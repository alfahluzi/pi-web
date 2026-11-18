// Bounded, symlink-safe capture storage for the cache monitor. All filesystem
// access, rotation, retention and deadline reporting lives here so the recorder
// only owns identity, queueing and lifecycle.

import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, opendir, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
// @ts-expect-error TS5097: tsconfig omits allowImportingTsExtensions, but Node's --experimental-strip-types requires the explicit .ts extension.
import { MAX_RECORD_BYTES, parseCapture } from './cache-monitor-schema.ts';

export const ACTIVE_CAPTURE = 'cache-monitor.jsonl';
export const MAX_CAPTURE_BYTES = 1024 * 1024;
export const MAX_CAPTURE_FILES = 4;
export const CAPTURE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const CAPTURE_NAME = /^cache-monitor(?:\.[1-3])?\.jsonl$/;
const MAX_DIRECTORY_ENTRIES = 16;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;

function fail(detail: string): never {
  throw new Error(`invalid capture storage: ${detail}`);
}

export async function prepareCaptureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('directory is not a real directory');
  await chmod(directory, 0o700);
}

async function statOwnedCapture(path: string): Promise<Stats | undefined> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) fail('capture path is not a regular file');
  return info;
}

async function readCapture(path: string, now: number): Promise<{ oldest: number; ino: number; dev: number }> {
  const file = await open(path, constants.O_RDONLY | NO_FOLLOW | NONBLOCK);
  try {
    const info = await file.stat();
    const pathInfo = await lstat(path);
    if (!info.isFile() || pathInfo.isSymbolicLink() || info.ino !== pathInfo.ino || info.dev !== pathInfo.dev) fail('capture identity changed');
    if (info.size > MAX_CAPTURE_BYTES) fail('capture file is too large');
    await file.chmod(0o600);
    const buffer = Buffer.alloc(info.size);
    let bytesRead = 0;
    while (bytesRead < info.size) {
      const result = await file.read(buffer, bytesRead, info.size - bytesRead, bytesRead);
      if (!result.bytesRead) fail('capture file changed while reading');
      bytesRead += result.bytesRead;
    }
    const after = await file.stat();
    if (after.size !== info.size || after.ino !== info.ino || after.dev !== info.dev) fail('capture file changed while reading');
    let oldest = Infinity;
    for (const record of parseCapture(buffer.toString('utf8'), now)) oldest = Math.min(oldest, record.timestamp_ms);
    return { oldest, ino: info.ino, dev: info.dev };
  } finally {
    await file.close();
  }
}

// Validates every owned capture, deletes those past seven days from their oldest
// record timestamp, and returns the earliest remaining expiry (Infinity if none).
export async function expireCaptures(directory: string, now: number): Promise<number> {
  await prepareCaptureDirectory(directory);
  const names: string[] = [];
  const directoryEntries = await opendir(directory);
  let entries = 0;
  for await (const entry of directoryEntries) {
    if (++entries > MAX_DIRECTORY_ENTRIES) fail('too many directory entries');
    if (CAPTURE_NAME.test(entry.name)) names.push(entry.name);
  }
  let deadline = Infinity;
  for (const name of names) {
    const path = join(directory, name);
    const { oldest, ino, dev } = await readCapture(path, now);
    if (oldest === Infinity) continue;
    const expiry = oldest + CAPTURE_RETENTION_MS;
    if (now >= expiry) {
      // Delete only if the path still names the file that was validated.
      const current = await lstat(path);
      if (current.ino === ino && current.dev === dev && current.isFile() && !current.isSymbolicLink()) await rm(path);
    } else {
      deadline = Math.min(deadline, expiry);
    }
  }
  return deadline;
}

async function rotateCaptures(directory: string): Promise<void> {
  await rm(join(directory, `cache-monitor.${MAX_CAPTURE_FILES - 1}.jsonl`), { force: true });
  for (let index = MAX_CAPTURE_FILES - 1; index >= 1; index--) {
    const from = join(directory, index === 1 ? ACTIVE_CAPTURE : `cache-monitor.${index - 1}.jsonl`);
    const to = join(directory, `cache-monitor.${index}.jsonl`);
    try {
      await rename(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function openActiveCapture(path: string, exists: boolean): Promise<FileHandle> {
  const flags = constants.O_WRONLY | constants.O_APPEND | NO_FOLLOW | NONBLOCK;
  // Never open a path without knowing what should be there: create exclusively
  // when absent, otherwise open the inode observed immediately before.
  return exists ? open(path, flags, 0o600) : open(path, flags | constants.O_CREAT | constants.O_EXCL, 0o600);
}

export async function appendCapture(directory: string, line: string, now: number): Promise<void> {
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > MAX_RECORD_BYTES) fail('record is too large');
  // Recheck expiry before every append so a clock jump or a long idle period
  // cannot extend retention or append to an expired capture.
  await expireCaptures(directory, now);
  const activePath = join(directory, ACTIVE_CAPTURE);
  let existing = await statOwnedCapture(activePath);
  if (existing && existing.size + bytes > MAX_CAPTURE_BYTES) {
    await rotateCaptures(directory);
    existing = undefined;
  }
  const file = await openActiveCapture(activePath, existing !== undefined);
  try {
    const opened = await file.stat();
    const pathInfo = await lstat(activePath);
    if (!opened.isFile() || pathInfo.isSymbolicLink() || opened.ino !== pathInfo.ino || opened.dev !== pathInfo.dev) fail('capture identity changed');
    if (existing && (opened.ino !== existing.ino || opened.dev !== existing.dev)) fail('capture was swapped');
    if (opened.size + bytes > MAX_CAPTURE_BYTES) fail('capture file limit reached');
    await file.chmod(0o600);
    await file.writeFile(line, 'utf8');
  } finally {
    await file.close();
  }
}
