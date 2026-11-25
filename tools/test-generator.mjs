// Стресс-тест генератора: node tools/test-generator.mjs [runs]
import { readFileSync } from 'node:fs';
import { parseDict, buildIndex, generate, verify } from '../js/generator.js';
const runs = +process.argv[2] || 100;
const langs = (process.argv[3] || 'ru,uk').split(',');
let bad = 0;
for (const lang of langs) {
  let text; try { text = readFileSync(new URL(`../dict/${lang}.txt`, import.meta.url), 'utf8'); } catch { continue; }
  const idx = buildIndex(parseDict(text));
  if (!idx.entries.length) continue;
  for (const size of ['s', 'm', 'l']) for (const diff of ['easy', 'medium', 'hard']) {
    let fills = [], times = [], fails = 0, words = [], att = [];
    for (let i = 0; i < runs; i++) {
      const t = performance.now();
      const { puzzle, attempts } = generate(idx, { size, diff, seed: i * 7 + 1, timeBudget: 1500 });
      times.push(performance.now() - t); att.push(attempts);
      if (!puzzle) { fails++; continue; }
      const e = verify(puzzle); if (e.length) { bad++; console.log('VERIFY', e.slice(0, 3)); }
      fills.push(puzzle.fill); words.push(puzzle.words.length);
    }
    const avg = a => a.length ? (a.reduce((x, y) => x + y, 0) / a.length) : 0;
    const max = a => Math.max(...a);
    console.log(`${lang} ${size} ${diff.padEnd(6)} fill ${avg(fills).toFixed(3)} min ${Math.min(...fills).toFixed(2)} words ${avg(words).toFixed(0)} time avg ${avg(times).toFixed(0)}ms max ${max(times).toFixed(0)}ms att ${avg(att).toFixed(1)} fails ${fails}`);
  }
}
process.exit(bad ? 1 : 0);
