/**
 * `scripts/check-english.mjs`: this repository is public and is written in
 * English. The suite fails on a tracked file with Cyrillic text in it; the
 * pull request's own words (title, description, commit messages) are checked
 * by the same script in the `signed-off` job, since they are not in the tree.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cyrillicInPullRequest, cyrillicInTrackedFiles, cyrillicLines } from "../scripts/check-english.mjs";

// Written as escapes, so that this file passes the check it tests.
const RUSSIAN_TITLE = "Контракт: orla_list_views";
const RUSSIAN_LINE = "копия контракта";

test("no tracked file carries Cyrillic text", () => {
  const found = cyrillicInTrackedFiles().map(({ file, line, text }) => `${file}:${line}: ${text}`);
  assert.deepEqual(found, [], "this repository is written in English; translate these lines");
});

test("a Cyrillic line is found with its number, an English one is not", () => {
  assert.deepEqual(cyrillicLines(`Contract: views\n\n${RUSSIAN_LINE}\n`), [{ line: 3, text: RUSSIAN_LINE }]);
  assert.deepEqual(cyrillicLines("Contract: vendor contracts on the personal door (ledgerly 4adf)"), []);
});

test("other scripts and signs are data, not Russian prose", () => {
  assert.deepEqual(cyrillicLines("Café Müller, €12.50, «日本», αβ"), []);
  assert.deepEqual(cyrillicLines(undefined), []);
  assert.deepEqual(cyrillicLines(""), []);
});

test("a pull request is read in its title, its description and every commit message", () => {
  const clean = {
    title: "Contract: views on the personal door",
    body: "## What this changes\n\nOne tool.",
    commits: [{ sha: "3a703f0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", message: "Contract: views\n\nSigned-off-by: A <a@b.c>" }],
  };
  assert.deepEqual(cyrillicInPullRequest(clean), []);

  const where = (pr) => cyrillicInPullRequest(pr).map((hit) => hit.where);
  assert.deepEqual(where({ ...clean, title: RUSSIAN_TITLE }), ["the pull request title"]);
  assert.deepEqual(where({ ...clean, body: `## What\n\n${RUSSIAN_LINE}` }), ["the pull request description"]);
  assert.deepEqual(
    where({ ...clean, commits: [{ sha: "48d9ba0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", message: `${RUSSIAN_TITLE}\n\nSigned-off-by: A <a@b.c>` }] }),
    ["the message of commit 48d9ba0"],
  );
});

test("a pull request with no description and no commits passes", () => {
  assert.deepEqual(cyrillicInPullRequest({ title: "Bump typescript", body: null, commits: [] }), []);
});
