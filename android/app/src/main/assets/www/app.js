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
const PAPER = { A0: [2383.94, 3370.39], A1: [1683.78, 2383.94], A2: [1190.55, 1683.78], A3: [841.89, 1190.55], A4, A5: [419.53, 595.28] };
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif';
/* Schriftarten für Textfelder (alle auf Android eingebaut, funktionieren also auch offline) */
const FONTS = { sans: FONT, serif: '"Noto Serif", Georgia, "Times New Roman", serif', mono: '"Droid Sans Mono", "Courier New", monospace', hand: '"Dancing Script", cursive' };
const fontOf = it => FONTS[it.font] || FONT;
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

/* Pfeilspitze: Form hf = open (offen) | fill (gefüllt) | stealth (spitz), Größe hs = 0 klein, 1 mittel, 2 groß */
const HEAD_ICONS = { open: '<path d="M4 12h15M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>', fill: '<path d="M4 12h9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 6l8 6-8 6z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>', stealth: '<path d="M4 12h9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M20 12L10 6l3 6-3 6z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>' };
function headLen(it) { return Math.max(10, it.size * 4.5) * [0.65, 1, 1.5][it.hs ?? 1]; }
function arrowHead(it) {
  const { x1, y1, x2, y2 } = it, a = Math.atan2(y2 - y1, x2 - x1), L = headLen(it), hf = it.hf || 'open';
  const P = (l, da) => [x2 - l * Math.cos(a + da), y2 - l * Math.sin(a + da)];
  if (hf === 'fill') return { filled: true, pts: [P(L, -0.42), [x2, y2], P(L, 0.42)], end: P(L * Math.cos(0.42) * 0.8, 0) };
  if (hf === 'stealth') return { filled: true, pts: [P(L, -0.4), [x2, y2], P(L, 0.4), P(L * 0.6, 0)], end: P(L * 0.62, 0) };
  return { filled: false, pts: [P(L, -0.45), [x2, y2], P(L, 0.45)], end: [x2, y2] };
}
/* Bemaßung: Maßlinie mit Begrenzungsstrichen und Schrägstrichen (Bauzeichnung), Maßzahl darüber */
const dimFs = it => it.fs || 11;
function dimLabel(it) {
  if (it.text != null && it.text !== '') return it.text;
  const mm = Math.hypot(it.x2 - it.x1, it.y2 - it.y1) / 72 * 25.4 * (it.scale || 1);
  const u = it.unit ?? 'm', v = u === 'm' ? mm / 1000 : u === 'cm' ? mm / 10 : mm, dec = it.dec ?? 2;
  return v.toLocaleString('de-DE', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + (u ? ' ' + u : '');
}
function dimTextPos(it, ax, ay, bx, by) {
  let a = Math.atan2(it.y2 - it.y1, it.x2 - it.x1); if (a > Math.PI / 2) a -= Math.PI; else if (a <= -Math.PI / 2) a += Math.PI;
  return { a, mx: (ax + bx) / 2, my: (ay + by) / 2, off: dimFs(it) * 0.35 + it.size };
}
/* PDF: Maß als Vektor – Linien wie gewohnt, die Maßzahl als echte Schrift (bleibt beim Heranzoomen am PC scharf) */
async function pdfDim(out, pg, v, it) {
  const label = dimLabel(it), fs = dimFs(it), c = parseColor(it.color) || [0, 0, 0, 1];
  const font = out._nbHelv ||= await out.embedFont(PDFLib.StandardFonts.Helvetica);
  let enc; try { enc = font.encodeText(label); } catch { return false; }          // Zeichen außerhalb der Standardschrift: als Bild
  const keys = (out._nbHelvKeys ||= new Map());
  if (!keys.has(pg)) keys.set(pg, pg.node.newFontDictionary('Fd', font.ref));
  drawDim(v, it, true);
  const d = dimPts(it), { a, mx, my, off } = dimTextPos(it, d.a[0], d.a[1], d.b[0], d.b[1]);
  const w = font.widthOfTextAtSize(label, fs), co = Math.cos(a), si = Math.sin(a);
  v.alpha(1, false);
  v.ops.push(PDFLib.pushGraphicsState(), PDFLib.concatTransformationMatrix(co, si, -si, co, mx, my), PDFLib.concatTransformationMatrix(1, 0, 0, -1, 0, 0),
    PDFLib.setFillingRgbColor(c[0], c[1], c[2]), PDFLib.beginText(), PDFLib.setFontAndSize(keys.get(pg), fs),
    PDFLib.moveText(-w / 2, off + fs * 0.22), PDFLib.showText(enc), PDFLib.endText(), PDFLib.popGraphicsState());
  v.cur = {};
  return true;
}
function dimPts(it) {
  const len = Math.hypot(it.x2 - it.x1, it.y2 - it.y1) || 1, nx = -(it.y2 - it.y1) / len, ny = (it.x2 - it.x1) / len, o = it.off || 0;
  return { nx, ny, a: [it.x1 + nx * o, it.y1 + ny * o], b: [it.x2 + nx * o, it.y2 + ny * o] };
}
function drawDim(ctx, it, noText) {
  const { x1, y1, x2, y2 } = it, len = Math.hypot(x2 - x1, y2 - y1); if (len < 0.5) return;
  const ux = (x2 - x1) / len, uy = (y2 - y1) / len, nx = -uy, ny = ux, fs = dimFs(it);
  const e = Math.max(5, fs * 0.6), t = Math.max(3.5, fs * 0.4), o = it.off || 0, sg = Math.sign(o) || 1;
  const ax = x1 + nx * o, ay = y1 + ny * o, bx = x2 + nx * o, by = y2 + ny * o;     // Maßlinie (parallel verschoben)
  ctx.save();
  ctx.strokeStyle = it.color; ctx.lineWidth = it.size; ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(ax - ux * e * 0.5, ay - uy * e * 0.5); ctx.lineTo(bx + ux * e * 0.5, by + uy * e * 0.5);   // Maßlinie (leicht überstehend)
  for (const [px, py, qx, qy] of [[x1, y1, ax, ay], [x2, y2, bx, by]]) {
    // Maßhilfslinie: vom gemessenen Punkt (kleine Lücke) bis etwas über die Maßlinie hinaus
    if (Math.abs(o) > e) { const g = Math.min(3, Math.abs(o) * 0.2); ctx.moveTo(px + nx * sg * g, py + ny * sg * g); ctx.lineTo(qx + nx * sg * e * 0.6, qy + ny * sg * e * 0.6); }
    else { ctx.moveTo(qx - nx * e, qy - ny * e); ctx.lineTo(qx + nx * e, qy + ny * e); }
    const dx = (ux + nx) * Math.SQRT1_2 * t, dy = (uy + ny) * Math.SQRT1_2 * t;                      // 45°-Schrägstrich
    ctx.moveTo(qx - dx, qy - dy); ctx.lineTo(qx + dx, qy + dy);
  }
  ctx.stroke();
  if (noText) { ctx.restore(); return; }
  // Maßzahl mittig über der Linie, immer lesbar (nie kopfüber)
  const { a, mx, my, off } = dimTextPos(it, ax, ay, bx, by);
  ctx.translate(mx, my); ctx.rotate(a);
  ctx.fillStyle = it.color; ctx.font = `${fs}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText(dimLabel(it), 0, -off);
  ctx.restore();
}
const closedShape = it => it.kind === 'rect' || it.kind === 'ellipse' || it.kind === 'poly';
function drawShape(ctx, it) {
  if (it.kind === 'dim') return drawDim(ctx, it);
  ctx.save();
  ctx.strokeStyle = it.color; ctx.lineWidth = it.size; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const { x1, y1, x2, y2 } = it;
  if (it.dash) ctx.setLineDash([Math.max(3, it.size * 3), Math.max(3, it.size * 2.5)]);
  ctx.beginPath();
  if (it.kind === 'poly') { it.pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); }
  else if (it.kind === 'rect') ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
  else if (it.kind === 'ellipse') ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
  else {
    const hd = it.kind === 'arrow' ? arrowHead(it) : null;
    ctx.moveTo(x1, y1); ctx.lineTo(...(hd ? hd.end : [x2, y2]));
    if (hd && !hd.filled) { const [p, q, r] = hd.pts; ctx.moveTo(...p); ctx.lineTo(...q); ctx.lineTo(...r); }
    if (hd && hd.filled) {
      // gefüllte Spitze: erst die Linie, dann die Spitze (ohne Strichelung) darüber
      if (!it.noStroke) ctx.stroke();
      ctx.setLineDash([]); ctx.beginPath(); hd.pts.forEach((pt, i) => i ? ctx.lineTo(...pt) : ctx.moveTo(...pt)); ctx.closePath();
      ctx.fillStyle = it.color; ctx.fill(); ctx.lineWidth = Math.min(it.size, 2); ctx.stroke();
      ctx.restore(); return;
    }
  }
  // helle Füllung immer aus der Linienfarbe berechnen: so werden auch ältere (deckende) helle Füllungen durchscheinend
  if (it.fill && closedShape(it)) { ctx.fillStyle = it.fillMode === 1 ? fillFor(it.color, 1) : it.fill; ctx.fill(); }
  if (!it.noStroke) ctx.stroke();
  if (it.hatch && closedShape(it)) drawHatch(ctx, it);
  ctx.restore();
}

/* ---------------- Schraffuren (Baustoffe) ----------------
   Die Linien werden selbst berechnet und an der Form abgeschnitten (kein clip, kein Muster):
   so sieht die Schraffur in der App und in der gespeicherten PDF gleich aus und bleibt dort scharf.
   Abstände in pt (1 mm ≈ 2,83 pt). */
const HATCHES = {
  rc:       { label: 'Stahlbeton', title: 'Stahlbeton: Schraffur unter 45°, abwechselnd durchgezogen und gestrichelt' },
  steel:    { label: 'Stahl',      title: 'Stahl: enge Schraffur unter 45°' },
  wood:     { label: 'Holz',       title: 'Holz in Faserrichtung (entlang der langen Seite)' },
  endgrain: { label: 'Hirnholz',   title: 'Hirnholz: Auskreuzung von Ecke zu Ecke' },
  soil:     { label: 'Erdreich',   title: 'Erdreich (gewachsener Boden): Dreiergruppen unter 45°' },
  insul:    { label: 'Dämmung weich', title: 'Weicher Dämmstoff: Bögen und sich kreuzende Schrägen über die ganze Dicke' },
  insulHard: { label: 'Dämmung hart', title: 'Harter Dämmstoff: Zickzack über die ganze Dicke' }
};
// Teilstücke der Strecke a–b, die innerhalb des (geschlossenen) Vielecks liegen
function clipSeg(a, b, poly) {
  const dx = b[0] - a[0], dy = b[1] - a[1], ts = [0, 1], out = [];
  for (let i = 1; i < poly.length; i++) {
    const [px, py] = poly[i - 1], ex = poly[i][0] - px, ey = poly[i][1] - py, den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((px - a[0]) * ey - (py - a[1]) * ex) / den, u = ((px - a[0]) * dy - (py - a[1]) * dx) / den;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
  }
  ts.sort((p, q) => p - q);
  for (let i = 1; i < ts.length; i++) {
    const t0 = ts[i - 1], t1 = ts[i], tm = (t0 + t1) / 2;
    if (t1 - t0 > 1e-6 && inPoly(a[0] + dx * tm, a[1] + dy * tm, poly)) out.push([[a[0] + dx * t0, a[1] + dy * t0], [a[0] + dx * t1, a[1] + dy * t1]]);
  }
  return out;
}
// Linienzug abschneiden; aneinanderstoßende Stücke bleiben ein Zug (saubere Wellenlinien)
function clipLine(pts, poly) {
  const out = []; let cur = null;
  // schnell: liegen beide Enden eines kurzen Stücks innen, wird es ohne Schnittberechnung übernommen
  const ins = pts.length > 2 ? pts.map(([x, y]) => inPoly(x, y, poly)) : null;
  for (let i = 1; i < pts.length; i++) for (const [p, q] of (ins && ins[i - 1] && ins[i] ? [[pts[i - 1], pts[i]]] : clipSeg(pts[i - 1], pts[i], poly))) {
    const e = cur && cur[cur.length - 1];
    if (e && Math.abs(e[0] - p[0]) < 1e-6 && Math.abs(e[1] - p[1]) < 1e-6) cur.push(q);
    else { cur = [p, q]; out.push(cur); }
  }
  return out;
}
// Schar paralleler Linien unter dem Winkel ang im Abstand s (am Seitenraster ausgerichtet: Nachbarformen passen zusammen)
function hatchFamily(poly, ang, s, wave = 0, sc = 1, group = [0]) {
  const c = Math.cos(ang), sn = Math.sin(ang), out = [];
  const pn = poly.map(([x, y]) => -x * sn + y * c), pd = poly.map(([x, y]) => x * c + y * sn);
  const n0 = Math.min(...pn), n1 = Math.max(...pn), d0 = Math.min(...pd) - 1, d1 = Math.max(...pd) + 1;
  if ((n1 - n0) / s > 400) s = (n1 - n0) / 400;           // Schutz bei riesigen Formen
  const P = (t, o) => [t * c - o * sn, t * sn + o * c];
  for (let k = Math.floor(n0 / s); k * s < n1; k++) for (const g of group) {
    const off = k * s + g, line = [];
    if (off <= n0 || off >= n1) continue;
    if (!wave) line.push(P(d0, off), P(d1, off));
    else for (let t = d0, st = Math.max(3 * sc, (d1 - d0) / 150); ; t = Math.min(t + st, d1)) { line.push(P(t, off + wave * Math.sin(t / (16 * sc) + k * 0.5))); if (t >= d1) break; }
    out.push(...clipLine(line, poly));
  }
  return out;
}
// Dämmstoff: Schlaufenlinie (Trochoide) entlang der langen Seite, Schlaufen reichen über die ganze Dicke
function insulLines(it, poly, sc, hard) {
  // Dämmstoff quer über die ganze Dicke, fortlaufend entlang der langen Seite
  //   weich: Bögen oben und unten (Durchmesser = Teilung), dazwischen sich kreuzende Schrägen
  //   hart:  Zickzack zwischen den beiden Rändern
  const ang = grainAngle(it, poly), c = Math.cos(ang), sn = Math.sin(ang);
  const pn = poly.map(([x, y]) => -x * sn + y * c), pd = poly.map(([x, y]) => x * c + y * sn);
  const n0 = Math.min(...pn) + 0.3, n1 = Math.max(...pn) - 0.3, d0 = Math.min(...pd), d1 = Math.max(...pd);
  const T = n1 - n0; if (T < 4 * sc) return [];               // zu dünn
  const p = Math.max(hard ? 0.25 * T : 0.2 * T, 2.5 * sc, (d1 - d0) / 400), r = p / 2;
  const P = (t, o) => [t * c - o * sn, t * sn + o * c], line = [];
  const arc = (cx, cy, a0, a1) => { for (let i = 0; i <= 10; i++) { const a = a0 + (a1 - a0) * i / 10; line.push(P(cx + r * Math.cos(a), cy + r * Math.sin(a))); } };
  for (let x = Math.floor(d0 / p) * p - p; x < d1 + p; x += p) {
    if (hard) { line.push(P(x, n1), P(x + r, n0)); continue; }
    if (T < 2 * p) { line.push(P(x, n1), P(x + r, n0)); continue; }  // flach: ohne Bögen
    arc(x + r, n0 + r, Math.PI, 2 * Math.PI);              // Bogen am einen Rand (x … x+p)
    line.push(P(x + r, n1 - r));                            // Schräge zurück zur Mitte
    arc(x + p, n1 - r, Math.PI, 0);                         // Bogen am anderen Rand (x+r … x+3r)
    line.push(P(x + p, n0 + r));                            // Schräge zum nächsten Bogen
  }
  return clipLine(line, poly);
}
// gerade Linien in Striche zerlegen (Raster entlang der Richtung ang: Striche benachbarter Linien liegen gleich)
function dashLines(lines, ang, on, off) {
  const c = Math.cos(ang), sn = Math.sin(ang), per = on + off, out = [];
  for (const [a, b] of lines) {
    let t0 = a[0] * c + a[1] * sn, t1 = b[0] * c + b[1] * sn;
    const flip = t1 < t0; if (flip) [t0, t1] = [t1, t0];
    const [p, q] = flip ? [b, a] : [a, b], L = t1 - t0 || 1;
    const at = t => [p[0] + (q[0] - p[0]) * (t - t0) / L, p[1] + (q[1] - p[1]) * (t - t0) / L];
    for (let k = Math.floor(t0 / per); k * per < t1; k++) {
      const s0 = Math.max(t0, k * per), s1 = Math.min(t1, k * per + on);
      if (s1 - s0 > 0.3) out.push([at(s0), at(s1)]);
    }
  }
  return out;
}
// Faserrichtung: entlang der längsten Seite (gedrehte Rechtecke sind Vielecke)
function grainAngle(it, poly) {
  if (it.kind !== 'poly') return Math.abs(it.x2 - it.x1) >= Math.abs(it.y2 - it.y1) ? 0 : Math.PI / 2;
  let best = -1, ang = 0;
  for (let i = 1; i < poly.length; i++) {
    const dx = poly[i][0] - poly[i - 1][0], dy = poly[i][1] - poly[i - 1][1], l = Math.hypot(dx, dy);
    if (l > best) { best = l; ang = Math.atan2(dy, dx); }
  }
  return ang;
}
const hatchCache = new Map();
function hatchLines(it, sc = 1) {
  const key = sc === 1 && [it.hatch, it.kind, it.x1, it.y1, it.x2, it.y2, it.pts ? it.pts.join(';') : ''].join('|');
  if (key && hatchCache.has(key)) return hatchCache.get(key);
  const poly = shapeOutline(it), Q = Math.PI / 4;
  let lines = [];
  if (it.hatch === 'rc') lines = [...hatchFamily(poly, -Q, 8 * sc), ...dashLines(hatchFamily(poly, -Q, 8 * sc, 0, sc, [4 * sc]), -Q, 3.5 * sc, 2 * sc)];
  else if (it.hatch === 'steel') lines = hatchFamily(poly, -Q, 2.5 * sc);
  else if (it.hatch === 'wood') lines = hatchFamily(poly, grainAngle(it, poly), 4.5 * sc, 1 * sc, sc);
  else if (it.hatch === 'soil') lines = hatchFamily(poly, -Q, 12 * sc, 0, sc, [0, 2.2 * sc, 4.4 * sc]);
  else if (it.hatch === 'insul' || it.hatch === 'insulHard') lines = insulLines(it, poly, sc, it.hatch === 'insulHard');
  else if (it.hatch === 'endgrain') {
    let a, b, c, d;
    if (it.kind === 'poly' && it.pts.length === 4) [a, b, c, d] = it.pts;
    else {
      const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      [a, b, c, d] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    }
    lines = [...clipSeg(a, c, poly), ...clipSeg(b, d, poly)];
  }
  if (key) { if (hatchCache.size > 500) hatchCache.clear(); hatchCache.set(key, lines); }
  return lines;
}
const hatchW = it => clamp(it.size * 0.45, 0.35, 1.2);
function drawHatch(ctx, it) {
  const lines = hatchLines(it); if (!lines.length) return;
  ctx.save(); ctx.setLineDash([]);
  ctx.strokeStyle = it.color; ctx.lineWidth = hatchW(it); ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
  ctx.beginPath();
  for (const l of lines) l.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  ctx.stroke(); ctx.restore();
}
// kleines Vorschaubild für Knopf und Auswahl
function hatchIcon(h) {
  const it = { kind: 'rect', x1: 3.5, y1: 6, x2: 20.5, y2: 18, hatch: h };
  const d = h ? hatchLines(it, 0.55).map(l => 'M' + l.map(([x, y]) => x.toFixed(2) + ' ' + y.toFixed(2)).join('L')).join('') : '';
  return `<svg viewBox="0 0 24 24"><path d="${d}" fill="none" stroke="currentColor" stroke-width="${h === 'steel' ? 0.7 : 1}"/><rect x="3.5" y="6" width="17" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`;
}

/* Bereichsradierer: Form in Linienzüge (Striche) umwandeln, die sich stückweise radieren lassen.
   Eine Füllung bleibt als eigene Form ohne Rand erhalten. */
function shapeToStrokes(it) {
  if (it.kind === 'dim') return [];          // Bemaßung wird beim Radieren als Ganzes gelöscht
  const base = { t: 'stroke', tool: 'pen', style: 'shape', color: it.color, size: it.size };
  if (it.dash) base.dash = true;
  const lines = [], out0 = [];
  const { x1, y1, x2, y2 } = it;
  if (it.kind === 'ellipse') {
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2, o = [];
    const n = clamp(Math.ceil(Math.PI * (rx + ry) / 3), 24, 400);
    for (let i = 0; i <= n; i++) o.push([cx + rx * Math.cos(i / n * Math.PI * 2), cy + ry * Math.sin(i / n * Math.PI * 2)]);
    lines.push(o);
  } else if (closedShape(it)) lines.push(shapeOutline(it));
  else {
    const hd = it.kind === 'arrow' ? arrowHead(it) : null;
    lines.push([[x1, y1], hd ? hd.end : [x2, y2]]);
    if (hd && !hd.filled) lines.push(hd.pts);
    if (hd && hd.filled) {
      lines.push([...hd.pts, hd.pts[0]]);
      out0.push({ t: 'shape', kind: 'poly', id: uid(), color: it.color, size: 0.5, pts: hd.pts.map(([x, y]) => [+x.toFixed(2), +y.toFixed(2)]), fill: it.color, fillMode: 2, noStroke: true });
    }
  }
  const out = [...out0];
  if ((it.fill || it.hatch) && closedShape(it)) out.push({ ...it, id: uid(), noStroke: true });
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
    if (S.hideIds && S.hideIds.has(it.id)) continue;        // wird gerade als Vorschaubild verschoben
    if (it.t === 'img') {
      const im = getImg(it.src, onImg); if (!im) continue;
      if (it.rot) { ctx.save(); ctx.translate(it.x + it.w / 2, it.y + it.h / 2); ctx.rotate(it.rot); ctx.drawImage(im, -it.w / 2, -it.h / 2, it.w, it.h); ctx.restore(); }
      else ctx.drawImage(im, it.x, it.y, it.w, it.h);
    }
    else if (it.t === 'shape') drawShape(ctx, it);
    else if (it.t === 'table') drawTable(ctx, it);
    else if (it.t === 'stroke') drawStroke(ctx, it);
    // Text liegt in derselben Ebenenfolge; das gerade bearbeitete Textfeld zeigt das Eingabefeld selbst
    else if (it.t === 'text' && !(S.editing && S.editing.it.id === it.id)) drawText(ctx, it);
  }
}

/* Tabelle: Rahmen, Gitter, optional Kopfzeile (fett, leicht hinterlegt); Text pro Zelle mit Zeilenumbruch */
function drawTable(ctx, it) {
  const { x, y, w, h, rows, cols } = it, lw = it.lw || 1;
  const cw = it.cw || Array(cols).fill(1 / cols), rh = it.rh || Array(rows).fill(1 / rows);
  const xs = [x], ys = [y];
  cw.forEach(f => xs.push(xs[xs.length - 1] + f * w)); rh.forEach(f => ys.push(ys[ys.length - 1] + f * h));
  ctx.save();
  if (it.header && rows > 1) { ctx.fillStyle = fillFor(it.color, 1); ctx.fillRect(x, y, w, ys[1] - y); }
  ctx.strokeStyle = it.color; ctx.lineWidth = lw; ctx.lineCap = 'butt';
  ctx.beginPath();
  ys.forEach(yy => { ctx.moveTo(x, yy); ctx.lineTo(x + w, yy); });
  xs.forEach(xx => { ctx.moveTo(xx, y); ctx.lineTo(xx, y + h); });
  ctx.stroke();
  ctx.fillStyle = it.color; ctx.textBaseline = 'alphabetic';
  const pad = Math.max(2, it.size * 0.3), lh = it.size * 1.25;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const txt = it.cells?.[r]?.[c]; if (!txt) continue;
    const bold = it.header && r === 0;
    ctx.font = `${bold ? 700 : 400} ${it.size}px ${FONT}`;
    const cx0 = xs[c] + pad, cwid = xs[c + 1] - xs[c] - 2 * pad, ch = ys[r + 1] - ys[r];
    const lines = [];
    for (const para of String(txt).split(/\n/)) {
      let line = '';
      for (const word of para.split(/(\s+)/)) {
        const test = line + word;
        if (line.trim() && ctx.measureText(test.trimEnd()).width > cwid) { lines.push(line.trimEnd()); line = word.trimStart(); } else line = test;
      }
      lines.push(line.trimEnd());
    }
    ctx.save(); ctx.beginPath(); ctx.rect(xs[c], ys[r], xs[c + 1] - xs[c], ch); ctx.clip();
    let ty = ys[r] + Math.max(pad, (ch - lines.length * lh) / 2) + it.size * 0.95;
    for (const l of lines) { ctx.fillText(l, cx0, ty); ty += lh; }
    ctx.restore();
  }
  ctx.restore();
}
function drawText(ctx, it) {
  ctx.save();
  ctx.fillStyle = it.color; ctx.font = `${it.bold ? 700 : 400} ${it.size}px ${fontOf(it)}`; ctx.textBaseline = 'alphabetic';
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
  if (it.t === 'shape' && it.kind === 'dim') {
    const d = dimPts(it), xs = [it.x1, it.x2, d.a[0], d.b[0]], ys = [it.y1, it.y2, d.a[1], d.b[1]], m = dimFs(it) * 1.6;
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x: x - m, y: y - m, w: Math.max(...xs) - x + 2 * m, h: Math.max(...ys) - y + 2 * m };
  }
  if (it.t === 'shape') {
    const m = it.kind === 'arrow' ? Math.max(it.size / 2, headLen(it)) : it.kind === 'dim' ? dimFs(it) * 1.6 : it.size / 2;
    return { x: Math.min(it.x1, it.x2) - m, y: Math.min(it.y1, it.y2) - m, w: Math.abs(it.x2 - it.x1) + 2 * m, h: Math.abs(it.y2 - it.y1) + 2 * m };
  }
  if (it.t === 'text') return { x: it.x, y: it.y, w: it.w, h: it.h || it.size * 1.35 };
  if (it.t === 'table') { const m = (it.lw || 1) / 2; return { x: it.x - m, y: it.y - m, w: it.w + 2 * m, h: it.h + 2 * m }; }
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
  if (it.kind === 'dim') { const d = dimPts(it); return [[it.x1, it.y1], d.a, d.b, [it.x2, it.y2]]; }
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
    if ((it.fill || it.hatch) && closedShape(it) && inPoly(x, y, o)) return true;      // gefüllte/schraffierte Formen auch innen treffen
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
    else { [it.x1, it.y1] = fn(it.x1, it.y1); [it.x2, it.y2] = fn(it.x2, it.y2); if (it.kind === 'dim' && it.off) it.off *= Math.sqrt(kx * ky); }
  } else {
    // Bild/Text: Mittelpunkt mitführen; Bilder drehen sich mit, Textfelder bleiben gerade
    const h0 = it.t === 'img' || it.t === 'table' ? it.h : (it.h || it.size * 1.35);
    const [cx, cy] = fn(it.x + it.w / 2, it.y + h0 / 2);
    let h1 = h0;
    it.w *= kx;
    if (it.t === 'img') { it.h *= ky; h1 = it.h; if (da) it.rot = ((it.rot || 0) + da) % (Math.PI * 2); }
    else if (it.t === 'table') { it.h *= ky; h1 = it.h; if (kx === ky) it.size *= k; }   // Tabelle bleibt gerade, Schrift wächst nur gleichmäßig
    else if (kx === ky) { it.size *= k; if (it.h) it.h *= k; h1 = h0 * k; }   // Text: nur gleichmäßig wächst die Schrift
    else if (it.t === 'text') delete it.auto;                                // Breite von Hand gezogen: danach nicht mehr automatisch
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
  // Endlos-Papier zählt nur mit A4-quer-Breite: sonst würde alles winzig, sobald es breit wird
  const maxW = Math.max(...S.note.pages.map(p => p.endless ? Math.min(p.w, A4[1]) : p.w));
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
    if (p.noteW) { octx.setTransform(r, 0, 0, r, -x0 * r, -y0 * r); drawNoteArea(octx, p); }
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
/* Notizfläche rechts neben einer PDF-Seite (p.pw = Breite der PDF-Seite, p.noteW = zusätzliche Breite) */
function drawNoteArea(ctx, p) {
  if (!p.noteW) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(p.pw, 0, p.noteW, p.h); ctx.clip();
  drawPaper(ctx, { ...p, bg: p.noteBg || 'grid', pdf: null });
  ctx.restore();
  ctx.save(); ctx.strokeStyle = '#9aa6a1'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(p.pw, 0); ctx.lineTo(p.pw, p.h); ctx.stroke(); ctx.restore();
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
  if (p.noteW) { octx.setTransform(r, 0, 0, r, 0, 0); drawNoteArea(octx, p); }
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
  // Nur geänderte Textfelder anfassen und erst alle schreiben, dann alle messen:
  // sonst erzwingt jedes Feld eine eigene Layout-Berechnung (beim Verschieben ruckelte das spürbar).
  const measure = [];
  for (const it of p.items) {
    if (it.t !== 'text') continue;
    let n = have.get(it.id);
    if (n) have.delete(it.id);
    else { n = document.createElement('div'); n.className = 'tx'; n.dataset.id = it.id; pe.text.appendChild(n); }
    const ed = !!(S.editing && S.editing.it.id === it.id);
    const key = [sc, it.x, it.y, it.w, it.size, it.bold, it.font, it.color, ed, ed ? '' : it.text, it.auto].join('|');
    if (n._k === key && it.h) continue;
    n._k = key;
    // neues Textfeld beim Tippen: wächst mit dem Text bis zum Seitenrand (statt gleich sehr breit zu sein)
    const auto = ed && it.auto, maxW = Math.max(40, p.w - it.x - 6);
    Object.assign(n.style, {
      left: it.x * sc + 'px', top: it.y * sc + 'px',
      width: auto ? 'max-content' : it.w * sc + 'px', minWidth: auto ? Math.min(30, maxW) * sc + 'px' : '', maxWidth: auto ? maxW * sc + 'px' : '',
      // nur das Eingabefeld beim Tippen ist sichtbar; sonst zeichnet der Canvas den Text in der richtigen Ebene
      fontSize: it.size * sc + 'px', color: ed ? it.color : 'transparent', fontWeight: it.bold ? '700' : '400', fontFamily: fontOf(it)
    });
    if (!ed) n.textContent = it.text;
    measure.push([it, n]);
  }
  for (const [it, n] of measure) it.h = n.offsetHeight / sc || it.size * 1.35;
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
  S.zoom = clamp(z, S.note.pages.some(p => p.endless) ? 0.1 : 0.5, 5);   // Endlos-Papier: weit herauszoomen für den Überblick
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
  growPage(p);
}
/* ---- Endlos-Papier: wächst, sobald Inhalt nahe an einen Rand kommt (in jede Richtung) ----
   Wächst es nach links/oben, rückt der ganze Inhalt (auch im Verlauf) nach rechts/unten; die Ansicht bleibt stehen. */
const GROW_M = 150, GROW_BY = 400, GROW_MAX = 20000;
function contentBox(p) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of p.items) { const b = bbox(it); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
function shiftPage(p, dx, dy) {
  const done = new Map();
  const mv = it => { let n = done.get(it); if (!n) { n = xform(it, (x, y) => [x + dx, y + dy], 1); done.set(it, n); } return n; };
  p.items = p.items.map(mv);
  for (const h of [...S.undo, ...S.redo]) {
    for (const e of h.multi || [h]) if (e.pid === p.id && Array.isArray(e.before)) { e.before = e.before.map(mv); e.after = e.after.map(mv); }
  }
}
function growPage(p) {
  if (!p.endless) return false;
  const b = contentBox(p); if (!b) return false;
  const need = v => v > 0 ? Math.ceil(v / GROW_BY) * GROW_BY : 0;
  let dl = need(GROW_M - b.x), dt = need(GROW_M - b.y), dr = need(b.x + b.w - (p.w - GROW_M)), db = need(b.y + b.h - (p.h - GROW_M));
  dr = Math.min(dr, Math.max(0, GROW_MAX - p.w - dl)); dl = Math.min(dl, Math.max(0, GROW_MAX - p.w));
  db = Math.min(db, Math.max(0, GROW_MAX - p.h - dt)); dt = Math.min(dt, Math.max(0, GROW_MAX - p.h));
  if (!(dl || dt || dr || db)) return false;
  if (dl || dt) shiftPage(p, dl, dt);
  p.w += dl + dr; p.h += dt + db;
  const pe = pageEls.get(p.id), sc = scale();
  if (pe) { hideDetail(pe); pe.sc = null; }
  layout();
  wrap.scrollLeft += dl * sc; wrap.scrollTop += dt * sc;
  refreshPage(p); scheduleRender(); markDirty();
  return true;
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
  multi.forEach(m => { const p = pageById(m.pid); if (p) growPage(p); });
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
    // Bilder (auch gerasterter Text) übernehmen im PDF die aktuelle Füll-Transparenz –
    // nach einer hellen Füllung oder Textmarker wären sie sonst fast unsichtbar. Darum vorher auf deckend stellen.
    this.alpha(1, false);
    this.ops.push(PDFLib.pushGraphicsState(), ...mats.map(m => PDFLib.concatTransformationMatrix(...m)), PDFLib.drawObject(key), PDFLib.popGraphicsState());
    this.cur = {};
  }
}
const needsRaster = it => it.t === 'text' || it.t === 'table' || (it.t === 'shape' && it.kind === 'dim') || (it.t === 'stroke' && it.tool === 'pen' && !!penStyle(it).grain);
function dataUrlBytes(url) { return b64decode(url.slice(url.indexOf(',') + 1)); }

/* ---- PDF: Text und Tabellen als echte Schrift (bleibt am PC beim Heranzoomen scharf) ----
   Zeilenumbrüche werden wie in der App berechnet; gezeichnet wird mit den PDF-Standardschriften
   (Standard → Helvetica, Serif → Times, Schreibmaschine → Courier). Schreibschrift und Zeichen,
   die diese Schriften nicht kennen, werden wie bisher als Bild gespeichert. */
const PDF_FONTS = { sans: ['Helvetica', 'HelveticaBold'], serif: ['TimesRoman', 'TimesRomanBold'], mono: ['Courier', 'CourierBold'] };
async function pdfFont(out, pg, fam, bold) {
  const names = PDF_FONTS[fam || 'sans']; if (!names) return null;
  const name = names[bold ? 1 : 0], fonts = (out._nbStd ||= new Map());
  if (!fonts.has(name)) fonts.set(name, await out.embedFont(PDFLib.StandardFonts[name]));
  const font = fonts.get(name), keys = (out._nbStdKeys ||= new Map()), k = name + '|' + pg.ref?.toString();
  if (!keys.has(k)) keys.set(k, pg.node.newFontDictionary('Ft', font.ref));
  return { font, key: keys.get(k) };
}
// Zeilen wie drawText/drawTable umbrechen (gemessen mit der App-Schrift, damit die Umbrüche gleich bleiben)
function wrapLines(text, size, bold, family, maxW) {
  const mc = (wrapLines.mc ||= document.createElement('canvas').getContext('2d'));
  mc.font = `${bold ? 700 : 400} ${size}px ${family}`;
  const out = [];
  for (const para of String(text).split(/\n/)) {
    let line = '';
    for (const w of para.split(/(\s+)/)) {
      const test = line + w;
      if (line.trim() && mc.measureText(test.trimEnd()).width > maxW) { out.push(line.trimEnd()); line = w.trimStart(); } else line = test;
    }
    out.push(line);
  }
  return out;
}
function pdfTextOps(v, f, size, color, lines) {
  const c = parseColor(color) || [0, 0, 0, 1];
  v.alpha(c[3] ?? 1, false);
  for (const { t, x, y } of lines) {
    if (!t) continue;
    v.ops.push(PDFLib.pushGraphicsState(), PDFLib.concatTransformationMatrix(1, 0, 0, -1, x, y), PDFLib.setFillingRgbColor(c[0], c[1], c[2]),
      PDFLib.beginText(), PDFLib.setFontAndSize(f.key, size), PDFLib.showText(f.font.encodeText(t)), PDFLib.endText(), PDFLib.popGraphicsState());
  }
  v.cur = {};
}
const canEncode = (f, t) => { try { f.font.encodeText(t); return true; } catch { return false; } };
async function pdfTextItem(out, pg, v, it) {
  const f = await pdfFont(out, pg, it.font, it.bold); if (!f) return false;
  const lines = wrapLines(it.text, it.size, it.bold, fontOf(it), it.w);
  if (!lines.every(t => canEncode(f, t))) return false;
  const lh = it.size * 1.35; let y = it.y + (lh - it.size) / 2 + it.size * 0.86;
  pdfTextOps(v, f, it.size, it.color, lines.map(t => { const o = { t, x: it.x, y }; y += lh; return o; }));
  return true;
}
async function pdfTable(out, pg, v, it) {
  const fN = await pdfFont(out, pg, 'sans', false), fB = await pdfFont(out, pg, 'sans', true);
  const { x, y, w, h, rows, cols } = it, lw = it.lw || 1;
  const cw = it.cw || Array(cols).fill(1 / cols), rh = it.rh || Array(rows).fill(1 / rows);
  const xs = [x], ys = [y];
  cw.forEach(f => xs.push(xs[xs.length - 1] + f * w)); rh.forEach(f => ys.push(ys[ys.length - 1] + f * h));
  const pad = Math.max(2, it.size * 0.3), lh = it.size * 1.25, cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const txt = it.cells?.[r]?.[c]; if (!txt) continue;
    const bold = !!(it.header && r === 0), f = bold ? fB : fN;
    const lines = wrapLines(txt, it.size, bold, FONT, xs[c + 1] - xs[c] - 2 * pad);
    if (!lines.every(t => canEncode(f, t))) return false;
    const ch = ys[r + 1] - ys[r];
    let ty = ys[r] + Math.max(pad, (ch - lines.length * lh) / 2) + it.size * 0.95;
    cells.push({ f, clip: [xs[c], ys[r], xs[c + 1] - xs[c], ch], lines: lines.map(t => { const o = { t, x: xs[c] + pad, y: ty }; ty += lh; return o; }) });
  }
  // Rahmen und Kopfzeile als Vektor, dann die Schrift
  v.save();
  if (it.header && rows > 1) { v.fillStyle = fillFor(it.color, 1); v.fillRect(x, y, w, ys[1] - y); }
  v.strokeStyle = it.color; v.lineWidth = lw; v.lineCap = 'butt';
  v.beginPath();
  ys.forEach(yy => { v.moveTo(x, yy); v.lineTo(x + w, yy); });
  xs.forEach(xx => { v.moveTo(xx, y); v.lineTo(xx, y + h); });
  v.stroke(); v.restore();
  // wie in der App: Text, der nicht in die Zelle passt, wird an der Zelle abgeschnitten
  for (const c of cells) {
    v.ops.push(PDFLib.pushGraphicsState(), PDFLib.rectangle(...c.clip), PDFLib.clip(), PDFLib.endPath());
    pdfTextOps(v, c.f, it.size, it.color, c.lines);
    v.ops.push(PDFLib.popGraphicsState()); v.cur = {};
  }
  return true;
}
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
    if (p.noteW && p.pdf != null && !withPaper) {
      // Notizfläche: Papier nur rechts neben der PDF-Seite (abgeschnitten auf diesen Bereich)
      v.ops.push(PDFLib.pushGraphicsState()); v.beginPath(); v.rect(p.pw, 0, p.noteW, p.h); v.ops.push(...v.path, PDFLib.clip(), PDFLib.endPath()); v.cur = {};
      drawPaper(v, { ...p, bg: p.noteBg || 'grid', pdf: null });
      v.ops.push(PDFLib.popGraphicsState()); v.cur = {};
      v.save(); v.strokeStyle = '#9aa6a1'; v.lineWidth = 1; v.beginPath(); v.moveTo(p.pw, 0); v.lineTo(p.pw, p.h); v.stroke(); v.restore();
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
      if (it.t === 'shape' && it.kind === 'dim') { await flush(false); if (await pdfDim(out, pg, v, it)) continue; batch.push(it); continue; }
      if (it.t === 'text' && it.text) { await flush(false); if (await pdfTextItem(out, pg, v, it)) continue; batch.push(it); continue; }
      if (it.t === 'table') { await flush(false); if (await pdfTable(out, pg, v, it)) continue; batch.push(it); continue; }
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
// Seitenfläche einer PDF-Seite um ext nach rechts (wie man sie liest) erweitern – auch bei gedrehten Seiten
function widenPdfPage(pg, ext) {
  const rot = ((pg.getRotation().angle % 360) + 360) % 360;
  const grow = b => rot === 90 ? [b.x, b.y, b.width, b.height + ext] : rot === 180 ? [b.x - ext, b.y, b.width + ext, b.height]
    : rot === 270 ? [b.x, b.y - ext, b.width, b.height + ext] : [b.x, b.y, b.width + ext, b.height];
  const mb = pg.getMediaBox(), cb = pg.getCropBox();
  pg.setMediaBox(...grow(mb)); pg.setCropBox(...grow(cb));
}
// Endlos-Papier: PDF-Seite auf den beschriebenen Bereich (+ Rand) zuschneiden, höchstens A0 (hoch oder quer)
function endlessCrop(p) {
  const b = contentBox(p), M = 28;
  if (!b) return { x: 0, y: 0, w: Math.min(p.w, A4[1]), h: Math.min(p.h, A4[0]) };
  let x = Math.max(0, b.x - M), y = Math.max(0, b.y - M), w = Math.min(p.w, b.x + b.w + M) - x, h = Math.min(p.h, b.y + b.h + M) - y;
  const [a, c] = PAPER.A0, [mw, mh] = w >= h ? [c, a] : [a, c];
  return { x, y, w: Math.min(w, mw), h: Math.min(h, mh), cut: w > mw || h > mh };
}
function cropEndless(pg, p) {
  const r = endlessCrop(p), H = pg.getHeight();
  pg.setMediaBox(r.x, H - r.y - r.h, r.w, r.h); pg.setCropBox(r.x, H - r.y - r.h, r.w, r.h);
}
async function buildPdf() {
  const { PDFDocument } = PDFLib;
  const out = await PDFDocument.create();
  const src = S.origBytes ? await PDFDocument.load(S.origBytes, { ignoreEncryption: true }) : null;
  for (const p of S.note.pages) {
    let pg;
    if (p.pdf != null && src) { [pg] = await out.copyPages(src, [p.pdf]); out.addPage(pg); if (p.noteW) widenPdfPage(pg, p.noteW); }
    else pg = out.addPage([p.w, p.h]);
    if (p.pdf != null && src && !p.items.length && !p.noteW) continue;
    await exportOverlay(out, pg, p, p.pdf == null || !src);
    if (p.endless) cropEndless(pg, p);
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
/* Nextcloud/ownCloud: Dateien aus „Öffnen mit“ kommen als Zwischenkopie der Nextcloud-App (kein Dokument-Speicherort).
   Hineinschreiben ändert nur die Kopie auf dem Tablet – hochgeladen wird zuverlässig nur über die Nextcloud-Dateiauswahl. */
const isCloud = h => !!(h && h.native && /^content:\/\/[^/]*(nextcloud|owncloud)/i.test(h.uri || ''));
const cloudCopy = h => isCloud(h) && !/^content:\/\/[^/]+\/(document|tree)\//i.test(h.uri);
async function permFix() {
  const name = S.handle?.name || pdfName();
  if (cloudCopy(S.handle)) $('#permMsg').textContent = `„${name}“ wurde über „Öffnen mit“ aus der Nextcloud-App geöffnet. Dabei landet eine Änderung nur in der Zwischenkopie der Nextcloud-App auf dem Tablet und wird nicht zuverlässig hochgeladen. Deine Notiz ist sicher in der App gespeichert. ` +
    `Tippe auf „Original auswählen …“, wähle in der Dateiauswahl links „Nextcloud“ und dort dieselbe Datei – danach speichert die App direkt in die Nextcloud.`;
  else $('#permMsg').textContent = `Die App darf „${name}“ gerade nicht mehr überschreiben. Das passiert bei Dateien, die über „Öffnen mit“ aus einer anderen App (z. B. Nextcloud) kamen, sobald die Notizbuch-App neu gestartet oder aktualisiert wurde. Deine Notiz ist sicher in der App gespeichert. ` +
    `Tippe auf „Original auswählen …“ und wähle dieselbe Datei noch einmal aus – danach speichert die App dauerhaft direkt hinein.`;
  const choice = await dialogChoice($('#permDlg'), 'p');
  if (choice === 'new') return saveToFile(true, name);
  if (choice !== 'pick') return false;
  let h;
  try { [h] = await window.showOpenFilePicker({ types: [{ description: 'PDF-Dokument', accept: { 'application/pdf': ['.pdf'], 'application/octet-stream': ['.pdf'] } }] }); }
  catch { return false; }
  if (cloudCopy(h)) { toast('Bitte die Datei in der Dateiauswahl über den Eintrag „Nextcloud“ wählen (nicht über „Zuletzt“ oder die Nextcloud-App).', 7000); return false; }
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
    if (h && cloudCopy(h)) return 'perm';                 // Zwischenkopie der Nextcloud-App: erst richtig auswählen lassen
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
    const cut = S.note.pages.some(p => p.endless && endlessCrop(p).cut);
    if (cut) setTimeout(() => toast('Hinweis: Das Endlos-Papier ist größer als A0 – im PDF wurde es auf A0 abgeschnitten (oben links beginnend).', 7000), 3500);
    toast(isCloud(h) ? `In „${h.name}“ gespeichert. Die Nextcloud-App lädt die Datei jetzt hoch – bei schlechter Verbindung kann das dauern (Stand in der Nextcloud-App unter „Uploads“).` : `In „${h.name}“ gespeichert.`, isCloud(h) ? 6500 : undefined);
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
        if (gest !== g || !g.lpT || touches.size !== 1 || !getClip()) return;
        const p = pageAt(g.sx, g.sy); if (!p) return;
        g.lp = true; navigator.vibrate?.(15);
        const [x, y] = toPage(p, g.sx, g.sy); showPasteChip(p, x, y);
      }, 2000);                                               // bewusst lang: mit dem Finger erst nach 2 s halten
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
      const dd = Math.hypot(e.clientX - gest.sx, e.clientY - gest.sy);
      if (dd > 10) gest.moved = true;
      if (dd > 18) { clearTimeout(gest.lpT); gest.lpT = 0; }       // erst bei deutlicher Bewegung kein „Einfügen“ mehr
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
  else fingerSelect(p, cx, cy);
}
/* Mit dem Finger auf ein Bild tippen (in jedem Werkzeug außer Lasso/Text, auch wenn der Finger nicht zeichnet):
   es wird ausgewählt und lässt sich dann mit dem Finger verschieben, skalieren und drehen. */
function fingerSelect(p, cx, cy) {
  if (!p) return S.sel && setSel(null);
  const [x, y] = toPage(p, cx, cy), r = 10 / scale();
  // nur Bilder (auch Formeln): Text, Handschrift und Formen bleiben beim Antippen mit dem Finger unberührt
  const hit = [...p.items].reverse().find(it => it.t === 'img' && hitItem(it, x, y, r));
  if (!hit) return S.sel && setSel(null);
  setSel({ p, ids: new Set([hit.id]) });
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
    a.lpT = setTimeout(() => { if (act === a && getClip()) longPressPaste(a, a.x0, a.y0); }, 2000);
  }
  if (tool === 'shape' && prefs.shape === 'compass') { compassStart(act); return; }
  if (tool === 'stamp') { stampPreview(act); return; }
  if (tool === 'restyle') { act.done = new Set(); restyleAt(x, y); return; }
  if (tool === 'eraser' && prefs.emode === 'cover') {
    act.tool = 'cover';
    act.item = { t: 'stroke', id: uid(), tool: 'cover', color: coverColor(act.p), size: +(prefs.sizes.eraser / act.k).toFixed(2), pts: [] };
    addPts(e);
  } else if (tool === 'pen' || tool === 'marker') {
    if (tool === 'pen' && prefs.dim && S.dimPending) {
      // zweiter Zug nach dem Messen: die Maßlinie folgt seitlich dem Stift
      const pend = S.dimPending; S.dimPending = null;
      const d = pend.pid === p.id && p.items.find(i => i.id === pend.id);
      if (d) { Object.assign(act, { tool: 'dimOffset', dim: d, off0: d.off || 0 }); return; }
    }
    act.item = { t: 'stroke', id: uid(), tool, color: prefs.color, size: prefs.sizes[tool], pts: [] };
    if (tool === 'pen') act.item.style = prefs.penStyle;
    else act.item.alpha = prefs.markerAlpha ?? 0.4;
    // Textmarker auf PDF-Seiten: Textzeilen laden, damit der Strich an ihnen einrasten kann
    if (tool === 'marker' && prefs.snapText !== false && p.pdf != null && S.pdf) {
      const a = act; pdfLines(p).then(l => { a.lines = l; }).catch(() => {});
    }
    addPts(e);
    // Lineal: der Strich wird von Anfang an als Gerade gezogen
    if (prefs.ruler || (tool === 'pen' && prefs.dim)) {
      act.recog = { kind: 'markerLine', x1: x, y1: y, x2: x, y2: y };
      if (tool === 'pen' && prefs.dim) {
        act.dimMode = true;
        const [fx, fy, h] = fangAt(act, x, y); Object.assign(act.recog, { x1: fx, y1: fy, x2: fx, y2: fy }); act.fA = h;
        act.hoverSeg = dimHoverAt(p, x, y, act.k)?.seg || null; dimHover = null;   // Antippen einer Linie = sie bemaßen
      }
      const a = act;
      a.lpT = setTimeout(() => { if (act === a && getClip()) longPressPaste(a, a.x0, a.y0); }, 2000);
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
    const still = () => a.item.pts.every(q => Math.hypot(q[0] - p0[0], q[1] - p0[1]) * a.k < 8);
    if (still()) {   // Stift steht still: „Einfügen“ erst nach insgesamt 2 s Halten
      clearTimeout(a.lpT);
      a.lpT = setTimeout(() => { if (act === a && !a.recog && still() && getClip()) longPressPaste(a, p0[0], p0[1]); }, 1400);
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
  if (r.kind === 'markerLine' && a.dimMode) { drawDim(ctx, dimFromRecog(a)); drawFang(ctx, a, [a.fA && [r.x1, r.y1], a.fB && [r.x2, r.y2]].filter(Boolean)); }
  else if (r.kind === 'markerLine') drawStroke(ctx, { ...a.item, pts: [[r.x1, r.y1, .5], [r.x2, r.y2, .5]] });
  else drawShape(ctx, r);
  if (r.kind === 'markerLine' || r.kind === 'line') drawLineInfo(ctx, r.x1, r.y1, r.x2, r.y2, a.k);
}
/* Fangpunkte für die Bemaßung: Ecken von Formen, Linienenden, Knicke von Stempel-Linien, Ecken von Bildern/Tabellen */
function fangPoints(p, excl) {
  const out = [];
  for (const it of p.items) {
    if (excl && excl.has(it.id)) continue;
    if (it.t === 'shape') {
      if (it.kind === 'poly') out.push(...it.pts);
      else if (it.kind === 'ellipse') { const cx = (it.x1 + it.x2) / 2, cy = (it.y1 + it.y2) / 2; out.push([cx, cy], [it.x1, cy], [it.x2, cy], [cx, it.y1], [cx, it.y2]); }
      else if (it.kind === 'rect') out.push([it.x1, it.y1], [it.x2, it.y1], [it.x1, it.y2], [it.x2, it.y2]);
      else out.push([it.x1, it.y1], [it.x2, it.y2]);
    } else if (it.t === 'stroke') {
      if (it.style === 'shape' && it.pts.length <= 40) out.push(...it.pts);
      else if (it.pts.length) out.push(it.pts[0], it.pts[it.pts.length - 1]);
    } else if (it.t === 'img' || it.t === 'table') out.push([it.x, it.y], [it.x + it.w, it.y], [it.x, it.y + it.h], [it.x + it.w, it.y + it.h]);
  }
  return out;
}
function fangAt(a, x, y, excl) {
  const pts = (a.fp ||= fangPoints(a.p, excl)), thr = 11 / a.k;
  let best = null, bd = thr;
  for (const q of pts) { const d = Math.hypot(q[0] - x, q[1] - y); if (d < bd) { bd = d; best = q; } }
  return best ? [best[0], best[1], true] : [x, y, false];
}
function drawFang(ctx, a, pts) {
  ctx.save(); ctx.strokeStyle = '#e0337a'; ctx.lineWidth = 1.5 / a.k;
  for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(x, y, 6 / a.k, 0, Math.PI * 2); ctx.stroke(); }
  ctx.restore();
}
/* Bemaßung: Stift schwebt über einer Linie/Kante → sie leuchtet auf (Ecken: Kreis); Antippen bemaßt sie direkt */
function dimSegments(p) {
  const out = [], add = (a, b) => { if (a && b && Math.hypot(b[0] - a[0], b[1] - a[1]) > 2) out.push([[a[0], a[1]], [b[0], b[1]]]); };
  const ring = (pts, closed) => { for (let i = 1; i < pts.length; i++) add(pts[i - 1], pts[i]); if (closed && pts.length > 2) add(pts[pts.length - 1], pts[0]); };
  for (const it of p.items) {
    if (it.t === 'shape') {
      if (it.kind === 'poly') ring(it.pts, true);
      else if (it.kind === 'rect') ring([[it.x1, it.y1], [it.x2, it.y1], [it.x2, it.y2], [it.x1, it.y2]], true);
      else if (it.kind === 'line' || it.kind === 'arrow') add([it.x1, it.y1], [it.x2, it.y2]);
    } else if (it.t === 'stroke') {
      if (it.style === 'shape' && it.pts.length <= 40) ring(it.pts, false);
      else if (it.pts.length === 2) add(it.pts[0], it.pts[1]);
    } else if ((it.t === 'img' && !it.rot) || it.t === 'table') ring([[it.x, it.y], [it.x + it.w, it.y], [it.x + it.w, it.y + it.h], [it.x, it.y + it.h]], true);
  }
  return out;
}
const dimGeoCache = new WeakMap();
function dimGeo(p) {
  const c = dimGeoCache.get(p), key = p.items.length + ':' + (p.items[p.items.length - 1]?.id || '');
  if (c && c.items === p.items && c.key === key) return c;
  const g = { items: p.items, key, pts: fangPoints(p), segs: dimSegments(p) };
  dimGeoCache.set(p, g); return g;
}
function dimHoverAt(p, x, y, k) {
  const g = dimGeo(p);
  let corner = null, cd = 11 / k;
  for (const q of g.pts) { const d = Math.hypot(q[0] - x, q[1] - y); if (d < cd) { cd = d; corner = q; } }
  if (corner) return { corner: [corner[0], corner[1]] };
  let seg = null, sd = 10 / k;
  for (const s of g.segs) { const d = segDist(x, y, s[0][0], s[0][1], s[1][0], s[1][1]); if (d < sd) { sd = d; seg = s; } }
  return seg ? { seg } : null;
}
let dimHover = null;
function clearDimHover() {
  if (!dimHover) return;
  const pe = pageEls.get(dimHover.pid); dimHover = null;
  if (pe && !act) clearLive(pe);
}
function onDimHover(e) {
  if (e.pointerType !== 'pen' || e.buttons || act || prefs.tool !== 'pen' || !prefs.dim || S.dimPending || !S.note) return clearDimHover();
  const p = pageAt(e.clientX, e.clientY); if (!p) return clearDimHover();
  const pe = pageEls.get(p.id), k = pe.el.getBoundingClientRect().width / p.w;
  const [x, y] = toPage(p, e.clientX, e.clientY), h = dimHoverAt(p, x, y, k), key = h ? JSON.stringify(h) : '';
  if (dimHover && dimHover.pid === p.id && dimHover.key === key) return;
  clearDimHover(); if (!h) return;
  dimHover = { pid: p.id, key };
  const ctx = prepLive(pe, p);
  ctx.save(); ctx.strokeStyle = ctx.fillStyle = '#e0337a';
  if (h.seg) {
    const [[x1, y1], [x2, y2]] = h.seg;
    ctx.globalAlpha = 0.35; ctx.lineWidth = 7 / k; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.globalAlpha = 1; ctx.lineWidth = 1.5 / k;
    for (const [px, py] of h.seg) { ctx.beginPath(); ctx.arc(px, py, 4 / k, 0, Math.PI * 2); ctx.stroke(); }
    const fs = 12 / k, t = dimLabel({ x1, y1, x2, y2, scale: prefs.dimScale || 50, unit: prefs.dimUnit ?? 'm', dec: prefs.dimDec ?? 2 }) + ' – antippen';
    ctx.font = `600 ${fs}px ${FONT}`; ctx.textBaseline = 'bottom';
    const tw = ctx.measureText(t).width, mx = (x1 + x2) / 2, my = (y1 + y2) / 2 - 10 / k;
    ctx.fillStyle = 'rgba(28,35,33,.85)'; ctx.fillRect(mx - tw / 2 - 5 / k, my - fs - 4 / k, tw + 10 / k, fs + 7 / k);
    ctx.fillStyle = '#fff'; ctx.fillText(t, mx - tw / 2, my);
  } else {
    ctx.lineWidth = 2 / k; ctx.beginPath(); ctx.arc(h.corner[0], h.corner[1], 7 / k, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}
wrap.addEventListener('pointermove', onDimHover);
wrap.addEventListener('pointerleave', clearDimHover);
function dimFromRecog(a) {
  const r = a.recog, pen = prefs.sizes.pen || 1.5;
  return { t: 'shape', id: a.dimId ||= uid(), kind: 'dim', x1: +r.x1.toFixed(2), y1: +r.y1.toFixed(2), x2: +r.x2.toFixed(2), y2: +r.y2.toFixed(2),
    color: prefs.color, size: +Math.max(0.6, Math.min(pen, 2) * 0.6).toFixed(2), fs: +Math.max(8, prefs.textSize * 0.75).toFixed(1),
    scale: prefs.dimScale || 50, unit: prefs.dimUnit ?? 'm', dec: prefs.dimDec ?? 2 };
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
      if (act.dimMode) { const [fx, fy, h] = fangAt(act, x, y); act.fB = h; [r.x2, r.y2] = h ? [fx, fy] : snapLine(r.x1, r.y1, x, y); }
      else [r.x2, r.y2] = snapLine(r.x1, r.y1, x, y);
      drawRecog(act);
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
  if (c.t === 'table') { if (col && c.color !== col) { c.color = col; return c; } return null; }
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
  else if (t === 'dimOffset') {
    const d = act.dim, { nx, ny } = dimPts(d), p = act.p;
    const off = +(act.off0 + (x - act.x0) * nx + (y - act.y0) * ny).toFixed(2);
    const nd = { ...d, off }, old = act.cur || d;
    p.items = p.items.map(i => i.id === d.id ? nd : i);
    act.cur = nd; renderRegionSoon(act.pe, p, unionBox([bbox(old), bbox(nd)]));
  }
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
    const b0 = origBox(act), thr = 7 / act.k, gd = guidesOn() && getGuides(act);
    if (act.axis === 'x') {
      let f = Math.max(0.05, (x - ax) / den(act.x0 - ax));
      const e0 = Math.abs(b0.x - ax) < 1e-6 ? b0.x + b0.w : b0.x, g = gd && bestSnap([ax + (e0 - ax) * f], gd.xs, thr);
      if (g) f = Math.max(0.05, (g.t.v - ax) / den(e0 - ax));
      if (gd) { const l = Math.min(ax, ax + (e0 - ax) * f); drawGuides(act, { x: l, y: b0.y, w: Math.abs(e0 - ax) * f, h: b0.h }, g, null); }
      applySel((a, b) => [ax + (a - ax) * f, b], 1, 0, f, 1);
    } else {
      let f = Math.max(0.05, (y - ay) / den(act.y0 - ay));
      const e0 = Math.abs(b0.y - ay) < 1e-6 ? b0.y + b0.h : b0.y, g = gd && bestSnap([ay + (e0 - ay) * f], gd.ys, thr);
      if (g) f = Math.max(0.05, (g.t.v - ay) / den(e0 - ay));
      if (gd) { const t = Math.min(ay, ay + (e0 - ay) * f); drawGuides(act, { x: b0.x, y: t, w: b0.w, h: Math.abs(e0 - ay) * f }, null, g); }
      applySel((a, b) => [a, ay + (b - ay) * f], 1, 0, 1, f);
    }
  } else if (t === 'scale') {
    const { ax, ay } = act; let f = Math.max(0.08, Math.hypot(x - ax, y - ay) / act.d0);
    if (guidesOn()) {
      const b0 = origBox(act), gd = getGuides(act), thr = 7 / act.k;
      const ex0 = Math.abs(b0.x - ax) < 1e-6 ? b0.x + b0.w : b0.x, ey0 = Math.abs(b0.y - ay) < 1e-6 ? b0.y + b0.h : b0.y;
      const gx = bestSnap([ax + (ex0 - ax) * f], gd.xs, thr), gy = bestSnap([ay + (ey0 - ay) * f], gd.ys, thr);
      const use = gx && (!gy || Math.abs(gx.d) <= Math.abs(gy.d)) ? 'x' : gy ? 'y' : null;
      if (use === 'x' && Math.abs(ex0 - ax) > 1) f = Math.max(0.08, (gx.t.v - ax) / (ex0 - ax));
      if (use === 'y' && Math.abs(ey0 - ay) > 1) f = Math.max(0.08, (gy.t.v - ay) / (ey0 - ay));
      const nx = [ax, ax + (ex0 - ax) * f], ny = [ay, ay + (ey0 - ay) * f];
      drawGuides(act, { x: Math.min(...nx), y: Math.min(...ny), w: Math.abs(nx[1] - nx[0]), h: Math.abs(ny[1] - ny[0]) }, use === 'x' ? gx : null, use === 'y' ? gy : null);
    }
    applySel((a, b) => [ax + (a - ax) * f, ay + (b - ay) * f], f);
  } else if (t === 'lineEnd') {
    // Linienende ziehen: das andere Ende bleibt stehen, rastet bei 0°/45°/90° ein
    const i = act.end, src = [...act.orig.values()][0];
    if (i === 3) {   // Maßlinie parallel verschieben
      const { nx: qx, ny: qy } = dimPts(src), off = +((x - src.x1) * qx + (y - src.y1) * qy).toFixed(2);
      applySel(null, 1, 0, 1, 1, { ...src, off }); ctx.clearRect(0, 0, act.p.w, act.p.h); return;
    }
    const o = 3 - i;
    let [nx, ny] = snapLine(src['x' + o], src['y' + o], x, y);
    if (src.kind === 'dim') { const [fx, fy, h] = fangAt(act, x, y, act.orig); if (h) [nx, ny] = [fx, fy]; }
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
  const c = parseColor(color || '');                       // auch Kurzform (#c00) und rgb()
  if (!c) return color;
  return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},0.2)`;
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
  if (HATCHES[prefs.hatch] && prefs.shape !== 'line' && prefs.shape !== 'arrow') base.hatch = prefs.hatch;
  if (prefs.shape === 'line' || prefs.shape === 'arrow') {
    const [x2, y2] = snapLine(a.x0, a.y0, a.x, a.y);
    if (prefs.shape === 'arrow') { base.hf = prefs.headForm || 'open'; base.hs = prefs.headSize ?? 1; }
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
  if (act.ghost) ghostFinish();
  if (act.dimMode && act.recog && e && e.clientX != null && e.type === 'pointerup') addPts(e);   // letzte Stiftposition (Fangpunkt) mitnehmen
  const a = act; act = null;
  const { p, pe, tool } = a;
  clearTimeout(a.hold?.t); clearTimeout(a.lpT);
  if (a.lp) { if (a.ctx) clearLive(pe); return; }       // langes Drücken: nur „Einfügen“ anbieten, nichts zeichnen
  if (tool === 'dimOffset') { if (a.ctx) clearLive(pe); if (a.cur) commit(p, a.before); return; }
  const snapped = tool === 'marker' && snapRects(a);
  if (snapped) {
    addStrokes(pe, p, snapped); clearLive(pe); commit(p, a.before);
  } else if ((tool === 'pen' || tool === 'marker') && a.recog) {
    const r = a.recog;
    // nur angetippt, aber auf einer Linie/Kante: genau diese Strecke bemaßen
    if (a.dimMode && a.hoverSeg && Math.hypot(r.x2 - r.x1, r.y2 - r.y1) * a.k < 4) { const [[x1, y1], [x2, y2]] = a.hoverSeg; Object.assign(r, { x1, y1, x2, y2 }); }
    const tiny = r.kind === 'markerLine' && Math.hypot(r.x2 - r.x1, r.y2 - r.y1) * a.k < 4;
    const it = tiny ? null : a.dimMode ? dimFromRecog(a) : r.kind === 'markerLine' ? { ...a.item, pts: [[+r.x1.toFixed(2), +r.y1.toFixed(2), .5], [+r.x2.toFixed(2), +r.y2.toFixed(2), .5]] } : r;
    if (it) addStrokes(pe, p, [it]);
    clearLive(pe); commit(p, a.before);
    if (it && a.dimMode) {
      S.dimPending = { pid: p.id, id: it.id };
      if ((prefs.dimOffHint || 0) < 3) { prefs.dimOffHint = (prefs.dimOffHint || 0) + 1; savePrefs(); toast('Jetzt irgendwo aufsetzen und seitlich ziehen: die Maßlinie wandert parallel mit. Kurz tippen = so lassen.', 5000); }
    }
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
    clearGuides();
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
  // „Einfügen“ nicht mehr beim einfachen Antippen – nur nach 3 s Halten (Wunsch: nicht aus Versehen)
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
    // nur Objekte, die VOLLSTÄNDIG im Lasso liegen
    let pts;
    if (it.t === 'stroke') pts = it.pts;
    else if (it.t === 'shape' && ['rect', 'ellipse', 'poly', 'line', 'arrow', 'dim'].includes(it.kind)) pts = shapeOutline(it);
    else { const b = bbox(it); pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]]; }
    if (pts.length && pts.every(([x, y]) => inPoly(x, y, poly))) ids.add(it.id);
  }
  setSel(ids.size ? { p, ids } : null);
}
function setSel(s) { S.sel = s; renderSel(); syncTextOpts(); }
/* markierte Textfelder: Größe, Schriftart und Fett lassen sich dann oben in der Leiste genau einstellen */
function selTexts() { return S.sel ? S.sel.p.items.filter(i => S.sel.ids.has(i.id) && i.t === 'text') : []; }
function syncTextOpts() {
  const tx = !S.editing && selTexts();
  $('#textOpts').hidden = prefs.tool !== 'text' && !(tx && tx.length);
  if (tx && tx.length) showTextStyle(tx[0]); else if (!S.editing) showTextStyle(null);
}
function showTextStyle(it) {
  showTextSize(it ? it.size : prefs.textSize);
  $('#textFont').value = (it ? it.font : prefs.textFont) || 'sans';
  $('#btnBold').classList.toggle('active', !!(it ? it.bold : prefs.bold));
}
function styleSelTexts(fn) {
  const tx = !S.editing && selTexts(); if (!tx || !tx.length) return false;
  const { p, ids } = S.sel, before = snap(p);
  p.items = p.items.map(i => ids.has(i.id) && i.t === 'text' ? fn({ ...i }) : i);
  refreshPage(p); commit(p, before); renderSel(); showTextStyle(selTexts()[0]);
  return true;
}
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
  const line = items.length === 1 && items[0].t === 'shape' && ['line', 'arrow', 'dim'].includes(items[0].kind) ? items[0] : null;
  const grips = line
    ? [1, 2].map(i => `<div class="lend" data-i="${i}" title="Ende ziehen" style="left:${((line['x' + i] - b.x) * sc + pad).toFixed(1)}px;top:${((line['y' + i] - b.y) * sc + pad).toFixed(1)}px"></div>`).join('')
      + (line.kind === 'dim' ? (d => `<div class="lend mid" data-i="3" title="Maßlinie parallel verschieben" style="left:${(((d.a[0] + d.b[0]) / 2 - b.x) * sc + pad).toFixed(1)}px;top:${(((d.a[1] + d.b[1]) / 2 - b.y) * sc + pad).toFixed(1)}px"></div>`)(dimPts(line)) : '')
    : ['nw', 'ne', 'sw', 'se'].map(d => `<div class="handle ${d}" data-d="${d}" title="Größe ändern (Seitenverhältnis bleibt)"></div>`).join('')
      + ['n', 's', 'w', 'e'].map(d => `<div class="edge ${d === 'n' || d === 's' ? 'eh' : 'ew'} ${d}" data-d="${d}" title="${d === 'n' || d === 's' ? 'Höhe' : 'Breite'} ändern"></div>`).join('');
  el.innerHTML = `<div class="selbar">${oneFormula ? `<button data-a="formula">${items[0].matrix ? 'Matrix bearbeiten' : 'Formel bearbeiten'}</button>` : items.length === 1 && items[0].t === 'text' ? '<button data-a="edittext">Text bearbeiten</button>' : items.length === 1 && items[0].t === 'table' ? '<button data-a="edittable">Tabelle bearbeiten</button>' : items.length === 1 && items[0].kind === 'dim' ? '<button data-a="dimtext">Maßzahl ändern</button>' : items.length === 1 && items[0].t === 'img' ? '<button data-a="crop">Zuschneiden</button>' : ''}<button data-a="style">Stil ändern</button><button data-a="align">Ausrichten</button><button data-a="layer">Ebene</button><button data-a="copy">Kopieren</button><button data-a="cut">Ausschneiden</button><button data-a="dup">Duplizieren</button><button data-a="stamp">Als Stempel</button><button data-a="del" class="danger">Löschen</button></div><div class="rot" title="Drehen"></div>${grips}`;
  el.addEventListener('pointerdown', e => {
    e.stopPropagation();
    if (e.target.closest('.selbar') || act) return;
    e.preventDefault(); hidePops();
    const cl = e.target.classList;
    const mode = cl.contains('lend') ? 'lineEnd' : cl.contains('handle') || cl.contains('edge') ? 'scale' : cl.contains('rot') ? 'rotate' : 'move';
    const orig = new Map(p.items.filter(i => ids.has(i.id)).map(i => [i.id, structuredClone(i)]));
    startAct(mode, p, e, { orig, axis: cl.contains('ew') ? 'x' : cl.contains('eh') ? 'y' : null, end: +e.target.dataset.i || 0 });
    if (mode === 'move') ghostStart();
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
    if (a === 'formula') { if (items[0].matrix) openGrid('matrix', p, items[0]); else openFormula(p, items[0]); }
    else if (a === 'edittext') editTextItem(p, items[0]);
    else if (a === 'crop') openCrop(p, items[0]);
    else if (a === 'edittable') openGrid('table', p, items[0]);
    else if (a === 'dimtext') {
      const it = items[0], v = prompt('Maßzahl (leer lassen = automatisch gemessen):', it.text ?? dimLabel(it));
      if (v === null) return;
      const before = snap(p), nv = v.trim(), auto = !nv || nv === dimLabel({ ...it, text: null });
      p.items = p.items.map(x => x.id === it.id ? (auto ? (({ text, ...r }) => r)(x) : { ...x, text: nv }) : x);
      refreshPage(p); commit(p, before); renderSel();
    }
    else if (a === 'stamp') saveSelAsStamp();
    else if (a === 'style') openStylePop(btn);
    else if (a === 'layer') showPop($('#layerPop'), btn);
    else if (a === 'align') { $('#alignHint').textContent = alignUnits().length < 2 ? 'Nur ein Objekt markiert: es wird an der Seite ausgerichtet.' : 'Die markierten Objekte werden aneinander ausgerichtet.'; showPop($('#alignPop'), btn); }
    else selAction(a);
  });
  pageEls.get(p.id).el.appendChild(el);
}
/* ---- Smarte Hilfslinien: beim Verschieben/Skalieren an Kanten und Mitten anderer Objekte (und der Seitenmitte) einrasten ---- */
const guidesOn = () => prefs.guides !== false;
function guideTargets(p, excl) {
  const boxes = p.items.filter(it => !excl.has(it.id) && (it.t !== 'stroke' || it.style === 'shape')).map(visBox);
  const xs = [], ys = [];
  for (const b of boxes) {
    xs.push({ v: b.x, b }, { v: b.x + b.w / 2, b }, { v: b.x + b.w, b });
    ys.push({ v: b.y, b }, { v: b.y + b.h / 2, b }, { v: b.y + b.h, b });
  }
  const pg = { x: 0, y: 0, w: p.w, h: p.h };
  xs.push({ v: p.w / 2, b: pg }); ys.push({ v: p.h / 2, b: pg });
  return { xs, ys };
}
function getGuides(a) {
  if (!a.gt || a.gtPage !== a.p.id) { a.gt = guideTargets(a.p, a.orig); a.gtPage = a.p.id; }
  return a.gt;
}
// beste Übereinstimmung: einer der Werte vals (Kanten/Mitte der Auswahl) nahe an einer Ziellinie
function bestSnap(vals, list, thr) {
  let best = null;
  for (const [i, v] of vals.entries()) for (const t of list) { const d = t.v - v; if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, i, t }; }
  return best;
}
function clearGuides(pe) { (pe?.el || document).querySelectorAll('.guide').forEach(n => n.remove()); }
function drawGuides(a, box, gx, gy) {
  clearGuides(a.pe); if (!gx && !gy) return;
  const sc = scale(), pad = 8;
  const mk = (cls, st) => { const d = document.createElement('div'); d.className = 'guide ' + cls; Object.assign(d.style, st); a.pe.el.appendChild(d); };
  if (gx) { const t = Math.min(box.y, gx.t.b.y) - pad, bt = Math.max(box.y + box.h, gx.t.b.y + gx.t.b.h) + pad; mk('v', { left: gx.t.v * sc + 'px', top: t * sc + 'px', height: (bt - t) * sc + 'px' }); }
  if (gy) { const l = Math.min(box.x, gy.t.b.x) - pad, r = Math.max(box.x + box.w, gy.t.b.x + gy.t.b.w) + pad; mk('h', { top: gy.t.v * sc + 'px', left: l * sc + 'px', width: (r - l) * sc + 'px' }); }
}
const origBox = a => (a.ob ||= unionBox([...a.orig.values()].map(bbox)));
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
function ghostStart() {
  const a = act, pe = a.pe, p = a.p, sc = scale(), items = [...a.orig.values()];
  const b0 = unionBox(items.map(bbox)), pad = 4, b = { x: b0.x - pad, y: b0.y - pad, w: b0.w + 2 * pad, h: b0.h + 2 * pad };
  const R = Math.min(dpr() * sc, Math.sqrt(9e6 / Math.max(1, b.w * b.h)));
  const c = document.createElement('canvas'); c.className = 'sel-ghost';
  c.width = Math.max(1, Math.round(b.w * R)); c.height = Math.max(1, Math.round(b.h * R));
  Object.assign(c.style, { position: 'absolute', left: b.x * sc + 'px', top: b.y * sc + 'px', width: b.w * sc + 'px', height: b.h * sc + 'px', zIndex: 2, pointerEvents: 'none', willChange: 'transform' });
  const ctx = c.getContext('2d'); ctx.setTransform(R, 0, 0, R, -b.x * R, -b.y * R);
  drawItems(ctx, items, () => {});
  pe.el.appendChild(c);
  S.hideIds = new Set(a.orig.keys());
  renderRegion(pe, p, b0);
  Object.assign(a, { ghost: c, gdx: 0, gdy: 0 });
}
function ghostMove(dx, dy) {
  const a = act, sc = scale(), t = `translate(${(dx * sc).toFixed(1)}px, ${(dy * sc).toFixed(1)}px)`;
  a.gdx = dx; a.gdy = dy; a.ghost.style.transform = t;
  const sb = a.pe.el.querySelector('.selbox'); if (sb) sb.style.transform = t;
}
function ghostFinish() {
  const a = act; if (!a || !a.ghost) return;
  const { gdx, gdy } = a;
  a.ghost.remove(); a.ghost = null; S.hideIds = null;
  applySel((x, y) => [x + gdx, y + gdy], 1);
}
function moveSelTo(cx, cy) {
  const q = pageUnder(cx, cy);
  if (q && q !== act.p && act.ghost) ghostFinish();      // Seitenwechsel: wieder normal zeichnen
  if (q && q !== act.p) moveSelToPage(q);
  act.rect = act.pe.el.getBoundingClientRect(); act.k = act.rect.width / act.p.w;   // Lage ändert sich beim Scrollen
  const [x, y] = toPageA(cx, cy);
  let dx = x - act.x0, dy = y - act.y0;
  if (guidesOn()) {
    const g = getGuides(act), b = origBox(act), thr = 7 / act.k;
    const gx = bestSnap([b.x + dx, b.x + dx + b.w / 2, b.x + dx + b.w], g.xs, thr);
    const gy = bestSnap([b.y + dy, b.y + dy + b.h / 2, b.y + dy + b.h], g.ys, thr);
    if (gx) dx += gx.d; if (gy) dy += gy.d;
    drawGuides(act, { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h }, gx, gy);
  }
  if (act.ghost) return ghostMove(dx, dy);
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
  Object.assign(a, { p: q, pe: qe, rect: rq, k, lastBox: null, ob: null });
  clearGuides();
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
/* ---- Ausrichten: markierte Objekte aneinander (oder an der Seite) ausrichten und verteilen ----
   Zusammengehöriges bleibt zusammen: Elemente, die sich berühren (z. B. Buchstaben eines Wortes, Teile eines Stempels),
   werden als eine Einheit bewegt – außer ein Element liegt ganz in einem anderen (z. B. Text in einem Kasten). */
// sichtbare Fläche: bei Text die tatsächliche Schriftbreite statt der Breite des Textfelds
function visBox(it) {
  const b = bbox(it); if (it.t !== 'text') return b;
  const mc = (visBox.mc ||= document.createElement('canvas').getContext('2d'));
  mc.font = `${it.bold ? 700 : 400} ${it.size}px ${fontOf(it)}`;
  const w = Math.max(...it.text.split(/\n/).map(l => mc.measureText(l).width), 1);
  return { ...b, w: Math.min(b.w, w + 2) };
}
function alignUnits() {
  if (!S.sel) return [];
  const items = S.sel.p.items.filter(i => S.sel.ids.has(i.id)), bx = items.map(visBox), n = items.length;
  const par = items.map((_, i) => i), find = i => par[i] === i ? i : (par[i] = find(par[i]));
  const m = 4, touch = (a, b) => a.x - m <= b.x + b.w && b.x - m <= a.x + a.w && a.y - m <= b.y + b.h && b.y - m <= a.y + a.h;
  const inside = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++)
    if (touch(bx[i], bx[j]) && !inside(bx[i], bx[j]) && !inside(bx[j], bx[i])) par[find(i)] = find(j);
  const groups = new Map();
  items.forEach((it, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(it); });
  return [...groups.values()].map(g => ({ items: g, b: unionBox(g.map(visBox)) }));
}
function alignSel(mode) {
  const units = alignUnits(); if (!units.length) return;
  const { p } = S.sel, before = snap(p);
  const ref = units.length < 2 ? { x: 0, y: 0, w: p.w, h: p.h } : unionBox(units.map(u => u.b));
  const moves = new Map();
  if (mode === 'hdist' || mode === 'vdist') {
    if (units.length < 3) return toast('Zum Verteilen mindestens drei Objekte markieren.');
    const h = mode === 'hdist', key = u => h ? u.b.x + u.b.w / 2 : u.b.y + u.b.h / 2;
    const us = [...units].sort((a, b) => key(a) - key(b));
    const total = us.reduce((s, u) => s + (h ? u.b.w : u.b.h), 0), span = h ? ref.w : ref.h, gap = (span - total) / (us.length - 1);
    let pos = h ? ref.x : ref.y;
    for (const u of us) { moves.set(u, h ? [pos - u.b.x, 0] : [0, pos - u.b.y]); pos += (h ? u.b.w : u.b.h) + gap; }
  } else {
    for (const u of units) {
      const b = u.b;
      const d = { left: [ref.x - b.x, 0], right: [ref.x + ref.w - b.x - b.w, 0], hcenter: [ref.x + ref.w / 2 - b.x - b.w / 2, 0],
        top: [0, ref.y - b.y], bottom: [0, ref.y + ref.h - b.y - b.h], vcenter: [0, ref.y + ref.h / 2 - b.y - b.h / 2] }[mode];
      moves.set(u, d);
    }
  }
  const mv = new Map();
  for (const [u, [dx, dy]] of moves) for (const it of u.items) mv.set(it.id, [dx, dy]);
  p.items = p.items.map(it => { const d = mv.get(it.id); return d && (d[0] || d[1]) ? { ...xform(it, (a, b) => [a + d[0], b + d[1]], 1), id: it.id } : it; });
  refreshPage(p); commit(p, before); renderSel();
}
$('#alignPop').addEventListener('click', e => { const b = e.target.closest('[data-al]'); if (b) alignSel(b.dataset.al); });
function selAction(a) {
  if (!S.sel) return;
  const { p, ids } = S.sel, before = snap(p);
  if (a === 'copy' || a === 'cut') {
    setClip(p.items.filter(i => ids.has(i.id)));
    toast((a === 'copy' ? 'Kopiert.' : 'Ausgeschnitten.') + ' Zum Einfügen auf eine freie Stelle 2 Sekunden ruhig halten.', 3500);
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
  const closed = items.filter(i => i.t === 'shape' && closedShape(i));
  $('#styleHatchRow').hidden = !closed.length;
  const curH = closed.length && closed.every(i => (i.hatch || '') === (closed[0].hatch || '')) ? (closed[0].hatch || '') : null;
  document.querySelectorAll('#styleHatch [data-hatch]').forEach(b => b.classList.toggle('active', b.dataset.hatch === curH));
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
$('#styleHatch').addEventListener('click', e => {
  const b = e.target.closest('[data-hatch]'); if (!b) return;
  const h = b.dataset.hatch;
  applyStyle(it => { if (it.t === 'shape' && closedShape(it)) { if (h) it.hatch = h; else delete it.hatch; } }, true);
  document.querySelectorAll('#styleHatch [data-hatch]').forEach(x => x.classList.toggle('active', x === b));
});
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
    // klein anfangen und beim Tippen mitwachsen (bis zum Seitenrand, dann Umbruch)
    it = { t: 'text', id: uid(), x, y: y - prefs.textSize * 0.68, w: 30, auto: true, text: '', size: prefs.textSize, color: prefs.color, bold: prefs.bold, font: prefs.textFont || 'sans' };
    if (p.w - x - 6 < 100) it.x = Math.max(8, p.w - 106);
    p.items.push(it);
  }
  S.editing = { p, it, before };
  if (hit) showTextStyle(it);
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
/* Schriftgröße eines vorhandenen Textes in der Auswahl zeigen (auch krumme Größen, z. B. von Stempeln) */
function showTextSize(sz) {
  const sel = $('#textSize'), v = String(+(+sz).toFixed(1));
  sel.querySelector('.cur')?.remove();
  if (![...sel.options].some(o => o.value === v)) {
    const o = new Option(v, v); o.className = 'cur';
    const after = [...sel.options].find(x => +x.value > +v); sel.insertBefore(o, after || null);
  }
  sel.value = v;
}
/* Markierten Text (auch aus Stempeln) wieder bearbeiten */
function editTextItem(p, it) {
  setSel(null); setTool('text');
  const b = bbox(it); textTap(p, b.x + b.w / 2, b.y + b.h / 2);
}
function commitText() {
  const ed = S.editing; if (!ed) return;
  S.editing = null;
  const { p, it, before } = ed;
  const pe = pageEls.get(p.id);
  const n = pe && pe.text.querySelector(`[data-id="${it.id}"]`);
  if (n) {
    it.text = n.innerText.replace(/\n$/, '');
    // mitwachsendes Feld: Breite auf den geschriebenen Text setzen (ragt so nicht mehr übers Blatt hinaus)
    if (it.auto) { const sc = scale(); it.w = clamp(n.getBoundingClientRect().width / sc + 3, 12, Math.max(12, p.w - it.x - 4)); }
    n.contentEditable = 'false'; n.classList.remove('editing');
  }
  if (!it.text.trim()) p.items = p.items.filter(i => i !== it);
  syncTextOpts();
  if (pe) { renderText(pe, p); renderInk(pe, p); }
  commit(p, before);
}
function styleEditing(what) {
  if (!S.editing) return;
  const { it, p } = S.editing;
  if (what === 'color') it.color = prefs.color;
  else if (what === 'size') it.size = prefs.textSize;
  else if (what === 'bold') it.bold = prefs.bold;
  else if (what === 'font') it.font = prefs.textFont;
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

/* ---------------- Bild zuschneiden ----------------
   Rahmen im Dialog ziehen (Ecken/Seiten = Größe, innen = verschieben, außerhalb = neu aufziehen).
   Das Bild wird wirklich beschnitten (kleinere Datei, PDF unverändert); Rückgängig stellt es wieder her. */
let cropCtx = null;
function layoutCrop() {
  const { r } = cropCtx, b = $('#cropBox');
  const css = { left: r.x * 100 + '%', top: r.y * 100 + '%', width: r.w * 100 + '%', height: r.h * 100 + '%' };
  Object.assign(b.style, css); Object.assign($('#cropShade').style, css);
  const nw = cropCtx.im.naturalWidth, nh = cropCtx.im.naturalHeight;
  $('#cropInfo').textContent = `${Math.round(r.w * nw)} × ${Math.round(r.h * nh)} Pixel`;
}
function openCrop(p, it) {
  const im = getImg(it.src); if (!im) { toast('Bild wird noch geladen – bitte gleich noch einmal.'); return; }
  cropCtx = { p, it, im, r: { x: 0, y: 0, w: 1, h: 1 } };
  const nw = im.naturalWidth, nh = im.naturalHeight;
  const k = Math.min((Math.min(900, innerWidth - 32) - 80) / nw, (innerHeight * 0.58) / nh);
  const st = $('#cropStage');
  st.style.width = Math.round(nw * k) + 'px'; st.style.height = Math.round(nh * k) + 'px';
  $('#cropImg').src = it.src;
  $('#cropRotHint').hidden = !it.rot;
  layoutCrop(); $('#cropDlg').showModal();
}
(() => {
  const st = $('#cropStage'), MIN = 0.03;
  let drag = null;
  st.addEventListener('pointerdown', e => {
    if (!cropCtx) return;
    e.preventDefault();
    const R = st.getBoundingClientRect(), px = (e.clientX - R.left) / R.width, py = (e.clientY - R.top) / R.height;
    let d = e.target.dataset.d || (e.target.id === 'cropBox' ? 'move' : null);
    if (!d) { cropCtx.r = { x: clamp(px, 0, 1), y: clamp(py, 0, 1), w: 0, h: 0 }; d = 'se'; }   // außerhalb: neu aufziehen
    drag = { d, R, px, py, r0: { ...cropCtx.r } };
    try { st.setPointerCapture(e.pointerId); } catch {}
  });
  st.addEventListener('pointermove', e => {
    if (!drag) return;
    const { d, R, r0 } = drag, dx = (e.clientX - R.left) / R.width - drag.px, dy = (e.clientY - R.top) / R.height - drag.py;
    let x0 = r0.x, y0 = r0.y, x1 = r0.x + r0.w, y1 = r0.y + r0.h;
    if (d === 'move') { const mx = clamp(dx, -x0, 1 - x1), my = clamp(dy, -y0, 1 - y1); x0 += mx; x1 += mx; y0 += my; y1 += my; }
    else {
      if (d.includes('w')) x0 = clamp(x0 + dx, 0, x1 - MIN);
      if (d.includes('e')) x1 = clamp(x1 + dx, x0 + MIN, 1);
      if (d.includes('n')) y0 = clamp(y0 + dy, 0, y1 - MIN);
      if (d.includes('s')) y1 = clamp(y1 + dy, y0 + MIN, 1);
    }
    cropCtx.r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; layoutCrop();
  });
  const end = () => {
    // zu kleiner neu aufgezogener Rahmen (nur angetippt): wieder ganzes Bild
    if (drag && cropCtx && (cropCtx.r.w < 0.03 || cropCtx.r.h < 0.03)) { cropCtx.r = drag.r0.w >= 0.03 && drag.r0.h >= 0.03 ? drag.r0 : { x: 0, y: 0, w: 1, h: 1 }; layoutCrop(); }
    drag = null;
  };
  st.addEventListener('pointerup', end); st.addEventListener('pointercancel', end);
  $('#cropDlg').addEventListener('click', e => {
    const a = e.target.closest('[data-c]')?.dataset.c; if (!a) return;
    if (a === 'reset') { cropCtx.r = { x: 0, y: 0, w: 1, h: 1 }; layoutCrop(); return; }
    if (a === 'ok') applyCrop();
    $('#cropDlg').close();
  });
  $('#cropDlg').addEventListener('close', () => { cropCtx = null; drag = null; });
})();
function applyCrop() {
  const { p, it, im, r } = cropCtx;
  if (r.x < 0.001 && r.y < 0.001 && r.w > 0.999 && r.h > 0.999) return;      // nichts beschnitten
  const nw = im.naturalWidth, nh = im.naturalHeight;
  const sx = Math.round(r.x * nw), sy = Math.round(r.y * nh), sw = Math.max(1, Math.round(r.w * nw)), sh = Math.max(1, Math.round(r.h * nh));
  const c = document.createElement('canvas'); c.width = sw; c.height = sh;
  const png = !it.src.startsWith('data:image/jpeg');
  const g = c.getContext('2d');
  if (!png) { g.fillStyle = '#fff'; g.fillRect(0, 0, sw, sh); }
  g.drawImage(im, sx, sy, sw, sh, 0, 0, sw, sh);
  const src = png ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.92);
  // neue Lage: Mittelpunkt des Ausschnitts (bei gedrehten Bildern mitgedreht), Größe anteilig
  const fx = (sx + sw / 2) / nw - 0.5, fy = (sy + sh / 2) / nh - 0.5, cs = Math.cos(it.rot || 0), sn = Math.sin(it.rot || 0);
  const ox = fx * it.w, oy = fy * it.h, cx = it.x + it.w / 2 + ox * cs - oy * sn, cy = it.y + it.h / 2 + ox * sn + oy * cs;
  const w = it.w * sw / nw, h = it.h * sh / nh;
  const before = snap(p), { tex, color, mh, matrix, ...base } = it;
  const nit = { ...base, src, x: cx - w / 2, y: cy - h / 2, w, h };
  p.items = p.items.map(x => x.id === it.id ? nit : x);
  refreshPage(p); commit(p, before);
  if (S.sel && S.sel.p === p) renderSel();
  toast('Bild zugeschnitten – mit Rückgängig wieder herstellbar.');
}

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
/* ---------------- Bemaßung: Maßstab, Einheit, Nachkommastellen ---------------- */
const SCALES = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500];
function fmtScale(v) { return (+v).toLocaleString('de-DE', { maximumFractionDigits: 3 }); }
$('#scaleList').innerHTML = SCALES.map(v => `<button data-scale="${v}">1:${v}</button>`).join('');
function syncScalePop() {
  const sc = prefs.dimScale || 50;
  document.querySelectorAll('#scaleList [data-scale]').forEach(b => b.classList.toggle('active', +b.dataset.scale === sc));
  $('#scaleOwn').value = SCALES.includes(sc) ? '' : sc;
  document.querySelectorAll('#unitList [data-unit]').forEach(b => b.classList.toggle('active', b.dataset.unit === (prefs.dimUnit ?? 'm')));
  document.querySelectorAll('#decList [data-dec]').forEach(b => b.classList.toggle('active', +b.dataset.dec === (prefs.dimDec ?? 2)));
}
// Änderung gilt für neue Maße und für markierte Maße
function setDimPref(key, val) {
  prefs[key] = val; savePrefs(); syncScalePop(); updToolbar();
  if (!S.sel) return;
  const { p, ids } = S.sel, prop = { dimScale: 'scale', dimUnit: 'unit', dimDec: 'dec' }[key];
  if (!p.items.some(i => ids.has(i.id) && i.kind === 'dim')) return;
  const before = snap(p);
  p.items = p.items.map(i => ids.has(i.id) && i.kind === 'dim' ? { ...i, [prop]: val } : i);
  refreshPage(p); commit(p, before); renderSel();
}
$('#scalePop').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.scale) setDimPref('dimScale', +b.dataset.scale);
  else if (b.dataset.unit != null) setDimPref('dimUnit', b.dataset.unit);
  else if (b.dataset.dec != null) setDimPref('dimDec', +b.dataset.dec);
});
$('#scaleOwn').addEventListener('change', e => { const v = parseFloat(String(e.target.value).replace(',', '.')); if (v > 0) setDimPref('dimScale', v); });
/* ---------------- Tabellen und Matrizen: gemeinsames Eingabefenster ---------------- */
let gridCtx = null;
function gridValues() { return [...$('#gridCells').querySelectorAll('input')].reduce((a, inp) => { (a[+inp.dataset.r] ||= [])[+inp.dataset.c] = inp.value; return a; }, []); }
function buildGridInputs(keep) {
  const R = clamp(+$('#gridRows').value || 1, 1, gridCtx.kind === 'table' ? 30 : 8), C = clamp(+$('#gridCols').value || 1, 1, gridCtx.kind === 'table' ? 12 : 8);
  const box = $('#gridCells'); box.innerHTML = '';
  box.style.gridTemplateColumns = `repeat(${C}, minmax(${gridCtx.kind === 'table' ? 90 : 70}px, 1fr))`;
  const head = gridCtx.kind === 'table' && $('#gridHead').checked;
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    const inp = document.createElement('input'); inp.dataset.r = r; inp.dataset.c = c;
    inp.value = keep?.[r]?.[c] ?? '';
    if (gridCtx.kind === 'matrix') inp.placeholder = `a_{${r + 1}${c + 1}}`;
    else if (head && r === 0) { inp.placeholder = `Spalte ${c + 1}`; inp.classList.add('head'); }
    box.appendChild(inp);
  }
}
function openGrid(kind, p, it = null) {
  if (!p) return;
  commitText();
  gridCtx = { kind, p, it };
  const mx = kind === 'matrix', src = mx ? it?.matrix : it;
  $('#gridTitle').textContent = (it ? (mx ? 'Matrix bearbeiten' : 'Tabelle bearbeiten') : (mx ? 'Matrix einfügen' : 'Tabelle einfügen'));
  $('#gridOk').textContent = it ? 'Übernehmen' : 'Einfügen';
  $('#gridRows').max = mx ? 8 : 30; $('#gridCols').max = mx ? 8 : 12;
  $('#gridRows').value = src?.rows || 3; $('#gridCols').value = src?.cols || 3;
  $('#gridHeadWrap').hidden = mx; $('#gridBrWrap').hidden = !mx;
  if (!mx) $('#gridHead').checked = it ? !!it.header : true;
  if (mx) $('#gridBr').value = src?.kind || 'pmatrix';
  $('#gridHint').textContent = mx
    ? 'Einträge in LaTeX möglich, z. B. x^2, \\frac{1}{2}, \\alpha. Leere Felder bekommen a₁₁, a₁₂ … (wie im grauen Platzhalter).'
    : 'Die Zellen kannst du gleich hier ausfüllen oder leer lassen und später über „Tabelle bearbeiten“ ändern. Größe und Spaltenbreite danach mit dem Lasso ziehen.';
  buildGridInputs(src?.cells);
  $('#gridDlg').showModal();
  setTimeout(() => $('#gridCells input')?.focus(), 50);
}
['gridRows', 'gridCols', 'gridHead'].forEach(id => $('#' + id).addEventListener('change', () => buildGridInputs(gridValues())));
$('#gridDlg').addEventListener('click', async e => {
  const a = e.target.closest('[data-g]')?.dataset.g; if (!a) return;
  if (a === 'cancel') { $('#gridDlg').close(); gridCtx = null; return; }
  const ctx = gridCtx; $('#gridDlg').close(); gridCtx = null; if (!ctx) return;
  const R = clamp(+$('#gridRows').value || 1, 1, ctx.kind === 'table' ? 30 : 8), C = clamp(+$('#gridCols').value || 1, 1, ctx.kind === 'table' ? 12 : 8);
  const vals = gridValues(), cells = Array.from({ length: R }, (_, r) => Array.from({ length: C }, (_, c) => (vals[r]?.[c] ?? '').trim()));
  if (ctx.kind === 'table') finishTable(ctx, R, C, cells, $('#gridHead').checked);
  else await finishMatrix(ctx, R, C, cells, $('#gridBr').value);
});
function finishTable(ctx, R, C, cells, header) {
  const { p } = ctx, pe = pageEls.get(p.id), before = snap(p);
  let it;
  if (ctx.it) {
    const o = ctx.it, rowH = o.h / o.rows;
    it = { ...o, rows: R, cols: C, cells, header, h: rowH * R, cw: o.cols === C ? o.cw : null, rh: o.rows === R ? o.rh : null };
    if (o.cols !== C) it.w = o.w / o.cols * C;
    const i = p.items.findIndex(x => x.id === o.id); if (i < 0) return;
    p.items[i] = it;
  } else {
    const size = prefs.textSize, colW = Math.min(110, p.w * 0.9 / C), rowH = Math.round(size * 2);
    const w = colW * C, h = rowH * R;
    const rr = pe.el.getBoundingClientRect(), wr = wrap.getBoundingClientRect(), k = rr.width / p.w;
    const cy = clamp(((wr.top + wr.height / 2) - rr.top) / k, h / 2, p.h - h / 2);
    it = { t: 'table', id: uid(), x: (p.w - w) / 2, y: cy - h / 2, w, h, rows: R, cols: C, cells, header, size, color: prefs.color, lw: 1 };
    p.items.push(it);
  }
  setTool('lasso'); refreshPage(p); commit(p, before);
  setSel({ p, ids: new Set([it.id]) });
}
async function finishMatrix(ctx, R, C, cells, kind) {
  const filled = cells.map((row, r) => row.map((v, c) => v || `a_{${r + 1}${c + 1}}`));
  const tex = `\\begin{${kind}} ${filled.map(row => row.join(' & ')).join(' \\\\ ')} \\end{${kind}}`;
  try { await loadMathJax(); } catch (e) { return toast(e.message); }
  const { p } = ctx, pe = pageEls.get(p.id), before = snap(p);
  let r;
  try { r = texToSvg(tex, ctx.it ? ctx.it.color : prefs.color); } catch (e) { return toast('Fehler in der Matrix: ' + e.message); }
  const matrix = { rows: R, cols: C, kind, cells };
  let it;
  if (ctx.it) {
    const old = ctx.it, fs = old.h / old.mh, w = r.ew * fs, h = r.eh * fs;
    it = { ...old, src: r.src, tex, mh: r.eh, matrix, x: old.x + old.w / 2 - w / 2, y: old.y + old.h / 2 - h / 2, w, h };
    const i = p.items.findIndex(o => o.id === old.id); if (i < 0) return;
    p.items[i] = it;
  } else {
    const fs = prefs.textSize * 1.25; let w = r.ew * fs, h = r.eh * fs;
    if (w > p.w * 0.9) { const k = p.w * 0.9 / w; w *= k; h *= k; }
    const rr = pe.el.getBoundingClientRect(), wr = wrap.getBoundingClientRect(), k = rr.width / p.w;
    const cy = clamp(((wr.top + wr.height / 2) - rr.top) / k, h / 2, p.h - h / 2);
    it = { t: 'img', id: uid(), x: (p.w - w) / 2, y: cy - h / 2, w, h, src: r.src, tex, color: prefs.color, mh: r.eh, matrix };
    p.items.push(it);
  }
  setTool('lasso'); refreshPage(p); commit(p, before);
  setSel({ p, ids: new Set([it.id]) });
}
$('#btnMatrix').addEventListener('click', () => { hidePops(); if (S.note) openGrid('matrix', currentPage()); });
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
/* Statik (wie in den Bautabellen): Auflager und typische statische Systeme, aus Linien gezeichnet.
   Einheit = Stempelgröße s; Auflager haben ihren Anschlusspunkt bei (0|0). */
const STATIK_SUPPORTS = [
  { id: 'fest', title: 'Festlager' }, { id: 'los', title: 'Loslager' },
  { id: 'einspL', title: 'Einspannung links' }, { id: 'einspR', title: 'Einspannung rechts' }, { id: 'gelenk', title: 'Gelenk' }
];
const STATIK_SYSTEMS = [
  { id: 'einfeld', title: 'Einfeldträger' }, { id: 'krag', title: 'Kragarm' }, { id: 'ueberstand', title: 'Einfeldträger mit Kragarm' },
  { id: 'zweifeld', title: 'Zweifeldträger' }, { id: 'einsplos', title: 'Einseitig eingespannt' }, { id: 'beids', title: 'Beidseitig eingespannt' },
  { id: 'gerber', title: 'Gelenkträger (Gerber)' }, { id: 'zweigelenk', title: 'Zweigelenkrahmen' }, { id: 'dreigelenk', title: 'Dreigelenkrahmen' }
];
const STATIK_LOADS = [
  { id: 'F', title: 'Einzellast' }, { id: 'Fh', title: 'Horizontallast' }, { id: 'q', title: 'Streckenlast' }, { id: 'dreieck', title: 'Dreieckslast' },
  { id: 'trapez', title: 'Trapezlast' }, { id: 'Mr', title: 'Moment rechtsdrehend' }, { id: 'Ml', title: 'Moment linksdrehend' }
];
function statikItems(id, s, color) {
  const thin = Math.max(1, s * 0.04), thick = Math.max(1.6, s * 0.08), out = [], late = [];
  // Bei Balkensystemen sitzt das Lager direkt am Balken – ein Kreis dort sähe aus wie ein Momentengelenk im Balken
  // (beim Durchlaufträger wäre das System dann kinematisch). Kreise nur bei einzelnen Auflagern und an Rahmenfüßen.
  const pins = !['einfeld', 'krag', 'ueberstand', 'zweifeld', 'einsplos', 'beids', 'gerber'].includes(id);
  const L = (pts, w = thin) => out.push(stampLine(pts.map(([x, y]) => [x * s, y * s]), color, w));
  const hinge = (x, y, r) => late.push({ t: 'shape', id: uid(), kind: 'ellipse', x1: (x - r) * s, y1: (y - r) * s, x2: (x + r) * s, y2: (y + r) * s, color, size: thin, fill: '#ffffff', fillMode: 2 });
  const hatch = (x1, x2, y, k) => { for (let x = x1 + 0.12 * k; x <= x2 + 1e-6; x += 0.2 * k) L([[x, y], [x - 0.15 * k, y + 0.17 * k]]); };
  const tri = (x, y, k, roller) => {
    L([[x, y], [x - 0.3 * k, y + 0.5 * k], [x + 0.3 * k, y + 0.5 * k], [x, y]]);
    L([[x - 0.45 * k, y + 0.5 * k], [x + 0.45 * k, y + 0.5 * k]]);
    let g = y + 0.5 * k;
    if (roller) { g = y + 0.63 * k; L([[x - 0.45 * k, g], [x + 0.45 * k, g]]); }
    hatch(x - 0.45 * k, x + 0.45 * k, g, k);
    if (pins) hinge(x, y, 0.07 * k);
  };
  // Einspannung: Wand senkrecht, Schraffur auf der Wandseite (dir -1 = links, +1 = rechts)
  const wall = (x, y, k, dir) => {
    L([[x, y - 0.5 * k], [x, y + 0.5 * k]], thick);
    for (let yy = y - 0.45 * k; yy <= y + 0.5 * k + 1e-6; yy += 0.19 * k) L([[x, yy], [x + dir * 0.17 * k, yy - 0.15 * k]]);
  };
  const beam = (x1, x2, y = 0) => L([[x1, y], [x2, y]], thick);
  // Lastpfeil von (x1|y1) nach (x2|y2), Spitze gefüllt
  const arr = (x1, y1, x2, y2, w = thin, hs = 0) => out.push({ t: 'shape', id: uid(), kind: 'arrow', x1: x1 * s, y1: y1 * s, x2: x2 * s, y2: y2 * s, color, size: w, hf: 'fill', hs });
  // verteilte Last von xa bis xb, Höhe h(x) über dem Balken (Pfeilspitzen auf y = 0)
  const dist = (xa, xb, h) => {
    L([[xa, -h(xa)], [xb, -h(xb)]]);
    if (h(xa) > 0.05) L([[xa, -h(xa)], [xa, 0]]);
    const n = 8;
    for (let i = 0; i <= n; i++) { const x = xa + (xb - xa) * i / n, hh = h(x); if (hh > 0.2) arr(x, -hh, x, 0); }
  };
  const moment = cw => {
    const r = 0.55, a0 = 0.75 * Math.PI, a1 = 2.25 * Math.PI, P = a => [r * Math.cos(a), r * Math.sin(a)];
    const pts = arcPts(0, 0, r, a0, a1, 32);
    L(cw ? pts : pts.reverse());
    const [e, b] = cw ? [a1, a1 - 0.35] : [a0, a0 + 0.35];
    arr(...P(b), ...P(e), thin, 1);
    late.push({ t: 'shape', id: uid(), kind: 'ellipse', x1: -0.05 * s, y1: -0.05 * s, x2: 0.05 * s, y2: 0.05 * s, color, size: thin, fill: color, fillMode: 2 });
  };
  const k = 0.75;
  switch (id) {
    case 'fest': tri(0, 0, 1, false); break;
    case 'los': tri(0, 0, 1, true); break;
    case 'einspL': wall(0, 0, 1, -1); break;
    case 'einspR': wall(0, 0, 1, 1); break;
    case 'gelenk': hinge(0, 0, 0.12); break;
    case 'einfeld': beam(-2, 2); tri(-2, 0, k); tri(2, 0, k, true); break;
    case 'krag': wall(-2, 0, k, -1); beam(-2, 2); break;
    case 'ueberstand': beam(-2, 2.6); tri(-2, 0, k); tri(1.2, 0, k, true); break;
    case 'zweifeld': beam(-2.5, 2.5); tri(-2.5, 0, k); tri(0, 0, k, true); tri(2.5, 0, k, true); break;
    case 'einsplos': wall(-2, 0, k, -1); beam(-2, 2); tri(2, 0, k, true); break;
    case 'beids': wall(-2, 0, k, -1); wall(2, 0, k, 1); beam(-2, 2); break;
    case 'gerber': beam(-3, 3); tri(-3, 0, k); tri(-1, 0, k, true); tri(3, 0, k, true); hinge(0.8, 0, 0.09); break;
    case 'F': arr(0, -1.4, 0, 0, thick, 1); break;
    case 'Fh': arr(-1.4, 0, 0, 0, thick, 1); break;
    case 'q': dist(-2, 2, () => 0.7); break;
    case 'dreieck': dist(-2, 2, x => 0.05 + 0.95 * (x + 2) / 4); break;
    case 'trapez': dist(-2, 2, x => 0.45 + 0.5 * (x + 2) / 4); break;
    case 'Mr': moment(true); break;
    case 'Ml': moment(false); break;
    case 'zweigelenk': case 'dreigelenk': {
      const top = -1.1, bot = 0.9;
      L([[-1.8, bot], [-1.8, top], [1.8, top], [1.8, bot]], thick);
      tri(-1.8, bot, k); tri(1.8, bot, k);
      if (id === 'dreigelenk') hinge(0, top, 0.09);
      break;
    }
  }
  return [...out, ...late];
}
/* Stahlbauprofile: Querschnitte, Mitte bei (0|0), Einheit = Stempelgröße s (Proportionen typischer Walzprofile) */
const STAHL_PROFILES = [
  { id: 'ipe', title: 'IPE' }, { id: 'hea', title: 'HEA' }, { id: 'heb', title: 'HEB' }, { id: 'upn', title: 'U (UPN)' },
  { id: 'l', title: 'L gleichschenklig' }, { id: 'lu', title: 'L ungleichschenklig' }, { id: 't', title: 'T' }, { id: 'z', title: 'Z' },
  { id: 'rhs', title: 'Rechteckrohr' }, { id: 'shs', title: 'Quadratrohr' }, { id: 'chs', title: 'Rundrohr' },
  { id: 'rd', title: 'Rundstahl' }, { id: 'fl', title: 'Flachstahl' }
];
function profileItems(id, s, color) {
  const thin = Math.max(1, s * 0.035), out = [];
  const P = pts => out.push({ t: 'shape', id: uid(), kind: 'poly', pts: pts.map(([x, y]) => [+(x * s).toFixed(2), +(y * s).toFixed(2)]), color, size: thin, fill: fillFor(color, 1), fillMode: 1 });
  const E = (r, white) => out.push({ t: 'shape', id: uid(), kind: 'ellipse', x1: -r * s, y1: -r * s, x2: r * s, y2: r * s, color, size: thin, fill: white ? '#ffffff' : fillFor(color, 1), fillMode: white ? 2 : 1 });
  const R = (w, h, white) => out.push({ t: 'shape', id: uid(), kind: 'rect', x1: -w / 2 * s, y1: -h / 2 * s, x2: w / 2 * s, y2: h / 2 * s, color, size: thin, fill: white ? '#ffffff' : fillFor(color, 1), fillMode: white ? 2 : 1 });
  // Doppel-T: Höhe h, Breite b, Stegdicke tw, Flanschdicke tf
  const I = (h, b, tw, tf) => { const H = h / 2, B = b / 2, W = tw / 2;
    P([[-B, -H], [B, -H], [B, -H + tf], [W, -H + tf], [W, H - tf], [B, H - tf], [B, H], [-B, H], [-B, H - tf], [-W, H - tf], [-W, -H + tf], [-B, -H + tf]]); };
  switch (id) {
    case 'ipe': I(1.4, 0.7, 0.07, 0.11); break;
    case 'hea': I(1.15, 1.2, 0.09, 0.14); break;
    case 'heb': I(1.2, 1.2, 0.11, 0.18); break;
    case 'upn': { const H = 0.7, b = 0.55, tw = 0.1, tf = 0.14, x0 = -b / 2;
      P([[x0, -H], [x0 + b, -H], [x0 + b, -H + tf * 0.8], [x0 + tw, -H + tf * 1.15], [x0 + tw, H - tf * 1.15], [x0 + b, H - tf * 0.8], [x0 + b, H], [x0, H]]); break; }
    case 'l': { const a = 1, t = 0.13, o = -a / 2; P([[o, o], [o + t, o], [o + t, o + a - t], [o + a, o + a - t], [o + a, o + a], [o, o + a]]); break; }
    case 'lu': { const a = 1.2, c = 0.8, t = 0.12, ox = -c / 2, oy = -a / 2; P([[ox, oy], [ox + t, oy], [ox + t, oy + a - t], [ox + c, oy + a - t], [ox + c, oy + a], [ox, oy + a]]); break; }
    case 't': { const b = 1, h = 1, t = 0.13, B = b / 2, H = h / 2, W = t / 2; P([[-B, -H], [B, -H], [B, -H + t], [W, -H + t], [W, H], [-W, H], [-W, -H + t], [-B, -H + t]]); break; }
    case 'z': { const H = 0.7, b = 0.5, t = 0.11, W = t / 2;
      P([[-b, -H], [W, -H], [W, H - t], [b, H - t], [b, H], [-W, H], [-W, -H + t], [-b, -H + t]]); break; }
    case 'rhs': R(1.4, 0.85); R(1.4 - 0.2, 0.85 - 0.2, true); break;
    case 'shs': R(1, 1); R(0.8, 0.8, true); break;
    case 'chs': E(0.6); E(0.5, true); break;
    case 'rd': E(0.45); break;
    case 'fl': R(1.3, 0.22); break;
  }
  return out;
}
/* Mathe: Koordinatensysteme. Ursprung bzw. Mittelpunkt bei (0|0), Einheit = Stempelgröße s */
const MATHE_STAMPS = [
  { id: 'k2', title: '2D-Koordinatensystem' }, { id: 'k2q', title: '2D, 1. Quadrant' }, { id: 'k2g', title: '2D mit Gitter' },
  { id: 'k3', title: '3D-Koordinatensystem' }, { id: 'k3r', title: '3D (rechtwinklig, Raum)' },
  { id: 'pol', title: 'Polarkoordinaten' }, { id: 'polp', title: 'Polar mit Punkt (r, φ)' }
];
function matheItems(id, s, color) {
  const thin = Math.max(0.8, s * 0.025), mid = Math.max(1.1, s * 0.04), out = [], fs = Math.max(8, s * 0.32);
  const L = (pts, w = thin, dash) => { const it = stampLine(pts.map(([x, y]) => [x * s, y * s]), color, w); if (dash) it.dash = true; out.push(it); };
  const A = (x1, y1, x2, y2) => out.push({ t: 'shape', id: uid(), kind: 'arrow', x1: x1 * s, y1: y1 * s, x2: x2 * s, y2: y2 * s, color, size: mid, hf: 'fill', hs: 0 });
  const T = (text, x, y, italic = true) => { const w = text.length * fs * 0.62 + fs * 0.4; out.push({ t: 'text', id: uid(), x: x * s - w / 2, y: y * s - fs * 0.68, w, text, size: +fs.toFixed(1), color, bold: false, font: italic ? 'serif' : 'sans' }); };
  const C = (r, dash) => out.push({ t: 'shape', id: uid(), kind: 'ellipse', x1: -r * s, y1: -r * s, x2: r * s, y2: r * s, color, size: thin, ...(dash ? { dash: true } : {}) });
  const ticksX = (a, b, step = 0.5, t = 0.06) => { for (let x = a; x <= b + 1e-6; x += step) if (Math.abs(x) > 1e-6) L([[x, -t], [x, t]]); };
  const ticksY = (a, b, step = 0.5, t = 0.06) => { for (let y = a; y <= b + 1e-6; y += step) if (Math.abs(y) > 1e-6) L([[-t, y], [t, y]]); };
  switch (id) {
    case 'k2': case 'k2g': {
      if (id === 'k2g') { for (let v = -2; v <= 2 + 1e-6; v += 0.5) if (Math.abs(v) > 1e-6) { L([[v, -2], [v, 2]], thin * 0.7, true); L([[-2, v], [2, v]], thin * 0.7, true); } }
      A(-2.2, 0, 2.3, 0); A(0, 2.2, 0, -2.3); ticksX(-2, 2); ticksY(-2, 2);
      T('x', 2.3, 0.3); T('y', 0.28, -2.3); T('0', -0.2, 0.25, false); T('1', 1, 0.28, false); T('1', -0.22, -1, false);
      break;
    }
    case 'k2q': A(-0.15, 0, 3.2, 0); A(0, 0.15, 0, -3.2); ticksX(0.5, 3); ticksY(-3, -0.5);
      T('x', 3.2, 0.3); T('y', 0.28, -3.2); T('0', -0.2, 0.25, false); T('1', 1, 0.28, false); T('1', -0.22, -1, false); break;
    case 'k3': {
      // Schrägbild: x schräg nach vorn-unten (45°, verkürzt), y nach rechts, z nach oben
      A(0, 0, 2.4, 0); A(0, 0, 0, -2.4); A(0, 0, -1.3, 1.3);
      L([[0, 0], [-1.6, 0]], thin, true); L([[0, 0], [0, 1.4]], thin, true); L([[0, 0], [0.9, -0.9]], thin, true);
      for (let k = 0.5; k <= 2 + 1e-6; k += 0.5) { L([[k, -0.06], [k, 0.06]]); L([[-0.06, -k], [0.06, -k]]); }
      for (let k = 0.5; k <= 1.75; k += 0.5) { const d = k * 0.71 * 0.71; L([[-d - 0.05, d - 0.05], [-d + 0.05, d + 0.05]]); }
      T('x', -1.45, 1.6); T('y', 2.45, 0.3); T('z', 0.28, -2.4); T('0', 0.2, 0.25, false);
      break;
    }
    case 'k3r': {
      // Raumecke: z oben, y rechts, x nach vorn-links (wie in vielen Schulbüchern)
      A(0, 0, 2.3, 0.55); A(0, 0, 0, -2.4); A(0, 0, -1.9, 0.75);
      T('x', -2.05, 1.05); T('y', 2.45, 0.85); T('z', 0.28, -2.4); T('0', 0.2, -0.25, false);
      break;
    }
    case 'pol': case 'polp': {
      for (const r of [0.5, 1, 1.5, 2]) C(r, r !== 2);
      for (let a = 0; a < 360; a += 30) { const t = a * Math.PI / 180; L([[0, 0], [2 * Math.cos(t), -2 * Math.sin(t)]], thin * 0.8, a % 90 !== 0); }
      A(0, 0, 2.35, 0);
      for (const [a, lab] of [[0, '0°'], [90, '90°'], [180, '180°'], [270, '270°']]) {
        const t = a * Math.PI / 180, r = 2.35; T(lab, r * Math.cos(t) + (a === 0 ? 0.15 : 0), -r * Math.sin(t) + (a === 0 ? -0.25 : 0), false);
      }
      for (const r of [1, 2]) T(String(r), r - 0.12, 0.22, false);
      if (id === 'polp') {
        const t = 50 * Math.PI / 180, r = 1.6, px = r * Math.cos(t), py = -r * Math.sin(t);
        L([[0, 0], [px, py]], mid);
        out.push({ t: 'shape', id: uid(), kind: 'ellipse', x1: (px - 0.07) * s, y1: (py - 0.07) * s, x2: (px + 0.07) * s, y2: (py + 0.07) * s, color, size: thin, fill: color, fillMode: 2 });
        L(arcPts(0, 0, 0.6, 0, -t, 16), mid);
        T('r', px / 2 - 0.15, py / 2 - 0.12); T('φ', 0.75, -0.3); T('P', px + 0.2, py - 0.15);
      }
      break;
    }
  }
  return out;
}
/* Flussdiagramm-Symbole nach der yEd-Palette „Flowchart“. Mitte bei (0|0), Breite 2s, Höhe s */
const FLUSS_SHAPES = [
  { id: 'process', title: 'Prozess' }, { id: 'decision', title: 'Entscheidung' }, { id: 'terminator', title: 'Start / Ende' },
  { id: 'data', title: 'Daten (Ein-/Ausgabe)' }, { id: 'predefined', title: 'Unterprogramm' }, { id: 'document', title: 'Dokument' },
  { id: 'multidoc', title: 'Mehrere Dokumente' }, { id: 'manualInput', title: 'Manuelle Eingabe' }, { id: 'manualOp', title: 'Manuelle Tätigkeit' },
  { id: 'preparation', title: 'Vorbereitung' }, { id: 'display', title: 'Anzeige' }, { id: 'delay', title: 'Verzögerung' },
  { id: 'loopLimit', title: 'Schleifengrenze' }, { id: 'connector', title: 'Verbinder' }, { id: 'offPage', title: 'Seitenverweis' },
  { id: 'database', title: 'Datenbank' }, { id: 'storedData', title: 'Gespeicherte Daten' }, { id: 'internal', title: 'Interner Speicher' },
  { id: 'card', title: 'Karte' }, { id: 'tape', title: 'Lochstreifen' }, { id: 'merge', title: 'Zusammenführen' },
  { id: 'extract', title: 'Extrahieren' }, { id: 'sort', title: 'Sortieren' }, { id: 'collate', title: 'Zusammenstellen' },
  { id: 'sum', title: 'Summierung' }, { id: 'or', title: 'Oder' }, { id: 'annotation', title: 'Anmerkung' }
];
function flussItems(id, s, color) {
  const lw = Math.max(1.1, s * 0.045), out = [];
  const sc = pts => pts.map(([x, y]) => [+(x * s).toFixed(2), +(y * s).toFixed(2)]);
  const P = (pts, white) => out.push({ t: 'shape', id: uid(), kind: 'poly', pts: sc(pts), color, size: lw, ...(white ? { fill: '#ffffff', fillMode: 2 } : {}) });
  const L = pts => out.push(stampLine(sc(pts), color, lw));
  const E = (cx, cy, rx, ry) => out.push({ t: 'shape', id: uid(), kind: 'ellipse', x1: (cx - rx) * s, y1: (cy - ry) * s, x2: (cx + rx) * s, y2: (cy + ry) * s, color, size: lw });
  const arc = (cx, cy, rx, ry, a0, a1, n = 18) => Array.from({ length: n + 1 }, (_, i) => { const t = (a0 + (a1 - a0) * i / n) * Math.PI / 180; return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)]; });
  const wave = (x0, x1, y, amp, n = 24) => Array.from({ length: n + 1 }, (_, i) => { const x = x0 + (x1 - x0) * i / n; return [x, y + amp * Math.sin(Math.PI * x)]; });
  const doc = (dx, dy, white) => P([[-1 + dx, -0.5 + dy], [1 + dx, -0.5 + dy], ...wave(1, -1, 0.36, 0.12).map(([x, y]) => [x + dx, y + dy])], white);
  switch (id) {
    case 'process': P([[-1, -0.5], [1, -0.5], [1, 0.5], [-1, 0.5]]); break;
    case 'decision': P([[0, -0.6], [1, 0], [0, 0.6], [-1, 0]]); break;
    case 'terminator': P([...arc(0.5, 0, 0.5, 0.5, -90, 90), ...arc(-0.5, 0, 0.5, 0.5, 90, 270)]); break;
    case 'data': P([[-0.75, -0.5], [1, -0.5], [0.75, 0.5], [-1, 0.5]]); break;
    case 'predefined': P([[-1, -0.5], [1, -0.5], [1, 0.5], [-1, 0.5]]); L([[-0.85, -0.5], [-0.85, 0.5]]); L([[0.85, -0.5], [0.85, 0.5]]); break;
    case 'document': doc(0, 0); break;
    case 'multidoc': doc(0.16, -0.16, true); doc(0.08, -0.08, true); doc(0, 0, true); break;
    case 'manualInput': P([[-1, -0.2], [1, -0.5], [1, 0.5], [-1, 0.5]]); break;
    case 'manualOp': P([[-1, -0.5], [1, -0.5], [0.75, 0.5], [-0.75, 0.5]]); break;
    case 'preparation': P([[-1, 0], [-0.75, -0.5], [0.75, -0.5], [1, 0], [0.75, 0.5], [-0.75, 0.5]]); break;
    case 'display': P([[-1, 0], [-0.7, -0.5], [0.6, -0.5], ...arc(0.6, 0, 0.4, 0.5, -90, 90).slice(1, -1), [0.6, 0.5], [-0.7, 0.5]]); break;
    case 'delay': P([[-1, -0.5], [0.5, -0.5], ...arc(0.5, 0, 0.5, 0.5, -90, 90).slice(1, -1), [0.5, 0.5], [-1, 0.5]]); break;
    case 'loopLimit': P([[-0.8, -0.5], [0.8, -0.5], [1, -0.3], [1, 0.5], [-1, 0.5], [-1, -0.3]]); break;
    case 'connector': E(0, 0, 0.4, 0.4); break;
    case 'offPage': P([[-0.6, -0.5], [0.6, -0.5], [0.6, 0.15], [0, 0.6], [-0.6, 0.15]]); break;
    case 'database': P([...arc(0, -0.4, 0.7, 0.15, 180, 360), [0.7, 0.4], ...arc(0, 0.4, 0.7, 0.15, 0, 180).slice(1), [-0.7, -0.4]]); L(arc(0, -0.4, 0.7, 0.15, 0, 180)); break;
    case 'storedData': P([[-0.8, -0.5], ...arc(1, 0, -0.2, 0.5, -90, 90), [-0.8, 0.5], ...arc(-0.8, 0, 0.2, 0.5, 90, 270).slice(1, -1)]); break;
    case 'internal': P([[-1, -0.5], [1, -0.5], [1, 0.5], [-1, 0.5]]); L([[-0.78, -0.5], [-0.78, 0.5]]); L([[-1, -0.28], [1, -0.28]]); break;
    case 'card': P([[-0.75, -0.5], [1, -0.5], [1, 0.5], [-1, 0.5], [-1, -0.25]]); break;
    case 'tape': P([...wave(-1, 1, -0.4, -0.1), ...wave(1, -1, 0.4, -0.1)]); break;
    case 'merge': P([[-0.7, -0.5], [0.7, -0.5], [0, 0.5]]); break;
    case 'extract': P([[0, -0.5], [0.7, 0.5], [-0.7, 0.5]]); break;
    case 'sort': P([[0, -0.6], [0.6, 0], [0, 0.6], [-0.6, 0]]); L([[-0.6, 0], [0.6, 0]]); break;
    case 'collate': P([[-0.5, -0.5], [0.5, -0.5], [0, 0], [0.5, 0.5], [-0.5, 0.5], [0, 0]]); break;
    case 'sum': { E(0, 0, 0.45, 0.45); const d = 0.45 * Math.SQRT1_2; L([[-d, -d], [d, d]]); L([[d, -d], [-d, d]]); break; }
    case 'or': E(0, 0, 0.45, 0.45); L([[-0.45, 0], [0.45, 0]]); L([[0, -0.45], [0, 0.45]]); break;
    case 'annotation': L([[-0.6, -0.5], [-1, -0.5], [-1, 0.5], [-0.6, 0.5]]); break;
  }
  return out;
}
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
  } else if (sel.startsWith('f:')) items = flussItems(sel.slice(2), prefs.sizes.stamp || 32, prefs.color);
  else if (sel.startsWith('m:')) items = matheItems(sel.slice(2), prefs.sizes.stamp || 32, prefs.color);
  else if (sel.startsWith('p:')) items = profileItems(sel.slice(2), prefs.sizes.stamp || 32, prefs.color);
  else if (sel.startsWith('s:')) items = statikItems(sel.slice(2), prefs.sizes.stamp || 32, prefs.color);
  else items = stampItems(sel, prefs.sizes.stamp || 32, prefs.color);
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
  if (/^[spmf]:/.test(sel)) return 'Stempel ▾';
  return (STAMPS.find(s => s.id === sel)?.label || '✓') + ' ▾';
}
function statikThumb(items, w, h) {
  const R = 2, c = document.createElement('canvas'); c.width = w * R; c.height = h * R; c.style.width = w + 'px'; c.style.height = h + 'px';
  const b = unionBox(items.map(bbox)), k = Math.min((w - 8) / Math.max(1, b.w), (h - 8) / Math.max(1, b.h), 2.6) * R;   // kleine Symbole (Gelenk) nicht riesig aufblasen
  const ctx = c.getContext('2d'); ctx.setTransform(k, 0, 0, k, w * R / 2 - (b.x + b.w / 2) * k, h * R / 2 - (b.y + b.h / 2) * k);
  drawItems(ctx, items, () => {});
  return c;
}
function buildStatikPop() {
  const fill = (box, list, w, h) => {
    box.innerHTML = '';
    for (const st of list) {
      const b = document.createElement('button'); b.dataset.stamp = 's:' + st.id; b.title = st.title;
      b.appendChild(statikThumb(statikItems(st.id, 20, '#1b1f24'), w, h));
      const l = document.createElement('span'); l.textContent = st.title; b.appendChild(l);
      b.classList.toggle('active', prefs.stamp === 's:' + st.id);
      box.appendChild(b);
    }
  };
  fill($('#statikSupports'), STATIK_SUPPORTS, 58, 40);
  fill($('#statikSystems'), STATIK_SYSTEMS, 110, 46);
  fill($('#statikLoads'), STATIK_LOADS, 80, 44);
}
function buildStahlPop() {
  const box = $('#stahlGrid'); box.innerHTML = '';
  for (const st of STAHL_PROFILES) {
    const b = document.createElement('button'); b.dataset.stamp = 'p:' + st.id; b.title = st.title;
    b.appendChild(statikThumb(profileItems(st.id, 20, '#1b1f24'), 60, 46));
    const l = document.createElement('span'); l.textContent = st.title; b.appendChild(l);
    b.classList.toggle('active', prefs.stamp === 'p:' + st.id);
    box.appendChild(b);
  }
}
function buildMathePop() {
  const box = $('#matheGrid'); box.innerHTML = '';
  for (const st of MATHE_STAMPS) {
    const b = document.createElement('button'); b.dataset.stamp = 'm:' + st.id; b.title = st.title;
    b.appendChild(statikThumb(matheItems(st.id, 20, '#1b1f24'), 60, 50));
    const l = document.createElement('span'); l.textContent = st.title; b.appendChild(l);
    b.classList.toggle('active', prefs.stamp === 'm:' + st.id);
    box.appendChild(b);
  }
}
function buildFlussPop() {
  const box = $('#flussGrid'); box.innerHTML = '';
  for (const st of FLUSS_SHAPES) {
    const b = document.createElement('button'); b.dataset.stamp = 'f:' + st.id; b.title = st.title;
    b.appendChild(statikThumb(flussItems(st.id, 20, '#1b1f24'), 64, 38));
    const l = document.createElement('span'); l.textContent = st.title; b.appendChild(l);
    b.classList.toggle('active', prefs.stamp === 'f:' + st.id);
    box.appendChild(b);
  }
}
$('#flussPop').addEventListener('click', e => {
  const b = e.target.closest('[data-stamp]'); if (!b) return;
  prefs.stamp = b.dataset.stamp; savePrefs(); hidePops(); updToolbar();
});
$('#mathePop').addEventListener('click', e => {
  const b = e.target.closest('[data-stamp]'); if (!b) return;
  prefs.stamp = b.dataset.stamp; savePrefs(); hidePops(); updToolbar();
});
$('#stahlPop').addEventListener('click', e => {
  const b = e.target.closest('[data-stamp]'); if (!b) return;
  prefs.stamp = b.dataset.stamp; savePrefs(); hidePops(); updToolbar();
});
$('#statikPop').addEventListener('click', e => {
  const b = e.target.closest('[data-stamp]'); if (!b) return;
  prefs.stamp = b.dataset.stamp; savePrefs(); hidePops(); updToolbar();
});
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
  $('#btnFill').hidden = ['compass', 'line', 'arrow'].includes(prefs.shape);
  $('#btnHatch').hidden = $('#btnFill').hidden;
  $('#btnHatch').innerHTML = hatchIcon(HATCHES[prefs.hatch] ? prefs.hatch : 'rc');
  $('#btnHatch').title = 'Schraffur: ' + (HATCHES[prefs.hatch]?.label || 'aus');
  $('#btnHatch').classList.toggle('active', !!HATCHES[prefs.hatch]);
  $('#btnHead').hidden = prefs.shape !== 'arrow';
  $('#btnHead').innerHTML = `<svg viewBox="0 0 24 24">${HEAD_ICONS[prefs.headForm || 'open']}</svg>`;
  $('#stampBox').hidden = t !== 'stamp';
  $('#btnStamp').textContent = stampLabel();
  $('#btnStatik').hidden = !addonOn('statik');
  $('#btnStahl').hidden = !addonOn('stahl');
  $('#btnMathe').hidden = !addonOn('mathe');
  $('#btnFluss').hidden = !addonOn('fluss');
  $('#btnFluss').classList.toggle('active', (prefs.stamp || '').startsWith('f:'));
  $('#btnMathe').classList.toggle('active', (prefs.stamp || '').startsWith('m:'));
  $('#btnStahl').classList.toggle('active', (prefs.stamp || '').startsWith('p:'));
  $('#btnStatik').classList.toggle('active', (prefs.stamp || '').startsWith('s:'));
  if (S.note) renderCompass();
  $('#rulerBox').hidden = t !== 'pen' && t !== 'marker';
  $('#btnRuler').classList.toggle('active', !!prefs.ruler);
  $('#btnDim').hidden = t !== 'pen'; $('#btnDim').classList.toggle('active', !!prefs.dim);
  $('#btnScale').hidden = t !== 'pen' || !prefs.dim; $('#btnScale').textContent = '1:' + fmtScale(prefs.dimScale || 50) + ' ▾';
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
  $('#optGuides').checked = prefs.guides !== false;
  $('#textOpts').hidden = t !== 'text' && !selTexts().length;
  document.querySelectorAll('[data-emode]').forEach(b => b.classList.toggle('active', b.dataset.emode === prefs.emode));
  document.querySelectorAll('[data-shape]').forEach(b => b.classList.toggle('active', b.dataset.shape === prefs.shape));
  if (!S.editing && !selTexts().length) showTextStyle(null);
  $('#customColor').value = /^#[0-9a-f]{6}$/i.test(prefs.color) ? prefs.color : '#000000';
  $('#optFinger').checked = prefs.finger;
  $('#optEditable').checked = prefs.editable;
}
/* Jedes farbige Werkzeug merkt sich seine zuletzt gewählte Farbe (z. B. Stift schwarz, Marker rot:
   beim Zurückwechseln zum Stift ist er wieder schwarz). Der Marker startet in Gelb. */
const COLOR_TOOLS = ['pen', 'marker', 'shape', 'text', 'stamp', 'restyle'];
prefs.toolColors ||= { marker: COLORS[6] };
function setTool(t) {
  commitText(); S.dimPending = null;
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
  savePrefs(); updToolbar(); styleEditing('color');
}

const PEN_LABELS = { fountain: 'Füller', ball: 'Kuli', pencil: 'Blei', brush: 'Pinsel', calligraphy: 'Kalli' };
let lastPenTap = 0;
/* Stift-Menü (Doppeltippen auf den Stift): Stiftart + Farbband mit 10 Farben und eigener Farbe */
const PEN_COLORS = ['#1b1f24', '#6b7280', '#8b5a2b', '#d0312d', '#ef8a00', '#ffd21f', '#1e8e4f', '#1fa5d6', '#1f4fd1', '#8a3fc2'];
$('#penColors').innerHTML = PEN_COLORS.map(c => `<button data-pcolor="${c}" style="background:${c}" title="${c}"></button>`).join('')
  + '<label class="custom-color" title="Eigene Farbe"><input type="color" id="penColor"><span>+</span></label>';
function syncPenPop() {
  document.querySelectorAll('#penPop [data-pstyle]').forEach(b => b.classList.toggle('active', b.dataset.pstyle === (prefs.penStyle || 'fountain')));
  document.querySelectorAll('#penColors [data-pcolor]').forEach(b => b.classList.toggle('active', b.dataset.pcolor.toLowerCase() === String(prefs.color).toLowerCase()));
  $('#penColor').value = /^#[0-9a-f]{6}$/i.test(prefs.color) ? prefs.color : '#000000';
}
$('#penColor').addEventListener('input', e => { setColor(e.target.value); syncPenPop(); });
$('#penPop').addEventListener('click', e => {
  const c = e.target.closest('[data-pcolor]');
  if (c) { setColor(c.dataset.pcolor); syncPenPop(); return; }
  const b = e.target.closest('[data-pstyle]'); if (!b) return;
  prefs.penStyle = b.dataset.pstyle; savePrefs(); hidePops(); setTool('pen');
});
function syncHeadPop() {
  document.querySelectorAll('#headPop [data-hf]').forEach(b => b.classList.toggle('active', b.dataset.hf === (prefs.headForm || 'open')));
  document.querySelectorAll('#headPop [data-hs]').forEach(b => b.classList.toggle('active', +b.dataset.hs === (prefs.headSize ?? 1)));
}
$('#headPop').addEventListener('click', e => {
  const b = e.target.closest('[data-hf],[data-hs]'); if (!b) return;
  if (b.dataset.hf) prefs.headForm = b.dataset.hf; else prefs.headSize = +b.dataset.hs;
  savePrefs(); syncHeadPop(); updToolbar();
  // markierte Pfeile gleich mit ändern
  if (S.sel) {
    const { p, ids } = S.sel, before = snap(p);
    let ch = false;
    p.items = p.items.map(it => ids.has(it.id) && it.t === 'shape' && it.kind === 'arrow' ? (ch = true, { ...it, hf: prefs.headForm || 'open', hs: prefs.headSize ?? 1 }) : it);
    if (ch) { renderRegion(pageEls.get(p.id), p, { x: 0, y: 0, w: p.w, h: p.h }); commit(p, before); renderSel(); }
  }
});
/* Schraffur-Auswahl (Formen) */
$('#hatchGrid').innerHTML = $('#styleHatch').innerHTML = [['', 'Keine', 'Keine Schraffur'], ...Object.entries(HATCHES).map(([k, v]) => [k, v.label, v.title])]
  .map(([k, l, t]) => `<button data-hatch="${k}" title="${t}">${hatchIcon(k)}<span>${l}</span></button>`).join('');
function syncHatchPop() {
  document.querySelectorAll('#hatchPop [data-hatch]').forEach(b => b.classList.toggle('active', b.dataset.hatch === (HATCHES[prefs.hatch] ? prefs.hatch : '')));
}
$('#hatchPop').addEventListener('click', e => {
  const b = e.target.closest('[data-hatch]'); if (!b) return;
  prefs.hatch = b.dataset.hatch; savePrefs(); syncHatchPop(); updToolbar(); hidePops();
});
$('#optSmooth').addEventListener('change', e => { prefs.smoothing = +e.target.value; savePrefs(); });
$('#optScribble').addEventListener('change', e => { prefs.scribble = e.target.checked; savePrefs(); });
$('#optGuides').addEventListener('change', e => { prefs.guides = e.target.checked; savePrefs(); });
$('#toolbar').addEventListener('pointerdown', e => { if (S.editing && e.target.closest('button,select,input')) e.preventDefault(); });
$('#toolbar').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.tool === 'pen') {
    // Doppeltippen auf den Stift öffnet die Auswahl der Stiftart
    const t = performance.now();
    if (prefs.tool === 'pen' && t - lastPenTap < 400) { lastPenTap = 0; syncPenPop(); showPop($('#penPop'), b); }
    else { lastPenTap = t; setTool('pen'); }
  }
  else if (b.dataset.tool) {
    setTool(b.dataset.tool);
    if (b.dataset.tool === 'restyle' && !prefs.rsHint) { prefs.rsHint = true; savePrefs(); toast('Zauberstift: Farbe und Stärke wählen, dann über Striche, Formen oder Text fahren – sie übernehmen den Stil.', 5500); }
  }
  else if (b.dataset.color) setColor(b.dataset.color);
  else if (b.id === 'btnSnap') { prefs.snapText = prefs.snapText === false; savePrefs(); updToolbar(); }
  else if (b.id === 'btnRuler') { prefs.ruler = !prefs.ruler; if (prefs.ruler) prefs.dim = false; savePrefs(); updToolbar(); }
  else if (b.id === 'btnDim') { prefs.dim = !prefs.dim; if (prefs.dim) prefs.ruler = false; savePrefs(); updToolbar(); if (prefs.dim && !prefs.dimHint) { prefs.dimHint = true; savePrefs(); toast('Bemaßung: von Punkt zu Punkt ziehen – oder mit dem Stift über eine Linie schweben und sie antippen. Maßstab über den Knopf daneben.', 7000); } }
  else if (b.id === 'btnScale') { syncScalePop(); showPop($('#scalePop'), b); }
  else if (b.id === 'btnAlpha') showPop($('#alphaPop'), b);
  else if (b.id === 'btnBehind') { prefs.markerBehind = prefs.markerBehind === false; savePrefs(); updToolbar(); }
  else if (b.id === 'btnFill') { prefs.fill = ((prefs.fill || 0) + 1) % 3; savePrefs(); updToolbar(); }
  else if (b.id === 'btnHead') { syncHeadPop(); showPop($('#headPop'), b); }
  else if (b.id === 'btnHatch') { syncHatchPop(); showPop($('#hatchPop'), b); }
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
  else if (b.id === 'btnBold') { const tx = selTexts(); if (!S.editing && tx.length) { const v = !tx[0].bold; styleSelTexts(i => (i.bold = v, i)); } else { prefs.bold = !prefs.bold; savePrefs(); updToolbar(); styleEditing('bold'); } }
  else if (b.id === 'btnImage') { commitText(); $('#fileImg').click(); }
  else if (b.id === 'btnStamp') { buildStampPop(); showPop($('#stampPop'), b); }
  else if (b.id === 'btnStatik') { buildStatikPop(); showPop($('#statikPop'), b); }
  else if (b.id === 'btnStahl') { buildStahlPop(); showPop($('#stahlPop'), b); }
  else if (b.id === 'btnMathe') { buildMathePop(); showPop($('#mathePop'), b); }
  else if (b.id === 'btnFluss') { buildFlussPop(); showPop($('#flussPop'), b); }
  else if (b.id === 'btnFormula') { if (S.note) openFormula(currentPage()); }
  else if (b.id === 'btnTable') { if (S.note) openGrid('table', currentPage()); }
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
$('#textSize').addEventListener('change', e => {
  const v = +e.target.value;
  if (styleSelTexts(i => (i.size = v, i.h = 0, i))) return;   // markierter Text: nur dieser ändert sich
  prefs.textSize = v; savePrefs(); styleEditing('size');
});
$('#textFont').addEventListener('change', e => {
  const v = e.target.value;
  if (styleSelTexts(i => (i.font = v, i))) return;
  prefs.textFont = v; savePrefs(); styleEditing('font');
});
$('#fileImg').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (f) try { await insertImage(f); } catch (err) { toast(err.message); }
});

/* ---------------- Menüs ---------------- */
function showPop(pop, anchor) {
  hidePops();
  pop.hidden = false;
  pop.style.maxHeight = '';
  const r = anchor.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
  pop.style.left = clamp(r.right - pw, 8, innerWidth - pw - 8) + 'px';
  // passt das Menü weder unter noch über den Knopf, wird es auf den freien Platz begrenzt und scrollt
  const below = innerHeight - r.bottom - 14, above = r.top - 14;
  if (ph <= below) pop.style.top = r.bottom + 6 + 'px';
  else if (ph <= above) pop.style.top = r.top - ph - 6 + 'px';
  else if (below >= above) { pop.style.maxHeight = below + 'px'; pop.style.top = r.bottom + 6 + 'px'; }
  else { pop.style.maxHeight = above + 'px'; pop.style.top = r.top - above - 6 + 'px'; }
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
  else if (m === 'table') openGrid('table', currentPage());
  else if (m === 'paste') pasteClip();
  else if (m === 'insPdf') pickInsertPdf();
  else if (m === 'noteArea') toggleNoteArea();
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
  insertPages(i + 1, [after.endless ? { id: uid(), w: A4[1], h: A4[0], bg: after.bg, paper: after.paper, pdf: null, items: [], endless: true }
    : { id: uid(), w: after.w, h: after.h, bg: tpl ? tpl.bg : 'blank', paper: tpl?.paper, pdf: null, items: [] }]);
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
  const withNote = S.note.pages.some(p => p.noteW);
  insertPages(i + 1, sizes.map(([w, h], k) => withNote ? { id: uid(), w: w + Math.round(w * 0.5), h, pw: w, noteW: Math.round(w * 0.5), noteBg: 'grid', bg: 'pdf', pdf: offset + k, items: [] } : { id: uid(), w, h, bg: 'pdf', pdf: offset + k, items: [] }));
  pushPagesHist(before);
  pageEls.forEach(pe => { pe.sc = null; }); scheduleRender();
  toast(`${sizes.length} PDF-Seite(n) aus „${file.name}“ eingefügt.`, 4000);
}
/* Notizfläche rechts neben allen PDF-Seiten an- oder ausschalten */
function toggleNoteArea() {
  commitText();
  const pdfPages = S.note.pages.filter(p => p.pdf != null);
  if (!pdfPages.length) return toast('Diese Notiz hat keine PDF-Seiten. Die Notizfläche gibt es für geöffnete oder eingefügte PDFs.', 5000);
  const on = pdfPages.some(p => !p.noteW);
  if (!on) {
    const used = pdfPages.find(p => p.items.some(it => { const b = bbox(it); return b.x + b.w > p.pw + 2; }));
    if (used) return toast('Auf der Notizfläche steht noch etwas. Bitte zuerst dort löschen oder verschieben.', 5000);
  }
  const before = pagesSnap();
  for (const p of pdfPages) {
    if (on && !p.noteW) { p.pw = p.w; p.noteW = Math.round(p.w * 0.5); p.noteBg = 'grid'; p.w = p.pw + p.noteW; }
    else if (!on && p.noteW) { p.w = p.pw; delete p.pw; delete p.noteW; delete p.noteBg; }
  }
  if (S.pdf) S.pdf._thumbBg = null;
  pageEls.forEach(pe => { pe.sc = null; hideDetail(pe); });
  pagesChanged(); pushPagesHist(before); scheduleRender();
  toast(on ? 'Notizfläche rechts neben den PDF-Seiten eingefügt. Beim Speichern wird sie Teil der PDF.' : 'Notizfläche entfernt.', 4500);
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
    const cache = pdf._thumbBg ||= new Map(), key = p.pdf + ':' + W + ':' + (p.noteW || 0);
    let bg = cache.get(key);
    if (!bg) {
      bg = document.createElement('canvas'); bg.width = c.width; bg.height = c.height;
      const bx = bg.getContext('2d'); bx.fillStyle = '#fff'; bx.fillRect(0, 0, bg.width, bg.height);
      const pg = await pdf.getPage(p.pdf + 1);
      await pg.render({ canvasContext: bx, viewport: pg.getViewport({ scale: r }) }).promise;
      if (p.noteW) { bx.setTransform(r, 0, 0, r, 0, 0); drawNoteArea(bx, p); }
      cache.set(key, bg);
    }
    ctx.drawImage(bg, 0, 0);
    ctx.setTransform(r, 0, 0, r, 0, 0); await paintOverlay(ctx, p, false);
  } else { ctx.setTransform(r, 0, 0, r, 0, 0); await paintOverlay(ctx, p, true); }
  return c;
}
const makeThumb = async () => (await pageThumb(S.note.pages[0], 300)).toDataURL('image/jpeg', 0.75);

async function newNote(paper, orient, size = 'A4') {
  const f = PAPER[size] || A4, endless = size === 'E', [w, h] = endless ? [A4[1], A4[0]] : orient === 'l' ? [f[1], f[0]] : f;
  const now = Date.now();
  const note = {
    id: uid(), title: 'Notiz vom ' + new Date().toLocaleDateString('de-DE', { day: 'numeric', month: 'long' }),
    folder: S.folder, created: now, updated: now, pages: [{ id: uid(), w, h, bg: paper, pdf: null, items: [], ...(endless ? { endless: true } : {}) }]
  };
  await dbPut('notes', note);
  if (endless && !prefs.endlessHint) { prefs.endlessHint = true; savePrefs(); setTimeout(() => toast('Endlos-Papier: Es wächst automatisch, sobald du nahe am Rand schreibst – in jede Richtung. Gespeichert wird der beschriebene Bereich (höchstens A0).', 7500), 600); }
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
  if (!restored && !prefs.noteAreaHint) {
    prefs.noteAreaHint = true; savePrefs();
    setTimeout(() => toast('Tipp: Menü ⋮ → „Notizfläche neben PDF an/aus“ setzt rechts neben jede Seite eine karierte Fläche für Notizen.', 7000), 5500);
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
/* Ordner sind Pfade wie „Uni/Mathe/Analysis/Kapitel 1“ – beliebig tief verschachtelt */
const parentOf = f => f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
const leafOf = f => f.slice(f.lastIndexOf('/') + 1);
const inFolder = (nf, f) => !f || nf === f || (nf || '').startsWith(f + '/');
const cleanName = n => (n || '').replace(/\//g, '-').replace(/\s+/g, ' ').trim();
function allFolders(notes) {
  const set = new Set();
  for (const f of [...prefs.folders, ...notes.map(n => n.folder)]) {
    if (!f) continue;
    const parts = f.split('/'); for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/'));
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'de'));
}
async function newFolderIn(parent) {
  const n = cleanName(prompt(parent ? `Neuer Unterordner in „${leafOf(parent)}“:` : 'Name des neuen Ordners:'));
  if (!n) return null;
  const f = parent ? parent + '/' + n : n;
  prefs.folders = [...new Set([...prefs.folders, f])]; savePrefs();
  return f;
}
/* Ordner umbenennen/verschieben: alle Pfade mit diesem Anfang anpassen (Notizen und leere Ordner) */
async function remapFolder(from, to) {
  const map = f => f === from ? to : f && f.startsWith(from + '/') ? (to ? to + f.slice(from.length) : f.slice(from.length + 1)) : f;
  prefs.folders = [...new Set(prefs.folders.map(map).filter(Boolean))]; savePrefs();
  for (const n of await dbAll('notes')) if (inFolder(n.folder, from) && n.folder) { n.folder = map(n.folder); await dbPut('notes', n); }
}
async function renderLibrary() {
  const notes = (await dbAll('notes')).sort((a, b) => b.updated - a.updated);
  const folders = allFolders(notes);
  if (S.folder && !folders.includes(S.folder)) S.folder = '';
  // Pfad: Alle Notizen › Uni › Mathe  (antippen = dorthin springen, ⋯ = Ordner bearbeiten)
  const cb = $('#crumbs'); cb.innerHTML = '';
  const crumb = (label, val) => {
    const b = document.createElement('button'); b.textContent = label;
    if (S.folder === val) b.classList.add('cur');
    b.onclick = () => { S.folder = val; renderLibrary(); };
    cb.appendChild(b);
  };
  crumb('Alle Notizen', '');
  if (S.folder) {
    const parts = S.folder.split('/');
    parts.forEach((p, i) => { const s = document.createElement('span'); s.className = 'sep'; s.textContent = '›'; cb.appendChild(s); crumb(p, parts.slice(0, i + 1).join('/')); });
    const m = document.createElement('button'); m.className = 'fmenu'; m.textContent = '⋯'; m.title = 'Ordner bearbeiten';
    m.onclick = e => showPop($('#folderPop'), e.currentTarget);
    cb.appendChild(m);
  }
  // Unterordner des aktuellen Ordners
  const fbox = $('#folders'); fbox.innerHTML = '';
  for (const f of folders.filter(f => parentOf(f) === S.folder)) {
    const b = document.createElement('button'); b.className = 'chip dir'; b.textContent = leafOf(f);
    const cnt = notes.filter(n => inFolder(n.folder, f)).length;
    if (cnt) { const sm = document.createElement('small'); sm.textContent = cnt; b.appendChild(sm); }
    b.onclick = () => { S.folder = f; renderLibrary(); };
    fbox.appendChild(b);
  }
  const add = document.createElement('button'); add.className = 'chip add'; add.textContent = S.folder ? '+ Unterordner' : '+ Ordner';
  add.onclick = async () => { const f = await newFolderIn(S.folder); if (f) { S.folder = f; renderLibrary(); } };
  fbox.appendChild(add);

  const q = S.search.trim().toLowerCase();
  // im Ordner: seine Notizen und die aller Unterordner
  const list = notes.filter(n => inFolder(n.folder, S.folder) && (!q || n.title.toLowerCase().includes(q)));
  const grid = $('#noteGrid'); grid.innerHTML = '';
  for (const n of list) {
    const card = document.createElement('article'); card.className = 'card'; card.dataset.id = n.id;
    card.innerHTML = `<button class="card-open"><div class="thumb"></div></button>
      <div class="card-meta"><div class="card-text"><div class="card-title"></div><div class="card-sub"></div></div>
      <button class="card-menu" aria-label="Optionen">⋯</button></div>`;
    if (n.thumb) { const img = new Image(); img.src = n.thumb; img.alt = ''; card.querySelector('.thumb').appendChild(img); }
    card.querySelector('.card-title').textContent = n.title;
    const sub = card.querySelector('.card-sub');
    const rel = n.folder && n.folder !== S.folder ? (S.folder ? n.folder.slice(S.folder.length + 1) : n.folder) : '';
    sub.textContent = fmtDate(n.updated) + (rel ? ' · ' + rel.replace(/\//g, ' › ') : '');
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
  else if (c === 'move') { const f = await pickFolder(`„${n.title}“`, n.folder || ''); if (f !== null) { n.folder = f; await dbPut('notes', n); } }
  else if (c === 'copy') {
    // Kopie mit allem Geschriebenen (und dem Original-PDF); sie ist nicht mit der Datei in Nextcloud verknüpft
    const f = await pickFolder(`„${n.title}“`, n.folder || '', null, 'kopieren');
    if (f === null) return;
    const now = Date.now(), cp = structuredClone(n);
    Object.assign(cp, { id: uid(), title: n.title.replace(/\.pdf$/i, '') + ' (Kopie)', folder: f, created: now, updated: now });
    delete cp.unsaved;
    const bl = await dbGet('blobs', n.id);
    await dbPut('notes', cp);
    if (bl) await dbPut('blobs', { ...bl, id: cp.id });
    toast('Kopie erstellt' + (f ? ` in „${leafOf(f)}“` : '') + '.');
  }
  else if (c === 'delete') {
    if (!confirm(`„${n.title}“ aus dem Notizbuch löschen?${n.fileName ? ' Die Datei in Nextcloud bleibt erhalten.' : ''}`)) return;
    await dbDel('notes', n.id); await dbDel('blobs', n.id); await dbDel('handles', n.id);
  }
  renderLibrary();
});
/* Ordner auswählen (eingerückte Liste aller Ordner); null = abgebrochen, '' = ohne Ordner */
async function pickFolder(what, cur, exclude = null, verb = 'verschieben') {
  const dlg = $('#moveDlg'), box = $('#moveList');
  $('#moveMsg').textContent = `${what} ${verb} nach:`;
  dlg.querySelector('h2').textContent = verb === 'kopieren' ? 'In Ordner kopieren' : 'In Ordner verschieben';
  const folders = allFolders(await dbAll('notes')).filter(f => !exclude || !inFolder(f, exclude));
  box.innerHTML = '';
  const row = (label, val, depth) => {
    const b = document.createElement('button'); b.dataset.mv = 'f:' + val; b.textContent = label;
    b.style.paddingLeft = 10 + depth * 22 + 'px';
    if (val === cur) b.classList.add('cur');
    box.appendChild(b);
  };
  row('Ohne Ordner (oberste Ebene)', '', 0);
  folders.forEach(f => row('📁 ' + leafOf(f), f, f.split('/').length));
  const r = await dialogChoice(dlg, 'mv');
  if (r === 'cancel') return null;
  if (r === 'new') { const f = await newFolderIn(S.folder); return f; }
  return r.slice(2);
}
$('#folderPop').addEventListener('click', async e => {
  const c = e.target.closest('button')?.dataset.f; if (!c || !S.folder) return;
  hidePops();
  const f = S.folder, parent = parentOf(f);
  if (c === 'new') { const nf = await newFolderIn(f); if (nf) S.folder = nf; }
  else if (c === 'rename') {
    const n = cleanName(prompt('Neuer Name des Ordners:', leafOf(f))); if (!n || n === leafOf(f)) return;
    const to = parent ? parent + '/' + n : n;
    await remapFolder(f, to); S.folder = to;
  } else if (c === 'move') {
    const dest = await pickFolder(`Ordner „${leafOf(f)}“`, parent, f);
    if (dest === null || dest === parent || inFolder(dest, f)) return;
    const to = dest ? dest + '/' + leafOf(f) : leafOf(f);
    await remapFolder(f, to); S.folder = to;
  } else if (c === 'delete') {
    const where = parent ? `„${leafOf(parent)}“` : 'die oberste Ebene';
    if (!confirm(`Ordner „${leafOf(f)}“ löschen?\nDie Notizen und Unterordner darin werden nicht gelöscht, sondern nach ${where} verschoben.`)) return;
    // Inhalt eine Ebene nach oben
    const map = x => x === f ? parent : x.startsWith(f + '/') ? (parent ? parent + '/' : '') + x.slice(f.length + 1) : x;
    prefs.folders = [...new Set(prefs.folders.map(map).filter(Boolean))]; savePrefs();
    for (const n of await dbAll('notes')) if (n.folder && inFolder(n.folder, f)) { n.folder = map(n.folder); await dbPut('notes', n); }
    S.folder = parent;
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
$('#btnNewNote').addEventListener('click', () => {
  const f = $('#newForm');
  f.elements.size.value = prefs.newSize || 'A4';
  f.querySelector(`[name="orient"][value="${prefs.newOrient === 'l' ? 'l' : 'p'}"]`).checked = true;
  $('#newDlg').showModal();
});
$('#newDlg').addEventListener('close', () => {
  if ($('#newDlg').returnValue !== 'ok') return;
  const f = new FormData($('#newForm'));
  prefs.newSize = f.get('size') || 'A4'; prefs.newOrient = f.get('orient'); savePrefs();
  newNote(f.get('paper'), f.get('orient'), prefs.newSize);
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
const APP_VERSION = 73;
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
$('#btnSettings').addEventListener('click', e => $('#settingsPop').hidden ? (buildAddons(), showPop($('#settingsPop'), e.currentTarget)) : hidePops());
/* Add-ons: Zusatzpakete, die man in den Einstellungen ein- und ausschalten kann (weitere einfach hier ergänzen) */
var ADDONS = [   // var: wird schon beim Start (updToolbar) gebraucht
  { id: 'statik', title: 'Statik (Bauwesen)', desc: 'Auflager, statische Systeme und Lasten als Stempel', def: true },
  { id: 'stahl', title: 'Stahlbauprofile', desc: 'Querschnitte: IPE, HEA, HEB, U, L, T, Z, Rohre, Rund- und Flachstahl', def: true },
  { id: 'mathe', title: 'Mathematik', desc: 'Koordinatensysteme (2D, 3D) und Polarkoordinaten als Stempel', def: true },
  { id: 'fluss', title: 'Flussdiagramm', desc: 'Symbole wie in yEd: Prozess, Entscheidung, Start/Ende, Daten, Dokument …', def: true }
];
function addonOn(id) { return (prefs.addons || {})[id] ?? (ADDONS || []).find(a => a.id === id)?.def ?? true; }
function buildAddons() {
  const box = $('#addonList'); box.innerHTML = '';
  for (const a of ADDONS) {
    const l = document.createElement('label'); l.className = 'check';
    l.innerHTML = `<input type="checkbox" data-addon="${a.id}"><span><b></b><small></small></span>`;
    l.querySelector('b').textContent = a.title; l.querySelector('small').textContent = a.desc;
    l.querySelector('input').checked = addonOn(a.id);
    box.appendChild(l);
  }
}
$('#addonList').addEventListener('change', e => {
  const id = e.target.dataset.addon; if (!id) return;
  prefs.addons = { ...(prefs.addons || {}), [id]: e.target.checked };
  const pre = { statik: 's:', stahl: 'p:', mathe: 'm:', fluss: 'f:' }[id];
  if (pre && !e.target.checked && (prefs.stamp || '').startsWith(pre)) prefs.stamp = 'check';
  savePrefs(); updToolbar();
  toast(e.target.checked ? 'Add-on eingeschaltet.' : 'Add-on ausgeschaltet. Schon gesetzte Zeichen bleiben erhalten.');
});
$('#settingsPop').addEventListener('click', e => {
  const s = e.target.closest('[data-s]')?.dataset.s; if (!s) return;
  hidePops();
  if (s === 'update') checkForUpdates(true);
  else if (s === 'tutorial') openTutorial();
  else if (s === 'news') showNews(Object.keys(CHANGELOG).sort((a, b) => verCmp(b, a)), 'Neuigkeiten');
});
/* ---------------- Kurzanleitung ---------------- */
const TUTORIAL = [
  { t: 'Willkommen im Notizbuch', i: '#btnSettings', h: `<p>Diese Kurzanleitung zeigt dir alle Funktionen. Mit <b>Weiter</b> blätterst du, <b>Schließen</b> beendet sie jederzeit – du findest sie wieder unter ⚙ → Kurzanleitung.</p>
    <h3>Die Übersicht</h3><ul>
    <li><b>Neue Notiz</b> legt ein leeres Heft an, <b>PDF öffnen</b> holt eine PDF (z. B. aus Nextcloud) zum Beschreiben.</li>
    <li><b>Suche</b> findet Notizen nach ihrem Titel.</li>
    <li><b>Ordner</b>: oben steht der Pfad (z. B. Alle Notizen › Uni › Mathe) – antippen springt zurück. Darunter die Unterordner und „+ Ordner“. Ordner lassen sich beliebig tief verschachteln.</li>
    <li><b>⋯ neben dem Ordnernamen</b>: Unterordner anlegen, umbenennen, verschieben, löschen (der Inhalt rutscht eine Ebene nach oben).</li>
    <li><b>⋯ an einer Notiz</b>: umbenennen, in einen Ordner verschieben oder kopieren, löschen.</li></ul>` },
  { t: 'Schreiben mit dem Stift', i: '[data-tool="pen"]', h: `<ul>
    <li><b>Doppelt auf den Stift tippen</b> öffnet die Stiftarten (Füller, Kugelschreiber, Bleistift, Pinsel, Kalligrafie) und ein Farbband mit 10 Farben plus eigener Farbe (+).</li>
    <li>Die <b>Strichstärke</b> wählst du mit den drei Punkten oder dem Regler. Lange auf einen Punkt drücken speichert die aktuelle Stärke darauf.</li>
    <li>Jedes Werkzeug merkt sich <b>seine eigene Farbe</b>.</li>
    <li><b>Form erkennen</b>: Am Ende eines Strichs den Stift kurz halten – aus der Kritzelei wird eine saubere Linie, ein Kreis oder ein Rechteck.</li>
    <li><b>Lineal</b>: Jeder Strich wird eine gerade Linie; Winkel und Länge werden angezeigt.</li>
    <li><b>Bemaßung</b> (neben dem Lineal): Von Punkt A zu Punkt B ziehen (rastet an Ecken und Linienenden ein, pinker Kreis), absetzen, dann irgendwo aufsetzen und seitlich ziehen – die Maßlinie wandert parallel heraus; kurz tippen = so lassen. Später mit dem Lasso: mittlerer Griff = Abstand, Endgriffe = Messpunkte. Daneben stellst du <b>Maßstab</b> (z. B. 1:50), Einheit und Nachkommastellen ein. Die Zahl lässt sich überschreiben: Maß markieren → „Maßzahl ändern“; die Enden kannst du mit dem Lasso verschieben, die Zahl rechnet sich neu.</li>
    <li><b>S Pen-Taste</b> gedrückt halten = Radierer. <b>Kritzeln</b> über Geschriebenes löscht es (abschaltbar im Menü ⋮).</li>
    <li><b>Lange auf eine freie Stelle drücken</b> zeigt „Einfügen“, wenn etwas kopiert ist (Stift oder Finger 2 Sekunden ruhig halten).</li></ul>` },
  { t: 'Textmarker und Zauberstift', i: '[data-tool="marker"]', h: `<h3>Textmarker</h3><ul>
    <li>Legt sich standardmäßig <b>hinter</b> die Schrift, damit sie lesbar bleibt (Knopf in der Leiste).</li>
    <li>Die <b>Transparenz</b> stellst du mit dem Regler-Knopf ein.</li>
    <li>Auf PDF-Seiten rastet er an den Textzeilen ein.</li></ul>
    <h3>Zauberstift</h3><ul>
    <li>Farbe und Stärke wählen, dann über Striche, Formen oder Text fahren – sie übernehmen den Stil.</li></ul>` },
  { t: 'Radierer', i: '[data-tool="eraser"]', h: `<ul>
    <li><b>Bereich</b>: löscht nur, was unter dem Radierer liegt – auch Teile von Formen und Linien.</li>
    <li><b>Ganze Striche</b>: ein Strich wird komplett gelöscht.</li>
    <li><b>Abdecken</b>: übermalt mit Papierweiß – auch Schrift aus anderen Apps in einer PDF.</li>
    <li>Tippst du nach dem Radieren eine Farbe an, bist du sofort wieder beim letzten Stift.</li></ul>` },
  { t: 'Lasso: auswählen und bearbeiten', i: '[data-tool="lasso"]', h: `<ul>
    <li>Um Objekte herumfahren – markiert wird nur, was <b>vollständig</b> im Lasso liegt. Einzelnes Antippen markiert ein Objekt.</li>
    <li><b>Griffe</b>: Ecken = Größe (Seitenverhältnis bleibt), Seiten = nur Breite oder Höhe, oberer Kreis = drehen. Bei Linien und Pfeilen ziehst du direkt die Enden.</li>
    <li><b>Verschieben</b>, auch auf eine andere Seite – am Rand scrollt es mit. Dabei erscheinen kurz <b>Hilfslinien</b> (pink), wenn eine Kante oder Mitte auf einer Linie mit einem anderen Objekt oder der Seitenmitte liegt – das Objekt rastet dort ein. Abschaltbar im Menü ⋮.</li>
    <li><b>Ausrichten</b> (in der Leiste): mehrere markierte Objekte links, mittig, rechts, oben oder unten aneinander ausrichten oder gleichmäßig verteilen. Ein einzelnes Objekt wird an der Seite ausgerichtet.</li>
    <li>Leiste: <b>Text/Formel bearbeiten</b>, Stil ändern, Ebene, Kopieren, Ausschneiden, Duplizieren, Als Stempel, Löschen.</li>
    <li>Ist Text markiert, ändern Größe, Schriftart und Fett oben in der Leiste <b>nur diesen Text</b>.</li>
    <li>Farbe antippen färbt die Auswahl um.</li></ul>` },
  { t: 'Text und Formeln', i: '[data-tool="text"]', h: `<ul>
    <li>Mit dem Text-Werkzeug auf das Blatt tippen und schreiben. Vorhandenen Text antippen bearbeitet ihn.</li>
    <li><b>Größe</b> 4 bis 44, <b>Schriftart</b> (Standard, Serif, Schreibmaschine, Schreibschrift) und <b>Fett</b>.</li>
    <li><b>▦ Tabelle</b>: Zeilen, Spalten und Kopfzeile wählen und die Zellen gleich ausfüllen. Markierte Tabelle → „Tabelle bearbeiten“ ändert Inhalt und Größe; mit dem Lasso an Ecken und Seiten breiter oder höher ziehen.</li>
    <li><b>∑ Formel</b>: Mathe in LaTeX eingeben (z. B. \\frac{a}{b}), mit Tasten für häufige Zeichen. Formel antippen bearbeitet sie wieder.</li></ul>` },
  { t: 'Formen und Zirkel', i: '[data-tool="shape"]', h: `<ul>
    <li>Rechteck, Ellipse, Dreieck, Linie und Pfeil aufziehen. Linien rasten bei 0°, 45° und 90° ein.</li>
    <li><b>Pfeilspitze</b>: Form (offen, gefüllt, spitz) und Größe (klein, mittel, groß).</li>
    <li><b>Füllung</b> aus, hell (20 %) oder voll; <b>gestrichelte</b> Linie.</li>
    <li><b>Zirkel</b>: Mittelpunkt setzen, Radius ziehen, dann am Kreis herumfahren – rastet bei Viertel-, Halb- und Vollkreis ein.</li></ul>` },
  { t: 'Stempel und Add-ons', i: '[data-tool="stamp"]', h: `<ul>
    <li><b>Stempel ▾</b>: Häkchen, Kreuz, Stern, Smileys, Datum, „Erledigt“ – und deine eigenen (etwas mit dem Lasso markieren → „Als Stempel“).</li>
    <li><b>Statik ▾</b>: Auflager, statische Systeme und Lasten. Auflager und Lasten sitzen mit dem Anschlusspunkt dort, wo du tippst.</li>
    <li><b>Stahl ▾</b>: Querschnitte von IPE, HEA, HEB, U, L, T, Z, Rohren, Rund- und Flachstahl.</li>
    <li><b>Mathe ▾</b>: 2D- und 3D-Koordinatensysteme, Polarkoordinaten und „Matrix einfügen …“ (Größe und Klammern frei wählbar, Einträge in LaTeX).</li>
    <li><b>Fluss ▾</b>: Flussdiagramm-Symbole wie in yEd (Prozess, Entscheidung, Start/Ende, Daten, Dokument, Datenbank …). Text mit dem Text-Werkzeug hinein, Verbindungen mit Pfeilen.</li>
    <li>Größe über den Regler. Alles besteht aus normalen Linien und Texten – du kannst es also verschieben, ändern und radieren.</li>
    <li>Die Pakete Statik, Stahl, Mathe und Fluss sind <b>Add-ons</b>: unter ⚙ → Add-ons einzeln ein- und ausschaltbar.</li></ul>` },
  { t: 'Seiten, Bilder und Ansicht', i: '#btnImage', h: `<ul>
    <li><b>Bild</b> einfügen und danach mit dem Lasso verschieben, drehen und skalieren.</li>
    <li><b>Seitenübersicht</b> (Kachel-Knopf oben): Seiten anspringen, Lesezeichen sehen.</li>
    <li><b>Menü ⋮</b>: Seite einfügen, duplizieren, löschen, Hintergrund (blanko, liniert, kariert, Punkte …), PDF-Seiten einfügen, Lesezeichen.</li>
    <li><b>Zoomen</b> mit zwei Fingern, <b>scrollen</b> mit dem Finger (Schwung geht weiter). Im Menü: „Mit dem Finger zeichnen“ und „Zoom zurücksetzen“.</li>
    <li><b>Rückgängig / Wiederholen</b> mit den Pfeilen oben.</li></ul>` },
  { t: 'Speichern, Sicherung und Updates', i: '#btnSave', h: `<ul>
    <li><b>Als PDF speichern</b> bzw. <b>Speichern</b> schreibt die Notiz als PDF, z. B. direkt in Nextcloud. Eine geöffnete PDF wird überschrieben; „Speichern unter …“ legt eine neue Datei an.</li>
    <li>„Schrift in der PDF bearbeitbar halten“: Beim nächsten Öffnen in der App kannst du alles weiter bearbeiten.</li>
    <li>Ein orangefarbenes „nicht gespeichert“ zeigt Änderungen, die noch nicht in der Datei sind.</li>
    <li><b>Sicherung</b> (Übersicht oben): alle Notizen in eine Datei sichern und wiederherstellen.</li>
    <li><b>Updates</b> sucht die App beim Öffnen von selbst; ein oranger Knopf zeigt eine neue Version. Danach kannst du dir die Neuigkeiten zeigen lassen.</li></ul>` }
];
let tutPage = 0;
function renderTut() {
  const p = TUTORIAL[tutPage];
  $('#tutTitle').textContent = p.t;
  $('#tutBody').innerHTML = p.h; $('#tutBody').scrollTop = 0;
  const ic = p.i && document.querySelector(p.i + ' svg');
  $('#tutIcon').innerHTML = ic ? ic.outerHTML : '';
  $('#tutDots').innerHTML = TUTORIAL.map((_, i) => `<i class="${i === tutPage ? 'on' : ''}"></i>`).join('');
  $('#tutDlg [data-t="prev"]').disabled = tutPage === 0;
  $('#tutDlg [data-t="next"]').textContent = tutPage === TUTORIAL.length - 1 ? 'Fertig' : 'Weiter';
}
function openTutorial() { tutPage = 0; renderTut(); $('#tutDlg').showModal(); }
$('#tutDlg').addEventListener('click', e => {
  const a = e.target.closest('[data-t]')?.dataset.t; if (!a) return;
  if (a === 'close' || (a === 'next' && tutPage === TUTORIAL.length - 1)) return $('#tutDlg').close();
  tutPage = clamp(tutPage + (a === 'next' ? 1 : -1), 0, TUTORIAL.length - 1); renderTut();
});

/* ---------------- Neuigkeiten nach einem Update ---------------- */
const CHANGELOG = {
  '5.7': ['Endlos-Papier (Neue Notiz → Größe „Endlos“): wächst beim Schreiben am Rand in jede Richtung; im PDF wird der beschriebene Bereich gespeichert, höchstens A0', 'Beim ersten Öffnen einer PDF gibt es einen Hinweis auf die Notizfläche (Menü ⋮)'],
  '5.6': ['Bemaßung: Stift über eine Linie oder Kante schweben lassen – sie leuchtet auf, Antippen bemaßt sie direkt; Ecken werden als Fangpunkt angezeigt', 'Neue Notizen in den Formaten A0 bis A5 (hoch oder quer)', 'PDF mit Notizfläche: Menü ⋮ → „Notizfläche neben PDF-Seiten“ setzt rechts neben jede PDF-Seite eine karierte Fläche für Notizen'],
  '5.5': ['Speichern in die Nextcloud zuverlässiger: Dateien aus „Öffnen mit“ werden erkannt und einmal über die Nextcloud-Dateiauswahl verknüpft, damit Änderungen wirklich hochgeladen werden', 'Beim Überschreiben bleibt kein Rest einer älteren, längeren Datei mehr hängen', 'Nach dem Speichern Hinweis, dass die Nextcloud-App den Upload übernimmt'],
  '5.4': ['Bilder zuschneiden: Bild markieren → „Zuschneiden“, Rahmen an Ecken und Seiten ziehen'],
  '5.3': ['Dämmung jetzt in zwei Varianten: „Dämmung weich“ (Bögen mit sich kreuzenden Schrägen) und „Dämmung hart“ (Zickzack)', 'Stahlbeton: Schraffur unter 45°, abwechselnd durchgezogen und gestrichelt'],
  '5.2': ['Neue Schraffuren für Formen (Bauwesen): Holz mit Faser, Hirnholz, Stahl, Stahlbeton (45°, abwechselnd durchgezogen und gestrichelt), Erdreich, Dämmung weich und Dämmung hart – Knopf neben „Füllung“; bereits gezeichnete Formen über das Stil-Menü schraffieren', 'Schraffuren bleiben im PDF scharfe Linien'],
  '5.1': ['„Einfügen“ erscheint auch mit dem Lasso nicht mehr beim einfachen Antippen – überall nur nach 2 Sekunden ruhigem Halten'],
  '5.0': ['„Einfügen“ erscheint erst nach 3 Sekunden Halten – mit dem Finger und mit dem Stift (nicht mehr aus Versehen)'],
  '4.9': ['Im PDF sind Textfelder, Stempeltexte und Tabellen jetzt echte Schrift statt Bild – am PC beim Heranzoomen gestochen scharf (Schreibschrift bleibt Bild)'],
  '4.8': ['Im PDF ist die Maßzahl der Bemaßung jetzt echte Schrift statt Bild – bleibt am PC beim Zoomen scharf'],
  '4.7': ['Menü ⋮ beim Bearbeiten lässt sich scrollen, wenn es nicht auf den Bildschirm passt', 'Antippen mit dem Finger wählt nur noch Bilder aus (Text und Handschrift nicht mehr)', '„Einfügen“ mit dem Finger: leichtes Zittern bricht das Halten nicht mehr ab'],
  '4.6': ['Mit dem Finger auf ein Objekt, einen Text, ein Bild oder einen Stempel tippen wählt es aus – auch wenn „Mit dem Finger zeichnen“ aus ist. Danach mit dem Finger verschieben, an den Griffen skalieren oder drehen'],
  '4.5': ['Bemaßung wie im CAD: von Punkt zu Punkt messen, dann mit einem zweiten Zug die Maßlinie parallel herausziehen (Maßhilfslinien wachsen mit); Punkte rasten an Ecken und Linienenden ein', 'Bilder, Texte und Stempel lassen sich viel flüssiger verschieben'],
  '4.4': ['Neue Textfelder starten klein und wachsen beim Schreiben mit – danach passt die Breite genau zum Text', 'Verschieben von Texten und Textbausteinen deutlich flüssiger'],
  '4.3': ['Bemaßung neben dem Lineal: Maßlinie mit Maßzahl, Maßstab (1:1 bis 1:500 oder eigener), Einheit und Nachkommastellen einstellbar; Maßzahl lässt sich überschreiben', 'Statik: Durchlaufträger und andere Balkensysteme ohne Gelenkkreis im Balken über den Lagern'],
  '4.2': ['Tabellen wie in LibreOffice: Zeilen, Spalten und Kopfzeile wählen, Zellen ausfüllen, später über „Tabelle bearbeiten“ ändern (▦ Tabelle beim Text-Werkzeug oder im Menü ⋮)', 'Mathe: Matrizen beliebiger Größe (bis 8×8) mit runden, eckigen, Betrags- oder geschweiften Klammern'],
  '4.1': ['Smarte Hilfslinien: Beim Verschieben und Skalieren rasten Objekte an Kanten und Mitten anderer Objekte und an der Seitenmitte ein (im Menü ⋮ abschaltbar)', 'Ausrichten: markierte Objekte links, mittig, rechts, oben, unten ausrichten oder gleichmäßig verteilen'],
  '4.0': ['Add-on Flussdiagramm: 27 Symbole wie in yEd (Prozess, Entscheidung, Start/Ende, Daten, Dokument, Datenbank …)'],
  '3.9': ['Kurzanleitung mit allen Funktionen (⚙ → Kurzanleitung)', 'Nach einem Update werden die Neuigkeiten angeboten – nur wenn du möchtest'],
  '3.8': ['Add-on Mathematik: 2D- und 3D-Koordinatensysteme, Polarkoordinaten'],
  '3.7': ['Add-on Stahlbauprofile: IPE, HEA, HEB, U, L, T, Z, Rohre, Rund- und Flachstahl'],
  '3.6': ['Statik: Lasten (Einzellast, Strecken-, Dreiecks-, Trapezlast, Momente)', 'Einstellungen → Add-ons: Pakete ein- und ausschalten'],
  '3.5': ['Statik-Stempel: Auflager und statische Systeme'],
  '3.4': ['Ordner beliebig tief verschachteln, Pfadzeile oben', 'Notizen in Ordner verschieben oder kopieren'],
  '3.3': ['Text in gespeicherten PDFs ist nicht mehr blass'],
  '3.2': ['Schriftarten für Text', 'Größe und Schrift von markiertem Text genau einstellen'],
  '3.1': ['Stift-Menü mit Farbband', 'Pfeilspitzen in 3 Formen und 3 Größen', 'Lasso markiert nur vollständig umfahrene Objekte', 'Text ab Größe 4, „Text bearbeiten“ in der Auswahl'],
  '3.0': ['Griffe an allen Ecken und Seiten, Linien an beiden Enden ziehen']
};
const verCmp = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
function newsSince(from, to) { return Object.keys(CHANGELOG).filter(v => (!from || verCmp(v, from) > 0) && verCmp(v, to) <= 0).sort((a, b) => verCmp(b, a)); }
function showNews(vers, title) {
  $('#newsTitle').textContent = title;
  $('#newsBody').innerHTML = vers.map(v => `<h3>Version ${v}</h3><ul>${CHANGELOG[v].map(x => `<li>${x}</li>`).join('')}</ul>`).join('');
  $('#newsDlg').showModal();
}
$('#newsDlg').addEventListener('click', e => { if (e.target.closest('[data-n]')) $('#newsDlg').close(); });
async function offerNews() {
  if (!NATIVE) return;
  const cur = window.NATIVE_APP.version, last = prefs.seenVersion;
  if (last === cur) return;
  prefs.seenVersion = cur; savePrefs();
  // erster Start nach Einführung dieser Funktion: wer schon Notizen hat, hat gerade aktualisiert
  const from = last || ((await dbAll('notes')).length ? '3.8' : null);
  if (!from) return;
  const vers = newsSince(from, cur); if (!vers.length) return;
  $('#newsAskMsg').textContent = `Die App ist jetzt auf Version ${cur}. Möchtest du kurz sehen, was neu ist?`;
  if (await dialogChoice($('#newsAskDlg'), 'na') === 'yes') showNews(vers, `Neu seit Version ${from}`);
}
setTimeout(offerNews, 1200);

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
