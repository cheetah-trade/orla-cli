/**
 * The commands themselves. Each one is a tool call and a way of printing it.
 *
 * Printing is deliberately two-headed: a table for a person and `--json` for a
 * pipe. A CLI that only pretty-prints gets parsed with `awk` by the second
 * user, and then the column widths are an API nobody agreed to.
 */

import { randomUUID } from "node:crypto";

import { callTool } from "./mcp.js";
import { load, save } from "./store.js";

type Row = Record<string, unknown>;

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
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
  if (spaces.length === 0) {
    throw new Error("this connection reaches no spaces; re-run `orla login` and tick one");
  }
  const names = spaces.map((s) => `  ${s.id}  ${s.name}`).join("\n");
  throw new Error(`several spaces are in reach, name one with --space:\n${names}`);
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
  limit: number;
};

async function fetchTransactions(filter: TxFilter): Promise<Row[]> {
  const data = (await callTool("orla_list_transactions", {
    space_id: filter.spaceId,
    date_from: filter.from,
    date_to: filter.to,
    search: filter.search,
    account_id: filter.account,
    limit: filter.limit,
  })) as { items?: Row[]; transactions?: Row[] };
  return data.items ?? data.transactions ?? [];
}

export async function txList(filter: TxFilter, json: boolean): Promise<void> {
  const rows = await fetchTransactions(filter);
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
export async function txExport(filter: TxFilter): Promise<void> {
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
