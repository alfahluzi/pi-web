/**
 * Host-side helpers for the panel postMessage bridge. Kept free of browser and
 * Node APIs so the path rule can be unit tested: the browser cannot apply Node
 * path rules, so a plugin that sends a workspace-relative path (the natural
 * thing to write) relies on this join.
 */

function isAbsolutePanelPath(path: string): boolean {
  // POSIX (`/x`), Windows drive (`C:\x` / `C:/x`) and UNC (`\\server\share`).
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(path);
}

/**
 * Resolve a path a panel asked to open against the active workspace. Absolute
 * paths pass through untouched; relative ones are joined with `cwd` using that
 * workspace's separator convention.
 */
export function resolveWebPanelPath(path: string, cwd: string | null): string {
  const trimmed = path.trim();
  if (!trimmed || !cwd || isAbsolutePanelPath(trimmed)) return trimmed;
  const separator = cwd.includes("\\") ? "\\" : "/";
  const base = cwd.replace(/[\\/]+$/, "");
  let relative = trimmed.replace(/^[\\/]+/, "");
  while (relative.startsWith("./") || relative.startsWith(".\\")) relative = relative.slice(2);
  return `${base}${separator}${relative}`;
}
