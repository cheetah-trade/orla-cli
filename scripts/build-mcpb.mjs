#!/usr/bin/env node
/**
 * The Claude Desktop bundle: `orla-<version>.mcpb`.
 *
 * An .mcpb is a zip with a manifest.json at its root, and Claude Desktop runs
 * the server it names as a child process. Ours is the stdio bridge (`orla
 * mcp`), which signs in by itself, so a person installs the bundle by
 * double-clicking it and meets the same consent page as everyone else.
 *
 * The manifest is written here from package.json rather than kept as a file,
 * because two places to write a version number is one place to forget it, and
 * `npm version` bumps only the one. No packer is installed: the format is a
 * zip, `zip` is on every machine and runner this runs on, and a foreign
 * package running at release time would have to clear the supply chain gate
 * in the main repository first.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** What Claude Desktop reads. `${__dirname}` is the folder it unpacks the bundle into. */
export function manifest() {
  return {
    manifest_version: "0.3",
    name: "orla",
    display_name: "Orla",
    version: pkg.version,
    description: "Your Orla books in Claude: read, record, export. Paying waits for a person.",
    long_description:
      "Connects Claude Desktop to your Orla books through a personal connection: " +
      "accounts, transactions, budgets, shared expenses and risk reads. The connection " +
      "reads and records; it cannot pay anyone, which is enforced on the server. " +
      "Signing in opens the browser on Orla's own consent page, where you tick the spaces this machine may reach.",
    author: { name: pkg.author, url: "https://orla.finance" },
    repository: { type: "git", url: "https://github.com/cheetah-trade/orla-cli.git" },
    homepage: pkg.homepage,
    documentation: "https://orla.finance/en/mcp",
    support: pkg.bugs.url,
    server: {
      type: "node",
      entry_point: "dist/index.js",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/dist/index.js", "mcp"],
      },
    },
    keywords: pkg.keywords,
    license: pkg.license,
    compatibility: { platforms: ["darwin", "win32", "linux"], runtimes: { node: ">=22" } },
  };
}

export function build(outDir = root) {
  const stage = join(outDir, "bundle");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true });
  // `orla version` and the bridge's serverInfo read the version from here.
  cpSync(join(root, "package.json"), join(stage, "package.json"));
  cpSync(join(root, "LICENSE"), join(stage, "LICENSE"));
  writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifest(), null, 2)}\n`);
  const out = join(outDir, `orla-${pkg.version}.mcpb`);
  rmSync(out, { force: true });
  execFileSync("zip", ["-qr", out, "manifest.json", "package.json", "LICENSE", "dist"], { cwd: stage });
  rmSync(stage, { recursive: true, force: true });
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = build();
  process.stdout.write(`${out}\n`);
}
