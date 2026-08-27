/**
 * Where the token lives between commands.
 *
 * The OS keychain first, because a refresh token is a live credential to
 * somebody's books and a dotfile is readable by every process this user runs.
 * `security` on macOS and `secret-tool` on Linux are already installed on the
 * machines that have a keychain worth using, so this needs no native module —
 * which also means `npx orla` never asks anyone to compile anything.
 *
 * The fallback is a 0600 file, and it says so out loud on first write rather
 * than silently downgrading: a person on a headless box should know their
 * refresh token is on disk.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

const SERVICE = "orla-cli";
const ACCOUNT = "default";

export type Session = {
  /** Where this session was minted. Stored so a token from staging cannot be replayed against production by a changed flag. */
  apiBase: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch millis. Refreshed a minute early rather than on the failure. */
  expiresAt: number;
  /** What `orla` uses when a command names no space. */
  defaultSpaceId?: string;
};

function filePath(): string {
  const base =
    process.env.XDG_CONFIG_HOME ?? join(homedir(), platform() === "darwin" ? "Library/Application Support" : ".config");
  return join(base, "orla", "session.json");
}

function keychainRead(): string | null {
  try {
    if (platform() === "darwin") {
      return execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    }
    if (platform() === "linux") {
      const out = execFileSync("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return out || null;
    }
  } catch {
    return null;
  }
  return null;
}

function keychainWrite(value: string): boolean {
  try {
    if (platform() === "darwin") {
      execFileSync("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w", value], {
        stdio: "ignore",
      });
      return true;
    }
    if (platform() === "linux") {
      execFileSync("secret-tool", ["store", "--label=Orla CLI", "service", SERVICE, "account", ACCOUNT], {
        input: value,
        stdio: ["pipe", "ignore", "ignore"],
      });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function keychainClear(): void {
  try {
    if (platform() === "darwin") {
      execFileSync("security", ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT], { stdio: "ignore" });
    } else if (platform() === "linux") {
      execFileSync("secret-tool", ["clear", "service", SERVICE, "account", ACCOUNT], { stdio: "ignore" });
    }
  } catch {
    // nothing stored, which is the state we wanted anyway
  }
}

export function load(): Session | null {
  const raw = keychainRead() ?? readFileOrNull(filePath());
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function save(session: Session): void {
  const raw = JSON.stringify(session);
  if (keychainWrite(raw)) return;
  const path = filePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, raw, { mode: 0o600 });
  chmodSync(path, 0o600);
  process.stderr.write(`orla: no OS keychain here, the session is in ${path} (0600)\n`);
}

export function clear(): void {
  keychainClear();
  try {
    rmSync(filePath());
  } catch {
    // already gone
  }
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
