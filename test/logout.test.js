/**
 * `orla logout` ends the connection on Orla's side, not only on this machine.
 *
 * Until 0.5.1 it deleted the local copy and nothing else, while SECURITY.md told
 * a person whose refresh token was stolen to run it. A copy elsewhere kept
 * working for the rest of the token's 30 or 60 days. Now logout asks Orla's
 * revocation endpoint (RFC 7009, found in the RFC 8414 metadata) first, and
 * when it cannot, says the session was forgotten here only.
 *
 * The stub below is Orla reduced to its metadata and revocation endpoint.
 */
import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
const CLIENT_ID = "https://orla.finance/mcp-cli.json";

function isolated() {
  const home = mkdtempSync(join(tmpdir(), "orla-cli-"));
  return { home, env: { ...process.env, ORLA_NO_KEYCHAIN: "1", XDG_CONFIG_HOME: home, ORLA_NO_BROWSER: "1" } };
}

const sessionFile = (home) => join(home, "orla", "session.json");

function withSession(home, apiBase) {
  mkdirSync(join(home, "orla"), { recursive: true });
  writeFileSync(
    sessionFile(home),
    JSON.stringify({ apiBase, accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + 3_600_000 }),
  );
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

/**
 * `revocation`: "here" (same origin), "elsewhere" (another origin), or none.
 * `status`: what the revocation endpoint answers. `home`: checked at the moment
 * the revocation arrives, to prove the order (revoke, then forget).
 */
async function stubOrla({ revocation = "here", status = 200, home } = {}) {
  const seen = { revocations: [], sessionPresentAtRevoke: [] };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      if (req.url === "/.well-known/oauth-authorization-server") {
        const meta = { issuer: base, token_endpoint: `${base}/oauth/token` };
        if (revocation === "here") meta.revocation_endpoint = `${base}/oauth/revoke`;
        if (revocation === "elsewhere") meta.revocation_endpoint = "http://127.0.0.2:9/oauth/revoke";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(meta));
        return;
      }
      if (req.url === "/oauth/revoke" && req.method === "POST") {
        seen.revocations.push(Object.fromEntries(new URLSearchParams(body)));
        if (home) seen.sessionPresentAtRevoke.push(existsSync(sessionFile(home)));
        if (status === 200) {
          res.writeHead(200).end();
        } else {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "temporarily_unavailable", error_description: "door closed" }));
        }
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { apiBase: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

test("logout revokes the refresh token on Orla before it forgets the session", async () => {
  const { home, env } = isolated();
  const stub = await stubOrla({ home });
  try {
    withSession(home, stub.apiBase);
    const { code, out, err } = await orla(["logout", "--json"], env);
    strictEqual(code, 0);
    deepStrictEqual(JSON.parse(out), { ok: true, data: { forgotten: true, revoked: true } });
    deepStrictEqual(stub.seen.revocations, [
      { token: "rt-1", token_type_hint: "refresh_token", client_id: CLIENT_ID },
    ]);
    deepStrictEqual(stub.seen.sessionPresentAtRevoke, [true], "revoked first, forgotten after");
    strictEqual(existsSync(sessionFile(home)), false);
    strictEqual(err, "");
  } finally {
    stub.close();
  }
});

test("logout says so in words when the connection was revoked", async () => {
  const { home, env } = isolated();
  const stub = await stubOrla();
  try {
    withSession(home, stub.apiBase);
    const { code, err } = await orla(["logout"], env);
    strictEqual(code, 0);
    match(err, /revoked on Orla/);
  } finally {
    stub.close();
  }
});

test("an Orla with no revocation endpoint: forgotten here only, and the person is told", async () => {
  const { home, env } = isolated();
  const stub = await stubOrla({ revocation: "none" });
  try {
    withSession(home, stub.apiBase);
    let answer = await orla(["logout", "--json"], env);
    strictEqual(answer.code, 0);
    const data = JSON.parse(answer.out).data;
    strictEqual(data.forgotten, true);
    strictEqual(data.revoked, false);
    strictEqual(data.reason, "not_offered");
    strictEqual(existsSync(sessionFile(home)), false);

    withSession(home, stub.apiBase);
    answer = await orla(["logout"], env);
    match(answer.err, /this machine only/);
    match(answer.err, /Revoke this connection in Orla under Agents/);
  } finally {
    stub.close();
  }
});

test("a revocation endpoint on another origin is not sent the token", async () => {
  const { home, env } = isolated();
  const stub = await stubOrla({ revocation: "elsewhere" });
  try {
    withSession(home, stub.apiBase);
    const { code, out } = await orla(["logout", "--json"], env);
    strictEqual(code, 0);
    const data = JSON.parse(out).data;
    strictEqual(data.revoked, false);
    strictEqual(data.reason, "not_offered");
    strictEqual(stub.seen.revocations.length, 0);
    strictEqual(existsSync(sessionFile(home)), false);
  } finally {
    stub.close();
  }
});

test("a refusal from the endpoint still forgets the session, and names the refusal", async () => {
  const { home, env } = isolated();
  const stub = await stubOrla({ status: 503 });
  try {
    withSession(home, stub.apiBase);
    const { code, out } = await orla(["logout", "--json"], env);
    strictEqual(code, 0);
    const data = JSON.parse(out).data;
    deepStrictEqual(data, { forgotten: true, revoked: false, reason: "refused", detail: "door closed" });
    strictEqual(stub.seen.revocations.length, 1);
    strictEqual(existsSync(sessionFile(home)), false);
  } finally {
    stub.close();
  }
});

test("an unreachable Orla still forgets the session", async () => {
  const { home, env } = isolated();
  withSession(home, "http://127.0.0.1:1");
  const { code, out } = await orla(["logout", "--json"], env);
  strictEqual(code, 0);
  const data = JSON.parse(out).data;
  strictEqual(data.revoked, false);
  strictEqual(data.reason, "unreachable");
  strictEqual(existsSync(sessionFile(home)), false);
});

test("logout with nothing stored is not an error", async () => {
  const { env } = isolated();
  const { code, out } = await orla(["logout", "--json"], env);
  strictEqual(code, 0);
  deepStrictEqual(JSON.parse(out).data, { forgotten: true, revoked: false, reason: "no_session" });
});

test("a session with only an access token sends that one", async () => {
  const { home, env } = isolated();
  const stub = await stubOrla();
  try {
    mkdirSync(join(home, "orla"), { recursive: true });
    writeFileSync(
      sessionFile(home),
      JSON.stringify({ apiBase: stub.apiBase, accessToken: "at-9", refreshToken: "", expiresAt: Date.now() + 1000 }),
    );
    const { out } = await orla(["logout", "--json"], env);
    strictEqual(JSON.parse(out).data.revoked, true);
    ok(stub.seen.revocations[0].token === "at-9" && stub.seen.revocations[0].token_type_hint === "access_token");
  } finally {
    stub.close();
  }
});
