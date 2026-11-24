import { experimental_defineHostEntry } from '@get-bb/plugin-sdk';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile, chmod, unlink } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { promisify } from 'node:util';
import { hostContract, type RelayStatus } from './contract';
import { McpHttpClient, renderContent, type ToolContent } from './lib/mcp';
import {
  CHROME_FLAGS, LABEL, LEGACY_DIR_NAMES, MCP_PROXY_VERSION, SERVICE_URL, codexEntry, codexPointsHere, isLegacyAgent,
  launchdPlist, nodeOk, parseNodeVersion, paths, runScript, withCodexEntry, withoutCodexEntry, type Paths,
} from './lib/service';
import { ALL, CONNECT_WAIT_MS, Inflight, addStop, connectedToPort, descendants, launchdPid, parseActivePort, patchToolHandler, readStops, refusal, removeStop, sharedStopFile, toAbort } from './lib/stop';
import servicePackage from './service/package.json' with { type: 'json' };
import serviceLock from './service/package-lock.json' with { type: 'json' };

const pexec = promisify(execFile);
const P = (): Paths => paths(homedir(), process.env.CODEX_HOME);
const isMac = () => platform() === 'darwin';
const uid = () => process.getuid?.() ?? 0;

async function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}) {
  try {
    const r = await pexec(cmd, args, { ...opts, maxBuffer: 16 * 1024 * 1024, timeout: opts.timeout ?? 120_000 });
    return { code: 0, out: `${r.stdout}${r.stderr}` };
  } catch (e: any) {
    return { code: typeof e.code === 'number' ? e.code : 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}` };
  }
}
const exists = (f: string) => stat(f).then(() => true, () => false);
const readText = (f: string) => readFile(f, 'utf8').catch(() => null);

async function writeIfChanged(file: string, text: string, mode?: number): Promise<boolean> {
  if ((await readText(file)) === text) return false;
  await mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true });
  await writeFile(file, text);
  if (mode !== undefined) await chmod(file, mode);
  return true;
}

async function labelRunning(label: string): Promise<boolean> {
  const r = await run('launchctl', ['print', `gui/${uid()}/${label}`], { timeout: 10_000 });
  return r.code === 0 && r.out.includes('state = running');
}

async function legacyAgents(p: Paths): Promise<{ label: string; file: string }[]> {
  const dir = `${p.home}/Library/LaunchAgents`;
  const out: { label: string; file: string }[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.endsWith('.plist')) continue;
    const file = `${dir}/${name}`;
    const r = await run('plutil', ['-convert', 'json', '-o', '-', file], { timeout: 10_000 });
    if (r.code !== 0) continue;
    try {
      const d = JSON.parse(r.out);
      if (isLegacyAgent(String(d.Label ?? ''), d.ProgramArguments, p)) out.push({ label: String(d.Label), file });
    } catch { /* not ours */ }
  }
  return out;
}

async function probe(signal?: AbortSignal): Promise<{ version: string | null; error: string | null }> {
  const c = new McpHttpClient(SERVICE_URL, signal ?? AbortSignal.timeout(10_000));
  try {
    const info = await c.initialize();
    return { version: `${info.name} ${info.version}`.trim(), error: null };
  } catch (e: any) {
    return { version: null, error: `нет ответа службы на ${SERVICE_URL}: ${e?.message ?? e}` };
  } finally {
    await c.close();
  }
}

const STOP_FILE = () => sharedStopFile(homedir());
const toolHandlerFile = (p: Paths) => `${p.installDir}/node_modules/chrome-devtools-mcp/out/Default/gen/src/ToolHandler.js`;

/** Does the service hold a DevTools connection to Chrome? Looks at its sockets only: no new connection, no «Allow». */
async function chromeConnection(): Promise<{ connected: boolean | null; detail: string }> {
  if (!isMac()) return { connected: null, detail: 'проверка подключения к Chrome есть только на macOS' };
  const port = parseActivePort(await readText(`${homedir()}/Library/Application Support/Google/Chrome/DevToolsActivePort`));
  if (!port) return { connected: false, detail: 'Chrome не запущен или удалённая отладка выключена (chrome://inspect/#remote-debugging)' };
  const root = launchdPid((await run('launchctl', ['print', `gui/${uid()}/${LABEL}`], { timeout: 10_000 })).out);
  if (!root) return { connected: false, detail: 'служба не запущена' };
  const pids = [root, ...descendants((await run('/bin/ps', ['-A', '-o', 'pid=,ppid='], { timeout: 10_000 })).out, root)];
  const lsof = await run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:ESTABLISHED', '-a', '-p', pids.join(',')], { timeout: 15_000 });
  return connectedToPort(lsof.out, port)
    ? { connected: true, detail: `подключена к Chrome (порт ${port})` }
    : { connected: false, detail: 'к Chrome не подключена: нужна команда `bb browser-relay connect` и одно «Allow» в Chrome' };
}

async function longConnectWait(p: Paths): Promise<boolean | null> {
  const src = await readText(toolHandlerFile(p));
  if (src === null) return null;
  const r = patchToolHandler(src);
  return r.found ? !r.changed : null;
}

async function status(): Promise<RelayStatus> {
  const p = P();
  if (!isMac()) {
    // Not supported for install, but a service someone runs by hand still counts.
    const pr = await probe();
    return { platform: platform(), supported: false, serviceUp: !pr.error, serviceError: pr.error, installed: false, running: false, legacyLabels: [], codexPointsHere: false, serverVersion: pr.version, chromeConnected: null, chromeDetail: 'проверка подключения к Chrome есть только на macOS', longConnectWait: null, stopped: Object.keys(await readStops(STOP_FILE())) };
  }
  const [pr, legacy, installed, toml, chrome, wait, stops] = await Promise.all([probe(), legacyAgents(p), exists(p.plist), readText(p.codexConfig), chromeConnection(), longConnectWait(P()), readStops(STOP_FILE())]);
  return {
    chromeConnected: pr.error ? false : chrome.connected,
    chromeDetail: pr.error ? 'служба не отвечает' : chrome.detail,
    longConnectWait: wait,
    stopped: Object.keys(stops),
    platform: 'darwin',
    supported: true,
    serviceUp: !pr.error,
    serviceError: pr.error,
    installed,
    running: installed ? await labelRunning(LABEL) : false,
    legacyLabels: legacy.map(l => l.label),
    codexPointsHere: codexPointsHere(codexEntry(toml ?? '')),
    serverVersion: pr.version,
  };
}

async function findNodeDir(): Promise<string | null> {
  const cands: string[] = [];
  const w = await run('/bin/bash', ['-lc', 'command -v node'], { timeout: 15_000 });
  if (w.code === 0 && w.out.trim()) cands.push(w.out.trim().split('\n')[0]);
  const nvm = `${homedir()}/.nvm/versions/node`;
  for (const v of (await readdir(nvm).catch(() => [] as string[])).sort().reverse()) cands.push(`${nvm}/${v}/bin/node`);
  cands.push('/opt/homebrew/bin/node', '/usr/local/bin/node');
  for (const c of cands) {
    if (!(await exists(c))) continue;
    const v = await run(c, ['--version'], { timeout: 10_000 });
    if (v.code === 0 && nodeOk(parseNodeVersion(v.out))) return c.slice(0, c.lastIndexOf('/'));
  }
  return null;
}

async function install(): Promise<{ ok: boolean; log: string }> {
  const log: string[] = [];
  if (!isMac()) return { ok: false, log: `Установка службы поддерживается только на macOS (здесь ${platform()}).` };
  const p = P();
  await mkdir(p.backupDir, { recursive: true });
  const nodeDir = await findNodeDir();
  if (!nodeDir) return { ok: false, log: 'Нужен Node.js ≥ 20.19: не найден ни в PATH, ни в ~/.nvm, ни в /opt/homebrew, /usr/local.' };
  const env = { ...process.env, PATH: `${nodeDir}:${process.env.PATH ?? ''}` };

  let changed = false;
  changed = (await writeIfChanged(`${p.installDir}/package.json`, `${JSON.stringify(servicePackage, null, 2)}\n`)) || changed;
  changed = (await writeIfChanged(`${p.installDir}/package-lock.json`, `${JSON.stringify(serviceLock, null, 2)}\n`)) || changed;
  if (changed || !(await exists(`${p.installDir}/node_modules/.bin/chrome-devtools-mcp`))) {
    log.push('npm ci: chrome-devtools-mcp (закреплённая версия)…');
    const r = await run(`${nodeDir}/npm`, ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: p.installDir, env, timeout: 600_000 });
    if (r.code !== 0) return { ok: false, log: [...log, r.out.slice(-2000)].join('\n') };
  }

  // chrome-devtools-mcp drops a pending «Allow» after 60 s: let one attempt wait long enough.
  const th = toolHandlerFile(p);
  const src = await readText(th);
  const patch = src === null ? null : patchToolHandler(src);
  if (patch?.changed) { await writeFile(th, patch.text); changed = true; log.push(`chrome-devtools-mcp: одно подключение ждёт «Allow» до ${CONNECT_WAIT_MS / 60_000} мин (вместо 60 с).`); }
  else if (!patch?.found) log.push('chrome-devtools-mcp: строка таймаута подключения не найдена — «Allow» нужно нажать в течение 60 с.');

  const want = `mcp-proxy ${MCP_PROXY_VERSION}`;
  const have = (await exists(p.mcpProxy)) ? (await run(p.mcpProxy, ['--version'], { timeout: 20_000 })).out.trim() : '';
  if (!have.includes(want)) {
    const uv = await run('/bin/bash', ['-lc', 'command -v uv'], { timeout: 15_000 });
    if (uv.code !== 0 || !uv.out.trim()) return { ok: false, log: [...log, 'Нужен uv (https://docs.astral.sh/uv/) для установки mcp-proxy.'].join('\n') };
    log.push(`uv tool install mcp-proxy==${MCP_PROXY_VERSION}…`);
    const r = await run(uv.out.trim().split('\n')[0], ['tool', 'install', '--force', `mcp-proxy==${MCP_PROXY_VERSION}`], { timeout: 600_000 });
    if (r.code !== 0) return { ok: false, log: [...log, r.out.slice(-2000)].join('\n') };
    changed = true;
  }

  changed = (await writeIfChanged(`${p.installDir}/run.sh`, runScript(p, nodeDir), 0o755)) || changed;

  // Earlier installs (bb-config chrome-devtools-shared, manual labels): stop them, keep a copy of the plist.
  for (const old of await legacyAgents(p)) {
    log.push(`Переношу прежнюю службу ${old.label} → ${LABEL} (Chrome один раз спросит «Allow»).`);
    await run('launchctl', ['bootout', `gui/${uid()}/${old.label}`], { timeout: 30_000 });
    await rename(old.file, `${p.backupDir}/${old.file.split('/').pop()}.${Date.now()}`);
    changed = true;
  }

  const plistChanged = await writeIfChanged(p.plist, launchdPlist(p));
  if (plistChanged) await run('launchctl', ['bootout', `gui/${uid()}/${LABEL}`], { timeout: 30_000 });
  if (plistChanged || !(await labelRunning(LABEL))) {
    const r = await run('launchctl', ['bootstrap', `gui/${uid()}`, p.plist], { timeout: 30_000 });
    if (r.code !== 0 && !(await labelRunning(LABEL))) log.push(`launchctl bootstrap: ${r.out.trim().slice(0, 500)}`);
  } else if (changed) {
    await run('launchctl', ['kickstart', '-k', `gui/${uid()}/${LABEL}`], { timeout: 30_000 });
  }

  // Codex on this machine: point only the chrome-devtools table at the service.
  const toml = (await readText(p.codexConfig)) ?? '';
  const entry = codexEntry(toml);
  if (!codexPointsHere(entry)) {
    if (toml) await copyFile(p.codexConfig, `${p.backupDir}/codex-config.toml.${Date.now()}`);
    if (entry && !(await exists(p.prevCodexEntry))) await writeFile(p.prevCodexEntry, entry);
    await mkdir(p.codexConfig.slice(0, p.codexConfig.lastIndexOf('/')), { recursive: true });
    await writeFile(p.codexConfig, withCodexEntry(toml));
    log.push('Codex: [mcp_servers.chrome-devtools] → служба Browser Relay. Открытые сессии Codex подхватят её после перезапуска.');
  } else if (!(await exists(p.prevCodexEntry))) {
    // Already pointed here by an earlier install: inherit its saved original entry for a clean `remove`.
    for (const d of LEGACY_DIR_NAMES) {
      const prev = `${p.home}/.local/share/${d}/backup/codex-chrome-devtools.previous.toml`;
      if (await exists(prev)) { await copyFile(prev, p.prevCodexEntry); break; }
    }
  }

  let up = await probe();
  for (let i = 0; i < 30 && up.error; i++) { await new Promise(r => setTimeout(r, 500)); up = await probe(); }
  log.push(up.error ? `Служба не отвечает: ${up.error}. Лог: ${p.log}` : `Готово: служба ${LABEL} отвечает на ${SERVICE_URL} (${CHROME_FLAGS[0]}). При первом обращении к Chrome нажмите «Allow» один раз.`);
  return { ok: !up.error, log: log.join('\n') };
}

async function remove(): Promise<{ ok: boolean; log: string }> {
  if (!isMac()) return { ok: false, log: `Не macOS (${platform()}): удалять нечего.` };
  const p = P();
  const log: string[] = [];
  await run('launchctl', ['bootout', `gui/${uid()}/${LABEL}`], { timeout: 30_000 });
  if (await exists(p.plist)) await unlink(p.plist);
  log.push(`Служба ${LABEL} остановлена и снята с автозапуска.`);
  const toml = await readText(p.codexConfig);
  if (toml && codexPointsHere(codexEntry(toml))) {
    await mkdir(p.backupDir, { recursive: true });
    await copyFile(p.codexConfig, `${p.backupDir}/codex-config.toml.${Date.now()}`);
    const prev = (await readText(p.prevCodexEntry)) ?? '';
    await writeFile(p.codexConfig, withoutCodexEntry(toml, prev));
    log.push(prev ? 'Codex: восстановлена прежняя запись chrome-devtools.' : 'Codex: запись chrome-devtools удалена (прежней не было).');
  }
  log.push(`Каталог ${p.installDir} и mcp-proxy оставлены; их можно удалить вручную.`);
  return { ok: true, log: log.join('\n') };
}

// ---- Stop: calls in flight by thread, watched against the shared stop list ----

const inflight = new Inflight();
let watchTimer: ReturnType<typeof setInterval> | null = null;
function watchStops(): void {
  if (watchTimer) return;
  watchTimer = setInterval(() => {
    if (!inflight.count()) { clearInterval(watchTimer!); watchTimer = null; return; }
    void readStops(STOP_FILE()).then(stops => { for (const k of toAbort(stops, inflight.keys())) inflight.abort(k, 'stopped'); }).catch(() => undefined);
  }, 500);
}

/** Runs one tool call through the service; Stop aborts it and tells the service to cancel. */
async function callTool(tool: string, args: Record<string, unknown>, threadId: string | null, signal: AbortSignal) {
  const stopped = refusal(await readStops(STOP_FILE()), threadId);
  if (stopped) return { stopped, result: null };
  const flight = inflight.begin(threadId ?? '', signal);
  watchStops();
  const c = new McpHttpClient(SERVICE_URL, flight.ac.signal);
  try {
    await c.initialize();
    const result = await c.request('tools/call', { name: tool, arguments: args });
    return { stopped: null, result };
  } catch (e) {
    if (flight.ac.signal.aborted) return { stopped: refusal(await readStops(STOP_FILE()), threadId) ?? 'CANCELLED: вызов отменён.', result: null };
    throw e;
  } finally {
    flight.done();
    await c.close();
  }
}

let pendingConnect: Promise<{ ok: boolean; connected: boolean; text: string }> | null = null;

/** One attempt, one «Allow»: never retried here; a second `connect` joins the pending one. */
async function connect(waitMs: number, threadId: string | null, signal: AbortSignal): Promise<{ ok: boolean; connected: boolean; text: string }> {
  const before = await chromeConnection();
  if (before.connected) return { ok: true, connected: true, text: `Служба уже ${before.detail}. Окна «Allow» не будет.` };
  if (pendingConnect) return pendingConnect;
  pendingConnect = (async () => {
    const wait = await longConnectWait(P());
    const note = wait ? '' : ' Служба ещё старой установки: chrome-devtools-mcp бросает попытку через 60 с — выполните `bb browser-relay service install`, чтобы ждать дольше.';
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort('timeout'), waitMs);
    const onAbort = () => ac.abort('cancelled');
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const r = await callTool('list_pages', {}, threadId, ac.signal).catch((e: any) => ({ stopped: null, result: null, error: String(e?.message ?? e) }));
      const after = await chromeConnection();
      if (!after.connected && ac.signal.reason === 'timeout') return { ok: false, connected: false, text: `«Allow» не нажат за ${Math.round(waitMs / 1000)} с. Попытка в службе ещё ждёт${wait ? ` до ${CONNECT_WAIT_MS / 60_000} мин` : ''}: если окно «Allow» открыто в Chrome, нажмите его; новых попыток не делаю.${note}` };
      if (r.stopped) return { ok: false, connected: !!after.connected, text: r.stopped };
      if (after.connected || (r.result && !r.result.isError)) return { ok: true, connected: true, text: `Подключено к Chrome. Дальше окон «Allow» нет до перезапуска Chrome или службы.${note}` };
      const why = 'error' in r ? r.error : r.result?.isError ? renderContent((r.result.content ?? []) as ToolContent[], 2000).text : 'нет ответа';
      return { ok: false, connected: false, text: `Не подключено: ${why}. Повторять сразу не нужно: если окно «Allow» ещё открыто в Chrome, нажмите его; иначе запустите connect снова один раз.${note}` };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  })().finally(() => { pendingConnect = null; });
  return pendingConnect;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    status: async () => status(),
    tools: async (_input, context) => {
      const c = new McpHttpClient(SERVICE_URL, context.signal);
      try {
        await c.initialize();
        const r = await c.request('tools/list', {});
        return (r?.tools ?? []).map((t: any) => ({ name: String(t.name), description: String(t.description ?? '').split('\n')[0].slice(0, 200) }));
      } finally {
        await c.close();
      }
    },
    call: async ({ tool, args, maxChars, threadId }, context) => {
      {
        const { stopped, result: r } = await callTool(tool, args, threadId ?? null, context.signal);
        if (stopped) return { ok: false, text: stopped, images: [] };
        const { text, images } = renderContent((r?.content ?? []) as ToolContent[], maxChars);
        const dir = `${context.experimental_paths.dataDir}/images`;
        const saved: string[] = [];
        if (images.length) await mkdir(dir, { recursive: true });
        for (const [i, img] of images.entries()) {
          const ext = img.mimeType.includes('jpeg') ? 'jpg' : img.mimeType.includes('webp') ? 'webp' : 'png';
          const f = `${dir}/${Date.now()}-${i}.${ext}`;
          await writeFile(f, Buffer.from(img.data, 'base64'));
          saved.push(f);
        }
        return { ok: !r?.isError, text, images: saved };
      }
    },
    connect: async ({ waitMs, threadId }, context) => connect(waitMs, threadId ?? null, context.signal),
    stop: async ({ key }) => {
      await addStop(STOP_FILE(), key);
      const aborted = inflight.abort(key, 'stopped');
      const log = [`Остановлено: ${key === ALL ? 'все вызовы Browser Relay' : `тред ${key}`}${aborted ? `; прервано вызовов в полёте: ${aborted}` : ''}.`];
      // Agents that talk to the service directly (Codex MCP) cannot be told apart: stopping everything stops the service itself.
      if (key === ALL && isMac()) {
        await run('launchctl', ['bootout', `gui/${uid()}/${LABEL}`], { timeout: 30_000 });
        log.push('Служба остановлена: соединение с Chrome закрыто, прямые подключения (Codex) тоже отрезаны. После `resume --all` Chrome один раз спросит «Allow».');
      }
      return { ok: true, aborted, log: log.join('\n') };
    },
    resume: async ({ key }) => {
      const had = await removeStop(STOP_FILE(), key);
      const log = [had ? `Снята остановка: ${key === ALL ? 'все вызовы' : `тред ${key}`}.` : 'Остановки не было.'];
      if (key === ALL && isMac() && (await exists(P().plist)) && !(await labelRunning(LABEL))) {
        const r = await run('launchctl', ['bootstrap', `gui/${uid()}`, P().plist], { timeout: 30_000 });
        log.push(r.code === 0 || (await labelRunning(LABEL)) ? 'Служба запущена снова; при первом обращении Chrome спросит «Allow».' : `Службу запустить не удалось: ${r.out.trim().slice(0, 300)}`);
      }
      return { ok: true, log: log.join('\n') };
    },
    service: async ({ action }) => (action === 'install' ? install() : remove()),
  },
});
