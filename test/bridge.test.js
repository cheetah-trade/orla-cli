/**
 * The stdio bridge, spoken to the way a client speaks to it.
 *
 * This is the path a client takes when it cannot do remote MCP itself, and it
 * had no test at all: the framing contract (one JSON object per line, a
 * notification never answered, a malformed line answered without killing the
 * session) is what every such client depends on.
 *
 * No session and no network are needed for either case: a malformed line is
 * refused before anything is sent, and a notification is not answered even
 * when the call behind it fails.
 */
import { strictEqual, match } from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");

/** Feed lines in, collect stdout, and never wait forever for a line that is not coming. */
function speak(lines, { waitMs = 1500 } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    for (const line of lines) child.stdin.write(`${line}\n`);
    setTimeout(() => {
      child.kill();
      done(out);
    }, waitMs);
  });
}

test("a malformed line is answered with a parse error and the session lives", async () => {
  const out = await speak(["{ not json", '{"jsonrpc":"2.0","id":1,'.slice(0, 10)]);
  const answers = out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  strictEqual(answers.length, 2, "one answer per malformed line, and it kept reading");
  for (const answer of answers) {
    strictEqual(answer.jsonrpc, "2.0");
    strictEqual(answer.id, null);
    strictEqual(answer.error.code, -32700);
    match(answer.error.message, /Parse error/);
  }
});

test("a blank line is ignored rather than answered", async () => {
  const out = await speak(["", "   ", "{ not json"]);
  strictEqual(out.trim().split("\n").filter(Boolean).length, 1);
});

test("a notification is never answered, even when the call behind it fails", async () => {
  // No id, so nothing may come back: not a result, and not an error either.
  const out = await speak(['{"jsonrpc":"2.0","method":"notifications/initialized"}']);
  strictEqual(out.trim(), "");
});
