import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

// startRpcSession() builds real SDK sessions here; keep them out of ~/.pi.
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-lifecycle-agent-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  AgentSessionWrapper,
  cacheMonitorDirectory,
  createCacheObservedRuntime,
  createSessionCacheMonitor,
  getRpcSession,
  isCacheMonitorEnabled,
  resolveSessionShutdownDeadlineMs,
  setRpcSessionTools,
  startRpcSession,
} = await jiti.import("./rpc-manager.ts");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

/** An SDK session whose session_shutdown handlers wait until the test releases them, or forever with `hang`. */
function makeClosingInner(calls, { hang = false } = {}) {
  let release = () => {};
  const held = hang
    ? new Promise(() => {})
    : new Promise((resolve) => { release = resolve; });
  return {
    inner: {
      sessionId: "closing-session",
      isBashRunning: false,
      isStreaming: false,
      isCompacting: false,
      extensionRunner: {
        emit(event) {
          calls.push(["emit", event.type]);
          return held;
        },
      },
      dispose() {
        calls.push(["dispose"]);
      },
    },
    release: () => release(),
  };
}

test("defaults the shutdown deadline to 5 seconds when the env var is unset or blank", () => {
  assert.equal(resolveSessionShutdownDeadlineMs(), 5_000);
  assert.equal(resolveSessionShutdownDeadlineMs(""), 5_000);
  assert.equal(resolveSessionShutdownDeadlineMs("   "), 5_000);
});

test("uses a positive shutdown deadline in milliseconds", () => {
  assert.equal(resolveSessionShutdownDeadlineMs("250"), 250);
  assert.equal(resolveSessionShutdownDeadlineMs("2147483647"), 2_147_483_647);
});

test("falls back to the 5-second deadline and warns for zero, invalid or out-of-range values", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  // Zero would mean "dispose without telling extensions"; shutdown always has a deadline.
  assert.equal(resolveSessionShutdownDeadlineMs("0"), 5_000);
  assert.equal(resolveSessionShutdownDeadlineMs("abc"), 5_000);
  assert.equal(resolveSessionShutdownDeadlineMs("-5"), 5_000);
  assert.equal(resolveSessionShutdownDeadlineMs("NaN"), 5_000);
  assert.equal(resolveSessionShutdownDeadlineMs("Infinity"), 5_000);
  assert.equal(resolveSessionShutdownDeadlineMs("2147483648"), 5_000);
  assert.equal(warn.mock.callCount(), 6);
});

test("a wrapper reports itself dead as soon as shutdown starts", async () => {
  const calls = [];
  const { inner, release } = makeClosingInner(calls);
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.onDestroy(() => calls.push(["unregister"]));

  const shutting = wrapper.shutdown();
  assert.equal(wrapper.isAlive(), false);
  // A second caller (project trust, a deleted session) joins the same shutdown.
  const joined = wrapper.shutdown();

  await nextTurn();
  // Extensions are still handling session_shutdown; nothing is disposed yet.
  assert.deepEqual(calls, [["emit", "session_shutdown"]]);
  assert.equal(wrapper.isAlive(), false);
  assert.equal(wrapper.evictIfDiskAhead(), false);

  release();
  await Promise.all([shutting, joined]);
  assert.deepEqual(calls, [["emit", "session_shutdown"], ["dispose"], ["unregister"]]);
  assert.equal(wrapper.isAlive(), false);
});

test("shutdown disposes the session once the deadline passes even if session_shutdown never settles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const warn = t.mock.method(console, "warn", () => {});
  const calls = [];
  const { inner } = makeClosingInner(calls, { hang: true });
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.onDestroy(() => calls.push(["unregister"]));

  let settled = false;
  const shutting = wrapper.shutdown().then(() => { settled = true; });
  await nextTurn();
  t.mock.timers.tick(4_999);
  await nextTurn();
  assert.equal(settled, false);
  assert.deepEqual(calls, [["emit", "session_shutdown"]]);

  t.mock.timers.tick(1);
  await shutting;
  assert.deepEqual(calls, [["emit", "session_shutdown"], ["dispose"], ["unregister"]]);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(
    warn.mock.calls[0].arguments[0],
    /did not finish session_shutdown for session closing-session within 5000 ms/,
  );
});

test("direct destruction also disposes the session at the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const warn = t.mock.method(console, "warn", () => {});
  const calls = [];
  const { inner } = makeClosingInner(calls, { hang: true });
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.onDestroy(() => calls.push(["unregister"]));

  wrapper.destroy();
  assert.equal(wrapper.isAlive(), false);
  await nextTurn();
  assert.deepEqual(calls, [["emit", "session_shutdown"]]);

  t.mock.timers.tick(5_000);
  await nextTurn();
  assert.deepEqual(calls, [["emit", "session_shutdown"], ["dispose"], ["unregister"]]);
  assert.equal(warn.mock.callCount(), 1);
});

test("a session_shutdown failure after the deadline is not an unhandled rejection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  let failLate;
  const calls = [];
  const wrapper = new AgentSessionWrapper({
    sessionId: "late-failure",
    isBashRunning: false,
    extensionRunner: {
      emit: () => new Promise((_resolve, reject) => { failLate = reject; }),
    },
    dispose() {
      calls.push("dispose");
    },
  });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));

  const shutting = wrapper.shutdown();
  await nextTurn();
  t.mock.timers.tick(5_000);
  await shutting;
  assert.deepEqual(calls, ["dispose"]);

  failLate(new Error("closed after the deadline"));
  await nextTurn();
  assert.deepEqual(unhandled, []);
});

test("the shutdown deadline timer does not keep the process alive", async (t) => {
  const realSetTimeout = globalThis.setTimeout;
  const deadlineTimers = [];
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    const timer = realSetTimeout(callback, delay, ...args);
    if (delay === 5_000) deadlineTimers.push(timer);
    return timer;
  });
  const calls = [];
  const { inner, release } = makeClosingInner(calls);
  const wrapper = new AgentSessionWrapper(inner);

  const shutting = wrapper.shutdown();
  await nextTurn();
  assert.equal(deadlineTimers.length, 1);
  assert.equal(deadlineTimers[0].hasRef(), false);

  release();
  await shutting;
  assert.deepEqual(calls, [["emit", "session_shutdown"], ["dispose"]]);
});

test("PI_WEB_SHUTDOWN_DEADLINE_MS sets the deadline", async (t) => {
  const previousValue = process.env.PI_WEB_SHUTDOWN_DEADLINE_MS;
  process.env.PI_WEB_SHUTDOWN_DEADLINE_MS = "250";
  try {
    const freshJiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
    const { AgentSessionWrapper: FreshWrapper } = await freshJiti.import("./rpc-manager.ts");

    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(console, "warn", () => {});
    const calls = [];
    const { inner } = makeClosingInner(calls, { hang: true });
    const wrapper = new FreshWrapper(inner);

    const shutting = wrapper.shutdown();
    await nextTurn();
    t.mock.timers.tick(249);
    await nextTurn();
    assert.deepEqual(calls, [["emit", "session_shutdown"]]);

    t.mock.timers.tick(1);
    await shutting;
    assert.deepEqual(calls, [["emit", "session_shutdown"], ["dispose"]]);
  } finally {
    if (previousValue === undefined) delete process.env.PI_WEB_SHUTDOWN_DEADLINE_MS;
    else process.env.PI_WEB_SHUTDOWN_DEADLINE_MS = previousValue;
  }
});

// A real SDK session is too large for assert's diff: compare wrappers by identity.
function assertRegistered(sessionId, expected, message) {
  assert.ok(getRpcSession(sessionId) === expected, message);
}

/** Starts a real, registered wrapper for a persisted session file. */
async function startPersistedSession(t) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-lifecycle-cwd-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const manager = SessionManager.create(cwd);
  manager.appendMessage({ role: "user", content: "persisted before the wrapper starts", timestamp: Date.now() });
  const sessionId = manager.getSessionId();
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile && existsSync(sessionFile));

  // Chat only keeps the real SDK session free of extensions and skills.
  const { session } = await startRpcSession(sessionId, sessionFile, undefined, { toolNames: [] });
  t.after(() => session.destroy());
  assertRegistered(sessionId, session, "the started wrapper is registered");
  return { sessionId, sessionFile, session };
}

/**
 * Lets a replacement start while `wrapper` is still closing, as it does once the bounded
 * wait for a shutdown stuck in extension binding runs out.
 */
function skipClosingWait(wrapper) {
  wrapper.waitUntilDisposed = async () => false;
}

/** Holds session_shutdown open, as an MCP server that never finishes closing does. */
function holdSessionShutdown(wrapper) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  wrapper.inner.extensionRunner.emit = async () => {
    signalStarted();
    await held;
  };
  return { started, release };
}

async function startReplacement(t, sessionId, sessionFile, closing) {
  const { session: replacement, realSessionId } = await startRpcSession(sessionId, sessionFile, undefined);
  t.after(() => replacement.destroy());
  assert.ok(replacement !== closing, "startRpcSession must not return the closing wrapper");
  assert.equal(realSessionId, sessionId);
  assert.equal(replacement.isAlive(), true);
  assert.equal(replacement.isChatOnly(), true);
  assertRegistered(sessionId, replacement, "the replacement takes over the registry entry");
  // The fast path now returns the replacement rather than starting a third wrapper.
  const again = await startRpcSession(sessionId, sessionFile, undefined);
  assert.ok(again.session === replacement, "the fast path returns the replacement");
  return replacement;
}

test("startRpcSession waits for a closing wrapper to dispose before it opens the session again", async (t) => {
  const { sessionId, sessionFile, session: closing } = await startPersistedSession(t);
  const shutdownHook = holdSessionShutdown(closing);
  const order = [];
  const dispose = closing.inner.dispose.bind(closing.inner);
  closing.inner.dispose = () => {
    order.push("closing disposed");
    dispose();
  };

  const shuttingDown = closing.shutdown();
  await shutdownHook.started;
  const replacing = startRpcSession(sessionId, sessionFile, undefined).then((started) => {
    order.push("replacement started");
    return started;
  });
  // Concurrent starts share the wait instead of each starting a wrapper.
  const concurrent = startRpcSession(sessionId, sessionFile, undefined);
  // A failed assertion below must not leave the shutdown held or the replacement running.
  t.after(async () => {
    shutdownHook.release();
    for (const start of [replacing, concurrent]) (await start.catch(() => null))?.session.destroy();
  });
  // An unblocked start of this Chat-only session finishes well within this window.
  await Promise.race([replacing, new Promise((resolve) => setTimeout(resolve, 500))]);
  assert.deepEqual(order, [], "nothing opens the session while its closing wrapper still owns it");
  assertRegistered(sessionId, closing, "the closing wrapper stays registered while it closes");
  assert.ok(globalThis.__piStartLocks.has(sessionId), "callers that check the start lock see the wait");

  shutdownHook.release();
  await shuttingDown;
  const { session: replacement } = await replacing;
  assert.ok((await concurrent).session === replacement, "the concurrent start gets the same replacement");
  assert.deepEqual(order, ["closing disposed", "replacement started"]);
  assert.ok(replacement !== closing);
  assertRegistered(sessionId, replacement, "the replacement takes over the registry entry");
});

test("a tool change made while the session closes applies to the wrapper a concurrent start brings up", async (t) => {
  const { sessionId, sessionFile, session: closing } = await startPersistedSession(t);
  assert.equal(closing.isChatOnly(), true);
  const shutdownHook = holdSessionShutdown(closing);
  const shuttingDown = closing.shutdown();
  await shutdownHook.started;

  // An SSE reconnect starts the session again, then the user picks Read-only.
  const reconnecting = startRpcSession(sessionId, sessionFile, undefined);
  const changingTools = setRpcSessionTools(sessionId, sessionFile, ["read"]);
  t.after(async () => {
    shutdownHook.release();
    for (const start of [reconnecting, changingTools]) (await start.catch(() => null))?.session.destroy();
  });

  shutdownHook.release();
  await shuttingDown;
  const changed = await changingTools;
  await reconnecting;
  assert.equal(changed.session.isAlive(), true);
  assert.equal(changed.session.isChatOnly(), false, "the selection left Chat only");
  assertRegistered(sessionId, changed.session, "the wrapper with the selection is the registered one");
  const tools = await changed.session.send({ type: "get_tools" });
  assert.ok(tools.some((tool) => tool.name === "read" && tool.active), "read is active");
});

test("startRpcSession replaces a shutting-down wrapper, which then cannot unregister its replacement", async (t) => {
  const { sessionId, sessionFile, session: closing } = await startPersistedSession(t);
  const shutdownHook = holdSessionShutdown(closing);
  skipClosingWait(closing);

  const shuttingDown = closing.shutdown();
  assert.equal(closing.isAlive(), false);
  await shutdownHook.started;
  // Still registered until it is disposed, but no lookup may route work to it.
  assertRegistered(sessionId, closing, "the closing wrapper stays registered until it is disposed");

  const replacement = await startReplacement(t, sessionId, sessionFile, closing);

  shutdownHook.release();
  await shuttingDown;
  assertRegistered(sessionId, replacement, "the closed wrapper left its replacement registered");
  assert.equal(replacement.isAlive(), true);

  await replacement.shutdown();
  assertRegistered(sessionId, undefined, "a wrapper still unregisters itself");
});

test("a wrapper evicted for a newer file on disk cannot unregister the wrapper that reloaded it", async (t) => {
  const { sessionId, sessionFile, session: stale } = await startPersistedSession(t);
  const shutdownHook = holdSessionShutdown(stale);
  skipClosingWait(stale);
  // Another pi process appends to the same session file.
  SessionManager.open(sessionFile).appendMessage({
    role: "user",
    content: "written by the other process",
    timestamp: Date.now(),
  });

  assert.equal(stale.evictIfDiskAhead(), true);
  assert.equal(stale.isAlive(), false);
  await shutdownHook.started;

  const replacement = await startReplacement(t, sessionId, sessionFile, stale);

  shutdownHook.release();
  await nextTurn();
  assertRegistered(sessionId, replacement, "the evicted wrapper left its replacement registered");
  assert.equal(replacement.isAlive(), true);
});

test("a wrapper registered before a hot reload cannot unregister its replacement either", async (t) => {
  const { sessionId, sessionFile, session: closing } = await startPersistedSession(t);
  // registerRpcWrapper() before this change removed the entry by id alone.
  closing.onDestroy(() => globalThis.__piSessions.delete(sessionId));
  const shutdownHook = holdSessionShutdown(closing);
  skipClosingWait(closing);

  const shuttingDown = closing.shutdown();
  await shutdownHook.started;
  const replacement = await startReplacement(t, sessionId, sessionFile, closing);

  shutdownHook.release();
  await shuttingDown;
  assertRegistered(sessionId, replacement, "the old cleanup left its replacement registered");
});

const CACHE_STREAM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A recorder double: every cache monitor call lands in `calls`, in order. */
function makeFakeCacheMonitor({ epochId = "11111111-1111-4111-8111-111111111111" } = {}) {
  const calls = [];
  let invocations = 0;
  const monitor = {
    localEpochId: epochId,
    beginInvocation(input) {
      invocations += 1;
      const handle = Object.freeze({
        ...input,
        localEpochId: epochId,
        localInvocationId: `invocation-${invocations}`,
        modelId: input.modelId ?? null,
        configId: input.configId ?? null,
      });
      calls.push(["beginInvocation", input, handle]);
      return handle;
    },
    recordRequest(handle, input) {
      calls.push(["recordRequest", handle, input]);
    },
    recordResponse(handle, input) {
      calls.push(["recordResponse", handle, input]);
    },
    markUnknown(handle, reason) {
      calls.push(["markUnknown", handle, reason]);
    },
    close(input) {
      calls.push(["close", input]);
      return Promise.resolve();
    },
  };
  return { monitor, calls };
}

function cacheCalls(calls, type) {
  return calls.filter(([name]) => name === type);
}

/** A stream whose result() resolves or rejects exactly like the SDK event stream's. */
function makeCacheStream(result) {
  return { result: () => (result instanceof Promise ? result : Promise.resolve(result)) };
}

test("the cache monitor stays off and creates nothing unless PI_WEB_CACHE_MONITOR is exactly 1", () => {
  const previous = process.env.PI_WEB_CACHE_MONITOR;
  try {
    for (const value of [undefined, "", "0", "true", "yes", " 1"]) {
      if (value === undefined) delete process.env.PI_WEB_CACHE_MONITOR;
      else process.env.PI_WEB_CACHE_MONITOR = value;
      assert.equal(isCacheMonitorEnabled(), false, `"${value}" must not enable capture`);
      assert.equal(createSessionCacheMonitor(), null, `"${value}" must not create a monitor`);
    }
    assert.equal(existsSync(cacheMonitorDirectory()), false, "the disabled gate creates no capture directory");
    assert.equal(isCacheMonitorEnabled("1"), true);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_CACHE_MONITOR;
    else process.env.PI_WEB_CACHE_MONITOR = previous;
  }
});

test("the gate creates a real per-session monitor with its own capture directory", async () => {
  const previous = process.env.PI_WEB_CACHE_MONITOR;
  process.env.PI_WEB_CACHE_MONITOR = "1";
  try {
    const monitor = createSessionCacheMonitor();
    assert.ok(monitor, "the gate creates a monitor");
    assert.match(monitor.localEpochId, CACHE_STREAM_ID_PATTERN);
    await monitor.close({ drain: false });
    assert.equal(existsSync(cacheMonitorDirectory()), true, "captures go to the one dedicated directory");
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_CACHE_MONITOR;
    else process.env.PI_WEB_CACHE_MONITOR = previous;
  }
});

test("closing an observed runtime drains the monitor once and repeat closes are no-ops", async () => {
  const { monitor, calls } = makeFakeCacheMonitor();
  const observed = createCacheObservedRuntime(monitor, { streamSimple() {} });
  await observed.close();
  await observed.close();
  assert.deepEqual(calls, [["close", { drain: true }]], "one close with the explicit drain policy");
});

test("each session's cache monitor sees only its own streamSimple calls and the shared runtime is untouched", async () => {
  const runtime = {
    label: "shared",
    streamSimple(model, context, options) {
      const observed = context.observe === false || typeof options?.onPayload !== "function"
        ? undefined
        : options.onPayload({ prompt: context.messages[0] }, model);
      return makeCacheStream(Promise.resolve(observed).then(() => ({
        stopReason: "stop",
        usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      })));
    },
  };
  const originalStreamSimple = runtime.streamSimple;
  const originalPrototype = Object.getPrototypeOf(runtime);
  const first = makeFakeCacheMonitor();
  const second = makeFakeCacheMonitor();
  const observedFirst = createCacheObservedRuntime(first.monitor, runtime);
  const observedSecond = createCacheObservedRuntime(second.monitor, runtime);
  assert.ok(observedFirst && observedSecond, "an active monitor wraps the runtime");
  assert.notEqual(observedFirst.runtime, runtime);
  assert.notEqual(observedSecond.runtime, runtime);
  assert.equal(runtime.streamSimple, originalStreamSimple, "the shared runtime keeps its own method");
  assert.equal(Object.getPrototypeOf(runtime), originalPrototype, "the shared prototype is untouched");
  assert.match(observedFirst.localStreamId, CACHE_STREAM_ID_PATTERN);
  assert.match(observedSecond.localStreamId, CACHE_STREAM_ID_PATTERN);
  assert.notEqual(observedFirst.localStreamId, observedSecond.localStreamId);

  const firstStream = await observedFirst.runtime
    .streamSimple({ provider: "anthropic", id: "claude-x" }, { messages: ["first"] }, { onPayload: () => ({ prompt: "first" }) })
    .result();
  assert.equal(firstStream.stopReason, "stop");
  await observedSecond.runtime
    .streamSimple({ provider: "openai", id: "gpt-x" }, { messages: ["second"], observe: false }, {})
    .result();
  await nextTurn();

  const firstBegin = cacheCalls(first.calls, "beginInvocation")[0][1];
  const secondBegin = cacheCalls(second.calls, "beginInvocation")[0][1];
  assert.equal(firstBegin.localStreamId, observedFirst.localStreamId);
  assert.equal(firstBegin.invocationIndex, 0);
  assert.equal(firstBegin.provider, "anthropic");
  assert.equal(firstBegin.modelId, "claude-x");
  assert.equal(secondBegin.localStreamId, observedSecond.localStreamId);
  assert.equal(secondBegin.invocationIndex, 0, "each session counts its own invocations");
  assert.equal(secondBegin.provider, "openai");
  assert.equal(cacheCalls(first.calls, "recordRequest").length, 1);
  assert.equal(cacheCalls(first.calls, "recordResponse").length, 1);
  assert.equal(cacheCalls(second.calls, "recordRequest").length, 0, "the second session observes nothing of the first");
  assert.deepEqual(cacheCalls(second.calls, "markUnknown").map((call) => call[2]), ["telemetry_gap"]);
});

test("the per-session proxy binds other methods to the runtime so private fields keep working", () => {
  class RuntimeWithPrivateState {
    #key = "private-value";
    readKey() {
      return this.#key;
    }
    streamSimple() {
      return makeCacheStream({ stopReason: "stop" });
    }
  }
  const runtime = new RuntimeWithPrivateState();
  const observed = createCacheObservedRuntime(makeFakeCacheMonitor().monitor, runtime);
  assert.ok(observed);
  assert.equal(observed.runtime.readKey(), "private-value");
  const detached = observed.runtime.readKey;
  assert.equal(detached(), "private-value", "function values are bound to the runtime");
  const raw = runtime.readKey;
  assert.throws(() => raw(), TypeError, "an unbound method is what receiver binding prevents");
});

test("the payload callback sees the effective payload, falls back to the original, and the stream is returned as-is", async () => {
  const seen = [];
  const streams = [];
  const capturedOptions = [];
  const runtime = {
    streamSimple(model, context, options) {
      capturedOptions.push(options);
      const stream = makeCacheStream(
        Promise.resolve(options.onPayload({ prompt: context.prompt }, model)).then(() => ({ stopReason: "stop" })),
      );
      streams.push(stream);
      return stream;
    },
  };
  const { monitor, calls } = makeFakeCacheMonitor();
  const observed = createCacheObservedRuntime(monitor, runtime);
  const model = { provider: "google", id: "gemini-x" };
  const replacement = { prompt: "replacement" };
  const callback = function (payload, payloadModel) {
    seen.push({ thisValue: this, args: [payload, payloadModel] });
    return payload.prompt === "original" ? replacement : undefined;
  };

  const firstOptions = { onPayload: callback, timeoutMs: 1234 };
  const secondOptions = { onPayload: callback };
  const firstStream = observed.runtime.streamSimple(model, { prompt: "original" }, firstOptions);
  assert.equal(firstStream, streams[0], "the exact original stream object comes back");
  await firstStream.result();
  const secondStream = observed.runtime.streamSimple(model, { prompt: "fallback" }, secondOptions);
  assert.equal(secondStream, streams[1]);
  await secondStream.result();
  await nextTurn();

  assert.equal(seen.length, 2, "the original callback runs exactly once per invocation");
  assert.equal(seen[0].thisValue, firstOptions, "the callback keeps its own options receiver");
  assert.equal(capturedOptions[0].timeoutMs, 1234, "other options survive the clone");
  assert.notEqual(capturedOptions[0], firstOptions, "only the options object is cloned");
  assert.deepEqual(seen[0].args, [{ prompt: "original" }, model]);
  assert.deepEqual(seen[1].args, [{ prompt: "fallback" }, model]);
  const observedOptions = cacheCalls(calls, "recordRequest").map((call) => call[2].payload);
  assert.deepEqual(observedOptions, [replacement, { prompt: "fallback" }], "undefined keeps the original payload");
  assert.deepEqual(
    cacheCalls(calls, "beginInvocation").map((call) => call[1].invocationIndex),
    [0, 1],
    "the invocation index advances per streamSimple call",
  );
});

test("a rejected payload callback propagates unchanged and observes nothing", async () => {
  const failure = new Error("payload rejected");
  let callbackResult;
  const runtime = {
    streamSimple(model, context, options) {
      callbackResult = options.onPayload({ prompt: "x" }, model);
      return makeCacheStream(Promise.reject(failure));
    },
  };
  const { monitor, calls } = makeFakeCacheMonitor();
  const observed = createCacheObservedRuntime(monitor, runtime);
  observed.runtime.streamSimple({ provider: "other" }, {}, { onPayload: () => { throw failure; } });
  await assert.rejects(callbackResult, (error) => error === failure);
  await nextTurn();
  assert.equal(cacheCalls(calls, "recordRequest").length, 0, "a failed callback is never observed");
  assert.deepEqual(cacheCalls(calls, "markUnknown").map((call) => call[2]), ["unmatched"]);
});

test("a synchronous streamSimple throw rethrows the same error and still advances the invocation index", () => {
  const failure = new Error("stream creation failed");
  const { monitor, calls } = makeFakeCacheMonitor();
  const observed = createCacheObservedRuntime(monitor, {
    streamSimple() {
      throw failure;
    },
  });
  assert.throws(() => observed.runtime.streamSimple({ provider: "openai", id: "gpt" }, {}, {}), (error) => error === failure);
  assert.throws(() => observed.runtime.streamSimple({ provider: "openai", id: "gpt" }, {}, {}), (error) => error === failure);
  assert.deepEqual(cacheCalls(calls, "beginInvocation").map((call) => call[1].invocationIndex), [0, 1]);
  assert.deepEqual(cacheCalls(calls, "markUnknown").map((call) => call[2]), ["unmatched", "unmatched"]);
});

test("recorder failures never change generation, callback values or the returned stream", async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));

  let createdStream;
  const runtime = {
    streamSimple(model, context, options) {
      createdStream = makeCacheStream(
        Promise.resolve(options.onPayload({ prompt: context.prompt }, model)).then((value) => ({ stopReason: "stop", value })),
      );
      return createdStream;
    },
  };
  const { monitor } = makeFakeCacheMonitor();
  monitor.recordRequest = () => { throw new Error("recorder failed"); };
  monitor.recordResponse = () => { throw new Error("recorder failed"); };
  monitor.markUnknown = () => { throw new Error("recorder failed"); };
  const observed = createCacheObservedRuntime(monitor, runtime);
  const stream = observed.runtime.streamSimple({ provider: "anthropic" }, { prompt: "x" }, { onPayload: () => "kept" });
  assert.equal(stream, createdStream);
  assert.deepEqual(await stream.result(), { stopReason: "stop", value: "kept" });
  await nextTurn();
  assert.deepEqual(unhandled, [], "observer failures are swallowed, not left unhandled");
});

test("the result observer maps stopReason and payload observations to unknown or a response", async () => {
  const sdkUsage = {
    input: 11,
    output: 2,
    cacheRead: 0,
    cacheWrite: 3,
    totalTokens: 16,
    cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 },
  };
  const cases = [
    { stopReason: "error", observe: true, expected: ["recordRequest", "markUnknown"], reason: "unmatched" },
    { stopReason: "aborted", observe: true, expected: ["recordRequest", "markUnknown"], reason: "unmatched" },
    { stopReason: "stop", observe: false, expected: ["markUnknown"], reason: "telemetry_gap" },
    { stopReason: "stop", observe: true, expected: ["recordRequest", "recordResponse"] },
    { stopReason: "length", observe: true, expected: ["recordRequest", "recordResponse"] },
    { stopReason: "toolUse", observe: true, expected: ["recordRequest", "recordResponse"] },
    { stopReason: "mystery", observe: true, expected: ["recordRequest", "markUnknown"], reason: "unmatched" },
  ];
  for (const scenario of cases) {
    const { monitor, calls } = makeFakeCacheMonitor();
    const observed = createCacheObservedRuntime(monitor, {
      streamSimple(model, context, options) {
        const payloadObserved = scenario.observe ? options.onPayload({ prompt: "x" }, model) : undefined;
        return makeCacheStream(Promise.resolve(payloadObserved).then(() => ({
          stopReason: scenario.stopReason,
          usage: sdkUsage,
        })));
      },
    });
    await observed.runtime.streamSimple({ provider: "anthropic", id: "claude" }, {}, { onPayload: () => undefined }).result();
    await nextTurn();
    const observedEvents = calls.filter(([type]) => type !== "beginInvocation");
    assert.deepEqual(observedEvents.map(([type]) => type), scenario.expected, `stopReason ${scenario.stopReason}`);
    if (scenario.reason) {
      assert.equal(observedEvents.at(-1)[2], scenario.reason, `stopReason ${scenario.stopReason} reason`);
    }
    if (scenario.expected.includes("recordResponse")) {
      assert.equal(cacheCalls(calls, "recordRequest").length, 1);
      assert.deepEqual(cacheCalls(calls, "recordResponse")[0][2].usage, {
        input_tokens: 11,
        output_tokens: 2,
        cache_read_tokens: 0,
        cache_write_tokens: 3,
      });
    }
  }
});

test("invalid or missing usage becomes null counters, never inferred values", async () => {
  const cases = [
    { usage: undefined, expected: null },
    { usage: { input: -1, output: "2", cacheRead: 1.5, cacheWrite: 4 }, expected: { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: 4 } },
    { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 2147483648 }, expected: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: null } },
  ];
  for (const scenario of cases) {
    const { monitor, calls } = makeFakeCacheMonitor();
    const observed = createCacheObservedRuntime(monitor, {
      streamSimple(model, context, options) {
        return makeCacheStream(Promise.resolve(options.onPayload({ prompt: "x" }, model)).then(() => ({
          stopReason: "stop",
          usage: scenario.usage,
        })));
      },
    });
    await observed.runtime.streamSimple({ provider: "anthropic" }, {}, { onPayload: () => undefined }).result();
    await nextTurn();
    assert.deepEqual(cacheCalls(calls, "recordResponse")[0][2].usage, scenario.expected);
  }
});

test("a second payload observation marks the invocation retry_ambiguous and never pairs it", async () => {
  const { monitor, calls } = makeFakeCacheMonitor();
  const observed = createCacheObservedRuntime(monitor, {
    streamSimple(model, context, options) {
      const first = options.onPayload({ prompt: "first" }, model);
      const second = options.onPayload({ prompt: "second" }, model);
      return makeCacheStream(Promise.all([first, second]).then(() => ({ stopReason: "stop" })));
    },
  });
  await observed.runtime.streamSimple({ provider: "anthropic" }, {}, { onPayload: () => undefined }).result();
  await nextTurn();
  assert.equal(cacheCalls(calls, "recordRequest").length, 1);
  assert.equal(cacheCalls(calls, "recordRequest")[0][2].payload.prompt, "first");
  assert.deepEqual(cacheCalls(calls, "markUnknown").map((call) => call[2]), ["retry_ambiguous"]);
  assert.equal(cacheCalls(calls, "recordResponse").length, 0, "an ambiguous invocation is never paired");
});

test("the wrapper closes the cache monitor once, after the SDK session is disposed", async (t) => {
  const calls = [];
  const { inner, release } = makeClosingInner(calls);
  const dispose = inner.dispose;
  inner.dispose = () => {
    calls.push(["inner dispose"]);
    dispose();
  };
  let releaseClose;
  let closeCalls = 0;
  const wrapper = new AgentSessionWrapper(inner, {
    cacheObserver: {
      close() {
        closeCalls += 1;
        calls.push(["cache monitor close"]);
        return new Promise((resolve) => { releaseClose = resolve; });
      },
    },
  });
  const shutting = wrapper.shutdown();
  let shutdownSettled = false;
  shutting.then(() => { shutdownSettled = true; });
  await nextTurn();
  release();
  await nextTurn();
  await nextTurn();
  assert.deepEqual(calls, [["emit", "session_shutdown"], ["inner dispose"], ["dispose"], ["cache monitor close"]], "capture stops after the session is disposed");
  assert.equal(shutdownSettled, false, "shutdown waits for the monitor to drain");
  releaseClose();
  await shutting;
  assert.equal(shutdownSettled, true);
  assert.equal(closeCalls, 1);
  wrapper.destroy();
  await nextTurn();
  assert.equal(closeCalls, 1, "closing twice reuses the same close");
});

test("a session whose folder was deleted stays open but refuses prompts (#1061)", async (t) => {
  const { sessionFile, session } = await startPersistedSession(t);
  const before = readFileSync(sessionFile, "utf8");
  await rm(session.cwd, { recursive: true, force: true });

  await assert.rejects(
    session.send({ type: "prompt", message: "hello" }),
    // Typed, so the route names the folder for the composer (#1422).
    { reason: "cwd-missing", cwd: session.cwd, message: `Directory does not exist: ${session.cwd}` },
  );
  assert.equal(session.isAlive(), true);
  assert.equal(existsSync(session.cwd), false);
  assert.equal(readFileSync(sessionFile, "utf8"), before);
});
