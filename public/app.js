// Shared helpers for the business pages.
const API = (window.API_BASE || '').replace(/\/$/, '');
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const naira = k => '₦' + (k / 100).toLocaleString('en-NG');
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};
async function api(path, opts = {}) {
  const token = store.get('orderly_token');
  const r = await fetch(API + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (r.status === 401 && token && !path.startsWith('/api/auth')) { store.set('orderly_token', null); location.href = 'login.html'; }
  if (!r.ok) throw new Error(body.error || 'Request failed');
  return body;
}

// Toast notifications (success / error / info) — replaces alerts and inline messages.
function toast(msg, type = 'success') {
  let box = document.getElementById('toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = `toast ${type}`; t.setAttribute('role', type === 'error' ? 'alert' : 'status');
  t.innerHTML = `<span class="ti">${type === 'error' ? '!' : type === 'info' ? 'i' : '✓'}</span><span></span>`;
  t.lastChild.textContent = msg;
  t.onclick = () => t.remove();
  box.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, type === 'error' ? 5500 : 3200);
}
