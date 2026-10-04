'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Test the single-file host's parser without activating its stdin transport.
const source = fs.readFileSync(path.join(__dirname, '..', 'host.js'), 'utf8');
const parser = source.slice(source.indexOf('function readReadiness('), source.indexOf('function readinessEnv('));
const now = Date.now();
const expected = { launchId: 'a'.repeat(32), launchStartedAt: now - 1000, pid: 42, port: 3080 };
const valid = { ...expected, schemaVersion: 1, host: '127.0.0.1', state: 'ready',
  startedAt: now - 2000, updatedAt: now, pluginVersion: '0.4.0', nodeVersion: 'v22.0.0' };
function parse(signal, overrides = {}, want = expected, skipPidCommandCheck = false) {
  const context = { DEFAULT_HOST: '127.0.0.1', READY_FILE: 'owned-path',
    fs: { statSync: () => ({ size: 256 }), readFileSync: () => JSON.stringify(signal) },
    pidAlive: () => true, pidLooksLikeDsh: () => true, ...overrides };
  return vm.runInNewContext(parser + '\nreadReadiness', context)(want, skipPidCommandCheck);
}
test('valid ready and starting leases, including dynamic port discovery', () => {
  assert.equal(parse(valid).state, 'ready');
  assert.equal(parse({ ...valid, state: 'starting' }).state, 'starting');
  assert.equal(parse(valid, {}, { ...expected, port: 0 }).port, 3080);
});
test('reject stale, foreign, malformed or inconsistent leases', () => {
  for (const patch of [ { schemaVersion: 2 }, { launchId: 'b'.repeat(32) },
    { launchStartedAt: now - 999 }, { pid: 43 }, { pid: -1 }, { port: 0 }, { port: 3081 },
    { host: '0.0.0.0' }, { state: 'stopped' }, { updatedAt: now - 20000 },
    { updatedAt: now + 20000 }, { startedAt: 'yesterday' }, { nodeVersion: null },
    { pluginVersion: null } ]) assert.equal(parse({ ...valid, ...patch }), null, JSON.stringify(patch));
  assert.equal(parse(valid, { pidAlive: () => false }), null);
  assert.equal(parse(valid, { pidLooksLikeDsh: () => false }), null);
  assert.equal(parse(valid, {}, {}), null, 'legacy run records fall back');
});
test('missing, oversized and invalid JSON files fall back without throwing', () => {
  for (const fileSystem of [
    { statSync: () => { throw new Error('ENOENT'); } },
    { statSync: () => ({ size: 8193 }) },
    { statSync: () => ({ size: 3 }), readFileSync: () => '{' },
  ]) assert.equal(parse(valid, { fs: fileSystem }), null);
});

test('read-only fast path skips process command lookup but still validates lease and live PID', () => {
  const noCommandLookup = () => { throw new Error('unexpected command lookup'); };
  assert.equal(parse(valid, { pidLooksLikeDsh: noCommandLookup }, expected, true).state, 'ready');
  assert.equal(parse(valid, { pidAlive: () => false, pidLooksLikeDsh: noCommandLookup }, expected, true), null);
  assert.equal(parse({ ...valid, launchId: 'b'.repeat(32) },
    { pidLooksLikeDsh: noCommandLookup }, expected, true), null);
});
