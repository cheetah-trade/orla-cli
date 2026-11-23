# Plan: isolate the sign-in timeout test's callback port

Branch: `codex/windows-callback-isolation`
Session: same; a small test-only repair after a deterministic local reproduction.

## Files

- `test/door-answers.test.js`: allow a test-only Node preload for the timeout case.
- `test/helpers/ephemeral-callback.mjs`: select the existing ephemeral-port fallback in that child process only.

## Interfaces

The production CLI and published callback-port compatibility remain unchanged. Only the timeout test's child starts with `PORTS` set to `[0]`, so another parallel sign-in cannot reclaim its published port before the assertion.

## Out of scope

Authentication changes, retrying CI until green, serializing the entire suite, new dependencies, version changes and npm publication.

## End-to-end check

- Existing main Windows run 45176921920 fails at door-answers.test.js:303; Ubuntu passes. Runtime and test are unchanged by PR #57.
- An external test copy reproduces the same failure after another listener successfully rebinds the released published port. Run the same contender against the isolated test and require success.
- Negative control: temporarily remove the timeout's close from generated dist, require the isolated test to fail, then rebuild dist.
- Run typecheck and the full test suite; require Windows and Ubuntu GitHub CI before merging.

## Deviations

None.
