import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeSingleQuotes, formatDateParts, toHex, dumpDatabase } from '../lib/backup.js';

test('string and byte helpers', () => {
  assert.equal(escapeSingleQuotes("O'Brien"), "O''Brien");
  assert.equal(escapeSingleQuotes("a'b'c"), "a''b''c");
  assert.equal(toHex(Buffer.from([0xde, 0xad])), 'dead');
});

test('date parts are zero-padded', () => {
  const d = formatDateParts(new Date(2026, 0, 5, 3, 7, 9, 4));
  assert.deepEqual(d, { year: 2026, month: '01', day: '05', hour: '03', minute: '07', second: '09', ms: '004' });
});

function fakeIntrospect() {
  return {
    dialect: 'test',
    quoteId: (name) => `"${name}"`,
    quoteTable: (table) => `"${table.name}"`,
    dropTableSql: (table) => `DROP TABLE IF EXISTS "${table.name}";`,
    async tables() {
      return [{ name: 't1' }, { name: 'empty' }];
    },
    async columns(table) {
      if (table.name === 'empty') return [{ name: 'id', typeSql: 'int', notNull: true }];
      return [
        { name: 'id', typeSql: 'int', notNull: true },
        { name: 'val', typeSql: 'text', notNull: false, default: "'x'" },
      ];
    },
    async primaryKey() {
      return ['id'];
    },
    async *rows(table) {
      if (table.name === 'empty') return;
      yield { id: 1, val: 'a' };
      yield { id: 2, val: null };
    },
    formatValue(value) {
      if (value === null || value === undefined) return 'NULL';
      return typeof value === 'number' ? String(value) : `'${value}'`;
    },
  };
}

test('dumpDatabase writes drop, create, and inserts in order', async () => {
  let out = '';
  const result = await dumpDatabase(fakeIntrospect(), (chunk) => { out += chunk; }, { database: 'demo' });

  assert.deepEqual(result, { tables: 2, rows: 2 });
  assert.match(out, /-- DB AutoRun backup/);
  assert.match(out, /-- Database: demo \(test\)/);
  assert.ok(out.includes('DROP TABLE IF EXISTS "t1";'));
  assert.ok(out.includes('CREATE TABLE "t1" (\n  "id" int NOT NULL,\n  "val" text DEFAULT \'x\',\n  PRIMARY KEY ("id")\n);'));
  assert.ok(out.includes('INSERT INTO "t1" ("id", "val") VALUES (1, \'a\');'));
  assert.ok(out.includes('INSERT INTO "t1" ("id", "val") VALUES (2, NULL);'));

  const createAt = out.indexOf('CREATE TABLE "t1"');
  const insertAt = out.indexOf('INSERT INTO "t1"');
  assert.ok(createAt !== -1 && insertAt > createAt, 'create comes before insert');
});

test('dumpDatabase creates an empty table but writes no inserts for it', async () => {
  let out = '';
  await dumpDatabase(fakeIntrospect(), (chunk) => { out += chunk; });
  assert.ok(out.includes('CREATE TABLE "empty"'));
  assert.ok(!out.includes('INSERT INTO "empty"'));
});

test('dumpDatabase reports when there are no tables', async () => {
  const introspect = { ...fakeIntrospect(), async tables() { return []; } };
  let out = '';
  const result = await dumpDatabase(introspect, (chunk) => { out += chunk; });
  assert.deepEqual(result, { tables: 0, rows: 0 });
  assert.match(out, /No tables found/);
});
