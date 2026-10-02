/**
 * Server-side registry for the right-panel "web panels" an installed Pi package
 * declares under `package.json#piWeb` (see `lib/web-panel-manifest.ts`).
 *
 * A panel document is served back to the browser from the package itself by
 * `app/api/web-panels/[id]/[[...path]]/route.ts`, so a plugin can ship HTML,
 * JS and CSS without a build step or any change to pi-web's source.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
  type PackageSource,
} from "@earendil-works/pi-coding-agent";
import { getProjectTrustStatus } from "@/lib/project-trust";
import type {
  PluginScope,
  WebPanelDiagnostic,
  WebPanelInfo,
  WebPanelsResponse,
} from "@/lib/api-types";
import {
  parseWebPanelManifest,
  resolvePanelAssetPath,
  webPanelAssetUrl,
  type WebPanelManifestPanel,
} from "@/lib/web-panel-manifest";

export interface WebPanelDeclaration extends WebPanelInfo {
  /** Absolute path of the HTML document the iframe loads. */
  entryPath: string;
  /** Absolute package root every asset must stay inside. */
  packageRoot: string;
}

export interface WebPanelScanResult {
  panels: WebPanelDeclaration[];
  diagnostics: WebPanelDiagnostic[];
}

type GlobalWithWebPanels = typeof globalThis & {
  /** id (lowercased) -> declaration, independent of cwd, for asset requests. */
  __piWebPanelRegistry?: Map<string, WebPanelDeclaration>;
};

function registryMap(): Map<string, WebPanelDeclaration> {
  const globalRef = globalThis as GlobalWithWebPanels;
  return (globalRef.__piWebPanelRegistry ??= new Map());
}

function getPackageSource(entry: PackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

function isDisabledPackage(entry: PackageSource): boolean {
  if (typeof entry === "string") return false;
  return (
    Array.isArray(entry.extensions) && entry.extensions.length === 0 &&
    Array.isArray(entry.skills) && entry.skills.length === 0 &&
    Array.isArray(entry.prompts) && entry.prompts.length === 0 &&
    Array.isArray(entry.themes) && entry.themes.length === 0
  );
}

function keyFor(source: string, scope: PluginScope): string {
  return `${scope}\0${source}`;
}

function scopeRank(scope: "user" | "project"): number {
  return scope === "project" ? 1 : 0;
}

function packageRootOf(installedPath: string): string | null {
  try {
    const stats = statSync(installedPath);
    return stats.isDirectory() ? installedPath : dirname(installedPath);
  } catch {
    return null;
  }
}

function readPackageManifest(packageRoot: string): { name?: string; piWeb?: unknown } | null {
  try {
    const parsed = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Record<string, unknown>;
    return {
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      piWeb: parsed.piWeb,
    };
  } catch {
    return null;
  }
}

function isFileSync(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Read-time containment check that also follows symlinks: a package can ship a
 * symlink pointing outside itself, so the lexical check in
 * `resolvePanelAssetPath` is not sufficient on its own.
 */
export function isPathInsidePackage(packageRoot: string, candidate: string): boolean {
  const root = resolve(packageRoot);
  const target = resolve(candidate);
  const lexical = relative(root, target);
  if (!lexical || lexical.startsWith("..") || isAbsolute(lexical)) return false;
  try {
    const realRoot = realpathSync(root);
    const realTarget = realpathSync(target);
    const realRelative = relative(realRoot, realTarget);
    return Boolean(realRelative) && !realRelative.startsWith("..") && !isAbsolute(realRelative);
  } catch {
    // The file does not exist (or a broken symlink): refuse rather than guess.
    return false;
  }
}

async function scanWebPanels(cwd: string | null): Promise<WebPanelScanResult> {
  const agentDir = getAgentDir();
  // With no workspace there is nothing project-scoped to resolve, so scan from
  // the agent directory: it has no project settings and reads only global ones.
  const effectiveCwd = cwd ?? agentDir;
  const trust = getProjectTrustStatus(effectiveCwd, agentDir);
  const settingsManager = SettingsManager.create(effectiveCwd, agentDir, {
    projectTrusted: trust.trusted,
  });
  const packageManager = new DefaultPackageManager({ cwd: effectiveCwd, agentDir, settingsManager });

  const diagnostics: WebPanelDiagnostic[] = [];
  const disabled = new Map<string, boolean>();
  for (const entry of settingsManager.getGlobalSettings().packages ?? []) {
    disabled.set(keyFor(getPackageSource(entry), "global"), isDisabledPackage(entry));
  }
  for (const entry of settingsManager.getProjectSettings().packages ?? []) {
    disabled.set(keyFor(getPackageSource(entry), "project"), isDisabledPackage(entry));
  }

  const byId = new Map<string, WebPanelDeclaration>();
  const packages = [...packageManager.listConfiguredPackages()]
    .sort((a, b) => scopeRank(a.scope) - scopeRank(b.scope));

  for (const pkg of packages) {
    const scope: PluginScope = pkg.scope === "project" ? "project" : "global";
    // Project packages only load when the project is trusted, matching how the
    // rest of pi-web treats project resources.
    if (scope === "project" && !trust.trusted) continue;
    if (disabled.get(keyFor(pkg.source, scope))) continue;
    if (!pkg.installedPath) continue;

    const packageRoot = packageRootOf(pkg.installedPath);
    if (!packageRoot) {
      diagnostics.push({ type: "warning", source: pkg.source, message: "Package path was not found." });
      continue;
    }

    const manifest = readPackageManifest(packageRoot);
    if (!manifest) continue;

    const parsed = parseWebPanelManifest(manifest.piWeb);
    for (const error of parsed.errors) {
      diagnostics.push({ type: "warning", source: pkg.source, message: error });
    }

    for (const panel of parsed.panels) {
      addPanel(byId, panel, {
        packageRoot,
        source: pkg.source,
        scope,
        packageName: manifest.name,
        diagnostics,
      });
    }
  }

  const panels = [...byId.values()].sort((a, b) => (
    a.order - b.order
    || a.title.localeCompare(b.title)
    || a.id.localeCompare(b.id)
  ));
  return { panels, diagnostics };
}

function addPanel(
  byId: Map<string, WebPanelDeclaration>,
  panel: WebPanelManifestPanel,
  context: {
    packageRoot: string;
    source: string;
    scope: PluginScope;
    packageName?: string;
    diagnostics: WebPanelDiagnostic[];
  },
): void {
  const { packageRoot, source, scope, packageName, diagnostics } = context;
  const entryPath = resolvePanelAssetPath(packageRoot, panel.entry);
  if (!entryPath || !isFileSync(entryPath)) {
    diagnostics.push({
      type: "warning",
      source,
      message: `Panel "${panel.id}" entry "${panel.entry}" was not found.`,
    });
    return;
  }

  const key = panel.id.toLowerCase();
  // Project panels override global ones with the same id; among equal scopes the
  // first configured package wins.
  if (scope === "global" && byId.has(key)) return;

  byId.set(key, {
    id: panel.id,
    title: panel.title,
    icon: panel.icon,
    iconSvgPath: panel.iconSvgPath,
    order: panel.order ?? 0,
    url: webPanelAssetUrl(panel.id, panel.entry),
    source,
    scope,
    packageName,
    packageRoot,
    entryPath,
  });
}

function register(panels: WebPanelDeclaration[]): void {
  const registry = registryMap();
  for (const panel of panels) registry.set(panel.id.toLowerCase(), panel);
}

/** Resolve the web panels visible for `cwd` and remember them for asset requests. */
export async function listWebPanels(cwd: string | null): Promise<WebPanelScanResult> {
  const result = await scanWebPanels(cwd);
  register(result.panels);
  return result;
}

/** Look a panel up by id from the last scan, for asset requests. */
export function findWebPanel(id: string): WebPanelDeclaration | null {
  return registryMap().get(id.toLowerCase()) ?? null;
}

/**
 * Asset requests arrive without the project cwd once the browser resolves a
 * relative import, so fall back to a scan when the id is unknown (for example
 * after a server restart whose registry is empty).
 */
export async function findWebPanelWithScan(
  id: string,
  cwd: string | null,
): Promise<WebPanelDeclaration | null> {
  const existing = findWebPanel(id);
  if (existing) return existing;
  if (!cwd) return null;
  await listWebPanels(cwd);
  return findWebPanel(id);
}

export function toWebPanelsResponse(result: WebPanelScanResult): WebPanelsResponse {
  return {
    panels: result.panels.map((panel): WebPanelInfo => ({
      id: panel.id,
      title: panel.title,
      icon: panel.icon,
      iconSvgPath: panel.iconSvgPath,
      order: panel.order,
      url: panel.url,
      source: panel.source,
      scope: panel.scope,
      packageName: panel.packageName,
    })),
    diagnostics: result.diagnostics,
  };
}
