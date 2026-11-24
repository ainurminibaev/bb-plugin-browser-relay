import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALL, CONNECT_WAIT_MS, Inflight, addStop, connectedToPort, descendants, holdDispatch, launchdPid, parseActivePort,
  patchToolHandler, readStops, refusal, removeStop, resumeRefusal, sharedStopFile, toAbort,
} from '../lib/stop.ts';

test('the stop list is the file shared with Mac Computer Use', () => {
  assert.equal(sharedStopFile('/Users/u'), '/Users/u/Library/Application Support/bb-agent-stop/stopped-threads.json');
});

test('a stopped thread is refused until resume; other threads and threadless calls go on', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-stop-'));
  const file = join(dir, 'x', 'stopped-threads.json');
  try {
    await addStop(file, 'thr_aaaa1', 7);
    const stops = await readStops(file);
    assert.match(refusal(stops, 'thr_aaaa1') ?? '', /^STOPPED_BY_USER/);
    assert.equal(refusal(stops, 'thr_bbbb2'), null);
    assert.equal(refusal(stops, null), null);
    assert.equal(await removeStop(file, 'thr_aaaa1'), true);
    assert.equal(refusal(await readStops(file), 'thr_aaaa1'), null);
    assert.equal(await removeStop(file, 'thr_aaaa1'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('stop --all refuses everything, threadless calls too', () => {
  const stops = { [ALL]: 1 };
  assert.match(refusal(stops, null) ?? '', /^STOPPED_BY_USER/);
  assert.match(refusal(stops, 'thr_x1234') ?? '', /^STOPPED_BY_USER/);
});

test('a stop aborts only the stopped thread in flight; --all aborts every call', () => {
  const f = new Inflight();
  const a = f.begin('thr_aaaa1'), b = f.begin('thr_bbbb2'), none = f.begin('');
  assert.deepEqual(toAbort({ thr_aaaa1: 1 }, f.keys()), ['thr_aaaa1']);
  assert.equal(f.abort('thr_aaaa1', 'stopped'), 1);
  assert.equal(a.ac.signal.aborted, true);
  assert.equal(b.ac.signal.aborted, false);
  assert.deepEqual(toAbort({ [ALL]: 1 }, f.keys()).sort(), ['', 'thr_aaaa1', 'thr_bbbb2'].sort());
  assert.equal(f.abort(ALL, 'stopped'), 3);
  assert.equal(none.ac.signal.aborted, true);
  a.done(); b.done(); none.done();
  assert.equal(f.count(), 0);
});

test('the caller going away (BB thread stop) aborts its call', () => {
  const f = new Inflight();
  const parent = new AbortController();
  const c = f.begin('thr_cccc3', parent.signal);
  parent.abort('thread-stopped');
  assert.equal(c.ac.signal.aborted, true);
  c.done();
});

test('queue of a stopped thread waits, the user gets through; a thread cannot resume itself', () => {
  assert.equal(holdDispatch({ thr_q1234: 1 }, 'thr_q1234', 'agent', 0).action, 'wait');
  assert.equal(holdDispatch({ thr_q1234: 1 }, 'thr_q1234', 'user', 0).action, 'proceed');
  assert.equal(holdDispatch({}, 'thr_q1234', 'agent', 0).action, 'proceed');
  assert.ok(resumeRefusal('thr_q1234', 'thr_q1234'));
  assert.equal(resumeRefusal('thr_other', 'thr_q1234'), null);
});

test('status: connected only with an ESTABLISHED socket to Chrome\'s DevTools port', () => {
  assert.equal(parseActivePort('9222\n/devtools/browser/abc\n'), 9222);
  assert.equal(parseActivePort(null), null);
  assert.equal(parseActivePort('garbage'), null);
  // Real line from a MacBook (`lsof -nP -iTCP -a -p <chrome-devtools-mcp>`).
  const lsof = 'COMMAND  PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nnode    2562 u   16u  IPv4 0xfa478b2c49221262      0t0  TCP 127.0.0.1:53142->127.0.0.1:9222 (ESTABLISHED)\n';
  assert.equal(connectedToPort(lsof, 9222), true);
  assert.equal(connectedToPort(lsof, 9223), false);
  assert.equal(connectedToPort('node 1 u 16u IPv4 0 0t0 TCP 127.0.0.1:8766 (LISTEN)\n', 9222), false);
});

test('status: the service process tree comes from launchd and ps', () => {
  assert.equal(launchdPid('gui/501/dev.bb.browser-relay = {\n\tstate = running\n\tpid = 2424\n'), 2424);
  assert.equal(launchdPid('state = not running'), null);
  const ps = '  1     0\n2424     1\n2562  2424\n2600  2562\n3000     1\n';
  assert.deepEqual(descendants(ps, 2424), [2562, 2600]);
});

test('service workaround: one connection attempt waits long enough for «Allow»', () => {
  const src = 'x;\nexport const TOOL_CALL_TIMEOUT_MS = 60_000;\nclass ToolCallTimeoutError extends Error {}\n';
  const once = patchToolHandler(src);
  assert.equal(once.found, true);
  assert.equal(once.changed, true);
  assert.match(once.text, new RegExp(`TOOL_CALL_TIMEOUT_MS = ${CONNECT_WAIT_MS};`));
  assert.ok(CONNECT_WAIT_MS >= 5 * 60_000);
  const twice = patchToolHandler(once.text);
  assert.equal(twice.changed, false, 'idempotent');
  assert.equal(twice.found, true);
  assert.deepEqual(patchToolHandler('no such line'), { text: 'no such line', changed: false, found: false });
});
