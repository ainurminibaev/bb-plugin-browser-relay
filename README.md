# Browser Relay — плагин BB

Агенты BB с **любой машины** работают в вашем настоящем Chrome (вкладки, логины,
сессии) через **одно общее подключение**. Chrome спрашивает «Allow remote debugging?»
один раз после запуска, а не на каждого агента.

## Зачем

Начиная с Chrome 144 браузер спрашивает разрешение на **каждое новое** DevTools-подключение
к основному профилю, и запомнить его нельзя. Каждый тред Codex/Claude, который сам
запускает `chrome-devtools-mcp`, `agent-browser --auto-connect` или Playwright по CDP,
вызывает новое окно — и зависает, пока человек не нажмёт «Allow». Особенно это бьёт по
агентам на серверах: до локальной службы на Mac им не дотянуться, и они импровизируют.

Browser Relay решает это так:

- на Mac с Chrome работает служба (LaunchAgent `dev.bb.browser-relay`): один
  `chrome-devtools-mcp --autoConnect` за `mcp-proxy` на `127.0.0.1:8766`;
- рабочий процесс плагина на том же Mac обращается к службе локально;
- агенты на любых машинах вызывают `bb browser-relay …`, BB передаёт вызов на Mac;
- Codex на том же Mac направляется на службу (`[mcp_servers.chrome-devtools]` в
  `~/.codex/config.toml`), остальные строки конфига не меняются;
- в комплекте навык для агентов: когда и как пользоваться, чего не делать.

Наружу ничего не открывается: служба слушает только 127.0.0.1, а удалённые вызовы идут
по уже существующему каналу BB к машине.

## Команды

```
bb browser-relay machines
bb browser-relay status   [--machine <ID|имя>]
bb browser-relay tools    [--machine <ID|имя>]
bb browser-relay call <tool> --args '<json>' [--machine <ID|имя>] [--timeout 120s] [--json]
bb browser-relay service install --machine <ID|имя>
bb browser-relay service remove  --machine <ID|имя>
```

### Какая машина

1. `--machine` (ID `host_…` или имя из `bb machine list`);
2. иначе настройка плагина **«Машина с Chrome по умолчанию»**;
3. иначе — единственная подключённая машина, где служба отвечает.

Если служба отвечает на нескольких машинах и ничего не указано, команда **не угадывает**,
а просит `--machine`. `bb browser-relay machines` показывает, где что стоит.

## Установка

```
bb plugin install <git-url или путь к checkout>
bb browser-relay service install --machine <Mac с Chrome>
```

Нужны на Mac: Node.js ≥ 20.19 и [uv](https://docs.astral.sh/uv/) (для `mcp-proxy` 0.15.0).
Один раз в Chrome включить `chrome://inspect/#remote-debugging`. При первом обращении
агента нажать «Allow». `service install` идемпотентен: повторный запуск проверяет и
доустанавливает. Прежние службы (`chrome-devtools-mcp-shared` под любой меткой)
переносятся автоматически — Chrome один раз спросит «Allow».

Файлы на Mac: `~/.local/share/bb-browser-relay/` (служба, `backup/` с копиями
`config.toml` Codex и прежних LaunchAgent), `~/Library/LaunchAgents/dev.bb.browser-relay.plist`,
лог `~/Library/Logs/bb-browser-relay.log`.

## Перезапуск, перезагрузка, Windows

- **Перезагрузка Mac:** служба запускается сама при входе (`RunAtLoad`) и
  перезапускается при падении (`KeepAlive`).
- **Перезапуск Chrome или службы:** Chrome **один раз** спросит «Allow» — это
  ограничение Chrome, обойти его нельзя.
- **Windows и Linux:** служба не поддерживается (нужен launchd). Команда
  `machines` покажет «не поддерживается». Поддержку Windows можно добавить через
  планировщик задач — пока не сделано.

## Ограничения

- Выбранная вкладка и состояние браузера общие для всех агентов: параллельная работа
  в одном Chrome может мешать. Навык просит работать в своей вкладке.
- Любой локальный процесс пользователя на Mac может обратиться к 127.0.0.1:8766 и
  управлять Chrome — так же, как при обычном `--autoConnect`.
- Снимки экрана сохраняются на Mac (путь печатается в ответе).

## Сравнение с Playwright MCP + расширение

Playwright MCP с расширением Chrome подключается через расширение и окна Allow не
вызывает, но даёт меньше возможностей (сеть, консоль, производительность — слабее) и
тоже работает только локально. Browser Relay остаётся основным; Playwright — запасной путь.

## Удаление

```
bb browser-relay service remove --machine <Mac>
bb plugin uninstall browser-relay
```

`service remove` останавливает службу и возвращает прежнюю запись Codex.

## Разработка

```
npm install && npm test && npx tsc --noEmit && bb plugin build
```

Лицензия MIT. Сторонние компоненты: chrome-devtools-mcp (Apache-2.0, Google),
mcp-proxy (MIT) — ставятся на Mac при `service install`, в репозитории не хранятся.
