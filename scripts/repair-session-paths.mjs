#!/usr/bin/env node
/**
 * Brings a project's history back after its folder was moved by hand (`mv`, a
 * file manager, another tool). The sessions still carry the old cwd, so pi-web
 * shows a project group whose folder is gone and refuses to run there; this
 * re-files each session under the new cwd, re-points parentSession, and re-keys
 * the sidebar state and trust.json — the half of "Move project…" that a move
 * outside pi-web never does.
 *
 * Nothing is renamed: the folder is already in its place. `--from` must be
 * gone and `--to` must exist.
 *
 * Usage (paths absolute or starting with ~/):
 *   scripts/repair-session-paths.mjs --from ~/Documents/old --to ~/Documents/new
 *   scripts/repair-session-paths.mjs --from … --to … --dry-run
 * Prints one JSON line: the plan (`--dry-run`), the result, or `{ error }` (1).
 *
 * Run it from a terminal, then restart pi-web: a session wrapper opened before
 * the repair keeps the old cwd in memory until the app restarts.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import { createJiti } from "jiti";

const args = process.argv.slice(2);
function arg(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}
function expand(input) {
  if (!input) return undefined;
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
  return resolve(input);
}

const from = expand(arg("from"));
const to = expand(arg("to"));
if (!from || !to) {
  console.error("usage: repair-session-paths.mjs --from <old-path> --to <new-path> [--dry-run]");
  process.exit(2);
}

const jiti = createJiti(import.meta.url);
const { prepareProjectPathRepair, executeProjectMove, isProjectMoveRefusal } = await jiti.import("../lib/project-move.ts");

try {
  const prepared = await prepareProjectPathRepair({ from, to });
  if (!prepared.ok) {
    console.error(JSON.stringify({ error: prepared.refusal.error, code: prepared.refusal.code }));
    process.exit(1);
  }
  const { plan } = prepared;
  if (args.includes("--dry-run")) {
    console.log(JSON.stringify({
      from: plan.source,
      to: plan.destination,
      sessionCount: plan.sessions.length,
      parentPatches: plan.parentPatches.length,
      worktrees: plan.worktrees.length,
    }));
    process.exit(0);
  }
  const result = await executeProjectMove(plan);
  console.log(JSON.stringify({ ok: true, result }));
} catch (error) {
  if (isProjectMoveRefusal(error)) {
    console.error(JSON.stringify({ error: error.message, code: error.code }));
  } else {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
  process.exit(1);
}
