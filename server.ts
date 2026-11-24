import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { PluginCliError, cliCommand, defineCli } from '@get-bb/plugin-sdk';
import { hostContract, type RelayStatus } from './contract';
import { pickMachine, type MachineInfo } from './lib/machines';
import { ALL, holdDispatch, resumeRefusal } from './lib/stop';

const MAX_TOOL_TEXT = 200_000;

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    defaultMachine: {
      type: 'string',
      label: 'Машина с Chrome по умолчанию (ID host_… или имя из `bb machine list`)',
      default: '',
    },
  });
  const host = bb.hosts.experimental_client({ contract: hostContract });

  async function probeAll(signal?: AbortSignal): Promise<MachineInfo[]> {
    const hosts = await bb.sdk.hosts.list();
    return Promise.all(hosts.map(async h => {
      let status: RelayStatus | null = null;
      let error: string | null = null;
      if (h.status === 'connected') {
        status = await host.call('status', null, { hostId: h.id, signal, timeoutMs: 20_000 }).catch((e: any) => { error = String(e?.message ?? e).slice(0, 200); return null; });
      }
      return { id: h.id, name: h.name, connected: h.status === 'connected', status, error };
    }));
  }

  async function resolve(machine: string | undefined, signal?: AbortSignal): Promise<MachineInfo> {
    const all = await probeAll(signal);
    const r = pickMachine(all, machine, (await settings.get()).defaultMachine);
    if ('error' in r) throw new PluginCliError(r.error, { code: 'machine', hint: r.hint });
    return r.machine;
  }

  const machineOpt = { type: 'string' as const, aliases: ['host'], description: 'Машина с Chrome: ID (host_…) или имя. По умолчанию — из настроек плагина или единственная машина с работающей службой.' };
  const jsonOpt = { type: 'boolean' as const, description: 'Вывести JSON' };

  const describe = (m: MachineInfo, def: string) => {
    const s = m.status;
    const mark = def && (m.id === def || m.name === def) ? ' [по умолчанию]' : '';
    if (!m.connected) return `${m.name} (${m.id})${mark}: машина не в сети`;
    if (!s) return `${m.name} (${m.id})${mark}: нет ответа плагина — ${m.error ?? 'неизвестно'}`;
    const svc = s.serviceUp ? `служба отвечает, ${s.chromeConnected === null ? s.chromeDetail || 'подключение к Chrome неизвестно' : s.chromeDetail}` : s.supported ? 'служба не отвечает' : `служба не поддерживается (${s.platform})`;
    const extra = [
      s.stopped?.length ? `остановлено: ${s.stopped.map(k => (k === ALL ? 'всё' : k)).join(', ')}` : '',
      s.serviceUp && s.longConnectWait === false ? 'служба ждёт «Allow» только 60 с — выполните service install' : '',
      s.legacyLabels.length ? `прежняя метка: ${s.legacyLabels.join(', ')} — выполните service install` : '',
      s.supported && s.serviceUp && !s.codexPointsHere ? 'Codex на этой машине смотрит не на службу' : '',
    ].filter(Boolean);
    return `${m.name} (${m.id})${mark}: ${svc}${extra.length ? `; ${extra.join('; ')}` : ''}`;
  };

  // ---- Stop by thread: the queue of a stopped thread waits until resume ----
  let stoppedThreads: Record<string, number> = {};
  const loaded = bb.storage.kv.get<Record<string, number>>('stopped-threads').then(v => { stoppedThreads = v ?? {}; }).catch(() => undefined);
  async function rememberStop(threadId: string): Promise<void> {
    await loaded;
    stoppedThreads = { ...stoppedThreads, [threadId]: stoppedThreads[threadId] ?? Date.now() };
    await bb.storage.kv.set('stopped-threads', stoppedThreads).catch(() => undefined);
  }
  async function forgetStop(threadId: string): Promise<void> {
    await loaded;
    if (!stoppedThreads[threadId]) return;
    const { [threadId]: _gone, ...rest } = stoppedThreads;
    stoppedThreads = rest;
    await bb.storage.kv.set('stopped-threads', stoppedThreads).catch(() => undefined);
    await bb.experimental_hooks.recheck('message.dispatch').catch(() => undefined);
  }
  bb.experimental_hooks.on('message.dispatch', ctx => {
    try { return holdDispatch(stoppedThreads, ctx.thread.id, String(ctx.initiator)); } catch { return { action: 'proceed' }; }
  });
  const threadArg = (v: string | undefined, ctx: { threadId?: string }) => {
    const t = (v ?? ctx.threadId ?? '').trim();
    if (!/^thr_[A-Za-z0-9]{4,64}$/.test(t)) throw new PluginCliError('нужен ID треда', { code: 'thread', hint: '--thread thr_…' });
    return t;
  };
  /** The named machine, or every machine where the service runs (a stop must not miss one). */
  async function stopTargets(machine: string | undefined, signal?: AbortSignal): Promise<MachineInfo[]> {
    if (machine) return [await resolve(machine, signal)];
    return (await probeAll(signal)).filter(m => m.connected && m.status && (m.status.serviceUp || m.status.installed));
  }

  bb.cli.register(defineCli({
    name: 'browser-relay',
    summary: 'Настоящий Chrome пользователя через одно общее подключение — без повторных «Allow remote debugging?». Работает с любой машины.',
    commands: {
      machines: cliCommand({
        summary: 'Список машин: где стоит служба и отвечает ли она',
        options: { json: jsonOpt },
        async run(input, ctx) {
          const all = await probeAll(ctx.signal);
          const def = (await settings.get()).defaultMachine.trim();
          if (input.options.json) return { exitCode: 0, stdout: JSON.stringify({ defaultMachine: def || null, machines: all }, null, 2) };
          return { exitCode: 0, stdout: all.map(m => describe(m, def)).join('\n') };
        },
      }),
      status: cliCommand({
        summary: 'Состояние службы на машине (Chrome не трогает, окна Allow нет)',
        options: { machine: machineOpt, json: jsonOpt },
        async run(input, ctx) {
          const m = await resolve(input.options.machine, ctx.signal);
          if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(m, null, 2) };
          return { exitCode: m.status?.serviceUp ? 0 : 1, stdout: describe(m, (await settings.get()).defaultMachine.trim()) };
        },
      }),
      tools: cliCommand({
        summary: 'Инструменты браузера (chrome-devtools-mcp): имя и описание',
        options: { machine: machineOpt, json: jsonOpt },
        async run(input, ctx) {
          const m = await resolve(input.options.machine, ctx.signal);
          const tools = await host.call('tools', null, { hostId: m.id, signal: ctx.signal, timeoutMs: 60_000 });
          if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(tools, null, 2) };
          return { exitCode: 0, stdout: tools.map(t => `${t.name} — ${t.description}`).join('\n') };
        },
      }),
      call: cliCommand({
        summary: 'Вызвать инструмент браузера: bb browser-relay call navigate_page --args \'{"url":"https://…"}\'',
        positionals: [{ name: 'tool', description: 'Имя инструмента из `bb browser-relay tools`', required: true }],
        options: {
          args: { type: 'string', aliases: ['arguments', 'input'], description: 'Аргументы инструмента, JSON-объект (по умолчанию {})' },
          machine: machineOpt,
          timeout: { type: 'duration', defaultUnit: 's', description: 'Сколько ждать ответа (по умолчанию 120 с, максимум 30 мин)' },
          json: jsonOpt,
        },
        async run(input, ctx) {
          let args: Record<string, unknown> = {};
          if (input.options.args) {
            try { args = JSON.parse(input.options.args); } catch { throw new PluginCliError('--args: не JSON', { code: 'bad_args', hint: 'Пример: --args \'{"url":"https://example.com"}\'' }); }
            if (!args || typeof args !== 'object' || Array.isArray(args)) throw new PluginCliError('--args должен быть JSON-объектом', { code: 'bad_args' });
          }
          const tool = input.positionals.tool;
          if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool)) throw new PluginCliError(`неверное имя инструмента: ${tool}`, { code: 'bad_tool', hint: 'Список: bb browser-relay tools' });
          const m = await resolve(input.options.machine, ctx.signal);
          if (!m.status?.serviceUp) throw new PluginCliError(`${m.name}: служба Browser Relay не отвечает`, { code: 'service_down', hint: `bb browser-relay service install --machine ${m.id}` });
          const timeoutMs = Math.min(Math.max(Number(input.options.timeout ?? 120_000), 1_000), 1_800_000);
          // Not connected yet: one `connect` waits for one «Allow»; a plain call would start a new attempt each time.
          if (m.status.chromeConnected === false) throw new PluginCliError(`${m.name}: служба не подключена к Chrome`, { code: 'not_connected', hint: `bb browser-relay connect --machine ${m.id} — один раз, затем нажмите «Allow» в Chrome` });
          const r = await host.call('call', { tool, args, maxChars: MAX_TOOL_TEXT, threadId: ctx.threadId ?? null }, { hostId: m.id, signal: ctx.signal, timeoutMs });
          if (r.text.startsWith('STOPPED_BY_USER')) return { exitCode: 3, stdout: r.text };
          if (input.options.json) return { exitCode: r.ok ? 0 : 1, stdout: JSON.stringify({ machine: m.id, ...r }, null, 2) };
          const imgs = r.images.length ? `\n\nСнимки сохранены на ${m.name} (${m.id}):\n${r.images.join('\n')}` : '';
          return { exitCode: r.ok ? 0 : 1, stdout: `${r.text}${imgs}` };
        },
      }),
      connect: cliCommand({
        summary: 'Подключить службу к Chrome: одна попытка, одно окно «Allow», долгое ожидание без повторов',
        options: { machine: machineOpt, wait: { type: 'duration', defaultUnit: 's', description: 'Сколько ждать нажатия «Allow» (по умолчанию 10 мин, максимум 30 мин)' } },
        async run(input, ctx) {
          const m = await resolve(input.options.machine, ctx.signal);
          if (!m.status?.serviceUp) throw new PluginCliError(`${m.name}: служба Browser Relay не отвечает`, { code: 'service_down', hint: `bb browser-relay service install --machine ${m.id}` });
          const waitMs = Math.min(Math.max(Number(input.options.wait ?? 600_000), 5_000), 1_800_000);
          const r = await host.call('connect', { waitMs, threadId: ctx.threadId ?? null }, { hostId: m.id, signal: ctx.signal, timeoutMs: waitMs + 30_000 });
          return { exitCode: r.connected ? 0 : 1, stdout: `${m.name} (${m.id}): ${r.text}` };
        },
      }),
      stop: cliCommand({
        summary: 'Остановить тред (или всё с --all): прервать вызовы в полёте, отказывать до resume, остановить ход треда',
        options: { thread: { type: 'string', description: 'ID треда (thr_…); по умолчанию — тред, из которого вызвана команда' }, all: { type: 'boolean', description: 'Остановить всё: все вызовы и саму службу (после resume --all нужен новый «Allow»)' }, machine: machineOpt },
        async run(input, ctx) {
          const key = input.options.all ? ALL : threadArg(input.options.thread, ctx);
          const targets = await stopTargets(input.options.machine, ctx.signal);
          const lines: string[] = [];
          for (const m of targets) {
            const r = await host.call('stop', { key }, { hostId: m.id, signal: ctx.signal, timeoutMs: 60_000 }).catch((e: any) => ({ ok: false, aborted: 0, log: `НЕ остановлено — ${String(e?.message ?? e).slice(0, 200)}` }));
            lines.push(`${m.name} (${m.id}): ${r.log}`);
          }
          if (key !== ALL) {
            await rememberStop(key);
            const stopped = await bb.sdk.threads.stop({ threadId: key }).then(() => true, () => false);
            lines.push(stopped ? `Тред ${key}: ход остановлен; сообщения агентов и автоматизаций ждут возобновления.` : `Тред ${key}: ход не остановлен (не найден или уже стоит).`);
          }
          return { exitCode: lines.some(l => l.includes('НЕ остановлено')) || !targets.length ? 1 : 0, stdout: targets.length ? lines.join('\n') : 'Нет машин с работающей службой.' };
        },
      }),
      resume: cliCommand({
        summary: 'Снять остановку треда (--thread) или всего (--all)',
        options: { thread: { type: 'string', description: 'ID треда (thr_…)' }, all: { type: 'boolean', description: 'Снять общую остановку и запустить службу' }, machine: machineOpt },
        async run(input, ctx) {
          if (!input.options.all && !input.options.thread) throw new PluginCliError('нужен --thread thr_… или --all', { code: 'thread' });
          const key = input.options.all ? ALL : threadArg(input.options.thread, ctx);
          const refusal = key === ALL ? null : resumeRefusal(ctx.threadId, key);
          if (refusal) throw new PluginCliError(refusal, { code: 'self_resume' });
          const lines: string[] = [];
          for (const m of await stopTargets(input.options.machine, ctx.signal)) {
            const r = await host.call('resume', { key }, { hostId: m.id, signal: ctx.signal, timeoutMs: 60_000 }).catch((e: any) => ({ ok: false, log: `не снято — ${String(e?.message ?? e).slice(0, 200)}` }));
            lines.push(`${m.name} (${m.id}): ${r.log}`);
          }
          if (key !== ALL) await forgetStop(key);
          return { exitCode: lines.some(l => l.includes('не снято')) ? 1 : 0, stdout: lines.join('\n') || 'Машин нет.' };
        },
      }),
      'service install': cliCommand({
        summary: 'Поставить или обновить службу на машине с Chrome (macOS; идемпотентно; одно «Allow» после переноса)',
        options: { machine: machineOpt },
        async run(input, ctx) {
          const m = await resolve(input.options.machine, ctx.signal);
          const r = await host.call('service', { action: 'install' }, { hostId: m.id, signal: ctx.signal, timeoutMs: 1_200_000 });
          return { exitCode: r.ok ? 0 : 1, stdout: `${m.name} (${m.id}):\n${r.log}` };
        },
      }),
      'service remove': cliCommand({
        summary: 'Остановить службу и вернуть прежнюю запись Codex',
        options: { machine: machineOpt },
        async run(input, ctx) {
          const m = await resolve(input.options.machine, ctx.signal);
          const r = await host.call('service', { action: 'remove' }, { hostId: m.id, signal: ctx.signal, timeoutMs: 120_000 });
          return { exitCode: r.ok ? 0 : 1, stdout: `${m.name} (${m.id}):\n${r.log}` };
        },
      }),
    },
  }));
}
