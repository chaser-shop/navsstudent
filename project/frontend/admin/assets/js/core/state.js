// Shared state: event bus, preferences, cached reference data, order cart, theme.
import { api } from './api.js';

const listeners = new Map();
export const bus = {
  on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    return () => listeners.get(evt)?.delete(fn);
  },
  emit(evt, payload) { listeners.get(evt)?.forEach((fn) => fn(payload)); },
};

export const prefs = {
  get(k, d) {
    try { const v = localStorage.getItem(`admin.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem(`admin.${k}`, JSON.stringify(v)); } catch { /* private mode */ }
  },
};

export const store = { me: null, settings: { shop_name: '', contact: '' }, brands: null, markups: null };

export async function getBrands(force = false) {
  if (!store.brands || force) store.brands = await api('/api/brands');
  return store.brands;
}
export async function getMarkups(force = false) {
  if (!store.markups || force) store.markups = await api('/api/pricing/markups');
  return store.markups;
}

const CART_KEY = 'admin.cart';
export const cart = {
  map() { try { return JSON.parse(sessionStorage.getItem(CART_KEY)) || {}; } catch { return {}; } },
  save(m) {
    try { sessionStorage.setItem(CART_KEY, JSON.stringify(m)); } catch { /* storage unavailable */ }
    bus.emit('cart', m);
  },
  lines() { return Object.values(this.map()); },
  count() { return this.lines().reduce((s, l) => s + l.qty, 0); },
  total() { return this.lines().reduce((s, l) => s + Number(l.price || 0) * l.qty, 0); },
  has(id) { return Boolean(this.map()[id]); },
  add(p, qty = 1) {
    const m = this.map();
    const cur = m[p.id];
    m[p.id] = {
      id: p.id, name: p.name, brand: p.brand, price: p.final_price, image: (p.images || [])[0] || null,
      qty: Math.min(1000, (cur?.qty || 0) + qty),
    };
    this.save(m);
  },
  setQty(id, qty) {
    const m = this.map();
    if (!m[id]) return;
    m[id].qty = Math.max(1, Math.min(1000, Math.round(Number(qty) || 1)));
    this.save(m);
  },
  remove(id) { const m = this.map(); delete m[id]; this.save(m); },
  clear() { this.save({}); },
};

const media = window.matchMedia('(prefers-color-scheme: light)');
export const theme = {
  get() { return prefs.get('theme', 'dark'); },
  resolve(mode = theme.get()) { return mode === 'system' ? (media.matches ? 'light' : 'dark') : mode; },
  apply(mode = theme.get()) {
    const t = theme.resolve(mode);
    document.documentElement.dataset.theme = t;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = t === 'light' ? '#f5f5f3' : '#0b0c0e';
  },
  set(mode) { prefs.set('theme', mode); theme.apply(mode); bus.emit('theme', mode); },
};
media.addEventListener?.('change', () => { if (theme.get() === 'system') theme.apply('system'); });
