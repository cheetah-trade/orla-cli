/**
 * The skill, the plugin and the bundle, kept in step with the code.
 *
 * skills/orla/SKILL.md teaches an agent the command names, the exit codes and
 * the environment variables. Each of those has one source in the code; if the
 * file drifts from it, the agent is taught a CLI that does not exist and the
 * failure lands in somebody's session, not here. The same for the plugin
 * manifests Claude Code reads and the manifest the Claude Desktop bundle is
 * built with: the one version number lives in package.json.
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "../dist/usage.js";
import { EXIT } from "../dist/errors.js";
import { DEFAULT_API } from "../dist/auth.js";
import { build, manifest } from "../scripts/build-mcpb.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const json = (p) => JSON.parse(read(p));
const SKILL = read("skills/orla/SKILL.md");
const README = read("README.md");
const pkg = json("package.json");

test("the skill names every command, and no command that does not exist", () => {
  for (const c of COMMANDS) ok(SKILL.includes(`\`orla ${c.name}`), `SKILL.md does not teach \`orla ${c.name}\``);
  // Every `orla <word>` the skill mentions in code is a real first word,
  // except the ones it names to say they do NOT exist ("no `orla space`").
  const firstWords = new Set(COMMANDS.map((c) => c.name.split(" ")[0]).concat(["help"]));
  for (const m of SKILL.matchAll(/(no )?`orla ([a-z]+)/g)) {
    if (m[1]) continue;
    ok(firstWords.has(m[2]), `SKILL.md mentions \`orla ${m[2]}\`, which is not a command`);
  }
});

test("the skill's exit-code table is the code's", () => {
  const table = SKILL.split("Exit codes:")[1].split("\n\n")[1];
  const rows = table.split("\n").filter((l) => /^\| \d/.test(l)).map((l) => Number(l.split("|")[1]));
  deepStrictEqual(rows.sort(), Object.values(EXIT).sort(), "one row per exit code, no more and no fewer");
  for (const code of ["cli.usage", "cli.not_connected", "cli.session_expired", "cli.no_spaces", "cli.space_required", "cli.unreachable", "cli.bad_answer", "cli.sign_in_cancelled", "cli.sign_in_in_progress"]) {
    ok(SKILL.includes(`\`${code}\``), `SKILL.md does not name ${code}`);
  }
});

test("the skill and the README name every environment variable the code reads", () => {
  const src = readdirSync(join(ROOT, "src")).map((f) => read(join("src", f))).join("\n");
  const vars = new Set([...src.matchAll(/process\.env(?:\.|\[")(ORLA_[A-Z_]+|XDG_CONFIG_HOME)/g)].map((m) => m[1]));
  ok(vars.size >= 3, `expected the env vars to be found in src, got ${[...vars]}`);
  for (const v of vars) {
    ok(SKILL.includes(`\`${v}`), `SKILL.md does not document ${v}`);
    ok(README.includes(`\`${v}`), `README.md does not document ${v}`);
  }
});

test("the skill is text a stranger reads: no em dash, frontmatter present", () => {
  ok(SKILL.startsWith("---\nname: orla\n"), "frontmatter names the skill");
  strictEqual(SKILL.includes("—"), false, "em dash in SKILL.md");
});

test("the plugin lists this skill among the others and ships it in the package", () => {
  // The manifests themselves (version in step with package.json, the personal
  // door asserted verbatim, one plugin that is actually here) are held by
  // test/skills.test.js. This adds only what the `orla` skill brings.
  const market = json(".claude-plugin/marketplace.json");
  ok(market.plugins[0].description.includes("drive the CLI"), "the marketplace description names the CLI skill");
  deepStrictEqual(json(".mcp.json"), { mcpServers: { orla: { type: "http", url: `${DEFAULT_API}/mcp/personal` } } });
  deepStrictEqual(pkg.files, ["dist", "skills"], "the skill ships in the npm package; the site serves it from there");
  ok(SKILL.includes(`${DEFAULT_API}/mcp/personal`), "the skill sends a personal connection to the personal door");
});

test("the Claude Desktop bundle is a zip with a manifest built from package.json", () => {
  const m = manifest();
  strictEqual(m.manifest_version, "0.3");
  strictEqual(m.name, "orla");
  strictEqual(m.version, pkg.version);
  strictEqual(m.server.type, "node");
  strictEqual(m.server.entry_point, "dist/index.js");
  deepStrictEqual(m.server.mcp_config, { command: "node", args: ["${__dirname}/dist/index.js", "mcp"] });
  ok(m.author.name && m.description, "author and description are required by the spec");

  const out = mkdtempSync(join(tmpdir(), "orla-mcpb-"));
  try {
    const file = build(out);
    strictEqual(file, join(out, `orla-${pkg.version}.mcpb`));
    const listed = execFileSync("unzip", ["-Z1", file], { encoding: "utf8" }).trim().split("\n");
    for (const must of ["manifest.json", "package.json", "LICENSE", "dist/index.js", "dist/mcp.js"]) {
      ok(listed.includes(must), `${must} missing from the bundle: ${listed.join(", ")}`);
    }
    const inside = JSON.parse(execFileSync("unzip", ["-p", file, "manifest.json"], { encoding: "utf8" }));
    strictEqual(inside.version, pkg.version);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
