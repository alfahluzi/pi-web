import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

function setup(t) {
  const inner = {
    sessionId: "sudo-prompt-test",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    sessionManager: { getCwd: () => "/tmp" },
    agent: { state: {}, abort() {} },
    abort() {},
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  return { wrapper, events };
}

const promptCount = (events) => events.filter((event) => event.method === "input").length;

async function waitForPrompt(events, index = 0) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const requests = events.filter((event) => event.method === "input");
    if (requests.length > index) return requests[index];
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("sudo prompt never arrived");
}

test("asks the browser once and reuses the answer for later commands", async (t) => {
  const { wrapper, events } = setup(t);
  const source = wrapper.createSudoPasswordSource();

  const first = source.requestPassword("sudo apt-get install -y foo");
  const request = await waitForPrompt(events);
  assert.equal(request.secret, true);
  assert.equal(request.command, "sudo apt-get install -y foo");
  assert.equal(request.title, "sudo password");
  // The dialog must expire on its own when nobody answers.
  assert.equal(request.timeout > 0, true);
  assert.equal(typeof request.expiresAt, "number");

  await wrapper.send({ type: "extension_ui_response", id: request.id, value: "  pa ss \n" });
  // Only Enter's newline is dropped: spaces are part of the password.
  assert.equal(await first, "  pa ss ");

  assert.equal(await source.requestPassword("sudo systemctl restart nginx"), "  pa ss ");
  assert.equal(promptCount(events), 1);
});

test("a cancelled prompt runs the command without a password and caches nothing", async (t) => {
  const { wrapper, events } = setup(t);
  const source = wrapper.createSudoPasswordSource();

  const first = source.requestPassword("sudo id -u");
  const request = await waitForPrompt(events);
  await wrapper.send({ type: "extension_ui_response", id: request.id, cancelled: true });
  assert.equal(await first, undefined);

  const second = source.requestPassword("sudo id -u");
  await waitForPrompt(events, 1);
  assert.equal(promptCount(events), 2);
  const retry = await waitForPrompt(events, 1);
  await wrapper.send({ type: "extension_ui_response", id: retry.id, value: "" });
  assert.equal(await second, undefined);
});

test("a rejected password is forgotten so the next command asks again", async (t) => {
  const { wrapper, events } = setup(t);
  const source = wrapper.createSudoPasswordSource();

  const first = source.requestPassword("sudo true");
  const request = await waitForPrompt(events);
  await wrapper.send({ type: "extension_ui_response", id: request.id, value: "typo" });
  assert.equal(await first, "typo");

  source.forgetPassword();
  const second = source.requestPassword("sudo true");
  const retry = await waitForPrompt(events, 1);
  await wrapper.send({ type: "extension_ui_response", id: retry.id, value: "correct" });
  assert.equal(await second, "correct");
});

test("parallel sudo commands share one dialog", async (t) => {
  const { wrapper, events } = setup(t);
  const source = wrapper.createSudoPasswordSource();

  const both = Promise.all([
    source.requestPassword("sudo first"),
    source.requestPassword("sudo second"),
  ]);
  const request = await waitForPrompt(events);
  await wrapper.send({ type: "extension_ui_response", id: request.id, value: "once" });

  assert.deepEqual(await both, ["once", "once"]);
  assert.equal(promptCount(events), 1);
});

test("an aborted run does not leave a prompt behind", async (t) => {
  const { wrapper, events } = setup(t);
  const source = wrapper.createSudoPasswordSource();
  const controller = new AbortController();
  controller.abort();

  assert.equal(await source.requestPassword("sudo id -u", controller.signal), undefined);
  assert.equal(promptCount(events), 0);
});

test("destroying the wrapper drops the cached password", async (t) => {
  const { wrapper, events } = setup(t);
  const source = wrapper.createSudoPasswordSource();

  const first = source.requestPassword("sudo id -u");
  const request = await waitForPrompt(events);
  await wrapper.send({ type: "extension_ui_response", id: request.id, value: "cached" });
  assert.equal(await first, "cached");

  wrapper.destroy();
  assert.equal(await source.requestPassword("sudo id -u"), undefined);
  assert.equal(promptCount(events), 1);
});

test("a queued sudo call honours Stop instead of waiting for the open dialog", async (t) => {
  const { wrapper, events } = setup(t);
  const source = wrapper.createSudoPasswordSource();
  const controller = new AbortController();

  const head = source.requestPassword("sudo first");
  await waitForPrompt(events);
  const queued = source.requestPassword("sudo second", controller.signal);
  controller.abort();
  assert.equal(await queued, undefined);

  const request = await waitForPrompt(events);
  await wrapper.send({ type: "extension_ui_response", id: request.id, value: "only-head" });
  assert.equal(await head, "only-head");
  assert.equal(promptCount(events), 1);
});
