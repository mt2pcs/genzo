'use strict';
/* GENZO Cloud Run サーバの起動点。アプリ本体は server/app.js */
var cfg = require('./config');
var app = require('./app');
var storage = require('./storage');
var llm = require('./llm');
var genzo = require('./genzo');

var server = app.listen(cfg.port, function(){
  console.log('GENZO listening on :' + cfg.port + ' | storage=' + storage.get().describe() + ' | llm=' + llm.describe() + ' | seedRev=' + genzo.SEED_REV + ' | auth=' + (cfg.basicAuth ? 'login' : 'none'));
});
/* 生成は数分かかる（新方向 2〜6分）。Cloud Run 側の --timeout と併せてサーバ側のタイムアウトも延長 */
server.requestTimeout = 60 * 60 * 1000;
server.headersTimeout = 61 * 60 * 1000;
server.keepAliveTimeout = 620 * 1000;
