import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

test("get_tools preserves the SDK tool definition fields", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const getToolsSource = source.slice(
    source.indexOf('case "get_tools"'),
    source.indexOf('case "get_commands"'),
  );

  assert.match(getToolsSource, /\.getAllTools\(\)/);
  assert.match(getToolsSource, /\.\.\.t,/);
  assert.match(getToolsSource, /active: active\.has\(t\.name\)/);
});

test("RPC session startup preloads extension-registered providers before restoring models", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /createAgentSessionServices\(/);
  assert.match(startupSource, /createAgentSessionFromServices\(/);
  assert.doesNotMatch(startupSource, /await createAgentSession\(/);
});

test("built-in subagents persist their selected resource policy", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const subagentSource = await readFile(new URL("./subagent-runtime.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(subagentSource, /SessionManager\.create\(parent\.cwd, undefined, \{ parentSession: parent\.sessionFile \}\)/);
  assert.match(subagentSource, /appendCustomEntry\(SUBAGENT_META_TYPE/);
  assert.match(subagentSource, /appendCustomEntry\(SUBAGENT_RESULT_TYPE/);
  assert.match(subagentSource, /dependencies\.registerSession\(inner, \{/);
  assert.match(subagentSource, /noExtensions: !profile\.loadExtensions/);
  assert.match(subagentSource, /noSkills: !profile\.loadSkills/);
  assert.match(subagentSource, /excludeTools: \[\.\.\.SUBAGENT_CONTROL_TOOL_NAMES\]/);
  assert.match(subagentSource, /withSubagentExtensionTools\(profile\.tools, extensionToolNames\)/);
  assert.match(subagentSource, /resourceSnapshot:/);
  assert.match(startupSource, /readSubagentSessionResources\(/);
  assert.match(startupSource, /resourceLoaderOptions: subagentResources/);
  assert.match(startupSource, /appendSystemPrompt: subagentResources\.appendSystemPrompt/);
  assert.match(startupSource, /noExtensions: !subagentResources\.loadExtensions/);
  assert.match(startupSource, /noSkills: !subagentResources\.loadSkills/);
  assert.match(startupSource, /excludeTools: \[\.\.\.SUBAGENT_CONTROL_TOOL_NAMES\]/);
  assert.match(startupSource, /let toolsOption: string\[\] \| undefined = subagentResources\?\.tools/);
  assert.match(source, /createSubagentController\(/);
  assert.match(source, /suppressCompletionNotifications: true/);
  assert.match(source, /suppressCompletionNotifications: Boolean\(subagentResources\)/);
  assert.match(startupSource, /createSubagentExtension\([\s\S]*?SUBAGENT_CONTROLLER\.extensionRuntime,[\s\S]*?\(\) => listSubagentProfiles\(sessionCwd\),[\s\S]*?isBuiltInSubagentsEnabled/);
  assert.match(startupSource, /preferPiWebSubagentExtension\(base\)/);
});

test("running snapshots expose sessions with suppressed completion notifications", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const runningRouteSource = await readFile(new URL("../app/api/agent/running/route.ts", import.meta.url), "utf8");
  const sessionsRouteSource = await readFile(new URL("../app/api/sessions/route.ts", import.meta.url), "utf8");
  const snapshotSource = source.slice(
    source.indexOf("export function getCompletionNotificationSuppressedRpcSessionIds"),
    source.indexOf("// ----------------------------------------------------------------------------", source.indexOf("export function getCompletionNotificationSuppressedRpcSessionIds")),
  );

  assert.match(snapshotSource, /session\.isRunning\(\) && session\.hasSuppressedCompletionNotifications\(\)/);
  assert.match(runningRouteSource, /completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds\(\)/);
  assert.match(sessionsRouteSource, /completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds\(\)/);
});

test("RPC session startup resolves and passes the SDK-native enabled model scope", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const resolveIndex = startupSource.indexOf("resolveVisibleModels(");
  const createIndex = startupSource.indexOf("createAgentSessionFromServices(");

  assert.ok(resolveIndex >= 0);
  assert.ok(createIndex > resolveIndex);
  assert.match(startupSource, /selectInitialModelScope\(/);
  assert.match(startupSource, /scopedModels: \[\.\.\.scope\.scopedModels\]/);
  assert.match(startupSource, /model: startupModel/);
  assert.match(startupSource, /thinkingLevel: initial\.thinkingLevel/);
});

test("RPC session startup treats only sessions with messages as continuing", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(
    startupSource,
    /const hasExistingMessages = branch\.some\(\(entry\) => entry\.type === "message" && entry\.message\.role !== "system"\)/,
  );
  assert.match(startupSource, /const initial = hasExistingMessages/);
  assert.match(startupSource, /getLatestModelChange\(branch as unknown as SessionEntry\[\]\)/);
  assert.match(startupSource, /model: startupModel/);
  assert.doesNotMatch(startupSource, /const initial = sessionFile/);
  assert.doesNotMatch(startupSource, /sessionManager\.buildSessionContext\(\)/);
});

test("RPC session startup opens an existing session file only once and trusts its cwd", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const routeSource = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const eventRouteSource = await readFile(new URL("../app/api/agent/[id]/events/route.ts", import.meta.url), "utf8");
  const autoNameRouteSource = await readFile(new URL("../app/api/sessions/[id]/auto-name/route.ts", import.meta.url), "utf8");

  assert.equal((startupSource.match(/SessionManager\.open\(/g) ?? []).length, 1);
  assert.match(startupSource, /const sessionCwd = sessionManager\.getCwd\(\)/);
  assert.match(startupSource, /projectTrustReloadOptions\(sessionCwd, agentDir\)/);
  assert.match(startupSource, /cwd: sessionCwd/);
  for (const route of [routeSource, eventRouteSource, autoNameRouteSource]) {
    assert.doesNotMatch(route, /SessionManager\.open\(/);
  }
});

test("RPC wrapper avoids per-chunk idle maintenance", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startSource = source.slice(
    source.indexOf("  start(): void"),
    source.indexOf("  beginExtensionBinding"),
  );

  assert.match(startSource, /IDLE_RESET_EVENT_TYPES\.has\(event\.type\)/);
  assert.doesNotMatch(startSource, /subscribe\(\(event: AgentEvent\) => \{\s*this\.resetIdleTimer\(\)/);
});

test("normal session teardown paths use graceful extension shutdown", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const deleteRouteSource = await readFile(new URL("../app/api/sessions/[id]/route.ts", import.meta.url), "utf8");
  const trustRouteSource = await readFile(new URL("../app/api/project-trust/route.ts", import.meta.url), "utf8");
  const idleSource = source.slice(
    source.indexOf("  private resetIdleTimer"),
    source.indexOf("  private persistBashOnlySession"),
  );
  const forkSource = source.slice(
    source.indexOf('case "fork"'),
    source.indexOf('case "clone"'),
  );
  const cloneSource = source.slice(
    source.indexOf('case "clone"'),
    source.indexOf('case "navigate_tree"'),
  );
  const replacementShutdownSource = source.slice(
    source.indexOf("  private async shutdownAfterSessionReplacement"),
    source.indexOf("  async send("),
  );

  assert.match(idleSource, /this\.shutdown\(\)/);
  assert.match(replacementShutdownSource, /await this\.shutdown\(\)/);
  assert.match(forkSource, /shutdownAfterSessionReplacement\("fork"\)/);
  assert.match(cloneSource, /shutdownAfterSessionReplacement\("clone"\)/);
  assert.match(deleteRouteSource, /await getRpcSession\(id\)\?\.shutdown\(\)/);
  assert.match(trustRouteSource, /await destroyRpcSessionsForCwd\(result\.cwd\)/);
});

test("clone copies the requested leaf into a child session", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const cloneSource = source.slice(
    source.indexOf('case "clone"'),
    source.indexOf('case "navigate_tree"'),
  );

  assert.match(cloneSource, /typeof command\.leafId === "string"/);
  assert.match(cloneSource, /branchHasAssistant/);
  assert.match(cloneSource, /createBranchedSession\(leafId\)/);
  assert.match(cloneSource, /cacheSessionPath\(newSessionId, clonedPath\)/);
  assert.match(cloneSource, /invalidateSessionListCache\(\)/);
  assert.match(cloneSource, /return \{ cancelled: false, newSessionId \}/);
});

test("fork_branch copies the selected assistant entry without replacing the source session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-quoted-branch-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendMessage({ role: "user", content: "source prompt", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "selected response" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const selectedEntryId = manager.getLeafId();
  const sourceFile = manager.getSessionFile();
  let forkedFile;
  let disposed = false;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: {},
    agent: { state: {} },
    dispose() { disposed = true; },
  });

  try {
    const result = await wrapper.send({ type: "fork_branch", entryId: selectedEntryId });
    const sessions = await SessionManager.list(root, sessionDir);
    const forkedInfo = sessions.find((session) => session.id === result.newSessionId);
    assert.ok(forkedInfo);
    forkedFile = forkedInfo.path;
    assert.equal(SessionManager.open(forkedFile, sessionDir).getLeafId(), selectedEntryId);
    assert.equal(manager.getLeafId(), selectedEntryId);
    assert.equal(disposed, false);
  } finally {
    wrapper.destroy();
    if (forkedFile) await unlink(forkedFile);
    if (sourceFile) await unlink(sourceFile);
    await rmdir(sessionDir);
    await rmdir(root);
  }
});

test("fork before the first message persists a reopenable message-free child session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-root-fork-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  const settingsEntryId = manager.appendModelChange("test", "test-model");
  const firstEntryId = manager.appendMessage({ role: "user", content: "source prompt", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "source response" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const sourceFile = manager.getSessionFile();
  let forkedFile;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: { emit: async () => {} },
    agent: { state: {} },
    dispose() {},
  });

  try {
    const result = await wrapper.send({ type: "fork", entryId: firstEntryId });
    const sessions = await SessionManager.list(root, sessionDir);
    const forkedInfo = sessions.find((session) => session.id === result.newSessionId);
    assert.ok(forkedInfo);
    forkedFile = forkedInfo.path;

    const forked = SessionManager.open(forkedFile, sessionDir);
    assert.equal(forked.getHeader().parentSession, sourceFile);
    assert.equal(forked.getLeafId(), settingsEntryId);
    assert.deepEqual(forked.getEntries(), [manager.getEntry(settingsEntryId)]);
  } finally {
    wrapper.destroy();
    if (forkedFile) await unlink(forkedFile);
    if (sourceFile) await unlink(sourceFile);
    await rmdir(sessionDir);
    await rmdir(root);
  }
});

test("session replacement rejects active work and clone writes one reopenable child", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-clone-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendMessage({ role: "user", content: "clone fixture", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "fixture response" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const cloneLeafId = manager.getLeafId();
  manager.appendSessionInfo("source-only metadata");

  const sourceFile = manager.getSessionFile();
  let clonedFile;
  let releaseModelRefresh;
  let signalModelRefresh;
  const modelRefreshStarted = new Promise((resolve) => { signalModelRefresh = resolve; });
  const modelRefreshHeld = new Promise((resolve) => { releaseModelRefresh = resolve; });
  let releaseShutdown;
  let signalShutdown;
  const shutdownStarted = new Promise((resolve) => { signalShutdown = resolve; });
  const shutdownHeld = new Promise((resolve) => { releaseShutdown = resolve; });
  let finishPrompt;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    prompt: (_message, options) => new Promise((resolve) => {
      finishPrompt = resolve;
      options.preflightResult?.(true);
    }),
    modelRuntime: {
      getModel: () => undefined,
      refresh: async () => {
        signalModelRefresh();
        await modelRefreshHeld;
      },
    },
    extensionRunner: {
      emit: async () => {
        signalShutdown();
        await shutdownHeld;
        throw new Error("fixture shutdown failure");
      },
    },
    agent: { state: {} },
    dispose() {},
  });

  try {
    const modelChange = wrapper.send({ type: "set_model", provider: "test", modelId: "missing" });
    await modelRefreshStarted;
    await assert.rejects(
      wrapper.send({ type: "clone" }),
      /Cannot clone while another session command is running/,
    );
    releaseModelRefresh();
    await assert.rejects(modelChange, /Model not found/);

    await wrapper.send({ type: "prompt", message: "keep this run active" });
    await assert.rejects(
      wrapper.send({ type: "fork", entryId: manager.getLeafId() }),
      /Cannot fork while the session is running/,
    );
    assert.ok(finishPrompt);
    finishPrompt();
    await new Promise((resolve) => setImmediate(resolve));

    const firstClone = wrapper.send({ type: "clone", leafId: cloneLeafId });
    await shutdownStarted;
    await assert.rejects(
      wrapper.send({ type: "clone" }),
      /Session is being copied to a new session/,
    );
    let shutdownErrorLog = "";
    const originalConsoleError = console.error;
    console.error = (...args) => { shutdownErrorLog = args.join(" "); };
    let result;
    try {
      releaseShutdown();
      result = await firstClone;
    } finally {
      console.error = originalConsoleError;
    }
    assert.match(shutdownErrorLog, /clone succeeded, but source session shutdown failed/);

    const sessions = await SessionManager.list(root, sessionDir);
    const clonedInfo = sessions.find((session) => session.id === result.newSessionId);
    assert.ok(clonedInfo);
    clonedFile = clonedInfo.path;

    const cloned = SessionManager.open(clonedFile, sessionDir);
    assert.equal(cloned.getHeader().parentSession, sourceFile);
    assert.equal(cloned.getLeafId(), cloneLeafId);
    assert.deepEqual(cloned.buildSessionContext().messages, manager.buildSessionContext().messages);
  } finally {
    wrapper.destroy();
    if (clonedFile) await unlink(clonedFile);
    if (sourceFile) await unlink(sourceFile);
    await rmdir(sessionDir);
    await rmdir(root);
  }
});

test("cancelled session replacement releases its lock", async () => {
  const manager = SessionManager.inMemory(tmpdir());
  let autoRetryEnabled = false;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    setAutoRetryEnabled: (enabled) => { autoRetryEnabled = enabled; },
    extensionRunner: {},
    agent: { state: {} },
    dispose() {},
  });

  try {
    assert.deepEqual(await wrapper.send({ type: "fork", entryId: "missing" }), { cancelled: true });
    await wrapper.send({ type: "set_auto_retry", enabled: true });
    assert.equal(autoRetryEnabled, true);
  } finally {
    wrapper.destroy();
  }
});

test("clone cancels an assistant-free branch without creating a file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-clone-empty-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendMessage({ role: "user", content: "no assistant yet", timestamp: Date.now() });
  const sourceFile = manager.getSessionFile();
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: { emit: async () => {} },
    agent: { state: {} },
    dispose() {},
  });

  try {
    assert.deepEqual(await wrapper.send({ type: "clone" }), { cancelled: true });
    assert.equal((await SessionManager.list(root, sessionDir)).length, 0);
  } finally {
    wrapper.destroy();
    await rmdir(sessionDir);
    await rmdir(root);
  }
});

test("new-session route applies model scope during construction instead of follow-up commands", async () => {
  const source = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");

  assert.match(source, /initialModel: \{ provider, modelId \}/);
  assert.match(source, /thinkingLevel: explicitThinkingLevel/);
  assert.doesNotMatch(source, /session\.send\(\{ type: "set_model"/);
  assert.doesNotMatch(source, /session\.send\(\{ type: "set_thinking_level"/);
  assert.match(source, /model: state\.model/);
  assert.match(source, /thinkingLevel: state\.thinkingLevel/);
});

test("prompt routes mark only preflight failures as rejected", async () => {
  const existingRoute = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const newRoute = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");

  for (const source of [existingRoute, newRoute]) {
    assert.match(source, /let promptAccepted = false/);
    assert.match(source, /await .*\.send\(/);
    assert.match(source, /promptAccepted = .*\.type === "prompt"/);
    assert.match(source, /commandType === "prompt" && !promptAccepted/);
  }
});

test("exact prompts are sent through before_agent_start instead of the SDK prompt state", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const subagentSource = await readFile(new URL("./subagent-runtime.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const promptSource = source.slice(
    source.indexOf('case "prompt"'),
    source.indexOf('case "abort"'),
  );

  // Pi 0.86 replays agent.state.systemPrompt from the transcript: assigning it throws,
  // and the loop's request context no longer carries a systemPrompt field.
  assert.doesNotMatch(source, /state\.systemPrompt =/);
  assert.doesNotMatch(source, /prepareNextTurnWithContext/);
  assert.doesNotMatch(subagentSource, /state\.systemPrompt =/);
  assert.match(startupSource, /const exactSystemPromptExtension = createExactSystemPromptExtension\(\(\) => exactSystemPromptRef\.current\?\.\(\)\)/);
  assert.match(startupSource, /exactSystemPromptRef\.current = exactSystemPrompt;/);
  assert.match(startupSource, /\{ \.\.\.CHAT_ONLY_RESOURCE_LOADER_OPTIONS, extensionFactories: \[exactSystemPromptExtension\] \}/);
  assert.match(startupSource, /usesExactSystemPrompt \? \{ extensionFactories: \[exactSystemPromptExtension\] \} : \{\}/);
  assert.match(subagentSource, /extensionFactories: \[createExactSystemPromptExtension\(\(\) => promptPlan\.exactSystemPrompt\)\]/);
  assert.match(promptSource, /preflightResult: \(success\) => \{[\s\S]*?if \(success\) acceptPreflight\(\);/);
  assert.doesNotMatch(promptSource, /requestedToolNames/);
});

test("RPC session startup persists explicit preferences without replaying setters", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /persistExplicitStartupPreferences\(/);
  assert.match(startupSource, /modelDefaultChanged\) invalidateModelsCache\(\)/);
});

test("custom extension UI receives the fixed headless terminal facade", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const customUiSource = source.slice(
    source.indexOf("private requestExtensionCustomUi"),
    source.indexOf("private requestExtensionUi"),
  );

  assert.match(customUiSource, /createHeadlessCustomUiTui\(/);
  assert.match(customUiSource, /width,/);
});

test("reloading a session invalidates the models cache", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const reloadSource = source.slice(
    source.indexOf('case "reload"'),
    source.indexOf('case "abort_compaction"'),
  );

  assert.match(reloadSource, /await this\.inner\.reload\(\)/);
  assert.match(reloadSource, /await this\.inner\.reload\(\);[\s\S]*?invalidateModelsCache\(\)/);
});

test("normal sessions restore persisted tool selections before loading resources", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const registrationSource = source.slice(
    source.indexOf("function registerRpcWrapper"),
    source.indexOf("const SUBAGENT_CONTROLLER"),
  );

  assert.match(startupSource, /readSessionToolSelection\(sessionManager\.getEntries\(\)/);
  assert.match(startupSource, /const selectedToolNames = subagentResources\?\.tools \?\? persistedToolNames \?\? requestedToolNames/);
  assert.match(startupSource, /appendSessionToolSelection\(sessionManager, requestedToolNames\)/);
  assert.ok(startupSource.indexOf("const chatOnly") < startupSource.indexOf("createAgentSessionServices("));
  assert.match(startupSource, /chatOnly\s*\? \{ \.\.\.CHAT_ONLY_RESOURCE_LOADER_OPTIONS/);
  assert.match(startupSource, /const trustReloadOptions = subagentResources[\s\S]*?subagentLoadsResources[\s\S]*?projectTrustReloadOptions\(sessionCwd, agentDir\)/);
  assert.match(registrationSource, /if \(!wrapper\.isChatOnly\(\)\) wrapper\.beginExtensionBinding\(\)/);
});

test("crossing the Chat-only boundary persists and rebuilds the wrapper", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const switchSource = source.slice(
    source.indexOf("export async function setRpcSessionTools"),
    source.indexOf("export function getRunningRpcSessionIds"),
  );

  assert.match(switchSource, /!hasCurrentResourcePolicy\s*\|\| existing\.isChatOnly\(\) !== \(toolNames\.length === 0\)/);
  assert.match(switchSource, /appendSessionToolSelection\(existing\.inner\.sessionManager, toolNames\)/);
  assert.match(switchSource, /await existing\.shutdown\(\)/);
  assert.match(switchSource, /__recreate__\$\{randomUUID\(\)\}/);
  assert.match(switchSource, /sessionId: started\.realSessionId/);
});

test("extension mode resolves from PI_WEB_EXTENSION_MODE with an rpc default", async () => {
  const { resolveExtensionMode } = await jiti.import("./rpc-manager.ts");

  // The host process may itself run with PI_WEB_EXTENSION_MODE set (that is the
  // point of the setting), so clear it while asserting the default.
  const previousMode = process.env.PI_WEB_EXTENSION_MODE;
  delete process.env.PI_WEB_EXTENSION_MODE;
  try {
    assert.equal(resolveExtensionMode(undefined), "rpc");
    assert.equal(resolveExtensionMode(""), "rpc");
  } finally {
    if (previousMode === undefined) delete process.env.PI_WEB_EXTENSION_MODE;
    else process.env.PI_WEB_EXTENSION_MODE = previousMode;
  }
  assert.equal(resolveExtensionMode("tui"), "tui");
  assert.equal(resolveExtensionMode("rpc"), "rpc");
  assert.equal(resolveExtensionMode("json"), "json");
  assert.equal(resolveExtensionMode("print"), "print");
  assert.equal(resolveExtensionMode("  tui  "), "tui");
  // Explicit but unusable values warn and fall back rather than throwing.
  assert.equal(resolveExtensionMode("bogus"), "rpc");
});

test("extension UI advertises no terminal input and maps percentage overlay widths", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

  assert.match(source, /onTerminalInput: undefined/);
  assert.match(source, /width\.trim\(\)\.endsWith\("%"\)/);
});

// --- Native ask_user_question questionnaire ---------------------------------

const QUESTIONNAIRE_QUESTIONS = [
  {
    question: "Which date library should we use?",
    header: "Library",
    multiSelect: false,
    options: [
      { label: "date-fns", description: "tree-shakeable", preview: "# date-fns" },
      { label: "dayjs", description: "2 kB core" },
    ],
  },
];

function flushExtensionUi() {
  // The ANSI path mounts the component from a microtask chain; the native path
  // emits its request synchronously.
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createExtensionUiHarness() {
  const emitted = [];
  const listeners = new Set();
  const wrapper = new AgentSessionWrapper({
    sessionId: "questionnaire-session",
    sessionFile: "",
    sessionManager: { isPersisted: () => false },
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: {},
    agent: { state: {} },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {},
  });
  wrapper.onEvent((event) => emitted.push(event));
  wrapper.start();

  return {
    wrapper,
    emitToolEvent(event) {
      for (const listener of [...listeners]) listener(event);
    },
    lastOpenCustomRequest() {
      const closed = new Set(
        emitted
          .filter((event) => event.type === "extension_ui_request" && event.method === "custom" && event.closed)
          .map((event) => event.id),
      );
      return emitted
        .filter((event) => event.type === "extension_ui_request"
          && event.method === "custom"
          && !event.closed
          && !closed.has(event.id))
        .at(-1);
    },
    customRequests() {
      return emitted.filter((event) => event.type === "extension_ui_request" && event.method === "custom");
    },
  };
}

test("ask_user_question renders natively and its answers resolve the extension promise", async () => {
  const harness = createExtensionUiHarness();
  try {
    harness.emitToolEvent({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "ask_user_question",
      args: { questions: QUESTIONNAIRE_QUESTIONS },
    });

    const ui = harness.wrapper.createExtensionUiContext();
    let factoryCalls = 0;
    const pending = ui.custom(() => {
      factoryCalls += 1;
      return { render: () => ["should never render"] };
    }, { overlay: true });

    const request = harness.lastOpenCustomRequest();
    assert.ok(request, "a custom UI request is emitted");
    assert.equal(request.questionnaire[0].options[0].preview, "# date-fns");
    assert.deepEqual(request.lines, []);
    assert.equal(factoryCalls, 0, "the TUI component factory is not invoked for the native path");

    await harness.wrapper.send({
      type: "extension_ui_questionnaire",
      id: request.id,
      result: {
        cancelled: false,
        answers: [{ questionIndex: 0, kind: "option", answer: "dayjs", question: "ignored" }],
      },
    });

    const result = await pending;
    assert.deepEqual(result, {
      answers: [{
        questionIndex: 0,
        question: "Which date library should we use?",
        kind: "option",
        answer: "dayjs",
      }],
      cancelled: false,
    });
    assert.equal(harness.lastOpenCustomRequest(), undefined, "the panel is closed once answered");
  } finally {
    harness.wrapper.destroy();
  }
});

test("a pending questionnaire is replayed to a browser that connects late", async () => {
  const harness = createExtensionUiHarness();
  try {
    harness.emitToolEvent({
      type: "tool_execution_start",
      toolCallId: "call-late",
      toolName: "ask_user_question",
      args: { questions: QUESTIONNAIRE_QUESTIONS },
    });

    const ui = harness.wrapper.createExtensionUiContext();
    const pending = ui.custom(() => ({ render: () => [] }), {});

    // A page refresh or a second tab attaches after the request was emitted;
    // `onEvent` must replay it or the transcript sits stuck forever.
    const replayed = [];
    harness.wrapper.onEvent((event) => replayed.push(event));
    const questionnaires = replayed.filter(
      (event) => event.type === "extension_ui_request" && event.method === "custom" && event.questionnaire,
    );
    assert.equal(questionnaires.length, 1);
    assert.equal(questionnaires[0].questionnaire[0].header, "Library");

    // Once answered it must stop being replayed.
    const request = harness.lastOpenCustomRequest();
    await harness.wrapper.send({
      type: "extension_ui_questionnaire",
      id: request.id,
      result: { cancelled: true, answers: [] },
    });
    await pending;

    const after = [];
    harness.wrapper.onEvent((event) => after.push(event));
    assert.equal(
      after.filter((event) => event.method === "custom" && event.questionnaire).length,
      0,
    );
  } finally {
    harness.wrapper.destroy();
  }
});

test("a questionnaire answer is re-validated before it reaches the extension", async () => {
  const harness = createExtensionUiHarness();
  try {
    harness.emitToolEvent({
      type: "tool_execution_start",
      toolCallId: "call-2",
      toolName: "ask_user_question",
      args: { questions: QUESTIONNAIRE_QUESTIONS },
    });

    const ui = harness.wrapper.createExtensionUiContext();
    const pending = ui.custom(() => ({ render: () => [] }), {});
    const request = harness.lastOpenCustomRequest();

    await harness.wrapper.send({
      type: "extension_ui_questionnaire",
      id: request.id,
      result: {
        cancelled: false,
        answers: [{ questionIndex: 0, kind: "option", answer: "moment" }],
      },
    });

    // A label the model never offered cannot survive; with nothing left the
    // result degrades to the extension's canonical decline.
    assert.deepEqual(await pending, { answers: [], cancelled: true });
  } finally {
    harness.wrapper.destroy();
  }
});

test("only a live ask_user_question call is intercepted", async () => {
  const harness = createExtensionUiHarness();
  try {
    // Malformed args: the tool call started but is not a renderable questionnaire.
    harness.emitToolEvent({
      type: "tool_execution_start",
      toolCallId: "call-3",
      toolName: "ask_user_question",
      args: { questions: [] },
    });
    const ui = harness.wrapper.createExtensionUiContext();
    const malformed = ui.custom(() => ({ render: () => ["ANSI fallback"] }), {});
    await flushExtensionUi();
    const malformedRequest = harness.lastOpenCustomRequest();
    assert.equal(malformedRequest.questionnaire, undefined);
    assert.deepEqual(malformedRequest.lines, ["ANSI fallback"]);

    // A finished call leaves no marker for the next unrelated dialog.
    harness.emitToolEvent({ type: "tool_execution_end", toolCallId: "call-3" });
    harness.emitToolEvent({
      type: "tool_execution_start",
      toolCallId: "call-4",
      toolName: "ask_user_question",
      args: { questions: QUESTIONNAIRE_QUESTIONS },
    });
    harness.emitToolEvent({ type: "tool_execution_end", toolCallId: "call-4" });
    const unrelated = ui.custom(() => ({ render: () => ["unrelated dialog"] }), {});
    await flushExtensionUi();
    const unrelatedRequest = harness.lastOpenCustomRequest();
    assert.equal(unrelatedRequest.questionnaire, undefined);
    assert.deepEqual(unrelatedRequest.lines, ["unrelated dialog"]);

    harness.wrapper.destroy();
    assert.equal(await malformed, undefined);
    assert.equal(await unrelated, undefined);
  } finally {
    harness.wrapper.destroy();
  }
});
