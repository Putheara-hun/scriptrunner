import sql from 'mssql';
import { formatDateParts } from '../backup.js';

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

  const pool = new sql.ConnectionPool({

    server: config.resolvedHost || host,
    port,
    database: config.database || undefined,
    user: config.user,
    password: config.password,
    connectionTimeout: 15000,
    requestTimeout: config.statementTimeoutMs ?? 0,
    pool: { min: 1, max: 1 },
    validateConnection: false,
    options: {
      appName: 'DB AutoRun',
      instanceName: instance,
      encrypt: config.encrypt,
      trustServerCertificate: !config.verifyCertificate,
    },
  });
  pool.on('error', () => {});
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
    introspect: makeIntrospect(pool),
  };
}

function mssqlType(column) {
  const type = String(column.typename).toLowerCase();
  if (['varchar', 'char', 'varbinary', 'binary'].includes(type)) {
    return `${type}(${column.max_length === -1 ? 'max' : column.max_length})`;
  }
  if (['nvarchar', 'nchar'].includes(type)) {
    return `${type}(${column.max_length === -1 ? 'max' : column.max_length / 2})`;
  }
  if (['decimal', 'numeric'].includes(type)) return `${type}(${column.precision},${column.scale})`;
  if (['datetime2', 'time', 'datetimeoffset'].includes(type)) return `${type}(${column.scale})`;
  return type;
}

function makeIntrospect(pool) {
  const quoteId = (name) => `[${String(name).replace(/]/g, ']]')}]`;
  const quoteTable = (table) => `${quoteId(table.schema)}.${quoteId(table.name)}`;
  const query = async (text, params = {}) => {
    const request = pool.request();
    for (const [key, value] of Object.entries(params)) request.input(key, value);
    return (await request.query(text)).recordset;
  };

  return {
    dialect: 'mssql',
    quoteId,
    quoteTable,
    dropTableSql: (table) => `DROP TABLE IF EXISTS ${quoteTable(table)};`,
    async tables() {
      return query(
        `SELECT s.name AS [schema], t.name AS name
         FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
         WHERE t.is_ms_shipped = 0 ORDER BY s.name, t.name`,
      );
    },
    async columns(table) {
      const rows = await query(
        `SELECT c.name AS name, ty.name AS typename, c.max_length, c.precision, c.scale, c.is_nullable
         FROM sys.columns c
         JOIN sys.types ty ON ty.user_type_id = c.user_type_id
         WHERE c.object_id = OBJECT_ID(@t) ORDER BY c.column_id`,
        { t: quoteTable(table) },
      );
      return rows.map((column) => ({ name: column.name, typeSql: mssqlType(column), notNull: !column.is_nullable, default: null }));
    },
    async primaryKey(table) {
      const rows = await query(
        `SELECT c.name
         FROM sys.indexes i
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
         WHERE i.is_primary_key = 1 AND i.object_id = OBJECT_ID(@t) ORDER BY ic.key_ordinal`,
        { t: quoteTable(table) },
      );
      return rows.map((row) => row.name);
    },
    async *rows(table, columnNames) {
      const select = columnNames.map(quoteId).join(', ');
      const rows = await query(`SELECT ${select} FROM ${quoteTable(table)}`);
      for (const row of rows) yield row;
    },
    formatValue(value) {
      if (value === null || value === undefined) return 'NULL';
      if (typeof value === 'number' || typeof value === 'bigint') return String(value);
      if (typeof value === 'boolean') return value ? '1' : '0';
      if (value instanceof Date) {
        const d = formatDateParts(value);
        return `'${d.year}-${d.month}-${d.day} ${d.hour}:${d.minute}:${d.second}.${d.ms}'`;
      }
      if (Buffer.isBuffer(value)) return `0x${value.toString('hex') || '00'}`;
      if (typeof value === 'object') return `N'${String(JSON.stringify(value)).replace(/'/g, "''")}'`;
      return `N'${String(value).replace(/'/g, "''")}'`;
    },
  };
}
