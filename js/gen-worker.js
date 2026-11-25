// Web Worker генерации. Протокол: {id, lang, size, diff, seed, recent[], v} → {id, ok, puzzle?, fallback?, error?}
import { parseDict, buildIndex, generate } from './generator.js';

const indexes = new Map();
const fallbacks = new Map();

async function getIndex(lang, v) {
  const key = lang + '@' + v;
  if (!indexes.has(key)) {
    const res = await fetch(new URL(`../dict/${lang}.txt?v=${v}`, import.meta.url));
    if (!res.ok) throw new Error('dict ' + res.status);
    indexes.set(key, buildIndex(parseDict(await res.text())));
  }
  return indexes.get(key);
}

async function getFallback(lang, size, v) {
  if (!fallbacks.has(lang)) {
    const res = await fetch(new URL(`../dict/fallback-${lang}.json?v=${v}`, import.meta.url));
    fallbacks.set(lang, res.ok ? await res.json() : []);
  }
  const list = fallbacks.get(lang).filter(p => p.size === size);
  return list.length ? list[Math.floor(Math.random() * list.length)] : null;
}

self.onmessage = async (e) => {
  const { id, lang, size, diff, seed, recent, v } = e.data;
  try {
    const idx = await getIndex(lang, v);
    const { puzzle } = generate(idx, { size, diff, seed, recent: new Set(recent || []) });
    if (puzzle) { self.postMessage({ id, ok: true, puzzle }); return; }
    const fb = await getFallback(lang, size, v);
    self.postMessage({ id, ok: !!fb, puzzle: fb, fallback: true });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
