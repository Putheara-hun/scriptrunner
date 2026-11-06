import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2';

class FakeRequest {
  listeners = {};
  constructor(pool) {
    this.pool = pool;
  }
  on(event, handler) {
    this.listeners[event] = handler;
  }
  async batch(text) {
    this.pool.batches.push(text);
    const reply = this.pool.replies[text];
    if (reply?.info) this.listeners.info?.({ message: reply.info });
    if (reply?.error) throw reply.error;
    return reply?.result ?? { recordsets: [], rowsAffected: [] };
  }
}

class FakePool {
  static last;
  batches = [];
  replies = {};
  closed = false;
  constructor(config) {
    this.config = config;
    FakePool.last = this;
  }
  on() {}
  async connect() {}
  request() {
    return new FakeRequest(this);
  }
  async close() {
    this.closed = true;
  }
}

const oracleState = {};
const fakeOracle = {
  SYSDBA: 2,
  async getConnection(config) {
    oracleState.config = config;
    oracleState.calls = [];
    return {
      oracleServerVersionString: '19.3.0.0.0',
      async execute(text, binds, options) {
        oracleState.calls.push({ text, options });
        const reply = oracleState.replies?.[text];
        if (reply?.error) throw reply.error;
        return reply?.result ?? {};
      },
      async commit() {
        oracleState.calls.push('commit');
      },
      async rollback() {
        oracleState.calls.push('rollback');
      },
      async close() {
        oracleState.calls.push('close');
      },
    };
  },
};

mock.module('mssql', { defaultExport: { ConnectionPool: FakePool } });
mock.module('oracledb', { defaultExport: fakeOracle });

const { open: openMssql, parseServerName } = await import('../lib/drivers/mssql.js');
const { open: openOracle } = await import('../lib/drivers/oracle.js');
const { open: openMysql } = await import('../lib/drivers/mysql.js');
const { describeConnectionFailure } = await import('../lib/drivers/index.js');

test('connection failures explain what to check, and keep the original message', () => {
  const config = { server: 'db1', port: 1433 };
  const explain = (message, code) => describeConnectionFailure(Object.assign(new Error(message), { code }), config);

  assert.match(explain('Failed to connect to db1:1433 - Could not connect (sequence)', 'ESOCKET'), /^Nothing answered at db1:1433\./);
  assert.match(explain('Failed to connect to db1:1433 - Could not connect (sequence)', 'ESOCKET'), /Details: Failed to connect/);
  assert.match(explain('connect ECONNREFUSED ::1:1433', 'ECONNREFUSED'), /^Nothing answered/);
  assert.match(explain('NJS-503: connection to host db1 port 1433 could not be established.'), /^Nothing answered/);
  assert.match(explain('getaddrinfo ENOTFOUND db1', 'ENOTFOUND'), /could not be found/);
  assert.match(explain('Failed to connect to db1:1433 in 15000ms', 'ETIMEOUT'), /firewall/);
  assert.match(explain('self-signed certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT'), /Verify the server's certificate/);
  assert.equal(explain('password authentication failed for user "app"'), 'password authentication failed for user "app"');
});

test('public mode: drivers connect to the vetted address and apply a query timeout', async () => {

  await openMssql({ server: 'db.example.com', port: 1433, user: 'sa', password: 'x', resolvedHost: '93.184.216.34', statementTimeoutMs: 60000 });
  assert.equal(FakePool.last.config.server, '93.184.216.34');
  assert.equal(FakePool.last.config.requestTimeout, 60000);

  await openOracle({ server: 'ora.example.com', port: 1521, database: 'S', user: 'u', password: 'x', resolvedHost: '93.184.216.34' });
  assert.equal(oracleState.config.connectString, '93.184.216.34:1521/S');
});

test('certificate checking and TCPS follow the form', async () => {
  await openMssql({ server: 'db1', port: 1433, user: 'sa', password: 'x', encrypt: true, verifyCertificate: true });
  assert.equal(FakePool.last.config.options.trustServerCertificate, false);
  await openMssql({ server: 'db1', port: 1433, user: 'sa', password: 'x', encrypt: true });
  assert.equal(FakePool.last.config.options.trustServerCertificate, true);

  await openOracle({ server: 'ora1', port: 2484, database: 'S', user: 'u', password: 'x', encrypt: true });
  assert.equal(oracleState.config.connectString, 'tcps://ora1:2484/S');
});

test('SQL Server: server name forms from SSMS', () => {
  assert.deepEqual(parseServerName('db1', 1433), { host: 'db1', instance: undefined, port: 1433 });
  assert.deepEqual(parseServerName('db1\\SQLEXPRESS', 1433), { host: 'db1', instance: 'SQLEXPRESS', port: 1433 });
  assert.deepEqual(parseServerName('db1, 1444', 1433), { host: 'db1', instance: undefined, port: 1444 });
});

test('SQL Server: long scripts are not cut off, and one connection is shared', async () => {
  await openMssql({ server: 'db1\\SQLEXPRESS', port: 1433, user: 'sa', password: 'x', encrypt: true });
  const { config } = FakePool.last;
  assert.equal(config.requestTimeout, 0);
  assert.deepEqual(config.pool, { min: 1, max: 1 });
  assert.equal(config.server, 'db1');
  assert.equal(config.options.instanceName, 'SQLEXPRESS');
  assert.equal(config.options.encrypt, true);
});

test('SQL Server: results, PRINT output and transactions', async () => {
  const connection = await openMssql({ server: 'db1', port: 1433, user: 'sa', password: 'x' });
  const pool = FakePool.last;
  pool.replies['a'] = {
    info: 'hello from PRINT',
    result: { recordsets: [[{ x: 1 }, { x: 2 }]], rowsAffected: [2, 5] },
  };
  const result = await connection.execute({ text: 'a', line: 1 });
  assert.deepEqual(result, { rows: 2, affected: 5, messages: ['hello from PRINT'] });

  await connection.begin();
  await connection.commit();
  await connection.rollback();
  assert.deepEqual(pool.batches.slice(1), [
    'BEGIN TRANSACTION',
    'IF @@TRANCOUNT > 0 COMMIT TRANSACTION',
    'IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION',
  ]);
  await connection.close();
  assert.equal(pool.closed, true);
});

test('SQL Server: errors point at the real line in the file and keep every message', async () => {
  const connection = await openMssql({ server: 'db1', port: 1433, user: 'sa', password: 'x' });
  const error = Object.assign(new Error('second problem'), {
    number: 208,
    lineNumber: 3,
    precedingErrors: [new Error('first problem')],
  });
  FakePool.last.replies['bad'] = { info: 'before the failure', error };

  const statement = { text: 'bad', line: 10 };
  await assert.rejects(connection.execute(statement));
  assert.deepEqual(error.serverMessages, ['before the failure']);
  assert.deepEqual(connection.describeError(error, statement), {
    message: 'first problem\nsecond problem',
    code: 'Msg 208',
    line: 12,
  });
});

test('Oracle: connects by service name, with SYSDBA only when asked', async () => {
  await openOracle({ server: 'ora1', port: 1521, database: 'XEPDB1', user: 'sys', password: 'x', sysdba: true });
  assert.equal(oracleState.config.connectString, 'ora1:1521/XEPDB1');
  assert.equal(oracleState.config.privilege, 2);

  await openOracle({ server: 'ora1', port: 1521, database: 'XEPDB1', user: 'app', password: 'x' });
  assert.equal('privilege' in oracleState.config, false);
});

test('Oracle: counts rows without loading everything, reports compile errors', async () => {
  const connection = await openOracle({ server: 'o', port: 1521, database: 's', user: 'u', password: 'x' });
  let closed = false;
  const asked = [];
  oracleState.replies = {
    big: {
      result: {
        resultSet: {
          async getRows(count) {
            asked.push(count);
            return new Array(count).fill([1]);
          },
          async close() {
            closed = true;
          },
        },
      },
    },
    dml: { result: { rowsAffected: 3 } },
    proc: { result: { warning: { message: 'NJS-700: creation succeeded with compilation errors' } } },
  };

  const big = await connection.execute({ text: 'big', line: 1 });
  assert.equal(big.rows, 1000);
  assert.equal(big.more, true);
  assert.equal(closed, true);
  assert.deepEqual(asked, [1001]);

  assert.equal((await connection.execute({ text: 'dml', line: 1 })).affected, 3);
  assert.match((await connection.execute({ text: 'proc', line: 1 })).warning, /compilation errors/);
});

test('Oracle: the script controls commits until the end of the file', async () => {
  const connection = await openOracle({ server: 'o', port: 1521, database: 's', user: 'u', password: 'x' });
  await connection.execute({ text: 'x', line: 1 });
  assert.equal(oracleState.calls.includes('commit'), false);
  assert.equal(oracleState.calls[0].options.autoCommit, undefined);
  await connection.finish();
  assert.equal(oracleState.calls.at(-1), 'commit');
});

test('Oracle: error offset becomes a line number', async () => {
  const connection = await openOracle({ server: 'o', port: 1521, database: 's', user: 'u', password: 'x' });
  const error = Object.assign(new Error('ORA-00904: invalid identifier'), { code: 'ORA-00904', offset: 9 });
  const info = connection.describeError(error, { text: 'SELECT\n  nope\nFROM dual', line: 20 });
  assert.deepEqual(info, { message: 'ORA-00904: invalid identifier', code: 'ORA-00904', line: 21 });
});

function startMysqlServer(onQuery) {
  const server = mysql.createServer();
  server.on('connection', (connection) => {
    connection.on('error', () => {});
    connection.serverHandshake({
      protocolVersion: 10,
      serverVersion: 'test-server',
      connectionId: 1,
      statusFlags: 2,
      characterSet: 33,
      capabilityFlags: 0xffffff ^ 0x800 ^ 0x20,
    });
    connection.on('query', (sql) => {
      connection.sequenceId = 1;
      onQuery(sql, connection);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('MySQL: real protocol round trip, with statements sent exactly as written', async () => {
  const received = [];
  const column = {
    catalog: 'def',
    schema: '',
    table: '',
    orgTable: '',
    name: 'v',
    orgName: 'v',
    characterSet: 33,
    columnLength: 384,
    columnType: 253,
    flags: 0,
    decimals: 0,
  };
  const server = await startMysqlServer((sql, connection) => {
    received.push(sql);
    if (sql.startsWith('SELECT nope')) {
      connection.writeError({ code: 1064, message: 'You have an error near nope at line 2' });
    } else if (sql.startsWith('SELECT')) {
      connection.writeTextResult([{ v: '1' }, { v: '2' }], [column]);
    } else {
      connection.writeOk({ affectedRows: 4 });
    }
  });

  try {
    const connection = await openMysql({
      server: '127.0.0.1',
      port: server._server.address().port,
      user: 'root',
      password: 'x',
    });

    const text = "SELECT 'what? ខ្មែរ' AS v";
    assert.deepEqual(await connection.execute({ text, line: 1 }), { rows: 2, affected: 0, messages: [] });
    assert.equal(received.at(-1), text);

    const update = await connection.execute({ text: 'UPDATE t SET a = 1', line: 1 });
    assert.deepEqual(update, { rows: 0, affected: 4, messages: [] });

    const failing = { text: 'SELECT nope\nFROM t', line: 7 };
    const error = await connection.execute(failing).catch((caught) => caught);
    const info = connection.describeError(error, failing);
    assert.equal(info.message, 'You have an error near nope at line 2');
    assert.equal(info.code, 'Error 1064');
    assert.equal(info.line, 8);

    await connection.begin();
    await connection.commit();
    await connection.rollback();
    assert.deepEqual(received.slice(-3), ['START TRANSACTION', 'COMMIT', 'ROLLBACK']);
    await connection.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
