'use strict';
/* Drive からの移行（server/drive_import.js）。Drive の代わりに fetch を差し替えて検証する */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.STORAGE = 'local';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'genzo-import-'));
process.env.LLM_PROVIDER = 'openai';

const genzo = require('../server/genzo');
const storage = require('../server/storage');
const driveImport = require('../server/drive_import');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
function resp(body, type, status){
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  return { ok: (status || 200) < 300, status: status || 200, headers: { get: (k) => k.toLowerCase() === 'content-type' ? type : null },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), text: async () => buf.toString(), json: async () => JSON.parse(buf.toString()) };
}

test('一覧→画像→project の順に取り込み、既存はスキップし、失敗はエラーとして返す', async () => {
  const seed = genzo._internal.seedProject();
  seed.directions = [{ id: 'd1', versions: [{ id: 'v1', visuals: { kv: { status: 'done', file: 'genzo_a.png' } } }] }];
  const listing = [
    { id: 'A', name: 'genzo_a.png', size: PNG.length, modifiedTime: '2026-01-01T00:00:00Z' },
    { id: 'A0', name: 'genzo_a.png', size: 1, modifiedTime: '2025-01-01T00:00:00Z' }, // 古い同名 → 無視
    { id: 'B', name: 'genzo_b.png', size: PNG.length },
    { id: 'C', name: 'genzo_c.png', size: PNG.length },
    { id: 'P', name: 'genzo_project.json' },
    { id: 'X', name: 'memo.txt' }
  ];
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    if (url.startsWith('https://www.googleapis.com/drive/v3/files?')) return resp(JSON.stringify({ files: listing }), 'application/json');
    const m = /(?:files\/|id=)([A-Z0-9]+)/.exec(url); const id = m && m[1];
    if (url.includes('googleapis.com')) return resp('nope', 'text/plain', 403); // API は権限なし → 公開 URL へ
    if (id === 'C') return resp('<html>virus scan</html>', 'text/html');
    if (id === 'P') return resp(JSON.stringify(seed), 'application/json');
    return resp(PNG, 'image/png');
  };
  const deps = { fetch: fakeFetch, token: 'tok' };
  const st = storage.get();
  await st.writeBytes('genzo_b.png', Buffer.from('old'));
  await genzo.API.getProject(); // 本番同様、シード済みのプロジェクトがある状態から始める

  const r1 = await driveImport.run({ folderId: 'F', limit: 1 }, deps);
  assert.equal(r1.listed, 5); assert.equal(r1.images, 3); assert.equal(r1.alreadyPresent, 1);
  assert.deepEqual(r1.imported, ['genzo_a.png']); assert.equal(r1.remaining, 1); assert.equal(r1.project, null);
  assert.ok(calls.some(u => u.includes('drive.usercontent.google.com')));

  const r2 = await driveImport.run({ folderId: 'F', limit: 10 }, deps); // 一覧はキャッシュ
  assert.equal(r2.errors.length, 1); assert.equal(r2.errors[0].name, 'genzo_c.png'); assert.match(r2.errors[0].error, /HTML/);
  assert.equal(r2.project, null, 'エラーがある回では project を差し替えない');
  assert.equal(calls.filter(u => u.includes('/drive/v3/files?')).length, 1);

  listing[3].id = 'C2'; // 修正された想定で再実行（キャッシュ中なので files を明示）
  const r3 = await driveImport.run({ folderId: 'F', files: listing, limit: 10 }, deps);
  assert.deepEqual(r3.imported, ['genzo_c.png']); assert.equal(r3.remaining, 0); assert.equal(r3.errors.length, 0);
  assert.ok(r3.project && r3.project.backup && r3.project.directions === 1);
  assert.equal((await st.readBytes('genzo_b.png')).buffer.toString(), 'old', '既存はそのまま');
  const p = await genzo.API.getProject();
  assert.equal(p.directions[0].id, 'd1');
  assert.ok((await st.listNames()).includes('genzo_project.json'));
  assert.ok(!(await st.listNames()).some(n => n.startsWith('backups/')));

  const r4 = await driveImport.run({ folderId: 'F', files: listing, overwrite: true, dryRun: true }, deps);
  assert.equal(r4.wouldImport.length, 3);
});

test('壊れた project JSON は受け付けない', async () => {
  await assert.rejects(genzo.replaceProject('{"version":2}'), /形式/);
  await assert.rejects(genzo.replaceProject('not json'), /JSON/);
});
