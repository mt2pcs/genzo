'use strict';
/* DriveApp の代替: プロジェクトJSONと画像ファイルの保存先。
   - gcs   : Google Cloud Storage（Cloud Run 本番）。書き込みは generation 前提条件付きで競合を検知する
   - local : ローカルファイルシステム（開発用）
   ファイルは GAS 版と同じ「名前」で識別する（fileId は名前と同値にして互換を保つ）。 */
var fs = require('fs');
var fsp = require('fs/promises');
var path = require('path');
var cfg = require('./config');

var MIME_BY_EXT = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.json':'application/json', '.txt':'text/plain' };
function mimeOf(name, fallback){ return MIME_BY_EXT[path.extname(name).toLowerCase()] || fallback || 'application/octet-stream'; }
function safeName(name){
  var n = String(name || '');
  if (!n || n.indexOf('..') >= 0 || /[\/\\]/.test(n.replace(/^(thumbs|backups)\//, ''))) throw new Error('不正なファイル名: ' + name);
  return n;
}

/* ---------- local ---------- */
function localStorage(){
  var root = path.resolve(cfg.dataDir);
  fs.mkdirSync(path.join(root, 'thumbs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'backups'), { recursive: true });
  var full = function(name){ return path.join(root, safeName(name)); };
  return {
    kind: 'local',
    describe: function(){ return 'local:' + root; },
    exists: async function(name){ try { await fsp.access(full(name)); return true; } catch(e){ return false; } },
    readText: async function(name){
      try { var s = await fsp.readFile(full(name), 'utf8'); var st = await fsp.stat(full(name)); return { text: s, generation: String(st.mtimeMs) }; }
      catch(e){ if (e.code === 'ENOENT') return null; throw e; }
    },
    writeText: async function(name, text, opts){
      opts = opts || {};
      if (opts.ifGenerationMatch !== undefined){
        var cur = await this.readText(name);
        var g = cur ? cur.generation : '0';
        if (String(g) !== String(opts.ifGenerationMatch)){ var err = new Error('書き込み競合: 他の処理がプロジェクトを更新しました'); err.code = 412; throw err; }
      }
      var tmp = full(name) + '.tmp' + process.pid;
      await fsp.writeFile(tmp, text, 'utf8');
      await fsp.rename(tmp, full(name));
    },
    readBytes: async function(name){
      try { var b = await fsp.readFile(full(name)); return { buffer: b, mime: mimeOf(name, 'image/png') }; }
      catch(e){ if (e.code === 'ENOENT') return null; throw e; }
    },
    writeBytes: async function(name, buffer){ await fsp.writeFile(full(name), buffer); return { id: name, name: name }; },
    remove: async function(name){ try { await fsp.unlink(full(name)); } catch(e){ if (e.code !== 'ENOENT') throw e; } },
    /* 直下のファイル名一覧（thumbs/ と backups/ は含めない）。移行の既存判定用 */
    listNames: async function(){
      var ents = await fsp.readdir(root, { withFileTypes: true });
      return ents.filter(function(e){ return e.isFile() && !/\.tmp\d+$/.test(e.name); }).map(function(e){ return e.name; });
    }
  };
}

/* ---------- gcs ---------- */
function gcsStorage(){
  var Storage = require('@google-cloud/storage').Storage;
  var bucket = new Storage().bucket(cfg.gcsBucket);
  var prefix = cfg.gcsPrefix;
  var obj = function(name){ return bucket.file(prefix + safeName(name)); };
  return {
    kind: 'gcs',
    describe: function(){ return 'gs://' + cfg.gcsBucket + '/' + prefix; },
    exists: async function(name){ var r = await obj(name).exists(); return r[0]; },
    readText: async function(name){
      var f = obj(name);
      try {
        var meta = (await f.getMetadata())[0];
        var buf = (await f.download())[0];
        return { text: buf.toString('utf8'), generation: String(meta.generation) };
      } catch(e){ if (e.code === 404) return null; throw e; }
    },
    writeText: async function(name, text, opts){
      opts = opts || {};
      var o = { contentType: mimeOf(name, 'application/json'), resumable: false };
      if (opts.ifGenerationMatch !== undefined) o.preconditionOpts = { ifGenerationMatch: Number(opts.ifGenerationMatch) };
      try { await obj(name).save(text, o); }
      catch(e){ if (e.code === 412){ var err = new Error('書き込み競合: 他の処理がプロジェクトを更新しました'); err.code = 412; throw err; } throw e; }
    },
    readBytes: async function(name){
      var f = obj(name);
      try {
        var meta = (await f.getMetadata())[0];
        var buf = (await f.download())[0];
        return { buffer: buf, mime: meta.contentType || mimeOf(name, 'image/png') };
      } catch(e){ if (e.code === 404) return null; throw e; }
    },
    writeBytes: async function(name, buffer, mime){
      await obj(name).save(buffer, { contentType: mime || mimeOf(name, 'image/png'), resumable: false });
      return { id: name, name: name };
    },
    remove: async function(name){ try { await obj(name).delete(); } catch(e){ if (e.code !== 404) throw e; } },
    listNames: async function(){
      var files = (await bucket.getFiles({ prefix: prefix }))[0];
      return files.map(function(f){ return f.name.slice(prefix.length); }).filter(function(n){ return n && n.indexOf('/') < 0; });
    }
  };
}

var impl = null;
function get(){
  if (impl) return impl;
  if (cfg.storage === 'gcs'){
    if (!cfg.gcsBucket) throw new Error('GCS_BUCKET が未設定です（保存先バケット。ローカル開発は STORAGE=local）');
    impl = gcsStorage();
  } else {
    impl = localStorage();
  }
  return impl;
}
module.exports = { get: get, mimeOf: mimeOf };
