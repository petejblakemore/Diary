'use strict';

// Diary frontend. All file and Git work is done by the Rust backend; this
// file only handles the editor, calendar, templates and timing.

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWebview } = window.__TAURI__.webview;

const $ = (id) => document.getElementById(id);
const editor = $('editor');

const DEFAULTS = {
  day: '# {{weekday}}, {{date}}\n\n## {{time}}\n\n',
  entry: '## {{time}}\n\n',
};
const SAVE_DELAY = 1200;            // autosave after typing pauses
const COMMIT_DELAY = 2 * 60 * 1000; // Git snapshot after two quiet minutes
const EMPTY_SESSION = /(^|\n)## \d{1,2}:\d{2}\s*$/;
const IMAGE = /\.(png|jpe?g|gif|webp|heic|tiff?)$/i;
const BASIC = /\{\{(date|weekday|time|year|month)\}\}/g;
const EXTRA = /\{\{(weather|moon)\}\}/g;

let journal = null;
let doc = null; // { kind: 'entry', date, onDisk } or { kind: 'template', name }
let dirty = false;
let saveTimer = null;
let commitTimer = null;
let view = { year: 0, month: 0 };
const extrasCache = new Map(); // date -> { weather, moon }, fetched once per session

// ---------- dates ----------

const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseIso = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const clock = () => {
  const now = new Date();
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
};
const stamp = () => `${isoDate(new Date())} ${clock()}`;
const longDate = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const weekday = (d) => d.toLocaleDateString('en-GB', { weekday: 'long' });

// ---------- templates ----------

// Placeholders are filled in once, at creation; saved files hold plain text.
// A line using {{weather}} or {{moon}} is dropped if none of them has a value
// (a past day, no location set, or no connection).
function fillTemplate(text, date, extras = {}) {
  const values = {
    date: longDate(date),
    weekday: weekday(date),
    time: clock(),
    year: String(date.getFullYear()),
    month: date.toLocaleDateString('en-GB', { month: 'long' }),
  };
  const basics = (line) => line.replace(BASIC, (_, key) => values[key]);
  return text
    .split('\n')
    .flatMap((line) => {
      if (!line.match(EXTRA)) return [basics(line)];
      let filled = false;
      const out = line.replace(EXTRA, (_, key) => {
        if (extras[key]) filled = true;
        return extras[key] ?? '';
      });
      return filled ? [basics(out).replace(/^[\s·|,]+|[\s·|,]+$/g, '')] : [];
    })
    .join('\n');
}

async function dayExtras(date, template) {
  if (!template.match(EXTRA) || date !== isoDate(new Date())) return {};
  if (!extrasCache.has(date)) {
    setStatus('Fetching weather…');
    extrasCache.set(date, await invoke('day_extras', { date }).catch(() => ({})));
  }
  return extrasCache.get(date);
}

async function loadTemplate(name) {
  try {
    return await invoke('read_template', { name });
  } catch {
    return DEFAULTS[name] ?? DEFAULTS.day;
  }
}

async function renderTemplates() {
  const names = await invoke('list_templates').catch(() => []);
  const list = $('templates');
  list.replaceChildren();
  for (const name of names) {
    const button = document.createElement('button');
    button.textContent = name;
    button.classList.toggle('selected', doc?.kind === 'template' && doc.name === name);
    button.addEventListener('click', () => openTemplate(name));
    const item = document.createElement('li');
    item.append(button);
    list.append(item);
  }
}

async function openTemplate(name) {
  await save();
  const text = await loadTemplate(name);
  doc = { kind: 'template', name };
  showDoc(text, `Template: ${name}`);
  setStatus('Placeholders: {{date}} {{weekday}} {{time}} {{year}} {{month}} {{weather}} {{moon}}');
  renderTemplates();
  renderCalendar();
}

async function createTemplate(name) {
  name = name.trim();
  if (!name) return;
  try {
    await invoke('write_template', { name, content: '# {{weekday}}, {{date}}\n\n' });
    scheduleCommit();
    await openTemplate(name);
  } catch (e) {
    setStatus(String(e));
  }
}

// Resolves to a template name, or null if cancelled.
async function pickTemplate() {
  const names = (await invoke('list_templates').catch(() => [])).filter((n) => n !== 'entry');
  return new Promise((resolve) => {
    const overlay = $('picker');
    const list = $('picker-list');
    list.replaceChildren();

    const close = (value) => {
      overlay.hidden = true;
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(null);
      }
    };

    for (const name of names) {
      const button = document.createElement('button');
      button.textContent = name;
      button.addEventListener('click', () => close(name));
      list.append(button);
    }
    overlay.onclick = (e) => { if (e.target === overlay) close(null); };
    document.addEventListener('keydown', onKey, true);
    overlay.hidden = false;
    list.querySelector('button')?.focus();
  });
}

// ---------- entries ----------

function showDoc(text, title) {
  editor.disabled = false;
  editor.value = text;
  $('doc-title').textContent = title;
  editor.focus();
  editor.setSelectionRange(text.length, text.length);
  editor.scrollTop = editor.scrollHeight;
}

// Opens an existing entry, or shows a draft from a template. Drafts are only
// written to disk once you type, so browsing never creates empty files.
async function openEntry(date, { template = 'day', append = false } = {}) {
  await save();
  const day = parseIso(date);
  let existing;
  try {
    existing = await invoke('read_entry', { date });
  } catch (e) {
    setStatus(String(e));
    return;
  }

  let text;
  if (existing !== null) {
    text = existing;
    if (append && !EMPTY_SESSION.test(text)) {
      const session = fillTemplate(await loadTemplate('entry'), day).trimStart();
      text = `${text.trimEnd()}\n\n${session}`;
    }
  } else {
    const source = await loadTemplate(template);
    text = fillTemplate(source, day, await dayExtras(date, source));
  }

  doc = { kind: 'entry', date, onDisk: existing !== null };
  view = { year: day.getFullYear(), month: day.getMonth() + 1 };
  showDoc(text, `${weekday(day)}, ${longDate(day)}`);
  setStatus(doc.onDisk ? 'Saved' : 'New entry: saved when you start typing');
  renderCalendar();
  renderTemplates();
}

async function goToday(chooseTemplate = false) {
  const today = isoDate(new Date());
  if (chooseTemplate) {
    const exists = (await invoke('read_entry', { date: today }).catch(() => null)) !== null;
    if (!exists) {
      const template = await pickTemplate();
      if (!template) return;
      return openEntry(today, { template });
    }
  }
  return openEntry(today, { append: true });
}

// ---------- saving & backups ----------

function setStatus(text) {
  $('save-state').textContent = text;
}

function markDirty() {
  dirty = true;
  setStatus('Editing…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DELAY);
}

async function save() {
  clearTimeout(saveTimer);
  if (!dirty || !doc) return;
  dirty = false;
  const target = doc;
  const content = editor.value;
  try {
    if (target.kind === 'entry') {
      await invoke('write_entry', { date: target.date, content });
      if (!target.onDisk) {
        target.onDisk = true;
        renderCalendar();
      }
    } else {
      await invoke('write_template', { name: target.name, content });
    }
    if (!dirty) setStatus('Saved');
    scheduleCommit();
  } catch (e) {
    dirty = true;
    setStatus(`Not saved: ${e}`);
  }
}

function scheduleCommit() {
  clearTimeout(commitTimer);
  commitTimer = setTimeout(commitNow, COMMIT_DELAY);
}

async function commitNow() {
  clearTimeout(commitTimer);
  try {
    await invoke('commit', { message: stamp() });
  } catch (e) {
    setStatus(`Backup failed: ${e}`);
  }
}

// ---------- calendar ----------

async function renderCalendar() {
  const { year, month } = view;
  if (!year) return;
  const first = new Date(year, month - 1, 1);
  const days = await invoke('month_entries', { year, month }).catch(() => []);
  const has = new Set(days);
  const today = isoDate(new Date());

  $('month-title').textContent = first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const grid = $('days');
  grid.replaceChildren();

  const offset = (first.getDay() + 6) % 7; // Monday-first
  for (let i = 0; i < offset; i++) grid.append(document.createElement('span'));

  const count = new Date(year, month, 0).getDate();
  for (let d = 1; d <= count; d++) {
    const date = `${year}-${pad(month)}-${pad(d)}`;
    const button = document.createElement('button');
    button.textContent = d;
    button.classList.toggle('has-entry', has.has(d));
    button.classList.toggle('today', date === today);
    button.classList.toggle('future', date > today);
    button.classList.toggle('selected', doc?.kind === 'entry' && doc.date === date);
    button.addEventListener('click', async (e) => {
      if (e.altKey && !has.has(d)) {
        const template = await pickTemplate();
        if (template) openEntry(date, { template });
      } else {
        openEntry(date);
      }
    });
    grid.append(button);
  }
}

function shiftMonth(delta) {
  const d = new Date(view.year, view.month - 1 + delta, 1);
  view = { year: d.getFullYear(), month: d.getMonth() + 1 };
  renderCalendar();
}

// ---------- attachments ----------

function insertAtCursor(text) {
  editor.focus();
  editor.setRangeText(text, editor.selectionStart, editor.selectionEnd, 'end');
  markDirty();
}

getCurrentWebview().onDragDropEvent(async (event) => {
  if (event.payload.type !== 'drop') return;
  if (doc?.kind !== 'entry') {
    setStatus('Open an entry to attach files');
    return;
  }
  const date = doc.date;
  const links = [];
  for (const path of event.payload.paths) {
    try {
      const rel = await invoke('add_attachment', { date, source: path });
      const name = rel.split('/').pop();
      links.push(IMAGE.test(name) ? `![](${rel})` : `[${name}](${rel})`);
    } catch (e) {
      setStatus(`Could not attach: ${e}`);
    }
  }
  if (links.length && doc?.date === date) insertAtCursor(`${links.join('\n')}\n`);
});

// ---------- dialogs ----------

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const shortDate = (iso) => parseIso(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const plural = (n, word) => `${n.toLocaleString('en-GB')} ${word}${n === 1 ? '' : 's'}`;

function listOf(items, limit = 12) {
  const list = el('ul');
  for (const item of items.slice(0, limit)) list.append(el('li', { textContent: item }));
  if (items.length > limit) list.append(el('li', { textContent: `…and ${items.length - limit} more` }));
  return list;
}

function showDialog(...children) {
  $('dialog-body').replaceChildren(...children);
  $('dialog').hidden = false;
  $('dialog-body').querySelector('.actions button:last-child')?.focus();
}

function closeDialog() {
  $('dialog').hidden = true;
  editor.focus();
}

// ---------- weather ----------

async function weatherSettings() {
  const current = await invoke('get_weather_location').catch(() => null);
  const input = el('input', {
    type: 'text',
    className: 'text-input',
    value: current ?? '',
    placeholder: 'e.g. Nantlle (leave blank to switch off)',
    maxLength: 60,
  });
  const error = el('p', { className: 'error' });
  const apply = async () => {
    try {
      await invoke('set_weather_location', { location: input.value });
      extrasCache.clear();
      closeDialog();
    } catch (e) {
      error.textContent = String(e);
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });

  showDialog(
    el('h2', { textContent: 'Weather and moon phase' }),
    el('p', {}, 'Add ', el('code', { textContent: '{{weather}}' }), ' and ', el('code', { textContent: '{{moon}}' }),
      ' to a template such as day.md. They are filled in once, when today’s entry is created, and saved as plain text.'),
    el('p', { className: 'hint', textContent: 'The moon phase is worked out on this Mac. The weather is fetched once a day from wttr.in, which sees this location and your IP address. Leave the location blank to keep Diary completely offline.' }),
    input,
    error,
    el('div', { className: 'actions' },
      el('button', { className: 'link', textContent: 'Cancel', onclick: closeDialog }),
      el('button', { className: 'primary', textContent: 'Save', onclick: apply })),
  );
  input.focus();
}

// ---------- importing old entries ----------

async function startImport() {
  await save();
  const source = await invoke('choose_folder', { title: 'Choose the folder with your old entries' }).catch(() => null);
  if (!source) return;

  let plan;
  try {
    plan = await invoke('scan_import', { source });
  } catch (e) {
    setStatus(`Import: ${e}`);
    return;
  }

  if (plan.total === 0) {
    showDialog(
      el('h2', { textContent: 'Import old entries' }),
      el('p', { textContent: `No Markdown files were found in “${plan.folder}”.` }),
      el('div', { className: 'actions' }, el('button', { className: 'primary', textContent: 'Close', onclick: closeDialog })),
    );
    return;
  }

  const range = plan.first ? `, from ${shortDate(plan.first)} to ${shortDate(plan.last)}` : '';
  const useFileDates = el('input', { type: 'checkbox' });
  const importButton = el('button', { className: 'primary', textContent: `Import ${plan.dated} notes` });
  useFileDates.addEventListener('change', () => {
    const count = plan.dated + (useFileDates.checked ? plan.undated.length : 0);
    importButton.textContent = `Import ${count} notes`;
  });

  const undated = plan.undated.length
    ? [
        el('p', { textContent: `${plural(plan.undated.length, 'note')} with no date found:` }),
        listOf(plan.undated.map((n) => n.rel)),
        el('label', {}, useFileDates, 'Use each file’s creation date for these'),
      ]
    : [];

  importButton.addEventListener('click', async () => {
    importButton.disabled = true;
    importButton.textContent = 'Importing…';
    try {
      const report = await invoke('run_import', { source, useFileDates: useFileDates.checked });
      showReport(report);
    } catch (e) {
      importButton.disabled = false;
      importButton.textContent = 'Try again';
      setStatus(`Import failed: ${e}`);
    }
  });

  showDialog(
    el('h2', { textContent: 'Import old entries' }),
    el('p', { textContent: `Found ${plural(plan.total, 'note')} in “${plan.folder}”. ${plural(plan.dated, 'note')} ha${plan.dated === 1 ? 's' : 've'} a date${range}.` }),
    ...undated,
    el('p', { className: 'hint', textContent: 'Your old files are only read, never changed. If a day already has an entry, the imported text is added at the end. Importing the same folder twice won’t duplicate anything.' }),
    el('div', { className: 'actions' }, el('button', { className: 'link', textContent: 'Cancel', onclick: closeDialog }), importButton),
  );
}

function showReport(report) {
  const lines = [`Imported ${plural(report.notes, 'note')} into ${plural(report.days, 'day')}.`];
  if (report.attachments) lines.push(`${plural(report.attachments, 'attachment')} copied.`);
  if (report.duplicates) lines.push(`${plural(report.duplicates, 'note')} already in your diary, skipped.`);
  if (report.skipped) lines.push(`${plural(report.skipped, 'note')} left out (no date, or empty).`);

  const missing = report.missing.length
    ? [el('p', { textContent: 'These linked files couldn’t be found, so their links were left as they were:' }), listOf(report.missing)]
    : [];

  showDialog(
    el('h2', { textContent: 'Import finished' }),
    ...lines.map((text) => el('p', { textContent: text })),
    ...missing,
    el('div', { className: 'actions' }, el('button', { className: 'primary', textContent: 'Done', onclick: () => {
      closeDialog();
      renderCalendar();
      if (doc?.kind === 'entry') openEntry(doc.date);
    } })),
  );
}

// ---------- journal folder ----------

async function chooseFolder() {
  await save();
  const path = await invoke('choose_folder').catch(() => null);
  if (!path) return;
  try {
    if (journal) await commitNow();
    journal = await invoke('set_journal', { path });
    start();
  } catch (e) {
    $('welcome-error').textContent = String(e);
    setStatus(String(e));
  }
}

function toggleZen(force) {
  document.body.classList.toggle('zen', force);
  editor.focus();
}

function start() {
  $('welcome').hidden = true;
  $('app').hidden = false;
  $('journal-path').textContent = journal.replace(/^\/Users\/[^/]+/, '~');
  goToday();
}

// ---------- wiring ----------

editor.addEventListener('input', markDirty);
window.addEventListener('blur', save);

$('choose').addEventListener('click', chooseFolder);
$('journal-path').addEventListener('click', chooseFolder);
$('import-button').addEventListener('click', startImport);
$('weather-button').addEventListener('click', weatherSettings);
$('dialog').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    closeDialog();
  }
});
$('today').addEventListener('click', (e) => goToday(e.altKey));
$('prev').addEventListener('click', () => shiftMonth(-1));
$('next').addEventListener('click', () => shiftMonth(1));
$('month-title').addEventListener('click', () => {
  const now = new Date();
  view = { year: now.getFullYear(), month: now.getMonth() + 1 };
  renderCalendar();
});
$('zen').addEventListener('click', () => toggleZen(true));

$('add-template').addEventListener('click', () => {
  $('add-template').hidden = true;
  $('new-template').hidden = false;
  $('new-template').focus();
});
$('new-template').addEventListener('keydown', (e) => {
  const input = e.target;
  if (e.key === 'Enter') createTemplate(input.value);
  if (e.key === 'Enter' || e.key === 'Escape') {
    input.value = '';
    input.hidden = true;
    $('add-template').hidden = false;
  }
});

document.addEventListener('keydown', (e) => {
  if (!e.metaKey) {
    if (e.key === 'Escape' && document.body.classList.contains('zen')) toggleZen(false);
    return;
  }
  switch (e.code) {
    case 'Period': e.preventDefault(); toggleZen(); break;
    case 'KeyT': e.preventDefault(); if (journal) goToday(e.altKey); break;
    case 'Comma': e.preventDefault(); chooseFolder(); break;
    case 'KeyS': e.preventDefault(); save(); break;
  }
});

// The backend asks us to save before it makes the final commit and quits.
listen('app-quit', async () => {
  try {
    await save();
  } finally {
    await invoke('quit_app');
  }
});

(async () => {
  journal = await invoke('get_journal');
  if (journal) start();
  else $('welcome').hidden = false;
})();
