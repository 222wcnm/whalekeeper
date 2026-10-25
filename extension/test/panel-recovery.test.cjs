'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { environment, response, flush, deferred } = require('./ui-stubs.cjs');

async function panel(options = {}) {
  const env = environment(options);
  env.load('content/panel.js');
  await flush();
  return env;
}
const summary = (state = 'working', sessionId = 'session') => ({ sessionId, state, updatedAt: 1 });
const snapshot = (source, items) => source.event('snapshot', { ok: true, items });
const probe = env => env.document.documentElement.getAttribute('data-dshm-sse-alive');
const signals = env => env.messages.filter(message => message.type === 'attention');
const mirrors = env => env.messages.filter(message => message.type === 'sessions-sync');

async function authQuery(env, sender = { id: 'own-extension-id' }) {
  let value;
  let kept;
  for (const listener of env.listeners) {
    const result = listener({ type: 'dsh-auth-status' }, sender, response => { value = response; });
    if (result === true) kept = true;
  }
  await flush();
  return { value, kept };
}

test('auth listener is available before title early-return, only reads root status, never injects a panel on 401/non-DSH', async (t) => {
  for (const [status, authenticated] of [[200, true], [401, false], [403, null], [500, null]]) await t.test(String(status), async () => {
    const env = await panel({ title: 'Unauthorized', url: 'http://localhost/#draft', fetch: async () => ({ status, ok: status === 200, json() { throw Error('body must not be read'); }, text() { throw Error('body must not be read'); } }) });
    const result = await authQuery(env);
    assert.equal(result.kept, true);
    assert.deepEqual(JSON.parse(JSON.stringify(result.value)), { authenticated, port: 80 });
    assert.equal(env.document.body.children.length, 0);
    assert.equal(env.sources.length, 0);
    assert.equal(env.fetches.length, 1);
    const requested = new URL(env.fetches[0].url, env.window.location);
    assert.equal(requested.href, 'http://localhost/');
    assert.equal(env.fetches[0].opts.method, 'GET');
    assert.equal(env.fetches[0].opts.credentials, 'same-origin');
  });
});

test('auth listener rejects foreign/missing extension senders without fetching or responding', async () => {
  const env = await panel({ title: 'Other local page' });
  for (const sender of [{ id: 'foreign-extension' }, {}, { id: '' }]) {
    const result = await authQuery(env, sender);
    assert.equal(result.value, undefined);
    assert.equal(result.kept, undefined);
  }
  assert.equal(env.fetches.length, 0);
});

test('auth network failure and timeout return null without secrets or body reads', async () => {
  const failed = await panel({ title: 'Unauthorized', fetch: async () => { throw Error('offline'); } });
  assert.equal((await authQuery(failed)).value?.authenticated, null);
  const hanging = await panel({ title: 'Unauthorized', fetch: () => new Promise(() => {}) });
  let answer;
  assert.equal(hanging.listeners[0]({ type: 'dsh-auth-status' }, { id: 'own-extension-id' }, value => { answer = value; }), true);
  await hanging.clock.advance(1600);
  assert.equal(answer?.authenticated, null);
  assert.deepEqual(Object.keys(answer).sort(), ['authenticated', 'port']);
});

test('panel ownership uses effective default HTTP port 80', async () => {
  const env = await panel({ url: 'http://localhost/' });
  const root = env.document.body.children[0].shadowRoot;
  assert.equal(root.querySelector('.dot').classList.contains('dot-running'), true);
  assert.equal(root.querySelector('.btn').disabled, false);
});

test('SSE open alone is not live; malformed snapshot and pre-snapshot deltas cannot make it live', async () => {
  const env = await panel({ hidden: true });
  const source = env.sources[0];
  source.open();
  assert.notEqual(probe(env), '1');
  source.event('snapshot', { items: [] });
  source.event('snapshot', { ok: true, items: [{ sessionId: 'bad', state: 'unknown' }] });
  source.event('upsert', { session: summary('waiting') });
  await env.clock.advance(100);
  assert.notEqual(probe(env), '1');
  assert.equal(signals(env).some(message => message.kind === 'waiting'), false);
  snapshot(source, [summary()]);
  assert.equal(probe(env), '1');
  await env.clock.advance(100);
  assert.equal(mirrors(env).at(-1).items[0].state, 'working');
});

test('any SSE error immediately clears live, closes stream, clears current attention and resets done baseline', async () => {
  const env = await panel({ hidden: true });
  const source = env.sources[0];
  source.open();
  snapshot(source, [summary()]);
  assert.equal(signals(env).at(-1).kind, 'working');
  source.error();
  assert.equal(source.closed, true);
  assert.equal(probe(env), '0');
  assert.equal(signals(env).at(-1).op, 'clear');
  assert.equal(mirrors(env).some(message => message.items.length === 0), false, 'loss is not an empty snapshot');
  await env.clock.advance(4000);
  assert.equal(signals(env).some(message => message.kind === 'done'), false);
  assert.equal(env.scans.some(selector => selector.includes('data-state')), false);
});

test('no-snapshot watchdog closes in 5 seconds and retries after 15 seconds in visible and hidden pages', async (t) => {
  for (const hidden of [false, true]) await t.test(hidden ? 'hidden' : 'visible', async () => {
    const env = await panel({ hidden });
    env.sources[0].open();
    await env.clock.advance(5000);
    assert.equal(env.sources[0].closed, true);
    assert.equal(probe(env), '0');
    await env.clock.advance(14999);
    assert.equal(env.sources.length, 1);
    await env.clock.advance(1);
    assert.equal(env.sources.length, 2);
    snapshot(env.sources[1], [summary('waiting')]);
    assert.equal(probe(env), '1');
  });
});

test('hidden error retries after 15 seconds and old callbacks cannot overwrite new snapshot or kill new generation', async () => {
  const env = await panel({ hidden: true });
  const old = env.sources[0];
  old.open();
  snapshot(old, [summary('working', 'old')]);
  old.error();
  await env.clock.advance(15000);
  assert.equal(env.sources.length, 2);
  const current = env.sources[1];
  snapshot(current, [summary('waiting', 'current')]);
  old.open();
  snapshot(old, [summary('working', 'stale')]);
  old.event('upsert', { session: summary('working', 'late') });
  old.event('removed', { sessionId: 'current' });
  old.error();
  await env.clock.advance(100);
  assert.equal(probe(env), '1');
  assert.equal(current.closed, false);
  assert.deepEqual(mirrors(env).at(-1).items.map(item => item.sessionId), ['current']);
});

test('late successful HTTP fallback cannot overwrite a newer SSE snapshot', async () => {
  const http = deferred();
  const env = await panel({ hidden: true, fetch: () => http.promise });
  assert.equal(env.fetches.length, 1);
  snapshot(env.sources[0], [summary('waiting', 'new')]);
  http.resolve(response(200, { ok: true, items: [summary('working', 'old')] }));
  await flush();
  await env.clock.advance(100);
  assert.deepEqual(mirrors(env).at(-1).items.map(item => item.sessionId), ['new']);
  assert.equal(signals(env).at(-1).kind, 'waiting');
});

test('late failed HTTP fallback cannot clear a newer SSE snapshot attention', async () => {
  const http = deferred();
  const env = await panel({ hidden: true, fetch: () => http.promise });
  snapshot(env.sources[0], [summary('waiting')]);
  http.resolve(response(500, null));
  await flush();
  assert.equal(signals(env).at(-1).kind, 'waiting');
  assert.equal(probe(env), '1');
});

test('valid HTTP fallback refreshes original mirror in visible and hidden pages without DOM scans', async (t) => {
  for (const hidden of [false, true]) await t.test(hidden ? 'hidden' : 'visible', async () => {
    const env = await panel({ hidden, fetch: async () => response(200, { ok: true, items: [summary('working', 'http')] }) });
    env.sources[0].error();
    await env.clock.advance(1100);
    assert.deepEqual(mirrors(env).at(-1).items.map(item => item.sessionId), ['http']);
    assert.equal(env.scans.some(selector => selector.includes('data-state')), false);
    assert.equal(signals(env).some(message => message.op === 'set'), hidden);
  });
});

test('unavailable HTTP does not synthesize completion; valid stable zero after known working still does', async () => {
  let data = { ok: true, items: [summary()] };
  const env = await panel({ hidden: true, fetch: async () => data === null ? response(500, null) : response(200, data) });
  env.sources[0].error();
  await env.clock.advance(1100);
  assert.equal(signals(env).at(-1).kind, 'working');
  data = null;
  await env.clock.advance(4000);
  assert.equal(signals(env).at(-1).op, 'clear');
  assert.equal(signals(env).some(message => message.kind === 'done'), false);
  data = { ok: true, items: [] };
  await env.clock.advance(3000);
  assert.equal(signals(env).some(message => message.kind === 'done'), false);
  data = { ok: true, items: [summary()] };
  await env.clock.advance(1000);
  data = { ok: true, items: [] };
  await env.clock.advance(3000);
  assert.equal(signals(env).at(-1).kind, 'done');
});

test('auth status cancels unused body and tolerates lost response channel', async () => {
  let canceled = 0;
  const env = await panel({ title: 'Unauthorized', fetch: async () => ({ status: 200, body: { async cancel() { canceled += 1; } } }) });
  assert.equal((await authQuery(env)).value.authenticated, true);
  assert.equal(canceled, 1);
  env.listeners[0]({ type: 'dsh-auth-status' }, { id: 'own-extension-id' }, () => { throw Error('context detached'); });
  await flush();
  assert.equal(canceled, 2);
});

test('SSE remains live without fallback HTTP and visible-to-hidden uses the existing valid snapshot', async () => {
  const env = await panel();
  snapshot(env.sources[0], [summary('waiting')]);
  const before = env.fetches.length;
  env.document.hidden = true;
  env.document.emit('visibilitychange');
  await env.clock.advance(3000);
  assert.equal(env.fetches.length, before);
  assert.equal(signals(env).at(-1).kind, 'waiting');
  env.document.hidden = false;
  env.document.emit('visibilitychange');
  assert.equal(signals(env).at(-1).op, 'clear');
});

test('BFCache pageshow opens a fresh stream and cannot derive done from pre-pagehide working', async () => {
  const env = await panel({ hidden: true });
  snapshot(env.sources[0], [summary()]);
  env.window.emit('pagehide');
  env.window.emit('pageshow');
  assert.equal(env.sources.length, 2);
  snapshot(env.sources[1], []);
  await env.clock.advance(3000);
  assert.equal(signals(env).some(message => message.kind === 'done'), false);
});

test('old callbacks after pagehide cannot re-enable live or publish attention', async () => {
  const env = await panel({ hidden: true });
  snapshot(env.sources[0], [summary()]);
  env.window.emit('pagehide');
  const length = env.messages.length;
  snapshot(env.sources[0], [summary('waiting')]);
  await env.clock.advance(16000);
  assert.equal(env.sources[0].closed, true);
  assert.equal(env.messages.length, length);
});
