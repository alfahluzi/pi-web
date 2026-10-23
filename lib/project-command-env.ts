import {
  createBashToolDefinition,
  createLocalBashOperations,
  getAgentDir,
  type BashOperations,
  type InlineExtension,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {
  commandNeedsSudo,
  createSudoAskpass,
  SUDO_AUTH_FAILURE_PATTERN,
  sudoShellPrefix,
} from "./sudo-prompt";

const HOST_EXTENSION_NAME = "pi-web-project-command-environment";
const HOST_EXTENSION_PATH = `<inline:${HOST_EXTENSION_NAME}>`;

/**
 * Operator-supplied sudo password plumbing, wired to the session wrapper.
 *
 * Pi Web owns both halves: the prompt is a browser dialog, and the value goes
 * straight into an askpass helper. It is never part of the tool call, so the
 * model cannot read it out of its own transcript.
 */
export type SudoPasswordSource = {
  /** Ask the operator; `undefined` means "run the command without a password". */
  requestPassword(command: string, signal?: AbortSignal): Promise<string | undefined>;
  /** The command reported an authentication failure, so the cached value is wrong. */
  forgetPassword(): void;
};

type ProjectShellSettings = {
  getShellCommandPrefix(): string | undefined;
  getShellPath(): string | undefined;
};

type ProjectCommandBashOperationsOptions = {
  agentBinDir?: string;
  baseEnvironment?: NodeJS.ProcessEnv;
  localOperations?: BashOperations;
  platform?: NodeJS.Platform;
  shellPath?: string;
};

function isHostRuntimeVariable(name: string, platform: NodeJS.Platform): boolean {
  const comparableName = platform === "win32" ? name.toUpperCase() : name;
  return comparableName === "PORT"
    || comparableName === "NODE_ENV"
    || comparableName.startsWith("NEXT_")
    // The browser login password guards this server; commands run on behalf of
    // a project (and the model reading their output) have no use for it.
    || comparableName === "PI_WEB_PASSWORD";
}

export function sanitizeProjectCommandEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment = { ...baseEnvironment };
  for (const name of Object.keys(environment)) {
    if (isHostRuntimeVariable(name, platform)) delete environment[name];
  }
  return environment;
}

function withAgentBinDirectory(
  environment: NodeJS.ProcessEnv,
  agentBinDir: string,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const pathKey = platform === "win32"
    ? Object.keys(environment).find((name) => name.toUpperCase() === "PATH") ?? "PATH"
    : "PATH";
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const currentPath = environment[pathKey] ?? "";
  const pathEntries = currentPath.split(pathDelimiter).filter(Boolean);
  if (!pathEntries.includes(agentBinDir)) {
    environment[pathKey] = [agentBinDir, currentPath].filter(Boolean).join(pathDelimiter);
  }
  return environment;
}

export function createProjectCommandBashOperations(
  options: ProjectCommandBashOperationsOptions = {},
): BashOperations {
  const {
    agentBinDir = join(getAgentDir(), "bin"),
    baseEnvironment = process.env,
    localOperations = createLocalBashOperations({ shellPath: options.shellPath }),
    platform = process.platform,
  } = options;

  return {
    exec(command, cwd, executionOptions) {
      const environment = withAgentBinDirectory(
        sanitizeProjectCommandEnvironment(executionOptions.env ?? baseEnvironment, platform),
        agentBinDir,
        platform,
      );
      return localOperations.exec(command, cwd, {
        ...executionOptions,
        env: environment,
      });
    },
  };
}

/** Keep the configured prefix first; the sudo function has to win over it. */
export function composeCommandPrefix(
  configured: string | undefined,
  extra: string | undefined,
): string | undefined {
  const parts = [configured, extra].filter((part): part is string => Boolean(part?.trim()));
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Watch the tail of a command's output so a rejected password is not reused.
 *
 * Only the suffix is kept: sudo's message is the last thing it writes before
 * giving up, and buffering a build log to search it would be wasteful.
 */
export function withSudoFailureDetection(
  operations: BashOperations,
  forgetPassword: () => void,
  pattern: RegExp = SUDO_AUTH_FAILURE_PATTERN,
): BashOperations {
  return {
    async exec(command, cwd, executionOptions) {
      let tail = "";
      const result = await operations.exec(command, cwd, {
        ...executionOptions,
        onData: (data) => {
          tail = `${tail}${data.toString("utf8")}`.slice(-4096);
          executionOptions.onData(data);
        },
      });
      if (pattern.test(tail)) forgetPassword();
      return result;
    },
  };
}

export function createProjectCommandBashExtension(options: {
  cwd: string;
  settings: ProjectShellSettings;
  sudoPasswords?: SudoPasswordSource;
}): InlineExtension {
  return {
    name: HOST_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      const displayDefinition = createBashToolDefinition(options.cwd);
      pi.registerTool({
        ...displayDefinition,
        async execute(toolCallId, params, signal, onUpdate, context) {
          const sudoPasswords = options.sudoPasswords;
          const needsPassword = sudoPasswords !== undefined
            && commandNeedsSudo(params.command)
            && !signal?.aborted;
          const password = needsPassword
            ? await sudoPasswords.requestPassword(params.command, signal)
            : undefined;
          let askpass: ReturnType<typeof createSudoAskpass> | undefined;
          try {
            askpass = password ? createSudoAskpass(password) : undefined;
            const operations = createProjectCommandBashOperations({
              shellPath: options.settings.getShellPath(),
            });
            const executionDefinition = createBashToolDefinition(options.cwd, {
              commandPrefix: composeCommandPrefix(
                options.settings.getShellCommandPrefix(),
                askpass ? sudoShellPrefix(askpass.scriptPath) : undefined,
              ),
              operations: askpass
                ? withSudoFailureDetection(operations, () => sudoPasswords?.forgetPassword())
                : operations,
            });
            return await executionDefinition.execute(toolCallId, params, signal, onUpdate, context);
          } finally {
            // Deleted in the tool's own frame: a later `ps`/read cannot reach it,
            // and a failed command cannot leave the password on disk.
            try {
              askpass?.dispose();
            } catch {
              // Cleanup must never replace the command's own result or error.
            }
          }
        },
      });
    },
  };
}

export function preferUserBashExtension(base: LoadExtensionsResult): LoadExtensionsResult {
  const hostExtensionIndex = base.extensions.findIndex((extension) => extension.path === HOST_EXTENSION_PATH);
  if (hostExtensionIndex < 0) return base;

  const userBashOwner = base.extensions
    .slice(0, hostExtensionIndex)
    .find((extension) => extension.tools.has("bash"));
  if (!userBashOwner) return base;

  return {
    ...base,
    extensions: base.extensions.filter((_, index) => index !== hostExtensionIndex),
    errors: base.errors.filter((error) => !(
      error.path === HOST_EXTENSION_PATH
      && error.error === `Tool "bash" conflicts with ${userBashOwner.path}`
    )),
  };
}
