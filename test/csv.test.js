/**
 * `orla export` writes somebody's books into a spreadsheet. A payee with a
 * comma in it, an address with a newline, a note with a quote: each of these
 * silently shifts every column to its right if the quoting is wrong, and the
 * person finds out when the totals disagree.
 */
import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { toCsv } from "../dist/commands.js";

const columns = ["date", "payee", "amount"];

test("a plain row is not quoted", () => {
  strictEqual(
    toCsv([{ date: "2026-03-28", payee: "Hetzner", amount: "-58.00" }], columns),
    "date,payee,amount\n2026-03-28,Hetzner,-58.00",
  );
});

test("a comma in a value is quoted", () => {
  const csv = toCsv([{ date: "2026-03-28", payee: "Ikea, Berlin", amount: "-58.00" }], columns);
  strictEqual(csv.split("\n")[1], '2026-03-28,"Ikea, Berlin",-58.00');
});

test("a quote inside a value is doubled", () => {
  const csv = toCsv([{ date: "2026-03-28", payee: 'The "Blue" Cafe', amount: "-12.00" }], columns);
  strictEqual(csv.split("\n")[1], '2026-03-28,"The ""Blue"" Cafe",-12.00');
});

test("a newline in a value is quoted rather than breaking the row", () => {
  const csv = toCsv([{ date: "2026-03-28", payee: "Line one\nLine two", amount: "-1.00" }], columns);
  strictEqual(csv, 'date,payee,amount\n2026-03-28,"Line one\nLine two",-1.00');
});

test("a missing value is empty, not the word undefined", () => {
  strictEqual(toCsv([{ date: "2026-03-28", amount: "-1.00" }], columns).split("\n")[1], "2026-03-28,,-1.00");
});

test("no rows still writes the header", () => {
  strictEqual(toCsv([], columns), "date,payee,amount");
});
