/**
 * Carry the package version into the plugin manifest.
 *
 * Three files in this repository name a version, and they ship together: npm
 * installs `orla-cli`, `/plugin install orla@orla` installs the skills next to
 * it, and `server.json` is the entry a client or a directory resolves the
 * server by. `npm version` only knows about the first one, so without this the
 * others silently stay a release behind: the registry entry did exactly that
 * and sat at 0.1.2 while the package was 0.2.1.
 *
 * Wired into the `version` lifecycle script, which npm runs after it bumps
 * package.json and before it commits, so the manifest lands in the same commit
 * and the same tag. `test/skills.test.js` is the check that this ran.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, ".claude-plugin", "plugin.json");
const REGISTRY = join(ROOT, "server.json");

const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
if (manifest.version === version) {
  console.log(`plugin manifest already at ${version}`);
} else {
  const before = manifest.version;
  manifest.version = version;
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`plugin manifest ${before} -> ${version}`);
}

const entry = JSON.parse(readFileSync(REGISTRY, "utf8"));
const before = [entry.version, ...(entry.packages ?? []).map((p) => p.version)];
entry.version = version;
for (const pkg of entry.packages ?? []) pkg.version = version;
if (before.every((v) => v === version)) {
  console.log(`registry entry already at ${version}`);
} else {
  writeFileSync(REGISTRY, JSON.stringify(entry, null, 2) + "\n");
  console.log(`registry entry ${before.join(", ")} -> ${version}`);
}
