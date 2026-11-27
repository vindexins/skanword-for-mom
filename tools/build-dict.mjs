// Сборка и валидация словарей: dict/src/<lang>*.txt → dict/<lang>.txt
// Запуск: node tools/build-dict.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeWord, MIN_LEN } from '../js/generator.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'dict', 'src');
const MAX_CLUE = 30;
const ALPHA = { ru: /^[А-ЯЁ]+$/, uk: /^[А-ЩЬЮЯІЇЄҐ]+$/ };
let failed = false;

for (const lang of ['ru', 'uk']) {
  const files = readdirSync(src).filter(f => f.startsWith(lang) && f.endsWith('.txt')).sort();
  const seen = new Map();
  const out = [];
  const warn = [];
  for (const f of files) {
    readFileSync(join(src, f), 'utf8').split('\n').forEach((raw, n) => {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.includes('|x|')) return;
      const where = `${f}:${n + 1}`;
      const [w0, clue, lvl] = line.split('|');
      if (!clue) { warn.push(`${where} нет определения`); return; }
      const w = normalizeWord(w0);
      if (w.length < MIN_LEN) return; // короткие слова тихо пропускаем
      if (!ALPHA[lang].test(w)) { warn.push(`${where} чужие символы: ${w0}`); return; }
      if (seen.has(w)) return; // дубль: оставляем первое определение
      if (clue.length > MAX_CLUE) warn.push(`${where} длинное определение (${clue.length}): ${clue}`);
      if (normalizeWord(clue).split(/[^А-ЯІЇЄҐ]+/).some(t => t.startsWith(w))) warn.push(`${where} ответ внутри определения: ${w}`);
      if (!/^[123]$/.test(lvl || '')) warn.push(`${where} уровень не 1..3`);
      seen.set(w, true);
      out.push(`${w0.trim().toLowerCase()}|${clue.trim()}|${lvl || 2}`);
    });
  }
  const byLen = {};
  for (const l of out) { const L = normalizeWord(l.split('|')[0]).length; byLen[L] = (byLen[L] || 0) + 1; }
  writeFileSync(join(root, 'dict', `${lang}.txt`), out.join('\n') + '\n');
  console.log(`${lang}: ${out.length} слов; по длине`, byLen);
  if (warn.length) { console.log(warn.join('\n')); }
  if (warn.some(w => w.includes('чужие') || w.includes('внутри'))) failed = true;
}
process.exit(failed ? 1 : 0);
