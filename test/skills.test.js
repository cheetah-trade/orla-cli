/**
 * The skills name tools by hand, and the door they name is defined in another
 * repository. So this reads every `orla_*(...)` call written in `skills/` and
 * checks it against `contracts/mcp-personal-tools.json`, the snapshot that
 * repository's own gate keeps honest.
 *
 * What it catches: a tool that does not exist on this door (a typo, or a tool
 * withheld from a personal connection, like anything that moves money), and an
 * argument no such tool takes.
 *
 * What it does NOT catch, and is worth saying out loud: field names in the
 * ANSWERS. The contract records what a tool is called and what it takes, not
 * what it returns, so `net_total` or `transfer_group_id` going away in the
 * backend leaves this green. Those live in the skills as prose and are checked
 * by running them, not here.
 */
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = join(ROOT, "skills");

const contract = JSON.parse(readFileSync(join(ROOT, "contracts", "mcp-personal-tools.json"), "utf8"));
const TOOLS = new Map(contract.tools.map((t) => [t.name, new Set(t.arguments)]));

/**
 * Tools a skill may NAME while saying they are not here, and may never call.
 *
 * A skill that explains a refusal has to print the name being refused, and the
 * contract records only what the door offers, never what it withholds. So the
 * list is here, short, with the reason beside it, and it is checked in both
 * directions: naming one as absent while the door has gained it is as wrong as
 * calling it.
 */
const ABSENT_ON_PURPOSE = new Map([
  ["orla_risk_resolve", "a verdict silences a detector for half a year; it belongs to a person, in Orla"],
  // The `orla` skill names the agent door's paying tools to say, in so many
  // words, that a personal connection does not have them. If the personal door
  // ever gained one, that sentence would be the first thing to become false.
  ["orla_propose_payment", "a payment proposal is the agent door's; a personal connection cannot pay anyone"],
  ["orla_wallet_transfer", "an agent's own wallet; a personal connection has no float to send from"],
  ["orla_pay_for_resource", "x402 from an agent's wallet; a personal connection has no wallet"],
]);

function skillFiles() {
  return readdirSync(SKILLS)
    .filter((entry) => statSync(join(SKILLS, entry)).isDirectory())
    .map((entry) => ({ name: entry, path: join(SKILLS, entry, "SKILL.md") }));
}

/** Every `orla_tool(...)` call in one document, with the arguments it names. */
function calls(text) {
  const found = [];
  const opener = /\b(orla_[a-z_]+)\s*\(/g;
  let match;
  while ((match = opener.exec(text))) {
    let depth = 1;
    let i = opener.lastIndex;
    while (i < text.length && depth > 0) {
      if (text[i] === "(") depth += 1;
      else if (text[i] === ")") depth -= 1;
      i += 1;
    }
    const body = text
      .slice(opener.lastIndex, i - 1)
      // a trailing `# note to the reader` is prose, not an argument
      .replace(/#[^\n]*/g, "")
      // an argument's VALUE may be anything, including a word that looks like
      // another argument: `search: "rent"` names `search` and nothing else
      .replace(/:\s*[^,\n]*/g, "");
    const args = body
      .split(/[,\n]/)
      .map((piece) => piece.trim())
      .filter((piece) => /^[a-z][a-z0-9_]*$/.test(piece));
    found.push({ tool: match[1], args });
  }
  return found;
}

test("every tool a skill calls exists on the personal door", () => {
  const offences = [];
  for (const skill of skillFiles()) {
    const text = readFileSync(skill.path, "utf8");
    for (const call of calls(text)) {
      if (!TOOLS.has(call.tool)) {
        offences.push(`${skill.name}: ${call.tool} is not on this door`);
      }
    }
    // A tool can also be named in prose or in a table, without a call beside it.
    for (const name of text.match(/\borla_[a-z_]+\b/g) ?? []) {
      if (TOOLS.has(name)) {
        if (ABSENT_ON_PURPOSE.has(name)) {
          offences.push(`${skill.name}: ${name} is described as withheld, and the door now offers it`);
        }
        continue;
      }
      if (ABSENT_ON_PURPOSE.has(name)) continue;
      if (!offences.some((o) => o.includes(name))) {
        offences.push(`${skill.name}: ${name} is not on this door`);
      }
    }
  }
  if (offences.length) {
    throw new Error(
      "a skill names a tool the personal connection does not have:\n  " +
        offences.join("\n  ") +
        "\nThe door is contracts/mcp-personal-tools.json; money tools are withheld from it by design.",
    );
  }
});

test("every argument a skill passes is one the tool takes", () => {
  const offences = [];
  for (const skill of skillFiles()) {
    for (const call of calls(readFileSync(skill.path, "utf8"))) {
      const known = TOOLS.get(call.tool);
      if (!known) continue; // reported by the test above
      for (const arg of call.args) {
        if (!known.has(arg)) offences.push(`${skill.name}: ${call.tool} takes no ${arg}`);
      }
    }
  }
  if (offences.length) {
    throw new Error("a skill passes an argument the tool does not take:\n  " + offences.join("\n  "));
  }
});

test("every skill declares the name of its own folder", () => {
  const offences = [];
  for (const skill of skillFiles()) {
    const text = readFileSync(skill.path, "utf8");
    const front = text.match(/^---\n([\s\S]*?)\n---/);
    if (!front) {
      offences.push(`${skill.name}: no frontmatter`);
      continue;
    }
    const name = front[1].match(/^name:\s*(\S+)/m)?.[1];
    const description = front[1].match(/^description:\s*(.+)$/m)?.[1];
    if (name !== skill.name) offences.push(`${skill.name}: frontmatter says name: ${name}`);
    // The listing a model chooses from carries name and description and nothing
    // else. A skill with a description that does not say WHEN to use it is a
    // skill that never fires.
    if (!description || description.length < 80) {
      offences.push(`${skill.name}: description is missing or too short to trigger on`);
    }
  }
  if (offences.length) throw new Error("skill frontmatter:\n  " + offences.join("\n  "));
});

test("the skills obey the house voice rule", () => {
  const offences = [];
  for (const skill of skillFiles()) {
    readFileSync(skill.path, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (line.includes("—")) offences.push(`skills/${skill.name}/SKILL.md:${i + 1}`);
      });
  }
  if (offences.length) {
    throw new Error("em dash in a skill (use a colon or a comma):\n  " + offences.join("\n  "));
  }
});

test("the plugin and the package carry the same version", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const plugin = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  if (pkg.version !== plugin.version) {
    throw new Error(
      `package.json is ${pkg.version} and .claude-plugin/plugin.json is ${plugin.version}. ` +
        "They ship together from one repository, so they release together.",
    );
  }
});

test("the plugin connects to Orla's own personal door and nowhere else", () => {
  // Installing this plugin is an invitation to connect a financial account, and
  // the address in the manifest is what the browser lands on. A pull request
  // that quietly repoints it at a lookalike host would be a phishing page with
  // our name on it, and it would read as a one-line diff. So the address is
  // asserted rather than reviewed.
  //
  // `/mcp/personal` rather than `/mcp` is the other half: the personal door is
  // the one where every tool that moves money is withheld and refused by name.
  const config = JSON.parse(readFileSync(join(ROOT, ".mcp.json"), "utf8"));
  const servers = Object.entries(config.mcpServers ?? {});
  if (servers.length !== 1) throw new Error(`.mcp.json declares ${servers.length} servers, expected one`);
  const [name, server] = servers[0];
  if (name !== "orla") throw new Error(`the server is named ${name}`);
  if (server.url !== "https://app.orla.finance/api/mcp/personal") {
    throw new Error(`.mcp.json points at ${server.url}`);
  }
  if (server.command || server.args) {
    throw new Error("the plugin runs no local command: it is an https endpoint and a consent page");
  }
});

test("the marketplace points at a plugin that is actually here", () => {
  const market = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  const plugin = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  const listed = market.plugins.map((p) => p.name);
  if (!listed.includes(plugin.name)) {
    throw new Error(`marketplace.json lists ${listed.join(", ")}, and the plugin here is ${plugin.name}`);
  }
  if (!skillFiles().length) throw new Error("the plugin ships no skills");
});
