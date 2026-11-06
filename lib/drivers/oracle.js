import oracledb from 'oracledb';
import { formatDateParts } from '../backup.js';

const MAX_ROWS_COUNTED = 1000;

export async function open(config) {
  const connection = await oracledb.getConnection({
    user: config.user,
    password: config.password,

    connectString: `${config.encrypt ? 'tcps://' : ''}${config.resolvedHost || config.server}:${config.port}/${config.database}`,
    transportConnectTimeout: 15,
    ...(config.sysdba ? { privilege: oracledb.SYSDBA } : {}),
  });
  if (config.statementTimeoutMs) connection.callTimeout = config.statementTimeoutMs;

  return {
    async version() {
      return connection.oracleServerVersionString
        ? `Oracle Database ${connection.oracleServerVersionString}`
        : 'Oracle Database';
    },
    async execute(statement) {

      const result = await connection.execute(statement.text, [], { resultSet: true });
      const messages = [];
      let warning;
      if (result.warning) {
        warning = `${result.warning.message}. See USER_ERRORS for the details.`;
      }

      let rows = 0;
      let more = false;
      if (result.resultSet) {
        const fetched = await result.resultSet.getRows(MAX_ROWS_COUNTED + 1);
        await result.resultSet.close();
        more = fetched.length > MAX_ROWS_COUNTED;
        rows = Math.min(fetched.length, MAX_ROWS_COUNTED);
      }
      return { rows, more, affected: result.rowsAffected ?? 0, messages, warning };
    },
    async begin() {},
    async commit() {
      await connection.commit();
    },
    async rollback() {
      await connection.rollback();
    },
    async finish() {
      await connection.commit();
    },
    async close() {
      await connection.close();
    },
    describeError(error, statement) {
      let line = statement.line;
      if (typeof error.offset === 'number' && error.offset > 0) {
        line += countNewlines(statement.text, error.offset);
      }
      return { message: error.message, code: error.code, line };
    },
    introspect: makeIntrospect(connection),
  };
}

function oracleType(column) {
  const type = column.dtype;
  if (['VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR'].includes(type)) {
    return `${type}(${column.len}${column.charused === 'C' ? ' CHAR' : ''})`;
  }
  if (type === 'NUMBER') {
    if (column.prec == null) return 'NUMBER';
    return column.scale ? `NUMBER(${column.prec},${column.scale})` : `NUMBER(${column.prec})`;
  }
  return type;
}

function makeIntrospect(connection) {
  const quoteId = (name) => `"${String(name).replace(/"/g, '""')}"`;
  const quoteTable = (table) => quoteId(table.name);
  const query = async (text, binds = {}) => {
    const result = await connection.execute(text, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return result.rows;
  };

  return {
    dialect: 'oracle',
    quoteId,
    quoteTable,
    dropTableSql: (table) =>
      `BEGIN EXECUTE IMMEDIATE 'DROP TABLE ${quoteTable(table)} CASCADE CONSTRAINTS'; ` +
      `EXCEPTION WHEN OTHERS THEN IF SQLCODE != -942 THEN RAISE; END IF; END;\n/`,
    async tables() {
      return query('SELECT table_name AS "name" FROM user_tables ORDER BY table_name');
    },
    async columns(table) {
      const rows = await query(
        `SELECT column_name AS "name", data_type AS "dtype", data_length AS "len",
                data_precision AS "prec", data_scale AS "scale", nullable AS "nullable", char_used AS "charused"
         FROM user_tab_columns WHERE table_name = :t ORDER BY column_id`,
        { t: table.name },
      );
      return rows.map((column) => ({
        name: column.name,
        typeSql: oracleType(column),
        notNull: column.nullable === 'N',
        default: null,
      }));
    },
    async primaryKey(table) {
      const rows = await query(
        `SELECT cc.column_name AS "name"
         FROM user_constraints c JOIN user_cons_columns cc ON cc.constraint_name = c.constraint_name
         WHERE c.constraint_type = 'P' AND c.table_name = :t ORDER BY cc.position`,
        { t: table.name },
      );
      return rows.map((row) => row.name);
    },
    async *rows(table, columnNames) {
      const select = columnNames.map(quoteId).join(', ');
      const result = await connection.execute(`SELECT ${select} FROM ${quoteTable(table)}`, [], {
        resultSet: true,
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        fetchTypeHandler: (metaData) => {
          if (metaData.dbType === oracledb.DB_TYPE_CLOB) return { type: oracledb.STRING };
          if (metaData.dbType === oracledb.DB_TYPE_BLOB) return { type: oracledb.BUFFER };
          return undefined;
        },
      });
      try {
        for (;;) {
          const batch = await result.resultSet.getRows(200);
          if (batch.length === 0) break;
          for (const row of batch) yield row;
        }
      } finally {
        await result.resultSet.close();
      }
    },
    formatValue(value) {
      if (value === null || value === undefined) return 'NULL';
      if (typeof value === 'number' || typeof value === 'bigint') return String(value);
      if (value instanceof Date) {
        const d = formatDateParts(value);
        return `TO_TIMESTAMP('${d.year}-${d.month}-${d.day} ${d.hour}:${d.minute}:${d.second}.${d.ms}', 'YYYY-MM-DD HH24:MI:SS.FF3')`;
      }
      if (Buffer.isBuffer(value)) return `HEXTORAW('${value.toString('hex')}')`;
      if (typeof value === 'object') return `'${String(JSON.stringify(value)).replace(/'/g, "''")}'`;
      return `'${String(value).replace(/'/g, "''")}'`;
    },
  };
}

function countNewlines(text, end) {
  let count = 0;
  for (let i = 0; i < end && i < text.length; i++) {
    if (text[i] === '\n') count++;
  }
  return count;
}
