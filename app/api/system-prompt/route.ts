import { join } from "node:path";
import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getProjectTrustStatus } from "@/lib/project-trust";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  SYSTEM_PROMPT_TARGETS,
  applySystemPromptWrite,
  deleteSystemPromptFile,
  isSystemPromptTarget,
  readSystemPromptFile,
  statSystemPromptEntry,
  systemPromptFileName,
  systemPromptPath,
  type SystemPromptTarget,
} from "@/lib/system-prompt-file";

export const dynamic = "force-dynamic";

/**
 * Settings › System prompt: reads and writes the agent directory's `SYSTEM.md`
 * and `APPEND_SYSTEM.md`, which pi reads at session start. Both paths are
 * resolved here from `getAgentDir()`, never taken from the request, so this
 * route cannot be pointed at another file.
 *
 * A running session keeps the prompt it started with until `reload`; the panel
 * sends that after a save. A project's `.pi/SYSTEM.md` outranks the global file
 * when the project is trusted, which the GET reports so the panel can say so.
 */

interface SystemPromptState {
  target: SystemPromptTarget;
  path: string;
  exists: boolean;
  content: string;
  revision: string;
  size: number;
  tooLarge: boolean;
  blocked: string | null;
  /** The project file that would win over this one, when the folder is trusted and has one. */
  projectFile: { path: string; active: boolean } | null;
}

function errorResponse(error: unknown, status = 500) {
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status });
}

function readTarget(agentDir: string, target: SystemPromptTarget, cwd: string | null): SystemPromptState {
  const file = readSystemPromptFile(agentDir, target);
  let projectFile: SystemPromptState["projectFile"] = null;
  if (cwd) {
    const projectPath = join(cwd, ".pi", systemPromptFileName(target));
    const project = statSystemPromptEntry(projectPath);
    if (project.state !== "missing") {
      const trusted = getProjectTrustStatus(cwd, agentDir).trusted;
      projectFile = { path: projectPath, active: trusted && project.state === "file" };
    }
  }
  return { target, ...file, projectFile };
}

export async function GET(req: Request) {
  try {
    const agentDir = getAgentDir();
    const cwd = new URL(req.url).searchParams.get("cwd") || null;
    return NextResponse.json({
      agentDir,
      targets: SYSTEM_PROMPT_TARGETS.map((target) => readTarget(agentDir, target, cwd)),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { target } = (body ?? {}) as { target?: unknown };
  if (!isSystemPromptTarget(target)) {
    return NextResponse.json({ error: "target must be 'system' or 'append'" }, { status: 400 });
  }
  try {
    const agentDir = getAgentDir();
    const written = applySystemPromptWrite(agentDir, target, body);
    if (!written.ok) return NextResponse.json({ error: written.error }, { status: written.status });
    return NextResponse.json({
      target,
      path: systemPromptPath(agentDir, target),
      exists: written.exists,
      content: written.content,
      revision: written.revision,
      size: Buffer.byteLength(written.content, "utf8"),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const target = new URL(req.url).searchParams.get("target");
  if (!isSystemPromptTarget(target)) {
    return NextResponse.json({ error: "target must be 'system' or 'append'" }, { status: 400 });
  }
  try {
    const result = deleteSystemPromptFile(getAgentDir(), target);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ target, exists: false, content: "", revision: "", size: 0 });
  } catch (error) {
    return errorResponse(error);
  }
}
