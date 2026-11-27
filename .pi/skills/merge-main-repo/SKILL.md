---
name: merge-main-repo
description: Merge the upstream pi-web release into this fork's custom branch. Use when asked to "merge main repo", "merge repo asli", "sync ke upstream", "update dari repo asli", "merge upstream", "catch up with upstream", or when the fork must take a new upstream version.
compatibility: Node.js 22.19.0 or newer; a git checkout of alfahluzi/pi-web on the custom branch, with remotes origin (the fork) and upstream (agegr/pi-web).
metadata:
  repo: alfahluzi/pi-web
  branch: custom
  merge-target: upstream/main
  last-verified-merge: 0.17.0 (98 upstream commits, 14 conflicted files, 20 hunks)
---

# Merge main repo

Bring upstream (agegr/pi-web) into this fork without losing fork features. The
fork keeps its own features on top of upstream: a merge must end with **both**
sides' work present, and with a written record of every decision so the next
merge is cheaper than this one.

Order matters: preconditions, a safety point, the gap, a dry run, the merge,
resolution by class, dependencies, checks, then the release hand-off.

## 1. Preconditions

Refuse — with the reason — instead of working around any of these:

```bash
git rev-parse --abbrev-ref HEAD     # must be custom
git status --porcelain -uno         # must print nothing
git status --porcelain              # untracked: inspect, see below
git remote -v                       # origin=alfahluzi/pi-web, upstream=agegr/pi-web
lsof -nP -iTCP:30141 -sTCP:LISTEN   # a dev server: stop it; never build while it runs
```

- Modified or staged tracked files: stop and ask the user to commit them first
  (that is a separate commit, never part of the merge).
- Untracked `.ppm/**/tasks.bak-*`, `plan.md.bak-*`, `.sangkar/`, screenshots are
  scratch: leave them untracked. This repo commits `plan.md`, `schema.md`,
  `tasks/*.json` only.
- A merge needs a clean tree **before** it starts; after `git merge` the tree is
  not clean until every conflict is resolved.

## 2. Safety point

```bash
HEAD_SHA=$(git rev-parse --short HEAD)
git branch -f "safety/pre-upstream-$(git show upstream/main:package.json | grep -m1 '"version"' | grep -oE '[0-9.]+')" "$HEAD_SHA"
```

A branch, not a tag: `git fetch --prune --tags` can move or drop tags. Report the
branch name to the user. `git merge --abort` is the first rollback (it restores
the pre-merge tree exactly); `git reset --hard safety/...` only when the abort is
no longer possible, and only after telling the user what it discards.

## 3. Fetch and size the gap

```bash
git fetch upstream --prune --tags
git rev-list --count HEAD..upstream/main      # commits coming in
git rev-list --count upstream/main..HEAD      # fork-only commits
git log --oneline HEAD..upstream/main | head -40
git show upstream/main:package.json | grep -m1 '"version"'
git tag --sort=-v:refname | head -3
```

Merge `upstream/main`, not the tag: it carries the fixes landed after the last
release. Name what was merged in the commit subject ("Merge upstream 0.17.0 into
fork ...") and the count in the body.

## 4. Dry run: predict every conflict

`git merge-tree` writes nothing and needs no worktree:

```bash
git merge-tree --write-tree HEAD upstream/main > /tmp/mt.txt; echo "exit=$?"
grep '^CONFLICT' /tmp/mt.txt
```

Exit 1 means conflicts; the first line is the merged tree id. Read the list to
the user **before** merging if the gap is large, so nobody is surprised by 14
files. (This repo's 0.15.0 -> 0.17.0 merge: 98 commits, 283 files, 14 conflicted
files, 20 hunks.)

## 5. Merge

```bash
git merge --no-ff --no-edit upstream/main
```

Then classify every conflicted file before editing anything. Three classes, and
they need different treatment:

1. **Additive-both** — the two sides added different things at the same anchor
   (imports, fields, constructor assignments, test blocks, a props signature).
   Keep both. This is mechanical.
2. **Semantic** — one side refactored code the other extended. Never take a side
   blindly; read both and keep both behaviours.
3. **Version/docs** — `package.json`, `package-lock.json`, `AGENTS.md`,
   `README.md`. Follow step 7 and step 8, not intuition.

## 6. Resolving: recipes that are not obvious

**The shared closing line.** When both sides appended a block at the end of a
file, git merges the middle and leaves the *shared* trailing `});` once. The
merged file interleaves both blocks, so reconstruct as: ours, one `});`, blank
line, theirs — the original trailing line then closes theirs.

**Never rewrite these files with `str.splitlines()`.** Several files carry a
literal U+2028 (line separator) inside a string, e.g.
`lib/session-ui-state-shared.test.mjs` (`"a<U+2028>b"`). Python's `splitlines()`
splits on U+2028, so the round trip turns it into a real newline and the file
becomes a syntax error. Use `split("\n")` or the edit tool.

**`lib/rpc-manager.ts` `destroy()`.** Upstream refactored generic UI cancel into
`cancelExtensionUi()`, which knows only `pendingUiResponses` and
`activeCustomUis`. Keep `this.cancelExtensionUi()` **and** the fork's native
`ask_user_question` tables (`activeQuestionnaires`, `pendingQuestionnaire`), or a
destroyed session leaves questionnaire dialogs hanging.

**`components/ChatWindow.tsx` input dialog.** The fork's sudo UI (`request.command`
preview, `type={request.secret ? "password" : "text"}`, `chat.extensionSecretNote`)
must stay, and so must upstream's IME guard
(`e.nativeEvent.keyCode !== 229`) on Enter. Losing the first drops the sudo
prompt; losing the second regresses CJK input.

**`components/FileViewer.tsx`.** Keep the fork's `edit` mode
(`<FileEditor value={editorValue} .../>` branch first) and use upstream's
`MemoizedDiffView` with `language`/`prismReady`/`isDark` for the diff branch.
The watch effect's dependency list is the union:
`[applyDiskContent, filePath, fetchContent, fetchGitDiff, sourceSessionId, watchEnabled, watchAttempt, superviseWatch]`.

**Feature inventory after resolving.** Grep for the fork's features and for
upstream's newest ones; every name must still appear. Update the lists below when
a merge teaches you a new one:

```bash
# fork-only: must still exist
grep -rln 'cacheMonitor\|request.secret\|rekeySessionUiProjects\|FileEditor\|WebPanelIcon\|getToolTiming\|activeQuestionnaires\|createSudoAskpass' lib components hooks app
# upstream-new in 0.17.0: must exist too
grep -rln 'onSelectSideChat\|useHorizontalStrip\|toolClocks\|watchAttempt\|invalidateSessionManagerCache\|MemoizedDiffView' lib components hooks
```

`tsc` catches a dropped symbol; it does **not** catch a dropped behaviour (a
resolution where you kept upstream's version of a block the fork had extended).
That is what this grep and a read of the final diff are for.

## 7. Dependencies

- `package.json`: take upstream's exact `@earendil-works/pi-*` pins, keep the
  fork's own dependencies (the CodeMirror block). Every pi package must stay
  pinned to one exact version (`lib/pi-packages.test.mjs` enforces it).
- `package-lock.json`: do not hand-merge. `git checkout --theirs package-lock.json`
  then let npm write it.
- **`NODE_ENV=production` in the shell makes `npm install` prune devDependencies**
  and deletes `node_modules/.bin/tsc` and eslint. Install with
  `NODE_ENV=development npm install --include=dev`, and check
  `node -p "require('./node_modules/@earendil-works/pi-coding-agent/package.json').version"`
  matches the new package.json.
- A stale node_modules can also fake a failure: under 1.5.0,
  `lib/project-command-env.test.mjs` died with
  `ERR_PACKAGE_PATH_NOT_EXPORTED` from jiti because that version's export map has
  no `require` path. It passed unchanged once 1.5.2 was installed.

## 8. Docs policy

- `AGENTS.md`: the fork's version wins — `git checkout --ours AGENTS.md`. It
  carries the file map the fork works from; upstream's rewrite drops it.
  Afterwards, note which new upstream files the map does not cover yet.
- `README.md`: upstream's version wins — `git checkout --theirs README.md`.
- Both decisions are the user's standing policy; ask before changing them.

## 9. Verification

```bash
node_modules/.bin/tsc --noEmit
node_modules/.bin/eslint <every resolved file>          # targeted, not `npm run lint`
env -u PI_WEB_PASSWORD -u NODE_ENV npm test              # expect 0 fail
```

- A whole-repo `npm run lint` exceeded 15 minutes in this checkout (and walks
  leftover `.next*` backups): lint the resolved files instead.
- **`PI_WEB_PASSWORD` set in the shell fails `lib/web-auth.test.mjs`**, and
  `NODE_ENV=production` changes other defaults. Unset both for the run.
- `lib/mcp-test.test.mjs`'s npmrc test can time out at 10 s only under full
  parallel load; rerun that file alone before calling it a regression.
- Two skips are normal: the Windows junction test and the PowerShell test (no
  PowerShell executable on Linux).
- For an unexpected failure, prove the baseline instead of guessing:
  `git show safety/<branch>:<path> > lib/zz-baseline.test.mjs`, run it, delete it.

## 10. Commit and hand off

```bash
git add -A && git commit -F - <<'EOF'
Merge upstream <version> into fork (resolution: fork features kept alongside upstream's)

<count> upstream commits, <old> -> <new>. <n> files changed; <k> files conflicted
and were resolved as follows.

Additive (both sides kept): <file: what each side added>
Semantic: <file: the decision and why>
Version: pi <new pins>, fork-only dependencies kept, lock regenerated by npm install
Docs: AGENTS.md fork, README.md upstream

Checks: tsc --noEmit; npm test <n> tests / <pass> pass / 0 fail / <skips> skipped
(PI_WEB_PASSWORD unset); targeted ESLint clean.
EOF
git push origin custom
```

Then the release is the `build-and-deploy` skill's job. A merge that changes the
upstream base restarts the version epoch: after merging 0.17.0 the version is
`0.17.0-0.0`, whatever the previous counters were.

## Notes

- Merge in place, once. Resolve in a second worktree only if the user asks: it
  splits the verification and doubles the paths in every command.
- An upstream that is many releases ahead takes one merge per release, not a
  chain: land `upstream/main`, verify, release, then repeat. Smaller merges have
  smaller conflict sets and a clear rollback point each.
- Read every `docs/agents/*.md` a conflicted file belongs to before resolving it;
  the notes say which features are load-bearing (e.g. the questionnaire path in
  `docs/agents/sessions.md`).
- Do not re-derive decisions this skill already records. If a resolution here
  turns out wrong, fix this file in the same change.
