/**
 * Flat row model of the sidebar's session tree.
 *
 * Every project is a collapsible group of session families; pinned families
 * move to one global section above the groups, archived families leave the
 * tree for the archive view. The component renders `rows` with a virtualizer
 * over per-kind heights (`getRowOffsets` + `getVisibleRowIndices`), so every
 * decision about what is shown lives here, pure and testable.
 *
 * With `pathTree` the groups nest by the projects' paths instead of standing
 * in one list: a folder above two projects is a row of its own, and a folder
 * above a single one is not (its segment joins the child's label, unless it
 * leads the tree, in which case it is dropped: every path on one machine
 * shares it). A project's own sessions stay under its header and its deeper
 * projects follow them, so a project's chevron still folds only its sessions.
 * Pinned projects stay in the flat band above the tree, which is why their
 * header names its parent folder (`parentLabel`): pulled out of the tree, the
 * folder is the only thing that tells two projects of the same name apart.
 *
 * Pin and archive flags are keyed by the family ROOT session id. An archived
 * family returns on its own when the root session gets a newer message
 * (`root.modified`, not `latestModified`: subagent activity alone does not
 * bring it back) or while any member is running.
 *
 * Groups keep the stored project order (`projectOrder`): activity never moves
 * a project that has a place in it. Pinned projects come first, then the
 * rest; in each band the projects without a place come first.
 */

import { getSessionFamily, listSessionFamilies, type SessionFamily } from "./session-family";
import { storedProjectName, type ProjectMovePosition, type SessionUiFamilyState, type SessionUiState } from "./session-ui-state-shared";
import type { SessionInfo } from "./types";
import { workspaceKeyOf } from "./workspace-memory";

export type SidebarLayout = "desktop" | "mobile";
export type SidebarRowKind =
  | "pinned-header" | "session" | "pinned-more" | "folder" | "group" | "group-more" | "group-empty"
  | "spacer" | "footer-open" | "footer-archived" | "archive-group";

/**
 * Per-kind row heights: one rhythm. Session rows, the section headers (a
 * project's, the pinned section's, the archive's projects), the empty
 * group's note and the footer are one height, 28px (44px on a phone, a
 * finger's minimum for the rows); only "show more" is a step shorter. A
 * spacer opens the list and parts the pinned section from the groups, one
 * group from the next and the groups from the footer.
 */
export const SIDEBAR_ROW_HEIGHTS: Record<SidebarLayout, Record<SidebarRowKind, number>> = {
  desktop: { "pinned-header": 28, session: 28, "pinned-more": 26, folder: 28, group: 28, "group-more": 26, "group-empty": 28, spacer: 8, "footer-open": 28, "footer-archived": 28, "archive-group": 28 },
  mobile: { "pinned-header": 44, session: 44, "pinned-more": 36, folder: 44, group: 44, "group-more": 36, "group-empty": 44, spacer: 8, "footer-open": 44, "footer-archived": 44, "archive-group": 44 },
};
export const GROUP_VISIBLE_LIMIT = 6;
export const PINNED_VISIBLE_LIMIT = 8;
/** How many more families each "show more" click reveals. */
export const SHOW_MORE_STEP = 20;
/** `moreShown` entry for the pinned section's "show more". */
export const PINNED_MORE_KEY = "pinned";

/**
 * `name` is what the sidebar shows: the user's display name for the project
 * (`customName`, from its group menu's Rename…), else its folder's name.
 */
export interface SidebarProject { key: string; root: string; name: string; customName: string | null; pinned: boolean; current: boolean }
export interface SidebarFamilyStatus { running: boolean; awaiting: boolean; unread: boolean; selected: boolean; transient: boolean }
/**
 * A folder row of the path tree: a directory above the projects, with its own
 * fold choice (kept in the same browser map as the groups', under
 * `folderKeyOf()`, so a project key can never collide with it).
 */
export interface SidebarFolder {
  key: string;
  /** Segments from the tree's top down to this folder, joined with "/". */
  path: string;
  /** Its name, with any single-child folders absorbed: "code/api". */
  label: string;
  depth: number;
  expanded: boolean;
  /** Project keys of its whole subtree, in tree order. */
  projectKeys: string[];
}

// A folded header's counts follow its rows' right column: a family awaiting
// input counts as awaiting, not running.
export type SidebarRow =
  | { kind: "pinned-header"; key: "pinned-header"; count: number; collapsed: boolean; running: number; awaiting: number; unread: number }
  | {
    kind: "folder";
    key: string;
    path: string;
    label: string;
    depth: number;
    expanded: boolean;
    projectCount: number;
    /** This folder is a pinned project pulled out to the band above. */
    pinnedAbove: boolean;
    running: number;
    awaiting: number;
    unread: number;
  }
  | { kind: "session"; key: string; family: SessionFamily; context: "pinned" | "group" | "archive"; project: SidebarProject; status: SidebarFamilyStatus; depth: number }
  | { kind: "pinned-more"; key: "pinned-more"; hidden: number; canShowLess: boolean; nextShown: number }
  | {
    kind: "group";
    key: string;
    project: SidebarProject;
    expanded: boolean;
    depth: number;
    /** The node above it in the path tree: a folder's key, another project's, or null at the top. */
    parentKey: string | null;
    /** The folder it sits in, for a pinned project pulled out of the tree. */
    parentLabel: string | null;
    /** Another project shares its parent, so it can be reordered among them. */
    movable: boolean;
    running: number;
    awaiting: number;
    unread: number;
  }
  | { kind: "group-more"; key: string; projectKey: string; depth: number; hidden: number; canShowLess: boolean; nextShown: number }
  | { kind: "group-empty"; key: string; project: SidebarProject; depth: number }
  | { kind: "spacer"; key: "top-spacer" | "pinned-spacer" | "footer-spacer" | `group-spacer:${string}` }
  | { kind: "footer-open"; key: "footer-open" }
  | { kind: "footer-archived"; key: "footer-archived"; count: number }
  | { kind: "archive-group"; key: string; project: SidebarProject; count: number; expanded: boolean };

export interface SessionTreeInput {
  /** The full catalog (allSessions), subagents included. */
  sessions: readonly SessionInfo[];
  uiState: SessionUiState;
  runningIds: ReadonlySet<string>;
  /** Members parked on an extension's blocking dialog, a subset of runningIds (/api/agent/running). */
  awaitingIds?: ReadonlySet<string>;
  unreadIds: ReadonlySet<string>;
  selectedSessionId: string | null;
  /** projectFor(selectedCwd); shown as a group even without sessions. */
  currentProject: { key: string; root: string } | null;
  /**
   * Explicit user choices (from prefs) over the groups kept open for the
   * page (effectiveGroupExpansion); see isGroupExpanded.
   */
  groupExpansion: Readonly<Record<string, boolean>>;
  /** Families revealed beyond the base limit by "show more", per projectKey or PINNED_MORE_KEY. */
  moreShown: Readonly<Record<string, number>>;
  pinnedCollapsed: boolean;
  /** Nest the groups by their paths (the sidebar's choice, lib/sidebar-prefs.ts). */
  pathTree: boolean;
}

export interface SessionTreeModel {
  rows: SidebarRow[];
  /** Projects in group order. */
  projects: SidebarProject[];
  /** Archived families across all projects. */
  archivedCount: number;
  /**
   * Shown projects without a place in `projectOrder`, per band, top to
   * bottom: a move saves its band's ones first, so it lands where it was seen.
   */
  unorderedKeysByBand: { pinned: string[]; other: string[] };
  /**
   * Of those, the ones the sidebar saves on its own, top to bottom: pinned
   * projects, and projects with a saved (not transient) live family. Not the
   * current project while it has none, nor a project of transient sessions
   * only: either may never get a file.
   */
  projectKeysToRecord: string[];
  /** The path tree's folder rows, top to bottom (empty without `pathTree`). */
  folders: SidebarFolder[];
  /**
   * Project keys sharing a parent in the tree (the key included, in tree
   * order): a folder's projects, a project's deeper projects, or the tree's
   * top rows. Everything else is not a sibling, so a move never crosses a
   * folder, where it would mean nothing.
   */
  siblingProjects: Record<string, string[]>;
  /** The folder keys above each project, top first (empty without `pathTree`). */
  ancestorFolders: Record<string, string[]>;
}

type FamilyFlagsInput = Pick<SessionTreeInput, "uiState" | "runningIds" | "awaitingIds" | "unreadIds" | "selectedSessionId">;

function familyEntry(state: SessionUiState, rootId: string): SessionUiFamilyState | undefined {
  // Session ids such as "constructor" must not resolve to Object.prototype members.
  return Object.hasOwn(state.sessions, rootId) ? state.sessions[rootId] : undefined;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Time value for ordering: newest first, unparsable dates last. */
function timeOf(value: string): number {
  const time = Date.parse(value);
  return Number.isNaN(time) ? -Infinity : time;
}

/** Descending comparison that is safe for ±Infinity (a - b would give NaN). */
function compareDesc(a: number, b: number): number {
  return a === b ? 0 : a > b ? -1 : 1;
}

export function familyIds(family: SessionFamily): string[] {
  return [family.root.id, ...family.subagents.map((session) => session.id)];
}

function anyMemberIn(family: SessionFamily, ids: ReadonlySet<string>): boolean {
  if (ids.size === 0) return false;
  return ids.has(family.root.id) || family.subagents.some((session) => ids.has(session.id));
}

function isMember(family: SessionFamily, sessionId: string | null): boolean {
  if (!sessionId) return false;
  return family.root.id === sessionId || family.subagents.some((session) => session.id === sessionId);
}

/**
 * archivedAt set AND no family member running AND (root.detailsPending OR
 * archivedAt >= Date.parse(root.modified)). A summary row (detailsPending)
 * carries only stat metadata, so its time is not trusted to un-archive; an
 * unparsable root.modified likewise keeps the family archived.
 */
export function isFamilyArchived(family: SessionFamily, state: SessionUiState, runningIds: ReadonlySet<string>): boolean {
  const archivedAt = finiteNumber(familyEntry(state, family.root.id)?.archivedAt);
  if (archivedAt === null) return false;
  if (anyMemberIn(family, runningIds)) return false;
  if (family.root.detailsPending) return true;
  const modified = Date.parse(family.root.modified);
  return Number.isNaN(modified) || archivedAt >= modified;
}

/** pinnedAt set AND not isFamilyArchived. */
export function isFamilyPinned(family: SessionFamily, state: SessionUiState, runningIds: ReadonlySet<string>): boolean {
  return finiteNumber(familyEntry(state, family.root.id)?.pinnedAt) !== null
    && !isFamilyArchived(family, state, runningIds);
}

/** Last path segment of a project root, for "/" and "\\" paths alike. */
export function projectNameOf(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, "");
  // "/" (or "\\", "//") is a filesystem root: show it as is.
  if (!trimmed) return root.charAt(0);
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return trimmed.slice(separator + 1);
}

/** Explicit choice wins; by default the current and pinned projects are open. */
export function isGroupExpanded(project: SidebarProject, groupExpansion: Readonly<Record<string, boolean>>): boolean {
  if (Object.hasOwn(groupExpansion, project.key)) {
    const choice = groupExpansion[project.key];
    if (typeof choice === "boolean") return choice;
  }
  return project.current || project.pinned;
}

/**
 * Display segments of a project root: "/home/x/proj" → ["home", "x", "proj"],
 * "C:\\a\\b" → ["C:", "a", "b"]. A filesystem root is one segment (itself).
 */
export function pathSegments(root: string): string[] {
  const trimmed = root.replace(/[\\/]+$/, "");
  const segments = trimmed.split(/[\\/]+/).filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments : [root];
}

/**
 * A folder row's key: its path under a prefix of its own, so a folder can
 * never take a project's key (nor the other way round) in the one browser map
 * that holds both fold choices (lib/sidebar-prefs.ts).
 */
export function folderKeyOf(path: string): string {
  return `dir:${path}`;
}

/** The name of the folder above a project root, or null at a filesystem root. */
export function parentFolderNameOf(root: string): string | null {
  const segments = pathSegments(root);
  return segments.length > 1 ? segments[segments.length - 2] : null;
}

type PathLevel = Map<string, PathNodeInput>;

interface PathNodeInput {
  /** Segments from the tree's top down to this folder, joined with "/". */
  path: string;
  segment: string;
  /** The project rooted here, if any. */
  project: SidebarProject | null;
  children: PathLevel;
}

type PathNode = Omit<PathNodeInput, "segment" | "children"> & { label: string; children: PathNode[] };

/**
 * A root's own text before its first segment: "/" for a POSIX path, nothing
 * past a drive ("C:"), a network path's prefix. Kept so a folder row's tooltip
 * names the folder as the filesystem does.
 */
function rootPrefixOf(root: string): string {
  const at = root.indexOf(pathSegments(root)[0]);
  return at > 0 ? root.slice(0, at) : "";
}

/** `root` as the path tree writes a node's path (buildPathTree). */
function treePathOf(root: string): string {
  return rootPrefixOf(root) + pathSegments(root).join("/");
}

/**
 * The projects' roots as a folder tree, in the order `projects` has. A node's
 * `path` is the folder's own text with "/" between its segments and whatever
 * came before its first one: it is what a row's tooltip shows and what
 * `folderKeyOf()` keys its fold by.
 */
function buildPathTree(projects: readonly SidebarProject[]): PathLevel {
  const top: PathLevel = new Map();
  for (const project of projects) {
    const segments = pathSegments(project.root);
    const prefix = rootPrefixOf(project.root);
    let level = top;
    let node: PathNodeInput | null = null;
    for (const [index, segment] of segments.entries()) {
      let next = level.get(segment);
      if (!next) {
        next = { path: prefix + segments.slice(0, index + 1).join("/"), segment, project: null, children: new Map() };
        level.set(segment, next);
      }
      node = next;
      level = next.children;
    }
    // A root is one path: its segments end where the project is.
    if (node) node.project = project;
  }
  return top;
}

/**
 * A folder above one child is not a row of its own: its segment joins the
 * child's label ("code/api"). Inside the tree that keeps where a project sits
 * without spending a row on every level between two projects.
 */
function foldPathNode(input: PathNodeInput): PathNode {
  let label = input.segment;
  let { path, project, children } = input;
  while (project === null && children.size === 1) {
    const only = [...children.values()][0];
    label = `${label}/${only.segment}`;
    path = only.path;
    project = only.project;
    children = only.children;
  }
  return { path, label, project, children: [...children.values()].map(foldPathNode) };
}

/**
 * The tree's top rows. A folder leading to the projects drops its own
 * segments instead of carrying them into a label: every path on one machine
 * shares them ("home", "Users", "C:"), so they say nothing about a project
 * and would make every top row long.
 */
function pathTreeRoots(top: PathLevel): PathNode[] {
  const roots: PathNode[] = [];
  for (const start of top.values()) {
    let node = start;
    while (node.project === null && node.children.size === 1) node = [...node.children.values()][0];
    roots.push(foldPathNode(node));
  }
  return roots;
}

/** The projects of a node's subtree, the node's own first, in tree order. */
function projectsUnder(node: PathNode): SidebarProject[] {
  return [
    ...(node.project ? [node.project] : []),
    ...node.children.flatMap(projectsUnder),
  ];
}

/** Every project of a tree, depth-first, whether its folders are open or not. */
function projectsOfTree(nodes: readonly PathNode[]): SidebarProject[] {
  return nodes.flatMap(projectsUnder);
}

/**
 * A folder is open unless this browser says otherwise: an explicit choice
 * wins, and a folder nobody touched is open only when it matters. Folded by
 * default keeps a deep tree readable (the point of nesting); open when it
 * holds the current project's path, or a run, an unread or a blocked session
 * would hide behind a closed row.
 */
function isFolderExpanded(
  key: string,
  projectKeys: readonly string[],
  activity: { running: number; awaiting: number; unread: number },
  input: Pick<SessionTreeInput, "groupExpansion" | "currentProject">,
): boolean {
  if (Object.hasOwn(input.groupExpansion, key)) {
    const choice = input.groupExpansion[key];
    if (typeof choice === "boolean") return choice;
  }
  if (activity.running > 0 || activity.awaiting > 0 || activity.unread > 0) return true;
  return input.currentProject !== null && projectKeys.includes(input.currentProject.key);
}

/**
 * The groups kept open for the page once `outgoing`, the project that was
 * current, no longer is (`outgoing` as the new model has it). A group open
 * only by the "current" default would fold up at once: picking a session in
 * another group would move every row below it, the clicked one included,
 * from under the pointer. It stays open for the page's life instead, never
 * as a saved choice: saved, every project ever visited would come back open
 * after a reload. Returns `keptOpen` itself when nothing changes: an explicit
 * choice in `groupExpansion` (the saved ones), a group already kept open, a
 * pinned project (open by default anyway), a project still current, or one
 * without a group any more.
 */
export function keepOutgoingGroupOpen(
  keptOpen: ReadonlySet<string>,
  groupExpansion: Readonly<Record<string, boolean>>,
  outgoing: SidebarProject | undefined,
): ReadonlySet<string> {
  if (!outgoing || outgoing.current || outgoing.pinned) return keptOpen;
  if (keptOpen.has(outgoing.key) || Object.hasOwn(groupExpansion, outgoing.key)) return keptOpen;
  return new Set(keptOpen).add(outgoing.key);
}

/**
 * What the tree shows and every toggle reads: the saved choices over the
 * groups kept open for the page (keepOutgoingGroupOpen). Returns
 * `groupExpansion` itself while none is kept open. Never saved: only
 * explicit choices are.
 */
export function effectiveGroupExpansion(
  groupExpansion: Readonly<Record<string, boolean>>,
  keptOpen: ReadonlySet<string>,
): Readonly<Record<string, boolean>> {
  if (keptOpen.size === 0) return groupExpansion;
  // fromEntries defines own properties, so no key can reach the prototype.
  return Object.fromEntries([
    ...[...keptOpen].filter((key) => !Object.hasOwn(groupExpansion, key)).map((key) => [key, true] as const),
    ...Object.entries(groupExpansion),
  ]);
}

/**
 * `keptOpen` without the groups an explicit choice now covers (`keys`; null
 * for a choice made for every group at once). Returns `keptOpen` itself
 * when none of them was in it.
 */
export function forgetKeptOpenGroups(keptOpen: ReadonlySet<string>, keys: readonly string[] | null): ReadonlySet<string> {
  if (keptOpen.size === 0) return keptOpen;
  if (keys === null) return new Set();
  if (!keys.some((key) => keptOpen.has(key))) return keptOpen;
  const next = new Set(keptOpen);
  for (const key of keys) next.delete(key);
  return next;
}

function familyStatus(family: SessionFamily, input: FamilyFlagsInput): SidebarFamilyStatus {
  return {
    running: anyMemberIn(family, input.runningIds),
    awaiting: input.awaitingIds ? anyMemberIn(family, input.awaitingIds) : false,
    unread: anyMemberIn(family, input.unreadIds),
    selected: isMember(family, input.selectedSessionId),
    transient: family.root.transient === true,
  };
}

function activityCounts(
  families: readonly SessionFamily[],
  input: Pick<SessionTreeInput, "runningIds" | "awaitingIds" | "unreadIds">,
): { running: number; awaiting: number; unread: number } {
  let running = 0;
  let awaiting = 0;
  let unread = 0;
  for (const family of families) {
    if (input.awaitingIds && anyMemberIn(family, input.awaitingIds)) awaiting++;
    else if (anyMemberIn(family, input.runningIds)) running++;
    if (anyMemberIn(family, input.unreadIds)) unread++;
  }
  return { running, awaiting, unread };
}

function familyProjectKey(family: SessionFamily): string {
  return workspaceKeyOf(family.root);
}

function familyProjectRoot(family: SessionFamily): string {
  return family.root.projectRoot ?? family.root.cwd;
}

/**
 * SidebarProject for every key that is referenced. The root path comes from
 * the newest family of that key (families arrive newest first), then from the
 * current project, then from the pinned-project entry.
 */
function createProjectResolver(
  uiState: SessionUiState,
  currentProject: { key: string; root: string } | null,
) {
  const roots = new Map<string, string>();
  const projects = new Map<string, SidebarProject>();

  return {
    noteFamily(family: SessionFamily) {
      const key = familyProjectKey(family);
      if (!roots.has(key)) roots.set(key, familyProjectRoot(family));
    },
    get(key: string): SidebarProject {
      const cached = projects.get(key);
      if (cached) return cached;
      const pinnedEntry = Object.hasOwn(uiState.projects, key) ? uiState.projects[key] : undefined;
      const current = currentProject !== null && currentProject.key === key;
      const root = roots.get(key)
        ?? (current ? currentProject.root : undefined)
        ?? pinnedEntry?.root
        ?? key;
      const customName = storedProjectName(uiState, key) ?? null;
      const project: SidebarProject = {
        key,
        root,
        name: customName ?? projectNameOf(root),
        customName,
        pinned: pinnedEntry !== undefined,
        current,
      };
      projects.set(key, project);
      return project;
    },
  };
}

function sessionRow(
  family: SessionFamily,
  context: "pinned" | "group" | "archive",
  project: SidebarProject,
  depth: number,
  input: FamilyFlagsInput,
): SidebarRow {
  return {
    kind: "session",
    key: `session:${context}:${family.root.id}`,
    family,
    context,
    project,
    status: familyStatus(family, input),
    depth,
  };
}

/**
 * The first `limit` families, the `shown` positions "show more" opened past
 * them, and any later family that is running, unread or selected (sorted
 * order kept). Positions, not a budget: a family that turns selected, unread
 * or running inside the window keeps its place and frees nothing, so picking
 * the last revealed row never brings in an older one below it. `revealed`
 * counts the rows only the window shows (what "show less" would fold);
 * `nextShown` is the window a "show more" click opens, decided at the click:
 * SHOW_MORE_STEP more hidden families past this one (those that show anyway
 * do not use up the click), or all that are left, and a long project never
 * mounts all of its rows at once.
 */
function visibleFamilies(
  families: readonly SessionFamily[],
  limit: number,
  shown: number,
  input: FamilyFlagsInput,
): { visible: SessionFamily[]; revealed: number; nextShown: number } {
  const flagged = families.map((family, index) => {
    if (index < limit) return false;
    const status = familyStatus(family, input);
    return status.running || status.unread || status.selected;
  });
  const end = limit + shown;
  let revealed = 0;
  const visible = families.filter((_family, index) => {
    if (index < limit || flagged[index]) return true;
    if (index < end) {
      revealed++;
      return true;
    }
    return false;
  });
  let next = Math.max(limit, Math.min(end, families.length));
  for (let hidden = 0; next < families.length && hidden < SHOW_MORE_STEP; next++) {
    if (!flagged[next]) hidden++;
  }
  return { visible, revealed, nextShown: next - limit };
}

/** Positions "show more" has opened past the base limit for `key` (0 when none or malformed). */
export function shownMoreFor(moreShown: Readonly<Record<string, number>>, key: string): number {
  if (!Object.hasOwn(moreShown, key)) return 0;
  const value = moreShown[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** One "show more" click for `key`: the window its more row offers (`nextShown`). */
export function showMoreFamilies(moreShown: Readonly<Record<string, number>>, key: string, nextShown: number): Record<string, number> {
  return { ...moreShown, [key]: Math.max(shownMoreFor(moreShown, key), Math.floor(nextShown)) };
}

/**
 * `moreShown` without the windows of the groups an explicit choice folds
 * (`keys`, the groups it covers; null: every group in `choices`): a group
 * opened again shows its first rows only, not the window it had. Returns
 * `moreShown` itself when none of them had one.
 */
export function forgetShownMoreOfFolded(
  moreShown: Readonly<Record<string, number>>,
  choices: Readonly<Record<string, boolean>>,
  keys: readonly string[] | null,
): Record<string, number> {
  const folded = (keys ?? Object.keys(choices)).filter((key) => choices[key] === false && Object.hasOwn(moreShown, key));
  if (folded.length === 0) return moreShown as Record<string, number>;
  const next = { ...moreShown };
  for (const key of folded) delete next[key];
  return next;
}

/** "Show less": back to the base limit for `key`. */
export function showLessFamilies(moreShown: Readonly<Record<string, number>>, key: string): Record<string, number> {
  if (!Object.hasOwn(moreShown, key)) return moreShown as Record<string, number>;
  const next = { ...moreShown };
  delete next[key];
  return next;
}

/**
 * The "show more" row: how many families are still hidden, and whether
 * "show less" would fold anything back (only rows "show more" revealed; the
 * running, unread or selected ones stay). Null when neither applies.
 */
function moreRowState(total: number, visible: number, revealed: number): { hidden: number; canShowLess: boolean } | null {
  const hidden = total - visible;
  const canShowLess = revealed > 0;
  return hidden > 0 || canShowLess ? { hidden, canShowLess } : null;
}

export function buildSessionTree(input: SessionTreeInput): SessionTreeModel {
  const { uiState, runningIds, currentProject } = input;
  const families = listSessionFamilies(input.sessions);
  const resolver = createProjectResolver(uiState, currentProject);

  let archivedCount = 0;
  const pinnedFamilies: SessionFamily[] = [];
  // Insertion order follows family activity (newest first).
  const projectFamilies = new Map<string, SessionFamily[]>();
  const projectActivity = new Map<string, number>();
  // Projects with a live family that has a file (pinned families included).
  const savedKeys = new Set<string>();

  for (const family of families) {
    if (isFamilyArchived(family, uiState, runningIds)) {
      archivedCount++;
      continue;
    }
    resolver.noteFamily(family);
    const key = familyProjectKey(family);
    const activity = timeOf(family.latestModified);
    projectActivity.set(key, Math.max(projectActivity.get(key) ?? -Infinity, activity));
    if (!family.root.transient) savedKeys.add(key);
    if (isFamilyPinned(family, uiState, runningIds)) {
      pinnedFamilies.push(family);
      continue;
    }
    const list = projectFamilies.get(key);
    if (list) list.push(family);
    else projectFamilies.set(key, [family]);
  }

  // A spacer keeps the first section's header off the toolbar's line (#1338).
  const rows: SidebarRow[] = [{ kind: "spacer", key: "top-spacer" }];

  // Pinned section: newest pin first; ties keep family activity order.
  if (pinnedFamilies.length > 0) {
    const pinnedAt = (family: SessionFamily) => finiteNumber(familyEntry(uiState, family.root.id)?.pinnedAt) ?? 0;
    const sorted = pinnedFamilies
      .map((family, index) => ({ family, index }))
      .sort((a, b) => compareDesc(pinnedAt(a.family), pinnedAt(b.family)) || a.index - b.index)
      .map(({ family }) => family);
    const { running, awaiting, unread } = activityCounts(sorted, input);
    rows.push({ kind: "pinned-header", key: "pinned-header", count: sorted.length, collapsed: input.pinnedCollapsed, running, awaiting, unread });
    if (!input.pinnedCollapsed) {
      const { visible, revealed, nextShown } = visibleFamilies(sorted, PINNED_VISIBLE_LIMIT, shownMoreFor(input.moreShown, PINNED_MORE_KEY), input);
      for (const family of visible) {
        rows.push(sessionRow(family, "pinned", resolver.get(familyProjectKey(family)), 0, input));
      }
      const more = moreRowState(sorted.length, visible.length, revealed);
      if (more) rows.push({ kind: "pinned-more", key: "pinned-more", ...more, nextShown });
    }
    rows.push({ kind: "spacer", key: "pinned-spacer" });
  }

  // Projects: live non-pinned families, the current project, pinned projects.
  const projectKeys: string[] = [...projectFamilies.keys()];
  const seen = new Set(projectKeys);
  const addKey = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    projectKeys.push(key);
  };
  if (currentProject) addKey(currentProject.key);
  for (const key of Object.keys(uiState.projects)) addKey(key);

  const projects = projectKeys.map((key) => resolver.get(key));
  // A Map: a stored key such as "constructor" must not find a prototype member.
  const rank = new Map<string, number>();
  (uiState.projectOrder ?? []).forEach((key, index) => {
    if (!rank.has(key)) rank.set(key, index);
  });
  const recordable = (project: SidebarProject) => project.pinned || savedKeys.has(project.key);
  // Projects without a place come first, in the fallback order, the ones that
  // are not saved on their own (transient only, the empty current project)
  // before the others: saving those then changes nothing on screen.
  type Indexed = { project: SidebarProject; index: number };
  const orderBand = (band: Indexed[], fallback: (a: Indexed, b: Indexed) => number): SidebarProject[] => [
    ...band
      .filter(({ project }) => !rank.has(project.key))
      .sort((a, b) => Number(recordable(a.project)) - Number(recordable(b.project)) || fallback(a, b)),
    ...band
      .filter(({ project }) => rank.has(project.key))
      .sort((a, b) => (rank.get(a.project.key) ?? 0) - (rank.get(b.project.key) ?? 0)),
  ].map(({ project }) => project);
  const activityOf = (project: SidebarProject) => projectActivity.get(project.key)
    ?? (project.current ? Infinity : -Infinity);
  const projectPinnedAt = (project: SidebarProject) => finiteNumber(uiState.projects[project.key]?.pinnedAt) ?? 0;
  const indexed = projects.map((project, index) => ({ project, index }));
  const pinnedProjects = orderBand(
    indexed.filter(({ project }) => project.pinned),
    (a, b) => compareDesc(projectPinnedAt(b.project), projectPinnedAt(a.project)) || a.index - b.index,
  );
  const otherProjects = orderBand(
    indexed.filter(({ project }) => !project.pinned),
    (a, b) => compareDesc(activityOf(a.project), activityOf(b.project)) || a.index - b.index,
  );
  const orderedProjects = [...pinnedProjects, ...otherProjects];
  const unorderedKeys = (band: SidebarProject[]) => band.filter((project) => !rank.has(project.key)).map((project) => project.key);

  // Per project, once: a folder's counts are its projects' added up.
  const countByProject = new Map<string, { running: number; awaiting: number; unread: number }>();
  const countsOf = (project: SidebarProject) => {
    let counts = countByProject.get(project.key);
    if (!counts) {
      counts = activityCounts(projectFamilies.get(project.key) ?? [], input);
      countByProject.set(project.key, counts);
    }
    return counts;
  };

  const folders: SidebarFolder[] = [];
  // Maps until the end: a project key is a path, and a stored one must never
  // reach Object.prototype (the return converts them with
  // Object.fromEntries, which defines own properties).
  const siblingProjects = new Map<string, string[]>();
  const ancestorFolders = new Map<string, string[]>();
  // The projects in the order they show: the pinned band, then the tree's
  // depth-first walk (or the band's own order without one). A folded folder
  // hides its rows, never its projects: the order saved for them is the one
  // they have when it opens.
  let treeProjects: SidebarProject[] = [];

  // A group's own rows under its header: no sessions yet, the families, "show more".
  const groupFamilyRows = (project: SidebarProject, depth: number, expanded: boolean) => {
    if (!expanded) return;
    const groupFamilies = projectFamilies.get(project.key) ?? [];
    if (groupFamilies.length === 0) {
      rows.push({ kind: "group-empty", key: `empty:${project.key}`, project, depth });
      return;
    }
    const { visible, revealed, nextShown } = visibleFamilies(groupFamilies, GROUP_VISIBLE_LIMIT, shownMoreFor(input.moreShown, project.key), input);
    for (const family of visible) rows.push(sessionRow(family, "group", project, depth, input));
    const more = moreRowState(groupFamilies.length, visible.length, revealed);
    if (more) rows.push({ kind: "group-more", key: `more:${project.key}`, projectKey: project.key, depth, ...more, nextShown });
  };

  const visibleGroupRows = (project: SidebarProject, depth: number, movable: boolean) => {
    const expanded = isGroupExpanded(project, input.groupExpansion);
    rows.push({
      kind: "group",
      key: `group:${project.key}`,
      project,
      expanded,
      depth,
      parentKey: null,
      // Pinned projects leave the tree for the band above it: naming their
      // folder is what tells two projects of the same name apart there. The
      // flat list never had that, and keeps its rows as they were.
      parentLabel: input.pathTree && project.pinned ? parentFolderNameOf(project.root) : null,
      movable,
      ...countsOf(project),
    });
    groupFamilyRows(project, depth, expanded);
  };

  if (!input.pathTree) {
    // One flat list: every project of a band can move past its neighbours.
    const pinnedKeys = pinnedProjects.map((project) => project.key);
    const otherKeys = otherProjects.map((project) => project.key);
    for (const project of pinnedProjects) siblingProjects.set(project.key, pinnedKeys);
    for (const project of otherProjects) siblingProjects.set(project.key, otherKeys);
    for (const [index, project] of orderedProjects.entries()) {
      if (index > 0) rows.push({ kind: "spacer", key: `group-spacer:${project.key}` });
      visibleGroupRows(project, 0, (project.pinned ? pinnedKeys : otherKeys).length > 1);
      treeProjects.push(project);
    }
  } else {
    const roots = pathTreeRoots(buildPathTree(otherProjects));
    treeProjects = projectsOfTree(roots);
    // A pinned project left the tree, but the folder its path makes stays: it
    // holds the projects under it, and says so rather than looking like a
    // second row of the same name.
    const pinnedAbove = new Set(pinnedProjects.map((project) => treePathOf(project.root)));
    // The band above the tree is flat: its projects are siblings of each
    // other, as they were in the list, so they reorder among themselves.
    const pinnedKeys = pinnedProjects.map((project) => project.key);
    for (const key of pinnedKeys) siblingProjects.set(key, pinnedKeys);

    // A level's sibling list: the projects sitting directly in it. A move
    // inside the tree reorders those, and only those: a project's place is
    // its path, so moving one into another folder would mean nothing.
    const noteSiblings = (level: readonly PathNode[]) => {
      const keys = level.flatMap((node) => (node.project ? [node.project.key] : []));
      if (keys.length > 0) for (const key of keys) siblingProjects.set(key, keys);
      for (const node of level) if (node.children.length > 0) noteSiblings(node.children);
    };
    noteSiblings(roots);

    function emitNode(node: PathNode, depth: number, parentKey: string | null, ancestors: string[]): void {
      if (node.project) {
        const project = node.project;
        ancestorFolders.set(project.key, ancestors);
        const expanded = isGroupExpanded(project, input.groupExpansion);
        rows.push({
          kind: "group",
          key: `group:${project.key}`,
          project,
          expanded,
          depth,
          parentKey,
          parentLabel: null,
          movable: (siblingProjects.get(project.key)?.length ?? 0) > 1,
          ...countsOf(project),
        });
        groupFamilyRows(project, depth, expanded);
        // Its own sessions first, its deeper projects after them: a group's
        // chevron folds its sessions, never the projects rooted below it.
        for (const child of node.children) emitNode(child, depth + 1, `group:${project.key}`, ancestors);
        return;
      }
      const key = folderKeyOf(node.path);
      const subtree = projectsUnder(node);
      const counts = subtree.reduce(
        (total, project) => {
          const own = countsOf(project);
          return { running: total.running + own.running, awaiting: total.awaiting + own.awaiting, unread: total.unread + own.unread };
        },
        { running: 0, awaiting: 0, unread: 0 },
      );
      const projectKeys = subtree.map((project) => project.key);
      const expanded = isFolderExpanded(key, projectKeys, counts, input);
      folders.push({ key, path: node.path, label: node.label, depth, expanded, projectKeys });
      rows.push({
        kind: "folder",
        key,
        path: node.path,
        label: node.label,
        depth,
        expanded,
        projectCount: projectKeys.length,
        pinnedAbove: pinnedAbove.has(node.path),
        ...counts,
      });
      const reached = [...ancestors, key];
      if (!expanded) {
        // A folded folder still knows where its projects sit, for a reveal.
        for (const project of subtree) ancestorFolders.set(project.key, reached);
        return;
      }
      for (const child of node.children) emitNode(child, depth + 1, key, reached);
    }

    // Pinned projects stay flat above the tree; a gap parts every two top
    // rows, as it does in the flat list (#1338).
    let first = true;
    const startRow = (key: string) => {
      if (!first) rows.push({ kind: "spacer", key: `group-spacer:${key}` });
      first = false;
    };
    for (const project of pinnedProjects) {
      startRow(project.key);
      visibleGroupRows(project, 0, pinnedProjects.length > 1);
    }
    for (const root of roots) {
      startRow(root.project?.key ?? root.path);
      emitNode(root, 0, null, []);
    }
  }

  // Flat, `treeProjects` is the whole list already (pinned band first).
  const orderedShown = input.pathTree ? [...pinnedProjects, ...treeProjects] : treeProjects;
  const unorderedKeysByBand = {
    pinned: unorderedKeys(pinnedProjects),
    other: unorderedKeys(input.pathTree ? treeProjects : otherProjects),
  };
  const projectKeysToRecord = orderedShown
    .filter((project) => !rank.has(project.key) && recordable(project))
    .map((project) => project.key);

  // One spacer parts the groups from the footer, as one parts the pinned
  // section from them.
  if (orderedShown.length > 0) rows.push({ kind: "spacer", key: "footer-spacer" });
  rows.push({ kind: "footer-open", key: "footer-open" });
  if (archivedCount > 0) rows.push({ kind: "footer-archived", key: "footer-archived", count: archivedCount });

  return {
    rows,
    projects: orderedShown,
    archivedCount,
    unorderedKeysByBand,
    projectKeysToRecord,
    folders,
    siblingProjects: Object.fromEntries(siblingProjects),
    ancestorFolders: Object.fromEntries(ancestorFolders),
  };
}

/**
 * The next `projectKeysToRecord` the sidebar saves on its own, at most `limit`,
 * taken from the bottom up. Saved keys go in front of the list and render right
 * below the unsaved ones, so each batch lands where it already shows and the
 * unsaved keys above it stay above it. A key sent before but still unsaved
 * (refused, or no room left) ends the batch: a key saved above it would drop
 * below it.
 */
export function nextProjectKeysToRecord(toRecord: readonly string[], sent: ReadonlySet<string>, limit: number): string[] {
  let first = toRecord.length;
  while (first > 0 && toRecord.length - first < limit && !sent.has(toRecord[first - 1])) first--;
  return toRecord.slice(first);
}

/**
 * The archive view: archived families of every project, grouped by project.
 * Groups by their newest archivedAt (desc), families by archivedAt (desc).
 * A group is open unless its project key is in `collapsed` (the browser's
 * own choice, lib/sidebar-prefs.ts); folded, only its header shows.
 */
export function buildArchiveRows(
  input: Pick<SessionTreeInput, "sessions" | "uiState" | "runningIds" | "awaitingIds" | "unreadIds" | "selectedSessionId" | "currentProject">
    & { collapsed?: ReadonlySet<string> },
): SidebarRow[] {
  const { uiState, runningIds } = input;
  const flags: FamilyFlagsInput = input;
  const resolver = createProjectResolver(uiState, input.currentProject);
  const groups = new Map<string, { newest: number; families: { family: SessionFamily; archivedAt: number }[] }>();

  for (const family of listSessionFamilies(input.sessions)) {
    if (!isFamilyArchived(family, uiState, runningIds)) continue;
    resolver.noteFamily(family);
    const archivedAt = finiteNumber(familyEntry(uiState, family.root.id)?.archivedAt) ?? 0;
    const key = familyProjectKey(family);
    const group = groups.get(key);
    if (group) {
      group.families.push({ family, archivedAt });
      group.newest = Math.max(group.newest, archivedAt);
    } else {
      groups.set(key, { newest: archivedAt, families: [{ family, archivedAt }] });
    }
  }

  const rows: SidebarRow[] = [];
  const ordered = [...groups.entries()]
    .map(([key, group], index) => ({ key, group, index }))
    .sort((a, b) => compareDesc(a.group.newest, b.group.newest) || a.index - b.index);
  for (const { key, group } of ordered) {
    const project = resolver.get(key);
    const expanded = !input.collapsed?.has(key);
    rows.push({ kind: "archive-group", key: `archive:${key}`, project, count: group.families.length, expanded });
    if (!expanded) continue;
    const families = group.families
      .map((entry, index) => ({ ...entry, index }))
      .sort((a, b) => compareDesc(a.archivedAt, b.archivedAt) || a.index - b.index);
    for (const { family } of families) {
      rows.push(sessionRow(family, "archive", project, 0, flags));
    }
  }
  return rows;
}

/**
 * Root ids of live, non-pinned, non-running, non-unread, non-selected
 * families of `projectKey` whose latestModified is older than
 * now - olderThanMs. Transient families have no file and are never archived.
 */
export function familiesToArchive(
  input: Pick<SessionTreeInput, "sessions" | "uiState" | "runningIds" | "unreadIds" | "selectedSessionId">,
  projectKey: string,
  olderThanMs: number,
  now: number,
): string[] {
  const cutoff = now - olderThanMs;
  const ids: string[] = [];
  for (const family of listSessionFamilies(input.sessions)) {
    if (familyProjectKey(family) !== projectKey) continue;
    if (isFamilyArchived(family, input.uiState, input.runningIds)) continue;
    if (isFamilyPinned(family, input.uiState, input.runningIds)) continue;
    const status = familyStatus(family, input);
    if (status.running || status.unread || status.selected || status.transient) continue;
    const modified = Date.parse(family.latestModified);
    if (Number.isNaN(modified) || modified >= cutoff) continue;
    ids.push(family.root.id);
  }
  return ids;
}

/**
 * Root ids of the archived families the archive view's bulk actions take
 * (Restore all, Delete…): every archived family, or those of `projectKey`,
 * or those archived before `archivedBefore`. An archived family never runs
 * (isFamilyArchived) and always has a file.
 */
export function archivedFamilyIds(
  input: Pick<SessionTreeInput, "sessions" | "uiState" | "runningIds">,
  filter: { projectKey?: string; archivedBefore?: number } = {},
): string[] {
  const ids: string[] = [];
  for (const family of listSessionFamilies(input.sessions)) {
    if (filter.projectKey !== undefined && familyProjectKey(family) !== filter.projectKey) continue;
    if (!isFamilyArchived(family, input.uiState, input.runningIds)) continue;
    if (filter.archivedBefore !== undefined) {
      const archivedAt = finiteNumber(familyEntry(input.uiState, family.root.id)?.archivedAt);
      if (archivedAt === null || archivedAt >= filter.archivedBefore) continue;
    }
    ids.push(family.root.id);
  }
  return ids;
}

/**
 * A project group's "Delete all sessions": root ids of every family of
 * `projectKey` that has a file, pinned and archived ones included (the
 * server deletes their subagent sessions with them), and how many families
 * it keeps because they run or wait for input: deleting one would stop its
 * run. Transient families have no file to delete.
 */
export function familiesToDelete(
  input: Pick<SessionTreeInput, "sessions" | "runningIds" | "awaitingIds">,
  projectKey: string,
): { ids: string[]; running: number } {
  const ids: string[] = [];
  let running = 0;
  for (const family of listSessionFamilies(input.sessions)) {
    if (familyProjectKey(family) !== projectKey || family.root.transient) continue;
    if (anyMemberIn(family, input.runningIds) || (input.awaitingIds && anyMemberIn(family, input.awaitingIds))) {
      running++;
      continue;
    }
    ids.push(family.root.id);
  }
  return { ids, running };
}

/** Prefix sums of row heights: length rows.length + 1, offsets[0] = 0. */
export function getRowOffsets(rows: readonly SidebarRow[], layout: SidebarLayout): number[] {
  const heights = SIDEBAR_ROW_HEIGHTS[layout];
  const offsets = new Array<number>(rows.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < rows.length; index++) {
    offsets[index + 1] = offsets[index] + heights[rows[index].kind];
  }
  return offsets;
}

/**
 * One project group as it is laid out: from its header row to the bottom of
 * its last row (its sessions, "show more", the empty note). `gapAbove` and
 * `gapBelow` are the spacer rows that part it from what is next to it: the
 * pinned section above the first, another group, the footer below the last.
 * Two neighbours share the spacer between them. `parentKey` is the node above
 * it in the path tree: only a group of the same one can trade places with it.
 */
export interface GroupBlock {
  key: string;
  pinned: boolean;
  parentKey: string | null;
  top: number;
  bottom: number;
  gapAbove: number;
  gapBelow: number;
}

/** A row that belongs to the group above it. */
function isGroupMemberRow(row: SidebarRow): boolean {
  return row.kind === "group-more" || row.kind === "group-empty" || (row.kind === "session" && row.context === "group");
}

/** The group blocks of `rows`, top to bottom. */
export function groupBlocks(rows: readonly SidebarRow[], offsets: readonly number[]): GroupBlock[] {
  const blocks: GroupBlock[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index];
    if (row.kind !== "group") {
      index++;
      continue;
    }
    let above = index;
    while (above > 0 && rows[above - 1].kind === "spacer") above--;
    let end = index + 1;
    while (end < rows.length && isGroupMemberRow(rows[end])) end++;
    let below = end;
    while (below < rows.length && rows[below].kind === "spacer") below++;
    blocks.push({
      key: row.project.key,
      pinned: row.project.pinned,
      parentKey: row.parentKey,
      top: offsets[index],
      bottom: offsets[end],
      gapAbove: offsets[index] - offsets[above],
      gapBelow: offsets[below] - offsets[end],
    });
    index = end;
  }
  return blocks;
}

/** Where a dragged group would go: next to `anchorKey`, with its drop line at `lineY` (content coordinates). */
export interface GroupDrop { anchorKey: string; position: ProjectMovePosition; lineY: number }

/** The line's 6px dot is centred on it: this low, at the top of the list, it is still whole. */
const DROP_LINE_MIN_Y = 3;

/**
 * The drop target for a group dragged to content position `y`. Only the
 * dragged group's row counts: its band (a drag never crosses from pinned
 * projects to the others) and its parent in the path tree (a project's place
 * is its path, so it can only trade places with the projects of its own
 * folder). A pointer above that row (the pinned section, a folder above it)
 * means its top and one below it (the footer) its bottom. The dragged block
 * goes before the first other block whose middle is below `y`. Null when that
 * is where it already is, or the row has no other group. Works from the rows
 * and offsets alone: collapsed groups, "show more" and rows not mounted
 * count as laid out. The line sits in the middle of the spacer it marks
 * (between two groups, after the pinned section or before the footer), and
 * never so high that its dot leaves the list.
 */
export function groupDropAt(blocks: readonly GroupBlock[], draggedKey: string, y: number): GroupDrop | null {
  const dragged = blocks.find((block) => block.key === draggedKey);
  if (!dragged) return null;
  const band = blocks.filter((block) => block.pinned === dragged.pinned && block.parentKey === dragged.parentKey);
  const from = band.indexOf(dragged);
  const others = band.filter((block) => block !== dragged);
  if (others.length === 0) return null;
  const to = others.filter((block) => (block.top + block.bottom) / 2 < y).length;
  if (to === from) return null;
  const last = others[others.length - 1];
  const lineY = Math.max(DROP_LINE_MIN_Y, to < others.length ? others[to].top - others[to].gapAbove / 2 : last.bottom + last.gapBelow / 2);
  return to > 0
    ? { anchorKey: others[to - 1].key, position: "after", lineY }
    : { anchorKey: others[0].key, position: "before", lineY };
}

/**
 * Move up / Move down in a group's menu: the move that swaps `key` with its
 * neighbour among its siblings (`siblingProjects`, the tree model's). Null at
 * the edge of the row it sits in.
 */
export function adjacentSiblingMove(
  siblingProjects: Readonly<Record<string, readonly string[]>>,
  key: string,
  direction: "up" | "down",
): { anchorKey: string; position: ProjectMovePosition } | null {
  const siblings = siblingProjects[key];
  if (!siblings) return null;
  const index = siblings.indexOf(key);
  const neighbour = index < 0 ? undefined : siblings[direction === "up" ? index - 1 : index + 1];
  if (neighbour === undefined) return null;
  return { anchorKey: neighbour, position: direction === "up" ? "before" : "after" };
}

/**
 * Auto-scroll while a group is dragged near an edge of the list (`top` and
 * `bottom` of its box, `clientY` the pointer): up to `maxStep` px a frame,
 * faster the deeper into the `edge` band (at most half the box), at full
 * speed past it; negative scrolls up, 0 outside both bands.
 */
export function autoScrollDelta(clientY: number, top: number, bottom: number, edge: number, maxStep: number): number {
  const band = Math.min(edge, (bottom - top) / 2);
  if (!(band > 0) || !Number.isFinite(clientY)) return 0;
  const speed = (depth: number) => Math.ceil(maxStep * Math.min(1, depth / band));
  if (clientY < top + band) return -speed(top + band - clientY);
  if (clientY > bottom - band) return speed(clientY - (bottom - band));
  return 0;
}

/** Where the drag ghost goes; one coordinate space for all (the hook uses the page's). */
export interface GhostPlacement {
  pointerY: number;
  /** The drop line, or null without a drop target. */
  lineY: number | null;
  ghostHeight: number;
  /** Space kept between the ghost and the pointer. */
  pointerGap: number;
  /** Space kept between the ghost and the drop line. */
  lineGap: number;
  /** The list's visible top. */
  minTop: number;
  /** The lowest top that keeps the ghost in the list: its visible bottom less ghostHeight. */
  maxTop: number;
}

/**
 * The drag ghost's top while a group is dragged. It follows the pointer, its
 * bottom `pointerGap` above it, and moves only as far as keeping clear of the
 * pointer and the drop line (`lineGap`) and inside the list takes: to the
 * nearest top that does. A line far from the pointer leaves it where it is;
 * a line just above the pointer puts it above the line, or below the pointer
 * when there is no room up there; at the list's top it goes below the
 * pointer, and below the line too when that is just under the pointer. A
 * line outside the visible box is scrolled away and cannot be covered: only
 * the pointer counts, as without a drop target. Only a list too short to
 * hold the ghost clear of both puts it over the pointer (over the line only
 * when no top in the list keeps clear of it), and one shorter than the ghost
 * keeps its top.
 */
export function ghostTopFor({ pointerY, lineY, ghostHeight, pointerGap, lineGap, minTop, maxTop }: GhostPlacement): number {
  const bottom = Math.max(minTop, maxTop);
  const wanted = pointerY - pointerGap - ghostHeight;
  const line = lineY !== null && lineY >= minTop && lineY <= bottom + ghostHeight ? lineY : null;
  const inList = (top: number) => top >= minTop && top <= bottom;
  // Tops at which the ghost comes closer than its gap to the pointer or the line.
  const nearPointer = (top: number) => top > wanted && top < pointerY + pointerGap;
  const nearLine = (top: number) => line !== null && top > line - lineGap - ghostHeight && top < line + lineGap;
  // The nearest top that fits is the one the pointer wants or one at the edge
  // of what it keeps clear of; on a tie the first listed, above before below.
  const candidates = line === null
    ? [wanted, minTop, pointerY + pointerGap, bottom]
    : [wanted, line - lineGap - ghostHeight, minTop, pointerY + pointerGap, line + lineGap, bottom];
  const nearest = (fits: (top: number) => boolean): number | null => {
    let best: number | null = null;
    for (const top of candidates) {
      if (fits(top) && (best === null || Math.abs(top - wanted) < Math.abs(best - wanted))) best = top;
    }
    return best;
  };
  return nearest((top) => inList(top) && !nearPointer(top) && !nearLine(top))
    ?? nearest((top) => inList(top) && !nearLine(top))
    ?? Math.min(bottom, Math.max(minTop, wanted));
}

const UNMEASURED_VIEWPORT_HEIGHT = 600;

/**
 * Indices to render: rows intersecting [scrollTop - overscanPx,
 * scrollTop + viewportHeight + overscanPx] (an unmeasured viewport of 0 counts
 * as 600px), plus every valid index in `keepMounted`. Sorted and unique.
 */
export function getVisibleRowIndices(
  offsets: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  overscanPx: number,
  keepMounted: readonly number[] = [],
): number[] {
  const count = Math.max(0, offsets.length - 1);
  const top = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  const height = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : UNMEASURED_VIEWPORT_HEIGHT;
  const overscan = Number.isFinite(overscanPx) && overscanPx > 0 ? overscanPx : 0;
  const windowStart = top - overscan;
  const windowEnd = top + height + overscan;

  // First row whose bottom edge is below windowStart.
  let low = 0;
  let high = count;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (offsets[mid + 1] > windowStart) high = mid;
    else low = mid + 1;
  }
  const first = low;

  // First row whose top edge is at or past windowEnd; the range ends before it.
  low = first;
  high = count;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (offsets[mid] >= windowEnd) high = mid;
    else low = mid + 1;
  }
  const end = low;

  const indices: number[] = [];
  for (let index = first; index < end; index++) indices.push(index);
  if (keepMounted.length === 0) return indices;

  const extra = keepMounted.filter((index) => Number.isInteger(index) && index >= 0 && index < count && (index < first || index >= end));
  if (extra.length === 0) return indices;
  return [...new Set([...indices, ...extra])].sort((a, b) => a - b);
}

/**
 * The scrollTop that brings row `index` into a viewport of `viewportHeight`
 * now scrolled to `scrollTop`: centred when it is partly or wholly out of
 * view, null when it is already in view (or there is no such row). With
 * `block` "start" the row goes to the top unless it is there already (the
 * browser clamps a list too short to put it there). With "nearest" a row
 * partly in view moves only as far as it takes to show it whole (its top
 * first when it is taller than the viewport): a click on a row cut by an
 * edge never moves it from under the pointer by half the list.
 */
export function revealScrollTop(
  offsets: readonly number[],
  index: number,
  scrollTop: number,
  viewportHeight: number,
  block?: "start" | "nearest",
): number | null {
  if (!Number.isInteger(index) || index < 0 || index >= offsets.length - 1) return null;
  const top = offsets[index];
  const bottom = offsets[index + 1];
  if (block === "start") return top === scrollTop ? null : top;
  if (top >= scrollTop && bottom <= scrollTop + viewportHeight) return null;
  if (block === "nearest" && bottom > scrollTop && top < scrollTop + viewportHeight) {
    return top < scrollTop || bottom - top > viewportHeight ? top : bottom - viewportHeight;
  }
  return Math.max(0, top - Math.max(0, (viewportHeight - (bottom - top)) / 2));
}

/** Where the main tree shows a session's row (locateSessionRow()). */
export interface SessionRowLocation {
  rowKey: string;
  projectKey: string;
  /** The pinned section is folded over the row. */
  unfoldPinned: boolean;
  /** The row's group is folded by an explicit choice. */
  unfoldGroup: boolean;
}

/**
 * Where the main tree shows a session's row: its family's row in the pinned
 * section or in its project's group, keyed as `buildSessionTree()` keys it
 * (a subagent or a side chat is its root's row), and what hides it now: the
 * pinned section folded, or the group folded on purpose. A group closed
 * only because its project is not the current one needs nothing: opening
 * a session makes its project current. Null when the main tree has no row
 * for it: not in the list (a fresh session not saved yet) or archived.
 */
export function locateSessionRow(
  input: Pick<SessionTreeInput, "sessions" | "uiState" | "runningIds" | "groupExpansion" | "pinnedCollapsed">,
  sessionId: string,
): SessionRowLocation | null {
  const family = getSessionFamily(input.sessions, sessionId);
  if (!family || isFamilyArchived(family, input.uiState, input.runningIds)) return null;
  const projectKey = familyProjectKey(family);
  if (isFamilyPinned(family, input.uiState, input.runningIds)) {
    return { rowKey: `session:pinned:${family.root.id}`, projectKey, unfoldPinned: input.pinnedCollapsed, unfoldGroup: false };
  }
  const unfoldGroup = Object.hasOwn(input.groupExpansion, projectKey) && input.groupExpansion[projectKey] === false;
  return { rowKey: `session:group:${family.root.id}`, projectKey, unfoldPinned: false, unfoldGroup };
}

/** A reveal request is dropped once its row has missed this many rows updates, or this long after it was made. */
export const REVEAL_MAX_MISSES = 3;
export const REVEAL_EXPIRY_MS = 3000;

/** How many rows updates have missed one reveal request's row so far. */
export interface RevealMisses { id: number; misses: number }

/**
 * One look at the rows for a reveal request (SessionTreeReveal in
 * components/SessionTree.tsx): "reveal" when its row is there, "wait" for the
 * next rows update, "drop" when it is older than REVEAL_EXPIRY_MS (found or
 * not: a row that turns up later, for another reason, is not scrolled to) or
 * its row has now missed REVEAL_MAX_MISSES updates. `misses` is the count
 * so far, kept for this id only; the next one comes back with the verdict.
 */
export function revealStep(
  misses: RevealMisses | null,
  request: { id: number; at: number },
  found: boolean,
  now: number,
): { misses: RevealMisses; action: "reveal" | "wait" | "drop" } {
  const current = misses?.id === request.id ? misses : { id: request.id, misses: 0 };
  // Written so an unreadable time counts as too old.
  if (!(now - request.at <= REVEAL_EXPIRY_MS)) return { misses: current, action: "drop" };
  if (found) return { misses: current, action: "reveal" };
  const next = { id: request.id, misses: current.misses + 1 };
  return { misses: next, action: next.misses >= REVEAL_MAX_MISSES ? "drop" : "wait" };
}
