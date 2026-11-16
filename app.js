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
const SCANNER_VERSION = 2; // 2 = frame-accurate timing
const SCAN_RATE = 4;            // hidden scanner plays at 4x (fast, without dropping frames)
const SAMPLE_INTERVAL = 1 / 10; // look at the subtitle area every 0.1 s of video

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
    DB.put('cues', id, (cuesById.get(id) || []).map(({ ocrBlob, _touched, aiBusy, ...c }) => c));
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
  if (status === 'ready' && ep.shared !== 'shared' && ep.shared !== 'imported') maybeShare(ep);
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
// Fingerprint of a video file (size + three 1 MB samples). The same file on another computer gives
// the same fingerprint, so finished subtitles can be shared without ever sharing the video.
async function fingerprint(file) {
  const MB = 1 << 20;
  const parts = [new TextEncoder().encode(String(file.size)).buffer];
  for (const at of [0, Math.max(0, Math.floor(file.size / 2) - MB / 2), Math.max(0, file.size - MB)]) parts.push(await file.slice(at, at + MB).arrayBuffer());
  const all = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) { all.set(new Uint8Array(p), o); o += p.byteLength; }
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', all))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Ready subtitles for this exact file prepared by someone else? Then use them: no processing, no AI cost.
async function importShared(ep) {
  if (!relayConfigured() || !ep.fp) return false;
  try {
    const r = await fetch(`${RELAY_URL}/shared/${ep.fp}`, { cache: 'no-store' });
    if (!r.ok) return false;
    const data = await r.json();
    if ((data.meta.scanVersion || 1) < SCANNER_VERSION || !data.cues.length) return false;
    const cues = data.cues.map((c) => ({ id: uid(), start: c.start, end: c.end, bbox: c.bbox, hebrew: c.hebrew || '', english: c.english || '',
      confidence: c.confidence ?? 0.9, status: 'done', source: 'shared', edited: !!c.edited, aiTried: true }));
    cues.sort((a, b) => a.start - b.start);
    if (Scan.ep && Scan.ep.id === ep.id) Scan.stop();
    cuesById.set(ep.id, cues);
    ep.coverage = [[0, ep.duration]];
    if (data.meta.band) ep.band = data.meta.band;
    ep.shared = 'imported'; ep.scanVersion = data.meta.scanVersion;
    await DB.put('cues', ep.id, cues);
    saveEp(ep); changed(ep, cues);
    if (P.id === ep.id) { P.cues = cuesById.get(ep.id); computeBand(); renderList(true); renderOverlay(true); }
    return true;
  } catch { return false; }
}

// Offer this episode's finished subtitles to others — only AI-quality ones, so a weaker offline
// version never takes the place of a better one.
let shareTimers = new Map();
function maybeShare(ep) {
  if (!relayConfigured() || !ep.fp || ep.status !== 'ready' || ep.shared === 'imported' && !ep.editedSinceImport) return;
  const cues = cuesById.get(ep.id) || [];
  const good = cues.filter((c) => c.source === 'ai' || c.source === 'shared' || c.edited).length;
  if (!cues.length || good < cues.length * 0.8 || shareTimers.has(ep.id)) return;
  shareTimers.set(ep.id, setTimeout(async () => {
    shareTimers.delete(ep.id);
    const body = {
      meta: { duration: ep.duration, width: ep.width, height: ep.height, size: ep.size, band: ep.band, scanVersion: ep.scanVersion || SCANNER_VERSION },
      cues: cues.filter((c) => c.english).map((c) => ({ start: c.start, end: c.end, bbox: c.bbox, hebrew: c.hebrew, english: c.english, confidence: c.confidence, edited: !!c.edited })),
    };
    try {
      const r = await fetch(`${RELAY_URL}/shared/${ep.fp}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.ok) { ep.shared = 'shared'; ep.editedSinceImport = false; saveEp(ep); libDirty = true; }
    } catch { /* try again on the next change */ }
  }, 5000));
}

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
    mode, status: 'processing', coverage: [], lastPosition: 0, createdAt: Date.now(), scanVersion: SCANNER_VERSION,
  };
  episodes.set(ep.id, ep); cuesById.set(ep.id, []); files.set(ep.id, f);
  await DB.put('episodes', ep.id, ep);
  await DB.put('cues', ep.id, []);
  if (info.thumb) await DB.put('blobs', ep.id + '/thumb', info.thumb);
  if (handle) { handles.set(ep.id, handle); await DB.put('handles', ep.id, handle); }
  try { ep.fp = await fingerprint(f); saveEp(ep); } catch { /* sharing just won't apply */ }
  const imported = await importShared(ep);
  libDirty = true;
  if (imported) toast('These subtitles were already prepared — ready to watch, no waiting.');
  tick();
  return ep;
}

// Throw away an episode's subtitles and read them again (e.g. after a scanner improvement).
async function redoEpisode(id) {
  const ep = episodes.get(id);
  if (!ep) return;
  if (Scan.ep && Scan.ep.id === id) Scan.stop();
  const thumb = await DB.get('blobs', id + '/thumb');
  await DB.delRange('blobs', id + '/');
  if (thumb) await DB.put('blobs', id + '/thumb', thumb);
  cuesById.set(id, []);
  ep.coverage = []; delete ep.band; ep.status = 'processing'; ep.scanVersion = SCANNER_VERSION; ep.shared = null;
  await DB.put('cues', id, []);
  saveEp(ep);
  if (P.id === id) { P.cues = cuesById.get(id); P.cueEls.clear(); $('#cue-list').innerHTML = ''; computeBand(); renderOverlay(true); }
  libDirty = true;
  tick();
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
  fast: false, fastFailed: new Set(),

  // Fast path for MP4/MOV (Chrome's video decoder in a worker, ~15–20x real time, keeps going in a
  // background tab); otherwise the hidden fast-forward video below.
  canFast(ep) {
    const f = files.get(ep.id);
    return !!f && 'VideoDecoder' in self && /\.(mp4|m4v|mov)$/i.test(f.name) && !this.fastFailed.has(ep.id);
  },

  start(ep, from, to) {
    this.stop();
    const gen = ++this.gen;
    this.ep = ep; this.from = from; this.to = to; this.scanStart = from; this.safe = from; this.pos = from;
    this.next = from; this.busy = false; this.ending = false; this.region = null;
    if (!this.worker) {
      this.worker = new Worker('scan-worker.js', { type: 'module' });
      this.worker.onmessage = (e) => this.onMessage(e.data);
    }
    this.wgen = gen;
    this.fast = this.canFast(ep);
    if (this.fast) {
      this.worker.postMessage({ type: 'decode', src: { file: files.get(ep.id) }, W: ep.width, H: ep.height, from, to, interval: SAMPLE_INTERVAL, gen });
      return;
    }
    this.worker.postMessage({ type: 'start', W: ep.width, H: ep.height, from, interval: SAMPLE_INTERVAL, gen });
    const v = this.video;
    v.src = videoUrl(ep.id);
    v.muted = true;
    v.currentTime = from;
    v.playbackRate = SCAN_RATE;
    v.onended = () => this.end(true);
    v.onpause = () => { if (this.ep && !this.ending && !this.waiting && gen === this.gen) setTimeout(() => this.ep && gen === this.gen && v.play().catch(() => {}), 300); };
    // Don't start until the scanner is ready and the jump has landed, or the first seconds get skipped.
    this.waiting = true;
    const go = () => { if (gen === this.gen && this.region && !v.seeking && v.readyState >= 2) { this.waiting = false; v.play().catch(() => {}); } };
    this.go = go;
    v.addEventListener('seeked', go, { once: true });
    v.addEventListener('canplay', go, { once: true });
    setTimeout(go, 1500); setTimeout(go, 4000); // safety nets
    // Exact frames: requestVideoFrameCallback hands us each frame as it's shown, with its true
    // media time, so subtitle timings are frame-accurate. A slow timer is only a fallback for when
    // Chrome stops delivering frame callbacks (e.g. the tab is in the background).
    let lastCb = 0;
    const sample = (t) => {
      this.pos = t;
      if (t >= this.to) { this.end(true); return false; }
      if (this.region && !this.busy && v.readyState >= 2 && !v.seeking && t + 0.001 >= this.next) {
        this.next = t + SAMPLE_INTERVAL * 0.9;
        const r = this.region;
        this.ctx.drawImage(v, r.x0, r.y0, r.w, r.h, 0, 0, r.w, r.h);
        const data = this.ctx.getImageData(0, 0, r.w, r.h).data.buffer;
        this.busy = true;
        this.worker.postMessage({ type: 'frame', t, data }, [data]);
      }
      return true;
    };
    const onFrame = (now, meta) => {
      if (gen !== this.gen) return;
      lastCb = performance.now();
      if (sample(meta.mediaTime)) v.requestVideoFrameCallback(onFrame);
    };
    v.requestVideoFrameCallback(onFrame);
    const poll = () => {
      if (gen !== this.gen) return;
      if (performance.now() - lastCb > 500 && !sample(v.currentTime)) return;
      setTimeout(poll, 40);
    };
    setTimeout(poll, 40);
  },

  onMessage(m) {
    if (m.gen !== this.wgen) return; // from a scan that was stopped
    const ep = this.ep;
    if (m.type === 'region') {
      this.region = m;
      this.canvas = new OffscreenCanvas(m.w, m.h);
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      if (this.waiting && this.go) this.go();
    } else if (m.type === 'ack') this.busy = false;
    else if (m.type === 'fast-done' && ep) this.end(true);
    else if (m.type === 'fast-unsupported' && ep) {
      // Chrome can't decode this file directly: fall back to the playback-based scanner.
      console.info('Fast scanning not available for this file:', m.reason);
      this.fastFailed.add(ep.id);
      this.start(ep, this.safe, this.to);
    } else if (m.type === 'progress' && ep) {
      this.pos = Math.max(this.pos, m.t);
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
    if (!this.fast) this.video.pause();
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
  ocrPump(); translatePump(); aiPump();
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
      c.hebrew = res.text; c.confidence = res.confidence; c.status = 'hebrew'; c.hebrewAt = Date.now();
      const gone = mergeSame(ep, cues);
      saveCues(ep.id);
      const touched = cues.filter((x) => x._touched); touched.forEach((x) => delete x._touched);
      changed(ep, gone.includes(c) ? touched : [c, ...touched], gone.map((x) => x.id));
      translatePump(); aiPump();
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
  if (aiActive() && TR.state === 'unsupported') { n.classList.add('hidden'); if (P.ep) updateEpisodeUi(); return; }
  if (TR.state === 'unsupported') html = 'English subtitles are made by <b>Google Chrome</b>\'s built-in translator (Chrome 138 or newer on a computer). Open this page in Chrome to get English — Hebrew reading works here too.';
  else if (TR.state === 'needs-click') html = '<b>One click to turn on English.</b> Chrome sets up its built-in Hebrew translator once — it stays on this computer, no account. <button class="btn small primary" id="tr-enable">Turn on English</button>';
  else if (TR.state === 'downloading') html = `Setting up Chrome's Hebrew translator… ${Math.round(TR.dl * 100)}%`;
  n.innerHTML = html;
  n.classList.toggle('hidden', !html);
  if (P.ep) updateEpisodeUi();
}

function rewrap(english, hebrew) {
  if (!/\n/.test(hebrew) || /\n/.test(english) || english.length < 28) return english;
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
          if (c.status !== 'hebrew' || !offlineMayTake(ep, c)) continue;
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
      c.status = 'done'; c.urgent = false; c.source = 'offline';
      saveCues(ep.id);
      changed(ep, [c]);
    }
  } finally { trBusy = false; }
}

// =====================================================================
// Optional AI polish — Claude via the owner's private relay (key never in this page)
// =====================================================================
const RELAY_URL = 'https://subtitle-player-relay.subtitle-player.workers.dev';
const AI = { reachable: false, enabled: false, configured: false, remaining: 0, viewerOn: localStorage.getItem('aiOff') !== '1', backoffUntil: 0, running: 0, lastError: '', spent: 0,
  settings: { imageModel: 'haiku', threshold: 0.85, think: 'off' } };
const relayConfigured = () => /^https:/.test(RELAY_URL);
const aiActive = () => relayConfigured() && AI.reachable && AI.enabled && AI.configured && AI.viewerOn && AI.remaining > 0 && Date.now() > AI.backoffUntil;

// With AI on, the offline translator only steps in for lines the viewer is about to see
// that AI hasn't handled in time — so English never stalls.
function offlineMayTake(ep, c) {
  if (!aiActive()) return true;
  const watching = watch.id === ep.id && Date.now() - watch.at < 15000;
  return watching && c.start - watch.t < 12 && c.end > watch.t - 2 && Date.now() - (c.hebrewAt || 0) > 7000 && !c.aiBusy;
}

async function aiStatus() {
  if (!relayConfigured()) return updateAiUi();
  try {
    const r = await fetch(RELAY_URL + '/status', { cache: 'no-store' });
    const j = await r.json();
    AI.reachable = r.ok; AI.enabled = !!j.enabled; AI.configured = !!j.configured; AI.remaining = j.remaining ?? 1e9;
    if (j.settings) AI.settings = { ...AI.settings, ...j.settings };
  } catch { AI.reachable = false; }
  updateAiUi();
  aiPump();
}
setInterval(aiStatus, 60000);

async function relay(path, body) {
  const r = await fetch(RELAY_URL + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `Relay error ${r.status}`), { status: r.status });
  AI.remaining = Math.max(0, AI.remaining - 1);
  return j;
}

// Claude sometimes writes line breaks as a literal "\\n" or " / ".
const aiText = (t) => String(t || '').replace(/\\n/g, '\n').replace(/\s+\/\s+/g, '\n').replace(/[ \t]+\n/g, '\n').trim();

function aiFailed(e) {
  AI.lastError = e.message;
  if (e.status === 503) { AI.enabled = false; aiStatus(); }
  else if (e.status === 429) { AI.backoffUntil = Date.now() + 5 * 60000; if (/limit/i.test(e.message)) AI.remaining = 0; }
  else AI.backoffUntil = Date.now() + 60000;
  updateAiUi();
  translatePump();
}

// How each line gets polished (owner-tunable on the relay, see the AI panel):
//  • clean OCR lines → fixed + translated from the text in batches (cheapest)
//  • messy OCR lines (low confidence), or lines Claude flags as unsure → read from the subtitle picture
const needsPicture = (c) => AI.settings.imageModel !== 'off' && (c.forcePicture || (c.confidence ?? 1) < AI.settings.threshold);
const TEXT_BATCH = 30, IMAGE_BATCH = 12;

// Next batch for Claude: the viewer's next lines first, then background upgrades of lines the
// offline translator already did (away from the playhead). Lines of one kind (text / picture) per batch.
function pickAiBatch() {
  let best = null;
  for (const ep of episodes.values()) {
    if (ep.status === 'paused') continue;
    for (const c of cuesById.get(ep.id) || []) {
      if (c.status !== 'hebrew' || c.aiBusy) continue;
      const pr = c.urgent ? -1e9 : priority(ep, c);
      if (!best || pr < best.pr) best = { ep, c, pr };
    }
  }
  const take = (ep, head, ok) => {
    const cues = cuesById.get(ep.id);
    const kind = needsPicture(head) ? 'image' : 'text';
    const max = kind === 'image' ? IMAGE_BATCH : TEXT_BATCH;
    const batch = [];
    const i0 = cues.indexOf(head);
    for (let i = i0; i < cues.length && batch.length < max && i < i0 + max * 3; i++) {
      const c = cues[i];
      if (ok(c) && (needsPicture(c) ? 'image' : 'text') === kind) batch.push(c);
    }
    return { ep, batch, kind };
  };
  if (best) return take(best.ep, best.c, (c) => c.status === 'hebrew' && !c.aiBusy);
  const upgradable = (ep, c) => c.status === 'done' && c.source !== 'ai' && !c.edited && !c.aiTried && !c.aiBusy && c.hebrew &&
    !(watch.id === ep.id && c.end > watch.t - 2 && c.start < watch.t + 25);
  for (const ep of episodes.values()) {
    if (ep.status === 'paused') continue;
    const cues = cuesById.get(ep.id) || [];
    const head = cues.find((c) => upgradable(ep, c));
    if (head) return take(ep, head, (c) => upgradable(ep, c));
  }
  return null;
}

function contextFor(ep, batch) {
  const cues = cuesById.get(ep.id);
  const i0 = cues.indexOf(batch[0]), i1 = cues.indexOf(batch[batch.length - 1]);
  return {
    show: ep.show,
    before: cues.slice(Math.max(0, i0 - 6), i0).filter((c) => c.english).map((c) => ({ he: c.hebrew, en: c.english })),
    after: cues.slice(i1 + 1, i1 + 4).filter((c) => c.hebrew).map((c) => c.hebrew),
  };
}

const toB64 = (blob) => new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.readAsDataURL(blob); });

// Up to 3 batches at once: same cost, ~3x faster, so preparing keeps up with the fast scanner.
const AI_PARALLEL = 3;
function aiPump() {
  while (AI.running < AI_PARALLEL && aiActive()) {
    const job = pickAiBatch();
    if (!job || !job.batch.length) break;
    for (const c of job.batch) { c.aiBusy = true; if (c.status === 'hebrew') c.status = 'ai'; }
    AI.running++;
    runAiJob(job).catch((e) => console.warn('AI batch failed', e)).finally(() => { AI.running--; aiPump(); });
  }
}

async function runAiJob(job) {
  const { ep, batch, kind } = job;
  const cues = cuesById.get(ep.id);
  changed(ep, batch);
  const sent = batch.map((c) => c.hebrew);
  const body = contextFor(ep, batch);
  let res;
  try {
    if (kind === 'image') {
      body.lines = [];
      for (const [k, c] of batch.entries()) {
        const blob = await DB.get('blobs', `${ep.id}/${c.id}`);
        body.lines.push({ n: k + 1, he: c.hebrew, img: blob ? await toB64(blob) : '' });
      }
      body.lines = body.lines.filter((l) => l.img);
      res = await relay('/read', body);
    } else {
      body.lines = batch.map((c, k) => ({ n: k + 1, he: c.hebrew }));
      res = await relay('/polish', body);
    }
  } catch (e) {
    for (const c of batch) { delete c.aiBusy; if (c.status === 'ai') c.status = 'hebrew'; }
    changed(ep, batch);
    aiFailed(e);
    return;
  }
  if (res.usage) AI.spent += res.usage.cost;
  const removed = [];
  batch.forEach((c, k) => {
    delete c.aiBusy;
    const it = (res.items || []).find((x) => x.n === k + 1);
    if (!it || c.hebrew !== sent[k] || !cues.includes(c)) { if (c.status === 'ai') c.status = 'hebrew'; c.aiTried = true; return; }
    if (kind === 'image' && it.not_text && !c.edited) { cues.splice(cues.indexOf(c), 1); removed.push(c.id); return; }
    if (kind === 'text' && it.unsure && !c.edited && AI.settings.imageModel !== 'off' && !c.forcePicture) {
      // Claude can't tell from the text: read it from the picture next.
      c.forcePicture = true; if (c.status === 'ai') c.status = 'hebrew'; return;
    }
    const he = aiText(it.hebrew), en = aiText(it.english);
    if (!c.edited && he) c.hebrew = he;
    else if (!c.edited && !he && en) c.hebrew = en; // non-Hebrew on screen (e.g. English song lyrics)
    c.english = rewrap(en, c.hebrew);
    c.status = 'done'; c.source = 'ai'; c.urgent = false; c.error = null; c.aiTried = true;
    if (!c.edited) c.confidence = Math.max(c.confidence ?? 0, it.unsure ? 0.5 : 0.9);
  });
  const gone = mergeSame(ep, cues);
  saveCues(ep.id);
  const touched = cues.filter((x) => x._touched); touched.forEach((x) => delete x._touched);
  changed(ep, batch.filter((c) => cues.includes(c)).concat(touched), removed.concat(gone.map((x) => x.id)));
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
  if (ep.status === 'ready') return { dot: 'ok', text: `Ready · ${progressOf(ep).total} lines${ep.shared === 'imported' ? ' · shared, no processing needed' : ep.shared === 'shared' ? ' · shared for others' : ''}` };
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
          ${(ep.scanVersion || 1) < SCANNER_VERSION ? '<button class="btn small" data-act="redo" title="Read this episode again with the improved, frame-accurate timing">Redo subtitles</button>' : ''}
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
  if (act === 'redo') {
    if (!confirm(`Read "${ep.title}" again with the improved timing?\n\nIts current subtitles (and any edits) are replaced. With AI polish on this costs about the same as the first time (cents).`)) return;
    await redoEpisode(ep.id);
    if (!files.has(ep.id)) toast('Open the episode to start reading it again.');
  }
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
  computeBand();
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
  if (!ep.fp && files.has(ep.id)) fingerprint(files.get(ep.id)).then((fp) => { ep.fp = fp; saveEp(ep); updateStatus(ep); }).catch(() => {});
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
  scheduleBand();
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
  if (TR.state !== 'ready' && !aiActive() && ep.status !== 'ready') {
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
    if (aiActive()) msg += ' · AI';
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

// Subtitle timings are frame-accurate (±0.05 s), so the English appears and disappears with the Hebrew.
const LEAD = 0.04, LAG = 0.04;
function cueAt(t) {
  let lo = 0, hi = P.cues.length - 1, best = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (P.cues[mid].start - LEAD <= t) { best = mid; lo = mid + 1; } else hi = mid - 1; }
  for (let i = best; i != null && i >= 0 && i >= best - 2; i--) {
    const c = P.cues[i];
    if (t >= c.start - LEAD && t < c.end + LAG) return c;
  }
  return null;
}

// ---- fixed subtitle box ----
// One box per episode, always the same size and position: it covers the area where the burned-in
// Hebrew subtitles sit (learned from all detected lines, wide and tall enough for two-line
// subtitles). Lines shown elsewhere on screen (credits, name tags) get their own box.
const pct = (arr, p) => { const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))]; };
const DEFAULT_BAND = { cx: 0.5, w: 0.64, bottom: 0.955, h: 0.14 }; // typical TV subtitle area, until learned
let bandTimer = null;
function scheduleBand() { if (P.ep?.band?.final) return; clearTimeout(bandTimer); bandTimer = setTimeout(() => { computeBand(); renderOverlay(true); }, 800); }
function computeBand() {
  const ep = P.ep;
  if (!ep) return;
  if (ep.band && ep.band.final) { P.band = ep.band; return; }
  const all = P.cues.filter((c) => c.bbox && c.hebrew);
  const medBottom = all.length ? pct(all.map((c) => c.bbox[1] + c.bbox[3]), 0.5) : 0;
  const main = all.filter((c) => Math.abs(c.bbox[1] + c.bbox[3] - medBottom) < 0.05 && Math.abs(c.bbox[0] + c.bbox[2] / 2 - 0.5) < 0.15);
  if (main.length < 12) { P.band = ep.band || DEFAULT_BAND; return; }
  // Size it from ordinary one- and two-line subtitles only (multi-line credit blocks would bloat it).
  const lineH = pct(main.filter((c) => c.hebrew.split('\n').length === 1).map((c) => c.bbox[3]), 0.5) || 0.045;
  const normal = main.filter((c) => c.hebrew.split('\n').length <= 2 && c.bbox[3] < lineH * 3.2);
  if (normal.length < 10) { P.band = ep.band || DEFAULT_BAND; return; }
  const cx = pct(normal.map((c) => c.bbox[0] + c.bbox[2] / 2), 0.5);
  const half = Math.max(cx - pct(normal.map((c) => c.bbox[0]), 0.05), pct(normal.map((c) => c.bbox[0] + c.bbox[2]), 0.95) - cx);
  const bottom = pct(normal.map((c) => c.bbox[1] + c.bbox[3]), 0.9);
  const twos = normal.filter((c) => c.bbox[3] > lineH * 1.6);
  const top = twos.length >= 4 ? pct(twos.map((c) => c.bbox[1]), 0.1) : bottom - lineH * 2.4;
  // Once enough lines are seen the box is fixed for good, so it never shifts while watching.
  ep.band = { cx, w: Math.min(0.96, half * 2), bottom: Math.min(0.995, bottom), h: Math.max(0.06, bottom - top), final: normal.length >= 60 };
  saveEp(ep);
  P.band = ep.band;
}
function inBand(c) {
  const b = P.band, [bx, by, bw, bh] = c.bbox;
  return !!b && Math.abs(by + bh - b.bottom) < 0.07 && bx + bw / 2 > b.cx - b.w / 2 && bx + bw / 2 < b.cx + b.w / 2;
}
const bandBox = () => { const b = P.band; return [b.cx - b.w / 2, b.bottom - b.h, b.cx + b.w / 2, b.bottom]; };
function boxFor(c) {
  if (inBand(c)) return { box: bandBox(), band: true };
  const [bx, by, bw, bh] = c.bbox;
  return { box: [bx, by, bx + bw, by + bh], band: false };
}

P.scale = Math.min(1.8, Math.max(0.6, Number(localStorage.getItem('subScale')) || 1));
function setScale(v) {
  P.scale = Math.round(Math.min(1.8, Math.max(0.6, v)) * 10) / 10;
  localStorage.setItem('subScale', String(P.scale));
  $('#size-val').textContent = Math.round(P.scale * 100) + '%';
  renderOverlay(true);
}

let shownKey = '';
function renderOverlay(force) {
  if (!P.ep) return;
  const t = video.currentTime;
  let c = cueAt(t);
  const mode = P.mode;
  // Short gap between two lines in the usual spot: keep the (empty) box up instead of flickering.
  let bridge = false;
  if (!c && P.band) {
    const next = P.cues.find((x) => x.start - 0.18 > t);
    const prev = [...P.cues].reverse().find((x) => x.end + 0.12 < t);
    if (prev && next && next.start - prev.end < 0.7 && inBand(prev) && inBand(next) && prev.english && next.english) bridge = true;
  }
  const key = c ? `${c.id}|${c.status}|${c.english}|${c.hebrew}|${mode}|${vrect.w}|${vrect.h}|${P.scale}|${JSON.stringify(P.band)}` : `none|${bridge}|${mode}|${P.scale}`;
  if (!force && key === shownKey) return;
  shownKey = key;
  const ov = $('#overlay');
  if ((c?.id || null) !== P.activeId) { P.activeId = c?.id || null; markActive(); }
  const font = Math.max(12, vrect.h * 0.043 * P.scale);
  const padX = font * 0.7, padY = font * 0.32;
  const place = (box, text, fixed) => {
    const [x0, y0, x1, y1] = box;
    const width = Math.min((x1 - x0) * vrect.w + padX * 2, vrect.w * 0.98);
    const height = (y1 - y0) * vrect.h + padY * 2;
    const left = ((x0 + x1) / 2) * vrect.w;
    const bottom = Math.max(0, vrect.h - y1 * vrect.h - padY);
    return `<div class="sub-box${fixed ? ' fixed' : ''}" style="left:${left}px;bottom:${bottom}px;width:${width}px;${fixed ? 'height' : 'min-height'}:${height}px;font-size:${font}px">${text}</div>`;
  };
  if (!c && bridge && mode !== 'off') { ov.innerHTML = place(bandBox(), '', true); return; }
  if (!c || mode === 'off' || (mode === 'he' ? !c.hebrew : !c.english)) { ov.innerHTML = ''; return; }
  let html;
  if (mode === 'en') html = `<div>${esc(c.english)}</div>`;
  else if (mode === 'he') html = `<div class="he">${esc(c.hebrew)}</div>`;
  else html = `<div>${esc(c.english)}</div><div class="he small">${esc(c.hebrew)}</div>`;
  const { box, band } = boxFor(c);
  ov.innerHTML = place(box, html, band);
  // Fixed box: a very long line shrinks a little to fit instead of growing the box.
  const el = ov.firstChild;
  let f = font;
  while (band && el.scrollHeight > el.clientHeight + 1 && f > font * 0.7) { f *= 0.93; el.style.fontSize = f + 'px'; }
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
$('#size-down').onclick = () => setScale(P.scale - 0.1);
$('#size-up').onclick = () => setScale(P.scale + 0.1);
$('#size-val').textContent = Math.round(P.scale * 100) + '%';
$('#size-val').onclick = () => setScale(1);
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
  else if (k === '-' || k === '_') setScale(P.scale - 0.1);
  else if (k === '=' || k === '+') setScale(P.scale + 0.1);
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
  if (c.status === 'hebrew' || c.status === 'translating' || c.status === 'ai') badges.push('<span class="badge">Translating…</span>');
  if (c.source === 'ai' && c.status === 'done') badges.push('<span class="badge" title="Fixed and translated by Claude">AI</span>');
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
    c.hebrew = value; c.edited = true; c.confidence = 1; c.english = ''; c.status = 'hebrew'; c.urgent = true; c.hebrewAt = 0; c.aiTried = false;
    toast(TR.translator ? 'Re-translating this line…' : 'Saved. English will update once translation is on.', 1800);
    aiPump(); translatePump();
  } else { c.english = value; c.edited = true; c.status = 'done'; c.urgent = false; }
  saveCues(P.id);
  changed(P.ep, [c]);
  if (P.ep.shared) { P.ep.shared = 'edited'; P.ep.editedSinceImport = true; }
}

// =====================================================================
// AI settings dialog
// =====================================================================
function updateAiUi() {
  const s = $('#ai-status'), btn = $('#ai-btn');
  let text, dot;
  if (!relayConfigured()) { text = 'Not set up on this site.'; dot = ''; }
  else if (!AI.reachable) { text = 'Can\'t reach the AI service right now — using the offline method.'; dot = 'bad'; }
  else if (!AI.configured) { text = 'The AI service has no Claude key yet.'; dot = 'bad'; }
  else if (!AI.enabled) { text = 'Turned off by the site owner — using the offline method.'; dot = ''; }
  else if (Date.now() < AI.backoffUntil) { text = `Paused for a few minutes (${AI.lastError}) — using the offline method meanwhile.`; dot = 'busy'; }
  else { text = 'Available — Claude fixes and translates the subtitles.'; dot = 'ok'; }
  s.innerHTML = `<span class="dot ${dot}"></span>${esc(text)}`;
  $('#ai-viewer').checked = AI.viewerOn;
  btn.classList.toggle('on', aiActive());
  btn.title = aiActive() ? 'AI polish is on' : 'AI polish is off';
  updateTrUi();
}
$('#ai-btn').onclick = () => { aiStatus(); $('#ai-dialog').classList.remove('hidden'); $('#owner-token').value = localStorage.getItem('aiOwnerToken') || ''; };
$('#ai-close').onclick = () => $('#ai-dialog').classList.add('hidden');
$('#ai-dialog').addEventListener('click', (e) => { if (e.target.id === 'ai-dialog') $('#ai-dialog').classList.add('hidden'); });
$('#ai-viewer').onchange = (e) => {
  AI.viewerOn = e.target.checked;
  localStorage.setItem('aiOff', AI.viewerOn ? '0' : '1');
  updateAiUi();
  if (aiActive()) aiPump(); else translatePump();
};
async function ownerCall(extra) {
  const token = $('#owner-token').value.trim();
  const msg = $('#owner-msg');
  if (!relayConfigured()) { msg.textContent = 'The AI service isn\'t set up yet.'; return null; }
  try {
    const r = await fetch(RELAY_URL + '/admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, ...extra }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Failed');
    localStorage.setItem('aiOwnerToken', token);
    showOwner(j);
    aiStatus();
    return j;
  } catch (e) { msg.textContent = e.message; return null; }
}
const usd = (v) => (v < 0.01 && v > 0 ? '< $0.01' : '$' + v.toFixed(2));
function showOwner(j) {
  $('#owner-tune').classList.remove('hidden');
  const u = j.usage || {};
  const t = u.today || { cost: 0, lines: 0 }, m = u.last30 || { cost: 0, lines: 0 };
  $('#owner-usage').innerHTML = `AI is <b>${j.enabled ? 'ON' : 'OFF'}</b> for everyone.<br>Spent today: <b>${usd(t.cost)}</b> (${t.lines} lines) · Last 30 days: <b>${usd(m.cost)}</b> (${m.lines} lines)` +
    (m.lines ? `<br>Average: ${usd(m.cost / m.lines * 900)} per ~900-line episode` : '');
  const s = j.settings || AI.settings;
  $('#t-image').value = s.imageModel;
  $('#t-thr').value = String([0, 0.75, 0.85, 0.95, 1.01].reduce((a, b) => (Math.abs(b - s.threshold) < Math.abs(a - s.threshold) ? b : a)));
  $('#t-think').value = s.think;
}
$('#owner-on').onclick = async () => { if (await ownerCall({ enabled: true })) $('#owner-msg').textContent = 'AI is now ON for everyone.'; };
$('#owner-off').onclick = async () => { if (await ownerCall({ enabled: false })) $('#owner-msg').textContent = 'AI is now OFF for everyone.'; };
$('#owner-load').onclick = async () => { if (await ownerCall({})) $('#owner-msg').textContent = ''; };
$('#t-save').onclick = async () => {
  const settings = { imageModel: $('#t-image').value, threshold: Number($('#t-thr').value), think: $('#t-think').value };
  if (await ownerCall({ settings })) $('#owner-msg').textContent = 'Saved. New lines use these settings.';
};

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
    for (const c of cues) { if (c.status === 'ocr') c.status = 'pending'; if (c.status === 'translating' || c.status === 'ai') c.status = 'hebrew'; }
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
  aiStatus();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
