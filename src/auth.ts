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

import { cancelled, notConnected, refused, sessionExpired, timedOut, unreachable } from "./errors.js";
import { load, save, withRefreshLock, type Session } from "./store.js";
import { debug, userAgent } from "./version.js";

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

/**
 * How long a sign-in waits for the browser to come back.
 *
 * Without a limit `orla login` (and the bridge, which signs in on its own) sat
 * on an open loopback port for as long as the process lived when the tab was
 * closed. Five minutes covers a sign-up with a confirmation letter; past it the
 * port is closed and the sign-in can simply be started again.
 * `ORLA_SIGN_IN_WAIT_MS` shortens it for tests.
 */
export function signInWaitMs(): number {
  const override = Number(process.env["ORLA_SIGN_IN_WAIT_MS"]);
  return Number.isFinite(override) && override > 0 ? override : 5 * 60_000;
}

/** Whether a callback belongs to this sign-in: null if it does, the reason if not. */
type CallbackCheck = (params: URLSearchParams) => string | null;

type Listener = { port: number; callback: Promise<URLSearchParams>; close: () => void };

/**
 * Listen on the first free published port.
 *
 * Returns as soon as the socket is bound, because the port belongs in the
 * authorization URL that has not been built yet; `callback` settles later, when
 * the browser comes back.
 */
async function startListener(check: CallbackCheck): Promise<Listener> {
  for (const port of PORTS) {
    const listener = await bind(port, check);
    if (listener) return listener;
  }
  // Only reachable if even port 0 could not bind, which is the machine refusing
  // to give out a socket rather than anything about these numbers.
  throw cancelled("could not open a local port to finish signing in; check that nothing is blocking loopback sockets");
}

function bind(port: number, check: CallbackCheck): Promise<Listener | null> {
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
      // Checked BEFORE the port closes: a request that does not belong to this
      // sign-in (another tab, a stale link, a page on this machine guessing the
      // port) used to close the listener and end the real sign-in with it.
      const wrong = check(url.searchParams);
      if (wrong) {
        process.stderr.write(`orla: ignored a sign-in callback that is not this one (${wrong})\n`);
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end("<!doctype html><meta charset=utf-8><p>This link is not the sign-in this terminal is waiting for.</p>");
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
      resolve({ port: actual, callback, close: () => server.close() });
    });
  });
}

/** How long one request to Orla may take before it is given up on: 60 s, `ORLA_REQUEST_TIMEOUT_MS` for tests. */
export function requestTimeoutMs(): number {
  const override = Number(process.env["ORLA_REQUEST_TIMEOUT_MS"]);
  return Number.isFinite(override) && override > 0 ? override : 60_000;
}

/**
 * `fetch`, but a network failure says what it could not reach, and nothing
 * waits forever.
 *
 * A request with no deadline held the bridge, which relays one line at a time,
 * for as long as the server took: a call stuck on Orla's side stuck every call
 * after it. A timeout is reported as `cli.timeout`, not as unreachable: the
 * request may have landed, and a write is retried with its idempotency key.
 *
 * Undici throws a bare `fetch failed` for DNS, TLS and refused connections
 * alike, and that message reaches the user unchanged: `orla: fetch failed`.
 * It names neither the host nor the remedy, and the commonest cause is a
 * session stored against an Orla this machine can no longer reach, which the
 * user has no way to guess.
 */
export async function reach(url: string, init: RequestInit, timeoutMs: number = requestTimeoutMs()): Promise<Response> {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  const started = Date.now();
  const where = (() => {
    try {
      const u = new URL(url);
      return `${u.host}${u.pathname}`;
    } catch {
      return host;
    }
  })();
  try {
    const headers = new Headers(init.headers);
    headers.set("user-agent", userAgent());
    const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
    debug(`${init.method ?? "GET"} ${where} -> ${res.status} in ${Date.now() - started} ms`);
    return res;
  } catch (err) {
    debug(`${init.method ?? "GET"} ${where} -> ${(err as Error)?.name ?? "error"} after ${Date.now() - started} ms`);
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw timedOut(
        `${host} did not answer within ${Math.round(timeoutMs / 1000)} s; ` +
          "a write may still have landed, so check before repeating it",
      );
    }
    const why = err instanceof Error && err.cause instanceof Error ? err.cause.message : (err as Error)?.message;
    throw unreachable(
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
  const json = (await res.json().catch(() => ({}))) as Record<string, string>;
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

  // RFC 9207: Orla names itself in `iss` on the redirect. A callback that names
  // another issuer is a mix-up (a code minted elsewhere), not this sign-in.
  const issuer = apiBase.replace(/\/+$/, "");
  const check: CallbackCheck = (params) => {
    if (params.get("state") !== state) return "it carried a different state";
    const iss = params.get("iss");
    if (iss !== null && iss.replace(/\/+$/, "") !== issuer) return `it came from ${iss}, not ${issuer}`;
    return null;
  };

  // The port is only known once something is listening, so the listener binds
  // before the URL is built and the browser opens after.
  const listener = await startListener(check);
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

  const waitMs = signInWaitMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const params = await Promise.race([
    listener.callback,
    new Promise<never>((_, fail) => {
      timer = setTimeout(() => {
        listener.close();
        fail(
          cancelled(
            `the browser did not come back within ${Math.round(waitMs / 60_000) || 1} min; ` +
              "nothing was connected, sign in again when ready",
          ),
        );
      }, waitMs);
    }),
  ]).finally(() => clearTimeout(timer));
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

const fresh = (session: Session): boolean => session.expiresAt - 60_000 > Date.now();

/**
 * A live access token, refreshed if the stored one is about to expire.
 *
 * The refresh runs under `withRefreshLock`, and the session is read again once
 * the lock is held: if another process or call refreshed while this one
 * waited, its tokens are used as they are. Presenting the old refresh token a
 * second time would end the whole connection on Orla's side.
 */
export async function accessToken(rejected?: string): Promise<{ token: string; session: Session }> {
  const session = load();
  if (!session) throw notConnected();
  // `rejected` is a token Orla just answered 401 to: its clock and ours disagree,
  // or it was ended on Orla's side. Refresh it even if it looks fresh here,
  // unless another process already replaced it while this one waited.
  const stale = (s: Session): boolean => !fresh(s) || (rejected !== undefined && s.accessToken === rejected);
  if (!stale(session)) return { token: session.accessToken, session };
  return withRefreshLock(async () => {
    const current = load();
    if (!current) throw notConnected();
    if (!stale(current)) return { token: current.accessToken, session: current };
    const tokens = await postForm(`${current.apiBase}/oauth/token`, {
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: CLIENT_ID,
      resource: `${current.apiBase}${doorPath(current)}`,
    });
    const refreshed: Session = {
      ...current,
      accessToken: tokens["access_token"] ?? "",
      refreshToken: tokens["refresh_token"] ?? "",
      expiresAt: Date.now() + Number(tokens["expires_in"] ?? 0) * 1000,
    };
    save(refreshed);
    return { token: refreshed.accessToken, session: refreshed };
  });
}

/**
 * What `orla logout` managed on Orla's side, besides forgetting the session here.
 *
 * `revoked: false` is not a failure of the command: the local copy is gone
 * either way. It is said out loud because the one reason to log out in a hurry
 * is a token that left this machine, and a copy elsewhere outlives a local
 * delete for as long as the refresh token lives (30 or 60 days).
 */
export type Revocation =
  | { revoked: true }
  | { revoked: false; reason: "not_offered" | "refused" | "unreachable"; detail: string };

const REVOKE_TIMEOUT_MS = 10_000;

/**
 * Where this Orla takes revocations (RFC 7009), from its RFC 8414 metadata.
 *
 * The OpenID alias is tried second for the reason the server gives for serving
 * it: on a deployment mounted under a path prefix it is the one that is found by
 * appending to the issuer. An endpoint on a different origin from the session's
 * is refused, because the request carries the refresh token and a metadata
 * document is not a reason to send that anywhere else.
 */
async function revocationEndpoint(apiBase: string): Promise<string | null> {
  for (const doc of ["oauth-authorization-server", "openid-configuration"]) {
    let res: Response;
    try {
      res = await fetch(`${apiBase}/.well-known/${doc}`, {
        headers: { "user-agent": userAgent() },
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
      });
    } catch {
      throw unreachable(`cannot reach ${apiBase}`);
    }
    if (!res.ok) continue;
    const meta = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const endpoint = meta["revocation_endpoint"];
    if (typeof endpoint !== "string" || !endpoint) return null;
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      return null;
    }
    return url.origin === new URL(apiBase).origin ? url.toString() : null;
  }
  return null;
}

/**
 * Ask Orla to end this connection (RFC 7009), before the session is forgotten.
 *
 * The refresh token is the one sent: Orla ends every token of this client's
 * chain on it, and only this client's, so the person's other connections
 * (Claude, another machine) keep working. Never throws: whatever happens here,
 * the caller still clears the local copy.
 */
export async function revoke(session: Session): Promise<Revocation> {
  const token = session.refreshToken || session.accessToken;
  let endpoint: string | null;
  try {
    endpoint = await revocationEndpoint(session.apiBase);
  } catch (err) {
    return { revoked: false, reason: "unreachable", detail: (err as Error).message };
  }
  if (!endpoint) {
    return {
      revoked: false,
      reason: "not_offered",
      detail: `${new URL(session.apiBase).host} offers no revocation endpoint`,
    };
  }
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": userAgent() },
      body: new URLSearchParams({
        token,
        token_type_hint: session.refreshToken ? "refresh_token" : "access_token",
        client_id: CLIENT_ID,
      }).toString(),
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    });
  } catch (err) {
    const why = err instanceof Error && err.cause instanceof Error ? err.cause.message : (err as Error)?.message;
    return { revoked: false, reason: "unreachable", detail: `cannot reach ${new URL(endpoint).host} (${why})` };
  }
  // RFC 7009 2.2: 200 whether or not the token was still alive, so 200 is the
  // only answer that means "nothing honours it any more".
  if (res.ok) return { revoked: true };
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const why = String(body["error_description"] ?? body["error"] ?? `revocation endpoint said ${res.status}`);
  return { revoked: false, reason: "refused", detail: why };
}
