// Генератор сканвордов. Чистый модуль без DOM: работает в Web Worker, в основном потоке и в Node (тесты).
// Гарантии завершения:
//  * каждая установка слова добавляет минимум одну новую буквенную клетку → слов не больше, чем клеток;
//  * жёсткий лимит шагов (maxSteps) и бюджета времени (timeBudget) на попытку;
//  * ограниченное число попыток (maxAttempts) с разными seed.

export const GEN_VERSION = 1;
export const MIN_LEN = 3;

export const SIZES = {
  s: { w: 9, h: 11 },
  m: { w: 12, h: 15 },
  l: { w: 15, h: 19 },
};

// Вес слова по уровню (1 — лёгкое, 3 — редкое) для каждой сложности.
const DIFF_WEIGHTS = {
  easy:   [0, 1.0, 0.45, 0.05],
  medium: [0, 0.7, 1.0, 0.45],
  hard:   [0, 0.35, 0.8, 1.0],
};

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normalizeWord(s) {
  return s.trim().toUpperCase().replace(/Ё/g, 'Е').replace(/['\u2019\u02BC\u0301]/g, '');
}

// Разбор словаря формата «слово|определение|уровень», одна запись на строку, # — комментарий.
export function parseDict(text) {
  const out = [];
  const seen = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('|');
    if (parts.length < 2) continue;
    const w = normalizeWord(parts[0]);
    if (w.length < MIN_LEN || seen.has(w)) continue;
    if (!/^[А-ЯІЇЄҐ]+$/.test(w)) continue;
    seen.add(w);
    const lvl = Math.min(3, Math.max(1, parseInt(parts[2], 10) || 2));
    out.push({ w, clue: parts[1].trim(), lvl });
  }
  return out;
}

export function buildIndex(entries) {
  const byLen = new Map();
  const byKey = new Map();
  entries.forEach((e, i) => {
    const L = e.w.length;
    if (!byLen.has(L)) byLen.set(L, []);
    byLen.get(L).push(i);
    for (let p = 0; p < L; p++) {
      const k = L * 4096 + p * 64 + 0; // числовой префикс
      const key = k + ':' + e.w[p];
      let arr = byKey.get(key);
      if (!arr) { arr = []; byKey.set(key, arr); }
      arr.push(i);
    }
  });
  let maxLen = 0;
  for (const L of byLen.keys()) maxLen = Math.max(maxLen, L);
  return { entries, byLen, byKey, maxLen };
}

function keyOf(L, p, ch) { return (L * 4096 + p * 64) + ':' + ch; }

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

// Одна попытка генерации.
function attempt(index, opt) {
  const { w: W, h: H } = opt;
  const N = W * H;
  const rng = mulberry32(opt.seed >>> 0);
  const weights = DIFF_WEIGHTS[opt.diff] || DIFF_WEIGHTS.medium;
  const recent = opt.recent || new Set();
  const maxSteps = opt.maxSteps ?? 4000000;
  const deadline = opt.now() + (opt.timeBudget ?? 1500);
  const ents = index.entries;

  const letters = new Array(N).fill(null);
  const clues = new Array(N).fill(null);    // массив {wi, arrow}
  const hasH = new Uint8Array(N), hasV = new Uint8Array(N);
  const placed = [];
  const used = new Set();
  let steps = 0;

  const inG = (r, c) => r >= 0 && c >= 0 && r < H && c < W;
  const id = (r, c) => r * W + c;

  function clueOptions(r, c, d) {
    // d: 'h' | 'v'. Возвращает варианты клетки-вопроса.
    const cand = d === 'h'
      ? [[r, c - 1, 'r'], [r - 1, c, 'dr']]
      : [[r - 1, c, 'd'], [r, c - 1, 'rd']];
    const res = [];
    for (const [cr, cc, arrow] of cand) {
      if (!inG(cr, cc)) continue;
      const i = id(cr, cc);
      if (letters[i] !== null) continue;
      if (clues[i] && clues[i].length >= 2) continue;
      res.push({ cr, cc, arrow, reuse: !!clues[i] });
    }
    return res;
  }

  // Полная проверка установки. Возвращает {cross, clue} или null.
  function check(word, r, c, d) {
    const L = word.length;
    const dr = d === 'v' ? 1 : 0, dc = d === 'h' ? 1 : 0;
    const er = r + dr * (L - 1), ec = c + dc * (L - 1);
    if (!inG(r, c) || !inG(er, ec)) return null;
    if (inG(r - dr, c - dc) && letters[id(r - dr, c - dc)] !== null) return null;
    if (inG(er + dr, ec + dc) && letters[id(er + dr, ec + dc)] !== null) return null;
    let cross = 0;
    for (let k = 0; k < L; k++) {
      const rr = r + dr * k, cc = c + dc * k, i = id(rr, cc);
      steps++;
      if (clues[i]) return null;
      const ch = letters[i];
      if (ch !== null) {
        if (ch !== word[k]) return null;
        if (d === 'h' ? hasH[i] : hasV[i]) return null;
        cross++;
      } else {
        // перпендикулярные соседи новой буквы должны быть пустыми
        if (d === 'h') {
          if (inG(rr - 1, cc) && letters[id(rr - 1, cc)] !== null) return null;
          if (inG(rr + 1, cc) && letters[id(rr + 1, cc)] !== null) return null;
        } else {
          if (inG(rr, cc - 1) && letters[id(rr, cc - 1)] !== null) return null;
          if (inG(rr, cc + 1) && letters[id(rr, cc + 1)] !== null) return null;
        }
      }
    }
    if (cross === L) return null;
    const opts = clueOptions(r, c, d);
    if (!opts.length) return null;
    // клетка-вопрос не должна попасть на путь слова (не может по геометрии), выбираем лучшую
    opts.sort((a, b) => (b.reuse - a.reuse) || ((a.arrow.length) - (b.arrow.length)));
    return { cross, clue: opts[0] };
  }

  function place(wi, r, c, d, clue) {
    const word = ents[wi].w;
    const dr = d === 'v' ? 1 : 0, dc = d === 'h' ? 1 : 0;
    for (let k = 0; k < word.length; k++) {
      const i = id(r + dr * k, c + dc * k);
      letters[i] = word[k];
      if (d === 'h') hasH[i] = 1; else hasV[i] = 1;
    }
    const ci = id(clue.cr, clue.cc);
    if (!clues[ci]) clues[ci] = [];
    clues[ci].push({ wi: placed.length, arrow: clue.arrow });
    placed.push({ wi, r, c, d, cr: clue.cr, cc: clue.cc, arrow: clue.arrow });
    used.add(wi);
  }

  function score(wi, L, res) {
    const e = ents[wi];
    let s = res.cross * (opt.wCross ?? 14) + L * (opt.wLen ?? 1.2) + weights[e.lvl] * 8 + rng() * 5;
    if (res.clue.reuse) s += 5;
    if (res.clue.cr === 0 || res.clue.cc === 0) s += 2;
    if (recent.has(e.w)) s -= 12;
    return s;
  }

  // --- первое слово ---
  {
    const maxL = Math.min(W - 1, index.maxLen);
    const pool = [];
    for (let L = Math.min(maxL, 8); L >= Math.min(5, maxL); L--) {
      const arr = index.byLen.get(L);
      if (arr) pool.push(...arr);
    }
    if (!pool.length) return null;
    shuffle(pool, rng);
    let ok = false;
    const r0 = 1 + Math.floor(rng() * Math.min(2, H - 2));
    for (const wi of pool.slice(0, 50)) {
      if (recent.has(ents[wi].w) && rng() < 0.8) continue;
      const res = check(ents[wi].w, r0, 1, 'h');
      if (res) { place(wi, r0, 1, 'h', res.clue); ok = true; break; }
    }
    if (!ok) return null;
  }

  // --- жадное заполнение ---
  const starts = [];
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) { starts.push([r, c, 'h'], [r, c, 'v']); }
  const SAMPLE = opt.sample ?? 6;

  function greedy() {
    let requireCross = true;
    let iter = 0;
    while (iter++ < N) {
      if (steps > maxSteps || opt.now() > deadline) return;
      let best = null, bestScore = -Infinity;
      shuffle(starts, rng);
      for (const [r, c, d] of starts) {
        const dr = d === 'v' ? 1 : 0, dc = d === 'h' ? 1 : 0;
        const s0 = id(r, c);
        if (clues[s0]) continue;
        if (letters[s0] !== null && (d === 'h' ? hasH[s0] : hasV[s0])) continue;
        if (inG(r - dr, c - dc) && letters[id(r - dr, c - dc)] !== null) continue;
        if (!clueOptions(r, c, d).length) continue;
        const fixed = [];
        let Lmax = 0;
        for (let k = 0; ; k++) {
          const rr = r + dr * k, cc = c + dc * k;
          if (!inG(rr, cc)) break;
          const i = id(rr, cc);
          if (clues[i]) break;
          if (letters[i] !== null && (d === 'h' ? hasH[i] : hasV[i])) break;
          if (letters[i] !== null) fixed.push([k, letters[i]]);
          Lmax = k + 1;
        }
        Lmax = Math.min(Lmax, index.maxLen);
        for (let L = Lmax; L >= MIN_LEN; L--) {
          const pr = r + dr * L, pc = c + dc * L;
          if (inG(pr, pc) && letters[id(pr, pc)] !== null) continue;
          const fx = fixed.filter(f => f[0] < L);
          if (requireCross && !fx.length) continue;
          let list;
          if (fx.length) {
            let bestList = null;
            for (const [p, ch] of fx) {
              const a = index.byKey.get(keyOf(L, p, ch));
              if (!a) { bestList = null; break; }
              if (!bestList || a.length < bestList.length) bestList = a;
            }
            list = bestList;
          } else {
            list = index.byLen.get(L);
          }
          if (!list || !list.length) continue;
          const n = Math.min(fx.length > 1 ? list.length : SAMPLE, list.length);
          const off = Math.floor(rng() * list.length);
          for (let t = 0; t < n; t++) {
            const wi = list[(off + t) % list.length];
            steps++;
            if (used.has(wi)) continue;
            const word = ents[wi].w;
            let ok = true;
            for (const [p, ch] of fx) if (word[p] !== ch) { ok = false; break; }
            if (!ok) continue;
            const res = check(word, r, c, d);
            if (!res) continue;
            if (requireCross && res.cross === 0) continue;
            const sc = score(wi, L, res);
            if (sc > bestScore) { bestScore = sc; best = { wi, r, c, d, clue: res.clue }; }
          }
        }
        if (steps > maxSteps) break;
      }
      if (!best) {
        if (requireCross) { requireCross = false; continue; }
        return;
      }
      place(best.wi, best.r, best.c, best.d, best.clue);
      requireCross = true;
    }
  }

  function reset(list) {
    letters.fill(null); clues.fill(null); hasH.fill(0); hasV.fill(0);
    placed.length = 0; used.clear();
    for (const p of list) place(p.wi, p.r, p.c, p.d, { cr: p.cr, cc: p.cc, arrow: p.arrow });
  }
  function fillOf() {
    let n = 0;
    for (let i = 0; i < N; i++) if (letters[i] !== null || clues[i]) n++;
    return n / N;
  }

  function toPuzzle() {
    return {
      w: W, h: H,
      words: placed.map(p => ({
        ans: ents[p.wi].w, clue: ents[p.wi].clue, lvl: ents[p.wi].lvl,
        d: p.d, r: p.r, c: p.c, cr: p.cr, cc: p.cc, arrow: p.arrow,
      })),
    };
  }

  greedy();

  // --- локальный поиск: убрать несколько слов и дозаполнить заново ---
  const lnsDeadline = Math.min(deadline, opt.now() + (opt.lnsBudget ?? 600));
  let bestList = placed.slice(), bestFill = fillOf();
  let lnsIter = 0;
  while (lnsIter++ < (opt.lnsIters ?? 400) && opt.now() < lnsDeadline && steps < maxSteps && bestList.length > 2) {
    const list = bestList.slice();
    // удаляем слова в случайной окрестности
    const k = 1 + Math.floor(rng() * 3);
    const pivot = list[1 + Math.floor(rng() * (list.length - 1))];
    list.sort((a, b) => (Math.abs(a.r - pivot.r) + Math.abs(a.c - pivot.c)) - (Math.abs(b.r - pivot.r) + Math.abs(b.c - pivot.c)));
    const removed = new Set(list.slice(0, k));
    const rest = bestList.filter(p => !removed.has(p) || p === bestList[0]);
    reset(rest);
    greedy();
    const f = fillOf();
    if (f >= bestFill && verify(toPuzzle()).length === 0) { bestFill = f; bestList = placed.slice(); }
  }
  reset(bestList);

  let letterCells = 0, clueCells = 0;
  for (let i = 0; i < N; i++) { if (letters[i] !== null) letterCells++; else if (clues[i]) clueCells++; }
  const fill = (letterCells + clueCells) / N;

  return {
    w: W, h: H,
    words: placed.map(p => ({
      ans: ents[p.wi].w, clue: ents[p.wi].clue, lvl: ents[p.wi].lvl,
      d: p.d, r: p.r, c: p.c, cr: p.cr, cc: p.cc, arrow: p.arrow,
    })),
    fill, letterCells, clueCells, steps,
  };
}

// Проверка корректности готового сканворда (используется и в тестах, и как страховка в рантайме).
export function verify(pz) {
  const { w: W, h: H, words } = pz;
  const N = W * H;
  const letters = new Array(N).fill(null);
  const clueCount = new Array(N).fill(0);
  const startH = new Map(), startV = new Map();
  const errs = [];
  const seen = new Set();
  for (const wd of words) {
    if (seen.has(wd.ans)) errs.push('dup ' + wd.ans);
    seen.add(wd.ans);
    const dr = wd.d === 'v' ? 1 : 0, dc = wd.d === 'h' ? 1 : 0;
    for (let k = 0; k < wd.ans.length; k++) {
      const r = wd.r + dr * k, c = wd.c + dc * k;
      if (r >= H || c >= W) { errs.push('out ' + wd.ans); break; }
      const i = r * W + c;
      if (letters[i] !== null && letters[i] !== wd.ans[k]) errs.push('conflict ' + wd.ans);
      letters[i] = wd.ans[k];
    }
    const exp = {
      r: [wd.r, wd.c - 1], dr: [wd.r - 1, wd.c], d: [wd.r - 1, wd.c], rd: [wd.r, wd.c - 1],
    }[wd.arrow];
    if (!exp || exp[0] !== wd.cr || exp[1] !== wd.cc) errs.push('clue pos ' + wd.ans);
    if ((wd.arrow === 'r' || wd.arrow === 'dr') !== (wd.d === 'h')) errs.push('arrow dir ' + wd.ans);
    clueCount[wd.cr * W + wd.cc]++;
    (wd.d === 'h' ? startH : startV).set(wd.r * W + wd.c, wd.ans.length);
  }
  for (let i = 0; i < N; i++) {
    if (clueCount[i] > 2) errs.push('clue>2 @' + i);
    if (clueCount[i] && letters[i] !== null) errs.push('clue on letter @' + i);
  }
  // каждая максимальная серия букв длиной ≥2 должна быть словом
  for (const d of ['h', 'v']) {
    const outer = d === 'h' ? H : W, inner = d === 'h' ? W : H;
    for (let a = 0; a < outer; a++) {
      let b = 0;
      while (b < inner) {
        const at = (x) => (d === 'h' ? a * W + x : x * W + a);
        if (letters[at(b)] === null) { b++; continue; }
        let e = b;
        while (e < inner && letters[at(e)] !== null) e++;
        const len = e - b;
        if (len >= 2) {
          const m = d === 'h' ? startH : startV;
          if (m.get(at(b)) !== len) errs.push(`run ${d} @${at(b)} len ${len}`);
        }
        b = e;
      }
    }
  }
  return errs;
}

// Генерация с повторами и ступенчатым снижением требований.
export function generate(index, o) {
  const size = SIZES[o.size] || SIZES.m;
  const now = o.now || (() => Date.now());
  const maxAttempts = o.maxAttempts ?? 5;
  const targets = o.targets || [0.78, 0.76, 0.74, 0.72, 0.7];
  const totalBudget = o.totalBudget ?? 3500;
  let best = null, attempts = 0;
  const t0 = now();
  for (let a = 0; a < maxAttempts; a++) {
    attempts++;
    const seed = ((o.seed >>> 0) + a * 2654435761) >>> 0;
    const res = attempt(index, {
      w: size.w, h: size.h, diff: o.diff, seed, recent: o.recent,
      maxSteps: o.maxSteps, timeBudget: o.timeBudget ?? 1200, now, lnsBudget: o.lnsBudget, lnsIters: o.lnsIters, sample: o.sample, wCross: o.wCross, wLen: o.wLen,
    });
    if (!res) continue;
    { const ve = verify(res); if (ve.length) { if (o.debug) console.log(ve); continue; } }
    res.seed = seed;
    if (!best || res.fill > best.fill) best = res;
    if (best.fill >= (targets[a] ?? 0.7)) break;
    if (now() - t0 > totalBudget) break;
  }
  if (!best || best.fill < (o.minFill ?? 0.6)) return { puzzle: null, attempts };
  return { puzzle: best, attempts };
}
