/**
 * The commands themselves. Each one is a tool call and a way of printing it.
 *
 * Printing is deliberately two-headed: a table for a person and `--json` for a
 * pipe. A CLI that only pretty-prints gets parsed with `awk` by the second
 * user, and then the column widths are an API nobody agreed to.
 */

import { randomUUID } from "node:crypto";

import { describe, noSpaces, spaceRequired, usage } from "./errors.js";
import { callTool } from "./mcp.js";
import { load, save } from "./store.js";

type Row = Record<string, unknown>;

/**
 * `--json` output is one envelope for every command: `{ok:true,data}` on
 * success and `{ok:false,error:{code,message}}` on failure, both on stdout.
 * A program reads `ok`, then branches on `error.code`; it never has to guess
 * from the shape of the data whether the call worked.
 */
export function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify({ ok: true, data }, null, 2)}\n`);
}

export function printFailure(err: unknown): void {
  const { code, message, details } = describe(err);
  const error = details === undefined ? { code, message } : { code, message, details };
  process.stdout.write(`${JSON.stringify({ ok: false, error }, null, 2)}\n`);
}

/** A table narrow enough for a terminal, with the columns named up front. */
export function printTable(rows: Row[], columns: string[]): void {
  if (rows.length === 0) {
    process.stdout.write("nothing here\n");
    return;
  }
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (cells: string[]) =>
    cells.map((cell, i) => cell.padEnd(widths[i] ?? cell.length)).join("  ").trimEnd();
  process.stdout.write(`${line(columns)}\n`);
  for (const row of rows) {
    process.stdout.write(`${line(columns.map((c) => String(row[c] ?? "")))}\n`);
  }
}

/** RFC 4180 enough for a spreadsheet: quote when the value could break a cell. */
export function toCsv(rows: Row[], columns: string[]): string {
  const cell = (value: unknown) => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\n");
}

/**
 * `--limit` read before any request: a number Orla would refuse is said here,
 * with the bound, instead of coming back as the server's validation error.
 */
export function parseLimit(raw: string | undefined, max?: number): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw usage(`--limit must be a whole number from 1, got ${raw}`);
  if (max !== undefined && n > max) {
    throw usage(`--limit is at most ${max} for this command, got ${raw}; \`orla export\` reads every row`);
  }
  return n;
}

export async function whoami(): Promise<Row> {
  return (await callTool("orla_whoami", {})) as Row;
}

/**
 * The space a command works in.
 *
 * Explicit flag first, then the one remembered at login, then the only space
 * there is. Guessing between several would put an entry in the wrong books,
 * which is the one mistake a bookkeeping CLI must not make quietly.
 */
export async function resolveSpace(flag?: string): Promise<string> {
  if (flag) return flag;
  const session = load();
  if (session?.defaultSpaceId) return session.defaultSpaceId;
  const me = (await whoami()) as { spaces?: { id: string; name: string }[] };
  const spaces = me.spaces ?? [];
  if (spaces.length === 1 && spaces[0]) {
    if (session) save({ ...session, defaultSpaceId: spaces[0].id });
    return spaces[0].id;
  }
  if (spaces.length === 0) throw noSpaces();
  throw spaceRequired(spaces);
}

export async function accounts(spaceId: string, json: boolean): Promise<void> {
  const data = (await callTool("orla_list_accounts", { space_id: spaceId })) as { accounts?: Row[] };
  const rows = data.accounts ?? [];
  if (json) return printJson(rows);
  printTable(rows, ["id", "name", "kind", "currency", "balance"]);
}

export async function spaces(json: boolean): Promise<void> {
  const me = (await whoami()) as { spaces?: Row[] };
  const rows = me.spaces ?? [];
  if (json) return printJson(rows);
  printTable(rows, ["id", "name", "kind", "base_currency", "preset"]);
}

export type TxFilter = {
  spaceId: string;
  from?: string;
  to?: string;
  search?: string;
  account?: string;
  /** How many rows at most; undefined means every row the filters match. */
  limit?: number;
};

/**
 * The most rows Orla serves in one call of `orla_list_transactions`
 * (`LIST_CAP` on the server). Asking for more is refused, not trimmed.
 */
export const PAGE = 200;

type TxPage = {
  items?: Row[];
  transactions?: Row[];
  total?: number;
  answer_truncated?: { next_offset?: number };
};

type Page = { rows: Row[]; total?: number; truncated: boolean; nextOffset?: number };

async function fetchPage(filter: TxFilter, offset: number, limit: number): Promise<Page> {
  const data = (await callTool("orla_list_transactions", {
    space_id: filter.spaceId,
    date_from: filter.from,
    date_to: filter.to,
    search: filter.search,
    account_id: filter.account,
    limit,
    offset,
  })) as TxPage;
  const cut = data.answer_truncated;
  const next = cut?.next_offset;
  return {
    rows: data.items ?? data.transactions ?? [],
    total: data.total,
    truncated: cut !== undefined && cut !== null,
    nextOffset: typeof next === "number" && Number.isInteger(next) && next > offset ? next : undefined,
  };
}

/**
 * Every row the filters match, a page of `PAGE` at a time.
 *
 * Until 0.5.1 `orla export` asked for 500 rows in one call, the server's
 * ceiling is 200, and every export ended in a refusal. The next page starts
 * where this one actually ended: at `answer_truncated.next_offset` when Orla
 * names it, else after the rows that came back, never at offset + limit. A
 * page Orla cut to fit its size ceiling is short without being the last, so
 * the walk goes on to `total`; only an uncut short page, or an empty one,
 * ends it when there is no total.
 */
async function fetchTransactions(filter: TxFilter): Promise<Row[]> {
  const rows: Row[] = [];
  let offset = 0;
  for (;;) {
    const remaining = filter.limit === undefined ? PAGE : filter.limit - rows.length;
    if (remaining <= 0) break;
    const want = Math.min(PAGE, remaining);
    const page = await fetchPage(filter, offset, want);
    rows.push(...page.rows);
    // nothing came back: going on would ask for the same window forever
    if (page.rows.length === 0) break;
    offset = page.nextOffset ?? offset + page.rows.length;
    if (page.total !== undefined) {
      if (offset >= page.total) break;
    } else if (page.rows.length < want && !page.truncated) {
      break;
    }
  }
  return rows;
}

export async function txList(filter: TxFilter, json: boolean): Promise<void> {
  const { rows } = await fetchPage(filter, 0, filter.limit ?? 50);
  if (json) return printJson(rows);
  printTable(rows, ["occurred_on", "kind", "signed_amount", "currency", "payee"]);
}

/**
 * The same rows as CSV, with ids resolved to names.
 *
 * A ledger names its account and its category as ids, which is right on the
 * wire and useless in a spreadsheet: the file is going to somebody's
 * accountant, and "8c9767bd" is not an answer to "which card was this".
 */
export async function txExport(filter: TxFilter, json = false): Promise<void> {
  const [rows, accountNames, categoryNames] = await Promise.all([
    fetchTransactions(filter),
    namesOf("orla_list_accounts", "accounts", filter.spaceId),
    namesOf("orla_list_categories", "categories", filter.spaceId),
  ]);
  const named = rows.map((row) => ({
    ...row,
    account: accountNames.get(String(row["account_id"] ?? "")) ?? row["account_id"],
    category: categoryNames.get(String(row["category_id"] ?? "")) ?? "",
  }));
  if (json) return printJson(named);
  process.stdout.write(
    `${toCsv(named, ["occurred_on", "kind", "signed_amount", "currency", "payee", "note", "category", "account"])}\n`,
  );
}

async function namesOf(tool: string, key: string, spaceId: string): Promise<Map<string, string>> {
  const data = (await callTool(tool, { space_id: spaceId })) as Record<string, Row[]>;
  return new Map((data[key] ?? []).map((row) => [String(row["id"]), String(row["name"] ?? "")]));
}

export async function txAdd(
  spaceId: string,
  input: { account: string; kind: string; amount: string; date: string; payee?: string; note?: string },
  json: boolean,
): Promise<void> {
  // Generated here rather than server-side: the point of the key is that a
  // retry of THIS invocation is recognised, and only the caller knows that a
  // second run is the same intent as the first.
  const created = await callTool("orla_book_transaction", {
    space_id: spaceId,
    account_id: input.account,
    kind: input.kind,
    amount: input.amount,
    occurred_on: input.date,
    payee: input.payee ?? "",
    note: input.note ?? "",
    idempotency_key: randomUUID(),
  });
  if (json) return printJson(created);
  // A write comes back in an envelope, not as the row: `applied` is false when
  // the connection is still queuing writes for a person, and printing "booked"
  // over that would be a lie the next command contradicts.
  const out = created as { applied?: boolean; message?: string; result?: Row };
  if (out.applied === false) {
    process.stdout.write(`${out.message || "queued for a person to accept"}\n`);
    return;
  }
  // The envelope carries the new row's id and nothing else, so the line is
  // built from what was asked for plus that id.
  const id = String((out.result ?? {})["transaction_id"] ?? "");
  process.stdout.write(
    `booked ${input.amount} ${input.payee ?? ""} ${id && `(${id})`}`.replace(/\s+/g, " ").trim() + "\n",
  );
}

/** What `orla feedback` may send. `tool_error` is the AI client's own report and has no command. */
export const FEEDBACK_KINDS = ["bug", "idea", "problem"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
/** The server's bounds on the text (`orla_send_feedback`), checked here before any request. */
const FEEDBACK_MIN = 3;
const FEEDBACK_MAX = 4000;

export function isFeedbackKind(kind: string | undefined): kind is FeedbackKind {
  return (FEEDBACK_KINDS as readonly string[]).includes(kind ?? "");
}

/**
 * Send a bug, a problem or an idea to the Orla team, after the person has seen
 * it. The text goes to people, so it is shown before it leaves: a terminal is
 * asked, and without one only `--yes` sends, because a script that hangs on a
 * question it cannot see is worse than one told what to pass.
 */
export async function feedback(
  kind: FeedbackKind,
  text: string,
  options: { spaceId?: string; yes: boolean; json: boolean },
  ask: (question: string) => Promise<boolean>,
): Promise<void> {
  const words = text.trim();
  if (words.length < FEEDBACK_MIN || words.length > FEEDBACK_MAX) {
    throw usage(`the text is ${FEEDBACK_MIN} to ${FEEDBACK_MAX} characters, got ${words.length}`);
  }
  if (!options.yes) {
    if (!process.stdin.isTTY) throw usage("not a terminal to ask in: pass --yes to send without the question");
    process.stderr.write(`To the Orla team, as ${kind}:\n\n${words}\n\n`);
    if (!(await ask("Send this? [y/N] "))) {
      if (options.json) return printJson({ sent: false });
      process.stderr.write("not sent\n");
      return;
    }
  }
  const args: Record<string, unknown> = { kind, text: words };
  if (options.spaceId) args["space_id"] = options.spaceId;
  const answer = (await callTool("orla_send_feedback", args)) as Row;
  if (options.json) return printJson(answer);
  process.stderr.write(
    answer["already_sent"] ? "already sent a moment ago; not sent twice\n" : "sent to the Orla team, thank you\n",
  );
}
