/**
 * `sudo` password prompts for the agent's shell tool.
 *
 * Pi runs tool commands without a terminal, so `sudo` cannot ask for a password
 * itself: it fails with "a terminal is required to authenticate". Pi Web asks
 * the operator in the browser instead and hands the value to sudo through an
 * `askpass` helper. The password therefore never appears in the command text,
 * `ps` output, the child environment, the tool result, the transcript, or a log.
 *
 * Sudo asks for the password itself only when it has no cached credential, so
 * an answered prompt is kept in memory for {@link SUDO_PASSWORD_TTL_MS}. It is
 * dropped on {@link SUDO_AUTH_FAILURE_PATTERN} so a typo cannot poison the
 * window with a password that never authenticates.
 *
 * Ubuntu 26.04 ships sudo-rs, which ignores `SUDO_ASKPASS` unless `-A` is on the
 * command line: `SUDO_ASKPASS=... sudo true` answers "interactive
 * authentication is required". {@link sudoShellPrefix} installs a `sudo` shell
 * function for the duration of that one command, which is the only way to add
 * the flag without rewriting shell code we do not parse.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** How long the browser prompt waits before the command runs without a password. */
export const SUDO_PROMPT_TIMEOUT_MS = 3 * 60_000;

/** How long an answered password is reused for later `sudo` commands. */
export const SUDO_PASSWORD_TTL_MS = 5 * 60_000;

/** Sudo's wording when the supplied password does not authenticate. */
export const SUDO_AUTH_FAILURE_PATTERN = /authentication failed|incorrect password|sorry, try again|no password was provided/i;

/** Longest command preview carried to the prompt. */
const COMMAND_PREVIEW_LIMIT = 600;

/**
 * Words that keep the following word in command position without being the
 * command themselves. `env FOO=1 sudo …` and `command sudo …` both still run
 * sudo, so the scan has to step over them.
 */
const COMMAND_PREFIX_WORDS = new Set([
  "!",
  "command",
  "do",
  "elif",
  "else",
  "env",
  "exec",
  "if",
  "nice",
  "nohup",
  "then",
  "time",
  "until",
  "while",
]);

/**
 * Blank out quoted text, escapes, and comments.
 *
 * `echo "run sudo later"` and `# sudo is blocked` are not sudo invocations, and
 * treating them as such would prompt for a password over nothing.
 */
export function stripShellQuotesAndComments(command: string): string {
  let stripped = "";
  let index = 0;
  while (index < command.length) {
    const char = command[index];
    if (char === "\\") {
      index += 2;
      stripped += " ";
      continue;
    }
    if (char === "'") {
      index += 1;
      while (index < command.length && command[index] !== "'") index += 1;
      index += 1;
      stripped += " ";
      continue;
    }
    if (char === '"') {
      index += 1;
      while (index < command.length && command[index] !== '"') {
        if (command[index] === "\\") index += 1;
        index += 1;
      }
      index += 1;
      stripped += " ";
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(command[index - 1] ?? ""))) {
      while (index < command.length && command[index] !== "\n") index += 1;
      continue;
    }
    stripped += char;
    index += 1;
  }
  return stripped;
}

/**
 * Whether a shell command invokes `sudo` in command position.
 *
 * Deliberately a scan, not a parser: a missed invocation only leaves the old
 * "a terminal is required" failure in place, while a false positive costs one
 * cancelled prompt.
 */
export function commandNeedsSudo(command: string): boolean {
  const sanitized = stripShellQuotesAndComments(command);
  for (const segment of sanitized.split(/[;&|\n(){}]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let index = 0;
    while (index < words.length) {
      const word = words[index] ?? "";
      const isAssignment = /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word);
      if (!COMMAND_PREFIX_WORDS.has(word) && !isAssignment) break;
      index += 1;
    }
    const word = words[index];
    // Only the bare command word is intercepted. `/usr/bin/sudo …` bypasses the
    // shell function, so prompting there would only write the password to disk
    // for a command that still fails with "a terminal is required".
    if (word === "sudo") return true;
  }
  return false;
}

/** One-line-ish preview of the command for the prompt. */
export function sudoCommandPreview(command: string): string {
  const trimmed = command.trim();
  return trimmed.length > COMMAND_PREVIEW_LIMIT
    ? `${trimmed.slice(0, COMMAND_PREVIEW_LIMIT)}…`
    : trimmed;
}

function singleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The helper sudo runs to read the password: it prints it once and removes it. */
export function askpassScriptText(secretPath: string): string {
  const quoted = singleQuote(secretPath);
  // Read-then-unlink keeps the plaintext file alive only until sudo's first
  // prompt. A command that suspects the location cannot list it later, and the
  // second attempt of a wrong password simply gets nothing (the operator is
  // asked again for the next command, see SUDO_AUTH_FAILURE_PATTERN). The
  // helper's own stderr is dropped so the temp path never reaches the tool
  // output of a rejected password.
  return `#!/bin/sh\npw=$(cat ${quoted} 2>/dev/null) || exit 1\nrm -f ${quoted}\nprintf '%s\\n' "$pw"\n`;
}

/**
 * Shell prefix that makes `sudo` in this command read the password through the
 * askpass helper. `export -f` covers `bash -c` children; it is a no-op in dash.
 */
export function sudoShellPrefix(askpassPath: string): string {
  return [
    `sudo() { SUDO_ASKPASS=${singleQuote(askpassPath)} command sudo -A "$@"; }`,
    "(export -f sudo) >/dev/null 2>&1 || true",
  ].join("\n");
}

export interface SudoAskpass {
  readonly dir: string;
  readonly scriptPath: string;
  dispose(): void;
}

/**
 * Every askpass directory that still exists, swept if the process exits before
 * a tool call finishes. `finally` covers the normal path; this covers a crash,
 * an uncaught rejection, or a shutdown signal, none of which leave the
 * plaintext on disk.
 */
const activeAskpassDirs = new Set<string>();
let exitSweepInstalled = false;

function sweepAskpassDirs(): void {
  for (const dir of activeAskpassDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: an exit hook has nowhere left to report to.
    }
  }
  activeAskpassDirs.clear();
}

function trackAskpassDir(dir: string): void {
  activeAskpassDirs.add(dir);
  if (exitSweepInstalled) return;
  exitSweepInstalled = true;
  process.once("exit", sweepAskpassDirs);
}

/**
 * Write the askpass helper and its password file into a private directory.
 *
 * `mkdtemp` is already 0700, so only this user can traverse it, and the
 * password file is created with mode 0600 by `open(2)` — a umask can only
 * narrow that, so it is never group- or other-readable. Both are removed as
 * soon as the command finishes, and by `sweepAskpassDirs` if it never does.
 *
 * Residual exposure, stated plainly: any process running as this same user can
 * read the file while it exists, which includes a command the model chose to
 * run. That window is the time until sudo's first prompt (the helper unlinks the
 * file), and it requires deliberately scanning the temp root during that exact
 * run — the model cannot reach it through its transcript, argv, environment, or
 * the tool result, which is what this feature promises.
 */
export function createSudoAskpass(password: string, options: { baseDir?: string } = {}): SudoAskpass {
  const dir = mkdtempSync(join(options.baseDir ?? tmpdir(), "pi-web-sudo-"));
  try {
    const secretPath = join(dir, "password");
    writeFileSync(secretPath, `${password}\n`, { mode: 0o600 });
    const scriptPath = join(dir, "askpass.sh");
    writeFileSync(scriptPath, askpassScriptText(secretPath), { mode: 0o700 });
    trackAskpassDir(dir);
    return {
      dir,
      scriptPath,
      dispose() {
        activeAskpassDirs.delete(dir);
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    // A half-written directory must not survive with the password in it.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Nothing else can be done; report the original failure.
    }
    throw error;
  }
}

/**
 * In-memory password with an expiry, so a run of sudo commands prompts once.
 *
 * Lives on the session wrapper and is never persisted: a server restart, an
 * idle unload, or an authentication failure all mean "ask again".
 */
export class SudoPasswordCache {
  private password: string | null = null;
  private expiresAt = 0;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlMs: number = SUDO_PASSWORD_TTL_MS, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  remember(password: string): void {
    if (!password) return;
    this.password = password;
    this.expiresAt = this.now() + this.ttlMs;
  }

  peek(): string | undefined {
    if (this.password === null) return undefined;
    if (this.now() >= this.expiresAt) {
      this.clear();
      return undefined;
    }
    return this.password;
  }

  clear(): void {
    this.password = null;
    this.expiresAt = 0;
  }
}
