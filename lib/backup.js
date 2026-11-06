export function escapeSingleQuotes(text) {
  return String(text).replace(/'/g, "''");
}

export function toHex(buffer) {
  return buffer.toString('hex');
}

export function pad(number, width = 2) {
  return String(number).padStart(width, '0');
}

export function formatDateParts(value) {
  return {
    year: value.getFullYear(),
    month: pad(value.getMonth() + 1),
    day: pad(value.getDate()),
    hour: pad(value.getHours()),
    minute: pad(value.getMinutes()),
    second: pad(value.getSeconds()),
    ms: pad(value.getMilliseconds(), 3),
  };
}

function header(dialect, database) {
  return (
    `-- DB AutoRun backup\n` +
    `-- Database: ${database || '(default)'} (${dialect})\n` +
    `-- Generated: ${new Date().toISOString()}\n` +
    `-- Restore: run this file in DB AutoRun (same database type).\n\n`
  );
}

function createTableSql(introspect, table, columns, primaryKey) {
  const lines = columns.map((column) => {
    let line = `  ${introspect.quoteId(column.name)} ${column.typeSql}`;
    if (column.notNull) line += ' NOT NULL';
    if (column.default != null) line += ` DEFAULT ${column.default}`;
    if (column.suffix) line += ` ${column.suffix}`;
    return line;
  });
  if (primaryKey.length) {
    lines.push(`  PRIMARY KEY (${primaryKey.map((name) => introspect.quoteId(name)).join(', ')})`);
  }
  return `CREATE TABLE ${introspect.quoteTable(table)} (\n${lines.join(',\n')}\n);\n`;
}

export async function dumpDatabase(introspect, emit, { database } = {}) {
  emit(header(introspect.dialect, database));
  const tables = await introspect.tables();
  if (tables.length === 0) {
    emit('-- No tables found in this database.\n');
    return { tables: 0, rows: 0 };
  }

  let tableCount = 0;
  let rowCount = 0;
  const batchLimit = 200;

  for (const table of tables) {
    const columns = await introspect.columns(table);
    if (columns.length === 0) continue;
    const primaryKey = await introspect.primaryKey(table);

    emit(`${introspect.dropTableSql(table)}\n`);
    emit(createTableSql(introspect, table, columns, primaryKey));

    const columnNames = columns.map((column) => column.name);
    const quotedColumns = columnNames.map((name) => introspect.quoteId(name)).join(', ');
    const target = introspect.quoteTable(table);

    let batch = [];
    for await (const row of introspect.rows(table, columnNames)) {
      const values = columnNames.map((name) => introspect.formatValue(row[name]));
      batch.push(`INSERT INTO ${target} (${quotedColumns}) VALUES (${values.join(', ')});`);
      rowCount++;
      if (batch.length >= batchLimit) {
        emit(`${batch.join('\n')}\n`);
        batch = [];
      }
    }
    if (batch.length) emit(`${batch.join('\n')}\n`);
    emit('\n');
    tableCount++;
  }
  return { tables: tableCount, rows: rowCount };
}
