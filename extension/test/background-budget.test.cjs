'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
function expressionBetween(begin, end, exported, extras = {}) {
  const from = source.indexOf(begin), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, 'background test seam exists');
  return vm.runInNewContext(source.slice(from, to) + '\n' + exported, { URL,
    boundNum: (value, max) => Math.max(0, Math.min(max, Math.floor(Number(value) || 0))), ...extras });
}
const budgets = () => expressionBetween('const NATIVE_TIMEOUT_MS', '// M8/M8.1', 'ACTION_TIMEOUT_MS');
const portOf = () => expressionBetween('function portFromUrl(', '// content script 上报', 'portFromUrl');
test('native action budgets exceed the shared 150-second startup and stop cleanup', () => {
  const actual = budgets();
  assert.equal(actual.start, 210000);
  assert.equal(actual.restart, 240000);
  assert.equal(actual.stop, 60000);
  assert.equal(actual.sessions, 8000);
});
test('loopback URLs use exact authority and effective HTTP port', () => {
  const parse = portOf();
  for (const [url, port] of [
    ['http://127.0.0.1:3080/', 3080], ['http://localhost:30801/#ignored', 30801],
    ['http://127.0.0.1/', 80], ['http://localhost:80/', 80],
  ]) assert.equal(parse(url), port, url);
  for (const url of ['http://127.0.0.1.evil:3080/', 'http://localhost.evil/',
    'http://localhost@untrusted.example/', 'http://u:p@127.0.0.1:3080/',
    'https://127.0.0.1:3080/', 'file:///tmp/test', 'http://127.0.0.1:0/', 'bad url']) {
    assert.equal(parse(url), null, url);
  }
});
test('session mirrors reject unsupported origins and normalize default HTTP port', async () => {
  const state = { cache: {}, writes: 0 };
  const handle = expressionBetween('async function handleSessionsSync(', '// 启动/唤醒时载入既有镜像',
    'handleSessionsSync', {
      portFromUrl: portOf(), sessionsCache: state.cache, SESSIONS_CACHE_MAX: 50,
      scheduleSessionsCacheWrite() { state.writes += 1; },
    });
  for (const url of ['https://127.0.0.1:3080/', 'http://localhost.evil/', 'http://u@localhost/']) {
    await handle({ items: [{ sessionId: 'rejected' }] }, { tab: { id: 1, url } });
  }
  assert.equal(state.writes, 0);
  await handle({ items: [{ sessionId: 'accepted' }] }, { tab: { id: 1, url: 'http://localhost/' } });
  assert.equal(state.cache['80'].items[0].sessionId, 'accepted');
  assert.equal(state.writes, 1);
});
test('attention sender validation follows the same HTTP authority contract', async () => {
  const state = { attention: {}, writes: 0 };
  const handle = expressionBetween('async function handleAttention(', '// 死提醒联动',
    'handleAttention', {
      portFromUrl: portOf(), attentionCache: state.attention, cachedSettings: {},
      ATTENTION_KINDS: { working: 1, waiting: 1, done: 1, idle: 1 },
      ATTENTION_STORE_KEY: 'attentionMap', pruneAttention: value => value,
      chrome: { storage: { local: { async set() { state.writes += 1; } } } }, applyBadge() {},
    });
  const message = { op: 'set', kind: 'waiting', counts: { working: 0, waiting: 1 } };
  await handle(message, { tab: { id: 1, url: 'https://localhost:3080/' } });
  assert.equal(state.writes, 0);
  await handle(message, { tab: { id: 1, url: 'http://localhost/' } });
  assert.equal(state.attention[1].port, 80);
  assert.equal(state.writes, 1);
});
