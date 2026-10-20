# 0006 — The file editor is save-based, with a revision-checked write endpoint

## Status

Accepted. 2026-10-02.

## Context

The file viewer was read-only by design. `/api/files/[...path]` answered `GET`
only — there was no write method — so a user who opened a source file could read
it but had to leave Pi Web to change it. The view had a single display mode,
`Source`, that rendered the text as highlighted but inert content.

Two pieces already existed that made a save round trip cheap:

- `fs.watch` on the target directory plus an SSE `watch` request already pushed
  live change events, and the client already re-read the file when one arrived.
  The watcher is directory-scoped, so any write to a file is seen by every tab
  watching that directory, including the tab that made it.
- The agent frequently writes the very files the user is browsing (through its
  own tools), so change detection could not be dropped to make editing simpler.

What was missing was an authenticated, contained write path and a way to avoid
clobbering concurrent agent writes.

## Decision

**Add `PUT /api/files/[...path]` as the only write endpoint.** It enforces, in
order:

- `isApiRequestAllowed` (origin check), `hasJsonContentType`, and
  `isFilePathAllowed` + `isExistingFilePathAllowed` against the allowed roots
  with `realpath` containment;
- `lstat` refusal of symbolic links, so a link inside an allowed root cannot
  redirect the write outside it;
- `validateFileEditInput`: a 1 MiB body cap, `TEXT_PREVIEW_MAX_BYTES` (256 KiB)
  cap on the file already on disk, NUL rejection for binary content, and a
  `baseRevision` string that must equal the current
  `fileRevision(stat)` (`mtimeMs:size:ino`), otherwise the route answers `409`
  and does not write.

The write itself goes through `writeFileAtomicSync` (temp file + rename) and
preserves the existing `stat.mode & 0o777`, so a save never rewrites the
permission bits of a source file. The text read response now carries
`revision`, which the client round-trips as `baseRevision` on the next save.

**`Edit` is a fourth display mode, backed by CodeMirror 6.** `Source` stays the
read-only highlighted view; `Edit` adds an editable buffer with the same
highlighting. Languages with an official `@codemirror/lang-*` package are
highlighted; everything else is plain text but still editable.

**Sync is save-based, not live keystroke collaboration.** The editor keeps an
unsaved draft inside `FileViewerState.draft` and only writes it to disk on an
explicit save. Incoming SSE content refreshes are gated on a clean buffer, so a
change on disk can never overwrite an unsaved draft. CRLF line endings are
preserved across the round trip so a save does not silently rewrite a
Windows-style file.

Save-based sync was chosen over live collaboration on purpose:

- The watcher is directory-scoped, so a single save already fans the change out
  to every open tab; there is no missing propagation to build.
- The writer's own echo is harmless: the incoming text equals the buffer that
  just produced it, so the client does nothing.
- Operational transformation or a CRDT, plus a persistent upstream channel,
  would be a much larger change for a single-operator server that is bound to
  loopback by default. There is no second writer whose concurrent keystrokes
  need merging.

The tool-preset precedent of
[ADR 0002](0002-chat-only-tool-selection.md) applies here too: a capability is
made explicit and persisted rather than inferred from incidental state.

## Alternatives considered

- **A plain `textarea`.** Rejected: no highlighting and it loses parity with the
  existing `Source` rendering, so the same file would look different depending
  on whether it is editable.
- **`@codemirror/legacy-modes` for the long tail of languages.** Rejected: an
  extra dependency, and the unknown/edge modes were not worth the risk. Those
  languages stay plain text, but they remain editable.
- **Writing with `writePrivateFileAtomicSync`.** Rejected: it hard-codes mode
  `0o600`, so saving an ordinary source file would rewrite its permissions to
  owner-only.
- **A direct `fs.writeFileSync`.** Rejected: a crash or disk-full during the
  call leaves a truncated file. The atomic temp-file-and-rename path avoids
  partial writes.
- **Authorizing writes through `isFilePathReferencedBySession`.** Rejected:
  that path exists so a session can *read* a file outside the allowed roots. It
  is not an authorization to write there, and using it would let a write follow
  a session reference outside the containment the write endpoint is meant to
  guarantee.

## Consequences

- Files above `TEXT_PREVIEW_MAX_BYTES` (256 KiB) are not editable; the read path
  already declines to show them in full, and the write path returns the same
  refusal.
- Only languages with an official `@codemirror/lang-*` package are highlighted.
  Others are editable plain text.
- There is no file creation through the editor and no rename or delete; those
  remain upload and agent operations.
- There are no multi-user cursors or presence. Two tabs editing the same file
  resolve through the `409` revision check: the stale save is rejected and the
  user must reconcile, which is the intended behavior.
- `Edit` is unavailable for deleted diffs, because there is no file on disk to
  write back to.
- Invariants an implementer must not break: no write through a symlink, no write
  without the origin and content-type checks, no clobbering a dirty buffer on an
  SSE refresh, and no write that fails to preserve the file's permission bits.