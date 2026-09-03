'use strict';
/* GENZO Cloud Run サーバ。
   - GET  /                 : public/index.html（GAS の doGet に相当）
   - POST /api/:fn          : google.script.run の代替。body={args:[...]} → {ok:true,result} / {ok:false,error}
   - GET  /files/:name      : 保存画像の直接配信（任意利用）
   - GET  /healthz          : ヘルスチェック */
var path = require('path');
var express = require('express');
var cfg = require('./config');
var genzo = require('./genzo');
var storage = require('./storage');
var llm = require('./llm');

var app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

/* 任意の Basic 認証（IAP や Cloud Run の認証を使わない場合の最低限の保護） */
if (cfg.basicAuth){
  var expected = 'Basic ' + Buffer.from(cfg.basicAuth).toString('base64');
  app.use(function(req, res, next){
    if (req.path === '/healthz' || req.path === '/api/healthz') return next();
    if (req.headers.authorization === expected) return next();
    res.set('WWW-Authenticate', 'Basic realm="GENZO"');
    res.status(401).send('Authentication required');
  });
}

/* /api/healthz は /healthz の別名。Claude Code クラウド環境の agent proxy が /healthz を横取りして 404 を返すため、
   deploy.sh の配信検証はこちらを使う */
app.get(['/healthz', '/api/healthz'], function(req, res){ res.json({ ok: true, storage: storage.get().describe(), llm: llm.describe(), seedRev: genzo.SEED_REV }); });

app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: 0, etag: true }));

/* 添付資料（analyzeStyleAssets）は base64 で最大 9MB 程度 → 余裕をもって 64MB */
app.use('/api', express.json({ limit: '64mb' }));

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

var server = app.listen(cfg.port, function(){
  console.log('GENZO listening on :' + cfg.port + ' | storage=' + storage.get().describe() + ' | llm=' + llm.describe() + ' | seedRev=' + genzo.SEED_REV);
});
/* 生成は数分かかる（新方向 2〜6分）。Cloud Run 側の --timeout と併せてサーバ側のタイムアウトも延長 */
server.requestTimeout = 60 * 60 * 1000;
server.headersTimeout = 61 * 60 * 1000;
server.keepAliveTimeout = 620 * 1000;
