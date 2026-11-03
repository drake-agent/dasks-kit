// Day / night / auto. Classic blocking script, the FIRST child of <body> on every chrome page:
// the parser runs it before it lays out anything after it, so the page never draws in the wrong mode. No inline script:
// the CSP is script-src 'self'.
// Choice: #light / #dark in the URL (read once, never saved), else localStorage dasks-theme (light|dark|auto), else dark.
// Mode: body[data-mode] = light | dark (public/ds/tokens.css is dark; public/chrome.css maps the light palette).
'use strict';
(() => {
  const KEY = 'dasks-theme';
  const CHOICES = ['light', 'dark', 'auto'];
  const os = matchMedia('(prefers-color-scheme: dark)');
  let choice = location.hash === '#light' || location.hash === '#dark' ? location.hash.slice(1) : null;
  if (!choice) {
    let v = null;
    try { v = localStorage.getItem(KEY); } catch { v = null; }
    choice = CHOICES.includes(v) ? v : 'dark';
  }
  const mode = () => (choice === 'auto' ? (os.matches ? 'dark' : 'light') : choice);
  function apply() {
    document.body.dataset.mode = mode();
    document.body.dataset.themeChoice = choice;
  }
  const onOs = () => { if (choice === 'auto') apply(); };
  if (os.addEventListener) os.addEventListener('change', onOs); else os.addListener(onOs);
  apply();

  window.dasksTheme = {
    get: () => ({ choice, mode: mode() }),
    set(c) {
      if (!CHOICES.includes(c)) return false;
      choice = c;
      try { localStorage.setItem(KEY, c); } catch { /* private mode: applies for this page only */ }
      apply();
      document.dispatchEvent(new CustomEvent('dasks-theme', { detail: { choice, mode: mode() } }));
      return true;
    },
  };
})();
