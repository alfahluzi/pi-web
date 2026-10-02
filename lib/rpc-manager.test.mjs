import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper, startRpcSession } = await jiti.import("./rpc-manager.ts");

test("RPC refuses a malformed subagent resource snapshot instead of reopening it as normal", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-corrupt-subagent-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  try {
    for (const parentSessionId of ["parent", null]) {
      const manager = SessionManager.create(root, sessionDir);
      manager.appendMessage({ role: "user", content: "delegated task", timestamp: Date.now() });
      manager.appendCustomEntry("pi-web:subagent", {
        version: 1,
        parentSessionId,
        parentSessionPath: "/tmp/parent.jsonl",
        parentToolCallId: "call",
        profile: "general-purpose",
        description: "corrupt",
        task: "task",
        runInBackground: false,
        createdAt: new Date().toISOString(),
        resourceSnapshot: {
          version: 1,
          appendSystemPrompt: [],
          tools: "read",
          loadSkills: false,
          loadExtensions: false,
        },
      });
      await assert.rejects(
        startRpcSession(manager.getSessionId(), manager.getSessionFile(), undefined),
        /Invalid subagent resource snapshot/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normal sessions load the Read-only MCP policy with the built-ins", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  // The Read-only policy for MCP tools rides along with the MCP extension.
  assert.match(startupSource, /\.\.\.\(builtins\?\.extensions \?\? \[\]\),\s*createReadOnlyMcpPolicyExtension\(\),/);
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

function assistantFixture(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
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
  };
}

test("fork and fork_branch copy finished entries while the source keeps running", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-running-fork-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  const firstUserId = manager.appendMessage({ role: "user", content: "first prompt", timestamp: Date.now() });
  const firstAssistantId = manager.appendMessage(assistantFixture("first response"));
  // The turn the agent is still running: its user message is already on disk.
  const runningUserId = manager.appendMessage({ role: "user", content: "running prompt", timestamp: Date.now() });
  const sourceFile = manager.getSessionFile();
  const sourceBefore = await readFile(sourceFile, "utf8");
  const forkedFiles = [];
  let disposed = false;
  let shutdownEvents = 0;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: true,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: { emit: async () => { shutdownEvents += 1; } },
    agent: { state: {} },
    dispose() { disposed = true; },
  });

  try {
    const forked = await wrapper.send({ type: "fork", entryId: runningUserId });
    const branched = await wrapper.send({ type: "fork_branch", entryId: firstAssistantId });
    const sessions = await SessionManager.list(root, sessionDir);
    for (const result of [forked, branched]) {
      const info = sessions.find((session) => session.id === result.newSessionId);
      assert.ok(info);
      forkedFiles.push(info.path);
      const child = SessionManager.open(info.path, sessionDir);
      assert.equal(child.getHeader().parentSession, sourceFile);
      assert.equal(child.getLeafId(), firstAssistantId);
      assert.deepEqual(child.getEntries().map((entry) => entry.id), [firstUserId, firstAssistantId]);
    }

    assert.equal(wrapper.isAlive(), true);
    assert.equal(disposed, false);
    assert.equal(shutdownEvents, 0);
    assert.equal(manager.getLeafId(), runningUserId);
    assert.equal(await readFile(sourceFile, "utf8"), sourceBefore);
  } finally {
    wrapper.destroy();
    for (const file of forkedFiles) await unlink(file);
    await unlink(sourceFile);
    await rmdir(sessionDir);
    await rmdir(root);
  }
});

test("fork refuses a running shell command and a source not yet written to disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-unsaved-fork-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendModelChange("test", "test-model");
  // pi 0.99 writes the file at the first user message. Remove it to exercise
  // the missing-on-disk error without relying on the old flush behavior.
  const userId = manager.appendMessage({ role: "user", content: "first prompt", timestamp: Date.now() });
  const sourceFile = manager.getSessionFile();
  await unlink(sourceFile);
  const inner = {
    sessionId: manager.getSessionId(),
    sessionFile: manager.getSessionFile(),
    sessionManager: manager,
    isStreaming: true,
    isCompacting: false,
    isBashRunning: true,
    extensionRunner: {},
    agent: { state: {} },
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);

  try {
    await assert.rejects(
      wrapper.send({ type: "fork", entryId: userId }),
      /Cannot fork while a shell command is running/,
    );
    await assert.rejects(
      wrapper.send({ type: "fork_branch", entryId: userId }),
      /Cannot fork while a shell command is running/,
    );

    inner.isBashRunning = false;
    await assert.rejects(
      wrapper.send({ type: "fork", entryId: userId }),
      /has not been saved yet/,
    );
    await assert.rejects(
      wrapper.send({ type: "fork_branch", entryId: userId }),
      /has not been saved yet/,
    );
    assert.equal(wrapper.isAlive(), true);
    assert.deepEqual(await readdir(sessionDir), []);
  } finally {
    wrapper.destroy();
    await rm(root, { recursive: true, force: true });
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
      options.preflightResult?.("started");
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
      wrapper.send({ type: "clone", leafId: cloneLeafId }),
      /Cannot clone while the session is running/,
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
    // Since pi 0.99 the first user message already creates the source file.
    assert.deepEqual((await SessionManager.list(root, sessionDir)).map((session) => session.path), [sourceFile]);
  } finally {
    wrapper.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("subagents that load resources pass the project trust gate", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /const trustReloadOptions = subagentResources[\s\S]*?subagentLoadsResources[\s\S]*?projectTrustReloadOptions\(sessionCwd, agentDir\)/);
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
