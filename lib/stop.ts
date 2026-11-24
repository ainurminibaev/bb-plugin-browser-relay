/**
 * Stop agent for the relay: which threads may not use the user's Chrome now.
 *
 * The list lives on the machine with Chrome, in the file shared with Mac
 * Computer Use (`~/Library/Application Support/bb-agent-stop/stopped-threads.json`,
 * thread id → when), so one stop blocks a thread's GUI actions and its browser
 * calls alike. The key `*` stops every relay call. A stop lasts until an
 * explicit resume.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const ALL = '*';
export type StopMap = Record<string, number>;

export const sharedStopFile = (home: string) => `${home}/Library/Application Support/bb-agent-stop/stopped-threads.json`;

export async function readStops(file: string): Promise<StopMap> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([, v]) => typeof v === 'number')) as StopMap;
  } catch { return {}; }
}

async function writeStops(file: string, map: StopMap): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(map));
  await rename(tmp, file);
}

/** Why a call from this thread (null: not from a thread) is refused, or null when it may run. */
export function refusal(stops: StopMap, threadId: string | null): string | null {
  if (stops[ALL] !== undefined) return 'STOPPED_BY_USER: Browser Relay остановлен для всех агентов до явного «bb browser-relay resume --all».';
  if (threadId && stops[threadId] !== undefined) return `STOPPED_BY_USER: тред ${threadId} остановлен: доступ к Chrome отозван до явного возобновления. Не повторяй и не обходи остановку.`;
  return null;
}

export async function addStop(file: string, key: string, at = Date.now()): Promise<void> {
  const m = await readStops(file);
  if (m[key] === undefined) { m[key] = at; await writeStops(file, m); }
}

export async function removeStop(file: string, key: string): Promise<boolean> {
  const m = await readStops(file);
  if (m[key] === undefined) return false;
  delete m[key];
  await writeStops(file, m);
  return true;
}

/** Calls in flight by thread (`''` for calls not made from a thread). */
export class Inflight {
  private readonly byKey = new Map<string, Set<AbortController>>();

  begin(key: string, parent?: AbortSignal): { ac: AbortController; done: () => void } {
    const ac = new AbortController();
    const onParent = () => ac.abort(parent?.reason ?? 'cancelled');
    if (parent?.aborted) ac.abort(parent.reason ?? 'cancelled');
    else parent?.addEventListener('abort', onParent, { once: true });
    let set = this.byKey.get(key);
    if (!set) { set = new Set(); this.byKey.set(key, set); }
    set.add(ac);
    return {
      ac,
      done: () => {
        parent?.removeEventListener('abort', onParent);
        const s = this.byKey.get(key);
        s?.delete(ac);
        if (s && !s.size) this.byKey.delete(key);
      },
    };
  }

  keys(): string[] { return [...this.byKey.keys()]; }
  count(): number { let n = 0; for (const s of this.byKey.values()) n += s.size; return n; }

  /** Aborts the calls of one thread, or all with ALL. */
  abort(key: string, reason: string): number {
    let n = 0;
    for (const [k, set] of this.byKey) {
      if (key !== ALL && k !== key) continue;
      for (const ac of set) { ac.abort(reason); n++; }
    }
    return n;
  }
}

/** Calls to abort now given the current stop list. */
export function toAbort(stops: StopMap, running: string[]): string[] {
  if (stops[ALL] !== undefined) return running;
  return running.filter(k => k && stops[k] !== undefined);
}

// ---- BB server side ----

export type DispatchDecision = { action: 'proceed' } | { action: 'wait'; reason: string; sendAt: number };

/** Messages from agents/automations to a stopped thread wait; the user's own go through. */
export function holdDispatch(stopped: Record<string, unknown>, threadId: string, initiator: string, now = Date.now()): DispatchDecision {
  if (!stopped[threadId] || initiator === 'user') return { action: 'proceed' };
  return { action: 'wait', reason: 'Тред остановлен в Browser Relay: очередь ждёт «bb browser-relay resume».', sendAt: now + 10 * 60_000 };
}

export function resumeRefusal(callerThreadId: string | undefined, threadId: string): string | null {
  return callerThreadId && callerThreadId === threadId ? 'Тред не может сам снять свою остановку: это делает пользователь или другой тред по его слову.' : null;
}

// ---- Is the service connected to Chrome? (no new DevTools connection, so no Allow dialog) ----

/** Port from Chrome's `DevToolsActivePort` file (first line), or null. */
export function parseActivePort(text: string | null): number | null {
  const n = Number((text ?? '').split('\n')[0]?.trim());
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/** `lsof -nP -iTCP -sTCP:ESTABLISHED -a -p …` output → is there a connection to Chrome's DevTools port? */
export function connectedToPort(lsof: string, port: number): boolean {
  const re = new RegExp(`->(?:127\\.0\\.0\\.1|\\[::1\\]|localhost):${port}\\b.*\\(ESTABLISHED\\)`);
  return lsof.split('\n').some(l => re.test(l));
}

// ---- Service-side workaround: chrome-devtools-mcp 1.13 drops a pending «Allow» after 60 s ----

/**
 * chrome-devtools-mcp abandons a browser connection attempt after
 * TOOL_CALL_TIMEOUT_MS (60 s in 1.13.0) and closes it, so an «Allow» pressed
 * later does nothing and the next call opens a new dialog. A client cancel
 * does not abandon the attempt — only that timer does. The service keeps one
 * attempt open long enough for the user to answer one dialog.
 */
export const CONNECT_WAIT_MS = 10 * 60_000;
const TIMEOUT_LINE = /export const TOOL_CALL_TIMEOUT_MS = [0-9_]+;/;

export function patchToolHandler(source: string): { text: string; changed: boolean; found: boolean } {
  const m = TIMEOUT_LINE.exec(source);
  if (!m) return { text: source, changed: false, found: false };
  const want = `export const TOOL_CALL_TIMEOUT_MS = ${CONNECT_WAIT_MS};`;
  if (m[0] === want) return { text: source, changed: false, found: true };
  return { text: source.replace(TIMEOUT_LINE, want), changed: true, found: true };
}

/** All descendants of `root` from `ps -A -o pid=,ppid=` output. */
export function descendants(ps: string, root: number): number[] {
  const kids = new Map<number, number[]>();
  for (const line of ps.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || !ppid) continue;
    kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  }
  const out: number[] = [];
  const queue = [...(kids.get(root) ?? [])];
  while (queue.length) {
    const p = queue.shift()!;
    if (out.includes(p)) continue;
    out.push(p);
    queue.push(...(kids.get(p) ?? []));
  }
  return out;
}

/** `launchctl print` output → the service's pid, or null. */
export function launchdPid(text: string): number | null {
  const n = Number(/^\s*pid = (\d+)/m.exec(text)?.[1]);
  return n > 0 ? n : null;
}
