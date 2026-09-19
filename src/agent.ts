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

import { DEFAULT_API, reach } from "./auth.js";
import { agentNoSpaces, badAnswer, keyRefused, noAgentKey, refused, spaceRequired, usage } from "./errors.js";

/**
 * How long one call on the agent door may take. Orla fetches the URL itself
 * and gives the host twenty seconds a hop, up to two redirects and the paid
 * request, then settles the payment; ninety seconds covers the slowest honest
 * answer with room to spare, and a call past it is a network failure (exit 5)
 * rather than a shell that hangs forever.
 */
export const AGENT_TIMEOUT_MS = 90_000;

/** The way out when the agent door cannot be reached: there is no session to clear. */
const AGENT_ADVICE = `If this machine is online, check the address --api points at (the default is ${DEFAULT_API}).`;

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
  const res = await reach(
    `${apiBase}${path}`,
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
    },
    AGENT_ADVICE,
  );
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

/**
 * A URL Orla would take at all, refused here before any network. The words
 * are the server's own (`agent.x402_scheme`, `agent.x402_url`), so a program
 * reads one message whichever side refused; the rest of the fence (the port,
 * the host, where its name resolves) stays Orla's, because only Orla resolves it.
 */
export function checkUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw usage(`orla fetch <url>: not a URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw usage("orla fetch <url>: the address must use https");
  }
  if (parsed.username || parsed.password) {
    throw usage("orla fetch <url>: credentials in the URL are not allowed");
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
 *
 * The body is written byte for byte when stdout is a pipe or a file: a
 * newline added for the terminal's sake would land inside the file too, and a
 * resource that ends without one is then not the resource. On a terminal the
 * prompt should not sit on the body's last line, so there one is added.
 */
export function printFetched(out: Fetched): void {
  if (out.applied === false) {
    process.stderr.write(`${out.message || "queued for a person to accept"}\n`);
    return;
  }
  const r = out.result ?? {};
  const body = String(r.body ?? "");
  if (body) process.stdout.write(process.stdout.isTTY && !body.endsWith("\n") ? `${body}\n` : body);
  const receipt = r.paid
    ? `paid ${r.amount_usd ?? "?"} USD to ${r.host ?? "the host"}${r.tx_hash ? `, tx ${r.tx_hash}` : ""}`
    : "no charge";
  process.stderr.write(`${receipt} (HTTP ${r.status ?? "?"})\n`);
}
