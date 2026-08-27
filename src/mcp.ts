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

import { createInterface } from "node:readline";

import { accessToken } from "./auth.js";

export const PROTOCOL_VERSION = "2026-07-28";

export type Rpc = { jsonrpc: "2.0"; id?: unknown; method?: string; params?: unknown; result?: unknown; error?: unknown };

async function post(body: unknown, extraHeaders: Record<string, string> = {}): Promise<Rpc> {
  const { token, session } = await accessToken();
  const res = await fetch(`${session.apiBase}/mcp`, {
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
  if (!text) throw new Error(`Orla answered ${res.status} with an empty body`);
  return JSON.parse(text) as Rpc;
}

/**
 * Call one tool and return its payload.
 *
 * A tool refusal comes back as a RESULT with `isError`, not as a protocol
 * error, so the model on the other end can read it. A CLI has no model, so it
 * is turned back into a thrown message here and printed like any other failure.
 */
export async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const answer = await post(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    { "Mcp-Method": "tools/call", "Mcp-Name": name },
  );
  const error = answer.error as { message?: string } | undefined;
  if (error) throw new Error(error.message ?? "Orla refused the call");
  const result = answer.result as
    | { isError?: boolean; content?: { text?: string }[]; structuredContent?: { data?: unknown } }
    | undefined;
  if (!result) throw new Error("Orla answered without a result");
  if (result.isError) {
    throw new Error(result.content?.[0]?.text ?? "refused");
  }
  return result.structuredContent?.data;
}

export async function listTools(): Promise<{ name: string; description?: string }[]> {
  const answer = await post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { "Mcp-Method": "tools/list" });
  const result = answer.result as { tools?: { name: string; description?: string }[] } | undefined;
  return result?.tools ?? [];
}

/**
 * Relay stdio JSON-RPC to the HTTP endpoint, one line in, one line out.
 *
 * Notifications (no `id`) are forwarded and answered with nothing, which is
 * what the transport asks for. Anything that fails locally still comes back as
 * a JSON-RPC error rather than a dead pipe: a client whose bridge exits without
 * a word reports "server crashed" and the person never sees the real reason.
 */
export async function bridge(): Promise<void> {
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let request: Rpc;
    try {
      request = JSON.parse(trimmed) as Rpc;
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`,
      );
      continue;
    }
    try {
      const headers: Record<string, string> = request.method
        ? { "Mcp-Method": String(request.method) }
        : {};
      const answer = await post(request, headers);
      if (request.id === undefined || request.id === null) continue;
      process.stdout.write(`${JSON.stringify(answer)}\n`);
    } catch (err) {
      if (request.id === undefined || request.id === null) continue;
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32000, message: (err as Error).message },
        })}\n`,
      );
    }
  }
}
