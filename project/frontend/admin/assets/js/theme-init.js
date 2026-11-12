// Applies the saved theme before first paint (external file so a strict CSP can forbid inline scripts).
(function () {
  try {
    var mode = JSON.parse(localStorage.getItem('admin.theme') || '"dark"');
    if (mode === 'system') mode = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', mode === 'light' ? 'light' : 'dark');
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
