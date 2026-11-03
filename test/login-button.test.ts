import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { task, tempRepo } from './helpers.ts';
import { asHuman, humanSecrets, serve } from './state-support.ts';

const read = (f: string) => fs.readFileSync(path.resolve(f), 'utf8');

test('the More menu has the login button next to the language switch, hidden until the state is known', () => {
  const html = read('public/index.html');
  assert.match(html, /<div class="more-foot">\s*<button[^>]*id="auth-btn" data-action="auth" hidden><\/button>\s*<div class="ds-segmented lang"/);
  const css = read('public/style.css');
  const phone = /@media \(max-width: 760px\) \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.doesNotMatch(phone, /auth-btn|top-actions/, 'not hidden on phones');
});

test('app: state from GET /api/session, label log in / log out, click logs in or out, language switch relabels', () => {
  const app = read('public/app.js');
  assert.match(app, /async function refreshAuth\(\) \{\s*try \{\s*const r = await fetch\('\/api\/session'/);
  assert.match(app, /b\.textContent = t\(AUTH\.in \? 'auth\.logout' : 'auth\.login'\)/);
  // logout: re-checks the real state first, never asks for the passphrase, says "logged out" only when it is
  assert.match(app, /async function authClick\(\) \{\s*await refreshAuth\(\);/);
  assert.match(app, /fetch\('\/api\/session\/logout'/);
  assert.match(app, /if \(status === 200 \|\| status === 401\) \{ CSRF = ''; toast\(t\('auth\.out'\)\); \} else toast\(t\('auth\.outfail'\), true\);/);
  assert.match(app, /async function load\(\) \{\n  refreshAuth\(\);/);
  assert.match(app, /try \{ await login\(\); toast\(t\('auth\.ok'\)\); \}/);
  assert.match(app, /if \(a === 'auth'\) \{/);
  assert.match(app, /applyStatic\(\); renderAuth\(\); render\(\);/);
  assert.match(app, /refreshAuth\(\);\nload\(\)\.then/);
  // a login from any path (the up-front button or the 401 retry) updates the button
  assert.match(app, /if \(r\.ok\) \{ CSRF = data\.csrf \|\| ''; AUTH = \{ known: true, in: true/);
  const i18n = read('public/i18n.js');
  for (const k of ['auth.login', 'auth.logout', 'auth.in', 'auth.ok', 'auth.out', 'auth.outfail']) assert.equal(i18n.split(`'${k}'`).length - 1, 2, k);
});

test('server side the button relies on: GET /api/session 401 → login → 200 logged_in → logout → 401', async () => {
  const { root, cleanup } = tempRepo([task()]); const h = humanSecrets(); const s = await serve(root, h.env);
  try {
    assert.equal((await fetch(s.url + '/api/session')).status, 401);
    const me = await asHuman(s.url, '/api/session');
    assert.equal(me.status, 200); assert.equal(me.json.logged_in, true); assert.ok(me.json.expires_at);
    assert.equal((await asHuman(s.url, '/api/session/logout', {})).status, 200);
    assert.equal((await asHuman(s.url, '/api/session')).status, 401);
  } finally { await s.stop(); cleanup(); h.cleanup(); }
});
