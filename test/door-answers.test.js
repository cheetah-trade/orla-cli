/**
 * What the door's HTTP status means to the CLI and the bridge, and that
 * nothing waits forever (review 20.11.2026, P2-1 and P2-2).
 *
 * Until 0.5.3 `post()` never looked at the status: a 401 came out as "Orla
 * refused the call" (exit 6) instead of a sign-in, a 429 or 503 body with
 * `id: null` went to the bridge's client as an answer to nobody, no request had
 * a deadline, the bridge read no line while one call was in flight (`ping`
 * included), and a sign-in whose tab was closed held its port for good.
 */
import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");

function isolated(extra = {}) {
  const home = mkdtempSync(join(tmpdir(), "orla-cli-"));
  return {
    home,
    env: { ...process.env, ORLA_NO_KEYCHAIN: "1", XDG_CONFIG_HOME: home, ORLA_NO_BROWSER: "1", ...extra },
  };
}

function withSession(home, apiBase, accessToken = "t") {
  mkdirSync(join(home, "orla"), { recursive: true });
  writeFileSync(
    join(home, "orla", "session.json"),
    JSON.stringify({ apiBase, accessToken, refreshToken: "r", expiresAt: Date.now() + 3_600_000, door: "personal" }),
  );
}

const stored = (home) => JSON.parse(readFileSync(join(home, "orla", "session.json"), "utf8"));

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

/**
 * Orla's door and token endpoint. `door(rpc, req)` returns `{status, headers,
 * body}` or `"hang"`; the token endpoint mints `fresh-N` and records grants.
 */
async function stubOrla(door, { token } = {}) {
  const seen = { grants: [], calls: [] };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/oauth/token") {
        const grant = Object.fromEntries(new URLSearchParams(body));
        seen.grants.push(grant);
        const answer = token ? token(grant) : { status: 200, body: { access_token: `fresh-${seen.grants.length}`, refresh_token: "r2", expires_in: 3600 } };
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(JSON.stringify(answer.body));
        return;
      }
      const rpc = JSON.parse(body);
      seen.calls.push({ method: rpc.method, auth: req.headers.authorization, rpc });
      const answer = door(rpc, req);
      if (answer === "hang") return; // never answers
      res.writeHead(answer.status ?? 200, { "content-type": "application/json", ...(answer.headers ?? {}) });
      res.end(JSON.stringify(answer.body ?? { jsonrpc: "2.0", id: rpc.id, result: { structuredContent: { data: {} } } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    apiBase: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

const whoami = (rpc) => ({
  body: { jsonrpc: "2.0", id: rpc.id, result: { structuredContent: { data: { user: { email: "x" }, spaces: [] } } } },
});

test("a 401 refreshes once and repeats the call with the new token", async () => {
  const stub = await stubOrla((rpc, req) =>
    req.headers.authorization === "Bearer t" ? { status: 401, body: { error: "invalid_token" } } : whoami(rpc),
  );
  try {
    const { home, env } = isolated();
    withSession(home, stub.apiBase);
    const { code } = await orla(["whoami", "--json"], env);
    strictEqual(code, 0);
    strictEqual(stub.seen.grants.length, 1);
    strictEqual(stub.seen.grants[0].grant_type, "refresh_token");
    deepStrictEqual(
      stub.seen.calls.map((c) => c.auth),
      ["Bearer t", "Bearer fresh-1"],
      "the same call, once more, with the refreshed token",
    );
    strictEqual(stored(home).accessToken, "fresh-1");
  } finally {
    stub.close();
  }
});

test("a 401 that survives the refresh is a dead session (exit 3), not a refusal (exit 6)", async () => {
  const stub = await stubOrla(() => ({ status: 401, body: { error: "invalid_token" } }));
  try {
    const { home, env } = isolated();
    withSession(home, stub.apiBase);
    const { code, out } = await orla(["whoami", "--json"], env);
    strictEqual(code, 3);
    strictEqual(JSON.parse(out).error.code, "cli.session_expired");
    strictEqual(stub.seen.calls.length, 2, "one repeat, not a loop");
  } finally {
    stub.close();
  }
});

test("a 401 whose refresh token is dead too is a dead session", async () => {
  const stub = await stubOrla(() => ({ status: 401, body: {} }), {
    token: () => ({ status: 400, body: { error: "invalid_grant", error_description: "refresh token revoked" } }),
  });
  try {
    const { home, env } = isolated();
    withSession(home, stub.apiBase);
    const { code, out } = await orla(["whoami", "--json"], env);
    strictEqual(code, 3);
    strictEqual(JSON.parse(out).error.code, "cli.session_expired");
  } finally {
    stub.close();
  }
});

test("429 is cli.rate_limited with Orla's Retry-After; nothing is repeated by itself", async () => {
  const stub = await stubOrla(() => ({
    status: 429,
    headers: { "retry-after": "17" },
    body: { jsonrpc: "2.0", id: null, error: { code: -32029, message: "slow down" } },
  }));
  try {
    const { home, env } = isolated();
    withSession(home, stub.apiBase);
    const { code, out } = await orla(["whoami", "--json"], env);
    strictEqual(code, 6);
    const { error } = JSON.parse(out);
    strictEqual(error.code, "cli.rate_limited");
    deepStrictEqual(error.details, { retry_after: 17 });
    match(error.message, /17 s/);
    strictEqual(stub.seen.calls.length, 1);
  } finally {
    stub.close();
  }
});

test("503 is cli.door_closed (exit 5) with Retry-After", async () => {
  const stub = await stubOrla(() => ({ status: 503, headers: { "retry-after": "120" }, body: {} }));
  try {
    const { home, env } = isolated();
    withSession(home, stub.apiBase);
    const { code, out } = await orla(["whoami", "--json"], env);
    strictEqual(code, 5);
    const { error } = JSON.parse(out);
    strictEqual(error.code, "cli.door_closed");
    deepStrictEqual(error.details, { retry_after: 120 });
  } finally {
    stub.close();
  }
});

test("a call Orla never answers times out as cli.timeout, not forever", async () => {
  const stub = await stubOrla(() => "hang");
  try {
    const { home, env } = isolated({ ORLA_REQUEST_TIMEOUT_MS: "300" });
    withSession(home, stub.apiBase);
    const started = Date.now();
    const { code, out } = await orla(["whoami", "--json"], env);
    ok(Date.now() - started < 10_000);
    strictEqual(code, 5);
    const { error } = JSON.parse(out);
    strictEqual(error.code, "cli.timeout");
    match(error.message, /may still have landed/);
  } finally {
    stub.close();
  }
});

/** The bridge as a client sees it. */
function bridge(apiBase, env, nodeArgs = []) {
  const child = spawn(process.execPath, [...nodeArgs, CLI, "mcp", "--api", apiBase], { env, stdio: ["pipe", "pipe", "pipe"] });
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
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const until = (pred, ms = 3000) =>
    new Promise((done, fail) => {
      const started = Date.now();
      const tick = () => {
        const hit = lines.find(pred);
        if (hit) return done(hit);
        if (Date.now() - started > ms) return fail(new Error(`nothing matched within ${ms}ms; stderr: ${err}`));
        setTimeout(tick, 20);
      };
      tick();
    });
  const stderrUntil = (re, ms = 3000) =>
    new Promise((done, fail) => {
      const started = Date.now();
      const tick = () => {
        const m = err.match(re);
        if (m) return done(m);
        if (Date.now() - started > ms) return fail(new Error(`stderr never matched ${re}: ${err}`));
        setTimeout(tick, 20);
      };
      tick();
    });
  return { lines, send, until, stderrUntil, kill: () => child.kill() };
}

test("the bridge answers ping while a call to Orla hangs", async () => {
  const stub = await stubOrla((rpc) => (rpc.method === "tools/call" ? "hang" : whoami(rpc)));
  const { home, env } = isolated();
  withSession(home, stub.apiBase);
  const b = bridge(stub.apiBase, env);
  try {
    b.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "orla_whoami", arguments: {} } });
    // let the call reach the stub and stick there
    await new Promise((r) => setTimeout(r, 200));
    b.send({ jsonrpc: "2.0", id: 2, method: "ping" });
    deepStrictEqual((await b.until((l) => l.id === 2, 1500)).result, {});
    strictEqual(b.lines.some((l) => l.id === 1), false, "the hung call is still in flight");
  } finally {
    b.kill();
    stub.close();
  }
});

test("the bridge ties a 429 to the request it answers, with the code and Retry-After", async () => {
  const stub = await stubOrla(() => ({
    status: 429,
    headers: { "retry-after": "5" },
    body: { jsonrpc: "2.0", id: null, error: { code: -32029, message: "slow down" } },
  }));
  const { home, env } = isolated();
  withSession(home, stub.apiBase);
  const b = bridge(stub.apiBase, env);
  try {
    b.send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "orla_whoami", arguments: {} } });
    const answer = await b.until((l) => l.id === 7);
    deepStrictEqual(answer.error.data, { code: "cli.rate_limited", retry_after: 5 });
  } finally {
    b.kill();
    stub.close();
  }
});

test("a protocol error Orla sends with id null reaches the client under the request's id", async () => {
  const stub = await stubOrla(() => ({
    status: 400,
    body: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
  }));
  const { home, env } = isolated();
  withSession(home, stub.apiBase);
  const b = bridge(stub.apiBase, env);
  try {
    b.send({ jsonrpc: "2.0", id: 9, method: "tools/list" });
    const answer = await b.until((l) => l.id === 9);
    strictEqual(answer.error.code, -32600);
  } finally {
    b.kill();
    stub.close();
  }
});

test("a sign-in whose browser never comes back gives up and frees its port", async () => {
  const stub = await stubOrla(whoami);
  const { env } = isolated({ ORLA_SIGN_IN_WAIT_MS: "400" });
  // A parallel sign-in can reclaim a released published port before fetch probes
  // it. Give this child an ephemeral port; the real timeout still has to close it.
  const b = bridge(stub.apiBase, env, ["--import", new URL("./helpers/ephemeral-callback.mjs", import.meta.url).href]);
  try {
    b.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
    const [, opened] = await b.stderrUntil(/Opening (\S+)/);
    await b.stderrUntil(/sign-in did not complete \(the browser did not come back/);
    const back = new URL(new URL(opened).searchParams.get("redirect_uri"));
    const closed = await fetch(back).then(
      () => false,
      () => true,
    );
    ok(closed, "nothing listens on the callback port any more");
  } finally {
    b.kill();
    stub.close();
  }
});

test("every request names orla-cli and its version; ORLA_DEBUG says what went where, without the token", async () => {
  const agents = [];
  const stub = await stubOrla((rpc, req) => {
    agents.push(req.headers["user-agent"]);
    return whoami(rpc);
  });
  try {
    const { home, env } = isolated({ ORLA_DEBUG: "1" });
    withSession(home, stub.apiBase, "SECRET-ACCESS");
    const { code, err } = await orla(["whoami", "--json"], env);
    strictEqual(code, 0);
    const pkg = JSON.parse(readFileSync(resolve(dirname(CLI), "../package.json"), "utf8"));
    match(agents[0], new RegExp(`^orla-cli/${pkg.version.replaceAll(".", "\\.")} \\(node `));
    match(err, /orla debug: POST 127\.0\.0\.1:\d+\/mcp\/personal -> 200 in \d+ ms/);
    ok(!err.includes("SECRET-ACCESS"), "the token never reaches the debug line");
  } finally {
    stub.close();
  }
});
