import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { PluginCliError, cliCommand, defineCli } from '@get-bb/plugin-sdk';
import { hostContract, type RelayStatus } from './contract';
import { pickMachine, type MachineInfo } from './lib/machines';

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
    const svc = s.serviceUp ? 'служба отвечает' : s.supported ? 'служба не отвечает' : `служба не поддерживается (${s.platform})`;
    const extra = [
      s.legacyLabels.length ? `прежняя метка: ${s.legacyLabels.join(', ')} — выполните service install` : '',
      s.supported && s.serviceUp && !s.codexPointsHere ? 'Codex на этой машине смотрит не на службу' : '',
    ].filter(Boolean);
    return `${m.name} (${m.id})${mark}: ${svc}${extra.length ? `; ${extra.join('; ')}` : ''}`;
  };

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
          const r = await host.call('call', { tool, args, maxChars: MAX_TOOL_TEXT }, { hostId: m.id, signal: ctx.signal, timeoutMs });
          if (input.options.json) return { exitCode: r.ok ? 0 : 1, stdout: JSON.stringify({ machine: m.id, ...r }, null, 2) };
          const imgs = r.images.length ? `\n\nСнимки сохранены на ${m.name} (${m.id}):\n${r.images.join('\n')}` : '';
          return { exitCode: r.ok ? 0 : 1, stdout: `${r.text}${imgs}` };
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
