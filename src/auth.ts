/**
 * `orla login`: the ordinary OAuth code flow, with the browser doing the part
 * that needs a human.
 *
 * Nothing here is CLI-specific on the server side, and that is the point. The
 * CLI is an MCP client like any other: it is identified by a metadata document
 * at a fixed https URL, it uses S256 PKCE, and the consent page it lands on is
 * the same one Claude sends people to. So a token minted here obeys the same
 * grant, shows up in the same list and dies to the same revoke button.
 *
 * The redirect is loopback because that is where a terminal can listen, and the
 * ports are fixed because the server matches redirect_uri against the document
 * exactly. Three of them: one is enough until something else on the machine is
 * already holding it, which is exactly when a person is least able to debug it.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { platform } from "node:os";

import { load, save, type Session } from "./store.js";

//: The API's own origin, behind the `/api` ingress prefix — not the app's.
//: `app.orla.finance/oauth/authorize` is the frontend's 404 page.
export const DEFAULT_API = "https://app.orla.finance/api";

/** Published from the marketing site, and the only identity this client has. */
export const CLIENT_ID = "https://orla.finance/mcp-cli.json";
export const PORTS = [7654, 7655, 7656];

const SCOPE = "orla.read orla.write";

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function openBrowser(url: string): void {
  // Honoured by CI and by anyone on a machine whose browser is somewhere else:
  // the URL is printed either way, so refusing to launch anything is a complete
  // interface rather than a degraded one.
  if (process.env["ORLA_NO_BROWSER"]) return;
  const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true, shell: platform() === "win32" }).unref();
  } catch {
    // headless box: the printed URL below is the whole interface
  }
}

type Listener = { port: number; callback: Promise<URLSearchParams> };

/**
 * Listen on the first free published port.
 *
 * Returns as soon as the socket is bound, because the port belongs in the
 * authorization URL that has not been built yet; `callback` settles later, when
 * the browser comes back.
 */
async function startListener(): Promise<Listener> {
  for (const port of PORTS) {
    const listener = await bind(port);
    if (listener) return listener;
  }
  throw new Error(`ports ${PORTS.join(", ")} are all busy; free one and run orla login again`);
}

function bind(port: number): Promise<Listener | null> {
  return new Promise((resolve, reject) => {
    let settle: (params: URLSearchParams) => void = () => {};
    let fail: (err: Error) => void = () => {};
    const callback = new Promise<URLSearchParams>((res, rej) => {
      settle = res;
      fail = rej;
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><meta charset=utf-8><p>Connected. You can close this tab.</p>");
      server.close();
      settle(url.searchParams);
    });

    server.once("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        resolve(null);
        return;
      }
      fail(err);
      reject(err);
    });
    // Loopback only: binding 0.0.0.0 would put an authorization callback on the
    // local network for as long as the login takes.
    server.listen(port, "127.0.0.1", () => resolve({ port, callback }));
  });
}

/**
 * `fetch`, but a network failure says what it could not reach.
 *
 * Undici throws a bare `fetch failed` for DNS, TLS and refused connections
 * alike, and that message reaches the user unchanged: `orla: fetch failed`.
 * It names neither the host nor the remedy, and the commonest cause is a
 * session stored against an Orla this machine can no longer reach, which the
 * user has no way to guess.
 */
export async function reach(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return url;
      }
    })();
    const why = err instanceof Error && err.cause instanceof Error ? err.cause.message : (err as Error)?.message;
    throw new Error(
      `cannot reach ${host}${why ? ` (${why})` : ""}. ` +
        "If this machine is online, the stored session may point at an Orla that is gone: " +
        "`orla logout` and `orla login` again.",
    );
  }
}

async function postForm(url: string, body: Record<string, string>): Promise<Record<string, string>> {
  const res = await reach(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json()) as Record<string, string>;
  if (!res.ok) {
    throw new Error(json["error_description"] || json["error"] || `token endpoint said ${res.status}`);
  }
  return json;
}

export async function login(apiBase: string): Promise<Session> {
  const { verifier, challenge } = pkce();
  const state = randomBytes(16).toString("base64url");
  const resource = `${apiBase}/mcp`;

  // The port is only known once something is listening, so the listener binds
  // before the URL is built and the browser opens after.
  const listener = await startListener();
  const redirectUri = `http://127.0.0.1:${listener.port}/callback`;
  const authorize = new URL(`${apiBase}/oauth/authorize`);
  authorize.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: SCOPE,
    resource,
  }).toString();

  process.stderr.write(`Opening ${authorize.toString()}\n`);
  openBrowser(authorize.toString());

  const params = await listener.callback;
  if (params.get("state") !== state) {
    throw new Error("the callback carried a different state; nothing was connected");
  }
  const code = params.get("code");
  if (!code) throw new Error(params.get("error") ?? "no code came back");

  const tokens = await postForm(`${apiBase}/oauth/token`, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: verifier,
    resource,
  });
  const session: Session = {
    apiBase,
    accessToken: tokens["access_token"] ?? "",
    refreshToken: tokens["refresh_token"] ?? "",
    expiresAt: Date.now() + Number(tokens["expires_in"] ?? 0) * 1000,
  };
  save(session);
  return session;
}

/** A live access token, refreshed if the stored one is about to expire. */
export async function accessToken(): Promise<{ token: string; session: Session }> {
  const session = load();
  if (!session) {
    throw new Error("not connected: run `orla login` first");
  }
  if (session.expiresAt - 60_000 > Date.now()) {
    return { token: session.accessToken, session };
  }
  const tokens = await postForm(`${session.apiBase}/oauth/token`, {
    grant_type: "refresh_token",
    refresh_token: session.refreshToken,
    client_id: CLIENT_ID,
    resource: `${session.apiBase}/mcp`,
  });
  const refreshed: Session = {
    ...session,
    accessToken: tokens["access_token"] ?? "",
    refreshToken: tokens["refresh_token"] ?? "",
    expiresAt: Date.now() + Number(tokens["expires_in"] ?? 0) * 1000,
  };
  save(refreshed);
  return { token: refreshed.accessToken, session: refreshed };
}
