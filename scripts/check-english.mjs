#!/usr/bin/env node
/**
 * This repository is public, and everything in it is written in English: the
 * files, the commit messages, and the title and description of a pull request.
 *
 * Orla's own repository is worked in Russian, and by 27.11.2026 more than half
 * of the commits on main here had come across with their messages
 * untranslated. A squash merge copies the pull request's title and its commit
 * messages onto main, where they stay for good, so this looks before the merge.
 *
 *   node scripts/check-english.mjs        # every tracked file
 *   node scripts/check-english.mjs --pr   # PR_TITLE, PR_BODY and the commits BASE..HEAD
 *
 * It looks for Cyrillic letters, not for "anything outside ASCII": a payee's
 * name, a currency sign or a quote in another script is data, and stays. A
 * test that needs a Cyrillic payee writes it as an escape ("Ж"), which
 * this does not match.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CYRILLIC = /\p{Script=Cyrillic}/u;

/** The lines of `text` that carry a Cyrillic letter, as `{ line, text }`, 1-based. */
export function cyrillicLines(text) {
  const found = [];
  String(text ?? "")
    .split(/\r?\n/)
    .forEach((content, index) => {
      if (CYRILLIC.test(content)) found.push({ line: index + 1, text: content.trim().slice(0, 120) });
    });
  return found;
}

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** Every tracked text file with a Cyrillic letter in it, as `{ file, line, text }`. */
export function cyrillicInTrackedFiles() {
  const found = [];
  for (const file of git("ls-files", "-z").split("\0").filter(Boolean)) {
    let bytes;
    try {
      bytes = readFileSync(join(ROOT, file));
    } catch {
      continue; // deleted in the working tree and not committed yet
    }
    if (bytes.includes(0)) continue; // a picture or an archive, not prose
    for (const hit of cyrillicLines(bytes.toString("utf8"))) found.push({ file, ...hit });
  }
  return found;
}

/** What a pull request would put on main: its title, its description, its commit messages. */
export function cyrillicInPullRequest({ title, body, commits }) {
  const found = [];
  for (const hit of cyrillicLines(title)) found.push({ where: "the pull request title", ...hit });
  for (const hit of cyrillicLines(body)) found.push({ where: "the pull request description", ...hit });
  for (const { sha, message } of commits ?? []) {
    for (const hit of cyrillicLines(message)) found.push({ where: `the message of commit ${sha.slice(0, 7)}`, ...hit });
  }
  return found;
}

function commitsBetween(base, head) {
  if (!base || !head) return [];
  return git("log", "--format=%H%n%B%x00", `${base}..${head}`)
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const newline = entry.indexOf("\n");
      return newline === -1 ? { sha: entry, message: "" } : { sha: entry.slice(0, newline), message: entry.slice(newline + 1) };
    });
}

function main() {
  if (process.argv.includes("--pr")) {
    const found = cyrillicInPullRequest({
      title: process.env.PR_TITLE,
      body: process.env.PR_BODY,
      commits: commitsBetween(process.env.BASE, process.env.HEAD),
    });
    if (!found.length) {
      console.log("The pull request and its commits are in English.");
      return 0;
    }
    for (const { where, line, text } of found) console.error(`::error::${where}, line ${line}: ${text}`);
    console.error(
      "\nThis repository is public and is written in English.\n" +
        "Edit the title or the description in place (the check runs again on its own).\n" +
        "For a commit message: `git commit --amend -s` for the last one, `git rebase -i` and reword for an older one, then push.",
    );
    return 1;
  }

  const found = cyrillicInTrackedFiles();
  if (!found.length) {
    console.log("No tracked file carries Cyrillic text.");
    return 0;
  }
  for (const { file, line, text } of found) console.error(`${file}:${line}: ${text}`);
  console.error("\nThis repository is public and is written in English. Translate the lines above.");
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
