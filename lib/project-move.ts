/**
 * "Move project": moves a project's folder to a directory the user chooses,
 * and carries its history and its place in the sidebar along, so the sessions
 * of that project are not left under a path that no longer exists.
 *
 * Two steps, deliberately separate. `prepareProjectMove` only reads: it
 * validates the source and the typed destination, counts what the destination
 * already holds (the menu shows that before anything moves), and plans every
 * session file that goes with the move. `executeProjectMove` then does the
 * irreversible part: shut down the project's idle wrappers, rename the folder,
 * re-file each session under the new cwd's directory with its header rewritten,
 * re-key the sidebar state and the trust decisions, invalidate the caches that
 * still name the old path, and repair the git worktrees the move broke.
 *
 * What it never does: move a folder whose sessions are running, move pi-web's
 * own working directory out from under the running server, or overwrite
 * anything at the destination. A renamed folder whose header rewrite failed is
 * reported per file rather than rolled back: every write here is atomic, and a
 * session left with its old cwd is still readable, just filed under the old
 * path.
 */

import { execFile } from "child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, relative, resolve } from "path";
import { promisify } from "util";
import { getAgentDir, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { writeFileAtomicSync } from "./atomic-file";
import { invalidateAllowedRootsCache } from "./allowed-roots";
import { mapPathUnderRoot, isPathAtOrUnder, expandProjectTarget, projectDestinationPath, sessionProjectDirName } from "./project-move-paths";
import { destroyRpcSessionsForCwd, getBusyRpcSessionCwds, getOpenRpcSessionCwds } from "./rpc-manager";
import {
  invalidateSessionListCache,
  invalidateSessionManagerCache,
  invalidateSessionPathCache,
  listAllSessions,
  readSessionHeader,
} from "./session-reader";
import { rekeySessionUiProjects, readSessionUiState } from "./session-ui-state";
import { invalidateProjectCache, listWorktrees } from "./worktree";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
/**
 * A session file is rewritten whole (the header line changes, the rest is kept
 * byte for byte). Past this size the copy would stall the server for seconds
 * for one file, so the file is reported instead of moved.
 */
const SESSION_REWRITE_MAX_BYTES = 64 * 1024 * 1024;

/** Why a move was refused: a code the sidebar turns into its own wording, and English diagnostic text. */
export type ProjectMoveRefusalCode =
  | "invalid-target"
  | "target-inside-source"
  | "target-not-directory"
  | "target-protected"
  | "destination-exists"
  | "source-missing"
  | "source-not-directory"
  | "source-symbolic-link"
  | "source-protected"
  | "sessions-running"
  | "cross-device"
  | "permission-denied"
  | "internal";

export interface ProjectMoveRefusal {
  code: ProjectMoveRefusalCode;
  /** HTTP status the route answers with. */
  status: number;
  error: string;
}

/** One session file that goes with the project. */
export interface ProjectMoveSession {
  id: string;
  from: string;
  to: string;
  /** The session's cwd today; `source` itself or a folder inside it. */
  cwd: string;
  newCwd: string;
}

/** A session file that stays where it is but names a moved session as its parent. */
export interface ProjectMoveParentPatch {
  path: string;
  from: string;
  to: string;
}

export interface ProjectMovePlan {
  source: string;
  /** The directory the project moves into; created when missing. */
  targetDir: string;
  targetDirExists: boolean;
  /** The project's folder inside `targetDir`: `targetDir` + the project's own name. */
  destination: string;
  /** Top-level folders and files already in `targetDir` (the confirmation's warning), 0 when it is new. */
  targetContents: { folders: number; files: number };
  sessions: ProjectMoveSession[];
  parentPatches: ProjectMoveParentPatch[];
  /** Session cwds of open wrappers in this tree; shut down before the rename. */
  openCwds: string[];
  /** Every registered worktree of the repository, as git lists them (paths today). */
  worktrees: string[];
  warnings: string[];
}

export interface ProjectMoveResult {
  source: string;
  destination: string;
  movedSessions: number;
  patchedParents: number;
  repairedWorktrees: string[];
  warnings: string[];
  /** Per-file failures; the folder has moved, these entries did not follow. */
  errors: string[];
}

function sessionsDir(): string {
  return join(getAgentDir(), "sessions");
}

function realPathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function refusal(code: ProjectMoveRefusalCode, status: number, error: string): { ok: false; refusal: ProjectMoveRefusal } {
  return { ok: false, refusal: { code, status, error } };
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** The nearest existing ancestor of `path` (the destination may not exist yet). */
function nearestExistingAncestor(path: string): string | null {
  let current = resolve(path);
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * `targetDir` with the symlinks that already exist resolved: a destination
 * reached through a link is one folder, and filing its sessions under the
 * link's own path would give the same project two groups (`normalizeRpcCwd`
 * resolves too). The parts that do not exist yet are kept as typed.
 */
function canonicalTarget(targetDir: string): string {
  const ancestor = nearestExistingAncestor(targetDir);
  if (ancestor === null) return targetDir;
  const real = realPathOrSelf(ancestor);
  const tail = relative(ancestor, targetDir);
  return tail === "" ? real : join(real, tail);
}

/** Running (or starting) wrappers under a tree: a move moves every folder in it. */
function busyCwdsUnder(source: string): string[] {
  return getBusyRpcSessionCwds().filter((cwd) => isPathAtOrUnder(cwd, source));
}

function topLevelCounts(dir: string): { folders: number; files: number } {
  const counts = { folders: 0, files: 0 };
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return counts;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) counts.folders += 1;
    else counts.files += 1;
  }
  return counts;
}

/**
 * Reads and validates everything the move needs, without changing anything.
 * `source` is resolved to its real path (a project reached through a symlink
 * moves the folder the symlink points at, which is what its sessions ran in).
 */
export async function prepareProjectMove(request: {
  root: string;
  target: string;
  home?: string;
  agentDir?: string;
}): Promise<{ ok: true; plan: ProjectMovePlan } | { ok: false; refusal: ProjectMoveRefusal }> {
  const home = request.home ?? homedir();
  const agentDir = request.agentDir ?? getAgentDir();

  const rawRoot = request.root?.trim();
  if (!rawRoot) return refusal("source-missing", 400, "A project path is required");
  let sourceStat;
  try {
    sourceStat = lstatSync(resolve(rawRoot));
  } catch {
    return refusal("source-missing", 404, `Project not found: ${rawRoot}`);
  }
  if (sourceStat.isSymbolicLink()) {
    // Its sessions ran in whatever it points at; moving the link would leave them behind.
    return refusal("source-symbolic-link", 409, `The project is a symbolic link: ${rawRoot}`);
  }
  if (!sourceStat.isDirectory()) {
    return refusal("source-not-directory", 400, `Not a directory: ${rawRoot}`);
  }
  const source = realPathOrSelf(resolve(rawRoot));

  // Folders whose move would break the machine or the server answering this request.
  if (dirname(source) === source) return refusal("source-protected", 409, "The filesystem root cannot be moved");
  if (isPathAtOrUnder(home, source)) {
    return refusal("source-protected", 409, `This folder contains the home directory: ${source}`);
  }
  if (isPathAtOrUnder(agentDir, source)) {
    return refusal("source-protected", 409, `This folder contains pi's own agent directory: ${source}`);
  }
  const serverCwd = realPathOrSelf(resolve(process.cwd()));
  if (isPathAtOrUnder(serverCwd, source)) {
    return refusal("source-protected", 409, `pi-web is running from this folder: ${source}`);
  }

  const typedTarget = expandProjectTarget(request.target ?? "", home);
  if (typedTarget === null) {
    return refusal("invalid-target", 400, "Enter an absolute path, or one starting with ~/");
  }
  const targetDir = canonicalTarget(typedTarget);
  if (isPathAtOrUnder(targetDir, source)) {
    return refusal("target-inside-source", 400, `The destination is inside the project itself: ${targetDir}`);
  }
  if (existsSync(targetDir) && !statSync(targetDir).isDirectory()) {
    return refusal("target-not-directory", 400, `The destination is not a directory: ${targetDir}`);
  }

  const destination = projectDestinationPath(targetDir, source);
  if (existsSync(destination)) {
    return refusal("destination-exists", 409, `Already exists: ${destination}`);
  }
  // The destination is refused where a project must never land: pi's own agent
  // directory (its sessions and state live there) and the folder pi-web itself
  // runs from (a checkout that watches its own tree).
  for (const [label, protectedPath] of [["pi's agent directory", agentDir], ["pi-web's own folder", serverCwd]] as const) {
    if (isPathAtOrUnder(destination, protectedPath)) {
      return refusal("target-protected", 409, `A project cannot be moved into ${label}: ${destination}`);
    }
  }

  // rename(2) cannot cross filesystems; catching it here keeps the refusal explicit.
  const ancestor = nearestExistingAncestor(targetDir);
  if (ancestor) {
    try {
      if (statSync(source).dev !== statSync(ancestor).dev) {
        return refusal("cross-device", 409, `The destination is on another filesystem: ${ancestor}`);
      }
    } catch {
      // A race with something deleting the ancestor: let the rename report it.
    }
  }

  const busyCwds = busyCwdsUnder(source);
  if (busyCwds.length > 0) {
    return refusal(
      "sessions-running",
      409,
      `A session in this project is running: ${busyCwds.join(", ")}`,
    );
  }

  const sessionsRoot = sessionsDir();
  const catalogue = await listAllSessions({ force: true });
  const sessions: ProjectMoveSession[] = [];
  const newPathByOld = new Map<string, string>();
  for (const session of catalogue) {
    if (!session.cwd || !session.path.endsWith(".jsonl")) continue;
    if (!isPathAtOrUnder(session.cwd, source)) continue;
    if (!existsSync(session.path)) continue;
    const newCwd = mapPathUnderRoot(session.cwd, source, destination);
    if (newCwd === null) continue;
    const to = join(sessionsRoot, sessionProjectDirName(newCwd), basename(session.path));
    newPathByOld.set(session.path, to);
    sessions.push({ id: session.id, from: session.path, to, cwd: session.cwd, newCwd });
  }

  // Sessions outside the project that name one of these as their parent keep
  // working: their `parentSession` is display metadata only, so it is re-pointed.
  const parentPatches: ProjectMoveParentPatch[] = [];
  for (const session of catalogue) {
    if (!session.relation || !session.path.endsWith(".jsonl")) continue;
    if (newPathByOld.has(session.path)) continue;
    let parentSession: string | undefined;
    try {
      parentSession = readSessionHeader(session.path)?.parentSession;
    } catch {
      continue;
    }
    if (!parentSession) continue;
    const to = newPathByOld.get(parentSession);
    if (to) parentPatches.push({ path: session.path, from: parentSession, to });
  }

  const warnings: string[] = [];
  let worktrees: string[] = [];
  try {
    worktrees = (await listWorktrees(source)).map((worktree) => worktree.path);
  } catch {
    // Not a git repository, or git is not installed: nothing to repair.
  }
  if (worktrees.length > 1) {
    warnings.push(`${worktrees.length - 1} worktree(s) belong to this repository`);
  }

  return {
    ok: true,
    plan: {
      source,
      targetDir,
      targetDirExists: existsSync(targetDir),
      destination,
      targetContents: existsSync(targetDir) ? topLevelCounts(targetDir) : { folders: 0, files: 0 },
      sessions,
      parentPatches,
      openCwds: getOpenRpcSessionCwds().filter((cwd) => isPathAtOrUnder(cwd, source)),
      worktrees,
      warnings,
    },
  };
}

/** The header line rewritten, the rest of the file as it was. */
function withHeader(text: string, header: Record<string, unknown>): string {
  const newline = text.indexOf("\n");
  if (newline < 0) return JSON.stringify(header);
  return `${JSON.stringify(header)}\n${text.slice(newline + 1)}`;
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function writeSessionFile(path: string, text: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomicSync(path, text, mode);
}

/**
 * Moves one session file to its new directory, its header carrying the new cwd.
 * A fork or subagent that moves along with its parent keeps its link too: its
 * header's `parentSession` is an absolute file path, and the parent's file
 * moves as well.
 */
function moveSessionFile(move: ProjectMoveSession, newPathByOld: ReadonlyMap<string, string>): void {
  if (statSync(move.from).size > SESSION_REWRITE_MAX_BYTES) {
    throw new Error(`Session is larger than ${Math.round(SESSION_REWRITE_MAX_BYTES / (1024 * 1024))} MB; it was not moved`);
  }
  const text = readText(move.from);
  const newline = text.indexOf("\n");
  const headerText = newline < 0 ? text : text.slice(0, newline);
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(headerText) as Record<string, unknown>;
  } catch {
    throw new Error(`Unreadable session header: ${move.from}`);
  }
  header.cwd = move.newCwd;
  if (typeof header.parentSession === "string") {
    const movedParent = newPathByOld.get(header.parentSession);
    if (movedParent) header.parentSession = movedParent;
  }
  const mode = statSync(move.from).mode & 0o777;
  // Write the new file first, then drop the old one: an interrupted move leaves
  // the history readable in the new place, never lost.
  writeSessionFile(move.to, newline < 0 ? `${JSON.stringify(header)}\n` : withHeader(text, header), mode);
  try {
    unlinkSync(move.from);
  } catch (error) {
    // Both files now hold the same session id: say where, so one can be removed.
    throw new Error(`Copied to ${move.to} but the original could not be removed (${error instanceof Error ? error.message : String(error)})`);
  }
}

function patchParentSession(patch: ProjectMoveParentPatch): void {
  const text = readText(patch.path);
  const newline = text.indexOf("\n");
  const headerText = newline < 0 ? text : text.slice(0, newline);
  const header = JSON.parse(headerText) as Record<string, unknown>;
  header.parentSession = patch.to;
  const mode = statSync(patch.path).mode & 0o777;
  writeFileAtomicSync(patch.path, newline < 0 ? `${JSON.stringify(header)}\n` : withHeader(text, header), mode);
}

/**
 * Trust decisions and sidebar keys that live under the old path follow the
 * project. Both are best effort: a trust store or sidebar state that cannot be
 * rewritten leaves a stale entry behind, which costs a trust prompt and an old
 * group's name, not the history.
 */
async function rekeyProjectState(plan: ProjectMovePlan, errors: string[]): Promise<void> {
  const uiState = readSessionUiState();
  const keys = new Set<string>([
    ...Object.keys(uiState.projects),
    ...Object.keys(uiState.projectNames ?? {}),
    ...(uiState.projectOrder ?? []),
  ]);
  const pairs: { from: string; to: string }[] = [];
  for (const key of keys) {
    const to = mapPathUnderRoot(key, plan.source, plan.destination);
    if (to !== null && to !== key) pairs.push({ from: key, to });
  }
  if (pairs.length > 0) {
    try {
      await rekeySessionUiProjects(pairs);
    } catch (error) {
      errors.push(`Sidebar state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    const store = new ProjectTrustStore(getAgentDir());
    const trustPath = join(getAgentDir(), "trust.json");
    const raw = existsSync(trustPath) ? JSON.parse(readText(trustPath)) as Record<string, unknown> : {};
    for (const [key, decision] of Object.entries(raw)) {
      const to = mapPathUnderRoot(key, plan.source, plan.destination);
      if (to === null || to === key || typeof decision !== "boolean") continue;
      store.set(to, decision);
      store.set(key, null);
    }
  } catch (error) {
    errors.push(`Trust: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Re-links a moved repository's worktrees. A worktree's `.git` file and the
 * repository's `worktrees/<name>/gitdir` hold absolute paths, so both ends of
 * every link break when either side moves. git reestablishes a link only when
 * `worktree repair` runs **in the checkout that moved** without arguments; the
 * paths form fixes the other end for worktrees that stayed behind, and running
 * it inside each of them covers one that moved on its own. Failures are
 * warnings: the files are already where the user asked.
 */
async function repairWorktrees(plan: ProjectMovePlan, warnings: string[]): Promise<string[]> {
  if (plan.worktrees.length === 0) return [];
  const repaired: string[] = [];
  const newMain = plan.destination;
  // The main checkout is never passed as a path: git repairs it from inside.
  const elsewhere = plan.worktrees
    .map((worktree) => mapPathUnderRoot(worktree, plan.source, plan.destination) ?? worktree)
    .filter((worktree) => worktree !== newMain && existsSync(worktree));

  const run = async (cwd: string, args: string[]): Promise<boolean> => {
    try {
      await execFileAsync("git", ["-C", cwd, ...args], {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, LC_ALL: "C" },
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
      warnings.push(`git worktree repair (${cwd}): ${message}`);
      return false;
    }
  };

  await run(newMain, ["worktree", "repair"]);
  if (elsewhere.length > 0) await run(newMain, ["worktree", "repair", ...elsewhere]);
  for (const worktree of elsewhere) {
    if (await run(worktree, ["worktree", "repair"])) repaired.push(worktree);
  }
  return repaired;
}

/**
 * Performs the plan: the folder moves first (one rename, nothing half-copied),
 * then every planned session file follows. Failures after the rename are
 * collected per file in `errors`; the result always says where the project is.
 */
export async function executeProjectMove(plan: ProjectMovePlan): Promise<ProjectMoveResult> {
  const errors: string[] = [];
  const warnings = [...plan.warnings];

  try {
    mkdirSync(plan.targetDir, { recursive: true });
  } catch (error) {
    const code = errorCode(error);
    if (code === "EACCES" || code === "EPERM") throw makeRefusal("permission-denied", 403, `Cannot create ${plan.targetDir}`);
    throw error;
  }

  // The plan was made moments ago; a run may have started in a second window
  // since. Moving under it would append to a file this request is about to
  // replace, and those bytes would be lost.
  const busyCwds = busyCwdsUnder(plan.source);
  if (busyCwds.length > 0) {
    throw makeRefusal("sessions-running", 409, `A session in this project is running: ${busyCwds.join(", ")}`);
  }
  // Idle wrappers hold the folder and the old session paths: shut them down
  // only once the move is certain to start, so a refusal above costs nothing.
  for (const cwd of plan.openCwds) {
    try {
      await destroyRpcSessionsForCwd(cwd);
    } catch (error) {
      errors.push(`Open session in ${cwd}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    renameSync(plan.source, plan.destination);
  } catch (error) {
    const code = errorCode(error);
    if (code === "EXDEV") throw makeRefusal("cross-device", 409, `The destination is on another filesystem: ${plan.targetDir}`);
    if (code === "EACCES" || code === "EPERM") throw makeRefusal("permission-denied", 403, `Cannot move into ${plan.targetDir}`);
    if (code === "ENOTEMPTY" || code === "EEXIST") throw makeRefusal("destination-exists", 409, `Already exists: ${plan.destination}`);
    if (code === "ENOENT") throw makeRefusal("source-missing", 404, `Project not found: ${plan.source}`);
    throw error;
  }

  const newPathByOld = new Map(plan.sessions.map((move) => [move.from, move.to]));
  let movedSessions = 0;
  for (const move of plan.sessions) {
    try {
      if (existsSync(move.to)) throw new Error(`Already exists: ${move.to}`);
      moveSessionFile(move, newPathByOld);
      invalidateSessionPathCache(move.id);
      invalidateSessionManagerCache(move.from);
      movedSessions += 1;
    } catch (error) {
      errors.push(`Session ${basename(move.from)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let patchedParents = 0;
  for (const patch of plan.parentPatches) {
    try {
      patchParentSession(patch);
      patchedParents += 1;
    } catch (error) {
      errors.push(`Session ${basename(patch.path)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await rekeyProjectState(plan, errors);
  const repairedWorktrees = await repairWorktrees(plan, warnings);

  invalidateProjectCache();
  invalidateSessionListCache();
  invalidateAllowedRootsCache();

  return {
    source: plan.source,
    destination: plan.destination,
    movedSessions,
    patchedParents,
    repairedWorktrees,
    warnings,
    errors,
  };
}

/** A refusal raised while executing (a rename that fails on a filesystem rule). */
function makeRefusal(code: ProjectMoveRefusalCode, status: number, error: string): Error & ProjectMoveRefusal {
  const failure = new Error(error) as Error & ProjectMoveRefusal;
  failure.code = code;
  failure.status = status;
  return failure;
}

export function isProjectMoveRefusal(error: unknown): error is Error & ProjectMoveRefusal {
  return error instanceof Error
    && typeof (error as Partial<ProjectMoveRefusal>).code === "string"
    && typeof (error as Partial<ProjectMoveRefusal>).status === "number";
}
