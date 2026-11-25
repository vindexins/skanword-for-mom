// Проверка новой версии: не чаще раза в сутки (при запуске и возвращении в приложение)
// + ручная проверка из настроек. Обновление применяется только после согласия.
import { APP_VERSION } from './version.js';
import { getMeta, setMeta } from './storage.js';

const DAY = 24 * 60 * 60 * 1000;
let reg = null;
let onAvailable = () => {};
let pending = null; // {version, notes}

export function cmpVer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return Math.sign(d); }
  return 0;
}

export async function initUpdates(cb) {
  onAvailable = cb;
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    try {
      reg = await navigator.serviceWorker.register('sw.js');
      // Перезагрузка после того, как пользователь согласился и новый SW взял управление.
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (window.__scwUpdating && !reloading) { reloading = true; location.reload(); }
      });
    } catch (e) { console.warn('SW недоступен', e); }
  }
  maybeCheck();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) maybeCheck(); });
}

function maybeCheck() {
  const m = getMeta();
  if (Date.now() - (m.lastCheck || 0) < DAY) return;
  checkNow(false).catch(() => {});
}

// Возвращает 'available' | 'latest' | 'offline'
export async function checkNow(manual) {
  let info;
  try {
    const res = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    info = await res.json();
  } catch { return 'offline'; }
  const m = getMeta();
  m.lastCheck = Date.now();
  setMeta(m);
  if (cmpVer(info.version, APP_VERSION) <= 0) return 'latest';
  pending = info;
  if (!manual && m.dismissed === info.version && Date.now() - (m.dismissedAt || 0) < DAY) return 'available';
  if (reg) { try { await reg.update(); } catch { /* сеть */ } }
  onAvailable(info);
  return 'available';
}

export function dismiss() {
  if (!pending) return;
  const m = getMeta();
  m.dismissed = pending.version; m.dismissedAt = Date.now();
  setMeta(m);
}

// Применить обновление. beforeReload — сохранить состояние.
export async function applyUpdate(beforeReload) {
  beforeReload && beforeReload();
  window.__scwUpdating = true;
  if (reg) {
    try { await reg.update(); } catch { /* */ }
    const w = reg.waiting || await waitForWaiting(reg, 15000);
    if (w) { w.postMessage({ type: 'SKIP_WAITING' }); setTimeout(() => location.reload(), 4000); return; }
  }
  location.reload();
}

function waitForWaiting(r, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    const done = () => { if (r.waiting) { clearTimeout(t); resolve(r.waiting); } };
    if (r.installing) r.installing.addEventListener('statechange', done);
    r.addEventListener('updatefound', () => { r.installing && r.installing.addEventListener('statechange', done); });
  });
}
