'use strict';
/* Notizbuch – handschriftliche Notizen und PDF-Anmerkungen.
   Notizen liegen lokal in IndexedDB. Geöffnete PDFs werden über die File System Access API
   direkt in die Originaldatei zurückgeschrieben (z. B. über den Nextcloud-Speicherort von Android).
   Beim Speichern wird die Schrift als bearbeitbare Ebene (JSON + Original-PDF) in die PDF eingebettet. */

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

const $ = (s, r = document) => r.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const FSA = 'showOpenFilePicker' in window && 'showSaveFilePicker' in window;
const NATIVE = !!window.NATIVE_APP;                      // läuft in der Android-App (native.js)
const revive = h => (window.reviveHandle ? window.reviveHandle(h) : h);
const A4 = [595.28, 841.89];
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif';
const COLORS = ['#1b1f24', '#1f4fd1', '#d0312d', '#1e8e4f', '#ef8a00', '#8a3fc2', '#ffd21f'];
const SIZE_RANGE = { pen: [0.5, 10, 0.5], marker: [4, 40, 1], eraser: [6, 60, 2], shape: [0.5, 10, 0.5], stamp: [12, 90, 2], restyle: [0.5, 10, 0.5] };
const DATA_NAME = 'notizbuch.json';
const ORIG_NAME = 'notizbuch-original.pdf';

/* ---------------- Einstellungen ---------------- */
const prefs = Object.assign({
  tool: 'pen', color: COLORS[0], sizes: { pen: 2, marker: 14, eraser: 20, shape: 2 },
  penStyle: 'fountain', smoothing: 0, shape: 'rect', emode: 'area', textSize: 16, bold: false, finger: false, editable: true, folders: []
}, (() => { try { return JSON.parse(localStorage.getItem('notizbuch.prefs')) || {}; } catch { return {}; } })());
// neue Werkzeuge bekommen ihre Standardgröße auch bei schon gespeicherten Einstellungen
prefs.sizes = { pen: 2, marker: 14, eraser: 20, shape: 2, stamp: 32, restyle: 2.5, ...prefs.sizes };
function savePrefs() { try { localStorage.setItem('notizbuch.prefs', JSON.stringify(prefs)); } catch {} }

/* ---------------- IndexedDB ---------------- */
let dbp;
function openDb() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('notizbuch', 1);
    r.onupgradeneeded = () => {
      for (const n of ['notes', 'blobs', 'handles'])
        if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n, { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
  });
}
const dbGet = (s, id) => tx(s, 'readonly', st => st.get(id));
const dbPut = (s, v) => tx(s, 'readwrite', st => st.put(v));
const dbDel = (s, id) => tx(s, 'readwrite', st => st.delete(id));
const dbAll = s => tx(s, 'readonly', st => st.getAll());

/* ---------------- Zustand ---------------- */
const S = {
  note: null, pdf: null, origBytes: null, handle: null,
  zoom: 1, undo: [], redo: [], sel: null, editing: null, fileDirty: false, saveT: 0,
  folder: '', search: ''
};
const pageEls = new Map();      // page.id -> Seitenelemente
const elToPe = new WeakMap();
const pageById = id => S.note.pages.find(p => p.id === id);

/* ---------------- Hilfen ---------------- */
let toastT;
function toast(msg, ms = 3200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, ms);
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  const t = l ? clamp(((px - ax) * dx + (py - ay) * dy) / l, 0, 1) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
function inPoly(x, y, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const fmtDate = t => new Date(t).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

/* ---------------- Zeichnen ---------------- */
/* Stiftarten: Breite (w) und Farbintensität (i) hängen vom Druck p (0…1) ab.
   Striche ohne „style“ stammen aus älteren Versionen und behalten ihr Aussehen. */
const PEN_STYLES = {
  fountain:    { w: (s, p) => s * (0.35 + 0.9 * p), i: p => 0.5 + 0.5 * p, max: 1.25 },
  ball:        { w: (s, p) => s * (0.8 + 0.3 * p), i: p => 0.55 + 0.45 * p, max: 1.1 },
  pencil:      { w: (s, p) => s * (0.7 + 0.5 * p), i: p => 0.15 + 0.85 * p, max: 1.2, grain: true },
  brush:       { w: (s, p) => s * (0.15 + 2.2 * p), i: p => 0.65 + 0.35 * p, max: 2.35 },
  calligraphy: { w: (s, p, a) => s * (0.25 + 1.6 * Math.abs(Math.sin(a - Math.PI / 4))) * (0.6 + 0.5 * p), i: p => 0.7 + 0.3 * p, max: 2 },
  legacy:      { w: (s, p) => s * (0.35 + 0.9 * p), i: () => 1, max: 1.25 },
  // Reste radierter Formen: gleichmäßig breite, gerade verbundene Linie wie die Form selbst
  shape:       { w: s => s, i: () => 1, max: 1, solid: true }
};
const penStyle = it => PEN_STYLES[it.style] || PEN_STYLES.legacy;
const penMaxW = it => (it.tool === 'marker' || it.tool === 'cover') ? it.size : it.size * penStyle(it).max;

/* Wenig Druck = hellere Farbe (zum Papierweiß hin gemischt), in 12 Stufen zwischengespeichert */
const shadeCache = new Map();
function shade(hex, i) {
  i = Math.round(clamp(i, 0, 1) * 12) / 12;
  const key = hex + i;
  let c = shadeCache.get(key);
  if (!c) {
    const n = parseInt(hex.slice(1), 16), f = v => Math.round(v + (255 - v) * (1 - i) * 0.85);
    c = `rgb(${f(n >> 16 & 255)},${f(n >> 8 & 255)},${f(n & 255)})`;
    shadeCache.set(key, c);
  }
  return c;
}
/* Bleistift-Körnung: Farbe mit zufällig durchlässigen Pixeln (fester Zufall → immer gleiches Muster) */
function penPaint(ctx, it, st, pr) {
  return shade(it.color, st.i(pr));
}

/* Bleistift: Der Strich wird erst deckend in einen Zwischenpuffer gemalt (so entstehen an den Überlappungen
   der Teilstücke keine dunklen Perlen) und dann mit einer feinen Papierstruktur ausgestanzt.
   Die Struktur hängt am Bildschirm-Pixelraster, damit die Körnung bei jedem Zoom gleich fein bleibt. */
let toothCanvas = null;
function paperTooth() {
  if (toothCanvas) return toothCanvas;
  const N = 96, c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d'), d = g.createImageData(N, N);
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const v = new Float32Array(N * N).map(rnd);
  const at = (x, y) => v[((y + N) % N) * N + ((x + N) % N)];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    // leicht verwischt und schräg betont: wirkt wie Papierfasern statt wie Rauschen
    const s = (2 * at(x, y) + at(x + 1, y) + at(x - 1, y) + at(x, y + 1) + at(x, y - 1) + 1.5 * at(x + 1, y + 1) + 1.5 * at(x - 1, y - 1)) / 9;
    d.data[(y * N + x) * 4 + 3] = Math.round(255 * (0.58 + 0.42 * clamp((s - 0.32) / 0.4, 0, 1)));
  }
  g.putImageData(d, 0, 0);
  return toothCanvas = c;
}
const pencilBuf = document.createElement('canvas');
function drawPencil(ctx, it) {
  const st = penStyle(it), pts = it.pts, n = pts.length, m = ctx.getTransform(), sc = Math.hypot(m.a, m.b) || 1;
  const b = bbox(it);
  const x0 = Math.floor(b.x * sc + m.e), y0 = Math.floor(b.y * sc + m.f);
  const W = Math.ceil(b.w * sc) + 3, H = Math.ceil(b.h * sc) + 3;
  if (W < 1 || H < 1 || W * H > 2.5e7) return;
  if (pencilBuf.width < W) pencilBuf.width = W;
  if (pencilBuf.height < H) pencilBuf.height = H;
  const g = pencilBuf.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, W, H);
  g.setTransform(sc, 0, 0, sc, m.e - x0, m.f - y0);
  g.lineCap = g.lineJoin = 'round';
  if (n < 3) {
    for (const [x, y, pr] of pts) { g.fillStyle = shade(it.color, st.i(pr)); g.beginPath(); g.arc(x, y, st.w(it.size, pr, 0) / 2, 0, 7); g.fill(); }
    if (n === 2) { g.strokeStyle = shade(it.color, st.i(pts[1][2])); g.lineWidth = st.w(it.size, pts[1][2], 0); g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); g.lineTo(pts[1][0], pts[1][1]); g.stroke(); }
  } else {
    let sx = pts[0][0], sy = pts[0][1];
    for (let i = 1; i < n - 1; i++) {
      const ex = i === n - 2 ? pts[n - 1][0] : (pts[i][0] + pts[i + 1][0]) / 2;
      const ey = i === n - 2 ? pts[n - 1][1] : (pts[i][1] + pts[i + 1][1]) / 2;
      g.lineWidth = st.w(it.size, pts[i][2], 0);
      g.strokeStyle = shade(it.color, st.i(pts[i][2]));
      g.beginPath(); g.moveTo(sx, sy); g.quadraticCurveTo(pts[i][0], pts[i][1], ex, ey); g.stroke();
      sx = ex; sy = ey;
    }
  }
  // Papierstruktur ausstanzen, verankert am Bildschirm-Raster
  const pat = g.createPattern(paperTooth(), 'repeat');
  pat.setTransform(new DOMMatrix([1, 0, 0, 1, -x0, -y0]));
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'destination-in';
  g.fillStyle = pat; g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'source-over';
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha *= 0.92;
  ctx.drawImage(pencilBuf, 0, 0, W, H, x0, y0, W, H);
  ctx.restore();
}

/* Papiervorlagen. Auf dunklem Papier werden die Hilfslinien hell gezeichnet. */
const BG_NAMES = { blank: 'Blanko', lined: 'Liniert', grid: 'Kariert', dots: 'Punkte', cornell: 'Cornell', music: 'Noten', mm: 'Millimeter', planner: 'Wochenplan' };
function paperDark(p) {
  const n = parseInt((p.paper || '#ffffff').slice(1), 16);
  return (n >> 16 & 255) * 0.3 + (n >> 8 & 255) * 0.59 + (n & 255) * 0.11 < 110;
}
function drawPaper(ctx, p) {
  ctx.fillStyle = p.paper || '#fff'; ctx.fillRect(0, 0, p.w, p.h);
  const dark = paperDark(p);
  const soft = dark ? 'rgba(255,255,255,.14)' : '#dde3ea', line = dark ? 'rgba(255,255,255,.24)' : '#c9d6e3', strong = dark ? 'rgba(255,255,255,.45)' : '#9fb0c2';
  const rule = (x1, y1, x2, y2) => { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); };
  ctx.save();
  if (p.bg === 'lined') {
    ctx.strokeStyle = line; ctx.lineWidth = 0.7; ctx.beginPath();
    for (let y = 80; y < p.h - 30; y += 24) rule(28, y, p.w - 28, y);
    ctx.stroke();
  } else if (p.bg === 'grid') {
    ctx.strokeStyle = soft; ctx.lineWidth = 0.6; ctx.beginPath();
    for (let x = 14.17; x < p.w; x += 14.17) rule(x, 0, x, p.h);
    for (let y = 14.17; y < p.h; y += 14.17) rule(0, y, p.w, y);
    ctx.stroke();
  } else if (p.bg === 'dots') {
    ctx.fillStyle = dark ? 'rgba(255,255,255,.4)' : '#aab4bd';
    for (let x = 17; x < p.w; x += 17) for (let y = 17; y < p.h; y += 17) { ctx.beginPath(); ctx.arc(x, y, 0.9, 0, 7); ctx.fill(); }
  } else if (p.bg === 'cornell') {
    // Cornell-Methode: Stichwortspalte links, Notizen rechts, Zusammenfassung unten
    const cue = p.w * 0.28, top = 84, sum = p.h - 150;
    ctx.strokeStyle = line; ctx.lineWidth = 0.7; ctx.beginPath();
    for (let y = top + 24; y < sum - 6; y += 24) rule(cue + 10, y, p.w - 28, y);
    for (let y = sum + 30; y < p.h - 30; y += 24) rule(28, y, p.w - 28, y);
    ctx.stroke();
    ctx.strokeStyle = strong; ctx.lineWidth = 1.1; ctx.beginPath();
    rule(28, top, p.w - 28, top); rule(cue, top, cue, sum); rule(28, sum, p.w - 28, sum);
    ctx.stroke();
  } else if (p.bg === 'music') {
    ctx.strokeStyle = dark ? 'rgba(255,255,255,.5)' : '#8996a3'; ctx.lineWidth = 0.6; ctx.beginPath();
    for (let y = 70; y + 28 < p.h - 40; y += 76) for (let i = 0; i < 5; i++) rule(36, y + i * 7, p.w - 36, y + i * 7);
    ctx.stroke();
  } else if (p.bg === 'mm') {
    const mm = 72 / 25.4;
    [[1, soft, 0.25], [5, line, 0.45], [10, strong, 0.7]].forEach(([step, col, lw]) => {
      ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.beginPath();
      for (let x = 0; x <= p.w; x += mm * step) rule(x, 0, x, p.h);
      for (let y = 0; y <= p.h; y += mm * step) rule(0, y, p.w, y);
      ctx.stroke();
    });
  } else if (p.bg === 'planner') {
    const days = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
    const x0 = 28, x1 = p.w - 28, top = 70, rowH = (p.h - top - 30) / 7;
    ctx.strokeStyle = strong; ctx.lineWidth = 0.9; ctx.beginPath();
    for (let i = 0; i <= 7; i++) rule(x0, top + i * rowH, x1, top + i * rowH);
    rule(x0, top, x0, top + 7 * rowH); rule(x1, top, x1, top + 7 * rowH); rule(x0 + 92, top, x0 + 92, top + 7 * rowH);
    ctx.stroke();
    ctx.fillStyle = dark ? 'rgba(255,255,255,.7)' : '#5d6b78'; ctx.font = `600 11px ${FONT}`; ctx.textBaseline = 'top';
    days.forEach((d, i) => ctx.fillText(d, x0 + 8, top + i * rowH + 8));
  }
  ctx.restore();
}

function drawStroke(ctx, it) {
  const pts = it.pts, n = pts.length;
  if (!n) return;
  if (it.tool === 'pen' && penStyle(it).grain && ctx.getTransform) return drawPencil(ctx, it);
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = it.color;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (it.tool === 'pen' && penStyle(it).solid) {
    // Rest einer radierten Form: gerade Verbindungen, damit Ecken spitz bleiben
    ctx.lineWidth = it.size;
    if (it.dash) ctx.setLineDash([Math.max(3, it.size * 3), Math.max(3, it.size * 2.5)]);
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    if (n === 1) ctx.lineTo(pts[0][0] + 0.01, pts[0][1]);
    for (let i = 1; i < n; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
  } else if (it.tool === 'marker' || it.tool === 'cover') {
    // Textmarker halbtransparent; Abdecken = deckend in Papierweiß
    ctx.globalAlpha = it.tool === 'marker' ? (it.alpha ?? 0.38) : 1; ctx.lineWidth = it.size;
    if (it.cap) ctx.lineCap = it.cap;                  // an Text eingerastete Markierungen enden gerade
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    if (n === 1) ctx.lineTo(pts[0][0] + 0.01, pts[0][1]);
    for (let i = 1; i < n - 1; i++) {
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
    }
    if (n > 1) ctx.lineTo(pts[n - 1][0], pts[n - 1][1]);
    ctx.stroke();
  } else if (n < 3) {
    const st = penStyle(it), a = n === 2 ? Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0]) : 0;
    for (const [x, y, pr] of pts) { ctx.fillStyle = penPaint(ctx, it, st, pr); ctx.beginPath(); ctx.arc(x, y, st.w(it.size, pr, a) / 2, 0, 7); ctx.fill(); }
    if (n === 2) { ctx.strokeStyle = penPaint(ctx, it, st, pts[1][2]); ctx.lineWidth = st.w(it.size, pts[1][2], a); ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[1][0], pts[1][1]); ctx.stroke(); }
  } else {
    const st = penStyle(it);
    let sx = pts[0][0], sy = pts[0][1];
    for (let i = 1; i < n - 1; i++) {
      const ex = i === n - 2 ? pts[n - 1][0] : (pts[i][0] + pts[i + 1][0]) / 2;
      const ey = i === n - 2 ? pts[n - 1][1] : (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.lineWidth = st.w(it.size, pts[i][2], Math.atan2(ey - sy, ex - sx));
      ctx.strokeStyle = penPaint(ctx, it, st, pts[i][2]);
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.quadraticCurveTo(pts[i][0], pts[i][1], ex, ey); ctx.stroke();
      sx = ex; sy = ey;
    }
  }
  ctx.restore();
}

const closedShape = it => it.kind === 'rect' || it.kind === 'ellipse' || it.kind === 'poly';
function drawShape(ctx, it) {
  ctx.save();
  ctx.strokeStyle = it.color; ctx.lineWidth = it.size; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const { x1, y1, x2, y2 } = it;
  if (it.dash) ctx.setLineDash([Math.max(3, it.size * 3), Math.max(3, it.size * 2.5)]);
  ctx.beginPath();
  if (it.kind === 'poly') { it.pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); }
  else if (it.kind === 'rect') ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
  else if (it.kind === 'ellipse') ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
  else {
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    if (it.kind === 'arrow') {
      const a = Math.atan2(y2 - y1, x2 - x1), L = Math.max(10, it.size * 4.5);
      ctx.moveTo(x2 - L * Math.cos(a - 0.45), y2 - L * Math.sin(a - 0.45)); ctx.lineTo(x2, y2);
      ctx.lineTo(x2 - L * Math.cos(a + 0.45), y2 - L * Math.sin(a + 0.45));
    }
  }
  // helle Füllung immer aus der Linienfarbe berechnen: so werden auch ältere (deckende) helle Füllungen durchscheinend
  if (it.fill && closedShape(it)) { ctx.fillStyle = it.fillMode === 1 ? fillFor(it.color, 1) : it.fill; ctx.fill(); }
  if (!it.noStroke) ctx.stroke();
  ctx.restore();
}

/* Bereichsradierer: Form in Linienzüge (Striche) umwandeln, die sich stückweise radieren lassen.
   Eine Füllung bleibt als eigene Form ohne Rand erhalten. */
function shapeToStrokes(it) {
  const base = { t: 'stroke', tool: 'pen', style: 'shape', color: it.color, size: it.size };
  if (it.dash) base.dash = true;
  const lines = [];
  const { x1, y1, x2, y2 } = it;
  if (it.kind === 'ellipse') {
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2, o = [];
    const n = clamp(Math.ceil(Math.PI * (rx + ry) / 3), 24, 400);
    for (let i = 0; i <= n; i++) o.push([cx + rx * Math.cos(i / n * Math.PI * 2), cy + ry * Math.sin(i / n * Math.PI * 2)]);
    lines.push(o);
  } else if (closedShape(it)) lines.push(shapeOutline(it));
  else {
    lines.push([[x1, y1], [x2, y2]]);
    if (it.kind === 'arrow') {
      const a = Math.atan2(y2 - y1, x2 - x1), L = Math.max(10, it.size * 4.5);
      lines.push([[x2 - L * Math.cos(a - 0.45), y2 - L * Math.sin(a - 0.45)], [x2, y2], [x2 - L * Math.cos(a + 0.45), y2 - L * Math.sin(a + 0.45)]]);
    }
  }
  const out = [];
  if (it.fill && closedShape(it)) out.push({ ...it, id: uid(), noStroke: true });
  lines.forEach((l, i) => out.push({ ...base, id: i ? uid() : it.id, pts: l.map(([x, y]) => [+x.toFixed(2), +y.toFixed(2), 0.5]) }));
  return out;
}
/* Zwischenpunkte einfügen, damit auch lange gerade Abschnitte mittendrin radiert werden können */
function densify(pts, step) {
  const o = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step);
    for (let k = 1; k < n; k++) {
      const t = k / n;
      const pa = a[2] ?? 0.5, pb = b[2] ?? 0.5;
      o.push([+(a[0] + (b[0] - a[0]) * t).toFixed(2), +(a[1] + (b[1] - a[1]) * t).toFixed(2), +(pa + (pb - pa) * t).toFixed(2)]);
    }
    o.push(b);
  }
  return o;
}

const imgCache = new Map();
function getImg(src, cb) {
  let im = imgCache.get(src);
  if (!im) {
    im = new Image(); im._cbs = [];
    im.onload = im.onerror = () => { const c = im._cbs; im._cbs = null; c.forEach(f => f()); };
    im.src = src; imgCache.set(src, im);
  }
  if (im._cbs) { if (cb) im._cbs.push(cb); return null; }
  return im.naturalWidth ? im : null;
}
const loadImages = items => Promise.all(items.filter(i => i.t === 'img').map(i => new Promise(res => { if (getImg(i.src, res)) res(); })));

/* In Zeichenreihenfolge malen: so liegt Abdeck-Weiß über altem Inhalt und neue Schrift darüber */
function drawItems(ctx, items, onImg) {
  for (const it of items) {
    if (it.t === 'img') {
      const im = getImg(it.src, onImg); if (!im) continue;
      if (it.rot) { ctx.save(); ctx.translate(it.x + it.w / 2, it.y + it.h / 2); ctx.rotate(it.rot); ctx.drawImage(im, -it.w / 2, -it.h / 2, it.w, it.h); ctx.restore(); }
      else ctx.drawImage(im, it.x, it.y, it.w, it.h);
    }
    else if (it.t === 'shape') drawShape(ctx, it);
    else if (it.t === 'stroke') drawStroke(ctx, it);
    // Text liegt in derselben Ebenenfolge; das gerade bearbeitete Textfeld zeigt das Eingabefeld selbst
    else if (it.t === 'text' && !(S.editing && S.editing.it.id === it.id)) drawText(ctx, it);
  }
}

function drawText(ctx, it) {
  ctx.save();
  ctx.fillStyle = it.color; ctx.font = `${it.bold ? 700 : 400} ${it.size}px ${FONT}`; ctx.textBaseline = 'alphabetic';
  const lh = it.size * 1.35;
  let y = it.y + (lh - it.size) / 2 + it.size * 0.86;
  for (const para of it.text.split('\n')) {
    let line = '';
    for (const w of para.split(/(\s+)/)) {
      const test = line + w;
      if (line.trim() && ctx.measureText(test.trimEnd()).width > it.w) { ctx.fillText(line.trimEnd(), it.x, y); y += lh; line = w.trimStart(); }
      else line = test;
    }
    ctx.fillText(line, it.x, y); y += lh;
  }
  ctx.restore();
}

/* Alles außer PDF-Hintergrund in einen Kontext malen (Export, Vorschaubild) */
async function paintOverlay(ctx, p, withPaper) {
  if (withPaper) drawPaper(ctx, p);
  await loadImages(p.items);
  drawItems(ctx, p.items);
}

/* ---------------- Geometrie der Elemente ---------------- */
function bbox(it) {
  if (it.t === 'stroke') {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const [x, y] of it.pts) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
    const m = penMaxW(it) / 2; return { x: a - m, y: b - m, w: c - a + 2 * m, h: d - b + 2 * m };
  }
  if (it.t === 'shape' && it.kind === 'poly') {
    const xs = it.pts.map(p => p[0]), ys = it.pts.map(p => p[1]), m = it.size / 2;
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x: x - m, y: y - m, w: Math.max(...xs) - x + 2 * m, h: Math.max(...ys) - y + 2 * m };
  }
  if (it.t === 'shape') {
    const m = it.size / 2;
    return { x: Math.min(it.x1, it.x2) - m, y: Math.min(it.y1, it.y2) - m, w: Math.abs(it.x2 - it.x1) + 2 * m, h: Math.abs(it.y2 - it.y1) + 2 * m };
  }
  if (it.t === 'text') return { x: it.x, y: it.y, w: it.w, h: it.h || it.size * 1.35 };
  if (it.rot) {
    const c = Math.abs(Math.cos(it.rot)), s = Math.abs(Math.sin(it.rot)), w = it.w * c + it.h * s, h = it.w * s + it.h * c;
    return { x: it.x + it.w / 2 - w / 2, y: it.y + it.h / 2 - h / 2, w, h };
  }
  return { x: it.x, y: it.y, w: it.w, h: it.h };
}
function unionBox(bs) {
  const x = Math.min(...bs.map(b => b.x)), y = Math.min(...bs.map(b => b.y));
  return { x, y, w: Math.max(...bs.map(b => b.x + b.w)) - x, h: Math.max(...bs.map(b => b.y + b.h)) - y };
}
const inBox = (b, x, y, m = 0) => x >= b.x - m && x <= b.x + b.w + m && y >= b.y - m && y <= b.y + b.h + m;

function shapeOutline(it) {
  if (it.kind === 'poly') return [...it.pts, it.pts[0]];
  const { x1, y1, x2, y2 } = it;
  if (it.kind === 'rect') return [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]];
  if (it.kind === 'ellipse') {
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2, o = [];
    for (let i = 0; i <= 48; i++) o.push([cx + rx * Math.cos(i / 48 * Math.PI * 2), cy + ry * Math.sin(i / 48 * Math.PI * 2)]);
    return o;
  }
  return [[x1, y1], [x2, y2]];
}
function hitItem(it, x, y, r) {
  if (it.t === 'stroke') {
    if (!inBox(bbox(it), x, y, r)) return false;
    const w = penMaxW(it) / 2 + r, p = it.pts;
    if (p.length === 1) return Math.hypot(p[0][0] - x, p[0][1] - y) < w;
    for (let i = 1; i < p.length; i++) if (segDist(x, y, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]) < w) return true;
    return false;
  }
  if (it.t === 'shape') {
    const o = shapeOutline(it);
    if (it.fill && closedShape(it) && inPoly(x, y, o)) return true;      // gefüllte Formen auch innen treffen
    for (let i = 1; i < o.length; i++) if (segDist(x, y, o[i - 1][0], o[i - 1][1], o[i][0], o[i][1]) < r + it.size / 2) return true;
    return false;
  }
  return inBox(bbox(it), x, y);
}
/* Element verschieben/skalieren (fn, k) und optional um da drehen (fn enthält dann die Drehung).
   Striche und Formen behalten beim Vergrößern ihre Strichstärke (wie in Samsung Notes);
   Text und Bilder wachsen mit. */
function xform(src, fn, k, da = 0, kx = k, ky = k) {
  const it = structuredClone(src);
  if (it.t === 'stroke') { it.pts = it.pts.map(([x, y, pr]) => { const [a, b] = fn(x, y); return [+a.toFixed(2), +b.toFixed(2), pr]; }); }
  else if (it.t === 'shape') {
    // Rechteck/Ellipse lassen sich nur als Vieleck drehen
    if (da && (it.kind === 'rect' || it.kind === 'ellipse')) { it.pts = shapeOutline(it).slice(0, -1); it.kind = 'poly'; }
    if (it.kind === 'poly') it.pts = it.pts.map(([x, y]) => fn(x, y).map(v => +v.toFixed(2)));
    else { [it.x1, it.y1] = fn(it.x1, it.y1); [it.x2, it.y2] = fn(it.x2, it.y2); }
  } else {
    // Bild/Text: Mittelpunkt mitführen; Bilder drehen sich mit, Textfelder bleiben gerade
    const h0 = it.t === 'img' ? it.h : (it.h || it.size * 1.35);
    const [cx, cy] = fn(it.x + it.w / 2, it.y + h0 / 2);
    let h1 = h0;
    it.w *= kx;
    if (it.t === 'img') { it.h *= ky; h1 = it.h; if (da) it.rot = ((it.rot || 0) + da) % (Math.PI * 2); }
    else if (kx === ky) { it.size *= k; if (it.h) it.h *= k; h1 = h0 * k; }   // Text: nur gleichmäßig wächst die Schrift
    it.x = cx - it.w / 2; it.y = cy - h1 / 2;
  }
  return it;
}

/* ---------------- Formerkennung (Stift am Ende kurz halten) ---------------- */
function rdp(P, eps) {
  if (P.length < 3) return P;
  const [ax, ay] = P[0], [bx, by] = P[P.length - 1];
  let md = 0, mi = 0;
  for (let i = 1; i < P.length - 1; i++) { const d = segDist(P[i][0], P[i][1], ax, ay, bx, by); if (d > md) { md = d; mi = i; } }
  if (md <= eps) return [P[0], P[P.length - 1]];
  return [...rdp(P.slice(0, mi + 1), eps).slice(0, -1), ...rdp(P.slice(mi), eps)];
}
/* Gerade auf 0°/45°/90° einrasten, wenn sie fast so liegt */
function snapLine(x1, y1, x2, y2) {
  const a = Math.atan2(y2 - y1, x2 - x1), L = Math.hypot(x2 - x1, y2 - y1), s = Math.PI / 4;
  const r = Math.round(a / s) * s;
  return Math.abs(a - r) < 0.09 ? [x1 + L * Math.cos(r), y1 + L * Math.sin(r)] : [x2, y2];
}
function recognizeShape(pts) {
  const P = pts.map(p => [p[0], p[1]]), n = P.length;
  if (n < 4) return null;
  let len = 0; for (let i = 1; i < n; i++) len += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
  const xs = P.map(p => p[0]), ys = P.map(p => p[1]);
  const bx = Math.min(...xs), by = Math.min(...ys), bw = Math.max(...xs) - bx, bh = Math.max(...ys) - by, size = Math.max(bw, bh);
  if (size < 10) return null;
  const chord = Math.hypot(P[n - 1][0] - P[0][0], P[n - 1][1] - P[0][1]);
  if (chord / len > 0.9) {
    const [x2, y2] = snapLine(P[0][0], P[0][1], P[n - 1][0], P[n - 1][1]);
    return { kind: 'line', x1: P[0][0], y1: P[0][1], x2, y2 };
  }
  if (chord > Math.max(0.3 * size, 14)) return null;              // offene Kurve: nichts erkennen
  // Ecken suchen: vereinfachen, dann fast gerade Knicke und zu nahe Punkte entfernen
  let C = rdp([...P, P[0]], size * 0.07).slice(0, -1);
  for (let changed = true; changed && C.length > 2;) {
    changed = false;
    for (let i = 0; i < C.length; i++) {
      const a = C[(i - 1 + C.length) % C.length], b = C[i], c = C[(i + 1) % C.length];
      const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
      const l1 = Math.hypot(...v1), l2 = Math.hypot(...v2);
      const ang = Math.acos(clamp((v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2 || 1), -1, 1));
      if (ang > 2.6 || l1 < size * 0.12) { C.splice(i, 1); changed = true; break; }
    }
  }
  const polyErr = poly => {
    let s = 0; const o = [...poly, poly[0]];
    for (const [x, y] of P) { let d = Infinity; for (let i = 1; i < o.length; i++) d = Math.min(d, segDist(x, y, o[i - 1][0], o[i - 1][1], o[i][0], o[i][1])); s += d; }
    return s / n / size;
  };
  const cx = bx + bw / 2, cy = by + bh / 2, rx = Math.max(bw / 2, 1), ry = Math.max(bh / 2, 1);
  let eErr = 0; for (const [x, y] of P) eErr += Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1);
  eErr = eErr / n * ((rx + ry) / 2) / size;
  const cands = [{ err: eErr, kind: 'ellipse' }];
  if (C.length === 3 || C.length === 4) cands.push({ err: polyErr(C), kind: 'poly' });
  const best = cands.sort((a, b) => a.err - b.err)[0];
  if (best.err > 0.07) return null;
  if (best.kind === 'ellipse') {
    if (Math.abs(bw - bh) < 0.15 * size) { const d = (bw + bh) / 2; return { kind: 'ellipse', x1: cx - d / 2, y1: cy - d / 2, x2: cx + d / 2, y2: cy + d / 2 }; }
    return { kind: 'ellipse', x1: bx, y1: by, x2: bx + bw, y2: by + bh };
  }
  if (C.length === 4) {
    // fast achsenparalleles Viereck → sauberes Rechteck
    const axis = C.every((p, i) => { const q = C[(i + 1) % 4], a = Math.abs(Math.atan2(q[1] - p[1], q[0] - p[0])) % (Math.PI / 2); return a < 0.26 || a > Math.PI / 2 - 0.26; });
    if (axis) {
      const qx = C.map(p => p[0]).sort((a, b) => a - b), qy = C.map(p => p[1]).sort((a, b) => a - b);
      return { kind: 'rect', x1: (qx[0] + qx[1]) / 2, y1: (qy[0] + qy[1]) / 2, x2: (qx[2] + qx[3]) / 2, y2: (qy[2] + qy[3]) / 2 };
    }
  }
  return { kind: 'poly', pts: C.map(([x, y]) => [+x.toFixed(2), +y.toFixed(2)]) };
}

/* ---------------- Seiten im Editor ---------------- */
const wrap = $('#pagesWrap'), pagesHost = $('#pages');
const dpr = () => window.devicePixelRatio || 1;
function baseScale() {
  const maxW = Math.max(...S.note.pages.map(p => p.w));
  return clamp((wrap.clientWidth - 32) / maxW, 0.2, 1.6);
}
const scale = () => baseScale() * S.zoom;
const ratio = p => Math.min(scale() * dpr(), Math.sqrt(6e6 / (p.w * p.h)));
function sizeCanvas(c, p, r) {
  const W = Math.round(p.w * r), H = Math.round(p.h * r);
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; return true; }
  return false;
}

const io = new IntersectionObserver(entries => {
  for (const en of entries) {
    const pe = elToPe.get(en.target); if (!pe) continue;
    pe.visible = en.isIntersecting;
    if (!pe.visible) freePage(pe);
  }
  scheduleRender();
}, { root: wrap, rootMargin: '700px 0px' });

function addPageEl(p, beforeEl = null) {
  const el = document.createElement('div');
  el.className = 'page'; el.dataset.id = p.id;
  el.innerHTML = '<canvas class="bg"></canvas><canvas class="ink"></canvas><canvas class="detail dbg"></canvas><canvas class="detail dink"></canvas><div class="text"></div><canvas class="live"></canvas><span class="pno"></span>';
  const pe = { el, bg: el.children[0], ink: el.children[1], dbg: el.children[2], dink: el.children[3], text: el.children[4], live: el.children[5], sc: null, visible: false, task: null, det: null };
  // Bei knappem Grafikspeicher verwirft Chrome Zeichenflächen (sie werden schwarz/leer): danach neu zeichnen
  for (const c of [pe.bg, pe.ink, pe.dbg, pe.dink, pe.live]) {
    c.addEventListener('contextlost', () => { pe.sc = null; });
    c.addEventListener('contextrestored', () => { pe.sc = null; scheduleRender(); });
  }
  pageEls.set(p.id, pe); elToPe.set(el, pe);
  pagesHost.insertBefore(el, beforeEl); io.observe(el);
  return pe;
}
function buildPages() {
  pageEls.forEach(pe => io.unobserve(pe.el)); pageEls.clear(); pagesHost.innerHTML = '';
  for (const p of S.note.pages) addPageEl(p);
  layout();
}
function freePage(pe) {
  if (pe.task) { pe.task.cancel(); pe.task = null; }
  for (const c of [pe.bg, pe.ink, pe.live]) { c.width = 0; c.height = 0; }
  hideDetail(pe);
  pe.sc = null;
}

/* ---------------- Detail-Ausschnitt beim Zoomen ----------------
   Die ganze Seite wird höchstens in ~6 Mio. Pixeln gezeichnet (Grafikspeicher). Ab etwa 100 % Zoom auf dem
   Tablet reicht das nicht mehr für volle Schärfe. Dann wird zusätzlich nur der sichtbare Ausschnitt (plus Rand)
   in Bildschirmauflösung gezeichnet und über die Seite gelegt: PDF/Papier in dbg, Schrift in dink. */
function hideDetail(pe) {
  if (pe.dtask) { pe.dtask.cancel(); pe.dtask = null; }
  for (const c of [pe.dbg, pe.dink]) { c.width = 0; c.height = 0; c.style.display = 'none'; }
  pe.det = null;
}
const needsDetail = p => scale() * dpr() > ratio(p) * 1.1;
async function renderDetail(pe, p) {
  if (!pe.visible || !needsDetail(p)) return hideDetail(pe);
  const sc = scale(), d = dpr();
  const pr = pe.el.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
  // sichtbarer Teil der Seite in CSS-Pixeln, mit etwas Rand zum Scrollen
  const mx = wr.width * 0.25, my = wr.height * 0.25;
  const vx0 = Math.max(0, wr.left - pr.left - mx), vy0 = Math.max(0, wr.top - pr.top - my);
  const vx1 = Math.min(pr.width, wr.right - pr.left + mx), vy1 = Math.min(pr.height, wr.bottom - pr.top + my);
  if (vx1 <= vx0 || vy1 <= vy0) return hideDetail(pe);
  const W = Math.round((vx1 - vx0) * d), H = Math.round((vy1 - vy0) * d);
  if (W * H > 12e6) return hideDetail(pe);
  const r = sc * d, x0 = vx0 / sc, y0 = vy0 / sc;
  if (pe.dtask) { pe.dtask.cancel(); pe.dtask = null; }
  const det = { x0, y0, r, sc };
  // Hintergrund erst in einen Zwischenpuffer, damit beim Neuzeichnen nichts aufblitzt
  const off = document.createElement('canvas'); off.width = W; off.height = H;
  const octx = off.getContext('2d');
  if (p.pdf != null && S.pdf) {
    octx.fillStyle = '#fff'; octx.fillRect(0, 0, W, H);
    const page = await S.pdf.getPage(p.pdf + 1);
    const task = page.render({ canvasContext: octx, viewport: page.getViewport({ scale: r, offsetX: -x0 * r, offsetY: -y0 * r }) });
    pe.dtask = task;
    try { await task.promise; } catch { return; }
    if (pe.dtask !== task) return;
    pe.dtask = null;
  } else {
    octx.setTransform(r, 0, 0, r, -x0 * r, -y0 * r); drawPaper(octx, p);
  }
  if (!pe.visible || scale() !== sc) return;                 // inzwischen gezoomt: der nächste Durchgang zeichnet neu
  for (const c of [pe.dbg, pe.dink]) {
    c.width = W; c.height = H;
    Object.assign(c.style, { display: 'block', left: vx0 + 'px', top: vy0 + 'px', width: (vx1 - vx0) + 'px', height: (vy1 - vy0) + 'px', right: 'auto', bottom: 'auto' });
  }
  pe.dbg.getContext('2d').drawImage(off, 0, 0);
  pe.det = det;
  renderDetailInk(pe, p);
}
function detailCtx(pe) {
  const { x0, y0, r } = pe.det, ctx = pe.dink.getContext('2d');
  ctx.setTransform(r, 0, 0, r, -x0 * r, -y0 * r);
  return ctx;
}
function renderDetailInk(pe, p) {
  if (!pe.det) return;
  const ctx = pe.dink.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, pe.dink.width, pe.dink.height);
  drawItems(detailCtx(pe), p.items, () => renderDetailInk(pe, p));
}
let detailT = 0;
function scheduleDetail() {
  clearTimeout(detailT);
  detailT = setTimeout(() => {
    if (!S.note || act) return;
    for (const p of S.note.pages) { const pe = pageEls.get(p.id); if (pe && pe.visible) renderDetail(pe, p); }
  }, 160);
}
wrap.addEventListener('scroll', () => { if (S.note && S.note.pages.some(needsDetail)) scheduleDetail(); }, { passive: true });

function layout() {
  const sc = scale();
  S.note.pages.forEach((p, i) => {
    const pe = pageEls.get(p.id);
    if (pe.det && pe.det.sc !== sc) hideDetail(pe);          // Zoom geändert: alter Ausschnitt passt nicht mehr
    pe.el.style.width = p.w * sc + 'px'; pe.el.style.height = p.h * sc + 'px';
    pe.el.lastChild.textContent = `${i + 1} / ${S.note.pages.length}`;
    pe.el.classList.toggle('marked', !!p.mark);
    renderText(pe, p);
  });
  renderSel(); renderCompass(); scheduleRender();
}
let renderT;
function scheduleRender() { clearTimeout(renderT); renderT = setTimeout(renderVisible, 90); }
function renderVisible() {
  if (!S.note) return;
  const sc = scale();
  for (const p of S.note.pages) {
    const pe = pageEls.get(p.id);
    if (pe && pe.visible && pe.sc !== sc) { pe.sc = sc; renderBg(pe, p); renderInk(pe, p); }
  }
  scheduleDetail();
}
async function renderBg(pe, p) {
  const r = ratio(p);
  if (pe.task) { pe.task.cancel(); pe.task = null; }
  if (p.pdf == null || !S.pdf) {
    sizeCanvas(pe.bg, p, r);
    const ctx = pe.bg.getContext('2d'); ctx.setTransform(r, 0, 0, r, 0, 0); drawPaper(ctx, p);
    return;
  }
  const page = await S.pdf.getPage(p.pdf + 1);
  const vp = page.getViewport({ scale: r });
  const off = document.createElement('canvas');
  off.width = Math.round(p.w * r); off.height = Math.round(p.h * r);
  const octx = off.getContext('2d'); octx.fillStyle = '#fff'; octx.fillRect(0, 0, off.width, off.height);
  const task = page.render({ canvasContext: octx, viewport: vp });
  pe.task = task;
  try { await task.promise; } catch { return; }
  if (pe.task !== task) return;
  pe.task = null;
  if (!pe.visible) return;
  sizeCanvas(pe.bg, p, r);
  pe.bg.getContext('2d').drawImage(off, 0, 0);
}
function renderInk(pe, p) {
  if (!pe.visible) return;
  if (pe.inkRaf) { cancelAnimationFrame(pe.inkRaf); pe.inkRaf = 0; }
  const r = ratio(p);
  sizeCanvas(pe.ink, p, r);
  const ctx = pe.ink.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, pe.ink.width, pe.ink.height);
  ctx.setTransform(r, 0, 0, r, 0, 0);
  drawItems(ctx, p.items, () => renderInk(pe, p));
  renderDetailInk(pe, p);
}
/* Höchstens einmal pro Bildschirmbild neu zeichnen (Radieren, Verschieben, Drehen) */
function renderInkSoon(pe, p) {
  if (!pe.visible || pe.inkRaf) return;
  pe.inkRaf = requestAnimationFrame(() => { pe.inkRaf = 0; renderInk(pe, p); });
}
/* Nur einen Bereich neu zeichnen (Radieren, Verschieben): geänderte Rechtecke sammeln und einmal pro
   Bildschirmbild nur dort löschen und die Elemente zeichnen, die hineinragen. Viel schneller als die ganze Seite. */
function renderRegionSoon(pe, p, box) {
  if (!pe.visible || !box) return;
  pe.dirty = pe.dirty ? unionBox([pe.dirty, box]) : box;
  if (pe.regRaf || pe.inkRaf) return;                    // ein ganzes Neuzeichnen ist ohnehin geplant
  pe.regRaf = requestAnimationFrame(() => {
    pe.regRaf = 0;
    const b = pe.dirty; pe.dirty = null;
    if (b) renderRegion(pe, p, b);
  });
}
function renderRegion(pe, p, b) {
  const r = ratio(p);
  if (pe.ink.width !== Math.round(p.w * r) || pe.ink.height !== Math.round(p.h * r)) return renderInk(pe, p);
  const items = p.items.filter(it => overlaps(bbox(it), b));
  const paint = (ctx, scale, ox = 0, oy = 0) => {
    // auf ganze Pixel runden: halb gelöschte Randpixel würden sonst als feine Nahtlinie sichtbar
    const m = 2 / scale, x = Math.floor((b.x - m - ox) * scale) / scale + ox, y = Math.floor((b.y - m - oy) * scale) / scale + oy;
    const w = Math.ceil((b.x + b.w + m - ox) * scale) / scale + ox - x, h = Math.ceil((b.y + b.h + m - oy) * scale) / scale + oy - y;
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.clearRect(x, y, w, h);
    drawItems(ctx, items, () => renderInk(pe, p));
    ctx.restore();
  };
  const ctx = pe.ink.getContext('2d'); ctx.setTransform(r, 0, 0, r, 0, 0);
  paint(ctx, r);
  if (pe.det) paint(detailCtx(pe), pe.det.r, pe.det.x0, pe.det.y0);
}
/* Neue Elemente liegen ganz oben: nur sie dazuzeichnen statt die ganze Seite neu */
function drawAdded(pe, p, items) {
  if (!pe.visible) return;
  const r = ratio(p);
  if (pe.inkRaf || pe.ink.width !== Math.round(p.w * r) || pe.ink.height !== Math.round(p.h * r)) return renderInk(pe, p);
  const ctx = pe.ink.getContext('2d'); ctx.setTransform(r, 0, 0, r, 0, 0);
  drawItems(ctx, items, () => renderInk(pe, p));
  if (pe.det) drawItems(detailCtx(pe), items, () => renderDetailInk(pe, p));
}
function renderText(pe, p) {
  const sc = scale();
  const have = new Map([...pe.text.children].map(n => [n.dataset.id, n]));
  for (const it of p.items) {
    if (it.t !== 'text') continue;
    let n = have.get(it.id);
    if (n) have.delete(it.id);
    else { n = document.createElement('div'); n.className = 'tx'; n.dataset.id = it.id; pe.text.appendChild(n); }
    Object.assign(n.style, {
      left: it.x * sc + 'px', top: it.y * sc + 'px', width: it.w * sc + 'px',
      // nur das Eingabefeld beim Tippen ist sichtbar; sonst zeichnet der Canvas den Text in der richtigen Ebene
      fontSize: it.size * sc + 'px', color: S.editing && S.editing.it.id === it.id ? it.color : 'transparent', fontWeight: it.bold ? '700' : '400'
    });
    if (!(S.editing && S.editing.it.id === it.id)) n.textContent = it.text;
    it.h = n.offsetHeight / sc || it.size * 1.35;
  }
  have.forEach(n => n.remove());
}
function refreshPage(p) {
  const pe = pageEls.get(p.id); if (!pe) return;
  renderInk(pe, p); renderText(pe, p);
}
function currentPage() {
  const r = wrap.getBoundingClientRect(), cy = r.top + r.height / 2;
  let best = S.note.pages[0], bd = Infinity;
  for (const p of S.note.pages) {
    const b = pageEls.get(p.id).el.getBoundingClientRect();
    const d = cy < b.top ? b.top - cy : cy > b.bottom ? cy - b.bottom : 0;
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
/* Zoomen um einen Bildschirmpunkt. Gemerkt wird, welcher Punkt der Seite dort liegt (anchor); nach dem
   neuen Layout wird so gescrollt, dass genau dieser Seitenpunkt wieder unter (cx, cy) liegt. Das stimmt
   auch, wenn die Seite zentriert ist oder schmaler als der Bildschirm (die alte Rechnung ging von einer
   links beginnenden Fläche aus, dadurch rutschte das Bild beim Zoomen nach rechts). */
function zoomAnchor(cx, cy) {
  const p = pageAt(cx, cy) || currentPage();
  const [x, y] = toPage(p, cx, cy);
  return { p, x, y };
}
function setZoom(z, cx, cy, anchor = null) {
  const a = anchor || zoomAnchor(cx, cy);
  S.zoom = clamp(z, 0.5, 5);
  layout();
  const r = pageEls.get(a.p.id).el.getBoundingClientRect(), k = r.width / a.p.w;
  wrap.scrollLeft += r.left + a.x * k - cx;
  wrap.scrollTop += r.top + a.y * k - cy;
}

/* ---------------- Verlauf & Speichern ---------------- */
/* Verlauf: gespeichert werden flache Kopien der Elementliste (keine Textkopien aller Striche).
   Dafür werden Elemente nie an Ort und Stelle verändert, sondern bei Änderungen ersetzt. */
const snap = p => p.items.slice();
function commit(p, before) {
  if (typeof before === 'string') before = JSON.parse(before);
  if (before.length === p.items.length && before.every((x, i) => x === p.items[i])) return;
  const after = snap(p);
  S.undo.push({ pid: p.id, before, after });
  if (S.undo.length > 60) S.undo.shift();
  S.redo.length = 0;
  updUndo(); markDirty(); queueThumb(p.id);
}
/* Ein Verlaufsschritt über mehrere Seiten (z. B. Auswahl auf eine andere Seite gezogen) */
function commitMulti(befores) {
  const multi = [];
  for (const [pid, before] of befores) {
    const p = pageById(pid); if (!p) continue;
    if (before.length === p.items.length && before.every((x, i) => x === p.items[i])) continue;
    multi.push({ pid, before, after: snap(p) });
  }
  if (!multi.length) return;
  S.undo.push(multi.length === 1 ? multi[0] : { multi });
  if (S.undo.length > 60) S.undo.shift();
  S.redo.length = 0;
  updUndo(); markDirty(); multi.forEach(m => queueThumb(m.pid));
}
function applyHist(from, to, key) {
  commitText();
  const h = from.pop(); if (!h) return;
  if (h.multi) {
    setSel(null);
    for (const m of h.multi) { const p = pageById(m.pid); if (p) { p.items = m[key].slice(); refreshPage(p); queueThumb(p.id); } }
    markDirty(); to.push(h); updUndo(); return;
  }
  if (h.pages) {
    // Seiten-Änderung (einfügen, löschen, verschieben …): ganze Seitenliste zurücksetzen
    const st = wrap.scrollTop;
    S.note.pages = JSON.parse(h[key]); setSel(null);
    buildPages(); buildPanel(); wrap.scrollTop = st; markDirty();
    to.push(h); updUndo(); return;
  }
  const p = pageById(h.pid);
  if (p) { p.items = h[key].slice(); setSel(null); refreshPage(p); markDirty(); queueThumb(p.id); }
  to.push(h); updUndo();
}
const undo = () => applyHist(S.undo, S.redo, 'before');
const redo = () => applyHist(S.redo, S.undo, 'after');
function updUndo() { $('#btnUndo').disabled = !S.undo.length; $('#btnRedo').disabled = !S.redo.length; }

function markDirty() {
  S.fileDirty = true; S.note.unsaved = true; updState();
  clearTimeout(S.saveT); S.saveT = setTimeout(saveLocal, 1500);
}
async function saveLocal() {
  clearTimeout(S.saveT);
  if (!S.note) return;
  // nicht mitten im Strich speichern: kurz warten, bis der Stift abgehoben ist
  if (act && !document.hidden) { S.saveT = setTimeout(saveLocal, 800); return; }
  S.note.updated = Date.now();
  try { await dbPut('notes', S.note); } catch (e) { toast('Lokales Speichern fehlgeschlagen: ' + e.message); }
}
function updState() {
  const el = $('#saveState');
  if (!S.note) return;
  if (S.handle) {
    el.textContent = S.fileDirty ? 'Änderungen noch nicht in der Datei' : 'Gespeichert in ' + S.handle.name;
    el.classList.toggle('dirty', S.fileDirty);
  } else {
    el.textContent = S.note.fileName ? 'Nur auf diesem Gerät · Original: ' + S.note.fileName : 'Nur auf diesem Gerät';
    el.classList.remove('dirty');
  }
  $('#btnSave').textContent = S.handle ? 'Speichern' : 'Als PDF speichern';
}

const pdfName = () => (S.note.title || 'Notiz').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]+/g, '-') + '.pdf';

/* ---------------- PDF-Export: Striche als echte Linien ----------------
   PdfCtx versteht den Teil der Canvas-Befehle, den drawPaper/drawStroke/drawShape benutzen, und schreibt
   daraus PDF-Zeichenbefehle. So bleibt Schrift in der gespeicherten PDF bei jedem Zoom scharf.
   Nur Bleistift-Körnung und Text werden weiterhin als Bild eingebettet. */
function parseColor(c) {
  if (typeof c !== 'string') return null;
  let m;
  if ((m = /^#([0-9a-f]{3})$/i.exec(c))) return [...m[1]].map(h => parseInt(h + h, 16) / 255).concat(1);
  if ((m = /^#([0-9a-f]{6})$/i.exec(c))) { const n = parseInt(m[1], 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255, 1]; }
  if ((m = /^rgba?\(([^)]+)\)$/i.exec(c))) { const v = m[1].split(',').map(Number); return [v[0] / 255, v[1] / 255, v[2] / 255, v[3] ?? 1]; }
  return null;
}
class PdfCtx {
  constructor(doc, page) {
    this.doc = doc; this.page = page; this.ops = []; this.path = []; this.stack = []; this.gs = new Map(); this.cur = {};
    Object.assign(this, { fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', globalAlpha: 1, font: '', textBaseline: 'alphabetic', dash: [] });
  }
  save() { const { fillStyle, strokeStyle, lineWidth, lineCap, lineJoin, globalAlpha, font, textBaseline, dash } = this; this.stack.push({ fillStyle, strokeStyle, lineWidth, lineCap, lineJoin, globalAlpha, font, textBaseline, dash }); }
  restore() { Object.assign(this, this.stack.pop()); }
  setLineDash(d) { this.dash = d; }
  beginPath() { this.path = []; }
  moveTo(x, y) { this.path.push(PDFLib.moveTo(x, y)); this.px = x; this.py = y; }
  lineTo(x, y) { this.path.push(PDFLib.lineTo(x, y)); this.px = x; this.py = y; }
  closePath() { this.path.push(PDFLib.closePath()); }
  quadraticCurveTo(cx, cy, x, y) {
    const { px, py } = this;
    this.path.push(PDFLib.appendBezierCurve(px + 2 / 3 * (cx - px), py + 2 / 3 * (cy - py), x + 2 / 3 * (cx - x), y + 2 / 3 * (cy - y), x, y));
    this.px = x; this.py = y;
  }
  rect(x, y, w, h) { this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.closePath(); }
  ellipse(cx, cy, rx, ry) {
    const k = 0.5522847498;
    this.moveTo(cx + rx, cy);
    this.path.push(PDFLib.appendBezierCurve(cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry),
      PDFLib.appendBezierCurve(cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy),
      PDFLib.appendBezierCurve(cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry),
      PDFLib.appendBezierCurve(cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy), PDFLib.closePath());
  }
  arc(cx, cy, r) { this.ellipse(cx, cy, r, r); }                // im Code kommen nur volle Kreise vor
  // Zustand nur schreiben, wenn er sich geändert hat (hält die Datei klein)
  set(key, val, op) { if (this.cur[key] !== val) { this.cur[key] = val; this.ops.push(op()); } }
  alpha(a, stroke) {
    a = Math.round(clamp(a, 0, 1) * 100) / 100;
    const id = (stroke ? 'S' : 'F') + a;
    if (!this.gs.has(id)) this.gs.set(id, this.page.node.newExtGState('GS', this.doc.context.obj(stroke ? { CA: a } : { ca: a })));
    this.set(stroke ? 'CA' : 'ca', a, () => PDFLib.setGraphicsState(this.gs.get(id)));
  }
  stroke() {
    const c = parseColor(this.strokeStyle); if (!c) throw new Error('Farbe nicht als Linie darstellbar');
    this.set('sc', c.slice(0, 3).join(), () => PDFLib.setStrokingRgbColor(c[0], c[1], c[2]));
    this.alpha(c[3] * this.globalAlpha, true);
    this.set('lw', this.lineWidth, () => PDFLib.setLineWidth(this.lineWidth));
    this.set('lc', this.lineCap, () => PDFLib.setLineCap({ butt: 0, round: 1, square: 2 }[this.lineCap] ?? 0));
    this.set('lj', this.lineJoin, () => PDFLib.setLineJoin({ miter: 0, round: 1, bevel: 2 }[this.lineJoin] ?? 0));
    this.set('d', this.dash.join(), () => PDFLib.setDashPattern(this.dash, 0));
    this.ops.push(...this.path, PDFLib.stroke());
  }
  fill() {
    const c = parseColor(this.fillStyle); if (!c) throw new Error('Farbe nicht als Fläche darstellbar');
    this.set('fc', c.slice(0, 3).join(), () => PDFLib.setFillingRgbColor(c[0], c[1], c[2]));
    this.alpha(c[3] * this.globalAlpha, false);
    this.ops.push(...this.path, PDFLib.fill());
  }
  fillRect(x, y, w, h) { const keep = this.path; this.path = []; this.rect(x, y, w, h); this.fill(); this.path = keep; }
  fillText(text, x, y) {
    const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] || 11), c = parseColor(this.fillStyle) || [0, 0, 0, 1];
    this.set('fc', c.slice(0, 3).join(), () => PDFLib.setFillingRgbColor(c[0], c[1], c[2]));
    this.alpha(c[3] * this.globalAlpha, false);
    const dy = this.textBaseline === 'top' ? size * 0.8 : 0;
    // Die Seite ist für die Zeichenbefehle gespiegelt (y nach unten); Text dafür lokal zurückspiegeln
    this.ops.push(PDFLib.pushGraphicsState(), PDFLib.concatTransformationMatrix(1, 0, 0, -1, x, y + dy), PDFLib.beginText(),
      PDFLib.setFontAndSize(this.fontKey, size), PDFLib.showText(this.fontObj.encodeText(text)), PDFLib.endText(), PDFLib.popGraphicsState());
  }
  drawXObject(ref, mats) {
    const key = this.page.node.newXObject('Img', ref);
    this.ops.push(PDFLib.pushGraphicsState(), ...mats.map(m => PDFLib.concatTransformationMatrix(...m)), PDFLib.drawObject(key), PDFLib.popGraphicsState());
    this.cur = {};
  }
}
const needsRaster = it => it.t === 'text' || (it.t === 'stroke' && it.tool === 'pen' && !!penStyle(it).grain);
function dataUrlBytes(url) { return b64decode(url.slice(url.indexOf(',') + 1)); }

/* Ausschnitt mit den übergebenen Elementen als PNG rendern (für Bleistift und Text) */
async function rasterPatch(out, p, items, asText) {
  const b = unionBox(items.map(bbox)), m = 3;
  const x = Math.max(0, b.x - m), y = Math.max(0, b.y - m), w = Math.min(p.w, b.x + b.w + m) - x, h = Math.min(p.h, b.y + b.h + m) - y;
  if (w <= 0 || h <= 0) return null;
  const R = Math.min(3, Math.sqrt(12e6 / (w * h)));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * R)); c.height = Math.max(1, Math.round(h * R));
  const ctx = c.getContext('2d'); ctx.setTransform(R, 0, 0, R, -x * R, -y * R);
  if (asText) items.forEach(it => drawText(ctx, it)); else drawItems(ctx, items);
  const png = await new Promise(res => c.toBlob(bl => bl.arrayBuffer().then(res), 'image/png'));
  return { img: await out.embedPng(png), x, y, w, h };
}

async function exportOverlay(out, pg, p, withPaper) {
  const cb = pg.getCropBox(), W = cb.width, H = cb.height;
  const rot = ((pg.getRotation().angle % 360) + 360) % 360;
  // Anzeige-Koordinaten (Ursprung oben links, y nach unten) → PDF-Koordinaten der evtl. gedrehten Seite
  const base = rot === 90 ? [0, 1, 1, 0, cb.x, cb.y] : rot === 180 ? [-1, 0, 0, 1, cb.x + W, cb.y]
    : rot === 270 ? [0, -1, -1, 0, cb.x + W, cb.y + H] : [1, 0, 0, -1, cb.x, cb.y + H];
  try {
    const v = new PdfCtx(out, pg);
    if (withPaper) {
      if (p.bg === 'planner') {
        v.fontObj = out._nbFont ||= await out.embedFont(PDFLib.StandardFonts.HelveticaBold);
        v.fontKey = pg.node.newFontDictionary('F', v.fontObj.ref);
      }
      drawPaper(v, p);
    }
    await loadImages(p.items);
    let batch = [];
    const flush = async asText => {
      if (!batch.length) return;
      const r = await rasterPatch(out, p, batch, asText); batch = [];
      if (r) v.drawXObject(r.img.ref, [[r.w, 0, 0, -r.h, r.x, r.y + r.h]]);
    };
    const embedded = out._nbImgs ||= new Map();
    for (const it of p.items) {
      if (needsRaster(it)) { batch.push(it); continue; }
      await flush(false);
      if (it.t === 'img') {
        // Fotos unverändert einbetten statt neu zu rastern
        if (!embedded.has(it.src)) embedded.set(it.src, await (it.src.startsWith('data:image/svg') ? out.embedPng(await svgToPng(it.src, it.w, it.h))
          : it.src.startsWith('data:image/png') ? out.embedPng(dataUrlBytes(it.src)) : out.embedJpg(dataUrlBytes(it.src))));
        const c = Math.cos(it.rot || 0), s = Math.sin(it.rot || 0);
        v.drawXObject(embedded.get(it.src).ref, [[1, 0, 0, 1, it.x + it.w / 2, it.y + it.h / 2], [c, s, -s, c, 0, 0], [it.w, 0, 0, -it.h, -it.w / 2, it.h / 2]]);
      } else if (it.t === 'shape') drawShape(v, it);
      else drawStroke(v, it);
    }
    await flush(false);
    if (!v.ops.length) return;
    pg.node.normalize();
    pg.pushOperators(PDFLib.pushGraphicsState(), PDFLib.concatTransformationMatrix(...base), ...v.ops, PDFLib.popGraphicsState());
  } catch (err) {
    // Sicherheitsnetz: klappt die Linien-Ausgabe nicht, die Seite wie früher als Bild speichern
    console.warn('Vektor-Export fehlgeschlagen, nutze Bild:', err);
    const R = Math.min(2.6, Math.sqrt(14e6 / (p.w * p.h)));
    const c = document.createElement('canvas');
    c.width = Math.round(p.w * R); c.height = Math.round(p.h * R);
    const ctx = c.getContext('2d'); ctx.setTransform(R, 0, 0, R, 0, 0);
    await paintOverlay(ctx, p, withPaper);
    const png = await new Promise(res => c.toBlob(b => b.arrayBuffer().then(res), 'image/png'));
    const img = await out.embedPng(png), { degrees } = PDFLib;
    pg.drawImage(img, rot === 90 ? { x: cb.x + W, y: cb.y, width: H, height: W, rotate: degrees(90) }
      : rot === 180 ? { x: cb.x + W, y: cb.y + H, width: W, height: H, rotate: degrees(180) }
      : rot === 270 ? { x: cb.x, y: cb.y + H, width: H, height: W, rotate: degrees(270) }
      : { x: cb.x, y: cb.y, width: W, height: H });
  }
}
async function buildPdf() {
  const { PDFDocument } = PDFLib;
  const out = await PDFDocument.create();
  const src = S.origBytes ? await PDFDocument.load(S.origBytes, { ignoreEncryption: true }) : null;
  for (const p of S.note.pages) {
    let pg;
    if (p.pdf != null && src) { [pg] = await out.copyPages(src, [p.pdf]); out.addPage(pg); }
    else pg = out.addPage([p.w, p.h]);
    if (p.pdf != null && src && !p.items.length) continue;
    await exportOverlay(out, pg, p, p.pdf == null || !src);
  }
  out.setTitle(S.note.title || 'Notiz');
  if (prefs.editable) {
    // Fingerabdruck der fertigen Seiten: verrät später, ob eine andere App die Datei verändert hat
    const sig = pdfSignature(await PDFDocument.load(await out.save()));
    const data = new TextEncoder().encode(JSON.stringify({ app: 'notizbuch', version: 1, sig, title: S.note.title, pages: S.note.pages }));
    await out.attach(data, DATA_NAME, { mimeType: 'application/json', description: 'Bearbeitbare Schrift (Notizbuch-App)' });
    if (S.origBytes) await out.attach(S.origBytes, ORIG_NAME, { mimeType: 'application/pdf', description: 'Original ohne Anmerkungen (Notizbuch-App)' });
  }
  return out.save();
}

/* Pro Seite: Prüfsumme der Seiteninhalte + Anzahl Anmerkungen */
function pdfSignature(doc) {
  const { PDFArray, PDFRef, PDFRawStream } = PDFLib;
  const fnv = (h, b) => { for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619) >>> 0; } return h; };
  return doc.getPages().map(pg => {
    let h = 2166136261;
    const c = pg.node.Contents();
    for (let part of c instanceof PDFArray ? c.asArray() : c ? [c] : []) {
      if (part instanceof PDFRef) part = doc.context.lookup(part);
      if (part instanceof PDFRawStream) h = fnv(h, part.contents);
      else if (part && part.getContents) h = fnv(h, part.getContents());
    }
    const an = pg.node.Annots();
    return h.toString(36) + '.' + (an ? an.size() : 0);
  }).join('|');
}

function downloadBytes(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function setFileClean() { S.fileDirty = false; S.note.unsaved = false; }

/* pickNew = „Speichern unter“: neue Datei wählen; die Notiz gehört danach zu dieser Datei. */
/* Fertige PDF-Bytes prüfen, bevor sie eine Datei überschreiben dürfen */
function checkPdf(bytes) {
  const head = new TextDecoder().decode(bytes.subarray(0, 5)), tail = new TextDecoder().decode(bytes.subarray(-32));
  if (bytes.length < 200 || head !== '%PDF-' || !tail.includes('%%EOF')) throw new Error('Die erzeugte PDF ist unvollständig. Die Datei wurde nicht verändert.');
  return bytes;
}

/* Hinweis, wenn der gewählte Dateiname keine Endung .pdf hat. Antwort: 'add' oder 'keep'. */
function askPdfExt(name, mode) {
  const dlg = $('#extDlg'), fixed = name.replace(/\.+$/, '') + '.pdf';
  $('#extMsg').textContent = `„${name}“ hat keine Endung .pdf. Ohne sie erkennen andere Apps (z. B. Nextcloud) die Datei eventuell nicht als PDF.` +
    (mode === 'save' ? ` Der Speicherdialog öffnet sich dann nochmal mit „${fixed}“ – dort nur noch auf Speichern tippen.`
      : ` Du kannst sie als „${fixed}“ neu speichern; die alte Datei ohne Endung kannst du danach in Nextcloud löschen.`);
  dlg.querySelector('[data-x="add"]').textContent = mode === 'save' ? '.pdf anfügen' : `Als „${fixed}“ speichern`;
  return new Promise(res => {
    const done = v => { dlg.removeEventListener('click', onClick); dlg.removeEventListener('cancel', onCancel); if (dlg.open) dlg.close(); res(v); };
    const onClick = e => { const b = e.target.closest('[data-x]'); if (b) done(b.dataset.x); };
    const onCancel = () => done('keep');
    dlg.addEventListener('click', onClick); dlg.addEventListener('cancel', onCancel);
    dlg.showModal();
  });
}

/* Es läuft immer nur ein Speichervorgang; ein zweiter wartet, bis der erste fertig ist. */
let saving = null;
function saveToFile(pickNew = false, suggest = null) {
  if (saving) return saving.then(() => pickNew ? saveToFile(true, suggest) : !S.fileDirty || saveToFile(false));
  saving = doSave(pickNew, suggest).finally(() => { saving = null; });
  return saving.then(r => r === 'perm' ? permFix() : r);
}
const isPermErr = e => e?.name === 'NotAllowedError' || /permission denial|securityexception|not exported|permission/i.test(String(e && e.message));
/* Dialog mit Knöpfen data-<key>="…" öffnen; liefert den Wert des gewählten Knopfs ('cancel' bei Zurück) */
function dialogChoice(dlg, key) {
  return new Promise(res => {
    const done = v => { dlg.removeEventListener('click', onClick); dlg.removeEventListener('cancel', onCancel); if (dlg.open) dlg.close(); res(v); };
    const onClick = e => { const b = e.target.closest(`[data-${key}]`); if (b) done(b.dataset[key]); };
    const onCancel = () => done('cancel');
    dlg.addEventListener('click', onClick); dlg.addEventListener('cancel', onCancel);
    dlg.showModal();
  });
}
/* Originaldatei nicht mehr beschreibbar: dieselbe Datei über die Dateiauswahl neu wählen lassen.
   Über die Dateiauswahl bekommt die App eine dauerhafte Erlaubnis und überschreibt dann direkt das Original. */
async function permFix() {
  const name = S.handle?.name || pdfName();
  $('#permMsg').textContent = `Die App darf „${name}“ gerade nicht mehr überschreiben. Das passiert bei Dateien, die über „Öffnen mit“ aus einer anderen App (z. B. Nextcloud) kamen, sobald die Notizbuch-App neu gestartet oder aktualisiert wurde. Deine Notiz ist sicher in der App gespeichert. ` +
    `Tippe auf „Original auswählen …“ und wähle dieselbe Datei noch einmal aus – danach speichert die App dauerhaft direkt hinein.`;
  const choice = await dialogChoice($('#permDlg'), 'p');
  if (choice === 'new') return saveToFile(true, name);
  if (choice !== 'pick') return false;
  let h;
  try { [h] = await window.showOpenFilePicker({ types: [{ description: 'PDF-Dokument', accept: { 'application/pdf': ['.pdf'], 'application/octet-stream': ['.pdf'] } }] }); }
  catch { return false; }
  if (h.name !== name) { toast(`Du hast „${h.name}“ gewählt, nicht „${name}“. Zum Überschreiben bitte genau die Originaldatei wählen.`, 7000); return false; }
  if ((await h.queryPermission({ mode: 'readwrite' })) !== 'granted') { toast('Diese Datei darf die App nur lesen. Wähle „Als neue Datei …“.', 6000); return false; }
  S.handle = h; await dbPut('handles', { id: S.note.id, handle: h });
  return saveToFile(false);
}
async function doSave(pickNew, suggest) {
  commitText();
  const btn = $('#btnSave'); btn.disabled = true;
  let created = null, lock = null, h = null;
  // Die PDF schon erzeugen, während der Speicherdialog offen ist: so liegt keine halb angelegte Datei herum
  const bytesP = buildPdf().then(checkPdf);
  bytesP.catch(() => {});
  try {
    if (!FSA) {
      downloadBytes(await bytesP, pdfName());
      setFileClean();
      toast('PDF wurde heruntergeladen.');
      return true;
    }
    h = pickNew ? null : S.handle;
    if (!h) {
      const name = suggest || (S.handle ? pdfName().replace(/\.pdf$/, ' (bearbeitet).pdf') : pdfName());
      h = created = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'PDF-Dokument', accept: { 'application/pdf': ['.pdf'] } }] });
      // Endung .pdf im Speicherdialog gelöscht (Nextcloud hängt sie nicht selbst an)? Dann die eben angelegte,
      // noch leere Datei entfernen und den Dialog mit „Name.pdf“ erneut öffnen. Umbenennen wird bewusst nicht
      // benutzt: danach fehlt bei manchen Speicherorten die Schreiberlaubnis.
      for (let tries = 0; tries < 2 && !/\.pdf$/i.test(h.name); tries++) {
        if ((await askPdfExt(h.name, 'save')) !== 'add') break;
        const want = h.name.replace(/\.+$/, '') + '.pdf';
        try { await created.remove?.(); } catch {}
        created = null;
        h = created = await window.showSaveFilePicker({ suggestedName: want, types: [{ description: 'PDF-Dokument', accept: { 'application/pdf': ['.pdf'] } }] });
      }
    }
    // Bildschirm während des Speicherns wach halten (erst nach dem Dialog, der braucht den frischen Fingertipp)
    try { lock = await navigator.wakeLock?.request('screen'); } catch {}
    if ((await h.queryPermission({ mode: 'readwrite' })) !== 'granted' && (await h.requestPermission({ mode: 'readwrite' })) !== 'granted')
      throw Object.assign(new Error('Die App darf die Datei nicht überschreiben.'), { name: 'NotAllowedError' });
    $('#saveState').textContent = 'Speichert … bitte die App nicht verlassen';
    const bytes = await bytesP;
    const w = await h.createWritable();
    try {
      await w.write(new Blob([bytes], { type: 'application/pdf' }));
      await w.close();
    } catch (err) {
      try { await w.abort(); } catch {}                    // Schreiben abbrechen: die alte Datei bleibt erhalten
      throw err;
    }
    // Gegenprobe: ist die Datei jetzt wirklich so groß wie die erzeugte PDF?
    try {
      // In der Android-App meldet Android die geschriebenen Bytes; die Größe beim Speicherort kann nachhinken (Upload)
      const size = h.native ? h.lastWritten : (await h.getFile()).size;
      if (size !== bytes.length) throw new Error(`Die Datei ist nur ${size} statt ${bytes.length} Bytes groß. Bitte nochmal speichern.`);
    } catch (err) { if (/Bytes groß/.test(err.message)) throw err; }
    created = null;
    if (h !== S.handle) { S.handle = h; await dbPut('handles', { id: S.note.id, handle: h }); }
    S.note.fileName = h.name;
    S.note.title = h.name; $('#noteTitle').value = h.name;   // Titelzeile zeigt den Dateinamen
    setFileClean();
    toast(`In „${h.name}“ gespeichert.`);
    return true;
  } catch (e) {
    // Eine gerade erst angelegte, leere Datei wieder entfernen
    if (created) { try { await created.remove?.(); } catch {} }
    // Schreiberlaubnis für die Originaldatei abgelaufen (typisch nach „Öffnen mit“ aus Nextcloud + App-Neustart):
    // nicht als Fehler melden, sondern anbieten, die Datei neu auszuwählen (siehe permFix)
    if (!created && h && h === S.handle && isPermErr(e)) return 'perm';
    if (e.name !== 'AbortError') toast('Speichern fehlgeschlagen: ' + e.message + (created ? ' Falls eine leere Datei entstanden ist, kannst du sie löschen.' : ''), 8000);
    return false;
  } finally {
    try { await lock?.release(); } catch {}
    btn.disabled = false; updState(); saveLocal();
  }
}

/* ---------------- Eingabe ---------------- */
const touches = new Map();
let gest = null, act = null;

wrap.addEventListener('pointerdown', onDown);
window.addEventListener('pointermove', onMove);
window.addEventListener('pointerup', onUp);
window.addEventListener('pointercancel', onUp);
window.addEventListener('pointerout', penBtnHandler);
wrap.addEventListener('contextmenu', e => e.preventDefault());
wrap.addEventListener('wheel', e => {
  if (!e.ctrlKey || !S.note) return;
  e.preventDefault(); setZoom(S.zoom * Math.exp(-e.deltaY * 0.002), e.clientX, e.clientY);
}, { passive: false });

function pageAt(cx, cy) {
  const el = document.elementFromPoint(cx, cy)?.closest('.page');
  return el && pageById(el.dataset.id);
}
function toPageA(cx, cy) { return [(cx - act.rect.left) / act.k, (cy - act.rect.top) / act.k]; }
function toPage(p, cx, cy) {
  const r = pageEls.get(p.id).el.getBoundingClientRect(), k = r.width / p.w;
  return [(cx - r.left) / k, (cy - r.top) / k];
}
/* S-Pen-Seitentaste: Chrome meldet sie je nach Gerät als rechte Taste (2), als Radierer-Taste (5/32)
   oder sogar als Maus mit rechter Taste. Alles davon schaltet auf Radierer. */
const penButton = e => ((e.pointerType === 'pen' || e.pointerType === 'touch') && (e.button === 2 || e.button === 5 || (e.buttons & 2) || (e.buttons & 32)))
  || (e.pointerType === 'mouse' && (e.button === 2 || (e.buttons & 2)) && navigator.maxTouchPoints > 0);
/* Samsung-Tablets: Seitentaste über dem Display gedrückt → Chrome meldet „gedrückt“ mit Druck 0.
   Der Tastenzustand wird nur aus schwebenden Ereignissen (Druck 0) gelesen; jeder neue Druck schaltet
   zwischen Radierer und Stift um. Wird die Taste beim Aufsetzen noch gehalten, radiert der Stift ebenfalls. */
const hoverButton = e => e.pointerType === 'pen' && e.pressure === 0 && (e.buttons & 1) === 1;
let penBtn = false;

function penBtnHandler(e) {
  if (e.pointerType !== 'pen' || !S.note) return false;
  if (e.type === 'pointerout') { if (!e.relatedTarget) penBtn = false; return false; }
  if (e.pressure === 0 && (e.type === 'pointermove' || e.type === 'pointerdown')) {
    const now = (e.buttons & 1) === 1;
    if (now && !penBtn) toggleEraser();
    penBtn = now;
  }
  const btnAct = act && act.tool === 'btnErase';
  if (e.type === 'pointerup' || e.type === 'pointercancel') {
    if (btnAct) { finishBtnPage(); act = null; return true; }
    return false;
  }
  if (btnAct) {
    if (e.pressure > 0) btnEraseMove(e);
    else { finishBtnPage(); act = null; }               // abgehoben: diese Radier-Berührung ist fertig
    return true;
  }
  if (hoverButton(e)) return true;                       // schwebt mit Taste: nichts zeichnen
  if (penBtn && e.pressure > 0 && !act && wrap.contains(e.target)) {
    act = { tool: 'btnErase', pid: e.pointerId, p: null };
    btnEraseMove(e);
    return true;
  }
  return false;
}
/* S-Pen-Taste: jeder Druck wechselt zwischen Radierer und vorherigem Werkzeug */
let toolBeforeEraser = 'pen', lastToggle = 0;
function toggleEraser() {
  const t = performance.now();
  if (t - lastToggle < 300) return;                      // Flackern der Tastenmeldung ignorieren
  lastToggle = t;
  if (prefs.tool === 'eraser') { setTool(toolBeforeEraser); toast('Stift aktiv', 1200); }
  else { toolBeforeEraser = prefs.tool; setTool('eraser'); toast('Radierer aktiv. Taste nochmal drücken für den Stift.', 1600); }
}
function btnEraseMove(e) {
  const erasing = e.pressure > 0;
  const p = pageAt(e.clientX, e.clientY);
  if (p && p !== act.p) {
    finishBtnPage();
    const pe = pageEls.get(p.id), rect = pe.el.getBoundingClientRect();
    Object.assign(act, { p, pe, rect, k: rect.width / p.w, before: snap(p), changed: false, ctx: prepLive(pe, p), ex: undefined, ey: undefined });
  }
  if (!act.p) return;
  const [x, y] = toPageA(e.clientX, e.clientY);
  if (erasing) {
    const mode = prefs.emode;
    if (mode === 'cover') prefs.emode = 'area';
    eraseAt(x, y);
    prefs.emode = mode;
  } else { act.ex = undefined; act.ey = undefined; }
  drawEraser(x, y);
}
function finishBtnPage() {
  if (!act.p) return;
  clearLive(act.pe);
  if (act.changed) commit(act.p, act.before);
}

/* Schwung beim Scrollen: nach schnellem Wischen läuft die Seite weiter und bremst sanft ab */
let fling = 0;
function stopFling() { if (fling) { cancelAnimationFrame(fling); fling = 0; } }
function startFling(vx, vy) {
  stopFling();
  let last = performance.now();
  const step = now => {
    const dt = Math.min(40, now - last); last = now;
    const sl = wrap.scrollLeft, st = wrap.scrollTop;
    wrap.scrollLeft -= vx * dt; wrap.scrollTop -= vy * dt;
    const f = Math.exp(-dt / 380);                      // Abbremsen (ähnlich wie bei Android-Listen)
    vx *= f; vy *= f;
    // am Rand angekommen: in der Richtung nicht weiterschieben
    if (wrap.scrollLeft === sl) vx = 0;
    if (wrap.scrollTop === st) vy = 0;
    fling = Math.hypot(vx, vy) > 0.03 ? requestAnimationFrame(step) : 0;
  };
  fling = requestAnimationFrame(step);
}
/* Geschwindigkeit (px/ms) aus den Fingerpositionen der letzten ~100 ms */
function panVelocity(g) {
  const s = g.samples, now = performance.now();
  while (s.length > 2 && now - s[0].t > 100) s.shift();
  if (s.length < 2 || now - s[s.length - 1].t > 60) return [0, 0];   // Finger stand vor dem Loslassen still
  const a = s[0], b = s[s.length - 1], dt = Math.max(1, b.t - a.t);
  return [(b.x - a.x) / dt, (b.y - a.y) / dt];
}

function onDown(e) {
  stopFling();
  if (e.target.closest('.tx.editing, .selbox, .pastechip')) return;
  removePasteChip();
  if (S.editing) commitText();
  hidePops();
  // Ein neues Aufsetzen beendet eine hängengebliebene Stift-Aktion (fehlendes pointerup)
  if (act && act.tool !== 'btnErase' && act.tool !== 'move' && act.tool !== 'scale' && e.pointerType === 'pen') { try { endAct(e); } catch { act = null; } }
  if (penBtnHandler(e)) { e.preventDefault(); return; }
  if (e.pointerType === 'touch' && !prefs.finger && !penButton(e)) {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...touches.values()];
    if (pts.length === 1) {
      const g = gest = { type: 'pan', id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now(), moved: false, samples: [{ x: e.clientX, y: e.clientY, t: performance.now() }] };
      // Finger lange still halten → „Einfügen“ an dieser Stelle
      g.lpT = setTimeout(() => {
        if (gest !== g || g.moved || touches.size !== 1 || !getClip()) return;
        const p = pageAt(g.sx, g.sy); if (!p) return;
        g.lp = true; navigator.vibrate?.(15);
        const [x, y] = toPage(p, g.sx, g.sy); showPasteChip(p, x, y);
      }, 600);
    }
    else if (pts.length === 2) {
      stopFling();
      // der Seitenpunkt zwischen den Fingern bleibt beim Zoomen (und Verschieben mit zwei Fingern) unter den Fingern
      const mx = (pts[0].x + pts[1].x) / 2, my = (pts[0].y + pts[1].y) / 2;
      gest = S.note ? { type: 'pinch', d0: dist(pts[0], pts[1]) || 1, z0: S.zoom, anchor: zoomAnchor(mx, my) } : null;
    }
    return;
  }
  if (act || (e.pointerType === 'mouse' && e.button !== 0 && !penButton(e))) return;
  const p = pageAt(e.clientX, e.clientY);
  const tool = penButton(e) ? 'eraser' : prefs.tool;
  if (!p) { if (tool === 'lasso') setSel(null); return; }
  e.preventDefault();
  try { wrap.setPointerCapture(e.pointerId); } catch {}
  startAct(tool, p, e);
}
function onMove(e) {
  if (penBtnHandler(e)) return;
  if (touches.has(e.pointerId)) {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gest?.type === 'pan' && gest.id === e.pointerId) {
      wrap.scrollLeft -= e.clientX - gest.x; wrap.scrollTop -= e.clientY - gest.y;
      gest.x = e.clientX; gest.y = e.clientY;
      gest.samples?.push({ x: e.clientX, y: e.clientY, t: performance.now() });
      if (gest.samples?.length > 30) gest.samples.shift();
      if (Math.hypot(e.clientX - gest.sx, e.clientY - gest.sy) > 10) gest.moved = true;
    } else if (gest?.type === 'pinch' && touches.size >= 2) {
      const [a, b] = [...touches.values()];
      setZoom(gest.z0 * dist(a, b) / gest.d0, (a.x + b.x) / 2, (a.y + b.y) / 2, gest.anchor);
    }
    return;
  }
  if (act && e.pointerId === act.pid) moveAct(e);
}
function onUp(e) {
  if (penBtnHandler(e)) return;
  if (touches.has(e.pointerId)) {
    touches.delete(e.pointerId);
    clearTimeout(gest?.lpT);
    if (gest?.lp) { gest = null; return; }                // nach langem Drücken: kein Tippen auslösen
    if (gest?.type === 'pan' && gest.id === e.pointerId && !gest.moved && e.type === 'pointerup' && performance.now() - gest.t < 450) tapAt(e.clientX, e.clientY);
    else if (gest?.type === 'pan' && gest.id === e.pointerId && gest.samples && e.type === 'pointerup' && touches.size === 0) {
      const [vx, vy] = panVelocity(gest);
      if (Math.hypot(vx, vy) > 0.25) startFling(vx * 1.15, vy * 1.15);   // nur nach schnellem Wischen
    }
    gest = null;
    if (touches.size === 1) { const [[id, pt]] = [...touches]; gest = { type: 'pan', id, x: pt.x, y: pt.y, sx: pt.x, sy: pt.y, t: 0, moved: true }; }
    return;
  }
  if (act && e.pointerId === act.pid) endAct(e);
}
function tapAt(cx, cy) {
  const p = pageAt(cx, cy);
  if (prefs.tool === 'lasso') { if (!p) return setSel(null); const [x, y] = toPage(p, cx, cy); tapSelect(p, x, y); }
  else if (prefs.tool === 'text' && p) { const [x, y] = toPage(p, cx, cy); textTap(p, x, y); }
}

/* Live-Ebene. Hinweis: den „desynchronized“-Modus von Chrome nicht verwenden. Auf Samsung-Tablets
   wird die durchsichtige Ebene damit beim Zoomen schwarz. */
const liveCtx = pe => pe.lctx ||= pe.live.getContext('2d');
/* Die Live-Ebene deckt nur den sichtbaren Teil der Seite ab, nicht die ganze Seite.
   So bleibt sie auch bei starkem Zoom klein und der Grafikspeicher reicht. */
function prepLive(pe, p) {
  const ctx = liveCtx(pe), sc = scale(), d = dpr();
  const pr = pe.el.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
  const x0 = Math.max(0, wr.left - pr.left), y0 = Math.max(0, wr.top - pr.top);
  const x1 = Math.min(pr.width, wr.right - pr.left), y1 = Math.min(pr.height, wr.bottom - pr.top);
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  const W = Math.round(w * d), H = Math.round(h * d);
  if (pe.live.width !== W || pe.live.height !== H) { pe.live.width = W; pe.live.height = H; }
  else { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H); }
  Object.assign(pe.live.style, { left: x0 + 'px', top: y0 + 'px', width: w + 'px', height: h + 'px', right: 'auto', bottom: 'auto' });
  // Seitenkoordinaten → Pixel des Ausschnitts
  ctx.setTransform(sc * d, 0, 0, sc * d, -x0 * d, -y0 * d);
  return ctx;
}
function clearLive(pe) { const c = pe.live, ctx = liveCtx(pe); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height); }

function startAct(tool, p, e, extra = {}) {
  const pe = pageEls.get(p.id), rect = pe.el.getBoundingClientRect();
  act = { tool, p, pe, pid: e.pointerId, rect, k: rect.width / p.w, before: snap(p), ...extra };
  const [x, y] = toPageA(e.clientX, e.clientY);
  Object.assign(act, { x0: x, y0: y, x, y });
  if (tool !== 'move' && tool !== 'scale' && tool !== 'text') act.ctx = prepLive(pe, p);
  if ((tool === 'shape' && prefs.shape !== 'compass') || tool === 'lasso' || tool === 'text') {
    // langes Drücken ohne Bewegung → „Einfügen“ (Stift/Marker: über die Halteerkennung in onHold)
    const a = act;
    a.lpT = setTimeout(() => { if (act === a && getClip()) longPressPaste(a, a.x0, a.y0); }, 600);
  }
  if (tool === 'shape' && prefs.shape === 'compass') { compassStart(act); return; }
  if (tool === 'stamp') { stampPreview(act); return; }
  if (tool === 'restyle') { act.done = new Set(); restyleAt(x, y); return; }
  if (tool === 'eraser' && prefs.emode === 'cover') {
    act.tool = 'cover';
    act.item = { t: 'stroke', id: uid(), tool: 'cover', color: coverColor(act.p), size: +(prefs.sizes.eraser / act.k).toFixed(2), pts: [] };
    addPts(e);
  } else if (tool === 'pen' || tool === 'marker') {
    act.item = { t: 'stroke', id: uid(), tool, color: prefs.color, size: prefs.sizes[tool], pts: [] };
    if (tool === 'pen') act.item.style = prefs.penStyle;
    else act.item.alpha = prefs.markerAlpha ?? 0.4;
    // Textmarker auf PDF-Seiten: Textzeilen laden, damit der Strich an ihnen einrasten kann
    if (tool === 'marker' && prefs.snapText !== false && p.pdf != null && S.pdf) {
      const a = act; pdfLines(p).then(l => { a.lines = l; }).catch(() => {});
    }
    addPts(e);
    // Lineal: der Strich wird von Anfang an als Gerade gezogen
    if (prefs.ruler) {
      act.recog = { kind: 'markerLine', x1: x, y1: y, x2: x, y2: y };
      const a = act;
      a.lpT = setTimeout(() => { if (act === a && getClip()) longPressPaste(a, a.x0, a.y0); }, 600);
    } else holdCheck(x, y);
  } else if (tool === 'eraser') {
    eraseAt(x, y); drawEraser(x, y);
  } else if (tool === 'lasso') {
    if (S.sel && S.sel.p !== p) setSel(null);
    act.poly = [[x, y]];
  }
}
/* Stift bleibt am Strichende ~0,6 s ruhig → Strich in Linie/Form umwandeln */
function holdCheck(x, y) {
  const h = act.hold;
  if (act.recog || (h && Math.hypot(x - h.x, y - h.y) * act.k < 6)) return;
  if (h) clearTimeout(h.t);
  const a = act;
  act.hold = { x, y, t: setTimeout(() => onHold(a), 600) };
}
/* Langes Drücken auf eine Stelle (ohne Bewegung): „Einfügen“ anbieten, wenn etwas in der Zwischenablage liegt.
   Der angefangene Punkt bzw. die Aktion wird dabei verworfen. */
function longPressPaste(a, x, y) {
  a.lp = true;
  clearTimeout(a.hold?.t); clearTimeout(a.lpT);
  if (a.item) a.item.pts = [];
  if (a.ctx) clearLive(a.pe);
  navigator.vibrate?.(15);
  showPasteChip(a.p, x, y);
}
function onHold(a) {
  if (act !== a || a.recog) return;
  const pts = a.item.pts;
  if (pts.length) {
    const p0 = pts[0];
    if (pts.every(q => Math.hypot(q[0] - p0[0], q[1] - p0[1]) * a.k < 8)) {   // Stift stand still
      if (getClip()) longPressPaste(a, p0[0], p0[1]);
      return;
    }
  }
  if (a.tool === 'marker') {
    if (pts.length < 3) return;
    const [x2, y2] = snapLine(pts[0][0], pts[0][1], pts[pts.length - 1][0], pts[pts.length - 1][1]);
    a.recog = { kind: 'markerLine', x1: pts[0][0], y1: pts[0][1], x2, y2 };
  } else {
    const s = recognizeShape(pts);
    if (!s) return;
    a.recog = { t: 'shape', id: uid(), ...s, color: a.item.color, size: +(a.item.size * 0.85).toFixed(2) };
  }
  navigator.vibrate?.(12);
  drawRecog(a);
}
function drawRecog(a) {
  const ctx = a.ctx, r = a.recog;
  ctx.clearRect(0, 0, a.p.w, a.p.h);
  if (r.kind === 'markerLine') drawStroke(ctx, { ...a.item, pts: [[r.x1, r.y1, .5], [r.x2, r.y2, .5]] });
  else drawShape(ctx, r);
  if (r.kind === 'markerLine' || r.kind === 'line') drawLineInfo(ctx, r.x1, r.y1, r.x2, r.y2, a.k);
}
/* Beim Ziehen einer Geraden: Winkel zur Waagerechten und Länge neben dem Linienende anzeigen */
function drawLineInfo(ctx, x1, y1, x2, y2, k) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len * k < 8) return;
  let deg = Math.round(Math.atan2(y1 - y2, x2 - x1) * 180 / Math.PI); if (deg < 0) deg += 360;
  const text = `${deg}°  ·  ${(len / 72 * 2.54).toLocaleString('de-DE', { maximumFractionDigits: 1 })} cm`;
  const fs = 13 / k, pad = 6 / k;
  ctx.save();
  ctx.font = `600 ${fs}px ${FONT}`; ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 2 * pad, h = fs + 2 * pad;
  const [bx, by] = badgePos(ctx, x2, y2, w, h, k);
  ctx.fillStyle = 'rgba(28,35,33,.88)'; ctx.beginPath(); ctx.roundRect(bx, by, w, h, 6 / k); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.fillText(text, bx + pad, by + h / 2);
  ctx.restore();
}
/* Sichtbarer Bereich der Live-Ebene in Seitenkoordinaten (sie deckt nur den gerade sichtbaren Ausschnitt ab) */
function liveBounds(ctx) {
  const t = ctx.getTransform();
  return { x0: -t.e / t.a, y0: -t.f / t.d, x1: (ctx.canvas.width - t.e) / t.a, y1: (ctx.canvas.height - t.f) / t.d };
}
/* Schild (w×h) neben den Punkt (x, y) setzen: bevorzugt rechts oberhalb; ist dort kein Platz im sichtbaren
   Ausschnitt, auf die andere Seite wechseln und notfalls an den Rand des Ausschnitts schieben */
function badgePos(ctx, x, y, w, h, k) {
  const v = liveBounds(ctx), gap = 14 / k, m = 6 / k;
  let bx = x + gap, by = y - h - gap;
  if (bx + w > v.x1 - m) bx = x - gap - w;          // rechts kein Platz → links vom Punkt
  if (by < v.y0 + m) by = y + gap;                  // oben kein Platz → unterhalb
  return [clamp(bx, v.x0 + m, Math.max(v.x0 + m, v.x1 - w - m)), clamp(by, v.y0 + m, Math.max(v.y0 + m, v.y1 - h - m))];
}
function addPts(e) {
  const it = act.item, ctx = act.ctx, k = act.k;
  if (act.recog) {
    // Nach dem Erkennen folgt das Linienende weiter dem Stift
    const r = act.recog;
    if (r.kind === 'line' || r.kind === 'markerLine') {
      const [x, y] = toPageA(e.clientX, e.clientY);
      [r.x2, r.y2] = snapLine(r.x1, r.y1, x, y); drawRecog(act);
    }
    return;
  }
  const evs = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
  const al = it.tool === 'cover' ? 1 : SMOOTH_ALPHA[prefs.smoothing] ?? 1;
  for (const ev of evs) {
    let [x, y] = toPageA(ev.clientX, ev.clientY);
    let pr = ev.pointerType === 'pen' ? (ev.pressure || 0.5) : 0.5;
    if (al < 1) {
      // Stabilisierung: die Strichspitze folgt dem Stift weich nach und filtert Zittern heraus
      act.raw = [x, y, pr];
      if (act.sm) {
        x = act.sm[0] + (x - act.sm[0]) * al; y = act.sm[1] + (y - act.sm[1]) * al;
        pr = act.sm[2] + (pr - act.sm[2]) * Math.min(1, al * 1.5);
      }
      act.sm = [x, y, pr];
    }
    const last = it.pts[it.pts.length - 1];
    if (last && Math.hypot(x - last[0], y - last[1]) < 0.7 / k) continue;
    it.pts.push([+x.toFixed(2), +y.toFixed(2), +pr.toFixed(2)]);
    if (it.tool === 'pen' && penStyle(it).grain) {
      // Bleistift: einmal pro Bildschirmbild den ganzen Strich neu zeichnen (wie er am Ende aussieht)
      const a = act;
      if (!a.pencilRaf) a.pencilRaf = requestAnimationFrame(() => {
        a.pencilRaf = 0;
        if (a.recog || act !== a) return;            // Strich schon fertig oder in eine Form umgewandelt
        a.ctx.clearRect(0, 0, a.p.w, a.p.h); drawPencil(a.ctx, a.item);
      });
    } else if (it.tool === 'pen') {
      const st = penStyle(it), a = last ? Math.atan2(y - last[1], x - last[0]) : 0;
      ctx.strokeStyle = ctx.fillStyle = penPaint(ctx, it, st, pr); ctx.lineCap = 'round';
      if (last) { ctx.lineWidth = st.w(it.size, pr, a); ctx.beginPath(); ctx.moveTo(last[0], last[1]); ctx.lineTo(x, y); ctx.stroke(); }
      else { ctx.beginPath(); ctx.arc(x, y, st.w(it.size, pr, a) / 2, 0, 7); ctx.fill(); }
    }
  }
  if (it.tool === 'marker') {
    ctx.clearRect(0, 0, act.p.w, act.p.h);
    const snap = snapRects(act);
    if (snap) snap.forEach(s => drawStroke(ctx, s)); else drawStroke(ctx, it);
  }
  const last = it.pts[it.pts.length - 1];
  if (it.tool === 'cover') {
    ctx.clearRect(0, 0, act.p.w, act.p.h); drawStroke(ctx, it);
    if (last) { ctx.save(); ctx.strokeStyle = '#2f5d50'; ctx.lineWidth = 1.2 / k; ctx.beginPath(); ctx.arc(last[0], last[1], it.size / 2, 0, 7); ctx.stroke(); ctx.restore(); }
    return;
  }
  if (last) holdCheck(last[0], last[1]);
}
/* ---------------- Textmarker an PDF-Text einrasten ----------------
   Die Textzeilen einer PDF-Seite kommen aus pdf.js (getTextContent). Ein Markerstrich, der auf Text beginnt,
   wird wie eine Textauswahl behandelt: vom Startzeichen bis zum Endzeichen, über mehrere Zeilen hinweg. */
function pdfLines(p) {
  const cache = S.pdf._lines ||= new Map();
  if (!cache.has(p.pdf)) cache.set(p.pdf, loadPdfLines(S.pdf, p.pdf));
  return cache.get(p.pdf);
}
async function loadPdfLines(doc, idx) {
  const page = await doc.getPage(idx + 1), vp = page.getViewport({ scale: 1 }), tc = await page.getTextContent();
  const boxes = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim() || !it.width) continue;
    const m = pdfjsLib.Util.transform(vp.transform, it.transform);
    if (Math.abs(m[1]) > 0.01 * Math.abs(m[0]) || Math.abs(m[2]) > 0.01 * Math.abs(m[3])) continue;   // nur waagerechter Text
    const h = Math.abs(m[3]); if (h < 2) continue;
    const xa = m[4], xb = m[4] + Math.sign(m[0]) * it.width, up = m[3] < 0;
    boxes.push({ left: Math.min(xa, xb), right: Math.max(xa, xb), top: m[5] - (up ? 0.82 : 0.22) * h, bottom: m[5] + (up ? 0.22 : 0.82) * h, h, n: it.str.length });
  }
  // zu Zeilen zusammenfassen: gleiche Höhe und nicht zu weit auseinander (zweispaltige Seiten bleiben getrennt)
  boxes.sort((a, b) => (a.top + a.bottom) - (b.top + b.bottom) || a.left - b.left);
  const lines = [];
  for (const b of boxes) {
    const l = lines.find(l => {
      const ov = Math.min(l.bottom, b.bottom) - Math.max(l.top, b.top);
      return ov > 0.5 * Math.min(l.bottom - l.top, b.bottom - b.top) && b.left - l.right < 3 * b.h && l.left - b.right < 3 * b.h;
    });
    if (l) { l.boxes.push(b); l.left = Math.min(l.left, b.left); l.right = Math.max(l.right, b.right); l.top = Math.min(l.top, b.top); l.bottom = Math.max(l.bottom, b.bottom); }
    else lines.push({ left: b.left, right: b.right, top: b.top, bottom: b.bottom, boxes: [b] });
  }
  lines.forEach(l => l.boxes.sort((a, b) => a.left - b.left));
  return lines.sort((a, b) => a.top - b.top || a.left - b.left);
}
function lineAt(lines, x, y) {
  let best = null, bd = Infinity;
  for (const l of lines) {
    const hh = l.bottom - l.top;
    if (x < l.left - hh || x > l.right + hh) continue;
    const d = y < l.top ? l.top - y : y > l.bottom ? y - l.bottom : 0;
    if (d < bd && d <= hh * 0.6) { bd = d; best = l; }
  }
  return best;
}
/* x auf eine Zeichengrenze der Zeile setzen; Zeichenbreite wird je Textstück gleichmäßig angenommen */
function snapX(l, x, end) {
  if (x <= l.left) return l.left;
  if (x >= l.right) return l.right;
  for (let i = 0; i < l.boxes.length; i++) {
    const b = l.boxes[i];
    if (x < b.left) return end ? l.boxes[i - 1].right : b.left;      // in einer Lücke zwischen Wörtern
    if (x <= b.right) {
      const cw = (b.right - b.left) / b.n, k = (x - b.left) / cw;
      return b.left + (end ? Math.ceil(k) : Math.floor(k)) * cw;
    }
  }
  return l.right;
}
function snapRects(a) {
  if (!a.lines || !a.item || a.item.pts.length < 2) return null;
  const P = a.item.pts, s = P[0], e = P[P.length - 1];
  let la = lineAt(a.lines, s[0], s[1]), lb = lineAt(a.lines, e[0], e[1]);
  if (!la || !lb) return null;
  let ia = a.lines.indexOf(la), ib = a.lines.indexOf(lb), xs = s[0], xe = e[0];
  if (ia > ib || (ia === ib && xs > xe)) { [ia, ib] = [ib, ia]; [la, lb] = [lb, la]; [xs, xe] = [xe, xs]; }
  const spanL = Math.min(la.left, lb.left), spanR = Math.max(la.right, lb.right), out = [];
  for (let i = ia; i <= ib; i++) {
    const l = a.lines[i];
    if (i !== ia && i !== ib && (l.right < spanL || l.left > spanR)) continue;   // Zeilen aus der Nachbarspalte überspringen
    const x0 = i === ia ? snapX(l, xs, false) : l.left, x1 = i === ib ? snapX(l, xe, true) : l.right;
    if (x1 - x0 < 1) continue;
    const yc = +((l.top + l.bottom) / 2).toFixed(2);
    out.push({ ...a.item, id: uid(), cap: 'butt', size: +(l.bottom - l.top).toFixed(2), pts: [[+x0.toFixed(2), yc, .5], [+x1.toFixed(2), yc, .5]] });
  }
  return out.length ? out : null;
}

/* Kritzeln zum Löschen: schnelles Hin-und-her über Geschriebenem löscht, was darunter liegt.
   Erkannt wird ein Zickzack mit mindestens vier langen Richtungswechseln; liegt nichts darunter, bleibt der Strich. */
function scribbleErase(a) {
  if (prefs.scribble === false) return false;
  const P = a.item.pts, n = P.length;
  if (n < 12) return false;
  const b = bbox(a.item);
  const zigzag = ax => {
    const span = ax ? b.h : b.w;
    if (span * a.k < 24) return 0;
    let runs = 0, start = P[0][ax], dir = 0, ext = P[0][ax];
    for (let i = 1; i < n; i++) {
      const v = P[i][ax];
      if (!dir) { if (Math.abs(v - start) > span * 0.15) { dir = Math.sign(v - start); ext = v; } continue; }
      if ((v - ext) * dir > 0) ext = v;
      else if ((ext - v) * dir > span * 0.3) {           // deutliche Umkehr: Lauf zählen, wenn er lang genug war
        if (Math.abs(ext - start) > span * 0.5) runs++;
        start = ext; ext = v; dir = -dir;
      }
    }
    if (Math.abs(ext - start) > span * 0.5) runs++;
    return runs;
  };
  if (Math.max(zigzag(0), zigzag(1)) < 5) return false;
  const p = a.p, pad = 2;
  const inside = (x, y) => x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad;
  // Kreuzt das Kritzeln ein Element mehrfach, ist es gemeint – auch wenn es weit über den Kritzelbereich hinausreicht
  // (z. B. eine lange gerade Linie, über deren Mitte gekritzelt wird)
  const cross = (a1, a2, b1, b2) => {
    const d = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    return d(a1, a2, b1) * d(a1, a2, b2) <= 0 && d(b1, b2, a1) * d(b1, b2, a2) <= 0;     // Berühren zählt mit
  };
  const crossings = line => {
    let k = 0;
    for (let i = 1; i < line.length; i++) for (let j = 1; j < n; j++) if (cross(line[i - 1], line[i], P[j - 1], P[j]) && ++k >= 3) return k;
    return k;
  };
  const hit = it => {
    if (it.t !== 'stroke' && it.t !== 'shape') return false;
    if (!overlaps(bbox(it), b)) return false;
    if (it.t === 'stroke') {
      const k = it.pts.filter(q => inside(q[0], q[1])).length;
      if (k >= Math.max(1, it.pts.length * 0.4)) return true;
      if (it.pts.length === 1) return false;
    } else {
      const s = bbox(it);
      if (inside(s.x + s.w / 2, s.y + s.h / 2) && s.w <= b.w * 1.3 && s.h <= b.h * 1.3) return true;
    }
    return crossings(it.t === 'stroke' ? it.pts : shapeOutline(it)) >= 3;
  };
  const keep = p.items.filter(it => !hit(it));
  if (keep.length === p.items.length) return false;
  p.items = keep;
  navigator.vibrate?.(10);
  return true;
}
/* Abdecken malt in der Papierfarbe der Seite (PDF-Seiten: weiß) */
const coverColor = p => (p.pdf == null && p.paper) || '#ffffff';
/* Glätten: 0 = aus, 1 = mittel, 2 = stark */
const SMOOTH_ALPHA = [1, 0.5, 0.22];
function smoothStroke(a) {
  const lvl = prefs.smoothing ?? 0, it = a.item;
  if (!lvl || it.tool === 'cover' || it.pts.length < 3) return;
  // bis zur echten Stiftposition nachziehen, dann mehrfach mitteln (Endpunkte bleiben fest)
  if (a.raw) {
    const l = it.pts[it.pts.length - 1];
    if (Math.hypot(a.raw[0] - l[0], a.raw[1] - l[1]) > 0.5) it.pts.push([+a.raw[0].toFixed(2), +a.raw[1].toFixed(2), +l[2].toFixed(2)]);
  }
  let P = it.pts;
  for (let k = 0; k < (lvl === 1 ? 2 : 7); k++) {
    P = P.map((p, i) => (i === 0 || i === P.length - 1) ? p
      : [0, 1, 2].map(j => +((P[i - 1][j] + 2 * p[j] + P[i + 1][j]) / 4).toFixed(2)));
  }
  it.pts = P;
}
function drawEraser(x, y) {
  const ctx = act.ctx; ctx.clearRect(0, 0, act.p.w, act.p.h);
  ctx.save(); ctx.strokeStyle = '#2f5d50'; ctx.lineWidth = 1.2 / act.k; ctx.fillStyle = 'rgba(47,93,80,.08)';
  ctx.beginPath(); ctx.arc(x, y, prefs.sizes.eraser / 2 / act.k, 0, 7); ctx.fill(); ctx.stroke(); ctx.restore();
}
/* ---------------- Zauberstift (Stil ändern durch Überfahren) ----------------
   Farbe und Strichstärke werden vorher eingestellt; alles, was der Stift berührt, übernimmt sie.
   Schalter „Farbe“ / „Stärke“ legen fest, was übertragen wird. Fotos und Abdecken bleiben unverändert. */
function restyleItem(it) {
  // Farbe und Stärke werden immer zusammen übertragen (Wunsch: ein Zug ändert beides)
  const col = prefs.color, w = prefs.sizes.restyle;
  if (it.t === 'img' && !isFormula(it)) return null;
  if (it.tool === 'cover') return null;
  const c = { ...it };
  if (col && c.color !== col) {
    if (isFormula(c)) {
      const i = c.src.indexOf(',') + 1, svg = decodeURIComponent(c.src.slice(i));
      c.src = c.src.slice(0, i) + encodeURIComponent(svg.split(`"${c.color}"`).join(`"${col}"`));
    }
    c.color = col;
    if (c.fill) c.fill = fillFor(col, c.fillMode || 2);
  }
  // Stärke nur bei Stiftstrichen und Formen (Marker und Text haben eigene Größen)
  if (w && ((c.t === 'stroke' && c.tool === 'pen') || c.t === 'shape') && c.size !== w) c.size = w;
  return c.color !== it.color || c.size !== it.size ? c : null;
}
function restyleAt(x, y) {
  const p = act.p, r = 3.5 / act.k;                       // feine Spitze (Radius 3,5 Bildschirm-Pixel)
  const lx = act.ex ?? x, ly = act.ey ?? y, steps = Math.max(1, Math.ceil(Math.hypot(x - lx, y - ly) / (r * 0.7)));
  act.ex = x; act.ey = y;
  // Spur des Zauberstifts andeuten
  const ctx = act.ctx;
  ctx.save(); ctx.strokeStyle = 'rgba(47,93,80,.35)'; ctx.lineWidth = 2 * r; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(x, y); ctx.stroke(); ctx.restore();
  let box = null;
  for (let s = 1; s <= steps; s++) {
    const ex = lx + (x - lx) * s / steps, ey = ly + (y - ly) * s / steps;
    p.items = p.items.map(it => {
      if (act.done.has(it.id) || !hitItem(it, ex, ey, r)) return it;
      act.done.add(it.id);
      const c = restyleItem(it); if (!c) return it;
      const b = unionBox([bbox(it), bbox(c)]);
      box = box ? unionBox([box, b]) : b;
      return c;
    });
  }
  if (box) { act.changed = true; renderRegionSoon(act.pe, p, box); if (p.items.some(i => i.t === 'text' && act.done.has(i.id))) renderText(act.pe, p); }
}
function eraseAt(x, y) {
  const p = act.p, r = prefs.sizes.eraser / 2 / act.k;
  // Zwischenpositionen ergänzen, damit schnelle Bewegungen nichts überspringen
  const lx = act.ex ?? x, ly = act.ey ?? y, steps = Math.max(1, Math.ceil(Math.hypot(x - lx, y - ly) / (r * 0.5)));
  act.ex = x; act.ey = y;
  let changed = false, box = null;
  for (let s = 1; s <= steps; s++) {
    const ex = lx + (x - lx) * s / steps, ey = ly + (y - ly) * s / steps;
    const out = [];
    for (const it of p.items) {
      if (it.t !== 'stroke' && it.t !== 'shape') { out.push(it); continue; }
      if (!hitItem(it, ex, ey, r)) { out.push(it); continue; }
      changed = true;
      // betroffener Bereich: beim ganzen Strich dessen Fläche, beim Bereichsradierer nur der Radierkreis
      const hb = (prefs.emode === 'stroke' || it.t === 'shape') ? bbox(it) : { x: ex - r - it.size * 2, y: ey - r - it.size * 2, w: 2 * r + it.size * 4, h: 2 * r + it.size * 4 };
      box = box ? unionBox([box, hb]) : hb;
      if (prefs.emode === 'stroke') continue;
      // Bereichsradierer: Formen werden zu Linienzügen, die Füllung verschwindet nur, wenn sie berührt wird
      const parts = it.t === 'shape' ? shapeToStrokes(it) : [it];
      for (const pa of parts) {
        if (pa.t === 'shape') { if (!hitItem(pa, ex, ey, r)) out.push(pa); continue; }
        if (it.t === 'shape') box = unionBox([box, bbox(pa)]);
        if (!hitItem(pa, ex, ey, r)) { out.push(pa); continue; }
        // Strich an der Radierstelle auftrennen (weit auseinanderliegende Punkte vorher verfeinern)
        const rr = r + penMaxW(pa) / 2 * 0.5;
        const segs = []; let cur = [];
        const dp = densify(pa.pts, Math.max(0.5, r / 3));
        // Verlauf bzw. Strichelung verschiebt sich: ganz neu malen
        if (pa.dash || dp.length !== pa.pts.length) box = unionBox([box, bbox(pa)]);
        for (const pt of dp) {
          if (Math.hypot(pt[0] - ex, pt[1] - ey) < rr) { if (cur.length) segs.push(cur); cur = []; }
          else cur.push(pt);
        }
        if (cur.length) segs.push(cur);
        segs.forEach((pts, i) => out.push({ ...pa, id: i ? uid() : pa.id, pts }));
      }
    }
    p.items = out;
  }
  if (changed) { act.changed = true; renderRegionSoon(act.pe, p, box); }
}
function moveAct(e) {
  if (act.tool === 'btnErase') return btnEraseMove(e);
  const [x, y] = toPageA(e.clientX, e.clientY);
  if (act.lp) return;                                     // „Einfügen“ wird angeboten: Bewegung ignorieren
  if (act.lpT && Math.hypot(x - act.x0, y - act.y0) * act.k > 8) { clearTimeout(act.lpT); act.lpT = 0; }
  act.x = x; act.y = y;
  // Seitentaste erst während des Schreibens gedrückt → ab hier radieren
  if ((act.tool === 'pen' || act.tool === 'marker') && penButton(e)) {
    clearTimeout(act.hold?.t);
    if (act.item.pts.length && !act.recog) addStrokes(act.pe, act.p, [act.item]);
    act.tool = 'eraser'; act.recog = null;
    if (prefs.emode === 'cover') {
      act.tool = 'cover';
      act.item = { t: 'stroke', id: uid(), tool: 'cover', color: coverColor(act.p), size: +(prefs.sizes.eraser / act.k).toFixed(2), pts: [] };
    }
  }
  const t = act.tool, ctx = act.ctx;
  if (t === 'pen' || t === 'marker' || t === 'cover') addPts(e);
  else if (t === 'eraser') { eraseAt(x, y); drawEraser(x, y); }
  else if (t === 'restyle') restyleAt(x, y);
  else if (t === 'lasso') {
    act.poly.push([x, y]);
    ctx.clearRect(0, 0, act.p.w, act.p.h);
    ctx.save(); ctx.setLineDash([5 / act.k, 4 / act.k]); ctx.strokeStyle = '#2f5d50'; ctx.lineWidth = 1.5 / act.k;
    ctx.fillStyle = 'rgba(47,93,80,.06)'; ctx.beginPath();
    act.poly.forEach(([a, b], i) => i ? ctx.lineTo(a, b) : ctx.moveTo(a, b));
    ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
  } else if (t === 'shape' && act.cmp) {
    compassMove(act);
  } else if (t === 'stamp') {
    stampPreview(act);
  } else if (t === 'shape') {
    ctx.clearRect(0, 0, act.p.w, act.p.h);
    const sh = shapeFromAct(); drawShape(ctx, sh);
    if (sh.kind === 'line' || sh.kind === 'arrow') drawLineInfo(ctx, sh.x1, sh.y1, sh.x2, sh.y2, act.k);
  } else if (t === 'move') {
    act.lcx = e.clientX; act.lcy = e.clientY;
    // am oberen/unteren Rand automatisch weiterscrollen, damit man auch zu Seiten außerhalb des Bildes ziehen kann
    const wr = wrap.getBoundingClientRect(), edge = 70, cy = e.clientY;
    act.asv = cy < wr.top + edge ? -(wr.top + edge - cy) * 0.35 : cy > wr.bottom - edge ? (cy - (wr.bottom - edge)) * 0.35 : 0;
    if (act.asv && !asRaf) asRaf = requestAnimationFrame(autoScrollTick);
    moveSelTo(e.clientX, e.clientY);
  } else if (t === 'scale' && act.axis) {
    // Seitengriff (alle vier Seiten): nur Breite (x) bzw. nur Höhe (y), gegenüberliegende Kante bleibt stehen
    const { ax, ay } = act;
    // Nenner mit Vorzeichen (links/oben ist er negativ), aber nie fast 0
    const den = v => Math.sign(v || 1) * Math.max(1, Math.abs(v));
    if (act.axis === 'x') { const f = Math.max(0.05, (x - ax) / den(act.x0 - ax)); applySel((a, b) => [ax + (a - ax) * f, b], 1, 0, f, 1); }
    else { const f = Math.max(0.05, (y - ay) / den(act.y0 - ay)); applySel((a, b) => [a, ay + (b - ay) * f], 1, 0, 1, f); }
  } else if (t === 'scale') {
    const { ax, ay } = act, f = Math.max(0.08, Math.hypot(x - ax, y - ay) / act.d0);
    applySel((a, b) => [ax + (a - ax) * f, ay + (b - ay) * f], f);
  } else if (t === 'lineEnd') {
    // Linienende ziehen: das andere Ende bleibt stehen, rastet bei 0°/45°/90° ein
    const i = act.end, o = 3 - i, src = [...act.orig.values()][0];
    const [nx, ny] = snapLine(src['x' + o], src['y' + o], x, y);
    const it = { ...src, ['x' + i]: +nx.toFixed(2), ['y' + i]: +ny.toFixed(2) };
    applySel(null, 1, 0, 1, 1, it);
    ctx.clearRect(0, 0, act.p.w, act.p.h);
    drawLineInfo(ctx, it.x1, it.y1, it.x2, it.y2, act.k);
  } else if (t === 'rotate') {
    const { cx, cy } = act;
    let da = Math.atan2(y - cy, x - cx) - act.a0;
    const q = Math.PI / 4, near = Math.round(da / q) * q;
    if (Math.abs(da - near) < 0.05) da = near;            // bei 45°-Schritten einrasten
    const c = Math.cos(da), s = Math.sin(da);
    applySel((a, b) => [cx + (a - cx) * c - (b - cy) * s, cy + (a - cx) * s + (b - cy) * c], 1, da);
  }
}
/* Füllung: 1 = heller Farbton, 2 = volle Farbe */
/* Füllung: 2 = volle Farbe, 1 = 20 % Farbe (durchscheinend, Schrift darunter bleibt sichtbar) */
function fillFor(color, mode) {
  if (mode === 2) return color;
  if (mode !== 1) return null;
  const m = /^#([0-9a-f]{6})$/i.exec(color || '');
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},0.2)`;
}
/* ---------------- Zirkel ----------------
   1) Spitze auf den Mittelpunkt setzen und nach außen ziehen: legt den Radius fest (in cm angezeigt).
   2) Danach irgendwo auf dem Kreis ansetzen und herumfahren: die Linie folgt genau dem Kreis.
      Bei Viertel-, Halb-, Dreiviertel- und Vollkreis rastet der Bogen ein.
   Erneut am Mittelpunkt (oder weit außerhalb) ansetzen = Zirkel neu einstellen.
   Ein Bogen wird als gleichmäßige Linie (Stil 'shape') gespeichert: radierbar, verschiebbar, scharf im PDF. */
S.compass = null;
const cmLen = v => (v / 72 * 2.54).toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' cm';
function drawBadge(ctx, x, y, text, k) {
  const fs = 13 / k, pad = 6 / k;
  ctx.save(); ctx.setLineDash([]);
  ctx.font = `600 ${fs}px ${FONT}`; ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 2 * pad, h = fs + 2 * pad;
  const [bx, by] = badgePos(ctx, x, y, w, h, k);
  ctx.fillStyle = 'rgba(28,35,33,.88)'; ctx.beginPath(); ctx.roundRect(bx, by, w, h, 6 / k); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.fillText(text, bx + pad, by + h / 2);
  ctx.restore();
}
function compassStart(a) {
  const c = S.compass, k = a.k;
  const d = c && c.pid === a.p.id ? Math.hypot(a.x0 - c.cx, a.y0 - c.cy) : Infinity;
  if (!c || c.pid !== a.p.id || d * k < 22 || d > c.r * 2 + 60 / k) {
    // neu einstellen: am alten Mittelpunkt angesetzt → nur den Radius ändern
    const keep = c && c.pid === a.p.id && d * k < 22;
    a.cmp = { mode: 'radius', cx: keep ? c.cx : a.x0, cy: keep ? c.cy : a.y0, r: 0 };
  } else {
    const a0 = Math.atan2(a.y0 - c.cy, a.x0 - c.cx);
    a.cmp = { mode: 'arc', cx: c.cx, cy: c.cy, r: c.r, a0, last: a0, sweep: 0 };
  }
  compassMove(a);
}
const COMPASS_SNAP = [0.5, 1, 1.5, 2].map(f => f * Math.PI);
function compassSweep(m) {
  for (const t of COMPASS_SNAP) for (const s of [t, -t]) if (Math.abs(m.sweep - s) < 6 * Math.PI / 180) return s;
  return m.sweep;
}
function compassArc(m, color, size) {
  const sw = compassSweep(m), n = clamp(Math.ceil(Math.abs(sw) * m.r / 2), 8, 720), pts = [];
  for (let i = 0; i <= n; i++) {
    const t = m.a0 + sw * i / n;
    pts.push([+(m.cx + m.r * Math.cos(t)).toFixed(2), +(m.cy + m.r * Math.sin(t)).toFixed(2), 0.5]);
  }
  const it = { t: 'stroke', id: uid(), tool: 'pen', style: 'shape', color, size, pts };
  if (prefs.dash) it.dash = true;
  return it;
}
function compassGuide(ctx, m, k) {
  ctx.save();
  ctx.strokeStyle = 'rgba(47,93,80,.55)'; ctx.lineWidth = 1.2 / k; ctx.setLineDash([5 / k, 4 / k]);
  if (m.r > 0) { ctx.beginPath(); ctx.arc(m.cx, m.cy, m.r, 0, Math.PI * 2); ctx.stroke(); }
  ctx.setLineDash([]); ctx.beginPath();
  ctx.moveTo(m.cx - 6 / k, m.cy); ctx.lineTo(m.cx + 6 / k, m.cy); ctx.moveTo(m.cx, m.cy - 6 / k); ctx.lineTo(m.cx, m.cy + 6 / k);
  ctx.strokeStyle = '#2f5d50'; ctx.lineWidth = 1.6 / k; ctx.stroke();
  ctx.restore();
}
function compassMove(a) {
  const m = a.cmp, ctx = a.ctx, k = a.k;
  ctx.clearRect(0, 0, a.p.w, a.p.h);
  if (m.mode === 'radius') {
    m.r = Math.hypot(a.x - m.cx, a.y - m.cy);
    compassGuide(ctx, m, k);
    if (m.r * k > 4) {
      ctx.save(); ctx.strokeStyle = '#2f5d50'; ctx.lineWidth = 1.6 / k;
      ctx.beginPath(); ctx.moveTo(m.cx, m.cy); ctx.lineTo(a.x, a.y); ctx.stroke(); ctx.restore();
      drawBadge(ctx, a.x, a.y, 'Radius ' + cmLen(m.r), k);
    }
    return;
  }
  const ang = Math.atan2(a.y - m.cy, a.x - m.cx);
  let d = ang - m.last;
  if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
  m.sweep = clamp(m.sweep + d, -2 * Math.PI, 2 * Math.PI); m.last = ang;
  compassGuide(ctx, m, k);
  const sw = compassSweep(m);
  if (Math.abs(sw) * m.r * k > 2) {
    drawStroke(ctx, compassArc(m, prefs.color, prefs.sizes.shape));
    const end = m.a0 + sw;
    drawBadge(ctx, m.cx + m.r * Math.cos(end), m.cy + m.r * Math.sin(end), Math.round(Math.abs(sw) * 180 / Math.PI) + '°', k);
  }
}
function compassEnd(a) {
  const m = a.cmp;
  if (m.mode === 'radius') {
    if (m.r * a.k > 6) { S.compass = { pid: a.p.id, cx: m.cx, cy: m.cy, r: m.r }; navigator.vibrate?.(10); }
    renderCompass();
    return;
  }
  if (Math.abs(compassSweep(m)) * m.r * a.k < 3) return;
  const it = compassArc(m, prefs.color, prefs.sizes.shape);
  a.p.items.push(it); drawAdded(a.pe, a.p, [it]); commit(a.p, a.before);
}
/* Zirkel sichtbar lassen (gestrichelter Kreis + Mittelpunkt), solange das Zirkel-Werkzeug aktiv ist */
function renderCompass() {
  document.querySelectorAll('.compass-ov').forEach(n => n.remove());
  const c = S.compass;
  if (!c || !S.note || prefs.tool !== 'shape' || prefs.shape !== 'compass') return;
  const pe = pageEls.get(c.pid); if (!pe) return;
  const sc = scale(), el = document.createElement('div');
  el.className = 'compass-ov';
  Object.assign(el.style, { left: (c.cx - c.r) * sc + 'px', top: (c.cy - c.r) * sc + 'px', width: 2 * c.r * sc + 'px', height: 2 * c.r * sc + 'px' });
  el.innerHTML = '<i></i>';
  pe.el.appendChild(el);
}
function shapeFromAct(a = act) {
  const base = { t: 'shape', id: uid(), color: prefs.color, size: prefs.sizes.shape };
  if (prefs.dash) base.dash = true;
  if (prefs.fill && prefs.shape !== 'line' && prefs.shape !== 'arrow') { base.fillMode = prefs.fill; base.fill = fillFor(prefs.color, prefs.fill); }
  if (prefs.shape === 'line' || prefs.shape === 'arrow') {
    const [x2, y2] = snapLine(a.x0, a.y0, a.x, a.y);
    return { ...base, kind: prefs.shape, x1: a.x0, y1: a.y0, x2, y2 };
  }
  if (prefs.shape === 'triangle') {
    const y1 = Math.min(a.y0, a.y), y2 = Math.max(a.y0, a.y);
    return { ...base, kind: 'poly', pts: [[(a.x0 + a.x) / 2, y1], [Math.max(a.x0, a.x), y2], [Math.min(a.x0, a.x), y2]] };
  }
  return { ...base, kind: prefs.shape, x1: a.x0, y1: a.y0, x2: a.x, y2: a.y };
}
/* Neue Striche einfügen. Textmarker landen (Einstellung „Hinter Schrift“, Standard an) unter der Schrift,
   die sie überdecken: direkt über dem obersten überlappenden Element, das keine Schrift ist
   (Foto, Abdecken, anderer Marker). So bleiben Fotos und Abdeck-Weiß weiterhin darunter. */
const isInk = it => it.t === 'text' || it.t === 'shape' || (it.t === 'stroke' && it.tool === 'pen');
/* Formen (Werkzeug „Formen“) kommen ebenfalls unter die Stift-Schrift und Text, die sie überdecken –
   aber über andere Formen, Fotos, Marker. So bleibt Geschriebenes immer im Vordergrund. */
const isPenInk = it => it.t === 'text' || (it.t === 'stroke' && it.tool === 'pen' && !penStyle(it).solid);
function addStrokes(pe, p, items) {
  if (!items.length) return;
  const marker = items[0].tool === 'marker' && prefs.markerBehind !== false, shape = items[0].t === 'shape';
  if (!marker && !shape) { p.items.push(...items); drawAdded(pe, p, items); return; }
  const ink = marker ? isInk : isPenInk;
  const b = unionBox(items.map(bbox));
  let i = p.items.length;
  while (i > 0) {
    const o = p.items[i - 1];
    if (!ink(o) && overlaps(bbox(o), b)) break;
    i--;
  }
  // dann direkt unter die erste überdeckte Schrift (nicht weiter nach unten als nötig)
  while (i < p.items.length && !(ink(p.items[i]) && overlaps(bbox(p.items[i]), b))) i++;
  if (i === p.items.length) { p.items.push(...items); drawAdded(pe, p, items); return; }
  p.items.splice(i, 0, ...items);
  if (pe.visible) renderRegion(pe, p, b);
}
function endAct(e) {
  if (act.tool === 'btnErase') { finishBtnPage(); act = null; return; }
  const a = act; act = null;
  const { p, pe, tool } = a;
  clearTimeout(a.hold?.t); clearTimeout(a.lpT);
  if (a.lp) { if (a.ctx) clearLive(pe); return; }       // langes Drücken: nur „Einfügen“ anbieten, nichts zeichnen
  const snapped = tool === 'marker' && snapRects(a);
  if (snapped) {
    addStrokes(pe, p, snapped); clearLive(pe); commit(p, a.before);
  } else if ((tool === 'pen' || tool === 'marker') && a.recog) {
    const r = a.recog;
    const tiny = r.kind === 'markerLine' && Math.hypot(r.x2 - r.x1, r.y2 - r.y1) * a.k < 4;
    const it = tiny ? null : r.kind === 'markerLine' ? { ...a.item, pts: [[+r.x1.toFixed(2), +r.y1.toFixed(2), .5], [+r.x2.toFixed(2), +r.y2.toFixed(2), .5]] } : r;
    if (it) addStrokes(pe, p, [it]);
    clearLive(pe); commit(p, a.before);
  } else if (tool === 'pen' || tool === 'marker' || tool === 'cover') {
    smoothStroke(a);
    if (tool === 'pen' && scribbleErase(a)) renderInk(pe, p);      // Kritzeln hat gelöscht: Seite neu zeichnen
    else if (a.item.pts.length) addStrokes(pe, p, [a.item]);
    clearLive(pe); commit(p, a.before);
  } else if (tool === 'eraser' || tool === 'restyle') {
    clearLive(pe); if (a.changed) commit(p, a.before);
  } else if (tool === 'lasso') {
    clearLive(pe);
    let len = 0; for (let i = 1; i < a.poly.length; i++) len += Math.hypot(a.poly[i][0] - a.poly[i - 1][0], a.poly[i][1] - a.poly[i - 1][1]);
    if (len * a.k < 12) tapSelect(p, a.x0, a.y0); else selectPoly(p, a.poly);
  } else if (tool === 'shape' && a.cmp) {
    clearLive(pe); compassEnd(a);
  } else if (tool === 'stamp') {
    clearLive(pe); if (e.type === 'pointerup') placeStamp(a);
  } else if (tool === 'shape') {
    clearLive(pe);
    if (Math.hypot(a.x - a.x0, a.y - a.y0) * a.k > 6) { addStrokes(pe, p, [shapeFromAct(a)]); commit(p, a.before); }
  } else if (tool === 'text') {
    if (e.type === 'pointerup') textTap(p, a.x0, a.y0);
  } else if (tool === 'move' || tool === 'scale' || tool === 'rotate' || tool === 'lineEnd') {
    if (a.ctx) a.ctx.clearRect(0, 0, p.w, p.h);
    if (a.befores) commitMulti(a.befores); else commit(p, a.before);
    renderSel();
  }
}

/* ---------------- Auswahl ---------------- */
function tapSelect(p, x, y) {
  const r = 8 / scale();
  const hit = [...p.items].reverse().find(it => hitItem(it, x, y, r));
  setSel(hit ? { p, ids: new Set([hit.id]) } : null);
  if (!hit && getClip()) showPasteChip(p, x, y);
}

/* ---------------- Zwischenablage (auch zwischen Seiten und Notizen) ---------------- */
let clipMem = null;
function getClip() {
  if (clipMem) return clipMem;
  try { clipMem = JSON.parse(localStorage.getItem('notizbuch.clip')); } catch {}
  return clipMem && clipMem.length ? clipMem : null;
}
function setClip(items) {
  clipMem = structuredClone(items);
  try { localStorage.setItem('notizbuch.clip', JSON.stringify(clipMem)); } catch { try { localStorage.removeItem('notizbuch.clip'); } catch {} }
}
function removePasteChip() { document.querySelectorAll('.pastechip').forEach(n => n.remove()); }
function showPasteChip(p, x, y) {
  removePasteChip();
  const sc = scale(), el = document.createElement('div');
  el.className = 'pastechip selbar';
  Object.assign(el.style, { left: x * sc + 'px', top: y * sc + 'px' });
  el.innerHTML = '<button>Einfügen</button>';
  el.addEventListener('pointerdown', e => e.stopPropagation());
  el.addEventListener('click', () => { removePasteChip(); pasteClip(p, x, y); });
  pageEls.get(p.id).el.appendChild(el);
}
function pasteClip(p = currentPage(), x, y) {
  const clip = getClip(); if (!clip) return toast('Die Zwischenablage ist leer.');
  if (x == null) {
    // Mitte des sichtbaren Bereichs der Seite
    const r = pageEls.get(p.id).el.getBoundingClientRect(), wr = wrap.getBoundingClientRect(), k = r.width / p.w;
    x = clamp((wr.left + wr.width / 2 - r.left) / k, 0, p.w); y = clamp((wr.top + wr.height / 2 - r.top) / k, 0, p.h);
  }
  const b = unionBox(clip.map(bbox));
  const dx = clamp(x - b.w / 2, 4, Math.max(4, p.w - b.w - 4)) - b.x, dy = clamp(y - b.h / 2, 4, Math.max(4, p.h - b.h - 4)) - b.y;
  const before = snap(p);
  const items = clip.map(i => ({ ...xform(i, (a, c) => [a + dx, c + dy], 1), id: uid() }));
  p.items.push(...items);
  setTool('lasso'); refreshPage(p); commit(p, before);
  setSel({ p, ids: new Set(items.map(i => i.id)) });
}
function selectPoly(p, poly) {
  const ids = new Set();
  for (const it of p.items) {
    if (it.t === 'stroke') {
      const inside = it.pts.filter(([x, y]) => inPoly(x, y, poly)).length;
      if (inside && inside >= it.pts.length * 0.5) ids.add(it.id);
    } else {
      const b = bbox(it);
      if (inPoly(b.x + b.w / 2, b.y + b.h / 2, poly)) ids.add(it.id);
    }
  }
  setSel(ids.size ? { p, ids } : null);
}
function setSel(s) { S.sel = s; renderSel(); }
function renderSel() {
  document.querySelectorAll('.selbox').forEach(n => n.remove());
  if (!S.sel || !S.note) return;
  const { p, ids } = S.sel;
  const items = p.items.filter(i => ids.has(i.id));
  if (!items.length) { S.sel = null; return; }
  // Rahmen mit Abstand um die Auswahl (mehr Fläche zum Anfassen und Ziehen);
  // Ankerpunkte werden bei kleinen Auswahlen kleiner (--hs = Größe in px)
  const b = unionBox(items.map(bbox)), sc = scale(), pad = 18;
  const hs = clamp(Math.min(b.w, b.h) * sc * 0.16, 10, 18);
  const el = document.createElement('div');
  // Leiste unter die Auswahl legen, wenn oben kein Platz ist; rechts ausrichten, wenn sie sonst aus der Seite ragt
  el.className = 'selbox' + (b.y * sc < 110 ? ' below' : '') + (b.x > p.w * 0.45 ? ' right' : '');
  Object.assign(el.style, { left: b.x * sc - pad + 'px', top: b.y * sc - pad + 'px', width: b.w * sc + 2 * pad + 'px', height: b.h * sc + 2 * pad + 'px' });
  el.style.setProperty('--hs', hs.toFixed(1) + 'px');
  const oneFormula = items.length === 1 && isFormula(items[0]);
  // Einzelne Linie/Pfeil: Griffe an beiden Enden; sonst Ecken (proportional) und Seiten (nur Breite/Höhe)
  const line = items.length === 1 && items[0].t === 'shape' && (items[0].kind === 'line' || items[0].kind === 'arrow') ? items[0] : null;
  const grips = line
    ? [1, 2].map(i => `<div class="lend" data-i="${i}" title="Ende ziehen" style="left:${((line['x' + i] - b.x) * sc + pad).toFixed(1)}px;top:${((line['y' + i] - b.y) * sc + pad).toFixed(1)}px"></div>`).join('')
    : ['nw', 'ne', 'sw', 'se'].map(d => `<div class="handle ${d}" data-d="${d}" title="Größe ändern (Seitenverhältnis bleibt)"></div>`).join('')
      + ['n', 's', 'w', 'e'].map(d => `<div class="edge ${d === 'n' || d === 's' ? 'eh' : 'ew'} ${d}" data-d="${d}" title="${d === 'n' || d === 's' ? 'Höhe' : 'Breite'} ändern"></div>`).join('');
  el.innerHTML = `<div class="selbar">${oneFormula ? '<button data-a="formula">Formel bearbeiten</button>' : ''}<button data-a="style">Stil ändern</button><button data-a="layer">Ebene</button><button data-a="copy">Kopieren</button><button data-a="cut">Ausschneiden</button><button data-a="dup">Duplizieren</button><button data-a="stamp">Als Stempel</button><button data-a="del" class="danger">Löschen</button></div><div class="rot" title="Drehen"></div>${grips}`;
  el.addEventListener('pointerdown', e => {
    e.stopPropagation();
    if (e.target.closest('.selbar') || act) return;
    e.preventDefault(); hidePops();
    const cl = e.target.classList;
    const mode = cl.contains('lend') ? 'lineEnd' : cl.contains('handle') || cl.contains('edge') ? 'scale' : cl.contains('rot') ? 'rotate' : 'move';
    const orig = new Map(p.items.filter(i => ids.has(i.id)).map(i => [i.id, structuredClone(i)]));
    startAct(mode, p, e, { orig, axis: cl.contains('ew') ? 'x' : cl.contains('eh') ? 'y' : null, end: +e.target.dataset.i || 0 });
    if (mode === 'scale') {
      // Fixpunkt = gegenüberliegende Ecke bzw. Seite
      const d = e.target.dataset.d || 'se';
      act.ax = d.includes('w') ? b.x + b.w : b.x; act.ay = d.includes('n') ? b.y + b.h : b.y;
      act.d0 = Math.max(1, Math.hypot(act.x0 - act.ax, act.y0 - act.ay));
    }
    if (mode === 'rotate') { act.cx = b.x + b.w / 2; act.cy = b.y + b.h / 2; act.a0 = Math.atan2(act.y0 - act.cy, act.x0 - act.cx); }
    try { el.setPointerCapture(e.pointerId); } catch {}
  });
  el.querySelector('.selbar').addEventListener('click', e => {
    const btn = e.target.closest('button'), a = btn?.dataset.a; if (!a) return;
    if (a === 'formula') openFormula(p, items[0]);
    else if (a === 'stamp') saveSelAsStamp();
    else if (a === 'style') openStylePop(btn);
    else if (a === 'layer') showPop($('#layerPop'), btn);
    else selAction(a);
  });
  pageEls.get(p.id).el.appendChild(el);
}
/* ---- Auswahl verschieben, auch über Seitengrenzen ---- */
let asRaf = 0;
function autoScrollTick() {
  if (!act || act.tool !== 'move' || !act.asv) { asRaf = 0; return; }
  wrap.scrollTop += act.asv;
  moveSelTo(act.lcx, act.lcy);
  asRaf = requestAnimationFrame(autoScrollTick);
}
/* Seite, deren Fläche den Bildschirmpunkt enthält (nach Lage, nicht nach dem obersten Element:
   unter dem Finger liegt beim Ziehen ja die Auswahl selbst) */
function pageUnder(cx, cy) {
  for (const p of S.note.pages) {
    const r = pageEls.get(p.id)?.el.getBoundingClientRect();
    if (r && cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) return p;
  }
  return null;
}
function moveSelTo(cx, cy) {
  const q = pageUnder(cx, cy);
  if (q && q !== act.p) moveSelToPage(q);
  act.rect = act.pe.el.getBoundingClientRect(); act.k = act.rect.width / act.p.w;   // Lage ändert sich beim Scrollen
  const [x, y] = toPageA(cx, cy), dx = x - act.x0, dy = y - act.y0;
  applySel((a, b) => [a + dx, b + dy], 1);
}
/* Die gezogene Auswahl wechselt auf Seite q: Elemente umziehen, Koordinaten umrechnen, Verlauf beider Seiten merken */
function moveSelToPage(q) {
  const a = act, p = a.p, qe = pageEls.get(q.id);
  const rp = a.pe.el.getBoundingClientRect(), rq = qe.el.getBoundingClientRect(), k = rq.width / q.w;
  const ox = (rp.left - rq.left) / k, oy = (rp.top - rq.top) / k;
  const tr = it => ({ ...xform(it, (u, v) => [u + ox, v + oy], 1), id: it.id });
  a.befores ||= new Map([[p.id, a.before]]);
  if (!a.befores.has(q.id)) a.befores.set(q.id, snap(q));
  const moving = p.items.filter(i => a.orig.has(i.id));
  p.items = p.items.filter(i => !a.orig.has(i.id));
  q.items = [...q.items, ...moving.map(tr)];
  a.orig = new Map([...a.orig].map(([id, it]) => [id, tr(it)]));
  a.x0 += ox; a.y0 += oy;
  Object.assign(a, { p: q, pe: qe, rect: rq, k, lastBox: null });
  S.sel = { p: q, ids: S.sel.ids };
  refreshPage(p); refreshPage(q); renderSel();
}
function applySel(fn, k, da = 0, kx = k, ky = k, direct = null) {
  const { p } = act;
  p.items = p.items.map(it => act.orig.has(it.id) ? (direct || xform(act.orig.get(it.id), fn, k, da, kx, ky)) : it);
  // Nur den Bereich neu zeichnen, wo die Auswahl war und jetzt ist
  const pe = act.pe, now = unionBox(p.items.filter(it => act.orig.has(it.id)).map(bbox));
  renderRegionSoon(pe, p, act.lastBox ? unionBox([act.lastBox, now]) : unionBox([now, ...[...act.orig.values()].map(bbox)]));
  act.lastBox = now;
  if (!pe.selRaf) pe.selRaf = requestAnimationFrame(() => { pe.selRaf = 0; renderText(pe, p); renderSel(); });
}
function selAction(a) {
  if (!S.sel) return;
  const { p, ids } = S.sel, before = snap(p);
  if (a === 'copy' || a === 'cut') {
    setClip(p.items.filter(i => ids.has(i.id)));
    toast(a === 'copy' ? 'Kopiert. Mit dem Lasso auf eine freie Stelle tippen zum Einfügen.' : 'Ausgeschnitten. Mit dem Lasso auf eine freie Stelle tippen zum Einfügen.', 3500);
    if (a === 'copy') return;
  }
  if (a === 'del' || a === 'cut') { p.items = p.items.filter(i => !ids.has(i.id)); setSel(null); }
  else if (a === 'dup') {
    const copies = p.items.filter(i => ids.has(i.id)).map(i => ({ ...xform(i, (x, y) => [x + 16, y + 16], 1), id: uid() }));
    p.items.push(...copies); setSel({ p, ids: new Set(copies.map(c => c.id)) });
  }
  refreshPage(p); commit(p, before);
}

/* ---------------- Ebenen: Reihenfolge der Elemente auf der Seite ----------------
   Was später in p.items steht, liegt weiter vorne. Die ausgewählten Elemente behalten
   untereinander ihre Reihenfolge. „Eine Ebene“ springt am nächsten Element vorbei, das die
   Auswahl tatsächlich überlappt; sonst würde sich sichtbar nichts ändern. */
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function moveLayer(dir) {
  if (!S.sel) return;
  const { p, ids } = S.sel, before = snap(p);
  const sel = p.items.filter(i => ids.has(i.id)), rest = p.items.filter(i => !ids.has(i.id));
  const box = unionBox(sel.map(bbox));
  const first = p.items.findIndex(i => ids.has(i.id)), last = p.items.length - 1 - [...p.items].reverse().findIndex(i => ids.has(i.id));
  let at;                                                  // Einfügestelle in „rest“
  if (dir === 'top') at = rest.length;
  else if (dir === 'bottom') at = 0;
  else if (dir === 'up') {
    const next = p.items.findIndex((it, i) => i > last && !ids.has(it.id) && overlaps(bbox(it), box));
    if (next < 0) return toast('Liegt schon ganz vorne.', 1800);
    at = rest.indexOf(p.items[next]) + 1;
  } else {
    let prev = -1;
    for (let i = first - 1; i >= 0; i--) if (!ids.has(p.items[i].id) && overlaps(bbox(p.items[i]), box)) { prev = i; break; }
    if (prev < 0) return toast('Liegt schon ganz hinten.', 1800);
    at = rest.indexOf(p.items[prev]);
  }
  rest.splice(at, 0, ...sel);
  p.items = rest;
  if (p.items.every((x, i) => x === before[i])) return toast(dir === 'top' || dir === 'up' ? 'Liegt schon ganz vorne.' : 'Liegt schon ganz hinten.', 1800);
  refreshPage(p); renderSel(); commit(p, before);
}
$('#layerPop').addEventListener('click', e => {
  const d = e.target.closest('[data-l]')?.dataset.l; if (!d) return;
  hidePops(); moveLayer(d);
});

/* ---------------- Stil der Auswahl ändern (Farbe + Strichstärke) ---------------- */
let styleBefore = null;
const selItems = () => S.sel ? S.sel.p.items.filter(i => S.sel.ids.has(i.id)) : [];
const hasSize = it => (it.t === 'stroke' && it.tool !== 'cover') || it.t === 'shape';
function openStylePop(anchor) {
  const items = selItems(), sized = items.filter(hasSize);
  const box = $('#styleSwatches'); box.innerHTML = '';
  const cur = items.find(i => i.color && i.tool !== 'cover')?.color;
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch' + (c === cur ? ' active' : ''); b.style.background = c; b.dataset.color = c; b.setAttribute('aria-label', 'Farbe ' + c);
    box.appendChild(b);
  }
  $('#styleSizeRow').hidden = !sized.length;
  if (sized.length) {
    const avg = sized.reduce((s, i) => s + i.size, 0) / sized.length;
    $('#styleSize').max = Math.max(20, Math.ceil(avg));
    $('#styleSize').value = avg; $('#styleSizeVal').textContent = (+avg.toFixed(1)).toLocaleString('de-DE');
  }
  styleBefore = null;
  showPop($('#stylePop'), anchor);
}
function applyStyle(fn, done) {
  if (!S.sel) return;
  const { p } = S.sel;
  styleBefore ??= snap(p);
  // ausgewählte Elemente durch geänderte Kopien ersetzen (der Verlauf behält die Originale)
  p.items = p.items.map(it => { if (!S.sel.ids.has(it.id)) return it; const c = { ...it }; fn(c); return c; });
  refreshPage(p); renderSel();
  if (done) { commit(p, styleBefore); styleBefore = null; }
}
const setSelColor = c => applyStyle(it => {
  if (isFormula(it) && it.color) {
    // Formel umfärben: die Farbe steht als Attribut im SVG
    const i = it.src.indexOf(',') + 1, svg = decodeURIComponent(it.src.slice(i));
    it.src = it.src.slice(0, i) + encodeURIComponent(svg.split(`"${it.color}"`).join(`"${c}"`)); it.color = c;
    return;
  }
  if (it.t === 'img' || it.tool === 'cover') return;
  it.color = c; if (it.fill) it.fill = fillFor(c, it.fillMode || 2);
}, true);
$('#styleSwatches').addEventListener('click', e => {
  const c = e.target.closest('[data-color]')?.dataset.color; if (!c) return;
  setSelColor(c);
  document.querySelectorAll('#styleSwatches .swatch').forEach(b => b.classList.toggle('active', b.dataset.color === c));
});
$('#styleColor').addEventListener('change', e => setSelColor(e.target.value));
$('#styleSize').addEventListener('input', e => {
  const v = +e.target.value; $('#styleSizeVal').textContent = v.toLocaleString('de-DE');
  applyStyle(it => { if (hasSize(it)) it.size = v; }, false);
});
$('#styleSize').addEventListener('change', () => applyStyle(() => {}, true));

/* ---------------- Text ---------------- */
function textTap(p, x, y) {
  // Formel antippen: im Formel-Dialog bearbeiten
  const fm = [...p.items].reverse().find(it => isFormula(it) && inBox(bbox(it), x, y, 4));
  if (fm) return openFormula(p, fm);
  const hit =[...p.items].reverse().find(it => it.t === 'text' && inBox(bbox(it), x, y, 4));
  const before = snap(p);
  let it = hit;
  if (it) { it = { ...hit }; p.items[p.items.indexOf(hit)] = it; }   // bearbeitet wird eine Kopie
  else {
    it = { t: 'text', id: uid(), x, y: y - prefs.textSize * 0.68, w: Math.min(340, p.w - x - 14), text: '', size: prefs.textSize, color: prefs.color, bold: prefs.bold };
    if (it.w < 80) { it.w = 180; it.x = Math.max(8, p.w - 190); }
    p.items.push(it);
  }
  S.editing = { p, it, before };
  const pe = pageEls.get(p.id);
  renderText(pe, p); renderInk(pe, p);
  const n = pe.text.querySelector(`[data-id="${it.id}"]`);
  n.classList.add('editing');
  n.contentEditable = 'plaintext-only';
  if (n.contentEditable !== 'plaintext-only') n.contentEditable = 'true';
  n.addEventListener('blur', commitText, { once: true });
  n.focus();
  const sel = getSelection(), range = document.createRange();
  range.selectNodeContents(n); range.collapse(false); sel.removeAllRanges(); sel.addRange(range);
}
function commitText() {
  const ed = S.editing; if (!ed) return;
  S.editing = null;
  const { p, it, before } = ed;
  const pe = pageEls.get(p.id);
  const n = pe && pe.text.querySelector(`[data-id="${it.id}"]`);
  if (n) { it.text = n.innerText.replace(/\n$/, ''); n.contentEditable = 'false'; n.classList.remove('editing'); }
  if (!it.text.trim()) p.items = p.items.filter(i => i !== it);
  if (pe) { renderText(pe, p); renderInk(pe, p); }
  commit(p, before);
}
function styleEditing() {
  if (!S.editing) return;
  const { it, p } = S.editing;
  it.color = prefs.color; it.size = prefs.textSize; it.bold = prefs.bold;
  renderText(pageEls.get(p.id), p);
}

/* ---------------- Bilder ---------------- */
async function insertImage(file) {
  const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Bild konnte nicht gelesen werden')); i.src = url; });
  const max = 1600, f = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
  const c = document.createElement('canvas'); c.width = Math.round(im.naturalWidth * f); c.height = Math.round(im.naturalHeight * f);
  c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
  const src = file.type === 'image/png' ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.86);
  const p = currentPage(), pe = pageEls.get(p.id);
  let w = Math.min(p.w * 0.6, c.width), h = w * c.height / c.width;
  if (h > p.h * 0.6) { h = p.h * 0.6; w = h * c.width / c.height; }
  const r = pe.el.getBoundingClientRect(), wr = wrap.getBoundingClientRect(), k = r.width / p.w;
  const cy = clamp(((wr.top + wr.height / 2) - r.top) / k, h / 2, p.h - h / 2);
  const it = { t: 'img', id: uid(), x: (p.w - w) / 2, y: cy - h / 2, w, h, src };
  const before = snap(p);
  p.items.push(it);
  setTool('lasso');
  refreshPage(p); commit(p, before);
  setSel({ p, ids: new Set([it.id]) });
}

/* ---------------- Formeln (LaTeX) ----------------
   MathJax (vendor/mathjax, offline in der App) setzt die Formel als SVG. Auf der Seite ist sie ein Bild
   (t:'img') mit zusätzlich tex (Quelltext), color, mh (Höhe in em) – so funktionieren Verschieben, Größe,
   Drehen, Ebenen und Kopieren wie bei Fotos. Beim PDF-Speichern wird das SVG in hoher Auflösung eingebettet. */
let mjReady = null;
function loadMathJax() {
  return mjReady ||= new Promise((res, rej) => {
    window.MathJax = {
      startup: { typeset: false, ready() { MathJax.startup.defaultReady(); MathJax.startup.promise.then(res, rej); } },
      tex: { formatError: (jax, err) => { throw err; } },     // Fehler anzeigen statt rot ins Bild setzen
      svg: { fontCache: 'none' }                                // jedes SVG enthält seine Zeichen selbst
    };
    const s = document.createElement('script');
    s.src = 'vendor/mathjax/tex-svg-full.js';
    s.onerror = () => { mjReady = null; rej(new Error('Das Formel-Modul konnte nicht geladen werden.')); };
    document.head.appendChild(s);
  });
}
function texToSvg(tex, color) {
  if (MathJax.texReset) MathJax.texReset();
  const svg = MathJax.tex2svg(tex, { display: true }).querySelector('svg');
  if (!svg) throw new Error('Formel konnte nicht gesetzt werden');
  const vb = svg.getAttribute('viewBox').split(/[\s,]+/).map(Number);   // Einheiten: 1/1000 em
  const ew = vb[2] / 1000, eh = vb[3] / 1000;
  svg.removeAttribute('style'); svg.removeAttribute('role'); svg.removeAttribute('focusable');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.setAttribute('width', (ew * 40).toFixed(2)); svg.setAttribute('height', (eh * 40).toFixed(2));
  const str = new XMLSerializer().serializeToString(svg).replace(/currentColor/g, color);
  return { src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(str), ew, eh };
}
const isFormula = it => it.t === 'img' && typeof it.tex === 'string';

const MATH_KEYS = [
  ['a⁄b', '\\frac{|}{}', 'Bruch'], ['√', '\\sqrt{|}', 'Wurzel'], ['ⁿ√', '\\sqrt[|]{}', 'n-te Wurzel'],
  ['x<sup>2</sup>', '^{|}', 'Hochgestellt'], ['x<sub>1</sub>', '_{|}', 'Tiefgestellt'], ['( )', '\\left( | \\right)', 'Klammern, wachsen mit'],
  ['∑', '\\sum_{|}^{}', 'Summe'], ['∫', '\\int_{|}^{}', 'Integral'], ['lim', '\\lim_{| \\to }', 'Grenzwert'],
  ['·', '\\cdot ', 'Mal-Punkt'], ['×', '\\times ', 'Kreuz'], ['±', '\\pm ', 'Plus-minus'],
  ['≤', '\\le ', 'kleiner gleich'], ['≥', '\\ge ', 'größer gleich'], ['≠', '\\neq ', 'ungleich'], ['≈', '\\approx ', 'ungefähr'],
  ['→', '\\to ', 'Pfeil'], ['⇒', '\\Rightarrow ', 'Folgepfeil'], ['∞', '\\infty ', 'Unendlich'],
  ['π', '\\pi ', 'Pi'], ['α', '\\alpha ', 'Alpha'], ['β', '\\beta ', 'Beta'], ['λ', '\\lambda ', 'Lambda'], ['Δ', '\\Delta ', 'Delta'],
  ['<small>Vektor</small>', '\\vec{|}', 'Vektor'], ['<small>Matrix</small>', '\\begin{pmatrix} | & \\\\  & \\end{pmatrix}', 'Matrix 2×2'],
  ['<small>Text</small>', '\\text{|}', 'Normaler Text in der Formel']
];
let mathCtx = null;          // { p, it } beim Bearbeiten, sonst { p } beim Neu-Einfügen
let mathTimer = 0;
function buildMathKeys() {
  const box = $('#mathKeys');
  for (const [label, ins, title] of MATH_KEYS) {
    const b = document.createElement('button');
    b.type = 'button'; b.innerHTML = label; b.title = title; b.dataset.ins = ins;
    box.appendChild(b);
  }
  // Tasten nehmen dem Eingabefeld nicht den Fokus (Tastatur bleibt offen)
  box.addEventListener('pointerdown', e => { if (e.target.closest('button')) e.preventDefault(); });
  box.addEventListener('click', e => {
    const b = e.target.closest('[data-ins]'); if (!b) return;
    const ta = $('#mathSrc'), s = ta.selectionStart, en = ta.selectionEnd, sel = ta.value.slice(s, en);
    let ins = b.dataset.ins, caret = ins.indexOf('|');
    // markierter Text wandert an die Cursorstelle der Vorlage (z. B. markiertes x → \sqrt{x})
    ins = ins.replace('|', sel); if (caret < 0) caret = ins.length; else if (sel) caret += sel.length;
    ta.setRangeText(ins, s, en, 'end');
    ta.selectionStart = ta.selectionEnd = s + caret;
    ta.focus(); mathPreview();
  });
}
function mathPreview() {
  clearTimeout(mathTimer);
  mathTimer = setTimeout(() => {
    const tex = $('#mathSrc').value.trim(), prev = $('#mathPrev'), err = $('#mathErr');
    if (!tex) { prev.innerHTML = '<span class="hint">Hier erscheint die Vorschau</span>'; err.textContent = ''; $('#mathOk').disabled = true; return; }
    try {
      const r = texToSvg(tex, mathColor());
      prev.innerHTML = ''; const im = new Image(); im.src = r.src; im.style.height = (r.eh * 28).toFixed(1) + 'px'; prev.appendChild(im);
      err.textContent = ''; $('#mathOk').disabled = false;
    } catch (e) { err.textContent = 'Fehler: ' + (e.message || e); $('#mathOk').disabled = true; }
  }, 150);
}
const mathColor = () => mathCtx?.it?.color || prefs.color;
async function openFormula(p, it = null) {
  commitText();
  mathCtx = { p, it };
  const dlg = $('#mathDlg');
  $('#mathTitle').textContent = it ? 'Formel bearbeiten' : 'Formel einfügen';
  $('#mathOk').textContent = it ? 'Übernehmen' : 'Einfügen';
  $('#mathSrc').value = it ? it.tex : '';
  $('#mathPrev').innerHTML = '<span class="hint">Formel-Modul wird geladen …</span>'; $('#mathErr').textContent = '';
  $('#mathOk').disabled = true;
  dlg.showModal();
  try { await loadMathJax(); mathPreview(); }
  catch (e) { $('#mathErr').textContent = e.message; }
  setTimeout(() => $('#mathSrc').focus(), 50);
}
function finishFormula() {
  const ctx = mathCtx, tex = $('#mathSrc').value.trim();
  $('#mathDlg').close(); mathCtx = null;
  if (!ctx || !tex || (ctx.it && ctx.it.tex === tex)) return;
  const { p } = ctx, pe = pageEls.get(p.id), before = snap(p);
  let r;
  try { r = texToSvg(tex, ctx.it ? ctx.it.color : prefs.color); } catch (e) { toast('Fehler in der Formel: ' + e.message); return; }
  let it;
  if (ctx.it) {
    // bisherige Größe (auch nach Vergrößern mit dem Lasso) beibehalten, Mittelpunkt bleibt stehen
    const old = ctx.it, fs = old.h / old.mh, w = r.ew * fs, h = r.eh * fs;
    it = { ...old, id: old.id, src: r.src, tex, mh: r.eh, x: old.x + old.w / 2 - w / 2, y: old.y + old.h / 2 - h / 2, w, h };
    const i = p.items.findIndex(o => o.id === old.id); if (i < 0) return;
    p.items[i] = it;
  } else {
    const fs = prefs.textSize * 1.25;
    let w = r.ew * fs, h = r.eh * fs;
    if (w > p.w * 0.9) { const k = p.w * 0.9 / w; w *= k; h *= k; }
    const rr = pe.el.getBoundingClientRect(), wr = wrap.getBoundingClientRect(), k = rr.width / p.w;
    const cy = clamp(((wr.top + wr.height / 2) - rr.top) / k, h / 2, p.h - h / 2);
    it = { t: 'img', id: uid(), x: (p.w - w) / 2, y: cy - h / 2, w, h, src: r.src, tex, color: prefs.color, mh: r.eh };
    p.items.push(it);
  }
  setTool('lasso');
  refreshPage(p); commit(p, before);
  setSel({ p, ids: new Set([it.id]) });
}
/* SVG-Formel für die PDF als PNG in hoher Auflösung (ca. 450 dpi) */
async function svgToPng(src, w, h) {
  const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Formel-Bild')); i.src = src; });
  const k = Math.min(6.25, 4000 / Math.max(w, h, 1));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
  return dataUrlBytes(c.toDataURL('image/png'));
}
buildMathKeys();
$('#mathSrc').addEventListener('input', mathPreview);
$('#mathDlg').addEventListener('click', e => {
  const m = e.target.closest('[data-m]')?.dataset.m;
  if (m === 'ok') finishFormula();
  else if (m === 'cancel') { $('#mathDlg').close(); mathCtx = null; }
});
$('#mathDlg').addEventListener('cancel', () => { mathCtx = null; });

/* ---------------- Stempel ----------------
   Werkzeug „Stempel“: auf die Seite tippen (oder ziehen und loslassen) setzt den gewählten Stempel.
   Eingebaute Stempel werden aus normalen Elementen gebaut (Linien, Formen, Text) – sie lassen sich danach
   wie alles andere radieren, verschieben, umfärben. Eigene Stempel: Lasso-Auswahl → „Als Stempel“. */
const STAMPS = [
  { id: 'check', label: '✓', title: 'Häkchen' }, { id: 'cross', label: '✗', title: 'Kreuz' },
  { id: 'star', label: '★', title: 'Stern' }, { id: 'smile', label: '☺', title: 'Lächeln' },
  { id: 'sad', label: '☹', title: 'Traurig' }, { id: 'date', label: 'Datum', title: 'Heutiges Datum' },
  { id: 'done', label: 'Erledigt', title: 'Erledigt-Stempel' }
];
const stampLine = (pts, color, size) => ({ t: 'stroke', id: uid(), tool: 'pen', style: 'shape', color, size, pts: pts.map(([x, y]) => [+x.toFixed(2), +y.toFixed(2), 0.5]) });
const arcPts = (cx, cy, r, a0, a1, n = 24) => Array.from({ length: n + 1 }, (_, i) => { const t = a0 + (a1 - a0) * i / n; return [cx + r * Math.cos(t), cy + r * Math.sin(t)]; });
/* Elemente eines Stempels, Mitte bei (0,0), Höhe etwa s */
function stampItems(id, s, color) {
  const lw = Math.max(1.2, s * 0.09), sc = pts => pts.map(([x, y]) => [x * s, y * s]);
  const deg = Math.PI / 180;
  if (id === 'check') return [stampLine(sc([[-0.42, 0.02], [-0.12, 0.32], [0.45, -0.38]]), color, lw)];
  if (id === 'cross') return [stampLine(sc([[-0.35, -0.35], [0.35, 0.35]]), color, lw), stampLine(sc([[0.35, -0.35], [-0.35, 0.35]]), color, lw)];
  if (id === 'star') {
    const pts = []; for (let i = 0; i < 10; i++) { const r = i % 2 ? 0.21 : 0.52, a = -Math.PI / 2 + i * Math.PI / 5; pts.push([+(r * s * Math.cos(a)).toFixed(2), +(r * s * Math.sin(a) + s * 0.04).toFixed(2)]); }
    return [{ t: 'shape', id: uid(), kind: 'poly', pts, color, size: Math.max(1, s * 0.04), fill: fillFor(color, 2), fillMode: 2 }];
  }
  if (id === 'smile' || id === 'sad') {
    const face = { t: 'shape', id: uid(), kind: 'ellipse', x1: -s / 2, y1: -s / 2, x2: s / 2, y2: s / 2, color, size: Math.max(1, s * 0.06) };
    const eye = x => stampLine([[x * s, -0.13 * s]], color, s * 0.12);
    const mouth = id === 'smile' ? arcPts(0, 0.0 * s, 0.27 * s, 25 * deg, 155 * deg) : arcPts(0, 0.4 * s, 0.27 * s, 205 * deg, 335 * deg);
    return [face, eye(-0.17), eye(0.17), stampLine(mouth, color, Math.max(1, s * 0.07))];
  }
  const fs = s * 0.55, text = id === 'date' ? new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : 'Erledigt';
  // Textbreite genau messen, damit Rahmen und Mitte stimmen
  const mc = (stampItems.mc ||= document.createElement('canvas').getContext('2d'));
  mc.font = `700 ${fs}px ${FONT}`;
  const tw = mc.measureText(text).width, h = fs * 1.35;
  const t = { t: 'text', id: uid(), x: -tw / 2, y: -h / 2, w: tw + fs * 0.3, text, size: +fs.toFixed(1), color, bold: true };
  if (id === 'date') return [t];
  const bw = tw / 2 + fs * 0.4;
  return [{ t: 'shape', id: uid(), kind: 'rect', x1: -bw, y1: -h / 2 - fs * 0.1, x2: bw, y2: h / 2 + fs * 0.1, color, size: Math.max(1, fs * 0.1) }, t];
}
const customStamps = () => { try { return JSON.parse(localStorage.getItem('notizbuch.stamps')) || []; } catch { return []; } };
function saveCustomStamps(list) {
  try { localStorage.setItem('notizbuch.stamps', JSON.stringify(list)); return true; }
  catch { toast('Zu wenig Platz für weitere eigene Stempel. Lösche einen alten Stempel (×).'); return false; }
}
/* Stempel an (x, y) als neue Elemente */
function stampAt(x, y) {
  const sel = prefs.stamp || 'check';
  let items;
  if (sel.startsWith('c:')) {
    const cs = customStamps().find(c => c.id === sel.slice(2)); if (!cs) return [];
    items = cs.items.map(i => ({ ...i, id: uid() }));
  } else items = stampItems(sel, prefs.sizes.stamp || 32, prefs.color);
  return items.map(i => ({ ...xform(i, (a, b) => [a + x, b + y], 1), id: i.id }));
}
function stampPreview(a) {
  const ctx = a.ctx; ctx.clearRect(0, 0, a.p.w, a.p.h);
  ctx.save(); ctx.globalAlpha = 0.55; drawItems(ctx, stampAt(a.x, a.y)); ctx.restore();
}
function placeStamp(a) {
  const items = stampAt(a.x, a.y); if (!items.length) return;
  a.p.items.push(...items);
  if (items.some(i => i.t === 'text')) refreshPage(a.p); else drawAdded(a.pe, a.p, items);
  commit(a.p, a.before);
  navigator.vibrate?.(8);
}
/* Lasso-Auswahl als eigenen Stempel speichern (Mitte = Mitte der Auswahl) */
function saveSelAsStamp() {
  if (!S.sel) return;
  const items = S.sel.p.items.filter(i => S.sel.ids.has(i.id)); if (!items.length) return;
  const b = unionBox(items.map(bbox)), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const list = customStamps();
  if (list.length >= 12) return toast('Es gibt schon 12 eigene Stempel. Lösche zuerst einen (×).');
  const id = uid();
  list.push({ id, items: items.map(i => xform(i, (a, c) => [a - cx, c - cy], 1)) });
  if (!saveCustomStamps(list)) return;
  prefs.stamp = 'c:' + id; savePrefs();
  toast('Als Stempel gespeichert. Zu finden beim Stempel-Werkzeug.');
}
function stampThumb(items) {
  const c = document.createElement('canvas'); c.width = 64; c.height = 48;
  const b = unionBox(items.map(bbox)), k = Math.min(56 / Math.max(1, b.w), 40 / Math.max(1, b.h));
  const ctx = c.getContext('2d'); ctx.setTransform(k, 0, 0, k, 32 - (b.x + b.w / 2) * k, 24 - (b.y + b.h / 2) * k);
  drawItems(ctx, items, () => {});
  return c;
}
function buildStampPop() {
  const box = $('#stampGrid'); box.innerHTML = '';
  for (const s of STAMPS) {
    const b = document.createElement('button');
    b.dataset.stamp = s.id; b.title = s.title; b.textContent = s.label;
    if (s.label.length > 1) b.classList.add('word');
    box.appendChild(b);
  }
  for (const cs of customStamps()) {
    const b = document.createElement('button');
    b.dataset.stamp = 'c:' + cs.id; b.title = 'Eigener Stempel'; b.className = 'custom';
    b.appendChild(stampThumb(cs.items));
    const x = document.createElement('span'); x.className = 'del'; x.textContent = '×'; x.title = 'Stempel löschen'; x.dataset.del = cs.id;
    b.appendChild(x); box.appendChild(b);
  }
  box.querySelectorAll('[data-stamp]').forEach(b => b.classList.toggle('active', b.dataset.stamp === (prefs.stamp || 'check')));
  $('#stampHint').hidden = customStamps().length > 0;
}
function stampLabel() {
  const sel = prefs.stamp || 'check';
  if (sel.startsWith('c:')) return 'Eigener ▾';
  return (STAMPS.find(s => s.id === sel)?.label || '✓') + ' ▾';
}
$('#stampPop').addEventListener('click', e => {
  const del = e.target.closest('[data-del]');
  if (del) {
    saveCustomStamps(customStamps().filter(c => c.id !== del.dataset.del));
    if (prefs.stamp === 'c:' + del.dataset.del) prefs.stamp = 'check';
    savePrefs(); buildStampPop(); updToolbar(); return;
  }
  const b = e.target.closest('[data-stamp]'); if (!b) return;
  prefs.stamp = b.dataset.stamp; savePrefs(); hidePops(); updToolbar();
});

/* ---------------- Werkzeugleiste ---------------- */
function buildSwatches() {
  const box = $('#swatches'); box.innerHTML = '';
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch'; b.style.background = c; b.dataset.color = c; b.title = c; b.setAttribute('aria-label', 'Farbe ' + c);
    box.appendChild(b);
  }
}
const dotPx = (t, v) => clamp(v * (t === 'eraser' ? 0.4 : t === 'marker' ? 0.6 : t === 'stamp' ? 0.35 : 2), 3, 24);
/* Drei Schnellwahl-Stärken pro Werkzeug; langes Drücken speichert die aktuelle Stärke */
const PRESETS = { pen: [1, 2.5, 5], marker: [8, 16, 28], eraser: [10, 24, 48], shape: [1, 2.5, 5], stamp: [20, 32, 52], restyle: [1, 2.5, 5] };
const presetsFor = t => (prefs.presets && prefs.presets[t]) || PRESETS[t];
function updToolbar() {
  document.querySelectorAll('.tool[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === prefs.tool));
  document.querySelectorAll('.swatch').forEach(b => b.classList.toggle('active', b.dataset.color === prefs.color));
  const t = prefs.tool, sizeTool = SIZE_RANGE[t] ? t : null;
  $('#sizeBox').hidden = !sizeTool;
  if (sizeTool) {
    const [mn, mx, st] = SIZE_RANGE[t], r = $('#sizeRange');
    r.min = mn; r.max = mx; r.step = st; r.value = prefs.sizes[t];
    $('#sizeDot').style.setProperty('--d', dotPx(t, prefs.sizes[t]) + 'px');
    const pre = presetsFor(t);
    document.querySelectorAll('[data-preset]').forEach(b => {
      const v = pre[+b.dataset.preset];
      b.querySelector('i').style.setProperty('--d', clamp(dotPx(t, v), 3, 20) + 'px');
      b.classList.toggle('active', v === prefs.sizes[t]);
      b.dataset.value = v;
    });
  }
  $('#penKind').textContent = PEN_LABELS[prefs.penStyle] || '';
  document.querySelectorAll('[data-pstyle]').forEach(b => b.classList.toggle('active', b.dataset.pstyle === prefs.penStyle));
  $('#optSmooth').value = String(prefs.smoothing ?? 0);
  $('#eraserModes').hidden = t !== 'eraser';
  $('#shapeKinds').hidden = t !== 'shape';
  $('#btnFill').hidden = prefs.shape === 'compass';
  $('#stampBox').hidden = t !== 'stamp';
  $('#btnStamp').textContent = stampLabel();
  if (S.note) renderCompass();
  $('#rulerBox').hidden = t !== 'pen' && t !== 'marker';
  $('#btnRuler').classList.toggle('active', !!prefs.ruler);
  $('#btnSnap').hidden = t !== 'marker';
  $('#btnSnap').classList.toggle('active', prefs.snapText !== false);
  $('#markerBox').hidden = t !== 'marker';
  $('#btnBehind').classList.toggle('active', prefs.markerBehind !== false);
  const tr = Math.round((1 - (prefs.markerAlpha ?? 0.4)) * 100);
  $('#alphaRange').value = tr; $('#alphaVal').textContent = '◐ ' + tr + ' %'; $('#alphaPopVal').textContent = tr + ' %';
  Object.assign($('#alphaDemo').style, { background: prefs.color, opacity: prefs.markerAlpha ?? 0.4 });
  const fm = prefs.fill || 0;
  $('#btnFill').innerHTML = `<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="2" fill="currentColor" fill-opacity="${[0, 0.2, 1][fm]}" stroke="currentColor" stroke-width="2"/></svg>`;
  $('#btnFill').title = 'Füllung: ' + ['aus', 'hell', 'voll'][fm] + ' (tippen zum Wechseln)';
  $('#btnFill').classList.toggle('active', !!prefs.fill);
  $('#btnDash').classList.toggle('active', !!prefs.dash);
  $('#optScribble').checked = prefs.scribble !== false;
  $('#textOpts').hidden = t !== 'text';
  document.querySelectorAll('[data-emode]').forEach(b => b.classList.toggle('active', b.dataset.emode === prefs.emode));
  document.querySelectorAll('[data-shape]').forEach(b => b.classList.toggle('active', b.dataset.shape === prefs.shape));
  $('#textSize').value = prefs.textSize;
  $('#btnBold').classList.toggle('active', prefs.bold);
  $('#customColor').value = /^#[0-9a-f]{6}$/i.test(prefs.color) ? prefs.color : '#000000';
  $('#optFinger').checked = prefs.finger;
  $('#optEditable').checked = prefs.editable;
}
/* Jedes farbige Werkzeug merkt sich seine zuletzt gewählte Farbe (z. B. Stift schwarz, Marker rot:
   beim Zurückwechseln zum Stift ist er wieder schwarz). Der Marker startet in Gelb. */
const COLOR_TOOLS = ['pen', 'marker', 'shape', 'text', 'stamp', 'restyle'];
prefs.toolColors ||= { marker: COLORS[6] };
function setTool(t) {
  commitText();
  prefs.tool = t;
  if (t === 'pen' || t === 'marker') prefs.lastDraw = t;
  if (COLOR_TOOLS.includes(t)) {
    if (prefs.toolColors[t]) prefs.color = prefs.toolColors[t];
    else prefs.toolColors[t] = prefs.color;
  }
  savePrefs();
  if (t !== 'lasso') setSel(null);
  updToolbar();
}
function setColor(c) {
  // Lasso mit Auswahl: die Auswahl umfärben. Radierer oder Lasso ohne Auswahl: zurück zum zuletzt
  // benutzten Stift (Stift oder Marker) – in der neu gewählten Farbe.
  if (prefs.tool === 'lasso' && S.sel) { prefs.color = c; savePrefs(); setSelColor(c); updToolbar(); return; }
  if (prefs.tool === 'eraser' || prefs.tool === 'lasso') setTool(prefs.lastDraw || 'pen');
  prefs.color = c;
  if (COLOR_TOOLS.includes(prefs.tool)) prefs.toolColors[prefs.tool] = c;
  savePrefs(); updToolbar(); styleEditing();
}

const PEN_LABELS = { fountain: 'Füller', ball: 'Kuli', pencil: 'Blei', brush: 'Pinsel', calligraphy: 'Kalli' };
let lastPenTap = 0;
$('#penPop').addEventListener('click', e => {
  const b = e.target.closest('[data-pstyle]'); if (!b) return;
  prefs.penStyle = b.dataset.pstyle; savePrefs(); hidePops(); setTool('pen');
});
$('#optSmooth').addEventListener('change', e => { prefs.smoothing = +e.target.value; savePrefs(); });
$('#optScribble').addEventListener('change', e => { prefs.scribble = e.target.checked; savePrefs(); });
$('#toolbar').addEventListener('pointerdown', e => { if (S.editing && e.target.closest('button,select,input')) e.preventDefault(); });
$('#toolbar').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.tool === 'pen') {
    // Doppeltippen auf den Stift öffnet die Auswahl der Stiftart
    const t = performance.now();
    if (prefs.tool === 'pen' && t - lastPenTap < 400) { lastPenTap = 0; showPop($('#penPop'), b); }
    else { lastPenTap = t; setTool('pen'); }
  }
  else if (b.dataset.tool) {
    setTool(b.dataset.tool);
    if (b.dataset.tool === 'restyle' && !prefs.rsHint) { prefs.rsHint = true; savePrefs(); toast('Zauberstift: Farbe und Stärke wählen, dann über Striche, Formen oder Text fahren – sie übernehmen den Stil.', 5500); }
  }
  else if (b.dataset.color) setColor(b.dataset.color);
  else if (b.id === 'btnSnap') { prefs.snapText = prefs.snapText === false; savePrefs(); updToolbar(); }
  else if (b.id === 'btnRuler') { prefs.ruler = !prefs.ruler; savePrefs(); updToolbar(); }
  else if (b.id === 'btnAlpha') showPop($('#alphaPop'), b);
  else if (b.id === 'btnBehind') { prefs.markerBehind = prefs.markerBehind === false; savePrefs(); updToolbar(); }
  else if (b.id === 'btnFill') { prefs.fill = ((prefs.fill || 0) + 1) % 3; savePrefs(); updToolbar(); }
  else if (b.id === 'btnDash') { prefs.dash = !prefs.dash; savePrefs(); updToolbar(); }
  else if (b.dataset.shape) {
    prefs.shape = b.dataset.shape; savePrefs(); updToolbar();
    if (prefs.shape === 'compass' && !S.compass) toast('Zirkel: Spitze auf den Mittelpunkt setzen und nach außen ziehen. Danach am Kreis ansetzen und herumfahren.', 5000);
  }
  else if (b.dataset.emode) { prefs.emode = b.dataset.emode; savePrefs(); updToolbar(); }
  else if (b.dataset.preset) {
    if (presetSaved) { presetSaved = false; return; }
    prefs.sizes[prefs.tool] = +b.dataset.value; savePrefs(); updToolbar();
  }
  else if (b.id === 'btnBold') { prefs.bold = !prefs.bold; savePrefs(); updToolbar(); styleEditing(); }
  else if (b.id === 'btnImage') { commitText(); $('#fileImg').click(); }
  else if (b.id === 'btnStamp') { buildStampPop(); showPop($('#stampPop'), b); }
  else if (b.id === 'btnFormula') { if (S.note) openFormula(currentPage()); }
});
let presetTimer = 0, presetSaved = false;
$('#sizePresets').addEventListener('pointerdown', e => {
  const b = e.target.closest('[data-preset]'); if (!b) return;
  clearTimeout(presetTimer);
  presetTimer = setTimeout(() => {
    const t = prefs.tool, list = [...presetsFor(t)];
    list[+b.dataset.preset] = prefs.sizes[t];
    prefs.presets = { ...(prefs.presets || {}), [t]: list };
    presetSaved = true; savePrefs(); updToolbar();
    navigator.vibrate?.(15);
    toast(`Stärke ${prefs.sizes[t]} auf ${['Fein', 'Mittel', 'Dick'][+b.dataset.preset]} gespeichert.`, 2000);
  }, 550);
});
for (const t of ['pointerup', 'pointerleave', 'pointercancel']) $('#sizePresets').addEventListener(t, () => clearTimeout(presetTimer));
$('#sizePresets').addEventListener('contextmenu', e => e.preventDefault());
$('#customColor').addEventListener('input', e => setColor(e.target.value));
$('#sizeRange').addEventListener('input', e => { prefs.sizes[prefs.tool] = +e.target.value; savePrefs(); updToolbar(); });
$('#alphaRange').addEventListener('input', e => { prefs.markerAlpha = +(1 - e.target.value / 100).toFixed(2); savePrefs(); updToolbar(); });
$('#textSize').addEventListener('change', e => { prefs.textSize = +e.target.value; savePrefs(); styleEditing(); });
$('#fileImg').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (f) try { await insertImage(f); } catch (err) { toast(err.message); }
});

/* ---------------- Menüs ---------------- */
function showPop(pop, anchor) {
  hidePops();
  pop.hidden = false;
  const r = anchor.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
  pop.style.left = clamp(r.right - pw, 8, innerWidth - pw - 8) + 'px';
  pop.style.top = (r.bottom + 6 + ph > innerHeight - 8 ? Math.max(8, r.top - ph - 6) : r.bottom + 6) + 'px';
}
function hidePops() { document.querySelectorAll('.popover').forEach(p => p.hidden = true); }
document.addEventListener('pointerdown', e => { if (!e.target.closest('.popover, #btnMenu, #btnBackup, #btnSettings, .card-menu, .thumb-menu')) hidePops(); });

$('#btnMenu').addEventListener('click', e => { commitText(); $('#menuPop').hidden ? showPop($('#menuPop'), e.currentTarget) : hidePops(); });
$('#menuPop').addEventListener('click', async e => {
  const m = e.target.closest('button')?.dataset.m; if (!m) return;
  hidePops();
  if (m === 'addPage') addPage();
  else if (m === 'dupPage') duplicatePage();
  else if (m === 'bgPage') openBgDlg();
  else if (m === 'paste') pasteClip();
  else if (m === 'insPdf') pickInsertPdf();
  else if (m === 'mark') toggleMark();
  else if (m === 'delPage') deletePage();
  else if (m === 'saveAs') saveToFile(true);
  else if (m === 'zoomReset') { S.zoom = 1; layout(); }
  else if (m === 'penTest') { penLog.length = 0; $('#penLog').textContent = 'Warte auf Stift …'; $('#penTest').hidden = false; penTestOn = true; }
});

/* Stift-Test: zeigt, wie Chrome die S-Pen-Tasten meldet (zur Fehlersuche) */
const penLog = [];
let lastButtons = -1;
function logPen(e) {
  if (!penTestOn) return;
  if (e.type === 'pointermove' && e.buttons === lastButtons) return;
  lastButtons = e.buttons ?? -1;
  penLog.unshift(`${e.type.replace('pointer', '')}  typ=${e.pointerType ?? '-'}  taste=${e.button ?? '-'}  tasten=${e.buttons ?? '-'}  druck=${(e.pressure ?? 0).toFixed(2)}  → ${penButton(e) || hoverButton(e) || (penBtn && e.pressure > 0) ? 'RADIERER' : 'normal'}  merkt=${penBtn ? 'Taste' : '-'}`);
  penLog.length = Math.min(penLog.length, 12);
  $('#penLog').textContent = penLog.join('\n');
}
for (const t of ['pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'contextmenu', 'auxclick'])
  window.addEventListener(t, logPen, true);
let penTestOn = false;
$('#penTestClose').addEventListener('click', () => { $('#penTest').hidden = true; penTestOn = false; });
$('#optFinger').addEventListener('change', e => { prefs.finger = e.target.checked; savePrefs(); toast(prefs.finger ? 'Finger zeichnet jetzt. Scrollen mit zwei Fingern.' : 'Finger scrollt, nur der Stift zeichnet.'); });
$('#optEditable').addEventListener('change', e => { prefs.editable = e.target.checked; savePrefs(); });

/* ---------------- Seiten: einfügen, duplizieren, verschieben, löschen ---------------- */
function pagesChanged() { layout(); buildPanel(); markDirty(); }
/* Seiten-Änderungen lassen sich als Ganzes rückgängig machen */
const pagesSnap = () => JSON.stringify(S.note.pages);
function pushPagesHist(before) {
  S.undo.push({ pages: true, before, after: pagesSnap() });
  if (S.undo.length > 60) S.undo.shift();
  S.redo.length = 0; updUndo();
}
function insertPages(i, list) {
  S.note.pages.splice(i, 0, ...list);
  const next = S.note.pages[i + list.length];
  for (const p of list) addPageEl(p, next ? pageEls.get(next.id).el : null);
  pagesChanged();
  requestAnimationFrame(() => pageEls.get(list[0].id)?.el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}
function addPage(after = currentPage()) {
  commitText();
  const before = pagesSnap(), i = S.note.pages.indexOf(after);
  const tpl = after.pdf == null ? after : [...S.note.pages].reverse().find(p => p.pdf == null);
  insertPages(i + 1, [{ id: uid(), w: after.w, h: after.h, bg: tpl ? tpl.bg : 'blank', paper: tpl?.paper, pdf: null, items: [] }]);
  pushPagesHist(before);
  toast(`Seite ${i + 2} eingefügt.`);
}
function duplicatePage(p = currentPage()) {
  commitText();
  const before = pagesSnap(), i = S.note.pages.indexOf(p), c = structuredClone(p);
  c.id = uid(); c.mark = false; c.items.forEach(it => { it.id = uid(); });
  insertPages(i + 1, [c]);
  pushPagesHist(before);
  toast(`Seite ${i + 1} dupliziert.`);
}
/* Seite vor die Seite mit beforeId setzen (ohne beforeId: ans Ende) */
function movePageTo(p, beforeId) {
  commitText();
  const before = pagesSnap(), a = S.note.pages, i = a.indexOf(p);
  a.splice(i, 1);
  const j = beforeId ? a.findIndex(x => x.id === beforeId) : a.length;
  a.splice(j < 0 ? a.length : j, 0, p);
  if (a.indexOf(p) === i) return;
  const next = a[a.indexOf(p) + 1];
  pagesHost.insertBefore(pageEls.get(p.id).el, next ? pageEls.get(next.id).el : null);
  pagesChanged(); pushPagesHist(before);
}
function movePage(p, d) {
  const a = S.note.pages, j = a.indexOf(p) + d;
  if (j < 0 || j >= a.length) return;
  movePageTo(p, d < 0 ? a[j].id : a[j + 1]?.id);
}
function deletePage(p = currentPage()) {
  if (S.note.pages.length < 2) return toast('Die letzte Seite kann nicht gelöscht werden.');
  commitText();
  const before = pagesSnap(), i = S.note.pages.indexOf(p);
  S.note.pages.splice(i, 1);
  const pe = pageEls.get(p.id); io.unobserve(pe.el); pe.el.remove(); pageEls.delete(p.id);
  if (S.sel?.p === p) setSel(null);
  pagesChanged(); pushPagesHist(before);
  toast(`Seite ${i + 1} gelöscht. „Rückgängig“ holt sie zurück.`, 4000);
}
function toggleMark(p = currentPage()) {
  p.mark = !p.mark;
  pageEls.get(p.id)?.el.classList.toggle('marked', !!p.mark);
  buildPanel(); markDirty();
  toast(p.mark ? 'Lesezeichen gesetzt.' : 'Lesezeichen entfernt.', 1500);
}

/* PDF-Seiten aus einer anderen Datei hinter einer Seite einfügen.
   Die Notiz hat genau eine Grund-PDF; neue Seiten werden an diese angehängt. */
async function insertPdfPages(file, after = currentPage()) {
  commitText();
  const add = new Uint8Array(await file.arrayBuffer());
  let merged, offset = 0, sizes = [];
  try {
    const { PDFDocument } = PDFLib;
    const src = await PDFDocument.load(add, { ignoreEncryption: true });
    if (S.origBytes) {
      const base = await PDFDocument.load(S.origBytes, { ignoreEncryption: true });
      offset = base.getPageCount();
      (await base.copyPages(src, src.getPageIndices())).forEach(pg => base.addPage(pg));
      merged = await base.save();
    } else merged = add;
    const doc = await pdfjsLib.getDocument({ data: merged.slice() }).promise;
    for (let i = offset; i < doc.numPages; i++) { const vp = (await doc.getPage(i + 1)).getViewport({ scale: 1 }); sizes.push([vp.width, vp.height]); }
    const old = S.pdf;
    S.pdf = doc; S.origBytes = new Uint8Array(merged);
    await dbPut('blobs', { id: S.note.id, bytes: S.origBytes.slice().buffer });
    old?.destroy();
  } catch (e) { return toast('Diese PDF konnte nicht eingefügt werden: ' + e.message, 6000); }
  const before = pagesSnap(), i = S.note.pages.indexOf(after);
  insertPages(i + 1, sizes.map(([w, h], k) => ({ id: uid(), w, h, bg: 'pdf', pdf: offset + k, items: [] })));
  pushPagesHist(before);
  pageEls.forEach(pe => { pe.sc = null; }); scheduleRender();
  toast(`${sizes.length} PDF-Seite(n) aus „${file.name}“ eingefügt.`, 4000);
}
let insertAfter = null;
async function pickInsertPdf(after = currentPage()) {
  insertAfter = after;
  if (!FSA) return $('#fileInsert').click();
  try {
    const [h] = await window.showOpenFilePicker({ types: [{ description: 'PDF-Dokument', accept: { 'application/pdf': ['.pdf'], 'application/octet-stream': [] } }] });
    await insertPdfPages(await h.getFile(), after);
  } catch (e) { if (e.name !== 'AbortError') toast('Öffnen fehlgeschlagen: ' + e.message, 6000); }
}
$('#fileInsert').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f && insertAfter) insertPdfPages(f, insertAfter); });

/* ---------------- Seitenübersicht (Vorschaubilder am Rand) ---------------- */
const panel = $('#pagePanel'), thumbList = $('#thumbList');
const thumbEls = new Map(), thumbQueue = new Set();
let thumbT = 0, pageTarget = null;
let onlyMarks = false;
const RIBBON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10v18l-5-4-5 4z" fill="var(--rf, none)" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
function buildPanel() {
  thumbList.innerHTML = ''; thumbEls.clear(); thumbQueue.clear();
  if (!S.note || panel.hidden) return;
  if (onlyMarks && !S.note.pages.some(p => p.mark)) onlyMarks = false;
  $('#btnMarks').classList.toggle('on', onlyMarks);
  S.note.pages.forEach((p, i) => {
    if (onlyMarks && !p.mark) return;
    const el = document.createElement('div');
    el.className = 'thumb-item' + (p.mark ? ' marked' : ''); el.dataset.id = p.id;
    el.innerHTML = `<button class="thumb-open" aria-label="Zu Seite ${i + 1}"><canvas width="10" height="10"></canvas></button>
      <div class="thumb-row"><span class="thumb-grip" title="Ziehen zum Verschieben"${onlyMarks ? ' hidden' : ''}>⠿</span><span class="thumb-no">${i + 1}</span>
      <button class="thumb-mark" aria-label="Lesezeichen für Seite ${i + 1}" title="Lesezeichen">${RIBBON}</button>
      <button class="thumb-menu" aria-label="Optionen für Seite ${i + 1}">⋯</button></div>`;
    el.querySelector('canvas').style.aspectRatio = `${p.w} / ${p.h}`;
    thumbList.appendChild(el); thumbEls.set(p.id, el); queueThumb(p.id);
  });
  markCurrentThumb();
}
$('#btnMarks').addEventListener('click', () => {
  if (!onlyMarks && !S.note.pages.some(p => p.mark)) return toast('Noch keine Lesezeichen. Tippe unter einer Seite auf das Fähnchen.', 3500);
  onlyMarks = !onlyMarks; buildPanel();
});

/* Seiten in der Übersicht am Griff ⠿ ziehen */
let drag = null;
thumbList.addEventListener('pointerdown', e => {
  const g = e.target.closest('.thumb-grip'); if (!g || drag) return;
  e.preventDefault();
  const el = g.closest('.thumb-item');
  drag = { el, pid: e.pointerId, y0: e.clientY, s0: thumbList.scrollTop, before: undefined };
  el.classList.add('dragging');
  try { g.setPointerCapture(e.pointerId); } catch {}
});
thumbList.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.pid) return;
  const lr = thumbList.getBoundingClientRect();
  if (e.clientY < lr.top + 44) thumbList.scrollTop -= 14; else if (e.clientY > lr.bottom - 44) thumbList.scrollTop += 14;
  drag.el.style.transform = `translateY(${e.clientY - drag.y0 + thumbList.scrollTop - drag.s0}px)`;
  const others = [...thumbList.children].filter(n => n !== drag.el);
  let idx = others.length;
  for (let i = 0; i < others.length; i++) { const r = others[i].getBoundingClientRect(); if (e.clientY < r.top + r.height / 2) { idx = i; break; } }
  others.forEach((n, i) => { n.classList.toggle('drop-before', i === idx); n.classList.toggle('drop-after', idx === others.length && i === others.length - 1); });
  drag.before = others[idx]?.dataset.id || null;
});
function endDrag(e) {
  if (!drag || e.pointerId !== drag.pid) return;
  const d = drag; drag = null;
  d.el.classList.remove('dragging'); d.el.style.transform = '';
  thumbList.querySelectorAll('.drop-before, .drop-after').forEach(n => n.classList.remove('drop-before', 'drop-after'));
  const p = pageById(d.el.dataset.id);
  if (e.type === 'pointerup' && p && d.before !== undefined) movePageTo(p, d.before);
}
thumbList.addEventListener('pointerup', endDrag);
thumbList.addEventListener('pointercancel', endDrag);
function queueThumb(id) {
  if (panel.hidden) return;
  thumbQueue.add(id); clearTimeout(thumbT); thumbT = setTimeout(flushThumbs, 1200);
}
async function flushThumbs() {
  // Vorschaubilder erst in einer Schreibpause erneuern
  if (act) { thumbT = setTimeout(flushThumbs, 800); return; }
  const ids = [...thumbQueue]; thumbQueue.clear();
  for (const id of ids) {
    const p = S.note && pageById(id), el = thumbEls.get(id);
    if (!p || !el) continue;
    try {
      const c = await pageThumb(p, 240), t = el.querySelector('canvas');
      if (!thumbEls.has(id)) continue;
      t.width = c.width; t.height = c.height; t.getContext('2d').drawImage(c, 0, 0);
    } catch {}
  }
}
function markCurrentThumb() {
  if (panel.hidden || !S.note) return;
  const cur = currentPage();
  thumbEls.forEach((el, id) => el.classList.toggle('current', id === cur.id));
}
let scrollT = 0;
wrap.addEventListener('scroll', () => { if (!scrollT) scrollT = setTimeout(() => { scrollT = 0; markCurrentThumb(); }, 150); }, { passive: true });

function togglePanel(show = panel.hidden) {
  panel.hidden = !show; prefs.panel = show; savePrefs();
  $('#btnPages').classList.toggle('on', show);
  if (S.note) { layout(); buildPanel(); }
}
$('#btnPages').addEventListener('click', () => { commitText(); togglePanel(); });
$('#btnPanelAdd').addEventListener('click', () => addPage(S.note.pages[S.note.pages.length - 1]));
thumbList.addEventListener('click', e => {
  const item = e.target.closest('.thumb-item'); if (!item) return;
  const p = pageById(item.dataset.id); if (!p) return;
  if (e.target.closest('.thumb-mark')) return toggleMark(p);
  if (e.target.closest('.thumb-grip')) return;
  const menu = e.target.closest('.thumb-menu');
  if (menu) {
    pageTarget = p;
    const i = S.note.pages.indexOf(p), pop = $('#pagePop');
    pop.querySelector('[data-p="mark"]').textContent = p.mark ? 'Lesezeichen entfernen' : 'Lesezeichen setzen';
    pop.querySelector('[data-p="up"]').disabled = i === 0;
    pop.querySelector('[data-p="down"]').disabled = i === S.note.pages.length - 1;
    pop.querySelector('[data-p="del"]').disabled = S.note.pages.length < 2;
    showPop(pop, menu);
  } else pageEls.get(p.id).el.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('#pagePop').addEventListener('click', e => {
  const a = e.target.closest('button')?.dataset.p, p = pageTarget; if (!a || !p) return;
  hidePops();
  if (a === 'dup') duplicatePage(p);
  else if (a === 'add') addPage(p);
  else if (a === 'bg') openBgDlg(p);
  else if (a === 'mark') toggleMark(p);
  else if (a === 'pdf') pickInsertPdf(p);
  else if (a === 'up') movePage(p, -1);
  else if (a === 'down') movePage(p, 1);
  else if (a === 'del') deletePage(p);
});

/* ---------------- Seitenhintergrund ---------------- */
let bgTarget = null;
function openBgDlg(p = currentPage()) {
  const free = S.note.pages.filter(x => x.pdf == null);
  if (!free.length) return toast('PDF-Seiten haben einen festen Hintergrund. Füge eine leere Seite ein, um ein Muster zu wählen.', 5000);
  bgTarget = p;
  const f = $('#bgForm'), ref = p.pdf == null ? p : free[0];
  f.elements.bgPattern.value = ref.bg === 'pdf' ? 'blank' : ref.bg;
  f.elements.bgColor.value = ref.paper || '#ffffff';
  f.elements.bgScope.value = p.pdf == null ? 'one' : 'all';
  f.querySelector('[name="bgScope"][value="one"]').disabled = p.pdf != null;
  $('#bgScopeOne').textContent = `Seite ${S.note.pages.indexOf(p) + 1}`;
  $('#bgNote').hidden = free.length === S.note.pages.length;
  $('#bgDlg').showModal();
}
$('#bgDlg').addEventListener('close', () => {
  if ($('#bgDlg').returnValue !== 'ok' || !S.note || !bgTarget) return;
  const f = new FormData($('#bgForm'));
  const before = pagesSnap();
  const targets = (f.get('bgScope') === 'all' ? S.note.pages : [S.note.pages.find(p => p.id === bgTarget.id)]).filter(p => p && p.pdf == null);
  for (const p of targets) {
    p.bg = f.get('bgPattern') || 'blank'; p.paper = f.get('bgColor') || '#ffffff';
    const pe = pageEls.get(p.id); if (pe) pe.sc = null;
    queueThumb(p.id);
  }
  scheduleRender(); markDirty(); pushPagesHist(before);
  toast(targets.length > 1 ? `Hintergrund für ${targets.length} Seiten geändert.` : 'Hintergrund geändert.');
});

/* ---------------- Notizen öffnen/anlegen ---------------- */
async function openNote(note) {
  Object.assign(S, { note, undo: [], redo: [], sel: null, editing: null, zoom: 1, fileDirty: !!note.unsaved, pdf: null, origBytes: null,
    snapshot: { pages: JSON.stringify(note.pages), unsaved: !!note.unsaved } });
  S.handle = revive((await dbGet('handles', note.id))?.handle) || null;
  if (S.handle?.name) note.title = S.handle.name;            // verknüpfte PDF: Titel = Dateiname
  const b = await dbGet('blobs', note.id);
  if (b) {
    S.origBytes = new Uint8Array(b.bytes);
    try { S.pdf = await pdfjsLib.getDocument({ data: S.origBytes.slice() }).promise; }
    catch (e) { toast('PDF konnte nicht gelesen werden: ' + e.message); }
  }
  $('#library').hidden = true; $('#editor').hidden = false;
  $('#noteTitle').value = note.title;
  updState(); updUndo(); updToolbar();
  panel.hidden = !prefs.panel; $('#btnPages').classList.toggle('on', !!prefs.panel);
  buildPages(); buildPanel(); wrap.scrollTop = 0; wrap.scrollLeft = 0;
}
/* Beim Schließen nie still überschreiben: fragen, was mit den Änderungen passieren soll */
function askClose() {
  const dlg = $('#closeDlg');
  $('#closeMsg').textContent = S.handle
    ? `„${S.handle.name}“ hat Änderungen, die noch nicht in der Datei sind.`
    : 'Diese Notiz ist noch nicht als PDF-Datei gespeichert.';
  dlg.querySelector('[data-choice="save"]').hidden = !S.handle;
  $('#closeSaveLabel').textContent = S.handle ? `In „${S.handle.name}“ speichern` : '';
  dlg.querySelector('[data-choice="saveAs"] b').textContent = S.handle ? 'Als neue Datei speichern …' : 'Als PDF-Datei speichern …';
  dlg.querySelector('[data-choice="saveAs"] span').textContent = S.handle ? 'Das Original bleibt unverändert' : 'Du wählst den Speicherort, z. B. Nextcloud';
  return new Promise(res => {
    const onClick = e => {
      const b = e.target.closest('[data-choice]'); if (!b) return;
      dlg.removeEventListener('click', onClick); dlg.removeEventListener('cancel', onCancel);
      dlg.close(); res(b.dataset.choice);
    };
    const onCancel = () => { dlg.removeEventListener('click', onClick); dlg.removeEventListener('cancel', onCancel); res('cancel'); };
    dlg.addEventListener('click', onClick); dlg.addEventListener('cancel', onCancel);
    dlg.showModal();
  });
}
async function closeEditor() {
  commitText();
  if (saving) await saving;                            // laufendes Speichern erst abschließen
  if (S.fileDirty) {
    const choice = await askClose();
    if (choice === 'cancel') return;
    if (choice === 'save' && !(await saveToFile(false))) return;
    if (choice === 'saveAs' && !(await saveToFile(true))) return;
    if (choice === 'discard') {
      S.note.pages = JSON.parse(S.snapshot.pages); S.note.unsaved = S.snapshot.unsaved;
    }
  }
  try { S.note.thumb = await Promise.race([makeThumb(), new Promise((_, rej) => setTimeout(rej, 4000))]); } catch {}
  await saveLocal();
  const pdf = S.pdf;
  S.note = null; S.pdf = null; S.origBytes = null; S.handle = null; setSel(null);
  pageEls.forEach(pe => { io.unobserve(pe.el); freePage(pe); }); pageEls.clear(); pagesHost.innerHTML = '';
  thumbList.innerHTML = ''; thumbEls.clear();
  pdf?.destroy();
  $('#editor').hidden = true; $('#library').hidden = false;
  if (updateReady) return location.reload();          // bereitliegendes Update jetzt übernehmen
  renderLibrary();
}
/* Kleine Vorschau einer Seite (Bibliothek, Seitenübersicht) */
async function pageThumb(p, W) {
  const r = W / p.w, pdf = S.pdf;
  const c = document.createElement('canvas'); c.width = W; c.height = Math.round(p.h * r);
  const ctx = c.getContext('2d');
  if (p.pdf != null && pdf) {
    // PDF-Hintergrund der Vorschau nur einmal rendern und dann wiederverwenden
    const cache = pdf._thumbBg ||= new Map(), key = p.pdf + ':' + W;
    let bg = cache.get(key);
    if (!bg) {
      bg = document.createElement('canvas'); bg.width = c.width; bg.height = c.height;
      const bx = bg.getContext('2d'); bx.fillStyle = '#fff'; bx.fillRect(0, 0, bg.width, bg.height);
      const pg = await pdf.getPage(p.pdf + 1);
      await pg.render({ canvasContext: bx, viewport: pg.getViewport({ scale: r }) }).promise;
      cache.set(key, bg);
    }
    ctx.drawImage(bg, 0, 0);
    ctx.setTransform(r, 0, 0, r, 0, 0); await paintOverlay(ctx, p, false);
  } else { ctx.setTransform(r, 0, 0, r, 0, 0); await paintOverlay(ctx, p, true); }
  return c;
}
const makeThumb = async () => (await pageThumb(S.note.pages[0], 300)).toDataURL('image/jpeg', 0.75);

async function newNote(paper, orient) {
  const [w, h] = orient === 'l' ? [A4[1], A4[0]] : A4;
  const now = Date.now();
  const note = {
    id: uid(), title: 'Notiz vom ' + new Date().toLocaleDateString('de-DE', { day: 'numeric', month: 'long' }),
    folder: S.folder, created: now, updated: now, pages: [{ id: uid(), w, h, bg: paper, pdf: null, items: [] }]
  };
  await dbPut('notes', note);
  openNote(note);
}

async function importPdf(file, handle) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let doc;
  try { doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise; }
  catch (e) { return toast('Diese Datei ist keine lesbare PDF: ' + e.message, 6000); }
  // Bearbeitbare Ebene aus einer früher gespeicherten Datei wiederherstellen
  let restored = null, orig = bytes, foreign = false;
  try {
    const att = Object.values((await doc.getAttachments()) || {});
    const j = att.find(a => a.filename === DATA_NAME), o = att.find(a => a.filename === ORIG_NAME);
    if (j) {
      const data = JSON.parse(new TextDecoder().decode(j.content));
      if (data.app === 'notizbuch' && Array.isArray(data.pages)) {
        // Wurde die Datei inzwischen in einer anderen App verändert? Dann gilt der aktuelle Dateiinhalt.
        if (data.sig && pdfSignature(await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true })) !== data.sig) foreign = true;
        else { restored = data; orig = o ? new Uint8Array(o.content) : null; }
      }
    }
  } catch {}
  let pages;
  if (restored) pages = restored.pages;
  else {
    pages = [];
    for (let i = 0; i < doc.numPages; i++) {
      const vp = (await doc.getPage(i + 1)).getViewport({ scale: 1 });
      pages.push({ id: uid(), w: vp.width, h: vp.height, bg: 'pdf', pdf: i, items: [] });
    }
  }
  doc.destroy();
  // Gleiche Datei schon einmal geöffnet? Dann dieselbe Notiz weiterverwenden.
  let existing = null;
  if (handle) {
    for (const row of await dbAll('handles')) {
      try { if (await revive(row.handle).isSameEntry(handle)) { existing = await dbGet('notes', row.id); break; } } catch {}
    }
  }
  // Ungespeicherte Änderungen aus der App nicht stillschweigend durch den Dateiinhalt ersetzen
  if (existing?.unsaved) {
    await openNote(existing);
    toast('Diese Datei hat noch Änderungen, die nur in der App liegen. Du siehst den Stand aus der App.', 6000);
    return;
  }
  const now = Date.now();
  const note = {
    id: existing?.id || uid(), title: file.name, fileName: file.name,
    folder: existing ? existing.folder : S.folder, created: existing?.created || now, updated: now, pages
  };
  if (orig) await dbPut('blobs', { id: note.id, bytes: orig.slice().buffer }); else await dbDel('blobs', note.id);
  if (handle) await dbPut('handles', { id: note.id, handle });
  await dbPut('notes', note);
  await openNote(note);
  // Datei ohne Endung .pdf geöffnet (z. B. in Nextcloud ohne Endung gespeichert): anbieten, sie als „Name.pdf“ neu zu speichern
  if (handle && !/\.pdf$/i.test(handle.name) && (await askPdfExt(handle.name, 'open')) === 'add') {
    await saveToFile(true, handle.name.replace(/\.+$/, '') + '.pdf');
    return;
  }
  if (restored) toast('Deine Schrift ist wieder bearbeitbar.');
  else if (foreign) toast('Diese PDF wurde in einer anderen App verändert. Du siehst den aktuellen Stand. Ältere Schrift lässt sich nur noch mit „Abdecken“ entfernen.', 8000);
  else if (!handle) toast('Die Datei ist nur als Kopie geöffnet. „Speichern“ fragt nach einem Speicherort.', 5000);
}
async function openPdfFlow() {
  if (!FSA) return $('#filePdf').click();
  try {
    const [h] = await window.showOpenFilePicker({ types: [{ description: 'PDF-Dokument', accept: { 'application/pdf': ['.pdf'], 'application/octet-stream': [] } }], multiple: false });
    await importPdf(await h.getFile(), h);
  } catch (e) { if (e.name !== 'AbortError') toast('Öffnen fehlgeschlagen: ' + e.message, 6000); }
}
$('#filePdf').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) importPdf(f, null); });

/* ---------------- Bibliothek ---------------- */
async function renderLibrary() {
  const notes = (await dbAll('notes')).sort((a, b) => b.updated - a.updated);
  const folders = [...new Set([...prefs.folders, ...notes.map(n => n.folder).filter(Boolean)])].sort((a, b) => a.localeCompare(b, 'de'));
  const fbox = $('#folders'); fbox.innerHTML = '';
  const chip = (label, val, cls = '') => {
    const b = document.createElement('button'); b.className = 'chip ' + cls; b.textContent = label;
    if (val !== null && S.folder === val) b.classList.add('active');
    b.onclick = () => {
      if (val === null) {
        const n = prompt('Name des neuen Ordners:'); if (!n || !n.trim()) return;
        prefs.folders = [...new Set([...prefs.folders, n.trim()])]; savePrefs(); S.folder = n.trim();
      } else S.folder = val;
      renderLibrary();
    };
    fbox.appendChild(b);
  };
  chip('Alle Notizen', '');
  folders.forEach(f => chip(f, f));
  chip('+ Ordner', null, 'add');

  const q = S.search.trim().toLowerCase();
  const list = notes.filter(n => (!S.folder || n.folder === S.folder) && (!q || n.title.toLowerCase().includes(q)));
  const grid = $('#noteGrid'); grid.innerHTML = '';
  for (const n of list) {
    const card = document.createElement('article'); card.className = 'card'; card.dataset.id = n.id;
    card.innerHTML = `<button class="card-open"><div class="thumb"></div></button>
      <div class="card-meta"><div class="card-text"><div class="card-title"></div><div class="card-sub"></div></div>
      <button class="card-menu" aria-label="Optionen">⋯</button></div>`;
    if (n.thumb) { const img = new Image(); img.src = n.thumb; img.alt = ''; card.querySelector('.thumb').appendChild(img); }
    card.querySelector('.card-title').textContent = n.title;
    const sub = card.querySelector('.card-sub');
    sub.textContent = fmtDate(n.updated) + (n.folder && !S.folder ? ' · ' + n.folder : '');
    if (n.fileName) { const bd = document.createElement('span'); bd.className = 'badge'; bd.textContent = 'PDF'; sub.prepend(bd); }
    if (n.unsaved && n.fileName) { const u = document.createElement('span'); u.className = 'badge unsaved'; u.textContent = 'nicht gespeichert'; u.title = 'Änderungen liegen nur in der App, nicht in der Datei'; sub.append(u); }
    card.querySelector('.card-open').onclick = () => openNote(n);
    card.querySelector('.card-menu').onclick = e => { cardTarget = n; showPop($('#cardPop'), e.currentTarget); };
    grid.appendChild(card);
  }
  $('#emptyLib').hidden = list.length > 0 || !!q;
}
let cardTarget = null;
$('#cardPop').addEventListener('click', async e => {
  const c = e.target.closest('button')?.dataset.c; if (!c || !cardTarget) return;
  hidePops();
  const n = cardTarget;
  if (c === 'rename') { const t = prompt('Neuer Titel:', n.title); if (t && t.trim()) { n.title = t.trim(); await dbPut('notes', n); } }
  else if (c === 'move') { const f = prompt('Ordnername (leer lassen für keinen Ordner):', n.folder || ''); if (f !== null) { n.folder = f.trim(); if (n.folder) prefs.folders = [...new Set([...prefs.folders, n.folder])]; savePrefs(); await dbPut('notes', n); } }
  else if (c === 'delete') {
    if (!confirm(`„${n.title}“ aus dem Notizbuch löschen?${n.fileName ? ' Die Datei in Nextcloud bleibt erhalten.' : ''}`)) return;
    await dbDel('notes', n.id); await dbDel('blobs', n.id); await dbDel('handles', n.id);
  }
  renderLibrary();
});
$('#search').addEventListener('input', e => { S.search = e.target.value; renderLibrary(); });
$('#btnOpenPdf').addEventListener('click', openPdfFlow);

/* ---------------- Sicherung aller Notizen (eine Datei, z. B. in Nextcloud) ---------------- */
function b64encode(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64decode(str) {
  const s = atob(str), u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}
async function createBackup() {
  const notes = await dbAll('notes'), blobs = await dbAll('blobs');
  if (!notes.length) return toast('Es gibt noch keine Notizen zum Sichern.');
  // stückweise zusammensetzen, damit auch große PDFs nicht den Speicher sprengen
  const parts = [`{"app":"notizbuch-backup","version":1,"created":${Date.now()},"folders":${JSON.stringify(prefs.folders)},"notes":${JSON.stringify(notes)},"blobs":[`];
  blobs.forEach((b, i) => parts.push(`${i ? ',' : ''}{"id":${JSON.stringify(b.id)},"b64":"`, b64encode(new Uint8Array(b.bytes)), '"}'));
  parts.push(']}');
  const blob = new Blob(parts, { type: 'application/json' });
  const name = `Notizbuch-Sicherung-${new Date().toISOString().slice(0, 10)}.json`;
  try {
    if (FSA) {
      const h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Notizbuch-Sicherung', accept: { 'application/json': ['.json'] } }] });
      const w = await h.createWritable(); await w.write(blob); await w.close();
      toast(`${notes.length} Notizen in „${h.name}“ gesichert.`, 4500);
    } else {
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast(`Sicherung mit ${notes.length} Notizen heruntergeladen.`, 4500);
    }
    prefs.lastBackup = Date.now(); savePrefs();
  } catch (e) { if (e.name !== 'AbortError') toast('Sicherung fehlgeschlagen: ' + e.message, 6000); }
}
async function restoreBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast('Diese Datei ist keine lesbare Sicherung.', 5000); }
  if (data.app !== 'notizbuch-backup' || !Array.isArray(data.notes)) return toast('Diese Datei ist keine Notizbuch-Sicherung.', 5000);
  const local = new Map((await dbAll('notes')).map(n => [n.id, n]));
  // Nur übernehmen, was hier fehlt oder in der Sicherung neuer ist
  const take = data.notes.filter(n => !local.has(n.id) || (n.updated || 0) > (local.get(n.id).updated || 0));
  const skipped = data.notes.length - take.length;
  if (!take.length) return toast('Alle Notizen aus der Sicherung sind hier schon aktuell.', 4500);
  if (!confirm(`${take.length} Notiz(en) aus der Sicherung übernehmen?${skipped ? ` ${skipped} sind hier schon gleich oder neuer und bleiben unverändert.` : ''}`)) return;
  const blobs = new Map((data.blobs || []).map(b => [b.id, b.b64]));
  for (const n of take) {
    if (blobs.has(n.id)) await dbPut('blobs', { id: n.id, bytes: b64decode(blobs.get(n.id)).buffer });
    await dbPut('notes', n);
  }
  prefs.folders = [...new Set([...prefs.folders, ...(data.folders || [])])]; savePrefs();
  await renderLibrary();
  toast(`${take.length} Notiz(en) wiederhergestellt.`, 4500);
}
$('#btnBackup').addEventListener('click', e => $('#backupPop').hidden ? showPop($('#backupPop'), e.currentTarget) : hidePops());
$('#backupPop').addEventListener('click', async e => {
  const b = e.target.closest('button')?.dataset.b; if (!b) return;
  hidePops();
  if (b === 'save') return createBackup();
  if (!FSA) return $('#fileBackup').click();
  try {
    const [h] = await window.showOpenFilePicker({ types: [{ description: 'Notizbuch-Sicherung', accept: { 'application/json': ['.json'] } }] });
    await restoreBackup(await h.getFile());
  } catch (err) { if (err.name !== 'AbortError') toast('Öffnen fehlgeschlagen: ' + err.message, 6000); }
});
$('#fileBackup').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) restoreBackup(f); });
$('#btnNewNote').addEventListener('click', () => $('#newDlg').showModal());
$('#newDlg').addEventListener('close', () => {
  if ($('#newDlg').returnValue !== 'ok') return;
  const f = new FormData($('#newForm'));
  newNote(f.get('paper'), f.get('orient'));
});

/* ---------------- Editor-Kopf ---------------- */
$('#btnBack').addEventListener('click', closeEditor);
$('#btnSave').addEventListener('click', () => saveToFile(false));
$('#btnUndo').addEventListener('click', undo);
$('#btnRedo').addEventListener('click', redo);
$('#noteTitle').addEventListener('input', e => { S.note.title = e.target.value; clearTimeout(S.saveT); S.saveT = setTimeout(saveLocal, 700); });
$('#noteTitle').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });

document.addEventListener('keydown', e => {
  if (!S.note || S.editing || e.target.matches('input, select, textarea')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveToFile(false); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel) { e.preventDefault(); selAction('del'); }
});
let resizeT;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => S.note && layout(), 120); });
document.addEventListener('visibilitychange', () => { if (document.hidden && S.note) { commitText(); saveLocal(); } });

/* ---------------- Start ---------------- */
buildSwatches(); updToolbar();
$('#fsaWarn').hidden = FSA;
renderLibrary();
if ('launchQueue' in window) {
  // Als installierte App mit einer PDF geöffnet („Öffnen mit …“)
  window.launchQueue.setConsumer(async params => {
    const h = params.files && params.files[0];
    if (h) { if (S.note) await closeEditor(); importPdf(await h.getFile(), h); }
  });
}
/* Updates: Die neue Version wird im Hintergrund geladen. Sobald sie bereit ist, lädt die App neu.
   In der Übersicht passiert das sofort, im Editor erst nach dem Schließen der Notiz (nichts geht verloren). */
const APP_VERSION = 45;
const versionText = NATIVE ? `Version ${APP_VERSION} · Android-App ${window.NATIVE_APP.version}` : `Version ${APP_VERSION}`;
$('#appVersion').textContent = versionText;
$('#settingsVersion').textContent = versionText;
let updateReady = false;
function applyUpdate() {
  if (S.note || saving) { updateReady = true; return; }
  location.reload();
}
/* Android-App: version.json auf der GitHub-Seite sagt, welche App-Version aktuell ist.
   Ist sie neuer, wird die APK geladen und der Android-Installer geöffnet (der Nutzer bestätigt dort). */
const UPDATE_INFO = 'https://merleverde.github.io/notizbuch/download/version.json';
let updateInfo = null;
async function checkForUpdates(manual) {
  if (!NATIVE) return manual && toast('Updates gibt es nur in der Android-App.');
  if (manual) toast('Suche nach Updates …', 2000);
  try {
    let src = UPDATE_INFO; try { src = localStorage.getItem('notizbuch.updateUrl') || UPDATE_INFO; } catch {}   // nur zum Testen änderbar
    // GitHub Pages hält version.json bis zu 10 Minuten im Zwischenspeicher – der Zusatz ?t=… holt immer den neuesten Stand
    const info = await window.NATIVE_APP.checkUpdate(src + (src.includes('?') ? '&' : '?') + 't=' + Date.now());
    info.base = src;
    try { localStorage.setItem('notizbuch.updateChecked', String(Date.now())); } catch {}
    if (+info.versionCode > window.NATIVE_APP.versionCode) {
      updateInfo = info;
      showUpdBadge();
      // Fenster von selbst nur einmal pro App-Start; der orange Knopf oben bleibt sichtbar
      if (manual || !updateLater) openUpdateDlg();
    } else if (manual) toast(`Du hast die neueste Version (${window.NATIVE_APP.version}).`, 3000);
  } catch (e) {
    if (manual) toast('Keine Verbindung zur Update-Seite. Bitte später nochmal versuchen.', 4000);
  }
}
function showUpdBadge() {
  document.querySelectorAll('.upd-badge').forEach(b => { b.hidden = false; b.textContent = 'Update ' + updateInfo.versionName; });
}
function openUpdateDlg() {
  if (!updateInfo || $('#updateDlg').open) return;
  $('#updateMsg').textContent = `Version ${updateInfo.versionName} ist verfügbar (installiert: ${window.NATIVE_APP.version}). Deine Notizen bleiben beim Aktualisieren erhalten.`;
  $('#updateDlg').showModal();
}
document.querySelectorAll('.upd-badge').forEach(b => b.addEventListener('click', () => { commitText(); hidePops(); openUpdateDlg(); }));
$('#updateDlg').addEventListener('cancel', () => { updateLater = true; });   // Zurück-Taste = „Später“
$('#updateDlg').addEventListener('click', async e => {
  const u = e.target.closest('[data-u]')?.dataset.u; if (!u) return;
  $('#updateDlg').close();
  if (u === 'later') updateLater = true;
  if (u !== 'install' || !updateInfo) return;
  commitText(); if (S.note) await saveLocal();          // lokaler Stand ist gesichert, bevor die App ersetzt wird
  toast('Update wird geladen …', 60000);
  try {
    const url = new URL(updateInfo.apk || 'Notizbuch.apk', updateInfo.base || UPDATE_INFO).href + '?v=' + updateInfo.versionCode;
    const r = await window.NATIVE_APP.installUpdate(url);
    if (r.needsPermission) toast('Bitte „Apps aus dieser Quelle zulassen“ einschalten, dann zurück und nochmal „Jetzt installieren“.', 9000);
    else toast('Bestätige jetzt im Android-Fenster „Aktualisieren“.', 6000);
  } catch (err) { toast('Update fehlgeschlagen: ' + err.message, 6000); }
});
window.nativeUpdateProgress = pct => { if (pct >= 0) toast(`Update wird geladen … ${pct} %`, 60000); };
window.nativeUpdateFailed = msg => toast('Update nicht installiert: ' + msg, 6000);

$('#btnUpdate').addEventListener('click', () => { hidePops(); checkForUpdates(true); });
$('#btnSettings').addEventListener('click', e => $('#settingsPop').hidden ? showPop($('#settingsPop'), e.currentTarget) : hidePops());
$('#settingsPop').addEventListener('click', e => { if (e.target.closest('[data-s="update"]')) { hidePops(); checkForUpdates(true); } });
// Updates von selbst suchen: beim Start und bei jedem Zurückwechseln in die App (höchstens alle 15 Sekunden – die Abfrage ist winzig).
// Gefunden → oranger Knopf „Update x.y“ oben (bleibt), dazu einmal pro App-Start das Hinweisfenster.
// „Später“ schließt nur das Fenster. Während gerade geschrieben wird, wartet die Prüfung.
let updateLater = false, lastAutoCheck = 0;
function autoCheckUpdates() {
  if (!NATIVE || Date.now() - lastAutoCheck < 15e3) return;
  if (act || S.editing || saving || document.querySelector('dialog[open]')) { setTimeout(autoCheckUpdates, 20000); return; }
  lastAutoCheck = Date.now();
  checkForUpdates(false);
}
if (NATIVE) {
  setTimeout(autoCheckUpdates, 1500);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(autoCheckUpdates, 1500); });
}

/* ---------------- Aufrufe aus der Android-App (MainActivity.java) ---------------- */
// „Öffnen mit …“: eine PDF aus einer anderen App (z. B. Nextcloud)
window.nativeOpenFile = async o => {
  if (S.note) await closeEditor();
  if (S.note) return;                                   // Schließen abgebrochen
  const h = new window.NativeFileHandle(o);
  try { await importPdf(await h.getFile(), o.writable ? h : null); }
  catch (e) { return toast('Die Datei konnte nicht geöffnet werden: ' + e.message, 6000); }
  if (!o.writable) toast('Diese App hat die Datei nur zum Lesen freigegeben. „Speichern“ fragt nach einem Speicherort.', 6000);
};
// S-Pen-Seitentaste, direkt von Android gemeldet (zusätzlich zur Erkennung im Browser; toggleEraser fängt doppelte Meldungen ab)
window.nativePenButton = () => { if (S.note) toggleEraser(); };
// Zurück-Taste: erst Menüs und Dialoge schließen, dann die Notiz; true = erledigt
window.nativeBack = () => {
  const dlg = document.querySelector('dialog[open]');
  if (dlg) { dlg.close('cancel'); dlg.dispatchEvent(new Event('cancel')); return true; }
  if ([...document.querySelectorAll('.popover')].some(p => !p.hidden)) { hidePops(); return true; }
  if (S.sel) { setSel(null); return true; }
  if (S.note) { closeEditor(); return true; }
  return false;
};

/* Vorschaubilder der Papiervorlagen in den Auswahldialogen */
function paperPreviews() {
  document.querySelectorAll('.paper-pick input').forEach(inp => {
    const c = document.createElement('canvas'); c.width = 120; c.height = 170;
    const ctx = c.getContext('2d'); ctx.setTransform(0.6, 0, 0, 0.6, 0, 0);
    drawPaper(ctx, { w: 200, h: 283, bg: inp.value });
    inp.nextElementSibling.style.backgroundImage = `url(${c.toDataURL()})`;
  });
}
paperPreviews();
