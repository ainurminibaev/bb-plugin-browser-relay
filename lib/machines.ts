import type { RelayStatus } from '../contract';

export type MachineInfo = { id: string; name: string; connected: boolean; status: RelayStatus | null; error: string | null };

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

function byRef(all: MachineInfo[], ref: string): MachineInfo[] {
  const exact = all.filter(m => m.id === ref.trim() || norm(m.name) === norm(ref));
  if (exact.length || norm(ref).length < 3) return exact;
  return all.filter(m => norm(m.name).includes(norm(ref)));
}

const listing = (all: MachineInfo[]) => all.map(m => `${m.name} (${m.id})`).join('; ');

/**
 * Which machine's Chrome to use: explicit --machine, else the default from settings,
 * else the only connected machine whose service answers. Never guesses between several.
 */
export function pickMachine(all: MachineInfo[], explicit: string | undefined, fallback: string): { machine: MachineInfo } | { error: string; hint: string } {
  const ref = explicit?.trim() || fallback.trim();
  if (ref) {
    const hits = byRef(all, ref);
    if (hits.length === 1) return { machine: hits[0] };
    const what = explicit?.trim() ? `--machine ${ref}` : `машина по умолчанию «${ref}» из настроек плагина`;
    return hits.length
      ? { error: `${what}: подходит несколько машин`, hint: `Укажите ID: ${listing(hits)}` }
      : { error: `${what}: машина не найдена`, hint: `Машины BB: ${listing(all)}` };
  }
  const up = all.filter(m => m.connected && m.status?.serviceUp);
  if (up.length === 1) return { machine: up[0] };
  if (!up.length) return { error: 'ни на одной машине служба Browser Relay не отвечает', hint: 'Поставьте её: bb browser-relay service install --machine <Mac с Chrome>' };
  return { error: `служба отвечает на нескольких машинах: ${listing(up)}`, hint: 'Укажите --machine или задайте машину по умолчанию в настройках плагина Browser Relay.' };
}
