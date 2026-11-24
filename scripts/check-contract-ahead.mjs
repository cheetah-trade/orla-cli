#!/usr/bin/env node
/**
 * The contract copy may run ahead of production with NEW tools, never with a
 * changed existing one.
 *
 * `contracts/mcp-personal-tools.json` is a copy of the personal door's shape,
 * and Orla's own CI compares it with the door on every push. A tool the copy
 * adds ahead of its landing is tolerated there; a tool that already exists and
 * reads differently in the copy turns that check red for every change on Orla's
 * side until the change lands. That happened twice (#60, rolled back in #61, on
 * 23.11.2026, and #70 on 24.11.2026), so this step asks production what the door
 * says now and refuses such a copy before it is merged here.
 *
 * For each tool that both the copy and production list, the record must be
 * identical. A tool production does not list yet passes. If production cannot
 * be read, the step fails and says so: a gate that passes when it cannot look
 * would let the same copy through on a bad day.
 *
 *   node scripts/check-contract-ahead.mjs
 *   ORLA_CONTRACT_URL=<url> node scripts/check-contract-ahead.mjs   # another deployment
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PRODUCTION_CONTRACT = "https://app.orla.finance/api/mcp/personal/contract.json";

const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);

/** What the copy changes about tools production already has; empty when the copy may merge. */
export function changedExistingTools(copy, production) {
  const live = new Map((production.tools ?? []).map((tool) => [tool.name, tool]));
  const problems = [];
  for (const tool of copy.tools ?? []) {
    const current = live.get(tool.name);
    if (current && canonical(current) !== canonical(tool)) {
      problems.push({ name: tool.name, copy: tool, production: current });
    }
  }
  return problems;
}

/** Tools the copy carries that production does not list yet: allowed, printed. */
export function newTools(copy, production) {
  const live = new Set((production.tools ?? []).map((tool) => tool.name));
  return (copy.tools ?? []).map((tool) => tool.name).filter((name) => !live.has(name));
}

async function readProduction(url) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (!Array.isArray(body.tools)) throw new Error("the answer has no `tools` list");
      return body;
    } catch (error) {
      last = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 3_000 * attempt));
    }
  }
  throw last;
}

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const copy = JSON.parse(readFileSync(join(root, "contracts", "mcp-personal-tools.json"), "utf8"));
  const url = process.env.ORLA_CONTRACT_URL || PRODUCTION_CONTRACT;

  let production;
  try {
    production = await readProduction(url);
  } catch (error) {
    console.error(
      `Could not read the door's contract from production (${url}): ${error.message}.\n` +
        "This step cannot tell whether the copy changes a tool that already exists, so it does not pass.\n" +
        "Re-run the job once the address answers.",
    );
    return 1;
  }

  const ahead = newTools(copy, production);
  if (ahead.length) console.log(`New tools ahead of production (allowed): ${ahead.join(", ")}`);

  const changed = changedExistingTools(copy, production);
  if (!changed.length) {
    console.log(`The copy agrees with production on every tool both list (${copy.tools.length - ahead.length}).`);
    return 0;
  }
  for (const { name, copy: mine, production: live } of changed) {
    console.error(`${name} differs from production:`);
    console.error(`  copy:       ${canonical(mine)}`);
    console.error(`  production: ${canonical(live)}`);
  }
  console.error(
    "\nA tool that already exists on production may change in this copy only once the change is live there.\n" +
      "Keep the production record here now, and publish the change after the Orla side has landed and deployed.",
  );
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
