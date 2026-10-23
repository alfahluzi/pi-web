import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { prepareProjectMove, prepareProjectPathRepair, executeProjectMove } = await jiti.import("./project-move.ts");
const { sessionProjectDirName } = await jiti.import("./project-move-paths.ts");

function writeSession(sessionsDir, cwd, id, extra = {}) {
  const dir = join(sessionsDir, sessionProjectDirName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-01-01T00-00-00_${id}.jsonl`);
  const header = { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd, ...extra };
  const message = {
    type: "message",
    id: "a1",
    parentId: null,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "user", content: "hello" },
  };
  fs.writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
  return file;
}

function fixture(t) {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const base = fs.mkdtempSync(join(tmpdir(), "pi-web-project-move-"));
  const home = join(base, "home");
  const agentDir = join(base, "agent");
  const sessionsDir = join(agentDir, "sessions");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(base, { recursive: true, force: true });
  });
  const project = join(home, "Documents", "proj");
  fs.mkdirSync(join(project, "src"), { recursive: true });
  fs.writeFileSync(join(project, "src", "index.ts"), "export {};\n");
  return { base, home, agentDir, sessionsDir, project };
}

test("prepare: plans the destination, the sessions and the contents warning", async (t) => {
  const { home, agentDir, sessionsDir, project } = fixture(t);
  writeSession(sessionsDir, project, "sess-main");
  writeSession(sessionsDir, join(project, "src"), "sess-sub");
  fs.mkdirSync(join(home, "Documents", "testing", "other"), { recursive: true });
  fs.writeFileSync(join(home, "Documents", "testing", "notes.txt"), "x");

  const prepared = await prepareProjectMove({ root: project, target: "~/Documents/testing", home, agentDir });
  assert.equal(prepared.ok, true);
  const { plan } = prepared;
  assert.equal(plan.destination, join(home, "Documents", "testing", "proj"));
  assert.equal(plan.targetDirExists, true);
  assert.deepEqual(plan.targetContents, { folders: 1, files: 1 });
  assert.equal(plan.sessions.length, 2);
  // A session opened in a subfolder keeps its place inside the project.
  const sub = plan.sessions.find((move) => move.cwd.endsWith("/src"));
  assert.equal(sub.newCwd, join(home, "Documents", "testing", "proj", "src"));
});

test("execute: moves the folder, re-files sessions and re-points a parent elsewhere", async (t) => {
  const { home, agentDir, sessionsDir, project } = fixture(t);
  const mainFile = writeSession(sessionsDir, project, "sess-main");
  const elsewhere = join(home, "elsewhere");
  fs.mkdirSync(elsewhere, { recursive: true });
  const childFile = writeSession(sessionsDir, elsewhere, "sess-child", { parentSession: mainFile });

  const prepared = await prepareProjectMove({ root: project, target: "~/Documents/testing", home, agentDir });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.plan.parentPatches.length, 1);

  const result = await executeProjectMove(prepared.plan);
  const destination = join(home, "Documents", "testing", "proj");
  assert.equal(result.destination, destination);
  assert.equal(result.movedSessions, 1);
  assert.equal(result.patchedParents, 1);
  assert.deepEqual(result.errors, []);
  assert.equal(fs.existsSync(project), false);
  assert.equal(fs.readFileSync(join(destination, "src", "index.ts"), "utf8"), "export {};\n");

  // The session followed its project: new folder, new cwd, history untouched.
  assert.equal(fs.existsSync(mainFile), false);
  const movedFile = join(sessionsDir, sessionProjectDirName(destination), "2026-01-01T00-00-00_sess-main.jsonl");
  assert.equal(fs.existsSync(movedFile), true);
  const lines = fs.readFileSync(movedFile, "utf8").split("\n");
  const header = JSON.parse(lines[0]);
  assert.equal(header.cwd, destination);
  assert.equal(JSON.parse(lines[1]).message.content, "hello");

  // The session left behind names its moved parent's new file.
  const childHeader = JSON.parse(fs.readFileSync(childFile, "utf8").split("\n")[0]);
  assert.equal(childHeader.parentSession, movedFile);
  assert.equal(childHeader.cwd, elsewhere);
});

test("execute: creates a destination that does not exist yet", async (t) => {
  const { home, agentDir, project } = fixture(t);
  const target = join(home, "fresh", "nested");
  const prepared = await prepareProjectMove({ root: project, target, home, agentDir });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.plan.targetDirExists, false);
  const result = await executeProjectMove(prepared.plan);
  assert.equal(result.destination, join(target, "proj"));
  assert.equal(fs.existsSync(join(target, "proj", "src", "index.ts")), true);
});

test("prepare refusals", async (t) => {
  const { home, agentDir, project } = fixture(t);
  const cases = [
    [{ root: project, target: "Documents/testing" }, "invalid-target"],
    [{ root: project, target: join(project, "inside") }, "target-inside-source"],
    [{ root: join(home, "nope"), target: "~/x" }, "source-missing"],
    // The home directory itself (or anything containing it) is never moved.
    [{ root: home, target: "~/x", detail: "home" }, "source-protected"],
  ];
  for (const [request, code] of cases) {
    const prepared = await prepareProjectMove({ ...request, home, agentDir });
    assert.equal(prepared.ok, false, `${request.target} should be refused`);
    assert.equal(prepared.refusal.code, code);
    if (request.detail) assert.equal(prepared.refusal.detail, request.detail, "the refusal names its case");
  }

  // An existing project folder at the destination is never merged or replaced.
  fs.mkdirSync(join(home, "Documents", "taken", "proj"), { recursive: true });
  const taken = await prepareProjectMove({ root: project, target: "~/Documents/taken", home, agentDir });
  assert.equal(taken.ok, false);
  assert.equal(taken.refusal.code, "destination-exists");

  // A symlinked project is refused: its sessions ran in the target folder.
  const link = join(home, "Documents", "link");
  fs.symlinkSync(project, link);
  const linked = await prepareProjectMove({ root: link, target: "~/Documents/testing", home, agentDir });
  assert.equal(linked.ok, false);
  assert.equal(linked.refusal.code, "source-symbolic-link");
});

test("execute: a session that moves with its parent keeps its parentSession link", async (t) => {
  const { home, agentDir, sessionsDir, project } = fixture(t);
  const mainFile = writeSession(sessionsDir, project, "sess-main");
  // A fork of the project's session: same cwd, so it moves too.
  writeSession(sessionsDir, project, "sess-fork", { parentSession: mainFile });

  const prepared = await prepareProjectMove({ root: project, target: "~/Documents/testing", home, agentDir });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.plan.sessions.length, 2);
  // Nothing outside the project needs patching: both ends move.
  assert.equal(prepared.plan.parentPatches.length, 0);

  const result = await executeProjectMove(prepared.plan);
  assert.deepEqual(result.errors, []);
  const destination = join(home, "Documents", "testing", "proj");
  const dir = join(sessionsDir, sessionProjectDirName(destination));
  const forkHeader = JSON.parse(fs.readFileSync(join(dir, "2026-01-01T00-00-00_sess-fork.jsonl"), "utf8").split("\n")[0]);
  assert.equal(forkHeader.cwd, destination);
  assert.equal(forkHeader.parentSession, join(dir, "2026-01-01T00-00-00_sess-main.jsonl"));
});

test("prepare: a destination inside pi's own folders is refused", async (t) => {
  const { home, agentDir, project } = fixture(t);
  const intoAgent = await prepareProjectMove({ root: project, target: join(agentDir, "somewhere"), home, agentDir });
  assert.equal(intoAgent.ok, false);
  assert.equal(intoAgent.refusal.code, "target-protected");
  assert.equal(intoAgent.refusal.detail, "agent-dir");

  const intoSessions = await prepareProjectMove({ root: project, target: join(agentDir, "sessions"), home, agentDir });
  assert.equal(intoSessions.ok, false);
  assert.equal(intoSessions.refusal.code, "target-protected");
});

test("the folder pi-web runs from is refused unless the caller stopped the server", async (t) => {
  const { home, agentDir, project } = fixture(t);
  const previousCwd = process.cwd();
  // Stand in for the running server: its cwd is inside the project.
  process.chdir(project);
  t.after(() => process.chdir(previousCwd));
  try {
    const refused = await prepareProjectMove({ root: project, target: "~/Documents/testing", home, agentDir });
    assert.equal(refused.ok, false);
    assert.equal(refused.refusal.code, "source-protected");
    assert.equal(refused.refusal.detail, "server-cwd");

    // scripts/move-pi-web.sh has already deleted the PM2 app when it asks for this.
    const allowed = await prepareProjectMove({ root: project, target: "~/Documents/testing", home, agentDir, allowServerCwd: true });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.plan.destination, join(home, "Documents", "testing", "proj"));
  } finally {
    process.chdir(previousCwd);
  }
});

test("repair: a folder moved by hand gets its sessions and sidebar state back", async (t) => {
  const { home, agentDir, sessionsDir, project } = fixture(t);
  const mainFile = writeSession(sessionsDir, project, "sess-main");
  const elsewhere = join(home, "elsewhere");
  fs.mkdirSync(elsewhere, { recursive: true });
  const childFile = writeSession(sessionsDir, elsewhere, "sess-child", { parentSession: mainFile });
  // The sidebar knew the project: a pinned entry, a name, a place in the order.
  fs.writeFileSync(join(agentDir, "pi-web-session-state.json"), JSON.stringify({
    version: 1,
    revision: 4,
    sessions: {},
    projects: { [project]: { pinnedAt: 7, root: project } },
    projectOrder: [project],
    projectNames: { [project]: "Proj" },
  }));
  fs.writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [project]: true }));

  // Moved by hand: the folder is elsewhere, every header still says where it was.
  const moved = join(home, "apps", "proj");
  fs.mkdirSync(dirname(moved), { recursive: true });
  fs.renameSync(project, moved);
  assert.equal(fs.existsSync(project), false);

  const prepared = await prepareProjectPathRepair({ from: project, to: moved });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.plan.kind, "repair");
  assert.equal(prepared.plan.sessions.length, 1);
  assert.equal(prepared.plan.parentPatches.length, 1);

  const result = await executeProjectMove(prepared.plan);
  assert.deepEqual(result.errors, []);
  assert.equal(result.movedSessions, 1);

  // The session file followed its new cwd, header rewritten, history untouched.
  const dir = join(sessionsDir, sessionProjectDirName(moved));
  const repairedFile = join(dir, "2026-01-01T00-00-00_sess-main.jsonl");
  assert.equal(fs.existsSync(repairedFile), true);
  assert.equal(fs.existsSync(mainFile), false);
  const header = JSON.parse(fs.readFileSync(repairedFile, "utf8").split("\n")[0]);
  assert.equal(header.cwd, moved);
  assert.equal(JSON.parse(fs.readFileSync(childFile, "utf8").split("\n")[0]).parentSession, repairedFile);

  // Footer state: the pin, the name and the order use the new key.
  const state = JSON.parse(fs.readFileSync(join(agentDir, "pi-web-session-state.json"), "utf8"));
  assert.deepEqual(state.projectOrder, [moved]);
  assert.deepEqual(state.projectNames, { [moved]: "Proj" });
  assert.deepEqual(state.projects, { [moved]: { pinnedAt: 7, root: moved } });
  assert.deepEqual(JSON.parse(fs.readFileSync(join(agentDir, "trust.json"), "utf8")), { [moved]: true });
});

test("repair refuses a folder that is still there, and a new location that is not", async (t) => {
  const { home, project } = fixture(t);
  const stillThere = await prepareProjectPathRepair({ from: project, to: join(home, "x") });
  assert.equal(stillThere.ok, false);
  // The new location is checked first: a repair cannot invent one.
  assert.equal(stillThere.refusal.code, "source-missing");

  fs.mkdirSync(join(home, "gone"), { recursive: true });
  const bothThere = await prepareProjectPathRepair({ from: join(home, "gone"), to: project });
  assert.equal(bothThere.ok, false);
  assert.equal(bothThere.refusal.code, "source-exists");

  fs.rmdirSync(join(home, "gone"));
  const neither = await prepareProjectPathRepair({ from: join(home, "gone"), to: join(home, "nowhere") });
  assert.equal(neither.ok, false);
  assert.equal(neither.refusal.code, "source-missing");
});
