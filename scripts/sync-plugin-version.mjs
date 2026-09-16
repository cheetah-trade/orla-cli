/**
 * Carry the package version into the plugin manifest.
 *
 * Two files in this repository name a version, and they ship together: npm
 * installs `orla-cli`, and `/plugin install orla@orla` installs the skills next
 * to it. `npm version` only knows about the first one, so without this the
 * manifest silently stays a release behind, and the only thing that would ever
 * say so is a person reading two files at once.
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
