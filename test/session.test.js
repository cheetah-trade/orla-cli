/**
 * A session's two ways to die, and what the CLI does about each.
 *
 * Orla rotates the refresh token on every use and treats one presented twice
 * as stolen: the whole connection ends (RFC 9700 reuse detection). So two
 * refreshes of the same expired token, from two `orla` processes or from the
 * parallel calls of one `orla export`, sign the person out. The refresh runs
 * under a lock file, and whoever waited reads the winner's tokens.
 *
 * And a session that is refused for good (revoked in the app, the chain ended)
 * must not strand the bridge: Claude Desktop has no terminal for `orla login`,
 * so the bridge forgets the dead session and runs the browser sign-in again.
 *
 * The stub below keeps Orla's rules: a used refresh token is `invalid_grant`
 * and ends every token of the connection.
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
const SPACE = "11111111-1111-1111-1111-111111111111";

/** Orla's token endpoint with rotation and reuse detection, and an MCP door that checks the token. */
async function stubOrla({ refuseRefresh = false } = {}) {
  const seen = { grants: [], reuse: 0, mcp: [] };
  const live = new Set(); // access tokens Orla still honours
  const unused = new Set(["rt-0"]); // refresh tokens not yet spent
  let minted = 0;
  const mint = () => {
    minted += 1;
    live.add(`at-${minted}`);
    unused.add(`rt-${minted}`);
    return { access_token: `at-${minted}`, refresh_token: `rt-${minted}`, expires_in: 3600 };
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status, value) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.url === "/oauth/token") {
        const grant = Object.fromEntries(new URLSearchParams(body));
        seen.grants.push(grant);
        if (grant.grant_type === "authorization_code") return send(200, mint());
        // A pause, so two refreshes that are going to overlap do overlap.
        setTimeout(() => {
          if (refuseRefresh) return send(400, { error: "invalid_grant", error_description: "Refresh token is not usable" });
          if (!unused.delete(grant.refresh_token)) {
            seen.reuse += 1;
            live.clear();
            unused.clear();
            return send(400, { error: "invalid_grant", error_description: "Refresh token was already used" });
          }
          send(200, mint());
        }, 150);
        return;
      }
      if (req.url === "/mcp/personal") {
        const rpc = JSON.parse(body);
        const token = (req.headers.authorization ?? "").replace("Bearer ", "");
        seen.mcp.push({ method: rpc.method, token });
        if (!live.has(token)) return send(401, { error: "invalid_token" });
        if (rpc.method === "tools/list") return send(200, { jsonrpc: "2.0", id: rpc.id, result: { tools: [{ name: "orla_whoami" }] } });
        const name = rpc.params?.name;
        const data =
          name === "orla_list_transactions"
            ? { items: [{ occurred_on: "2026-03-28", signed_amount: "-1.00", account_id: "a" }], total: 1, limit: 200, offset: 0 }
            : name === "orla_list_accounts"
              ? { accounts: [{ id: "a", name: "Card" }] }
              : { categories: [] };
        return send(200, { jsonrpc: "2.0", id: rpc.id, result: { structuredContent: { data } } });
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { apiBase: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

/** A config home holding a session whose access token has already expired. */
function expiredHome(apiBase) {
  const home = mkdtempSync(join(tmpdir(), "orla-session-"));
  mkdirSync(join(home, "orla"), { recursive: true });
  writeFileSync(
    join(home, "orla", "session.json"),
    JSON.stringify({
      apiBase,
      door: "personal",
      accessToken: "at-0",
      refreshToken: "rt-0",
      expiresAt: Date.now() - 1000,
      defaultSpaceId: SPACE,
    }),
  );
  return home;
}

const env = (home) => ({ ...process.env, ORLA_NO_KEYCHAIN: "1", ORLA_NO_BROWSER: "1", XDG_CONFIG_HOME: home });

function run(args, home) {
  return new Promise((done) => {
    execFile(process.execPath, [CLI, ...args], { env: env(home), timeout: 10_000 }, (error, stdout, stderr) =>
      done({ code: error?.code ?? 0, stdout, stderr }),
    );
  });
}

test("two processes and one export's parallel calls refresh an expired token once", async () => {
  const stub = await stubOrla();
  const home = expiredHome(stub.apiBase);
  try {
    // Two exports at once: six tool calls, all finding the same expired token.
    const [a, b] = await Promise.all([run(["export", "--json"], home), run(["export", "--json"], home)]);
    strictEqual(a.code, 0, a.stdout + a.stderr);
    strictEqual(b.code, 0, b.stdout + b.stderr);
    strictEqual(stub.seen.reuse, 0, "no refresh token was presented twice");
    strictEqual(stub.seen.grants.filter((g) => g.grant_type === "refresh_token").length, 1);
    ok(stub.seen.mcp.every((c) => c.token === "at-1"), "every call went out with the one refreshed token");
    strictEqual(existsSync(join(home, "orla", "refresh.lock")), false, "the lock is released");
  } finally {
    stub.close();
  }
});

test("a lock left by a process that died mid-refresh does not block forever", async () => {
  const stub = await stubOrla();
  const home = expiredHome(stub.apiBase);
  const lock = join(home, "orla", "refresh.lock");
  writeFileSync(lock, "");
  // Aged past the stale limit, as a crashed holder's would be.
  const { utimesSync } = await import("node:fs");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  try {
    const out = await run(["export", "--json"], home);
    strictEqual(out.code, 0, out.stdout + out.stderr);
    strictEqual(existsSync(lock), false);
  } finally {
    stub.close();
  }
});

/** The bridge as Claude Desktop runs it: lines in, lines out, stderr for the sign-in URL. */
function bridge(apiBase, home) {
  const child = spawn(process.execPath, [CLI, "mcp", "--api", apiBase], { env: env(home), stdio: ["pipe", "pipe", "pipe"] });
  const lines = [];
  let err = "";
  let buffered = "";
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    const parts = buffered.split("\n");
    buffered = parts.pop();
    for (const p of parts) if (p.trim()) lines.push(JSON.parse(p));
  });
  child.stderr.on("data", (c) => (err += c));
  const wait = (find, what, ms = 4000) =>
    new Promise((done, fail) => {
      const started = Date.now();
      const tick = () => {
        const hit = find();
        if (hit) return done(hit);
        if (Date.now() - started > ms) return fail(new Error(`${what} not seen within ${ms}ms; stderr: ${err}`));
        setTimeout(tick, 20);
      };
      tick();
    });
  return {
    send: (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`),
    until: (pred) => wait(() => lines.find(pred), "line"),
    stderrUntil: (re) => wait(() => err.match(re), String(re)),
    kill: () => child.kill(),
  };
}

test("a bridge whose session is refused for good forgets it and signs in again", async () => {
  const stub = await stubOrla({ refuseRefresh: true });
  const home = expiredHome(stub.apiBase);
  const b = bridge(stub.apiBase, home);
  try {
    b.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "orla_whoami", arguments: {} } });
    const first = await b.until((l) => l.id === 1);
    strictEqual(first.error.data.code, "cli.sign_in_in_progress", "the person is pointed at the browser, not a terminal");
    strictEqual(existsSync(join(home, "orla", "session.json")), false, "the dead session is forgotten");

    const [, opened] = await b.stderrUntil(/Opening (\S+)/);
    const authorize = new URL(opened);
    const back = new URL(authorize.searchParams.get("redirect_uri"));
    back.searchParams.set("code", "c0de");
    back.searchParams.set("state", authorize.searchParams.get("state"));
    strictEqual((await fetch(back)).status, 200);

    await b.until((l) => l.method === "notifications/tools/list_changed");
    b.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    deepStrictEqual((await b.until((l) => l.id === 2)).result, { tools: [{ name: "orla_whoami" }] });
    strictEqual(stub.seen.mcp.at(-1).token, "at-1", "relayed with the token of the new sign-in");
  } finally {
    b.kill();
    stub.close();
  }
});
