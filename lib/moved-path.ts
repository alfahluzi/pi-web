/**
 * Client-safe path arithmetic for a project that just moved: which open tab and
 * which composer cwd belong to the old folder and where they point now.
 *
 * A browser cannot import `node:path` (and the server's helpers reach the
 * filesystem), so containment here is plain string work on slash-normalized
 * paths. It is for choosing what to re-point in the UI, not for an access
 * decision — the file routes re-check every path themselves.
 */

function toSlash(path: string): string {
  return path.replace(/\\/g, "/");
}

function isWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** Slash form, no duplicate or trailing separators, case-folded for a Windows path. */
export function comparablePath(path: string): string {
  const slashed = toSlash(path).replace(/\/{2,}/g, "/").replace(/(.)\/+$/, "$1");
  return isWindowsPath(path) ? slashed.toLowerCase() : slashed;
}

/** `path` is `root` itself or inside it. */
export function isPathAtOrUnderRoot(path: string, root: string): boolean {
  if (!path || !root) return false;
  const candidate = comparablePath(path);
  const base = comparablePath(root);
  return candidate === base || candidate.startsWith(`${base}/`);
}

/** Where `path` lands when `from` moves to `to`; null when it is outside. */
export function remapMovedPath(path: string, from: string, to: string): string | null {
  if (!isPathAtOrUnderRoot(path, from)) return null;
  const candidate = comparablePath(path);
  const base = comparablePath(from);
  if (candidate === base) return to;
  const tail = toSlash(path).slice(toSlash(from).length).replace(/^\/+/, "");
  return `${toSlash(to).replace(/\/+$/, "")}/${tail}`;
}

/**
 * A panel URL whose `?cwd=` names a folder under `from`, re-pointed at `to`
 * (a package panel's document is served with the workspace it was opened in).
 * Null when the URL carries no such cwd, so callers can leave the tab alone.
 */
export function remapUrlCwd(url: string, from: string, to: string): string | null {
  const query = url.indexOf("?");
  if (query < 0) return null;
  const params = new URLSearchParams(url.slice(query + 1));
  const cwd = params.get("cwd");
  if (!cwd) return null;
  const moved = remapMovedPath(cwd, from, to);
  if (!moved) return null;
  params.set("cwd", moved);
  return `${url.slice(0, query)}?${params.toString()}`;
}
