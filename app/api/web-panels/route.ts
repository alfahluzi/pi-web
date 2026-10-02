import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { listWebPanels, toWebPanelsResponse } from "@/lib/web-panels";

export const dynamic = "force-dynamic";

/**
 * GET /api/web-panels?cwd=...
 *
 * Lists the right-panel web panels declared by installed Pi packages. The panel
 * documents themselves are served by `/api/web-panels/[id]/[...path]`.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");

  if (cwd) {
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
  }

  try {
    // Always rescan: installing or removing a package while Settings is open
    // must be reflected on the next fetch, and the scan is a handful of
    // package.json reads.
    const result = await listWebPanels(cwd);
    return NextResponse.json(toWebPanelsResponse(result));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
