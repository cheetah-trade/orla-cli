# Pipeline of cheetah-trade/orla-cli, last 7 days (collected 2026-11-25 10:53)

Window (UTC): 2026-11-18 09:53:20 – 2026-11-25 09:53:20, every run listed.

## CI by workflow

Not run yet: red only because a two-tier CI has not run its suites yet (light tier on a pull request); not counted as failures.

| Workflow | Runs | Failed | Not run yet | Failure rate | Reruns | Median min | p90 min |
|---|---|---|---|---|---|---|---|
| ci | 182 | 11 | 0 | 6% | 2 | 0.7 | 0.8 |
| dco | 122 | 13 | 0 | 11% | 0 | 0.1 | 0.2 |
| Dependabot Updates | 20 | 0 | 0 | 0% | 0 | 0.8 | 0.8 |
| release | 4 | 0 | 0 | 0% | 0 | 0.6 | 0.8 |

## Where it fails (jobs of recent failed runs)

- dco / signed-off: 13
- ci / windows: 10
- ci / check: 3
- ci / contract-ahead: 1

## Why runs fail (error lines of recent failed runs)

- 1× # (Contract copy: orla_accountant_export, the accountant's files as links into Orla (ledgerly 27c2)) has no Signed-off-by line
- 1× # (Merge branch 'main' into growing-businesses) has no Signed-off-by line
- 1× # (README и описание плагина: шесть готовых сценариев личной двери (#)) has no Signed-off-by line
- 1× # (Контракт: что требует внимания на личной двери (#)) has no Signed-off-by line
- 1× # (Контракт: сверка одного счёта против книги (896d)) has no Signed-off-by line
- 1× # (Контракт: напоминание по счёту клиенту и ссылка на оплату (180e)) has no Signed-off-by line
- 1× # (Контракт: orla_set_up_books, настройка книг из чата (37ce)) has no Signed-off-by line
- 1× # (contract: копия контракта личной двери на девять новых инструментов) has no Signed-off-by line
- 1× # (contracts: the address book on the personal door (find, read, add, correct a contact)) has no Signed-off-by line
- 1× # (Merge origin/main into feat/codex-chatgpt-manifests) has no Signed-off-by line
- 1× # (Merge remote-tracking branch 'origin/main' into skills-twenty-tools) has no Signed-off-by line
- 1× # (contracts: orla_create_account, a hand-kept first account on the personal door) has no Signed-off-by line

## Tests that fail (recent failed runs)

- No failing tests named in the logs.

## Security alerts on GitHub (open)

- Dependencies (Dependabot): none
- Code scanning: could not read
- Secret scanning: none

## Pull requests

- Merged, complete UTC days: 55 without bots (0 by bots left out); to merge, bots excluded: median 0.0 h, p90 1.3 h.
- Open (not drafts): 4; oldest: #28 build(deps): bump actions/checkout from 4 to 7 (4.6 d); #29 build(deps): bump actions/setup-node from 4 to 7 (4.6 d); #30 build(deps-dev): bump @types/node from 22.20.1 to 26.6.6 (4.6 d); #31 build(deps-dev): bump typescript from 5.9.3 to 7.0.2 (4.6 d).
