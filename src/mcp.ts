/**
 * The one way this CLI talks to Orla: the MCP endpoint.
 *
 * There is no second REST client here on purpose. Every command below is a tool
 * call, so `orla tx add` and "book that expense" typed at Claude go through the
 * same authorization, the same idempotency and the same audit row. A CLI with
 * its own API surface would be a second door to keep in step with the first,
 * and the two would drift the first time one of them gained a check.
 *
 * `bridge()` is the other half: clients that only speak stdio (several desktop
 * MCP clients still do) get a process that relays JSON-RPC to the HTTP endpoint
 * and holds the token, so a person who cannot paste a remote connector URL is
 * not locked out of the product.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { accessToken, DEFAULT_API, doorPath, login, reach } from "./auth.js";
import { badAnswer, describe, refused } from "./errors.js";
import { load } from "./store.js";

export const PROTOCOL_VERSION = "2026-07-28";

export type Rpc = { jsonrpc: "2.0"; id?: unknown; method?: string; params?: unknown; result?: unknown; error?: unknown };

async function post(body: unknown, extraHeaders: Record<string, string> = {}): Promise<Rpc> {
  const { token, session } = await accessToken();
  const res = await reach(`${session.apiBase}${doorPath(session)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  if (res.status === 202) return { jsonrpc: "2.0" };
  const text = await res.text();
  if (!text) throw badAnswer(`Orla answered ${res.status} with an empty body`);
  try {
    return JSON.parse(text) as Rpc;
  } catch {
    throw badAnswer(`Orla answered ${res.status} with something that is not JSON`);
  }
}

/** The shape a refusal comes back in: the REST error body, under the untrusted-data notice. */
type Refusal = { data?: { error?: string; detail?: string; details?: unknown } };

/**
 * Call one tool and return its payload.
 *
 * A tool refusal comes back as a RESULT with `isError`, not as a protocol
 * error, so the model on the other end can read it. A CLI has no model, so it
 * is turned back into a thrown failure here, keeping the server's code: the
 * same `mcp.unknown_tool` or `validation_error` the REST API would name, so a
 * program can branch on it instead of parsing prose.
 */
export async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const answer = await post(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    { "Mcp-Method": "tools/call", "Mcp-Name": name },
  );
  const error = answer.error as { code?: number; message?: string; data?: unknown } | undefined;
  if (error) throw refused("mcp.rpc_error", error.message ?? "Orla refused the call", error);
  const result = answer.result as
    | { isError?: boolean; content?: { text?: string }[]; structuredContent?: Refusal & { data?: unknown } }
    | undefined;
  if (!result) throw badAnswer("Orla answered without a result");
  if (result.isError) {
    const body = (result.structuredContent as Refusal | undefined)?.data;
    const text = result.content?.[0]?.text ?? "refused";
    throw refused(body?.error ?? "orla.refused", body?.detail ?? text, body?.details);
  }
  return result.structuredContent?.data;
}

export async function listTools(): Promise<{ name: string; description?: string }[]> {
  const answer = await post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { "Mcp-Method": "tools/list" });
  const result = answer.result as { tools?: { name: string; description?: string }[] } | undefined;
  return result?.tools ?? [];
}

function version(): string {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
  return manifest.version ?? "unknown";
}

const line = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

/**
 * What the bridge does while this machine has no session.
 *
 * A client that spawned the bridge has no terminal to type `orla login` into:
 * Claude Desktop launches it from a bundle, other clients from a config file.
 * So the bridge signs in by itself, with the same browser flow `orla login`
 * uses, and stays a well-formed MCP server while the person is in the browser:
 * `initialize` and `ping` are answered here, `tools/list` is empty, and any
 * tool call is refused with a reason that names the browser tab. When the
 * sign-in lands, the client is told the tool list changed and asks again.
 *
 * A failed sign-in (the tab closed, the state came back wrong) is retried on
 * the next request, but not sooner than a pause: a client that polls would
 * otherwise open a browser tab per poll.
 */
class SignIn {
  private pending: Promise<void> | null = null;
  private lastFailure = 0;
  private static readonly RETRY_AFTER_MS = 30_000;

  constructor(private readonly apiBase: string) {}

  /** True once a session exists; starts the sign-in if none is running. */
  ready(): boolean {
    if (load()) return true;
    if (!this.pending && Date.now() - this.lastFailure > SignIn.RETRY_AFTER_MS) {
      this.pending = login(this.apiBase)
        .then(() => {
          line({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
        })
        .catch((err: unknown) => {
          this.lastFailure = Date.now();
          process.stderr.write(`orla: sign-in did not complete (${describe(err).message})\n`);
        })
        .finally(() => {
          this.pending = null;
        });
    }
    return false;
  }

  /** The answer to a request that arrived while nobody is signed in yet. */
  answer(request: Rpc): Rpc | null {
    if (request.id === undefined || request.id === null) return null;
    const params = request.params as { protocolVersion?: string } | undefined;
    switch (request.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "orla-cli", version: version() },
          },
        };
      case "ping":
        return { jsonrpc: "2.0", id: request.id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id: request.id, result: { tools: [] } };
      default:
        return {
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32000,
            message:
              "Orla sign-in is in progress: finish it in the browser tab that opened. " +
              "If no tab opened, open the URL this server printed on stderr.",
            data: { code: "cli.sign_in_in_progress" },
          },
        };
    }
  }
}

/**
 * Relay stdio JSON-RPC to the HTTP endpoint, one line in, one line out.
 *
 * Notifications (no `id`) are forwarded and answered with nothing, which is
 * what the transport asks for. Anything that fails locally still comes back as
 * a JSON-RPC error rather than a dead pipe: a client whose bridge exits without
 * a word reports "server crashed" and the person never sees the real reason.
 */
export async function bridge(apiBase: string = DEFAULT_API): Promise<void> {
  const signIn = new SignIn(apiBase);
  const lines = createInterface({ input: process.stdin });
  for await (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let request: Rpc;
    try {
      request = JSON.parse(trimmed) as Rpc;
    } catch {
      line({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    if (!signIn.ready()) {
      const local = signIn.answer(request);
      if (local) line(local);
      continue;
    }
    try {
      const headers: Record<string, string> = request.method ? { "Mcp-Method": String(request.method) } : {};
      const answer = await post(request, headers);
      if (request.id === undefined || request.id === null) continue;
      line(answer);
    } catch (err) {
      if (request.id === undefined || request.id === null) continue;
      const { code, message } = describe(err);
      line({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message, data: { code } } });
    }
  }
}
