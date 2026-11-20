/**
 * An answer that left rows out says so, and `orla tx add` books today on this
 * machine's calendar (review 20.11.2026, P2-8 and P2-9).
 *
 * Until 0.5.3 `orla accounts`, `orla tx list`, `orla export` and the name
 * lookups behind the export threw Orla's `total` and `truncated` away: a short
 * list or a CSV with blank categories came out with nothing saying it was
 * short. And the date was `toISOString()`, UTC, so after midnight east of
 * Greenwich an entry landed on yesterday, on the first of a month in the month
 * before.
 */
import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { localToday } from "../dist/commands.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
const SPACE = "11111111-1111-1111-1111-111111111111";

const tx = (i) => ({ id: `tx-${i}`, occurred_on: "2026-03-28", kind: "expense", signed_amount: "-1.00", currency: "EUR", payee: `p${i}`, account_id: "acc-1", category_id: "cat-250" });

/** Orla with `answers[tool](args)` per tool; records every call. */
async function stub(answers) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { params } = JSON.parse(body);
      calls.push({ name: params?.name, args: params?.arguments ?? {} });
      const data = (answers[params?.name] ?? (() => ({})))(params?.arguments ?? {});
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: { data } } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { api: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() };
}

function run(args, api, extraEnv = {}) {
  return new Promise((done) => {
    const home = mkdtempSync(join(tmpdir(), "orla-cut-"));
    mkdirSync(join(home, "orla"), { recursive: true });
    writeFileSync(
      join(home, "orla", "session.json"),
      JSON.stringify({ door: "personal", apiBase: api, accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3_600_000, defaultSpaceId: SPACE }),
    );
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, ORLA_NO_KEYCHAIN: "1", XDG_CONFIG_HOME: home, ...extraEnv }, timeout: 8000 },
      (error, stdout, stderr) => done({ code: error?.code ?? 0, stdout, stderr }),
    );
  });
}

const capNote = (returned, total) => ({ returned, total, hint: "Only the first are here." });

test("accounts over Orla's ceiling: stderr says so, --json carries truncated", async () => {
  const accounts = Array.from({ length: 200 }, (_, i) => ({ id: `a${i}`, name: `A${i}` }));
  const s = await stub({ orla_list_accounts: () => ({ accounts, truncated: capNote(200, 201) }) });
  try {
    const table = await run(["accounts"], s.api);
    strictEqual(table.code, 0);
    match(table.stderr, /showing 200 of 201 accounts/);
    const json = JSON.parse((await run(["accounts", "--json"], s.api)).stdout);
    strictEqual(json.data.length, 200, "data keeps its shape: the rows");
    deepStrictEqual(json.truncated, { shown: 200, total: 201, reason: "server_cap" });
  } finally {
    s.close();
  }
});

test("a list that is whole says nothing and carries no truncated", async () => {
  const s = await stub({ orla_list_accounts: () => ({ accounts: [{ id: "a", name: "A" }] }) });
  try {
    const out = await run(["accounts", "--json"], s.api);
    strictEqual(out.stderr, "");
    strictEqual("truncated" in JSON.parse(out.stdout), false);
  } finally {
    s.close();
  }
});

test("tx list names how many of the total it shows", async () => {
  const s = await stub({ orla_list_transactions: (a) => ({ items: Array.from({ length: a.limit }, (_, i) => tx(i)), total: 1234 }) });
  try {
    const table = await run(["tx", "list"], s.api);
    match(table.stderr, /showing 50 of 1234 transactions/);
    const json = JSON.parse((await run(["tx", "list", "--limit", "20", "--json"], s.api)).stdout);
    deepStrictEqual(json.truncated, { shown: 20, total: 1234, reason: "limit" });
  } finally {
    s.close();
  }
});

test("an export that Orla stopped short of its total is named, and blank categories are explained", async () => {
  // 250 rows promised; the third page comes back empty
  const s = await stub({
    orla_list_transactions: (a) => ({ items: a.offset < 200 ? Array.from({ length: Math.min(a.limit, 200 - a.offset) }, (_, i) => tx(a.offset + i)) : [], total: 250 }),
    orla_list_accounts: () => ({ accounts: [{ id: "acc-1", name: "Card" }] }),
    orla_list_categories: () => ({ categories: Array.from({ length: 200 }, (_, i) => ({ id: `cat-${i}`, name: `C${i}` })), truncated: capNote(200, 260) }),
  });
  try {
    const csv = await run(["export"], s.api);
    strictEqual(csv.code, 0);
    strictEqual(csv.stdout.trim().split("\n").length, 201, "the CSV itself is untouched");
    match(csv.stderr, /showing 200 of 250 transactions; Orla stopped/);
    match(csv.stderr, /showing 200 of 260 categories/);
    const json = JSON.parse((await run(["export", "--json"], s.api)).stdout);
    deepStrictEqual(json.truncated, { shown: 200, total: 250, reason: "incomplete" });
  } finally {
    s.close();
  }
});

const dayIn = (timeZone) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

// UTC+14 and UTC-11 are a day apart at every hour, so at any moment at least
// one of them is not on UTC's date: the old toISOString() failed one of these.
for (const zone of ["Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
  test(`tx add books today in ${zone}, not in UTC`, async () => {
    const s = await stub({ orla_book_transaction: () => ({ applied: true, result: { transaction_id: "t1" } }) });
    try {
      const before = dayIn(zone);
      const out = await run(["tx", "add", "--account", "acc-1", "--amount", "5"], s.api, { TZ: zone });
      strictEqual(out.code, 0, out.stderr);
      const booked = s.calls.find((c) => c.name === "orla_book_transaction").args.occurred_on;
      ok([before, dayIn(zone)].includes(booked), `${booked} is not today in ${zone} (${before})`);
    } finally {
      s.close();
    }
  });
}

test("localToday reads the machine's calendar", () => {
  strictEqual(localToday(new Date(2026, 0, 1, 0, 30)), "2026-01-01");
  strictEqual(localToday(new Date(2026, 10, 30, 23, 59)), "2026-11-30");
});
