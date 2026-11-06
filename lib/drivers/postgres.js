import pg from 'pg';

const RETURNS_ROWS = new Set(['SELECT', 'FETCH', 'SHOW', 'VALUES', 'TABLE', 'EXPLAIN']);

export async function open(config) {
  const client = new pg.Client({
    host: config.server,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database || 'postgres',
    ssl: config.encrypt ? { rejectUnauthorized: Boolean(config.verifyCertificate) } : false,
    connectionTimeoutMillis: 15000,
    application_name: 'DB AutoRun',
  });

  let notices = [];
  client.on('notice', (notice) => notices.push(`${notice.severity}: ${notice.message}`));
  client.on('error', () => {}); // failures surface on the next query instead
  await client.connect();

  const takeNotices = () => {
    const taken = notices;
    notices = [];
    return taken;
  };

  return {
    async version() {
      const result = await client.query('SELECT version() AS v');
      return result.rows[0].v;
    },
    async execute(statement) {
      try {
        const result = await client.query(statement.text);
        const last = Array.isArray(result) ? result[result.length - 1] : result;
        const count = last.rowCount ?? 0;
        const returnsRows = RETURNS_ROWS.has(last.command);
        return {
          rows: returnsRows ? count : 0,
          affected: returnsRows ? 0 : count,
          messages: takeNotices(),
        };
      } catch (error) {
        error.serverMessages = takeNotices();
        throw error;
      }
    },
    async begin() {
      await client.query('BEGIN');
    },
    async commit() {
      await client.query('COMMIT');
    },
    async rollback() {
      await client.query('ROLLBACK');
    },
    async finish() {},
    async close() {
      await client.end();
    },
    describeError(error, statement) {
      let line = statement.line;
      const position = Number(error.position);
      if (position > 0) {
        line += statement.text.slice(0, position - 1).split('\n').length - 1;
      }
      const details = [error.message, error.detail, error.hint && `Hint: ${error.hint}`, error.where];
      return { message: details.filter(Boolean).join('\n'), code: error.code, line };
    },
  };
}
