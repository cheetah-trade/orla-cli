/**
 * The bridge signing in by itself.
 *
 * Claude Desktop launches the bridge from a bundle and other clients from a
 * config file: there is no terminal to type `orla login` into. So the bridge
 * has to be a well-formed MCP server while nobody is signed in, run the
 * browser flow on its own, and become the real relay the moment the person is
 * done. This drives that whole path without a browser: the sign-in URL the
 * bridge prints carries the redirect URI and the state, so the test plays the
 * browser and calls the callback itself, against a stub of Orla that answers
 * the token endpoint and then the MCP endpoint.
 */
import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");

function isolated() {
  const home = mkdtempSync(join(tmpdir(), "orla-cli-"));
  return { ...process.env, ORLA_NO_KEYCHAIN: "1", XDG_CONFIG_HOME: home, ORLA_NO_BROWSER: "1" };
}

/** Orla, reduced to the two endpoints a sign-in and one tools/list need. */
async function stubOrla() {
  const seen = { tokenGrants: [], mcpCalls: [] };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/oauth/token") {
        seen.tokenGrants.push(Object.fromEntries(new URLSearchParams(body)));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }));
        return;
      }
      // Both doors, because which one the bridge posts to is part of what these
      // tests are watching: a sign-in from here asks for the personal door.
      if (req.url === "/mcp" || req.url === "/mcp/personal") {
        const rpc = JSON.parse(body);
        seen.mcpCalls.push({ method: rpc.method, auth: req.headers.authorization, path: req.url });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { tools: [{ name: "orla_whoami" }] } }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { apiBase: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

/** The bridge as a client sees it: lines in, lines out, stderr kept for the URL. */
function bridge(apiBase, env) {
  const child = spawn(process.execPath, [CLI, "mcp", "--api", apiBase], { env, stdio: ["pipe", "pipe", "pipe"] });
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
  return { child, lines, send, until, stderrUntil, kill: () => child.kill() };
}

test("with no session the bridge is a server with no tools, and a tool call names the sign-in", async () => {
  const stub = await stubOrla();
  const b = bridge(stub.apiBase, isolated());
  try {
    b.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
    const init = await b.until((l) => l.id === 1);
    strictEqual(init.result.serverInfo.name, "orla-cli");
    strictEqual(init.result.protocolVersion, "2025-06-18", "the client's version is echoed, not argued with");
    deepStrictEqual(init.result.capabilities, { tools: { listChanged: true } });

    b.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    b.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    deepStrictEqual((await b.until((l) => l.id === 2)).result, { tools: [] });

    b.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "orla_whoami", arguments: {} } });
    const refused = await b.until((l) => l.id === 3);
    strictEqual(refused.error.data.code, "cli.sign_in_in_progress");
    match(refused.error.message, /browser/);

    b.send({ jsonrpc: "2.0", id: 4, method: "ping" });
    deepStrictEqual((await b.until((l) => l.id === 4)).result, {});

    // The sign-in started on the first request, once, and printed where it went.
    const urls = await b.stderrUntil(/Opening (\S+)/);
    strictEqual(urls.index, urls.input.indexOf("Opening"), "one sign-in, not one per request");
    match(urls[1], new RegExp(`^${stub.apiBase}/oauth/authorize\\?`));
    strictEqual(stub.seen.mcpCalls.length, 0, "nothing reached Orla without a token");
  } finally {
    b.kill();
    stub.close();
  }
});

test("when the person finishes in the browser, the client is told and the relay begins", async () => {
  const stub = await stubOrla();
  const b = bridge(stub.apiBase, isolated());
  try {
    b.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
    await b.until((l) => l.id === 1);
    const [, opened] = await b.stderrUntil(/Opening (\S+)/);
    const authorize = new URL(opened);
    strictEqual(authorize.searchParams.get("code_challenge_method"), "S256");

    // Play the browser: land on the redirect with a code and the same state.
    const back = new URL(authorize.searchParams.get("redirect_uri"));
    back.searchParams.set("code", "c0de");
    back.searchParams.set("state", authorize.searchParams.get("state"));
    const landed = await fetch(back);
    strictEqual(landed.status, 200);

    const changed = await b.until((l) => l.method === "notifications/tools/list_changed");
    strictEqual(changed.id, undefined, "a notification, so the client refetches rather than answers");
    strictEqual(stub.seen.tokenGrants[0].grant_type, "authorization_code");

    b.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listed = await b.until((l) => l.id === 2);
    deepStrictEqual(listed.result, { tools: [{ name: "orla_whoami" }] });
    strictEqual(stub.seen.mcpCalls[0].auth, "Bearer at", "relayed with the token the sign-in minted");
    strictEqual(stub.seen.mcpCalls[0].path, "/mcp/personal", "and relayed to the door that sign-in asked for");
    strictEqual(
      stub.seen.tokenGrants[0].resource,
      `${stub.apiBase}/mcp/personal`,
      "the code was exchanged for that same audience",
    );
  } finally {
    b.kill();
    stub.close();
  }
});

test("a state that comes back wrong is refused, said out loud, and does not connect", async () => {
  const stub = await stubOrla();
  const b = bridge(stub.apiBase, isolated());
  try {
    b.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
    await b.until((l) => l.id === 1);
    const [, opened] = await b.stderrUntil(/Opening (\S+)/);
    const back = new URL(new URL(opened).searchParams.get("redirect_uri"));
    back.searchParams.set("code", "c0de");
    back.searchParams.set("state", "forged");
    await fetch(back);
    await b.stderrUntil(/sign-in did not complete \(the callback carried a different state/);
    strictEqual(stub.seen.tokenGrants.length, 0, "no code was exchanged");
    b.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    deepStrictEqual((await b.until((l) => l.id === 2)).result, { tools: [] }, "still not signed in");
  } finally {
    b.kill();
    stub.close();
  }
});
