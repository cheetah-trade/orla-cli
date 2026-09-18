/**
 * Which address the CLI actually posts to.
 *
 * Orla answers MCP at two addresses and the difference is what a person is
 * agreeing to: `/mcp/personal` withholds every tool that moves money, `/mcp`
 * offers the shape where an agent gets a budget. Until 0.2.2 this client asked
 * for `/mcp` while its readme described the personal one, so the promise was
 * kept by whatever the person happened to tick on the consent page.
 *
 * These drive the real binary against a local server and assert the path it
 * asks for, rather than reading the source and believing it.
 */
import { strictEqual, deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");

/** A server that records what was asked of it and answers one tool list. */
function recorder() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ path: req.url, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
    });
  });
  return { seen, server };
}

/** Run `orla` with a session file holding exactly this session. */
function run(args, session) {
  return new Promise((done) => {
    const home = mkdtempSync(join(tmpdir(), "orla-door-"));
    mkdirSync(join(home, "orla"), { recursive: true });
    writeFileSync(join(home, "orla", "session.json"), JSON.stringify(session));
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, ORLA_NO_KEYCHAIN: "1", XDG_CONFIG_HOME: home }, timeout: 8000 },
      (error, stdout, stderr) => done({ error, stdout, stderr }),
    );
  });
}

async function pathAskedFor(session) {
  const { seen, server } = recorder();
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const api = `http://127.0.0.1:${server.address().port}`;
  await run(["tools", "--json"], {
    ...session,
    apiBase: api,
    accessToken: "live-token",
    refreshToken: "r",
    expiresAt: Date.now() + 3_600_000,
  });
  server.close();
  return seen.map((s) => s.path);
}

test("a session minted at the personal door posts to the personal door", async () => {
  deepStrictEqual(await pathAskedFor({ door: "personal" }), ["/mcp/personal"]);
});

test("a session minted at the agent door keeps posting there", async () => {
  deepStrictEqual(await pathAskedFor({ door: "agent" }), ["/mcp"]);
});

test("a session from before doors were recorded is left where it was minted", async () => {
  // Not a default to prefer: a token is issued for one audience, and quietly
  // sending it to the other is a 401 the person cannot explain.
  deepStrictEqual(await pathAskedFor({}), ["/mcp"]);
});

test("login asks for the personal door unless --agent is passed", async () => {
  // The authorization URL is printed before any browser opens, so the resource
  // this client asks for can be read without completing a flow.
  const url = async (args) => {
    const { stderr } = await run(["login", "--api", "http://127.0.0.1:9", ...args], {});
    return decodeURIComponent(stderr.match(/Opening (\S+)/)?.[1] ?? "");
  };
  // `resource` is the last parameter, so the value runs to the end of the URL.
  // Asserting the end rather than a substring is what tells the two apart:
  // "/mcp" is a prefix of "/mcp/personal".
  const plain = await url([]);
  strictEqual(plain.endsWith("resource=http://127.0.0.1:9/mcp/personal"), true, plain);
  const agent = await url(["--agent"]);
  strictEqual(agent.endsWith("resource=http://127.0.0.1:9/mcp"), true, agent);
});
