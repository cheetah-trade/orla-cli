#!/usr/bin/env node
/**
 * `orla`: the terminal door into the same MCP surface Claude uses.
 *
 * Argument parsing is by hand and stays that way: a dependency-free CLI is one
 * `npx orla` with nothing to install and nothing to audit, and the grammar here
 * is a dozen commands with flags.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_API, login } from "./auth.js";
import {
  accounts,
  printFailure,
  printJson,
  resolveSpace,
  spaces,
  txAdd,
  txExport,
  txList,
  whoami,
} from "./commands.js";
import { describe, notConnected, usage } from "./errors.js";
import { bridge, listTools } from "./mcp.js";
import { need, optional, parse } from "./args.js";
import type { Flags } from "./args.js";
import { clear, load, save } from "./store.js";
import { COMMANDS, USAGE } from "./usage.js";

/**
 * Read from the manifest rather than repeated in the source, because two
 * places to write a version number is one place to forget it. `npm publish`
 * always ships package.json, so this resolves inside the installed package.
 */
function version(): string {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
  return manifest.version ?? "unknown";
}

async function run(argv: string[]): Promise<void> {
  const { words, flags } = parse(argv);
  const command = words[0] ?? "";
  const json = flags["json"] === true;

  if (command === "version" || flags["version"] === true) {
    if (json) return printJson({ version: version() });
    process.stdout.write(`${version()}\n`);
    return;
  }

  if (!command || command === "help" || flags["help"] === true) {
    if (json) return printJson({ commands: COMMANDS });
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  if (command === "login") {
    const session = await login(optional(flags, "api") ?? DEFAULT_API);
    process.stderr.write(`connected to ${session.apiBase}\n`);
    if (json) return printJson({ api: session.apiBase, connection: await whoami() });
    await whoamiSummary();
    return;
  }

  if (command === "logout") {
    clear();
    if (json) return printJson({ forgotten: true });
    process.stderr.write("session forgotten\n");
    return;
  }

  if (command === "mcp") {
    await bridge(optional(flags, "api") ?? DEFAULT_API);
    return;
  }

  if (command === "whoami") {
    const me = await whoami();
    if (json) return printJson(me);
    await whoamiSummary();
    return;
  }

  if (command === "spaces") {
    await spaces(json);
    return;
  }

  if (command === "use") {
    const spaceId = words[1];
    if (!spaceId) throw usage("orla use <space-id>");
    const session = load();
    if (!session) throw notConnected();
    save({ ...session, defaultSpaceId: spaceId });
    if (json) return printJson({ default_space_id: spaceId });
    process.stderr.write(`default space is now ${spaceId}\n`);
    return;
  }

  if (command === "tools") {
    const tools = await listTools();
    if (json) return printJson(tools);
    for (const tool of tools) process.stdout.write(`${tool.name}\n`);
    return;
  }

  if (!["accounts", "export", "tx"].includes(command)) {
    throw usage(`unknown command: ${command}\n\n${USAGE}`);
  }

  const spaceId = await resolveSpace(optional(flags, "space"));

  if (command === "accounts") {
    await accounts(spaceId, json);
    return;
  }

  if (command === "export") {
    await txExport(filterFrom(spaceId, flags, 500), json);
    return;
  }

  const sub = words[1] ?? "list";
  if (sub === "list") {
    await txList(filterFrom(spaceId, flags, 50), json);
    return;
  }
  if (sub === "add") {
    await txAdd(
      spaceId,
      {
        account: need(flags, "account"),
        kind: optional(flags, "kind") ?? "expense",
        amount: need(flags, "amount"),
        date: optional(flags, "date") ?? new Date().toISOString().slice(0, 10),
        payee: optional(flags, "payee"),
        note: optional(flags, "note"),
      },
      json,
    );
    return;
  }
  throw usage(`unknown: orla tx ${sub}`);
}

function filterFrom(spaceId: string, flags: Flags, fallbackLimit: number) {
  return {
    spaceId,
    from: optional(flags, "from"),
    to: optional(flags, "to"),
    search: optional(flags, "search"),
    account: optional(flags, "account"),
    limit: Number(optional(flags, "limit") ?? fallbackLimit),
  };
}

async function whoamiSummary(): Promise<void> {
  const me = (await whoami()) as {
    name?: string;
    owner_name?: string;
    spaces?: { id: string; name: string }[];
  };
  process.stdout.write(`${me.name ?? "connection"} for ${me.owner_name ?? "you"}\n`);
  for (const space of me.spaces ?? []) {
    process.stdout.write(`  ${space.id}  ${space.name}\n`);
  }
}

const argv = process.argv.slice(2);
run(argv).catch((err: unknown) => {
  // The failure goes where the answer would have gone: with --json it is the
  // envelope on stdout, so a program reads one stream and one shape; without
  // it, a line on stderr. The exit status says which kind of failure either way.
  if (parse(argv).flags["json"] === true) {
    printFailure(err);
  } else {
    process.stderr.write(`orla: ${describe(err).message}\n`);
  }
  process.exitCode = describe(err).exit;
});
