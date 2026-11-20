Let agents on any machine use your real Chrome — your tabs, logins and sessions —
through one shared connection, so Chrome asks "Allow remote debugging?" once per
launch instead of once per agent.

## What you get

- A `bb browser-relay` command for agents on every machine: list tools, call them,
  check the service.
- A background service on the Mac with Chrome that keeps one DevTools connection
  open and shares it.
- Codex on that Mac is pointed at the same service, so its `chrome-devtools` MCP
  stops opening its own connections too.

## How it works

The service runs chrome-devtools-mcp once and serves it over MCP on 127.0.0.1.
The plugin's worker on that Mac talks to it; agents elsewhere reach it through BB.
Nothing is exposed to the network.

## Limits

macOS only. One "Allow" after each Chrome launch or service restart. The selected
tab is shared by all agents.
