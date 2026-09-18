/**
 * What a program sees: one envelope on stdout and an exit status that says
 * which kind of failure it was.
 *
 * Before this, every failure was exit code 1 and a sentence on stderr, and
 * the server's own refusal code (`mcp.unknown_tool`, `validation_error`) was
 * thrown away on the way to the terminal. Each case here is one row of the
 * exit-code table in skills/orla/SKILL.md, produced the way a caller would
 * produce it: the built CLI, spawned, against an isolated session store and,
 * where Orla has to answer, a local stub of the MCP endpoint.
 */
import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");

/** A fresh config dir, so the developer's real session is never read or written. */
function isolated() {
  const home = mkdtempSync(join(tmpdir(), "orla-cli-"));
  return { home, env: { ...process.env, ORLA_NO_KEYCHAIN: "1", XDG_CONFIG_HOME: home, ORLA_NO_BROWSER: "1" } };
}

function withSession(home, apiBase) {
  mkdirSync(join(home, "orla"), { recursive: true });
  writeFileSync(
    join(home, "orla", "session.json"),
    JSON.stringify({ apiBase, accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3_600_000 }),
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

/** A stand-in for Orla's MCP endpoint: one handler decides every tools/call. */
async function stubOrla(answer) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const rpc = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, ...answer(rpc) }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { apiBase: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const ok = (data) => ({ result: { structuredContent: { notice: "n", data } } });
const refusal = (error, detail, details) => ({
  result: {
    isError: true,
    content: [{ type: "text", text: detail }],
    structuredContent: { notice: "n", data: details ? { error, detail, details } : { error, detail } },
  },
});

test("exit 2: an unknown command is a usage failure, in the envelope", async () => {
  const { env } = isolated();
  const { code, out } = await orla(["nonsense", "--json"], env);
  strictEqual(code, 2);
  const answer = JSON.parse(out);
  strictEqual(answer.ok, false);
  strictEqual(answer.error.code, "cli.usage");
  match(answer.error.message, /unknown command: nonsense/);
});

test("exit 2: a missing required flag is a usage failure, not a general one", async () => {
  const { home, env } = isolated();
  withSession(home, "http://127.0.0.1:1");
  // --space so the command never asks Orla which space; the flag check comes first.
  const { code, out } = await orla(["tx", "add", "--space", "s1", "--json"], env);
  strictEqual(code, 2);
  strictEqual(JSON.parse(out).error.code, "cli.usage");
});

test("exit 3: no session on this machine", async () => {
  const { env } = isolated();
  const { code, out, err } = await orla(["whoami", "--json"], env);
  strictEqual(code, 3);
  deepStrictEqual(JSON.parse(out), {
    ok: false,
    error: { code: "cli.not_connected", message: "not connected: run `orla login` first" },
  });
  strictEqual(err, "", "with --json the failure is on stdout, not repeated on stderr");
});

test("without --json the same failure is a line on stderr, stdout stays empty", async () => {
  const { env } = isolated();
  const { code, out, err } = await orla(["whoami"], env);
  strictEqual(code, 3);
  strictEqual(out, "");
  strictEqual(err, "orla: not connected: run `orla login` first\n");
});

test("exit 5: Orla cannot be reached", async () => {
  const { home, env } = isolated();
  withSession(home, "http://127.0.0.1:1");
  const { code, out } = await orla(["whoami", "--json"], env);
  strictEqual(code, 5);
  const answer = JSON.parse(out);
  strictEqual(answer.error.code, "cli.unreachable");
  match(answer.error.message, /127\.0\.0\.1:1/);
});

test("exit 6: a refusal keeps the server's own code and details", async () => {
  const stub = await stubOrla(() => refusal("mcp.unknown_tool", "no such tool", { tool: "orla_whoami" }));
  try {
    const { home, env } = isolated();
    withSession(home, stub.apiBase);
    const { code, out } = await orla(["whoami", "--json"], env);
    strictEqual(code, 6);
    deepStrictEqual(JSON.parse(out), {
      ok: false,
      error: { code: "mcp.unknown_tool", message: "no such tool", details: { tool: "orla_whoami" } },
    });
  } finally {
    stub.close();
  }
});

test("exit 6: an answer with no result is a bad answer, not a crash", async () => {
  const stub = await stubOrla(() => ({}));
  try {
    const { home, env } = isolated();
    withSession(home, stub.apiBase);
    const { code, out } = await orla(["whoami", "--json"], env);
    strictEqual(code, 6);
    strictEqual(JSON.parse(out).error.code, "cli.bad_answer");
  } finally {
    stub.close();
  }
});

test("exit 4: no space in reach, and several spaces with none named", async () => {
  let spaces = [];
  const stub = await stubOrla(() => ok({ name: "cli", spaces }));
  try {
    const { home, env } = isolated();
    withSession(home, stub.apiBase);
    let answer = await orla(["accounts", "--json"], env);
    strictEqual(answer.code, 4);
    strictEqual(JSON.parse(answer.out).error.code, "cli.no_spaces");

    spaces = [
      { id: "s1", name: "Home" },
      { id: "s2", name: "Shop" },
    ];
    answer = await orla(["accounts", "--json"], env);
    strictEqual(answer.code, 4);
    const parsed = JSON.parse(answer.out);
    strictEqual(parsed.error.code, "cli.space_required");
    deepStrictEqual(parsed.error.details, { spaces });
  } finally {
    stub.close();
  }
});

test("exit 0: success is {ok:true,data} with the tool's payload and nothing else", async () => {
  const stub = await stubOrla((rpc) =>
    rpc.params.name === "orla_whoami" ? ok({ name: "cli", spaces: [{ id: "s1", name: "Home" }] }) : ok({ accounts: [{ id: "a1", name: "Cash" }] }),
  );
  try {
    const { home, env } = isolated();
    withSession(home, stub.apiBase);
    const { code, out } = await orla(["accounts", "--json"], env);
    strictEqual(code, 0);
    deepStrictEqual(JSON.parse(out), { ok: true, data: [{ id: "a1", name: "Cash" }] });
  } finally {
    stub.close();
  }
});

test("version, help, logout and use answer in the envelope too", async () => {
  const { home, env } = isolated();
  let answer = await orla(["version", "--json"], env);
  strictEqual(answer.code, 0);
  match(JSON.parse(answer.out).data.version, /^\d+\.\d+\.\d+/);

  answer = await orla(["help", "--json"], env);
  const commands = JSON.parse(answer.out).data.commands.map((c) => c.name);
  deepStrictEqual(commands.slice(0, 3), ["login", "logout", "whoami"]);

  answer = await orla(["use", "--json"], env);
  strictEqual(answer.code, 2, "use without an id is a usage failure");

  withSession(home, "http://127.0.0.1:1");
  answer = await orla(["use", "s9", "--json"], env);
  strictEqual(answer.code, 0);
  deepStrictEqual(JSON.parse(answer.out), { ok: true, data: { default_space_id: "s9" } });

  answer = await orla(["logout", "--json"], env);
  strictEqual(answer.code, 0);
  deepStrictEqual(JSON.parse(answer.out), { ok: true, data: { forgotten: true } });
  answer = await orla(["whoami", "--json"], env);
  strictEqual(answer.code, 3, "and the session is gone");
});
