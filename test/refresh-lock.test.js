import { strictEqual, rejects } from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { withRefreshLock } from "../dist/store.js";

function isolatedLock(t, platform = "win32") {
  const home = fs.mkdtempSync(join(os.tmpdir(), "orla-lock-test-"));
  const previousHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = home;
  const path = join(home, "orla", "refresh.lock");
  const open = fs.openSync;
  t.mock.method(os, "platform", () => platform);
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (previousHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return {
    path,
    inject(callback) {
      t.mock.method(fs, "openSync", (file, ...args) => file === path ? callback(() => open(file, ...args)) : open(file, ...args));
      syncBuiltinESMExports();
    },
  };
}

const denied = (code = "EPERM", syscall = "open") => Object.assign(new Error("injected lock access failure"), { code, syscall });

test("transient Windows lock-open EPERM preserves exclusive acquisition", { timeout: 5000 }, async (t) => {
  const lock = isolatedLock(t);
  let failures = 3;
  lock.inject((open) => {
    if (failures-- > 0) throw denied();
    return open();
  });
  let active = 0;
  let maximum = 0;
  let completed = 0;
  await Promise.all([1, 2].map(() => withRefreshLock(async () => {
    maximum = Math.max(maximum, ++active);
    strictEqual(fs.existsSync(lock.path), true);
    await new Promise((resolve) => setTimeout(resolve, 75));
    --active;
    ++completed;
  })));
  strictEqual(maximum, 1, "work never overlaps after a failed exclusive create");
  strictEqual(completed, 2);
  strictEqual(fs.existsSync(lock.path), false);
});

test("persistent Windows lock-open EPERM terminates and preserves the original error", { timeout: 5000 }, async (t) => {
  const lock = isolatedLock(t);
  const error = denied();
  let attempts = 0;
  let ran = false;
  lock.inject(() => { ++attempts; throw error; });
  await rejects(withRefreshLock(async () => { ran = true; }), (actual) => actual === error);
  strictEqual(ran, false);
  strictEqual(attempts > 1 && attempts <= 21, true, "permission failure has a bounded retry budget");
  strictEqual(fs.existsSync(lock.path), false);
});

for (const [platform, code, syscall] of [["linux", "EPERM", "open"], ["win32", "EACCES", "open"], ["win32", "EPERM", "close"]]) {
  test(`${platform} ${syscall}/${code} outside transient Windows opens fails immediately`, async (t) => {
    const lock = isolatedLock(t, platform);
    const error = denied(code, syscall);
    let attempts = 0;
    lock.inject(() => { ++attempts; throw error; });
    await rejects(withRefreshLock(async () => { throw new Error("must not acquire"); }), (actual) => actual === error);
    strictEqual(attempts, 1);
  });
}
