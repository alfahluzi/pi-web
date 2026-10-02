import { NextResponse } from "next/server";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { resolvePanelAssetPath } from "@/lib/web-panel-manifest";
import { findWebPanelWithScan, isPathInsidePackage } from "@/lib/web-panels";

export const dynamic = "force-dynamic";

/**
 * Static asset + document server for package-provided right panels.
 *
 * `/api/web-panels/<id>/<entry>` serves the declared HTML document; relative
 * imports inside it (`./app.js`, `./style.css`) resolve to sibling paths under
 * the same prefix. Freshness matters more than caching here because a panel is
 * edited in place while pi-web is running.
 */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".jsx": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".tsx": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

function mimeFor(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; path?: string[] }> },
) {
  const { id, path } = await context.params;
  const { searchParams } = new URL(request.url);
  const cwd = searchParams.get("cwd");

  if (cwd) {
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
  }

  const panel = await findWebPanelWithScan(id, cwd);
  if (!panel) return new NextResponse("Panel not found", { status: 404 });

  const relativePath = (path ?? []).join("/");
  if (!relativePath) {
    return NextResponse.redirect(new URL(panel.url, request.url), 302);
  }

  const candidate = resolvePanelAssetPath(panel.packageRoot, relativePath);
  if (!candidate || !isPathInsidePackage(panel.packageRoot, candidate)) {
    return new NextResponse("Not found", { status: 404 });
  }

  let info;
  try {
    info = await stat(candidate);
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
  if (!info.isFile()) return new NextResponse("Not found", { status: 404 });

  const data = await readFile(candidate);
  return new NextResponse(new Uint8Array(data), {
    status: 200,
    headers: {
      "Content-Type": mimeFor(candidate),
      "Content-Length": String(info.size),
      "Cache-Control": "no-store, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
