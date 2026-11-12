// Стан застосунку: користувач і дані /api/sync (розклад, предмети, домашнє), локальні позначки пристрою.

import { api, LS, setToken, clearImageCache } from './api.js';

const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}
export function emit(event, payload) {
  for (const fn of listeners.get(event) || []) {
    try { fn(payload); } catch (e) { console.error(e); }
  }
}

export const store = {
  user: null,
  data: null, // відповідь /api/sync
  lastSync: 0,
};

export function loadCache() {
  const c = LS.get('cache');
  if (c && c.user) {
    store.user = c.user;
    store.data = c;
  }
  return !!store.user;
}

let syncing = null;
export function sync() {
  if (!syncing) {
    syncing = api('GET', '/api/sync')
      .then((d) => {
        const prevUser = store.user;
        store.user = d.user;
        store.data = d;
        store.lastSync = Date.now();
        LS.set('cache', d);
        emit('sync', d);
        if (!prevUser || prevUser.isAdmin !== d.user.isAdmin || prevUser.canModerate !== d.user.canModerate || prevUser.hasPassword !== d.user.hasPassword) emit('user', d.user);
        return d;
      })
      .finally(() => { syncing = null; });
  }
  return syncing;
}

export function setUser(user) {
  store.user = { ...(store.user || {}), ...user };
  if (store.data) store.data.user = store.user;
  emit('user', store.user);
}

export function clearSession() {
  setToken(null);
  LS.del('cache');
  store.user = null;
  store.data = null;
  store.lastSync = 0;
  clearImageCache();
}

export const isAdmin = () => !!(store.user && store.user.isAdmin);
export const canModerate = () => !!(store.user && (store.user.isAdmin || store.user.canModerate));

export const subjectName = (key) => {
  const s = store.data && store.data.subjects && store.data.subjects[key];
  return (s && s.fullName) || key || 'Предмет';
};
export const subjectLink = (key) => {
  const s = store.data && store.data.subjects && store.data.subjects[key];
  return (s && s.link) || '';
};
export const teacherName = (key) => {
  const t = store.data && store.data.teachers && store.data.teachers[key];
  return t || key || '';
};

// Локальні позначки (лише на цьому пристрої): виконане домашнє.
const doneSet = new Set(LS.get('done', []));
export const isDone = (id) => doneSet.has(id);
export function toggleDone(id, value) {
  if (value ?? !doneSet.has(id)) doneSet.add(id); else doneSet.delete(id);
  LS.set('done', [...doneSet].slice(-500));
  emit('done', id);
}

// Відповіді на «Що задали?»: сервер пам’ятає їх за акаунтом, тут — щоб одразу сховати плашку.
const answeredLocal = new Set(LS.get('answered', []));
export const isAnswered = (lessonId) => answeredLocal.has(lessonId)
  || !!(store.data && ((store.data.answered || []).includes(lessonId) || (store.data.noHomework || []).includes(lessonId)));
export async function markAnswered(lessonId) {
  answeredLocal.add(lessonId);
  LS.set('answered', [...answeredLocal].slice(-300));
  emit('answered', lessonId);
  try { await api('POST', `/api/lessons/${encodeURIComponent(lessonId)}/answered`); } catch { /* позначка лишається локально */ }
}
