// node tools/bump-version.mjs 1.1.0 "Что нового (ru)" "Що нового (uk)"
import { readFileSync, writeFileSync } from 'node:fs';
const [v, ru = '', uk = ''] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(v || '')) { console.error('Укажите версию x.y.z'); process.exit(1); }
const f = (p) => new URL('../' + p, import.meta.url);
const sub = (p, re, s) => writeFileSync(f(p), readFileSync(f(p), 'utf8').replace(re, s));
sub('js/version.js', /APP_VERSION = '[^']*'/, `APP_VERSION = '${v}'`);
sub('sw.js', /CACHE_VERSION = '[^']*'/, `CACHE_VERSION = '${v}'`);
const today = new Date().toISOString().slice(0, 10);
writeFileSync(f('version.json'), JSON.stringify({ version: v, date: today, notes: { ru: ru || v, uk: uk || ru || v } }, null, 2) + '\n');
console.log('Версия', v, '— не забудьте закоммитить и запушить');
