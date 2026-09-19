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
 * The redirect is loopback because that is where a terminal can listen. The
 * ports used to be a fixed list of three, because the server matched
 * redirect_uri against the document as an exact string and a port it had never
 * seen was refused. That was the server being wrong (RFC 8252 §7.3 requires ANY
 * port to be allowed on a loopback redirect, which is why native clients bind
 * whatever is free), and it was fixed on 2026-09-08. So this asks the operating
 * system for a free port like every other native client, and the failure mode
 * where three specific ports were all taken is gone.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { platform } from "node:os";

import { cancelled, notConnected, refused, sessionExpired, unreachable } from "./errors.js";
import { load, save, type Session } from "./store.js";

//: The API's own origin, behind the `/api` ingress prefix — not the app's.
//: `app.orla.finance/oauth/authorize` is the frontend's 404 page.
export const DEFAULT_API = "https://app.orla.finance/api";

/** Published from the marketing site, and the only identity this client has. */
export const CLIENT_ID = "https://orla.finance/mcp-cli.json";
//: Kept, and no longer the whole story: an older Orla refuses a port that is not
//: on this list, so trying these first means a CLI updated before the server it
//: talks to still works. Port 0 is the real answer and comes last.
export const PORTS = [7654, 7655, 7656, 0];

const SCOPE = "orla.read orla.write";

/**
 * Orla answers MCP at two addresses, and the difference is not a label.
 *
 * `/mcp/personal` is a person's own books: every tool that moves money is
 * withheld from the list and refused if a model asks for one by name, so the
 * promise holds whatever the consent page was told. `/mcp` offers both shapes,
 * and the consent page there can mint an agent with a budget of its own.
 *
 * `login` asks for the personal door unless told otherwise, because that is
 * what this client documents itself as. A session stores the door it was minted
 * at, so an existing connection keeps going where it already goes.
 */
export type Door = "personal" | "agent";

const DOOR_PATHS: Record<Door, string> = { personal: "/mcp/personal", agent: "/mcp" };

export function doorPath(session: Pick<Session, "door">): string {
  return DOOR_PATHS[session.door ?? "agent"];
}

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
  // Only reachable if even port 0 could not bind, which is the machine refusing
  // to give out a socket rather than anything about these numbers.
  throw cancelled("could not open a local port to finish signing in; check that nothing is blocking loopback sockets");
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
    server.listen(port, "127.0.0.1", () => {
      // The port the OS actually gave, not the one asked for. With a fixed
      // number the two are the same; with 0 they are not, and echoing the
      // request back would put `127.0.0.1:0` in the redirect URI.
      const bound = server.address();
      const actual = typeof bound === "object" && bound ? bound.port : port;
      resolve({ port: actual, callback });
    });
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
export async function reach(url: string, init: RequestInit, advice: string = SESSION_ADVICE): Promise<Response> {
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
    throw unreachable(`cannot reach ${host}${why ? ` (${why})` : ""}. ${advice}`);
  }
}

/**
 * The way out, for the door that stores a session. The agent door has none to
 * clear and passes its own advice: `orla logout` there would be advice about
 * a thing that does not exist.
 */
const SESSION_ADVICE =
  "If this machine is online, the stored session may point at an Orla that is gone: " +
  "`orla logout` and `orla login` again.";

async function postForm(url: string, body: Record<string, string>): Promise<Record<string, string>> {
  const res = await reach(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json()) as Record<string, string>;
  if (!res.ok) {
    const why = json["error_description"] || json["error"] || `token endpoint said ${res.status}`;
    // `invalid_grant` is the token endpoint saying the refresh token is dead:
    // revoked in the app, rotated away, or minted by an Orla that is gone. That
    // is "not connected" from here on, not a refusal of one command.
    if (json["error"] === "invalid_grant") throw sessionExpired(why);
    throw refused(json["error"] || "oauth.token", why, json);
  }
  return json;
}

export async function login(apiBase: string, door: Door = "personal"): Promise<Session> {
  const { verifier, challenge } = pkce();
  const state = randomBytes(16).toString("base64url");
  const resource = `${apiBase}${DOOR_PATHS[door]}`;

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
    throw cancelled("the callback carried a different state; nothing was connected");
  }
  const code = params.get("code");
  if (!code) throw cancelled(params.get("error_description") ?? params.get("error") ?? "no code came back");

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
    door,
  };
  save(session);
  return session;
}

/** A live access token, refreshed if the stored one is about to expire. */
export async function accessToken(): Promise<{ token: string; session: Session }> {
  const session = load();
  if (!session) throw notConnected();
  if (session.expiresAt - 60_000 > Date.now()) {
    return { token: session.accessToken, session };
  }
  const tokens = await postForm(`${session.apiBase}/oauth/token`, {
    grant_type: "refresh_token",
    refresh_token: session.refreshToken,
    client_id: CLIENT_ID,
    resource: `${session.apiBase}${doorPath(session)}`,
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
