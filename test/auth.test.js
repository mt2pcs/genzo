'use strict';
/* ログイン画面（Cookie セッション）と Basic ヘッダ互換の検証。外部サービスには接続しない */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.STORAGE = 'local';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'genzo-auth-'));
process.env.APP_BASIC_AUTH = 'genzo:secret';

const app = require('../server/app');
let server, base;
test.before(async () => { await new Promise(r => { server = app.listen(0, () => { base = 'http://127.0.0.1:' + server.address().port; r(); }); }); });
test.after(() => server.close());

const noRedirect = { redirect: 'manual' };

test('未ログインの画面アクセスは /login へ、/api は 401 JSON、/healthz は素通し', async () => {
  const r = await fetch(base + '/', noRedirect);
  assert.equal(r.status, 302);
  assert.ok(r.headers.get('location').startsWith('/login?next=%2F'));
  const a = await fetch(base + '/api/getProject', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"args":[]}' });
  assert.equal(a.status, 401);
  const j = await a.json();
  assert.equal(j.ok, false); assert.equal(j.login, '/login');
  const h = await fetch(base + '/healthz');
  assert.equal(h.status, 200);
  assert.equal((await h.json()).auth, 'login');
});

test('ログイン画面は GENZO のトーンで描画され、誤入力は 401 で同じ画面に戻る', async () => {
  const r = await fetch(base + '/login?next=/foo');
  const html = await r.text();
  assert.ok(html.includes('GEN<i>Z</i>O'));
  assert.ok(html.includes('name="next" value="/foo"'));
  assert.ok(!html.includes('{{'));
  const bad = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'user=genzo&pass=wrong&next=/foo', ...noRedirect });
  assert.equal(bad.status, 401);
  assert.ok((await bad.text()).includes('ユーザー名かパスワードが違います'));
});

test('正しい資格情報で Cookie が発行され、以後は画面と /api が通る。/logout で失効', async () => {
  const ok = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'user=genzo&pass=secret&next=/', ...noRedirect });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/');
  const cookie = ok.headers.get('set-cookie');
  assert.ok(/genzo_session=.+HttpOnly/.test(cookie));
  const c = cookie.split(';')[0];
  const page = await fetch(base + '/', { headers: { Cookie: c }, ...noRedirect });
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('UI_REV'));
  const api = await fetch(base + '/api/saveProject', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: c }, body: '{"args":[{}]}' });
  assert.equal(api.status, 200);
  const again = await fetch(base + '/login', { headers: { Cookie: c }, ...noRedirect });
  assert.equal(again.status, 302); // ログイン済みなら画面へ戻す
  const out = await fetch(base + '/logout', { headers: { Cookie: c }, ...noRedirect });
  assert.ok(/Max-Age=0/.test(out.headers.get('set-cookie')));
  const forged = await fetch(base + '/', { headers: { Cookie: 'genzo_session=' + Buffer.from('genzo|9999999999').toString('base64url') + '.bad' }, ...noRedirect });
  assert.equal(forged.status, 302);
});

test('Basic ヘッダ（curl / deploy.sh の配信検証）も引き続き受け付ける', async () => {
  const h = { Authorization: 'Basic ' + Buffer.from('genzo:secret').toString('base64') };
  const r = await fetch(base + '/', { headers: h, ...noRedirect });
  assert.equal(r.status, 200);
  const bad = await fetch(base + '/', { headers: { Authorization: 'Basic ' + Buffer.from('genzo:nope').toString('base64') }, ...noRedirect });
  assert.equal(bad.status, 302);
});
