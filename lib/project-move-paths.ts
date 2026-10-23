/**
 * The path arithmetic of "Move project": where a typed destination points, and
 * which paths move with a project. Pure (no filesystem, no `os`), so both the
 * route's engine and its tests can use it, and a unit test can cover the
 * separator and `~` rules that are otherwise only exercised by a live move.
 *
 * A project's folder moves as a whole, so every path that starts with it moves
 * with it and keeps its relative tail: a session opened in `repo/packages/web`
 * follows to `<destination>/packages/web`.
 */

import { basename, isAbsolute, join, normalize, relative, resolve, sep } from "path";
import { isWindowsAbsolutePath } from "./paths";

/** A typed destination longer than this is a paste accident, not a path. */
export const PROJECT_TARGET_MAX_LENGTH = 4096;

/**
 * The directory a typed destination names: `~` and `~/…` against the home
 * directory, an absolute path as it is, anything else as null (a relative path
 * would resolve against the server's own working directory, which the person
 * typing cannot see). Empty input is null too.
 */
export function expandProjectTarget(input: string, home: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > PROJECT_TARGET_MAX_LENGTH) return null;
  if (trimmed === "~") return normalize(home);
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return resolve(home, trimmed.slice(2));
  }
  if (isWindowsAbsolutePath(trimmed) || isAbsolute(trimmed)) {
    // `normalize` keeps a Windows drive root (`C:\`) as it is and folds `..`.
    return normalize(trimmed);
  }
  return null;
}

/** `path` is `root` itself or inside it; lexical, so it works for a path that is gone. */
export function isPathAtOrUnder(path: string, root: string): boolean {
  const rel = relative(normalize(root), normalize(path));
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Where `path` ends up when `from` moves to `to`: `to` itself for the project
 * folder, `to` plus the same relative tail for anything inside it, null for a
 * path outside. `from` and `to` must be absolute and normalized.
 */
export function mapPathUnderRoot(path: string, from: string, to: string): string | null {
  if (!isPathAtOrUnder(path, from)) return null;
  const rel = relative(normalize(from), normalize(path));
  return rel === "" ? normalize(to) : join(normalize(to), rel);
}

/** The project folder a destination directory holds: the project keeps its own name. */
export function projectDestinationPath(targetDir: string, sourceRoot: string): string {
  return join(normalize(targetDir), basename(normalize(sourceRoot)));
}

/**
 * pi's session directory name for a cwd, exactly as the SDK encodes it
 * (`--abs-path-with-slashes-replaced--`): sessions are filed under it, so a
 * moved session must be filed under the new cwd's name.
 */
export function sessionProjectDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
