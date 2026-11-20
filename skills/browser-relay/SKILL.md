---
name: browser-relay
description: Работать в настоящем Chrome пользователя (его вкладки, логины, сессии) с любой машины без повторных «Allow remote debugging?» — через `bb browser-relay`. Использовать всегда, когда нужен Chrome пользователя, а не встроенный/headless браузер; диагностика и установка службы.
---

# Browser Relay

Chrome 144+ спрашивает «Allow remote debugging?» на **каждое новое** DevTools-подключение
к основному профилю. Browser Relay держит на машине с Chrome одну службу с одним
подключением; все агенты со всех машин идут через неё — Allow нужен один раз после
запуска Chrome или перезапуска службы.

## Правило

Chrome пользователя — только через `bb browser-relay` (или, в Codex на той же машине,
через MCP `chrome-devtools`, который указывает на ту же службу). **Не** запускай
`agent-browser --auto-connect`, свой `chrome-devtools-mcp`, `npx chrome-devtools-mcp`,
Playwright `connectOverCDP` и не ищи порт 9222: каждое такое подключение — новое окно Allow,
агент зависает, пока человек не нажмёт.

## Команды

```
bb browser-relay machines                     # где служба стоит и отвечает
bb browser-relay status [--machine <m>]       # Chrome не трогает, окна нет
bb browser-relay tools  [--machine <m>]       # инструменты chrome-devtools-mcp
bb browser-relay call <tool> --args '<json>' [--machine <m>] [--timeout 120s] [--json]
bb browser-relay service install --machine <m>   # поставить/обновить/перенести службу (macOS)
bb browser-relay service remove  --machine <m>
```

Частые вызовы: `list_pages`, `select_page {"pageId":N}`, `new_page {"url":"…"}`,
`navigate_page {"url":"…"}`, `take_snapshot`, `click {"uid":"…"}`, `fill {"uid":"…","value":"…"}`,
`evaluate_script {"function":"() => document.title"}`, `take_screenshot`.
Точные аргументы — в `tools`. Снимки сохраняются **на машине с Chrome**; путь печатается
в ответе (забрать: `bb file read --host <id> <путь>` при необходимости).

Машина: `--machine` → настройка плагина «машина по умолчанию» → единственная машина,
где служба отвечает. Между несколькими команда не выбирает сама — укажи `--machine`.

## Ограничения

- Работай в своей вкладке (`new_page`), чужие вкладки пользователя не закрывай.
  Выбранная вкладка общая для всех агентов: параллельные агенты могут мешать друг другу.
- Окно Allow после запуска Chrome или перезапуска службы — одно; скажи пользователю
  нажать его и жди, не переподключайся в цикле.
- Служба ставится только на macOS (launchd). Windows и Linux — не поддерживаются.
- Покупки, отправку сообщений, удаление и публикацию в браузере — только после явного
  подтверждения пользователя.

## Диагностика

- `status`: «служба не отвечает» → `service install --machine <m>`; лог службы
  `~/Library/Logs/bb-browser-relay.log` на той машине.
- «прежняя метка» → `service install` переносит старую службу (одно новое Allow).
- Вызов висит → в Chrome ждёт окно Allow; попроси пользователя нажать.
