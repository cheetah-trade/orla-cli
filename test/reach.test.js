/**
 * What a user sees when the network says no.
 *
 * Undici throws a bare `fetch failed` for DNS, TLS and refused connections
 * alike, and that message used to reach the user unchanged: `orla: fetch
 * failed`. It named neither the host nor the remedy, and the commonest cause
 * is a session stored against an Orla this machine can no longer reach.
 */
import { rejects } from "node:assert/strict";
import { test } from "node:test";
import { reach } from "../dist/auth.js";

test("a refused connection names the host and the way out", async () => {
  // Port 1 on the loopback: nothing listens there, on any machine.
  await rejects(
    () => reach("http://127.0.0.1:1/oauth/token", { method: "POST" }),
    (err) => {
      if (!/127\.0\.0\.1:1/.test(err.message)) throw new Error(`no host in: ${err.message}`);
      if (!/orla login/.test(err.message)) throw new Error(`no remedy in: ${err.message}`);
      if (/^fetch failed$/.test(err.message)) throw new Error("the bare message survived");
      return true;
    },
  );
});

test("a name that does not resolve is the same kind of answer", async () => {
  await rejects(
    () => reach("https://orla-cli-no-such-host.invalid/mcp", { method: "POST" }),
    (err) => /orla-cli-no-such-host\.invalid/.test(err.message) && /orla login/.test(err.message),
  );
});

test("a caller with no session to clear gets its own way out, and a timeout is the same kind of answer", async () => {
  // The agent door: `orla logout` would be advice about a thing that does not
  // exist there, so it passes what to check instead.
  await rejects(
    () => reach("http://127.0.0.1:1/agent/me", { method: "GET" }, "check --api"),
    (err) => {
      if (!/check --api/.test(err.message)) throw new Error(`no advice in: ${err.message}`);
      if (/orla login/.test(err.message)) throw new Error(`the session remedy leaked into: ${err.message}`);
      return err.code === "cli.unreachable";
    },
  );
  // A server that never answers, with a deadline: unreachable, not a hang.
  const { createServer } = await import("node:http");
  const server = createServer(() => {});
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    await rejects(
      () => reach(`http://127.0.0.1:${port}/slow`, { method: "GET", signal: AbortSignal.timeout(100) }, "check --api"),
      (err) => err.code === "cli.unreachable" && new RegExp(`127\\.0\\.0\\.1:${port}`).test(err.message),
    );
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test("a server that answers is passed straight through", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.writeHead(418, { "content-type": "text/plain" });
    res.end("teapot");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const res = await reach(`http://127.0.0.1:${port}/`, { method: "GET" });
    if (res.status !== 418) throw new Error(`expected the status through, got ${res.status}`);
  } finally {
    server.close();
  }
});
