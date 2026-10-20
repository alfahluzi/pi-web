import { NextResponse } from "next/server";
import { readPinnedSessionIds, writePinnedSessionIds } from "@/lib/session-pins";
import { togglePinnedId } from "@/lib/session-pin-order";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

// Pins are a pi-web-only preference, so they live in their own sidecar file
// instead of the session transcript (see lib/session-pins.ts).
export async function GET() {
  return NextResponse.json({ pinnedSessionIds: readPinnedSessionIds() }, { headers: NO_STORE });
}

/** Toggle one session: `{ sessionId, pinned }`. Pinning is idempotent. */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null) as { sessionId?: unknown; pinned?: unknown } | null;
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
    if (!sessionId) {
      return NextResponse.json({ error: "sessionId is required" }, { status: 400, headers: NO_STORE });
    }
    if (typeof body?.pinned !== "boolean") {
      return NextResponse.json({ error: "pinned must be a boolean" }, { status: 400, headers: NO_STORE });
    }
    const pinnedSessionIds = writePinnedSessionIds(
      togglePinnedId(readPinnedSessionIds(), sessionId, body.pinned),
    );
    return NextResponse.json({ pinnedSessionIds }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500, headers: NO_STORE });
  }
}
