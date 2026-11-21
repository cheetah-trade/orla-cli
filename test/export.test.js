/**
 * `orla export` reads a space's whole history, and Orla serves at most 200
 * transactions per call. Until 0.5.1 the CLI asked for 500 in one call, the
 * server refused, and the readme's first example ended in exit 6 for everyone.
 *
 * These drive the real binary against a local server that pages like Orla:
 * `limit` above 200 is refused, `offset` picks the window, `total` counts all.
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
const SPACE = "11111111-1111-1111-1111-111111111111";

const ledger = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `tx-${i}`,
    occurred_on: "2026-03-28",
    kind: "expense",
    signed_amount: `-${i + 1}.00`,
    currency: "EUR",
    payee: `payee ${i}`,
    account_id: "acc-1",
    category_id: null,
  }));

/** A server holding `rows`, answering tool calls the way the personal door does. */
function orla(rows, { cutTo, nextOffset = false } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const { params } = JSON.parse(body);
      const args = params?.arguments ?? {};
      calls.push({ name: params?.name, args });
      const answer = (data) => ({ jsonrpc: "2.0", id: 1, result: { structuredContent: { data } } });
      let out;
      if (params?.name === "orla_list_transactions") {
        const limit = args.limit ?? 50;
        const offset = args.offset ?? 0;
        if (limit > 200) {
          out = {
            jsonrpc: "2.0",
            id: 1,
            result: {
              isError: true,
              content: [{ text: "limit is at most 200" }],
              structuredContent: { data: { error: "validation_error", detail: "limit is at most 200" } },
            },
          };
        } else {
          let items = rows.slice(offset, offset + limit);
          const data = { total: rows.length, limit, offset };
          // Orla's size ceiling (`mcp_answer_caps.fit`) cuts a wide page short
          // and says so; the cut page is not the last one.
          if (cutTo !== undefined && items.length > cutTo) {
            const returned = items.length;
            items = items.slice(0, cutTo);
            data.answer_truncated = { reason: "too big", lists: [{ path: "items", returned: cutTo, total: returned }] };
            if (nextOffset) data.answer_truncated.next_offset = offset + cutTo;
          }
          out = answer({ items, ...data });
        }
      } else if (params?.name === "orla_list_accounts") {
        out = answer({ accounts: [{ id: "acc-1", name: "Card" }] });
      } else {
        out = answer({ categories: [] });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  return { calls, server };
}

function run(args, api) {
  return new Promise((done) => {
    const home = mkdtempSync(join(tmpdir(), "orla-export-"));
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
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, ORLA_NO_KEYCHAIN: "1", XDG_CONFIG_HOME: home }, timeout: 8000 },
      (error, stdout, stderr) => done({ code: error?.code ?? 0, stdout, stderr }),
    );
  });
}

async function against(rows, args, shape) {
  const { calls, server } = orla(rows, shape);
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  try {
    const out = await run(args, `http://127.0.0.1:${server.address().port}`);
    return { ...out, pages: calls.filter((c) => c.name === "orla_list_transactions").map((c) => c.args) };
  } finally {
    server.close();
  }
}

test("export reads 450 rows in pages of 200 and writes every one", async () => {
  const { code, stdout, pages } = await against(ledger(450), ["export"]);
  strictEqual(code, 0);
  const lines = stdout.trim().split("\n");
  strictEqual(lines.length, 451); // header + 450
  ok(lines[450].includes("payee 449"));
  ok(lines[1].endsWith(",Card"));
  deepStrictEqual(
    pages.map((p) => [p.limit, p.offset]),
    [
      [200, 0],
      [200, 200],
      [200, 400],
    ],
  );
});

test("export of exactly 400 rows stops on the total, without an empty third call", async () => {
  const { code, stdout, pages } = await against(ledger(400), ["export"]);
  strictEqual(code, 0);
  strictEqual(stdout.trim().split("\n").length, 401);
  strictEqual(pages.length, 2);
});

test("export --limit stops early and never asks for more than 200 at once", async () => {
  const { code, stdout, pages } = await against(ledger(900), ["export", "--limit", "250"]);
  strictEqual(code, 0);
  strictEqual(stdout.trim().split("\n").length, 251);
  deepStrictEqual(
    pages.map((p) => [p.limit, p.offset]),
    [
      [200, 0],
      [50, 200],
    ],
  );
});

test("export --json is one envelope with every row", async () => {
  const { code, stdout } = await against(ledger(230), ["export", "--json"]);
  strictEqual(code, 0);
  const out = JSON.parse(stdout);
  strictEqual(out.ok, true);
  strictEqual(out.data.length, 230);
});

test("tx list asks for 50 by default, in one call", async () => {
  const { code, pages } = await against(ledger(300), ["tx", "list", "--json"]);
  strictEqual(code, 0);
  deepStrictEqual(
    pages.map((p) => [p.limit, p.offset]),
    [[50, 0]],
  );
});

test("tx list --limit above 200 is a usage error before any request", async () => {
  const { code, stdout, pages } = await against(ledger(10), ["tx", "list", "--limit", "500", "--json"]);
  strictEqual(code, 2);
  const out = JSON.parse(stdout);
  strictEqual(out.error.code, "cli.usage");
  ok(out.error.message.includes("at most 200"));
  strictEqual(pages.length, 0);
});

test("a --limit that is not a whole number is refused before any request", async () => {
  for (const bad of ["0", "-5", "ten", "1.5"]) {
    const { code, pages } = await against(ledger(10), ["export", "--limit", bad]);
    strictEqual(code, 2, `--limit ${bad}`);
    strictEqual(pages.length, 0);
  }
});

for (const nextOffset of [false, true]) {
  test(`a page cut short by the size ceiling is not the end (next_offset ${nextOffset ? "named" : "absent"})`, async () => {
    const { code, stdout, pages } = await against(ledger(450), ["export", "--json"], { cutTo: 90, nextOffset });
    strictEqual(code, 0);
    const ids = JSON.parse(stdout).data.map((r) => r.id);
    strictEqual(ids.length, 450, "every row, none lost to the cut");
    strictEqual(new Set(ids).size, 450, "and none twice");
    deepStrictEqual(ids, ledger(450).map((r) => r.id), "in order");
    deepStrictEqual(
      pages.map((p) => p.offset),
      [0, 90, 180, 270, 360],
      "each page starts where the last one ended, not at offset + limit",
    );
  });
}
