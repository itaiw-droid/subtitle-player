// Subtitle scanner (runs in a Web Worker).
// Receives the bottom strip of sampled video frames, detects when burned-in subtitle text
// appears / changes / disappears, and for every subtitle produces:
//   • a colour crop (shown in the subtitle list)
//   • a clean black-on-white image of just the lettering (for OCR), built from the per-pixel
//     minimum over all frames of that subtitle — the letters stay white, a moving background doesn't.
'use strict';

const RX0 = 0.06, RX1 = 0.94, RY0 = 0.58, RY1 = 0.985;
const MIN_PIXELS = 60;
// How alike two frames' lettering must be to count as the same subtitle. Strict on purpose: splitting
// one subtitle in two is harmless (identical neighbours are re-joined after OCR), merging two
// different subtitles makes the English lag behind the Hebrew.
const SIM = 0.72;

let W = 0, H = 0, rx0 = 0, ry0 = 0, rw = 0, rh = 0, step = 2, interval = 1 / 6;
let current = null;   // subtitle currently on screen
let pending = null;   // a change seen once, waiting for confirmation {t, mask}
let lastProgress = -1;
let lastT = null;      // time of the previous sample
// A change happened somewhere between the last sample that still showed the old picture and the
// first that showed the new one: use the midpoint (halves the timing error).
const boundary = (p) => (p.prev != null && p.t - p.prev < 0.5 ? (p.prev + p.t) / 2 : p.t);
let rangeStart = 0;
let gen = 0;
// Every message carries the scan session id so the page can ignore leftovers from a stopped scan.
const post = (o) => postMessage({ ...o, gen });

function region(w, h) {
  return { x0: Math.floor(w * RX0), y0: Math.floor(h * RY0), w: Math.floor(w * RX1) - Math.floor(w * RX0), h: Math.floor(h * RY1) - Math.floor(h * RY0) };
}

// ---------------------------------------------------------------- mask
// Bright, unsaturated pixels right next to a much darker pixel (the subtitle outline/shadow).
function buildMask(d) {
  const gw = Math.floor(rw / step), gh = Math.floor(rh / step);
  const n = gw * gh;
  const luma = new Int16Array(n), white = new Uint8Array(n);
  for (let gy = 0; gy < gh; gy++) {
    const row = gy * step * rw;
    for (let gx = 0; gx < gw; gx++) {
      const p = (row + gx * step) * 4;
      const r = d[p], g = d[p + 1], b = d[p + 2];
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      const i = gy * gw + gx;
      luma[i] = (r * 77 + g * 150 + b * 29) >> 8;
      if (mn >= 170 && mx - mn <= 48) white[i] = 1;
    }
  }
  const bits = new Uint8Array(n);
  let count = 0;
  const reach = Math.max(1, Math.floor(4 / step));
  for (let gy = reach; gy < gh - reach; gy++) {
    for (let gx = reach; gx < gw - reach; gx++) {
      const i = gy * gw + gx;
      if (!white[i]) continue;
      const l = luma[i] - 95;
      for (let k = 1; k <= reach; k++) {
        if (luma[i - k] < l || luma[i + k] < l || luma[i - k * gw] < l || luma[i + k * gw] < l) { bits[i] = 1; count++; break; }
      }
    }
  }
  return { w: gw, h: gh, bits, count };
}

// Keep only lettering: rows crossed by many thin strokes, grouped into text-line bands,
// limited horizontally to where strokes cluster; plus lines stacked right next to the main one.
function cleanMask(m) {
  const out = { w: m.w, h: m.h, bits: new Uint8Array(m.bits.length), count: 0, minX: m.w, minY: m.h, maxX: -1, maxY: -1 };
  if (!m.count) return out;
  const maxRun = Math.max(2, Math.floor(14 / step));
  const strokes = [];
  for (let y = 0; y < m.h; y++) {
    const row = y * m.w, list = [];
    let x = 0;
    while (x < m.w) {
      if (!m.bits[row + x]) { x++; continue; }
      let e = x;
      while (e < m.w && m.bits[row + e]) e++;
      if (e - x <= maxRun) list.push((x + e) >> 1);
      x = e;
    }
    strokes.push(list);
  }
  const minStrokes = 7;
  const bands = [];
  let y = 0;
  while (y < m.h) {
    if (strokes[y].length < minStrokes) { y++; continue; }
    let e = y, gap = 0;
    while (e + 1 < m.h) {
      if (strokes[e + 1].length >= minStrokes) { e++; gap = 0; }
      else if (gap < 1 && e + 2 < m.h && strokes[e + 2].length >= minStrokes) { e += 2; gap++; }
      else break;
    }
    const hPx = (e - y + 1) * step;
    if (hPx >= H / 80 && hPx <= H / 9) bands.push([y, e]);
    y = e + 1;
  }
  if (!bands.length) return out;
  const gapMax = Math.max(6, Math.floor(m.w / 16));
  const lines = [];
  for (const [b0, b1] of bands) {
    const xs = [];
    for (let yy = b0; yy <= b1; yy++) for (const v of strokes[yy]) xs.push(v);
    xs.sort((a, b) => a - b);
    let bestS = 0, bestE = 0, bestN = 0, s = 0;
    for (let i = 1; i <= xs.length; i++) {
      if (i === xs.length || xs[i] - xs[i - 1] > gapMax) {
        if (i - s > bestN) { bestN = i - s; bestS = xs[s]; bestE = xs[i - 1]; }
        s = i;
      }
    }
    const rows = b1 - b0 + 1;
    if (bestE - bestS < m.w / 14 || bestN < rows * 6) continue;
    lines.push({ y0: b0, y1: b1, xs: bestS, xe: bestE, n: bestN });
  }
  if (!lines.length) return out;
  const main = lines.reduce((a, b) => (b.n > a.n ? b : a));
  const lineH = main.y1 - main.y0 + 1;
  const group = [main];
  let top = main.y0, bottom = main.y1, added = true;
  while (added) {
    added = false;
    for (const l of lines) {
      if (group.includes(l)) continue;
      const gapAbove = top - l.y1, gapBelow = l.y0 - bottom;
      const near = (gapAbove >= 0 && gapAbove <= lineH * 2) || (gapBelow >= 0 && gapBelow <= lineH * 2);
      const overlapX = Math.min(l.xe, main.xe) - Math.max(l.xs, main.xs) > 0;
      if (near && overlapX && l.n * 5 >= main.n) { group.push(l); top = Math.min(top, l.y0); bottom = Math.max(bottom, l.y1); added = true; }
    }
  }
  for (const l of group) {
    for (let yy = l.y0; yy <= l.y1; yy++) {
      for (let xx = Math.max(0, l.xs - 3); xx <= Math.min(m.w - 1, l.xe + 3); xx++) {
        const i = yy * m.w + xx;
        if (!m.bits[i]) continue;
        out.bits[i] = 1; out.count++;
        if (xx < out.minX) out.minX = xx; if (xx > out.maxX) out.maxX = xx;
        if (yy < out.minY) out.minY = yy; if (yy > out.maxY) out.maxY = yy;
      }
    }
  }
  return out;
}

function coverage(a, b) {
  if (!a.count) return b.count ? 0 : 1;
  let hit = 0;
  const w = a.w, h = a.h;
  for (let y = Math.max(a.minY, 1); y <= Math.min(a.maxY, h - 2); y++) {
    for (let x = Math.max(a.minX, 1); x <= Math.min(a.maxX, w - 2); x++) {
      const i = y * w + x;
      if (!a.bits[i]) continue;
      if (b.bits[i] || b.bits[i - 1] || b.bits[i + 1] || b.bits[i - w] || b.bits[i + w]) hit++;
    }
  }
  return hit / a.count;
}
const similar = (a, b) => Math.min(coverage(a, b), coverage(b, a));

// ---------------------------------------------------------------- per-subtitle images
function whiteness(d) {
  const out = new Uint8Array(rw * rh);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const r = d[p], g = d[p + 1], b = d[p + 2];
    out[i] = r < g ? (r < b ? r : b) : (g < b ? g : b);
  }
  return out;
}

function maskBox(mask) {
  // Box of the lettering in region pixels, and normalised to the full frame.
  const bx = mask.minX * step, by = mask.minY * step;
  const bw = (mask.maxX - mask.minX + 1) * step, bh = (mask.maxY - mask.minY + 1) * step;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return { bx, by, bw, bh, bbox: [r3((rx0 + bx) / W), r3((ry0 + by) / H), r3(bw / W), r3(bh / H)] };
}

function colorCrop(d, box) {
  const padX = Math.max(12, box.bh * 0.25), padY = Math.max(8, box.bh * 0.2);
  const cx = Math.max(0, Math.floor(box.bx - padX)), cy = Math.max(0, Math.floor(box.by - padY));
  const cw = Math.min(rw - cx, Math.floor(box.bw + padX * 2)), ch = Math.min(rh - cy, Math.floor(box.bh + padY * 2));
  if (cw < 4 || ch < 4) return null;
  const img = new ImageData(cw, ch);
  for (let y = 0; y < ch; y++) img.data.set(d.subarray(((cy + y) * rw + cx) * 4, ((cy + y) * rw + cx + cw) * 4), y * cw * 4);
  return img;
}

function ocrFromMin(minW, box) {
  const padX = Math.max(14, Math.floor(box.bh / 3)), padY = Math.max(14, Math.floor(box.bh * 0.6));
  const cx = Math.max(0, box.bx - padX), cy = Math.max(0, box.by - padY);
  const cw = Math.min(rw - cx, box.bw + padX * 2), ch = Math.min(rh - cy, box.bh + padY * 2);
  if (cw < 8 || ch < 8) return null;
  const on = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (minW[(cy + y) * rw + cx + x] >= 150) on[y * cw + x] = 1;
  // Connected components: keep letter-sized blobs.
  const maxLetterH = Math.max(12, Math.floor(H * 0.065)), maxLetterW = maxLetterH * 5;
  const label = new Int32Array(cw * ch), keep = new Uint8Array(cw * ch);
  let next = 1;
  const stack = [], members = [];
  for (let s = 0; s < cw * ch; s++) {
    if (!on[s] || label[s]) continue;
    stack.length = 0; members.length = 0;
    stack.push(s); label[s] = next;
    let mnx = cw, mxx = 0, mny = ch, mxy = 0, edge = false;
    while (stack.length) {
      const i = stack.pop();
      members.push(i);
      const x = i % cw, y = (i / cw) | 0;
      if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y;
      if (x === 0 || y === 0 || x === cw - 1 || y === ch - 1) edge = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
        const j = ny * cw + nx;
        if (on[j] && !label[j]) { label[j] = next; stack.push(j); }
      }
    }
    next++;
    const h = mxy - mny + 1, w = mxx - mnx + 1;
    if (members.length >= 3 && h <= maxLetterH && w <= maxLetterW && !(edge && h > maxLetterH * 0.75)) for (const i of members) keep[i] = 1;
  }
  return renderLines(keep, cw, ch);
}

// Re-lay the lettering line by line, widen word gaps (subtitle fonts space words tightly),
// drop hanging punctuation, and add a throw-away dash "word" at the end of each line because
// Tesseract's Hebrew model otherwise glues the last two words together. The dash is stripped after OCR.
function renderLines(keep, cw, ch) {
  const rowInk = new Int32Array(ch);
  for (let y = 0; y < ch; y++) { let n = 0; for (let x = 0; x < cw; x++) if (keep[y * cw + x]) n++; rowInk[y] = n; }
  let bands = [];
  let y = 0;
  while (y < ch) {
    if (!rowInk[y]) { y++; continue; }
    let e = y;
    while (e + 1 < ch && (rowInk[e + 1] > 0 || (e + 2 < ch && rowInk[e + 2] > 0))) e++;
    bands.push([y, e]); y = e + 1;
  }
  const tallest = Math.max(0, ...bands.map(([a, b]) => b - a + 1));
  bands = bands.filter(([a, b]) => (b - a + 1) * 3 >= tallest);
  if (!bands.length) return null;
  const lines = [];
  for (const [b0, b1] of bands) {
    const lh = b1 - b0 + 1;
    const colInk = new Uint8Array(cw);
    for (let x = 0; x < cw; x++) for (let yy = b0; yy <= b1; yy++) if (keep[yy * cw + x]) { colInk[x] = 1; break; }
    let first = colInk.indexOf(1), last = colInk.lastIndexOf(1);
    if (first < 0) continue;
    const glyphH = (x0, x1) => {
      let t = Infinity, bo = -1;
      for (let x = x0; x <= x1; x++) for (let yy = b0; yy <= b1; yy++) if (keep[yy * cw + x]) { if (yy < t) t = yy; if (yy > bo) bo = yy; }
      return bo >= 0 ? bo - t + 1 : 0;
    };
    for (let k = 0; k < 2; k++) {
      let e = first;
      while (e <= last && colInk[e]) e++;
      if (e <= last && glyphH(first, e - 1) * 100 < lh * 45) { for (let x = first; x < e; x++) colInk[x] = 0; first = colInk.indexOf(1); }
      let s0 = last;
      while (s0 >= first && colInk[s0]) s0--;
      if (s0 >= first && glyphH(s0 + 1, last) * 100 < lh * 45) { for (let x = s0 + 1; x <= last; x++) colInk[x] = 0; last = colInk.lastIndexOf(1); }
    }
    // Word gaps vs letter gaps (1-D Otsu).
    const gaps = [];
    for (let x = first; x <= last;) {
      if (colInk[x]) { x++; continue; }
      let e = x;
      while (e <= last && !colInk[e]) e++;
      gaps.push(e - x); x = e;
    }
    const sg = gaps.slice().sort((a, b) => a - b);
    let wordGap = Infinity, bestScore = -1;
    for (let k = 1; k < sg.length; k++) {
      const a = sg.slice(0, k), b = sg.slice(k);
      const ma = a.reduce((n, v) => n + v, 0) / a.length, mb = b.reduce((n, v) => n + v, 0) / b.length;
      const score = a.length * b.length * (mb - ma) * (mb - ma);
      if (score > bestScore && mb >= Math.max(ma * 1.7, ma + 2.5)) { bestScore = score; wordGap = sg[k]; }
    }
    if (wordGap === Infinity && sg.length && sg[sg.length - 1] >= lh * 0.3) wordGap = sg[sg.length - 1];
    const cols = [];
    for (let i = 0; i < Math.max(6, Math.floor(lh * 0.7)); i++) cols.push(-2);      // the dash
    for (let i = 0; i < Math.max(lh, 10); i++) cols.push(-1);
    for (let x = first; x <= last;) {
      if (colInk[x]) { cols.push(x); x++; continue; }
      let e = x;
      while (e <= last && !colInk[e]) e++;
      const gap = e - x;
      if (gap >= wordGap) for (let i = 0; i < Math.max(gap * 2, Math.floor(lh * 0.7)); i++) cols.push(-1);
      else for (let i = x; i < e; i++) cols.push(i);
      x = e;
    }
    lines.push({ y0: b0, y1: b1, cols });
  }
  if (!lines.length) return null;
  const scale = 2, pad = 24;
  const maxW = Math.max(...lines.map((l) => l.cols.length));
  const spacing = Math.max(8, tallest >> 1);
  const totalH = lines.reduce((n, l) => n + (l.y1 - l.y0 + 1), 0) + spacing * (lines.length - 1);
  const ow = maxW * scale + pad * 2, oh = totalH * scale + pad * 2;
  const img = new ImageData(ow, oh);
  img.data.fill(255);
  const dot = (px, py) => { const p = (py * ow + px) * 4; img.data[p] = img.data[p + 1] = img.data[p + 2] = 0; };
  let oy = 0;
  for (const l of lines) {
    const lh = l.y1 - l.y0 + 1;
    const offX = (maxW - l.cols.length) >> 1;
    const t = Math.max(1, Math.floor(lh / 12));
    l.cols.forEach((sx, ox) => {
      if (sx === -2) {
        for (let yy = (lh >> 1) - t; yy < (lh >> 1) + t; yy++) for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) dot(pad + (offX + ox) * scale + dx, pad + (oy + yy) * scale + dy);
      } else if (sx >= 0) {
        for (let yy = l.y0; yy <= l.y1; yy++) if (keep[yy * cw + sx]) {
          for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) dot(pad + (offX + ox) * scale + dx, pad + (oy + yy - l.y0) * scale + dy);
        }
      }
    });
    oy += lh + spacing;
  }
  return img;
}

async function toBlob(img, type, quality) {
  const c = new OffscreenCanvas(img.width, img.height);
  c.getContext('2d').putImageData(img, 0, 0);
  return c.convertToBlob({ type, quality });
}

async function finish(c, endT, partial) {
  if (c.samples < 2 || endT - c.start < 0.3 || !c.crop) return;
  const ocr = ocrFromMin(c.minW, c.box);
  if (!ocr) return;
  const [img, ocrBlob] = await Promise.all([toBlob(c.crop, 'image/jpeg', 0.85), toBlob(ocr, 'image/png')]);
  const r3 = (v) => Math.round(v * 1000) / 1000;
  post({ type: 'cue', start: r3(c.start), end: r3(endT), bbox: c.box.bbox, img, ocr: ocrBlob, partial });
}

// ---------------------------------------------------------------- frames
function onFrame(t, d) {
  const mask = cleanMask(buildMask(d));
  const hasText = mask.count >= MIN_PIXELS;
  const newCandidate = (start) => {
    const box = maskBox(mask);
    return { start, lastT: t, mask, bestCount: mask.count, box, crop: colorCrop(d, box), samples: 2, minW: whiteness(d) };
  };
  if (current) {
    const c = current;
    if (hasText && similar(c.mask, mask) >= SIM) {
      pending = null;
      c.lastT = t; c.samples++;
      const wn = whiteness(d);
      const mw = c.minW;
      for (let i = 0; i < wn.length; i++) if (wn[i] < mw[i]) mw[i] = wn[i];
      // Only a clearly fuller frame of the *same* lettering (fade-in) becomes the reference.
      if (mask.count > c.bestCount + (c.bestCount >> 3) && similar(c.mask, mask) >= 0.85) {
        c.box = maskBox(mask); c.crop = colorCrop(d, c.box); c.bestCount = mask.count; c.mask = mask;
      }
    } else if (pending && (hasText ? pending.mask.count > 0 && similar(pending.mask, mask) >= SIM : pending.mask.count < MIN_PIXELS)) {
      const at = boundary(pending);
      finish(c, at, false);
      current = hasText ? newCandidate(at) : null;
      pending = null;
    } else {
      pending = { t, prev: lastT, mask: hasText ? mask : { count: 0 } };
    }
  } else if (hasText) {
    if (pending && pending.mask.count > 0 && similar(pending.mask, mask) >= SIM) { current = newCandidate(boundary(pending)); pending = null; }
    else pending = { t, prev: lastT, mask };
  } else pending = null;

  lastT = t;
  if (t - lastProgress >= 1) {
    lastProgress = t;
    post({ type: 'progress', t, safe: current ? current.start : pending ? pending.t : t });
  }
}

onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'start') {
    gen = m.gen; W = m.W; H = m.H; interval = m.interval || 1 / 6;
    const r = region(W, H);
    rx0 = r.x0; ry0 = r.y0; rw = r.w; rh = r.h;
    step = Math.max(1, Math.floor(W / 640));
    current = null; pending = null; lastProgress = -1; lastT = null; rangeStart = m.from;
    post({ type: 'region', x0: rx0, y0: ry0, w: rw, h: rh });
  } else if (m.type === 'frame') {
    onFrame(m.t, new Uint8ClampedArray(m.data));
    post({ type: 'ack' });
  } else if (m.type === 'end') {
    // Range finished (or stopped): emit what's on screen as a partial subtitle.
    if (current && m.flush) await finish(current, Math.min(current.lastT + interval, m.t), true);
    current = null; pending = null;
    post({ type: 'ended', t: m.t });
  }
};
