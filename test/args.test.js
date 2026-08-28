/**
 * The grammar. Five commands and a handful of flags, and exactly one way it
 * goes quietly wrong: a flag that expects a value swallowing the next flag.
 */
import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { test } from "node:test";
import { need, optional, parse } from "../dist/args.js";

test("words and flags are told apart", () => {
  const { words, flags } = parse(["tx", "list", "--from", "2026-08-01", "--json"]);
  deepStrictEqual(words, ["tx", "list"]);
  deepStrictEqual(flags, { from: "2026-08-01", json: true });
});

test("a flag followed by another flag is a boolean, not a value", () => {
  // The quiet one: `--json --limit 10` must not read "--limit" as the value of
  // --json and then lose the limit.
  const { flags } = parse(["tx", "list", "--json", "--limit", "10"]);
  deepStrictEqual(flags, { json: true, limit: "10" });
});

test("a trailing flag with no value is a boolean", () => {
  deepStrictEqual(parse(["whoami", "--json"]).flags, { json: true });
});

test("a value that looks like a date, an id or a negative amount survives", () => {
  const { flags } = parse(["tx", "add", "--amount", "-58.00", "--account", "acc_1", "--date", "2026-03-28"]);
  strictEqual(flags["amount"], "-58.00");
  strictEqual(flags["account"], "acc_1");
  strictEqual(flags["date"], "2026-03-28");
});

test("repeated flags keep the last one", () => {
  strictEqual(parse(["tx", "list", "--limit", "10", "--limit", "50"]).flags["limit"], "50");
});

test("need refuses a missing or boolean flag, optional does not", () => {
  const { flags } = parse(["tx", "add", "--account", "acc_1", "--note"]);
  strictEqual(need(flags, "account"), "acc_1");
  throws(() => need(flags, "amount"), /--amount is required/);
  // `--note` with nothing after it is a boolean, and a boolean is not a note
  throws(() => need(flags, "note"), /--note is required/);
  strictEqual(optional(flags, "note"), undefined);
  strictEqual(optional(flags, "account"), "acc_1");
});

test("no arguments is not an error", () => {
  deepStrictEqual(parse([]), { words: [], flags: {} });
});
