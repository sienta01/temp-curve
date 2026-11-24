// Wires the patient form, the grid, the chart, storage, and the exports together.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let undoStack = [];
  let redoStack = [];
  let chart = null;

  const prefs = () => Store.prefs;
  const patient = () => Store.find(prefs().activeId);
  const sortedPatients = () => [...Store.patients].sort(Model.byRoom);

  // ---- changes ------------------------------------------------------------

  const snapshot = ({ start, dayCount, step, extra, readings }) =>
    JSON.stringify({ start, dayCount, step, extra, readings });

  // Every change to the table goes through here, so every change can be undone.
  function write(mutate) {
    const p = patient();
    const before = snapshot(p);
    mutate(p);
    if (snapshot(p) === before) return;
    undoStack.push(before);
    if (undoStack.length > 200) undoStack.shift();
    redoStack = [];
    Store.changed(p);
    renderTable();
  }

  function restoreFrom(from, to) {
    grid.commit();
    if (!from.length) return;
    const p = patient();
    to.push(snapshot(p));
    Object.assign(p, JSON.parse(from.pop()));
    Store.changed(p);
    renderTable();
  }
  const undo = () => restoreFrom(undoStack, redoStack);
  const redo = () => restoreFrom(redoStack, undoStack);

  function forgetHistory() {
    undoStack = [];
    redoStack = [];
  }

  function openPatient(id) {
    if (!Store.patients.length) Store.add(Model.newPatient());
    prefs().activeId = Store.find(id) ? id : sortedPatients()[0].id;
    Store.savePrefs();
    forgetHistory();
    grid.reset();
    renderAll();
  }

  // ---- rendering ----------------------------------------------------------

  const grid = createGrid({
    root: $('grid'),
    read: patient,
    write,
    onUndo: undo,
    onRedo: redo,
    onNotice: toast,
    onActive(key) {
      renderCellBar(key);
      if (chart) Chart.setCursor(chart, key);
    },
  });

  function setValue(input, value) {
    if (input.value !== value) input.value = value; // leaves the caret alone while typing
  }

  function renderAll() {
    const p = patient();
    setValue($('nama'), p.nama);
    setValue($('ruangan'), p.ruangan);
    setValue($('rm'), p.rm);
    $('show-values').checked = prefs().showValues;
    renderPicker();
    renderTable();
  }

  function renderTable() {
    const p = patient();
    setValue($('start'), p.start);
    $('step').value = String(p.step);
    $('per-row').value = String(prefs().perRow[p.step]);
    $('undo').disabled = !undoStack.length;
    $('redo').disabled = !redoStack.length;
    const full = p.dayCount >= Model.MAX_DAYS;
    $('day-before').disabled = full;
    $('day-after').disabled = full;
    $('day-remove-first').disabled = p.dayCount <= 1;
    $('day-remove').disabled = p.dayCount <= 1;
    $('time-clean').disabled = !Model.emptyExtras(p).length;
    grid.refresh();
    renderChart();
  }

  function patientLabel(p) {
    const parts = [p.nama.trim() || 'Tanpa nama', p.ruangan.trim(), p.rm.trim() && `RM ${p.rm.trim()}`];
    return parts.filter(Boolean).join(' · ');
  }

  function renderPicker() {
    $('patient').replaceChildren(
      ...sortedPatients().map((p) => new Option(patientLabel(p), p.id, false, p.id === prefs().activeId))
    );
  }

  const when = (key, style) => `${Model.formatDate(Model.dateOf(key), style)}, ${Model.timeOf(key)}`;

  function renderCellBar(key) {
    const raw = patient().readings[key] ?? '';
    const t = Model.parseTemp(raw);
    const text = {
      empty: '',
      bad: `“${raw}” ${t.reason}, tidak digambar`,
      ok: `${t.kind === 'ok' ? Model.formatTemp(t.value) : ''} °C${t.low ? `, di bawah ${Model.FLOOR} °C, ditandai ▼ di kurva` : ''}`,
    };
    $('cell-time').textContent = when(key, 'full');
    $('cell-value').textContent = text[t.kind];
    $('cell-value').classList.toggle('bad', t.kind === 'bad');
  }

  function chartOptions() {
    const { step } = patient();
    return { step, perRow: prefs().perRow[step], showValues: prefs().showValues };
  }

  function renderChart() {
    const p = patient();
    chart = Chart.build(p, chartOptions());
    const { svg } = chart;
    const natural = +svg.getAttribute('width');
    // Enlarge short charts, shrink long ones, but keep them legible on a phone.
    svg.setAttribute('width', Math.round(natural * 1.3));
    svg.removeAttribute('height');
    svg.style.maxWidth = '100%';
    svg.style.minWidth = Math.round(natural * 0.7) + 'px';
    $('sheet').replaceChildren(svg);
    Chart.setCursor(chart, grid.activeKey());
    hideTip();

    const bad = Model.badCells(p);
    $('bad-cells').hidden = !bad.length;
    if (bad.length) {
      const list = bad.slice(0, 3).map((b) => `${when(b.key, 'row')} (“${b.raw}”)`);
      const more = bad.length > 3 ? `, dan ${bad.length - 3} lainnya` : '';
      $('bad-cells').textContent = `${bad.length} sel tidak valid dan tidak digambar: ${list.join('; ')}${more}.`;
    }
  }

  const STATUS = {
    local: ['Tersimpan di browser ini', false],
    'local-failed': ['Tidak tersimpan', true],
    saved: ['Tersimpan di server', false],
    saving: ['Menyimpan…', false],
    offline: ['Server tidak terhubung', true],
    unsaved: ['Belum tersimpan, mencoba lagi…', true],
  };
  function renderStatus(state) {
    const [text, alarm] = STATUS[state];
    if ($('status').textContent !== text) $('status').textContent = text;
    $('status').classList.toggle('alarm', alarm);
    $('storage-warning').hidden = state !== 'local-failed';
  }

  // ---- changes from another device or tab -----------------------------------

  function onRemote(id, what) {
    if (what === 'deleted' && id === prefs().activeId) {
      toast('Pasien ini baru saja dihapus dari perangkat lain.');
      return openPatient('');
    }
    if (id === null && !patient()) return openPatient('');
    if (id !== null && id !== prefs().activeId) return renderPicker();
    forgetHistory();
    renderAll();
  }

  // ---- chart hover and click ----------------------------------------------

  function hideTip() {
    $('tip').hidden = true;
  }

  $('sheet').addEventListener('pointermove', (e) => {
    const hit = e.target.closest?.('.hit');
    if (!hit) return hideTip();
    const at = Chart.locate(chart, hit, e.clientX);
    const tip = $('tip');
    tip.firstElementChild.textContent = at.point ? `${Model.formatTemp(at.point.value)} °C` : 'Belum diisi';
    tip.lastElementChild.textContent = when(at.key, 'row');
    tip.hidden = false;
    const half = tip.offsetWidth / 2 + 4;
    tip.style.left = Math.max(half, Math.min(at.clientX, window.innerWidth - half)) + 'px';
    tip.style.top = (at.clientY ?? e.clientY) + 'px';
  });
  $('sheet').addEventListener('pointerleave', hideTip);
  window.addEventListener('scroll', hideTip, { passive: true });

  $('sheet').addEventListener('click', (e) => {
    const hit = e.target.closest?.('.hit');
    if (hit) grid.selectKey(Chart.locate(chart, hit, e.clientX).key);
  });

  // ---- patients -----------------------------------------------------------

  for (const field of ['nama', 'ruangan', 'rm']) {
    $(field).addEventListener('input', () => {
      const p = patient();
      p[field] = $(field).value;
      Store.changed(p);
      renderPicker();
      renderChart();
    });
  }

  $('start').addEventListener('change', () => {
    const value = $('start').value;
    if (Model.isDate(value)) write((p) => Model.shiftDates(p, value));
    $('start').value = patient().start;
  });

  $('patient').addEventListener('change', () => openPatient($('patient').value));

  $('add-patient').addEventListener('click', () => {
    const p = Model.newPatient();
    Store.add(p);
    openPatient(p.id);
    $('nama').focus();
  });

  $('del-patient').addEventListener('click', () => {
    const p = patient();
    const where = Store.mode === 'server' ? ' Data di server ikut terhapus untuk semua perangkat.' : '';
    $('confirm-text').textContent =
      `Hapus ${patientLabel(p)} beserta ${Model.readings(p).length} data suhu?${where} Tindakan ini tidak bisa diurungkan.`;
    $('confirm').returnValue = '';
    $('confirm').showModal();
  });

  $('confirm').addEventListener('close', async () => {
    if ($('confirm').returnValue !== 'yes') return;
    try {
      const done = await Store.remove(prefs().activeId);
      if (!done) return toast('Data pasien ini baru diubah dari perangkat lain. Periksa dulu, lalu hapus lagi.');
      openPatient('');
    } catch (err) {
      console.error(err);
      toast('Pasien gagal dihapus. Periksa koneksi ke server.');
    }
  });

  // ---- table tools --------------------------------------------------------

  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  $('step').addEventListener('change', () => write((p) => Model.setStep(p, Number($('step').value))));
  $('time-clean').addEventListener('click', () => write(Model.removeEmptyTimes));
  $('day-before').addEventListener('click', () => write(Model.addDayBefore));
  $('day-after').addEventListener('click', () => {
    write((p) => { p.dayCount++; });
    const p = patient();
    grid.selectKey(Model.keyAt(Model.addDays(p.start, p.dayCount - 1), Model.sheet(p).times[0]));
  });

  // Deleting a day takes its readings along, so say so when there were any.
  function removeDay(remove, date) {
    grid.commit();
    const p = patient();
    const before = Object.keys(p.readings).length;
    write(remove);
    const gone = before - Object.keys(p.readings).length;
    if (gone) toast(`${Model.formatDate(date, 'row')} dihapus bersama ${gone} data suhu. Klik Urungkan untuk mengembalikan.`);
  }
  $('day-remove-first').addEventListener('click', () => removeDay(Model.removeFirstDay, patient().start));
  $('day-remove').addEventListener('click', () => {
    const p = patient();
    removeDay(Model.removeLastDay, Model.addDays(p.start, p.dayCount - 1));
  });

  // ---- add times ------------------------------------------------------------

  // The times described by the dialog: one time, or a series. Null while incomplete.
  function dialogTimes() {
    const from = Model.parseTime($('time-from').value);
    const toText = $('time-to').value.trim();
    const to = toText ? Model.parseTime(toText) : from;
    if (!from || !to) return null;
    return Model.timeSeries(from, to, Number($('time-every').value));
  }

  function previewTimes() {
    const times = dialogTimes();
    const existing = new Set(Model.sheet(patient()).times);
    const fresh = times?.filter((t) => !existing.has(t)) ?? [];
    $('time-ok').disabled = !fresh.length;
    $('time-preview').textContent = !times
      ? 'Isi “Sampai” hanya untuk deret, misalnya 07:00 sampai 09:00 setiap 15 menit.'
      : fresh.length
        ? `${fresh.length} kolom baru: ${fresh.slice(0, 8).join(', ')}${fresh.length > 8 ? ', …' : ''}`
        : 'Jam ini sudah ada di tabel.';
  }

  $('time-add').addEventListener('click', () => {
    $('time-form').reset();
    previewTimes();
    $('time-dialog').showModal();
    $('time-from').focus();
  });
  $('time-form').addEventListener('input', previewTimes);
  $('time-cancel').addEventListener('click', () => $('time-dialog').close());
  $('time-form').addEventListener('submit', (e) => {
    const times = dialogTimes();
    if (!times || $('time-ok').disabled) return e.preventDefault();
    const day = Model.wardDate(grid.activeKey());
    write((p) => Model.addTimes(p, times));
    // After the dialog has handed focus back.
    setTimeout(() => grid.selectKey(Model.keyAt(day, times[0])));
  });

  // ---- export -------------------------------------------------------------

  $('per-row').addEventListener('change', () => {
    prefs().perRow[patient().step] = Number($('per-row').value);
    Store.savePrefs();
    renderChart();
  });
  $('show-values').addEventListener('change', () => {
    prefs().showValues = $('show-values').checked;
    Store.savePrefs();
    renderChart();
  });

  function fileName(ext) {
    const p = patient();
    const parts = ['kurva-suhu', p.rm, p.nama, p.start]
      .map((s) => s.trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, ''))
      .filter(Boolean);
    return parts.join('_') + '.' + ext;
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  const renderPNG = () => Chart.toPNG(Chart.buildForExport(patient(), chartOptions()));

  $('png').addEventListener('click', async () => {
    grid.commit();
    try {
      download(await renderPNG(), fileName('png'));
    } catch (err) {
      console.error(err);
      toast('Gambar gagal dibuat. Coba Cetak / PDF.');
    }
  });

  // Browsers offer the image clipboard only over HTTPS, localhost, or a local file.
  if (!navigator.clipboard?.write || !window.ClipboardItem) $('copy').hidden = true;
  $('copy').addEventListener('click', async () => {
    grid.commit();
    try {
      // Safari needs the promise handed over inside the click itself.
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': renderPNG() })]);
      toast('Gambar disalin.');
    } catch (err) {
      console.error(err);
      toast('Gambar gagal disalin. Gunakan Unduh PNG.');
    }
  });

  // The PDF takes its file name from the page title.
  const pageTitle = document.title;
  window.addEventListener('beforeprint', () => { document.title = fileName('pdf').slice(0, -4); });
  window.addEventListener('afterprint', () => { document.title = pageTitle; });
  $('print').addEventListener('click', () => {
    grid.commit();
    window.print();
  });

  $('csv').addEventListener('click', () => {
    grid.commit();
    download(new Blob(['﻿' + toCSV(patient())], { type: 'text/csv;charset=utf-8' }), fileName('csv'));
  });

  // One line per filled cell with its real calendar date. Excel expects semicolons
  // wherever the comma is the decimal mark.
  function toCSV(p) {
    const sep = Model.DECIMAL === ',' ? ';' : ',';
    const cell = (v) => {
      let s = String(v);
      if (/^[=+\-@\t]/.test(s)) s = "'" + s; // never let Excel run it as a formula
      return /["\n\r,;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [['Nama', p.nama], ['Ruangan', p.ruangan], ['No RM', p.rm], [], ['Tanggal', 'Jam', 'Suhu (°C)']];
    for (const key of Object.keys(p.readings).sort()) {
      rows.push([Model.dateOf(key), Model.timeOf(key), Model.display(p.readings[key])]);
    }
    return rows.map((row) => row.map(cell).join(sep)).join('\r\n') + '\r\n';
  }

  // ---- backup ---------------------------------------------------------------

  $('backup').addEventListener('click', () => {
    grid.commit();
    const data = { app: 'temp-curve', version: 2, patients: Store.patients };
    download(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), `kurva-suhu_cadangan_${Model.currentWardDay()}.json`);
  });

  $('restore').addEventListener('click', () => $('restore-file').click());
  $('restore-file').addEventListener('change', async () => {
    const file = $('restore-file').files[0];
    $('restore-file').value = '';
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      // handled below
    }
    if (data?.app !== 'temp-curve' || !Array.isArray(data.patients)) return toast('Berkas ini bukan cadangan Kurva Suhu.');
    let added = 0;
    let filled = 0;
    let last = null;
    for (const incoming of data.patients.map(Model.cleanPatient)) {
      const p = Store.find(incoming.id);
      if (p) filled += fillGaps(p, incoming);
      else if (incoming.nama || incoming.ruangan || incoming.rm || Object.keys(incoming.readings).length) {
        Store.add(incoming);
        Store.changed(incoming);
        last = incoming.id;
        added++;
      }
    }
    openPatient(last ?? prefs().activeId);
    toast(`${added} pasien ditambahkan, ${filled} data suhu dilengkapi. Data yang sudah ada tidak diubah.`);
  });

  // Add what is missing from a backup; never overwrite.
  function fillGaps(p, from) {
    let n = 0;
    for (const f of ['nama', 'ruangan', 'rm']) p[f] ||= from[f];
    for (const [key, raw] of Object.entries(from.readings)) {
      if (p.readings[key] !== undefined) continue;
      Model.put(p, key, raw);
      n++;
    }
    Model.normalise(p);
    Store.changed(p);
    return n;
  }

  // ---- misc ---------------------------------------------------------------

  let toastTimer;
  function toast(text) {
    $('toast').textContent = text;
    $('toast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.remove('show'), 5000);
  }

  $('sample').textContent = Model.formatTemp(36.8);
  $('reload').addEventListener('click', () => location.reload());

  Store.init({ onStatus: renderStatus, onRemote }).then(
    () => openPatient(prefs().activeId),
    (err) => {
      console.error(err);
      $('status').textContent = 'Gagal memuat';
      $('status').classList.add('alarm');
      $('load-error').hidden = false;
      document.querySelector('main').hidden = true;
      document.querySelector('.picker').hidden = true;
    }
  );
})();
