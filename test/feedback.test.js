/**
 * `orla feedback` sends a bug, a problem or an idea to the Orla team through
 * the personal door's `orla_send_feedback`, and only after the person has seen
 * the text: a terminal is asked, and without one only `--yes` sends.
 *
 * These drive the real binary against a local server that answers tool calls
 * the way the personal door does. Its stdin is a pipe, never a terminal.
 */
import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
const SPACE = "11111111-1111-1111-1111-111111111111";

function orla({ refuse } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const { params } = JSON.parse(body);
      calls.push({ name: params?.name, args: params?.arguments ?? {} });
      const out = refuse
        ? {
            jsonrpc: "2.0",
            id: 1,
            result: {
              isError: true,
              content: [{ text: refuse }],
              structuredContent: { data: { error: "mcp.feedback_limit", detail: refuse } },
            },
          }
        : { jsonrpc: "2.0", id: 1, result: { structuredContent: { data: { sent: true, kind: params?.arguments?.kind } } } };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  return { calls, server };
}

function run(args, api) {
  return new Promise((done) => {
    const home = mkdtempSync(join(tmpdir(), "orla-feedback-"));
    mkdirSync(join(home, "orla"), { recursive: true });
    writeFileSync(
      join(home, "orla", "session.json"),
      JSON.stringify({
        door: "personal",
        apiBase: api,
        accessToken: "live-token",
        refreshToken: "r",
        expiresAt: Date.now() + 3_600_000,
        defaultSpaceId: SPACE,
      }),
    );
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, ORLA_NO_KEYCHAIN: "1", XDG_CONFIG_HOME: home }, timeout: 8000 },
      (error, stdout, stderr) => done({ code: error?.code ?? 0, stdout, stderr }),
    );
    child.stdin.end();
  });
}

async function against(args, shape) {
  const { calls, server } = orla(shape);
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  try {
    return { ...(await run(args, `http://127.0.0.1:${server.address().port}`)), calls };
  } finally {
    server.close();
  }
}

test("--yes sends the kind and the words, and no space unless one is named", async () => {
  const { code, stderr, calls } = await against(["feedback", "idea", "Export", "to", "PDF", "--yes"]);
  strictEqual(code, 0);
  deepStrictEqual(calls, [{ name: "orla_send_feedback", args: { kind: "idea", text: "Export to PDF" } }]);
  match(stderr, /sent to the Orla team/);
});

test("--yes before the text still reads the text as the text", async () => {
  const { code, calls } = await against(["feedback", "bug", "--yes", "The VAT report is empty", "--space", SPACE]);
  strictEqual(code, 0);
  deepStrictEqual(calls[0].args, { kind: "bug", text: "The VAT report is empty", space_id: SPACE });
});

test("without a terminal and without --yes nothing is sent", async () => {
  const { code, stderr, calls } = await against(["feedback", "problem", "I cannot find the VAT report"]);
  strictEqual(code, 2);
  match(stderr, /--yes/);
  strictEqual(calls.length, 0);
});

test("a kind the door does not take, or no text, is a usage failure before any request", async () => {
  for (const args of [["feedback", "tool_error", "x y z", "--yes"], ["feedback", "bug", "--yes"], ["feedback"]]) {
    const { code, calls } = await against(args);
    strictEqual(code, 2, args.join(" "));
    strictEqual(calls.length, 0);
  }
  const { code } = await against(["feedback", "bug", "x".repeat(4001), "--yes"]);
  strictEqual(code, 2);
});

test("Orla's ceiling comes back as its own code with --json", async () => {
  const { code, stdout } = await against(["feedback", "bug", "one more", "--yes", "--json"], {
    refuse: "five reports in the last hour",
  });
  strictEqual(code, 6);
  const envelope = JSON.parse(stdout);
  strictEqual(envelope.ok, false);
  strictEqual(envelope.error.code, "mcp.feedback_limit");
  ok(envelope.error.message.includes("five reports"));
});
