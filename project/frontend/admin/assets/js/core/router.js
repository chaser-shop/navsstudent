// Hash router: "#/path?query". Filter state lives in the query so links and Back work.
const routes = [];

export function addRoute(path, load, meta = {}) {
  const keys = [];
  const re = new RegExp(`^${path.replace(/\/:([a-z]+)/gi, (_, k) => { keys.push(k); return '/([^/]+)'; })}/?$`);
  routes.push({ path, re, keys, load, meta });
}

export function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/';
  const i = h.indexOf('?');
  const path = (i >= 0 ? h.slice(0, i) : h) || '/';
  return { path, query: new URLSearchParams(i >= 0 ? h.slice(i + 1) : '') };
}

export function match(path) {
  for (const r of routes) {
    const m = r.re.exec(path);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { ...r, params };
    }
  }
  return null;
}

export function navigate(to) {
  if (location.hash === `#${to}`) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = to;
}

/** Updates the query of the current route without re-rendering the page. */
export function replaceQuery(query) {
  const { path } = parseHash();
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== '' && v != null && v !== false)).toString();
  history.replaceState(history.state, '', `#${path}${qs ? `?${qs}` : ''}`);
}

export const href = (path, query = {}) => {
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== '' && v != null)).toString();
  return `#${path}${qs ? `?${qs}` : ''}`;
};
