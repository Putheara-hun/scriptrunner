import pg from 'pg';
import { escapeSingleQuotes } from '../backup.js';

const RETURNS_ROWS = new Set(['SELECT', 'FETCH', 'SHOW', 'VALUES', 'TABLE', 'EXPLAIN']);

function pgArrayLiteral(values) {
  const parts = values.map((value) => {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return `"${String(value).replace(/(["\\])/g, '\\$1')}"`;
  });
  return `{${parts.join(',')}}`;
}

export async function open(config) {
  const client = new pg.Client({

    host: config.resolvedHost || config.server,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database || 'postgres',
    ssl: config.encrypt
      ? { rejectUnauthorized: Boolean(config.verifyCertificate), servername: config.server }
      : false,
    connectionTimeoutMillis: 15000,
    ...(config.statementTimeoutMs ? { statement_timeout: config.statementTimeoutMs } : {}),
    application_name: 'DB AutoRun',
  });

  let notices = [];
  client.on('notice', (notice) => notices.push(`${notice.severity}: ${notice.message}`));
  client.on('error', () => {});
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
    introspect: makeIntrospect(client),
  };
}

function makeIntrospect(client) {
  const quoteId = (name) => `"${String(name).replace(/"/g, '""')}"`;
  const quoteTable = (table) => `${quoteId(table.schema)}.${quoteId(table.name)}`;
  const relId = (table) => `format('%I.%I', $1::text, $2::text)::regclass`;

  return {
    dialect: 'postgres',
    quoteId,
    quoteTable,
    dropTableSql: (table) => `DROP TABLE IF EXISTS ${quoteTable(table)} CASCADE;`,
    async tables() {
      const result = await client.query(
        `SELECT n.nspname AS schema, c.relname AS name
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
           AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast%'
         ORDER BY n.nspname, c.relname`,
      );
      return result.rows;
    },
    async columns(table) {
      const result = await client.query(
        `SELECT a.attname AS name,
                pg_catalog.format_type(a.atttypid, a.atttypmod) AS typesql,
                a.attnotnull AS notnull,
                pg_get_expr(d.adbin, d.adrelid) AS def
         FROM pg_attribute a
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE a.attrelid = ${relId(table)} AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attnum`,
        [table.schema, table.name],
      );
      return result.rows.map((column) => ({
        name: column.name,
        typeSql: column.typesql,
        notNull: column.notnull,
        default: column.def && !/nextval\(/i.test(column.def) ? column.def : null,
      }));
    },
    async primaryKey(table) {
      const result = await client.query(
        `SELECT a.attname AS name
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
         WHERE i.indrelid = ${relId(table)} AND i.indisprimary
         ORDER BY array_position(i.indkey, a.attnum)`,
        [table.schema, table.name],
      );
      return result.rows.map((row) => row.name);
    },
    async *rows(table, columnNames) {
      const select = columnNames.map(quoteId).join(', ');
      await client.query('BEGIN');
      try {
        await client.query(`DECLARE _dbautorun_bak NO SCROLL CURSOR FOR SELECT ${select} FROM ${quoteTable(table)}`);
        for (;;) {
          const chunk = await client.query('FETCH 500 FROM _dbautorun_bak');
          if (chunk.rows.length === 0) break;
          for (const row of chunk.rows) yield row;
        }
        await client.query('CLOSE _dbautorun_bak');
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    },
    formatValue(value) {
      if (value === null || value === undefined) return 'NULL';
      if (typeof value === 'number' || typeof value === 'bigint') return String(value);
      if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
      if (value instanceof Date) return `'${value.toISOString()}'`;
      if (Buffer.isBuffer(value)) return `'\\x${value.toString('hex')}'`;
      if (Array.isArray(value)) return `'${escapeSingleQuotes(pgArrayLiteral(value))}'`;
      if (typeof value === 'object') return `'${escapeSingleQuotes(JSON.stringify(value))}'`;
      return `'${escapeSingleQuotes(String(value))}'`;
    },
  };
}
