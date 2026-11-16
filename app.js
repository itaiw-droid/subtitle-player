// Subtitle Player — runs entirely in the browser (Chrome).
// Video: played from the user's own disk (object URL). Nothing is uploaded.
// Scanning: a hidden copy of the video plays fast-forward; scan-worker.js finds subtitles.
// OCR: Tesseract (bundled with this site). Translation: Chrome's on-device Translator API.
// Storage: IndexedDB in this browser (episodes, subtitles, crops, file handles).
'use strict';

const $ = (s) => document.querySelector(s);
const fmt = (t) => {
  if (!Number.isFinite(t)) t = 0;
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uid = () => Math.random().toString(16).slice(2, 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let toastTimer;
function toast(msg, ms = 3500) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms); }

const LOW_CONFIDENCE = 0.72;
const SCAN_RATE = 6;          // hidden scanner plays at 6x
const SAMPLE_INTERVAL = 1 / 6;

// =====================================================================
// IndexedDB
// =====================================================================
const DB = {
  db: null,
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('subtitle-player', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of ['episodes', 'cues', 'blobs', 'handles']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
      };
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = this.db.transaction(store, mode);
      const r = fn(t.objectStore(store));
      t.oncomplete = () => resolve(r && r.result);
      t.onerror = () => reject(t.error);
    });
  },
  get(store, key) { return this.tx(store, 'readonly', (s) => s.get(key)); },
  put(store, key, val) { return this.tx(store, 'readwrite', (s) => s.put(val, key)); },
  del(store, key) { return this.tx(store, 'readwrite', (s) => s.delete(key)); },
  delRange(store, prefix) { return this.tx(store, 'readwrite', (s) => s.delete(IDBKeyRange.bound(prefix, prefix + '￿'))); },
  all(store) {
    return new Promise((resolve, reject) => {
      const out = [];
      const req = this.db.transaction(store).objectStore(store).openCursor();
      req.onsuccess = () => { const c = req.result; if (c) { out.push([c.key, c.value]); c.continue(); } else resolve(out); };
      req.onerror = () => reject(req.error);
    });
  },
};

// =====================================================================
// State
// =====================================================================
const episodes = new Map();  // id -> episode
const cuesById = new Map();  // id -> cue[]
const files = new Map();     // id -> File (available this session)
const handles = new Map();   // id -> FileSystemFileHandle (remembered across visits)
const urls = new Map();      // id -> object URL of the video file
let watch = { id: null, t: 0, at: 0 }; // what the viewer is watching

const saveTimers = new Map();
function saveEp(ep) { clearTimeout(saveTimers.get('e' + ep.id)); saveTimers.set('e' + ep.id, setTimeout(() => DB.put('episodes', ep.id, ep), 300)); }
function saveCues(id) {
  clearTimeout(saveTimers.get('c' + id));
  saveTimers.set('c' + id, setTimeout(() => {
    if (!episodes.has(id)) return;
    DB.put('cues', id, (cuesById.get(id) || []).map(({ ocrBlob, _touched, ...c }) => c));
  }, 600));
}

function videoUrl(id) {
  if (!urls.has(id) && files.has(id)) urls.set(id, URL.createObjectURL(files.get(id)));
  return urls.get(id);
}
function releaseVideo(id) {
  const u = urls.get(id);
  if (u) { URL.revokeObjectURL(u); urls.delete(id); }
}

// Intervals [[a,b],...] merged & sorted
function addInterval(list, a, b) {
  if (!(b > a)) return list;
  const all = [...list, [a, b]].sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [s, e] of all) {
    if (out.length && s <= out[out.length - 1][1] + 0.05) out[out.length - 1][1] = Math.max(out[out.length - 1][1], e);
    else out.push([s, e]);
  }
  return out;
}
const coveredLength = (l) => l.reduce((n, [a, b]) => n + (b - a), 0);
function firstUncovered(list, from, duration) {
  let t = from;
  for (const [a, b] of list) if (t >= a && t < b) t = b;
  return t < duration - 0.25 ? t : null;
}
function nextCoveredStart(list, from, duration) { for (const [a] of list) if (a > from + 0.01) return a; return duration; }

const HEB = /[א-ת]/g;
const normHeb = (s) => String(s || '').replace(/[^א-ת0-9]/g, '');
const isLow = (c) => !c.edited && c.hebrew != null && (c.confidence ?? 1) < LOW_CONFIDENCE;

function progressOf(ep) {
  const cues = cuesById.get(ep.id) || [];
  const scanned = ep.duration ? Math.min(1, coveredLength(ep.coverage) / ep.duration) : 0;
  const total = cues.length;
  const done = cues.filter((c) => c.status === 'done').length;
  const read = cues.filter((c) => c.hebrew != null).length;
  const translated = total ? done / total : (scanned >= 1 ? 1 : 0);
  return { scanned, total, done, read, pending: total - done,
    overall: Math.round((scanned * 0.3 + scanned * (total ? read / total : 1) * 0.2 + scanned * translated * 0.5) * 100) };
}

function updateStatus(ep) {
  const prog = progressOf(ep);
  const complete = firstUncovered(ep.coverage, 0, ep.duration) == null && prog.pending === 0 && !(Scan.ep && Scan.ep.id === ep.id);
  const status = ep.status === 'paused' ? 'paused' : complete ? 'ready' : 'processing';
  if (status !== ep.status) { ep.status = status; saveEp(ep); }
}

// UI hooks (filled in below)
let libDirty = false;
function changed(ep, upsert = [], removed = []) {
  updateStatus(ep);
  libDirty = true;
  if (P.id === ep.id) onPlayerCues(upsert, removed);
}
setInterval(() => { if (libDirty && !$('#library').classList.contains('hidden')) { libDirty = false; renderLibrary(); } }, 700);

// =====================================================================
// Files (File System Access API: remembered between visits in Chrome)
// =====================================================================
const VIDEO_TYPES = [{ description: 'Videos', accept: { 'video/*': ['.mp4', '.m4v', '.mov', '.webm', '.mkv'] } }];

async function pickVideo() {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await showOpenFilePicker({ types: VIDEO_TYPES, excludeAcceptAllOption: false, id: 'videos' });
      return { handle, file: await handle.getFile() };
    } catch (e) { if (e.name === 'AbortError') return null; }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'video/*';
    input.onchange = () => resolve(input.files[0] ? { file: input.files[0] } : null);
    input.click();
  });
}

// Try to get the episode's file without asking: this session, or a remembered handle with permission.
async function fileFor(ep, askPermission) {
  if (files.has(ep.id)) return files.get(ep.id);
  const h = handles.get(ep.id);
  if (!h) return null;
  try {
    let perm = await h.queryPermission({ mode: 'read' });
    if (perm !== 'granted' && askPermission) perm = await h.requestPermission({ mode: 'read' });
    if (perm !== 'granted') return null;
    const f = await h.getFile();
    if (f.size !== ep.size) return null;
    files.set(ep.id, f);
    return f;
  } catch { return null; }
}

function probe(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto';
    const url = URL.createObjectURL(file);
    const done = (r) => { v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); resolve(r); };
    v.onloadedmetadata = () => {
      if (!v.videoWidth) return done({ error: 'This file has no video picture Chrome can show.' });
      const info = { duration: v.duration, width: v.videoWidth, height: v.videoHeight };
      // Poster frame for the library.
      v.currentTime = Math.min(v.duration * 0.12, 300);
      v.onseeked = () => {
        const c = document.createElement('canvas');
        const s = Math.min(1, 640 / v.videoWidth);
        c.width = Math.round(v.videoWidth * s); c.height = Math.round(v.videoHeight * s);
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        c.toBlob((b) => done({ ...info, thumb: b }), 'image/jpeg', 0.8);
      };
    };
    v.onerror = () => done({ error: 'Chrome can\'t play this video format. MP4 (H.264/HEVC), MOV, M4V and WebM work best.' });
    v.src = url;
  });
}

// =====================================================================
// Episodes
// =====================================================================
async function createEpisode(chosenFile, handle, show, mode) {
  const f = chosenFile;
  const existing = [...episodes.values()].find((e) => e.fileName === f.name && e.size === f.size);
  if (existing) {
    files.set(existing.id, f);
    if (handle) { handles.set(existing.id, handle); DB.put('handles', existing.id, handle); }
    existing.mode = mode; if (existing.status === 'paused') existing.status = 'processing';
    saveEp(existing); changed(existing); tick();
    return existing;
  }
  const info = await probe(f);
  if (info.error) throw new Error(info.error);
  const ep = {
    id: uid(), fileName: f.name, size: f.size, lastModified: f.lastModified,
    title: show.trim() || f.name.replace(/\.[^.]+$/, ''), show: show.trim(),
    duration: info.duration, width: info.width, height: info.height,
    mode, status: 'processing', coverage: [], lastPosition: 0, createdAt: Date.now(),
  };
  episodes.set(ep.id, ep); cuesById.set(ep.id, []); files.set(ep.id, f);
  await DB.put('episodes', ep.id, ep);
  await DB.put('cues', ep.id, []);
  if (info.thumb) await DB.put('blobs', ep.id + '/thumb', info.thumb);
  if (handle) { handles.set(ep.id, handle); await DB.put('handles', ep.id, handle); }
  libDirty = true;
  tick();
  return ep;
}

async function deleteEpisode(id) {
  if (Scan.ep && Scan.ep.id === id) Scan.stop();
  episodes.delete(id); cuesById.delete(id); files.delete(id); handles.delete(id); releaseVideo(id);
  await DB.del('episodes', id); await DB.del('cues', id); await DB.del('handles', id);
  await DB.delRange('blobs', id + '/');
  libDirty = true;
}

// =====================================================================
// Scanner (hidden fast-forward playback -> scan-worker.js)
// =====================================================================
const Scan = {
  ep: null, worker: null, video: $('#scanvid'), canvas: null, ctx: null, region: null,
  from: 0, to: 0, scanStart: 0, safe: 0, pos: 0, next: 0, busy: false, gen: 0, wgen: 0, ending: false,

  start(ep, from, to) {
    this.stop();
    const gen = ++this.gen;
    this.ep = ep; this.from = from; this.to = to; this.scanStart = from; this.safe = from; this.pos = from;
    this.next = from; this.busy = false; this.ending = false; this.region = null;
    if (!this.worker) {
      this.worker = new Worker('scan-worker.js');
      this.worker.onmessage = (e) => this.onMessage(e.data);
    }
    this.wgen = gen;
    this.worker.postMessage({ type: 'start', W: ep.width, H: ep.height, from, interval: SAMPLE_INTERVAL, gen });
    const v = this.video;
    v.src = videoUrl(ep.id);
    v.muted = true;
    v.currentTime = from;
    v.playbackRate = SCAN_RATE;
    v.onended = () => this.end(true);
    v.onpause = () => { if (this.ep && !this.ending && gen === this.gen) setTimeout(() => this.ep && gen === this.gen && v.play().catch(() => {}), 300); };
    v.play().catch(() => {});
    // Grab frames on a short timer (frame callbacks don't fire for a video nobody sees).
    const poll = () => {
      if (gen !== this.gen) return;
      const t = v.currentTime;
      this.pos = t;
      if (t >= this.to) return this.end(true);
      if (this.region && !this.busy && v.readyState >= 2 && !v.seeking && t + 0.001 >= this.next) {
        this.next = t + SAMPLE_INTERVAL;
        const r = this.region;
        this.ctx.drawImage(v, r.x0, r.y0, r.w, r.h, 0, 0, r.w, r.h);
        const data = this.ctx.getImageData(0, 0, r.w, r.h).data.buffer;
        this.busy = true;
        this.worker.postMessage({ type: 'frame', t, data }, [data]);
      }
      setTimeout(poll, 12);
    };
    setTimeout(poll, 12);
  },

  onMessage(m) {
    if (m.gen !== this.wgen) return; // from a scan that was stopped
    const ep = this.ep;
    if (m.type === 'region') {
      this.region = m;
      this.canvas = new OffscreenCanvas(m.w, m.h);
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    } else if (m.type === 'ack') this.busy = false;
    else if (m.type === 'progress' && ep) {
      this.safe = m.safe;
      ep.coverage = addInterval(ep.coverage, this.scanStart, m.safe);
      saveEp(ep); changed(ep);
    } else if (m.type === 'cue' && ep) addCue(ep, m);
    else if (m.type === 'ended' && ep && this.ending) {
      ep.coverage = addInterval(ep.coverage, this.scanStart, this.fullRange ? m.t : this.safe);
      saveEp(ep);
      this.ep = null;
      changed(ep);
      setTimeout(tick, 50);
    }
  },

  end(full) {
    if (!this.ep || this.ending) return;
    this.ending = true; this.fullRange = full;
    this.gen++;
    this.video.pause();
    this.worker.postMessage({ type: 'end', t: full ? this.to : this.pos, flush: full });
  },

  stop() {
    if (!this.ep) return;
    const ep = this.ep;
    this.end(false);
    ep.coverage = addInterval(ep.coverage, this.scanStart, this.safe);
    saveEp(ep);
  },
};

function addCue(ep, m) {
  const cues = cuesById.get(ep.id);
  const dup = cues.find((o) => Math.min(o.end, m.end) - Math.max(o.start, m.start) > 0.6 * Math.min(o.end - o.start, m.end - m.start));
  if (dup) return;
  const cue = { id: uid(), start: m.start, end: m.end, bbox: m.bbox, status: 'pending', ocrBlob: m.ocr };
  cues.push(cue);
  cues.sort((a, b) => a.start - b.start);
  DB.put('blobs', `${ep.id}/${cue.id}`, m.img);
  DB.put('blobs', `${ep.id}/${cue.id}/ocr`, m.ocr);
  saveCues(ep.id);
  changed(ep, [cue]);
  ocrPump();
}

// Decide what to scan next: the episode being watched (from the playhead), else any
// episode still being prepared whose file is available in this session.
function tick() {
  for (const ep of episodes.values()) updateStatus(ep);
  if (Scan.ep) { ocrPump(); return; }
  const candidates = [...episodes.values()].filter((e) => e.status === 'processing' && files.has(e.id));
  candidates.sort((a, b) => (b.id === watch.id) - (a.id === watch.id) || a.createdAt - b.createdAt);
  for (const ep of candidates) {
    const target = ep.id === watch.id ? Math.max(0, watch.t - 1) : 0;
    let from = firstUncovered(ep.coverage, target, ep.duration);
    if (from == null) from = firstUncovered(ep.coverage, 0, ep.duration);
    if (from == null) continue;
    Scan.start(ep, from, nextCoveredStart(ep.coverage, from, ep.duration));
    break;
  }
  ocrPump();
}
setInterval(tick, 1500);

// The viewer jumped somewhere nobody has scanned: move the scanner there.
function onPlayhead(id, t, save) {
  const prev = watch.t;
  watch = { id, t, at: Date.now() };
  const ep = episodes.get(id);
  if (!ep) return;
  if (save) { ep.lastPosition = t; saveEp(ep); }
  const covered = ep.coverage.some(([a, b]) => t >= a && t < b - 2);
  if (!covered && Scan.ep) {
    const other = Scan.ep.id !== id;
    const behind = !other && t < Scan.scanStart - 0.5;
    const farAhead = !other && t > Scan.pos + 20;
    if (other || behind || farAhead) Scan.stop();
  }
  if (Math.abs(prev - t) > 3 || !Scan.ep) tick();
}

// =====================================================================
// OCR (Tesseract, bundled with this site)
// =====================================================================
let ocrWorkerP = null;
function ocrWorker() {
  if (!ocrWorkerP) {
    const base = new URL('vendor/', location.href).href;
    ocrWorkerP = Tesseract.createWorker('heb', 1, {
      workerPath: base + 'tesseract/worker.min.js',
      corePath: base + 'tesseract/core',
      langPath: base + 'lang',
      gzip: true,
    }).then(async (w) => { await w.setParameters({ tessedit_pageseg_mode: '6' }); return w; });
  }
  return ocrWorkerP;
}

async function readHebrew(blob) {
  const w = await ocrWorker();
  const { data } = await w.recognize(blob, {}, { text: true, blocks: true });
  const lines = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    const words = [];
    for (const wd of l.words || []) {
      const t = String(wd.text || '').replace(/[‎‏‪-‮|\\[\]{}<>]/g, '').trim();
      const heb = (t.match(HEB) || []).length;
      if (heb >= 1) words.push({ t, heb, conf: wd.confidence });
      else if (/^[0-9][0-9:.,]*$/.test(t)) words.push({ t, heb: 0, conf: wd.confidence });
    }
    const hw = words.filter((x) => x.heb > 0);
    if (!hw.length) continue;
    const avgLen = hw.reduce((n, x) => n + x.heb, 0) / hw.length;
    const conf = hw.reduce((n, x) => n + x.conf, 0) / hw.length;
    if (avgLen < 2.3 || conf < 50) continue;
    lines.push({ text: words.map((x) => x.t).join(' '), conf });
  }
  if (!lines.length) return null;
  return { text: lines.map((l) => l.text).join('\n'), confidence: Math.min(...lines.map((l) => l.conf)) / 100 };
}

function priority(ep, c) {
  const watching = watch.id === ep.id && Date.now() - watch.at < 15000;
  const p = watching ? watch.t : 0;
  return (watching ? 0 : 1e7) + (c.end >= p - 1 ? c.start - p : 1e6 + (p - c.start));
}

let ocrBusy = false;
async function ocrPump() {
  if (ocrBusy) return;
  ocrBusy = true;
  try {
    for (;;) {
      let best = null;
      for (const ep of episodes.values()) {
        if (ep.status === 'paused') continue;
        for (const c of cuesById.get(ep.id) || []) {
          if (c.status !== 'pending') continue;
          const pr = priority(ep, c);
          if (!best || pr < best.pr) best = { ep, c, pr };
        }
      }
      if (!best) break;
      const { ep, c } = best;
      c.status = 'ocr';
      let res = null;
      try {
        const blob = c.ocrBlob || await DB.get('blobs', `${ep.id}/${c.id}/ocr`);
        if (blob) res = await readHebrew(blob);
      } catch (e) { console.warn('OCR failed', e); }
      const cues = cuesById.get(ep.id);
      if (!cues || !cues.includes(c)) continue;
      delete c.ocrBlob;
      if (!res) {
        cues.splice(cues.indexOf(c), 1);
        DB.del('blobs', `${ep.id}/${c.id}`); DB.del('blobs', `${ep.id}/${c.id}/ocr`);
        saveCues(ep.id); changed(ep, [], [c.id]);
        continue;
      }
      c.hebrew = res.text; c.confidence = res.confidence; c.status = 'hebrew';
      const gone = mergeSame(ep, cues);
      saveCues(ep.id);
      const touched = cues.filter((x) => x._touched); touched.forEach((x) => delete x._touched);
      changed(ep, gone.includes(c) ? touched : [c, ...touched], gone.map((x) => x.id));
      translatePump();
    }
  } finally { ocrBusy = false; }
}

function mergeSame(ep, cues) {
  const gone = [];
  for (let i = 1; i < cues.length; i++) {
    const a = cues[i - 1], b = cues[i];
    if (a.hebrew == null || b.hebrew == null || b.start - a.end > 0.5 || normHeb(a.hebrew) !== normHeb(b.hebrew)) continue;
    const x0 = Math.min(a.bbox[0], b.bbox[0]), y0 = Math.min(a.bbox[1], b.bbox[1]);
    const x1 = Math.max(a.bbox[0] + a.bbox[2], b.bbox[0] + b.bbox[2]), y1 = Math.max(a.bbox[1] + a.bbox[3], b.bbox[1] + b.bbox[3]);
    a.bbox = [x0, y0, x1 - x0, y1 - y0];
    a.end = Math.max(a.end, b.end);
    a.confidence = Math.max(a.confidence ?? 0, b.confidence ?? 0);
    if (b.edited) { a.hebrew = b.hebrew; a.english = b.english; a.edited = true; }
    if (!a.english && b.english) { a.english = b.english; a.status = b.status; }
    a._touched = true;
    DB.del('blobs', `${ep.id}/${b.id}`); DB.del('blobs', `${ep.id}/${b.id}/ocr`);
    gone.push(b);
    cues.splice(i, 1); i--;
  }
  return gone;
}

// =====================================================================
// Translation — Chrome's built-in, on-device translator
// =====================================================================
const TR = { translator: null, state: 'init', dl: 0 };
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

async function initTranslator(fromGesture) {
  if (TR.translator || TR.state === 'downloading') return;
  const opts = { sourceLanguage: 'he', targetLanguage: 'en' };
  if (!('Translator' in self)) { TR.state = 'unsupported'; return updateTrUi(); }
  let a;
  try { a = await withTimeout(Translator.availability(opts), 6000); } catch { a = 'unavailable'; }
  if (a === 'unavailable') { TR.state = 'unsupported'; return updateTrUi(); }
  if (a !== 'available' && !fromGesture) { TR.state = 'needs-click'; return updateTrUi(); }
  try {
    TR.state = 'downloading'; updateTrUi();
    TR.translator = await Translator.create({ ...opts, monitor(m) { m.addEventListener('downloadprogress', (e) => { TR.dl = e.loaded; updateTrUi(); }); } });
    TR.state = 'ready';
  } catch { TR.state = 'needs-click'; }
  updateTrUi();
  translatePump();
}
// Chrome only lets a page set up the translator after a click, so any click will do.
document.addEventListener('pointerdown', () => { if (TR.state === 'needs-click') initTranslator(true); }, true);
document.addEventListener('keydown', () => { if (TR.state === 'needs-click') initTranslator(true); }, true);

function updateTrUi() {
  const n = $('#tr-notice');
  let html = '';
  if (TR.state === 'unsupported') html = 'English subtitles are made by <b>Google Chrome</b>\'s built-in translator (Chrome 138 or newer on a computer). Open this page in Chrome to get English — Hebrew reading works here too.';
  else if (TR.state === 'needs-click') html = '<b>One click to turn on English.</b> Chrome sets up its built-in Hebrew translator once — it stays on this computer, no account. <button class="btn small primary" id="tr-enable">Turn on English</button>';
  else if (TR.state === 'downloading') html = `Setting up Chrome's Hebrew translator… ${Math.round(TR.dl * 100)}%`;
  n.innerHTML = html;
  n.classList.toggle('hidden', !html);
  if (P.ep) updateEpisodeUi();
}

function rewrap(english, hebrew) {
  if (!/\n/.test(hebrew) || english.length < 28) return english;
  const mid = english.length / 2;
  let best = -1;
  for (let i = 0; i < english.length; i++) if (english[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  return best > 0 ? english.slice(0, best) + '\n' + english.slice(best + 1) : english;
}

let trBusy = false;
async function translatePump() {
  if (trBusy || !TR.translator) return;
  trBusy = true;
  try {
    for (;;) {
      let best = null;
      for (const ep of episodes.values()) {
        if (ep.status === 'paused') continue;
        for (const c of cuesById.get(ep.id) || []) {
          if (c.status !== 'hebrew') continue;
          const pr = c.urgent ? -1e9 : priority(ep, c);
          if (!best || pr < best.pr) best = { ep, c, pr };
        }
      }
      if (!best) break;
      const { ep, c } = best;
      c.status = 'translating';
      const src = c.hebrew;
      try {
        const en = await TR.translator.translate(src.replace(/\n/g, ' '));
        if (c.hebrew !== src) { c.status = 'hebrew'; continue; } // edited meanwhile
        c.english = rewrap(en.trim(), src); c.error = null;
      } catch (e) { c.english = c.english || ''; c.error = 'Translation failed'; }
      c.status = 'done'; c.urgent = false;
      saveCues(ep.id);
      changed(ep, [c]);
    }
  } finally { trBusy = false; }
}

// =====================================================================
// Library UI
// =====================================================================
const thumbUrls = new Map();
async function thumbUrl(id) {
  if (thumbUrls.has(id)) return thumbUrls.get(id);
  const b = await DB.get('blobs', id + '/thumb');
  const u = b ? URL.createObjectURL(b) : '';
  thumbUrls.set(id, u);
  return u;
}

function statusOf(ep) {
  if (ep.status === 'ready') return { dot: 'ok', text: `Ready · ${progressOf(ep).total} lines` };
  if (ep.status === 'paused') return { dot: '', text: `Paused · ${progressOf(ep).overall}%` };
  if (!files.has(ep.id)) return { dot: '', text: `Waiting for the video · ${progressOf(ep).overall}% — open it to continue` };
  return { dot: 'busy', text: `Preparing subtitles · ${progressOf(ep).overall}%` };
}

async function renderLibrary() {
  const list = [...episodes.values()].sort((a, b) => b.createdAt - a.createdAt);
  $('#empty').classList.toggle('hidden', list.length > 0);
  const html = [];
  for (const ep of list) {
    const st = statusOf(ep);
    const resume = ep.duration ? Math.min(100, (ep.lastPosition / ep.duration) * 100) : 0;
    const pr = progressOf(ep);
    html.push(`<div class="card" data-id="${ep.id}">
      <div class="thumb" data-act="play" style="background-image:url('${await thumbUrl(ep.id)}')">
        <div class="play-hint"><span><svg viewBox="0 0 24 24" width="22" height="22"><path d="M7 4.5v15l13-7.5z" fill="#000"/></svg></span></div>
        ${resume > 1 ? `<div class="resume" style="width:${resume}%"></div>` : ''}
      </div>
      <div class="card-body">
        <div class="card-title">${esc(ep.title)}</div>
        <div class="card-meta"><span>${fmt(ep.duration)}</span><span>· ${ep.mode === 'prepare' ? 'Prepared first' : 'Play while preparing'}</span></div>
        <div class="status"><span class="dot ${st.dot}"></span>${esc(st.text)}</div>
        ${ep.status !== 'ready' ? `<div class="bar"><i style="width:${pr.overall}%"></i></div>` : ''}
        <div class="card-actions">
          <button class="btn small primary" data-act="play">${resume > 1 ? 'Resume' : 'Play'}</button>
          <button class="btn small" data-act="subs">Subtitles</button>
          ${ep.status === 'paused' ? '<button class="btn small" data-act="resume">Resume prep</button>' : ep.status === 'processing' && files.has(ep.id) ? '<button class="btn small" data-act="pause">Pause prep</button>' : ''}
          ${ep.status === 'processing' && !files.has(ep.id) ? '<button class="btn small" data-act="continue">Continue prep</button>' : ''}
          <button class="btn small ghost danger" data-act="delete" style="margin-left:auto">Delete</button>
        </div>
      </div>
    </div>`);
  }
  $('#grid').innerHTML = html.join('');
}

$('#grid').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const card = e.target.closest('.card');
  if (!act || !card) return;
  const ep = episodes.get(card.dataset.id);
  if (act === 'play') location.hash = `#/watch/${ep.id}`;
  if (act === 'subs') location.hash = `#/watch/${ep.id}/subs`;
  if (act === 'pause') { ep.status = 'paused'; if (Scan.ep?.id === ep.id) Scan.stop(); saveEp(ep); libDirty = true; }
  if (act === 'resume') { ep.status = 'processing'; saveEp(ep); libDirty = true; tick(); }
  if (act === 'continue') { if (await ensureFile(ep)) { libDirty = true; tick(); } }
  if (act === 'delete') {
    if (!confirm(`Delete "${ep.title}" and its subtitles?\n\nThe video file itself stays on your computer.`)) return;
    await deleteEpisode(ep.id);
    toast('Episode deleted. The video file was not touched.');
  }
});

// Get the episode's file, asking for permission or a re-pick if needed (call from a click).
async function ensureFile(ep) {
  let f = await fileFor(ep, true);
  if (f) return f;
  const r = await pickVideo();
  if (!r) return null;
  if (r.file.size !== ep.size && !confirm(`“${r.file.name}” isn't the same file as this episode (“${ep.fileName}”), so the subtitles may not line up. Use it anyway?`)) return null;
  files.set(ep.id, r.file);
  if (r.handle) { handles.set(ep.id, r.handle); DB.put('handles', ep.id, r.handle); }
  if (r.file.size !== ep.size) { ep.size = r.file.size; saveEp(ep); }
  return r.file;
}

// =====================================================================
// Add episode dialog
// =====================================================================
let chosen = null;
function openAdd(item) {
  chosen = null;
  $('#add-dialog').classList.remove('hidden');
  $('#pick-zone').classList.remove('hidden'); $('#chosen').classList.add('hidden');
  $('#f-show').value = '';
  $('#add-err').classList.add('hidden');
  setModesEnabled(false);
  if (item) useDropped(item);
}
function closeAdd() { $('#add-dialog').classList.add('hidden'); }
function setModesEnabled(on) { $('#mode-play').disabled = !on; $('#mode-prepare').disabled = !on; }
function setChosen(c) {
  chosen = c;
  $('#chosen-name').textContent = c.file.name;
  $('#pick-zone').classList.add('hidden'); $('#chosen').classList.remove('hidden');
  $('#add-err').classList.add('hidden');
  setModesEnabled(true);
}
function addError(msg) { const e = $('#add-err'); e.textContent = msg; e.classList.remove('hidden'); }
async function pickForAdd() { const r = await pickVideo(); if (r) setChosen(r); }
async function useDropped(item) {
  let handle = null, file = null;
  try { handle = item.getAsFileSystemHandle ? await item.getAsFileSystemHandle() : null; } catch { /* ignore */ }
  if (handle && handle.kind === 'file') file = await handle.getFile(); else { handle = null; file = item.getAsFile ? item.getAsFile() : item; }
  if (!file || !/^video\//.test(file.type) && !/\.(mp4|m4v|mov|mkv|webm)$/i.test(file.name)) return addError('That doesn\'t look like a video file.');
  setChosen({ file, handle });
}
async function create(mode) {
  if (!chosen) return;
  setModesEnabled(false);
  const label = $('#add-err');
  try {
    label.textContent = 'Opening the video…'; label.classList.remove('hidden');
    const ep = await createEpisode(chosen.file, chosen.handle, $('#f-show').value, mode);
    closeAdd();
    if (mode === 'play') location.hash = `#/watch/${ep.id}`;
    else { toast('Preparing subtitles. Keep this tab open while it works.'); renderLibrary(); }
  } catch (e) { addError(e.message); setModesEnabled(true); }
}
$('#add-btn').onclick = () => openAdd();
$('#empty-add').onclick = () => openAdd();
$('#add-cancel').onclick = closeAdd;
$('#pick-btn').onclick = pickForAdd;
$('#change-btn').onclick = pickForAdd;
$('#mode-play').onclick = () => create('play');
$('#mode-prepare').onclick = () => create('prepare');
$('#add-dialog').addEventListener('click', (e) => { if (e.target.id === 'add-dialog') closeAdd(); });

['dragover', 'dragenter'].forEach((t) => document.addEventListener(t, (e) => {
  if ($('#player').classList.contains('hidden')) { e.preventDefault(); $('#pick-zone').classList.add('over'); }
}));
document.addEventListener('dragleave', () => $('#pick-zone').classList.remove('over'));
document.addEventListener('drop', (e) => {
  e.preventDefault(); $('#pick-zone').classList.remove('over');
  const item = [...(e.dataTransfer?.items || [])].find((i) => i.kind === 'file');
  if (!item || !$('#player').classList.contains('hidden')) return;
  if ($('#add-dialog').classList.contains('hidden')) openAdd(item); else useDropped(item);
});

// =====================================================================
// Player
// =====================================================================
const video = $('#video');
const P = { id: null, ep: null, cues: [], mode: localStorage.getItem('subMode') || 'en', lastReport: 0, lastSave: 0, cueEls: new Map(), activeId: null, follow: true, onlyFlagged: false };
const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>';
const cropUrls = new Map();

async function openPlayer(id, withList) {
  const ep = episodes.get(id);
  if (!ep) { location.hash = '#/'; return; }
  $('#library').classList.add('hidden');
  $('#player').classList.remove('hidden');
  $('#player').classList.toggle('drawer-open', !!withList);
  if (P.id === id) return;
  closePlayer();
  P.id = id; P.ep = ep; P.cues = cuesById.get(id); P.cueEls.clear(); P.activeId = null;
  $('#cue-list').innerHTML = '';
  $('#overlay').innerHTML = '';
  $('#p-title').textContent = ep.title; document.title = ep.title;
  setModeButtons();
  renderList(true);
  updateEpisodeUi();
  const f = await fileFor(ep, false);
  if (P.id !== id) return;
  if (f) loadVideo(); else showNeedFile();
}

function showNeedFile() {
  const ep = P.ep;
  const remembered = handles.has(ep.id);
  $('#missing').classList.remove('hidden');
  $('#missing-title').textContent = remembered ? 'Allow access to the video' : 'Choose the video file';
  $('#missing-text').innerHTML = remembered
    ? `Chrome asks once per visit before this page can read “${esc(ep.fileName)}” from your computer. It stays on your computer — nothing is uploaded.`
    : `This page plays “${esc(ep.fileName)}” straight from your computer and never uploads it, so after the page was closed it needs you to pick the file again. Your subtitles and your place are saved.`;
  $('#locate-btn').textContent = remembered ? 'Allow' : 'Choose file…';
}

function loadVideo() {
  const ep = P.ep;
  $('#missing').classList.add('hidden');
  video.src = videoUrl(ep.id);
  video.addEventListener('loadedmetadata', () => {
    if (ep.lastPosition > 3 && ep.lastPosition < ep.duration - 10) video.currentTime = ep.lastPosition - 2;
    layoutOverlay();
    const p = video.play();
    if (p) p.catch(() => $('#bigplay').classList.remove('hidden'));
    onPlayhead(ep.id, video.currentTime, false);
  }, { once: true });
  tick();
}

function closePlayer() {
  if (P.id && video.currentTime > 0) reportPlayhead(true);
  video.pause();
  video.removeAttribute('src'); video.load();
  for (const u of cropUrls.values()) URL.revokeObjectURL(u);
  cropUrls.clear();
  P.id = null; P.ep = null;
  watch = { id: null, t: 0, at: 0 };
}

video.addEventListener('error', () => { if (P.ep && video.getAttribute('src')) toast('Chrome can\'t play this video format. Try converting it to MP4.', 8000); });

function onPlayerCues(upsert, removed) {
  for (const id of removed) { P.cueEls.get(id)?.remove(); P.cueEls.delete(id); }
  renderList(false, upsert.map((c) => c.id));
  renderOverlay(true);
  drawSeekRanges();
}

function updateEpisodeUi() {
  const ep = P.ep; if (!ep) return;
  const chip = $('#status-chip'), txt = $('#status-text'), dot = chip.querySelector('.dot');
  const t = video.currentTime || 0;
  const prog = progressOf(ep);
  let msg = '', persist = false, cls = 'busy';
  if (TR.state !== 'ready' && ep.status !== 'ready') {
    msg = TR.state === 'downloading' ? `Setting up translation… ${Math.round(TR.dl * 100)}%` : TR.state === 'unsupported' ? 'English needs Google Chrome' : 'Click anywhere to turn on English';
    cls = 'bad'; persist = true;
  } else if (ep.status === 'ready') { msg = `${prog.total} subtitles · ready`; cls = 'ok'; }
  else if (ep.status === 'paused') { msg = `Subtitle prep paused · ${prog.overall}%`; cls = ''; }
  else if (document.hidden) msg = 'Paused while this tab is in the background';
  else {
    const ready = readyUntil(t);
    if (ready == null) { msg = 'Reading subtitles from here…'; persist = !video.paused; }
    else if (ready - t < 4 && ready < ep.duration - 1) { msg = 'Translating the next lines…'; persist = !video.paused; }
    else msg = `English ready to ${fmt(ready)} · ${prog.overall}% overall`;
  }
  txt.textContent = msg; dot.className = 'dot ' + cls;
  chip.classList.toggle('persist', persist);
  const lines = P.cues.filter((c) => c.hebrew != null).length, low = P.cues.filter(isLow).length;
  $('#dr-count').textContent = `${lines} lines${low ? ` · ${low} to review` : ''}`;
  drawSeekRanges();
}

function readyUntil(t) {
  const cov = P.ep.coverage || [];
  const iv = cov.find(([a, b]) => t >= a - 0.5 && t < b);
  if (!iv && P.ep.status !== 'ready') return null;
  let until = iv ? iv[1] : P.ep.duration;
  for (const c of P.cues) {
    if (c.end < t) continue;
    if (c.start > until) break;
    if (!c.english) { until = Math.max(t, c.start); break; }
  }
  return until;
}

// ---- overlay ----
let vrect = { x: 0, y: 0, w: 0, h: 0 };
function layoutOverlay() {
  const stage = $('#stage').getBoundingClientRect();
  const vw = video.videoWidth || P.ep?.width || 16, vh = video.videoHeight || P.ep?.height || 9;
  const s = Math.min(stage.width / vw, stage.height / vh);
  vrect = { w: vw * s, h: vh * s, x: (stage.width - vw * s) / 2, y: (stage.height - vh * s) / 2 };
  Object.assign($('#overlay').style, { left: vrect.x + 'px', top: vrect.y + 'px', width: vrect.w + 'px', height: vrect.h + 'px' });
  renderOverlay(true);
}
new ResizeObserver(layoutOverlay).observe($('#stage'));

function cueAt(t) {
  let lo = 0, hi = P.cues.length - 1, best = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (P.cues[mid].start - 0.18 <= t) { best = mid; lo = mid + 1; } else hi = mid - 1; }
  for (let i = best; i != null && i >= 0 && i >= best - 2; i--) {
    const c = P.cues[i];
    if (t >= c.start - 0.18 && t <= c.end + 0.12) return c;
  }
  return null;
}

let shownKey = '';
function renderOverlay(force) {
  if (!P.ep) return;
  const c = cueAt(video.currentTime);
  const mode = P.mode;
  const key = c ? `${c.id}|${c.status}|${c.english}|${c.hebrew}|${mode}|${vrect.w}|${vrect.h}` : `none|${mode}`;
  if (!force && key === shownKey) return;
  shownKey = key;
  const ov = $('#overlay');
  if ((c?.id || null) !== P.activeId) { P.activeId = c?.id || null; markActive(); }
  if (!c || mode === 'off' || (mode === 'he' ? !c.hebrew : !c.english)) { ov.innerHTML = ''; return; }
  const [bx, by, bw, bh] = c.bbox;
  const lines = Math.max(1, (c.hebrew.match(/\n/g) || []).length + 1);
  const lineH = (bh * vrect.h) / lines;
  const font = Math.max(13, Math.min(lineH * 0.82, vrect.h * 0.06));
  const padX = lineH * 0.55, padY = lineH * 0.3;
  const left = (bx + bw / 2) * vrect.w;
  const bottom = vrect.h - (by + bh) * vrect.h - padY;
  const minW = bw * vrect.w + padX * 2, minH = bh * vrect.h + padY * 2;
  let html;
  if (mode === 'en') html = `<div>${esc(c.english)}</div>`;
  else if (mode === 'he') html = `<div class="he">${esc(c.hebrew)}</div>`;
  else html = `<div>${esc(c.english)}</div><div class="he small">${esc(c.hebrew)}</div>`;
  ov.innerHTML = `<div class="sub-box" style="left:${left}px;bottom:${bottom}px;min-width:${minW}px;min-height:${minH}px;max-width:${vrect.w * 0.96}px;font-size:${font}px">${html}</div>`;
}

function loop() {
  if (P.ep && !$('#player').classList.contains('hidden')) {
    renderOverlay(false);
    const t = video.currentTime, d = video.duration || P.ep.duration || 1;
    $('#played').style.width = (t / d * 100) + '%';
    $('#knob').style.left = (t / d * 100) + '%';
    $('#time').textContent = `${fmt(t)} / ${fmt(d)}`;
    const now = performance.now();
    if (!video.paused && now - P.lastReport > 2000) reportPlayhead(now - P.lastSave > 6000);
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
setInterval(() => { if (P.ep && !$('#player').classList.contains('hidden')) updateEpisodeUi(); }, 1000);

function reportPlayhead(save) {
  if (!P.id) return;
  P.lastReport = performance.now();
  if (save) P.lastSave = performance.now();
  onPlayhead(P.id, video.currentTime, save);
}
video.addEventListener('seeked', () => { reportPlayhead(true); renderOverlay(true); updateEpisodeUi(); });
video.addEventListener('pause', () => { reportPlayhead(true); setPP(); showHud(); });
video.addEventListener('play', () => { $('#bigplay').classList.add('hidden'); setPP(); poke(); });
window.addEventListener('pagehide', () => { if (P.id) reportPlayhead(true); for (const id of [...urls.keys()]) releaseVideo(id); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

// ---- seek bar ----
function drawSeekRanges() {
  if (!P.ep) return;
  const d = P.ep.duration || 1;
  const track = $('#track');
  track.querySelectorAll('.seg,.pend').forEach((n) => n.remove());
  const frag = document.createDocumentFragment();
  for (const [a, b] of P.ep.coverage || []) {
    const s = document.createElement('div'); s.className = 'seg';
    s.style.left = (a / d * 100) + '%'; s.style.width = ((b - a) / d * 100) + '%'; frag.appendChild(s);
  }
  for (const c of P.cues) if (!c.english) {
    const s = document.createElement('div'); s.className = 'pend';
    s.style.left = (c.start / d * 100) + '%'; s.style.width = Math.max(0.15, (c.end - c.start) / d * 100) + '%'; frag.appendChild(s);
  }
  track.insertBefore(frag, $('#played'));
}
const seekT = (e) => { const r = $('#seek').getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (video.duration || P.ep.duration); };
let dragging = false;
$('#seek').addEventListener('pointerdown', (e) => { dragging = true; $('#seek').setPointerCapture(e.pointerId); video.currentTime = seekT(e); });
$('#seek').addEventListener('pointermove', (e) => {
  const t = seekT(e), r = $('#seek').getBoundingClientRect();
  const tip = $('#tip'); tip.textContent = fmt(t); tip.style.left = (e.clientX - r.left) + 'px';
  if (dragging) video.currentTime = t;
});
$('#seek').addEventListener('pointerup', () => { dragging = false; });

// ---- controls ----
function setPP() { $('#pp-btn').innerHTML = video.paused ? ICON_PLAY : ICON_PAUSE; }
setPP();
function togglePlay() { if (!video.getAttribute('src')) return; if (video.paused) video.play(); else video.pause(); }
$('#pp-btn').onclick = togglePlay;
$('#bigplay').onclick = () => video.play();
$('#rew-btn').onclick = () => { video.currentTime = Math.max(0, video.currentTime - 5); };
$('#stage').addEventListener('click', (e) => { if (e.target === video || e.target.id === 'overlay' || e.target.id === 'hud') togglePlay(); });
$('#stage').addEventListener('dblclick', (e) => { if (e.target === video || e.target.id === 'hud') toggleFs(); });
function toggleFs() { if (document.fullscreenElement) document.exitFullscreen(); else $('#player').requestFullscreen?.(); }
$('#fs-btn').onclick = toggleFs;
function setModeButtons() { document.querySelectorAll('#modes button').forEach((b) => b.classList.toggle('on', b.dataset.m === P.mode)); }
$('#modes').addEventListener('click', (e) => { const m = e.target.dataset.m; if (m) setMode(m); });
function setMode(m) { P.mode = m; localStorage.setItem('subMode', m); setModeButtons(); renderOverlay(true); }
$('#list-btn').onclick = () => toggleDrawer();
$('#dr-close').onclick = () => toggleDrawer(false);
function toggleDrawer(on) {
  const open = on ?? !$('#player').classList.contains('drawer-open');
  $('#player').classList.toggle('drawer-open', open);
  history.replaceState(null, '', `#/watch/${P.id}${open ? '/subs' : ''}`);
  if (open) setTimeout(() => scrollToActive(true), 260);
}
$('#back-btn').onclick = () => { location.hash = '#/'; };
$('#missing-back').onclick = () => { location.hash = '#/'; };
$('#locate-btn').onclick = async () => { if (P.ep && await ensureFile(P.ep)) loadVideo(); };

let idleTimer;
function poke() {
  $('#player').classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!video.paused && !$('#player').classList.contains('drawer-open') && !dragging) $('#player').classList.add('idle'); }, 2600);
}
function showHud() { $('#player').classList.remove('idle'); clearTimeout(idleTimer); }
$('#player').addEventListener('mousemove', poke);

document.addEventListener('keydown', (e) => {
  if ($('#player').classList.contains('hidden')) { if (e.key === 'Escape') closeAdd(); return; }
  if (e.target.matches('input, textarea')) { if (e.key === 'Escape') e.target.blur(); return; }
  const k = e.key.toLowerCase();
  if (k === ' ' || k === 'k') { e.preventDefault(); togglePlay(); }
  else if (k === 'arrowleft') { video.currentTime = Math.max(0, video.currentTime - 5); poke(); }
  else if (k === 'arrowright') { video.currentTime = Math.min(video.duration, video.currentTime + 5); poke(); }
  else if (k === 'j') video.currentTime = Math.max(0, video.currentTime - 10);
  else if (k === 'l') video.currentTime = Math.min(video.duration, video.currentTime + 10);
  else if (k === 'f') toggleFs();
  else if (k === 's') { const order = ['en', 'he', 'both', 'off']; setMode(order[(order.indexOf(P.mode) + 1) % 4]); toast(`Subtitles: ${({ en: 'English', he: 'Hebrew', both: 'Both', off: 'Off' })[P.mode]}`, 1200); }
  else if (k === 'e') toggleDrawer();
  else if (k === 'escape') { if (document.fullscreenElement) return; if ($('#player').classList.contains('drawer-open')) toggleDrawer(false); else location.hash = '#/'; }
});

// ---- subtitle list / editor ----
const cueVisible = (c) => !P.onlyFlagged || isLow(c) || !!c.error;

async function cropUrl(epId, cueId) {
  const key = `${epId}/${cueId}`;
  if (cropUrls.has(key)) return cropUrls.get(key);
  const b = await DB.get('blobs', key);
  const u = b ? URL.createObjectURL(b) : '';
  cropUrls.set(key, u);
  return u;
}

function buildCueEl(c) {
  const el = document.createElement('div');
  el.className = 'cue'; el.dataset.id = c.id;
  el.innerHTML = `<div class="meta"><span class="t"></span><span class="badges"></span></div>
    <img loading="lazy" alt="">
    <textarea class="he" rows="1" dir="rtl" spellcheck="false" placeholder="Hebrew"></textarea>
    <textarea class="en" rows="1" placeholder="English"></textarea>`;
  el.querySelector('.t').onclick = () => { const cue = P.cues.find((x) => x.id === el.dataset.id); if (cue) video.currentTime = cue.start + 0.05; };
  const img = el.querySelector('img');
  const epId = P.id;
  new IntersectionObserver((entries, obs) => {
    if (entries.some((x) => x.isIntersecting)) { obs.disconnect(); cropUrl(epId, c.id).then((u) => { if (u) img.src = u; }); }
  }, { root: $('#cue-list') }).observe(el);
  const he = el.querySelector('.he'), en = el.querySelector('.en');
  for (const ta of [he, en]) {
    ta.addEventListener('input', () => autosize(ta));
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.blur(); } });
  }
  he.addEventListener('blur', () => saveCue(el.dataset.id, 'hebrew', he.value));
  en.addEventListener('blur', () => saveCue(el.dataset.id, 'english', en.value));
  return el;
}
function autosize(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }

function fillCueEl(el, c) {
  el.querySelector('.t').textContent = fmt(c.start);
  const badges = [];
  if (c.status === 'pending' || c.status === 'ocr') badges.push('<span class="badge">Reading…</span>');
  if (c.status === 'hebrew' || c.status === 'translating') badges.push('<span class="badge">Translating…</span>');
  if (isLow(c)) badges.push('<span class="badge warn">Check Hebrew</span>');
  if (c.edited) badges.push('<span class="badge">Edited</span>');
  if (c.error) badges.push(`<span class="badge err" title="${esc(c.error)}">Problem</span>`);
  el.querySelector('.badges').innerHTML = badges.join(' ');
  el.classList.toggle('flag', isLow(c));
  el.classList.toggle('hidden', !cueVisible(c));
  const he = el.querySelector('.he'), en = el.querySelector('.en');
  if (document.activeElement !== he) { he.value = c.hebrew || ''; autosize(he); }
  if (document.activeElement !== en) { en.value = c.english || ''; en.placeholder = c.status === 'done' ? 'English' : (c.hebrew ? 'Translating…' : 'Reading…'); autosize(en); }
  he.disabled = en.disabled = c.status === 'pending' || c.status === 'ocr';
}

function renderList(full, changedIds) {
  const list = $('#cue-list');
  if (full) { list.innerHTML = ''; P.cueEls.clear(); }
  const ids = changedIds ? new Set(changedIds) : null;
  let prev = null;
  for (const c of P.cues) {
    let el = P.cueEls.get(c.id);
    if (!el) { el = buildCueEl(c); P.cueEls.set(c.id, el); fillCueEl(el, c); }
    else if (!ids || ids.has(c.id)) fillCueEl(el, c);
    const want = prev ? prev.nextSibling : list.firstChild;
    if (want !== el) list.insertBefore(el, want);
    prev = el;
  }
  if (!P.cues.length) list.innerHTML = '<div class="dr-empty">No subtitles yet.<br>They appear here as the video is read.</div>';
  else list.querySelector('.dr-empty')?.remove();
  updateEpisodeUi();
}

function markActive() {
  document.querySelectorAll('.cue.active').forEach((n) => n.classList.remove('active'));
  const el = P.activeId && P.cueEls.get(P.activeId);
  if (el) { el.classList.add('active'); scrollToActive(false); }
}
function scrollToActive(instant) {
  if (!P.follow || !$('#player').classList.contains('drawer-open') || $('#cue-list').contains(document.activeElement)) return;
  const el = P.activeId && P.cueEls.get(P.activeId);
  if (el) el.scrollIntoView({ block: 'center', behavior: instant ? 'auto' : 'smooth' });
}
$('#follow-t').onclick = (e) => { P.follow = !P.follow; e.target.classList.toggle('on', P.follow); scrollToActive(true); };
$('#flag-t').onclick = (e) => {
  P.onlyFlagged = !P.onlyFlagged; e.target.classList.toggle('on', P.onlyFlagged);
  for (const c of P.cues) P.cueEls.get(c.id)?.classList.toggle('hidden', !cueVisible(c));
};

function saveCue(id, field, value) {
  const c = P.cues.find((x) => x.id === id);
  value = value.trim();
  if (!c || (c[field] || '') === value) return;
  if (field === 'hebrew') {
    // Corrected Hebrew: re-translate just this line, first in line.
    c.hebrew = value; c.edited = true; c.confidence = 1; c.english = ''; c.status = 'hebrew'; c.urgent = true;
    toast(TR.translator ? 'Re-translating this line…' : 'Saved. English will update once translation is on.', 1800);
    translatePump();
  } else { c.english = value; c.edited = true; c.status = 'done'; c.urgent = false; }
  saveCues(P.id);
  changed(P.ep, [c]);
}

// =====================================================================
// Routing & start-up
// =====================================================================
function route() {
  const m = location.hash.match(/^#\/watch\/([a-z0-9]+)(\/subs)?/);
  if (m) openPlayer(m[1], !!m[2]);
  else {
    closePlayer();
    $('#library').classList.remove('hidden');
    $('#player').classList.add('hidden');
    document.title = 'Subtitle Player';
    renderLibrary();
  }
}

(async () => {
  await DB.open();
  for (const [id, ep] of await DB.all('episodes')) episodes.set(id, ep);
  for (const [id, cues] of await DB.all('cues')) {
    if (!episodes.has(id)) continue;
    for (const c of cues) { if (c.status === 'ocr') c.status = 'pending'; if (c.status === 'translating') c.status = 'hebrew'; }
    cuesById.set(id, cues);
  }
  for (const [id, h] of await DB.all('handles')) if (episodes.has(id)) handles.set(id, h);
  for (const id of episodes.keys()) if (!cuesById.has(id)) cuesById.set(id, []);
  // Remembered files that Chrome still lets us read without asking.
  await Promise.all([...episodes.values()].map((ep) => fileFor(ep, false)));
  window.addEventListener('hashchange', route);
  route();
  tick();
  initTranslator(false);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
