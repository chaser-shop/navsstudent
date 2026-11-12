// Product images are served only to authenticated admins, so they are fetched as blobs.
import { api } from '../core/api.js';

const cache = new Map();
export const refName = (ref) => String(ref || '').split('/').pop();

export function imageURL(ref) {
  const name = refName(ref);
  if (!name) return Promise.reject(new Error('no image'));
  if (!cache.has(name)) {
    cache.set(name, api(`/api/media/${encodeURIComponent(name)}`).then((b) => URL.createObjectURL(b)).catch((e) => {
      cache.delete(name);
      throw e;
    }));
  }
  return cache.get(name);
}

function load(img) {
  imageURL(img.dataset.ref).then((url) => {
    img.addEventListener('load', () => img.classList.add('is-loaded'), { once: true });
    img.src = url;
  }).catch(() => img.remove());
}

let io;
/** Lazily loads every <img data-ref> inside root. */
export function hydrate(root) {
  if (!io) {
    io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); load(e.target); }
    }, { rootMargin: '240px' });
  }
  root.querySelectorAll('img[data-ref]:not([data-hydrated])').forEach((img) => {
    img.dataset.hydrated = '1';
    io.observe(img);
  });
}

export function clearMediaCache() {
  for (const p of cache.values()) p.then((u) => URL.revokeObjectURL(u)).catch(() => {});
  cache.clear();
}
