'use strict';
/* GENZO の Express アプリ本体（index.js が listen する。テストはこのモジュールを直接使う）。
   - GET  /                 : public/index.html（GAS の doGet に相当）
   - GET  /login, /logout   : 入室画面（APP_PASSWORD 設定時のみ。パスワード1つ。server/auth.js）
   - POST /api/:fn          : google.script.run の代替。body={args:[...]} → {ok:true,result} / {ok:false,error}
   - GET  /files/:name      : 保存画像の直接配信（任意利用）
   - GET  /api/health       : ヘルスチェック（/healthz は Cloud Run の手前で 404 になるため使わない）
   - POST /api/admin/importFromDrive : GAS 版 Drive フォルダからの移行（server/drive_import.js） */
var path = require('path');
var express = require('express');
var cfg = require('./config');
var genzo = require('./genzo');
var storage = require('./storage');
var llm = require('./llm');
var driveImport = require('./drive_import');
var auth = require('./auth').create({ password: cfg.password, sessionSecret: cfg.sessionSecret });

var app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

/* /healthz は Cloud Run のフロントエンドに横取りされて 404 になるため /api/health を正とする（/healthz はローカル用の別名） */
app.get(['/api/health', '/healthz'], function(req, res){ res.json({ ok: true, storage: storage.get().describe(), llm: llm.describe(), seedRev: genzo.SEED_REV, auth: auth.enabled ? 'password' : 'none' }); });

auth.routes(app, express);
app.use(auth.middleware);

app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: 0, etag: true }));

/* 添付資料（analyzeStyleAssets）は base64 で最大 9MB 程度 → 余裕をもって 64MB */
app.use('/api', express.json({ limit: '64mb' }));

/* 移行: GAS 版の Drive フォルダから画像と genzo_project.json を取り込む（入室パスワードで保護。scripts/import-from-drive.sh が叩く） */
app.post('/api/admin/importFromDrive', async function(req, res){
  var t0 = Date.now();
  try {
    var r = await driveImport.run(req.body || {});
    console.log('[import] imported=' + r.imported.length + ' errors=' + r.errors.length + ' remaining=' + r.remaining + ' ' + (Date.now() - t0) + 'ms');
    res.json({ ok: true, result: r });
  } catch(e){
    console.error('[import] failed: ' + ((e && e.stack) || e));
    res.status(500).json({ ok: false, error: (e && e.message) || String(e) });
  }
});

app.post('/api/:fn', async function(req, res){
  var fn = req.params.fn;
  var impl = genzo.API[fn];
  if (!impl){ res.status(404).json({ ok: false, error: '未知の関数: ' + fn }); return; }
  var args = (req.body && Array.isArray(req.body.args)) ? req.body.args : [];
  var t0 = Date.now();
  try {
    var result = await impl.apply(null, args);
    if (result === undefined) result = null;
    res.json({ ok: true, result: result });
    console.log('[api] ' + fn + ' ok ' + (Date.now() - t0) + 'ms');
  } catch(e){
    var msg = (e && e.message) || String(e);
    console.error('[api] ' + fn + ' failed ' + (Date.now() - t0) + 'ms: ' + msg);
    if (e && e.stack && !(e.expected)) console.error(e.stack);
    res.status(500).json({ ok: false, error: msg });
  }
});

app.get('/files/:name', async function(req, res){
  try {
    var f = await genzo.readFile(req.params.name);
    if (!f){ res.status(404).send('not found'); return; }
    res.set('Content-Type', f.mime); res.set('Cache-Control', 'private, max-age=3600');
    res.send(f.buffer);
  } catch(e){ res.status(400).send((e && e.message) || 'error'); }
});

app.use(function(err, req, res, next){ // eslint-disable-line no-unused-vars
  console.error('[server] ' + ((err && err.stack) || err));
  res.status(err && err.type === 'entity.too.large' ? 413 : 500).json({ ok: false, error: (err && err.message) || 'server error' });
});

module.exports = app;
