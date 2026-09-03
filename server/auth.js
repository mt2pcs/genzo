'use strict';
/* 入口の保護。ブラウザ標準の Basic 認証ダイアログの代わりに、GENZO と同じトーンのログイン画面を出す。
   - 資格情報は従来どおり APP_BASIC_AUTH="user:pass"（未設定なら保護なし）
   - ログイン成功で署名付き Cookie（HttpOnly, 30日）を発行。署名鍵は APP_SESSION_SECRET、未設定なら資格情報から導出
   - curl や deploy.sh の配信検証のために Authorization: Basic ヘッダも引き続き受け付ける
   - /api は未認証なら 401 JSON（画面側はそれを受けて /login へ移動する） */
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var COOKIE = 'genzo_session';
var TTL_SEC = 30 * 24 * 3600;
var LOGIN_HTML = fs.readFileSync(path.join(__dirname, 'login.html'), 'utf8');

function parseCreds(s){
  var i = String(s || '').indexOf(':');
  if (i <= 0) return null;
  return { user: s.slice(0, i), pass: s.slice(i + 1) };
}
function safeEq(a, b){
  var x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function esc(s){ return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function create(opts){
  var creds = parseCreds(opts.basicAuth);
  if (!creds) return { enabled: false, middleware: function(req, res, next){ next(); }, routes: function(){} };
  var secret = opts.sessionSecret || crypto.createHash('sha256').update('genzo|' + opts.basicAuth).digest('hex');

  function sign(payload){ return crypto.createHmac('sha256', secret).update(payload).digest('base64url'); }
  function issue(){
    var payload = creds.user + '|' + (Math.floor(Date.now() / 1000) + TTL_SEC);
    return Buffer.from(payload).toString('base64url') + '.' + sign(payload);
  }
  function verify(token){
    if (!token || token.indexOf('.') < 0) return false;
    var parts = token.split('.');
    var payload;
    try { payload = Buffer.from(parts[0], 'base64url').toString('utf8'); } catch(e){ return false; }
    if (!safeEq(sign(payload), parts[1])) return false;
    var seg = payload.split('|');
    return seg[0] === creds.user && Number(seg[1]) > Math.floor(Date.now() / 1000);
  }
  function cookieOf(req){
    var m = /(?:^|;\s*)genzo_session=([^;]+)/.exec(req.headers.cookie || '');
    return m ? decodeURIComponent(m[1]) : null;
  }
  function basicOk(req){
    var h = req.headers.authorization || '';
    if (!/^Basic /i.test(h)) return false;
    var dec;
    try { dec = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8'); } catch(e){ return false; }
    var c = parseCreds(dec);
    return !!c && safeEq(c.user, creds.user) && safeEq(c.pass, creds.pass);
  }
  function setCookie(res, req){
    var secure = req.secure || (req.headers['x-forwarded-proto'] === 'https');
    res.setHeader('Set-Cookie', COOKIE + '=' + encodeURIComponent(issue()) + '; Path=/; Max-Age=' + TTL_SEC + '; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : ''));
  }
  function safeNext(n){ return (typeof n === 'string' && /^\/(?!\/)/.test(n) && n !== '/login') ? n : '/'; }
  function page(res, status, vars){
    var html = LOGIN_HTML.replace(/\{\{ERROR\}\}/g, vars.error ? '<div class="err" role="alert">' + esc(vars.error) + '</div>' : '')
      .replace(/\{\{NEXT\}\}/g, esc(vars.next || '/'))
      .replace(/\{\{USER\}\}/g, esc(vars.user || ''));
    res.status(status).set('Content-Type', 'text/html; charset=utf-8').set('Cache-Control', 'no-store').send(html);
  }

  function middleware(req, res, next){
    if (req.path === '/healthz' || req.path === '/api/health' || req.path === '/login' || req.path === '/logout') return next();
    if (basicOk(req) || verify(cookieOf(req))) return next();
    if (req.path.indexOf('/api/') === 0){
      res.status(401).json({ ok: false, error: 'ログインが必要です', login: '/login' });
      return;
    }
    if (req.method === 'GET' && (req.accepts(['html', 'json']) === 'html')){
      res.redirect(302, '/login?next=' + encodeURIComponent(req.originalUrl || '/'));
      return;
    }
    res.status(401).send('Authentication required');
  }
  function routes(app, express){
    app.get('/login', function(req, res){
      if (verify(cookieOf(req))) return res.redirect(302, safeNext(req.query.next));
      page(res, 200, { next: safeNext(req.query.next) });
    });
    app.post('/login', express.urlencoded({ extended: false, limit: '8kb' }), function(req, res){
      var b = req.body || {};
      var ok = safeEq(b.user || '', creds.user) && safeEq(b.pass || '', creds.pass);
      if (!ok){
        setTimeout(function(){ page(res, 401, { error: 'ユーザー名かパスワードが違います', next: safeNext(b.next), user: b.user }); }, 400);
        return;
      }
      setCookie(res, req);
      res.redirect(303, safeNext(b.next));
    });
    app.get('/logout', function(req, res){
      res.setHeader('Set-Cookie', COOKIE + '=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
      res.redirect(302, '/login');
    });
  }
  return { enabled: true, middleware: middleware, routes: routes, _verify: verify, _issue: issue };
}
module.exports = { create: create };
