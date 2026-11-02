import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { buildSystemPromptsResponse } from "@/lib/system-prompt-library";

export const dynamic = "force-dynamic";

/**
 * GET /api/system-prompts?sessionId=<id>
 *
 * The `pi-system-prompt-manager` extension's prompt library and the state the
 * given session uses (its own entry, else the global `default`). Read-only: the
 * composer picks by sending `/sysprompt <name>` to the session, so the extension
 * stays the one writer of both files. The session id is only a lookup key, never
 * a path, and an unknown one falls back to the default.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  try {
    return NextResponse.json(buildSystemPromptsResponse(getAgentDir(), searchParams.get("sessionId")));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
