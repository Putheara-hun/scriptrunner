import sql from 'mssql';

// Accepts the forms people paste from SSMS: host, host\INSTANCE and host,1433.
export function parseServerName(server, port) {
  const [hostAndInstance, portAfterComma] = server.split(',').map((part) => part.trim());
  const [host, instance] = hostAndInstance.split('\\');
  return {
    host,
    instance: instance || undefined,
    port: portAfterComma ? Number(portAfterComma) : port,
  };
}

export async function open(config) {
  const { host, instance, port } = parseServerName(config.server, config.port);

  // One connection only, so BEGIN TRAN, SET options and #temp tables carry from
  // one batch to the next, exactly as they do in sqlcmd.
  const pool = new sql.ConnectionPool({
    server: host,
    port,
    database: config.database || undefined,
    user: config.user,
    password: config.password,
    connectionTimeout: 15000,
    requestTimeout: 0, // scripts can legitimately run for hours
    pool: { min: 1, max: 1 },
    validateConnection: false,
    options: {
      appName: 'DB AutoRun',
      instanceName: instance,
      encrypt: config.encrypt,
      trustServerCertificate: !config.verifyCertificate,
    },
  });
  pool.on('error', () => {}); // failures surface on the next request instead
  await pool.connect();

  const batch = async (text) => {
    const messages = [];
    const request = pool.request();
    request.on('info', (info) => messages.push(info.message));
    try {
      return { result: await request.batch(text), messages };
    } catch (error) {
      error.serverMessages = messages;
      throw error;
    }
  };

  return {
    async version() {
      const { result } = await batch('SELECT @@VERSION AS v');
      return String(result.recordset[0].v).split('\n')[0].trim();
    },
    async execute(statement) {
      const { result, messages } = await batch(statement.text);
      const rows = (result.recordsets ?? []).reduce((sum, set) => sum + set.length, 0);
      const counted = (result.rowsAffected ?? []).reduce((sum, count) => sum + count, 0);
      return { rows, affected: Math.max(0, counted - rows), messages };
    },
    async begin() {
      await batch('BEGIN TRANSACTION');
    },
    async commit() {
      await batch('IF @@TRANCOUNT > 0 COMMIT TRANSACTION');
    },
    async rollback() {
      await batch('IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION');
    },
    async finish() {},
    async close() {
      await pool.close();
    },
    describeError(error, statement) {
      const all = [...(error.precedingErrors ?? []), error];
      return {
        message: all.map((item) => item.message).join('\n'),
        code: error.number ? `Msg ${error.number}` : error.code,
        line: statement.line + (error.lineNumber || 1) - 1,
      };
    },
  };
}
