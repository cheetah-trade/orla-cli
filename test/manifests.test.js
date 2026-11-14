/**
 * The same plugin described for ChatGPT and Codex (Agent Plugins 1.0.0).
 *
 * The Claude Code manifest in `.claude-plugin/` and the portable one at the
 * root describe ONE plugin: the same skills, the same personal door, the same
 * version. A second description drifts the way the registry entry once did
 * (`sync-plugin-version.mjs` says how), so what matters is pinned here rather
 * than left to review:
 *
 * - `mcp.json` connects to Orla's personal door and nowhere else, with no local
 *   command, exactly like `.mcp.json`: installing a finance plugin is an
 *   invitation to connect an account, and the address is where the browser lands;
 * - the portable manifest carries the release's version and the fields the
 *   directory shows a person;
 * - the text a directory shows promotes no plan and no upgrade: the ChatGPT
 *   plugin rules forbid it ("must not display subscription plans ... or promote
 *   upgrades", read 2026-09-26), and Orla's own door already cuts that sentence
 *   out of its refusals for the same reason;
 * - the repo marketplace points at a plugin that is here, and the icons it names
 *   exist.
 */
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PERSONAL_DOOR = "https://app.orla.finance/api/mcp/personal";
const read = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

test("the portable MCP config connects to the personal door and nowhere else", () => {
  const config = read("mcp.json");
  if (config.$schema !== "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json") {
    throw new Error(`mcp.json declares schema ${config.$schema}`);
  }
  const servers = Object.entries(config.mcpServers ?? {});
  if (servers.length !== 1) throw new Error(`mcp.json declares ${servers.length} servers, expected one`);
  const [name, server] = servers[0];
  if (name !== "orla") throw new Error(`the server is named ${name}`);
  if (server.type !== "streamable-http") throw new Error(`the transport is ${server.type}`);
  if (server.url !== PERSONAL_DOOR) throw new Error(`mcp.json points at ${server.url}`);
  if (server.command || server.args) throw new Error("the plugin runs no local command");
  const claude = read(".mcp.json").mcpServers.orla;
  if (claude.url !== server.url) {
    throw new Error(`.mcp.json and mcp.json point at different doors: ${claude.url} and ${server.url}`);
  }
});

test("the portable manifest is the same plugin at the same version", () => {
  const pkg = read("package.json");
  const portable = read("plugin.json");
  const claude = read(".claude-plugin/plugin.json");
  if (portable.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json") {
    throw new Error(`plugin.json declares schema ${portable.$schema}`);
  }
  if (portable.name !== claude.name) throw new Error(`plugin.json is ${portable.name}, the Claude one ${claude.name}`);
  if (portable.version !== pkg.version) {
    throw new Error(`plugin.json is ${portable.version} and package.json is ${pkg.version}; they release together`);
  }
});

test("the directory card has what a person reads before installing", () => {
  const ui = read("plugin.json").extensions?.["com.openai"]?.interface;
  if (!ui) throw new Error("plugin.json has no extensions.com.openai.interface");
  const required = [
    "displayName", "shortDescription", "longDescription", "developerName", "category",
    "capabilities", "websiteURL", "privacyPolicyURL", "termsOfServiceURL", "defaultPrompt",
    "brandColor", "composerIcon", "logo",
  ];
  const missing = required.filter((k) => ui[k] === undefined || ui[k] === "");
  if (missing.length) throw new Error(`the directory card lacks ${missing.join(", ")}`);
  for (const key of ["composerIcon", "logo"]) {
    if (!ui[key].startsWith("./assets/")) throw new Error(`${key} is ${ui[key]}, not under ./assets/`);
    if (!existsSync(join(ROOT, ui[key]))) throw new Error(`${key} names ${ui[key]}, which is not here`);
  }
  for (const key of ["websiteURL", "privacyPolicyURL", "termsOfServiceURL"]) {
    if (!/^https:\/\/orla\.finance(\/|$)/.test(ui[key])) throw new Error(`${key} is ${ui[key]}`);
  }
});

test("nothing a directory shows sells a plan or has an em dash", () => {
  const portable = read("plugin.json");
  const ui = portable.extensions["com.openai"].interface;
  const texts = [portable.description, ui.shortDescription, ui.longDescription, ...ui.defaultPrompt];
  const pitch = /\b(upgrade|pricing|subscribe|subscription|pro plan|free trial|billing)\b/i;
  for (const text of texts) {
    if (pitch.test(text)) throw new Error(`the directory would show a sales pitch: ${text}`);
    if (text.includes("—")) throw new Error(`em dash in the directory text: ${text}`);
  }
});

test("the repo marketplace points at the plugin that is here", () => {
  const market = read(".agents/plugins/marketplace.json");
  const entry = market.plugins.find((p) => p.name === read("plugin.json").name);
  if (!entry) throw new Error(`the marketplace lists ${market.plugins.map((p) => p.name).join(", ")}`);
  if (entry.source?.source !== "local" || !String(entry.source.path).startsWith("./")) {
    throw new Error(`the marketplace entry points at ${JSON.stringify(entry.source)}`);
  }
  if (!existsSync(join(ROOT, entry.source.path, "plugin.json"))) {
    throw new Error(`no plugin.json at ${entry.source.path}`);
  }
  for (const key of ["installation", "authentication"]) {
    if (!entry.policy?.[key]) throw new Error(`the marketplace entry has no policy.${key}`);
  }
  if (!entry.category) throw new Error("the marketplace entry has no category");
});
