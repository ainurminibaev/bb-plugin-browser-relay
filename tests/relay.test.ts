import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSse, parseBody, renderContent } from '../lib/mcp.ts';
import { codexEntry, codexPointsHere, withCodexEntry, withoutCodexEntry, isLegacyAgent, paths, nodeOk, parseNodeVersion, runScript, launchdPlist, LABEL } from '../lib/service.ts';
import { pickMachine, type MachineInfo } from '../lib/machines.ts';

test('SSE and JSON bodies', () => {
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":1}}\n\n: ping\n\n';
  assert.deepEqual(parseSse(sse), [{ jsonrpc: '2.0', id: 1, result: { ok: 1 } }]);
  assert.equal(parseBody('application/json', '{"jsonrpc":"2.0","id":2,"result":{}}')[0].id, 2);
  assert.deepEqual(parseBody('application/json', ''), []);
});

test('tool content is bounded, images separated', () => {
  const r = renderContent([{ type: 'text', text: 'x'.repeat(50) }, { type: 'image', data: 'AA==', mimeType: 'image/png' }], 10);
  assert.match(r.text, /обрезано: 40/);
  assert.equal(r.images.length, 1);
});

const TOML = 'model = "x"\n\n[mcp_servers.chrome-devtools]\ncommand = "npx"\nargs = ["chrome-devtools-mcp@latest", "--autoConnect"]\n\n[mcp_servers.other]\ncommand = "node"\n';

test('codex: only the chrome-devtools table changes, and back', () => {
  const prev = codexEntry(TOML)!;
  assert.ok(!codexPointsHere(prev));
  const next = withCodexEntry(TOML);
  assert.ok(codexPointsHere(codexEntry(next)));
  assert.ok(next.startsWith('model = "x"\n\n[mcp_servers.chrome-devtools]'));
  assert.ok(next.endsWith('[mcp_servers.other]\ncommand = "node"\n'));
  assert.equal(withCodexEntry(next), next, 'idempotent');
  assert.equal(withoutCodexEntry(next, prev), TOML);
  const appended = withCodexEntry('model = "x"\n');
  assert.ok(appended.startsWith('model = "x"\n\n[mcp_servers.chrome-devtools]'));
  assert.ok(withCodexEntry('').startsWith('[mcp_servers.chrome-devtools]'));
});

test('legacy LaunchAgents are recognised, ours is not', () => {
  const p = paths('/Users/u');
  assert.ok(isLegacyAgent('com.someone.chrome-devtools-mcp-shared', ['/Users/u/.local/share/chrome-devtools-mcp-shared/run.sh'], p));
  assert.ok(isLegacyAgent('dev.bb-config.chrome-devtools-mcp-shared', ['/Users/u/.local/share/chrome-devtools-mcp-shared/run.sh'], p));
  assert.ok(!isLegacyAgent(LABEL, [`${p.installDir}/run.sh`], p));
  assert.ok(!isLegacyAgent('com.other', ['/bin/true'], p));
});

test('generated files', () => {
  const p = paths("/Users/o'k");
  assert.match(runScript(p, '/opt/node/bin'), /--autoConnect/);
  assert.match(runScript(p, '/opt/node/bin'), /'\/Users\/o'\\''k\/\.local\/bin\/mcp-proxy'/);
  assert.match(launchdPlist(p), /<string>dev\.bb\.browser-relay<\/string>/);
  assert.ok(nodeOk(parseNodeVersion('v20.19.0')) && nodeOk(parseNodeVersion('v26.1.0')) && !nodeOk(parseNodeVersion('v20.18.9')));
});

const up = (id: string, name: string, serviceUp: boolean): MachineInfo => ({ id, name, connected: true, error: null,
  status: { platform: 'darwin', supported: true, serviceUp, serviceError: null, installed: true, running: serviceUp, legacyLabels: [], codexPointsHere: true, serverVersion: null } });

test('machine choice never guesses between several', () => {
  const mac = up('host_mac', 'MacBook Pro', true), mini = up('host_mini', 'Mac mini', true), linux = up('host_tru', 'Tru', false);
  assert.equal((pickMachine([mac, linux], undefined, '') as any).machine.id, 'host_mac');
  assert.match((pickMachine([mac, mini], undefined, '') as any).error, /нескольких/);
  assert.equal((pickMachine([mac, mini], undefined, 'Mac mini') as any).machine.id, 'host_mini');
  assert.equal((pickMachine([mac, mini], 'host_mac', 'Mac mini') as any).machine.id, 'host_mac');
  assert.equal((pickMachine([mac, mini], 'macbook', '') as any).machine.id, 'host_mac');
  assert.match((pickMachine([linux], undefined, '') as any).error, /ни на одной/);
  assert.match((pickMachine([mac], 'nope', '') as any).error, /не найдена/);
});
