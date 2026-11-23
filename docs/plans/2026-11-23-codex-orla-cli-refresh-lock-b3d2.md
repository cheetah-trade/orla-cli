# Windows refresh-lock EPERM recovery

Task: Ledgerly backlog 20261123-orla-cli-windows-refresh-lock-eperm-main-ci-b3d2.
Session: small scoped change, implemented in the same session after this plan commit.

Files: src/store.ts; test/refresh-lock.test.js; this plan.
Interfaces: withRefreshLock remains unchanged. Exclusive create with mode0600 remains the only acquisition operation. Retry Windows open/EPERM at most20 times with the existing50ms poll delay, then surface the original error. EACCES and errors on other platforms remain immediate failures; no chmod or unowned lock deletion.
Out of scope: token protocol, stale-lock redesign, contract/skills, dependency changes, CI policy, npm/version release.
End-to-end check: fault-inject transient and persistent open failures; assert serialized callbacks and error propagation; retain the existing two-process/parallel-export test proving exactly one token rotation. Run typecheck/full suite on Node22 and require Windows CI evidence.

Existing evidence: main8c3ba987 still waits only for EEXIST in src/store.ts; historical run45074018813 failed on Windows open refresh.lock EPERM and then passed a retry. No overlapping open PR or active claim found. Windows access-denied errors map to EPERM in libuv; the precise cause of the historical transient is not proven. The fix addresses the observed transient error without treating every permission failure as recoverable indefinitely.

Reference: https://github.com/libuv/libuv/blob/v1.x/src/win/error.c (ERROR_ACCESS_DENIED mapping). No production credentials are used by tests.

## Deviations
None.
