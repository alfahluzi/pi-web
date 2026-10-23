#!/usr/bin/env node
/**
 * Moves a pi-web checkout to another folder, with the history of the sessions
 * that ran in it — the step `scripts/move-pi-web.sh` cannot do in the shell.
 *
 * It is `lib/project-move.ts` with one escape hatch: `allowServerCwd`, because
 * the checkout being moved is the one pi-web runs from. That is only safe
 * because the shell script deletes the PM2 app first: nothing is left with this
 * folder as its working directory. Never call this while pi-web serves.
 *
 * Usage (from anywhere; paths are absolute):
 *   move-pi-web.mjs --root <checkout> --new-path <destination>
 *   move-pi-web.mjs --plan-only --root <checkout> --new-path <destination>
 * Prints one JSON line: the engine's result, or the plan with `--plan-only`,
 * or `{ "error": ... }` with code 1.
 */

import { dirname, basename, resolve } from "node:path";
import { createJiti } from "jiti";

const args = process.argv.slice(2);
function arg(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const rawRoot = arg("root");
const rawNewPath = arg("new-path");
if (!rawRoot || !rawNewPath) {
  console.error("usage: move-pi-web.mjs --root <checkout> --new-path <destination>");
  process.exit(2);
}

const root = resolve(rawRoot);
const newPath = resolve(rawNewPath);
if (basename(root) !== basename(newPath)) {
  // The engine names the destination after the folder it moves; a rename of the
  // folder itself is a different operation (the PM2 app and the global link are
  // named after the checkout, not after this path).
  console.error(`the folder's own name must stay ${basename(root)}: ${newPath}`);
  process.exit(2);
}

const jiti = createJiti(import.meta.url);
const { prepareProjectMove, executeProjectMove, isProjectMoveRefusal } = await jiti.import("../lib/project-move.ts");

try {
  const planOnly = args.includes("--plan-only");
  const prepared = await prepareProjectMove({
    root,
    // The destination is `<target>/<name>`; pass the folder that will hold it.
    target: dirname(newPath),
    allowServerCwd: true,
  });
  if (!prepared.ok) {
    console.error(JSON.stringify({ error: prepared.refusal.error, code: prepared.refusal.code, detail: prepared.refusal.detail }));
    process.exit(1);
  }
  if (prepared.plan.destination !== newPath) {
    console.error(JSON.stringify({ error: `planned destination ${prepared.plan.destination} is not ${newPath}`, code: "invalid-target" }));
    process.exit(1);
  }
  if (planOnly) {
    // The shell prints what it will do; this is the part only the engine knows.
    console.log(JSON.stringify({
      destination: prepared.plan.destination,
      sessionCount: prepared.plan.sessions.length,
      worktrees: prepared.plan.worktrees.length,
      targetDir: prepared.plan.targetDir,
    }));
    process.exit(0);
  }
  const result = await executeProjectMove(prepared.plan);
  // Warnings and per-file errors are the caller's to report: they do not fail
  // the move, the folder is already where it was asked to go.
  console.log(JSON.stringify({ ok: true, result }));
} catch (error) {
  if (isProjectMoveRefusal(error)) {
    console.error(JSON.stringify({ error: error.message, code: error.code }));
  } else {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
  process.exit(1);
}
