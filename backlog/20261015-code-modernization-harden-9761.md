---
type: backlog
id: 20261015-code-modernization-harden-9761
department: development
status: ready
take: owner
priority: normal
author: Antons-MacBook-Air-2 · Claude app
date: 2026-10-15
task: 
after: 
goal: 
epic: Агентная обвязка 2026-10
rank: 
found_in: 
updated: 2026-10-15T07:57:28Z
---
# Пилот code-modernization на одном модуле: оценка, карта, правила, harden

Пилот плагина Anthropic code-modernization (claude-plugins-official, v1.0.0; установлен 15.10.2026 на Mac владельца Antons-MacBook-Air-2, на других Mac его пока нет — пилот идёт там). README: https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-modernization/README.md

Зачем: плагин — готовая обвязка в духе нашего плейбука (эпик «Агентная обвязка 2026-10»): правила бизнес-логики Given/When/Then с file:line и повторной проверкой вторым агентом, карта зависимостей, оценка долга и безопасности, а главное — доказательство поведения скриптом, а не мнением модели (тесты с чистого листа, старое против нового на одних входах, 10+ новых входов, canary-поломка, каждое P0-правило покрыто запущенным тестом). Хотим понять, что из этого брать в постоянную практику проекта.

Как: выбрать ОДИН небольшой модуль (до ~5 тыс. строк) с понятной ценностью и назвать его в отчёте. Рабочая папка вне репозитория (например ~/modernize/orla-cli), исходники через --source, в .claude/settings.json папки — deny на Edit исходников, как в README. Шаги: /code-modernization:modernize (цель «Understand it first»), preflight, assess, map, extract-rules (перед большим веером — сказать, сколько агентов запустит; лимит подписки беречь), затем harden по этому модулю. Пересборку (uplift/transform) не запускать без отдельного решения владельца. Ничего из analysis/ и modernized/ не коммитить в репозиторий без решения владельца; найденные секреты остаются только в SECRETS.local.md. Телеметрию плагина включает или выключает владелец (опция Usage counts пока не задана).

## Acceptance criteria

- Пройдены preflight, assess, map и extract-rules на одном названном модуле; REPORT.html сохранён артефактом
- Правила P0 из BUSINESS_RULES.md вынесены владельцу на просмотр (modernize-review) с вопросами, где плагин не уверен
- Находки harden по модулю разобраны: реальные заведены отдельными пунктами бэклога, ложные отмечены
- Записан расход: время шагов, число агентов и доля лимита подписки
- Вывод: что из способа доказательства плагина (canary, сравнение старого и нового, P0 с тестами) брать в проект — отдельными пунктами в эпик «Агентная обвязка 2026-10»
