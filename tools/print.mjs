import { readFileSync } from 'node:fs';
import { parseDict, buildIndex, generate } from '../js/generator.js';
const idx = buildIndex(parseDict(readFileSync(new URL('../dict/'+(process.argv[3]||'ru')+'.txt', import.meta.url),'utf8')));
const { puzzle: p } = generate(idx, { size: process.argv[2]||'m', diff: 'medium', seed: +process.argv[4]||3, minFill: 0 });
const g = Array.from({length:p.h},()=>Array(p.w).fill('·'));
for (const w of p.words){ g[w.cr][w.cc]='#'; for(let k=0;k<w.ans.length;k++){ const r=w.r+(w.d==='v'?k:0), c=w.c+(w.d==='h'?k:0); g[r][c]=w.ans[k]; } }
console.log(g.map(r=>r.join(' ')).join('\n')); console.log('fill',p.fill.toFixed(3),'words',p.words.length);
