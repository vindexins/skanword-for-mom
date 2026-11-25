// Слой хранения поверх localStorage.
// Правила:
//  * фиксированный набор ключей с префиксом scw: — всё остальное с этим префиксом удаляется при запуске;
//  * у каждой коллекции жёсткий предел размера;
//  * номер схемы + цепочка миграций;
//  * битый JSON сбрасывает только свой ключ;
//  * запись через save() с обработкой переполнения квоты.

export const SCHEMA = 1;
export const HISTORY_LIMIT = 5;          // предыдущих сканвордов на язык (плюс текущий)
export const USED_LIMIT = 1500;          // недавно использованных слов на язык
export const STATS_RECENT_LIMIT = 50;    // последних результатов в статистике
export const LANGS = ['ru', 'uk'];

const P = 'scw:';
const KEYS = {
  meta: P + 'meta',
  settings: P + 'settings',
  stats: P + 'stats',
  games: (l) => P + 'games:' + l,
  used: (l) => P + 'used:' + l,
};
const KNOWN = new Set([KEYS.meta, KEYS.settings, KEYS.stats, ...LANGS.map(KEYS.games), ...LANGS.map(KEYS.used)]);

export const DEFAULT_SETTINGS = {
  lang: 'ru', size: 'm', diff: 'medium',
  hintReveal: 3, hintCheck: 3,
  theme: 'auto', clueScale: 1, kbdHidden: false,
};

const emptyLangStats = () => ({ solved: 0, time: 0, hints: 0, best: {}, streak: 0, lastDay: '', recent: [] });
const emptyStats = () => Object.fromEntries(LANGS.map(l => [l, emptyLangStats()]));
const emptyGames = () => ({ current: null, list: [] });

let ls = null;
try { ls = window.localStorage; ls.setItem(P + 't', '1'); ls.removeItem(P + 't'); } catch { ls = null; }
const mem = new Map(); // запасной вариант, если localStorage недоступен (приватный режим)

function rawGet(k) { return ls ? ls.getItem(k) : (mem.has(k) ? mem.get(k) : null); }
function rawSet(k, v) { if (ls) ls.setItem(k, v); else mem.set(k, v); }
function rawDel(k) { if (ls) ls.removeItem(k); else mem.delete(k); }
function rawKeys() {
  if (!ls) return [...mem.keys()];
  const out = [];
  for (let i = 0; i < ls.length; i++) out.push(ls.key(i));
  return out;
}

function read(key, fallback, valid) {
  const raw = rawGet(key);
  if (raw == null) return fallback();
  try {
    const v = JSON.parse(raw);
    if (valid && !valid(v)) throw new Error('invalid');
    return v;
  } catch {
    rawDel(key);
    return fallback();
  }
}

function isQuota(e) {
  return e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014 || /quota/i.test(e.message || ''));
}

// Освобождение места: по шагам, от наименее ценного.
function prune(step) {
  for (const l of LANGS) {
    if (step >= 1) {
      const u = (rawGet(KEYS.used(l)) || '').split('|').filter(Boolean);
      rawSet(KEYS.used(l), u.slice(-Math.floor(USED_LIMIT / (step + 1))).join('|'));
    }
    if (step >= 2) {
      const g = read(KEYS.games(l), emptyGames);
      g.list = g.list.filter(p => p.id === g.current).concat(
        g.list.filter(p => p.id !== g.current).sort((a, b) => b.opened - a.opened).slice(0, Math.max(0, HISTORY_LIMIT - step * 2)));
      rawSet(KEYS.games(l), JSON.stringify(g));
    }
  }
  if (step >= 2) {
    const s = read(KEYS.stats, emptyStats);
    for (const l of LANGS) if (s[l]) s[l].recent = (s[l].recent || []).slice(-10);
    rawSet(KEYS.stats, JSON.stringify(s));
  }
}

export function save(key, value) {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  for (let step = 0; step <= 3; step++) {
    try { rawSet(key, str); return true; }
    catch (e) {
      if (!isQuota(e)) { console.warn('save failed', key, e); return false; }
      try { prune(step + 1); } catch { /* ignore */ }
    }
  }
  console.warn('save: квота исчерпана', key);
  return false;
}

// --- миграции: MIGRATIONS[n] переводит данные со схемы n на n+1 ---
const MIGRATIONS = {
  // 1: () => { ... пример: переименовать поле в scw:settings ... },
};

function migrate(meta) {
  let v = meta.schema || 0;
  if (v === 0) { meta.schema = SCHEMA; return; } // первая установка
  while (v < SCHEMA) {
    const fn = MIGRATIONS[v];
    try { if (fn) fn(); }
    catch (e) {
      console.warn('миграция упала', v, e);
      for (const l of LANGS) rawDel(KEYS.games(l)); // сбрасываем только сложный раздел
    }
    v++;
  }
  meta.schema = Math.max(meta.schema, SCHEMA);
}

function gc() {
  for (const k of rawKeys()) {
    if (k && k.startsWith(P) && !KNOWN.has(k)) rawDel(k);
  }
}

function validPuzzle(p) {
  return p && typeof p.id === 'string' && Array.isArray(p.words) && typeof p.fill === 'string'
    && p.fill.length === p.w * p.h && typeof p.flags === 'string' && p.flags.length === p.w * p.h;
}

export function init() {
  const meta = read(KEYS.meta, () => ({ schema: 0, lastCheck: 0, dismissed: '' }), v => typeof v === 'object');
  migrate(meta);
  save(KEYS.meta, meta);
  gc();
  // чистим историю от повреждённых записей и лишнего
  for (const l of LANGS) {
    const g = read(KEYS.games(l), emptyGames, v => v && Array.isArray(v.list));
    const before = g.list.length;
    g.list = g.list.filter(validPuzzle);
    trimHistory(g);
    if (g.list.length !== before || (g.current && !g.list.some(p => p.id === g.current))) {
      if (!g.list.some(p => p.id === g.current)) g.current = g.list[0]?.id || null;
      save(KEYS.games(l), g);
    }
  }
  return meta;
}

function trimHistory(g) {
  const cur = g.list.find(p => p.id === g.current);
  const others = g.list.filter(p => p.id !== g.current).sort((a, b) => b.opened - a.opened).slice(0, HISTORY_LIMIT);
  g.list = cur ? [cur, ...others] : others;
}

export const getMeta = () => read(KEYS.meta, () => ({ schema: SCHEMA, lastCheck: 0, dismissed: '' }));
export const setMeta = (m) => save(KEYS.meta, m);

export function getSettings() {
  const s = read(KEYS.settings, () => ({}), v => typeof v === 'object');
  return { ...DEFAULT_SETTINGS, ...s };
}
export const setSettings = (s) => save(KEYS.settings, s);

export function getGames(lang) { return read(KEYS.games(lang), emptyGames, v => v && Array.isArray(v.list)); }
export function setGames(lang, g) { trimHistory(g); return save(KEYS.games(lang), g); }

export function getCurrent(lang) {
  const g = getGames(lang);
  return g.list.find(p => p.id === g.current) || null;
}

// Добавить новый сканворд и сделать его текущим; самый давно открытый вытесняется.
export function addPuzzle(lang, p) {
  const g = getGames(lang);
  g.list.unshift(p);
  g.current = p.id;
  setGames(lang, g);
}

export function savePuzzle(p) {
  const g = getGames(p.lang);
  const i = g.list.findIndex(x => x.id === p.id);
  if (i >= 0) g.list[i] = p; else g.list.unshift(p);
  return setGames(p.lang, g);
}

export function openPuzzle(lang, id) {
  const g = getGames(lang);
  const p = g.list.find(x => x.id === id);
  if (!p) return null;
  p.opened = Date.now();
  g.current = id;
  setGames(lang, g);
  return p;
}

export function deletePuzzle(lang, id) {
  const g = getGames(lang);
  g.list = g.list.filter(x => x.id !== id);
  if (g.current === id) g.current = g.list[0]?.id || null;
  setGames(lang, g);
}

export function getUsed(lang) {
  const raw = rawGet(KEYS.used(lang));
  return raw ? raw.split('|').filter(Boolean) : [];
}
export function addUsed(lang, words) {
  const set = new Set(words);
  const u = getUsed(lang).filter(w => !set.has(w)).concat(words);
  save(KEYS.used(lang), u.slice(-USED_LIMIT).join('|'));
}

export function getStats() {
  const s = read(KEYS.stats, emptyStats, v => typeof v === 'object');
  for (const l of LANGS) s[l] = { ...emptyLangStats(), ...(s[l] || {}) };
  return s;
}

function dayKey(t) { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }

export function recordSolved(p) {
  const s = getStats();
  const st = s[p.lang];
  st.solved++;
  st.time += p.time;
  st.hints += (p.used.r + p.used.c);
  const key = p.size;
  if (!st.best[key] || p.time < st.best[key]) st.best[key] = p.time;
  const today = dayKey(Date.now());
  const yesterday = dayKey(Date.now() - 864e5);
  if (st.lastDay !== today) st.streak = st.lastDay === yesterday ? st.streak + 1 : 1;
  st.lastDay = today;
  st.recent.push({ t: p.time, s: p.size, d: p.diff, h: p.used.r + p.used.c, at: Date.now() });
  st.recent = st.recent.slice(-STATS_RECENT_LIMIT);
  save(KEYS.stats, s);
  return st;
}

export function usageBytes() {
  let n = 0;
  for (const k of rawKeys()) if (k && k.startsWith(P)) n += (k.length + (rawGet(k) || '').length) * 2;
  return n;
}

export function exportAll() {
  const out = { app: 'skanword', schema: SCHEMA, at: new Date().toISOString(), data: {} };
  for (const k of KNOWN) { const v = rawGet(k); if (v != null) out.data[k] = v; }
  return JSON.stringify(out);
}

export function importAll(text) {
  const obj = JSON.parse(text);
  if (!obj || obj.app !== 'skanword' || typeof obj.data !== 'object') throw new Error('bad file');
  if ((obj.schema || 0) > SCHEMA) throw new Error('newer schema');
  for (const [k, v] of Object.entries(obj.data)) if (KNOWN.has(k) && typeof v === 'string') rawSet(k, v);
  const meta = getMeta(); meta.schema = obj.schema || SCHEMA; setMeta(meta);
  init();
}

export function resetAll() {
  for (const k of rawKeys()) if (k && k.startsWith(P)) rawDel(k);
  init();
}

export async function requestPersist() {
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch { /* */ }
  return false;
}

export const storageAvailable = () => !!ls;
