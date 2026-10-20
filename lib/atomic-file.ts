import { randomUUID } from "crypto";
import { renameSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";

/**
 * Atomically replace a file while preserving the caller-supplied permission
 * bits. The temp file lives in the target's directory so a directory watcher
 * observes the rename. The caller must create the parent directory first.
 */
export function writeFileAtomicSync(path: string, contents: string, mode: number): void {
  const dir = dirname(path);
  const tempPath = join(dir, `.${basename(path)}-${randomUUID()}.tmp`);
  let operationFailed = false;

  try {
    writeFileSync(tempPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode,
      flush: true,
    });
    renameSync(tempPath, path);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      unlinkSync(tempPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !operationFailed) {
        throw error;
      }
    }
  }
}

/**
 * Replace a file atomically without exposing credentials through default
 * process permissions. The caller must create the parent directory first.
 */
export function writePrivateFileAtomicSync(path: string, contents: string): void {
  const dir = dirname(path);
  const tempPath = join(dir, `.${basename(path)}-${randomUUID()}.tmp`);
  let operationFailed = false;

  try {
    writeFileSync(tempPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    renameSync(tempPath, path);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      unlinkSync(tempPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !operationFailed) {
        throw error;
      }
    }
  }
}
