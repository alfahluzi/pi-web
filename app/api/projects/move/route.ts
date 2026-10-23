import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { executeProjectMove, isProjectMoveRefusal, prepareProjectMove, type ProjectMovePlan } from "@/lib/project-move";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/projects/move — the sidebar's "Move project".
// Body: { root, target, dryRun? }
//   root    the project's folder today (the group's root)
//   target  the directory the project moves into; created when missing
//   dryRun  true: only validate and describe the move (the confirmation's
//           "This folder contains 4 folders and 3 files"), changing nothing
// The project keeps its own folder name inside `target`.
//
// The two steps are separate on purpose: the menu shows what a dry run plans,
// including what the destination already holds, and only a second request with
// the same paths moves anything.

const NO_STORE = { "Cache-Control": "no-store" };

function refusal(status: number, code: string, error: string) {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

/** What the sidebar needs to show the move before it happens. */
function planSummary(plan: ProjectMovePlan) {
  return {
    source: plan.source,
    targetDir: plan.targetDir,
    targetDirExists: plan.targetDirExists,
    destination: plan.destination,
    targetContents: plan.targetContents,
    sessionCount: plan.sessions.length,
    warnings: plan.warnings,
  };
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return refusal(403, "request-denied", "Untrusted API request");
  if (!hasJsonContentType(req)) return refusal(415, "content-type", "Content-Type must be application/json");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return refusal(400, "invalid-request", "Invalid JSON body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return refusal(400, "invalid-request", "Expected a JSON object");
  }
  const { root, target, dryRun } = body as { root?: unknown; target?: unknown; dryRun?: unknown };
  if (typeof root !== "string" || typeof target !== "string") {
    return refusal(400, "invalid-request", "root and target must be strings");
  }

  try {
    const prepared = await prepareProjectMove({ root, target });
    if (!prepared.ok) return refusal(prepared.refusal.status, prepared.refusal.code, prepared.refusal.error);
    if (dryRun === true) {
      return NextResponse.json({ plan: planSummary(prepared.plan) }, { headers: NO_STORE });
    }
    const result = await executeProjectMove(prepared.plan);
    return NextResponse.json({ moved: result }, { headers: NO_STORE });
  } catch (error) {
    if (isProjectMoveRefusal(error)) return refusal(error.status, error.code, error.message);
    return refusal(500, "internal", error instanceof Error ? error.message : String(error));
  }
}
