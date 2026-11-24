/**
 * `scripts/check-contract-ahead.mjs`: the copy may add tools ahead of
 * production, never change one production already has (#60, #70).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { changedExistingTools, newTools } from "../scripts/check-contract-ahead.mjs";

const tool = (name, extra = {}) => ({
  name,
  arguments: ["space_id"],
  required: ["space_id"],
  readOnly: true,
  destructive: false,
  ...extra,
});
const production = { tools: [tool("orla_list_accounts"), tool("orla_amend_transaction", { readOnly: false })] };

test("a copy that matches production passes", () => {
  const copy = { tools: [tool("orla_amend_transaction", { readOnly: false }), tool("orla_list_accounts")] };
  assert.deepEqual(changedExistingTools(copy, production), []);
  assert.deepEqual(newTools(copy, production), []);
});

test("a new tool ahead of production passes and is named", () => {
  const copy = { tools: [...production.tools, tool("orla_needs_attention")] };
  assert.deepEqual(changedExistingTools(copy, production), []);
  assert.deepEqual(newTools(copy, production), ["orla_needs_attention"]);
});

test("a changed existing tool is refused", () => {
  const copy = {
    tools: [
      tool("orla_list_accounts"),
      tool("orla_amend_transaction", { readOnly: false, arguments: ["space_id", "tags"] }),
    ],
  };
  const changed = changedExistingTools(copy, production);
  assert.deepEqual(
    changed.map((c) => c.name),
    ["orla_amend_transaction"],
  );
});

test("key order alone is not a change", () => {
  const live = production.tools[0];
  const reordered = Object.fromEntries(Object.entries(live).reverse());
  assert.deepEqual(changedExistingTools({ tools: [reordered] }, production), []);
});
