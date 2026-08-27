#!/usr/bin/env node
/**
 * `orla` — the terminal door into the same MCP surface Claude uses.
 *
 * Argument parsing is by hand and stays that way: a dependency-free CLI is one
 * `npx orla` with nothing to install and nothing to audit, and the grammar here
 * is five commands with flags.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_API, login } from "./auth.js";
import {
  accounts,
  printJson,
  resolveSpace,
  spaces,
  txAdd,
  txExport,
  txList,
  whoami,
} from "./commands.js";
import { bridge, listTools } from "./mcp.js";
import { clear, load, save } from "./store.js";

const USAGE = `orla — your Orla books from the terminal

  orla login [--api URL]        connect this machine (opens a browser)
  orla logout                   forget the stored session
  orla whoami                   who this connection is, and what it reaches
  orla spaces                   the spaces in reach
  orla use <space-id>           remember a space as the default
  orla accounts                 accounts in the space
  orla tx list                  transactions (--from --to --search --account --limit)
  orla tx add                   record one (--account --kind --amount --date [--payee --note])
  orla export                   the same rows as CSV on stdout
  orla tools                    which tools this connection is given
  orla mcp                      stdio bridge, for clients that cannot speak HTTP
  orla version                  which version this is

Flags: --space <id> on anything space-scoped, --json for machine output.
A personal connection reads and records. It cannot pay anyone.`;

type Flags = Record<string, string | boolean>;

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

function parse(argv: string[]): { words: string[]; flags: Flags } {
  const words: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) {
      words.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[name] = true;
    } else {
      flags[name] = next;
      i += 1;
    }
  }
  return { words, flags };
}

function need(flags: Flags, name: string): string {
  const value = flags[name];
  if (typeof value !== "string" || !value) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function optional(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

async function run(argv: string[]): Promise<void> {
  const { words, flags } = parse(argv);
  const command = words[0] ?? "";
  const json = flags["json"] === true;

  if (command === "version" || flags["version"] === true) {
    process.stdout.write(`${version()}\n`);
    return;
  }

  if (!command || command === "help" || flags["help"] === true) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  if (command === "login") {
    const session = await login(optional(flags, "api") ?? DEFAULT_API);
    process.stderr.write(`connected to ${session.apiBase}\n`);
    await whoamiSummary();
    return;
  }

  if (command === "logout") {
    clear();
    process.stderr.write("session forgotten\n");
    return;
  }

  if (command === "mcp") {
    await bridge();
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
    if (!spaceId) throw new Error("orla use <space-id>");
    const session = load();
    if (!session) throw new Error("not connected: run `orla login` first");
    save({ ...session, defaultSpaceId: spaceId });
    process.stderr.write(`default space is now ${spaceId}\n`);
    return;
  }

  if (command === "tools") {
    const tools = await listTools();
    if (json) return printJson(tools);
    for (const tool of tools) process.stdout.write(`${tool.name}\n`);
    return;
  }

  const spaceId = await resolveSpace(optional(flags, "space"));

  if (command === "accounts") {
    await accounts(spaceId, json);
    return;
  }

  if (command === "export") {
    await txExport(filterFrom(spaceId, flags, 500));
    return;
  }

  if (command === "tx") {
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
    throw new Error(`unknown: orla tx ${sub}`);
  }

  throw new Error(`unknown command: ${command}\n\n${USAGE}`);
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

run(process.argv.slice(2)).catch((err: Error) => {
  process.stderr.write(`orla: ${err.message}\n`);
  process.exitCode = 1;
});
