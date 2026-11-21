/** The package's own version and the User-Agent built from it. */

import { readFileSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function version(): string {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
  return manifest.version ?? "unknown";
}

/**
 * Sent on every request to Orla. Until 0.5.3 the CLI sent undici's default,
 * so Orla's logs could not tell this client, or which release of it, from any
 * other Node program: a bug in one version was invisible as one.
 */
export function userAgent(): string {
  return `orla-cli/${version()} (node ${process.versions.node}; ${platform()})`;
}

/**
 * `ORLA_DEBUG=1`: one stderr line per request, method, host and path, status
 * and time. Never a header, a body or a query string: those carry the token,
 * the code and the person's data.
 */
export function debug(line: string): void {
  if (process.env["ORLA_DEBUG"]) process.stderr.write(`orla debug: ${line}\n`);
}
