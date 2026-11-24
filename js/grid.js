// Spreadsheet grid: one row per day, one column per time.
// A single input floats over the active cell. In "select" mode it is invisible and
// only catches keys and clipboard events; typing turns it into the cell editor.
'use strict';

function createGrid({ root, read, write, onActive, onUndo, onRedo, onNotice }) {
  const table = document.createElement('table');
  const thead = table.createTHead();
  const tbody = table.createTBody();
  const editor = document.createElement('input');
  editor.className = 'editor';
  editor.type = 'text';
  editor.inputMode = 'decimal';
  editor.enterKeyHint = 'next';
  editor.autocomplete = 'off';
  editor.spellcheck = false;
  root.append(table, editor);

  let sheet = null; // rows and columns of the current patient
  let anchor = { r: 0, c: 0 }; // the active cell
  let head = { r: 0, c: 0 }; // the far corner of the selection
  let mode = 'select'; // 'select' | 'type' (arrows leave the cell) | 'edit' (arrows move the caret)
  let editKey = null; // date and time being edited, fixed even if rows or columns move
  let cells = []; // cells[r][c] -> td
  let builtFor = '';

  const lastRow = () => sheet.rows - 1;
  const lastCol = () => sheet.times.length - 1;
  const rawAt = (r, c) => read().readings[sheet.key(r, c)] ?? '';

  // ---- rendering ----------------------------------------------------------

  function buildHeader(step) {
    thead.replaceChildren();
    const tr = thead.insertRow();
    const corner = document.createElement('th');
    corner.scope = 'col';
    corner.className = 'corner';
    corner.textContent = 'Tanggal';
    tr.append(corner);
    const standard = new Set(Model.standardTimes(step));
    sheet.times.forEach((time, c) => {
      const th = document.createElement('th');
      th.scope = 'col';
      th.dataset.c = c;
      th.append(time.endsWith(':00') ? time.slice(0, 2) : time);
      th.classList.toggle('extra', !standard.has(time));
      if (Model.isNextDay(time)) {
        const note = document.createElement('small');
        note.textContent = '+1 hari';
        th.append(note);
        th.title = 'Dini hari tanggal berikutnya';
      }
      tr.append(th);
    });
    table.style.minWidth = 120 + sheet.times.length * 62 + 'px';
  }

  function buildRows() {
    tbody.replaceChildren();
    cells = Array.from({ length: sheet.rows }, (_, r) => {
      const tr = tbody.insertRow();
      const th = document.createElement('th');
      th.scope = 'row';
      th.dataset.r = r;
      th.textContent = Model.formatDate(sheet.date(r), 'row');
      tr.append(th);
      return sheet.times.map((_, c) => {
        const td = tr.insertCell();
        td.dataset.r = r;
        td.dataset.c = c;
        return td;
      });
    });
  }

  function refresh() {
    const p = read();
    const keep = sheet && { anchor: sheet.key(anchor.r, anchor.c), head: sheet.key(head.r, head.c) };
    sheet = Model.sheet(p);
    const shape = [p.id, p.start, sheet.rows, p.step, ...sheet.times].join();
    if (shape !== builtFor) {
      buildHeader(p.step);
      buildRows();
      builtFor = shape;
      if (keep) {
        // Stay on the same date and time when rows or columns are added or removed.
        anchor = sheet.find(keep.anchor) ?? clamp(anchor);
        head = sheet.find(keep.head) ?? anchor;
      }
    }
    cells.forEach((row, r) =>
      row.forEach((td, c) => {
        const raw = rawAt(r, c);
        const t = Model.parseTemp(raw);
        const text = Model.display(raw);
        if (td.textContent !== text) td.textContent = text;
        td.classList.toggle('bad', t.kind === 'bad');
        td.classList.toggle('low', t.kind === 'ok' && t.low);
        td.classList.toggle('fever', t.kind === 'ok' && t.value >= Model.FEVER);
        td.title =
          t.kind === 'bad' ? `Tidak digambar: ${t.reason}` : t.low ? `Di bawah ${Model.FLOOR} °C, ditandai ▼ di kurva` : '';
      })
    );
    anchor = clamp(anchor);
    head = clamp(head);
    paint();
  }

  function clamp({ r, c }) {
    return { r: Math.max(0, Math.min(r, lastRow())), c: Math.max(0, Math.min(c, lastCol())) };
  }

  function range() {
    return {
      r0: Math.min(anchor.r, head.r), r1: Math.max(anchor.r, head.r),
      c0: Math.min(anchor.c, head.c), c1: Math.max(anchor.c, head.c),
    };
  }

  function paint() {
    const { r0, r1, c0, c1 } = range();
    cells.forEach((row, r) =>
      row.forEach((td, c) => {
        const inside = r >= r0 && r <= r1 && c >= c0 && c <= c1;
        td.classList.toggle('sel', inside);
        td.classList.toggle('active', r === anchor.r && c === anchor.c);
      })
    );
    [...thead.rows[0].cells].slice(1).forEach((th, c) => th.classList.toggle('on', c >= c0 && c <= c1));
    [...tbody.rows].forEach((tr, r) => tr.cells[0].classList.toggle('on', r >= r0 && r <= r1));
    placeEditor();
    onActive(sheet.key(anchor.r, anchor.c));
  }

  function placeEditor() {
    const td = cells[anchor.r]?.[anchor.c];
    if (!td || !sheet) return;
    const a = td.getBoundingClientRect();
    const b = root.getBoundingClientRect();
    editor.style.left = a.left - b.left - root.clientLeft + root.scrollLeft + 'px';
    editor.style.top = a.top - b.top - root.clientTop + root.scrollTop + 'px';
    editor.style.width = a.width + 'px';
    editor.style.height = a.height + 'px';
    const key = sheet.key(anchor.r, anchor.c);
    const shown = Model.display(read().readings[key]) || 'kosong';
    editor.setAttribute('aria-label', `Suhu ${Model.formatDate(Model.dateOf(key), 'full')} ${Model.timeOf(key)}, ${shown}`);
  }

  // ---- selection ----------------------------------------------------------

  function select(r, c, { extend = false, focus = true } = {}) {
    commit();
    const to = clamp({ r, c });
    head = to;
    if (!extend) anchor = to;
    paint();
    if (focus) editor.focus({ preventScroll: true });
    cells[to.r][to.c].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function selectRange(r0, c0, r1, c1) {
    commit();
    anchor = clamp({ r: r0, c: c0 });
    head = clamp({ r: r1, c: c1 });
    paint();
    editor.focus({ preventScroll: true });
  }

  // Select a date and time; does nothing if it has no cell.
  function selectKey(key, options) {
    commit();
    const at = sheet.find(key);
    if (at) select(at.r, at.c, options);
  }

  function atEnd() {
    return anchor.r === lastRow() && anchor.c === lastCol();
  }

  // Next / previous time, wrapping across days.
  function step(dir) {
    const cols = sheet.times.length;
    const i = anchor.r * cols + anchor.c + dir;
    if (i >= 0) select(Math.floor(i / cols), i % cols);
  }

  // ---- editing ------------------------------------------------------------

  function setMode(next) {
    mode = next;
    editor.classList.toggle('open', next !== 'select');
  }

  function startEdit(next, text) {
    setMode(next);
    editKey = sheet.key(anchor.r, anchor.c);
    if (text !== undefined) editor.value = text;
    cells[anchor.r][anchor.c].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function commit() {
    if (mode === 'select') return;
    const key = editKey;
    const value = editor.value;
    setMode('select');
    editor.value = '';
    write((p) => Model.put(p, key, value));
  }

  function cancel() {
    setMode('select');
    editor.value = '';
  }

  function clearRange() {
    const { r0, r1, c0, c1 } = range();
    write((p) => {
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) Model.put(p, sheet.key(r, c), '');
    });
  }

  // ---- keyboard -----------------------------------------------------------

  const ARROWS = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };

  editor.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key;

    if (key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) return step(-1);
      if (atEnd()) {
        commit();
        if (sheet.rows < Model.MAX_DAYS) write((p) => { p.dayCount++; });
      }
      return step(1);
    }
    if (key === 'Tab') {
      // Leaving past either end hands focus back to the page.
      if (e.shiftKey ? anchor.r === 0 && anchor.c === 0 : atEnd()) return commit();
      e.preventDefault();
      return step(e.shiftKey ? -1 : 1);
    }
    if (key === 'Escape') {
      if (mode !== 'select') cancel();
      else { head = { ...anchor }; paint(); }
      return;
    }
    if (ARROWS[key] && mode !== 'edit') {
      e.preventDefault();
      const [dr, dc] = ARROWS[key];
      const from = e.shiftKey ? head : anchor;
      const to = mod
        ? { r: dr ? (dr > 0 ? lastRow() : 0) : from.r, c: dc ? (dc > 0 ? lastCol() : 0) : from.c }
        : { r: from.r + dr, c: from.c + dc };
      return select(to.r, to.c, { extend: e.shiftKey });
    }
    if (mode !== 'select') return;

    if (key === 'F2') {
      e.preventDefault();
      return openForEdit();
    }
    if (key === 'Delete' || key === 'Backspace') {
      e.preventDefault();
      return clearRange();
    }
    if (key === 'Home' || key === 'End') {
      e.preventDefault();
      const c = key === 'Home' ? 0 : lastCol();
      const r = mod ? (key === 'Home' ? 0 : lastRow()) : (e.shiftKey ? head.r : anchor.r);
      return select(r, c, { extend: e.shiftKey });
    }
    if (mod && key.toLowerCase() === 'a') {
      e.preventDefault();
      return selectRange(0, 0, lastRow(), lastCol());
    }
    if (mod && key.toLowerCase() === 'z') {
      e.preventDefault();
      return e.shiftKey ? onRedo() : onUndo();
    }
    if (mod && key.toLowerCase() === 'y') {
      e.preventDefault();
      return onRedo();
    }
  });

  function openForEdit() {
    startEdit('edit', Model.display(rawAt(anchor.r, anchor.c)));
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }

  editor.addEventListener('input', () => {
    if (mode === 'select') startEdit('type');
  });

  editor.addEventListener('focus', () => root.classList.add('focused'));
  editor.addEventListener('blur', () => {
    commit();
    root.classList.remove('focused');
  });

  // ---- clipboard ----------------------------------------------------------

  function selectionAsTSV() {
    const { r0, r1, c0, c1 } = range();
    const lines = [];
    for (let r = r0; r <= r1; r++) {
      const line = [];
      for (let c = c0; c <= c1; c++) line.push(Model.display(rawAt(r, c)));
      lines.push(line.join('\t'));
    }
    return lines.join('\n');
  }

  function paste(text) {
    const rows = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map((l) => l.split('\t'));
    const { r0, r1, c0, c1 } = range();
    let dropped = 0;

    if (rows.length === 1 && rows[0].length === 1) {
      write((p) => {
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) Model.put(p, sheet.key(r, c), rows[0][0]);
      });
      return;
    }

    write((p) => {
      rows.forEach((row, i) => {
        const r = r0 + i;
        if (r >= p.dayCount && r < Model.MAX_DAYS) p.dayCount = r + 1;
        row.forEach((raw, j) => {
          const c = c0 + j;
          if (r < p.dayCount && c <= lastCol()) Model.put(p, sheet.key(r, c), raw);
          else if (raw.trim()) dropped++;
        });
      });
    });
    const width = Math.max(...rows.map((row) => row.length));
    anchor = { r: r0, c: c0 };
    head = clamp({ r: r0 + rows.length - 1, c: c0 + width - 1 });
    paint();
    if (dropped) onNotice(`${dropped} nilai di luar tabel tidak ikut ditempel.`);
  }

  // Safari only enables copy/cut without a text selection if these are cancelled.
  for (const type of ['beforecopy', 'beforecut']) {
    editor.addEventListener(type, (e) => { if (mode === 'select') e.preventDefault(); });
  }
  editor.addEventListener('copy', (e) => {
    if (mode !== 'select') return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', selectionAsTSV());
  });
  editor.addEventListener('cut', (e) => {
    if (mode !== 'select') return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', selectionAsTSV());
    clearRange();
  });
  editor.addEventListener('paste', (e) => {
    const text = e.clipboardData.getData('text/plain');
    if (mode !== 'select' && !/[\t\n]/.test(text)) return;
    e.preventDefault();
    if (mode !== 'select') cancel();
    if (text) paste(text);
  });

  // ---- mouse --------------------------------------------------------------

  function cellAt(target) {
    const td = target instanceof Element ? target.closest('td[data-r]') : null;
    return td && tbody.contains(td) ? { r: +td.dataset.r, c: +td.dataset.c } : null;
  }

  let dragging = false;

  table.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); // keep focus in the editor
    const cell = cellAt(e.target);
    if (cell) {
      dragging = true;
      return select(cell.r, cell.c, { extend: e.shiftKey });
    }
    const th = e.target.closest('th');
    if (!th) return;
    if (th.dataset.c !== undefined) selectRange(0, +th.dataset.c, lastRow(), +th.dataset.c);
    else if (th.dataset.r !== undefined) selectRange(+th.dataset.r, 0, +th.dataset.r, lastCol());
    else selectRange(0, 0, lastRow(), lastCol());
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const cell = cellAt(e.target);
    if (cell && (cell.r !== head.r || cell.c !== head.c)) select(cell.r, cell.c, { extend: true });
  });
  document.addEventListener('mouseup', () => { dragging = false; });

  table.addEventListener('dblclick', (e) => {
    if (cellAt(e.target)) openForEdit();
  });

  new ResizeObserver(placeEditor).observe(table);

  // Start over on another patient.
  function reset() {
    cancel();
    sheet = null;
    builtFor = '';
    anchor = { r: 0, c: 0 };
    head = { r: 0, c: 0 };
    refresh();
  }

  return { refresh, reset, selectKey, commit, isEditing: () => mode !== 'select', activeKey: () => sheet.key(anchor.r, anchor.c) };
}
