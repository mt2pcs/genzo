'use strict';
/* GAS 版 GENZO の Drive フォルダ（genzo_project.json と genzo_*.png）を保存先（GCS / ローカル）へ取り込む。
   - 一覧: Drive API（実行サービスアカウントのトークン。フォルダが SA に共有されているか公開なら読める）。
           取れなければ呼び出し側が渡す files=[{id,name}] を使う
   - 取得: Drive API の alt=media → 失敗時は公開ダウンロード URL（フォルダが「リンクを知っている全員」なら通る）
   - 1 回の呼び出しで limit 件まで同期処理して残数を返す。呼び出し側は remaining が 0 になるまで繰り返す
     （Cloud Run は応答後に CPU が止まるため、バックグラウンドではなく同期処理にしている）
   - 画像は保存先に無いものだけ取り込む（overwrite=true で上書き）。画像が揃ってから最後に project JSON を差し替える */
var storage = require('./storage');
var genzo = require('./genzo');

var PROJECT_NAME = 'genzo_project.json';
var IMAGE_RE = /\.(png|jpe?g|webp)$/i;
var _listCache = {}; // folderId → { at, files }
var LIST_TTL = 10 * 60 * 1000;

async function _token(){
  try {
    var GoogleAuth = require('google-auth-library').GoogleAuth;
    var auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
    return await auth.getAccessToken();
  } catch(e){ return null; }
}

async function _listViaApi(folderId, token, fetchFn){
  var files = [], pageToken = '';
  do {
    var q = "'" + folderId.replace(/'/g, "\\'") + "' in parents and trashed = false";
    var url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q)
      + '&fields=' + encodeURIComponent('nextPageToken,files(id,name,size,mimeType,modifiedTime)')
      + '&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    var r = await fetchFn(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw new Error('Drive 一覧 HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
    var j = await r.json();
    files = files.concat(j.files || []);
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return files;
}

async function _download(file, token, fetchFn){
  var errs = [];
  if (token){
    try {
      var r = await fetchFn('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(file.id) + '?alt=media&supportsAllDrives=true', { headers: { Authorization: 'Bearer ' + token } });
      if (r.ok) return { buffer: Buffer.from(await r.arrayBuffer()), mime: (r.headers.get('content-type') || '').split(';')[0] };
      errs.push('api HTTP ' + r.status);
    } catch(e){ errs.push('api ' + (e.message || e)); }
  }
  var pub = await fetchFn('https://drive.usercontent.google.com/download?id=' + encodeURIComponent(file.id) + '&export=download', { redirect: 'follow' });
  if (!pub.ok) throw new Error(errs.concat(['public HTTP ' + pub.status]).join(' / '));
  var ct = (pub.headers.get('content-type') || '').split(';')[0];
  var buf = Buffer.from(await pub.arrayBuffer());
  if (/text\/html/i.test(ct)) throw new Error(errs.concat(['public: HTML が返った（共有設定を確認）']).join(' / '));
  return { buffer: buf, mime: ct };
}

function _dedupe(files){
  // 同名が複数あれば新しい方を採る（GAS 版は同名で作り直すことがあった）
  var by = {};
  files.forEach(function(f){
    var cur = by[f.name];
    if (!cur || String(f.modifiedTime || '') > String(cur.modifiedTime || '')) by[f.name] = f;
  });
  return Object.keys(by).map(function(n){ return by[n]; });
}

/* opts: { folderId, files?, limit=40, concurrency=4, overwrite=false, images=true, project=true, dryRun=false } */
async function run(opts, deps){
  opts = opts || {}; deps = deps || {};
  var fetchFn = deps.fetch || fetch;
  var folderId = String(opts.folderId || '').trim();
  var limit = Math.max(1, Math.min(200, Number(opts.limit) || 40));
  var conc = Math.max(1, Math.min(8, Number(opts.concurrency) || 4));
  var t0 = Date.now();
  var token = deps.token !== undefined ? deps.token : await _token();
  var notes = [];

  var listing = null;
  if (Array.isArray(opts.files) && opts.files.length){ listing = opts.files; notes.push('一覧: 呼び出し側から ' + listing.length + ' 件'); }
  else {
    if (!folderId) throw new Error('folderId か files が必要です');
    var c = _listCache[folderId];
    if (c && Date.now() - c.at < LIST_TTL) listing = c.files;
    else {
      if (!token) throw new Error('Drive の一覧を取得できません（実行 SA のトークンが無い）。files=[{id,name}] を渡してください');
      listing = await _listViaApi(folderId, token, fetchFn);
      _listCache[folderId] = { at: Date.now(), files: listing };
    }
    notes.push('一覧: Drive API から ' + listing.length + ' 件');
  }
  listing = _dedupe(listing.filter(function(f){ return f && f.id && f.name; }));

  var store = storage.get();
  var existing = new Set(await store.listNames());
  var images = listing.filter(function(f){ return IMAGE_RE.test(f.name); });
  var projectFile = listing.filter(function(f){ return f.name === PROJECT_NAME; })[0] || null;
  var todo = images.filter(function(f){ return opts.overwrite || !existing.has(f.name); });
  var result = { folderId: folderId, listed: listing.length, images: images.length, alreadyPresent: images.length - todo.length, imported: [], errors: [], remaining: 0, project: null, notes: notes, ms: 0 };

  if (opts.images === false) todo = [];
  var batch = todo.slice(0, limit);
  result.remaining = todo.length - batch.length;
  if (opts.dryRun){ result.wouldImport = batch.map(function(f){ return f.name; }); result.ms = Date.now() - t0; return result; }

  var idx = 0;
  async function worker(){
    while (idx < batch.length){
      var f = batch[idx++];
      try {
        var d = await _download(f, token, fetchFn);
        if (f.size && Number(f.size) !== d.buffer.length) throw new Error('サイズ不一致 ' + d.buffer.length + ' != ' + f.size);
        await genzo.saveFile(f.name, d.buffer, /^image\//.test(d.mime) ? d.mime : storage.mimeOf(f.name, 'image/png'));
        result.imported.push(f.name);
      } catch(e){ result.errors.push({ name: f.name, error: (e && e.message) || String(e) }); }
    }
  }
  var workers = []; for (var i = 0; i < conc; i++) workers.push(worker());
  await Promise.all(workers);

  // 画像が揃った（残り 0・この回のエラー 0）ときだけ project JSON を差し替える
  if (opts.project !== false && projectFile && result.remaining === 0 && result.errors.length === 0){
    try {
      var pj = await _download(projectFile, token, fetchFn);
      result.project = await genzo.replaceProject(pj.buffer.toString('utf8'));
    } catch(e){ result.errors.push({ name: PROJECT_NAME, error: (e && e.message) || String(e) }); }
  } else if (opts.project !== false && !projectFile){
    notes.push('一覧に ' + PROJECT_NAME + ' が無いためプロジェクトは差し替えない');
  }
  result.ms = Date.now() - t0;
  return result;
}

module.exports = { run: run, _internal: { dedupe: _dedupe } };
