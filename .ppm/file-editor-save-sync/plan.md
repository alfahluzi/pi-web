# File Editor with Save-Based Sync

Created: 2026-10-02
Last updated: 2026-10-02

## 1. Objective

Make a text/code file opened in the Pi Web file viewer editable in place with CodeMirror 6, saved
through a new `PUT /api/files/[...path]` endpoint, and synchronized by saving only: after a save,
every tab, every other viewer kind (image/audio/video/document preview), the diff view, and the agent
itself observe the new file content. No live keystroke-level collaboration is in scope.

Acceptance intent that this plan must deliver:

- A clean text file can be switched to an **Edit** mode, changed, and saved with `Cmd/Ctrl+S` or a
  toolbar button.
- A save in tab A reaches tab B (same file) without a page refresh, through the existing
  `fs.watch` + SSE `change` mechanism.
- Saving never silently clobbers a change written by the agent (or any external writer) after the
  file was loaded; the user is told and chooses reload or overwrite.
- An unsaved draft survives a tab switch and is never lost by an automatic reload.

## 2. Source documents and requirements

- `AGENTS.md` — architecture map, file-access invariants, dev-server rules, "do not run `next build`
  during dev", "reuse the running dev server".
- `LOCAL-CHANGES.md` — this checkout is a fork of `@agegr/pi-web@0.9.3` on branch `custom`; the fork
  already patches `lib/rpc-manager.ts`, `lib/pi-types.ts`, `README.md`. New work must not disturb
  those patches.
- `app/api/files/[...path]/route.ts` — `GET` (list/read/download/meta/preview/watch) and `POST`
  (upload only). No write path exists today.
- `app/api/files/watch-route.test.mjs`, `app/api/files/stream-route.test.mjs` — the established
  source-assertion test pattern for this route.
- `lib/file-access.ts`, `lib/request-security.ts`, `lib/file-upload.ts` — the authorization,
  origin-check, and replace/refuse rules the upload path already applies.
- `lib/atomic-file.ts` — existing atomic write helper, but pinned to mode `0o600`.
- `lib/text-preview.ts`, `lib/file-types.ts` — `TEXT_PREVIEW_MAX_BYTES = 256 * 1024` and the UTF-8
  boundary-safe chunk reader.
- `components/FileViewer.tsx`, `lib/file-viewer-state.ts`, `components/file-tab-state.ts`,
  `components/AppShell.tsx`, `components/TabBar.tsx` — the viewer, its persisted per-tab state, and
  the tab surface.
- `docs/adr/0002-chat-only-tool-selection.md` … `0005-built-in-subagent-disable.md` — ADR house style.
- `lib/i18n/messages/{en,zh-CN,zh-TW}.ts` — all user-facing strings live in three locale files.

User requirements captured during planning:

1. Editing is triggered from the file viewer itself (not a separate editor page).
2. Synchronization is save-based; live typing / multi-cursor collaboration is explicitly out of scope.
3. The editor must be CodeMirror 6 (user preference).

## 3. Current-state findings

Verified by reading the code, not assumed:

- The file API is read-only. `FILE_REQUEST_TYPES = ["list","read","download","meta","preview","watch"]`
  and the only writer is the upload `POST`, which refuses to touch an existing file
  (`fs.writeFileSync(destination, bytes, { flag: "wx" })`).
- `TextFileViewer` renders `SyntaxHighlighter` / `ReactMarkdown` / `iframe` / `DiffView` only. There is
  no `textarea`, `contentEditable`, or editor dependency anywhere in `components/`; the single
  `textarea` reference in `FileViewer.tsx` is a keyboard-shortcut exclusion.
- Live reload already exists: the `watch` branch uses `fs.watch(path.dirname(filePath), …)`, dedupes
  with `mtimeMs/ctimeMs/ino/size`, and emits SSE `change`; the client responds with `fetchContent`
  and `fetchGitDiff`. The watcher is per-connection, so each tab gets its own stream.
- The watcher watches the **directory**, so a write performed by the Next.js server process itself
  also produces a `change` event for every connected client. No extra publish/broadcast layer is
  needed for save-based sync.
- `TEXT_PREVIEW_MAX_BYTES = 256 * 1024`; beyond that the viewer shows a "Load more" button and
  `data.truncated === true`, so a full-file save would truncate the file.
- Only the **active** file tab mounts `FileViewer`
  (`key={activeFileTab.id}:${activeFileTab.viewerRevision}`), and the active viewer saves its
  `FileViewerState` on unmount through `onStateChange`. An in-editor draft therefore survives a tab
  switch only if it is part of that state.
- `FileViewerState = { displayMode, wrapLines, scrollTop, scrollLeft }` with
  `displayMode: "source" | "preview" | "diff"`.
- Tests run with `node --experimental-strip-types --test` (`npm test`), component tests assert on
  source text, and `node_modules/.bin/tsc --noEmit` plus `npm run lint` are the type/lint gates.
- A `next dev` server for this checkout is already running on `127.0.0.1:30141` (pid resolved from
  `/proc`, cwd `/home/ljosalfar-server/Documents/pi-web`), and `.next/dev/lock` exists. A second
  `next dev` for this checkout is not possible; browser verification must reuse the running server.
- All required CodeMirror 6 packages resolve on the configured npm registry (verified with
  `npm view`): `@codemirror/{state,view,commands,language,search}` and
  `@codemirror/lang-{javascript,json,markdown,html,css,python,rust,cpp,java,sql,yaml,xml,go,php}`.
- React is 19.2.4 and Next is 16.3.6; no React CodeMirror wrapper is installed.

## 4. Constraints and invariants

- **File-access boundary stays single.** Writes must go through the same
  `isFilePathAllowed` / `isExistingFilePathAllowed` checks as reads (realpath containment), and must
  never be authorized by `isFilePathReferencedBySession` — that path exists so a session can *read* a
  file outside the allowed roots, not write one.
- **`PUT` is a new, explicitly guarded method.** It must call `isApiRequestAllowed()` (the upload
  `POST` does; the `GET` branches do not) and `hasJsonContentType()`.
- **No new file creation.** A missing target is `404`; `flag: "wx"` upload semantics stay unchanged.
- **No write through a symlink.** Refuse with `400`, mirroring `inspectUploadTargets`'s
  non-replaceable rule.
- **Preserve file mode.** The atomic write must reuse `stat.mode & 0o777`; the existing
  `writePrivateFileAtomicSync` (mode `0o600`) must not be used or changed.
- **Never auto-reload a dirty buffer.** SSE `change` may refresh the viewer only when the buffer is
  clean and the draft is empty.
- **Editing is disabled for truncated files** (`data.truncated === true`), because a partial buffer
  would be written back as the whole file.
- **Do not run `next build`.** Development uses Turbopack; the running dev server is reused.
- **`enabledModels`-style minimal-edit discipline does not apply here**, but the i18n and TabBar files
  are hotspots: exactly one task per phase may own each of them.
- CodeMirror languages load through dynamic `import()` so the initial bundle stays small.

## 5. Proposed approach

Two phases. `phase_0` fixes every contract that two or more later tasks depend on (server write path,
revision token, validation helpers, the `FileEditor` component API, `FileViewerState.draft`, i18n
keys). `phase_1` integrates: the Edit mode inside `FileViewer`, the dirty-tab surface in
`AppShell`/`TabBar`, and documentation.

Phase shape, so the wave numbers are not mistaken for a scheduling defect: `phase_0` runs four
unrelated foundation tasks in parallel (wave 1), then the two tasks that consume those contracts
(wave 2), then one phase verification (wave 3). `phase_1` runs the viewer integration beside the
two documentation updates (wave 1); `AppShell`/`TabBar` dirty wiring is deliberately a single-task
wave 2 because it consumes the `onDirtyChange` prop that `FileViewer` only introduces in wave 1 —
running them concurrently would leave `tsc --noEmit` red for whichever task landed first; wave 3 is
the end-to-end verification.

Server (`PUT /api/files/[...path]`):

1. `isApiRequestAllowed` → `403`; `hasJsonContentType` → `415`.
2. Root check with `isFilePathAllowed`, then realpath containment with
   `isExistingFilePathAllowed` → `403`.
3. `lstat`: missing → `404`; symlink → `400`; not a regular file → `400`.
4. `stat` → revision token.
5. Parse `{ content, baseRevision }` and validate via pure helpers.
6. Atomic write with the original mode.
7. Re-`stat` and return `{ revision, size, mtime }`.

Revision token and validation live in a pure, unit-tested module (`lib/file-edit.ts`):

- `fileRevision(stat) === \`${Math.trunc(mtimeMs)}:${size}:${ino}\``.
- `MAX_FILE_EDIT_BYTES = 1024 * 1024` (4× the preview cap, so a fully loaded 256 KiB file always fits).
- Error precedence: size cap → `413`; NUL byte → `415`; malformed body → `400`; stale revision →
  `409`.

Reads gain a `revision` field so the client has a base token. `GET read` and `meta` keep their current
shapes otherwise.

Client:

- New `components/FileEditor.tsx` wrapping one `EditorView` (no React CodeMirror wrapper), with
  line numbers, history, search, `Mod-s` → `onSave`, `Ctrl-Enter`-free, and a theme built from the
  existing CSS variables through `useTheme()`.
- New dynamic language loader `lib/code-languages.ts` mapping the server language id
  (`getLanguage()`) to a CodeMirror extension; anything without an official package falls back to
  plain text while remaining editable.
- `FileViewerDisplayMode` gains `"edit"`; `FileViewerState` gains `draft?: string | null`; `FileData`
  gains `revision`.
- The Edit mode button is always rendered so the capability is discoverable, but it is `disabled`
  with the `i18n.fileTooLargeToEdit` tooltip when the file is truncated, and `effectiveDisplayMode`
  falls back to `"source"` so a file that becomes un-editable while edit mode is selected can never
  render the editor.
- `TextFileViewer` owns the edit buffer, the dirty flag, the line-ending memory, the save call, and the
  conflict/stale banner. It writes `draft` into `viewerStateRef` so a tab switch preserves it, and
  reports dirtiness upward through an optional `onDirtyChange` prop.
- `AppShell` tracks dirty tab ids, passes `dirty` to `TabBar` (dot indicator), and confirms before
  closing a dirty file tab. No confirmation on tab switch — the draft is preserved.

Save-based sync then falls out of the existing watcher: the saved file's `rename` produces a `change`
event, every other tab refetches, and the writing tab refetches identical content (harmless echo,
because the editor only replaces its document when the incoming text actually differs).

Line-ending handling is explicit: on load the viewer detects a CRLF file, remembers it, and hands the
editor LF-normalized text; on save it converts back and sends CRLF. This prevents a whole-file diff
from CodeMirror's internal `\n` normalization.

## 6. Dependencies

Runtime dependencies added by `phase_0` (exact resolved versions verified with `npm view` on
2026-10-02):

```text
@codemirror/state ^6.7.6
@codemirror/view ^6.43.13
@codemirror/commands ^6.11.1
@codemirror/language ^6.12.4
@codemirror/search ^6.7.2
@codemirror/lang-javascript ^6.2.5
@codemirror/lang-json ^6.0.2
@codemirror/lang-markdown ^6.5.2
@codemirror/lang-html ^6.4.12
@codemirror/lang-css ^6.3.1
@codemirror/lang-python ^6.2.1
@codemirror/lang-rust ^6.0.2
@codemirror/lang-cpp ^6.0.3
@codemirror/lang-java ^6.0.2
@codemirror/lang-sql ^6.10.0
@codemirror/lang-yaml ^6.1.3
@codemirror/lang-xml ^6.1.0
@codemirror/lang-go ^6.0.1
@codemirror/lang-php ^6.0.2
```

Existing modules reused, not reimplemented: `lib/file-access.ts`, `lib/request-security.ts`,
`lib/paths.ts`, `lib/text-preview.ts`, `lib/file-types.ts`, `lib/atomic-file.ts`, `hooks/useI18n.tsx`,
`hooks/useTheme.ts`, `components/MermaidBlock.tsx` (untouched).

## 7. Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| CRLF file round-trips through CodeMirror's LF document | Whole-file diff, destroyed history | Explicit EOL detection on load and restore on save; a CRLF fixture in `lib/file-edit.test.mjs`/`FileViewer` assertions |
| Agent writes the same file while the user is typing | Silent loss of the agent's work, or of the user's draft | Dirty-aware `change` handler shows a "file changed on disk" banner instead of reloading; `PUT` compares `baseRevision` and answers `409`; the user picks reload or overwrite |
| Only the active tab mounts `FileViewer` | Tab switch destroys an unsaved draft | `draft` becomes part of `FileViewerState`, saved on unmount and restored through `initialState` |
| Atomic `rename` changes the inode, and the watcher filters on `changedName` | Missed or duplicated `change` events | The watcher matches `samePath(join(dir, changedName), filePath)` and dedupes on `mtimeMs/ctimeMs/ino/size`; a rename to the target name matches. Keep the temp file in the same directory as the target |
| Own save echoes back as a `change` event | Cursor/scroll jump or editor remount | Editor replaces its document only when the incoming value differs; scroll state is preserved through `viewerStateRef` |
| Truncated (>256 KiB) file edited as if complete | Data loss (file truncated to the loaded chunk) | Edit mode omitted when `data.truncated`; `PUT` answers `413` above the cap |
| Symlink inside an allowed root redirects the write | Write outside the allowed roots | `lstat().isSymbolicLink()` → `400`; realpath containment before write |
| Windows `renameSync` over an existing file | Save failure | Node uses `MOVEFILE_REPLACE_EXISTING`; failure surfaces as a `500` with the original error, never a silent partial write |
| CodeMirror bundle growth | Slower initial page | Per-language dynamic `import()`; unmapped languages load nothing |
| `npm install` while the dev server runs | Turbopack reload churn, stale HMR graph | Install once in a foundation task; refresh the browser tab before manual verification; never run `next build` |

## 8. Verification strategy

Automated, per task and at each phase boundary:

- `npm test` (`node --experimental-strip-types --test` over `app/**`, `components/**`, `hooks/**`,
  `lib/**`, `public/**`).
- `node_modules/.bin/tsc --noEmit`.
- `npm run lint`.

New tests added by this plan:

- `lib/file-language.test.mjs` — language ids preserved after extraction from the route.
- `lib/file-edit.test.mjs` — every validation branch (`400`/`409`/`413` size/`413` truncated/`415`/ok),
  `fileRevision` format, and a real temp-directory round trip of `writeFileAtomicSync` asserting
  content, preserved mode bits, and no leftover `*.tmp` file.
- `lib/code-languages.test.mjs` — mapped ids resolve, unmapped ids resolve to `null`.
- `components/FileEditor.test.mjs` — source assertions in the style of `components/FileViewer.test.mjs`
  (one `EditorView`, `Mod-s` keymap, document replaced only when different, no per-keystroke React
  state).
- `app/api/files/write-route.test.mjs` — source assertions on the `PUT` branch (origin check, JSON
  content type, `lstat` symlink refusal, validation call, atomic write, revision response), following
  `app/api/files/watch-route.test.mjs`.
- `components/FileViewer.test.mjs` (extended) — the Edit button is `disabled={!canEdit}` with the
  too-large tooltip, `effectiveDisplayMode` falls back to `"source"` when `!canEdit`, `PUT` carries
  `baseRevision`, the `change` handler is dirty-guarded, and the draft is stored on unmount. The
  existing harness's fixed declaration list (line 41) must gain `canEdit`.
- `components/file-tab-state.test.mjs` (extended) — `openFileTab` preserves `draft` when it rebuilds
  `viewerState` for a mode hint.
- `components/AppShell.file-editor.test.mjs` — dirty tab dot, close confirmation, `onDirtyChange`
  wiring, matching the existing `AppShell.*.test.mjs` source-assertion style.

Manual browser verification in the closing task, reusing the already-running dev server at
`http://127.0.0.1:30141` (must not start a second `next dev`, must not run `next build`):

1. Open a text file, switch to **Edit**, type, press `Cmd/Ctrl+S`; the toolbar reports the save and
   the git diff badge appears.
2. Open the same file in a second browser page; save in the first; the second updates without a
   refresh (save-based sync).
3. Open a file, save it, then modify it externally (`printf` append); the viewer reloads while clean.
4. Open a file, type without saving, modify it externally; the viewer must show the "file changed on
   disk" banner and keep the draft. Saving must offer reload/overwrite rather than clobbering.
5. Switch to another file tab and back; the draft is still there.
6. Open a file larger than 256 KiB; **Edit** must not be offered.

## 9. Definition of done

- A text file can be edited and saved from the viewer with CodeMirror 6, on Linux, with no regression
  to Source/Preview/Diff modes, wrapping, line mention, or `@`-mention.
- Saving a file updates every other open viewer of that file (any file kind) without a refresh, purely
  through the existing `fs.watch` + SSE path.
- `PUT` enforces origin check, JSON content type, allowed-root + realpath containment, symlink
  refusal, size cap, NUL rejection, stale-revision `409`, and returns the new revision.
- A dirty buffer is never overwritten by an automatic reload; the conflict path is reachable and
  testable.
- An unsaved draft survives a tab switch and is announced on tab close.
- `npm test`, `node_modules/.bin/tsc --noEmit`, and `npm run lint` all pass, and manual verification
  steps 1–6 above are recorded in `progress` as evidence.
- `docs/adr/0006-file-editor-save-sync.md` records the decision, and `README.md`,
  `LOCAL-CHANGES.md`, and `AGENTS.md` describe the new endpoint, component, and traps.
- No change to `lib/rpc-manager.ts`, `lib/pi-types.ts`, or any other existing fork patch.

## Open questions

None blocking. One deliberate scope decision, recorded here instead of left to an executor:

- CodeMirror highlighting covers only languages with an official `@codemirror/lang-*` package. Bash,
  TOML, Dockerfile, GraphQL, HCL, Kotlin, Swift, Ruby, C# and Makefile open in the editor as plain
  text. Adding `@codemirror/legacy-modes` for those is future work, not this plan.