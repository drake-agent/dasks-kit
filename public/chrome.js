// The shared app chrome (top bar, phone bottom bar, More menu) on every page: index.html holds the one copy of the
// markup; /asks fetches it from "/" and inserts it, so the pages can never drift apart.
// Classic script, no modules: index.html loads it before app.js, the other pages before their own module.
'use strict';
(() => {
  const PAGE_VIEW = { '/asks': 'asks', '/fleet': 'fleet' };
  // The same language rule as the pages themselves: ?lang=, else the saved choice, else English.
  const lang = (() => {
    let l = new URLSearchParams(location.search).get('lang');
    if (l !== 'ko' && l !== 'en') { try { l = localStorage.getItem('dasks.lang'); } catch { l = null; } }
    return l === 'ko' ? 'ko' : 'en';
  })();
  const label = (k) => (typeof DICT === 'object' && (DICT[lang]?.[k] || DICT.en[k])) || '';
  let opener = null; // the More button that opened the menu: focus goes back to it

  function setMenu(open) {
    const menu = document.getElementById('more-menu');
    if (!menu) return;
    menu.hidden = !open;
    for (const b of document.querySelectorAll('.nav-more')) b.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('more-open', open);
    // Wide screens: hang the popover under the top-bar More button (phones show it as a sheet, placed by CSS).
    const btn = document.querySelector('.topbar .nav-more');
    if (open && btn && btn.offsetParent) {
      const r = btn.getBoundingClientRect();
      menu.style.top = `${Math.round(r.bottom + 6)}px`;
      menu.style.right = `${Math.max(8, Math.round(document.documentElement.clientWidth - r.right))}px`;
    } else { menu.style.top = ''; menu.style.right = ''; }
    if (open) menu.querySelector('a, button')?.focus({ preventScroll: true });
  }
  /** More shows as current when the page on screen is one of its links (aria-current set by app.js or below). */
  function syncMore() {
    const inMenu = !!document.querySelector('#more-menu [aria-current="page"]:not(.more-phone)');
    const phoneOnly = !!document.querySelector('#more-menu .more-phone[aria-current="page"]');
    const cur = document.querySelector('#more-menu [aria-current="page"]');
    for (const b of document.querySelectorAll('.nav-more')) {
      const on = inMenu || (phoneOnly && !!b.closest('.bottombar'));
      b.toggleAttribute('data-active', on);
      // While one of its pages is open the top-bar button says which ("Goals ▾"); its accessible name still says it opens
      // the More menu. The phone tab keeps More (its ••• icon would not match a page name) and is lit; the page's own
      // heading names it.
      const lab = b.querySelector('span');
      if (lab && on && cur && !b.closest('.bottombar')) { lab.dataset.base ??= lab.textContent; lab.textContent = cur.textContent.trim(); b.setAttribute('aria-label', `${lab.dataset.base} · ${lab.textContent}`); }
      else if (lab && lab.dataset.base !== undefined) { lab.textContent = lab.dataset.base; delete lab.dataset.base; b.removeAttribute('aria-label'); }
    }
  }
  /** Day / night / auto in the More menu (theme-boot.js owns the choice): the pressed button is the choice in effect. */
  function syncTheme() {
    const cur = window.dasksTheme?.get().choice;
    for (const b of document.querySelectorAll('[data-set-theme]')) b.setAttribute('aria-pressed', String(b.dataset.setTheme === cur));
  }
  window.DasksChrome = { setMenu, syncMore };
  document.addEventListener('dasks-theme', syncTheme);
  syncTheme();

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-set-theme]');
    if (t) { window.dasksTheme?.set(t.dataset.setTheme); return; }
    const b = e.target.closest('.nav-more');
    if (b) { e.preventDefault(); opener = b; setMenu(document.getElementById('more-menu').hidden); return; }
    const menu = document.getElementById('more-menu');
    if (!menu || menu.hidden) return;
    if (e.target.closest('#more-menu a') || !e.target.closest('#more-menu')) setMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const menu = document.getElementById('more-menu');
    if (!menu || menu.hidden) return;
    // This Escape closes the menu only: the board's own Escape (panel, drawer) must not also run.
    e.stopImmediatePropagation();
    setMenu(false);
    (opener?.offsetParent ? opener : [...document.querySelectorAll('.nav-more')].find((x) => x.offsetParent))?.focus();
  });

  /** The board page's last top-bar values (app.js renderChrome), when fresh: the your-turn badge and the live dot. */
  function fillFromSnapshot() {
    let snap = null;
    try { snap = JSON.parse(localStorage.getItem('dasks.chrome') || 'null'); } catch { snap = null; }
    if (!snap || !(Date.now() - snap.at < 30 * 60_000)) return;
    for (const b of document.querySelectorAll('#badge-top, #badge-bottom')) { b.textContent = String(snap.n); b.hidden = !snap.n; }
    // The board page was live a moment ago: say so here too (older than two minutes, the dot stays hidden).
    const live = document.getElementById('live'), left = snap.at + 2 * 60_000 - Date.now();
    if (live && left > 0) { live.classList.add('on'); setTimeout(() => live.classList.remove('on'), left); }
  }

  // Standalone pages: borrow the chrome from index.html (login and language stay with app.js); the badge and the live dot
  // come from fillFromSnapshot.
  if (document.querySelector('.topbar')) return;
  const view = PAGE_VIEW[location.pathname.replace(/\/$/, '')] || '';
  fetch('/', { headers: { accept: 'text/html' } }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.status)))).then((html) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const top = doc.querySelector('.topbar'), bottom = doc.querySelector('.bottombar'), menu = doc.querySelector('#more-menu');
    if (!top || !bottom || !menu) return;
    for (const el of menu.querySelectorAll('.more-foot')) el.remove();
    for (const root of [top, bottom, menu]) {
      for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = label(el.dataset.i18n);
      for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', label(el.dataset.i18nAria));
      // Hash routes belong to the board page.
      for (const a of root.querySelectorAll('a[href^="#/"]')) a.setAttribute('href', `/${a.getAttribute('href')}`);
      for (const a of root.querySelectorAll('[data-view]')) a.setAttribute('aria-current', a.dataset.view === view ? 'page' : 'false');
    }
    document.body.prepend(document.adoptNode(top), document.adoptNode(menu));
    document.body.append(document.adoptNode(bottom));
    document.body.classList.add('has-chrome');
    syncTheme();
    fillFromSnapshot();
    syncMore();
  }).catch(() => { /* the page still works without the chrome: its own heading stays */ });
})();
