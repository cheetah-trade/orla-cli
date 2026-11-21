#!/usr/bin/env node
/**
 * `orla`: the terminal door into the same MCP surface Claude uses.
 *
 * Argument parsing is by hand and stays that way: a dependency-free CLI is one
 * `npx orla` with nothing to install and nothing to audit, and the grammar here
 * is a dozen commands with flags.
 */

import { createInterface } from "node:readline/promises";

import { DEFAULT_API, login, revoke } from "./auth.js";
import {
  accounts,
  feedback,
  isFeedbackKind,
  localToday,
  PAGE,
  parseLimit,
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
import { version } from "./version.js";
import { COMMANDS, USAGE } from "./usage.js";

/**
 * Read from the manifest rather than repeated in the source, because two
 * places to write a version number is one place to forget it. `npm publish`
 * always ships package.json, so this resolves inside the installed package.
 */

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
    // The personal door by default: it is the one that holds no tool that moves
    // money, and it is what this client says about itself in its readme.
    const session = await login(optional(flags, "api") ?? DEFAULT_API, flags["agent"] === true ? "agent" : "personal");
    process.stderr.write(`connected to ${session.apiBase}${session.door === "agent" ? " (agent door)" : " (your own books)"}\n`);
    if (json) return printJson({ api: session.apiBase, connection: await whoami() });
    await whoamiSummary();
    return;
  }

  if (command === "logout") {
    // Revoked on Orla first, then forgotten here, and forgotten whatever Orla
    // said: a local copy kept because the server was down is the worse outcome.
    const session = load();
    const outcome = session ? await revoke(session) : null;
    clear();
    if (json) return printJson({ forgotten: true, ...(outcome ?? { revoked: false, reason: "no_session" }) });
    if (!session) {
      process.stderr.write("no session was stored on this machine\n");
    } else if (outcome?.revoked) {
      process.stderr.write("connection revoked on Orla and forgotten on this machine\n");
    } else {
      process.stderr.write(
        `session forgotten on this machine only: ${outcome?.detail}.\n` +
          "The tokens still work wherever a copy of them is. Revoke this connection in Orla under Agents.\n",
      );
    }
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

  if (command === "feedback") {
    // `--yes "text"` would otherwise read the text as the flag's value
    if (typeof flags["yes"] === "string") {
      words.push(flags["yes"]);
      flags["yes"] = true;
    }
    const kind = words[1];
    const text = words.slice(2).join(" ");
    if (!isFeedbackKind(kind) || !text.trim()) throw usage('orla feedback <bug|idea|problem> "text" [--yes] [--space <id>]');
    // no default space here: a report names a space only when the person does
    await feedback(kind, text, { spaceId: optional(flags, "space"), yes: flags["yes"] === true, json }, confirm);
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

  // Before the space is resolved: a bad --limit is the command line's fault and
  // says so without a single request.
  const sub = words[1] ?? "list";
  const limit =
    command === "export"
      ? parseLimit(optional(flags, "limit"))
      : command === "tx" && sub === "list"
        ? (parseLimit(optional(flags, "limit"), PAGE) ?? 50)
        : undefined;

  const spaceId = await resolveSpace(optional(flags, "space"));

  if (command === "accounts") {
    await accounts(spaceId, json);
    return;
  }

  if (command === "export") {
    await txExport(filterFrom(spaceId, flags, limit), json);
    return;
  }

  if (sub === "list") {
    await txList(filterFrom(spaceId, flags, limit), json);
    return;
  }
  if (sub === "add") {
    await txAdd(
      spaceId,
      {
        account: need(flags, "account"),
        kind: optional(flags, "kind") ?? "expense",
        amount: need(flags, "amount"),
        date: optional(flags, "date") ?? localToday(),
        payee: optional(flags, "payee"),
        note: optional(flags, "note"),
      },
      json,
    );
    return;
  }
  throw usage(`unknown: orla tx ${sub}`);
}

function filterFrom(spaceId: string, flags: Flags, limit: number | undefined) {
  return {
    spaceId,
    from: optional(flags, "from"),
    to: optional(flags, "to"),
    search: optional(flags, "search"),
    account: optional(flags, "account"),
    limit,
  };
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
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
