import { strictEqual, rejects, throws } from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { spawn } from "node:child_process";
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

// Exercise the actual Windows delete-pending error, not just a mocked errno.
test("Windows delete-pending lock retries until the final handle closes", { skip: process.platform !== "win32", timeout: 30000 }, async (t) => {
  const lock = isolatedLock(t);
  fs.mkdirSync(join(process.env.XDG_CONFIG_HOME, "orla"), { recursive: true });
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PendingLock {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool DeleteFileW(string path);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);
}
'@
$handle = [PendingLock]::CreateFileW($env:ORLA_TEST_LOCK, [uint32]2147483648, 7, [IntPtr]::Zero, 2, 0x80, [IntPtr]::Zero)
if ($handle -eq [IntPtr](-1)) { throw 'CreateFileW failed' }
try {
  if (-not [PendingLock]::DeleteFileW($env:ORLA_TEST_LOCK)) { throw 'DeleteFileW failed' }
  [Console]::Out.WriteLine('pending')
  [Console]::Out.Flush()
  [Console]::ReadLine() | Out-Null
} finally {
  [PendingLock]::CloseHandle($handle) | Out-Null
}
`;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, ORLA_TEST_LOCK: lock.path },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let output = "";
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`delete-pending fixture exited ${code}: ${errors}`)));
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("pending")) resolve();
    });
  });
  throws(() => fs.openSync(lock.path, "wx", 0o600), (err) => err.code === "EPERM" && err.syscall === "open");
  const acquired = withRefreshLock(async () => "acquired");
  const release = setTimeout(() => child.stdin.end("release\n"), 150);
  t.after(() => clearTimeout(release));
  strictEqual(await acquired, "acquired");
  strictEqual(fs.existsSync(lock.path), false);
});
