/**
 * The house voice rule, which the main repository enforces with its own gates:
 * no em dash in text a user reads. Developer prose is exempt, so this reads the
 * strings the CLI prints rather than the whole file.
 *
 * It is here because this repository is public and its output is the first Orla
 * text a stranger sees, and because the rule is invisible to anyone who has not
 * read CLAUDE.md in the other repository.
 */
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

test("nothing the CLI prints carries an em dash", () => {
  const offences = [];
  for (const file of readdirSync(SRC).filter((f) => f.endsWith(".ts"))) {
    const text = readFileSync(join(SRC, file), "utf8");
    // Strip developer prose: block comments and line comments. What is left is
    // code, and any em dash in it sits inside a string a user can see.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    code.split("\n").forEach((line, i) => {
      if (line.includes("—")) offences.push(`src/${file}:${i + 1} ${line.trim().slice(0, 70)}`);
    });
  }
  if (offences.length) {
    throw new Error(
      "em dash in text a user reads (use a colon or a comma):\n  " + offences.join("\n  "),
    );
  }
});
