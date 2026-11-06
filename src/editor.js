'use strict';

// Diary's editor. Shows Markdown styled as you write (big headings, bold that
// looks bold) while the faded # and ** symbols stay in the text, so the file
// on disk is exactly what you typed. The text is the single source of truth:
// every edit is applied to it, then the affected lines are redrawn.

const Editor = (() => {
  const root = document.getElementById('editor');
  const rawEl = document.getElementById('raw-editor');

  let text = '';
  let raw = false;
  let rendered = [];
  let composing = false;
  let lastSel = [0, 0];
  let changed = () => {};
  let onFiles = () => {};
  let imageSrc = () => null;
  const history = { undo: [], redo: [], time: 0, kind: '' };

  // ---------- drawing ----------

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = (s) => esc(s).replace(/"/g, '&quot;');
  const md = (s) => `<span class="md">${esc(s)}</span>`;
  const IMAGE_LINE = /^\s*!\[[^\]]*\]\(<?([^)>\s]+)>?\)\s*$/;

  // **bold** __bold__ | ~~strike~~ | *italic* | `code` | [link](url) ![image](path) | #tag
  const INLINE = /(\*\*|__)(\S(?:.*?\S)?)\1|~~(\S(?:.*?\S)?)~~|\*(\S(?:.*?\S)?)\*|`([^`]+)`|(!?\[)([^\]]*)(\]\([^)]*\))|(^|[\s(])(#\p{L}[\p{L}\p{N}_\/-]*)/gu;

  function inline(s) {
    let out = '';
    let last = 0;
    for (const m of s.matchAll(INLINE)) {
      out += esc(s.slice(last, m.index));
      if (m[1]) out += md(m[1]) + `<strong>${esc(m[2])}</strong>` + md(m[1]);
      else if (m[3] !== undefined) out += md('~~') + `<del>${esc(m[3])}</del>` + md('~~');
      else if (m[4] !== undefined) out += md('*') + `<em>${esc(m[4])}</em>` + md('*');
      else if (m[5] !== undefined) out += md('`') + `<code>${esc(m[5])}</code>` + md('`');
      else if (m[6] !== undefined) out += md(m[6]) + `<span class="link">${esc(m[7])}</span>` + md(m[8]);
      else out += esc(m[9]) + `<span class="tag">${esc(m[10])}</span>`;
      last = m.index + m[0].length;
    }
    return out + esc(s.slice(last));
  }

  function lineHtml(line) {
    let cls = 'line';
    let body;
    let m;
    if ((m = /^(#{1,6})(\s+)(.*)$/.exec(line))) {
      cls += ` h${m[1].length}`;
      body = `<span class="md hmark">${esc(m[1] + m[2])}</span>` + inline(m[3]);
    } else if ((m = /^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/.exec(line))) {
      cls += ' li';
      body = esc(m[1]) + md(m[2] + m[3]) + inline(m[4]);
    } else if ((m = /^(>\s?)(.*)$/.exec(line))) {
      cls += ' quote';
      body = md(m[1]) + inline(m[2]);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      cls += ' rule';
      body = md(line);
    } else {
      body = inline(line);
    }
    // A line holding only a picture shows the picture beneath its link. The
    // image has no text, so it never becomes part of the file.
    const image = IMAGE_LINE.exec(line);
    const src = image && imageSrc(image[1]);
    if (src) {
      cls += ' has-image';
      body += `<img class="preview" contenteditable="false" draggable="false" alt="" src="${escAttr(src)}">`;
    }
    return `<div class="${cls}">${body || '<br>'}</div>`;
  }

  // Redraw only the lines that changed, unless lines were added or removed.
  function render(full = false) {
    if (raw) {
      if (rawEl.value !== text) rawEl.value = text;
      return;
    }
    const lines = text.split('\n');
    const kids = root.children;
    if (full || kids.length !== lines.length || root.childNodes.length !== lines.length) {
      root.innerHTML = lines.map(lineHtml).join('');
    } else {
      for (let i = 0; i < lines.length; i++) {
        if (rendered[i] !== lines[i] || kids[i].textContent !== lines[i]) kids[i].outerHTML = lineHtml(lines[i]);
      }
    }
    rendered = lines;
  }

  // ---------- positions: page <-> character offset in the text ----------

  function lineOf(node) {
    while (node && node.parentNode !== root) node = node.parentNode;
    return node;
  }

  function toOffset(node, off) {
    const kids = [...root.childNodes];
    if (!kids.length) return 0;
    let idx;
    let col;
    if (node === root) {
      idx = Math.min(off, kids.length - 1);
      col = off >= kids.length ? kids[idx].textContent.length : 0;
    } else {
      const line = lineOf(node);
      if (!line) return lastSel[0];
      idx = kids.indexOf(line);
      const range = document.createRange();
      range.setStart(line, 0);
      range.setEnd(node, off);
      col = range.toString().length;
    }
    let pos = 0;
    for (let i = 0; i < idx; i++) pos += kids[i].textContent.length + 1;
    return pos + col;
  }

  function fromOffset(pos) {
    const kids = root.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const len = kids[i].textContent.length;
      if (pos <= len || i === kids.length - 1) {
        let rest = Math.min(pos, len);
        const walker = document.createTreeWalker(kids[i], NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) {
          if (rest <= n.length) return [n, rest];
          rest -= n.length;
        }
        return [kids[i], 0];
      }
      pos -= len + 1;
    }
    return [root, 0];
  }
// Heading # marks are hidden except on the line being edited, so they can
// still be seen and changed there. They stay in the text either way.
let caretLine = null;

function markCaretLine(node) {
  if (node === undefined) {
    const sel = window.getSelection();
    node = sel.rangeCount && root.contains(sel.anchorNode) ? sel.anchorNode : null;
  }
  if (node && node.nodeType !== Node.ELEMENT_NODE) node = node.parentElement;
  const line = raw || !node ? null : lineOf(node);
  if (line === caretLine) return;
  caretLine?.classList.remove('caret-line');
  line?.classList.add('caret-line');
  caretLine = line;
}
  function selection() {
    if (raw) return [rawEl.selectionStart, rawEl.selectionEnd];
    const sel = window.getSelection();
    if (!sel.rangeCount || !root.contains(sel.anchorNode)) return lastSel;
    const r = sel.getRangeAt(0);
    const a = toOffset(r.startContainer, r.startOffset);
    const b = toOffset(r.endContainer, r.endOffset);
    return [Math.min(a, b), Math.max(a, b)];
  }

  function setSelection(a, b = a) {
    a = Math.max(0, Math.min(a, text.length));
    b = Math.max(0, Math.min(b, text.length));
    lastSel = [a, b];
    if (raw) {
      rawEl.setSelectionRange(a, b);
      return;
    }
    const [n1, o1] = fromOffset(a);
    const [n2, o2] = fromOffset(b);
    const el = n2.nodeType === Node.ELEMENT_NODE ? n2 : n2.parentElement;   // moved up
    markCaretLine(el);                                                      // new
    window.getSelection().setBaseAndExtent(n1, o1, n2, o2);
    lineOf(el)?.scrollIntoView({ block: 'nearest' });
  }

  // ---------- changing the text ----------

  // Typing is grouped into undo steps of about a word: a new step starts
  // after a pause, when switching between typing and deleting, or at the
  // first space after a word.
  function commit(next, a, b, kind = 'other', before = lastSel, insert = '') {
    if (next === text) {
      setSelection(a, b);
      return;
    }
    const now = Date.now();
    const typing = kind === 'type' || kind === 'delete';
    const space = /^\s+$/.test(insert);
    const wordEnded = kind === 'type' && space && !history.space;
    const merge = typing && history.kind === kind && now - history.time < 1000 && !wordEnded;
    if (!merge) {
      history.undo.push({ text, sel: before });
      if (history.undo.length > 500) history.undo.shift();
    }
    history.space = space;
    history.redo = [];
    history.time = now;
    history.kind = kind;
    text = next;
    render();
    setSelection(a, b);
    changed();
  }

  function edit(a, b, insert, kind, before) {
    const caret = a + insert.length;
    commit(text.slice(0, a) + insert + text.slice(b), caret, caret, kind, before, insert);
  }

  // ⌘Z can arrive from the menu bar and from the page for one key press;
  // only the first counts.
  let lastStep = 0;

  function step(from, to) {
    const now = Date.now();
    if (now - lastStep < 80) return;
    lastStep = now;
    const state = from.pop();
    if (!state) return;
    to.push({ text, sel: selection() });
    text = state.text;
    history.kind = '';
    render();
    setSelection(...state.sel);
    changed();
  }

  // Lines touched by the range a..b, as [start, end] offsets.
  function lineBounds(a, b) {
    const start = text.lastIndexOf('\n', a - 1) + 1;
    const end = text.indexOf('\n', b);
    return [start, end < 0 ? text.length : end];
  }

  const headingLevel = (line) => /^(#{1,6})\s/.exec(line)?.[1].length ?? 0;

  // Set the touched lines to this heading level, or back to plain text if
  // they already are.
  function heading(level) {
    const before = selection();
    const [a, b] = before;
    const [start, end] = lineBounds(a, b);
    const lines = text.slice(start, end).split('\n');
    const filled = lines.filter((l) => l.trim());
    const already = filled.length > 0 && filled.every((l) => headingLevel(l) === level);
    const next = lines.map((l, i) => {
      if (!l.trim() && lines.length > 1) return l;
      const body = l.replace(/^#{1,6}\s+/, '');
      return already ? body : `${'#'.repeat(level)} ${body}`;
    });
    const block = next.join('\n');
    const firstDelta = next[0].length - lines[0].length;
    const totalDelta = block.length - (end - start);
    commit(
      text.slice(0, start) + block + text.slice(end),
      Math.max(start, a + firstDelta),
      Math.max(start, b + totalDelta),
      'format',
      before,
    );
  }

  // Wrap the selection in a marker such as ** or ~~, or unwrap it if it is
  // already wrapped. With nothing selected, insert a pair and type between.
  function wrap(marker) {
    const before = selection();
    let [a, b] = before;
    const n = marker.length;

    if (a >= n && text.slice(a - n, a) === marker && text.slice(b, b + n) === marker) {
      commit(text.slice(0, a - n) + text.slice(a, b) + text.slice(b + n), a - n, b - n, 'format', before);
      return;
    }
    if (a === b) {
      commit(text.slice(0, a) + marker + marker + text.slice(a), a + n, a + n, 'format', before);
      return;
    }

    // Keep spaces at the edges of the selection outside the markers.
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    const sel = text.slice(a, b);

    if (sel.length >= 2 * n && sel.startsWith(marker) && sel.endsWith(marker)) {
      const inner = sel.slice(n, -n);
      commit(text.slice(0, a) + inner + text.slice(b), a, a + inner.length, 'format', before);
      return;
    }

    // Markdown formatting can't span lines, so wrap each line separately.
    const wrapped = sel
      .split('\n')
      .map((l) => {
        const t = l.trim();
        if (!t) return l;
        const lead = l.slice(0, l.indexOf(t));
        return lead + marker + t + marker + l.slice(lead.length + t.length);
      })
      .join('\n');
    commit(text.slice(0, a) + wrapped + text.slice(b), a + n, a + wrapped.length - n, 'format', before);
  }

  // ---------- lists ----------

  const INDENT = '    '; // four spaces: what Markdown expects for nested numbered lists
  const LIST = /^(\s*)([-*+]|(\d+)[.)])(\s+)/;

  // Apply fn to every line the selection touches, keeping the selection on
  // the same text afterwards.
  function changeLines(fn) {
    const before = selection();
    const [a, b] = before;
    const [start, end] = lineBounds(a, b);
    const lines = text.slice(start, end).split('\n');
    const next = fn(lines);
    const block = next.join('\n');
    const firstDelta = next[0].length - lines[0].length;
    const totalDelta = block.length - (end - start);
    commit(
      text.slice(0, start) + block + text.slice(end),
      Math.max(start, a + firstDelta),
      Math.max(start, b + totalDelta),
      'format',
      before,
    );
  }

  const isBullet = (l) => /^\s*[-*+]\s/.test(l);
  const isNumbered = (l) => /^\s*\d+[.)]\s/.test(l);

  // Turn the lines into a bulleted or numbered list, or back to plain text
  // if they already are one.
  function list(kind) {
    changeLines((lines) => {
      const filled = lines.filter((l) => l.trim());
      const test = kind === 'bullet' ? isBullet : isNumbered;
      const already = filled.length > 0 && filled.every(test);
      let n = 0;
      return lines.map((l) => {
        if (!l.trim() && lines.length > 1) return l;
        const m = LIST.exec(l);
        const indent = m ? m[1] : /^\s*/.exec(l)[0];
        const body = m ? l.slice(m[0].length) : l.slice(indent.length);
        if (already) return indent + body;
        n += 1;
        return `${indent}${kind === 'bullet' ? '-' : `${n}.`} ${body}`;
      });
    });
  }

  // Indent or outdent list items. Plain paragraphs aren't indented, because
  // four leading spaces would turn them into a code block in Markdown.
  function indent(direction) {
    changeLines((lines) =>
      lines.map((l) => {
        if (!LIST.test(l)) return l;
        if (direction > 0) return INDENT + l;
        return l.replace(/^( {1,4}|\t)/, '');
      }),
    );
  }

  // Return in a list continues it; Return on an empty item ends the list
  // (or steps out one level if it's indented). Returns false if the caret
  // isn't in a list, so a plain new line is inserted instead.
  function continueList(before) {
    const [a, b] = before;
    const start = text.lastIndexOf('\n', a - 1) + 1;
    const line = text.slice(start, text.indexOf('\n', a) < 0 ? text.length : text.indexOf('\n', a));
    const m = LIST.exec(line);
    if (!m || a - start < m[0].length) return false;

    if (!line.slice(m[0].length).trim()) {
      const out = m[1] ? line.replace(/^( {1,4}|\t)/, '') : '';
      const end = start + line.length;
      commit(text.slice(0, start) + out + text.slice(end), start + out.length, start + out.length, 'other', before);
      return true;
    }

    const marker = m[3] ? `${Number(m[3]) + 1}${m[2].slice(-1)}` : m[2];
    edit(a, b, `\n${m[1]}${marker}${m[4]}`, 'other', before);
    return true;
  }

  // ---------- styled view input ----------

  const FORMAT_MARKERS = { formatBold: '**', formatItalic: '*', formatStrikeThrough: '~~' };

  function targetRange(e, sel) {
    const r = e.getTargetRanges?.()[0];
    if (!r) return sel;
    const a = toOffset(r.startContainer, r.startOffset);
    const b = toOffset(r.endContainer, r.endOffset);
    return [Math.min(a, b), Math.max(a, b)];
  }

  const filesIn = (data) => [...(data?.files ?? [])];

  root.addEventListener('beforeinput', (e) => {
    const t = e.inputType;
    if (e.isComposing || t === 'insertCompositionText' || t === 'deleteCompositionText') return;

    if (t === 'historyUndo' || t === 'historyRedo') {
      e.preventDefault();
      t === 'historyUndo' ? api.undo() : api.redo();
      return;
    }
    if (t.startsWith('format')) {
      e.preventDefault();
      if (FORMAT_MARKERS[t]) wrap(FORMAT_MARKERS[t]);
      return;
    }
    // Pictures inserted by macOS itself, e.g. Import from iPhone.
    const files = filesIn(e.dataTransfer);
    if (files.length) {
      e.preventDefault();
      onFiles(files);
      return;
    }

    let insert;
    if (t === 'insertText' || t === 'insertReplacementText') {
      insert = e.data ?? e.dataTransfer?.getData('text/plain') ?? '';
    } else if (t === 'insertParagraph' || t === 'insertLineBreak') {
      insert = '\n';
      e.preventDefault();
      const before = selection();
      if (continueList(before)) return;
      const [a, b] = targetRange(e, before);
      edit(a, b, insert, 'other', before);
      return;
    } else if (t.startsWith('delete')) {
      insert = '';
    } else {
      return; // anything unusual happens natively, then resync() catches up
    }

    e.preventDefault();
    const before = selection();
    const [a, b] = targetRange(e, before);
    if (insert === '' && a === b) return;
    const kind = t === 'insertText' ? 'type' : t.startsWith('delete') ? 'delete' : 'other';
    edit(a, b, insert, kind, before);
  });

  // Paste plain text only, so the file stays plain Markdown. Pasted pictures
  // are saved as attachments instead.
  root.addEventListener('paste', (e) => {
    e.preventDefault();
    const files = filesIn(e.clipboardData);
    if (files.length) {
      onFiles(files);
      return;
    }
    const s = e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
    const sel = selection();
    edit(sel[0], sel[1], s, 'other', sel);
  });
  root.addEventListener('copy', (e) => {
    const [a, b] = selection();
    if (a === b) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', text.slice(a, b));
  });
  root.addEventListener('cut', (e) => {
    const sel = selection();
    const [a, b] = sel;
    if (a === b) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', text.slice(a, b));
    edit(a, b, '', 'other', sel);
  });
  root.addEventListener('dragstart', (e) => e.preventDefault());

  // Tab and ⇧Tab indent and outdent list items.
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.metaKey || e.altKey || e.ctrlKey) return;
    const [a, b] = selection();
    const [start, end] = lineBounds(a, b);
    if (!text.slice(start, end).split('\n').some((l) => LIST.test(l))) return;
    e.preventDefault();
    indent(e.shiftKey ? -1 : 1);
  });

  // If macOS slipped a picture straight into the page, save it properly and
  // take it out of the page again.
  function adoptImages() {
    for (const img of root.querySelectorAll('img:not(.preview)')) {
      const src = img.src;
      img.remove();
      fetch(src)
        .then((r) => r.blob())
        .then((blob) => onFiles([new File([blob], 'photo', { type: blob.type })]))
        .catch(() => {});
    }
  }

  // Accents, dictation and other composed input are let through natively;
  // afterwards the text is read back from the page.
  function resync() {
    adoptImages();
    const before = lastSel;
    const sel = window.getSelection();
    let a = 0;
    let b = 0;
    if (sel.rangeCount) {
      const r = sel.getRangeAt(0);
      a = toOffset(r.startContainer, r.startOffset);
      b = toOffset(r.endContainer, r.endOffset);
    }
    const next = [...root.childNodes].map((n) => n.textContent).join('\n').replace(/\u00a0/g, ' ');
    if (next !== text) commit(next, a, b, 'type', before);
    else if (root.childNodes.length !== text.split('\n').length) render(true);
  }

  root.addEventListener('compositionstart', () => { composing = true; });
  root.addEventListener('compositionend', () => {
    composing = false;
    resync();
  });
  root.addEventListener('input', () => {
    if (!composing) resync();
  });

  document.addEventListener('selectionchange', () => {
    if (raw || composing) return;
    const sel = window.getSelection();
    if (sel.rangeCount && root.contains(sel.anchorNode)) lastSel = selection();
    markCaretLine();
  });

  // ---------- raw view input ----------

  let rawBefore = [0, 0];
  rawEl.addEventListener('beforeinput', (e) => {
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
      e.preventDefault();
      e.inputType === 'historyUndo' ? api.undo() : api.redo();
      return;
    }
    rawBefore = [rawEl.selectionStart, rawEl.selectionEnd];
  });
  rawEl.addEventListener('input', (e) => {
    const kind = e.inputType === 'insertText' ? 'type' : e.inputType?.startsWith('delete') ? 'delete' : 'other';
    commit(rawEl.value, rawEl.selectionStart, rawEl.selectionEnd, kind, rawBefore);
  });

  // ---------- spelling ----------

  // Misspelled words are drawn with the CSS Highlight API, which paints over
  // the text without touching the page. Its ranges are live: lines that
  // aren't redrawn keep their marks, and redrawn lines lose them until the
  // next check.
  const spelling = window.Highlight && CSS.highlights ? new Highlight() : null;
  if (spelling) CSS.highlights.set('spelling', spelling);
  let misspelled = []; // [start, end, word]

  function markSpelling(ranges) {
    misspelled = ranges;
    if (!spelling) return;
    spelling.clear();
    if (raw) return;
    for (const [a, b] of ranges) {
      const range = document.createRange();
      range.setStart(...fromOffset(a));
      range.setEnd(...fromOffset(b));
      spelling.add(range);
    }
  }

  function misspellingAt(x, y) {
    const r = document.caretRangeFromPoint?.(x, y);
    if (!r || !root.contains(r.startContainer)) return null;
    const pos = toOffset(r.startContainer, r.startOffset);
    return misspelled.find(([a, b, word]) => pos >= a && pos <= b && text.slice(a, b) === word) ?? null;
  }

  // ---------- public ----------

  const api = {
    get value() {
      return text;
    },
    get raw() {
      return raw;
    },
    get caret() {
      return selection()[1];
    },
    set onChange(fn) {
      changed = fn;
    },
    set onFiles(fn) {
      onFiles = fn;
    },
    set imageSrc(fn) {
      imageSrc = fn;
    },
    // Move the caret to a point on screen, e.g. where something was dropped.
    placeCaretAt(x, y) {
      const r = document.caretRangeFromPoint?.(x, y);
      if (raw || !r || !root.contains(r.startContainer)) return;
      const pos = toOffset(r.startContainer, r.startOffset);
      setSelection(pos, pos);
    },
    // Is the caret at the start of a line?
    get atLineStart() {
      const a = selection()[0];
      return a === 0 || text[a - 1] === '\n';
    },
    load(next) {
      text = next;
      history.undo = [];
      history.redo = [];
      history.kind = '';
      misspelled = [];
      spelling?.clear();
      render(true);
      lastSel = [text.length, text.length];
      api.focus();
    },
    insert(s) {
      const sel = selection();
      edit(sel[0], sel[1], s, 'other', sel);
    },
    replace(a, b, s) {
      edit(a, b, s, 'other', selection());
    },
    focus() {
      (raw ? rawEl : root).focus({ preventScroll: true });
      setSelection(...lastSel);
    },
    setRaw(on) {
      const sel = selection();
      raw = on;
      root.hidden = on;
      rawEl.hidden = !on;
      render(true);
      spelling?.clear();
      lastSel = sel;
      api.focus();
    },
    undo: () => step(history.undo, history.redo),
    redo: () => step(history.redo, history.undo),
    heading,
    wrap,
    list,
    indent,
    markSpelling,
    misspellingAt,
  };

  return api;
})();
