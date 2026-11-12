/* Тема: «Авто» (за системою), «Світла», «Темна». Вибір зберігається на пристрої (localStorage, ключ theme). */
(() => {
  'use strict';
  const root = document.documentElement;
  const mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  const mode = () => { try { const v = JSON.parse(localStorage.getItem('theme')); return v === 'light' || v === 'dark' ? v : 'auto'; } catch (e) { return 'auto'; } };
  function apply() {
    const m = mode();
    const dark = m === 'dark' || (m === 'auto' && !!(mq && mq.matches));
    if (m === 'auto') delete root.dataset.theme; else root.dataset.theme = m;
    // Автоматична темна тема вмикається класом — одна копія змінних у CSS для обох випадків.
    root.classList.toggle('dark-auto', m === 'auto' && dark);
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta); }
    meta.content = dark ? '#0b0e14' : '#f5f6f8';
  }
  window.__applyTheme = apply;
  if (mq && mq.addEventListener) mq.addEventListener('change', apply);
  apply();
})();
