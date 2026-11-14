/**
 * `orla fetch`, the one command on the agent door.
 *
 * What is pinned: the key comes from the environment and from nowhere else
 * (no session on the machine is read, no key is ever printed); the request
 * Orla sees is the agent REST call with the bearer, an idempotency key and
 * `{url}`; a receipt says whether money moved from `paid`, never from the
 * status; the space is the flag or the only one the key reaches; a refusal
 * keeps Orla's own code and a refused key is "not connected", not a refusal
 * of one command. Driven the way a caller drives it: the built CLI, spawned,
 * against a local stub of the agent door.
 */
import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
const KEY = "oak_test_0123456789abcdef";

function isolated(extra = {}) {
  const home = mkdtempSync(join(tmpdir(), "orla-cli-"));
  return { home, env: { ...process.env, ORLA_NO_KEYCHAIN: "1", XDG_CONFIG_HOME: home, ORLA_NO_BROWSER: "1", ...extra } };
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

/** Orla's agent door, reduced to `/agent/me` and `/agent/spaces/:id/x402`. */
async function stubAgentDoor(answer) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const call = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
      seen.push(call);
      const { status, json } = answer(call);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { apiBase: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

const PAID = {
  applied: true,
  proposal_id: null,
  message: "",
  result: {
    paid: true,
    status: 200,
    amount_usd: "0.02",
    host: "api.example.com",
    tx_hash: "0xabc",
    body: '{"answer":42}',
  },
};

test("exit 3: no key in the environment, before anything is asked of Orla", async () => {
  const { home, env } = isolated();
  // A personal session on the machine is not a key: the agent door never reads it.
  mkdirSync(join(home, "orla"), { recursive: true });
  writeFileSync(
    join(home, "orla", "session.json"),
    JSON.stringify({ apiBase: "http://127.0.0.1:1", accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3_600_000 }),
  );
  delete env.ORLA_AGENT_KEY;
  const { code, out } = await orla(["fetch", "https://api.example.com/x", "--space", "s1", "--json"], env);
  strictEqual(code, 3);
  const answer = JSON.parse(out);
  strictEqual(answer.error.code, "cli.no_agent_key");
  match(answer.error.message, /ORLA_AGENT_KEY/);
});

test("exit 2: no url, or something Orla's fence would refuse, before anything is sent", async () => {
  const { env } = isolated({ ORLA_AGENT_KEY: KEY });
  let answer = await orla(["fetch", "--json"], env);
  strictEqual(answer.code, 2);
  strictEqual(JSON.parse(answer.out).error.code, "cli.usage");
  // The same words as the server's refusals (agent.x402_scheme, agent.x402_url).
  answer = await orla(["fetch", "ftp://files.example.com/a", "--space", "s1", "--json"], env);
  strictEqual(answer.code, 2);
  match(JSON.parse(answer.out).error.message, /must use https/);
  answer = await orla(["fetch", "http://api.example.com/x", "--space", "s1", "--json"], env);
  strictEqual(answer.code, 2);
  match(JSON.parse(answer.out).error.message, /must use https/);
  answer = await orla(["fetch", "https://user:secret@api.example.com/x", "--space", "s1", "--json"], env);
  strictEqual(answer.code, 2);
  match(JSON.parse(answer.out).error.message, /credentials in the URL/);
  ok(!answer.out.includes("secret"), "the password in the URL is not echoed");
  // Without --space the space would be asked of /agent/me first; a bad URL
  // must not get that far. Port 1 answers nobody, so reaching it would be exit 5.
  answer = await orla(["fetch", "ftp://files.example.com/a", "--api", "http://127.0.0.1:1", "--json"], env);
  strictEqual(answer.code, 2);
  strictEqual(JSON.parse(answer.out).error.code, "cli.usage");
});

test("--json before the url is a switch, not a flag that eats the url", async () => {
  const stub = await stubAgentDoor(() => ({ status: 200, json: PAID }));
  try {
    const { env } = isolated({ ORLA_AGENT_KEY: KEY });
    const { code, out } = await orla(["fetch", "--json", "https://api.example.com/x", "--space", "s1", "--api", stub.apiBase], env);
    strictEqual(code, 0);
    deepStrictEqual(JSON.parse(out), { ok: true, data: PAID });
    deepStrictEqual(stub.seen[0].body, { url: "https://api.example.com/x" });
  } finally {
    stub.close();
  }
});

test("a paid fetch: the agent call Orla sees, and the envelope with the receipt", async () => {
  const stub = await stubAgentDoor(() => ({ status: 200, json: PAID }));
  try {
    const { env } = isolated({ ORLA_AGENT_KEY: KEY });
    const { code, out } = await orla(
      ["fetch", "https://api.example.com/x?q=1", "--space", "s1", "--api", stub.apiBase, "--json"],
      env,
    );
    strictEqual(code, 0);
    deepStrictEqual(JSON.parse(out), { ok: true, data: PAID });
    strictEqual(stub.seen.length, 1, "with --space, nothing else is asked");
    const call = stub.seen[0];
    strictEqual(call.method, "POST");
    strictEqual(call.url, "/agent/spaces/s1/x402");
    strictEqual(call.headers.authorization, `Bearer ${KEY}`);
    match(call.headers["idempotency-key"], /^[0-9a-f-]{36}$/, "one idempotency key per run");
    deepStrictEqual(call.body, { url: "https://api.example.com/x?q=1" });
  } finally {
    stub.close();
  }
});

test("--idempotency-key is passed through, so a retry is the same purchase to Orla", async () => {
  const stub = await stubAgentDoor(() => ({ status: 200, json: PAID }));
  try {
    const { env } = isolated({ ORLA_AGENT_KEY: KEY });
    await orla(
      ["fetch", "https://api.example.com/x", "--space", "s1", "--api", stub.apiBase, "--idempotency-key", "run-7", "--json"],
      env,
    );
    strictEqual(stub.seen[0].headers["idempotency-key"], "run-7");
  } finally {
    stub.close();
  }
});

test("for a person: the resource on stdout, the receipt on stderr, and paid is read from paid", async () => {
  let result = PAID.result;
  const stub = await stubAgentDoor(() => ({ status: 200, json: { ...PAID, result } }));
  try {
    const { env } = isolated({ ORLA_AGENT_KEY: KEY });
    let answer = await orla(["fetch", "https://api.example.com/x", "--space", "s1", "--api", stub.apiBase], env);
    strictEqual(answer.code, 0);
    // stdout is a pipe here, as it is under `> file`: the body byte for byte,
    // no newline added for a terminal's sake
    strictEqual(answer.out, '{"answer":42}');
    strictEqual(answer.err, "paid 0.02 USD to api.example.com, tx 0xabc (HTTP 200)\n");

    // a URL that never asked for money: the common case, and not "paid"
    result = { paid: false, status: 200, body: "free" };
    answer = await orla(["fetch", "https://api.example.com/x", "--space", "s1", "--api", stub.apiBase], env);
    strictEqual(answer.out, "free");
    strictEqual(answer.err, "no charge (HTTP 200)\n");

    // a body that ends in a newline keeps exactly that one
    result = { paid: false, status: 200, body: "line\n" };
    answer = await orla(["fetch", "https://api.example.com/x", "--space", "s1", "--api", stub.apiBase], env);
    strictEqual(answer.out, "line\n");
  } finally {
    stub.close();
  }
});

test("exit 4: the space is the only one the key reaches, and several with none named refuse", async () => {
  let spaces = [{ id: "s7", name: "Shop" }];
  const stub = await stubAgentDoor((call) =>
    call.url === "/agent/me" ? { status: 200, json: { name: "bot", spaces } } : { status: 200, json: PAID },
  );
  try {
    const { env } = isolated({ ORLA_AGENT_KEY: KEY });
    let answer = await orla(["fetch", "https://api.example.com/x", "--api", stub.apiBase, "--json"], env);
    strictEqual(answer.code, 0);
    strictEqual(stub.seen[0].url, "/agent/me");
    strictEqual(stub.seen[0].headers.authorization, `Bearer ${KEY}`);
    strictEqual(stub.seen[1].url, "/agent/spaces/s7/x402");

    spaces = [
      { id: "s7", name: "Shop" },
      { id: "s8", name: "Lab" },
    ];
    answer = await orla(["fetch", "https://api.example.com/x", "--api", stub.apiBase, "--json"], env);
    strictEqual(answer.code, 4);
    const parsed = JSON.parse(answer.out);
    strictEqual(parsed.error.code, "cli.space_required");
    deepStrictEqual(parsed.error.details, { spaces });

    spaces = [];
    answer = await orla(["fetch", "https://api.example.com/x", "--api", stub.apiBase, "--json"], env);
    strictEqual(answer.code, 4);
    strictEqual(JSON.parse(answer.out).error.code, "cli.no_spaces");
    match(JSON.parse(answer.out).error.message, /Agents/);
  } finally {
    stub.close();
  }
});

test("exit 6: a refusal keeps Orla's own code and details; exit 3: a refused key", async () => {
  let refusal = {
    status: 400,
    json: { error: "agent.x402_host_not_allowed", detail: "This agent may only pay api.example.com", details: { host: "evil.example" } },
  };
  const stub = await stubAgentDoor(() => refusal);
  try {
    const { env } = isolated({ ORLA_AGENT_KEY: KEY });
    const args = ["fetch", "https://evil.example/x", "--space", "s1", "--api", stub.apiBase, "--json"];
    let answer = await orla(args, env);
    strictEqual(answer.code, 6);
    deepStrictEqual(JSON.parse(answer.out), {
      ok: false,
      error: {
        code: "agent.x402_host_not_allowed",
        message: "This agent may only pay api.example.com",
        details: { host: "evil.example" },
      },
    });

    refusal = { status: 401, json: { error: "authentication_error", detail: "Unknown agent key" } };
    answer = await orla(args, env);
    strictEqual(answer.code, 3);
    const parsed = JSON.parse(answer.out);
    strictEqual(parsed.error.code, "authentication_error");
    match(parsed.error.message, /ORLA_AGENT_KEY/);
    ok(!answer.out.includes(KEY) && !answer.err.includes(KEY), "the key is never printed");
  } finally {
    stub.close();
  }
});

test("exit 5: the agent door cannot be reached, and the key is not in the message", async () => {
  const { env } = isolated({ ORLA_AGENT_KEY: KEY });
  const { code, out, err } = await orla(
    ["fetch", "https://api.example.com/x", "--space", "s1", "--api", "http://127.0.0.1:1", "--json"],
    env,
  );
  strictEqual(code, 5);
  strictEqual(JSON.parse(out).error.code, "cli.unreachable");
  ok(!out.includes(KEY) && !err.includes(KEY));
});
