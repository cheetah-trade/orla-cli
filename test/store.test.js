/**
 * Where the session lives, and that the token never rides in an argument list
 * (review 20.11.2026, P2-3), and how the browser is opened (P2-4).
 *
 * The keychain tools are replaced by fakes on PATH that keep the "keychain" in
 * a file and log every argument list they were started with: a token in argv
 * is a token in `ps -ww` for every process on the machine.
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { browserCommand } from "../dist/auth.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
const KEYCHAIN = platform() === "darwin" || platform() === "linux";

/**
 * A fake `security` (macOS) or `secret-tool` (Linux). `takes: false` plays a
 * keychain that accepts the command and stores nothing.
 */
function fakeKeychain({ takes = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "orla-fake-kc-"));
  const store = join(dir, "store");
  const log = join(dir, "argv.log");
  const script = `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");
const stdin = () => { try { return fs.readFileSync(0, "utf8"); } catch { return ""; } };
const keep = (v) => { if (${takes}) fs.writeFileSync(${JSON.stringify(store)}, v); };
const show = () => { if (!fs.existsSync(${JSON.stringify(store)})) process.exit(44); process.stdout.write(fs.readFileSync(${JSON.stringify(store)}, "utf8")); };
const drop = () => fs.rmSync(${JSON.stringify(store)}, { force: true });
if (${JSON.stringify(platform())} === "darwin") {
  if (argv[0] === "-i") {
    const words = stdin().trim().split(/\\s+/);
    if (words[0] === "add-generic-password") keep(Buffer.from(words[words.indexOf("-X") + 1], "hex").toString("utf8"));
  } else if (argv[0] === "add-generic-password") keep(argv[argv.indexOf("-w") + 1]);
  else if (argv[0] === "find-generic-password") show();
  else if (argv[0] === "delete-generic-password") drop();
} else {
  if (argv[0] === "store") keep(stdin());
  else if (argv[0] === "lookup") show();
  else if (argv[0] === "clear") drop();
}
`;
  const name = platform() === "darwin" ? "security" : "secret-tool";
  writeFileSync(join(dir, name), script);
  chmodSync(join(dir, name), 0o755);
  return {
    PATH: `${dir}${delimiter}${process.env.PATH}`,
    put: (session) => writeFileSync(store, JSON.stringify(session)),
    stored: () => (existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : null),
    argv: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []),
  };
}

async function stubOrla() {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/oauth/token") {
        res.end(JSON.stringify({ access_token: "ACCESS-SECRET-2", refresh_token: "REFRESH-SECRET-2", expires_in: 3600 }));
        return;
      }
      const rpc = JSON.parse(body);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { structuredContent: { data: { user: {}, spaces: [] } } } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { apiBase: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

function orla(args, env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => done({ code, out, err }));
  });
}

const expired = (apiBase) => ({
  apiBase,
  accessToken: "ACCESS-SECRET-1",
  refreshToken: "REFRESH-SECRET-1",
  expiresAt: Date.now() - 1000,
  door: "personal",
});

test("a refresh saves the new session to the keychain without the token in any argument list", { skip: !KEYCHAIN }, async () => {
  const stub = await stubOrla();
  const kc = fakeKeychain();
  kc.put(expired(stub.apiBase));
  const home = mkdtempSync(join(tmpdir(), "orla-cli-"));
  try {
    const { code, err } = await orla(["whoami", "--json"], { ...process.env, PATH: kc.PATH, XDG_CONFIG_HOME: home, ORLA_NO_BROWSER: "1", ORLA_NO_KEYCHAIN: "" });
    strictEqual(code, 0, err);
    strictEqual(kc.stored().refreshToken, "REFRESH-SECRET-2", "the refreshed session is in the keychain");
    const all = JSON.stringify(kc.argv());
    ok(kc.argv().length > 0, "the fake keychain was used");
    ok(!all.includes("SECRET"), `a token rode in argv: ${all}`);
    ok(!all.includes(Buffer.from("REFRESH-SECRET-2").toString("hex")), "nor in hex");
    strictEqual(existsSync(join(home, "orla", "session.json")), false, "no file copy beside the keychain");
  } finally {
    stub.close();
  }
});

test("a keychain that does not take the write falls back to a 0600 file", { skip: !KEYCHAIN }, async () => {
  const stub = await stubOrla();
  const kc = fakeKeychain({ takes: false });
  const home = mkdtempSync(join(tmpdir(), "orla-cli-"));
  mkdirSync(join(home, "orla"), { recursive: true });
  writeFileSync(join(home, "orla", "session.json"), JSON.stringify(expired(stub.apiBase)));
  try {
    const { code, err } = await orla(["whoami", "--json"], { ...process.env, PATH: kc.PATH, XDG_CONFIG_HOME: home, ORLA_NO_BROWSER: "1", ORLA_NO_KEYCHAIN: "" });
    strictEqual(code, 0, err);
    const path = join(home, "orla", "session.json");
    strictEqual(JSON.parse(readFileSync(path, "utf8")).refreshToken, "REFRESH-SECRET-2", "the session was not lost");
    strictEqual(statSync(path).mode & 0o777, 0o600);
    ok(err.includes("no OS keychain here"), "and said so");
  } finally {
    stub.close();
  }
});

test("without a keychain the session file is 0600", { skip: platform() === "win32" }, async () => {
  const stub = await stubOrla();
  const home = mkdtempSync(join(tmpdir(), "orla-cli-"));
  mkdirSync(join(home, "orla"), { recursive: true });
  const path = join(home, "orla", "session.json");
  writeFileSync(path, JSON.stringify(expired(stub.apiBase)), { mode: 0o644 });
  try {
    const { code } = await orla(["whoami", "--json"], { ...process.env, XDG_CONFIG_HOME: home, ORLA_NO_BROWSER: "1", ORLA_NO_KEYCHAIN: "1" });
    strictEqual(code, 0);
    strictEqual(statSync(path).mode & 0o777, 0o600, "rewritten 0600 even over a looser file");
  } finally {
    stub.close();
  }
});

const AUTHORIZE =
  "https://app.orla.finance/api/oauth/authorize?client_id=https%3A%2F%2Forla.finance%2Fmcp-cli.json" +
  "&redirect_uri=http%3A%2F%2F127.0.0.1%3A7654%2Fcallback&response_type=code&state=s&code_challenge=c" +
  "&code_challenge_method=S256&scope=orla.read+orla.write";

test("on Windows the whole authorize URL reaches the URL handler as one argument, with no shell", () => {
  const { cmd, args } = browserCommand(AUTHORIZE, "win32");
  strictEqual(cmd, "rundll32");
  deepStrictEqual(args, ["url.dll,FileProtocolHandler", AUTHORIZE]);
  ok(!args.some((a) => a !== AUTHORIZE && a.includes("&")), "no part of the URL is split off");
});

test("macOS and Linux open the URL with their own handler", () => {
  deepStrictEqual(browserCommand(AUTHORIZE, "darwin"), { cmd: "open", args: [AUTHORIZE] });
  deepStrictEqual(browserCommand(AUTHORIZE, "linux"), { cmd: "xdg-open", args: [AUTHORIZE] });
});
