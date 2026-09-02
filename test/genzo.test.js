'use strict';
/* ローカル保存先 + LLM モックで、移植後のバックエンド API を通しで検証する。
   実行: npm test（外部サービスには接続しない） */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.STORAGE = 'local';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'genzo-test-'));
process.env.LLM_PROVIDER = 'vertex';

const llm = require('../server/llm');
const genzo = require('../server/genzo');
const API = genzo.API;

/* LLM モック: 直近の呼び出しを記録し、テストごとに応答を差し替える */
const calls = [];
let nextReply = () => '{}';
llm.chat = async function(messages, opts){ calls.push({ messages, opts }); return nextReply(messages, opts); };
llm.groundedSearch = async function(prompt){ calls.push({ grounded: prompt }); return { text: JSON.stringify({ summary: 'ok', findings: [{ claim: 'x', publisher: 'p', title: 't', year: '2026', url: 'https://example.com' }], conditions: ['c'], verdict: 'clear', verdict_reason: 'r' }), cites: [] }; };
llm.genImage = async function(prompt, opts, refs){
  calls.push({ image: prompt, opts, refs: (refs || []).length });
  // 16x16 の PNG を sharp で生成
  const sharp = require('sharp');
  const buf = await sharp({ create: { width: 64, height: 96, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
  return buf.toString('base64');
};

test('getProject: シードから v3 プロジェクトを生成し永続化する', async () => {
  const p = await API.getProject();
  assert.equal(p.version, 3);
  assert.equal(p.seedRev, genzo.SEED_REV);
  assert.ok(p.perception && p.perception.findings.length > 0);
  assert.ok(p.concepts.length >= 3);
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, 'genzo_project.json')));
  // 2回目は保存済み JSON を読む（同じ内容）
  const p2 = await API.getProject();
  assert.equal(p2.seedRev, genzo.SEED_REV);
  assert.deepEqual(p2.concepts.map(c => c.id), p.concepts.map(c => c.id));
});

test('_migrate: 旧 rev の JSON はシードで更新されユーザー資産は保持される', async () => {
  const file = path.join(process.env.DATA_DIR, 'genzo_project.json');
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  p.seedRev = 1;
  p.directions[0].note = 'ユーザーのメモ';
  p.tabPrefs = { hidden: [], order: [] };
  fs.writeFileSync(file, JSON.stringify(p));
  const m = await API.getProject();
  assert.equal(m.seedRev, genzo.SEED_REV);
  assert.equal(m.directions.find(d => d.id === p.directions[0].id).note, 'ユーザーのメモ');
});

test('saveProject / updateTabPrefs / saveNote: ロック付き更新が保存される', async () => {
  const p = await API.getProject();
  const cid = p.concepts[1].id;
  await API.saveProject({ activeConceptId: cid });
  const p2 = await API.getProject();
  assert.equal(p2.activeConceptId, cid);
  const p3 = await API.updateTabPrefs({ id: p2.concepts[0].id, op: 'hide' });
  assert.ok(p3.tabPrefs.hidden.includes(p2.concepts[0].id));
  await assert.rejects(API.updateTabPrefs({ id: 'nope', op: 'hide' }), /未知のコンセプト/);
  const d = p3.directions[0];
  await API.saveNote(d.id, 'note-1');
  const p4 = await API.getProject();
  assert.equal(p4.directions.find(x => x.id === d.id).note, 'note-1');
});

test('directInput: LLM 応答（JSON）を提案として返し、approveProposal で版が作られる', async () => {
  const p = await API.getProject();
  const dir = p.directions.find(d => !d.gated);
  const parent = dir.versions.find(v => v.id === dir.repVersionId);
  nextReply = () => JSON.stringify({
    interpretation: { moves: [{ variable: 'V1', change: 'x', magnitude: '小', note: 'n' }] },
    matched: [], verdict: { status: 'ok' },
    spec: Object.assign(JSON.parse(JSON.stringify(parent.spec)), { label: 'テスト派生', changed: ['surface'],
      design: Object.assign(JSON.parse(JSON.stringify(parent.spec.design)), { surface: { v: '新しい地', en: 'new ground', why: 'w' } }) })
  });
  const prop = await API.directInput({ directionId: dir.id, versionId: parent.id, input: { type: 'text', text: '地を変える' } });
  // 親版の符号をそのまま返すため、模倣検知（機械検査）が warn を付けることがある＝GAS版と同じ挙動
  assert.ok(['ok', 'warn'].includes(prop.verdict.status), prop.verdict.status);
  assert.equal(prop._input.conceptId, dir.conceptId);
  const last = calls[calls.length - 1];
  assert.equal(last.opts.json, true);
  assert.equal(last.messages[0].role, 'system');
  const r = await API.approveProposal({ directionId: dir.id, parentVersionId: parent.id, proposal: prop });
  const d2 = r.project.directions.find(d => d.id === dir.id);
  const v = d2.versions.find(v => v.id === r.versionId);
  assert.equal(v.label, 'テスト派生');
  assert.equal(v.spec.design.surface.en, 'new ground');
  assert.ok(v.spec.prompts && v.spec.prompts.package.includes('new ground'));
  assert.ok(v.spec.shelfCheck);
  await assert.rejects(API.directInput({ conceptId: 'no-such-concept', input: { text: 'x' } }), /コンセプトが見つかりません/);
});

test('generateVisual → getThumbs → getFullImage → clearVersionOutputs', async () => {
  const p = await API.getProject();
  const dir = p.directions.find(d => !d.gated);
  const v = dir.versions[0];
  const r = await API.generateVisual(dir.id, v.id, 'package', 'メモ');
  assert.ok(r.dataUri.startsWith('data:image/png;base64,'));
  const img = calls[calls.length - 1];
  assert.equal(img.opts.aspectRatio, '3:4');
  assert.ok(img.image.includes('Hard constraints'));
  assert.ok(img.image.includes('ART DIRECTION NOTE'));
  const p2 = await API.getProject();
  const vis = p2.directions.find(d => d.id === dir.id).versions[0].visuals.package;
  assert.equal(vis.status, 'done');
  assert.equal(vis.file, r.file);
  // kv は package を参照画像として渡す
  await API.generateVisual(dir.id, v.id, 'kv', '');
  assert.equal(calls[calls.length - 1].refs, 1);
  const th = await API.getThumbs([r.file, 'missing.png']);
  assert.ok(th[r.file] && th[r.file].startsWith('data:image/jpeg;base64,'));
  assert.equal(th['missing.png'], undefined);
  const full = await API.getFullImage(r.file);
  assert.ok(full.startsWith('data:image/png;base64,'));
  await assert.rejects(API.getFullImage('missing.png'), /画像が見つかりません/);
  const p3 = await API.clearVersionOutputs(dir.id, v.id);
  assert.equal(p3.directions.find(d => d.id === dir.id).versions[0].visuals.package.status, 'empty');
  assert.equal(await genzo.readFile(r.file), null);
});

test('encodeCanToSchema: 二重符号化の結果が目録に書き込まれる', async () => {
  const p = await API.getProject();
  const cb = p.audit.codebook;
  const target = cb.targets[0];
  const levels = {}; cb.schema.forEach(a => { levels[a.id] = a.levels[0]; });
  let n = 0;
  nextReply = () => { n++; const o = Object.assign({}, levels); if (n === 2) o.A1 = cb.schema[0].levels[1] || levels.A1; return JSON.stringify(o); };
  const png = await require('sharp')({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer();
  const p2 = await API.encodeCanToSchema({ targetId: target.id, imageB64: png.toString('base64'), mime: 'image/png' });
  const row = p2.audit.codebook.table[target.id];
  assert.ok(row && row.imageFile.startsWith('genzo_cb_'));
  assert.equal(row.cells.A1.status, (cb.schema[0].levels[1] ? 'needs-adjudication' : 'encoded'));
  assert.equal(row.cells.A2.status, 'encoded');
  const p3 = await API.adjudicateCell({ targetId: target.id, attrId: 'A1', value: levels.A1 });
  assert.equal(p3.audit.codebook.table[target.id].cells.A1.status, 'verified');
});

test('runGrounding: グラウンディング結果で凍結が解除される', async () => {
  const p = await API.getProject();
  const gated = p.directions.find(d => d.gated);
  assert.ok(gated, 'シードに凍結方向がある前提');
  const p2 = await API.runGrounding(gated.id);
  const d = p2.directions.find(x => x.id === gated.id);
  assert.equal(d.gated, null);
  assert.ok(d.audits[0].method.includes('Google Search grounding'));
});

test('assistantChat: システムプロンプトに状態ダイジェストが入り、withSource でソースが付く', async () => {
  nextReply = () => 'こんにちは';
  const r = await API.assistantChat({ messages: [{ role: 'user', content: '使い方は？' }], withSource: true });
  assert.equal(r.reply, 'こんにちは');
  assert.equal(r.sourceUsed, true);
  const sys = calls[calls.length - 1].messages[0].content;
  assert.ok(sys.includes('現在のプロジェクト状態'));
  assert.ok(sys.includes('===== server/genzo.js ====='));
  assert.ok(!sys.includes('Apps Script'));
});

test('getStyleGuidesView / resetProject', async () => {
  const v = await API.getStyleGuidesView();
  assert.ok(Array.isArray(v.guides) && v.guides.length > 0);
  const p = await API.resetProject();
  assert.equal(p.seedRev, genzo.SEED_REV);
});
