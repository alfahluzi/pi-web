# 0007 — Sudo passwords are asked for in the browser and handed to an askpass helper

## Status

Accepted.

## Context

Pi runs a tool's shell command without a terminal. `sudo` therefore cannot
prompt: it fails immediately with `a terminal is required to authenticate`
(classic sudo) or `interactive authentication is required` (sudo-rs, which
Ubuntu 26.04 ships). Both were verified on the target machine before this
change, and the second one decides the whole design — sudo-rs ignores
`SUDO_ASKPASS` unless `-A` is on the command line, so an environment variable
alone is not enough.

The operator asked for a way to supply the password from the Pi Web UI without
the model ever seeing it. Three properties follow from that request and shape
the implementation:

1. The value must not enter the conversation. It cannot be a tool result, a
   `details` payload, a system message, or a log line the model can read.
2. It must not be reachable from the command itself: not in the command text,
   not in `ps` output, not in the environment of the process sudo starts.
3. Declining must not break the run. The command still has to behave the way it
   did before this feature existed.

Pi Web already replaced the `bash` tool with an inline extension
(`lib/project-command-env.ts`) to give project commands a sanitized environment,
and it already had a prompt/response channel for extension dialogs
(`extension_ui_request` → `extension_ui_input`) whose answers never reach the
transcript. Both are reused rather than inventing a second pathway.

## Decision

**Intercept in the bash tool, not in the shell text.** The inline extension owns
the tool definition, so it can ask for a password before spawning anything and
compose the command prefix for that one execution. No shell parsing of a command
we do not understand, no rewriting of `sudo` call sites.

**Prompt through the wrapper, not through `ctx.ui`.** `ctx.ui.input()` would
work, but its SDK signature has no way to say "this value is a secret", and pi-web
needs the dialog to carry the command being authorized. `AgentSessionWrapper`
therefore owns `requestSudoPassword()` and emits the request itself with
`secret: true` and a `command` preview on the existing `input` method. The
browser renders a masked field, and the value travels the ordinary response
path.

**The password reaches sudo through an askpass helper.** For a command that
invokes sudo, the extension writes `askpass.sh` (0700) and `password` (0600) into
a `mkdtemp` directory under the temp root, and prepends a `sudo() { SUDO_ASKPASS=…
command sudo -A "$@"; }` shell function to that one command. `export -f` covers
`bash -c` children; dash simply ignores it. The helper reads the password and
**unlinks the file**, so the plaintext survives only until sudo's first prompt;
`dispose()` and a `process.once("exit")` sweep remove the directory if neither
the tool call nor the process finishes normally.

The alternatives were rejected for concrete reasons:

- `sudo -S` with the password on stdin needs control of the spawned stdin. Pi's
  local shell operations set `stdio: ["ignore", …]`, and only the
  `commandTransport: "stdin"` shell mode uses a pipe — reimplementing the spawn
  would duplicate pi's timeout, abort, and process-tree handling.
- `exec 3<<EOF` inside the command puts the password where `ps` can see it,
  because the whole script becomes the shell's argv.
- Pre-authenticating with `sudo -v` relies on sudo's timestamp record being
  shared between two separate shells. It is keyed by tty (absent here) or by
  parent pid (different per spawn), so it silently fails.

**An answered password is cached in memory for five minutes.** Sudo's own cache
is keyed the same way its timestamp record is, so consecutive tool calls each
prompt again. The cache lives on the wrapper, is never persisted, and is cleared
on `destroy()` (idle unload, fork, server restart).

A wrong password must not be reused for the whole window, so the operations
wrapper keeps the last 4 KiB of output and clears the cache when it matches
`SUDO_AUTH_FAILURE_PATTERN` (`Authentication failed`, `Sorry, try again.`, …).
sudo asks three times before it gives up; only then does the message appear, so
the check runs after the command, not during it.

**Declining is not an error.** Cancel, timeout (3 minutes), abort, an empty
answer, or a dead wrapper all resolve `undefined`; the command then runs exactly
as it would have without this feature. Throwing would turn a declined dialog
into a tool error the model has to interpret, and `isRunning()` already keeps the
wrapper — and therefore the pending dialog — alive while the prompt is open.
A call queued behind an open dialog also races its own `AbortSignal`, so Stop
reaches it immediately instead of after the dialog ahead of it.

Parallel bash calls share one dialog through a promise chain on the wrapper: two
stacked password boxes would be indistinguishable, and the second answer would be
useless.

## Consequences

- Only pi-web's built-in bash tool has this. A user extension that replaces
  `bash` wins over it (`preferUserBashExtension`), and sub-agent sessions load
  neither, so they keep the plain "terminal required" failure. That is the same
  boundary the sanitized command environment already has.
- Only `sudo` reached as a bare command word is covered. `/usr/bin/sudo …`
  bypasses the shell function, so `commandNeedsSudo` deliberately does not treat
  it as an invocation — prompting there would write the password for a run that
  still fails. `xargs sudo`, `sh -c 'sudo …'`, and `eval` are missed for the same
  reason (the scan strips quotes rather than parsing them); they keep the old
  "a terminal is required" failure. Heredoc bodies are false positives: they cost
  one cancelled prompt.
- Anything running as the same user can read the password file during the short
  window before sudo's first prompt, and that includes a shell command the model
  chose to run (for example scanning the temp root mid-run). The 0700/0600 modes
  only exclude *other* users, and closing that gap would require an OS-level
  channel — a socket or pipe gated on peer credentials — which Node does not
  expose without native code. What this design does guarantee is that the value
  never reaches the model through its own transcript, tool results, argv,
  environment, logs, or notifications, which is the attack surface the feature
  exists to remove.
- The value is submitted to the pi-web server in an HTTP body, exactly like
  `POST /api/web-auth`. Loopback binds keep it on the machine; this deployment
  also serves a hostname through a reverse proxy, where the password is only as
  protected as that transport (TLS) — the same trust the web-login password
  already relies on.

## Verification

`lib/sudo-prompt.test.mjs` covers detection (including that an absolute
`/usr/bin/sudo` is *not* intercepted), quoting, the private file modes, the
read-then-unlink helper, cleanup, and the TTL cache.
`lib/project-command-env.test.mjs` proves the prefix is only applied when a
password was supplied and that an authentication failure clears the cache.
`lib/sudo-password-prompt.test.mjs` covers the wrapper: one dialog for parallel
calls, cancel/abort/empty answers, Stop reaching a queued call, forget-on-
rejection, and cache clearing on `destroy()`.

End-to-end, on this machine: the prompt rendered with `type="password"`; a
wrong password produced sudo-rs's three attempts and
`maximum 3 incorrect authentication attempts`; the next sudo command prompted
again (cache cleared); cancelling ran the command unchanged and it failed with
`sudo: A terminal is required to authenticate`; and the submitted value appeared
nowhere in the SSE stream, the server log, or the session `.jsonl`.
