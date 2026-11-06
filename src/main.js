'use strict';

// Diary frontend. All file and Git work is done by the Rust backend, and
// editing by editor.js; this file handles the calendar, templates and timing.

const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  day: '# {{weekday}}, {{date}}\n\n## {{time}}\n\n',
  entry: '## {{time}}\n\n',
};
const SAVE_DELAY = 1200;            // autosave after typing pauses
const COMMIT_DELAY = 2 * 60 * 1000; // Git snapshot after two quiet minutes
const EMPTY_SESSION = /(^|\n)## \d{1,2}:\d{2}\s*$/;
const IMAGE = /\.(png|jpe?g|gif|webp|heic|tiff?)$/i;

let journal = null;
let doc = null; // { kind: 'entry', date, onDisk } or { kind: 'template', name }
let dirty = false;
let saveTimer = null;
let commitTimer = null;
let view = { year: 0, month: 0 };

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
// A line using {{weather}} or {{moon}} is left out when neither has a value
// (a past day, no place set, or no connection).
const BASIC = /\{\{\s*(date|weekday|time|year|month)\s*\}\}/g;
const EXTRA = /\{\{\s*(weather|moon)\s*\}\}/g;

function fillTemplate(text, date, extras = {}) {
  const values = {
    date: longDate(date),
    weekday: weekday(date),
    time: clock(),
    year: String(date.getFullYear()),
    month: date.toLocaleDateString('en-GB', { month: 'long' }),
  };
  const basics = (line) => line.replace(BASIC, (_, key) => values[key]);
  let dropped = false;
  const out = text
    .split('\n')
    .flatMap((line) => {
      if (!line.match(EXTRA)) return [basics(line)];
      let filled = false;
      const done = line.replace(EXTRA, (_, key) => {
        if (extras[key]) filled = true;
        return extras[key] ?? '';
      });
      if (!filled) dropped = true;
      return filled ? [basics(done).replace(/^[\s·|,]+|[\s·|,]+$/g, '')] : [];
    })
    .join('\n');
  return dropped ? out.replace(/\n{3,}/g, '\n\n') : out;
}

// Weather and moon phase for today's new entry, fetched once per session.
// The request itself is cached, so clicking Today twice doesn't ask twice.
const extrasCache = new Map();

async function dayExtras(date, template) {
  if (!template.match(EXTRA) || date !== isoDate(new Date())) return {};
  if (!extrasCache.has(date)) {
    setStatus('Fetching weather…');
    extrasCache.set(date, invoke('day_extras', { date }).catch(() => ({})));
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
  Editor.load(text);
  $('doc-title').textContent = title;
  scheduleSpelling();
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
  if (!journal) return;
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
  scheduleSpelling();
}

// ---------- spelling ----------

// Link addresses, inline code, URLs and #tags aren't prose, so aren't checked.
const NOT_PROSE = /\]\([^)]*\)|`[^`]*`|https?:\/\/\S+|#\p{L}[\p{L}\p{N}_\/-]*/gu;
const ignoredWords = new Set();
let spellTimer = null;

function scheduleSpelling() {
  clearTimeout(spellTimer);
  spellTimer = setTimeout(checkSpelling, 500);
}

async function checkSpelling() {
  if (Editor.raw) return;
  const text = Editor.value;
  const found = await invoke('check_spelling', { text }).catch(() => []);
  if (Editor.value !== text) return; // typing carried on; another check is coming
  const skip = [...text.matchAll(NOT_PROSE)].map((m) => [m.index, m.index + m[0].length]);
  const caret = Editor.caret;
  const ranges = found
    .map(([start, length]) => [start, start + length, text.slice(start, start + length)])
    .filter(([a, b, word]) =>
      !ignoredWords.has(word.toLowerCase())
      && !skip.some(([x, y]) => a < y && b > x)
      && b !== caret); // the word still being typed
  Editor.markSpelling(ranges);
}

function closeSpellMenu() {
  $('spell-menu').hidden = true;
}

async function openSpellMenu(e) {
  const hit = Editor.misspellingAt(e.clientX, e.clientY);
  if (!hit) return; // not a marked word: the normal menu appears
  e.preventDefault();
  const [a, b, word] = hit;
  const guesses = await invoke('spelling_guesses', { word }).catch(() => []);

  const item = (label, action, className = '') =>
    el('button', { textContent: label, className, onclick: () => { closeSpellMenu(); action(); } });

  const menu = $('spell-menu');
  menu.replaceChildren(
    ...(guesses.length
      ? guesses.map((g) => item(g, () => Editor.replace(a, b, g), 'guess'))
      : [el('span', { className: 'none', textContent: 'No suggestions' })]),
    el('hr'),
    item('Learn Spelling', async () => {
      await invoke('learn_word', { word });
      checkSpelling();
    }),
    item('Ignore', () => {
      ignoredWords.add(word.toLowerCase());
      checkSpelling();
    }),
  );
  menu.hidden = false;
  const { innerWidth: w, innerHeight: h } = window;
  menu.style.left = `${Math.min(e.clientX, w - menu.offsetWidth - 8)}px`;
  menu.style.top = `${Math.min(e.clientY, h - menu.offsetHeight - 8)}px`;
}

async function save() {
  clearTimeout(saveTimer);
  if (!dirty || !doc) return;
  dirty = false;
  const target = doc;
  const content = Editor.value;
  try {
    if (target.kind === 'entry') {
      await invoke('write_entry', { date: target.date, content });
      updateTagsFor(target.date, content);
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

const EXTENSIONS = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif',
  'image/gif': 'gif', 'image/webp': 'webp', 'image/tiff': 'tiff', 'application/pdf': 'pdf',
};

// Pictures from Photos, the clipboard or an iPhone often arrive as
// "image.png" or with no name at all, so give them a dated, readable one.
function attachmentName(file) {
  if (file.name && !/^(image|photo|untitled)(\.\w+)?$/i.test(file.name)) return file.name;
  const ext = EXTENSIONS[file.type] ?? file.name.split('.').pop() ?? 'bin';
  return `photo-${clock().replace(':', '')}.${ext}`;
}

// Pictures in an entry show from the diary folder, e.g.
// ~/Diary/2026/2026-11/ + 2026-11-02/photo.jpg. Web links and paths that
// climb out of the folder are not shown.
Editor.imageSrc = (rel) => {
  if (doc?.kind !== 'entry' || !journal || /^[a-z]+:|^\/|(^|\/)\.\.(\/|$)/i.test(rel)) return null;
  const [y, m] = doc.date.split('-');
  let path = rel;
  try {
    path = decodeURI(rel);
  } catch {}
  return convertFileSrc(`${journal}/${y}/${y}-${m}/${path}`);
};

async function attachFiles(files) {
  if (doc?.kind !== 'entry') {
    setStatus('Open an entry to attach files');
    return;
  }
  const date = doc.date;
  const links = [];
  setStatus(files.length > 1 ? `Saving ${files.length} files…` : 'Saving…');
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const rel = await invoke('save_attachment_bytes', bytes, {
        headers: { 'x-date': date, 'x-name': encodeURIComponent(attachmentName(file)) },
      });
      const name = rel.split('/').pop();
      links.push(IMAGE.test(name) ? `![](${rel})` : `[${name}](${rel})`);
    } catch (e) {
      setStatus(`Could not attach: ${e}`);
    }
  }
  if (!links.length || doc?.date !== date) return;
  // Each attachment goes on a line of its own, so pictures show in full.
  const before = Editor.atLineStart ? '' : '\n';
  Editor.focus();
  Editor.insert(`${before}${links.join('\n')}\n`);
}

Editor.onFiles = attachFiles;

// Dropping files, or pictures from Photos, anywhere in the window.
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  Editor.placeCaretAt(e.clientX, e.clientY);
  const files = [...e.dataTransfer.files];
  if (files.length) {
    attachFiles(files);
    return;
  }
  const dropped = e.dataTransfer.getData('text/plain');
  if (dropped && doc) {
    Editor.focus();
    Editor.insert(dropped);
  }
});

// ---------- importing old entries ----------

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

function showImport(...children) {
  $('import-body').replaceChildren(...children);
  $('import-dialog').hidden = false;
  $('import-body').querySelector('.actions button:last-child')?.focus();
}

function closeImport() {
  $('import-dialog').hidden = true;
  Editor.focus();
}

async function startImport() {
  if (!journal) return;
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

  const templateNote = plan.templates
    ? [el('p', { className: 'hint', textContent: `${plural(plan.templates, 'template file')} left out.` })]
    : [];

  if (plan.total === 0) {
    showImport(
      el('h2', { textContent: 'Import old entries' }),
      el('p', { textContent: `No Markdown entries were found in “${plan.folder}”.` }),
      ...templateNote,
      el('div', { className: 'actions' }, el('button', { className: 'primary', textContent: 'Close', onclick: closeImport })),
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

  showImport(
    el('h2', { textContent: 'Import old entries' }),
    el('p', { textContent: `Found ${plural(plan.total, 'note')} in “${plan.folder}”. ${plural(plan.dated, 'note')} ha${plan.dated === 1 ? 's' : 've'} a date${range}.` }),
    ...undated,
    ...templateNote,
    el('p', { className: 'hint', textContent: 'Your old files are only read, never changed. If a day already has an entry, the imported text is added at the end. Importing the same folder twice won’t duplicate anything.' }),
    el('div', { className: 'actions' }, el('button', { className: 'link', textContent: 'Cancel', onclick: closeImport }), importButton),
  );
}

function showReport(report) {
  const lines = [`Imported ${plural(report.notes, 'note')} into ${plural(report.days, 'day')}.`];
  if (report.attachments) lines.push(`${plural(report.attachments, 'attachment')} copied.`);
  if (report.duplicates) lines.push(`${plural(report.duplicates, 'note')} already in your diary, skipped.`);
  if (report.skipped) lines.push(`${plural(report.skipped, 'note')} left out (no date, or empty).`);
  if (report.templates) lines.push(`${plural(report.templates, 'template file')} left out.`);

  const missing = report.missing.length
    ? [el('p', { textContent: 'These linked files couldn’t be found, so their links were left as they were:' }), listOf(report.missing)]
    : [];

  showImport(
    el('h2', { textContent: 'Import finished' }),
    ...lines.map((text) => el('p', { textContent: text })),
    ...missing,
    el('div', { className: 'actions' }, el('button', { className: 'primary', textContent: 'Done', onclick: () => {
      closeImport();
      renderCalendar();
      loadTags();
      if (doc?.kind === 'entry') openEntry(doc.date);
    } })),
  );
}

// ---------- tags ----------

// Same rule as the Rust side: # then a letter, at a line start or after a
// space or bracket.
const TAG = /(^|[\s(])#(\p{L}[\p{L}\p{N}_\/-]*)/gu;
const TAG_BEFORE_CARET = /(?:^|[\s(])#(\p{L}[\p{L}\p{N}_\/-]*)$/u;

let tags = new Map(); // lower-case name -> { name, dates: Set of YYYY-MM-DD }
let openTag = null;
let suggest = { items: [], index: 0, start: 0, end: 0 };

function tagsIn(text) {
  const found = new Map();
  for (const m of text.matchAll(TAG)) {
    const name = m[2].replace(/[-/]+$/, '');
    found.set(name.toLowerCase(), name);
  }
  return found;
}

async function loadTags() {
  const list = await invoke('all_tags').catch(() => []);
  tags = new Map(list.map((t) => [t.name.toLowerCase(), { name: t.name, dates: new Set(t.dates) }]));
  renderTags();
}

// After saving an entry, update the tag list from that entry alone.
function updateTagsFor(date, text) {
  for (const t of tags.values()) t.dates.delete(date);
  for (const [key, name] of tagsIn(text)) {
    if (!tags.has(key)) tags.set(key, { name, dates: new Set() });
    tags.get(key).dates.add(date);
  }
  for (const [key, t] of tags) if (!t.dates.size) tags.delete(key);
  renderTags();
}

const byUse = (a, b) => b.dates.size - a.dates.size || a.name.localeCompare(b.name);

function renderTags() {
  const section = $('tags-section');
  section.hidden = settings.hide_tags || tags.size === 0;
  if (section.hidden) return;

  const list = $('tag-list');
  list.replaceChildren();
  for (const t of [...tags.values()].sort(byUse)) {
    const key = t.name.toLowerCase();
    const button = el('button', { className: 'tag-name', title: 'Show entries with this tag' },
      el('span', { textContent: `#${t.name}` }),
      el('span', { className: 'count', textContent: String(t.dates.size) }));
    button.classList.toggle('selected', openTag === key);
    button.addEventListener('click', () => {
      openTag = openTag === key ? null : key;
      renderTags();
    });
    const item = el('li', {}, button);

    if (openTag === key) {
      const dates = el('ul', { className: 'tag-dates' });
      for (const date of [...t.dates].sort().reverse()) {
        const d = parseIso(date);
        const label = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
        const open = el('button', { textContent: label });
        open.classList.toggle('selected', doc?.kind === 'entry' && doc.date === date);
        open.addEventListener('click', () => openEntry(date));
        dates.append(el('li', {}, open));
      }
      item.append(dates);
    }
    list.append(item);
  }
}

// ---------- tag suggestions while typing ----------

function hideSuggest() {
  $('tag-suggest').hidden = true;
  suggest.items = [];
}

function caretRect() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const rect = range.getClientRects()[0];
  if (rect) return rect;
  const node = range.startContainer;
  return (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.getBoundingClientRect() ?? null;
}

function updateSuggestions() {
  if (Editor.raw || doc?.kind !== 'entry') return hideSuggest();
  const caret = Editor.caret;
  const m = TAG_BEFORE_CARET.exec(Editor.value.slice(Math.max(0, caret - 80), caret));
  if (!m) return hideSuggest();

  const typed = m[1].toLowerCase();
  const items = [...tags.values()]
    .filter((t) => {
      const name = t.name.toLowerCase();
      // Skip the half-typed tag itself if it was saved mid-word.
      const onlyHere = t.dates.size === 1 && t.dates.has(doc.date);
      return name.startsWith(typed) && name !== typed && !onlyHere;
    })
    .sort(byUse)
    .slice(0, 6);
  if (!items.length) return hideSuggest();

  suggest = { items, index: 0, start: caret - m[1].length, end: caret };
  drawSuggest();
  const rect = caretRect();
  const box = $('tag-suggest');
  if (rect) {
    box.style.left = `${Math.min(rect.left, window.innerWidth - box.offsetWidth - 8)}px`;
    const below = rect.bottom + 4;
    box.style.top = `${below + box.offsetHeight > window.innerHeight ? rect.top - box.offsetHeight - 4 : below}px`;
  }
}

function drawSuggest() {
  const box = $('tag-suggest');
  box.replaceChildren(...suggest.items.map((t, i) => {
    const option = el('button', { role: 'option' },
      el('span', { textContent: `#${t.name}` }),
      el('span', { className: 'count', textContent: String(t.dates.size) }));
    option.classList.toggle('on', i === suggest.index);
    option.setAttribute('aria-selected', i === suggest.index);
    option.addEventListener('mousedown', (e) => {
      e.preventDefault();
      suggest.index = i;
      acceptSuggestion();
    });
    return option;
  }));
  box.hidden = false;
}

function acceptSuggestion() {
  const t = suggest.items[suggest.index];
  if (!t) return;
  const { start, end } = suggest;
  hideSuggest();
  Editor.replace(start, end, `${t.name} `);
}

// While suggestions show, ↑ ↓ choose, Return or Tab accept, Esc closes.
$('editor').addEventListener('keydown', (e) => {
  if ($('tag-suggest').hidden) return;
  const handled = () => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    handled();
    const n = suggest.items.length;
    suggest.index = (suggest.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    drawSuggest();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    handled();
    acceptSuggestion();
  } else if (e.key === 'Escape') {
    handled();
    hideSuggest();
  }
}, true);

$('editor').addEventListener('blur', hideSuggest);
$('editor').addEventListener('scroll', hideSuggest);
$('editor').addEventListener('mousedown', hideSuggest);

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

// ---------- settings ----------

const tilde = (path) => path.replace(/^\/Users\/[^/]+/, '~');
let settings = {
  appearance: '',
  accent: '',
  reminder: false,
  reminder_time: '21:00',
  reminder_message: '',
  hide_tags: false,
  weather_location: '',
};

function applyAccent(accent) {
  if (accent) document.documentElement.dataset.accent = accent;
  else delete document.documentElement.dataset.accent;
}

function showSettingsState() {
  $('settings-path').textContent = journal ? tilde(journal) : 'No folder chosen';
  for (const b of document.querySelectorAll('[data-appearance]')) {
    const on = b.dataset.appearance === settings.appearance;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on);
  }
  for (const b of document.querySelectorAll('.swatch')) {
    const on = b.dataset.accent === settings.accent;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on);
  }
  $('reminder-on').checked = settings.reminder;
  $('reminder-time').value = settings.reminder_time;
  $('reminder-message').value = settings.reminder_message;
  $('tags-on').checked = !settings.hide_tags;
  $('weather-location').value = settings.weather_location ?? '';
}

function reminderStatus(text, error = false) {
  const p = $('reminder-status');
  p.textContent = text;
  p.classList.toggle('error', error);
  p.hidden = !text;
}

async function saveReminder() {
  settings.reminder = $('reminder-on').checked;
  settings.reminder_time = $('reminder-time').value || '21:00';
  settings.reminder_message = $('reminder-message').value;
  try {
    await invoke('set_reminder', {
      enabled: settings.reminder,
      time: settings.reminder_time,
      message: settings.reminder_message,
    });
    reminderStatus(settings.reminder ? `Reminder set for ${settings.reminder_time} on days with no entry.` : 'Reminder off.');
  } catch (e) {
    reminderStatus(String(e), true);
  }
}

$('reminder-on').addEventListener('change', saveReminder);
$('reminder-time').addEventListener('change', saveReminder);
$('reminder-message').addEventListener('change', saveReminder);
$('reminder-test').addEventListener('click', async () => {
  try {
    await invoke('test_reminder', { message: $('reminder-message').value });
    reminderStatus('Test sent. If nothing appeared, check System Settings → Notifications → Diary.');
  } catch (e) {
    reminderStatus(String(e), true);
  }
});

$('tags-on').addEventListener('change', async () => {
  settings.hide_tags = !$('tags-on').checked;
  renderTags();
  await invoke('set_hide_tags', { hide: settings.hide_tags }).catch((e) => setStatus(String(e)));
});

$('weather-location').addEventListener('change', async () => {
  const status = $('weather-status');
  try {
    await invoke('set_weather_location', { location: $('weather-location').value });
    settings.weather_location = $('weather-location').value.trim();
    extrasCache.clear();
    status.hidden = true;
  } catch (e) {
    status.textContent = String(e);
    status.classList.add('error');
    status.hidden = false;
  }
});

async function openSettings() {
  await save();
  $('move-status').hidden = true;
  reminderStatus('');
  showSettingsState();
  $('settings').hidden = false;
  $('settings-done').focus();
}

function closeSettings() {
  $('settings').hidden = true;
  Editor.focus();
}

function moveStatus(message, { error = false, actions = [] } = {}) {
  const box = $('move-status');
  box.className = error ? 'error' : '';
  box.replaceChildren(el('p', { textContent: message }), ...(actions.length ? [el('div', { className: 'buttons' }, ...actions)] : []));
  box.hidden = false;
}

async function moveFolder(allowCloud = false, chosen = null) {
  await save();
  const destination = chosen ?? await invoke('choose_folder', { title: 'Choose where to move your diary' }).catch(() => null);
  if (!destination) return;

  const buttons = [$('move-folder'), $('other-folder')];
  buttons.forEach((b) => { b.disabled = true; });
  moveStatus('Copying and checking your diary…');
  try {
    clearTimeout(commitTimer);
    journal = await invoke('move_journal', { destination, allowCloud });
    $('journal-path').textContent = tilde(journal);
    showSettingsState();
    moveStatus(`Moved to ${tilde(journal)}. The old folder is still in its original place; delete it once you're happy everything is here.`, {
      actions: [el('button', { className: 'secondary', textContent: 'Show Old Folder', onclick: () => invoke('reveal_previous') })],
    });
    if (doc?.kind === 'entry') openEntry(doc.date);
    renderCalendar();
    loadTags();
  } catch (e) {
    if (String(e) === 'CLOUD') {
      moveStatus('That folder syncs to an online service, so your diary would be copied onto someone else’s servers. Move it there anyway?', {
        actions: [
          el('button', { className: 'link', textContent: 'Cancel', onclick: () => { $('move-status').hidden = true; } }),
          el('button', { className: 'secondary', textContent: 'Move Anyway', onclick: () => moveFolder(true, destination) }),
        ],
      });
    } else {
      moveStatus(String(e), { error: true });
    }
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

for (const b of document.querySelectorAll('[data-appearance]')) {
  b.addEventListener('click', async () => {
    settings.appearance = b.dataset.appearance;
    showSettingsState();
    await invoke('set_appearance', { appearance: settings.appearance }).catch((e) => setStatus(String(e)));
  });
}

for (const b of document.querySelectorAll('.swatch')) {
  b.addEventListener('click', async () => {
    settings.accent = b.dataset.accent;
    applyAccent(settings.accent);
    showSettingsState();
    await invoke('set_accent', { accent: settings.accent }).catch((e) => setStatus(String(e)));
  });
}

$('move-folder').addEventListener('click', () => moveFolder());
$('other-folder').addEventListener('click', async () => {
  await chooseFolder();
  showSettingsState();
});
$('settings-done').addEventListener('click', closeSettings);
$('settings').addEventListener('click', (e) => { if (e.target === $('settings')) closeSettings(); });
$('settings').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    closeSettings();
  }
});

// ---------- zen ----------

let zenHint = null;

function toggleZen(force) {
  const on = document.body.classList.toggle('zen', force);
  if (!on) document.body.classList.remove('zen-awake');
  Editor.focus();
}

function toggleRaw() {
  Editor.setRaw(!Editor.raw);
  $('raw').classList.toggle('on', Editor.raw);
  if (!Editor.raw) scheduleSpelling();
}

// Formatting commands, shared by the toolbar and the Format menu.
const COMMANDS = {
  h1: () => Editor.heading(1),
  h2: () => Editor.heading(2),
  h3: () => Editor.heading(3),
  bold: () => Editor.wrap('**'),
  italic: () => Editor.wrap('*'),
  strike: () => Editor.wrap('~~'),
  bullets: () => Editor.list('bullet'),
  numbers: () => Editor.list('number'),
  indent: () => Editor.indent(1),
  outdent: () => Editor.indent(-1),
  undo: () => Editor.undo(),
  redo: () => Editor.redo(),
};

// In Zen mode, moving the mouse briefly shows the Exit Zen button.
document.addEventListener('mousemove', () => {
  if (!document.body.classList.contains('zen')) return;
  document.body.classList.add('zen-awake');
  clearTimeout(zenHint);
  zenHint = setTimeout(() => document.body.classList.remove('zen-awake'), 2000);
});

function start() {
  $('welcome').hidden = true;
  $('app').hidden = false;
  $('journal-path').textContent = tilde(journal);
  // Draw this month straight away; today's entry may wait a moment for the weather.
  const now = new Date();
  view = { year: now.getFullYear(), month: now.getMonth() + 1 };
  renderCalendar();
  goToday();
  loadTags();
}

// ---------- wiring ----------

Editor.onChange = () => {
  markDirty();
  updateSuggestions();
};
window.addEventListener('blur', save);

// Toolbar buttons act on the text without taking focus from it.
for (const button of document.querySelectorAll('#toolbar [data-cmd]')) {
  button.addEventListener('mousedown', (e) => e.preventDefault());
  button.addEventListener('click', () => COMMANDS[button.dataset.cmd]());
}
$('raw').addEventListener('mousedown', (e) => e.preventDefault());
$('raw').addEventListener('click', toggleRaw);

$('editor').addEventListener('contextmenu', openSpellMenu);
document.addEventListener('mousedown', (e) => {
  if (!$('spell-menu').contains(e.target)) closeSpellMenu();
});
$('editor').addEventListener('scroll', closeSpellMenu);

$('choose').addEventListener('click', chooseFolder);
$('journal-path').addEventListener('click', openSettings);
$('import-button').addEventListener('click', startImport);
$('import-dialog').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    closeImport();
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
$('zen-exit').addEventListener('click', () => toggleZen(false));

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

// All ⌘ shortcuts live in the menu bar (see main.rs); only keys macOS
// doesn't claim are handled here.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('spell-menu').hidden) {
    e.preventDefault();
    closeSpellMenu();
  } else if (e.key === 'Escape' && document.body.classList.contains('zen')) {
    e.preventDefault();
    toggleZen(false);
  } else if (e.metaKey && e.code === 'KeyS') {
    e.preventDefault();
    save();
  } else if (e.metaKey && e.code === 'KeyZ') {
    // Normally the menu bar takes ⌘Z first; this is a fallback, and a
    // double press within one keystroke is ignored by the editor.
    e.preventDefault();
    e.shiftKey ? Editor.redo() : Editor.undo();
  }
});

listen('menu', ({ payload }) => {
  if (COMMANDS[payload]) return COMMANDS[payload]();
  switch (payload) {
    case 'today': goToday(); break;
    case 'zen': toggleZen(); break;
    case 'raw': toggleRaw(); break;
    case 'import': startImport(); break;
    case 'settings': openSettings(); break;
    case 'folder': chooseFolder(); break;
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
  settings = await invoke('get_settings').catch(() => settings);
  applyAccent(settings.accent);
  journal = await invoke('get_journal');
  if (journal) start();
  else $('welcome').hidden = false;
})();
