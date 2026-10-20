import { TEXT_PREVIEW_MAX_BYTES } from "@/lib/file-types";

export const MAX_FILE_EDIT_BYTES = 1024 * 1024;
export const FILE_EDIT_TOO_LARGE_ERROR = "File is too large to edit";

export function fileRevision(stat: { mtimeMs: number; size: number; ino: number }): string {
  return `${Math.trunc(stat.mtimeMs)}:${stat.size}:${stat.ino}`;
}

export type FileEditValidation =
  | { ok: true; content: string }
  | { ok: false; status: number; error: string };

export function validateFileEditInput(
  body: unknown,
  current: { size: number; revision: string },
): FileEditValidation {
  if (current.size > TEXT_PREVIEW_MAX_BYTES) {
    return { ok: false, status: 413, error: FILE_EDIT_TOO_LARGE_ERROR };
  }

  if (
    body === null ||
    typeof body !== "object" ||
    typeof (body as { content?: unknown }).content !== "string" ||
    typeof (body as { baseRevision?: unknown }).baseRevision !== "string"
  ) {
    return { ok: false, status: 400, error: "Expected { content, baseRevision }" };
  }

  const { content, baseRevision } = body as { content: string; baseRevision: string };

  if (Buffer.byteLength(content, "utf8") > MAX_FILE_EDIT_BYTES) {
    return { ok: false, status: 413, error: FILE_EDIT_TOO_LARGE_ERROR };
  }

  if (content.includes("\u0000")) {
    return { ok: false, status: 415, error: "Binary files cannot be edited" };
  }

  if (baseRevision !== current.revision) {
    return { ok: false, status: 409, error: "File changed on disk" };
  }

  return { ok: true, content };
}