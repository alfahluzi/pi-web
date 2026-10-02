/**
 * Pure helpers for the pi-web "web panel" manifest that a Pi package can
 * declare under `package.json#piWeb`. Nothing here touches the SDK or the
 * filesystem beyond `node:path`, so it is safe to unit test in isolation and to
 * import from both the server registry and client-side validation mirrors.
 *
 * Shape a package declares:
 *
 *   {
 *     "name": "@scope/my-panel",
 *     "piWeb": {
 *       "panels": [
 *         { "id": "plan", "title": "Project Plan", "icon": "clipboard",
 *           "entry": "panel/index.html" }
 *       ]
 *     }
 *   }
 *
 * `id` becomes the first URL segment of the asset route, `entry` points at the
 * HTML document the right panel loads in an iframe, and every relative asset in
 * that document resolves under the same route prefix.
 */

export const WEB_PANEL_ICON_NAMES = [
  "plugin",
  "clipboard",
  "list",
  "folder",
  "file",
  "globe",
  "terminal",
  "settings",
  "table",
  "calendar",
  "chart",
  "code",
  "book",
  "sparkles",
  "layers",
  "git-branch",
  "database",
  "external-link",
  "message",
  "lightbulb",
  "rocket",
  "search",
  "box",
] as const;

export type WebPanelIconName = (typeof WEB_PANEL_ICON_NAMES)[number];

const ICON_NAME_SET = new Set<string>(WEB_PANEL_ICON_NAMES);
const PANEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
/** Only path-command characters, digits and separators — never quotes or `<`. */
const SAFE_SVG_PATH = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+\-eE]*$/;
const MAX_ICON_PATH_LENGTH = 4000;
const MAX_ENTRY_LENGTH = 512;

export interface WebPanelManifestPanel {
  id: string;
  title: string;
  /** Relative path to the HTML document inside the package. */
  entry: string;
  icon?: string;
  iconSvgPath?: string;
  order?: number;
}

export interface WebPanelManifestParseResult {
  panels: WebPanelManifestPanel[];
  errors: string[];
}

/** Normalize backslashes and any leading `./` so comparisons are platform-stable. */
export function normalizePanelRelativePath(value: string): string {
  let normalized = value.replace(/\\/g, "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized;
}

/**
 * Reject absolute paths, drive letters, empty/dot segments and null bytes so the
 * value can never escape the package root once joined.
 */
export function isSafePanelRelativePath(value: string): boolean {
  if (!value || value.length > MAX_ENTRY_LENGTH) return false;
  if (value.includes("\0")) return false;
  const normalized = normalizePanelRelativePath(value);
  if (normalized.startsWith("/")) return false;
  if (/^[a-zA-Z]:/.test(normalized)) return false;
  return normalized.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Resolve a package-relative asset path to an absolute one, returning null when
 * it would leave the package root. Purely lexical: symlink escape is checked
 * separately by `isPathInsidePackage` at read time.
 */
export function resolvePanelAssetPath(packageRoot: string, relativePath: string): string | null {
  if (!isSafePanelRelativePath(relativePath)) return null;
  const root = `${packageRoot}`.replace(/[/\\]+$/, "");
  const candidate = `${root}/${normalizePanelRelativePath(relativePath)}`;
  const normalizedRoot = normalizePanelRelativePath(root);
  const normalizedCandidate = normalizePanelRelativePath(candidate);
  if (normalizedCandidate === normalizedRoot) return null;
  if (!normalizedCandidate.startsWith(`${normalizedRoot}/`)) return null;
  return candidate;
}

/**
 * Parse and validate `package.json#piWeb`. Never throws: malformed entries are
 * reported as errors so the caller can surface them as diagnostics instead of
 * failing the whole package listing.
 */
export function parseWebPanelManifest(raw: unknown): WebPanelManifestParseResult {
  const errors: string[] = [];
  if (raw == null) return { panels: [], errors };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("piWeb must be an object");
    return { panels: [], errors };
  }

  const entries = (raw as { panels?: unknown }).panels;
  if (entries === undefined) return { panels: [], errors };
  if (!Array.isArray(entries)) {
    errors.push("piWeb.panels must be an array");
    return { panels: [], errors };
  }

  const panels: WebPanelManifestPanel[] = [];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const label = `piWeb.panels[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${label} must be an object`);
      return;
    }
    const record = entry as Record<string, unknown>;

    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!PANEL_ID_PATTERN.test(id)) {
      errors.push(`${label}.id must match ${PANEL_ID_PATTERN}`);
      return;
    }
    const idKey = id.toLowerCase();
    if (seen.has(idKey)) {
      errors.push(`${label}.id "${id}" is duplicated`);
      return;
    }
    seen.add(idKey);

    const entryPath = typeof record.entry === "string" ? record.entry.trim() : "";
    if (!isSafePanelRelativePath(entryPath) || !/\.html?$/i.test(entryPath)) {
      errors.push(`${label}.entry must be a relative path to an .html file inside the package`);
      return;
    }

    const title = typeof record.title === "string" && record.title.trim()
      ? record.title.trim().slice(0, 80)
      : id;

    const icon = typeof record.icon === "string" && ICON_NAME_SET.has(record.icon)
      ? record.icon
      : undefined;

    const rawIconPath = typeof record.iconSvgPath === "string" ? record.iconSvgPath.trim() : "";
    const iconSvgPath = rawIconPath
      && rawIconPath.length <= MAX_ICON_PATH_LENGTH
      && SAFE_SVG_PATH.test(rawIconPath)
      ? rawIconPath
      : undefined;

    const order = typeof record.order === "number" && Number.isFinite(record.order)
      ? record.order
      : undefined;

    panels.push({
      id,
      title,
      entry: normalizePanelRelativePath(entryPath),
      icon,
      iconSvgPath,
      order,
    });
  });

  return { panels, errors };
}

/** Build the URL the iframe loads for a panel document. */
export function webPanelAssetUrl(id: string, relativePath: string): string {
  const encoded = normalizePanelRelativePath(relativePath)
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `/api/web-panels/${encodeURIComponent(id)}/${encoded}`;
}
