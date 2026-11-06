import mysql from 'mysql2/promise';
import { escapeSingleQuotes, formatDateParts } from '../backup.js';

function countResult(result) {
  let rows = 0;
  let affected = 0;
  if (Array.isArray(result)) {
    for (const part of result) {
      if (Array.isArray(part)) rows += part.length;
      else if (part && typeof part.affectedRows === 'number') affected += part.affectedRows;
      else rows += 1;
    }
  } else if (result) {
    affected = result.affectedRows ?? 0;
  }
  return { rows, affected };
}

export async function open(config) {
  const connection = await mysql.createConnection({

    host: config.resolvedHost || config.server,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database || undefined,
    charset: 'utf8mb4',
    connectTimeout: 15000,
    ssl: config.encrypt
      ? { rejectUnauthorized: Boolean(config.verifyCertificate), servername: config.server }
      : undefined,
  });
  connection.on('error', () => {});

  return {
    async version() {
      const [rows] = await connection.query('SELECT VERSION() AS v');
      return `MySQL/MariaDB ${rows[0].v}`;
    },
    async execute(statement) {
      const [result] = await connection.query(statement.text);
      return { ...countResult(result), messages: [] };
    },
    async begin() {
      await connection.query('START TRANSACTION');
    },
    async commit() {
      await connection.query('COMMIT');
    },
    async rollback() {
      await connection.query('ROLLBACK');
    },
    async finish() {},
    async close() {
      await connection.end();
    },
    describeError(error, statement) {
      const atLine = /at line (\d+)/.exec(error.message ?? '');
      return {
        message: error.sqlMessage ?? error.message,
        code: error.errno ? `Error ${error.errno}` : error.code,
        line: statement.line + (atLine ? Number(atLine[1]) - 1 : 0),
      };
    },
    introspect: makeIntrospect(connection),
  };
}

function makeIntrospect(connection) {
  const quoteId = (name) => `\`${String(name).replace(/`/g, '``')}\``;
  const quoteTable = (table) => quoteId(table.name);

  return {
    dialect: 'mysql',
    quoteId,
    quoteTable,
    dropTableSql: (table) => `DROP TABLE IF EXISTS ${quoteTable(table)};`,
    async tables() {
      const [rows] = await connection.query(
        `SELECT table_name AS name FROM information_schema.tables
         WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name`,
      );
      if (rows.length === 0) {
        const [[db]] = await connection.query('SELECT DATABASE() AS db');
        if (!db.db) throw new Error('No database is selected. Choose a database to back up.');
      }
      return rows.map((row) => ({ name: row.name }));
    },
    async columns(table) {
      const [rows] = await connection.query(
        `SELECT column_name AS name, column_type AS typesql, is_nullable AS nullable, extra AS extra
         FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position`,
        [table.name],
      );
      return rows.map((column) => ({
        name: column.name,
        typeSql: column.typesql,
        notNull: column.nullable === 'NO',
        default: null,
        suffix: /auto_increment/i.test(column.extra || '') ? 'AUTO_INCREMENT' : null,
      }));
    },
    async primaryKey(table) {
      const [rows] = await connection.query(
        `SELECT column_name AS name FROM information_schema.key_column_usage
         WHERE table_schema = DATABASE() AND table_name = ? AND constraint_name = 'PRIMARY'
         ORDER BY ordinal_position`,
        [table.name],
      );
      return rows.map((row) => row.name);
    },
    async *rows(table, columnNames) {
      const select = columnNames.map(quoteId).join(', ');
      const [rows] = await connection.query(`SELECT ${select} FROM ${quoteTable(table)}`);
      for (const row of rows) yield row;
    },
    formatValue(value) {
      if (value === null || value === undefined) return 'NULL';
      if (typeof value === 'number' || typeof value === 'bigint') return String(value);
      if (typeof value === 'boolean') return value ? '1' : '0';
      if (value instanceof Date) {
        const d = formatDateParts(value);
        return `'${d.year}-${d.month}-${d.day} ${d.hour}:${d.minute}:${d.second}'`;
      }
      if (Buffer.isBuffer(value)) return `0x${value.toString('hex') || '00'}`;
      if (typeof value === 'object') return `'${String(JSON.stringify(value)).replace(/[\\']/g, (c) => `\\${c}`)}'`;
      return `'${String(value).replace(/[\\']/g, (c) => `\\${c}`)}'`;
    },
  };
}
