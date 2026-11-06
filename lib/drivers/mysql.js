import mysql from 'mysql2/promise';

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
  };
}
