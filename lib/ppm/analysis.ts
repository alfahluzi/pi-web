// Pure plan-structure analysis: waves, critical path, concurrency, file-ownership
// conflicts, lint warnings. Ported 1:1 from project-plan-manager's
// bin/commands/_shared/analysis.js.

// Structural subset of a phase that the analyzers need; full PpmPhase objects
// satisfy it (PpmTask extends PpmTaskLike).
export interface PpmTaskLike {
  id: string;
  title?: string;
  detail?: string;
  progress?: string;
  status?: string;
  pre_request?: string[];
  files?: string[];
  agent?: string;
}

export interface PpmPhaseLike {
  tasks: PpmTaskLike[];
}

const depsOf = (task: PpmTaskLike | undefined): string[] => (Array.isArray(task?.pre_request) ? task!.pre_request : []);

// Wave (topological level) per task id: 0 when no deps, else 1 + max(dep wave). Assumes acyclic (validated).
export function levels<T extends PpmTaskLike>(phase: { tasks: T[] }): Map<string, number> {
  const byId = new Map(phase.tasks.map((task) => [task.id, task]));
  const memo = new Map<string, number>();
  const level = (id: string): number => {
    if (!memo.has(id)) memo.set(id, depsOf(byId.get(id)).reduce((max, dep) => Math.max(max, level(dep) + 1), 0));
    return memo.get(id)!;
  };
  for (const task of phase.tasks) level(task.id);
  return memo;
}

export function waves<T extends PpmTaskLike>(phase: { tasks: T[] }): T[][] {
  const level = levels(phase);
  const result: T[][] = [];
  for (const task of phase.tasks) {
    const index = level.get(task.id)!;
    if (!result[index]) result[index] = [];
    result[index].push(task);
  }
  return result;
}

export function criticalPath<T extends PpmTaskLike>(phase: { tasks: T[] }): string[] {
  if (!phase.tasks.length) return [];
  const level = levels(phase);
  const byId = new Map(phase.tasks.map((task) => [task.id, task]));
  let current = phase.tasks.reduce((best, task) => (level.get(task.id)! > level.get(best.id)! ? task : best));
  const chain = [current.id];
  while (depsOf(current).length) {
    const dep = depsOf(current).reduce((best, candidate) => (level.get(candidate)! > level.get(best)! ? candidate : best));
    current = byId.get(dep)!;
    chain.unshift(current.id);
  }
  return chain;
}

// Transitive ancestors per task id.
function ancestors<T extends PpmTaskLike>(phase: { tasks: T[] }): Map<string, Set<string>> {
  const byId = new Map(phase.tasks.map((task) => [task.id, task]));
  const memo = new Map<string, Set<string>>();
  const walk = (id: string): Set<string> => {
    if (memo.has(id)) return memo.get(id)!;
    const set = new Set<string>();
    for (const dep of depsOf(byId.get(id))) {
      set.add(dep);
      for (const up of walk(dep)) set.add(up);
    }
    memo.set(id, set);
    return set;
  };
  for (const task of phase.tasks) walk(task.id);
  return memo;
}

// Pairs of tasks with no ordering between them: they may run at the same time.
export function concurrentPairs<T extends PpmTaskLike>(phase: { tasks: T[] }): [T, T][] {
  const up = ancestors(phase);
  const pairs: [T, T][] = [];
  for (let i = 0; i < phase.tasks.length; i += 1)
    for (let j = i + 1; j < phase.tasks.length; j += 1) {
      const a = phase.tasks[i], b = phase.tasks[j];
      if (!up.get(a.id)!.has(b.id) && !up.get(b.id)!.has(a.id)) pairs.push([a, b]);
    }
  return pairs;
}

const normalize = (pattern: string): string => {
  const clean = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  return clean.endsWith("/") ? `${clean}**` : clean;
};

function globToRegex(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      source += ".*";
      i += 1;
      if (pattern[i + 1] === "/") i += 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

const staticPrefix = (pattern: string): string => pattern.split(/[*?]/)[0];

// Could two ownership patterns refer to the same file?
// ponytail: glob-vs-glob is approximated by static-prefix containment (conservative, may over-report); use a real glob-intersection lib if false positives hurt.
// A literal path may be a file or a directory (trailing "/" is optional), so it also owns everything under it.
const within = (target: string, root: string): boolean => target === root || target.startsWith(`${root.replace(/\/\*\*$/, "")}/`);

export function patternsOverlap(a: string, b: string): boolean {
  const x = normalize(a), y = normalize(b);
  if (x === y) return true;
  const xGlob = /[*?]/.test(x), yGlob = /[*?]/.test(y);
  if (!xGlob && !yGlob) return within(x, y) || within(y, x);
  if (!xGlob) return globToRegex(y).test(x) || staticPrefix(y).startsWith(`${x}/`);
  if (!yGlob) return globToRegex(x).test(y) || staticPrefix(x).startsWith(`${y}/`);
  const px = staticPrefix(x), py = staticPrefix(y);
  return px.startsWith(py) || py.startsWith(px);
}

export function fileConflicts<T extends PpmTaskLike>(
  phase: { tasks: T[] },
): { a: string; b: string; shared: string[] }[] {
  const conflicts: { a: string; b: string; shared: string[] }[] = [];
  for (const [a, b] of concurrentPairs(phase)) {
    if (!Array.isArray(a.files) || !Array.isArray(b.files)) continue;
    const shared: string[] = [];
    for (const fa of a.files) for (const fb of b.files) if (patternsOverlap(fa, fb)) shared.push(fa === fb ? fa : `${fa} ~ ${fb}`);
    if (shared.length) conflicts.push({ a: a.id, b: b.id, shared });
  }
  return conflicts;
}

export const DETAIL_SECTIONS = ["Goal", "Files", "Steps", "Verify", "Done when"];

export function missingSections(detail: string | undefined): string[] {
  return DETAIL_SECTIONS.filter((section) => !new RegExp(`^\\s*(?:#+\\s*)?${section}\\s*:?`, "im").test(detail ?? ""));
}

// Advisory findings for one phase. Errors = defects that break parallel execution; warnings = efficiency/clarity smells.
export function lintPhase<T extends PpmTaskLike>(phase: { tasks: T[] }): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const tasks = phase.tasks;
  for (const { a, b, shared } of fileConflicts(phase))
    errors.push(`${a} and ${b} can run concurrently but share files: ${shared.join(", ")} (add pre_request or move shared files to one task)`);
  // An empty phase would read as "0/0 done" and let a hollow plan look complete.
  if (!tasks.length) return { errors: ["phase has no tasks (add tasks or delete the phase file)"], warnings };

  const phaseWaves = waves(phase);
  const width = Math.max(...phaseWaves.map((wave) => wave.length));
  if (tasks.length >= 2 && width === 1)
    warnings.push(`fully serial (${tasks.length} tasks, width 1): drop unneeded pre_request, merge tasks, or split independent work`);

  const concurrent = concurrentPairs(phase);
  if (concurrent.length) {
    const racing = new Set(concurrent.flatMap(([a, b]) => [a.id, b.id]));
    const unowned = tasks.filter((task) => racing.has(task.id) && !(Array.isArray(task.files) && task.files.length)).map((task) => task.id);
    if (unowned.length) warnings.push(`parallel tasks without files ownership (conflicts cannot be checked): ${unowned.join(", ")}`);
    const up = ancestors(phase);
    const sink = tasks.some((task) => up.get(task.id)!.size === tasks.length - 1);
    if (!sink) warnings.push("parallel work has no closing integration/verify task (one task whose pre_request covers all others)");
  }

  for (const task of tasks) {
    const missing = missingSections(task.detail);
    if (missing.length) warnings.push(`${task.id}: detail missing context-packet sections: ${missing.join(", ")}`);
    if (!task.agent) warnings.push(`${task.id}: no agent role hint (explore|implement|review|verify)`);
  }
  return { errors, warnings };
}