'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { environment, flush, deferred } = require('./ui-stubs.cjs');

function popup(options = {}) {
  const env = environment(options);
  env.load('popup.js');
  env.run(`settings = {port:3080, retentionMins:30}; state='running'; detail={port:3080,launchUrl:'http://127.0.0.1:3080/?token=valid-test-token'};`);
  return env;
}
function creations(env) { return env.calls.filter(call => call.action === 'create'); }
const tab = (url, extra = {}) => ({ id: 4, windowId: 1, lastAccessed: 1, status: 'complete', url, ...extra });

test('popup parses exact HTTP loopback ports instead of matching URL prefixes', async (t) => {
  for (const url of ['http://127.0.0.1:30801/', 'http://localhost:30801/', 'https://localhost:3080/', 'http://localhost.evil:3080/', 'http://user:pass@localhost:3080/']) {
    await t.test(url, async () => {
      const env = popup({ tabs: [tab(url)] });
      await env.run('openWebUI()');
      assert.equal(creations(env).length, 1);
      assert.equal(env.calls.some(call => call.action === 'update'), false);
      assert.equal(env.calls.some(call => call.action === 'auth'), false);
    });
  }
});

test('confirmed authenticated page is only focused; its URL and draft are never changed', async () => {
  const env = popup({ tabs: [tab('http://localhost:3080/#old-draft')] });
  await env.run(`openWebUI('/#/chat/not-a-supported-route')`);
  assert.equal(creations(env).length, 0);
  assert.equal(env.calls.filter(call => call.action === 'auth').length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(env.calls.find(call => call.action === 'auth').message)), { type: 'dsh-auth-status' });
  assert.deepEqual(env.calls.find(call => call.action === 'update'), { action: 'update', id: 4, active: true });
  assert.equal(env.calls.some(call => call.url || call.action === 'reload'), false);
});

test('401, unknown, missing receiver, wrong response port, discarded and unloaded pages get a separate launch tab', async (t) => {
  const cases = [
    { name: '401', auth: async () => ({ authenticated: false, port: 3080 }) },
    { name: 'unknown', auth: async () => ({ authenticated: null, port: 3080 }) },
    { name: 'no receiver', auth: async () => { throw Error('no receiver'); } },
    { name: 'wrong port', auth: async () => ({ authenticated: true, port: 30801 }) },
    { name: 'discarded', extra: { discarded: true } },
    { name: 'unloaded', extra: { status: 'unloaded' } },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const env = popup({ tabs: [tab('http://127.0.0.1:3080/#draft', scenario.extra)], auth: scenario.auth });
    await env.run('openWebUI()');
    assert.equal(creations(env).length, 1);
    assert.equal(new URL(creations(env)[0].url).searchParams.get('token'), 'valid-test-token');
    assert.equal(env.calls.some(call => call.action === 'update' || call.action === 'reload'), false);
    for (const call of env.calls.filter(call => call.action === 'auth')) assert.equal(JSON.stringify(call).includes('valid-test-token'), false);
  });
});

test('authentication lookup is bounded when a content listener never responds', async () => {
  const env = popup({ tabs: [tab('http://localhost:3080/')], auth: () => new Promise(() => {}) });
  const opening = env.run('openWebUI()');
  await flush();
  await env.clock.advance(2000);
  assert.equal(creations(env).length, 1);
  await opening;
});

test('authenticated candidates outrank unknown ones, then current window and MRU', async () => {
  const env = popup({ tabs: [tab('http://localhost:3080/', { id: 1, lastAccessed: 20 }), tab('http://127.0.0.1:3080/', { id: 2, windowId: 2 })], auth: async id => ({ authenticated: id === 2, port: 3080 }) });
  await env.run('openWebUI()');
  assert.equal(creations(env).length, 0);
  assert.equal(env.calls.find(call => call.action === 'update').id, 2);
});

test('default HTTP port 80 and reported dynamic ports are used, never stale settings', async () => {
  const env = popup({ url: 'http://localhost/', tabs: [tab('http://localhost/#draft')] });
  env.run('detail.port=80; settings.port=3080;');
  await env.run('openWebUI()');
  assert.equal(creations(env).length, 0);
  assert.equal(env.calls.find(call => call.action === 'update').id, 4);
  const dynamic = popup();
  dynamic.run('detail.port=49123; detail.launchUrl="http://localhost:49123/?token=dynamic-token"; settings.port=0;');
  await dynamic.run('openWebUI()');
  assert.equal(new URL(creations(dynamic)[0].url).port, '49123');
  const unresolved = popup();
  unresolved.run('detail.port=0; settings.port=3080;');
  await unresolved.run('openWebUI()');
  assert.equal(creations(unresolved).length, 0);
});

test('invalid launch URLs are rejected, bare URL fallback is token-free and explains the original launch entry', async (t) => {
  const invalid = [
    'https://127.0.0.1:3080/?token=valid-token', 'http://outside.example:3080/?token=valid-token',
    'http://127.0.0.1:30801/?token=valid-token', 'http://127.0.0.1:3080/path?token=valid-token',
    'http://user:pass@127.0.0.1:3080/?token=valid-token', 'http://127.0.0.1:3080/?token=',
    'http://127.0.0.1:3080/?token=a%0Ab', 'http://127.0.0.1:3080/?token=a&token=b',
    'http://127.0.0.1:3080/?token=a&redirect=https://outside.example', 'not a URL',
  ];
  for (const url of invalid) await t.test(url, async () => {
    const env = popup();
    env.addId('toast');
    const text = env.addId('toast-text');
    env.context.candidateUrl = url;
    env.run('detail.launchUrl=candidateUrl;');
    await env.run('openWebUI()');
    assert.equal(new URL(creations(env)[0].url).search, '');
    assert.equal(new URL(creations(env)[0].url).origin, 'http://127.0.0.1:3080');
    assert.match(text.textContent, /原.*启动|启动.*原/);
  });
});

test('new navigation preserves a valid token but does not invent a session hash contract', async () => {
  const env = popup();
  await env.run(`openWebUI('/#/chat/arbitrary-session')`);
  const opened = new URL(creations(env)[0].url);
  assert.equal(opened.searchParams.get('token'), 'valid-test-token');
  assert.equal(opened.hash, '');
});

test('session rows are read-only and existing mark-read / undo behavior remains', async () => {
  const env = popup();
  const unit = env.run(`renderSessionUnit({sessionId:'done',title:'Example',state:'completed',updatedAt:Date.now()})`);
  const row = unit.querySelector('.session-row');
  assert.notEqual(row.style.cursor, 'pointer');
  assert.equal(row.getAttribute('role'), null);
  assert.equal(row.getAttribute('tabindex'), null);
  row.emit('click');
  await flush();
  assert.equal(env.calls.length, 0);
  unit.querySelector('.btn-mark-read').emit('click');
  assert.equal(env.run('pendingReadMap.done.remaining'), 3);
  env.run('cancelInlineUndo("done")');
  assert.equal(env.run('Boolean(pendingReadMap.done)'), false);
  env.run('startInlineCountdown("done", "Example")');
  await env.clock.advance(3180);
  assert.equal(typeof env.storage.readSessions.done, 'number');
});

test('old native sessions response cannot overwrite a newer mirror snapshot', async () => {
  const request = deferred();
  const env = popup({ sendMessage: () => request.promise });
  const refreshing = env.run('refreshSessions()');
  env.run(`applyMirrorSessions({'3080':{items:[{sessionId:'new',state:'waiting'}],at:Date.now()}})`);
  request.resolve({ ok: true, result: { available: true, items: [{ sessionId: 'old', state: 'working' }] } });
  await refreshing;
  assert.equal(env.run('sessionsData.items[0].sessionId'), 'new');
});

test('mirror snapshots expire after 5 seconds and stale/future cache never restores completed rows', async () => {
  const env = popup();
  env.run(`applyMirrorSessions({'3080':{items:[{sessionId:'cached',state:'completed'}],at:Date.now()}})`);
  assert.equal(env.run('sessionsData.items[0].sessionId'), 'cached');
  await env.clock.advance(5000);
  assert.equal(env.run('sessionsData'), null);
  env.run(`applyMirrorSessions({'3080':{items:[{sessionId:'stale',state:'completed'}],at:Date.now()-5001}})`);
  assert.equal(env.run('sessionsData'), null);
  env.run(`applyMirrorSessions({'3080':{items:[{sessionId:'future',state:'completed'}],at:Date.now()+1}})`);
  assert.equal(env.run('sessionsData'), null);
});

test('instance loss and port switch discard cached sessions and old native requests', async () => {
  const request = deferred();
  const env = popup({ sendMessage: () => request.promise });
  env.run('render=()=>{};'); // Lifecycle rendering is outside this request-order regression.
  env.run(`applyMirrorSessions({'3080':{items:[{sessionId:'old-port',state:'working'}],at:Date.now()}})`);
  const refreshing = env.run('refreshSessions()');
  env.run(`applyStatus({state:'stopped',port:3080})`);
  assert.equal(env.run('sessionsData'), null);
  request.resolve({ ok: true, result: { available: true, items: [{ sessionId: 'late', state: 'working' }] } });
  await refreshing;
  assert.equal(env.run('sessionsData'), null);
  env.run(`applyStatus({state:'running',port:49123}); applyMirrorSessions({'49123':{items:[{sessionId:'new-port',state:'waiting'}],at:Date.now()}});`);
  assert.equal(env.run('sessionsData.items[0].sessionId'), 'new-port');
});

test('startup error/progress copy has no fixed 30-second budget or invented restart subphase', () => {
  const env = popup();
  assert.doesNotMatch(env.run('ERROR_TEXTS.START_TIMEOUT'), /30\s*秒/);
  env.run(`pending={action:'restart',phase:'stopping',atMs:Date.now(),ack:true};`);
  assert.doesNotMatch(env.run('row2Text()'), /停止旧进程|旧进程已停止|新进程启动中/);
});
