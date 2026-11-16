const $ = (id) => document.getElementById(id);

const DB_TYPES = {
  mssql: {
    label: 'SQL Server',
    port: 1433,
    serverHint: 'e.g. localhost or localhost\\SQLEXPRESS',
    databaseLabel: 'Database (optional)',
    databaseHint: 'e.g. SalesDb',
    userHint: 'e.g. sa',
    encrypt: true,
    transactionNote: 'If a statement fails, that file is rolled back.',
  },
  oracle: {
    label: 'Oracle',
    port: 1521,
    serverHint: 'e.g. localhost',
    databaseLabel: 'Service name',
    databaseHint: 'e.g. ORCLPDB1',
    userHint: 'e.g. system',
    transactionNote: 'If a statement fails, that file is rolled back. Oracle cannot roll back CREATE, ALTER or DROP.',
  },
  postgres: {
    label: 'PostgreSQL',
    port: 5432,
    serverHint: 'e.g. localhost',
    databaseLabel: 'Database (optional)',
    databaseHint: 'e.g. postgres',
    userHint: 'e.g. postgres',
    encrypt: false,
    transactionNote: 'If a statement fails, that file is rolled back. CREATE DATABASE and VACUUM cannot run inside one.',
  },
  mysql: {
    label: 'MySQL / MariaDB',
    port: 3306,
    serverHint: 'e.g. localhost',
    databaseLabel: 'Database (optional)',
    databaseHint: 'e.g. SalesDb',
    userHint: 'e.g. root',
    encrypt: false,
    transactionNote: 'If a statement fails, that file is rolled back. MySQL cannot roll back CREATE, ALTER or DROP.',
  },
};

const LOCATIONS = {
  local: { label: 'Local run', badge: 'Local' },
  internet: { label: 'Over the internet', badge: 'Internet' },
};

const ON_ERROR_LABELS = {
  stop: 'Stop the whole run',
  next: 'Skip to the next file',
  continue: 'Continue with the next statement',
};

const SCRIPT_EXTENSIONS = new Set([
  'sql', 'ddl', 'dml', 'tsql', 'psql', 'pgsql', 'mysql',
  'pls', 'plb', 'pks', 'pkb', 'prc', 'fnc', 'trg', 'vw',
]);

const STATUS_LABELS = {
  waiting: 'Waiting',
  ok: 'Done',
  warning: 'Warnings',
  error: 'Failed',
  stopped: 'Stopped',
  skipped: 'Not run',
};

const COUNTED_KEY = 'dbautorun.counted';

const LOOSE_GROUP_NAME = 'Individual files';
const PASTED_GROUP_NAME = 'Pasted SQL';
const MAX_PASTE_PREVIEW = 20000;
const MAX_STORED_OK_ENTRIES = 20000;
const VISIBLE_OK_ENTRIES = 300;
const RENDER_INTERVAL_MS = 120;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const state = {
  session: null,
  groups: [],
  selectedId: null,
  followRunning: true,
  running: false,
  stopRequested: false,
  runId: null,
  lastRun: null,
  currentFile: null,
  nextId: 1,
  pasteCount: 0,
  writtenCount: 0,
  editing: null,
  schema: null,
  schemaIndex: null,
  schemaLoadError: null,
  schemaExpanded: new Set(),
};

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

function plural(count, noun) {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60000);
  return `${minutes} min ${Math.round((ms % 60000) / 1000)} s`;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function readStorage(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {

  }
}

function allFiles() {
  return state.groups.flatMap((group) => group.files);
}

function findFile(id) {
  return allFiles().find((file) => file.id === id) ?? null;
}

function isFinished(file) {
  return file.status === 'ok' || file.status === 'warning';
}

function resetResult(file) {
  Object.assign(file, {
    status: 'idle',
    entries: [],
    okStored: 0,
    okDropped: 0,
    statements: null,
    executed: 0,
    failed: 0,
    warnings: 0,
    ms: null,
    encoding: null,
    rolledBack: false,
  });
}

const DB_BADGE = { mssql: '#cc2927', oracle: '#c74634', postgres: '#336791', mysql: '#00758f' };

function dbBadge(type) {
  const color = DB_BADGE[type] ?? '#5d6871';
  return `<svg class="db-icon" viewBox="0 0 20 20" aria-hidden="true">
    <rect width="20" height="20" rx="5" fill="${color}"/>
    <g fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round">
      <ellipse cx="10" cy="6.4" rx="4.2" ry="1.8"/>
      <path d="M5.8 6.4v7.2c0 1 1.88 1.8 4.2 1.8s4.2-.8 4.2-1.8V6.4"/>
      <path d="M5.8 10c0 1 1.88 1.8 4.2 1.8s4.2-.8 4.2-1.8"/>
    </g>
  </svg>`;
}

function dbMark(type) {
  const mark = document.createElement('span');
  mark.className = 'db-mark';
  const img = document.createElement('img');
  img.className = 'db-logo';
  img.alt = '';
  img.setAttribute('aria-hidden', 'true');
  img.addEventListener('error', () => { mark.innerHTML = dbBadge(type); }, { once: true });
  img.src = `/logos/${type}.svg`;
  mark.append(img);
  return mark;
}

let dbSelect = null;

function setUpDbSelect() {
  const select = $('db-type');
  const button = $('db-type-button');
  const valueEl = $('db-type-value');
  const list = $('db-type-list');
  const options = [...select.options].filter((option) => option.value)
    .map((option) => ({ value: option.value, label: option.textContent.trim() }));
  let activeIndex = -1;

  const items = options.map((option, index) => {
    const li = document.createElement('li');
    li.className = 'select-option';
    li.id = `db-opt-${option.value}`;
    li.setAttribute('role', 'option');
    li.dataset.value = option.value;
    const label = document.createElement('span');
    label.textContent = option.label;
    li.append(dbMark(option.value), label);
    li.addEventListener('click', () => choose(option.value));
    li.addEventListener('mousemove', () => setActive(index));
    return li;
  });
  list.replaceChildren(...items);

  const isOpen = () => !list.hidden;

  function open() {
    if (isOpen()) return;
    list.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    const current = options.findIndex((option) => option.value === select.value);
    setActive(current >= 0 ? current : 0);
    list.focus();
  }

  function close(focusButton = true) {
    if (!isOpen()) return;
    list.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    list.removeAttribute('aria-activedescendant');
    if (focusButton) button.focus();
  }

  function setActive(index) {
    activeIndex = index;
    items.forEach((li, i) => li.classList.toggle('is-active', i === index));
    if (index >= 0) {
      list.setAttribute('aria-activedescendant', items[index].id);
      items[index].scrollIntoView({ block: 'nearest' });
    }
  }

  function choose(value) {
    const changed = select.value !== value;
    select.value = value;
    syncButton();
    close(!changed);
    if (changed) select.dispatchEvent(new Event('change'));
  }

  function syncButton() {
    const { value } = select;
    if (value) {
      const label = document.createElement('span');
      label.textContent = options.find((o) => o.value === value)?.label ?? '';
      valueEl.replaceChildren(dbMark(value), label);
      valueEl.classList.remove('is-placeholder');
    } else {
      valueEl.textContent = select.options[0]?.textContent ?? 'Choose a database…';
      valueEl.classList.add('is-placeholder');
    }
    items.forEach((li) => li.setAttribute('aria-selected', String(li.dataset.value === value)));
  }

  function typeAhead(letter) {
    const matches = (option) => option.label.toLowerCase().startsWith(letter);
    const after = options.findIndex((option, i) => i > activeIndex && matches(option));
    const found = after >= 0 ? after : options.findIndex(matches);
    if (found >= 0) setActive(found);
  }

  button.addEventListener('click', () => (isOpen() ? close() : open()));
  button.addEventListener('keydown', (event) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      open();
    }
  });
  list.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') setActive(Math.min(activeIndex + 1, items.length - 1));
    else if (event.key === 'ArrowUp') setActive(Math.max(activeIndex - 1, 0));
    else if (event.key === 'Home') setActive(0);
    else if (event.key === 'End') setActive(items.length - 1);
    else if (event.key === 'Enter' || event.key === ' ') {
      if (activeIndex >= 0) choose(options[activeIndex].value);
    } else if (event.key === 'Escape') close();
    else if (event.key === 'Tab') {
      close(false);
      return;
    } else if (/^[a-z0-9]$/i.test(event.key)) {
      typeAhead(event.key.toLowerCase());
    } else {
      return;
    }
    event.preventDefault();
  });
  document.addEventListener('click', (event) => {
    if (isOpen() && !event.target.closest('#db-select')) close(false);
  });

  syncButton();
  return { syncButton };
}

function selectedLocation() {
  return document.querySelector('input[name="location"]:checked').value;
}

function profileKey(location, type) {
  return `dbautorun.profile.${location}.${type}`;
}

function showConnectionFields(type) {
  const db = DB_TYPES[type];
  const location = selectedLocation();
  const isInternet = location === 'internet';
  const saved = readStorage(profileKey(location, type)) ?? {};

  $('connection-fields').hidden = false;
  $('server').placeholder = isInternet ? 'e.g. db.example.com' : db.serverHint;
  $('database-label').textContent = db.databaseLabel;
  $('database').placeholder = db.databaseHint;
  $('user').placeholder = db.userHint;
  $('encrypt-option').hidden = !isInternet && db.encrypt === undefined;
  $('sysdba-option').hidden = type !== 'oracle';

  let encryptHint = 'Self-signed certificates are accepted.';
  if (isInternet) {
    encryptHint = type === 'oracle'
      ? 'Oracle uses TCPS for this, usually on port 2484.'
      : 'Recommended whenever the database is not on this computer.';
  }
  $('encrypt-hint').textContent = encryptHint;

  $('server').value = saved.server ?? '';
  $('port').value = saved.port ?? db.port;
  $('database').value = saved.database ?? '';
  $('user').value = saved.user ?? '';
  $('password').value = '';
  $('encrypt').checked = saved.encrypt ?? (isInternet || Boolean(db.encrypt));
  $('verify-certificate').checked = saved.verifyCertificate ?? true;
  $('sysdba').checked = saved.sysdba ?? false;
  $('connect-error').hidden = true;
  hideDatabasePanel();
  updateSecurityOptions();
}

function updateSecurityOptions() {
  const isInternet = selectedLocation() === 'internet';
  const isOracle = $('db-type').value === 'oracle';
  const encrypted = !$('encrypt-option').hidden && $('encrypt').checked;

  $('verify-option').hidden = !isInternet || !encrypted || isOracle;

  let warning = '';
  if (isInternet && !encrypted) {
    warning = 'Without encryption, others on the internet can read your data, and possibly your password.';
  } else if (!$('verify-option').hidden && !$('verify-certificate').checked) {
    warning = 'Without verification, someone on the network could pretend to be the server and capture your password.';
  }
  $('security-warning').textContent = warning;
  $('security-warning').hidden = !warning;
}

let isPublicHost = document.body.dataset.public === 'true';

function updateLocalHelp() {
  const onlyHelp = isPublicHost && selectedLocation() === 'local';
  const help = $('local-run-help');
  if (help) help.hidden = !onlyHelp;
  $('db-type-field').hidden = onlyHelp;
  if (onlyHelp) $('connection-fields').hidden = true;
}

function applyLocation() {
  const location = selectedLocation();
  const type = readStorage(`dbautorun.lastType.${location}`) ?? $('db-type').value;
  if (DB_TYPES[type]) {
    $('db-type').value = type;
    showConnectionFields(type);
  } else {
    $('db-type').value = '';
    $('connection-fields').hidden = true;
  }
  dbSelect?.syncButton();
  updateLocalHelp();
}

function restoreConnectionForm() {
  const lastLocation = readStorage('dbautorun.lastLocation');
  if (LOCATIONS[lastLocation]) {
    document.querySelector(`input[name="location"][value="${lastLocation}"]`).checked = true;
  }
  if (!isPublicHost) {
    document.querySelector('input[name="location"][value="local"]').checked = true;
    $('location-choice').hidden = true;
  }
  applyLocation();
}

function showConnectError(message) {
  $('connect-error').textContent = message;
  $('connect-error').hidden = false;
}

function hideDatabasePanel() {
  $('database-panel').hidden = true;
  $('database-list').replaceChildren();
}

async function browseDatabases(form) {
  $('connect-button').disabled = true;
  $('connect-button').textContent = 'Looking up databases…';
  try {
    const response = await fetch('/api/list-databases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    const result = await response.json();

    if (!response.ok) {
      showConnectError(result.error);
      return true;
    }

    if (!result.databases?.length) return false;
    renderDatabasePanel(result.databases);
    return true;
  } catch {
    return false;
  } finally {
    $('connect-button').disabled = false;
    $('connect-button').textContent = 'Connect';
  }
}

function renderDatabasePanel(databases) {
  $('database-count').textContent = plural(databases.length, 'database');
  $('database-list').replaceChildren(el('ul', { class: 'database-list-items' },
    ...databases.map((name) => el('li', {},
      el('button', {
        type: 'button',
        class: 'database-item',
        title: name,
        onclick: () => {
          $('database').value = name;
          hideDatabasePanel();
          $('connect-form').requestSubmit();
        },
      }, name),
    )),
    el('li', {},
      el('button', {
        type: 'button',
        class: 'database-item is-default-choice',
        title: 'Connect without choosing a database',
        onclick: () => {
          hideDatabasePanel();
          connectNow();
        },
      }, 'Use the default database'),
    ),
  ));
  $('database-panel').hidden = false;
}

function readConnectionForm() {
  return {
    type: $('db-type').value,
    server: $('server').value.trim(),
    port: Number($('port').value),
    database: $('database').value.trim(),
    user: $('user').value.trim(),
    password: $('password').value,
    encrypt: !$('encrypt-option').hidden && $('encrypt').checked,
    verifyCertificate: !$('verify-option').hidden && $('verify-certificate').checked,
    sysdba: !$('sysdba-option').hidden && $('sysdba').checked,
  };
}

async function submitConnection(event) {
  event.preventDefault();
  $('connect-error').hidden = true;

  const form = readConnectionForm();
  if (!form.database && form.type !== 'oracle' && (await browseDatabases(form))) return;

  await connectNow();
}

async function connectNow() {
  const form = readConnectionForm();
  const { type } = form;
  const db = DB_TYPES[type];
  const location = selectedLocation();

  $('connect-error').hidden = true;
  hideDatabasePanel();
  $('connect-button').disabled = true;
  $('connect-button').textContent = 'Connecting…';

  try {
    const response = await fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    const result = await response.json();
    if (!response.ok) {
      showConnectError(result.error);
      return;
    }

    const { password, ...remembered } = form;
    writeStorage(profileKey(location, type), remembered);
    writeStorage(`dbautorun.lastType.${location}`, type);
    writeStorage('dbautorun.lastLocation', location);

    state.session = {
      token: result.token,
      type,
      location,
      label: db.label,
      target: `${form.server}:${form.port}${form.database ? ` / ${form.database}` : ''}`,
      user: form.user,
      version: result.version,
    };
    $('password').value = '';
    enterWorkspace();
  } catch {
    showConnectError('The local DB AutoRun server is not responding. Check that its window is still open.');
  } finally {
    $('connect-button').disabled = false;
    $('connect-button').textContent = 'Connect';
  }
}

function enterWorkspace() {
  const { session } = state;
  $('target-location').textContent = LOCATIONS[session.location].badge;
  $('target-location').dataset.location = session.location;
  $('target-type').textContent = session.label;
  $('target-detail').textContent = `${session.target} as ${session.user}`;
  $('target-version').textContent = session.version;
  $('target-version').title = session.version;
  $('transaction-hint').textContent = DB_TYPES[session.type].transactionNote;
  document.title = `${session.label} ${session.target} - DB AutoRun`;

  $('connect-view').hidden = true;
  $('app-view').hidden = false;
  render();
  loadSchema();
}

async function disconnect() {
  const token = state.session?.token;
  state.session = null;
  state.lastRun = null;
  state.selectedId = null;
  state.schema = null;
  state.schemaIndex = null;
  state.schemaLoadError = null;
  state.schemaExpanded = new Set();
  allFiles().forEach(resetResult);
  document.title = 'DB AutoRun';
  $('app-view').hidden = true;
  $('connect-view').hidden = false;
  hideDatabasePanel();
  $('password').focus();
  if (token) {
    await fetch('/api/disconnect', { method: 'POST', headers: { 'X-Session': token } }).catch(() => {});
  }
}

function buildSchemaIndex(schema) {
  const tableList = [];
  const tablesByName = new Map();
  const columnEntries = [];

  for (const table of schema.tables) {
    const isDefaultSchema = !table.schema || ['dbo', 'public'].includes(table.schema);
    const insertName = isDefaultSchema ? table.name : `${table.schema}.${table.name}`;
    const displayName = table.schema ? `${table.schema}.${table.name}` : table.name;
    const entry = { schema: table.schema, name: table.name, insertName, displayName, columns: table.columns };
    tableList.push(entry);
    for (const key of new Set([table.name, insertName, displayName])) {
      tablesByName.set(key.toLowerCase(), entry);
    }
    for (const column of table.columns) {
      columnEntries.push({ name: column.name, typeSql: column.typeSql, table: insertName });
    }
  }
  return { tableList, tablesByName, columnEntries };
}

async function loadSchema() {
  const { session } = state;
  if (!session) return;
  state.schema = null;
  state.schemaIndex = null;
  state.schemaLoadError = null;
  renderSchemaPanel();
  try {
    const response = await fetch('/api/schema', { headers: { 'X-Session': session.token } });
    const body = await response.json();
    if (state.session !== session) return;
    if (!response.ok) throw new Error(body.error || 'Could not load the table list.');
    state.schema = body;
    state.schemaIndex = body.supported === false ? null : buildSchemaIndex(body);
  } catch {
    if (state.session !== session) return;
    state.schemaLoadError = 'Could not load the table list.';
  }
  renderSchemaPanel();
}

function comparePaths(a, b) {
  const left = a.relPath.split('/');
  const right = b.relPath.split('/');
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const order = collator.compare(left[i], right[i]);
    if (order !== 0) return order;
  }
  return left.length - right.length;
}

function isScript(name) {
  return SCRIPT_EXTENSIONS.has(name.split('.').pop().toLowerCase());
}

function addEntries(entries) {
  let added = 0;
  let replaced = 0;
  let ignored = 0;
  const touchedGroups = new Set();

  for (const { file, groupName, relPath, text } of entries) {
    if (!isScript(file.name)) {
      ignored++;
      continue;
    }
    const name = groupName ?? LOOSE_GROUP_NAME;
    let group = state.groups.find((candidate) => candidate.name === name);
    if (!group) {
      group = { id: state.nextId++, name, files: [], manualOrder: false };
      state.groups.push(group);
    }

    const existing = group.files.find((candidate) => candidate.relPath === relPath);
    if (existing) {
      const changed = existing.file.size !== file.size || existing.file.lastModified !== file.lastModified;
      existing.file = file;
      if (changed) {
        resetResult(existing);
        replaced++;
      }
      continue;
    }

    const entry = { id: state.nextId++, file, relPath, text };
    resetResult(entry);
    group.files.push(entry);
    touchedGroups.add(group);
    added++;
  }

  for (const group of touchedGroups) {
    if (!group.manualOrder) group.files.sort(comparePaths);
  }

  const parts = [];
  if (added) parts.push(`Added ${plural(added, 'script')}.`);
  if (replaced) parts.push(`Updated ${plural(replaced, 'changed script')}.`);
  if (ignored) parts.push(`Skipped ${plural(ignored, 'file')}: only SQL scripts can be added.`);
  if (!parts.length) parts.push(entries.length ? 'Those scripts are already in the list.' : 'No files found there.');
  showAddNotice(parts.join(' '));
  render();
  return { added, replaced, ignored };
}

function showAddNotice(message) {
  $('add-notice').textContent = message;
  $('add-notice').hidden = false;
}

function addFromFilePicker(fileList) {
  addEntries([...fileList].map((file) => ({ file, groupName: null, relPath: file.name })));
}

function addFromFolderPicker(fileList) {
  addEntries(
    [...fileList].map((file) => {
      const [root, ...rest] = file.webkitRelativePath.split('/');
      return { file, groupName: root, relPath: rest.join('/') };
    }),
  );
}

function readEntryFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function readDirectory(directory) {
  const reader = directory.createReader();
  const children = [];
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return children;
    children.push(...batch);
  }
}

async function walkDirectory(directory, groupName, prefix, output) {
  for (const child of await readDirectory(directory)) {
    const relPath = prefix ? `${prefix}/${child.name}` : child.name;
    if (child.isDirectory) await walkDirectory(child, groupName, relPath, output);
    else output.push({ file: await readEntryFile(child), groupName, relPath });
  }
}

function readTransferItems(items) {
  return [...items]
    .filter((item) => item.kind === 'file')
    .map((item) => ({ entry: item.webkitGetAsEntry?.(), file: item.getAsFile() }));
}

async function addTransferred(picked) {
  const output = [];
  let unreadable = false;
  try {
    for (const { entry, file } of picked) {
      if (entry?.isDirectory) await walkDirectory(entry, entry.name, '', output);
      else if (entry) output.push({ file: await readEntryFile(entry), groupName: null, relPath: entry.name });
      else if (file) output.push({ file, groupName: null, relPath: file.name });
    }
  } catch {
    unreadable = true;
  }
  const result = addEntries(output);
  if (unreadable) showAddNotice(`${$('add-notice').textContent} Some files could not be read.`);
  return result;
}

function addFromDrop(dataTransfer) {
  return addTransferred(readTransferItems(dataTransfer.items));
}

function isOnlyFilePaths(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.every((line) => /^"?(?:[a-zA-Z]:\\|\\\\)[^"]*"?$/.test(line));
}

function addPastedText(text) {
  if (isOnlyFilePaths(text)) {
    showAddNotice('That is a file path, not the file. Copy the file itself, or use Add files.');
    return;
  }

  const existing = allFiles().find((file) => file.text === text);
  if (!existing) {
    state.pasteCount++;
    const relPath = `pasted-${state.pasteCount}.sql`;
    const file = new File([text], relPath, { type: 'text/plain' });
    addEntries([{ file, groupName: PASTED_GROUP_NAME, relPath, text }]);
  }

  const script = existing ?? allFiles().find((file) => file.text === text);
  state.selectedId = script.id;
  showAddNotice(
    existing
      ? `That text is already in the list as ${script.relPath}.`
      : `Added the pasted text as ${script.relPath}.`,
  );
  render();
}

const WRITTEN_GROUP_NAME = 'Written SQL';
const EDITOR_MAX_BYTES = 2 * 1024 * 1024;

function scriptName(name) {
  const trimmed = String(name).trim();
  if (!trimmed) return '';
  return /\.[a-z0-9]+$/i.test(trimmed) ? trimmed : `${trimmed}.sql`;
}

function decodeForEditor(bytes) {
  const data = new Uint8Array(bytes);
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le').decode(data);
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16be').decode(data);
  return new TextDecoder('utf-8').decode(data);
}

function updateEditorCount() {
  const length = $('editor-text').value.length;
  $('editor-count').textContent = length ? `${length.toLocaleString()} characters` : '';
}

async function openEditor(script) {
  if (script && typeof script.text !== 'string' && script.file.size > EDITOR_MAX_BYTES) {
    showAddNotice(`${script.relPath} is too large to open in the editor.`);
    return;
  }
  state.editing = script ?? null;
  if (script) {
    $('editor-title').textContent = `Edit ${script.relPath}`;
    $('editor-name').value = script.relPath;
    try {
      $('editor-text').value =
        typeof script.text === 'string' ? script.text : decodeForEditor(await script.file.arrayBuffer());
    } catch {
      state.editing = null;
      showAddNotice('That file could not be opened for editing.');
      return;
    }
  } else {
    state.writtenCount++;
    $('editor-title').textContent = 'New script';
    $('editor-name').value = `script-${state.writtenCount}.sql`;
    $('editor-text').value = '';
  }
  updateEditorCount();
  hideAutocomplete();
  $('schema-search').value = '';
  renderSchemaPanel();
  $('editor-dialog').showModal();
  $('editor-text').focus();
}

function renderSchemaPanel() {
  const list = $('schema-list');
  const countEl = $('schema-count');
  const filter = $('schema-search').value.trim().toLowerCase();

  if (state.schemaLoadError) {
    list.replaceChildren(el('p', { class: 'schema-empty' }, state.schemaLoadError));
    countEl.textContent = '';
    return;
  }
  if (!state.schema) {
    list.replaceChildren(el('p', { class: 'schema-empty' }, 'Loading tables…'));
    countEl.textContent = '';
    return;
  }
  if (state.schema.supported === false) {
    list.replaceChildren(el('p', { class: 'schema-empty' }, 'Table browsing is not available for this database.'));
    countEl.textContent = '';
    return;
  }

  const { tableList } = state.schemaIndex;
  countEl.textContent = plural(tableList.length, 'table');

  const filtered = !filter
    ? tableList
    : tableList.filter((table) =>
        table.displayName.toLowerCase().includes(filter) ||
        table.columns.some((column) => column.name.toLowerCase().includes(filter)),
      );

  if (!filtered.length) {
    list.replaceChildren(el('p', { class: 'schema-empty' }, 'No tables match.'));
    return;
  }

  list.replaceChildren(...filtered.map((table) => {
    const expanded = filter ? true : state.schemaExpanded.has(table.displayName);
    const columns = filter
      ? table.columns.filter((column) => column.name.toLowerCase().includes(filter) || table.displayName.toLowerCase().includes(filter))
      : table.columns;

    return el('div', { class: 'schema-table' },
      el('div', { class: 'schema-table-row' },
        el('button', {
          type: 'button',
          class: 'schema-table-head',
          title: table.displayName,
          onclick: () => {
            if (state.schemaExpanded.has(table.displayName)) state.schemaExpanded.delete(table.displayName);
            else state.schemaExpanded.add(table.displayName);
            renderSchemaPanel();
          },
        },
          el('span', { class: `schema-caret${expanded ? ' is-open' : ''}` }, '▸'),
          el('span', { class: 'schema-table-name' }, table.displayName),
        ),
        el('button', {
          type: 'button',
          class: 'schema-insert-btn',
          title: `Insert ${table.insertName}`,
          onclick: () => insertIntoEditor(table.insertName),
        }, '+'),
      ),
      expanded && el('ul', { class: 'schema-columns' },
        ...columns.map((column) => el('li', {
          class: 'schema-column',
          title: `Insert ${column.name}`,
          onclick: () => insertIntoEditor(column.name),
        },
          el('span', { class: 'schema-column-name' }, column.name),
          column.typeSql && el('span', { class: 'schema-column-type' }, column.typeSql),
        )),
      ),
    );
  }));
}

function insertIntoEditor(text) {
  const textarea = $('editor-text');
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;
  textarea.value = `${value.slice(0, start)}${text}${value.slice(end)}`;
  const pos = start + text.length;
  textarea.focus();
  textarea.setSelectionRange(pos, pos);
  hideAutocomplete();
  updateEditorCount();
}

const CARET_MIRROR_PROPS = [
  'boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontStyle', 'fontVariant', 'fontWeight',
  'fontSize', 'lineHeight', 'fontFamily', 'textAlign', 'textTransform', 'textIndent', 'letterSpacing',
  'wordSpacing', 'tabSize',
];

function caretCoordinates(textarea, position) {
  const div = document.createElement('div');
  const computed = getComputedStyle(textarea);
  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  div.style.whiteSpace = 'pre-wrap';
  div.style.wordWrap = 'break-word';
  for (const prop of CARET_MIRROR_PROPS) div.style[prop] = computed[prop];
  div.style.width = `${textarea.clientWidth}px`;
  document.body.append(div);

  div.textContent = textarea.value.slice(0, position);
  const span = document.createElement('span');
  span.textContent = textarea.value.slice(position) || '.';
  div.append(span);

  const coordinates = {
    top: span.offsetTop + parseInt(computed.borderTopWidth, 10),
    left: span.offsetLeft + parseInt(computed.borderLeftWidth, 10),
    height: span.offsetHeight,
  };
  div.remove();
  return coordinates;
}

function currentWordRange(text, caret) {
  let start = caret;
  while (start > 0 && /[\w.]/.test(text[start - 1])) start--;
  return { start, word: text.slice(start, caret) };
}

const ALIAS_STOPWORDS = new Set([
  'where', 'group', 'order', 'having', 'join', 'inner', 'left', 'right', 'full', 'outer', 'on', 'union',
  'intersect', 'except', 'limit', 'offset', 'fetch', 'with', 'set', 'values', 'returning', 'into', 'exec',
  'execute', 'cross', 'natural', 'using', 'for', 'window', 'as', 'and', 'or', 'select', 'from',
]);

const ID_PART = '(?:\\[[^\\]\\r\\n]+\\]|"[^"\\r\\n]+"|`[^`\\r\\n]+`|[A-Za-z_][\\w$#]*)';
const ALIAS_PATTERN = new RegExp(
  `\\b(?:FROM|JOIN)\\s+(${ID_PART}(?:\\s*\\.\\s*${ID_PART}){0,2})\\s+(?:AS\\s+)?(${ID_PART})(?![\\w$#])`,
  'gi',
);

function bareName(name) {
  return name.replace(/[\[\]"`\s]/g, '').toLowerCase();
}

function extractAliases(text) {
  const aliases = new Map();
  ALIAS_PATTERN.lastIndex = 0;
  let match;
  while ((match = ALIAS_PATTERN.exec(text))) {
    const [, rawTable, rawAlias] = match;
    const alias = bareName(rawAlias);
    if (!alias || ALIAS_STOPWORDS.has(alias)) continue;
    aliases.set(alias, bareName(rawTable));
  }
  return aliases;
}

function buildSuggestions(word, aliases) {
  const index = state.schemaIndex;
  if (!index) return [];
  const dot = word.lastIndexOf('.');

  if (dot >= 0) {
    const prefix = word.slice(0, dot).toLowerCase();
    const table = index.tablesByName.get(prefix) || index.tablesByName.get(aliases.get(prefix));
    if (!table) return [];
    const needle = word.slice(dot + 1).toLowerCase();
    return table.columns
      .filter((column) => column.name.toLowerCase().startsWith(needle))
      .slice(0, 12)
      .map((column) => ({ type: 'column', label: column.name, detail: column.typeSql || '', insertText: column.name }));
  }

  const needle = word.toLowerCase();
  const tableMatches = index.tableList
    .filter((table) => table.insertName.toLowerCase().startsWith(needle) || table.name.toLowerCase().startsWith(needle))
    .slice(0, 8)
    .map((table) => ({ type: 'table', label: table.displayName, detail: 'table', insertText: table.insertName }));
  const columnMatches = index.columnEntries
    .filter((column) => column.name.toLowerCase().startsWith(needle))
    .slice(0, 8)
    .map((column) => ({ type: 'column', label: column.name, detail: column.table, insertText: column.name }));
  return [...tableMatches, ...columnMatches].slice(0, 14);
}

let currentSuggestions = [];
let activeSuggestionIndex = -1;
let currentWordInfo = null;

function hideAutocomplete() {
  $('autocomplete-list').hidden = true;
  currentSuggestions = [];
  activeSuggestionIndex = -1;
  currentWordInfo = null;
}

function renderAutocomplete() {
  const list = $('autocomplete-list');
  list.replaceChildren(...currentSuggestions.map((suggestion, index) => el('li', {
    class: `suggestion${index === activeSuggestionIndex ? ' is-active' : ''}`,
    role: 'option',
    'aria-selected': String(index === activeSuggestionIndex),
    onmousedown: (event) => event.preventDefault(),
    onmouseup: () => acceptSuggestion(index),
    onmousemove: () => {
      if (activeSuggestionIndex !== index) {
        activeSuggestionIndex = index;
        renderAutocomplete();
      }
    },
  },
    el('span', { class: `suggestion-icon suggestion-icon-${suggestion.type}` }, suggestion.type === 'table' ? 'T' : 'C'),
    el('span', { class: 'suggestion-label' }, suggestion.label),
    suggestion.detail && el('span', { class: 'suggestion-detail' }, suggestion.detail),
  )));
  list.hidden = currentSuggestions.length === 0;
}

function positionAutocomplete() {
  const textarea = $('editor-text');
  const list = $('autocomplete-list');
  const coords = caretCoordinates(textarea, currentWordInfo.end);
  list.style.top = `${textarea.offsetTop + coords.top + coords.height - textarea.scrollTop + 2}px`;
  list.style.left = `${textarea.offsetLeft + coords.left - textarea.scrollLeft}px`;
}

function moveActiveSuggestion(delta) {
  if (!currentSuggestions.length) return;
  activeSuggestionIndex = (activeSuggestionIndex + delta + currentSuggestions.length) % currentSuggestions.length;
  renderAutocomplete();
}

function acceptSuggestion(index) {
  const suggestion = currentSuggestions[index];
  if (!suggestion || !currentWordInfo) return;
  const textarea = $('editor-text');
  const { start, end } = currentWordInfo;
  const value = textarea.value;
  textarea.value = `${value.slice(0, start)}${suggestion.insertText}${value.slice(end)}`;
  const pos = start + suggestion.insertText.length;
  textarea.focus();
  textarea.setSelectionRange(pos, pos);
  hideAutocomplete();
  updateEditorCount();
}

function syncAutocompleteToCaret() {
  if ($('autocomplete-list').hidden) return;
  const textarea = $('editor-text');
  const movedOut =
    !currentWordInfo ||
    textarea.selectionStart !== textarea.selectionEnd ||
    textarea.selectionStart < currentWordInfo.start ||
    textarea.selectionStart > currentWordInfo.end;
  if (movedOut) hideAutocomplete();
}

function updateAutocomplete(options = {}) {
  const textarea = $('editor-text');
  if (!state.schemaIndex || textarea.selectionStart !== textarea.selectionEnd) {
    hideAutocomplete();
    return;
  }
  const caret = textarea.selectionStart;
  const { start, word } = currentWordRange(textarea.value, caret);
  const dot = word.lastIndexOf('.');
  if (!options.force && dot < 0 && word.length < 2) {
    hideAutocomplete();
    return;
  }

  const suggestions = buildSuggestions(word, extractAliases(textarea.value));
  if (!suggestions.length) {
    hideAutocomplete();
    return;
  }

  currentSuggestions = suggestions;
  currentWordInfo = { start: dot >= 0 ? start + dot + 1 : start, end: caret };
  activeSuggestionIndex = 0;
  renderAutocomplete();
  positionAutocomplete();
}

function saveEditor() {
  const name = scriptName($('editor-name').value) || 'script.sql';
  const text = $('editor-text').value;
  if (!text.trim()) {
    showAddNotice('Nothing to save — the script is empty.');
    return;
  }
  const file = new File([text], name, { type: 'text/plain' });

  if (state.editing) {
    const script = state.editing;
    script.relPath = name;
    script.text = text;
    script.file = file;
    resetResult(script);
    state.selectedId = script.id;
    showAddNotice(`Saved ${name}.`);
  } else {
    let group = state.groups.find((candidate) => candidate.name === WRITTEN_GROUP_NAME);
    if (!group) {
      group = { id: state.nextId++, name: WRITTEN_GROUP_NAME, files: [], manualOrder: true };
      state.groups.push(group);
    }
    const entry = { id: state.nextId++, file, relPath: name, text };
    resetResult(entry);
    group.files.push(entry);
    state.selectedId = entry.id;
    showAddNotice(`Added ${name}.`);
  }
  state.editing = null;
  hideAutocomplete();
  $('editor-dialog').close();
  render();
}

async function addFromPaste(clipboard) {
  const text = clipboard.getData('text/plain');
  const fileItems = [...clipboard.items].filter((item) => item.kind === 'file');

  const pictureBesideText = text.trim() && fileItems.every((item) => item.type.startsWith('image/'));

  if (fileItems.length && !pictureBesideText) {
    const { added, replaced, ignored } = await addTransferred(readTransferItems(fileItems));
    if (ignored && !added && !replaced) {
      showAddNotice('No SQL scripts in what you pasted. If you copied a folder, drag it here or use Add folder.');
    }
  } else if (text.trim()) {
    addPastedText(text);
  } else {
    showAddNotice('Nothing to paste. Copy some SQL text or script files first.');
  }
}

async function pasteFromButton() {
  try {
    const text = await navigator.clipboard.readText();
    if (text.trim()) addPastedText(text);
    else showAddNotice('No text to paste. To paste copied files, press Ctrl+V.');
  } catch {
    showAddNotice('The browser did not allow reading the clipboard. Press Ctrl+V instead.');
  }
}

function setUpDropZone() {
  const panel = $('scripts-panel');
  let depth = 0;

  for (const type of ['dragover', 'drop']) {
    window.addEventListener(type, (event) => event.preventDefault());
  }
  panel.addEventListener('dragenter', () => {
    depth++;
    if (!state.running) panel.classList.add('is-drop-target');
  });
  panel.addEventListener('dragleave', () => {
    depth--;
    if (depth === 0) panel.classList.remove('is-drop-target');
  });
  panel.addEventListener('drop', (event) => {
    depth = 0;
    panel.classList.remove('is-drop-target');
    if (!state.running) addFromDrop(event.dataTransfer);
  });
}

function move(list, item, offset) {
  const from = list.indexOf(item);
  const to = from + offset;
  if (to < 0 || to >= list.length) return;
  list.splice(from, 1);
  list.splice(to, 0, item);
}

function removeFile(group, file) {
  group.files.splice(group.files.indexOf(file), 1);
  if (!group.files.length) state.groups.splice(state.groups.indexOf(group), 1);
  if (state.selectedId === file.id) state.selectedId = null;
  if (!state.groups.length) state.lastRun = null;
}

function removeGroup(group) {
  if (group.files.some((file) => file.id === state.selectedId)) state.selectedId = null;
  state.groups.splice(state.groups.indexOf(group), 1);
  if (!state.groups.length) state.lastRun = null;
}

function askToConfirm(files) {
  const { session } = state;
  const onError = $('on-error').value;
  const useTransaction = $('use-transaction').checked;
  const alreadyRan = files.filter(isFinished).length;

  $('confirm-title').textContent = `Run ${plural(files.length, 'script')} on ${session.label}?`;
  $('confirm-location').textContent = LOCATIONS[session.location].label;
  $('confirm-target').textContent = `${session.target} as ${session.user}`;
  $('confirm-on-error').textContent = ON_ERROR_LABELS[onError];
  $('confirm-transaction').textContent = useTransaction ? 'One per file' : 'None. Each statement stays applied.';
  $('confirm-warning').hidden = alreadyRan === 0;
  $('confirm-warning').textContent = `${plural(alreadyRan, 'script')} already ran successfully and will run again.`;
  $('confirm-run').textContent = `Run ${plural(files.length, 'script')}`;

  const dialog = $('confirm-dialog');
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'run'), { once: true });
  });
}

async function startRun(files) {
  if (state.running || !files.length) return;
  $('confirm-dialog').returnValue = '';
  if (!(await askToConfirm(files))) return;

  const options = {
    onError: $('on-error').value,
    transaction: $('use-transaction').checked,
    newUser: !readStorage(COUNTED_KEY),
  };

  state.running = true;
  state.stopRequested = false;
  state.followRunning = true;
  state.runId = crypto.randomUUID();
  state.lastRun = { planned: files, startedAt: Date.now(), ms: null };
  $('add-notice').hidden = true;
  for (const file of files) {
    resetResult(file);
    file.status = 'waiting';
  }
  render();

  for (const file of files) {
    if (state.stopRequested) break;
    await runFile(file, options);
    if (file.status === 'stopped' || !state.session) break;
    if (file.status === 'error' && options.onError === 'stop') break;
  }

  for (const file of files) {
    if (file.status === 'waiting') file.status = 'skipped';
  }

  state.running = false;
  state.currentFile = null;
  state.lastRun.ms = Date.now() - state.lastRun.startedAt;
  const firstFailure = files.find((file) => file.status === 'error');
  if (firstFailure && state.followRunning) state.selectedId = firstFailure.id;
  render();
}

function failFile(file, message) {
  file.failed++;
  file.status = 'error';
  file.entries.push({ type: 'stmt', status: 'error', line: null, preview: '', messages: [], error: { message } });
}

async function runFile(file, options) {
  state.currentFile = file;
  file.status = 'running';
  if (state.followRunning) state.selectedId = file.id;
  render();
  document.querySelector(`[data-file-id="${file.id}"]`)?.scrollIntoView({ block: 'nearest' });

  let bytes;
  try {
    bytes = await file.file.arrayBuffer();
  } catch {
    failFile(file, 'This file changed or moved after it was added. Add it again, then run it.');
    return;
  }

  const query = new URLSearchParams({
    runId: state.runId,
    onError: options.onError,
    transaction: options.transaction ? '1' : '0',
    newUser: options.newUser ? '1' : '0',
  });

  try {
    const response = await fetch(`/api/run?${query}`, {
      method: 'POST',
      headers: { 'X-Session': state.session.token, 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      failFile(file, body.error ?? `The server answered with status ${response.status}.`);
      return;
    }
    writeStorage(COUNTED_KEY, true);
    await readEvents(response, (event) => handleEvent(file, event));
    if (file.status === 'running') failFile(file, 'The run ended early. The result of this file is unknown.');
  } catch {
    failFile(file, 'Lost contact with the local DB AutoRun server. The result of this file is unknown.');
  }
}

async function readEvents(response, onEvent) {
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      onEvent(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
    }
  }
}

function handleEvent(file, event) {
  if (event.type === 'start') {
    file.statements = event.statements;
    file.encoding = event.encoding;
  } else if (event.type === 'stmt') {
    if (event.status === 'ok') {
      file.executed++;
      if (file.okStored >= MAX_STORED_OK_ENTRIES) {
        file.okDropped++;
      } else {
        file.okStored++;
        file.entries.push(event);
      }
    } else {
      if (event.status === 'warning') file.executed++;
      else file.failed++;
      file.entries.push(event);
    }
  } else if (event.type === 'note') {
    file.entries.push(event);
  } else if (event.type === 'end') {
    Object.assign(file, {
      status: event.status,
      executed: event.executed,
      failed: event.failed,
      warnings: event.warnings,
      rolledBack: event.rolledBack,
      ms: event.ms,
    });
    if (event.error) {
      file.entries.push({ type: 'stmt', status: 'error', line: null, preview: '', messages: [], error: event.error });
    }
  }
  scheduleRender();
}

async function requestStop() {
  state.stopRequested = true;
  render();
  await fetch('/api/stop', {
    method: 'POST',
    headers: { 'X-Session': state.session.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId: state.runId }),
  }).catch(() => {});
}

let renderTimer = null;

function scheduleRender() {
  renderTimer ??= setTimeout(() => {
    renderTimer = null;
    render();
  }, RENDER_INTERVAL_MS);
}

function render() {
  renderQueue();
  renderRunPanel();
  renderLog();
}

const ICON_PATHS = {
  up: 'M8 13V3M3.500 7.500 8 3l4.500 4.500',
  down: 'M8 3v10M3.500 8.500 8 13l4.500-4.500',
  remove: 'M4 4l8 8M12 4l-8 8',
  edit: 'M11 2.5 L13.5 5 L5 13.5 L2 14 L2.5 11 Z',
};

function icon(name) {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(namespace, 'path');
  path.setAttribute('d', ICON_PATHS[name]);
  svg.append(path);
  return svg;
}

function iconButton(iconName, label, key, options) {
  return el('button', {
    class: 'icon-btn',
    type: 'button',
    title: label,
    'aria-label': label,
    disabled: options.disabled,
    onclick: options.onClick,
    dataset: { focusKey: key },
  }, icon(iconName));
}

function fileStateText(file) {
  if (file.status === 'idle') return formatSize(file.file.size);
  if (file.status === 'running') {
    if (file.statements === null) return 'Starting';
    return `${(file.executed + file.failed).toLocaleString()} of ${file.statements.toLocaleString()}`;
  }
  return STATUS_LABELS[file.status];
}

function renderQueue() {
  const queue = $('queue');
  const focusKey = document.activeElement?.dataset?.focusKey;
  const scrollTop = queue.scrollTop;
  const count = allFiles().length;
  const locked = state.running;
  let number = 0;

  const rerender = (action) => () => {
    action();
    render();
  };

  queue.replaceChildren(
    ...state.groups.map((group, groupIndex) =>
      el('section', { class: 'group' },
        el('header', { class: 'group-head' },
          el('span', { class: 'group-name', title: group.name }, group.name),
          el('span', { class: 'group-count' }, plural(group.files.length, 'file')),
          state.groups.length > 1 && iconButton('up', `Move ${group.name} up`, `g-up-${group.id}`, {
            disabled: locked || groupIndex === 0,
            onClick: rerender(() => move(state.groups, group, -1)),
          }),
          state.groups.length > 1 && iconButton('down', `Move ${group.name} down`, `g-down-${group.id}`, {
            disabled: locked || groupIndex === state.groups.length - 1,
            onClick: rerender(() => move(state.groups, group, 1)),
          }),
          iconButton('remove', `Remove ${group.name}`, `g-remove-${group.id}`, {
            disabled: locked,
            onClick: rerender(() => removeGroup(group)),
          }),
        ),
        el('ol', { class: 'files' },
          ...group.files.map((file, fileIndex) => {
            number++;
            return el('li', {
              class: `file${state.selectedId === file.id ? ' is-selected' : ''}`,
              dataset: { status: file.status, fileId: file.id },
            },
              el('button', {
                class: 'file-main',
                type: 'button',
                title: file.relPath,
                dataset: { focusKey: `f-${file.id}` },
                onclick: () => {
                  state.selectedId = file.id;
                  state.followRunning = false;
                  render();
                },
              },
                el('span', { class: 'file-num' }, String(number)),
                el('span', { class: 'file-path' }, file.relPath),
                el('span', { class: 'file-state' }, fileStateText(file)),
              ),
              el('span', { class: 'row-actions' },
                iconButton('edit', `Edit ${file.relPath}`, `f-edit-${file.id}`, {
                  disabled: locked,
                  onClick: () => openEditor(file),
                }),
                iconButton('up', `Move ${file.relPath} up`, `f-up-${file.id}`, {
                  disabled: locked || fileIndex === 0,
                  onClick: rerender(() => {
                    group.manualOrder = true;
                    move(group.files, file, -1);
                  }),
                }),
                iconButton('down', `Move ${file.relPath} down`, `f-down-${file.id}`, {
                  disabled: locked || fileIndex === group.files.length - 1,
                  onClick: rerender(() => {
                    group.manualOrder = true;
                    move(group.files, file, 1);
                  }),
                }),
                iconButton('remove', `Remove ${file.relPath}`, `f-remove-${file.id}`, {
                  disabled: locked,
                  onClick: rerender(() => removeFile(group, file)),
                }),
              ),
            );
          }),
        ),
      ),
    ),
  );

  queue.scrollTop = scrollTop;
  if (focusKey) queue.querySelector(`[data-focus-key="${focusKey}"]`)?.focus();

  $('script-count').textContent = count ? `(${count.toLocaleString()})` : '';
  $('queue-empty').hidden = count > 0;
  $('queue-foot').hidden = count === 0;
  $('clear-all').disabled = locked;
  $('add-files').disabled = locked;
  $('add-folder').disabled = locked;
  $('paste').disabled = locked;
  $('new-script').disabled = locked;
  $('backup').disabled = locked;
  $('restore').disabled = locked;
  $('disconnect').disabled = locked;
}

function summarize(planned) {
  const count = (...statuses) => planned.filter((file) => statuses.includes(file.status)).length;
  return {
    finished: count('ok', 'warning'),
    withWarnings: count('warning'),
    failed: count('error'),
    notRun: count('skipped', 'stopped', 'waiting'),
  };
}

function renderRunPanel() {
  const files = allFiles();
  const remaining = files.filter((file) => !isFinished(file));
  const someRan = state.lastRun !== null && files.some((file) => file.status !== 'idle');
  const showRemaining = !state.running && someRan && remaining.length > 0 && remaining.length < files.length;

  const runAll = $('run-all');
  runAll.hidden = state.running;
  runAll.disabled = files.length === 0;
  runAll.textContent = files.length ? `Run ${plural(files.length, 'script')}` : 'Run scripts';
  runAll.classList.toggle('primary', !showRemaining);

  const runRemaining = $('run-remaining');
  runRemaining.hidden = !showRemaining;
  runRemaining.textContent =
    remaining.length === 1 ? 'Run the unfinished script' : `Run the ${remaining.length.toLocaleString()} unfinished scripts`;

  const stop = $('stop');
  stop.hidden = !state.running;
  stop.disabled = state.stopRequested;
  stop.textContent = state.stopRequested ? 'Stopping after this statement…' : 'Stop';

  $('save-log').hidden = state.running || !someRan;
  $('on-error').disabled = state.running;
  $('use-transaction').disabled = state.running;

  const inTransaction = $('use-transaction').checked;
  const continueOption = $('on-error').querySelector('option[value="continue"]');
  continueOption.disabled = inTransaction;
  if (inTransaction && $('on-error').value === 'continue') $('on-error').value = 'next';

  const status = $('run-status');
  const run = state.lastRun;
  status.hidden = !run;
  if (!run) return;

  const progress = $('run-progress');
  const stillListed = run.planned.filter((file) => findFile(file.id));
  const { finished, withWarnings, failed, notRun } = summarize(stillListed);

  if (state.running) {
    const position = run.planned.indexOf(state.currentFile) + 1;
    $('run-summary').textContent = `File ${position} of ${run.planned.length}: ${state.currentFile?.relPath ?? ''}`;
    status.dataset.tone = 'running';
    progress.hidden = false;
    progress.max = run.planned.length;
    progress.value = Math.max(0, position - 1);
    return;
  }

  progress.hidden = true;
  const time = ` Took ${formatDuration(run.ms ?? 0)}.`;
  if (failed > 0) {
    const parts = [`${failed} failed`];
    if (finished) parts.push(`${finished} finished`);
    if (notRun) parts.push(`${notRun} not run`);
    $('run-summary').textContent = `${parts.join(', ')}.${time}`;
    status.dataset.tone = 'error';
  } else if (notRun > 0) {
    $('run-summary').textContent = `Stopped. ${finished} finished, ${notRun} not run.${time}`;
    status.dataset.tone = 'warning';
  } else if (withWarnings > 0) {
    const outcome = finished === 1
      ? 'The script finished with warnings.'
      : `All ${finished.toLocaleString()} scripts finished, ${withWarnings} with warnings.`;
    $('run-summary').textContent = `${outcome}${time}`;
    status.dataset.tone = 'warning';
  } else {
    const outcome = finished === 1 ? 'The script finished.' : `All ${finished.toLocaleString()} scripts finished.`;
    $('run-summary').textContent = `${outcome}${time}`;
    status.dataset.tone = 'ok';
  }
}

function resultText(entry) {
  const parts = [];
  if (entry.rows) parts.push(`${plural(entry.rows, 'row')}${entry.more ? '+' : ''} returned`);
  if (entry.affected) parts.push(`${plural(entry.affected, 'row')} affected`);
  if (entry.runs) parts.push(`ran ${entry.runs} times`);
  if (typeof entry.ms === 'number') parts.push(formatDuration(entry.ms));
  return parts.join(' · ');
}

function lineLabel(line) {
  return line ? `Line ${line.toLocaleString()}` : 'File';
}

function resultTable(entry) {
  const header = el('tr', {}, ...entry.columns.map((name) => el('th', {}, name)));
  const body = entry.data.map((row) =>
    el('tr', {}, ...row.map((cell) =>
      cell === null ? el('td', { class: 'cell-null' }, 'NULL') : el('td', { title: String(cell) }, String(cell)),
    )),
  );
  const table = el('table', { class: 'result-table' }, el('thead', {}, header), el('tbody', {}, ...body));
  const block = el('div', { class: 'result-block' }, el('div', { class: 'result-scroll' }, table));
  if (entry.rows > entry.data.length || entry.more) {
    block.append(el('div', { class: 'result-more' },
      `Showing the first ${entry.data.length.toLocaleString()} of ${entry.rows.toLocaleString()}${entry.more ? '+' : ''} rows.`,
    ));
  } else if (entry.data.length === 0) {
    block.append(el('div', { class: 'result-more' }, 'No rows returned.'));
  }
  return block;
}

function renderEntry(entry) {
  const messages = entry.messages?.length ? el('pre', {}, entry.messages.join('\n')) : null;

  if (entry.type === 'note') {
    return el('li', { class: `entry ${entry.level === 'error' ? 'is-error' : 'is-warning'}` },
      el('span', { class: 'entry-line' }, lineLabel(entry.line)),
      el('div', { class: 'entry-body' },
        entry.text && el('div', { class: 'entry-sql' }, entry.text),
        el('div', { class: 'note-text' }, entry.message),
      ),
    );
  }

  if (entry.status === 'error') {
    const errorLine = entry.error?.line ?? entry.line;
    const code = entry.error?.code ? `${entry.error.code}: ` : '';
    return el('li', { class: 'entry is-error' },
      el('span', { class: 'entry-line' }, lineLabel(errorLine)),
      el('div', { class: 'entry-body' },
        el('pre', { class: 'error-text' }, `${code}${entry.error?.message ?? 'Unknown error'}`),
        messages,
        entry.sql && el('details', {},
          el('summary', {}, `Show the statement (starts at line ${entry.line.toLocaleString()})`),
          el('pre', {}, entry.sql),
        ),
      ),
    );
  }

  const hasTable = Boolean(entry.columns && entry.data);
  return el('li', { class: `entry${entry.status === 'warning' ? ' is-warning' : ''}` },
    el('span', { class: 'entry-line' }, lineLabel(entry.line)),
    el('span', { class: 'entry-sql', title: entry.preview }, entry.preview),
    el('span', { class: 'entry-meta' }, resultText(entry)),
    (entry.warning || messages || hasTable) && el('div', { class: 'entry-body' },
      entry.warning && el('div', { class: 'note-text' }, entry.warning),
      messages,
      hasTable && resultTable(entry),
    ),
  );
}

function renderLog() {
  const log = $('log');
  const file = findFile(state.selectedId);

  if (!file) {
    log.replaceChildren(el('p', { class: 'log-empty' },
      state.lastRun ? 'Select a script to see its results.' : 'Results appear here when you run your scripts.',
    ));
    return;
  }

  const stickToBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;

  const meta = [];
  if (file.status === 'idle') meta.push('Not run yet');
  else meta.push(file.status === 'running' ? 'Running' : STATUS_LABELS[file.status]);
  if (file.statements !== null) {
    meta.push(`${file.executed.toLocaleString()} of ${plural(file.statements, 'statement')} succeeded`);
  }
  if (file.ms !== null) meta.push(formatDuration(file.ms));
  if (file.encoding) meta.push(file.encoding);

  let callout = null;
  if (file.rolledBack) {
    callout = 'Rolled back. No changes from this file were kept, apart from anything the database commits automatically.';
  } else if (file.status === 'error' && file.executed > 0) {
    callout = 'Statements that ran before the failure are still applied.';
  } else if (file.status === 'stopped' && file.executed > 0) {
    callout = 'Stopped part way through. Statements that already ran are still applied.';
  }

  const okEntries = file.okStored;
  const hiddenOk = Math.max(0, okEntries - VISIBLE_OK_ENTRIES);
  let okSeen = 0;
  const visible = file.entries.filter((entry) => {
    if (entry.status !== 'ok') return true;
    okSeen++;
    return okSeen > hiddenOk;
  });

  const trimmedCount = hiddenOk + file.okDropped;
  const sections = [
    el('header', { class: 'log-head' },
      el('div', { class: 'log-title' }, file.relPath),
      el('div', { class: 'log-meta' }, meta.join(' · ')),
      callout && el('div', { class: 'log-callout' }, callout),
    ),
  ];
  if (trimmedCount > 0) {
    sections.push(el('div', { class: 'log-trimmed' },
      `${plural(trimmedCount, 'earlier successful statement')} not shown. Save the log to see more.`,
    ));
  }

  if (file.text && file.status === 'idle') {
    const isCut = file.text.length > MAX_PASTE_PREVIEW;
    sections.push(el('pre', { class: 'pasted-preview' },
      isCut ? `${file.text.slice(0, MAX_PASTE_PREVIEW)}\n…` : file.text,
    ));
  }
  sections.push(el('ul', { class: 'entries' }, ...visible.map(renderEntry)));
  log.replaceChildren(...sections);

  if (state.running && stickToBottom) log.scrollTop = log.scrollHeight;
}

function buildLogText() {
  const { session } = state;
  const lines = [
    'DB AutoRun log',
    `Server: ${session.label} ${session.target} as ${session.user} (${LOCATIONS[session.location].label})`,
    `Version: ${session.version}`,
    `Saved: ${new Date().toLocaleString()}`,
    '',
  ];

  allFiles().forEach((file, index) => {
    const label = file.status === 'idle' ? 'Not run' : STATUS_LABELS[file.status] ?? file.status;
    const counts = file.statements !== null ? `, ${file.executed} of ${file.statements} statements succeeded` : '';
    const duration = file.ms !== null ? `, ${formatDuration(file.ms)}` : '';
    lines.push(`${index + 1}. [${label}] ${file.relPath}${counts}${duration}`);
    if (file.rolledBack) lines.push('   Rolled back.');

    for (const entry of file.entries) {
      const at = entry.line ? `line ${entry.line}` : 'file';
      if (entry.type === 'note') {
        lines.push(`   ${at}: NOTE ${entry.text ? `${entry.text} - ` : ''}${entry.message}`);
      } else if (entry.status === 'error') {
        const code = entry.error?.code ? `${entry.error.code}: ` : '';
        lines.push(`   ${entry.error?.line ? `line ${entry.error.line}` : at}: ERROR ${code}${entry.error?.message ?? ''}`);
        if (entry.sql) lines.push(entry.sql.replace(/^/gm, '      | '));
      } else {
        lines.push(`   ${at}: ${entry.status === 'warning' ? 'WARNING' : 'OK'} ${entry.preview} (${resultText(entry)})`);
        if (entry.warning) lines.push(`      ${entry.warning}`);
        if (entry.columns && entry.data) {
          lines.push(`      ${entry.columns.join('\t')}`);
          for (const row of entry.data) {
            lines.push(`      ${row.map((cell) => (cell === null ? 'NULL' : String(cell).replace(/\t/g, ' '))).join('\t')}`);
          }
        }
      }
      for (const message of entry.messages ?? []) lines.push(`      > ${message}`);
    }
    if (file.okDropped) lines.push(`   ...and ${file.okDropped} more successful statements.`);
    lines.push('');
  });

  return lines.join('\r\n');
}

function saveLog() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const url = URL.createObjectURL(new Blob([buildLogText()], { type: 'text/plain;charset=utf-8' }));
  const link = el('a', { href: url, download: `db-autorun-log-${stamp}.txt` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function backupDatabase() {
  const button = $('backup');
  if (button.disabled) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Backing up…';
  try {
    const response = await fetch('/api/backup', { method: 'POST', headers: { 'X-Session': state.session.token } });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      showAddNotice(body.error ?? 'Backup failed.');
      return;
    }
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const named = /filename="([^"]+)"/.exec(disposition);
    const filename = named ? named[1] : 'backup.sql';
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = el('a', { href: url, download: filename });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    showAddNotice(`Backup saved as ${filename}. To restore it later, use Restore (or Add files) and Run.`);
  } catch {
    showAddNotice('Lost contact with the server during the backup.');
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

$('backup').addEventListener('click', backupDatabase);
$('restore').addEventListener('click', () => $('file-input').click());
$('db-type').addEventListener('change', (event) => {
  showConnectionFields(event.target.value);
  $('server').focus();
});
for (const radio of document.querySelectorAll('input[name="location"]')) {
  radio.addEventListener('change', applyLocation);
}
$('copy-cmd')?.addEventListener('click', async () => {
  const button = $('copy-cmd');
  try {
    await navigator.clipboard.writeText('npx dbautorun');
    const original = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = original; }, 1500);
  } catch {
    const range = document.createRange();
    range.selectNodeContents($('npx-cmd'));
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
});
$('database').addEventListener('input', hideDatabasePanel);
$('encrypt').addEventListener('change', updateSecurityOptions);
$('verify-certificate').addEventListener('change', updateSecurityOptions);
$('connect-form').addEventListener('submit', submitConnection);
$('disconnect').addEventListener('click', disconnect);

$('add-files').addEventListener('click', () => $('file-input').click());
$('add-folder').addEventListener('click', () => $('folder-input').click());
$('paste').addEventListener('click', pasteFromButton);
$('new-script').addEventListener('click', () => openEditor(null));
$('editor-cancel').addEventListener('click', () => { hideAutocomplete(); $('editor-dialog').close(); });
$('editor-save').addEventListener('click', saveEditor);
$('schema-search').addEventListener('input', renderSchemaPanel);
$('editor-text').addEventListener('input', () => {
  updateEditorCount();
  updateAutocomplete();
});
$('editor-text').addEventListener('blur', hideAutocomplete);
$('editor-text').addEventListener('click', syncAutocompleteToCaret);
$('editor-text').addEventListener('keyup', (event) => {
  if (!event.key.startsWith('Arrow') && !['Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return;
  syncAutocompleteToCaret();
});
$('editor-text').addEventListener('keydown', (event) => {
  if (!$('autocomplete-list').hidden) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActiveSuggestion(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActiveSuggestion(-1);
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      acceptSuggestion(activeSuggestionIndex);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      hideAutocomplete();
      return;
    }
  }
  if (event.ctrlKey && event.code === 'Space') {
    event.preventDefault();
    updateAutocomplete({ force: true });
    return;
  }
  if (event.key === 'Tab') {
    event.preventDefault();
    const area = event.target;
    const { selectionStart: start, selectionEnd: end } = area;
    area.value = `${area.value.slice(0, start)}  ${area.value.slice(end)}`;
    area.selectionStart = area.selectionEnd = start + 2;
    updateEditorCount();
  } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    saveEditor();
  }
});
document.addEventListener('paste', (event) => {
  if ($('app-view').hidden || state.running || $('confirm-dialog').open || $('editor-dialog').open) return;
  if (event.target.closest('input, textarea, [contenteditable]')) return;
  event.preventDefault();
  addFromPaste(event.clipboardData);
});
$('file-input').accept = [...SCRIPT_EXTENSIONS].map((extension) => `.${extension}`).join(',');
for (const [inputId, handler] of [['file-input', addFromFilePicker], ['folder-input', addFromFolderPicker]]) {
  $(inputId).addEventListener('change', (event) => {
    handler(event.target.files);
    event.target.value = '';
  });
}
$('clear-all').addEventListener('click', () => {
  state.groups = [];
  state.selectedId = null;
  state.lastRun = null;
  $('add-notice').hidden = true;
  render();
});

$('use-transaction').addEventListener('change', renderRunPanel);
$('run-all').addEventListener('click', () => startRun(allFiles()));
$('run-remaining').addEventListener('click', () => startRun(allFiles().filter((file) => !isFinished(file))));
$('stop').addEventListener('click', requestStop);
$('save-log').addEventListener('click', saveLog);

$('confirm-cancel').addEventListener('click', () => $('confirm-dialog').close(''));
$('confirm-run').addEventListener('click', () => $('confirm-dialog').close('run'));

window.addEventListener('beforeunload', (event) => {
  if (state.running) event.preventDefault();
});

setUpDropZone();
dbSelect = setUpDbSelect();
restoreConnectionForm();
