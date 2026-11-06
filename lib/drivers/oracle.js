import oracledb from 'oracledb';

const MAX_ROWS_COUNTED = 1000;

export async function open(config) {
  const connection = await oracledb.getConnection({
    user: config.user,
    password: config.password,
    connectString: `${config.encrypt ? 'tcps://' : ''}${config.server}:${config.port}/${config.database}`,
    transportConnectTimeout: 15,
    ...(config.sysdba ? { privilege: oracledb.SYSDBA } : {}),
  });

  return {
    async version() {
      return connection.oracleServerVersionString
        ? `Oracle Database ${connection.oracleServerVersionString}`
        : 'Oracle Database';
    },
    async execute(statement) {
      // No auto-commit, so a ROLLBACK written in the script still works.
      // finish() commits at the end of the file, as SQL*Plus does on exit.
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
  };
}

function countNewlines(text, end) {
  let count = 0;
  for (let i = 0; i < end && i < text.length; i++) {
    if (text[i] === '\n') count++;
  }
  return count;
}
