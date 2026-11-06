import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function emptyCounts() {
  return { users: 0, runs: 0, scripts: 0, since: new Date().toISOString().slice(0, 10) };
}

function load(filePath) {
  try {
    return { ...emptyCounts(), ...JSON.parse(readFileSync(filePath, 'utf8')) };
  } catch (error) {
    if (error.code === 'ENOENT') return emptyCounts();

    console.error(`Could not read ${filePath}: ${error.message}. Starting the counts again.`);
    try {
      renameSync(filePath, `${filePath}.damaged`);
    } catch {

    }
    return emptyCounts();
  }
}

export function createUsageCounter(filePath) {
  const counts = load(filePath);

  function save() {
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });

      const temporary = `${filePath}.tmp`;
      writeFileSync(temporary, JSON.stringify(counts, null, 2));
      renameSync(temporary, filePath);
    } catch (error) {
      console.error(`Could not save the usage counts: ${error.message}`);
    }
  }

  return {
    recordScript({ newRun, newUser }) {
      if (newUser) counts.users++;
      if (newRun) counts.runs++;
      counts.scripts++;
      save();
    },
    totals() {
      return { ...counts };
    },
  };
}
