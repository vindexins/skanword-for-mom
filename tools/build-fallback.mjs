// Запасные сканворды на случай, если генерация не удалась: dict/fallback-<lang>.json
import { readFileSync, writeFileSync } from 'node:fs';
import { parseDict, buildIndex, generate, verify } from '../js/generator.js';
for (const lang of ['ru', 'uk']) {
  const idx = buildIndex(parseDict(readFileSync(new URL(`../dict/${lang}.txt`, import.meta.url), 'utf8')));
  const out = [];
  for (const size of ['s', 'm', 'l']) for (let k = 0; k < 3; k++) {
    let best = null;
    for (let s = 0; s < 6; s++) {
      const { puzzle } = generate(idx, { size, diff: 'medium', seed: 1000 + k * 100 + s, timeBudget: 4000, lnsBudget: 3000, totalBudget: 20000, targets: [1] });
      if (puzzle && !verify(puzzle).length && (!best || puzzle.fill > best.fill)) best = puzzle;
    }
    best.size = size; best.diff = 'medium';
    out.push(best);
    console.log(lang, size, k, best.fill.toFixed(3));
  }
  writeFileSync(new URL(`../dict/fallback-${lang}.json`, import.meta.url), JSON.stringify(out));
}
