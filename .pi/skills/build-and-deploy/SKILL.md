---
name: build-and-deploy
description: Build this pi-web fork and deploy it to GitHub with the fork version bump. Use when asked to "build and deploy", "deploy pi-web", "release the fork", "bump the fork version and push", or to ship the commits made since the last deployment.
compatibility: Node.js 22.19.0 or newer; a git checkout of alfahluzi/pi-web on the custom branch, with remotes origin (the fork) and upstream (agegr/pi-web).
metadata:
  repo: alfahluzi/pi-web
  branch: custom
  version-format: <original-repo-version>-<a>.<b>
---

# Build and deploy

Ship this fork's commits to GitHub in ordered steps: what is undeployed, the
version this deploy gets, the build, the release commit, the push. A failed step
stops the flow: nothing is pushed and the version change is reverted.

The version is `<original-repo-version>-<a>.<b>`. The base is upstream's release
version; `a` counts deploys that contain a breaking change, `b` counts those that
do not. From an upstream base of `0.17.0`: `0.17.0-0.0` on the first deploy,
`0.17.0-0.1` on the next one without a breaking change, `0.17.0-1.0` on the next
one with one.

## 1. Preconditions

Run these first and refuse — with the reason — instead of working around them:

```bash
git rev-parse --show-toplevel                 # this fork's checkout
git rev-parse --abbrev-ref HEAD               # must be custom
git status --porcelain -uno                   # must print nothing
git status --porcelain                        # untracked files: inspect, see below
git remote get-url origin                     # must be alfahluzi/pi-web, never agegr/pi-web
lsof -nP -iTCP:30141 -sTCP:LISTEN             # must print nothing
```

- Modified or staged tracked files: stop and ask the user to commit them. The
  release commit holds the version bump only.
- Untracked files are listed but do not block: scratch artifacts such as `.ppm/`
  backups or `.sangkar/` notes are not pushed. If an untracked file is source
  that belongs to this deploy, stop and ask the user to commit it first.
- Branch is `custom-next` (the rebase branch) or a detached HEAD: stop. `custom`
  is what this fork deploys.
- A dev server on 30141: stop that exact process (`kill <pid>`) and say so. Never
  start a second dev server, and never build while one runs — both write `.next/`
  and the development server loses its graph.

## 2. Commits since the last deployment

A pushed `origin/custom` is the deployment record, so this range is exactly what
GitHub does not have yet:

```bash
git fetch origin --prune --tags
git fetch upstream --prune --tags
git log --oneline origin/custom..HEAD
```

Show the list to the user. An empty list means nothing to deploy: report that and
stop, after checking a previous run left no release commit or tag behind
(`git tag --points-at HEAD`, `git ls-remote --tags origin`).

## 3. Decide the version

```bash
node -p "require('./package.json').version"                     # current fork version
git show upstream/main:package.json | grep -m1 '"version"'      # upstream base version
```

Read the counters off the current version:

| Current version | base | a | b |
| --- | --- | --- | --- |
| `0.17.0-1.2` | `0.17.0` | 1 | 2 |
| `0.17.0` (no counters yet, e.g. right after an upstream merge) | `0.17.0` | 0 | 0 |

If the base differs from upstream's version, an upstream release landed since the
last deploy: start a new epoch, `a = 0`, `b = 0`, and say so in the report.

One bump per deployment, not per commit. A breaking change is a commit whose
subject is `<type>!:` or `<type>(scope)!:`, or whose body carries a
`BREAKING CHANGE:` or `BREAKING-CHANGE:` footer:

```bash
git log --format=%s%n%b origin/custom..HEAD | grep -qE '^[a-z]+(\([^)]*\))?!:|^BREAKING[ -]CHANGE:' && echo major || echo minor
```

- `major`: `a + 1`, and `b` restarts at `0`.
- `minor`: `b + 1`, `a` unchanged.

Keep the deciding commit (or the fact that none was breaking) for the report.

## 4. Write the version

```bash
npm version "<base>-<a>.<b>" --no-git-tag-version
node -p "[require('./package.json').version, require('./package-lock.json').version].join(' ')"
```

`npm version --no-git-tag-version` writes package.json and the lockfile's root
version and creates no commit or tag; the two printed versions must match. Do not
hand-edit the JSON files, and do not switch to a format such as `0.17.0.1-0`: npm
rejects a package version that is not semver, which is why the counters sit after
a prerelease hyphen.

## 5. Checks and build

All four must pass:

```bash
node_modules/.bin/tsc --noEmit
npm run lint
npm test
npm run build
```

Stop at the first failure and report the command with its first error lines;
revert the version first with `git checkout -- package.json package-lock.json`.
The build must also leave `.next/BUILD_ID` behind; without it the build did not
finish.

`npm run lint` also walks leftover `.next*` build backups in the checkout (eslint
reads its own ignores, not `.gitignore`). Failures that only name files inside
such a directory are checkout litter, not this deploy's code: ask the user to
remove or move that directory aside and rerun. Do not change the lint config as
part of a deploy.

The bump comes before the build on purpose: `next.config.ts` inlines
`NEXT_PUBLIC_APP_VERSION` from package.json, and `app/api/app-update/route.ts`
reports that value, so a build made before the bump would ship the previous
version.

## 6. Release commit, tag, push

```bash
git add package.json package-lock.json
git commit -m "chore(release): v<version>"
git tag -a "v<version>" -m "v<version>"
git push origin custom
git push origin "v<version>"
```

Then verify the deploy:

```bash
git rev-parse --short HEAD origin/custom
git ls-remote --tags origin "v<version>"
```

HEAD and `origin/custom` must be the same commit, and the tag must be listed.
Never force-push, never push to `upstream`, and never `git push --tags` — that
would publish every upstream tag this clone has fetched.

## 7. Report

State the commits deployed, major or minor with the commit that decided it (or
that none was breaking), the old → new version, the outcome of the four checks,
and the pushed branch and tag with their commit hashes.

## Notes

- The `v*` tag also matches upstream's `.github/workflows/publish.yml`, which
  tries to publish `@agegr/pi-web` to npm and an image to GHCR. Those publish
  permissions belong to agegr's repositories, so that run fails. It is expected
  and says nothing about the deploy: the deploy is done when the branch and tag
  are on GitHub. To avoid the red runs, rename the tag to `fork-v<version>` or
  narrow that workflow's trigger in this fork.
- `pi-web update`, `pi-web update --check` and the UI's update check accept only
  strict `X.Y.Z`, so they never offer upgrades for `<base>-<a>.<b>`. Updating a
  checkout of this fork is `git pull` + `npm ci` + `npm run build`.
- `./deploy-to-pi-web.sh` promotes a finished build to the local PM2 app. It is a
  separate, machine-local deployment and not part of this flow.
