import assert from "node:assert/strict";
import { readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./sudo-prompt.ts");
}

test("detects sudo invocations in command position", async () => {
  const { commandNeedsSudo } = await loadSubject();
  const detected = [
    "sudo apt-get install -y foo",
    "cd /tmp && sudo systemctl restart nginx",
    "FOO=1 sudo id -u",
    "env LANG=C sudo id -u",
    "command sudo -n true",
    "( sudo id -u )",
    "$(sudo id -u)",
    "echo start\nsudo reboot",
    "if true; then sudo id -u; fi",
    "cat file | sudo tee /etc/hosts",
    "sudo",
  ];
  for (const command of detected) {
    assert.equal(commandNeedsSudo(command), true, command);
  }

  const ignored = [
    "echo hello",
    'echo "run sudo later"',
    "printf '%s' 'sudo id'",
    "# sudo id -u",
    "grep -rn sudo docs/",
    "man sudo",
    "sudoku --start",
    "npm run sudo-wrapper",
    "echo $(cat notes.md) # sudo nothing",
    // An absolute path bypasses the `sudo` shell function, so prompting here
    // would only write the password for a command that still fails.
    "/usr/bin/sudo id -u",
    "/usr/bin/sudo -n true",
  ];
  for (const command of ignored) {
    assert.equal(commandNeedsSudo(command), false, command);
  }
});

test("keeps a command preview readable and bounded", async () => {
  const { sudoCommandPreview } = await loadSubject();
  assert.equal(sudoCommandPreview("  sudo id -u \n"), "sudo id -u");
  const long = `sudo ${"x".repeat(1000)}`;
  const preview = sudoCommandPreview(long);
  assert.equal(preview.length, 601);
  assert.ok(preview.endsWith("…"));
});

test("writes a private askpass helper and removes it on dispose", async () => {
  const { createSudoAskpass, askpassScriptText, sudoShellPrefix } = await loadSubject();
  const askpass = createSudoAskpass("p@ss'word\nwith specials");
  try {
    assert.equal(statSync(askpass.dir).mode & 0o777, 0o700);
    const secretPath = join(askpass.dir, "password");
    assert.equal(statSync(secretPath).mode & 0o777, 0o600);
    assert.equal(statSync(askpass.scriptPath).mode & 0o777, 0o700);
    assert.equal(readFileSync(askpass.scriptPath, "utf8"), askpassScriptText(secretPath));
    assert.equal(readFileSync(secretPath, "utf8"), "p@ss'word\nwith specials\n");

    const prefix = sudoShellPrefix(askpass.scriptPath);
    assert.match(prefix, /^sudo\(\) \{ SUDO_ASKPASS=/);
    assert.ok(prefix.includes("-A"));
    assert.ok(!prefix.includes("p@ss"));
  } finally {
    askpass.dispose();
  }
  assert.equal(existsSync(askpass.dir), false);
});

test("the askpass helper prints the password once and then removes it", async () => {
  const { createSudoAskpass } = await loadSubject();
  const askpass = createSudoAskpass("pw 'quoted' $HOME");
  try {
    const secretPath = join(askpass.dir, "password");
    const { execFileSync } = await import("node:child_process");
    assert.equal(execFileSync("sh", [askpass.scriptPath], { encoding: "utf8" }), "pw 'quoted' $HOME\n");
    // Read-then-unlink: a second prompt finds nothing rather than a file that
    // lingers for the whole command.
    assert.equal(existsSync(secretPath), false);
    assert.throws(() => execFileSync("sh", [askpass.scriptPath], { encoding: "utf8", stdio: "pipe" }));
  } finally {
    askpass.dispose();
  }
});

test("escapes single quotes in shell-quoted paths", async () => {
  const { askpassScriptText, sudoShellPrefix } = await loadSubject();
  const script = askpassScriptText("/tmp/it's here/password");
  assert.ok(script.startsWith("#!/bin/sh\n"));
  assert.equal(script.match(/'\/tmp\/it'\\''s here\/password'/g)?.length, 2);
  assert.ok(sudoShellPrefix("'/tmp/it's").includes("'\\''"));
});

test("caches the password for its ttl and forgets it afterwards", async () => {
  const { SudoPasswordCache, SUDO_PASSWORD_TTL_MS } = await loadSubject();
  let now = 1_000;
  const cache = new SudoPasswordCache(SUDO_PASSWORD_TTL_MS, () => now);

  assert.equal(cache.peek(), undefined);
  cache.remember("secret");
  assert.equal(cache.peek(), "secret");

  now += SUDO_PASSWORD_TTL_MS - 1;
  assert.equal(cache.peek(), "secret");

  now += 1;
  assert.equal(cache.peek(), undefined);

  cache.remember("again");
  cache.clear();
  assert.equal(cache.peek(), undefined);

  cache.remember("");
  assert.equal(cache.peek(), undefined);
});

test("recognizes sudo's authentication failures", async () => {
  const { SUDO_AUTH_FAILURE_PATTERN } = await loadSubject();
  for (const output of [
    "sudo: Authentication failed, try again.",
    "Sorry, try again.",
    "sudo: no password was provided",
    "sudo: 3 incorrect password attempts",
  ]) {
    assert.equal(SUDO_AUTH_FAILURE_PATTERN.test(output), true, output);
  }
  assert.equal(SUDO_AUTH_FAILURE_PATTERN.test("sudo: a terminal is required"), false);
  assert.equal(SUDO_AUTH_FAILURE_PATTERN.test("Reading package lists... Done"), false);
});
