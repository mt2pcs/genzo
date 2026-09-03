'use strict';
/* 本番の画面をこのセッション環境で描画して確認するための中継サーバ。
   サンドボックスの headless Chromium は外向き HTTPS が通らない（ERR_CONNECTION_RESET）が、Node の fetch は通るので、
   画面（public/index.html）をローカルで配り、/api と /files だけ本番へ入室パスワード付きで中継する。
     node scripts/preview-live.js            # http://127.0.0.1:18090 を Playwright で開く
   環境変数: APP_URL（既定は本番）, APP_PASSWORD（既定 genzo）, PORT（既定 18090） */
var express = require('express');
var path = require('path');
var PROD = (process.env.APP_URL || 'https://genzo-1066908065074.asia-northeast1.run.app').replace(/\/$/, '');
var AUTH = 'Basic ' + Buffer.from('genzo:' + (process.env.APP_PASSWORD || 'genzo')).toString('base64');
var app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(['/api', '/files'], express.raw({ type: '*/*', limit: '64mb' }), async function(req, res){
  try {
    var h = { Authorization: AUTH };
    if (req.headers['content-type']) h['Content-Type'] = req.headers['content-type'];
    var r = await fetch(PROD + req.originalUrl, { method: req.method, headers: h, body: (req.method === 'GET' || req.method === 'HEAD') ? undefined : req.body });
    res.status(r.status); var ct = r.headers.get('content-type'); if (ct) res.set('Content-Type', ct);
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch(e){ res.status(502).send(String(e)); }
});
var port = Number(process.env.PORT) || 18090;
app.listen(port, function(){ console.log('preview of ' + PROD + ' on http://127.0.0.1:' + port); });
