// Draws the temperature chart as a self-contained SVG, so the same output serves the
// on-screen preview, the PNG, and the printed page. Proportions and colours follow the
// paper form: 8 columns per day, solid grey half degrees, dashed whole degrees, and a
// red double line at 38. Time runs to scale, so readings may fall at any minute.
const Chart = (() => {
  'use strict';

  const { FEVER, FLOOR, DAY } = Model;
  const NS = 'http://www.w3.org/2000/svg';
  const FONT = "Verdana, 'DejaVu Sans', Geneva, sans-serif";

  const PAD = 14;
  const AXIS = 37; // width of the degree column
  const COL = 24; // one column
  const DEG = 23; // one degree
  const DATE = 18; // date row
  const HEAD = 16; // hour row
  const LOW_BAND = 25; // strip under the scale for readings below 35
  const GAP = 18; // between strips

  const DETAIL_STEP = 15; // minutes per column of a detail strip
  const DETAIL_COL = 34;
  const DETAIL_MIN_COLS = 9; // two hours, both ends included
  const DETAIL_MAX_COLS = 25; // six hours

  const INK = '#2f2738';
  const RULE = '#111111';
  const EDGE = '#8a8a8a';
  const GRID = '#d9d9d9';
  const RED = '#d42c2d';
  const BLUE = '#1746b4';

  const HIGH = 40; // default top of the scale, as on the form

  function el(parent, name, attrs = {}, text) {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    parent?.append(node);
    return node;
  }

  function line(parent, x1, y1, x2, y2, stroke, width = 1, extra = {}) {
    return el(parent, 'line', { x1, y1, x2, y2, stroke, 'stroke-width': width, ...extra });
  }

  const ruler = document.createElement('canvas').getContext('2d');
  function textWidth(text, size, bold) {
    ruler.font = `${bold ? 'bold ' : ''}${size}px ${FONT}`;
    return ruler.measureText(text).width;
  }

  // The scale starts at 35. The top rises by whole degrees only when a reading, or its
  // printed number, would touch the frame half a degree above. Readings below 35 go to
  // a separate band so that they never stretch the scale.
  function scaleFor(points, showValues) {
    const max = Math.max(...points.map((p) => p.value), FLOOR);
    const hi = Math.max(HIGH, Math.ceil(max + (showValues ? 0.05 : -0.35)));
    const hasLow = points.some((p) => p.low);
    const scaleH = (hi - FLOOR + 1) * DEG;
    const bodyH = scaleH + (hasLow ? LOW_BAND : 0);
    const bodyTop = DATE + HEAD;
    const yOf = (t) => bodyTop + (hi + 0.5 - t) * DEG;
    const lowY = bodyTop + scaleH + 7;
    return {
      hi, hasLow, scaleH, bodyH, bodyTop, yOf,
      stripH: bodyTop + bodyH,
      y: (p) => (p.low ? lowY : yOf(p.value)),
    };
  }

  // ---- strips: each is a run of equal columns starting at time t0 ------------

  // From the first to the last day with readings, cut into rows of `perRow` days.
  function mainStrips(patient, points, step, perRow) {
    const firstDay = points.length ? Model.wardDate(points[0].key) : patient.start;
    const lastDay = points.length ? Model.wardDate(points[points.length - 1].key) : firstDay;
    const days = (Model.dayStart(lastDay) - Model.dayStart(firstDay)) / DAY + 1;
    const perStrip = Math.min(days, perRow);
    const perDay = DAY / step;
    const out = [];
    for (let d = 0; d < days; d += perStrip) {
      const date = Model.addDays(firstDay, d);
      out.push({
        t0: Model.dayStart(date), step, colW: COL, cols: perStrip * perDay, labelSize: 11,
        label: (t) => Model.pad((t / 60) % 24),
        heads: Array.from({ length: perStrip }, (_, i) => ({
          from: i * perDay, cols: perDay, text: Model.formatDate(Model.addDays(date, i), 'full'),
        })),
      });
    }
    return out;
  }

  // Three or more readings at most 30 minutes apart are too close to read on the main
  // chart, so each such run also gets an enlarged strip with a column every 15 minutes.
  function detailStrips(points) {
    const runs = [];
    points.forEach((p, i) => {
      if (i > 0 && p.t - points[i - 1].t <= 30) {
        if (runs.at(-1)?.at(-1) !== points[i - 1]) runs.push([points[i - 1]]);
        runs.at(-1).push(p);
      }
    });
    const out = [];
    for (const run of runs) {
      if (run.length < 3) continue;
      const start = Math.floor(run[0].t / 60) * 60;
      const end = Math.ceil(run.at(-1).t / 60) * 60;
      const total = (end - start) / DETAIL_STEP + 1;
      for (let i = 0; i < total; i += DETAIL_MAX_COLS) {
        const cols = Math.max(DETAIL_MIN_COLS, Math.min(DETAIL_MAX_COLS, total - i));
        const from = start + i * DETAIL_STEP;
        out.push({
          t0: from - DETAIL_STEP / 2, step: DETAIL_STEP, colW: DETAIL_COL, cols, labelSize: 8.5,
          label: (t) => Model.hhmm(t % DAY),
          heads: [{ from: 0, cols, text: spanText(from, from + (cols - 1) * DETAIL_STEP) }],
        });
      }
    }
    return out;
  }

  function spanText(a, b) {
    const [ka, kb] = [Model.toKey(a), Model.toKey(b)];
    const da = Model.formatDate(Model.dateOf(ka), 'day');
    const db = Model.formatDate(Model.dateOf(kb), 'day');
    return `Detail ${da}, ${Model.timeOf(ka)}–${da === db ? '' : db + ', '}${Model.timeOf(kb)}`;
  }

  const widthOf = (strip) => AXIS + strip.cols * strip.colW;
  const xOf = (strip, t) => AXIS + ((t - strip.t0) / strip.step) * strip.colW;

  // ---- drawing --------------------------------------------------------------

  // Patient details flow left to right and wrap when the chart is narrow.
  function infoLines(patient, width) {
    const size = 11;
    const items = [['Nama', patient.nama], ['Ruangan', patient.ruangan], ['No RM', patient.rm]].map(([k, v]) => {
      const label = k + ': ';
      const value = v.trim() || '____________';
      const labelWidth = textWidth(label, size, false);
      return { label, value, labelWidth, width: labelWidth + textWidth(value, size, true) };
    });
    const lines = [];
    let x = Infinity;
    for (const item of items) {
      if (x + item.width > width) {
        lines.push([]);
        x = 0;
      }
      lines[lines.length - 1].push({ ...item, x });
      x += item.width + 26;
    }
    return { size, lines, width: Math.max(...items.map((i) => i.width)) };
  }

  function build(patient, { step = 180, perRow = 7, showValues = false } = {}) {
    const points = Model.readings(patient);
    const scale = scaleFor(points, showValues);
    const strips = [...mainStrips(patient, points, step, perRow), ...detailStrips(points)];

    const notes = ['Jam 00:00–04:29 = dini hari tanggal berikutnya'];
    if (scale.hasLow) notes.push(`▼ = suhu di bawah ${FLOOR} °C, di luar skala`);
    const fit = Math.max(...strips.map(widthOf), ...notes.map((n) => textWidth(n, 8, false)),
      ...strips.flatMap((s) => s.heads.map((h) => AXIS + textWidth(h.text, 10, false) + 8)));
    const info = infoLines(patient, fit);
    const infoTop = PAD + 13;
    const chartTop = infoTop + 8 + info.lines.length * 16 + 4;
    const notesTop = chartTop + strips.length * (scale.stripH + GAP) - GAP + 13;
    const width = Math.ceil(Math.max(fit, info.width) + PAD * 2);
    const height = Math.ceil(notesTop + (notes.length - 1) * 11 + PAD);

    const svg = el(null, 'svg', {
      xmlns: NS, width, height, viewBox: `0 0 ${width} ${height}`,
      'font-family': FONT, role: 'img',
      'aria-label': `Kurva suhu ${patient.nama || 'pasien'}, ${points.length} pengukuran`,
    });
    el(svg, 'rect', { width, height, fill: '#ffffff' });

    el(svg, 'text', { x: PAD, y: infoTop, 'font-size': 13, 'font-weight': 'bold', fill: INK }, 'Kurva Suhu (°C)');
    info.lines.forEach((items, i) => {
      const y = infoTop + 20 + i * 16;
      for (const item of items) {
        el(svg, 'text', { x: PAD + item.x, y, 'font-size': info.size, fill: INK }, item.label.trimEnd());
        el(svg, 'text', { x: PAD + item.x + item.labelWidth, y, 'font-size': info.size, 'font-weight': 'bold', fill: INK }, item.value);
      }
    });

    const defs = el(svg, 'defs');
    strips.forEach((strip, i) => {
      const clip = el(defs, 'clipPath', { id: `plot-${i}` });
      el(clip, 'rect', { x: AXIS, y: scale.bodyTop, width: strip.cols * strip.colW, height: scale.bodyH });

      const g = el(svg, 'g', { transform: `translate(${PAD} ${chartTop + i * (scale.stripH + GAP)})` });
      drawFrame(g, strip, scale);
      drawCurve(g, strip, scale, points, i, showValues);
      const ui = el(g, 'g', { class: 'ui' });
      strip.cursor = el(ui, 'rect', { class: 'cursor', y: DATE, height: scale.stripH - DATE, visibility: 'hidden' });
      strip.hit = el(ui, 'rect', {
        class: 'hit', 'data-strip': i, x: AXIS, y: DATE, width: strip.cols * strip.colW, height: scale.stripH - DATE, fill: 'transparent',
      });
    });

    notes.forEach((n, i) => el(svg, 'text', { x: PAD, y: notesTop + i * 11, 'font-size': 8, fill: '#6b6472' }, n));
    return { svg, strips, points, scale };
  }

  function drawFrame(g, strip, scale) {
    const { hi, hasLow, scaleH, stripH, bodyTop, yOf } = scale;
    const { cols, colW, step, t0 } = strip;
    const right = widthOf(strip);
    const breaks = new Set(strip.heads.map((h) => h.from));

    // grid
    for (let i = 1; i < cols; i++) {
      if (!breaks.has(i)) line(g, AXIS + i * colW, bodyTop, AXIS + i * colW, stripH, GRID);
    }
    for (let t = FLOOR; t <= hi; t++) line(g, AXIS, yOf(t + 0.5), right, yOf(t + 0.5), GRID);
    for (let t = FLOOR; t <= hi; t++) {
      if (t !== FEVER) line(g, AXIS, yOf(t), right, yOf(t), RULE, 1.2, { 'stroke-dasharray': '4.5 1.8' });
    }
    for (const d of [-1.2, 1.2]) line(g, AXIS, yOf(FEVER) + d, right, yOf(FEVER) + d, RED, 1.2);

    // degree labels
    const axisLabel = (y, text) => el(g, 'text', {
      x: AXIS / 2, y, 'font-size': 12, 'font-weight': 'bold', 'text-anchor': 'middle', fill: INK,
    }, text);
    for (let t = FLOOR; t <= hi; t++) axisLabel(yOf(t) + 4.5, String(t));
    if (hasLow) {
      line(g, 0, bodyTop + scaleH, right, bodyTop + scaleH, RULE, 1);
      axisLabel(bodyTop + scaleH + LOW_BAND / 2 + 4.5, `<${FLOOR}`);
    }

    // time labels and ticks
    for (let i = 0; i < cols; i++) {
      const x = AXIS + i * colW;
      el(g, 'text', {
        x: x + colW / 2, y: DATE + 12, 'font-size': strip.labelSize, 'font-weight': 'bold', 'text-anchor': 'middle', fill: INK,
      }, strip.label(t0 + (i + 0.5) * step));
      if (i && !breaks.has(i)) line(g, x, DATE, x, bodyTop, RULE, 1.2);
    }

    // dates
    for (const h of strip.heads) {
      const x = AXIS + h.from * colW;
      const fits = textWidth(h.text, 10, false) < h.cols * colW - 8;
      el(g, 'text', {
        x: fits ? x + (h.cols * colW) / 2 : x + 4, y: 12.5, 'font-size': 10, 'text-anchor': fits ? 'middle' : 'start', fill: INK,
      }, h.text);
      if (h.from) line(g, x, 0, x, stripH, RULE, 1.2);
    }

    // frame
    line(g, AXIS, DATE, right, DATE, RULE, 1.2);
    el(g, 'rect', { x: 0, y: 0, width: right, height: stripH, fill: 'none', stroke: EDGE, 'stroke-width': 1 });
    line(g, 0, 0, right, 0, RULE, 1.2);
    line(g, 0, stripH, right, stripH, RULE, 1.2);
    line(g, AXIS, 0, AXIS, stripH, RULE, 1.6);
  }

  function drawCurve(g, strip, scale, points, index, showValues) {
    const at = points.map((p) => [xOf(strip, p.t), scale.y(p)]);
    const plot = el(g, 'g', { 'clip-path': `url(#plot-${index})` });

    // The whole curve is drawn in every strip and clipped, so it runs on across strips.
    // Readings more than 24 hours apart are not joined.
    let d = '';
    points.forEach((p, i) => {
      const joined = i > 0 && p.t - points[i - 1].t <= DAY;
      d += `${joined ? 'L' : 'M'}${at[i][0].toFixed(2)} ${at[i][1].toFixed(2)}`;
    });
    if (d) {
      el(plot, 'path', {
        d, fill: 'none', stroke: BLUE, 'stroke-width': 1.8, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      });
    }

    const right = widthOf(strip);
    const inside = points.map((_, i) => i).filter((i) => at[i][0] >= AXIS && at[i][0] < right);

    // Markers shrink when readings are crowded; the detail strip shows those in full.
    for (const i of inside) {
      const [x, y] = at[i];
      const space = Math.min(i > 0 ? x - at[i - 1][0] : Infinity, i < points.length - 1 ? at[i + 1][0] - x : Infinity);
      const r = space >= 9 ? 3.4 : space >= 5 ? 2.4 : 1.5;
      if (points[i].low) {
        const s = Math.max(r, 2.4) + 0.6;
        el(plot, 'path', {
          d: `M${x - s} ${y - s * 0.75}H${x + s}L${x} ${y + s}Z`, fill: BLUE, stroke: '#ffffff', 'stroke-width': 0.8, class: 'low',
        });
      } else {
        el(plot, 'circle', { cx: x, cy: y, r, fill: BLUE, stroke: '#ffffff', 'stroke-width': r > 2 ? 1 : 0 });
      }
    }

    const label = (x, y, text, bold) => el(g, 'text', {
      x, y, 'font-size': 8, 'font-weight': bold ? 'bold' : 'normal', 'text-anchor': 'middle', fill: INK,
      stroke: '#ffffff', 'stroke-width': 2.4, 'stroke-linejoin': 'round', 'paint-order': 'stroke',
    }, text);

    // Readings below 35 always carry their number. Where several crowd together the
    // lowest is written first and the rest only where there is room.
    const taken = [];
    for (const i of inside.filter((i) => points[i].low).sort((a, b) => points[a].value - points[b].value)) {
      const x = Math.max(AXIS + 12, Math.min(at[i][0], right - 12));
      if (taken.some((other) => Math.abs(other - x) < 24)) continue;
      taken.push(x);
      label(x, scale.stripH - 3, Model.formatTemp(points[i].value), true);
    }

    if (!showValues) return;
    let last = -Infinity;
    for (const i of inside) {
      const [x, y] = at[i];
      if (points[i].low || x - last < 21) continue;
      last = x;
      const prev = i > 0 ? at[i - 1][1] : y;
      const next = i < points.length - 1 ? at[i + 1][1] : y;
      const valley = prev + next < 2 * y - 1.2;
      label(x, valley ? Math.min(y + 12.5, scale.bodyTop + scale.scaleH - 1.5) : y - 6, Model.formatTemp(points[i].value), false);
    }
  }

  // ---- on-screen helpers ------------------------------------------------------

  // Shade the column of the active cell.
  function setCursor(chart, key) {
    const t = Model.toMinutes(key);
    for (const s of chart.strips) {
      const i = (t - s.t0) / s.step - 0.5;
      const inside = i >= -0.5 && i < s.cols - 0.5;
      const w = Number.isInteger(i) ? s.colW : 6;
      s.cursor.setAttribute('visibility', inside ? 'visible' : 'hidden');
      if (inside) {
        s.cursor.setAttribute('x', xOf(s, t) - w / 2);
        s.cursor.setAttribute('width', w);
      }
    }
  }

  // What is under the pointer: the nearest reading, else the nearest column.
  function locate(chart, hit, clientX) {
    const s = chart.strips[+hit.dataset.strip];
    const box = hit.getBoundingClientRect();
    const unit = box.width / (s.cols * s.colW);
    const x = AXIS + (clientX - box.left) / unit;
    let near = null;
    for (const p of chart.points) {
      const gap = Math.abs(xOf(s, p.t) - x);
      if (gap <= Math.max(s.colW / 2, 10 / unit) && (!near || gap < near.gap)) near = { p, gap };
    }
    const i = Math.max(0, Math.min(s.cols - 1, Math.floor((x - AXIS) / s.colW)));
    const t = near ? near.p.t : s.t0 + (i + 0.5) * s.step;
    return {
      key: Model.toKey(t),
      point: near?.p ?? null,
      clientX: box.left + (xOf(s, t) - AXIS) * unit,
      clientY: near ? box.top + (chart.scale.y(near.p) - DATE) * unit : null,
    };
  }

  // Export copy: without the on-screen layer.
  function buildForExport(patient, options) {
    const { svg } = build(patient, options);
    svg.querySelectorAll('.ui').forEach((n) => n.remove());
    return svg;
  }

  // Rasterise at 3x, backing off for very long charts to stay within canvas limits.
  async function toPNG(svg) {
    const w = +svg.getAttribute('width');
    const h = +svg.getAttribute('height');
    const scale = Math.min(3, 8000 / w, 8000 / h, Math.sqrt(16e6 / (w * h)));
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG kosong'))), 'image/png')
    );
  }

  return { build, buildForExport, setCursor, locate, toPNG };
})();
