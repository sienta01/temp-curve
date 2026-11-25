// Data model: patients, temperature parsing, times, columns, and merging.
// A reading is stored under its real calendar time ("2026-11-24T07:15"), as the text of
// its cell, so a mistyped value stays visible (and flagged) instead of disappearing.
const Model = (() => {
  'use strict';

  // One table row is one ward day: 04:30 until 04:29 the next morning. 00:00-04:29 is
  // therefore the next calendar date, like the 02 column.
  const DAY = 1440;
  const DAY_START = 270;
  const FIRST_HOUR = 360;
  // Standard columns: the default ward times (180, the chart still draws 3-hour columns)
  // or every hour (60).
  const STEPS = [180, 60];
  const DEFAULT_TIMES = ['06:00', '09:00', '12:00', '15:00', '18:00', '22:00', '02:00'];

  const FEVER = 38;
  const FLOOR = 35; // bottom line of the chart; lower readings are marked off-scale
  const MIN_TEMP = 25; // outside MIN-MAX is treated as a typing mistake
  const MAX_TEMP = 45;

  const START_DAYS = 7;
  const MAX_DAYS = 120;
  const FIELDS = ['nama', 'ruangan', 'rm', 'start', 'dayCount', 'step'];

  // Follow the browser's number format so copy/paste with Excel round-trips.
  const DECIMAL = (1.5).toLocaleString().includes(',') ? ',' : '.';

  const pad = (n) => String(n).padStart(2, '0');
  const clone = (x) => JSON.parse(JSON.stringify(x));

  // ---- temperatures -------------------------------------------------------

  // Accepts 36.8, 36,8, "36.8 °C", and the shorthand 368 / 3685.
  function parseTemp(raw) {
    let s = String(raw ?? '').trim();
    if (!s) return { kind: 'empty' };
    s = s.replace(/\s*°?\s*c$/i, '').replace(',', '.');
    if (/^\d{3,4}$/.test(s)) s = s.slice(0, 2) + '.' + s.slice(2);
    if (!/^\d+(\.\d*)?$/.test(s)) return { kind: 'bad', reason: 'bukan angka' };
    const value = Number(Number(s).toFixed(2));
    if (value < MIN_TEMP || value > MAX_TEMP) {
      return { kind: 'bad', reason: `di luar ${MIN_TEMP}–${MAX_TEMP} °C` };
    }
    return { kind: 'ok', value, low: value < FLOOR };
  }

  function plain(value) {
    const s = String(value);
    return s.includes('.') ? s : s + '.0';
  }

  const formatTemp = (value) => plain(value).replace('.', DECIMAL);

  // What gets stored: "36.8" for a valid reading, the raw text otherwise.
  function canonical(raw) {
    const t = parseTemp(raw);
    if (t.kind === 'ok') return plain(t.value);
    return String(raw ?? '').trim().slice(0, 16);
  }

  function display(raw) {
    const t = parseTemp(raw);
    return t.kind === 'ok' ? formatTemp(t.value) : String(raw ?? '');
  }

  // ---- dates and times (arithmetic in UTC so DST can never shift anything) --

  // Minutes since 1970 for a reading key, and back.
  const toMinutes = (key) => Date.parse(key + ':00Z') / 60000;
  const toKey = (minutes) => new Date(minutes * 60000).toISOString().slice(0, 16);

  function isDate(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && addDays(s, 0) === s;
  }

  const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
  const isKey = (s) => isDate(s.slice(0, 10)) && s[10] === 'T' && isTime(s.slice(11));

  function addDays(date, n) {
    return new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  }

  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

  const FORMATS = {
    row: { weekday: 'short', day: 'numeric', month: 'short' },
    day: { day: 'numeric', month: 'short', year: 'numeric' },
    full: { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' },
  };
  const formatters = {};
  function formatDate(date, style) {
    formatters[style] ??= new Intl.DateTimeFormat('id-ID', { ...FORMATS[style], timeZone: 'UTC' });
    return formatters[style].format(new Date(date + 'T00:00:00Z'));
  }

  const timeOf = (key) => key.slice(11);
  const dateOf = (key) => key.slice(0, 10);
  const hhmm = (minutes) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  const minutesOf = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const isNextDay = (time) => minutesOf(time) < DAY_START;

  // Position of a time within the ward day, 0 at 04:30.
  const order = (time) => (minutesOf(time) - DAY_START + DAY) % DAY;

  // The date of the table row a reading belongs to.
  const wardDate = (key) => dateOf(toKey(toMinutes(key) - DAY_START));
  const dayStart = (date) => toMinutes(date + 'T00:00') + DAY_START;

  function currentWardDay(now = new Date()) {
    const t = new Date(now.getTime() - DAY_START * 60000);
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  }

  // "7", "715", "07.15", "7:15" -> "07:15"; null when it is not a time.
  function parseTime(text) {
    const s = String(text).trim();
    const m = /^(\d{1,2})[:.,\s](\d{1,2})$/.exec(s) ?? /^(\d{1,2}?)(\d{2})?$/.exec(s);
    if (!m) return null;
    const time = `${pad(m[1])}:${pad(m[2] ?? 0)}`;
    return isTime(time) ? time : null;
  }

  // Every `every` minutes from one time to another, crossing midnight if needed.
  function timeSeries(from, to, every) {
    const span = (minutesOf(to) - minutesOf(from) + DAY) % DAY;
    const out = [];
    for (let m = 0; m <= span; m += every) out.push(hhmm((minutesOf(from) + m) % DAY));
    return out;
  }

  // ---- patients -----------------------------------------------------------

  function newPatient() {
    return {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      nama: '',
      ruangan: '',
      rm: '',
      start: currentWardDay(),
      dayCount: START_DAYS,
      step: STEPS[0],
      extra: [], // added times that are not standard columns
      readings: {}, // key -> cell text
    };
  }

  // Patient list order: by room ("Melati 2" before "Melati 10"), then name, then record
  // number. Patients without a room come last.
  const collator = new Intl.Collator('id', { numeric: true, sensitivity: 'base' });
  function byRoom(a, b) {
    const room = (p) => p.ruangan.trim();
    return (
      !room(a) - !room(b) ||
      collator.compare(room(a), room(b)) ||
      collator.compare(a.nama.trim(), b.nama.trim()) ||
      collator.compare(a.rm.trim(), b.rm.trim())
    );
  }

  // Calendar key for a time in the table row of `date`.
  const keyAt = (date, time) => `${addDays(date, isNextDay(time) ? 1 : 0)}T${time}`;

  function put(p, key, raw) {
    const value = canonical(raw);
    if (value) p.readings[key] = value;
    else delete p.readings[key];
  }

  function standardTimes(step) {
    if (step === 180) return [...DEFAULT_TIMES];
    const out = [];
    for (let m = 0; m < DAY; m += step) out.push(hhmm((FIRST_HOUR + m) % DAY));
    return out;
  }

  // The table as rows and columns. A time that holds a reading always has a column,
  // whatever the column settings, so data can never be hidden. The result is a snapshot:
  // it keeps describing the old table after the patient changes.
  function sheet(p) {
    const { start, dayCount } = p;
    const used = Object.keys(p.readings).map(timeOf);
    const times = [...new Set([...standardTimes(p.step), ...p.extra, ...used])].sort((a, b) => order(a) - order(b));
    const columnOf = new Map(times.map((t, c) => [t, c]));
    const date = (r) => addDays(start, r);
    return {
      rows: dayCount,
      times,
      date,
      key: (r, c) => keyAt(date(r), times[c]),
      find(key) {
        const r = daysBetween(start, wardDate(key));
        const c = columnOf.get(timeOf(key));
        return c !== undefined && r >= 0 && r < dayCount ? { r, c } : null;
      },
    };
  }

  // Added columns without a single reading in them.
  function emptyExtras(p) {
    const used = new Set(Object.keys(p.readings).map(timeOf));
    const standard = new Set(standardTimes(p.step));
    return p.extra.filter((t) => !used.has(t) && !standard.has(t));
  }

  // Grow the date range and the columns so that every reading has a lasting cell.
  function normalise(p) {
    const known = new Set([...standardTimes(p.step), ...p.extra]);
    for (const key of Object.keys(p.readings)) {
      if (!known.has(timeOf(key))) {
        known.add(timeOf(key));
        p.extra.push(timeOf(key));
      }
      const r = daysBetween(p.start, wardDate(key));
      if (r < 0) {
        p.start = addDays(p.start, r);
        p.dayCount -= r;
      } else if (r >= p.dayCount) p.dayCount = r + 1;
    }
    return p;
  }

  function setStep(p, step) {
    p.step = step;
    normalise(p);
  }

  function addTimes(p, times) {
    p.extra = [...new Set([...p.extra, ...times])];
  }

  function removeEmptyTimes(p) {
    const empty = new Set(emptyExtras(p));
    p.extra = p.extra.filter((t) => !empty.has(t));
  }

  function shiftDates(p, newStart) {
    const n = daysBetween(p.start, newStart);
    const moved = {};
    for (const [key, raw] of Object.entries(p.readings)) moved[`${addDays(dateOf(key), n)}T${timeOf(key)}`] = raw;
    p.readings = moved;
    p.start = newStart;
  }

  function addDayBefore(p) {
    p.start = addDays(p.start, -1);
    p.dayCount++;
  }

  function clearDay(p, date) {
    for (const key of Object.keys(p.readings)) if (wardDate(key) === date) delete p.readings[key];
  }

  function removeFirstDay(p) {
    clearDay(p, p.start);
    p.start = addDays(p.start, 1);
    p.dayCount--;
  }

  function removeLastDay(p) {
    clearDay(p, addDays(p.start, p.dayCount - 1));
    p.dayCount--;
  }

  // Valid readings in time order.
  function readings(p) {
    return Object.entries(p.readings)
      .map(([key, raw]) => ({ key, t: toMinutes(key), ...parseTemp(raw) }))
      .filter((x) => x.kind === 'ok')
      .sort((a, b) => a.t - b.t);
  }

  function badCells(p) {
    return Object.entries(p.readings)
      .map(([key, raw]) => ({ key, raw, ...parseTemp(raw) }))
      .filter((x) => x.kind === 'bad')
      .sort((a, b) => toMinutes(a.key) - toMinutes(b.key));
  }

  // ---- saved data ---------------------------------------------------------

  // Rebuild a patient from untrusted JSON, including the first version's format
  // (an array of days with eight fixed 3-hour cells each).
  function cleanPatient(p) {
    const base = newPatient();
    const text = (v) => (typeof v === 'string' ? v : '');
    const out = {
      ...base,
      id: /^[a-z0-9]{6,40}$/.test(text(p?.id)) ? p.id : base.id,
      nama: text(p?.nama),
      ruangan: text(p?.ruangan),
      rm: text(p?.rm),
      start: isDate(text(p?.start)) ? p.start : base.start,
      dayCount: Number.isInteger(p?.dayCount) && p.dayCount > 0 ? Math.min(p.dayCount, MAX_DAYS) : base.dayCount,
      step: STEPS.includes(p?.step) ? p.step : base.step,
      extra: Array.isArray(p?.extra) ? [...new Set(p.extra.filter((t) => isTime(text(t))))] : [],
    };
    if (Array.isArray(p?.days)) {
      out.dayCount = Math.max(1, Math.min(p.days.length, MAX_DAYS));
      const times = Array.from({ length: 8 }, (_, c) => hhmm((FIRST_HOUR + c * 180) % DAY));
      p.days.slice(0, MAX_DAYS).forEach((day, r) => {
        const date = addDays(out.start, r);
        if (Array.isArray(day)) day.slice(0, 8).forEach((raw, c) => put(out, keyAt(date, times[c]), text(raw)));
      });
    } else {
      for (const [key, raw] of Object.entries(p?.readings ?? {})) if (isKey(key)) put(out, key, text(raw));
    }
    return normalise(out);
  }

  // Three-way merge for two devices editing the same patient: whatever changed here
  // since `base` wins, everything else comes from the other device.
  function merge(base, mine, theirs) {
    const out = clone(theirs);
    for (const f of FIELDS) if (mine[f] !== base[f]) out[f] = mine[f];
    out.extra = [...new Set([...mine.extra, ...theirs.extra])].filter((t) => {
      const here = mine.extra.includes(t);
      return here !== base.extra.includes(t) ? here : theirs.extra.includes(t);
    });
    for (const key of new Set([...Object.keys(base.readings), ...Object.keys(mine.readings)])) {
      if (mine.readings[key] === base.readings[key]) continue;
      if (mine.readings[key] === undefined) delete out.readings[key];
      else out.readings[key] = mine.readings[key];
    }
    return normalise(out);
  }

  return {
    STEPS, FEVER, FLOOR, MAX_DAYS, DAY, DECIMAL,
    parseTemp, formatTemp, canonical, display,
    isDate, addDays, formatDate, toMinutes, toKey, timeOf, dateOf, hhmm, isNextDay, dayStart, wardDate, currentWardDay,
    parseTime, timeSeries, pad, clone,
    newPatient, byRoom, keyAt, put, sheet, standardTimes, emptyExtras, normalise, setStep, addTimes, removeEmptyTimes, shiftDates, addDayBefore, removeFirstDay, removeLastDay,
    readings, badCells, cleanPatient, merge,
  };
})();
