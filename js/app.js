// Основной модуль интерфейса.
import * as Store from './storage.js';
import { STRINGS, KEYBOARDS, ALPHABET, letterFromCode } from './i18n.js';
import { APP_VERSION } from './version.js';
import { SIZES } from './generator.js';
import { initUpdates, checkNow, applyUpdate, dismiss } from './update.js';

const $ = (s) => document.querySelector(s);
const ARR = { r: '→', d: '↓', dr: '↳', rd: '↴' };
const ARR_ORDER = { r: 0, rd: 1, dr: 2, d: 3 };
const GEN_TIMEOUT = 10000;

let S = null;          // настройки
let T = null;          // строки интерфейса
let P = null;          // текущий сканворд (запись хранилища)
let G = null;          // производная сетка
let fill = [], flags = [];
let cur = null;        // {i, d}
let solvedSet = new Set();
let zoom = 1, baseCell = 40;
let physicalKbd = false;
let saveTimer = 0;
let busy = false;
let prefetch = null;   // {key, promise}

// ---------- запуск ----------
function boot() {
  Store.init();
  S = Store.getSettings();
  applyTheme();
  applyLang();
  bindUI();
  loadOrCreate();
  setInterval(tick, 1000);
  initUpdates(showUpdateBanner);
  Store.requestPersist();
  if (!Store.storageAvailable()) setTimeout(() => toast('localStorage недоступен — прогресс не сохранится'), 800);
}

function applyTheme() {
  const dark = S.theme === 'dark' || (S.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.setProperty('--clue-scale', S.clueScale);
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => S && applyTheme());

function applyLang() {
  T = STRINGS[S.lang];
  document.documentElement.lang = S.lang === 'uk' ? 'uk' : 'ru';
  document.title = T.appName;
  document.querySelectorAll('[data-t]').forEach(el => { el.textContent = T[el.dataset.t]; });
  document.querySelectorAll('#lang-seg button').forEach(b => b.classList.toggle('on', b.dataset.lang === S.lang));
  buildKeyboard();
}

// ---------- генерация ----------
let worker = null;
let reqId = 0;
const waiting = new Map();

function getWorker() {
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./gen-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => { const w = waiting.get(e.data.id); if (w) { waiting.delete(e.data.id); w.resolve(e.data); } };
    worker.onerror = (e) => { console.warn('worker error', e); killWorker(); };
  } catch (e) { console.warn('worker недоступен', e); worker = null; }
  return worker;
}
function killWorker() {
  if (worker) { try { worker.terminate(); } catch { /* */ } }
  worker = null;
  for (const w of waiting.values()) w.resolve({ ok: false, error: 'worker died' });
  waiting.clear();
}

function recentWords(lang) {
  const used = Store.getUsed(lang);
  for (const p of Store.getGames(lang).list) for (const w of p.words) used.push(w.a);
  return used;
}

// Сторожевой таймер: если воркер молчит — останавливаем и пробуем снова, затем в основном потоке.
async function requestPuzzle(lang, size, diff) {
  const msg = { lang, size, diff, recent: recentWords(lang), v: APP_VERSION };
  for (let attempt = 0; attempt < 2; attempt++) {
    const w = getWorker();
    if (!w) break;
    const id = ++reqId;
    const res = await new Promise((resolve) => {
      waiting.set(id, { resolve });
      w.postMessage({ ...msg, id, seed: (Math.random() * 2 ** 32) >>> 0 });
      setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); killWorker(); resolve({ ok: false, error: 'timeout' }); } }, GEN_TIMEOUT);
    });
    if (res.ok) return res;
  }
  // запасной путь без воркера
  try {
    const G2 = await import('./generator.js');
    const text = await (await fetch(`dict/${lang}.txt?v=${APP_VERSION}`)).text();
    const { puzzle } = G2.generate(G2.buildIndex(G2.parseDict(text)), {
      size, diff, seed: (Math.random() * 2 ** 32) >>> 0, recent: new Set(msg.recent), totalBudget: 2500,
    });
    if (puzzle) return { ok: true, puzzle };
    const fb = await (await fetch(`dict/fallback-${lang}.json?v=${APP_VERSION}`)).json();
    const list = fb.filter(p => p.size === size);
    if (list.length) return { ok: true, puzzle: list[Math.floor(Math.random() * list.length)], fallback: true };
  } catch (e) { console.warn(e); }
  return { ok: false };
}

const prefetchKey = () => `${S.lang}|${S.size}|${S.diff}`;
function startPrefetch() {
  const key = prefetchKey();
  if (prefetch && prefetch.key === key) return;
  const { lang, size, diff } = S;
  prefetch = { key, promise: new Promise(r => setTimeout(r, 1500)).then(() => requestPuzzle(lang, size, diff)) };
}

function makeRecord(gen, lang, size, diff) {
  const now = Date.now();
  const n = gen.w * gen.h;
  return {
    id: now.toString(36) + Math.random().toString(36).slice(2, 7),
    v: 1, lang, size, diff, seed: gen.seed || 0,
    w: gen.w, h: gen.h, created: now, opened: now,
    words: gen.words.map(w => ({ a: w.ans, q: w.clue, d: w.d, r: w.r, c: w.c, cr: w.cr, cc: w.cc, ar: w.arrow })),
    fill: '.'.repeat(n), flags: '.'.repeat(n),
    hints: { r: S.hintReveal, c: S.hintCheck }, used: { r: 0, c: 0 },
    time: 0, solved: false, solvedAt: 0,
  };
}

async function newPuzzle() {
  if (busy) return;
  busy = true;
  flushSave();
  showLoading(true);
  try {
    let res = null;
    const key = prefetchKey();
    if (prefetch && prefetch.key === key) { res = await prefetch.promise; prefetch = null; }
    if (!res || !res.ok) res = await requestPuzzle(S.lang, S.size, S.diff);
    if (!res.ok) { toast('Ошибка генерации'); return; }
    if (res.fallback) toast(T.genFailed);
    const rec = makeRecord(res.puzzle, S.lang, S.size, S.diff);
    Store.addPuzzle(S.lang, rec);
    Store.addUsed(S.lang, rec.words.map(w => w.a));
    setPuzzle(rec);
  } finally {
    busy = false;
    showLoading(false);
    startPrefetch();
  }
}

function loadOrCreate() {
  const p = Store.getCurrent(S.lang);
  if (p) { setPuzzle(p); startPrefetch(); }
  else newPuzzle();
}

function showLoading(on) {
  $('#loading').hidden = !on;
  $('#loading-text').textContent = T.generating;
}

// ---------- модель сетки ----------
function buildGrid(p) {
  const n = p.w * p.h;
  const cells = Array.from({ length: n }, () => ({ t: 'E', sol: '', h: -1, v: -1, q: [] }));
  const words = p.words.map((w, wi) => {
    const dr = w.d === 'v' ? 1 : 0, dc = w.d === 'h' ? 1 : 0;
    const idx = [];
    for (let k = 0; k < w.a.length; k++) {
      const i = (w.r + dr * k) * p.w + (w.c + dc * k);
      idx.push(i);
      cells[i].t = 'L'; cells[i].sol = w.a[k]; cells[i][w.d] = wi;
    }
    const ci = w.cr * p.w + w.cc;
    cells[ci].t = 'Q'; cells[ci].q.push(wi);
    return { ...w, cells: idx, ci };
  });
  for (const c of cells) if (c.q.length > 1) c.q.sort((a, b) => ARR_ORDER[words[a].ar] - ARR_ORDER[words[b].ar]);
  const order = words.map((_, i) => i).sort((a, b) => (words[a].ci - words[b].ci) || (ARR_ORDER[words[a].ar] - ARR_ORDER[words[b].ar]));
  order.forEach((wi, n2) => { words[wi].num = n2 + 1; });
  return { w: p.w, h: p.h, cells, words, order };
}

const isSolvedWord = (wi) => G.words[wi].cells.every(i => fill[i] === G.cells[i].sol);
const locked = (i) => flags[i] === 'r' || (G.cells[i].h >= 0 && solvedSet.has(G.cells[i].h)) || (G.cells[i].v >= 0 && solvedSet.has(G.cells[i].v));

function recomputeSolved() {
  const before = solvedSet;
  solvedSet = new Set();
  G.words.forEach((_, wi) => { if (isSolvedWord(wi)) solvedSet.add(wi); });
  const fresh = [...solvedSet].filter(wi => !before.has(wi));
  return fresh;
}

function setPuzzle(p) {
  P = p;
  G = buildGrid(p);
  fill = p.fill.split('');
  flags = p.flags.split('');
  recomputeSolved();
  zoom = 1;
  renderBoard();
  renderClueList();
  const first = G.order.find(wi => !solvedSet.has(wi)) ?? G.order[0];
  cur = null;
  if (first != null && !p.solved) selectWord(first);
  paint();
  updateHud();
}

// ---------- отрисовка ----------
function clueK(text, two) {
  const L = text.length;
  let k = L <= 8 ? .23 : L <= 13 ? .2 : L <= 18 ? .18 : L <= 24 ? .165 : .15;
  if (two) k *= .8;
  return k;
}

function renderBoard() {
  const b = $('#board');
  b.style.gridTemplateColumns = `repeat(${G.w}, var(--cellpx))`;
  b.textContent = '';
  const frag = document.createDocumentFragment();
  G.cells.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'cell ' + c.t;
    el.dataset.i = i;
    if (c.t === 'L') {
      const s = document.createElement('span'); s.className = 'ch'; el.appendChild(s);
    } else if (c.t === 'Q') {
      if (c.q.length > 1) el.classList.add('two');
      for (const wi of c.q) {
        const w = G.words[wi];
        const q = document.createElement('div');
        q.className = 'q'; q.dataset.w = wi;
        q.style.setProperty('--k', clueK(w.q, c.q.length > 1));
        q.innerHTML = `<span class="qt"></span><span class="arr ${w.ar}">${ARR[w.ar]}</span>`;
        q.firstChild.textContent = w.q;
        el.appendChild(q);
      }
    }
    frag.appendChild(el);
  });
  b.appendChild(frag);
  fitBoard();
}

function fitBoard() {
  if (!G) return;
  const sc = $('#scroller');
  const availW = sc.clientWidth - 24 - 6, availH = sc.clientHeight - 24 - 6;
  baseCell = Math.max(26, Math.min(96, Math.floor(Math.min((availW - G.w) / G.w, (availH - G.h) / G.h))));
  applyZoom();
}
function applyZoom() {
  document.documentElement.style.setProperty('--cellpx', Math.round(baseCell * zoom) + 'px');
}

function paint() {
  if (!G) return;
  const els = $('#board').children;
  const wordCells = cur ? new Set(G.words[curWord()].cells) : new Set();
  for (let i = 0; i < els.length; i++) {
    const c = G.cells[i];
    if (c.t !== 'L') continue;
    const el = els[i];
    el.firstChild.textContent = fill[i] === '.' ? '' : fill[i];
    const ok = (c.h >= 0 && solvedSet.has(c.h)) || (c.v >= 0 && solvedSet.has(c.v));
    el.className = 'cell L' + (wordCells.has(i) ? ' hl' : '') + (cur && cur.i === i ? ' cur' : '')
      + (ok ? ' ok' : '') + (flags[i] === 'r' ? ' rev' : '') + (flags[i] === 'x' ? ' x' : '');
  }
  document.querySelectorAll('#board .q').forEach(q => {
    const wi = +q.dataset.w;
    q.classList.toggle('active', !!cur && wi === curWord());
    q.classList.toggle('done', solvedSet.has(wi));
  });
  // строка вопроса
  if (cur) {
    const w = G.words[curWord()];
    $('#clue-arr').textContent = ARR[w.ar];
    $('#clue-text').textContent = w.q;
    $('#clue-len').textContent = `(${w.a.length})`;
  } else {
    $('#clue-arr').textContent = ''; $('#clue-text').textContent = P && P.solved ? T.solvedTitle : ''; $('#clue-len').textContent = '';
  }
  document.querySelectorAll('#cluelist .cl-i').forEach(el => {
    const wi = +el.dataset.w;
    el.classList.toggle('done', solvedSet.has(wi));
    const on = !!cur && wi === curWord();
    if (on && !el.classList.contains('on')) el.scrollIntoView({ block: 'nearest' });
    el.classList.toggle('on', on);
  });
}

function renderClueList() {
  const box = $('#cluelist');
  box.textContent = '';
  for (const d of ['h', 'v']) {
    const h = document.createElement('div'); h.className = 'cl-h'; h.textContent = d === 'h' ? T.across : T.down;
    box.appendChild(h);
    for (const wi of G.order) {
      const w = G.words[wi];
      if (w.d !== d) continue;
      const el = document.createElement('div');
      el.className = 'cl-i'; el.dataset.w = wi;
      el.innerHTML = `<span class="n"></span><span class="t"></span>`;
      el.firstChild.textContent = w.num + '.';
      el.lastChild.textContent = `${w.q} (${w.a.length})`;
      box.appendChild(el);
    }
  }
}

function updateHud() {
  if (!P) return;
  const lr = P.hints.r - P.used.r, lc = P.hints.c - P.used.c;
  $('#cnt-reveal').textContent = lr; $('#cnt-reveal').classList.toggle('zero', lr <= 0);
  $('#cnt-check').textContent = lc; $('#cnt-check').classList.toggle('zero', lc <= 0);
  $('#btn-reveal').disabled = P.solved; $('#btn-check').disabled = P.solved;
  $('#timer').textContent = fmtTime(P.time);
  $('#kbd').hidden = S.kbdHidden || physicalKbd || P.solved;
}

function fmtTime(s) {
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(ss).padStart(2, '0');
}

// ---------- выбор и ввод ----------
const curWord = () => G.cells[cur.i][cur.d];

function selectWord(wi, toFirstEmpty = true) {
  const w = G.words[wi];
  let i = w.cells[0];
  if (toFirstEmpty) {
    const e = w.cells.find(x => fill[x] === '.' && !locked(x)) ?? w.cells.find(x => !locked(x));
    if (e != null) i = e;
  }
  cur = { i, d: w.d };
  paint();
  scrollToCur();
}

function selectCell(i) {
  const c = G.cells[i];
  if (c.t === 'Q') {
    const ws = c.q;
    const k = cur ? ws.indexOf(curWord()) : -1;
    selectWord(ws[(k + 1) % ws.length]);
    return;
  }
  if (c.t !== 'L') return;
  if (cur && cur.i === i) {
    const other = cur.d === 'h' ? 'v' : 'h';
    if (c[other] >= 0) cur.d = other;
  } else {
    const pref = cur ? cur.d : 'h';
    cur = { i, d: c[pref] >= 0 ? pref : (pref === 'h' ? 'v' : 'h') };
  }
  paint();
}

function scrollToCur() {
  if (!cur || zoom <= 1.01) return;
  const el = $('#board').children[cur.i];
  el && el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function nextInWord(fromIdx, step) {
  const cells = G.words[curWord()].cells;
  let k = cells.indexOf(fromIdx) + step;
  while (k >= 0 && k < cells.length) {
    if (!locked(cells[k])) return cells[k];
    k += step;
  }
  return null;
}

function gotoNextWord(step = 1) {
  if (!cur) { const f = G.order.find(wi => !solvedSet.has(wi)); if (f != null) selectWord(f); return; }
  const pos = G.order.indexOf(curWord());
  for (let t = 1; t <= G.order.length; t++) {
    const wi = G.order[(pos + step * t + G.order.length * 2) % G.order.length];
    if (!solvedSet.has(wi)) { selectWord(wi); return; }
  }
}

function input(ch) {
  if (!P || P.solved || !cur) return;
  let i = cur.i;
  if (locked(i)) {
    const n = nextInWord(i, 1);
    if (n == null) { gotoNextWord(); return; }
    i = n;
  }
  fill[i] = ch;
  if (flags[i] === 'x') flags[i] = '.';
  const wordBefore = curWord();
  const fresh = recomputeSolved();
  if (fresh.length) popWords(fresh);
  if (solvedSet.size === G.words.length) { cur = { i, d: cur.d }; finish(); return; }
  if (solvedSet.has(wordBefore)) { gotoNextWord(); }
  else {
    const n = nextInWord(i, 1);
    cur = { i: n ?? i, d: cur.d };
    paint(); scrollToCur();
  }
  scheduleSave();
}

function backspace() {
  if (!P || P.solved || !cur) return;
  const i = cur.i;
  if (fill[i] !== '.' && !locked(i)) { fill[i] = '.'; flags[i] = '.'; }
  else {
    const p = nextInWord(i, -1);
    if (p != null) { cur.i = p; fill[p] = '.'; flags[p] = '.'; }
  }
  recomputeSolved();
  paint(); scheduleSave();
}

function moveArrow(dr, dc) {
  if (!cur) return;
  let r = Math.floor(cur.i / G.w), c = cur.i % G.w;
  const axis = dc ? 'h' : 'v';
  for (;;) {
    r += dr; c += dc;
    if (r < 0 || c < 0 || r >= G.h || c >= G.w) return;
    const i = r * G.w + c;
    if (G.cells[i].t === 'L') {
      const cell = G.cells[i];
      cur = { i, d: cell[axis] >= 0 ? axis : (axis === 'h' ? 'v' : 'h') };
      paint(); scrollToCur(); return;
    }
  }
}

function popWords(wis) {
  const els = $('#board').children;
  for (const wi of wis) for (const i of G.words[wi].cells) {
    const el = els[i]; el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
  }
}

// ---------- подсказки ----------
function reveal() {
  if (!P || P.solved) return;
  if (P.hints.r - P.used.r <= 0) { toast(T.noHints); return; }
  if (!cur) { toast(T.selectCell); return; }
  let i = cur.i;
  if (locked(i) || fill[i] === G.cells[i].sol) {
    const w = G.words[curWord()];
    const k = w.cells.find(x => !locked(x) && fill[x] !== G.cells[x].sol);
    if (k == null) { gotoNextWord(); return; }
    i = k;
  }
  fill[i] = G.cells[i].sol; flags[i] = 'r';
  P.used.r++;
  cur.i = i;
  const fresh = recomputeSolved();
  if (fresh.length) popWords(fresh);
  updateHud();
  if (solvedSet.size === G.words.length) { finish(); return; }
  if (solvedSet.has(curWord())) gotoNextWord(); else paint();
  scheduleSave();
}

function check() {
  if (!P || P.solved) return;
  if (P.hints.c - P.used.c <= 0) { toast(T.noHints); return; }
  let n = 0;
  G.cells.forEach((c, i) => { if (c.t === 'L' && fill[i] !== '.' && fill[i] !== c.sol && flags[i] !== 'r') { flags[i] = 'x'; n++; } });
  P.used.c++;
  toast(n ? T.errorsFound(n) : T.noErrors);
  updateHud(); paint(); scheduleSave();
}

// ---------- завершение ----------
function finish() {
  P.solved = true; P.solvedAt = Date.now();
  cur = null;
  saveNow();
  Store.recordSolved(P);
  paint(); updateHud();
  const hints = P.used.r + P.used.c;
  openDialog(`
    <div class="win-big">★</div>
    <h2 style="text-align:center">${esc(T.solvedTitle)}</h2>
    <p style="text-align:center">${esc(T.solvedText(fmtTime(P.time), hints))}</p>
    <div class="dlg-actions" style="justify-content:center">
      <button class="btn plain" value="close">${esc(T.close)}</button>
      <button class="btn primary" value="next" id="win-next">${esc(T.next)}</button>
    </div>`, (v) => { if (v === 'next') newPuzzle(); });
}

// ---------- сохранение ----------
function syncRecord() {
  if (!P) return;
  P.fill = fill.join('');
  P.flags = flags.join('');
}
function saveNow() { if (!P) return; clearTimeout(saveTimer); saveTimer = 0; syncRecord(); Store.savePuzzle(P); }
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); }
function flushSave() { saveNow(); }
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
window.addEventListener('pagehide', flushSave);

let tickN = 0;
function tick() {
  if (!P || P.solved || document.hidden || $('#dlg').open || busy) return;
  P.time++;
  $('#timer').textContent = fmtTime(P.time);
  if (++tickN % 10 === 0) saveNow();
}

// ---------- клавиатура ----------
function buildKeyboard() {
  const k = $('#kbd');
  k.textContent = '';
  const rows = KEYBOARDS[S.lang];
  rows.forEach((row, ri) => {
    const r = document.createElement('div'); r.className = 'krow';
    for (const ch of row) {
      const b = document.createElement('button'); b.className = 'key'; b.textContent = ch; b.dataset.k = ch;
      r.appendChild(b);
    }
    if (ri === rows.length - 1) {
      const b = document.createElement('button'); b.className = 'key wide'; b.textContent = '⌫'; b.dataset.k = 'BS';
      r.appendChild(b);
    }
    k.appendChild(r);
  });
}

function onKeyDown(e) {
  if ($('#dlg').open) return;
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  let handled = true;
  if (k === 'Backspace' || k === 'Delete') backspace();
  else if (k === 'ArrowLeft') moveArrow(0, -1);
  else if (k === 'ArrowRight') moveArrow(0, 1);
  else if (k === 'ArrowUp') moveArrow(-1, 0);
  else if (k === 'ArrowDown') moveArrow(1, 0);
  else if (k === 'Tab' || k === 'Enter') gotoNextWord(e.shiftKey ? -1 : 1);
  else if (k === ' ') { if (cur) selectCell(cur.i); }
  else {
    let ch = k && k.length === 1 ? k.toUpperCase().replace('Ё', 'Е') : '';
    if (!ALPHABET[S.lang].has(ch)) ch = letterFromCode(S.lang, e.code) || '';
    if (ch && ALPHABET[S.lang].has(ch)) {
      if (!physicalKbd) { physicalKbd = true; updateHud(); requestAnimationFrame(fitBoard); }
      input(ch);
    } else handled = false;
  }
  if (handled) e.preventDefault();
}

// ---------- зум ----------
function bindZoom() {
  const sc = $('#scroller');
  let pinch = null;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  sc.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      const rect = sc.getBoundingClientRect();
      const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
      const my = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
      pinch = { d0: dist(e.touches), z0: zoom, mx, my, cx: (sc.scrollLeft + mx) / (baseCell * zoom), cy: (sc.scrollTop + my) / (baseCell * zoom) };
      e.preventDefault();
    }
  }, { passive: false });
  sc.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    zoom = Math.min(3.5, Math.max(1, pinch.z0 * dist(e.touches) / pinch.d0));
    applyZoom();
    const cell = baseCell * zoom;
    sc.scrollLeft = pinch.cx * cell - pinch.mx;
    sc.scrollTop = pinch.cy * cell - pinch.my;
  }, { passive: false });
  sc.addEventListener('touchend', (e) => { if (pinch && e.touches.length < 2) { pinch = null; lastPinch = Date.now(); } });
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
  // колесо/трекпад с Ctrl — зум на iPad с трекпадом и на десктопе
  sc.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoom = Math.min(3.5, Math.max(1, zoom * (e.deltaY < 0 ? 1.08 : 0.93)));
    applyZoom();
  }, { passive: false });
  new ResizeObserver(() => fitBoard()).observe(sc);
}
let lastPinch = 0;

// ---------- привязки ----------
function bindUI() {
  $('#board').addEventListener('click', (e) => {
    if (Date.now() - lastPinch < 300) return;
    const q = e.target.closest('.q');
    if (q) { selectWord(+q.dataset.w); return; }
    const c = e.target.closest('.cell');
    if (c && P && !P.solved) selectCell(+c.dataset.i);
  });
  $('#kbd').addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.key');
    if (!b) return;
    e.preventDefault();
    b.classList.add('down'); setTimeout(() => b.classList.remove('down'), 120);
    if (b.dataset.k === 'BS') backspace(); else input(b.dataset.k);
  });
  $('#cluelist').addEventListener('click', (e) => {
    const it = e.target.closest('.cl-i');
    if (it && P && !P.solved) selectWord(+it.dataset.w);
  });
  $('#clue-prev').onclick = () => gotoNextWord(-1);
  $('#clue-next').onclick = () => gotoNextWord(1);
  $('#kbd-toggle').onclick = () => {
    if (physicalKbd) { physicalKbd = false; S.kbdHidden = false; }
    else S.kbdHidden = !S.kbdHidden;
    Store.setSettings(S); updateHud(); requestAnimationFrame(fitBoard);
  };
  $('#btn-reveal').onclick = reveal;
  $('#btn-check').onclick = check;
  $('#btn-new').onclick = newPuzzle;
  $('#btn-history').onclick = openHistory;
  $('#btn-stats').onclick = openStats;
  $('#btn-settings').onclick = openSettings;
  document.querySelectorAll('#lang-seg button').forEach(b => b.onclick = () => switchLang(b.dataset.lang));
  document.addEventListener('keydown', onKeyDown);
  bindZoom();
}

function switchLang(lang) {
  if (lang === S.lang || busy) return;
  flushSave();
  S.lang = lang; Store.setSettings(S);
  prefetch = null;
  applyLang();
  loadOrCreate();
}

// ---------- диалоги ----------
let dlgHandler = null;
function openDialog(html, onClose) {
  const d = $('#dlg');
  $('#dlg-body').innerHTML = html;
  dlgHandler = onClose || null;
  if (!d.open) d.showModal();
  return $('#dlg-body');
}
$('#dlg').addEventListener('close', () => {
  const v = $('#dlg').returnValue; $('#dlg').returnValue = '';
  const h = dlgHandler; dlgHandler = null;
  h && h(v);
});
$('#dlg').addEventListener('click', (e) => { if (e.target === $('#dlg')) $('#dlg').close(); });
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function openHistory() {
  flushSave();
  const g = Store.getGames(S.lang);
  const items = g.list.slice().sort((a, b) => (b.id === g.current) - (a.id === g.current) || b.opened - a.opened);
  const body = openDialog(`
    <h2>${esc(T.history)}</h2>
    <div class="hist">${items.length ? items.map(p => {
      const letters = new Set(); p.words.forEach(w => { for (let k = 0; k < w.a.length; k++) letters.add((w.r + (w.d === 'v' ? k : 0)) * p.w + w.c + (w.d === 'h' ? k : 0)); });
      let ok = 0; letters.forEach(i => { if (p.fill[i] !== '.') ok++; });
      const pct = Math.round(ok / Math.max(1, letters.size) * 100);
      const status = p.solved ? T.solved : T.progress(pct);
      const date = new Date(p.created).toLocaleDateString(S.lang === 'uk' ? 'uk-UA' : 'ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      return `<div class="hi ${p.id === g.current ? 'cur' : ''}" data-id="${p.id}">
        <canvas width="${p.w * 5}" height="${p.h * 5}" data-id="${p.id}" style="width:${p.w * 5}px;height:${p.h * 5}px"></canvas>
        <div class="meta"><b>${esc(T.sizes[p.size] || p.size)} ${p.w}×${p.h} · ${esc(T.diffs[p.diff] || p.diff)}</b>
          <span>${esc(status)} · ${fmtTime(p.time)}</span><span>${esc(date)}${p.id === g.current ? ' · ' + esc(T.current) : ''}</span></div>
        ${p.id === g.current ? '' : `<button type="button" class="btn plain" data-open="${p.id}">${esc(T.open)}</button>
        <button type="button" class="btn danger" data-del="${p.id}" aria-label="${esc(T.delete)}">✕</button>`}
      </div>`;
    }).join('') : `<p>${esc(T.emptyHistory)}</p>`}</div>
    <p class="note">${esc(T.persistNote)}</p>
    <div class="dlg-actions"><button class="btn plain" value="close">${esc(T.close)}</button></div>`);
  body.querySelectorAll('canvas').forEach(cv => drawThumb(cv, items.find(p => p.id === cv.dataset.id)));
  body.onclick = (e) => {
    const o = e.target.closest('[data-open]'), d = e.target.closest('[data-del]');
    if (o) { const p = Store.openPuzzle(S.lang, o.dataset.open); $('#dlg').close(); if (p) setPuzzle(p); }
    else if (d) { Store.deletePuzzle(S.lang, d.dataset.del); openHistory(); }
  };
}

function drawThumb(cv, p) {
  if (!p) return;
  const ctx = cv.getContext('2d');
  const st = getComputedStyle(document.documentElement);
  const col = (n) => st.getPropertyValue(n).trim();
  ctx.fillStyle = col('--empty'); ctx.fillRect(0, 0, cv.width, cv.height);
  const g = buildGrid(p);
  g.cells.forEach((c, i) => {
    const x = (i % p.w) * 5, y = Math.floor(i / p.w) * 5;
    if (c.t === 'Q') ctx.fillStyle = col('--clue-ink');
    else if (c.t === 'L') ctx.fillStyle = p.fill[i] !== '.' ? col('--accent') : col('--cell');
    else return;
    ctx.fillRect(x, y, 4, 4);
  });
}

function openStats() {
  const st = Store.getStats()[S.lang];
  const avg = st.solved ? Math.round(st.time / st.solved) : 0;
  const best = ['s', 'm', 'l'].map(k => st.best[k] ? `${T.sizes[k]}: ${fmtTime(st.best[k])}` : '').filter(Boolean).join('<br>') || '—';
  openDialog(`
    <h2>${esc(T.stats)}</h2>
    <div class="stats">
      <div class="stat"><b>${st.solved}</b><span>${esc(T.statSolved)}</span></div>
      <div class="stat"><b>${st.solved ? fmtTime(avg) : '—'}</b><span>${esc(T.statAvg)}</span></div>
      <div class="stat"><b>${st.streak}</b><span>${esc(T.statStreak)}</span></div>
      <div class="stat"><b>${st.hints}</b><span>${esc(T.statHints)}</span></div>
      <div class="stat" style="grid-column:1/-1"><span>${esc(T.statBest)}</span><div style="margin-top:6px;font-weight:600">${best}</div></div>
    </div>
    <div class="dlg-actions"><button class="btn plain" value="close">${esc(T.close)}</button></div>`);
}

function optRow(label, key, options, labels) {
  return `<div class="row"><label>${esc(label)}</label><div class="opts" data-key="${key}">${
    options.map(o => `<button type="button" class="opt ${String(S[key]) === String(o) ? 'on' : ''}" data-v="${o}">${esc(labels[o])}</button>`).join('')}</div></div>`;
}
function stepRow(label, key) {
  return `<div class="row"><label>${esc(label)}</label><div class="stepper" data-key="${key}">
    <button type="button" data-step="-1">−</button><output>${S[key]}</output><button type="button" data-step="1">+</button></div></div>`;
}

function openSettings() {
  const kb = Math.max(1, Math.round(Store.usageBytes() / 1024));
  const body = openDialog(`
    <h2>${esc(T.settings)}</h2>
    ${optRow(T.language, 'lang', ['ru', 'uk'], { ru: 'Русский', uk: 'Українська' })}
    <div class="group">
      ${optRow(T.size, 'size', ['s', 'm', 'l'], Object.fromEntries(Object.entries(SIZES).map(([k, v]) => [k, `${T.sizes[k]} ${v.w}×${v.h}`])))}
      ${optRow(T.difficulty, 'diff', ['easy', 'medium', 'hard'], T.diffs)}
      <h3>${esc(T.hintLimits)}</h3>
      ${stepRow(T.revealLimit, 'hintReveal')}
      ${stepRow(T.checkLimit, 'hintCheck')}
      <p class="note">${esc(T.appliesNext)}</p>
    </div>
    <div class="group">
      ${optRow(T.theme, 'theme', ['auto', 'light', 'dark'], T.themes)}
      ${optRow(T.clueScale, 'clueScale', ['0.85', '1', '1.2'], T.clueScales)}
      ${optRow(T.keyboard, 'kbdHidden', ['false', 'true'], { false: T.shown, true: T.hidden })}
    </div>
    <div class="group">
      <h3>${esc(T.data)}</h3>
      <div class="row"><span>${esc(T.storageUsed(kb))}</span>
        <span class="opts"><button type="button" class="opt" id="st-export">${esc(T.exportData)}</button>
        <button type="button" class="opt" id="st-import">${esc(T.importData)}</button></span></div>
      <input type="file" id="st-file" accept="application/json,.json" hidden>
      <div class="row"><span>${esc(T.version(APP_VERSION))}</span><button type="button" class="opt" id="st-upd">${esc(T.checkUpdates)}</button></div>
      <div class="row"><span></span><button type="button" class="btn danger" id="st-reset">${esc(T.resetData)}</button></div>
    </div>
    <div class="dlg-actions"><button class="btn primary" value="close">${esc(T.close)}</button></div>`);

  body.onclick = async (e) => {
    const opt = e.target.closest('.opt[data-v]');
    if (opt) {
      const key = opt.parentElement.dataset.key;
      let v = opt.dataset.v;
      if (key === 'kbdHidden') v = v === 'true';
      if (key === 'clueScale') v = parseFloat(v);
      const prev = S[key];
      S[key] = v; Store.setSettings(S);
      opt.parentElement.querySelectorAll('.opt').forEach(b => b.classList.toggle('on', b === opt));
      if (key === 'theme' || key === 'clueScale') applyTheme();
      if (key === 'kbdHidden') { physicalKbd = false; updateHud(); requestAnimationFrame(fitBoard); }
      if (key === 'size' || key === 'diff') prefetch = null;
      if (key === 'lang' && prev !== v) { S.lang = prev; $('#dlg').close(); switchLang(v); }
      return;
    }
    const step = e.target.closest('[data-step]');
    if (step) {
      const key = step.parentElement.dataset.key;
      S[key] = Math.max(0, Math.min(20, S[key] + +step.dataset.step));
      step.parentElement.querySelector('output').textContent = S[key];
      Store.setSettings(S);
      return;
    }
    if (e.target.id === 'st-export') exportData();
    if (e.target.id === 'st-import') body.querySelector('#st-file').click();
    if (e.target.id === 'st-upd') {
      const r = await checkNow(true);
      if (r === 'latest') toast(T.upToDate); else if (r === 'offline') toast(T.offline);
    }
    if (e.target.id === 'st-reset') {
      if (confirm(T.resetConfirm)) { Store.resetAll(); S = Store.getSettings(); $('#dlg').close(); applyTheme(); applyLang(); prefetch = null; P = null; newPuzzle(); }
    }
  };
  body.querySelector('#st-file').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      Store.importAll(await f.text());
      S = Store.getSettings(); applyTheme(); applyLang(); $('#dlg').close(); prefetch = null; loadOrCreate();
      toast(T.importOk);
    } catch { toast(T.importBad); }
  };
}

async function exportData() {
  flushSave();
  const blob = new Blob([Store.exportAll()], { type: 'application/json' });
  const name = `skanword-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch { /* отмена */ }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- обновления ----------
function showUpdateBanner(info) {
  const b = $('#update-banner');
  $('#upd-title').textContent = T.updateAvailable(info.version);
  $('#upd-notes').textContent = (info.notes && (info.notes[S.lang] || info.notes.ru)) || '';
  $('#upd-now').textContent = T.updateNow;
  $('#upd-later').textContent = T.later;
  b.hidden = false;
  requestAnimationFrame(fitBoard);
  $('#upd-now').onclick = () => { $('#upd-now').disabled = true; applyUpdate(flushSave); };
  $('#upd-later').onclick = () => { dismiss(); b.hidden = true; requestAnimationFrame(fitBoard); };
}

// ---------- тост ----------
let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

boot();
