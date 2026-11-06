import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUsageCounter } from '../lib/usage.js';

function withTempFolder(run) {
  const folder = mkdtempSync(path.join(tmpdir(), 'dbautorun-usage-'));
  try {
    return run(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

test('counts users, runs and scripts separately', () => {
  withTempFolder((folder) => {
    const usage = createUsageCounter(path.join(folder, 'usage.json'));
    usage.recordScript({ newRun: true, newUser: true });
    usage.recordScript({ newRun: false, newUser: false });
    usage.recordScript({ newRun: true, newUser: false });

    const { users, runs, scripts } = usage.totals();
    assert.deepEqual({ users, runs, scripts }, { users: 1, runs: 2, scripts: 3 });
  });
});

test('counts survive a restart', () => {
  withTempFolder((folder) => {
    const file = path.join(folder, 'nested', 'usage.json');
    createUsageCounter(file).recordScript({ newRun: true, newUser: true });

    const reopened = createUsageCounter(file);
    assert.equal(reopened.totals().users, 1);
    reopened.recordScript({ newRun: true, newUser: true });
    assert.equal(createUsageCounter(file).totals().users, 2);
  });
});

test('the file holds only the totals and the start date', () => {
  withTempFolder((folder) => {
    const file = path.join(folder, 'usage.json');
    createUsageCounter(file).recordScript({ newRun: true, newUser: true });
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))), ['users', 'runs', 'scripts', 'since']);
  });
});

test('a damaged file is kept aside and counting starts again', (context) => {
  context.mock.method(console, 'error', () => {});
  withTempFolder((folder) => {
    const file = path.join(folder, 'usage.json');
    writeFileSync(file, '{ not json');

    const usage = createUsageCounter(file);
    assert.equal(usage.totals().users, 0);
    assert.equal(readFileSync(`${file}.damaged`, 'utf8'), '{ not json');
    usage.recordScript({ newRun: true, newUser: true });
    assert.equal(createUsageCounter(file).totals().users, 1);
  });
});

test('a failed save does not stop the run', (context) => {
  const logged = context.mock.method(console, 'error', () => {});
  withTempFolder((folder) => {
    const blocker = path.join(folder, 'a-file');
    writeFileSync(blocker, '');

    const usage = createUsageCounter(path.join(blocker, 'usage.json'));
    assert.doesNotThrow(() => usage.recordScript({ newRun: true, newUser: true }));
    assert.equal(usage.totals().users, 1);
    assert.equal(logged.mock.callCount() > 0, true);
  });
});
