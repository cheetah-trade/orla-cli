/**
 * `orla fetch`: the one command on the AGENT door.
 *
 * Everything else in this CLI is the personal connection, which reads and
 * records and cannot pay. This is different on purpose and says so: it never
 * touches the stored session, it authenticates with an agent key taken from
 * the environment, and it asks Orla to fetch a URL and pay its 402 from that
 * agent's own float, inside the ceilings the owner set in the app. Nothing is
 * signed here; the CLI carries the request and prints the receipt.
 *
 * Why the environment and not a stored key: an agent key is a live credential
 * to a wallet, shown once. A process that holds it in its environment for the
 * length of one run is the narrowest way to lend it to a shell, and it is how
 * every other agent SDK is configured. `orla login` stays a person's door.
 */

import { randomUUID } from "node:crypto";

import { reach } from "./auth.js";
import { agentNoSpaces, badAnswer, keyRefused, noAgentKey, refused, spaceRequired, usage } from "./errors.js";

/** What Orla answers to a mutating agent call, with the x402 result inside. */
export type Fetched = {
  applied?: boolean;
  proposal_id?: string | null;
  message?: string;
  result?: {
    paid?: boolean;
    status?: number;
    body?: string;
    amount_usd?: string;
    host?: string;
    tx_hash?: string | null;
  } | null;
};

/** The REST error body: `{error, detail, details}`. */
type Refusal = { error?: string; detail?: string; details?: unknown };

/** The key, from the environment only. Never read from a file and never stored. */
export function agentKey(): string {
  const key = process.env["ORLA_AGENT_KEY"]?.trim();
  if (!key) throw noAgentKey();
  return key;
}

/**
 * One call on the agent REST door.
 *
 * A refusal keeps the server's own code, as the MCP client does, so a program
 * branches on `agent.x402_host_not_allowed` and not on prose. A 401 is the key
 * itself being refused (revoked, mistyped, from another deployment), which is
 * "not connected" for a script, not a refusal of one command.
 */
export async function agentCall(
  apiBase: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<unknown> {
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${agentKey()}`,
  };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["Idempotency-Key"] = idempotencyKey ?? randomUUID();
  }
  const res = await reach(`${apiBase}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw badAnswer(`Orla answered ${res.status} with something that is not JSON`);
    }
  }
  if (res.ok) {
    if (parsed === undefined) throw badAnswer(`Orla answered ${res.status} with an empty body`);
    return parsed;
  }
  const why = (parsed ?? {}) as Refusal;
  const code = why.error ?? `http_${res.status}`;
  const message = why.detail ?? `Orla answered ${res.status}`;
  if (res.status === 401) throw keyRefused(code, message);
  throw refused(code, message, why.details);
}

/**
 * The space an agent command works in: the flag, else the only space the key
 * reaches. Several spaces and no flag is a refusal, as on the personal door:
 * a purchase charged to the wrong books is not a mistake to make quietly.
 */
export async function resolveAgentSpace(apiBase: string, flag?: string): Promise<string> {
  if (flag) return flag;
  const me = (await agentCall(apiBase, "GET", "/agent/me")) as { spaces?: { id: string; name: string }[] };
  const spaces = me.spaces ?? [];
  if (spaces.length === 1 && spaces[0]) return spaces[0].id;
  if (spaces.length === 0) throw agentNoSpaces();
  throw spaceRequired(spaces);
}

/** A URL the server could fetch at all; the rest of the checks are Orla's. */
export function checkUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw usage(`orla fetch <url>: not a URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw usage(`orla fetch <url>: the url must start with https://`);
  }
  return url;
}

export async function fetchPaid(
  apiBase: string,
  spaceId: string,
  url: string,
  idempotencyKey?: string,
): Promise<Fetched> {
  const path = `/agent/spaces/${encodeURIComponent(spaceId)}/x402`;
  return (await agentCall(apiBase, "POST", path, { url: checkUrl(url) }, idempotencyKey)) as Fetched;
}

/**
 * For a person: the resource on stdout, so `orla fetch URL > answer.json`
 * does what it looks like, and the receipt on stderr. Whether money moved is
 * read from `paid`, never guessed from the status: a URL that never asked for
 * money is the common case, and printing "paid" over it would be a lie.
 */
export function printFetched(out: Fetched): void {
  if (out.applied === false) {
    process.stderr.write(`${out.message || "queued for a person to accept"}\n`);
    return;
  }
  const r = out.result ?? {};
  const body = String(r.body ?? "");
  if (body) process.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
  const receipt = r.paid
    ? `paid ${r.amount_usd ?? "?"} USD to ${r.host ?? "the host"}${r.tx_hash ? `, tx ${r.tx_hash}` : ""}`
    : "no charge";
  process.stderr.write(`${receipt} (HTTP ${r.status ?? "?"})\n`);
}
