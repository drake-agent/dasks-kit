// The fleet page (/fleet): the captain lease, every runner's last heartbeat and the captain chat. Refreshed every 10 s.
// Chat posts go out as the logged-in human (session cookie + CSRF); every value goes in through textContent.
'use strict';
(() => {
  const LANG = (() => {
    let l = new URLSearchParams(location.search).get('lang');
    if (l !== 'ko' && l !== 'en') { try { l = localStorage.getItem('dasks.lang'); } catch { l = null; } }
    return l === 'ko' ? 'ko' : 'en';
  })();
  const tr = (k, v) => {
    let s = (typeof DICT === 'object' && (DICT[LANG]?.[k] ?? DICT.en[k])) || k;
    if (v) s = s.replace(/\{(\w+)\}/g, (m, x) => (v[x] !== undefined ? String(v[x]) : m));
    return s;
  };
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(LANG === 'ko' ? 'ko-KR' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
  document.documentElement.lang = LANG;
  document.title = `Dasks · ${tr('nav.fleet')}`;
  $('fleet-title').textContent = tr('nav.fleet');
  for (const e of document.querySelectorAll('[data-k]')) e.textContent = tr(e.dataset.k);
  document.querySelector('#chat-form textarea').placeholder = tr('fleet.chat.ph');
  document.querySelector('#login-form input').placeholder = tr('fleet.chat.pass');

  let csrf = '', seq = 0;
  async function session() {
    const r = await fetch('/api/session', { credentials: 'same-origin' });
    csrf = r.ok ? (await r.json()).csrf || '' : '';
    $('login-form').hidden = !!csrf; $('chat-form').hidden = !csrf;
  }
  async function get(path) {
    const r = await fetch(path, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  }
  async function refresh() {
    try {
      const [cap, fleet, chat] = await Promise.all([get('/api/captain'), get('/api/fleet'), get(`/api/captain/chat?since=${seq}`)]);
      $('captain').textContent = cap.lease ? tr('fleet.captain.on', { who: cap.lease.holder, t: when(cap.lease.expires_at) }) : tr('fleet.captain.none');
      const list = $('machines');
      list.replaceChildren(...fleet.machines.map((m) => {
        const li = el('li', 'fleet-machine');
        const head = el('div', 'fleet-row');
        head.append(el('strong', '', m.machine), el('span', `ds-badge state-${m.state}`, tr(`fleet.state.${m.state}`)));
        const meta = el('div', 'fleet-meta', [tr('fleet.seen', { t: when(m.last_seen) }), tr('fleet.slots', { n: m.slots }), m.harnesses.join(', '), m.version && `v${m.version}`, m.behind && tr('fleet.behind'), m.update && tr('fleet.held', { why: m.update })].filter(Boolean).join(' · '));
        li.append(head, meta);
        if (m.cards.length) li.append(el('div', 'fleet-cards', m.cards.join(' ')));
        return li;
      }));
      if (!fleet.machines.length) list.append(el('li', 'fleet-note', tr('fleet.machines.none')));
      $('quiet-note').textContent = tr('fleet.quiet.note', { n: fleet.dead_min });
      const ol = $('chat');
      if (!seq && !chat.messages.length) ol.replaceChildren(el('li', 'fleet-note', tr('fleet.chat.none')));
      if (chat.messages.length && !seq) ol.replaceChildren();
      for (const m of chat.messages) {
        const li = el('li', m.from === 'user' ? 'mine' : '');
        li.append(el('div', 'fleet-meta', `${m.from} · ${when(m.at)}`), el('div', 'fleet-text', m.text));
        ol.append(li);
      }
      seq = chat.last_seq;
    } catch (e) { $('captain').textContent = `${tr('fleet.loadfail')} (${e.message})`; }
  }
  $('chat-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const box = ev.target.text, err = $('chat-err');
    err.hidden = true;
    const r = await fetch('/api/captain/chat', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Dasks-Actor': 'user', 'X-Dasks-CSRF': csrf }, body: JSON.stringify({ text: box.value }) });
    if (r.ok) { box.value = ''; return refresh(); }
    const d = await r.json().catch(() => ({}));
    err.textContent = tr('fleet.chat.err', { e: d.error || r.status }); err.hidden = false;
    if (r.status === 401) await session();
  });
  $('login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = $('chat-err');
    const r = await fetch('/api/session', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'passphrase', passphrase: ev.target.passphrase.value }) });
    ev.target.passphrase.value = '';
    if (!r.ok) { const d = await r.json().catch(() => ({})); err.textContent = tr('fleet.chat.err', { e: d.error || r.status }); err.hidden = false; return; }
    err.hidden = true;
    await session(); await refresh();
  });
  session().then(refresh);
  setInterval(refresh, 10_000);
})();
