'use strict';
/**
GENZO v3 — コンセプトのビジュアル意思決定ワークスペース（Cloud Run 版）

GAS 版 code.gs からの移植。GAS 固有 API を次のとおり置き換えている（設計・シード・判定ロジックは同一）:
  PropertiesService → 環境変数（server/config.js）
  UrlFetchApp（OpenAI互換API） → server/llm.js（既定 Vertex AI: Gemini / Gemini画像生成・Imagen / Google検索グラウンディング）
  DriveApp → server/storage.js（Cloud Storage / ローカルFS）
  LockService → server/lock.js（非同期ミューテックス）+ 保存時の世代番号照合
  CacheService（サムネ） → プロセス内キャッシュ + sharp による縮小サムネの保存
  HtmlService（doGet） → server/index.js が public/index.html を配信
  google.script.run → POST /api/:fn（server/index.js）

アーキテクチャ:
認識5段（発見→含意→空間→方向→決定設計）をプリセットとして保持。
方向(direction)ごとのワークスペースに版(version)の系譜ツリー。
全入力（自由文/参照借用/パーツ指定）は共通パイプライン
①解釈 ②文脈照合 ③判定（壁内/警告/ギャップ→ブリーフ起案） ④設計応答
を通り、言語の応答→ユーザー承認→画像化 の順を強制する。
*/
var fs = require('fs');
var path = require('path');
var llm = require('./llm');
var storage = require('./storage');
var createMutex = require('./lock').createMutex;
var sharp = null;
try { sharp = require('sharp'); } catch(e){ console.warn('[genzo] sharp が読み込めません。サムネイルはフル画像で代替します: ' + (e.message || e)); }
/* ================= props / util ================= */
function _model(){ return llm.modelName(); }
function _searchTool(){ return llm.searchToolName(); }
function _sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
/* ================= LLM（server/llm.js 経由） ================= */
/* OpenAI 形式の messages（system/user/assistant、content は文字列または text/image_url/file パーツ配列）を受け、
   本文文字列を返す。opts: { json, maxTokens, effort }。プロバイダ差はすべて llm.js が吸収する */
async function _chat(messages, opts){
return await llm.chat(messages, opts || {});
}
function _lenientJSON(text){
if (!text) throw new Error('空の応答');
var t = String(text).trim().replace(/^`{1,3}(?:json)?\s*/i, '').replace(/`{1,3}\s*$/,'').trim();
try { return JSON.parse(t); } catch(e){}
var start = -1, open = 0, inStr = false, esc = false, openCh = '', closeCh = '';
for (var i = 0; i < t.length; i++){
var ch = t[i];
if (start < 0){
if (ch === '{' || ch === '['){ start = i; open = 1; openCh = ch; closeCh = (ch === '{') ? '}' : ']'; }
continue;
}
if (inStr){
if (esc) esc = false;
else if (ch === '\\') esc = true;
else if (ch === '"') inStr = false;
continue;
}
if (ch === '"') inStr = true;
else if (ch === openCh) open++;
else if (ch === closeCh){
open--;
if (open === 0) return JSON.parse(t.slice(start, i + 1));
}
}
throw new Error('JSONを抽出できませんでした: ' + t.slice(0, 200));
}
/* 画像生成。refs は [{buffer, mime}]（参照画像つき編集）。戻り値は PNG の base64 */
async function _genImage(prompt, opts, refs){
return await llm.genImage(prompt, opts || {}, refs || []);
}
/* ================= 保存先（storage） / project ================= */
var PROJECT_FILE = 'genzo_project.json';
var SEED_REV = 79; // プリセット知識の改訂番号。上げると_migrateがプリセット部分だけ差し替える（ユーザーの版・メモ・画像・参照・依頼は保持）
function _migrate(p){
if ((p.seedRev||0) >= SEED_REV) return p;
var seed = _seedProject();
// 設計済み執行（v0/vLo/vHi）の削除墓標は無効化＝箱は復元される（生成物のみ削除の原則）
p.deletedVersionIds = (p.deletedVersionIds || []).filter(function(id){ return !/-(v0|vLo|vHi)$/.test(id); });
// 内部リサーチ産のスコープ付き記録はユーザー資産——シード差し替えで消えないよう退避し、後段で再接続する
var _keepScoped = function(arr){ return (arr||[]).filter(function(x){ return x && x.scope; }); };
var _resFindings = _keepScoped(p.perception && p.perception.findings);
var _resAudit = {
symbols: _keepScoped(p.audit && p.audit.symbols),
sources: _keepScoped(p.audit && p.audit.sources),
prohibitions: _keepScoped(p.audit && p.audit.prohibitions),
vocab: _keepScoped(p.audit && p.audit.regulations && p.audit.regulations.vocab)
};
p.styleGuides = p.styleGuides || [];
// プリセット知識は丸ごと最新版へ
p.strategy = seed.strategy;
// ユーザー追加コンセプトを保持しつつシード分を差し替え（詳細マージは後段）
var _seedCids={}; (seed.concepts||[]).forEach(function(sc){_seedCids[sc.id]=1;});
var _userConcepts=(p.concepts||[]).filter(function(c){return !_seedCids[c.id];});
p.concepts = seed.concepts.concat(_userConcepts);
p.perception = seed.perception;
p.space = seed.space;
p.dictionary = seed.dictionary;
var _oldCbTable = (p.audit && p.audit.codebook && p.audit.codebook.table) || null;
// ユーザー資産の退避（p.auditはこの直後にシードで丸ごと置換されるため、ここで捕捉する）
var _oldCbRefUser = ((p.audit && p.audit.codebook && p.audit.codebook.refTargets) || []).filter(function(t){ return t.userAdded; });
var _oldCbRefTomb = (p.audit && p.audit.codebook && p.audit.codebook.deletedRefTargetIds) || [];
var _oldCbArch = (p.audit && p.audit.codebook && p.audit.codebook.archetypes) || null;
// seed側の符号化表を、この直後の table 差し戻し（ユーザー資産の復元）で参照が失われる前に捕捉する
// （p.audit = seed.audit のエイリアスにより、以降 scb.table はユーザー表を指すため）
var _seedCbTable = (seed.audit && seed.audit.codebook && seed.audit.codebook.table) || {};
p.audit = seed.audit;
if (_oldCbTable && p.audit.codebook) p.audit.codebook.table = _oldCbTable; // 符号化表はユーザー資産
// リサーチ産記録の再接続
p.perception.findings = (p.perception.findings || []).concat(_resFindings);
p.audit.symbols = (p.audit.symbols || []).concat(_resAudit.symbols);
p.audit.sources = (p.audit.sources || []).concat(_resAudit.sources);
p.audit.prohibitions = (p.audit.prohibitions || []).concat(_resAudit.prohibitions);
p.audit.regulations = p.audit.regulations || {};
p.audit.regulations.vocab = (p.audit.regulations.vocab || []).concat(_resAudit.vocab);
// 方向: プリセットのベース（name/axis/gated/versions[0]のspec）を更新し、ユーザー作成の版・メモ・フェーズ・代表・画像は保持
p.directions = p.directions || [];
var byId = {}; p.directions.forEach(function(d){ byId[d.id] = d; });
// コンセプトの記述フィールド（statement/framing等）はシードで更新
var cById = {}; (p.concepts||[]).forEach(function(c){ cById[c.id] = c; });
(seed.concepts||[]).forEach(function(sc){
var ex = cById[sc.id];
if (!ex){ p.concepts.push(sc); return; }
['name','insight','statement','nakami','worldview','naming','rtb','framing','openQuestion','keyterms','derivation','derivationStatus','structure','naming','namingStatus','sourceNote','sheet'].forEach(function(k){ if (sc[k] !== undefined) ex[k] = sc[k]; });
delete ex.universe; // 戦略領分の再演データは撤去
});
// 目録: 符号化表（ユーザー資産）を保持し、著述フィールドはシードで更新、判定と網羅性は再計算
if (p.audit && p.audit.codebook && seed.audit && seed.audit.codebook){
var ocb = p.audit.codebook, scb = seed.audit.codebook;
['version','date','selection','kThreshold','schema','targets','misreads','contrast','pairTest','notes','refTargets','archetypes'].forEach(function(k){ ocb[k] = scb[k]; });
// ユーザー資産の再接続: 追加した参照缶と、編集・承認済みの性格軸（構成・status）はシード差し替えで消さない
// （退避は p.audit 置換の前＝_oldCbRefUser/_oldCbArch）
ocb.deletedRefTargetIds = _oldCbRefTomb;
ocb.refTargets = (ocb.refTargets||[]).filter(function(t){ return _oldCbRefTomb.indexOf(t.id) < 0; });
// seed側の新規符号行の補充: 符号化表はユーザー資産（既存行が常に勝つ）だが、シードが新たに持ち込む缶の
// 一次符号化行は、ユーザー側に同じ行が無く・削除墓標にも無い場合のみ追加する（v73: 参照缶5本の一次符号化）
ocb.table = ocb.table || {};
Object.keys(_seedCbTable).forEach(function(id){
if (!ocb.table[id] && _oldCbRefTomb.indexOf(id) < 0) ocb.table[id] = _seedCbTable[id];
});
_oldCbRefUser.forEach(function(t){ if (!(ocb.refTargets||[]).some(function(x){ return x.id === t.id; })) ocb.refTargets.push(t); });
if (_oldCbArch && _oldCbArch.length){
// 同IDはユーザー版を優先（構成・承認の保持）。ただし「構成がシードと同一かつ未承認」＝未編集とみなし、
// シード側の承認（v74: ニコのチャット指示承認）を採用する。シードにしかない新しい軸は追加。ユーザーだけが持つ軸も保持
ocb.archetypes = (ocb.archetypes||[]).map(function(sa){
var hit = null; _oldCbArch.forEach(function(a){ if (a.id === sa.id) hit = a; });
if (!hit) return sa;
var same = JSON.stringify((hit.members||[]).slice().sort()) === JSON.stringify((sa.members||[]).slice().sort());
if (same && hit.status !== 'approved' && sa.status === 'approved') return sa;
return hit;
});
_oldCbArch.forEach(function(a){ if (!ocb.archetypes.some(function(x){ return x.id === a.id; })) ocb.archetypes.push(a); });
}
if (Object.keys(ocb.table||{}).length) _cbComputeCodes(ocb);
}
seed.directions.forEach(function(sd){
var ex = byId[sd.id];
if (!ex){ p.directions.push(sd); return; }
ex.name = sd.name; ex.axis = sd.axis; ex.gated = sd.gated;
// シード版（vLo/v0/vHi）はシードの順序で並べ、既存があればspecを更新しvisualsを保持。ユーザー版はその後に元の順序で温存
var exBy = {}; (ex.versions||[]).forEach(function(v){ exBy[v.id] = v; });
var seedIds = {};
var tomb = p.deletedVersionIds || [];
var merged = sd.versions.filter(function(sv){ return tomb.indexOf(sv.id) < 0; }).map(function(sv){
seedIds[sv.id] = true;
var old = exBy[sv.id];
if (old){ old.label = sv.label; old.spec = sv.spec; old.origin = sv.origin; return old; }
return sv;
});
(ex.versions||[]).forEach(function(v){ if (!seedIds[v.id]) merged.push(v); });
ex.versions = merged;
if (!ex.repVersionId || !merged.some(function(v){ return v.id === ex.repVersionId; })) ex.repVersionId = sd.repVersionId;
});
p.briefs = p.briefs || [];
seed.briefs.forEach(function(sb){ if (!p.briefs.some(function(b){ return b.id === sb.id; })) p.briefs.unshift(sb); });
// タブ順: シード順に整列（①澄虎→②別解→ブレンデッド→③A-D）。ユーザー追加コンセプトは末尾で相対順保持
var seedOrder = {}; (seed.concepts||[]).forEach(function(sc,i){ seedOrder[sc.id]=i; });
p.concepts.sort(function(a,b){
var ia=(seedOrder[a.id]!==undefined)?seedOrder[a.id]:999, ib=(seedOrder[b.id]!==undefined)?seedOrder[b.id]:999;
return ia-ib;
});
// タブ整理の維持: ユーザーの並び順・非表示（tabPrefs）はプロジェクト資産としてrev更新を生き残る。
// 直前のシード順ソートの後にユーザー順を再適用する。ユーザー順に無い新規コンセプトは末尾
// （ユーザーの配置を乱さない。移動はタブ管理からいつでも可能）。存在しなくなったIDは掃除。
p.tabPrefs = p.tabPrefs || { hidden: [], order: [] };
(function(){
var _cids = {}; p.concepts.forEach(function(c){ _cids[c.id] = 1; });
p.tabPrefs.hidden = (p.tabPrefs.hidden || []).filter(function(id){ return _cids[id]; });
p.tabPrefs.order = (p.tabPrefs.order || []).filter(function(id){ return _cids[id]; });
if (p.tabPrefs.order.length){
var uo = {}; p.tabPrefs.order.forEach(function(id, i){ uo[id] = i; });
var cur = {}; p.concepts.forEach(function(c, i){ cur[c.id] = i; });
p.concepts.sort(function(a, b){
var ka = (uo[a.id] !== undefined) ? uo[a.id] : 1000 + cur[a.id];
var kb = (uo[b.id] !== undefined) ? uo[b.id] : 1000 + cur[b.id];
return ka - kb;
});
}
// 全タブが非表示になる異常状態の防護（手動編集等）: 先頭を強制表示
if (p.concepts.length && p.concepts.every(function(c){ return p.tabPrefs.hidden.indexOf(c.id) >= 0; })){
p.tabPrefs.hidden = p.tabPrefs.hidden.filter(function(id){ return id !== p.concepts[0].id; });
}
})();
p.refs = p.refs || [];
if (p.audit && p.audit.codebook) p.audit.codebook.coverage = _cbCoverage(p);
p.seedRev = SEED_REV;
return p;
}
var _mutex = createMutex();
function _store(){ return storage.get(); }
async function _readProjectRaw(){ return await _store().readText(PROJECT_FILE); } // {text, generation} | null
function _parseProject(raw){
if (!raw) return null;
try {
var p = JSON.parse(raw.text);
if (p.version !== 3) return null; // 旧版JSONは読まない（v3で再スタート）
return p;
} catch(e){ return null; }
}
async function _loadProject(){
var p = _parseProject(await _readProjectRaw());
if (!p) return _seedProject();
return _migrate(p);
}
async function _storeProject(p, opts){
p.meta.updated = new Date().toISOString();
await _store().writeText(PROJECT_FILE, JSON.stringify(p), opts || {});
return p;
}
/* 読込→fn→保存 を排他実行する。保存は読込時の世代番号を前提条件にし、別インスタンスの割り込み更新があれば再試行する */
async function _withLock(fn){
var release = await _mutex.acquire(30000);
try {
for (var attempt = 0; ; attempt++){
var raw = await _readProjectRaw();
var p0 = _parseProject(raw);
var p = p0 ? _migrate(p0) : _seedProject();
var r = await fn(p);
try { await _storeProject(p, { ifGenerationMatch: raw ? raw.generation : 0 }); return r; }
catch(e){ if (e && e.code === 412 && attempt < 3){ await _sleep(250 * (attempt + 1)); continue; } throw e; }
}
} finally { release(); }
}
/* 画像ファイル */
async function _saveFile(name, buffer, mime){
await _store().writeBytes(name, buffer, mime || 'image/png');
_thumbForget(name);
try { await _store().remove('thumbs/' + name + '.jpg'); } catch(e){}
return { id: name, name: name };
}
async function _readFile(name){ return await _store().readBytes(name); }
async function _trashFiles(names){
for (var i = 0; i < (names || []).length; i++){
var n = names[i];
try { await _store().remove(n); } catch(e){}
try { await _store().remove('thumbs/' + n + '.jpg'); } catch(e){}
_thumbForget(n);
}
}
async function getProject(){
var raw = await _readProjectRaw();
// 旧形式・旧revからの再シード/移行時は即永続化し、状態を一意にする
var needStore = !raw;
if (raw){
try { var r0 = JSON.parse(raw.text); if (r0.version !== 3 || (r0.seedRev||0) < SEED_REV) needStore = true; }
catch(e){ needStore = true; }
}
if (needStore) return await _withLock(async function(p){ return p; });
return await _loadProject();
}
async function resetProject(){
var release = await _mutex.acquire(30000);
try { return await _storeProject(_seedProject()); } finally { release(); }
}
/* 移行用: GAS 版の genzo_project.json をそのまま採用する（現行のものは backups/ に退避）。
   画像はファイル名で参照するため fileId は不要。読込時に _migrate が現行 SEED_REV へ更新する */
async function replaceProject(text){
var p = null;
try { p = JSON.parse(text); } catch(e){ throw new Error('genzo_project.json を JSON として読めません: ' + e.message); }
if (!p || p.version !== 3 || !Array.isArray(p.directions)) throw new Error('genzo_project.json の形式が違います（version=3 と directions[] が必要）');
var release = await _mutex.acquire(30000);
try {
var cur = await _readProjectRaw();
var backup = null;
if (cur){ backup = 'backups/genzo_project.' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'; await _store().writeText(backup, cur.text); }
await _store().writeText(PROJECT_FILE, text);
return { backup: backup, seedRev: p.seedRev || 0, directions: p.directions.length, versions: p.directions.reduce(function(n, d){ return n + ((d.versions||[]).length); }, 0), refs: (p.refs||[]).length };
} finally { release(); }
}
async function saveProject(partial){
await _withLock(async function(p){
if (partial && partial.activeConceptId) p.activeConceptId = partial.activeConceptId;
return true;
});
return true;
}

/* ================= アプリ内AIアシスタント =================
三層コンテキスト設計:
第1層 ASSISTANT_GUIDE（下の定数）——アプリの機能・思想・操作の自己記述。コード更新時は
  この定数も同じ納品で更新する（SEED_REVと同じ規律。ソース全文を毎回送るより安く正確）。
第2層 _assistantContext——生きたプロジェクト状態の機械生成ダイジェスト（毎回）。
第3層 _fetchOwnSource——サーバ自身のソースファイル読込（オプション）。
アシスタントは読み取り専用の案内役。操作の代行はしない（誤操作リスクの排除）。 */
var ASSISTANT_GUIDE = [
'あなたはGENZOアプリに組み込まれたAIアシスタントです。以下の自己記述と、後続の「現在のプロジェクト状態」ダイジェストに基づいて、ユーザー（Firstthing/サントリーRIBチームのメンバー）の質問に日本語で答えます。',
'',
'◆ 回答の規範',
'・簡潔に。操作手順は画面上の実際のラベル（例:「観察表を開く」「この構成で承認」）で案内する。',
'・ダイジェストに無い情報を捏造しない。「この情報はダイジェストに含まれていないため、◯◯を開いて確認してください」と正直に言う。',
'・あなたは読み取り専用の案内役。操作の代行はできない——ボタンの場所と手順を案内する。',
'・「どの案が良いか」等の設計判断は、設計書の事実（符号・署名判定・棚での立ち位置）を根拠に意見として述べてよい。ただし承認・裁定・選定の確定はチームの領分だと明示する。',
'・仕組みの「なぜ」を聞かれたら、下記の設計思想から答える。実装コードの詳細を聞かれ、ソースが与えられていない場合は「コード参照モード（実装コードも参照して答える）で聞き直すか、開発チームへ」と案内。',
'',
'◆ GENZOとは',
'サントリーRIBチーム向けの新ビールブランド・パッケージ探索ツール。コンセプト（様式の仮説）ごとに缶デザインの「方向」を設計し、設計書と画像を生成して検証に回す。Node.js サーバ（server/genzo.js）+単一HTML（public/index.html）として Cloud Run で動き、プロジェクト全体は Cloud Storage にJSONとして自動保存される。LLMは Vertex AI の Gemini（環境変数 VERTEX_MODEL）、画像は Vertex AI の画像生成モデル（VERTEX_IMAGE_MODEL）。',
'設計思想: (1)実証主義——観察（棚の符号化）から規定を導出し、AIの一次案と人間の確定（裁定・承認）を分ける。(2)機械焼き込み——判定（模倣検知・署名占有・ブレンド配分・棚での立ち位置）はサーバが計算して設計書に記録し、AIの自己申告に依存しない。(3)統制——派生は指示された変更だけを反映し他を維持する。',
'',
'◆ 画面構成',
'上部タブバー: 「🏛土台」→各コンセプトタブ→「＋新コンセプト」→「⚖選定」→「⚙」（タブ管理）。',
'・土台: カテゴリ共通基盤。①棚の観察記録（コード目録・性格軸のサマリ、「観察表を開く」で目録ドロワー）②デザインルール📐（ビール王道／定番・ビールらしさの原則・王道の性格軸4本、展開で中身）③規制・監査。',
'・コンセプトタブ: そのコンセプトの方向一覧。各方向カードに版（執行）が並び、「＋派生を作る」「この案をベースに派生」「＋新しい方向」で生成。',
'・選定: 全コンセプト横断で検証に回す案を決める画面。',
'・タブ管理⚙: コンセプトタブの表示/非表示・並び順（▲▼）。整理状況はプロジェクトに自動保存され、リロードや更新を跨いで維持。非表示は削除ではなくデータは無傷。最後の1タブは非表示不可。表示中タブを隠すと作業座標は先頭の表示タブへ移動。',
'',
'◆ コード目録（観察表ドロワー）',
'売れ筋8缶（スーパードライ・一番搾り・黒ラベル・プレモル・晴れ風・ヱビス・マルエフ・ラガー）を8属性で符号化した観察記録。属性: A1地の色相域/A2地の光沢/A3主図像/A4動勢/A5構図/A6泡写実/A7金の使用/A8ロゴ書体。',
'・符号化は二重（v/v2）で、不一致セルは「裁定待ち」（黄色）。プルダウンで人が裁定するか、缶の実物画像を入れて再符号化すると確定する。',
'・区分は3つ: コード母集団（8缶・王道の計算対象）／参照専用（王道の計算には数えない。性格軸の票と模倣検知の網を広げる。現在クラシックラガー・バドワイザー・ハイネケン・グッドエール・マスターズドリームの5本、AI一次符号化済み・裁定待ちセルあり）／誤読物差し（対照缶＝ビールでないものとの重なり検査用）。',
'・参照缶は目録ドロワーから追加・削除できる（削除は墓標つきで更新後も復活しない）。',
'',
'◆ 王道の定義と性格軸',
'王道＝目録の各属性の最頻コードの合成（自動導出・観察に追随）。現況の床（占有7割以上＝全性格軸で共通に守る属性）: A2金属光沢・A4静的・A5中央シンメトリー・A6泡なし。拮抗属性（最頻が割れている）: A1色相・A3図像・A7金・A8書体——これが王道の中の性格を分ける軸。',
'性格軸は4本: 力強さの王道（スーパードライ・黒ラベル＋参照缶）／優しさの王道（一番搾り・マルエフ・ラガー）／格の王道（プレモル・ヱビス＋参照缶）／新しさの王道（晴れ風＋グッドエール。単独より差し味向き）。プロファイルは構成銘柄の条件付き最頻値として毎回導出される。',
'・承認制: 目録ドロワーの性格軸カードで構成を編集し「この構成で承認」。承認済みの軸だけが設計知識に接続され、生成指示で効く。構成を変えると承認は自動失効。',
'・sigRisk（署名帯）: 軸のある水準が構成1缶の票だけで決まり、その缶の識別署名と同値の場合の警告。設計はその水準を文字どおり採らず、隣接水準か二次変数で再実装する。',
'・軸を指定しない「王道」生成でも、AIは命題に最も整合する軸を1つ選んでdecisionsに宣言する（自由域を文脈の癖で埋めない）。',
'',
'◆ 王道ブレンド',
'派生・新方向フォームの「王道ブレンド」パネルで、承認済みの軸を25%刻みで配合（合計は自動正規化。テキストなしブレンドのみの送信も可。テキストで「強さ7:優しさ3」でも効く）。',
'・比率の意味: 色の混合ではなく「どの軸がどの拮抗属性を取るか」の配分。一次知覚の優先順（A1色相→A3図像→A8書体→A7金）で比率の大きい軸から取る。配分はサーバの決定論計算で、結果は設計書の「王道ブレンドの配分」ブロックに焼き込まれる。',
'・事前接近検査: 配分ベクトルが実在銘柄の模倣域（7/8一致等）に入る場合、知覚優先度の最も低い1属性に⚠再実装フラグが立つ（例: 強70:優30はスーパードライに接近→A8書体を再実装して距離を作る）。',
'・25%刻みの理由: 目録n=8の解像度で1%単位は精度の偽装になるため。',
'・派生テキストに「力強く」等の性格語彙を書くとヒントが出る: テキスト派生は同一命題内の±1移動で性格の組み替えには届かない。軸ごと組み替えるならブレンドを使う。',
'',
'◆ 署名（PB対策）',
'「王道文法＋固有の識別署名＝ブランド／王道文法のみ＝PB」。全ての設計案は signature（属性×水準×占有する知覚×根拠）を宣言し、承認時にサーバが対象8缶と突合して占有判定を焼き込む: 空白（0缶＝最良）／少数派（1-2缶＝subで先客と差別化が条件）／共通文法（3缶以上＝署名として機能しない・赤字警告）。',
'・署名は方向の資産。派生では親版の署名が強制継承される。未宣言の版は「署名未宣言＝PBの文法」と記録される。判定は拒否ではなく記録——採否はチームが判断する。',
'',
'◆ 新コンセプトの進め方（順序）',
'よくある質問「棚卸しと方向定義どちらが先？」への答え: 両者は別の網であり、棚卸しは省略できない（先送りはできる）。(1)必須材料はコンセプトシートの「インサイト」「開発コンセプト」の2行。(2)棚卸し（知識を調える）＝このコンセプトが触る記号・語彙・借用元の先客・規制を事前検査し監査台帳へ入れる——「作ったものが棚で立つか」の検査。以降の全生成を制約する。(3)生成時の自動調査（gap判定）＝「指示の解釈に足りない知識」だけを検知する確率的な網で、AIが自分の無知に気づいた場合のみ発火する——「作れるか」の網。指示が知識内なら発火せず、設計の記号は未検証のまま「監査未実施」の仮案として出る。(4)後の監査で先客・誤読リスクが見つかった方向は凍結（gated）され画像化が止まる。結論: 探索を急ぐなら生成先行も可だが、検証・提案に回す前には棚卸しが必要。方向0件のコンセプト画面にこの説明のガイドカードが出る。',
'',
'◆ 生成の入力型と統制',
'・新しい方向: 新しい様式（命題）を起こす。標準案v0が先に立ち、下限vLo（主導装置1つの分離測定）と攻め端vHi（誤読が始まる閾値の計器）が後段で自動設計される。',
'・派生: 統制された改訂。指示された変更だけ反映し、他のスロット（surface/motif/layout/logo/copy）は一字一句維持。パーツ指定チップで「変更/維持」を明示できる。',
'・借用: 缶画像を添付→視覚変数（V1支配色/V2素材感/V3図像/V4構図＋二次）に言語化→借りたい変数を選んで生成。識別資産は移植せず知覚を再実装。',
'・知識の外の指示は gap 判定になり、憶測で作らず内部リサーチ（計画→web接地→監査台帳へ統合）を先に回す。',
'・ワードマーク: nameChoiceは方向の不変量。「澄虎」は①コンセプト専用で他では使用不可。',
'',
'◆ 設計書の読み方（版カードから開く）',
'bet（消費者仮説）→proposition（命題）→decisions（導出）→coding（8属性の符号）→王道ブレンドの配分（指示した構造）→署名（固有性の宣言と占有判定）→棚での立ち位置（最終結果: 王道コードとの照合・最近接銘柄との距離）→台帳（守る/破るコードと検証仮説）。配分=入力、署名=宣言、立ち位置=出力——三者のズレはそれ自体が発見。',
'・模倣検知: 生成のたびに全銘柄＋符号化済み参照缶と照合。7/8一致か識別署名の全再現で自動矯正。',
'',
'◆ 運用・トラブルシュート',
'・画面上部に黒帯の警告が出たらサーバ（server/genzo.js）と画面（public/index.html）のバージョン不一致。両方を含む最新のイメージを Cloud Run に再デプロイする。',
'・接続設定: 環境変数 LLM_PROVIDER（openai／vertex）。openai は OPENAI_API_KEY・OPENAI_MODEL・OPENAI_IMAGE_MODEL（GAS 版と同じ）、vertex は VERTEX_PROJECT・VERTEX_LOCATION・VERTEX_MODEL・VERTEX_IMAGE_MODEL、保存先 GCS_BUCKET（Cloud Run のサービスアカウントに Vertex AI User と Storage Object Admin が必要）。',
'・生成が遅い: 新方向は2〜6分、派生は1〜3分が正常。画像の現像は版ごとに「生成する」か一括画像化。',
'・裁定待ちセルは動作の前提ではなく精度の上積み。確定するほど王道・性格軸・模倣検知が締まる。'
].join('\n');
function _assistantContext(p){
var out = { meta: (p.meta && p.meta.name) || '', seedRev: p.seedRev, activeConceptId: p.activeConceptId };
var hid = (p.tabPrefs && p.tabPrefs.hidden) || [];
out.concepts = (p.concepts||[]).map(function(c){
return { id: c.id, name: c.name, hidden: hid.indexOf(c.id) >= 0,
directions: (p.directions||[]).filter(function(d){ return d.conceptId === c.id; }).length };
});
out.activeDirections = (p.directions||[]).filter(function(d){ return d.conceptId === p.activeConceptId; }).map(function(d){
return { id: d.id, name: d.name, phase: d.phase || '', note: String(d.note||'').slice(0, 120),
versions: (d.versions||[]).map(function(v){
var s = v.spec || {};
return { id: v.id, label: v.label, hasImage: !!(v.visuals && v.visuals.length),
bet: String(s.bet||'').slice(0, 90),
blend: s.blend ? (s.blend.ratios||[]).map(function(r){ return r.name + r.pct + '%'; }).join('+') : null,
signature: s.signature ? (s.signature.missing ? '未宣言' : (s.signature.attrId + '=' + s.signature.level + (s.signature.occupancy ? '(' + s.signature.occupancy.verdict + ')' : ''))) : null,
nearest: (s.shelfCheck && s.shelfCheck.nearest) ? (s.shelfCheck.nearest.brand + ' ' + s.shelfCheck.nearest.match + '/' + s.shelfCheck.nearest.total) : null };
}) };
});
var cb = _cbOf(p);
if (cb){
var pend = 0;
(cb.targets||[]).concat(cb.refTargets||[]).forEach(function(t){ var r = cb.table && cb.table[t.id]; if (r) cb.schema.forEach(function(a){ var c = r.cells && r.cells[a.id]; if (!c || c.status === 'needs-adjudication') pend++; }); });
out.codebook = { coded: Object.keys(cb.table||{}).length, targets: (cb.targets||[]).length,
refTargets: (cb.refTargets||[]).map(function(t){ return t.brand + (cb.table && cb.table[t.id] ? '(符号化済)' : '(未符号化)'); }),
adjudicationPending: pend,
pairTest: (cb.pairTest && cb.pairTest.status) || '未実施' };
out.archetypes = (cb.archetypes||[]).map(function(a){
return { name: a.name, status: a.status, members: (a.members||[]).length,
coded: (a.members||[]).filter(function(id){ return cb.table && cb.table[id]; }).length };
});
}
out.styleGuides = _styleGuidesFor(p, p.activeConceptId).map(function(g){ return g.name; });
if (p.selection) out.selection = String(JSON.stringify(p.selection)).slice(0, 1200);
out.tabPrefsHidden = hid;
var s = JSON.stringify(out);
return s.length > 42000 ? s.slice(0, 42000) + '…(切り詰め)' : s;
}
function _fetchOwnSource(){
var files = [
['server/genzo.js', path.join(__dirname, 'genzo.js')],
['server/llm.js', path.join(__dirname, 'llm.js')],
['server/storage.js', path.join(__dirname, 'storage.js')],
['server/index.js', path.join(__dirname, 'index.js')],
['public/index.html', path.join(__dirname, '..', 'public', 'index.html')]
];
return files.map(function(f){
var s;
try { s = fs.readFileSync(f[1], 'utf8'); } catch(e){ throw new Error('ソース自己取得に失敗: ' + f[0] + '（' + (e.message || e) + '）'); }
return '===== ' + f[0] + ' =====\n' + s;
}).join('\n\n');
}
async function assistantChat(args){
args = args || {};
var msgs = (args.messages||[]).filter(function(m){ return m && (m.role === 'user' || m.role === 'assistant') && m.content; })
.map(function(m){ return { role: m.role, content: String(m.content).slice(0, 8000) }; });
if (!msgs.length || msgs[msgs.length-1].role !== 'user') throw new Error('質問がありません');
if (msgs.length > 12) msgs = msgs.slice(msgs.length - 12); // 履歴はクライアント保持・直近12ターンのみ送信
var p = await _loadProject();
var sys = ASSISTANT_GUIDE + '\n\n===== 現在のプロジェクト状態（機械生成ダイジェスト） =====\n' + _assistantContext(p);
var sourceUsed = false, sourceError = null;
if (args.withSource){
try { sys += '\n\n===== ソースコード（サーバのソースファイル・実装の真実源） =====\n' + _fetchOwnSource(); sourceUsed = true; }
catch(e){ sourceError = String(e.message || e); }
}
var reply = await _chat([{ role: 'system', content: sys }].concat(msgs), { maxTokens: 2500 });
return { reply: reply, sourceUsed: sourceUsed, sourceError: sourceError };
}

/* ================= タブ整理（コンセプトの非表示・並び順） =================
整理状況は p.tabPrefs { hidden:[conceptId], order:[conceptId] } としてプロジェクト本体（保存先JSON）に持つ。
コンセプトオブジェクト側にフラグを持たせない理由: _migrate がシードのコンセプトを丸ごと差し替え、
タブ順もシード順へ強制ソートするため、オブジェクト側の状態はrev更新で消える。tabPrefs は _migrate が
触らない資産として生き残り、末尾で並び順・非表示を再適用する。非表示はナビゲーションの整理であって
データの削除ではない——方向・版・選定への影響はゼロ。 */
async function updateTabPrefs(args){
args = args || {};
return await _withLock(async function(p){
p.tabPrefs = p.tabPrefs || { hidden: [], order: [] };
var tp = p.tabPrefs; tp.hidden = tp.hidden || [];
var cs = p.concepts || [];
var idx = -1; cs.forEach(function(c, i){ if (c.id === args.id) idx = i; });
if (idx < 0) throw new Error('未知のコンセプト: ' + args.id);
if (args.op === 'hide'){
var visible = cs.filter(function(c){ return tp.hidden.indexOf(c.id) < 0; });
if (visible.length <= 1) throw new Error('最後の表示タブは非表示にできません');
if (tp.hidden.indexOf(args.id) < 0) tp.hidden.push(args.id);
// 表示中のタブを隠した場合、作業座標を最初の表示タブへ移す
if (p.activeConceptId === args.id){
var nv = cs.filter(function(c){ return tp.hidden.indexOf(c.id) < 0; })[0];
if (nv) p.activeConceptId = nv.id;
}
} else if (args.op === 'show'){
tp.hidden = tp.hidden.filter(function(x){ return x !== args.id; });
} else if (args.op === 'move'){
var j = idx + (Number(args.delta) < 0 ? -1 : 1);
if (j >= 0 && j < cs.length){ var t = cs[idx]; cs[idx] = cs[j]; cs[j] = t; }
} else {
throw new Error('未知の操作: ' + args.op);
}
tp.order = cs.map(function(c){ return c.id; }); // 現在の配列順を整理状況として記録
return p;
});
}
function _dirOf(p, id){ var d=null; (p.directions||[]).forEach(function(x){ if(x.id===id) d=x; }); return d; }
function _verOf(dir, id){ var v=null; (dir.versions||[]).forEach(function(x){ if(x.id===id) v=x; }); return v; }
function _refOf(p, id){ var r=null; (p.refs||[]).forEach(function(x){ if(x.id===id) r=x; }); return r; }
async function saveNote(directionId, note){
await _withLock(async function(p){ var d=_dirOf(p,directionId); if(d) d.note=String(note||''); return true; });
return true;
}
async function setPhase(directionId, phase){
if (['direction','comp','research'].indexOf(phase) < 0) throw new Error('不正なフェーズ');
await _withLock(async function(p){ var d=_dirOf(p,directionId); if(d) d.phase=phase; return true; });
return await _loadProject();
}
async function setRepresentative(directionId, versionId){
await _withLock(async function(p){ var d=_dirOf(p,directionId); if(d && _verOf(d,versionId)) d.repVersionId=versionId; return true; });
return await _loadProject();
}
async function saveBriefResult(briefId, text){
if(!text || !String(text).trim()) throw new Error('取り込む結果が空です');
await _withLock(async function(p){
var b=null; (p.briefs||[]).forEach(function(x){ if(x.id===briefId) b=x; });
if(!b) throw new Error('依頼書が見つかりません');
b.result = { text: String(text).slice(0, 60000), date: new Date().toISOString().slice(0,10), source: 'ディープリサーチ結果（手動貼付）' };
b.status = 'answered';
return true;
});
return await _loadProject();
}
async function saveBrief(brief){
var saved = null;
await _withLock(async function(p){
p.briefs = p.briefs || [];
saved = { id:'br'+Date.now(), created:new Date().toISOString(), trigger:brief.trigger||'', title:brief.title||'追加リサーチ', text:brief.text||'', status:'open' };
p.briefs.push(saved);
return true;
});
return await _loadProject();
}
/* ================= 共有プロンプト部品 ================= */
var TYPE_DEFS = [
'3つのアウトプットの分担と判断目的（プロンプトはここから逆算する）:',
'- board=世界観のムードボード(16:9)。判断目的:「この世界観はターゲットの生活に実在しうるか」。シーン・人物の生活の瞬間・素材の質感・光・色面はすべてここが担う。製品コラージュ禁止（入れても小さく1点）。人物は25歳以上に見えること・喉元アップ/ゴクゴク描写の禁止。',
'- package=350ml缶の店頭カンプ正面(3:4縦)。判断目的:「2秒の棚でど真ん中のビールに見えながら差分が立つか」。必須表示（品質宣言・アルコール分・純アルコール量・お酒表記）を含む。3枚の中で最初に生成され、他の2枚の製品描写の基準になる。',
'- kv=広告バナーカンプ(16:9)。判断目的:「広告の完成形が店頭前に想像できるか」。boardのシーン画とは役割が異なり、完成した広告の体裁を持つ: 缶を主役に置き（packageと同一デザイン。参照画像が添付されていればそれに厳密一致させる）、日本語ヘッドラインのコピースペースとロゴブロックを備えたバナー構成。背景の世界観は簡潔に。人物は不要。'
].join('\n');
var WRITING_RULES = [
'文章規則（厳守）:',
'- すべての文章はブランド意思決定者への提案文。完結した文で書き、体言止めの断片や社内メモ調は禁止。参照コード（L2/R2-3等）で根拠の所在だけ示すのは禁止——事実・数字・出典名を文中に埋め込み、その場で自己完結させる。',
'- 版や方向の名前は「買う人に何がどう見えるようになるか」が分かる命名。「◯◯で見せる案」のような手段だけの命名は禁止。',
'- decisions の各要素は {decision:表現の決定, seek:狙う知覚, evidence:根拠（事実+出典名を含む自己完結文）} の三つ組で書く。'
].join('\n');
/* ================= コンセプト帰属の知識隔離 =================
コンセプト①「澄虎」（と②別解）の専用資産（白虎・虎紋・与件名「澄虎」に関わる発見・辞書・監査項目）を、
他コンセプトの設計文脈から隔離する。旧実装は全コンセプトの directInput にこれらを無差別に渡しており、
新コンセプト・新方向の設計が虎に汚染される（＝虎が出てくる）不具合の主因だった。 */
var _TORA_CONCEPTS = { sumitora:1, 'kegare-alt':1 };
var _TORA_RE = /虎/;
function _scopePass(rec, conceptId){
// scope付きレコード（内部リサーチ産）: 帰属コンセプトか global のみ通す。無タグ（シード資産）は null を返し呼び出し側の既定規則へ
return (rec && rec.scope) ? (rec.scope === conceptId || rec.scope === 'global') : null;
}
function _knowledgeFor(p, conceptId){
var tora = !!_TORA_CONCEPTS[conceptId];
var k = JSON.parse(JSON.stringify({
findings: (p.perception && p.perception.findings) || [],
implications: (p.perception && p.perception.implications) || [],
space: p.space,
dictionary: p.dictionary,
audit: p.audit
}));
// 判定規則: タグ付き＝帰属で判定（他コンセプト産は①②にも渡さない）／無タグのシード資産＝①②はフル・他は虎関連を隔離
var keep = function(rec, legacyToraTest){
var s = _scopePass(rec, conceptId);
if (s !== null) return s;
if (tora) return true;
return !legacyToraTest(rec);
};
k.findings = k.findings.filter(function(f){ return keep(f, function(x){ return _TORA_RE.test((x.title||'')+(x.fact||'')); }); });
k.implications = (k.implications||[]).filter(function(i){ return keep(i, function(x){ return _TORA_RE.test(x.claim||''); }); });
k.dictionary = (k.dictionary||[]).map(function(t){
t.moves = (t.moves||[]).filter(function(m){ return keep(m, function(x){ return _TORA_RE.test((x.how||'')+(x.v||'')); }); });
return t;
}).filter(function(t){ return (t.moves||[]).length > 0; });
if (!tora && k.space && k.space.variables){
k.space.variables.forEach(function(v){
if (v.ceiling) v.ceiling = String(v.ceiling).replace(/。?縞のある虎・円形の虎紋章は阪神・寅年と混線/,'');
});
}
if (k.audit){
k.audit.symbols = (k.audit.symbols||[]).filter(function(s){ return keep(s, function(x){ return _TORA_RE.test((x.name||'')+(x.note||'')); }); });
k.audit.sources = (k.audit.sources||[]).filter(function(s){ return keep(s, function(x){ return _TORA_RE.test((x.name||'')+(x.grammar||'')+(x.transplant||'')+(x.evidence||'')); }); });
// 禁止事項: シードは文字列・内部リサーチ産は {v,en,scope}。LLMには帰属フィルタ後、文字列に正規化して渡す
k.audit.prohibitions = (k.audit.prohibitions||[]).filter(function(x){
if (typeof x === 'string') return tora || !_TORA_RE.test(x);
return _scopePass(x, conceptId) === true;
}).map(function(x){ return typeof x === 'string' ? x : x.v; });
if (k.audit.regulations && k.audit.regulations.vocab){
k.audit.regulations.vocab = k.audit.regulations.vocab.filter(function(x){ var s = _scopePass(x, conceptId); return s === null ? true : s; });
}
}
// 様式規範（デザインルールの箱）: 王道＝コード目録からの自動導出 + ユーザー定義（帰属フィルタ済み）
k.styleGuides = _styleGuidesFor(p, conceptId);
return k;
}
/* 画像生成用のハード制約。
旧実装は監査の禁止事項（日本語）を全生成にそのまま連結しており、「縞のある虎・円形の虎紋章の禁止」という
否定文中の「虎」が画像モデルの誘引となって、無関係なコンセプトの缶にまで虎が出現する不具合の一因だった。
本実装は (a) 英語の否定制約に翻訳し (b) ①以外のコンセプトには虎という語自体を渡さず、
「MOTIF行で明示されない動物・紋章の全面禁止」という語彙非依存の制約で虎の混入を封鎖する。 */
function _hardConstraints(p, conceptId){
var rules = [
'no spiritual-healing symbols (no purple gradients, no glowing orbs, no aura, no power-stone imagery)',
'no health, recovery or detox claims and no body-benefit depiction',
'no drinking occasions around sauna, bathing or sports',
'no close-up of a throat, no gulping depiction',
'no person who could look under 25',
'must never be mistaken for a soft drink, sparkling water or tea — keep mainstream beer anchors clearly legible',
'must not look like a seasonal or limited edition; no character-collab styling',
'no mockery or parody of sacred motifs',
'gold only as thin lines or edges, never as large solid areas'
];
if (_TORA_CONCEPTS[conceptId]){
rules.push('the white tiger, when present, must follow the MOTIF line exactly: never striped, never inside a circular crest');
} else {
rules.push('STRICT: no animals, beasts, mythical creatures or animal crests of any kind unless the MOTIF line of this prompt explicitly specifies one');
rules.push('render ONLY the wordmark specified in this prompt; never any other product or brand name');
}
// 内部リサーチ産のコンセプト帰属の禁止事項（画像用の英語否定制約）を接続
((p && p.audit && p.audit.prohibitions) || []).forEach(function(x){
if (x && typeof x === 'object' && x.en && (x.scope === conceptId || x.scope === 'global')) rules.push(x.en);
});
// デザインルールの箱（様式規範）の画像制約を接続
if (p && typeof _styleGuidesFor === 'function'){
_styleGuidesFor(p, conceptId).forEach(function(g){ ((g && g.en) || []).forEach(function(e){ if (e) rules.push(e); }); });
}
return rules.join('; ');
}
/* ================= パイプライン（全入力共通） =================
①解釈 ②文脈照合 ③判定 ④設計応答 を1コールで実行し、提案(proposal)を返す。
保存はしない。ユーザーが approveProposal を呼んだ時のみ版が作られる。
*/
async function directInput(args){
args = args || {};
var p = await _loadProject();
var dir = args.directionId ? _dirOf(p, args.directionId) : null;
var parent = (dir && args.versionId) ? _verOf(dir, args.versionId) : null;
var concept = null;
(p.concepts||[]).forEach(function(c){ if(c.id === (dir ? dir.conceptId : args.conceptId)) concept = c; });
if (!concept){
// 旧実装はここで concepts[0]（＝①澄虎）へ暗黙フォールバックしており、
// 状態のずれたクライアントからの新コンセプト/新方向の依頼が全て澄虎の文脈で設計される不具合の原因だった。
var _reqCid = dir ? dir.conceptId : (args.conceptId || '未指定');
throw new Error('コンセプトが見つかりません（id: ' + _reqCid + '）。画面を再読み込みして最新の状態で再実行してください（澄虎タブへの暗黙置換は行いません）');
}
var input = args.input || {};
var ref = input.refId ? _refOf(p, input.refId) : null;
// 王道ブレンド: 配分は決定論のサーバ計算（承認済みの軸のみ・比率は正規化）。LLMには配分結果を厳守指示として渡す
var blendAlloc = null;
if (input.blend && Object.keys(input.blend).length){
blendAlloc = _blendAllocation(p, input.blend);
}
var existingGlances = (p.directions||[]).filter(function(d){ return d.conceptId===concept.id; })
.map(function(d){ var rv=_verOf(d, d.repVersionId)||d.versions[0]; return { name:d.name, glance: rv && rv.spec ? rv.spec.glance : '' }; });
var sys = [
'あなたはアートディレクターの機能を代替する翻訳・批評エンジン。マーケターの入力を受け、次の4段を実行してJSONで返す。',
'',
'① interpretation（解釈）: 入力がこの案の命題（proposition＝様式の言明）に与える影響を先に一文で述べ（propositionEffect）、次に視覚変数への操作に翻訳する。moves:[{variable:"V1|V2|V3|V4|二次(書体/仕上げ等)", change:"何をどう動かすか", magnitude:"小|中|大", note:"命題との整合を含む翻訳の理由"}]。命題と矛盾する操作は行わず、命題側を更新する提案として扱う。',
'② matched（文脈照合）: 提供された knowledge（発見・含意・空間の共通条件・失敗前例・監査・辞書）から、この入力に関係する項目だけを引用する。matched:[{source:"発見:晴れ風の批評 / 含意:浄化は言える / 失敗前例:清涼飲料誤認 / 監査:金の使用 / 辞書:高級に のように、読者がF番号なしで分かる名で", quote:"該当内容の要約（事実・数字・出典名を保持）", relevance:"この入力にどう関係するか"}]。最大6件。関係ない知識は引かない。',
'③ verdict（判定）: status を "ok"（壁内）| "warn"（壁に接触。進めるが条件付き）| "gap"（提供知識の外。設計を進めない）から選ぶ。',
'   - warn の場合 warnings:[{wall:"どの床/天井/監査に触れるか", why:"理由（自己完結文）", alternative:"壁内で同じ狙いを満たす代替の操作"}]。',
'   - gap の場合 gap:{missing:"何の知識が欠けているか", briefTitle:"調査依頼の題", briefText:"内部リサーチエンジンに渡す調査依頼文（背景・確認したい事実・出力への期待を含む完結した依頼文）"} を書き、spec は null にする。判断基準: 入力が要求するモチーフ/借用元/表現が、提供された監査・借用元マップ・発見のいずれにも先客確認や規制確認の記録を持たない場合は gap。憶測で審査済み扱いにしない。',
'④ spec（設計応答）: status が ok / warn の場合のみ。親版の spec を基点に moves を反映した改訂版を書く:',
'統制された改訂（派生の厳守事項）: 派生とは「入力が要求した変更だけを反映した改訂」である。moves に対応するスロットだけを動かし、他のスロット（surface/motif/layout/logo/copy）は親の値を一字一句維持する。動かしたスロット名を changed:["surface",...] に必ず列挙し、各スロットの why にどの move への対応かを書く。変更の連動が必要な場合（例: 地色変更でロゴの可読性が崩れるためロゴ色も変える）は、そのスロットも changed に含めて連動理由を why に明記する。改名（renamed:true）時は logo も changed に含める。宣言なしにスロットを動かした場合、サーバが親の値へ差し戻す。',
'   {label:"版の短い名前", bet:"この版の消費者仮説＝賭け（誰の・どの実在の瞬間に・なぜ効くと読むか。市場実証があれば添える）", proposition:"この版の命題（賭けから導かれる様式の言明）", aim:"この版の狙い（平易な一文）", decisions:[{decision,seek,evidence}]（4変数それぞれの命題からの導出が読める3-5個）, glance:"ひと目の違い", ledger:{keeps:[{code,note}], breaks:[{code, hypothesis:"破ることで生じる誤読の仮説", measure:"その検証手段"}], note:"共有数は目録の符号化完了後に確定"}, gates:[G1-G6の再判定{id,result:pass|conditional|fail,note}], measurement:"調査で測ること", falsify:"反証条件", coding:{A1..A8: 目録スキーマの水準値}（設計からの符号化。派生・新方向を問わず全specで必須）, signature:{attrId,level,sub,basis}（署名の新設——別項の厳守指示参照）, system:{palette:[{hex,name}],motif,typography,composition,finish,tone}, design:{surface:{v,en,why}, motif:{v,en,why}, layout:{v,en,why}, logo:{v,en,why}, copy:{v,en,why}}}。',
'設計書（design・厳守）: 5スロットすべてを完成形として書き切る（変更しないスロットも親の値を引き継いで書く）。v=日本語の設計記述、en=画像モデルに渡る英語の描画記述（缶上の文字は日本語のまま埋め込む）、why=採用論拠。motif が図像なしの場合は v:"図像なし"・en:"NO pictorial motif"。logo.v は必ず nameChoice.name を「」で含める（例: 「凪」細身セリフ・横組み・缶幅38%）。copy は「読点1つの短い断言」（例: 静かに、強い。）で、その執行の主導装置の読みを固定する一行——缶面には載らず、KVのヘッドラインとボードのタイルに逐語で描画される。prompts は書かない（サーバが CAN不変条件・ワードマークロックを含めて設計書から機械組み立てする）。',
'   warn の場合、spec は warnings の alternative を採用した形で書く（壁の外の表現をそのまま実装しない）。',
'',
'parts指定（input.locks）がある場合: locks.keep の要素は一切変更せず、locks.change の要素のみ操作対象にする。',
'借用（input.type="borrow"）の場合: 参照の decomposition から input.variables の変数だけを移植する。参照元の識別資産（他ブランドの色・紋章そのもの）は移植せず、「その変数が達成している知覚」を自ブランドの語彙で再実装する。監査のG4（他ブランド混線）照合を必ず行う。',
'新しい方向の設計（parentSpecがnull）の場合: 新方向は新しい「様式（命題）」であること。既存方向の命題と相互排他な文化系から取り、4変数すべてをその命題から一貫導出し、ledger（守るコード/破るコード+検証仮説）と risks:["接近する失敗前例名"]、coding:{A1..A8: 目録スキーマの水準値}（設計からの符号化） を必ず書く。existing_directions の glance と知覚レベルで取り違えないこと。specの design は v0（標準執行）のみを書く。下限・攻め端の2水準はサーバが承認後に別途設計するため、この応答に executions を含めない。',
'王道／定番の扱い（厳守）: 入力が「王道」「定番」「スタンダード」等を要求したら、knowledge.styleGuides の該当ガイドに従う。王道とは対象集合の共通文法（各属性の最頻コード）であって、特定銘柄の意匠の再現ではない。ガイドの signatures にある各銘柄の識別署名（その銘柄をその銘柄たらしめる属性の組）を同じ組み合わせで採ることは禁止——スーパードライ風・プレモル風など「どこかの銘柄っぽい」符号は機械検査で棄却される。王道の差分は識別署名以外の属性とワードマーク・細部で作る。さらに styleGuides の「ビールらしさの原則」に従い、(a)3系統（物性・舶来・作り手）のどれで「らしさ」を出すか (b)代表レイアウト4型（オーバル／上アイコン／中心揃え積み上げ／ビッグロゴ）のどれに立つか、を decisions に宣言すること。',
'王道の性格軸（厳守）: knowledge.styleGuides に「王道の性格軸: ◯◯」ガイドが含まれる場合（承認済みの軸のみ渡される）、入力がその軸名（例:「力強さの王道」「優しさの王道」）を指定したら、床（floor）の属性は全軸共通で維持し、拮抗属性は当該ガイドの profile の水準を基調に採る（tieWith は軸内の自由域）。入力が複数軸のブレンド（例:「強さ7:優しさ3」）を指定したら、拮抗属性を比率で配分する——比率の大きい軸から一次知覚側（A1地の色相・A4動勢）を、小さい軸から書体・細部側（A8等）を採り、どの属性をどの軸から採ったかを decisions に宣言する。profile の sigRisk が付く属性は署名帯であり、その水準をそのまま採らず、隣接水準または二次変数で同じ知覚を再実装する。軸の指定がない「王道」指定では、拮抗属性を文脈の癖（ターゲット記述・コンセプトの情緒）で無自覚に埋めないこと——承認済みの性格軸から命題に最も整合する軸を1つ選び、decisions に「性格軸: ◯◯を採用（理由）」と宣言してその profile に従う。承認済みの軸が無い場合のみ従来どおり自由域とする。',
'構造ブレンド（厳守）: input.blendDirective が渡された場合、それは承認済みの性格軸プロファイルからサーバが機械配分した属性割当である。floor の属性は水準をそのまま維持し、items の各属性はその level を基調に採る。sigRisk の付く項目は署名帯＝その水準を文字どおり採らず、隣接水準または二次変数（コントラスト・書体の骨格・密度・仕上げ）で同じ知覚を再実装し、置換の内容を decisions に明記する。level が null の項目は自由域として命題から導出してよい。採用した最終水準を coding に正直に書く（機械の模倣検知が走る）。ブレンドの意図（どの軸を何%）は bet と proposition に反映する。派生でブレンドが指定された場合、配分が要求するスロットの再導出は明示指示として正当であり、動かしたスロットを changed に全て列挙する。',
'知識の帰属（厳守）: knowledge は対象コンセプトの帰属でフィルタ済み。白虎・澄虎・浄化の意匠体系はコンセプト①「澄虎」（および②別解）の専用資産であり、それ以外のコンセプトの設計に虎・白虎・図像としての虎紋・名前「澄虎」を持ち込むことは入出力ルール違反。knowledge に無い記号を憶測で導入しない。',
'ワードマークの宣言（厳守）: spec には必ず nameChoice:{name:"缶上に載せる商品名/作業ラベル", basis:"採用論拠（1-2文）", status:"商標・先客・音の監査未実施"} を含める。名前は対象コンセプトのシート（pName）や本文の仮案から取り、未決なら入力とコンセプトから新たに提案する。派生（parentSpecあり）では nameChoice は親版のものをそのまま維持する——名前は方向の不変量であり、版ごとに変えない。入力が名前の変更を明示的に要求した場合のみ新しい nameChoice を書き、renamed:true を付けて basis に変更理由を記す。他コンセプトの名前の流用は禁止（特に「澄虎」は①の与件名で、①以外では使用不可）。design.logo 以外のスロットに他のワードマーク・ブランド名を書き込まないこと（ロックはサーバが注入する）。',
'署名の新設（厳守・PB対策）: 王道文法（最頻水準の合成）だけで組まれた案は棚の平均缶＝PBの文法そのものに収束する。実在の定番は必ず「王道文法＋固有の識別署名」で立っている（目録の signatures がその記録）。spec には必ず signature:{attrId:"A1〜A8のいずれか", level:"目録スキーマの水準名", sub:"その水準の中でこの案が具体的に占有する知覚——色相の具体値・処理・線の太さ・図像の扱い等（1-2文）", basis:"なぜこの占有が目録上の空白または少数派で、かつ命題と整合するか"} を含めること。選ぶ水準は目録上の空白または少数派であること——対象8缶の過半が持つ水準は共通文法であって署名にならない（サーバが占有数を機械検査して設計書に焼き込む）。既存銘柄の識別署名と同じ水準を選ぶ場合は sub でその銘柄と明確に異なる知覚を規定する。派生（parentSpecあり）では signature は親版のものをそのまま維持する——署名は方向の資産であり、版ごとに変えたらそれは署名ではない。入力が署名の変更を明示的に要求した場合のみ新しい signature を書き、basis に変更理由を記す。ブレンド指定があっても signature は別途必要——ブレンドは性格の混合、署名は固有性の宣言。coding は signature の水準と矛盾しないこと。',
'',
TYPE_DEFS,
WRITING_RULES,
'JSONのみで返す: {interpretation:{moves:[]}, matched:[], verdict:{status, warnings?, gap?}, spec}'
].join('\n');
var usr = JSON.stringify({
strategy: p.strategy,
concept: concept,
knowledge: _knowledgeFor(p, concept.id),
parentSpec: parent ? parent.spec : null,
existing_directions: existingGlances,
input: {
type: input.type || 'text',
text: input.text || '',
variables: input.variables || null,
locks: input.locks || null,
blendDirective: blendAlloc,
reference: ref ? { name: ref.name, decomposition: ref.decomposition, caution: ref.caution } : null
}
});
var out = await _chat([{role:'system', content:sys},{role:'user', content:usr}], { json:true, maxTokens: 11000, effort:'high' });
var proposal = _lenientJSON(out);
if (!proposal.verdict) throw new Error('判定が返りませんでした');
// 単一銘柄への接近の機械検知（王道／定番の模倣潰れ対策）: 検出したら1回だけ矯正再生成し、残存すれば警告として可視化する
if (proposal.spec && proposal.spec.coding){
var mim = _mimicryCheck(p, proposal.spec.coding);
if (mim){
var fix = '機械検査: 提案の符号（coding）が「' + mim.brand + '」と' + mim.match + '/' + mim.total + '属性一致（' + (mim.level==='replica' ? '完全一致' : '識別署名の再現を含む接近') + '）。王道は共通文法であり単一銘柄の再現ではない。属性 ' + mim.changeAttrs.join('・') + ' を当該銘柄と異なる水準に変え、design と decisions も整合させた改訂版を、同じJSONスキーマ全体で返し直すこと。';
try {
var out2 = await _chat([{role:'system', content:sys},{role:'user', content:usr},{role:'assistant', content:out},{role:'user', content:fix}], { json:true, maxTokens: 11000, effort:'high' });
var p2 = _lenientJSON(out2);
if (p2 && p2.verdict && p2.spec) proposal = p2;
} catch(e){}
var mim2 = proposal.spec ? _mimicryCheck(p, proposal.spec.coding) : null;
if (mim2){
proposal.verdict = proposal.verdict || { status:'warn' };
if (proposal.verdict.status === 'ok') proposal.verdict.status = 'warn';
proposal.verdict.warnings = (proposal.verdict.warnings || []).concat([{
wall: '記号監査 G4 他ブランド混線（機械検査）',
why: '符号が「' + mim2.brand + '」と' + mim2.match + '/' + mim2.total + '属性一致しています',
alternative: '属性 ' + mim2.changeAttrs.join('・') + ' を当該銘柄と異なる水準へ（王道＝共通文法。識別署名の再現は不可）'
}]);
}
}
}
if (blendAlloc && proposal.spec) proposal.spec.blend = blendAlloc; // サーバ焼き込み＝設計書の配分表示は機械計算の事実
// 署名の継承（サーバ強制）: 派生で署名が返らなかった場合は親版の署名を継承する——署名は方向の資産（統制改訂と同じ思想）
if (args.versionId && parent && parent.spec && parent.spec.signature && parent.spec.signature.attrId
&& !(proposal.spec && proposal.spec.signature && proposal.spec.signature.attrId)){
if (proposal.spec){
proposal.spec.signature = JSON.parse(JSON.stringify(parent.spec.signature));
delete proposal.spec.signature.occupancy; // 承認時に現在の目録で再検査させる
proposal.spec.signature.inherited = true;
}
}
proposal._input = { directionId: args.directionId || null, versionId: args.versionId || null, conceptId: concept.id, summary: _inputSummary(input, ref) };
return proposal;
}
function _inputSummary(input, ref){
var bl = '';
if (input.blend && Object.keys(input.blend).length){
bl = '王道ブレンド(' + Object.keys(input.blend).filter(function(k){ return Number(input.blend[k]) > 0; }).map(function(k){ return k.replace(/^arch-/,'') + input.blend[k] + '%'; }).join('・') + ') ';
}
if (input.type === 'borrow' && ref) return bl + '参照「' + ref.name + '」から ' + (input.variables||[]).join('・') + ' を借用' + (input.text ? '（' + input.text + '）' : '');
if (input.locks) return bl + 'パーツ指定（維持:' + (input.locks.keep||[]).join('・') + ' / 変更:' + (input.locks.change||[]).join('・') + '）' + (input.text || '');
return bl + (input.text || '');
}
/** 提案を承認して版を作成 */
async function approveProposal(args){
args = args || {};
var proposal = args.proposal;
if (!proposal || !proposal.spec) throw new Error('spec のない提案は承認できません');
var made = null;
await _withLock(async function(p){
var dir = _dirOf(p, args.directionId);
if (!dir) throw new Error('方向が見つかりません');
// 派生は親版の nameChoice を継承する。名前は方向の不変量なので、入力が明示的に改名を要求した場合
// （パイプラインが renamed:true を宣言した場合）以外は、AIが別名を返しても親の名前へ差し戻す。
var _pv = args.parentVersionId ? _verOf(dir, args.parentVersionId) : null;
var _pn = _pv && _pv.spec && _pv.spec.nameChoice ? _pv.spec.nameChoice : null;
if (!proposal.spec.nameChoice){
if (_pn) proposal.spec.nameChoice = JSON.parse(JSON.stringify(_pn));
} else if (_pn && proposal.spec.nameChoice.name !== _pn.name && !proposal.spec.nameChoice.renamed){
var _rejected = proposal.spec.nameChoice.name;
proposal.spec.nameChoice = JSON.parse(JSON.stringify(_pn));
// 設計書ロゴ欄に紛れた別名も親の名前へ置換（ロックとロゴ記述の矛盾を残さない）
if (proposal.spec.design && proposal.spec.design.logo && _rejected){
['v','en'].forEach(function(k){
if (proposal.spec.design.logo[k]) proposal.spec.design.logo[k] = String(proposal.spec.design.logo[k]).split(_rejected).join(_pn.name);
});
}
}
// 統制された改訂: 宣言（changed）にないスロットの変更は親の値へ差し戻す
_controlledRevision(_pv ? _pv.spec : null, proposal.spec);
// 設計書必須＋プロンプト機械組み立ての一本化: LLMの自由英文プロンプトは受けない。
// CAN不変条件・必須表示・2秒棚テスト・ワードマークロックが構造的に必ず入る。
var _rep = proposal.spec.coding ? _mimicryCheck(p, proposal.spec.coding) : null;
if (_rep && _rep.level === 'replica') throw new Error('符号が「' + _rep.brand + '」と完全一致（' + _rep.match + '/' + _rep.total + '属性）のため承認できません。属性 ' + _rep.changeAttrs.join('・') + ' を変えて再生成してください');
_finishSpec(proposal.spec, dir.conceptId, dir.id);
_stampShelfCheck(p, proposal.spec);
var v = {
id: 'v' + Date.now(),
parentId: args.parentVersionId || null,
created: new Date().toISOString(),
label: proposal.spec.label || '改訂版',
origin: {
inputSummary: (proposal._input && proposal._input.summary) || '',
interpretation: proposal.interpretation || null,
matched: proposal.matched || [],
verdict: proposal.verdict || null
},
spec: proposal.spec,
visuals: { board:{status:'empty'}, package:{status:'empty'}, kv:{status:'empty'} }
};
dir.versions.push(v);
made = v;
return true;
});
return { project: await _loadProject(), versionId: made.id };
}
/** 新しい方向を承認して作成（パイプライン提案から） */
async function approveNewDirection(args){
args = args || {};
var proposal = args.proposal;
if (!proposal || !proposal.spec) throw new Error('spec のない提案は承認できません');
var made = null;
await _withLock(async function(p){
var _cid = (proposal._input && proposal._input.conceptId) || p.activeConceptId;
if (!(p.concepts||[]).some(function(c){ return c.id === _cid; })){
throw new Error('コンセプトが見つかりません（id: ' + _cid + '）。画面を再読み込みして最新の状態で再実行してください');
}
var _rep2 = proposal.spec.coding ? _mimicryCheck(p, proposal.spec.coding) : null;
if (_rep2 && _rep2.level === 'replica') throw new Error('符号が「' + _rep2.brand + '」と完全一致（' + _rep2.match + '/' + _rep2.total + '属性）のため承認できません。属性 ' + _rep2.changeAttrs.join('・') + ' を変えて再生成してください');
var originV0 = { inputSummary: (proposal._input && proposal._input.summary) || '', interpretation: proposal.interpretation||null, matched: proposal.matched||[], verdict: proposal.verdict||null };
var built = _buildNewDirectionVersions(proposal.spec, _cid, originV0);
built.versions.forEach(function(bv){ _stampShelfCheck(p, bv.spec); });
var d = {
id: 'd' + Date.now(),
conceptId: _cid,
name: proposal.spec.label || '新しい方向',
axis: { control:false, risks: proposal.spec.risks || [] },
origin: 'user',
phase: 'direction',
gated: null,
note: '',
versions: built.versions,
repVersionId: built.repId
};
p.directions.push(d);
made = d;
return true;
});
return { project: await _loadProject(), directionId: made.id };
}
/* ================= 参照の変数分解 ================= */
/* ---------- コード目録: 二重符号化・裁定・機械的コード判定 ---------- */
function _cbOf(p){ return p.audit && p.audit.codebook; }
function _cbItem(cb, id){
var hit=null;
(cb.targets||[]).concat(cb.contrast||[]).concat(cb.refTargets||[]).forEach(function(t){ if(t.id===id) hit=t; });
return hit;
}
async function _encodeOnce(cb, item, imageB64, mime){
var ask = [
'缶パッケージ画像を、以下の属性スキーマに符号化せよ。各属性は必ずlevelsのいずれか1値。判定基準に厳密に従い、迷う場合も最も近い1値を選ぶ。',
JSON.stringify(cb.schema),
'対象: ' + item.brand,
'JSONのみ: {"A1":"","A2":"","A3":"","A4":"","A5":"","A6":"","A7":"","A8":""}（値はlevelsの文字列そのまま）'
].join('\n');
var content = [{type:'text', text: ask}, {type:'image_url', image_url:{url:'data:'+(mime||'image/png')+';base64,'+imageB64}}];
return _lenientJSON(await _chat([{role:'user', content: content}], { json:true, maxTokens: 800 }));
}
async function encodeCanToSchema(args){
args = args || {};
if (!args.targetId || !args.imageB64) throw new Error('targetIdと画像が必要です');
var p0 = await _loadProject();
var cb0 = _cbOf(p0); if (!cb0) throw new Error('コード目録が未初期化です');
var item = _cbItem(cb0, args.targetId); if (!item) throw new Error('未知の対象: ' + args.targetId);
var f = await _saveFile('genzo_cb_' + args.targetId + '_' + Date.now() + '.png', Buffer.from(args.imageB64, 'base64'), args.mime || 'image/png');
// 二重符号化。LLM 呼び出しはロック外で行い、結果の書き込みだけをロック内で行う
var e1 = await _encodeOnce(cb0, item, args.imageB64, args.mime);
var e2 = await _encodeOnce(cb0, item, args.imageB64, args.mime);
return await _withLock(async function(p){
var cb = _cbOf(p); if (!cb) throw new Error('コード目録が未初期化です');
if (!_cbItem(cb, args.targetId)) throw new Error('未知の対象: ' + args.targetId);
var cells = {}, agreeN = 0;
cb.schema.forEach(function(a){
var v1 = e1[a.id] || '', v2 = e2[a.id] || '';
var agree = v1 && v1 === v2;
if (agree) agreeN++;
cells[a.id] = { v: v1, v2: v2, status: agree ? 'encoded' : 'needs-adjudication' };
});
cb.table[args.targetId] = { cells: cells, imageFile: f.name, imageFileId: f.id,
agreement: Math.round(100*agreeN/cb.schema.length), encodedAt: new Date().toISOString(),
basis: '画像からの二重符号化（画像に遡及可能）' };
_cbComputeCodes(cb);
_cbPairTest(cb);
return p;
});
}
async function adjudicateCell(args){
args = args || {};
return await _withLock(async function(p){
var cb = _cbOf(p); if (!cb || !cb.table[args.targetId]) throw new Error('未符号化の対象です');
var cell = cb.table[args.targetId].cells[args.attrId]; if (!cell) throw new Error('未知の属性');
cell.v = args.value; cell.status = 'verified';
_cbComputeCodes(cb);
_cbPairTest(cb);
return p;
});
}
function _cbComputeCodes(cb){
var n = 0, freq = {};
cb.schema.forEach(function(a){ freq[a.id] = {}; });
(cb.targets||[]).forEach(function(t){
var row = cb.table[t.id]; if (!row) return;
n++;
cb.schema.forEach(function(a){
var c = row.cells[a.id]; if (!c || !c.v) return;
freq[a.id][c.v] = (freq[a.id][c.v]||0) + 1;
});
});
var anyDraft = (cb.targets||[]).some(function(t){
var row = cb.table[t.id];
if (!row) return true;
return cb.schema.some(function(a){ var c=row.cells[a.id]; return !c || c.status==='needs-adjudication'; });
});
cb.codes = [];
if (n === 0){ cb.codesNote = '符号化された対象が0本。コード判定は符号化後に自動計算されます。'; return cb; }
cb.schema.forEach(function(a){
var best = null;
Object.keys(freq[a.id]).forEach(function(v){ if (!best || freq[a.id][v] > freq[a.id][best]) best = v; });
if (!best) return;
var share = freq[a.id][best];
cb.codes.push({ attr: a.id + ' ' + a.name, level: best, share: share + '/' + n, isCode: (share / n) >= cb.kThreshold });
});
cb.codesNote = anyDraft ? '暫定（未裁定・未符号化のセルが残っています。全セル確定まで判定はドラフト扱い）' : '確定（全セル画像検証済み）';
return cb;
}
async function decomposeReference(args){
args = args || {};
if (!args.name && !args.imageB64) throw new Error('商品名か画像のどちらかは必要です');
var p = await _loadProject();
var imageFileId = null, imageFile = null;
if (args.imageB64){
var _rf = await _saveFile('genzo_ref' + Date.now() + '.png', Buffer.from(args.imageB64, 'base64'), args.mime || 'image/png');
imageFileId = _rf.id; imageFile = _rf.name;
}
var ask = [
'次の参照商品を、GENZOの視覚変数スキーマに分解せよ。分解は「寄せたい」を変数単位の操作に変換するための共通言語である。',
'V1=支配色 / V2=地の素材感 / V3=図像の様式・動勢 / V4=構図の界構造 / secondary={typography, finish, density}',
'併せて、提供する監査DBと照合し、この参照から変数を借用する場合の注意（他ブランド識別資産との混線=G4、規制、カテゴリ混線）を書く。',
'JSONのみ: {"summary":"一言でどんなデザインか","decomposition":{"V1":"","V2":"","V3":"","V4":"","secondary":{"typography":"","finish":"","density":""}},"working":"なぜこのデザインが市場で効いているかの仮説（完結した文）","borrowSuggest":["借用に向く変数と、借りられるのは何か（識別資産でなく知覚）を1-3個"],"caution":"借用時の注意（監査DBとの照合結果を含む自己完結文）"}',
'監査DB: ' + JSON.stringify(p.audit),
'商品名: ' + (args.name || '不明'),
'商品情報: ' + (args.info || 'なし')
].join('\n');
var content = [{ type:'text', text: ask }];
if (args.imageB64) content.push({ type:'image_url', image_url:{ url:'data:' + (args.mime || 'image/png') + ';base64,' + args.imageB64 } });
var out = await _chat([{role:'user', content: content}], { json:true, maxTokens: 3000 });
var a = _lenientJSON(out);
await _withLock(async function(p2){
p2.refs.push({
id: 'r' + Date.now(), name: args.name || '(名称未設定)', info: args.info || '',
imageFile: imageFile, imageFileId: imageFileId,
summary: a.summary || '', decomposition: a.decomposition || {}, working: a.working || '',
borrowSuggest: a.borrowSuggest || [], caution: a.caution || '',
created: new Date().toISOString()
});
return true;
});
return await _loadProject();
}
async function deleteReference(id){
await _withLock(async function(p){ p.refs = (p.refs||[]).filter(function(r){ return r.id !== id; }); return true; });
return await _loadProject();
}
async function deleteDirection(id){
await _withLock(async function(p){ p.directions = (p.directions||[]).filter(function(d){ return d.id !== id; }); return true; });
return await _loadProject();
}
async function updateConceptSheet(conceptId, field, value){
await _withLock(async function(p){
var c=null; (p.concepts||[]).forEach(function(x){ if(x.id===conceptId)c=x; });
if(!c) throw new Error('コンセプトが見つかりません');
c.sheet = c.sheet || {};
c.sheet[field] = { v: String(value||'未決'), src: (value&&String(value).trim())?'ツール上で定義':'未決' };
return true;
});
return await _loadProject();
}
async function addConcept(name, insight, statement){
await _withLock(async function(p){
var id='c-'+Date.now().toString(36);
p.concepts.push({ id:id, name:name||'新コンセプト', insight:insight||'', statement:statement||'',
naming:'商品名は未決。本タブのアウトプット対象', namingStatus:'working',
sourceNote:'出自: ツール上で新規作成（資料外の④）。要素の出自は各セルに明示',
sheet:{ insight:{v:insight||'未決',src:insight?'ツール提案':'未決'}, brandConcept:{v:'未決',src:'未決'},
devConcept:{v:statement||'未決',src:statement?'ツール提案':'未決'}, analogy:{v:'未決',src:'未決'},
benefitP:{v:'未決',src:'未決'}, benefitE:{v:'未決',src:'未決'},
fact:{v:'（ブレンド技術ファクトを流用可能）',src:'ツール提案'},
pColor:{v:'未決',src:'未決'}, pName:{v:'未決',src:'未決'}, pDba:{v:'未決',src:'未決'} },
openQuestion:'', keyterms:'全要素の出自はセル表示の通り。', framing:'新規コンセプトの展開枠。方向は「＋新しい方向」から。' });
p.activeConceptId=id; return true;
});
return await _loadProject();
}
async function clearVersionOutputs(directionId, versionId){
var trash = [];
await _withLock(async function(p){
var d = _dirOf(p, directionId); if(!d) throw new Error('方向が見つかりません');
var v = null; d.versions.forEach(function(x){ if(x.id===versionId) v=x; });
if (!v) throw new Error('版が見つかりません');
['board','package','kv'].forEach(function(t){
var x = v.visuals && v.visuals[t];
if (x && x.file) trash.push(x.file);
v.visuals[t] = { status:'empty' };
});
if (v.qa) delete v.qa;
return true;
});
await _trashFiles(trash);
return await _loadProject();
}
async function rebuildSpecFromImage(directionId, versionId){
var p0 = await _loadProject();
var d0 = _dirOf(p0, directionId); if(!d0) throw new Error('方向が見つかりません');
var v0 = _verOf(d0, versionId); if(!v0) throw new Error('版が見つかりません');
var fname = v0.visuals && v0.visuals.package && v0.visuals.package.file;
if(!fname) throw new Error('この版にはパッケージ画像がありません（採録は画像がある版のみ）');
var f = await _readFile(fname); if(!f) throw new Error('画像ファイルが保存先に見つかりません: '+fname);
var b64 = f.buffer.toString('base64');
var c0 = null; (p0.concepts||[]).forEach(function(x){ if(x.id===d0.conceptId) c0=x; });
var sp0 = v0.spec || {};
var sys = 'あなたはブランドのパッケージ設計者。缶画像を観測し、(A)事実の観測と(B)この完成形をこの方向の案として採択する場合の設計論拠を、日本語+英語の厳密なJSONで返す（コードフェンス禁止）。観測は美化しない。論拠は方向の命題に接続した設計判断として書く（後付けであることは呼び出し側が明示するので、論拠自体は堂々と設計の言葉で）。';
var usr = '【方向の文脈】コンセプト: '+(c0?c0.name:'')+'／方向: '+d0.name+'／命題: '+(sp0.proposition||'')+'／賭け: '+String(sp0.bet||'').slice(0,300)+'\n'
+ '缶画像を観測し、次のJSONのみを返す: {"wordmark":{"text":"缶上のブランド名の文字そのまま","script":"書体の系","layout":"縦/横・位置","width_pct":数値},"surface":{"jp":"観測","en":"english"},"motif":{"jp":"観測（なければ なし）","en":"english or NO pictorial motif"},"layout":{"jp":"観測","en":"english"},"copy":{"jp":"缶上の日本語コピー（なければ空）"},"rationale":{"surface":"この地がこの命題に効く理由","motif":"図像の理由","layout":"構図の理由","logo":"この名前・書体・置き方がこの方向に合う理由（名前の意味とこの世界観の接続を必ず含める）","copy":"コピーの理由","fit":"総評: この完成形はこの方向の案として立つか・弱点は何か（1-2文）"}}';
var content = [ { type:'text', text: usr }, { type:'image_url', image_url:{ url:'data:image/png;base64,'+b64 } } ];
var raw = await _chat([{role:'system',content:sys},{role:'user',content:content}], {json:true, maxTokens:6000, effort:'low'});
var o = _lenientJSON(raw);
if(!o || !o.wordmark || !o.wordmark.text) throw new Error('採録の解析に失敗（画像からワードマークが読めません）');
var nm = String(o.wordmark.text).trim();
var made = null;
await _withLock(async function(p){
var d = _dirOf(p, directionId); var v = _verOf(d, versionId);
if(!v) throw new Error('版が見つかりません');
var R = o.rationale || {};
function W(k){ return '事後採択: ' + (R[k] || 'この完成形を本方向の案として採用する') + '（画像を観測して採択した論拠。意図の先行設計ではない点は origin に記録）'; }
var lgV = '「'+nm+'」'+(o.wordmark.script||'')+'・'+(o.wordmark.layout||'')+'・缶幅'+(o.wordmark.width_pct||'?')+'%（画像上の実名を事後採用・監査未実施）';
var lgE = (String(o.wordmark.layout||'').indexOf('縦')>=0?'vertical ':'horizontal ')+(o.wordmark.script||'')+' wordmark '+nm+' at '+(o.wordmark.width_pct||40)+'% of can width';
v.spec.design = {
surface:{ v:(o.surface&&o.surface.jp)||'', en:(o.surface&&o.surface.en)||'', why:W('surface') },
motif:{ v:(o.motif&&o.motif.jp)||'なし', en:(o.motif&&o.motif.en)||'NO pictorial motif', why:W('motif') },
layout:{ v:(o.layout&&o.layout.jp)||'', en:(o.layout&&o.layout.en)||'', why:W('layout') },
logo:{ v:lgV, en:lgE, why:W('logo') },
copy:{ v:(o.copy&&o.copy.jp)||v.spec.design&&v.spec.design.copy&&v.spec.design.copy.v||'', en:(o.copy&&o.copy.jp)||'', why:W('copy') }
};
v.spec.nameChoice = { name:nm,
basis:'事後採択: ' + (R.logo || 'この完成形の名前をこの方向の案として採用') + '｜出自の開示: 生成時は無宣言の偶発名（rev48以前）で、意図の先行設計ではない',
status:'商標・先客・音の監査未実施' };
if (R.fit) v.spec.recaptureFit = 'この完成形の評価（採択時のメモ）: ' + R.fit;
v.spec.prompts = { board:_boardPrompt(v.spec.design, v.spec.worldLine||v.spec.aim||''), package:_pkgPrompt(v.spec.design), kv:_kvPrompt(v.spec.design) };
_declareName(v.spec, d.conceptId, directionId); // 採録名にも越境ガード＋ワードマークロックを適用
v.origin = v.origin || {};
v.origin.recapture = { date:new Date().toISOString().slice(0,10), from:'package image', wordmark:nm };
made = nm;
return true;
});
return await _loadProject();
}
async function clearDirectionOutputs(directionId){
var trash = [];
await _withLock(async function(p){
var d = _dirOf(p, directionId); if(!d) throw new Error('方向が見つかりません');
d.versions.forEach(function(v){
['board','package','kv'].forEach(function(t){
var x = v.visuals && v.visuals[t];
if (x && x.file) trash.push(x.file);
v.visuals[t] = { status:'empty' };
});
if (v.qa) delete v.qa;
});
return true;
});
await _trashFiles(trash);
return await _loadProject();
}
async function deleteVersion(directionId, versionId){
var trash = [];
await _withLock(async function(p){
var d = _dirOf(p, directionId); if(!d) return true;
var vt = null; d.versions.forEach(function(x){ if(x.id===versionId) vt=x; });
if (vt && !vt.parentId && /-(v0|vLo|vHi)$/.test(versionId)){
throw new Error('設計された執行幅（v0/vLo/vHi）の箱は削除できません。生成物を消したい場合は「画像をクリア」を使ってください（設計と3幅の構造は保持されます）');
}
var hasChild = d.versions.some(function(v){ return v.parentId === versionId; });
if (hasChild) throw new Error('派生版がある版は削除できません（先に派生を削除してください）');
if (d.versions.length <= 1) throw new Error('最後の版は削除できません');
if (vt){
['board','package','kv'].forEach(function(t){
var x = vt.visuals && vt.visuals[t];
if (x && x.file) trash.push(x.file);
});
}
d.versions = d.versions.filter(function(v){ return v.id !== versionId; });
p.deletedVersionIds = p.deletedVersionIds || []; if(p.deletedVersionIds.indexOf(versionId)<0) p.deletedVersionIds.push(versionId);
if (d.repVersionId === versionId) d.repVersionId = d.versions[0].id;
return true;
});
await _trashFiles(trash);
return await _loadProject();
}
/* ================= 画像生成 ================= */
var SIZE_BY_TYPE = { board:'1536x1024', kv:'1536x1024', package:'1024x1536' }; // OpenAI 互換（gpt-image）用
var ASPECT_BY_TYPE = { board:'16:9', kv:'16:9', package:'3:4' };              // Vertex AI（Gemini画像 / Imagen）用
async function generateVisual(directionId, versionId, type, note){
var p = await _loadProject();
var dir = _dirOf(p, directionId);
if (!dir) throw new Error('方向が見つかりません');
if (dir.gated) throw new Error('この方向は監査ギャップ未解消のため画像化できません: ' + dir.gated);
var v = _verOf(dir, versionId);
if (!v || !v.spec || !v.spec.prompts || !v.spec.prompts[type]) throw new Error('プロンプトがありません');
var proh = _hardConstraints(p, dir.conceptId);
var refNames = [];
var prompt = v.spec.prompts[type];
if (type === 'kv'){
var pkg = v.visuals && v.visuals.package;
if (pkg && pkg.file){
refNames = [pkg.file];
prompt = 'Use the attached can design EXACTLY as the product in this banner — identical colors, logo, motif, layout and finish. Do not redesign it.\n' + prompt;
}
}
if (note) prompt += '\n\nART DIRECTION NOTE from the marketer (apply on top of the spec; where it conflicts with layout/motif details above, the note wins, but NEVER violate the hard constraints below): ' + note;
prompt += '\n\nHard constraints (never violate): ' + proh
+ '; Never depict any real existing beer brand, can design, logo, or trade dress (e.g. Asahi, Super Dry, Kirin, Ichiban Shibori, Suntory Premium Malts, Sapporo, Kuro Label, Yebisu, Orion, Heineken, Budweiser). The only product allowed is the fictional brand described in this prompt. Do not replicate the recognizable trade-dress combination (ground color + finish + composition + typeface signature) of any single existing brand; mainstream means the shared grammar of the shelf, executed with the wordmark and details of this specific can.';
var refs = [];
for (var i = 0; i < refNames.length; i++){
try { var rf = await _readFile(refNames[i]); if (rf) refs.push(rf); } catch(e){}
}
var b64 = await _genImage(prompt, { size: SIZE_BY_TYPE[type] || '1024x1024', aspectRatio: ASPECT_BY_TYPE[type] || '1:1' }, refs);
var name = 'genzo_' + directionId + '_' + versionId + '_' + type + '.png';
var file = await _saveFile(name, Buffer.from(b64, 'base64'), 'image/png');
await _withLock(async function(p2){
var d2 = _dirOf(p2, directionId); if(!d2) return true;
var v2 = _verOf(d2, versionId); if(!v2) return true;
v2.visuals[type] = { status:'done', file:name, fileId:file.id, at:new Date().toISOString() };
return true;
});
return { file:name, dataUri:'data:image/png;base64,' + b64 };
}
/* ================= サムネイル ================= */
var GATE_BRIEF = { 'blend-b4': 'br-seed-b4' };
/* web 接地（Vertex AI: Google検索グラウンディング / OpenAI互換: web_search）。戻り値 { text, cites:[{title,url}] } */
async function _groundedAudit(prompt){
return await llm.groundedSearch(prompt);
}
async function runGrounding(dirId){
// 1) 監査質問の構築（読み取りのみ・ロック外）
var p0 = await _loadProject();
var d0 = null; (p0.directions||[]).forEach(function(x){ if(x.id===dirId) d0=x; });
if (!d0) throw new Error('方向が見つかりません');
if (!d0.gated) throw new Error('この方向は凍結されていません');
var c0 = null; (p0.concepts||[]).forEach(function(x){ if(x.id===d0.conceptId) c0=x; });
var sp0 = (d0.versions && d0.versions[0] && d0.versions[0].spec) || {};
var q = 'あなたはビールブランドのパッケージ監査の調査員。web検索で事実を確認し、日本語で厳密なJSONのみを返す（コードフェンス禁止）。\n'
+ '【監査対象】ブランド: サントリーの新ビール（コンセプト: ' + (c0?c0.name:'') + '）／方向: ' + d0.name + '\n'
+ '【凍結理由】' + d0.gated + '\n'
+ '【設計意図】' + (sp0.aim || '') + '\n'
+ '【確認事項】(1)通年定番ビールで季節記号（桜・雪・紅葉等の絵柄や季節色替え）を使う先客の有無と実例 (2)季節限定缶の記号慣習（限定品コード）の実例（直近1年以内の市場情報を優先。事例は年を明記） (3)定番と誤読されないための識別条件の提案 (4)判定。\n'
+ '【出力JSON】{"summary":"3行以内","findings":[{"claim":"事実","publisher":"発行元","title":"資料名","year":"年","url":"URL"}],"conditions":["識別条件"],"verdict":"clear|blocked","verdict_reason":"1-2文"}\n'
+ '出典は発行元・資料名・年を必須とし、確認できない主張は書かない。';
var g = await _groundedAudit(q);
var parsed = null;
try { parsed = JSON.parse(String(g.text).replace(/^`{1,3}json\s*|^`{1,3}\s*|`{1,3}\s*$/g, '').trim()); } catch(e){}
if (!parsed || !parsed.verdict) throw new Error('監査結果の解析に失敗（生テキストは監査記録に保存されません）: ' + String(g.text).slice(0,120));
var record = {
date: new Date().toISOString().slice(0,10),
method: 'グラウンディング（' + _model() + ' + ' + _searchTool() + '）',
question: '季節記号の先客・限定品コードとの識別条件',
summary: parsed.summary || '',
findings: parsed.findings || [],
conditions: parsed.conditions || [],
verdict: parsed.verdict,
verdictReason: parsed.verdict_reason || '',
extraCites: g.cites || []
};
// 2) 反映（ロック内）
await _withLock(async function(p){
var d = null; (p.directions||[]).forEach(function(x){ if(x.id===dirId) d=x; });
if (!d) throw new Error('方向が見つかりません');
d.audits = d.audits || [];
d.audits.unshift(record);
if (parsed.verdict === 'clear'){
d.gated = null;
d.note = ('✅ 監査済（グラウンディング ' + record.date + '）: 識別条件つきで凍結解除。条件と出典は設計書の監査記録。 ' + (d.note || '')).slice(0, 400);
} else {
d.gated = '監査ギャップ未解消（グラウンディング ' + record.date + ' 再判定: 凍結維持）: ' + (record.verdictReason || '先客・誤読リスクが解消できず') + ' — 詳細は設計書の監査記録。';
}
var bid = GATE_BRIEF[dirId];
if (bid){
(p.briefs||[]).forEach(function(b){
if (b.id !== bid) return;
b.resolution = { method: record.method, date: record.date, verdict: record.verdict, summary: record.summary, sources: record.findings };
if (parsed.verdict === 'clear') b.status = 'closed';
});
}
return true;
});
return await _loadProject();
}
/* ================= 内部リサーチエンジン =================
gap（提供知識の外）を外部のディープリサーチに出さず、システム内で 計画→接地調査→統合 の3段で実行する。
- researchPlan: 調査依頼を、web検索1回ずつで検証可能な独立質問（先客確認/規制確認/借用元文法/市場実証）に分解
- researchExecute: 1質問を web_search 接地で実行し、出典つき findings を返す（保存しない）
- researchIntegrate: 全結果を監査台帳の正規レコード（記号監査/借用元マップ/禁止事項/語彙規制/発見）に統合し、
  コンセプト帰属（scope）と出典（origin）つきで永続化。禁止事項は en を持ち画像生成のハード制約にも自動接続される
クライアントが3段を順に呼ぶ（各段を1リクエストに収めてタイムアウトを避け、進捗を可視化する）。 */
async function researchPlan(args){
args = args || {};
var p = await _loadProject();
var concept = null; (p.concepts||[]).forEach(function(c){ if(c.id===args.conceptId) concept=c; });
if (!concept) throw new Error('コンセプトが見つかりません（id: ' + (args.conceptId||'未指定') + '）');
var have = {
symbols: ((p.audit&&p.audit.symbols)||[]).filter(function(s){ var sc=_scopePass(s,concept.id); return sc===null?true:sc; }).map(function(s){ return s.name+'('+(s.verdict||'')+')'; }),
sources: ((p.audit&&p.audit.sources)||[]).filter(function(s){ var sc=_scopePass(s,concept.id); return sc===null?true:sc; }).map(function(s){ return s.name+'('+(s.status||'')+')'; })
};
var sys = [
'あなたはブランドデザイン監査の調査設計者。渡された調査依頼を、web検索1回ずつで検証可能な独立の調査質問に分解する。',
'質問タイプは4種: 先客確認（その記号・モチーフ・名前を既に強く占有しているブランド/作品/文化的含意と、連想の支配度・鮮度）/ 規制確認（酒類の広告・宣伝及び酒類容器の表示に関する自主基準、景表法、健康増進法など該当条項との適合）/ 借用元文法（借用したい他カテゴリの成功デザイン文法の実体、移植可能な要素、市場実証の数字）/ 市場実証（棚の実勢・シェア・リニューアル動向など事実の確認）。',
'規則: (a)1質問=1検証対象。webで一次情報に当たれる具体性で書く（固有名詞を含める） (b)already_audited と重複する質問は立てない (c)3〜5問・優先度順 (d)各質問に aim（この答えが設計のどの判断を解錠するか）を書く。',
'JSONのみ: {title:"調査の題", questions:[{id:"Q1", type:"先客確認|規制確認|借用元文法|市場実証", q:"検証可能な具体的質問", aim:"設計判断への接続"}]}'
].join('\n');
var usr = JSON.stringify({
brief: { title: args.briefTitle||'', missing: args.missing||'', text: args.briefText||'' },
concept: { id: concept.id, name: concept.name, sheet: concept.sheet||null },
strategy_meta: (p.strategy && p.strategy.meta) || null,
already_audited: have
});
var out = _lenientJSON(await _chat([{role:'system',content:sys},{role:'user',content:usr}], {json:true, maxTokens:3000, effort:'medium'}));
if (!out || !out.questions || !out.questions.length) throw new Error('調査計画の生成に失敗しました');
out.questions = out.questions.slice(0, 5);
return out;
}
async function researchExecute(args){
args = args || {};
var q = args.question || {};
if (!q.q) throw new Error('調査質問が空です');
var guides = {
'先客確認': '(1)その記号/名前/モチーフを現在強く占有しているブランド・作品・文化的連想を特定（発行元と年つき） (2)連想の支配度（全国区か一部か・鮮度） (3)混同を避ける識別条件の提案',
'規制確認': '(1)該当し得る基準・法令の名称と条項の内容 (2)使用可・条件付き・不可の判定材料 (3)缶体表示・意匠への具体的な影響',
'借用元文法': '(1)借用元カテゴリの実在デザイン文法（色・組版・素材・構図の具体） (2)その文法の移植で成立した実例と数字 (3)移植時の誤読リスク',
'市場実証': '(1)事実の確認（数字は出典年つき） (2)直近1年の変化 (3)設計判断への含意'
};
var prompt = 'あなたはビールブランドのパッケージ監査の調査員。web検索で事実を確認し、日本語で厳密なJSONのみを返す（コードフェンス禁止）。\n'
+ '【調査質問】(' + (q.type||'') + ') ' + q.q + '\n'
+ '【この答えが解錠する設計判断】' + (q.aim||'') + '\n'
+ '【確認事項】' + (guides[q.type] || '(1)事実の確認 (2)出典 (3)設計判断への含意') + '\n'
+ '【出力JSON】{"summary":"3行以内","findings":[{"claim":"事実（1文・具体）","publisher":"発行元","title":"資料名","year":"年","url":"URL"}],"implication":"設計判断への含意（1-2文）","confidence":"high|mid|low","unverified":["確認できなかった事項"]}\n'
+ '出典は発行元・資料名・年を必須とし、web検索で確認できない主張は findings に書かない（unverified に回す）。';
var g = await _groundedAudit(prompt);
var parsed = null;
try { parsed = _lenientJSON(g.text); } catch(e){}
if (!parsed) throw new Error('調査結果の解析に失敗: ' + String(g.text).slice(0, 120));
return { summary: parsed.summary||'', findings: parsed.findings||[], implication: parsed.implication||'', confidence: parsed.confidence||'mid', unverified: parsed.unverified||[], extraCites: g.cites||[] };
}
async function researchIntegrate(args){
args = args || {};
var cid = args.conceptId;
var p0 = await _loadProject();
var concept = null; (p0.concepts||[]).forEach(function(c){ if(c.id===cid) concept=c; });
if (!concept) throw new Error('コンセプトが見つかりません（id: ' + (cid||'未指定') + '）');
var sys = [
'あなたはブランドデザイン監査の記録官。調査結果を、監査台帳の正規レコードに統合する。',
'出力レコードの型（該当があるものだけ）:',
'- symbols: 記号監査 [{name:"記号/モチーフ/名前", verdict:"可|条件付き可|要再考|不可", note:"判定根拠。条件付きなら条件、要再考なら代替案。出典（発行元・年）を文中に含める"}]',
'- sources: 借用元マップ [{name:"借用元", status:"合格|条件付き合格|不合格（記録として保持）", grammar:"借用元の文法", transplant:"移植してよい要素（不合格ならなし）", evidence:"実証（数字は出典年つき）", risk:"誤読リスクと防波堤"}]',
'- prohibitions: 禁止事項 [{v:"日本語の禁止文（1文）", en:"画像生成に渡す英語の否定制約（否定で誘引しない語選びにする）"}]',
'- vocab: 語彙規制 [{term:"表現", verdict:"使用可|条件付き|使用不可", basis:"根拠条項・法令名"}]',
'- findings: 発見 [{title:"見出し", fact:"事実（出典を文中に含める）"}] — 設計の材料になる市場事実のみ',
'規則: (a)調査findingsの裏付けがない主張はレコード化しない (b)確認できなかった事項は unresolved に列挙 (c)existing と同名の対象は、矛盾があるときだけ差分をnoteに明記して出す。単なる再掲は不要 (d)verdictは条件・代替まで書き切る（「要検討」で止めない）',
'JSONのみ: {digest:"3-5行の統合要約", symbols:[], sources:[], prohibitions:[], vocab:[], findings:[], unresolved:[]}'
].join('\n');
var usr = JSON.stringify({
concept: { id: concept.id, name: concept.name },
brief: args.brief || null,
results: args.results || [],
existing: {
symbols: ((p0.audit&&p0.audit.symbols)||[]).map(function(s){ return { name:s.name, verdict:s.verdict, scope:s.scope||null }; }),
sources: ((p0.audit&&p0.audit.sources)||[]).map(function(s){ return { name:s.name, status:s.status, scope:s.scope||null }; })
}
});
var out = _lenientJSON(await _chat([{role:'system',content:sys},{role:'user',content:usr}], {json:true, maxTokens:8000, effort:'high'}));
if (!out) throw new Error('統合に失敗しました');
var date = new Date().toISOString().slice(0,10);
var origin = { method:'内部リサーチ（' + _model() + ' + ' + _searchTool() + '）', date:date, brief:(args.brief && args.brief.briefTitle) || '' };
var added = { symbols:0, sources:0, prohibitions:0, vocab:0, findings:0 };
await _withLock(async function(p){
p.audit = p.audit || {};
p.audit.symbols = p.audit.symbols || []; p.audit.sources = p.audit.sources || [];
p.audit.prohibitions = p.audit.prohibitions || [];
p.audit.regulations = p.audit.regulations || {}; p.audit.regulations.vocab = p.audit.regulations.vocab || [];
var dupe = function(arr, name){ return arr.some(function(x){ return x && x.name === name && (x.scope || null) === cid; }); };
(out.symbols||[]).forEach(function(s){ if(!s || !s.name || dupe(p.audit.symbols, s.name)) return; s.scope = cid; s.origin = origin; p.audit.symbols.push(s); added.symbols++; });
(out.sources||[]).forEach(function(s){ if(!s || !s.name || dupe(p.audit.sources, s.name)) return; s.scope = cid; s.origin = origin; p.audit.sources.push(s); added.sources++; });
(out.prohibitions||[]).forEach(function(x){ if(!x || !x.v) return; x.scope = cid; x.origin = origin; p.audit.prohibitions.push(x); added.prohibitions++; });
(out.vocab||[]).forEach(function(x){ if(!x || !x.term) return; x.scope = cid; x.origin = origin; p.audit.regulations.vocab.push(x); added.vocab++; });
p.perception = p.perception || {}; p.perception.findings = p.perception.findings || [];
(out.findings||[]).forEach(function(f, i){ if(!f || !f.fact) return; f.id = 'R' + Date.now().toString(36) + i; f.scope = cid; f.origin = origin; p.perception.findings.push(f); added.findings++; });
p.research = p.research || [];
p.research.unshift({ id:'rs' + Date.now(), date:date, conceptId:cid, title:(args.brief && args.brief.briefTitle) || '内部リサーチ',
questions:(args.results||[]).map(function(r){ return { type:r.question && r.question.type, q:r.question && r.question.q, summary:r.summary, findings:(r.findings||[]).length, failed:!!r.failed }; }),
digest: out.digest || '', added: added, unresolved: out.unresolved || [] });
p.briefs = p.briefs || [];
p.briefs.unshift({ id:'b' + Date.now(), title:((args.brief && args.brief.briefTitle) || '内部リサーチ'), text:(args.brief && args.brief.briefText) || '', status:'closed',
resolution:{ method:origin.method, date:date, verdict:'integrated', summary:out.digest || '', sources:[].concat.apply([], (args.results||[]).map(function(r){ return r.findings || []; })).slice(0, 20) } });
return true;
});
return { project:await _loadProject(), digest:out.digest || '', added:added, unresolved:out.unresolved || [] };
}
async function conceptIntakeBrief(args){
args = args || {};
var p = await _loadProject();
var concept = null; (p.concepts||[]).forEach(function(c){ if(c.id===args.conceptId) concept=c; });
if (!concept) throw new Error('コンセプトが見つかりません（id: ' + (args.conceptId||'未指定') + '）');
var sys = [
'あなたはブランドデザイン監査の調査設計者。新しいコンセプトの設計に着手する前の「初期棚卸し」の調査依頼を書く。',
'依頼は、このコンセプトのシートから設計に使われそうな記号・モチーフ・語彙・借用元カテゴリの候補を特定し、それぞれの先客確認・規制確認・借用元文法の調査が必要である旨を、背景つきの完結した依頼文にする。',
'JSONのみ: {briefTitle:"依頼の題", missing:"欠けている知識の一言要約", briefText:"背景・確認したい事実・出力への期待を含む依頼文（500字以内）"}'
].join('\n');
var usr = JSON.stringify({ concept:{ id:concept.id, name:concept.name, sheet:concept.sheet||null }, strategy_meta:(p.strategy && p.strategy.meta) || null });
var out = _lenientJSON(await _chat([{role:'system',content:sys},{role:'user',content:usr}], {json:true, maxTokens:2000, effort:'medium'}));
if (!out || !out.briefText) throw new Error('棚卸し依頼の生成に失敗しました');
return out;
}
/* ================= デザインルールの箱（様式規範） =================
「王道／定番」が特定銘柄（スーパードライ等）の模倣に潰れる問題への構造対応。
- _mainstreamGuide: コード目録の符号化表から「王道＝各属性の最頻コード」と「各銘柄の識別署名
  （最頻から逸れている属性＝その銘柄をその銘柄たらしめる差分）」を機械導出する。常に目録と同期。
- _mimicryCheck: 提案specの符号（coding）を各銘柄の符号と突合し、単一銘柄への接近を機械検知する。
  完全一致(8/8)=複製として承認拒否、7/8以上または識別署名の全再現=模倣として矯正・警告。
- p.styleGuides: ユーザー定義の規範を格納する箱。defineStyleGuide で自然文から構造化して格納し、
  以後の設計知識（knowledge.styleGuides）と画像制約（en）に自動接続される。 */
/* シードの様式規範。出典: 「ビールらしさとは」サントリーデザイン部作成資料（チーム共有pptx・2026-07取込）。
既存のコード目録（A1..A8＝棚の統計的な共通文法）に対し、この資料は「なぜその意匠がビールらしいのか」
という意味論の導出（物性／舶来／作り手の3系統）と、レイアウトの型（4種）を与える——統計と意味論の両輪。
帰属判定: 本資料はカテゴリ普遍の知識（特定コンセプトの与件ではない）と判定し global に置く。
（コンセプト固有のクライアント資料を無判定でglobalに流し込むことが虎混入の原因だった——同じ轍を踏まないための明示判定） */
var SEED_STYLE_GUIDES = [
{
id: 'guide-beerness', kind: 'seed', scope: 'global',
name: 'ビールらしさの原則（サントリーデザイン部資料）',
source: '「ビールらしさとは」サントリーデザイン部作成資料',
definition: '缶ビールらしさは3系統の意味体系から生じる: ①ビールの物性（麦由来の金色／麦のイラスト／飲みごたえを感じる密度感）②舶来のお酒の記憶（英字のタイトル／樽詰め由来のオーバル組／古くからラベルにまかれていた記憶による中心揃え・シンメトリー）③作り手のこだわり感（細かい製法などの文言／品質保証感）。',
points: [
'アイコンが設定されている（星・紋章・動物章など、缶の頂点に立つ象徴図形。例: スーパードライの箔章、黒ラベルの星）',
'デザインの密度が高い（細かい文言・罫・装飾の積層が「飲みごたえの密度感」を作る。余白の多い軽装はビール圏から出やすい）',
'英字がもたらす舶来酒缶（英字タイトル・英文の添え書きが酒格を作る。例: KIRIN BEER、RICH MALT）',
'箱組、もしくは中心揃えの文字組み（古典ラベルの記憶。左揃えのフリーレイアウトはビールらしさを失う）'
],
layouts: [
{ type:'オーバル型', spec:'樽蓋由来の楕円ラベル枠を中心に置き、枠内に中心揃えで積む（Spring Valley/ラガー/Orion系譜）' },
{ type:'上アイコン型', spec:'缶上部中央にアイコン（星・恵比寿・獅子など）を置き、その下にロゴ・銘柄名を積む（ヱビス/黒ラベル/一番搾り系譜）' },
{ type:'中心揃え積み上げ型', spec:'専用アイコンを持たず、中心軸に文字要素を密度高く積層する（スーパードライ/アサヒ生系譜）' },
{ type:'ビッグロゴ型', spec:'ロゴタイプ自体を缶幅いっぱいの主役にする（Budweiser/Heineken＝海外プレミアムの文法）' }
],
rules: [
'王道／定番の設計では、3系統（物性・舶来・作り手）のどれで「らしさ」を出すかを decisions に宣言する',
'レイアウトは代表4型（オーバル／上アイコン／中心揃え積み上げ／ビッグロゴ）のいずれに立つかを宣言する。逸脱する場合は理由と検証仮説を ledger に書く',
'密度を落とす（余白を増やす）設計は「ビールらしさの喪失」を計器として測る攻め端でのみ行い、統制・標準執行では密度感を保つ',
'英字の添え書き・製法文言・品質保証の記号は、王道設計の標準装備として検討する（作り手のこだわり感の系統）'
],
en: []
}
];
function _brandSigs(cb){
var modal = {};
cb.schema.forEach(function(a){
var freq = {};
(cb.targets||[]).forEach(function(t){
var r = cb.table && cb.table[t.id]; var c = r && r.cells && r.cells[a.id];
if (c && c.v) freq[c.v] = (freq[c.v]||0) + 1;
});
var best = null;
Object.keys(freq).forEach(function(v){ if (best === null || freq[v] > freq[best]) best = v; });
modal[a.id] = { level: best, share: best !== null ? freq[best] : 0 };
});
// 署名の照合対象＝対象8缶＋符号化済みの参照缶（参照缶は最頻値には数えないが、
// 符号化されると識別署名が模倣検知の網に加わる——力強い王道の生成がバドワイザー等の複製へ潰れるのを防ぐ）
var sigItems = (cb.targets||[]).map(function(t){ return { t:t, ref:false }; })
.concat((cb.refTargets||[]).map(function(t){ return { t:t, ref:true }; }));
var sigs = sigItems.map(function(it){
var t = it.t;
var r = cb.table && cb.table[t.id]; if (!r) return null;
var vec = {}, distinctive = {};
cb.schema.forEach(function(a){
var c = r.cells && r.cells[a.id];
if (c && c.v){ vec[a.id] = c.v; if (modal[a.id].level !== null && c.v !== modal[a.id].level) distinctive[a.id] = c.v; }
});
return { id:t.id, brand:t.brand, vec:vec, distinctive:distinctive, ref:it.ref };
}).filter(function(x){ return x; });
return { modal: modal, sigs: sigs };
}
function _mainstreamGuide(p){
var cb = _cbOf(p); if (!cb || !cb.table || !Object.keys(cb.table).length) return null;
var bs = _brandSigs(cb);
var n = (cb.targets||[]).length;
return {
id: 'guide-mainstream', name: 'ビール王道／定番（コード目録から自動導出）', kind: 'derived', scope: 'global',
definition: '「王道／定番」とは対象' + n + '缶の共通文法（各属性の最頻コード）を指す。特定銘柄の意匠の再現ではない。',
codes: cb.schema.map(function(a){ var m = bs.modal[a.id]; return { attr: a.id + ' ' + a.name, level: m.level, share: m.share + '/' + n }; }),
signatures: bs.sigs.filter(function(s){ return !s.ref; }).map(function(s){ return { brand: s.brand, distinctive: s.distinctive }; }),
rules: [
'王道指定時は codes の最頻水準を基調に採る。占有率が拮抗する属性は、承認済みの「王道の性格軸」ガイドがある場合、命題に最も整合する軸を1つ選んで宣言しその profile に従う（自由域を文脈の癖で埋めない）。軸ガイドが無い場合のみ自由域',
'signatures の各銘柄の識別署名（distinctive）を、その銘柄と同じ組み合わせで再現しない',
'差別化は識別署名以外の属性・ワードマーク・細部で作る（王道＝棚の共通文法であって、どの銘柄の複製でもない）'
]
};
}
/* ================= 王道の性格軸（アーキタイプ）の導出 =================
「王道＝単一の最頻ベクトル」の分解。床（対象8缶の占有がkThreshold以上の属性＝ビールである
ための共通条件）は全軸で共有し、拮抗属性（最頻が割れている＝王道の中の性格を分けている属性）
だけを、各アーキタイプの構成銘柄上の条件付き最頻値で規定する。
- プロファイルは格納せず読み出し時に符号化表から導出（_mainstreamGuideと同じ設計＝観察に自動追随）
- sigRisk: 拮抗属性の水準が構成1缶だけの票で決まり、かつその缶の識別署名と同値の場合、
  その水準は「署名帯」——そのまま採ると当該銘柄の複製に近づくため機械警告として焼き込む
- status: draft（判断割当のまま）/ approved（チーム承認済み）。approvedのみ設計知識に接続 */
function _archetypeGuides(p){
var cb = _cbOf(p); if (!cb || !cb.table || !(cb.archetypes||[]).length) return [];
var bs = _brandSigs(cb);
var sigById = {}; bs.sigs.forEach(function(s){ sigById[s.id] = s; });
var nCoded = (cb.targets||[]).filter(function(t){ return cb.table[t.id]; }).length;
var kThr = cb.kThreshold || 0.7;
var byId = {};
(cb.targets||[]).forEach(function(t){ byId[t.id] = t; });
(cb.refTargets||[]).forEach(function(t){ byId[t.id] = t; });
return (cb.archetypes||[]).map(function(ar){
var members = (ar.members||[]).map(function(id){ return byId[id]; }).filter(function(x){ return x; });
var coded = members.filter(function(t){ return cb.table[t.id]; });
var floor = [], profile = [], sigRiskN = 0;
cb.schema.forEach(function(a){
var m = bs.modal[a.id] || { level:null, share:0 };
var isFloor = nCoded > 0 && m.level !== null && (m.share / nCoded) >= kThr;
if (isFloor){ floor.push({ attr: a.id + ' ' + a.name, level: m.level, share: m.share + '/' + nCoded }); return; }
var freq = {}, who = {};
coded.forEach(function(t){
var c = cb.table[t.id].cells && cb.table[t.id].cells[a.id];
if (c && c.v){ freq[c.v] = (freq[c.v]||0) + 1; (who[c.v] = who[c.v] || []).push(t); }
});
var best = null;
Object.keys(freq).forEach(function(v){ if (best === null || freq[v] > freq[best]) best = v; });
if (best === null){ profile.push({ attr: a.id + ' ' + a.name, level: null, share: '0/' + coded.length, note: '構成銘柄が未符号化' }); return; }
var contributors = who[best];
var tieWith = Object.keys(freq).filter(function(v){ return v !== best && freq[v] === freq[best]; });
var sigRisk = null;
if (contributors.length === 1){
var s = sigById[contributors[0].id];
if (s && s.distinctive && String(s.distinctive[a.id]||'') === String(best)){ sigRisk = contributors[0].brand; sigRiskN++; }
}
profile.push({ attr: a.id + ' ' + a.name, level: best, share: freq[best] + '/' + coded.length,
contributors: contributors.map(function(t){ return t.brand; }),
tieWith: tieWith.length ? tieWith : null, sigRisk: sigRisk });
});
var thin = coded.length < 2;
return {
id: 'guide-arch-' + ar.id, archetypeId: ar.id, kind: 'derived', scope: 'global',
name: '王道の性格軸: ' + ar.name, status: ar.status || 'draft', semantic: ar.semantic || '',
definition: '「' + ar.name + '」＝床（全軸共通のビール共通条件）を維持したまま、拮抗属性を構成銘柄' + coded.length + '/' + members.length + '缶の条件付き最頻値で規定した王道の一系統。' + (ar.basis ? ' 構成の根拠: ' + ar.basis : ''),
membersInfo: { names: members.map(function(t){ return t.brand + (cb.table[t.id] ? '' : '（未符号化）'); }), total: members.length, coded: coded.length },
floor: floor, profile: profile, thin: thin, sigRiskN: sigRiskN,
rules: [
'床（floor）の属性は水準をそのまま維持する——ここを崩すとビール可読を失う（全性格軸で共通）',
'拮抗属性は profile の水準を基調に採る。tieWith がある属性は軸内の自由域（どちらでも軸の性格を保つ）',
'sigRisk の付く属性は署名帯: その水準は当該銘柄の識別署名と同値のため、そのまま採らず、同じ知覚を隣接水準または二次変数（コントラスト・書体の骨格・密度）で再実装する',
'この軸を名指しした設計でも模倣検知（_mimicryCheck）は全銘柄・参照缶に対して通常どおり走る'
].concat(thin ? ['注意: 符号化済みの構成が' + coded.length + '缶のため条件付き最頻値の解像度が低い。参照缶の符号化で票が増えると規定が安定する'] : [])
};
});
}
/* ================= 王道ブレンドの機械配分 =================
「強さ60%×優しさ40%」の正直な実装: カテゴリカルな属性は線形補間できないため、
比率は「どの軸がどの拮抗属性を取るか」の配分として解釈する。床は全軸共通で維持。
- 配分は決定論（LLMに任せない）: 一次知覚側の属性（A1色相→A3図像→…）から、比率の大きい軸が取る
- 割当枠は最大剰余法で丸め、必ず全属性が埋まる
- 未符号化で水準がnullの軸に当たった属性は、次に比率の大きい水準保有軸へ落ちる（それも無ければ自由域）
- sigRisk（署名帯）はそのまま運ぶ——設計側は当該水準を直接採らず再実装する義務を負う
- 配分結果は spec.blend としてサーバが焼き込む（設計書ドロワーに表示・LLMの自己申告に依存しない） */
var _BLEND_ATTR_PRIORITY = ['A1','A3','A4','A2','A5','A8','A7','A6'];
function _blendAllocation(p, ratios){
ratios = ratios || {};
var guides = _archetypeGuides(p).filter(function(g){ return g.status === 'approved' && Number(ratios[g.archetypeId]) > 0; });
if (!guides.length) throw new Error('ブレンドに指定できる承認済みの性格軸がありません（承認は🏛土台→観察表を開く→王道の性格軸から）');
var sum = 0; guides.forEach(function(g){ sum += Number(ratios[g.archetypeId]); });
var axes = guides.map(function(g){
return { id: g.archetypeId, name: g.name.replace(/^王道の性格軸: /,''), pct: Math.round(100 * Number(ratios[g.archetypeId]) / sum), g: g };
}).sort(function(a,b){ return b.pct - a.pct; });
// 対象＝拮抗属性（全ガイドで共通の集合）。一次知覚の優先順に並べる
var attrs = (axes[0].g.profile || []).map(function(c){ return c.attr; });
attrs.sort(function(a,b){ return _BLEND_ATTR_PRIORITY.indexOf(a.split(' ')[0]) - _BLEND_ATTR_PRIORITY.indexOf(b.split(' ')[0]); });
var n = attrs.length;
if (!n) throw new Error('拮抗属性が0件です（符号化表が空の可能性）');
// 割当枠: 最大剰余法
var raw = axes.map(function(a){ return a.pct * n / 100; });
var quota = raw.map(function(x){ return Math.floor(x); });
var rem = n - quota.reduce(function(s,x){ return s + x; }, 0);
raw.map(function(x,i){ return { i:i, f: x - Math.floor(x) }; })
.sort(function(a,b){ return b.f - a.f; })
.slice(0, Math.max(0, rem))
.forEach(function(o){ quota[o.i]++; });
// 配分: 優先属性から、枠の残る最大比率の軸へ。水準未符号化なら次の水準保有軸へ落とす
var items = attrs.map(function(attr){
var owner = null;
for (var i = 0; i < axes.length; i++){ if (quota[i] > 0){ owner = i; break; } }
if (owner === null) owner = 0; else quota[owner]--;
var cellOf = function(ax){ var hit = null; (ax.g.profile||[]).forEach(function(c){ if (c.attr === attr) hit = c; }); return hit; };
var cell = cellOf(axes[owner]), from = axes[owner], fallback = false;
if (!cell || cell.level === null){
for (var j = 0; j < axes.length; j++){
var c2 = cellOf(axes[j]);
if (c2 && c2.level !== null){ cell = c2; from = axes[j]; fallback = (j !== owner); break; }
}
}
if (!cell || cell.level === null){
return { attr: attr, axisId: axes[owner].id, axisName: axes[owner].name, level: null, note: '自由域（全軸で未符号化）' };
}
return { attr: attr, axisId: from.id, axisName: from.name, level: cell.level,
sigRisk: cell.sigRisk || null, tieWith: cell.tieWith || null,
note: fallback ? '第一候補の軸が未符号化のため代替軸から採用' : null };
});
// 配分ベクトルの事前接近検査: 床＋配分水準の合成が実在銘柄の模倣域（7/8一致 or 識別署名の全再現）に
// 入る場合、そのまま厳守させると後段の模倣検知と矛盾する。模倣は識別署名1属性を外せば解ける（7/8→6/8かつ
// 署名の全再現が崩れる）ため、接触属性のうち知覚優先度の最も低い1項目だけに再実装フラグを立てる——
// ブレンドの主知覚（色相・図像）を守ったまま、機械指示を自己整合させる。
var floor = axes[0].g.floor || [];
var coding = {};
floor.forEach(function(f){ coding[f.attr.split(' ')[0]] = f.level; });
items.forEach(function(it){ if (it.level !== null) coding[it.attr.split(' ')[0]] = it.level; });
var mimicryNote = null;
var mim = _mimicryCheck(p, coding);
if (mim){
var hitItems = items.filter(function(it){ return it.level !== null && mim.changeAttrs.indexOf(it.attr.split(' ')[0]) >= 0; });
if (hitItems.length){
var target = hitItems[hitItems.length - 1]; // 優先度リスト末尾＝知覚上いちばん細部の属性を譲る
target.sigRisk = target.sigRisk || mim.brand;
target.note = ((target.note ? target.note + '。' : '')) + '接近検査: 配分どおりだと「' + mim.brand + '」と' + mim.match + '/' + mim.total + '属性一致——この属性は水準を文字どおり採らず、隣接水準か二次変数で同じ知覚を再実装して距離を作る';
mimicryNote = '配分ベクトルは「' + mim.brand + '」の模倣域に接触（' + mim.match + '/' + mim.total + '）。' + target.attr + ' の再実装で距離を確保する設計指示を発行済み';
}
}
return {
ratios: axes.map(function(a){ return { id: a.id, name: a.name, pct: a.pct }; }),
floor: floor,
items: items,
mimicryNote: mimicryNote,
derivedAt: new Date().toISOString().slice(0,10)
};
}
function _styleGuidesFor(p, conceptId){
var out = [];
var mg = _mainstreamGuide(p);
if (mg) out.push(mg);
// 王道の性格軸: 承認済み（approved）のみ設計知識に接続する——構成割当は判断であり、
// チームの命名承認を経ていないプロファイルで生成を規定しない（draftは📐と目録画面での表示のみ）
_archetypeGuides(p).forEach(function(g){ if (g.status === 'approved') out.push(g); });
SEED_STYLE_GUIDES.forEach(function(g){ out.push(g); });
((p.styleGuides)||[]).forEach(function(g){
if (!g) return;
var s = _scopePass(g, conceptId);
if (s === null || s === true) out.push(g);
});
return out;
}
function _mimicryCheck(p, coding){
if (!coding) return null;
var cb = _cbOf(p); if (!cb || !cb.table) return null;
var bs = _brandSigs(cb);
var worst = null;
bs.sigs.forEach(function(s){
var total = 0, match = 0;
Object.keys(s.vec).forEach(function(a){
if (coding[a] !== undefined && coding[a] !== null && String(coding[a]) !== ''){
total++;
if (String(coding[a]) === String(s.vec[a])) match++;
}
});
if (total < 6) return;
var dKeys = Object.keys(s.distinctive);
var dHit = dKeys.length > 0 && dKeys.every(function(a){ return String(coding[a]||'') === String(s.distinctive[a]); });
var level = null;
if (match === total && total >= 8) level = 'replica';
else if (match >= 7 || (dHit && match >= 6)) level = 'mimic';
if (!level) return;
var change = dKeys.filter(function(a){ return String(coding[a]||'') === String(s.distinctive[a]); });
if (!change.length) change = Object.keys(s.vec).filter(function(a){ return String(coding[a]||'') === String(s.vec[a]); }).slice(-2);
var v = { level: level, brand: s.brand, match: match, total: total, changeAttrs: change };
if (!worst || (worst.level !== 'replica' && level === 'replica') || (worst.level === level && v.match > worst.match)) worst = v;
});
return worst;
}
/* 設計ロジックの可視化用:
- _stampShelfCheck: 承認時に、版の符号（coding）を王道コード（最頻値）および全銘柄と照合した結果を
  spec.shelfCheck として焼き込む。設計書ドロワーに「どの属性で王道に立ち、どこで破り、
  最も近い実在銘柄からどれだけ距離があるか」が表示される。
- getStyleGuidesView: 📐の箱の展開表示用に、適用中の様式規範の全文（王道コード表・識別署名・
  ビールらしさの意味体系・ユーザー定義）を返す。 */
function _nearestBrand(p, coding){
if (!coding) return null;
var cb = _cbOf(p); if (!cb || !cb.table) return null;
var bs = _brandSigs(cb);
var best = null;
bs.sigs.forEach(function(s){
var total = 0, match = 0;
Object.keys(s.vec).forEach(function(a){
if (coding[a] !== undefined && coding[a] !== null && String(coding[a]) !== ''){ total++; if (String(coding[a]) === String(s.vec[a])) match++; }
});
if (total < 1) return;
if (!best || match > best.match) best = { brand: s.brand, match: match, total: total };
});
return best;
}
/* 署名の占有検査: 宣言された署名（attrId×level）を対象8缶（王道母集団）の符号化表と突合し、
その水準を現に持つ銘柄数を数える。空白(0)＝取りに行ける固有性 / 少数派(1-2)＝要sub差別化 /
共通文法(3+)＝署名として機能しない（王道の顔であって固有性ではない）。判定は焼き込みであって拒否ではない——
設計書に事実として残し、チームの判断材料にする。 */
function _signatureOccupancy(p, sig){
var cb = _cbOf(p); if (!cb || !cb.table || !sig || !sig.attrId || !sig.level) return null;
var holders = [];
(cb.targets||[]).forEach(function(t){
var r = cb.table[t.id]; var c = r && r.cells && r.cells[sig.attrId];
if (c && c.v && String(c.v) === String(sig.level)) holders.push(t.brand);
});
var n = (cb.targets||[]).filter(function(t){ return cb.table[t.id]; }).length;
var verdict = holders.length === 0 ? '空白' : (holders.length <= 2 ? '少数派' : '共通文法');
return { count: holders.length, of: n, holders: holders, verdict: verdict, checkedAt: new Date().toISOString().slice(0,10) };
}
function _stampShelfCheck(p, spec){
if (!spec || !spec.coding) return spec;
var cb = _cbOf(p); if (!cb || !cb.table) return spec;
// 署名の検査（v75以降の承認で焼き込み。未宣言もその事実を機械記録する）
if (spec.signature && spec.signature.attrId){
spec.signature.occupancy = _signatureOccupancy(p, spec.signature);
} else if (!spec.signature){
spec.signature = { missing: true };
}
var bs = _brandSigs(cb);
var attrs = [];
cb.schema.forEach(function(a){
var ours = spec.coding[a.id];
if (ours === undefined || ours === null || String(ours) === '') return;
var m = bs.modal[a.id] ? bs.modal[a.id].level : null;
attrs.push({ id: a.id, name: a.name, ours: String(ours), modal: m, follows: (m !== null && String(ours) === String(m)) });
});
spec.shelfCheck = { attrs: attrs, nearest: _nearestBrand(p, spec.coding), checkedAt: new Date().toISOString().slice(0,10) };
return spec;
}
async function getStyleGuidesView(){
var p = await _loadProject();
// archetypeGuides は status を問わず全件（draftの中身確認・承認判断のため）。
// guides（設計知識に接続される実体）に入るのは approved のみ＝_styleGuidesFor の判定に従う
return { guides: _styleGuidesFor(p, p.activeConceptId), archetypeGuides: _archetypeGuides(p), activeConceptId: p.activeConceptId };
}
/* ================= 性格軸・参照缶の目録操作 ================= */
async function updateArchetype(args){
args = args || {};
if (!args.id) throw new Error('アーキタイプIDが必要です');
return await _withLock(async function(p){
var cb = _cbOf(p); if (!cb || !(cb.archetypes||[]).length) throw new Error('性格軸が未初期化です。再読み込みしてください');
var ar = null; cb.archetypes.forEach(function(x){ if (x.id === args.id) ar = x; });
if (!ar) throw new Error('未知の性格軸: ' + args.id);
if (args.name !== undefined && String(args.name).trim()) ar.name = String(args.name).trim();
if (args.semantic !== undefined) ar.semantic = String(args.semantic);
if (args.addMember){
var item = _cbItem(cb, args.addMember);
if (!item) throw new Error('未知の缶: ' + args.addMember);
var isContrast = (cb.contrast||[]).some(function(t){ return t.id === args.addMember; });
if (isContrast) throw new Error('誤読物差し（対照缶）は性格軸の構成に入れられません——対照群は「ビールでないもの」の物差しです');
ar.members = ar.members || [];
if (ar.members.indexOf(args.addMember) < 0) ar.members.push(args.addMember);
// 構成の変更＝プロファイルが変わる＝承認は失効（draftへ差し戻し）
ar.status = 'draft';
}
if (args.removeMember){
ar.members = (ar.members||[]).filter(function(id){ return id !== args.removeMember; });
ar.status = 'draft';
}
if (args.status === 'approved'){
ar.status = 'approved';
ar.approvedAt = new Date().toISOString().slice(0,10);
} else if (args.status === 'draft'){
ar.status = 'draft'; delete ar.approvedAt;
}
return p;
});
}
async function addRefTarget(args){
args = args || {};
if (!args.brand || !String(args.brand).trim()) throw new Error('銘柄名が必要です');
return await _withLock(async function(p){
var cb = _cbOf(p); if (!cb) throw new Error('コード目録が未初期化です');
cb.refTargets = cb.refTargets || [];
var id = 'cbr-u' + Date.now();
cb.refTargets.push({ id: id, brand: String(args.brand).trim(), maker: String(args.maker||'').trim(),
basis: String(args.basis||'').trim() || '参照缶（選定は判断）', archetypeHint: args.archetypeHint || null, userAdded: true });
return p;
});
}
async function removeRefTarget(args){
args = args || {};
if (!args.id) throw new Error('IDが必要です');
return await _withLock(async function(p){
var cb = _cbOf(p); if (!cb) throw new Error('コード目録が未初期化です');
cb.refTargets = (cb.refTargets||[]).filter(function(t){ return t.id !== args.id; });
// 削除墓標: シード由来の参照缶がrev更新のマイグレーションで復活しないようにする（deletedVersionIdsと同じパターン）
cb.deletedRefTargetIds = (cb.deletedRefTargetIds||[]);
if (cb.deletedRefTargetIds.indexOf(args.id) < 0) cb.deletedRefTargetIds.push(args.id);
if (cb.table && cb.table[args.id]) delete cb.table[args.id]; // 符号化行も除去（参照缶は王道の計算に入らないため再計算は不要だが一貫のため実行）
(cb.archetypes||[]).forEach(function(ar){
var before = (ar.members||[]).length;
ar.members = (ar.members||[]).filter(function(m){ return m !== args.id; });
if ((ar.members||[]).length !== before) ar.status = 'draft'; // 構成が変わった軸は承認失効
});
_cbComputeCodes(cb);
return p;
});
}
async function defineStyleGuide(args){
args = args || {};
if (!args.name || !String(args.name).trim() || !args.instruction || !String(args.instruction).trim()) throw new Error('ルール名と定義文が必要です');
var p = await _loadProject();
var cb = _cbOf(p);
var sys = [
'あなたはブランドデザインの規範定義者。与えられた指示から、設計パイプラインが従える「デザインルール（様式規範）」を1件、構造化して書く。',
'規則: (a)特定銘柄の再現を規範化しない（銘柄名を規則に書かない） (b)属性はコード目録スキーマの水準から選ぶ (c)各規則は検証可能な具体性で1文 (d)画像制約 en は英語・否定で誘引しない語選び。',
'JSONのみ: {definition:"この規範が何を指すか（1-2文）", rules:["設計規則"], attrs:{規定するA1..A8のみ:"水準または許容範囲"}, en:["画像生成に渡す英語制約（任意）"], cautions:["この規範の誤用パターン"]}'
].join('\n');
var usr = JSON.stringify({ name: args.name, instruction: args.instruction, schema: cb ? cb.schema : null, mainstream: _mainstreamGuide(p) });
var out = _lenientJSON(await _chat([{role:'system',content:sys},{role:'user',content:usr}], {json:true, maxTokens:4000, effort:'medium'}));
if (!out || !out.rules || !out.rules.length) throw new Error('ルール定義の生成に失敗しました');
var g = { id:'sg' + Date.now(), name: String(args.name).trim(), kind:'user', scope: args.conceptId || 'global',
definition: out.definition || '', rules: out.rules, attrs: out.attrs || null, en: out.en || [], cautions: out.cautions || [],
origin: { method:'定義（' + _model() + '）', date: new Date().toISOString().slice(0,10), instruction: args.instruction, assets: args.assets || [] } };
await _withLock(async function(p2){ p2.styleGuides = p2.styleGuides || []; p2.styleGuides.push(g); return true; });
return { project: await _loadProject(), guide: g };
}
/* 添付資料（ブランドガイドライン・参考デザイン画像・PDF・テキスト）を読み、
様式規範の草稿（ルール名の案＋定義文＋出典メモ）に整理する。格納はしない——
人が定義文を確認・編集してから defineStyleGuide で箱に入れる（検証を挟む設計）。 */
async function analyzeStyleAssets(args){
args = args || {};
var files = args.files || [];
if (!files.length) throw new Error('分析するファイルがありません');
var parts = [], textDocs = [], totalLen = 0;
files.forEach(function(f){
if (!f || !f.data) return;
totalLen += String(f.data).length;
var mime = f.mime || '';
if (/^image\//.test(mime)){
parts.push({ type:'image_url', image_url:{ url:'data:' + mime + ';base64,' + f.data } });
} else if (mime === 'application/pdf'){
parts.push({ type:'file', file:{ filename: f.name || 'attachment.pdf', file_data: 'data:application/pdf;base64,' + f.data } });
} else if (/^text\//.test(mime) || /\.(txt|md|csv)$/i.test(f.name || '')){
try { textDocs.push('【添付テキスト: ' + (f.name||'') + '】\n' + Buffer.from(String(f.data), 'base64').toString('utf8').slice(0, 20000)); } catch(e){}
} else {
throw new Error('未対応のファイル形式です: ' + (f.name || mime) + '（画像・PDF・テキストに対応しています）');
}
});
if (totalLen > 9000000) throw new Error('添付の合計サイズが大きすぎます（合計およそ6MBまで）。画像は縮小、PDFは分割してください');
var p = await _loadProject();
var cb = _cbOf(p);
var ask = 'あなたはブランドデザイン監査の分析者。添付資料（ブランドガイドライン・参考デザイン・競合パッケージの写真・規定文書など）を読み、設計パイプラインに格納できる「デザインルール（様式規範）」の草稿を書く。\n'
+ '出力は日本語の厳密なJSONのみ（コードフェンス禁止）: {"name":"ルール名の案（12字以内）","definition":"定義文","sources":"各規則を資料のどこから読んだか（簡潔に）"}\n'
+ 'definition の書き方: (1)この規範が指す様式の一言要約 (2)必須事項（色・素材・図像・構図・書体を、コード目録スキーマの水準語で具体的に） (3)禁止事項 (4)運用条件。資料に書かれていないことを補わない。特定銘柄の再現を規範化しない（銘柄固有の意匠は「文法」に抽象化して書く）。\n'
+ (cb ? '【コード目録スキーマ（水準語はここから選ぶ）】' + JSON.stringify(cb.schema) + '\n' : '')
+ (args.note ? '【依頼者の補足・現状の下書き】' + args.note + '\n' : '')
+ (textDocs.length ? textDocs.join('\n\n') + '\n' : '')
+ '添付資料は以下。';
var content = [{ type:'text', text: ask }].concat(parts);
var out = _lenientJSON(await _chat([{ role:'user', content: content }], { json:true, maxTokens:5000, effort:'medium' }));
if (!out || !out.definition) throw new Error('分析に失敗しました（資料からルール化できる内容を読み取れませんでした）');
return { name: out.name || '', definition: out.definition, sources: out.sources || '', fileNames: files.map(function(f){ return f.name || ''; }) };
}
/* 選定（意思決定③）の記録: 検証候補・理由・メモ。全コンセプト横断の選定タブから保存される */
/* 3水準の分離構築: 新方向の承認後、標準案（v0）を基点に 下限（vLo）と攻め端（vHi）を後段で設計する。
承認時の単一巨大応答（3設計書一括・十数分）を分割し、標準案を数分で返して残りをバックグラウンド化するための分離。 */
async function buildDirectionExecutions(args){
args = args || {};
var p0 = await _loadProject();
var dir = null; (p0.directions||[]).forEach(function(d){ if(d.id===args.directionId) dir=d; });
if (!dir) throw new Error('方向が見つかりません');
if ((dir.versions||[]).length >= 3) throw new Error('3水準は構築済みです');
var v0 = null; (dir.versions||[]).forEach(function(v){ if(v.id===dir.repVersionId) v0=v; });
if (!v0 || !v0.spec || !v0.spec.design) throw new Error('標準案の設計書がありません');
var sys = [
'あなたはパッケージ設計の実験計画者。与えられた標準執行（v0）の設計書を基点に、同一命題の強度サンプリング2水準を設計する。',
'vLo=装置の下限: 主導装置1つだけを分離測定する最少執行（他変数は王道に固定。命題がその装置単体で立つかの下限計器）。',
'vHi=攻め端: 声量・構図の上限執行（誤読が始まる閾値を実測する計器。何の誤読の計器かを aim に明記）。',
'規則: (a)3案は同一命題・同一ワードマーク。名前を変えない (b)design は5スロット（surface/motif/layout/logo/copy 各{v,en,why}）の完全形 (c)copy は執行ごとに書き分ける（トーン＝読点1つの短い断言は共通） (d)logo.v にはv0と同じ商品名を「」で含める。',
'JSONのみ: {vLo:{label:"執行名", aim:"何を測るか", device:"主導装置", design:{5スロット}}, vHi:{label,aim,device,design}}'
].join('\n');
var usr = JSON.stringify({ direction:{ name: dir.name }, v0: { label:v0.spec.label, bet:v0.spec.bet, proposition:v0.spec.proposition, aim:v0.spec.aim, nameChoice:v0.spec.nameChoice, design:v0.spec.design, coding:v0.spec.coding||null } });
var out = _lenientJSON(await _chat([{role:'system',content:sys},{role:'user',content:usr}], {json:true, maxTokens:9000, effort:'medium'}));
if (!out) throw new Error('水準設計の生成に失敗しました');
var made = [];
await _withLock(async function(p){
var d2 = null; (p.directions||[]).forEach(function(d){ if(d.id===args.directionId) d2=d; });
if (!d2 || (d2.versions||[]).length >= 3) return false;
var v02 = null; (d2.versions||[]).forEach(function(v){ if(v.id===d2.repVersionId) v02=v; });
if (!v02) return false;
var now = Date.now();
var mk = function(ex, fallback, suf){
if (!ex || !ex.design) return null;
var sp = JSON.parse(JSON.stringify(v02.spec));
delete sp.prompts; delete sp.shelfCheck; delete sp._revision;
sp.label = ex.label || fallback;
sp.aim = ex.aim || sp.aim;
if (ex.device) sp.leadDevice = ex.device;
sp.design = ex.design;
sp.measurement = (v02.spec.measurement||'') + ' 同一命題の執行3案（下限/標準/攻め端）を同一調査に入れ、命題をどの装置・声量で言うのが強いかも特定する。';
try { _finishSpec(sp, d2.conceptId, d2.id); } catch(e){ return null; } // 不完全な水準は静かに棄却（標準案は既にある）
_stampShelfCheck(p, sp);
return { id:'v'+now+suf, parentId:null, created:new Date().toISOString(), label:sp.label,
origin:{ inputSummary:'標準案からの水準展開（執行: '+sp.label+'）', interpretation:null, matched:[], verdict:null },
spec:sp, visuals:{ board:{status:'empty'}, package:{status:'empty'}, kv:{status:'empty'} } };
};
var lo = mk(out.vLo, '装置の下限', '-lo');
var hi = mk(out.vHi, '攻め端', '-hi');
var i0 = -1; d2.versions.forEach(function(v,i){ if(v.id===d2.repVersionId) i0=i; });
if (lo){ d2.versions.splice(Math.max(i0,0), 0, lo); made.push('下限'); i0++; }
if (hi){ d2.versions.splice(i0+1, 0, hi); made.push('攻め端'); }
return made.length > 0;
});
if (!made.length) throw new Error('水準の設計が規格を満たしませんでした。もう一度お試しください');
return { project: await _loadProject(), made: made };
}
async function saveSelection(args){
args = args || {};
await _withLock(async function(p){
p.selection = p.selection || {};
if (args.picks !== undefined) p.selection.picks = args.picks;
if (args.note !== undefined) p.selection.note = args.note;
p.selection.updated = new Date().toISOString().slice(0,10);
return true;
});
return true;
}
/* コンセプトシートの未決セルをAIが下書きする。確定済みセル・戦略メタ・帰属知識と矛盾しない
作業仮説として書き、出自「AI下書き（未確認）」を明示。人がセル編集で確定させる前提の足場 */
async function draftConceptSheet(args){
args = args || {};
var p = await _loadProject();
var concept = null; (p.concepts||[]).forEach(function(c){ if(c.id===args.conceptId) concept=c; });
if (!concept || !concept.sheet) throw new Error('コンセプトが見つかりません');
var pending = Object.keys(concept.sheet).filter(function(k){ return concept.sheet[k] && concept.sheet[k].src === '未決'; });
if (!pending.length) throw new Error('未決のセルはありません');
var labels = { context:'時代性/社会性の文脈', insight:'インサイト', brandConcept:'ブランドコンセプト', devConcept:'開発コンセプト（争点）', analogy:'手をつなぐ市場アナロジー', benefitP:'ベネフィット（物性）', benefitE:'ベネフィット（情緒）', fact:'ファクト', pColor:'知覚設計:色', pName:'知覚設計:製品名', pDba:'知覚設計:DBA' };
var sys = [
'あなたはビールブランドの戦略プランナー。コンセプトシートの未決セルを、確定済みセルと戦略文脈から矛盾なく下書きする。',
'規則: (a)確定済みセルの言葉を核に導出し、飛躍しない (b)各セルは1-2文の作業仮説として書く（断定の事実を捏造しない。ファクトは「要確認:」を付けて候補を書く） (c)知覚設計:色/製品名は候補を2-3個併記 (d)対象キー以外は出力しない。',
'JSONのみ: {キー:"下書き文"} 対象キーは入力の pending に列挙。'
].join('\n');
var cur = {}; Object.keys(concept.sheet).forEach(function(k){ cur[k] = { label: labels[k]||k, v: concept.sheet[k].v, src: concept.sheet[k].src }; });
var usr = JSON.stringify({ concept:{name:concept.name, insight:concept.insight, statement:concept.statement}, sheet:cur, pending:pending, strategy_meta:(p.strategy&&p.strategy.meta)||null });
var out = _lenientJSON(await _chat([{role:'system',content:sys},{role:'user',content:usr}], {json:true, maxTokens:4000, effort:'medium'}));
if (!out) throw new Error('下書きの生成に失敗しました');
await _withLock(async function(p2){
var c2 = null; (p2.concepts||[]).forEach(function(c){ if(c.id===args.conceptId) c2=c; });
if (!c2 || !c2.sheet) return false;
pending.forEach(function(k){ if (out[k] && String(out[k]).trim()) c2.sheet[k] = { v: String(out[k]).trim(), src: 'AI下書き（未確認）' }; });
return true;
});
return await _loadProject();
}
async function deleteStyleGuide(args){
args = args || {};
await _withLock(async function(p){ p.styleGuides = (p.styleGuides||[]).filter(function(g){ return g.id !== args.id; }); return true; });
return await _loadProject();
}
/* サムネイル: Drive の getThumbnail の代替として sharp で幅480pxのJPEGを生成し、保存先（thumbs/）とプロセス内キャッシュに置く。
   応答は GAS 版と同じ { name: dataURI } */
var _thumbCache = new Map();
var THUMB_CACHE_MAX = 400;
function _thumbForget(name){ _thumbCache.delete(name); }
function _thumbRemember(name, uri){
if (_thumbCache.size >= THUMB_CACHE_MAX){ var k = _thumbCache.keys().next().value; _thumbCache.delete(k); }
_thumbCache.set(name, uri);
}
async function _thumbOf(name){
var hit = _thumbCache.get(name); if (hit) return hit;
var st = _store();
var tname = 'thumbs/' + name + '.jpg';
var t = null;
try { t = await st.readBytes(tname); } catch(e){ t = null; }
if (!t){
var f = await st.readBytes(name); if (!f) return null;
var buf = null;
if (sharp){ try { buf = await sharp(f.buffer).rotate().resize({ width: 480, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer(); } catch(e){ buf = null; } }
if (buf){ try { await st.writeBytes(tname, buf, 'image/jpeg'); } catch(e){} t = { buffer: buf, mime: 'image/jpeg' }; }
else t = f; // 縮小できない個体はフル画像で代替
}
var uri = 'data:' + (t.mime || 'image/jpeg') + ';base64,' + t.buffer.toString('base64');
if (uri.length < 400000) _thumbRemember(name, uri);
return uri;
}
async function getThumbs(names){
var out = {};
await Promise.all((names || []).map(async function(name){
try { var u = await _thumbOf(name); if (u) out[name] = u; }
catch(e){ console.error('[thumb] ' + name + ': ' + (e && e.message || e)); }
}));
return out;
}
async function getFullImage(name){
var f = await _readFile(name);
if (!f) throw new Error('画像が見つかりません: ' + name);
return 'data:' + (f.mime || 'image/png') + ';base64,' + f.buffer.toString('base64');
}
/* ================= シード v3 ================= */
function _seedProject(){
return _deriveContrast(_applyVariants({
version: 3,
seedRev: SEED_REV,
meta: { name:'RIB', client:'サントリー', category:'ビール（新ブランド）', updated:null },
strategy: {
target: 'もっと楽に飲みたい、すっきり嗜好の一番搾りユーザー。一番搾りが好きな理由は「ガツンとしてないまろやか × 上質さ = 落ち着き」。一方で行動はスッキリも求めている（併飲: ASD 28% / 晴れ風 21%）',
position: 'ビールヒエラルキーのど真ん中。すっきり心地よい味わいでも、ど真ん中をいきなり取れるビールとして認識され、一番搾り主飲者を獲得する',
spec: 'エール×ラガー。深みがあるのに重くない（味・香りの厚み × キレ・すっきり）。お互いをいいとこどりしたコンフォートなバランス',
devConcept: 'ステルス・コンフォート — 頭が求める知覚品質を担保することで、無自覚に心地よさを感じてもらう（隠れた心地よさ）',
thesis: 'RIB開発の肝は、王道感/本格感を担保しながら斬新さも作る「一番搾りとの絶妙な差分」。プロダクト（知覚品質）で斬新さを主張すると奇抜・ニッチに見えるため、知覚品質では王道を担保し、世界観/情緒（コミュニケーション・PKG・ネーミング）で差分を感じさせる役割分担にする。目指す像は「次世代の王道」＝王道感がありつつ、こっちを選んだ方がアップデート感も感じる',
caution: '斬新さ≠奇抜さ。ド真ん中に見えない・限定品に見えるのはNG。斬新さはふんわり醸し出されるくらいがセンスを感じてちょうどいい'
},
concepts: [
{ id:'sumitora', name:'澄虎（SUMITORA）',
insight:'気枯れを祓いたい — 情報過多と気疲れの時代、コントロールできない情報や他人の感情に心身が侵食され、気持ちが沈んでいる',
statement:'澄み切った味わいで、気枯れた心身を浄化する『神聖な一杯』',
nakami:'中味コンセプト「調和」— ラガー×エールの絶妙なブレンド。雑味を排除した奥深さのある究極の「澄」。心を静めスッキリさせる浄化の味わい',
worldview:'「浄化」×「活動的・生命力・気をためる・動的」。ミニマリストの枯れた静けさはNG。ビールの役割は身体的切断ではなく心理的浄化',
naming:'「澄虎」— サントリー資料p.11に明示されたネーミング（参考構造: 清らかさ・上品さ・繊細さ×力強さ・本格感・格調高さ の適用。白虎＝邪気を祓う守護神）。資料の与件であり、このツールでは変更しない（表記・組み・スケールは設計変数）',
namingStatus:'given',
sheet:{
insight:{v:'気枯れを祓いたい',src:'資料'},
brandConcept:{v:'●●（資料上も未決）',src:'未決'},
devConcept:{v:'澄み切った味わいで気枯れた心身を浄化する『神聖な一杯』',src:'資料'},
analogy:{v:'サウナ・登山・ランニング（スピ活）',src:'資料'},
benefitP:{v:'ブレンドにより奥深く澄んだ味わい・角が取れたまるい味わい',src:'資料'},
benefitE:{v:'日々の疲れやストレスを祓い、翌日への活力になる',src:'資料'},
fact:{v:'120年のブレンド技術をビールに応用。季節ごとの温度と湿度に合わせて最も心地よい味わいを実現（7種の麦芽を使用、天然水醸造）',src:'資料'},
pColor:{v:'白×紺×淡青（浄化の白基調・棚の色相空白）',src:'ツール提案'},
pName:{v:'澄虎（SUMITORA）',src:'資料'},
pDba:{v:'方向S-1〜S-4の執行で幅出し中',src:'ツール提案'}
},
sourceNote:'出自: サントリー資料の開発コンセプト①（インサイト「気枯れを祓いたい」）＋ネーミング頁p.11。電通議論資料（MTG#1）は両タブ共通の設計条件——「斬新さ≠奇抜さ（限定品に見えるな）」は台帳の誤読仮説に、「王道感の担保」は目録コードの錨として配線済み',
keyterms:'鍵語の出自 — 「気枯れ」「祓う」はサントリー資料の言葉（インサイト原文「気枯れを祓いたい」、ネーミング根拠「白虎＝古来より邪気を祓い清浄をもたらす守護神」）。それを受けて可能性空間を「祓いの様式」で切るという操作は、資料ではなくこのツール側の設計判断。',
derivationStatus:'方向の範囲＝「祓い・浄化を担ってきた日本の視覚文化」。この範囲から候補を引き、規制と記号監査で削った（棄却も記録として残す）。範囲の見落とし検査は調査依頼書「浄化の意匠体系の棚卸し」で継続——完了までこの一覧を最終とは主張しない。◆出典の鮮度規則: (a)市場の時点データ＝1年以内で再取得（棚の目録は暫定・缶画像投入で確定）／(b)事例＝発生時点の記録＋現況追跡を併記（翠・綾鷹は2026年時点まで追跡済み）／(c)規制＝現行版の改正日で管理（令和8年7月1日改正版で確認済み）。',
derivation:[
{ candidate:'水源・自然の澄み', source:'手水舎の禊——参拝前に水で身を清める、今も全国の神社に現存する清めの儀礼。観世水・青海波・流水文は染織・工芸で連綿と使われてきた水の定型文様（伝統文様として文様辞典に収載）', verdict:'採用 → S-1', reason:'清冽イメージの市場実績。ただし自主基準の清涼飲料誤認防止と晴れ風への批評により、ビール記号の増強を条件とする' },
{ candidate:'神事の白（祓いの原義）', source:'神職の白装束・奉書紙・御幣——神道の清浄を担ってきた白の実在体系。截金は仏画・仏像装飾の実在技法（国宝・重要文化財の仏教美術に現存）', verdict:'採用 → S-2', reason:'初詣・お祓い等の既存リセット行動に乗る。条件: スピリチュアル記号の禁止、和素材の量の上限（プライドポテト2017の実証）' },
{ candidate:'スピリチュアル・ヒーリング表現（光の玉・オーラ・紫グラデ）', source:'画像検索で「浄化」の上位を占める光の玉・オーラ・紫グラデーション（記号監査 2026-07実施: 検索上位の目視監査で確認）', verdict:'棄却', reason:'自主基準（健康効用の想起防止）に抵触し得るうえ、パワーストーン系記号は品位を毀損。記号監査で使用禁止と判定済み' },
{ candidate:'サウナ「ととのう」系のVI', source:'サウナ施設・専門メディアで定着した「ととのう」の視覚語彙（記号監査 2026-07実施で確認）', verdict:'棄却', reason:'サウナブーム関連の識別資産と混線（先客監査で不合格）。その狙い＝動的な祓いは、書・日本画の系譜に付け替えて墨勢として採用' },
{ candidate:'書・日本画の気迫（墨勢）', source:'禅寺の天井に現存する雲龍図（建仁寺・妙心寺等）と書の一閃——気迫を担ってきた水墨の実在系譜。サウナVI棄却後の付け替え先として記号監査を通過', verdict:'採用 → S-3', reason:'雲龍図の系譜＋白虎の意味体系と整合。条件: 日本酒コードとの距離管理' },
{ candidate:'のれんの所作', source:'飲食店の入口に今も現存する染織の生活意匠（藍染・抜染は実在技法）。翠は居酒屋境界の再定義で2021年販売数量が前年比236%（日経クロストレンド2021「計画比3倍売れたサントリー翠」／Web担2023「三位一体戦略」）。現況追跡2026: 一過性でなく定番化——ブランド刷新・缶2種追加で家庭用拡大が継続し、サントリーは2030年ジン市場1.8倍戦略の中核に位置付け（サントリー2025.2ニュースリリース／日経2026.3／激流オンライン2026.3）', verdict:'採用 → S-4', reason:'翠の居酒屋境界再定義236%・Stellaの注ぎ儀式の実証。条件: 限定品誤読の実測（幅の攻め端）' },
{ candidate:'様式なし（名前だけ）', source:'意匠体系ではなく調査設計上の必須条件（統制）。翠は漢字一字の名前と最小限の意匠で缶が2022年目標比158%＝名前が差分を運べる市場実証（日経クロストレンド2021／日経トレンディ2022ヒット商品 酒類部門大賞。現況追跡2026: 定番化・拡張継続＝実証は現在も有効）', verdict:'採用 → S-0 統制', reason:'全案の基準線。様式化の寄与量そのものを測る' },
{ candidate:'湯・湯上がりの様式', source:'銭湯の暖簾・湯気・富士山ペンキ絵として実在する生活意匠', verdict:'棄却', reason:'『酒類の広告・宣伝及び酒類容器の表示に関する自主基準』（酒類業中央団体連絡協議会9団体・令和8年7月1日最終改正、ビール酒造組合公開PDF）II-2-(2)⑤が「入浴時飲酒の推奨誘発」を明示的に禁止（プロジェクト初期に確認済みの制約）。湯上がりの一杯という文脈は推奨誘発と読まれるため、意匠として実在しても採用できない。なお意味空間上は静×日常＝水源と同象限のため、棄却しても解釈空間に空白は生じない' }
],
structure:{
basis:'2軸は各案の賭け（消費者の実在行動）から導出した意味次元。数値ではなく、位置は象限への帰属（根拠は各案に一行で記載。反証歓迎）。統制案は様式ゼロ＝原点。',
x:{neg:'日常の生活', pos:'非日常・儀式', label:'浄化の場 — 生活者はどこで祓われるか'},
y:{neg:'静 — 浸る・鎮まる', pos:'動 — 断つ・切り替える', label:'浄化の様態'},
cells:[
{dirId:'sumi-s1', x:-1, y:-1, why:'賭け＝シャワー・冷たい水という日常の行動に「浸る」浄化'},
{dirId:'sumi-s2', x:1,  y:-1, why:'賭け＝初詣・お祓いという非日常の儀式で「鎮める」'},
{dirId:'sumi-s3', x:1,  y:1,  why:'賭け＝断ち切る気迫。書の一閃という非日常の高揚'},
{dirId:'sumi-s4', x:-1, y:1,  why:'賭け＝帰り道・のれんという日常の所作で「切り替える」'}
],
center:'sumi-s0',
empties:[],
coverage:'4象限すべてに1案＝この2軸が張る解釈空間の範囲では、可能性は洗い出し済み。棄却3候補も配置検査済み: スピリチュアル＝静×非日常（神事と同象限）、サウナ＝動×日常（のれんと同象限）、湯＝静×日常（水源と同象限）——いずれも生存案のいる象限に属し、棄却による空白は生じていない。軸自体の偏り・第5の意匠体系の見落としは依頼書「浄化の意匠体系の棚卸し」で検査'
},
openQuestion:'「神聖な一杯」はコピーとしては一つでも、缶の上では答えが割れる——澄みとは水源の風景なのか、白い儀式なのか、一閃の気迫なのか、のれんをくぐる所作なのか。どの解釈が最も強く届くかは、言葉では決められない。見て、測るまで分からない。',
framing:'「祓い」はそれ自体では様式を持たない概念のため、可能性空間を「祓いの様式＝どの文化系から清めの表現を取るか」で切る。自然（水源の澄み）／神事（白の儀式）／気迫（一閃の墨）／日常の所作（のれんをくぐる）の4様式に、様式を使わない統制案（現代の定番の文法だけで語る）を基準線として加えた5案。各様式は異なる文化系から取っているため解釈が相互排他で、統制案との比較により「祓いを様式化すること自体の効果」も測れる。',
rtb:'120年のブレンド技術。7種の麦芽の黄金比、清らかな天然水、非熱処理・生ビール' },
{ id:'kegare-alt', name:'② 気枯れ・別解',
insight:'気枯れを祓いたい',
statement:'澄み切った味わいで、気枯れた心身を浄化する『神聖な一杯』（開発コンセプトは①と共通。商品名・知覚設計を別解として幅出しする）',
naming:'商品名は本タブのアウトプット。ネーミングは生成ロジック（型）のレベルでまず幅を張る——資料p.10-11の構造はページ名の通り「※参考にする」構造＝有力な型の一つであって全体ではない。型の一覧（一次・ツール提案。網羅は主張しない）: 型A＝資料の参考構造〔清らかさ系の一字×力強い生き物の一字。綾鷹（綾×鷹）→澄虎（澄×虎）と同型の別実装。仮案「澄雷」は雷が生き物でなく緩和形〕／型B＝行為・儀式の名詞化〔祓・禊の系。「ミソギ」はこの型では有効候補として保留——神事語彙の記号監査要〕／型C＝表記の転換〔ローマ字・カタカナ化。KIYOTORA等はユーザー指示由来でここ〕／型D＝浄化の情景・自然物の一語〔水源の系〕。候補は型ごとの生成→監査（規制語・商標・先客・音）を経て確定。方向を起こす際は型と仮案を指示する',
namingStatus:'working',
sourceNote:'出自: サントリー資料の開発コンセプト①のうち、ネーミング「澄虎」に依存しない可能性の探索枠',
sheet:{
insight:{v:'気枯れを祓いたい',src:'資料'},
brandConcept:{v:'●●（未決）',src:'未決'},
devConcept:{v:'澄み切った味わいで気枯れた心身を浄化する『神聖な一杯』',src:'資料'},
analogy:{v:'サウナ・登山・ランニング（スピ活）',src:'資料'},
benefitP:{v:'ブレンドにより奥深く澄んだ味わい・角が取れたまるい味わい',src:'資料'},
benefitE:{v:'日々の疲れやストレスを祓い、翌日への活力になる',src:'資料'},
fact:{v:'120年のブレンド技術をビールに応用（7種の麦芽、天然水醸造）',src:'資料'},
pColor:{v:'未決（ネーミング決定に従属）',src:'未決'},
pName:{v:'未決。型A〜D（資料構造／行為名詞化／表記転換／情景一語）の生成ロジックで幅出し。既存仮案（澄雷=型A緩和形／ミソギ=型B／KIYOTORA=型C）はすべて監査未実施の保留',src:'ツール提案'},
pDba:{v:'未決',src:'未決'}
},
openQuestion:'「神聖な一杯」を澄虎以外の名前で言うなら何か。名前が変われば色・意匠の最適も変わる——その連鎖ごと幅出しする。',
keyterms:'開発コンセプト＝資料の与件。商品名・知覚設計＝本タブのアウトプット。',
derivation:[
{ candidate:'型A 資料構造の別実装（澄雷）', source:'資料p.10-11の参考ネーミング構造（綾鷹→澄虎の型）。澄雷＝ツール提案の緩和形仮案', verdict:'採用 → A-1', reason:'型の別実装で名前→意匠の連鎖を検証。監査（商標・先客・音）は未実施の保留' },
{ candidate:'型B 行為の名詞化（ミソギ）', source:'ツール提案の型。禊＝神社の水による清めとして現存する実在儀礼', verdict:'採用 → A-2', reason:'行為語の想起力を検証。神事語彙の記号監査＋商標監査が未実施の保留' },
{ candidate:'型C 表記の転換（KIYOTORA）', source:'ユーザー指示由来。翠のSUI併記＝表記国際化の先行文法', verdict:'採用 → A-3', reason:'表記系単体の寄与を分離測定。読み変更の音・商標監査は未実施' },
{ candidate:'型D 情景一語（水源の系）', source:'ツール提案の型', verdict:'保留', reason:'①S-1（水源の澄）と意味空間が重複——差分が立つ候補が生成できるまで方向化しない' }
],
derivationStatus:'方向の範囲＝「ネーミングの生成ロジック（型）×知覚設計の連鎖」。型一覧は一次のツール提案で、見落とし検査は依頼書「浄化系ネーミングの型と先客の棚卸し」で継続——完了まで最終とは主張しない。全候補が監査未実施の仮案であることを各行に明記。◆出典の鮮度規則は①と共通（時点データ1年以内／事例は現況追跡併記／規制は現行版）。',
structure:{
basis:'2軸は名前の働き方から導出した意味次元（意匠体系の軸は①と共有＝各方向の意匠は①の棚卸し5体系から名前に従属して選択）。位置は象限への帰属で、根拠は各案に一行。統制＝与件名「澄虎」そのもの（①S-0が実装）を原点に置く。',
x:{neg:'状態を名指す（澄・清）', pos:'行為を名指す（禊ぐ・祓う）', label:'名前の意味の在処'},
y:{neg:'漢字の格（伝統）', pos:'音の表記（カナ・ローマ字＝現代化）', label:'表記の系'},
cells:[
{dirId:'kalt-a', x:-1, y:-1, why:'澄雷＝状態（澄）×漢字。与件と同じ象限で名前だけ替える最小変位'},
{dirId:'kalt-b', x:1,  y:1,  why:'ミソギ＝行為×音（カナ現代化）。与件から最遠の対角'},
{dirId:'kalt-c', x:-1, y:1,  why:'KIYOTORA＝状態×音。意味を固定し表記だけ動かす分離測定'}
],
center:'sumi-s0',
empties:[{x:1, y:-1, note:'空白象限: 行為×漢字（例: 一字「祓」）。宗教語の直接使用の記号監査と商標の壁が最も高い領域——依頼書の棚卸し結果を待って充填可否を判定'}],
coverage:'4象限中3象限に1案＋空白1（理由つき）。統制（澄虎＝①S-0）は原点として全案の基準線を共有。軸の妥当性と型の見落としは依頼書で検査継続'
},
        framing:'①と同じ意味空間を、別の名前と知覚設計で再充填する枠。型A/B/Cの3方向を初期案として展開済み（各方向＝1つの型の1実装。名前は全て仮案）。型Dは①との重複により保留。' },
      { id:'blended', name:'季節ベストバランス（ブレンデッド）',
        insight:'飲みたいビールの味は季節で変わるのに、定番品はいつも同じ味。季節の気持ちは限定品任せ。理由のある「間違いなさ」は個性的な新商品が増え続ける市場で強い',
        statement:'匠の技で、1年中最適な味わいを約束するブレンデッドビール',
        nakami:'季節の温度と湿度に合わせてラガー×エールのブレンド比を調整し、最も心地よい味わいを実現。角がとれたスムーズな味わい',
        worldview:'職人・匠の世界。茶匠のブレンド、コーヒーの季節ブレンド、グランメゾンの温湿度調整と同じ「プロの調整」の文脈。権威による安心感',
        naming:'商品名は資料で未決（「ブレンデッドビール」はカテゴリ記述）。名前の考案はすべて本ツール（LLM）。◆生成器v2: 源泉プールは【ビール固有語彙に純化】——L1製法（搾り・直汲み・醸造・貯蔵・熟成・麦芽・ホップ・泡）※「仕込み」「合わせ」等の発酵食品一般語（味噌・出汁の語彙）は汚染源として隔離／L2飲用感覚（のどごし・キレ・コク・澄み・冷え・一杯）／L3飲む時間・場面／L4コンセプト由来の気象・自然語／L5自社資産（ブレンダー文化・水）／L6外来語族（モルツ・ドラフトの棚実在文法）※必ずサンプルする（ゼロの型族＝掃き残しとして警告）。関門: ①衝突即殺 ②喉テスト（「◯◯ください」） ③缶の顔 ④事実整合（中味・色と矛盾する名前は嘘）。殺しも理由つき記録。◆候補の場（生存者・型族分布: 二字1/外来語1/かな2/所作1）: 「ブレンダーズ」〔B-2採用・L5×L6。配合を決める職人＝ブレンダーそのもので、手書きの配合記録の意匠と同じ主語。RTB「120年のブレンド技術」に直結する自社資産。喉テスト「ブレンダーズください」＝洋酒の実在感。検査: 他社バー業態等の先客識別＋ウイスキー誤読〕／「常盤」〔B-1採用・暖簾の不変。検査: 他業種先客〕／「シラベ」〔B-3採用・調律の語。検査: かな表記〕／「アワセ」〔B-0・B-S採用・資料原文の動詞の名詞化。検査: RTD文法〕／「手詰め」〔手作業の直訳・クラフト実在語。検査: 大量生産実態との④整合〕。◆殺しの記録: 合わせ仕込み（「仕込み」＝発酵食品一般語で調味料想起＝プール汚染。v2で棄却）／調合（薬剤）／配合（飼料連想）／FORMULA（F1連想）／季節仕込み・トキワ表記（既存）。全生存者監査未実施。②③と一括監査',
        namingStatus:'working',
        sheet:{
          insight:{v:'季節ごとに最適な気持ちにビールが合わせてほしい',src:'資料'},
          brandConcept:{v:'●●（資料上も未決）',src:'未決'},
          devConcept:{v:'匠の技で1年中最適な味わいを約束するブレンデッドビール',src:'資料'},
          analogy:{v:'茶匠・コーヒーの季節ブレンド（プロの調整）',src:'資料'},
          benefitP:{v:'2つのビールが混ざった角がとれたスムーズな味わいだからどんなシーンにもフィットする',src:'資料'},
          benefitE:{v:'落ち着きつつ、程よくリフレッシュできる',src:'資料'},
          fact:{v:'120年のブレンド技術をビールに応用。季節ごとの温度と湿度に合わせて最も心地よい味わいを実現',src:'資料'},
          pColor:{v:'紺×金／紙の生成り（格と手仕事の系）',src:'ツール提案'},
          pName:{v:'未決。方向別採用: 常盤（B-1老舗）／ブレンダーズ（B-2職人・自社資産×外来語族）／シラベ（B-3精密）／アワセ（B-0・B-S）。全て監査未実施',src:'ツール提案'},
          pDba:{v:'方向B-1〜B-3の執行で幅出し中',src:'ツール提案'}
        },
        sourceNote:'出自: サントリー資料の開発コンセプト②（インサイト「季節ごとに最適な気持ちにビールが合わせてほしい」）。ネーミング頁は存在しない（澄虎のp.11に相当する頁なし＝画像で確認済み）',
        rtb:'120年のブレンド技術（ウイスキーの権威）の応用。7種の麦芽、天然水醸造',
        keyterms:'鍵語の出自 — 「調律」「匠」「季節ベストバランス」はサントリー資料の言葉。権威の源泉で空間を切る操作はこのツール側の設計判断。',
        derivationStatus:'方向の範囲＝「調律・匠の信用を担ってきた意匠」（暖簾と家紋／工房の紙と活版／製図）。範囲の見落とし検査は依頼書で継続。◆出典の鮮度規則: (a)時点データ＝1年以内で再取得／(b)事例＝発生記録＋現況追跡（綾鷹は2025年過去最高更新まで追跡済み）／(c)規制＝現行版の改正日で管理。',
        derivation:[
          { candidate:'老舗の暖簾・格', source:'暖簾・家紋・漆器——老舗の格を担ってきた実在の意匠。綾鷹は上林春松本店（宇治・創業450年）の権威借用でシェア2%→20%（ダイヤモンド・オンライン2023）。現況追跡: 2024年の7年ぶり刷新が奏功し過去最高販売数量、2025年も過去最高を更新（食品新聞2025.11／コカ・コーラ2026.3リリース）＝権威借用の資産は現役', verdict:'採用 → B-1', reason:'プレモル・ヱビスの格文法の市場実績＋綾鷹2%→20%。条件: 緑茶可読の実測' },
          { candidate:'職人の手仕事', source:'工房の記録紙・活版印刷・検印——手仕事の信頼を担う実在の意匠。茶匠・コーヒーの季節ブレンドが「プロの調整」の文脈を既に教育済み（サントリー戦略資料）', verdict:'採用 → B-2', reason:'隣接文脈が信頼の型を教育済み。条件: クラフト誤読の実測（計器）' },
          { candidate:'精密設計・データ', source:'製図・エンジニアリングドローイングの実在様式（図面・寸法線・グリッド）。中味の事実（120年のブレンド技術）の直接図像化', verdict:'採用 → B-3', reason:'読み自体が検証対象と明示の上で採用（若年層の信頼移行仮説）' },
          { candidate:'季節の調律を計器・数値で言う（絵柄なし）', source:'開発コンセプト「季節ごとの温度と湿度に合わせて最も心地よい味わい」（サントリー資料）＝コンセプトの中核。計器化＝ツール提案', verdict:'採用 → B-S 主方向', reason:'季節絵柄は限定品コード（電通資料「限定品に見えるな」・B-4凍結の理由）。通年同一の計器＋配合数値なら定番の顔のまま中核差分を言える' },
          { candidate:'季節で意匠が回る缶（絵柄・色替え）', source:'中味の事実（季節でブレンド比が変わる）の直接表現', verdict:'凍結 → B-4', reason:'限定品コードとの識別条件が監査未了。調査依頼書を発行済み、結果が入るまで設計しない' }
        ],
        structure:{
          basis:'2軸は各案の賭け（信用の根拠の読み）から導出した意味次元。位置は象限への帰属。統制案は様式ゼロ＝原点。',
          x:{neg:'人の手', pos:'家・仕組み', label:'担保の主体 — 誰が最適を保証するか'},
          y:{neg:'積み上げた過去', pos:'現在の調整', label:'担保の時制'},
          cells:[
            {dirId:'blend-b1', x:1,  y:-1, why:'賭け＝暖簾と歴史。家という制度の蓄積が保証する'},
            {dirId:'blend-b2', x:-1, y:1,  why:'賭け＝いまの職人の手が今季の配合を保証する'},
            {dirId:'blend-b3', x:1,  y:1,  why:'賭け＝いまの精密な設計・データが保証する'}
          ],
          center:'blend-b0',
          empties:[{x:-1, y:-1, note:'空白象限: 人×過去＝先代からの口伝・秘伝。範囲の棚卸し調査の結果次第で第4の候補として検討'}],
          coverage:'4象限中3つに案あり・1つは意図的な空白として明示（B-4「季節」は時間の別次元のため凍結中の別軸）'
        },
        openQuestion:'「匠の調律」の説得力がどこから来るか——老舗の暖簾なのか、職人の手なのか、精密な設計なのか——は言葉では決められない。見て、測るまで分からない。',
        framing:'主方向＝B-S 季節の調律（コンセプトの中核「季節ベストバランス」の直接実装。季節を絵柄でなく通年不変の計器＋配合数値で言い、限定品誤読を構造的に回避）。老舗／職人／精密の3方向は「調律の信用の裏書き＝権威の源泉」の従属幅として維持（相互排他）。統制B-0が基準線。B-4（季節の絵柄系）は限定品コードとの識別監査が未了のため凍結を継続——B-Sはその凍結理由（絵柄）を設計から排除した別解。' },
      { id:'den-misty', name:'③A Misty LAGER',
        insight:'頑張りの締めくくりに、派手なご褒美より「整った自分」を持ち帰りたい',
        statement:'柔らかいけどしっかりと整う世界観/情緒性をまとうLAGER',
        naming:'商品名は本タブのアウトプット。◆生成器v2: 源泉プールは【ビール固有語彙に純化】——L1製法（搾り・直汲み・醸造・貯蔵・熟成・麦芽・ホップ・泡）※「仕込み」「合わせ」等の発酵食品一般語（味噌・出汁の語彙）は汚染源として隔離／L2飲用感覚（のどごし・キレ・コク・澄み・冷え・一杯）／L3飲む時間・場面／L4コンセプト由来の気象・自然語／L5自社資産（ブレンダー文化・水）／L6外来語族（モルツ・ドラフトの棚実在文法）※必ずサンプルする（ゼロの型族＝掃き残しとして警告）。関門: ①衝突即殺 ②喉テスト（「◯◯ください」） ③缶の顔 ④事実整合（中味・色と矛盾する名前は嘘）。殺しも理由つき記録。◆候補の場（生存者・型族分布: 気象3/一字1/L2複合1/外来語1/所作1）: 「朝霧」〔M-1採用・靄と晴れていく途中の直訳。検査: 日本酒先客〕／「凪」〔M-2採用・波立ちが収まって整う＝「整う」のど真ん中の気象語で、等間隔ラインの静けさと同義。喉テスト「なぎください」成立。検査: 飲食店名の先客密度〕／「朝露」〔M-3採用・結露の直訳。検査: 白露等の酒先客＋朝霧との同タブ識別〕／「絹泡」〔L2泡×柔らかさの定番比喩。検査: 読み教育〕／「MELLOW」〔L6・まろやかの実在評価語。検査: 輸入誤読〕／「露払い」〔一筋拭く行為の直訳。検査: 相撲連想〕／「ひと呼吸」〔検査: RTD文法〕。◆殺しの記録: 朝仕込み（「仕込み」＝発酵食品一般語で調味料想起＝プール汚染。v2で棄却）／HAZE（Hazy IPAの業界語＝①）／薄明（注文不成立）／均整・晴れ間・雫・淡霧・律（既存記録維持）。全生存者監査未実施', namingStatus:'working',
        sourceNote:'出自: 電通議論資料（MTG#1）の世界観/情緒性コンセプトA。CONCEPTに紐づく物性まで定義済み',
        sheet:{
          context:{v:'成功報酬→癒しの報酬→整う報酬（資料原文）',src:'資料'},
          insight:{v:'頑張りの締めくくりに、派手なご褒美より「整った自分」を持ち帰りたい',src:'ツール提案（文脈からの翻訳）'},
          brandConcept:{v:'柔らかいけどしっかりと整う世界観/情緒性',src:'資料'},
          devConcept:{v:'（提案・決裁待ち）柔らかい飲み口の奥で、今日の自分をしっかり整えるブレンドの一杯——資料の物性（深みがありつつ飲み口軽快）と世界観（整う報酬）の接続',src:'ツール提案'},
          analogy:{v:'未決',src:'未決'},
          benefitP:{v:'味わいとしては深みがありのどごしの満足感もありながら、飲み口は軽快',src:'資料'},
          benefitE:{v:'しっかりと整う',src:'資料'},
          fact:{v:'（サントリー資料のブレンド技術ファクトを流用可能）',src:'ツール提案'},
          pColor:{v:'未決',src:'未決'}, pName:{v:'未決。方向別採用: 朝霧（M-1靄）／凪（M-2整い・気象語）／朝露（M-3結露）。全て監査未実施',src:'ツール提案'}, pDba:{v:'未決',src:'未決'}
        },
        openQuestion:'「整う報酬」の世界観を、サウナ既存語彙（棄却済み）と混同されずに缶で言えるか。',
        keyterms:'世界観・物性＝電通資料の言葉。開発コンセプト化・商品名・知覚設計＝本タブのアウトプット。',
        derivation:[
          { candidate:'靄の階調（Mistyの直訳）', source:'電通資料の世界観語「Misty」＋灰青グラデ＝ツール提案の翻訳', verdict:'採用 → M-1', reason:'色単体の分離測定。青過多＝清涼飲料誤読は台帳で検査' },
          { candidate:'整いの秩序（等間隔ライン）', source:'世界観「しっかり整う」＝資料／等間隔の秩序＝ツール提案', verdict:'採用 → M-2', reason:'サウナ語彙（①で棄却済み）に触れない「整う」の言い方' },
          { candidate:'波紋モチーフ', source:'「整う」の視覚語彙として自然な候補', verdict:'棄却', reason:'綾鷹が2024年の全面刷新で「波打つ心が整う波紋モチーフ」を採用済み（コカ・コーラ2024.3リリース）＝緑茶の顔になっており先客衝突' },
          { candidate:'サウナ・ととのう語彙', source:'現行の「整う」ブーム語彙', verdict:'棄却', reason:'①タブの記号監査で棄却済み（自主基準: 入浴時飲酒の推奨誘発リスク＋既存VIの先客）' }
        ],
        derivationStatus:'方向の範囲＝「柔らかさ×整いを担える視覚語彙」。棄却2件（波紋・サウナ）は先客と規制による。開発コンセプト化はシートの未決セルで進める。',
        structure:{
          basis:'2軸は各方向の賭けから導出。X=表現の抽象度（世界観を何で言うか）、Y=「整う」の時点。統制M-0（王道＋作業ラベルのみ）が原点。',
          x:{neg:'抽象（色・線）', pos:'具象（物・情景）', label:'表現の抽象度'},
          y:{neg:'途中（ほどけていく柔らかさ）', pos:'完了（定まった秩序）', label:'「整う」の時点'},
          cells:[
            {dirId:'my-1', x:-1, y:-1, why:'靄の階調＝抽象の色で、晴れていく途中を漂う'},
            {dirId:'my-2', x:-1, y:1,  why:'等間隔ライン＝抽象の線で、定まった秩序（完了）を言う'},
            {dirId:'my-3', x:1,  y:-1, why:'結露の窓＝具象の物で、一筋だけ晴れた途中を言う'}
          ],
          center:'my-0',
          empties:[{x:1, y:1, note:'空白象限: 具象×完了（例: 畳まれた白いシャツ・整えられた棚の静物）。生活の完了情景系は候補未生成——依頼書「世界観4系の視覚語彙棚卸し」の結果で充填可否を判定'}],
          coverage:'4象限中3象限に1案＋空白1（理由つき）。統制M-0が原点。棄却2件の配置検査: 波紋＝抽象×完了（M-2と同象限・先客で棄却）、サウナ語彙＝具象×途中（M-3と同象限・規制で棄却）——棄却による空白は生じていない。'
        },
        framing:'電通資料コンセプトAの展開枠。M-1（色）/M-2（構図）/M-3（素材・物語）＋統制M-0の4方向を初期案として展開済み。' },
      { id:'den-quiet', name:'③B QUIET LAGER',
        insight:'強がりの一杯はもういい。余裕と人間味のある自分でいられる一杯がほしい',
        statement:'本当の豊かさを内に備えた世界観/情緒性をまとうLAGER',
        naming:'商品名は本タブのアウトプット。◆生成器v2: 源泉プールは【ビール固有語彙に純化】——L1製法（搾り・直汲み・醸造・貯蔵・熟成・麦芽・ホップ・泡）※「仕込み」「合わせ」等の発酵食品一般語（味噌・出汁の語彙）は汚染源として隔離／L2飲用感覚（のどごし・キレ・コク・澄み・冷え・一杯）／L3飲む時間・場面／L4コンセプト由来の気象・自然語／L5自社資産（ブレンダー文化・水）／L6外来語族（モルツ・ドラフトの棚実在文法）※必ずサンプルする（ゼロの型族＝掃き残しとして警告）。関門: ①衝突即殺 ②喉テスト（「◯◯ください」） ③缶の顔 ④事実整合（中味・色と矛盾する名前は嘘）。殺しも理由つき記録。◆候補の場（生存者・型族分布: 一字1/L2複合2/原料複合1/かな1/外来語1/所作1）: 「懐」〔Q-1採用・内に持つ豊かさの直訳。検査: 二読〕／「奥行」〔Q-2採用・味評価の実在語彙×余白の空間語。賭け: 名詞単独の据わり〕／「シジマ」〔Q-3採用・森のしじまの慣用。検査: RTD文法〕／「深麦」〔原料族＝金麦の文法×深さ。喉テスト成立。検査: 造語の読み〕／「RESERVE」〔L6×L5・内に蓄えるの直訳で自社ウイスキー文化語。検査: 自社内資産の転用可否＋ウイスキー誤読〕／「深呼吸」〔検査: 健康連想〕。◆殺しの記録: 蔵出し（命題逆行）／静寂（注文不成立）／STOCK（在庫連想）／DEEP（形容単体で約束なし）／静・奥（単一金型反復）。全生存者監査未実施', namingStatus:'working',
        sourceNote:'出自: 電通議論資料（MTG#1）の世界観/情緒性コンセプトB',
        sheet:{
          context:{v:'強さ→余裕→人間味（資料原文）',src:'資料'},
          insight:{v:'強がりの一杯はもういい。余裕と人間味のある自分でいられる一杯がほしい',src:'ツール提案（文脈からの翻訳）'},
          brandConcept:{v:'本当の豊かさを内に備えた世界観/情緒性',src:'資料'},
          devConcept:{v:'（提案・決裁待ち）キレの奥に豊かな香りをたたえた、静かな余裕の一杯——資料の物性（キレ×多面的な深み）と世界観（余裕・人間味）の接続',src:'ツール提案'}, analogy:{v:'未決',src:'未決'},
          benefitP:{v:'すっきりとしたキレと奥に感じる豊かな香りと力強さの深み（多面的な味わい）がある',src:'資料'},
          benefitE:{v:'内に備えた豊かさ・余裕',src:'資料'},
          fact:{v:'（ブレンド技術ファクトを流用可能）',src:'ツール提案'},
          pColor:{v:'未決',src:'未決'}, pName:{v:'未決。方向別採用: 懐（Q-1内包）／奥行（Q-2余白・味語彙）／シジマ（Q-3森閑）。監査未実施',src:'ツール提案'}, pDba:{v:'未決',src:'未決'}
        },
        openQuestion:'「静かな豊かさ」をプレミアム既存文法（モルツ系）と混同されずに言えるか。',
        keyterms:'世界観・物性＝電通資料の言葉。以降は本タブのアウトプット。',
        derivation:[
          { candidate:'内包の金（外マット・内金）', source:'世界観「豊かさを内に」＝資料／内外反転＝ツール提案', verdict:'採用 → Q-1', reason:'プレモル系「外面金」文法との構造的差別化' },
          { candidate:'低重心の余白', source:'「余裕」＝資料の時代文脈／低重心構図＝ツール提案', verdict:'採用 → Q-2', reason:'余裕を構図で直訳。安価誤読は台帳で検査' },
          { candidate:'外面金の増量（プレミアム王道）', source:'高級ビールの既存文法', verdict:'棄却', reason:'「外に見せる豊かさ」＝世界観の反対語。プレモル・ヱビスの先客文法そのもの' }
        ],
        derivationStatus:'方向の範囲＝「内向きの豊かさを担える意匠」。外面金は世界観との矛盾で棄却。',
        structure:{
          basis:'2軸は各方向の賭けから導出。X=豊かさの置き場、Y=静けさの装置。統制Q-0が原点。',
          x:{neg:'内に隠す', pos:'面に出す（小声で）', label:'豊かさの置き場'},
          y:{neg:'マテリアル（色・質感）', pos:'スペース（構図・余白）', label:'静けさの装置'},
          cells:[
            {dirId:'qt-1', x:-1, y:-1, why:'内包の金＝隠す×質感（外はマット・内だけ金）'},
            {dirId:'qt-3', x:1,  y:-1, why:'森閑の緑鼠＝面に小声で出す×色'},
            {dirId:'qt-2', x:-1, y:1,  why:'低重心＝要素を下へ沈める（隠す寄り）×余白'}
          ],
          center:'qt-0',
          empties:[{x:1, y:1, note:'空白象限: 面に出す×余白（例: 大胆な余白に一語だけ大きく置く「静かな主張」）。候補未生成——依頼書の棚卸しで充填可否を判定'}],
          coverage:'3象限＋空白1＋原点。棄却の配置検査: 外面金の増量＝出す×質感（qt-3と同象限・世界観矛盾で棄却）——空白は生じていない。'
        },
        framing:'電通資料コンセプトBの展開枠。Q-1（素材）/Q-2（構図）/Q-3（色相比較）＋統制Q-0の4方向を初期案として展開済み。' },
      { id:'den-node', name:'③C NODE LAGER',
        insight:'なんとなく飲む一杯ではなく、自分のちょうどいいモードに切り替わる「意味のある一杯」がほしい',
        statement:'濃い薄いではなく、自分ちょうどよいモードにチューニングされていく結節点のような世界観/情緒性をまとうLAGER',
        naming:'商品名は本タブのアウトプット。◆生成器v2: 源泉プールは【ビール固有語彙に純化】——L1製法（搾り・直汲み・醸造・貯蔵・熟成・麦芽・ホップ・泡）※「仕込み」「合わせ」等の発酵食品一般語（味噌・出汁の語彙）は汚染源として隔離／L2飲用感覚（のどごし・キレ・コク・澄み・冷え・一杯）／L3飲む時間・場面／L4コンセプト由来の気象・自然語／L5自社資産（ブレンダー文化・水）／L6外来語族（モルツ・ドラフトの棚実在文法）※必ずサンプルする（ゼロの型族＝掃き残しとして警告）。関門: ①衝突即殺 ②喉テスト（「◯◯ください」） ③缶の顔 ④事実整合（中味・色と矛盾する名前は嘘）。殺しも理由つき記録。◆候補の場（生存者・型族分布: 製法1/かな2）: 「中汲み」〔N-1採用・中間の一番よいところを汲む。「汲み」はビール直汲みにも実在＝ビール圏内。検査: 中味の製法実態との整合〕／「アワイ」〔N-2採用。検査: アワセ音近接〕／「ムスビ」〔N-3採用・図像連動。検査: 多義〕。◆殺しの記録: 外来語族は全滅を記録——TUNE（車連想）／MODE（一般名詞すぎ識別ゼロ）／MIDDLE（同）／HALF&HALF（半々と同根＝62:38の事実と矛盾）。中庸（説教）／半々（④事実矛盾）／回路図系・律（既存）。※外来語族ゼロは掃き残しでなく全滅の記録である点を明記。全生存者監査未実施', namingStatus:'working',
        sourceNote:'出自: 電通議論資料（MTG#1）の世界観/情緒性コンセプトC',
        sheet:{
          context:{v:'量→質→意味（資料原文）',src:'資料'},
          insight:{v:'なんとなく飲む一杯ではなく、自分のちょうどいいモードに切り替わる「意味のある一杯」がほしい',src:'ツール提案（文脈からの翻訳）'},
          brandConcept:{v:'ちょうどよいモードにチューニングされていく結節点のような世界観/情緒性',src:'資料'},
          devConcept:{v:'（提案・決裁待ち）濃さではなく、自分のちょうどよいモードへ切り替えるブレンドの一杯——資料原文「濃い薄いではなく」の開発コンセプト化',src:'ツール提案'}, analogy:{v:'未決',src:'未決'},
          benefitP:{v:'のどごしの力強さと軽やかなコクの柔らかさに広がる',src:'資料'},
          benefitE:{v:'何気なくても意味のある自分時間へのモード調整',src:'資料'},
          fact:{v:'（ブレンド技術＝チューニングの実装として強適合）',src:'ツール提案'},
          pColor:{v:'未決',src:'未決'}, pName:{v:'未決。方向別採用: 中汲み（N-1計器・製法型）／アワイ（N-2中点）／ムスビ（N-3結び）。監査未実施',src:'ツール提案'}, pDba:{v:'未決',src:'未決'}
        },
        openQuestion:'「チューニング」はブレンデッド（既存タブ）の調律と概念が近接——別コンセプトとして立つ差分は何か。',
        keyterms:'世界観・物性＝電通資料の言葉。以降は本タブのアウトプット。',
        derivation:[
          { candidate:'モードの計器（薄⇄濃の目盛）', source:'コンセプト文「ちょうどよいモードにチューニング」＝資料／計器化＝ツール提案', verdict:'採用 → N-1', reason:'主観の座標化。B-3（製法図面）との差分＝飲み手の計器/作り手の説明を導出表で管理' },
          { candidate:'グラデの中点', source:'「濃い薄いではなく」＝資料原文／中点線＝ツール提案', verdict:'採用 → N-2', reason:'同一命題の別装置（色）——①で確立した執行比較の文法' },
          { candidate:'接続・ネットワーク図（NODEの直訳）', source:'コンセプトワードの字義', verdict:'棄却', reason:'回路図・ハブの図像はガジェット/テック帰属が強く、ビール可読の錨（目録コード）と両立しない' }
        ],
        derivationStatus:'方向の範囲＝「結節点・ちょうどよさを担える意匠」。字義直訳（回路図）は誤帰属で棄却。ブレンデッドタブの調律（B-S）との概念近接は比較設計の対象として明記。',
        structure:{
          basis:'2軸は各方向の賭けから導出。X=ちょうどよさの語り口、Y=表現の要素。統制N-0が原点。ブレンデッドB-S（調律）との概念近接は導出表で管理。',
          x:{neg:'理性（座標・数値）', pos:'情緒（意匠・物語）', label:'語り口'},
          y:{neg:'図像（もの）', pos:'場（色・面）', label:'表現の要素'},
          cells:[
            {dirId:'nd-1', x:-1, y:-1, why:'モードの計器＝理性×図像（目盛という物）'},
            {dirId:'nd-2', x:-1, y:1,  why:'あいだの中点＝理性×場（グラデの座標）'},
            {dirId:'nd-3', x:1,  y:-1, why:'水引の結び＝情緒×図像（結びという物）'}
          ],
          center:'nd-0',
          empties:[{x:1, y:1, note:'空白象限: 情緒×場（例: 夕暮れと夜のあいだの空の色＝時間の中間を色で）。候補未生成——依頼書の棚卸しで充填可否を判定'}],
          coverage:'3象限＋空白1＋原点。棄却の配置検査: 回路図＝理性×図像（nd-1と同象限・誤帰属で棄却）——空白は生じていない。'
        },
        framing:'電通資料コンセプトCの展開枠。N-1（計器）/N-2（色）/N-3（和意匠）＋統制N-0の4方向を初期案として展開済み。' },
      { id:'den-city', name:'③D City LAGER',
        insight:'べったりしない、ちょうどいい距離の人付き合いに寄り添う一杯がほしい',
        statement:'かっこいいけどどこか冷たさもある都会的な世界観/情緒性をまとうLAGER',
        naming:'商品名は本タブのアウトプット。◆生成器v2: 源泉プールは【ビール固有語彙に純化】——L1製法（搾り・直汲み・醸造・貯蔵・熟成・麦芽・ホップ・泡）※「仕込み」「合わせ」等の発酵食品一般語（味噌・出汁の語彙）は汚染源として隔離／L2飲用感覚（のどごし・キレ・コク・澄み・冷え・一杯）／L3飲む時間・場面／L4コンセプト由来の気象・自然語／L5自社資産（ブレンダー文化・水）／L6外来語族（モルツ・ドラフトの棚実在文法）※必ずサンプルする（ゼロの型族＝掃き残しとして警告）。関門: ①衝突即殺 ②喉テスト（「◯◯ください」） ③缶の顔 ④事実整合（中味・色と矛盾する名前は嘘）。殺しも理由つき記録。◆候補の場（生存者・型族分布: 時間1/色1/外来語1）: 「宵」〔C-1・C-2採用・夜の入りの実在時間語。C-2はタイポ主役で可読負担最大のため共有（設計判断）。検査: 酔い同音〕／「琥珀」〔C-3採用・ビールの色の正式語彙＝名前と絵の完全一致。検査: 琥珀ヱビス等の先客識別〕／「CHROME」〔L6・ガンメタルの素材直訳。検査: 工業連想〕。◆殺しの記録: NOIR（黒の語×中味は淡色ラガー＝④色の嘘。バー実在感はあったが事実整合で死）／行間（内輪言葉）／9PM・終電（注文不成立/ネガ）／LINE・GRID（アプリ/内輪）／宵の口・街灯・直線・STILL・夜風・街宵・アーバン・灯（既存記録維持）。全生存者監査未実施', namingStatus:'working',
        sourceNote:'出自: 電通議論資料（MTG#1）の世界観/情緒性コンセプトD',
        sheet:{
          context:{v:'強い結束→共感性→ゆるい距離感（資料原文）',src:'資料'},
          insight:{v:'べったりしない、ちょうどいい距離の人付き合いに寄り添う一杯がほしい',src:'ツール提案（文脈からの翻訳）'},
          brandConcept:{v:'かっこいいけどどこか冷たさもある都会的な世界観/情緒性',src:'資料'},
          devConcept:{v:'（提案・決裁待ち）力強いのどごしと軽快な香りを絶妙に整えた、都会の定番の一杯——資料の物性（至高の絶妙バランス）と前提条件（ド真ん中）の接続',src:'ツール提案'}, analogy:{v:'未決',src:'未決'},
          benefitP:{v:'のどごしの力強さと香りの軽快さの至高の絶妙バランス',src:'資料'},
          benefitE:{v:'緩やかなつながり・都会的な距離感',src:'資料'},
          fact:{v:'（ブレンド技術ファクトを流用可能）',src:'ツール提案'},
          pColor:{v:'未決',src:'未決'}, pName:{v:'未決。方向別採用: 宵（C-1夜のガラス・C-2グリッド＝可読負担の設計判断で共有）／琥珀（C-3窓越し・色の正式語彙）。監査未実施',src:'ツール提案'}, pDba:{v:'未決',src:'未決'}
        },
        openQuestion:'都会的な冷たさは「ド真ん中の王道感」（電通資料の前提条件）と両立するか。',
        keyterms:'世界観・物性＝電通資料の言葉。以降は本タブのアウトプット。',
        derivation:[
          { candidate:'夜のガラスの反射', source:'世界観「都会的な冷たさ」＝資料／鏡面反射＝ツール提案', verdict:'採用 → C-1', reason:'金属光沢コードの内側で都会を言える（王道感の維持）' },
          { candidate:'グリッドの組版', source:'都会の規律＝ツール提案（スイス・タイポグラフィの正統）', verdict:'採用 → C-2', reason:'冷たさ→雑味のなさへの転化。安価/文具誤読は台帳で検査' },
          { candidate:'ネオン・スカイラインの絵柄', source:'「都会」の通俗的視覚語彙', verdict:'棄却', reason:'クラフトビールの定番文法＝先客衝突、かつ絵柄はド真ん中の王道感（電通資料の前提条件）を毀損' }
        ],
        derivationStatus:'方向の範囲＝「都会的な距離感を担える意匠」。通俗語彙（ネオン）は先客と王道毀損で棄却。',
        structure:{
          basis:'2軸は各方向の賭けから導出。X=都会の温度、Y=都会の言い方。統制C-0が原点。',
          x:{neg:'冷（無機・距離）', pos:'温（灯り・気配）', label:'都会の温度'},
          y:{neg:'マテリアル（質感・光）', pos:'ジオメトリ（秩序・枠）', label:'都会の言い方'},
          cells:[
            {dirId:'ct-1', x:-1, y:-1, why:'夜のガラス＝冷たい鏡面×質感（反射は面上の点景）'},
            {dirId:'ct-2', x:-1, y:1,  why:'グリッドの静寂＝冷たい規律×秩序'},
            {dirId:'ct-3', x:1,  y:1,  why:'窓越しの琥珀＝温の灯り×枠（額装の構図）'}
          ],
          center:'ct-0',
          empties:[{x:1, y:-1, note:'空白象限: 温×質感（例: 真鍮や木の手ざわり×金属＝温かな都会の素材）。候補未生成——依頼書の棚卸しで充填可否を判定'}],
          coverage:'3象限＋空白1＋原点。棄却の配置検査: ネオン絵柄＝温×質感（空白象限に属するが先客と王道毀損で棄却済み＝空白の充填候補から除外済み）。'
        },
        framing:'電通資料コンセプトDの展開枠。C-1（素材）/C-2（構図）/C-3（可読強化）＋統制C-0の4方向を初期案として展開済み。' }

    ],
    activeConceptId:'sumitora',

    /* ===== 第1段: 前提リサーチ（5つの問いと答え） ===== */
    perception: {
      intro: '目的: 5方向の根拠となる事実の確認。対象: 規制 / 市場前例 / 需要 / 記号の先客 / 検証手法。各設問の答えは事実と出典で構成。02 設計条件と03 可動域はここから導出。',
      questions: [
        { id:'Q1', q:'規制と自主基準は「浄化」をどこまで許すか', finds:['F1','F2'] },
        { id:'Q2', q:'王道×差分は、市場でどう成功しどう失敗してきたか', finds:['F3','F4','F5','F6'] },
        { id:'Q3', q:'「気枯れを祓う」に、そもそも需要はあるか', finds:['F7'] },
        { id:'Q4', q:'使おうとしている記号（白虎・白・金）は安全か、棚に空きはあるか', finds:['F8','F9'] },
        { id:'Q5', q:'作った差分は、どうすれば調査で検証できるか', finds:['F10'] }
      ],
      findings: [
        { id:'F1', title:'「浄化・祓う」は禁止されていない', fact:'酒類広告の業界自主基準は「浄化」「祓う」「整う」を禁止していない。禁止列挙は過度飲酒・依存誘発・スポーツ時/入浴時飲酒の推奨・喉元の「ゴクゴク」描写など13項目に限られる（酒類の広告審査委員会に掲載の現行基準で内容確認済み。最終改正日の表記のみ導入前のリーガルチェックで最新版の再確認を推奨）。ただし列挙外＝無条件ではなく、体調回復・健康効用を想起させる文脈と結び付けた瞬間にアウトになる。', sources:[{title:'酒類の広告審査委員会（自主基準 掲載ページ）', url:'https://www.rcaa.jp/standard/koukoku.html'}] },
        { id:'F2', title:'缶体には清涼飲料誤認の防止義務がある', fact:'同基準は缶体に対し、純アルコール量のグラム表示（6ポイント以上）、健康注意文言、そして「清涼飲料等と誤認されないよう色彩・絵柄に配意する」ことを求めている。白・水色基調のデザインはこの誤認防止条項に正面から関わる。', sources:[{title:'同自主基準 III 酒類容器関係', url:'https://www.rcaa.jp/standard/'}] },
        { id:'F3', title:'晴れ風 — 1変数の差分で15年最大ヒット（ただし誤認批評つき）', fact:'キリン晴れ風は、文字と図像は王道ビールデザイン（一番搾り・ラガーとの共通要素）を踏襲し、色だけをターコイズに変えて発売1カ月で同社過去15年の新商品最大の販売数量、初年度576万ケースを記録した。一方で「水色ベースは清涼飲料のデザイン」「季節限定品にされる危険」という批評も同時に付いた。', sources:[{title:'AdverTimes（晴れ風670万ケース目標）', url:'https://www.advertimes.com/20250207/article489017/'},{title:'日経クロストレンド（晴れ風デザインの秘密）', url:'https://xtrend.nikkei.com/atcl/contents/18/00947/00043/'}] },
        { id:'F4', title:'プライドポテト — 和のやりすぎは2秒の棚で敗北した', fact:'湖池屋プライドポテトは2017年、和・日の丸に寄せた赤パッケージと読みにくい味名で「店頭では2秒で買うか決まる」棚に敗北。2020年に白ベース×カタカナ表記へ回帰し、3カ月で売上20億円（前年比517%）の再ヒットになった。和・格調の「やりすぎ」は棚で負けるという実証。', sources:[{title:'XD（プライドポテトが刺さる理由）', url:'https://exp-d.com/interview/9374/'},{title:'日本経済新聞', url:'https://www.nikkei.com/article/DGXMZO60391440W0A610C2000000/'}] },
        { id:'F5', title:'綾鷹 — 和の格調はシェア2%→20%の武器になった', fact:'綾鷹は永禄年間創業の茶舗・上林春松本店の権威と「縦組み毛筆ロゴ×深色帯×金縁」の文法で、緑茶シェアを2%から約20%へ拡大した。和の格調はカテゴリの王道感を毀損せず、むしろ「間違いなさ」の担保になり得るというカテゴリ横断の実証。', sources:[{title:'ダイヤモンド・オンライン（綾鷹2%→20%）', url:'https://diamond.jp/articles/-/339387'}] },
        { id:'F6', title:'翠とStella — 境界・儀式のデザインは酒類で実証済み', fact:'サントリー翠は「居酒屋の境界の再定義」（飲食店・瓶・缶の三位一体）で販売数量前年比236%・日経トレンディ酒類部門大賞。またStella Artoisは公式の注ぎ儀式9ステップの第1歩を明示的に「The Purification（浄化）」と命名して展開している。境界・儀式のデザインは酒類ブランディングとして国内外に成功実証がある。', sources:[{title:'Web担（翠 三位一体戦略）', url:'https://webtan.impress.co.jp/e/2023/08/22/45208'},{title:'Stella Artois 9-Step Pouring Ritual', url:'https://cdn.uc.assets.prezly.com/a7590d8c-8f20-40ac-a3d1-dba850625d33/-/inline/no/9-step-pouring-ritual.pdf'}] },
        { id:'F7', title:'「気枯れ」の需要は男性でも4割超', fact:'SNS・情報疲れは定量的に裏付けがある。NTTドコモ モバイル社会研究所の2025年調査では利用頻度にかかわらず6〜7割が「情報の多さ」による疲れを実感。クロス・マーケティングの2026年調査（n=3,000）では「SNSと距離を置きたい」が男性でも41.7%。「気枯れ」インサイトの需要側の裏付け。', sources:[{title:'モバイル社会研究所', url:'https://www.moba-ken.jp/project/service/20260219.html'},{title:'日本経済新聞（クロス・マーケティング調査報道）', url:'https://www.nikkei.com/article/DGXZQOUC036HD0T00C26A7000000/'}] },
        { id:'F8', title:'白虎は意味が通る。ただし描き方に条件がある', fact:'白虎は四神の西の守護で、伝統的に魔除け・邪気の遮断を司る図像。「気枯れを祓う」という意味と正しく接続する。一方、虎の缶面使用には阪神タイガース（円形紋章＋縞）と寅年グッズという強い先客がおり、縞を描かない・円形化しないことが混線回避の条件になる。麻の葉紋は鬼滅の刃（禰豆子）の連想が支配的で、かつ伝統的願意が「子供の成長」で大人の浄化とズレるため主役には使えない。', sources:[{title:'四神・白虎の意味体系（伝統文化解説）', url:'https://ja.wikipedia.org/wiki/%E5%9B%9B%E7%A5%9E'}] },
        { id:'F9', title:'2026年の棚 — 色相の空白は「白×金線」', fact:'2026年10月の酒税一本化でビールは9.1円減税、金麦・本麒麟などが相次ぎビール化する。王道を名乗るプレイヤーが一斉に増える棚で、価格でなく世界観の競争になる。缶の色相占有は銀=スーパードライ、金/赤=一番搾り、黒=黒ラベル、ターコイズ=晴れ風、オレンジ=グッドエール、金=アサヒゴールド（面の金を占有）。白×金（線）は相対的な空白（各社公式商品情報からの整理。POS裏付けなし）。', sources:[{title:'財務省 酒税に関する資料', url:'https://www.mof.go.jp/tax_policy/summary/consumption/d08.htm'}] },
        { id:'F10', title:'調査の定石 — 要素分解できる設計だけが答えを返す', fact:'パッケージ調査の実務定石は、絶対評価→相対評価の順で提示し、色・ロゴ・フォントなど要素分解した魅力度と印象語を測り、模擬棚で競合と並べて識別性・独自性を評価する。要素分解できる差分設計にしておくほど、調査が「どの要素が効いたか」に答えられる。', sources:[{title:'アスマーク（パッケージテストの手法）', url:'https://www.asmarq.co.jp/column/column-cat/how_to/package-investigation/'},{title:'INTAGE 知るギャラリー', url:'https://gallery.intage.co.jp/package-2/'}] }
      ],
      implications: [
        { id:'I1', from:['F1','F2'], claim:'「浄化・祓う」は言える。壁は2つだけ——効能に聞こえないこと（健康・回復の語と併記しない）と、清涼飲料・限定品に見えないこと。' },
        { id:'I2', from:['F3','F4'], claim:'差分は1変数なら王道感を保ったまま大ヒットし得る。複数変数を同時に動かした（和に全振りした）事例は棚で敗北している。よって幅出しは「どの1変数を動かすか」の比較として設計すべき。' },
        { id:'I3', from:['F5','F6'], claim:'和の格調・境界や儀式のデザインは、酒類・飲料で成功実証のある文法。RIBの「神聖・浄化」路線は前例のない賭けではない。' },
        { id:'I4', from:['F7'], claim:'「気枯れ」は流行語ではなく、TGT男性の4割超が持つ定量的な欲求。世界観の需要側は立証済みで、問うべきは表現の側だけ。' },
        { id:'I5', from:['F8','F9'], claim:'白虎×白×金（線）は、意味の整合・先客回避・棚の色相空白の3条件を同時に満たす稀な組み合わせ。ただし虎の描法と金の使い方に条件が付く。' },
        { id:'I6', from:['F10'], claim:'各案の差分を単一変数に分離しておけば、調査結果は「どの案が勝ったか」でなく「どの変数に差分予算を割くべきか」という再利用可能な知見として返ってくる。' }
      ]
    },

    /* ===== 第3段: 遊びの範囲（共通条件と失敗前例） ===== */
    space: {
      note: '缶の第一印象（3m・2秒）を決める一次知覚変数は4つ。王道7缶の遠距離識別を成立させている変数であり、新参2者（晴れ風・グッドエール）が動かして成功したのも一次変数のみ。書体・仕上げ・情報密度は近接時に効く二次変数として、幅出しの主変数から除外する。各案は一次変数を1つだけ失敗前例の手前まで動かし、他は共通条件に固定する（単一変数変位）。',
      derivation: 'この4変数は感覚語ではなく、店頭3メートル・2秒の距離で王道7缶（スーパードライ/一番搾り/黒ラベル/プレモル等）を互いに見分けさせている一次要素を抽出したものです。裏付けとして、直近で成功した新参2缶（晴れ風・グッドエール）が動かしたのも、この一次変数のうち1つだけでした。書体・仕上げ・情報密度は手に取った近接時にしか効かないため二次変数とし、幅出しの主変数から外しています。各変数には「全案共通の条件」（王道感を担保するために全案が守る約束）と「実証された失敗前例」（越えたときに実際に失敗した・規制に当たることが確認されている限界）があり、各案の差分はその手前までしか動かしません。',
      variables: [
        { id:'V1', name:'支配色', floor:'銀・金系の金属色域', wall:'清涼飲料誤認', ceiling:'高彩度・大面積の青は清涼飲料誤認（自主基準の誤認防止条項、晴れ風への「清涼飲料に見える」批評）。黒はサッポロ、ターコイズ・オレンジはキリン、面の金はアサヒが占有' },
        { id:'V2', name:'地の素材感', floor:'金属光沢', wall:'和過多・縁起物化', ceiling:'和素材の過多は2秒棚で敗北（プライドポテト2017の実証）。授与品に寄りすぎると縁起物・土産物に誤読される' },
        { id:'V3', name:'図像の様式・動勢', floor:'紋章1点・静的', wall:'書芸漂流・先客混線', ceiling:'書芸様式に寄りすぎると日本酒・高級酒コードに漂流。縞のある虎・円形の虎紋章は阪神・寅年と混線' },
        { id:'V4', name:'構図の界構造', floor:'左右対称・中央ロゴブロック・品質宣言定位置', wall:'解読失敗＝限定品', ceiling:'界分割の解読に失敗すると奇抜・限定品コードに落ちる（戦略の最重要注意点、晴れ風への批評と同型）' }
      ],
      secondary: ['書体の性格', '仕上げ（箔・マット・光沢）', '情報密度']
    },

    /* ===== 翻訳辞書（印象語 ⇄ 変数操作） ===== */
    dictionary: [
      { term:'もっと高級に/格を上げたい', moves:[{v:'V2', how:'地の光沢を上げる、または紙・布の「密度ある質感」に寄せる'},{v:'二次', how:'金の線量を増やす（面にはしない=アサヒゴールド占有）、情報密度を下げる'}], caution:'和素材を増やす方向はV2失敗前例（2秒棚敗北）に接近' },
      { term:'もっと王道に/定番らしく', moves:[{v:'V1', how:'金属色域へ戻す'},{v:'V4', how:'完全対称・ロゴブロック強調'},{v:'二次', how:'品質宣言を大きく、泡・麦芽の写実を足す'}] },
      { term:'もっと今っぽく/若々しく', moves:[{v:'V1', how:'彩度を抑えたまま明度を上げる（淡色化）'},{v:'V2', how:'マット化'},{v:'二次', how:'情報密度を下げる'}], caution:'淡色×マットは清涼飲料誤認（V1の失敗前例）に接近。ビール記号の併置が条件' },
      { term:'もっと強く/力強く', moves:[{v:'V3', how:'図像に動勢を入れる（走る・跳ぶ姿態）'},{v:'V1', how:'コントラストを上げる（地は変えず図像側を濃く）'}], caution:'書芸様式への漂流（V3の失敗前例）に注意。泡・生表記で酒種の可読を守る' },
      { term:'もっと優しく/柔らかく', moves:[{v:'V2', how:'紙・布の温かい質感へ'},{v:'V3', how:'図像を静的・端正に'},{v:'二次', how:'書体の骨格を細く'}] },
      { term:'もっと神聖に/清らかに', moves:[{v:'V2', how:'奉書・織物の「密度ある白」へ（光の玉・オーラ等のスピリチュアル記号は禁止）'},{v:'V3', how:'白虎の様式を日本画・截金の系譜に'}], caution:'健康効用に聞こえる語との併記は不可（自主基準の禁止列挙に該当）。縁起物化はV2の失敗前例' },
      { term:'もっと軽く/すっきり', moves:[{v:'V1', how:'白の面積を増やす、淡青は低彩度・小面積で'},{v:'二次', how:'情報密度を下げる'}], caution:'V1失敗前例（清涼飲料誤認）に最接近する操作。生ビール表記・泡を大きく' },
      { term:'差分をもう半歩強く', moves:[{v:'当該案の変位変数', how:'同じ変数の変位量を1段階上げる（他の変数には波及させない）'}], caution:'失敗前例との距離を照合してから' },
      { term:'目立たせたい/棚で止めたい', moves:[{v:'V4', how:'界構造・視線誘導の非対称要素を入れる'},{v:'V1', how:'色相の空白（白×金線）を突く'}], caution:'V4は解読失敗＝奇抜化の失敗前例が近い。解読の補助線（意味の分かる図像）とセットで' }
    ],

    /* ===== 監査DB（記号・借用元・禁則・規定） ===== */
    audit: {
      codebook: {
        version: 'v1-draft', date: '2026-07-06',
        selection: {
          rule: '対象集合＝直近の販売数量・購買データで上位のビール（狭義）主要ブランドの350ml標準缶8本。対照群＝棚で隣接し誤読リスクの源になるカテゴリの代表缶6本（失敗前例の正体は自カテゴリのコード破りではなく、隣のカテゴリのコードへの接近であるため）。',
          sources: [
            { title:'JMR生活総研 消費者調査データ ビール系飲料 2025年8月版（再購入意向: スーパードライ/一番搾り/晴れ風/プレモル/黒ラベル/ヱビスの順）', url:'https://www.jmrlsi.co.jp/trend/mranking/02-drink/mranking430.html' },
            { title:'Vポイント購買データ 2024/7-2025/6 ビール類総合ランキング（スーパードライ首位）', url:'https://www.vpoint-biz.jp/columns/cccdata25' },
            { title:'日経 2026年4月 ブランド別販売実績（スーパードライ/プレモル/黒ラベル）', url:'https://www.nikkei.com/article/DGXZQOUC148CO0U6A510C2000000/' }
          ]
        },
        kThreshold: 0.7,
        schema: [
          { id:'A1', name:'地の色相域', levels:['銀白','金・琥珀','黒','赤系','青系','緑系','白・クリーム','茶'], criterion:'缶正面の面積50%以上を占める地色の色相域。グラデーションは占有の大きい側。金属銀は「銀白」。' },
          { id:'A2', name:'地の光沢', levels:['金属','マット','紙・布質感'], criterion:'地に鏡面ハイライト（照明の白い映り込み）があれば金属。紙・布のテクスチャが視認できれば紙・布質感。どちらもなければマット。' },
          { id:'A3', name:'主図像の種類', levels:['紋章・エンブレム','文字ロゴのみ','写実（麦・泡・情景）','幾何・抽象'], criterion:'缶正面で最大面積を占める非文字要素の種類。非文字要素が事実上なければ「文字ロゴのみ」。' },
          { id:'A4', name:'動勢', levels:['静的','動的'], criterion:'主要素に15度以上傾いた軸・流線・スピード線・波形反復があれば動的。' },
          { id:'A5', name:'構図', levels:['中央シンメトリー','縦帯分割','横帯分割','全面図像'], criterion:'商品名ロゴブロックの位置と、最も強い分割線の向きで判定。' },
          { id:'A6', name:'泡・液体の写実', levels:['あり','なし'], criterion:'泡・注ぎ・液面の写実描写の有無。' },
          { id:'A7', name:'金の使用', levels:['なし','線・縁','面'], criterion:'金色の面積。輪郭線・罫・縁取りまでは「線・縁」、ベタ領域があれば「面」。' },
          { id:'A8', name:'ロゴ書体系統', levels:['角ゴシック系','明朝・毛筆系','欧文サンセリフ','欧文セリフ・装飾'], criterion:'最大の商品名ロゴの書体系統。' }
        ],
        targets: [
          { id:'cb-sd',   brand:'アサヒ スーパードライ', maker:'アサヒ', basis:'全出典で首位' },
          { id:'cb-ichi', brand:'キリン 一番搾り', maker:'キリン', basis:'JMR再購入意向2位・販売2本柱' },
          { id:'cb-kuro', brand:'サッポロ 黒ラベル', maker:'サッポロ', basis:'JMR上位・販売数量2桁増の主力' },
          { id:'cb-pm',   brand:'ザ・プレミアム・モルツ', maker:'サントリー', basis:'JMR上位・販売増' },
          { id:'cb-hare', brand:'キリン 晴れ風', maker:'キリン', basis:'JMR再購入意向3位。色コードを破って成功した経験データとして必須' },
          { id:'cb-ebisu',brand:'ヱビスビール', maker:'サッポロ', basis:'JMR上位・プレミアム帯の基準' },
          { id:'cb-maruefu', brand:'アサヒ生ビール（マルエフ）', maker:'アサヒ', basis:'JMR 3位グループ' },
          { id:'cb-lager', brand:'キリン ラガー', maker:'キリン', basis:'最古参の定番。紋章コードの原点として採用（選定は判断: 数量上位性は要確認）' }
        ],
        /* 参照缶（性格軸の解像度用）: 王道の最頻値・ペア弁別・網羅性の計算には数えない第三の母集団。
        用途は2つ——(1)構成銘柄が薄い性格軸（特に力強さ＝実質スーパードライ1缶）の条件付き最頻値に票を足す
        (2)符号化されると識別署名が模倣検知の照合対象に加わり、検知の網が広がる。
        選定は判断（売上上位性は要求しない）。符号化は対象缶と同じ二重符号化＋裁定のワークフロー。 */
        refTargets: [
          { id:'cbr-classiclager', brand:'キリン クラシックラガー', maker:'キリン', archetypeHint:'arch-strong', basis:'昭和40年代の意匠を再現した現行の復刻定番。力強い王道の伝統文法の参照（数量基準外＝選定は判断）' },
          { id:'cbr-budweiser', brand:'バドワイザー', maker:'ABインベブ（国内ライセンス）', archetypeHint:'arch-strong', basis:'「ビールらしさとは」資料がビッグロゴ型の例示に挙げる銘柄。力強い王道の海外文法の参照' },
          { id:'cbr-heineken', brand:'ハイネケン', maker:'ハイネケン', archetypeHint:'arch-class', basis:'同資料ビッグロゴ型の例示。海外プレミアム＝格の系統の参照' },
          { id:'cbr-goodale', brand:'キリン グッドエール', maker:'キリン', archetypeHint:'arch-new', basis:'2025年10月発売のキリン第3の柱（一番搾り・晴れ風に次ぐ）。発見F9（2026年の棚）でオレンジ占有の新参成功者として既収載。新しさの王道の参照（メーカー・意匠事実はキリン公式リリース2025-09-22で確認）' },
          { id:'cbr-masters', brand:'ザ・プレミアム・モルツ マスターズドリーム', maker:'サントリー', archetypeHint:'arch-class', basis:'自社プレミアム上位帯。格の系統の解像度参照（選定は判断）' }
        ],
        /* 王道の性格軸（アーキタイプ）: 「王道＝単一の最頻ベクトル」が生む2つの不具合——
        (a)拮抗属性が自由域のままLLMの文脈（ターゲット記述）で埋まり優しさ側へ吹き溜まる
        (b)署名なしの平均缶＝PBの文法に収束する——への構造対応の第1段。
        床（占有がkThreshold以上の属性）は全軸共通で維持し、拮抗属性だけを軸ごとの条件付き最頻値で規定する。
        構成銘柄の割当は判断＝draft。チームが目録画面で編集・承認（approved）すると設計知識に接続される。
        プロファイルの中身は格納しない——_archetypeGuidesが符号化表から常時導出（観察の更新に自動追随）。 */
        archetypes: [
          { id:'arch-strong', name:'力強さの王道', status:'approved', approvedAt:'2026-07-16', approvedNote:'ニコ承認（チャット指示 2026-07-16）。画像確定前の暫定プロファイルで接続——符号の裁定・画像再符号化で規定は自動更新される。構成に異論があれば編集すると承認は自動失効し再レビューに戻る',
            semantic:'辛口・キレ・緊張感。らしさ3系統では物性（飲みごたえ）を高コントラストと硬質さで言う系統',
            members:['cb-sd','cb-kuro','cbr-classiclager','cbr-budweiser'],
            basis:'符号化表の視覚クラスタ（銀白地×高コントラスト×欧文系）からの判断割当。注意: 国内の現占有はほぼスーパードライ1缶＝参照缶の符号化までは条件付き最頻値がSDの署名と重なりやすい（sigRiskとして機械警告される）' },
          { id:'arch-gentle', name:'優しさの王道', status:'approved', approvedAt:'2026-07-16', approvedNote:'ニコ承認（チャット指示 2026-07-16）。画像確定前の暫定プロファイルで接続——符号の裁定・画像再符号化で規定は自動更新される。構成に異論があれば編集すると承認は自動失効し再レビューに戻る',
            semantic:'まろやか・実直・安心。物性（麦・泡の写実）と暖色、明朝・毛筆系の柔らかい骨格で言う系統',
            members:['cb-ichi','cb-maruefu','cb-lager'],
            basis:'符号化表の視覚クラスタ（暖色/白クリーム地×明朝毛筆×写実寄り）からの判断割当。注記: ラガーはブランド像（苦味・力強さ）と缶の視覚（白地×紋章×静的）が乖離する——本目録は見た目の符号なので視覚側で割当。異論があれば構成から外して承認すること' },
          { id:'arch-class', name:'格の王道', status:'approved', approvedAt:'2026-07-16', approvedNote:'ニコ承認（チャット指示 2026-07-16）。画像確定前の暫定プロファイルで接続——符号の裁定・画像再符号化で規定は自動更新される。構成に異論があれば編集すると承認は自動失効し再レビューに戻る',
            semantic:'品格・伝統・報酬感。舶来（紋章・欧文セリフ）と作り手（品質宣言）の系統で言う',
            members:['cb-pm','cb-ebisu','cbr-heineken','cbr-masters'],
            basis:'符号化表の視覚クラスタ（紋章×面金×欧文セリフ・装飾）からの判断割当' },
          { id:'arch-new', name:'新しさの王道', status:'approved', approvedAt:'2026-07-16', approvedNote:'ニコ承認（チャット指示 2026-07-16）。画像確定前の暫定プロファイルで接続——符号の裁定・画像再符号化で規定は自動更新される。構成に異論があれば編集すると承認は自動失効し再レビューに戻る',
            semantic:'王道文法を守りながら一次変数を1つだけ破る新参の成功文法（晴れ風の実証）。図像の抽象化・色相の空白突きが典型',
            members:['cb-hare','cbr-goodale'],
            basis:'発見F3（晴れ風=1変数差分の実証）・F9（グッドエールのオレンジ占有）からの判断割当。この軸は「破り方の型」であり、単独100%での使用よりブレンドの差し味を想定' }
        ],
        // 誤読リスク台帳: 対照群はここから導出される。各リスクは「どこに実証が記録されているか」を持ち、
        // 判定手段は 対照缶（同じ属性表に符号化して重なりを見る）か、棚に代表缶が存在しないリスクは調査で直接測定。
        misreads: [
          { id:'mr-soft', wall:'清涼飲料誤認', covers:['清涼飲料誤認'],
            evidence:'業界自主基準の誤認防止条項（缶体の色彩は清涼飲料と誤認されないよう配意する義務）と、晴れ風に実際に付いた「清涼飲料に見える」という批評。いずれも01 調査に出典付きで収載',
            directions:['S-1 色の変位','辞書「もっと軽く/今っぽく」'],
            category:'炭酸水・清涼飲料・無糖チューハイ', method:'対照缶',
            reps:[
              { id:'cb-wilkinson', brand:'ウィルキンソン タンサン', repBasis:'炭酸水の代表銘柄。銀地×赤ロゴ＝無糖・清涼のコード（選定規則: カテゴリ代表×当該視覚コード共有）' },
              { id:'cb-mitsuya', brand:'三ツ矢サイダー', repBasis:'清涼飲料の長寿代表。白×緑の清涼コード' },
              { id:'cb-hyoketsu', brand:'キリン 氷結（無糖レモン）', repBasis:'RTD上位ブランド（JMR RTD調査2025「氷結・ほろよいの競り合い」）かつキリンRTD売上No.1シリーズ（キリン発表2025）。銀×青×ダイヤカット＝淡青方向の最近接' }
            ] },
          { id:'mr-tea', wall:'緑茶可読', covers:['緑茶可読'],
            evidence:'03可動域 B-1の失敗前例（紺×金は緑茶プレミアムの意匠と近接）',
            directions:['B-1 色格の変位'],
            category:'緑茶飲料', method:'対照缶',
            reps:[
              { id:'cb-ayataka', brand:'綾鷹', repBasis:'緑茶2番手グループ（首位おーいお茶=シェア約4割: 日経クロストレンド2024 / 伊右衛門と綾鷹が約24%で拮抗: ダイヤモンド）。深緑×金の意匠が紺金コードの最近接。首位おーいお茶は白緑系で当該コードを共有しないため代表から除外——選定規則: カテゴリ上位×当該視覚コード共有' }
            ] },
          { id:'mr-wa', wall:'和過多・縁起物化', covers:['和過多','縁起物化'],
            evidence:'湖池屋プライドポテト2017年の実証（和素材過多のパッケージは2秒の棚で敗北し、リニューアルで回復した）。01 調査に出典付きで収載',
            directions:['S-2 素材の変位','S-3 図像の変位'],
            category:'縁起物・授与品（恒常的な棚カテゴリが存在しない）', method:'調査で直接測定',
            reps:[],
            measure:'カンプ提示後の自由連想＋「自分で飲む/贈答・土産」の用途二択聴取で縁起物連想率を測る' },
          { id:'mr-craft', wall:'クラフト・ニッチ誤読', covers:['クラフト・ニッチ'],
            evidence:'03可動域 B-2の失敗前例（紙・ラベルの文法はクラフトの識別コード）',
            directions:['B-2 素材の変位（計器）','S-2 素材の変位'],
            category:'クラフトビール', method:'対照缶',
            reps:[
              { id:'cb-yonayona', brand:'よなよなエール', repBasis:'クラフト最大手ヤッホーブルーイングの主力・和柄×紙質感の代表（販売序列の一次出典は未取得＝選定は判断とタグ付け）' }
            ] },
          { id:'mr-sake', wall:'書芸漂流（日本酒コード）', covers:['書芸漂流'],
            evidence:'03可動域 V3の失敗前例（書芸様式は日本酒・高級酒コードに漂流）',
            directions:['S-3 図像の変位'],
            category:'カップ・缶日本酒', method:'対照缶',
            reps:[
              { id:'cb-onecup', brand:'ワンカップ大関', repBasis:'カップ日本酒の代名詞的ロングセラー（選定は判断: 数量出典未取得）。毛筆ロゴ×白地の日本酒コード代表' }
            ] },
          { id:'mr-nonal', wall:'ノンアルコール誤認', covers:['ノンアル'],
            evidence:'業界自主基準（酒マーク・お酒表記の義務）。ドライゼロがスーパードライの意匠に酷似している市場事実が境界の狭さを示す',
            directions:['全方向（必須表示の遵守）','特にS-1淡色・S-2白'],
            category:'ノンアルコールビール', method:'対照缶',
            reps:[
              { id:'cb-dryzero', brand:'アサヒ ドライゼロ', repBasis:'ビール意匠に最も近いノンアル（黒×銀）。誤認境界の下限を定義' },
              { id:'cb-allfree', brand:'サントリー オールフリー', repBasis:'白基調ノンアルの代表。S-2白方向の隣人' }
            ] },
          { id:'mr-limited', wall:'解読失敗＝限定品コード', covers:['解読失敗','意味不明'],
            evidence:'戦略の最重要注意点（晴れ風批評と同型: 新奇な構図は限定品・変わり種に誤読される）',
            directions:['S-4 構図の変位（計器）','B-3 図像の変位'],
            category:'限定品（様式でなく文脈のコードのため代表缶が存在しない）', method:'調査で直接測定',
            reps:[],
            measure:'カンプ提示後「定番/期間限定のどちらに見えるか」二択＋想定購入頻度の聴取' }
        ],
        table: {
          "cbr-classiclager": {
            "cells": {
              "A1": {
                "v": "白・クリーム",
                "v2": "茶",
                "status": "needs-adjudication"
              },
              "A2": {
                "v": "金属",
                "v2": "金属",
                "status": "draft"
              },
              "A3": {
                "v": "紋章・エンブレム",
                "v2": "紋章・エンブレム",
                "status": "draft"
              },
              "A4": {
                "v": "静的",
                "v2": "静的",
                "status": "draft"
              },
              "A5": {
                "v": "中央シンメトリー",
                "v2": "中央シンメトリー",
                "status": "draft"
              },
              "A6": {
                "v": "なし",
                "v2": "なし",
                "status": "draft"
              },
              "A7": {
                "v": "線・縁",
                "v2": "なし",
                "status": "needs-adjudication"
              },
              "A8": {
                "v": "明朝・毛筆系",
                "v2": "欧文セリフ・装飾",
                "status": "needs-adjudication"
              }
            },
            "imageFile": null,
            "imageFileId": null,
            "agreement": 62,
            "encodedAt": "2026-07-16T00:00:00Z",
            "basis": "記憶ベースの一次符号化（アシスタント・v73）。確信のないセルは最初から裁定待ち。「缶の画像を入れて表に追加」による画像再符号化で確定する"
          },
          "cbr-budweiser": {
            "cells": {
              "A1": {
                "v": "赤系",
                "v2": "赤系",
                "status": "draft"
              },
              "A2": {
                "v": "金属",
                "v2": "マット",
                "status": "needs-adjudication"
              },
              "A3": {
                "v": "文字ロゴのみ",
                "v2": "紋章・エンブレム",
                "status": "needs-adjudication"
              },
              "A4": {
                "v": "静的",
                "v2": "動的",
                "status": "needs-adjudication"
              },
              "A5": {
                "v": "中央シンメトリー",
                "v2": "中央シンメトリー",
                "status": "draft"
              },
              "A6": {
                "v": "なし",
                "v2": "なし",
                "status": "draft"
              },
              "A7": {
                "v": "なし",
                "v2": "線・縁",
                "status": "needs-adjudication"
              },
              "A8": {
                "v": "欧文セリフ・装飾",
                "v2": "欧文セリフ・装飾",
                "status": "draft"
              }
            },
            "imageFile": null,
            "imageFileId": null,
            "agreement": 50,
            "encodedAt": "2026-07-16T00:00:00Z",
            "basis": "記憶ベースの一次符号化（アシスタント・v73）。確信のないセルは最初から裁定待ち。「缶の画像を入れて表に追加」による画像再符号化で確定する"
          },
          "cbr-heineken": {
            "cells": {
              "A1": {
                "v": "緑系",
                "v2": "緑系",
                "status": "draft"
              },
              "A2": {
                "v": "金属",
                "v2": "金属",
                "status": "draft"
              },
              "A3": {
                "v": "紋章・エンブレム",
                "v2": "文字ロゴのみ",
                "status": "needs-adjudication"
              },
              "A4": {
                "v": "静的",
                "v2": "静的",
                "status": "draft"
              },
              "A5": {
                "v": "横帯分割",
                "v2": "中央シンメトリー",
                "status": "needs-adjudication"
              },
              "A6": {
                "v": "なし",
                "v2": "なし",
                "status": "draft"
              },
              "A7": {
                "v": "なし",
                "v2": "なし",
                "status": "draft"
              },
              "A8": {
                "v": "欧文セリフ・装飾",
                "v2": "欧文サンセリフ",
                "status": "needs-adjudication"
              }
            },
            "imageFile": null,
            "imageFileId": null,
            "agreement": 62,
            "encodedAt": "2026-07-16T00:00:00Z",
            "basis": "記憶ベースの一次符号化（アシスタント・v73）。確信のないセルは最初から裁定待ち。「缶の画像を入れて表に追加」による画像再符号化で確定する"
          },
          "cbr-goodale": {
            "cells": {
              "A1": {
                "v": "赤系",
                "v2": "金・琥珀",
                "status": "needs-adjudication"
              },
              "A2": {
                "v": "金属",
                "v2": "金属",
                "status": "draft"
              },
              "A3": {
                "v": "紋章・エンブレム",
                "v2": "紋章・エンブレム",
                "status": "draft"
              },
              "A4": {
                "v": "静的",
                "v2": "動的",
                "status": "needs-adjudication"
              },
              "A5": {
                "v": "中央シンメトリー",
                "v2": "中央シンメトリー",
                "status": "draft"
              },
              "A6": {
                "v": "なし",
                "v2": "なし",
                "status": "draft"
              },
              "A7": {
                "v": "なし",
                "v2": "線・縁",
                "status": "needs-adjudication"
              },
              "A8": {
                "v": "角ゴシック系",
                "v2": "欧文サンセリフ",
                "status": "needs-adjudication"
              }
            },
            "imageFile": null,
            "imageFileId": null,
            "agreement": 50,
            "encodedAt": "2026-07-16T00:00:00Z",
            "basis": "記憶ベースの一次符号化（アシスタント・v73）。確信のないセルは最初から裁定待ち。「缶の画像を入れて表に追加」による画像再符号化で確定する。意匠事実（オレンジのカラーリング・聖獣麒麟を中央に堂々と配置）はキリン公式ニュースリリース2025-09-22で確認済み"
          },
          "cbr-masters": {
            "cells": {
              "A1": {
                "v": "青系",
                "v2": "青系",
                "status": "draft"
              },
              "A2": {
                "v": "金属",
                "v2": "金属",
                "status": "draft"
              },
              "A3": {
                "v": "紋章・エンブレム",
                "v2": "文字ロゴのみ",
                "status": "needs-adjudication"
              },
              "A4": {
                "v": "静的",
                "v2": "静的",
                "status": "draft"
              },
              "A5": {
                "v": "中央シンメトリー",
                "v2": "中央シンメトリー",
                "status": "draft"
              },
              "A6": {
                "v": "なし",
                "v2": "なし",
                "status": "draft"
              },
              "A7": {
                "v": "線・縁",
                "v2": "面",
                "status": "needs-adjudication"
              },
              "A8": {
                "v": "欧文セリフ・装飾",
                "v2": "欧文セリフ・装飾",
                "status": "draft"
              }
            },
            "imageFile": null,
            "imageFileId": null,
            "agreement": 75,
            "encodedAt": "2026-07-16T00:00:00Z",
            "basis": "記憶ベースの一次符号化（アシスタント・v73）。確信のないセルは最初から裁定待ち。「缶の画像を入れて表に追加」による画像再符号化で確定する"
          },
          "cb-sd": {
            "cells": {
              "A1": {
                "v": "銀白",
                "v2": "銀白",
                "status": "draft"
              },
              "A2": {
                "v": "金属",
                "v2": "金属",
                "status": "draft"
              },
              "A3": {
                "v": "文字ロゴのみ",
                "v2": "文字ロゴのみ",
                "status": "draft"
              },
              "A4": {
                "v": "静的",
                "v2": "静的",
                "status": "draft"
              },
              "A5": {
                "v": "中央シンメトリー",
                "v2": "中央シンメトリー",
                "status": "draft"
              },
              "A6": {
                "v": "なし",
                "v2": "なし",
                "status": "draft"
              },
              "A7": {
                "v": "なし",
                "v2": "なし",
                "status": "draft"
              },
              "A8": {
                "v": "欧文セリフ・装飾",
                "v2": "明朝・毛筆系",
                "status": "needs-adjudication"
              }
            },
            "imageFile": null,
            "imageFileId": null,
            "agreement": 88,
            "encodedAt": "2026-07-06T00:00:00Z",
            "basis": "記憶ベースの一次符号化（アシスタント）。確信のないセルは最初から裁定待ち。各行の「缶の画像を入れて表に追加」による画像再符号化で確定する"
          },
          "cb-ichi": {
            "cells": {
              "A1": {
                "v": "金・琥珀",
                "v2": "金・琥珀",
                "status": "draft"
              },
              "A2": {
                "v": "金属",
                "v2": "金属",
                "status": "draft"
              },
              "A3": {
                "v": "写実（麦・泡・情景）",
                "v2": "写実（麦・泡・情景）",
                "status": "draft"
              },
              "A4": {
                "v": "静的",
                "v2": "静的",
                "status": "draft"
              },
              "A5": {
                "v": "中央シンメトリー",
                "v2": "中央シンメトリー",
                "status": "draft"
              },
              "A6": {
                "v": "あり",
                "v2": "なし",
                "status": "needs-adjudication"
              },
              "A7": {
                "v": "面",
                "v2": "面",
                "status": "draft"
              },
              "A8": {
                "v": "明朝・毛筆系",
                "v2": "明朝・毛筆系",
                "status": "draft"
              }
            },
            "imageFile": null,
            "imageFileId": null,
            "agreement": 88,
            "encodedAt": "2026-07-06T00:00:00Z",
            "basis": "記憶ベースの一次符号化（アシスタント）。確信のないセルは最初から裁定待ち。各行の「缶の画像を入れて表に追加」による画像再符号化で確定する"
          },
          "cb-kuro": {
            "cells": {
              "A1": {
                "v": "銀白",
                "v2": "銀白",
                "status": "draft"
              },
              "A2": {
                "v": "金属",
                "v2": "金属",
                "status": "draft"
              },
              "A3": {
                "v": "紋章・エンブレム",
                "v2": "紋章・エンブレム",
                "status": "draft"
              },
              "A4": {
                "v": "静的",
                "v2": "静的",
                "status": "draft"
              },
              "A5": {
                "v": "中央シンメトリー",
                "v2": "横帯分割",
                "status": "needs-adjudication"
              },
              "A6": {
                "v": "なし",
                "v2": "なし",
                "status": "draft"
              },
              "A7": {
                "v": "線・縁",
                "v2": "面",
                "status": "needs-adjudication"
              },
              "A8": {
                "v": "欧文サンセリフ",
                "v2": "欧文サンセリフ",
                "status": "draft"
              }
            },
            "imageFile": null,
            "imageFileId": null,
            "agreement": 75,
            "encodedAt": "2026-07-06T00:00:00Z",
            "basis": "記憶ベースの一次符号化（アシスタント）。確信のないセルは最初から裁定待ち。各行の「缶の画像を入れて表に追加」による画像再符号化で確定する"
          },
          "cb-pm": {
            "cells": {
              "A1": {
                "v": "青系",
                "v2": "青系",
                "status": "draft"
              },
              "A2": {
                "v": "金属",
                "v2": "金属",
                "status": "draft"
              },
              "A3": {
                "v": "紋章・エンブレム",
                "v2": "紋章・エンブレム",
                "status": "draft"
              },
              "A4": {
                "v": "静的",
                "v2": "静的",
                "status": "draft"
              },
              "A5": {
                "v": "中央シンメトリー",
                "v2": "中央シンメトリー",
                "status": "draft"
              },
              "A6": {
                "v": "なし",
                "v2": "なし",
                "status": "draft"
              },
              "A7": {
                "v": "面",
                "v2": "面",
                "status": "draft"
              },
              "A8": {
                "v": "欧文セリフ・装飾",
                "v2": "欧文セリフ・装飾",
                "status": "draft"
              }
            },
            "imageFile": null,
            "imageFileId": null,
            "agreement": 100,
            "encodedAt": "2026-07-06T00:00:00Z",
            "basis": "記憶ベースの一次符号化（アシスタント）。確信のないセルは最初から裁定待ち。各行の「缶の画像を入れて表に追加」による画像再符号化で確定する"
          },
          "cb-hare": {
            "cells": {
              "A1": {
                "v": "白・クリーム",
                "v2": "青系",
                "status": "needs-adjudication"
              },
              "A2": {
                "v": "金属",
                "v2": "マット",
                "status": "needs-adjudication"
              },
              "A3": {
                "v": "幾何・抽象",
                "v2": "幾何・抽象",
                "status": "draft"
              },
              "A4": {
                "v": "動的",
                "v2": "動的",
                "status": "draft"
              },
              "A5": {
                "v": "中央シンメトリー",
                "v2": "中央シンメトリー",
                "status": "draft"
              },
              "A6": {
                "v": "なし",
                "v2": "なし",
                "status": "draft"
              },
              "A7": {
                "v": "なし",
                "v2": "なし",
                "status": "draft"
              },
              "A8": {
                "v": "明朝・毛筆系",
                "v2": "明朝・毛筆系",
                "status": "draft"
              }
            },
            "imageFile": null,
            "imageFileId": null,
            "agreement": 75,
            "encodedAt": "2026-07-06T00:00:00Z",
            "basis": "記憶ベースの一次符号化（アシスタント）。確信のないセルは最初から裁定待ち。各行の「缶の画像を入れて表に追加」による画像再符号化で確定する"
          },
          "cb-ebisu": {
            "cells": {
              "A1": {
                "v": "金・琥珀",
                "v2": "金・琥珀",
                "status": "draft"
              },
              "A2": {
                "v": "金属",
                "v2": "金属",
                "status": "draft"
              },
              "A3": {
                "v": "紋章・エンブレム",
                "v2": "紋章・エンブレム",
                "status": "draft"
              },
              "A4": {
                "v": "静的",
                "v2": "静的",
                "status": "draft"
              },
              "A5": {
                "v": "中央シンメトリー",
                "v2": "中央シンメトリー",
                "status": "draft"
              },
              "A6": {
                "v": "なし",
                "v2": "なし",
                "status": "draft"
              },
              "A7": {
                "v": "面",
                "v2": "面",
                "status": "draft"
              },
              "A8": {
                "v": "欧文セリフ・装飾",
                "v2": "欧文セリフ・装飾",
                "status": "draft"
              }
            },
            "imageFile": null,
            "imageFileId": null,
            "agreement": 100,
            "encodedAt": "2026-07-06T00:00:00Z",
            "basis": "記憶ベースの一次符号化（アシスタント）。確信のないセルは最初から裁定待ち。各行の「缶の画像を入れて表に追加」による画像再符号化で確定する"
          },
          "cb-maruefu": {
            "cells": {
              "A1": {
                "v": "白・クリーム",
                "v2": "赤系",
                "status": "needs-adjudication"
              },
              "A2": {
                "v": "金属",
                "v2": "金属",
                "status": "draft"
              },
              "A3": {
                "v": "文字ロゴのみ",
                "v2": "文字ロゴのみ",
                "status": "draft"
              },
              "A4": {
                "v": "静的",
                "v2": "静的",
                "status": "draft"
              },
              "A5": {
                "v": "中央シンメトリー",
                "v2": "中央シンメトリー",
                "status": "draft"
              },
              "A6": {
                "v": "あり",
                "v2": "なし",
                "status": "needs-adjudication"
              },
              "A7": {
                "v": "線・縁",
                "v2": "線・縁",
                "status": "draft"
              },
              "A8": {
                "v": "明朝・毛筆系",
                "v2": "明朝・毛筆系",
                "status": "draft"
              }
            },
            "imageFile": null,
            "imageFileId": null,
            "agreement": 75,
            "encodedAt": "2026-07-06T00:00:00Z",
            "basis": "記憶ベースの一次符号化（アシスタント）。確信のないセルは最初から裁定待ち。各行の「缶の画像を入れて表に追加」による画像再符号化で確定する"
          },
          "cb-lager": {
            "cells": {
              "A1": {
                "v": "白・クリーム",
                "v2": "白・クリーム",
                "status": "draft"
              },
              "A2": {
                "v": "金属",
                "v2": "金属",
                "status": "draft"
              },
              "A3": {
                "v": "紋章・エンブレム",
                "v2": "紋章・エンブレム",
                "status": "draft"
              },
              "A4": {
                "v": "静的",
                "v2": "動的",
                "status": "needs-adjudication"
              },
              "A5": {
                "v": "中央シンメトリー",
                "v2": "横帯分割",
                "status": "needs-adjudication"
              },
              "A6": {
                "v": "なし",
                "v2": "なし",
                "status": "draft"
              },
              "A7": {
                "v": "線・縁",
                "v2": "線・縁",
                "status": "draft"
              },
              "A8": {
                "v": "明朝・毛筆系",
                "v2": "欧文セリフ・装飾",
                "status": "needs-adjudication"
              }
            },
            "imageFile": null,
            "imageFileId": null,
            "agreement": 62,
            "encodedAt": "2026-07-06T00:00:00Z",
            "basis": "記憶ベースの一次符号化（アシスタント）。確信のないセルは最初から裁定待ち。各行の「缶の画像を入れて表に追加」による画像再符号化で確定する"
          },
          "cb-hyoketsu": {
            "cells": {
              "A1": {
                "v": "銀白",
                "v2": "銀白",
                "status": "draft"
              },
              "A2": {
                "v": "金属",
                "v2": "金属",
                "status": "draft"
              },
              "A3": {
                "v": "幾何・抽象",
                "v2": "幾何・抽象",
                "status": "draft"
              },
              "A4": {
                "v": "動的",
                "v2": "動的",
                "status": "draft"
              },
              "A5": {
                "v": "中央シンメトリー",
                "v2": "中央シンメトリー",
                "status": "draft"
              },
              "A6": {
                "v": "なし",
                "v2": "なし",
                "status": "draft"
              },
              "A7": {
                "v": "なし",
                "v2": "なし",
                "status": "draft"
              },
              "A8": {
                "v": "角ゴシック系",
                "v2": "角ゴシック系",
                "status": "draft"
              }
            },
            "imageFile": null,
            "imageFileId": null,
            "agreement": 100,
            "encodedAt": "2026-07-06T00:00:00Z",
            "basis": "記憶ベースの一次符号化（アシスタント）。確信のないセルは最初から裁定待ち。各行の「缶の画像を入れて表に追加」による画像再符号化で確定する"
          },
          "cb-dryzero": {
            "cells": {
              "A1": {
                "v": "黒",
                "v2": "黒",
                "status": "draft"
              },
              "A2": {
                "v": "金属",
                "v2": "金属",
                "status": "draft"
              },
              "A3": {
                "v": "文字ロゴのみ",
                "v2": "文字ロゴのみ",
                "status": "draft"
              },
              "A4": {
                "v": "静的",
                "v2": "静的",
                "status": "draft"
              },
              "A5": {
                "v": "中央シンメトリー",
                "v2": "中央シンメトリー",
                "status": "draft"
              },
              "A6": {
                "v": "あり",
                "v2": "なし",
                "status": "needs-adjudication"
              },
              "A7": {
                "v": "なし",
                "v2": "なし",
                "status": "draft"
              },
              "A8": {
                "v": "角ゴシック系",
                "v2": "角ゴシック系",
                "status": "draft"
              }
            },
            "imageFile": null,
            "imageFileId": null,
            "agreement": 88,
            "encodedAt": "2026-07-06T00:00:00Z",
            "basis": "記憶ベースの一次符号化（アシスタント）。確信のないセルは最初から裁定待ち。各行の「缶の画像を入れて表に追加」による画像再符号化で確定する"
          },
          "cb-allfree": {
            "cells": {
              "A1": {
                "v": "白・クリーム",
                "v2": "白・クリーム",
                "status": "draft"
              },
              "A2": {
                "v": "金属",
                "v2": "マット",
                "status": "needs-adjudication"
              },
              "A3": {
                "v": "文字ロゴのみ",
                "v2": "写実（麦・泡・情景）",
                "status": "needs-adjudication"
              },
              "A4": {
                "v": "静的",
                "v2": "静的",
                "status": "draft"
              },
              "A5": {
                "v": "中央シンメトリー",
                "v2": "中央シンメトリー",
                "status": "draft"
              },
              "A6": {
                "v": "なし",
                "v2": "なし",
                "status": "draft"
              },
              "A7": {
                "v": "線・縁",
                "v2": "線・縁",
                "status": "draft"
              },
              "A8": {
                "v": "角ゴシック系",
                "v2": "角ゴシック系",
                "status": "draft"
              }
            },
            "imageFile": null,
            "imageFileId": null,
            "agreement": 75,
            "encodedAt": "2026-07-06T00:00:00Z",
            "basis": "記憶ベースの一次符号化（アシスタント）。確信のないセルは最初から裁定待ち。各行の「缶の画像を入れて表に追加」による画像再符号化で確定する"
          },
          "cb-yonayona": {
            "cells": {
              "A1": {
                "v": "白・クリーム",
                "v2": "茶",
                "status": "needs-adjudication"
              },
              "A2": {
                "v": "マット",
                "v2": "紙・布質感",
                "status": "needs-adjudication"
              },
              "A3": {
                "v": "写実（麦・泡・情景）",
                "v2": "写実（麦・泡・情景）",
                "status": "draft"
              },
              "A4": {
                "v": "静的",
                "v2": "静的",
                "status": "draft"
              },
              "A5": {
                "v": "全面図像",
                "v2": "全面図像",
                "status": "draft"
              },
              "A6": {
                "v": "なし",
                "v2": "なし",
                "status": "draft"
              },
              "A7": {
                "v": "なし",
                "v2": "なし",
                "status": "draft"
              },
              "A8": {
                "v": "明朝・毛筆系",
                "v2": "明朝・毛筆系",
                "status": "draft"
              }
            },
            "imageFile": null,
            "imageFileId": null,
            "agreement": 75,
            "encodedAt": "2026-07-06T00:00:00Z",
            "basis": "記憶ベースの一次符号化（アシスタント）。確信のないセルは最初から裁定待ち。各行の「缶の画像を入れて表に追加」による画像再符号化で確定する"
          },
          "cb-wilkinson": {
            "cells": {
              "A1": {
                "v": "銀白",
                "v2": "銀白",
                "status": "draft"
              },
              "A2": {
                "v": "金属",
                "v2": "金属",
                "status": "draft"
              },
              "A3": {
                "v": "文字ロゴのみ",
                "v2": "文字ロゴのみ",
                "status": "draft"
              },
              "A4": {
                "v": "静的",
                "v2": "静的",
                "status": "draft"
              },
              "A5": {
                "v": "中央シンメトリー",
                "v2": "中央シンメトリー",
                "status": "draft"
              },
              "A6": {
                "v": "なし",
                "v2": "なし",
                "status": "draft"
              },
              "A7": {
                "v": "なし",
                "v2": "なし",
                "status": "draft"
              },
              "A8": {
                "v": "欧文セリフ・装飾",
                "v2": "欧文セリフ・装飾",
                "status": "draft"
              }
            },
            "imageFile": null,
            "imageFileId": null,
            "agreement": 100,
            "encodedAt": "2026-07-06T00:00:00Z",
            "basis": "記憶ベースの一次符号化（アシスタント）。確信のないセルは最初から裁定待ち。各行の「缶の画像を入れて表に追加」による画像再符号化で確定する"
          },
          "cb-mitsuya": {
            "cells": {
              "A1": {
                "v": "白・クリーム",
                "v2": "緑系",
                "status": "needs-adjudication"
              },
              "A2": {
                "v": "金属",
                "v2": "金属",
                "status": "draft"
              },
              "A3": {
                "v": "紋章・エンブレム",
                "v2": "紋章・エンブレム",
                "status": "draft"
              },
              "A4": {
                "v": "静的",
                "v2": "静的",
                "status": "draft"
              },
              "A5": {
                "v": "中央シンメトリー",
                "v2": "中央シンメトリー",
                "status": "draft"
              },
              "A6": {
                "v": "なし",
                "v2": "なし",
                "status": "draft"
              },
              "A7": {
                "v": "なし",
                "v2": "なし",
                "status": "draft"
              },
              "A8": {
                "v": "角ゴシック系",
                "v2": "角ゴシック系",
                "status": "draft"
              }
            },
            "imageFile": null,
            "imageFileId": null,
            "agreement": 88,
            "encodedAt": "2026-07-06T00:00:00Z",
            "basis": "記憶ベースの一次符号化（アシスタント）。確信のないセルは最初から裁定待ち。各行の「缶の画像を入れて表に追加」による画像再符号化で確定する"
          },
          "cb-ayataka": {
            "cells": {
              "A1": {
                "v": "緑系",
                "v2": "緑系",
                "status": "draft"
              },
              "A2": {
                "v": "マット",
                "v2": "紙・布質感",
                "status": "needs-adjudication"
              },
              "A3": {
                "v": "文字ロゴのみ",
                "v2": "文字ロゴのみ",
                "status": "draft"
              },
              "A4": {
                "v": "静的",
                "v2": "静的",
                "status": "draft"
              },
              "A5": {
                "v": "中央シンメトリー",
                "v2": "縦帯分割",
                "status": "needs-adjudication"
              },
              "A6": {
                "v": "なし",
                "v2": "なし",
                "status": "draft"
              },
              "A7": {
                "v": "線・縁",
                "v2": "線・縁",
                "status": "draft"
              },
              "A8": {
                "v": "明朝・毛筆系",
                "v2": "明朝・毛筆系",
                "status": "draft"
              }
            },
            "imageFile": null,
            "imageFileId": null,
            "agreement": 75,
            "encodedAt": "2026-07-06T00:00:00Z",
            "basis": "記憶ベースの一次符号化（アシスタント）。確信のないセルは最初から裁定待ち。各行の「缶の画像を入れて表に追加」による画像再符号化で確定する"
          },
          "cb-onecup": {
            "cells": {
              "A1": {
                "v": "白・クリーム",
                "v2": "白・クリーム",
                "status": "draft"
              },
              "A2": {
                "v": "マット",
                "v2": "マット",
                "status": "draft"
              },
              "A3": {
                "v": "文字ロゴのみ",
                "v2": "文字ロゴのみ",
                "status": "draft"
              },
              "A4": {
                "v": "静的",
                "v2": "静的",
                "status": "draft"
              },
              "A5": {
                "v": "中央シンメトリー",
                "v2": "中央シンメトリー",
                "status": "draft"
              },
              "A6": {
                "v": "なし",
                "v2": "なし",
                "status": "draft"
              },
              "A7": {
                "v": "なし",
                "v2": "なし",
                "status": "draft"
              },
              "A8": {
                "v": "明朝・毛筆系",
                "v2": "明朝・毛筆系",
                "status": "draft"
              }
            },
            "imageFile": null,
            "imageFileId": null,
            "agreement": 100,
            "encodedAt": "2026-07-06T00:00:00Z",
            "basis": "記憶ベースの一次符号化（アシスタント）。確信のないセルは最初から裁定待ち。各行の「缶の画像を入れて表に追加」による画像再符号化で確定する"
          }
        },
        pairTest: { status:'pending', note:'全ペア弁別課題（3m相当で各2缶を見分ける差分がこのスキーマで記述できるか）は、符号化表が画像で埋まった後に実施。記述不能ペアが出れば属性を追加、未使用属性は削除' },
        notes: '符号化の原資料は各社公式の製品正面画像＋店頭の棚写真（要撮影: 並び・フェイス数・照明込みの真の環境）。符号化は同一画像を独立2回行い、不一致セルは人間が裁定。更新トリガーは対象集合内ブランドのリニューアル・新商品の上位進入。'
      },
      symbols: [
        { name:'麻の葉紋', verdict:'要再考', note:'鬼滅の刃・禰豆子の着物として認知が支配的→コラボ品/便乗品の誤読リスク。伝統的願意は「子供の健やかな成長」で大人の気枯れ浄化とズレる。代替: 青海波（永遠の平安・水）/ 流水文・観世水（禊=水による祓い）' },
        { name:'虎（白虎）', verdict:'条件付き可', note:'白虎=四神の西の守護・魔除け・邪気遮断で「気枯れを祓う」と正整合。条件: 縞を描かない/円形ロゴ化しない（阪神・寅年回避）/動勢のある姿態か端正な紋/様式は日本画・截金の系譜' },
        { name:'白（浄化の白）', verdict:'条件付き可', note:'ネットの「浄化」ビジュアルはパワーストーン系記号（紫グラデ・光の玉・オーラ）に汚染されており使用禁止。白は「張りと密度のある清浄の白」（奉書・素材の白）として運用。白×金（線）は棚の色相空白（王道7缶の占有色調査より）。誤認防止条項によりビール王道記号の併置が条件' },
        { name:'金', verdict:'条件付き可', note:'アサヒゴールドが「面の金」を占有。金は線・縁・截金に限定（白虎=金の元素とも整合）' },
        { name:'紺の毛筆ロゴ', verdict:'可', note:'綾鷹で実証済みの文法（シェア2%→20%）。緑茶可読との距離に注意（金属光沢・泡・ジョッキ写実でビール可読を担保）' }
      ],
      sources: [
        { name:'神社授与品・お守り', status:'合格', grammar:'織物の質感/組紐/白×紅×紺×金糸/奉書の白', transplant:'布織の地紋テクスチャ・糸の金', evidence:'「浄化」「祓い」を明示する授与品が八坂神社・神田明神等で日常的に流通・課金されている＝浄め語彙は生活文化', risk:'縁起物・土産物への誤読 → 缶フォーマット厳守で防波堤' },
        { name:'書の筆勢・日本画の動的表現（雲龍図の系譜）', status:'合格（サウナVIから付け替え）', grammar:'白地に走る一本の墨の動勢/余白と気配', transplant:'白虎の姿態と融合した動勢ストローク', evidence:'白虎の魔除け・邪気遮断の意味体系（記号監査に収載）と整合', risk:'書芸に寄ると日本酒コードに漂流 → 泡・生表記・金属光沢で引き戻す' },
        { name:'プレミアム緑茶（綾鷹）', status:'合格', grammar:'縦組み毛筆ロゴ+深色帯+金縁', transplant:'縦毛筆ロゴの運用/金の縁・線使い', evidence:'綾鷹のシェア2%→20%の実証', risk:'お茶に見える → ビール記号の併置' },
        { name:'サントリー天然水（自社資産）', status:'条件付き合格', grammar:'空気遠近法・光の乱反射・ロゴ不変（日経クロストレンド掲載の一次デザイン原則）', transplant:'白→淡青の透明感・水光', evidence:'RTB「清らかな天然水」と直結。2018年度清涼飲料販売数量No.1の市場到達力', risk:'ノンアル・清涼飲料誤認（誤認防止条項と晴れ風への批評）→ ビール記号併置が条件。山岳写実は天然水本体と混線するため禁止' },
        { name:'居酒屋ののれん', status:'条件付き合格（銭湯から構造のみ継承）', grammar:'のれん=上下二界を分け、くぐることで気分が切り替わる装置', transplant:'缶面の界構造', evidence:'翠の居酒屋境界再定義236%の実証、Stella「The Purification」儀式の前例', risk:'解読失敗＝奇抜・限定品化。攻め端の参照点として運用' },
        { name:'サウナ施設VI', status:'不合格（記録として保持）', grammar:'湯気・温冷・ととのい', transplant:'なし', evidence:'', risk:'飲酒×サウナは前後どちらの順序でも生理的禁忌（血圧乱高下・脱水）。自主基準の「スポーツ時・入浴時飲酒の推奨誘発」（自主基準の禁止列挙）に直接該当し得るため棄却。「動」の役割は雲龍図系譜が引き継いだ' },
        { name:'銭湯・入浴文化', status:'不合格（のれんのみ継承）', grammar:'湯・レトロポップ', transplant:'なし', evidence:'', risk:'入浴×飲酒も同型の禁忌' }
      ],
      prohibitions: [
        'スピリチュアル商材の記号（紫グラデーション・光の玉・オーラ・パワーストーン的表現）の禁止',
        '効能・回復・デトックス・健康増進を示唆する語と身体表現の禁止（心理的浄化=情緒としてのみ）',
        'サウナ・入浴・運動直後など飲酒禁忌オケージョンの描写禁止',
        '喉元のアップ・ゴクゴク飲む描写の禁止（静止画KVにも準用）',
        '25歳未満に見える人物の起用禁止',
        '清涼飲料・炭酸水に誤認される表現の禁止: 白・水色基調の場合は必ずビール王道記号（金属光沢/泡/麦芽/大型ロゴ）を併置',
        '限定品コード（過剰な季節記号・キャラクターコラボ風あしらい）の禁止',
        '神聖表現の茶化し・パロディの禁止',
        '縞のある虎・円形の虎紋章の禁止',
        '面で使う金の禁止（金は線・縁・截金に限定）'
      ],
      regulations: {
        basis: '酒類の広告・宣伝及び酒類容器の表示に関する自主基準。禁止表現リストと清涼飲料誤認防止条項の内容は酒類の広告審査委員会の現行掲載で確認済み（最終改正日はリーガルチェック時に最新版を要確認）',
        canDesign: '缶体設計に最初から織り込む表示: 純アルコール量（g・6ポイント以上）/ 健康注意文言 / 20歳未満飲酒禁止表記。モチーフと余白はこの表示面積を確保した上で設計する',
        vocab: [
          { term:'「浄化」「祓う」「清め」「神聖な一杯」「澄む」', verdict:'使用可', basis:'自主基準の禁止列挙外。ただし健康・体調回復・機能効用を想起させる文脈との併記は不可' },
          { term:'「120年のブレンド技術」「匠」等のRTB表現', verdict:'使用可（裏付け保持が要件）', basis:'景表法優良誤認回避のため製法記録の裏付けを整備。綾鷹の上林春松訴求という先行実例あり' },
          { term:'清涼感に振れた白・水色基調、季節・限定強調の意匠', verdict:'条件付き', basis:'誤認防止条項＋晴れ風への批評。ビール王道記号の併置で引き戻す' },
          { term:'「体調が整う」「疲労回復」「デトックス」等の身体効用', verdict:'使用不可', basis:'自主基準の趣旨・景表法・健康増進法' },
          { term:'イッキ・過度飲酒想起、喉元描写、入浴/スポーツ時飲酒', verdict:'使用不可', basis:'自主基準に明示列挙' }
        ]
      }
    },

    /* ===== 第4段: 方向 = 解釈の命題（4変数すべてを命題から導出） ===== */
    directions: [
      _dirSeed('sumi-s0','sumitora','S-0 統制「澄虎、そのまま」', null, {
        label:'基準', proposition:'祓いを様式化しない。現代の定番の文法と「澄虎」という名前だけで語る。',
        bet:'「祓い」の物語装飾がなくても、澄んだ味の実感と名前の強さだけで選ばれる——生活者は棚で結局「うまそうで間違いなさそうな新しい定番」を選んでいる、という読み。翠が漢字一字の語感を核に缶目標比158%を作った実証がこの読みを支える。',
        aim:'視覚の差分をゼロにし、ネーミングとロゴだけの運搬力を測る基準案。',
        coding:{A1:'銀白',A2:'金属',A3:'文字ロゴのみ',A4:'静的',A5:'中央シンメトリー',A6:'なし',A7:'線・縁',A8:'明朝・毛筆系'}, codingBasis:'設計書（4変数の決定とsystem）から同一スキーマで符号化。画像確定後にAI再符号化で検証',
        decisions:[
          { decision:'4変数すべてを棚の共通条件（銀白金属・中央対称・王道写実・静的紋章）に置き、非王道要素は紺毛筆ロゴ「澄虎」と小さな白虎紋のみとする。',
            seek:'棚では完全に「ど真ん中のビール」に見え、名前を読んだ瞬間にだけ「澄」が立ち上がる。',
            evidence:'サントリー翠は漢字一字の語感を核に缶が目標比158%・日経トレンディ酒類部門大賞となり、名前自体が差分を運べることを実証。澄虎は綾鷹と同じ「清らかさ×力強さ」の掛け合わせ構造を持つ。' },
          { decision:'この案を全調査の統制条件（基準線）とする。',
            seek:'他案の新しさスコアとの差＝「様式化の寄与量」の直接測定。',
            evidence:'パッケージ調査の定石は絶対評価→相対評価＋要素分解（アスマーク・INTAGEの調査設計解説）。統制があって初めて様式の効果と名前の効果を分離できる。' }
        ],
        glance:'銀の金属地に紺毛筆「澄虎」。視覚上は王道そのもの。',
        measurement:'新しさ・購入意向の基準値。他案との差＝様式化の寄与量。',
        ledger:{ keeps:[{code:'地の金属光沢',note:'王道文法一式を全て維持'},{code:'中央対称構図'},{code:'泡・麦の写実'}], breaks:[], note:'破るコードなし＝基準線。共有数は目録の符号化完了後に確定' },
        system:{ palette:[{hex:'#D9DCE0',name:'銀'},{hex:'#1B2A5E',name:'紺'},{hex:'#B79A4B',name:'金線'}], motif:'小さな端正な白虎紋（縞なし・円形にしない）', typography:'紺の毛筆縦組み+細身欧文', composition:'完全対称・中央ロゴブロック', finish:'王道の金属光沢', tone:'ど真ん中・実直' },
        prompts:{
          board:'Brand worldview moodboard, 16:9 collage, theme: the honest mainstream Japanese beer life. Brushed silver aluminum, golden barley, crisp foam macro, izakaya counter at evening, quiet living room after work, vertical navy brush calligraphy specimen, palette chips (#D9DCE0,#1B2A5E,#B79A4B). Trustworthy, dignified-ordinary. NO beer cans, no bottles, no glasses of beer, no invented brand names, no logo lockups or label mockups. Editorial moodboard layout.',
          package:'Photorealistic 350ml Japanese beer can, front view, 3:4. All foam, barley and liquid imagery is PRINTED label artwork on the can surface — never real foam or liquid on or around the can. Classic brushed silver metallic ground, completely conventional mainstream layout. Center: large vertical brush logo 澄虎 in deep navy, SUMITORA in slim serif below, one small white tiger crest in fine gold lines. Symmetric, premium studio light, strong metallic sheen, condensation. Must look like it has always been on the mainstream shelf. Mandatory labels in conventional positions: 麦芽100% / ラガー×エール ブレンド / 生ビール（非熱処理）, ALC.5%, 純アルコール量14g, お酒 mark.',
          kv:'Advertising banner key visual comp, 16:9. Product hero: the silver-and-navy 350ml beer can (match the attached can reference EXACTLY if provided) on a warm wooden kitchen counter, condensation, crisp studio light. Left two-thirds: clean copy space on softly blurred warm-evening-home backdrop, large Japanese headline placeholder 「まっすぐ、うまい。」, small brand logo block bottom right. Polished ad banner finish. No people.'
        }
      }, {control:true, risks:[]}),

      _dirSeed('sumi-s1','sumitora','S-1 自然の様式「水源の澄」', null, {
        label:'基準執行', proposition:'澄みとは、水源の風景である。',
        executionLabel:'図像で語る — 観世水と虎',
        bet:'気枯れた人が「浄化」に対して持つ最も普遍的なイメージは水である——シャワーで流す、冷たい水を飲んで落ち着く、という実在の行動が既にある。浄化を宗教でなく自然の語彙で言えば誰も排除しない、という読み。清冽な水のイメージが飲料市場で機能し続けてきた実績（天然水系）が支える。',
        aim:'祓いの表現を自然（水源）の文化系から取り、色・素材・図像・構図の4変数すべてを「水源の風景」から一貫導出する案。',
        coding:{A1:'青系',A2:'金属',A3:'幾何・抽象',A4:'静的',A5:'中央シンメトリー',A6:'あり',A7:'なし',A8:'明朝・毛筆系'}, codingBasis:'設計書（4変数の決定とsystem）から同一スキーマで符号化。画像確定後にAI再符号化で検証',
        decisions:[
          { decision:'V1 支配色: 地を白から淡青への透明グラデーションにする。泡・麦芽の写実と「生ビール」表記を通常より大きく併置する。',
            seek:'雑味のない冷たい水の透明感が、缶を見た瞬間の体感として立つ。',
            evidence:'業界自主基準は缶体色彩の清涼飲料誤認防止を義務付け、晴れ風には実際に「清涼飲料に見える」批評が付いた（01 調査に出典収載）。よって淡青の採用はビール記号の増強を条件とする。' },
          { decision:'V2 素材感: 金属光沢を消さず、水面の反射光として運用する（光沢の意味を「金属」から「水面」に読み替える）。',
            seek:'王道の光沢コードを維持したまま、質感が水を語る。',
            evidence:'地の光沢は王道缶が共有する棚の慣習（コード目録A2で符号化中）。コードを破らず意味だけ差し替える操作なので、2秒棚のビール可読を保てる。' },
          { decision:'V3 図像: 観世水（伝統的な水文）の細い水紋と、流れのほとりに立つ白虎を組み合わせる。',
            seek:'「清流」の既存語彙で水源が読め、白虎（邪気を祓う守護神）が祓いの意味を接続する。',
            evidence:'観世水は着物・工芸で連綿と使われる水の定型文であり解読コストが低い。白虎の魔除け・清浄の意味体系は記号監査に収載済み。' },
          { decision:'V4 構図: 低い水平線と水平分割の静けさで組む。ロゴは中央を維持。',
            seek:'風景としての静けさが構図から伝わる。',
            evidence:'水平構図の静性は視覚表現の通説であり、この案では通説を検証仮説として扱い2秒識別テストで測る。中央ロゴは王道構図コードの維持。' }
        ],
        glance:'白から淡青へ沈む缶。水紋と虎。5案で最も「冷たい」。',
        measurement:'冷涼感・雑味のなさの体感スコアと、ビール/清涼飲料の帰属正答率。',
        ledger:{ keeps:[{code:'地の光沢（水面反射として維持）'},{code:'泡・麦の写実（増強）'},{code:'中央ロゴ構図'}],
          breaks:[{code:'地の色相域＝銀白・金系', hypothesis:'淡青の地はビール可読を落とし、清涼飲料・無糖チューハイ側に誤帰属される恐れ', measure:'2秒棚識別テスト＋氷結・ウィルキンソンを混ぜた帰属質問（誤読リスク台帳の対照缶）'}],
          note:'共有数は目録の符号化完了後に確定' },
        system:{ palette:[{hex:'#F4F7F9',name:'白'},{hex:'#BFD9E6',name:'淡青'},{hex:'#1B2A5E',name:'紺'}], motif:'観世水の水紋と、流れのほとりの白虎', typography:'紺の毛筆縦組み', composition:'低い水平線・水平分割・中央ロゴ', finish:'水面の反射光を帯びた金属光沢', tone:'冷たく静かで澄んでいる' },
        prompts:{
          board:'Brand worldview moodboard, 16:9 collage, theme: the spring-water source of clarity. Mountain stream macro, clear ripples over pebbles, seigaiha water pattern specimen, pale-blue gradient sky at dawn, condensation on glass, a white tiger standing at a stream (japanese painting style), palette chips (#F4F7F9,#BFD9E6,#1B2A5E). Cold, quiet, pure. NO beer cans, no bottles, no glasses of beer, no invented brand names, no logo lockups or label mockups. Editorial moodboard layout.',
          package:'Photorealistic 350ml Japanese beer can, front view, 3:4. All foam, barley and liquid imagery is PRINTED label artwork on the can surface — never real foam or liquid on or around the can. Ground: PURE WHITE (not blue — the blue-gradient execution is a separate design), metallic sheen as subtle water-light. Fine indigo seigaiha water ripple lines printed on the white, a small white tiger standing by a stream in fine line art. Low horizon feel, calm horizontal division, large vertical navy brush logo 澄虎 centered. EXTRA-LARGE beer identity anchors: realistic foam head, barley, clearly legible 生ビール. Mandatory labels in conventional positions: 麦芽100% / ラガー×エール ブレンド / 生ビール（非熱処理）, ALC.5%, 純アルコール量14g, お酒 mark.',
          kv:'Advertising banner key visual comp, 16:9. Product hero: the white-to-pale-blue 350ml beer can (match the attached can reference EXACTLY if provided) standing on a wet reflective surface with clear water-light ripples, condensation. Left two-thirds: airy white copy space with cold light refractions, large Japanese headline placeholder 「澄む、一杯。」, clearly legible 生ビール note near the product, small logo block bottom right. Fresh clean ad banner finish. No people. Must read as beer, never as sparkling water.'
        }
      }, {control:false, risks:['清涼飲料誤認']}),

      _dirSeed('sumi-s2','sumitora','S-2 神事の様式「祈りの白」', null, {
        label:'基準執行', proposition:'祓いとは、白い儀式である。',
        executionLabel:'図像で語る — 截金の虎紋',
        bet:'生活者は今も、初詣・お祓い・厄除け・盛り塩といった神事的行為で「気持ちの区切り」を買っている——宗教心ではなくリセットの道具として。祓いの原義に最も忠実な解釈が、その既存行動の上にそのまま乗る、という読み。',
        aim:'祓いの表現を神事の文化系から取り、4変数すべてを「白い儀式」から一貫導出する案。',
        coding:{A1:'白・クリーム',A2:'紙・布質感',A3:'紋章・エンブレム',A4:'静的',A5:'中央シンメトリー',A6:'あり',A7:'線・縁',A8:'明朝・毛筆系'}, codingBasis:'設計書（4変数の決定とsystem）から同一スキーマで符号化。画像確定後にAI再符号化で検証',
        decisions:[
          { decision:'V1 支配色: 奉書の白を地とし、金は糸の細線に限定する。',
            seek:'神聖さが「密度のある白」として立つ。白×金（線）は棚の色相空白。',
            evidence:'王道7缶の占有色調査（01 調査）で白×金線の組は空白。金を面にしないのはアサヒゴールドの先客回避（記号監査）。' },
          { decision:'V2 素材感: 地を金属から奉書・織物の紙布質感に置き換える。ただし和素材の総量に上限規律を敷く。',
            seek:'触感で「儀式の白」が伝わる。',
            evidence:'湖池屋プライドポテト2017は和素材過多のパッケージが2秒の棚で敗北しリニューアルで回復した実証（01 調査に収載）。量の規律はこの前例から導出。' },
          { decision:'V3 図像: 白虎紋を日本画・截金の系譜で様式化する。光の玉・オーラ等のスピリチュアル記号は使用禁止。',
            seek:'神聖が工芸の格として読める（パワーストーン系に落ちない）。',
            evidence:'禁止則は自主基準（健康効用の想起防止）から導出。截金は仏教美術の実在系譜で格の裏付けがある。' },
          { decision:'V4 構図: 結界の中央対称で組む。王道の対称コードをそのまま神事の文法として読み替える。',
            seek:'構図コードを破らずに儀式性を獲得する。',
            evidence:'中央対称は王道缶の共有慣習（目録A5で符号化中）であり、同時に神前の左右対称と同型。破らない差分。' }
        ],
        glance:'紙のように白い缶に金の糸。静かで神聖。',
        measurement:'神聖・清められる感の体感スコアと、縁起物・授与品への誤読率。',
        ledger:{ keeps:[{code:'中央対称構図（結界として読み替え）'},{code:'泡・麦の写実（帯で維持）'}],
          breaks:[{code:'地の光沢＝金属', hypothesis:'紙布の白は縁起物・土産物、またはクラフトに誤読される恐れ', measure:'自由連想＋「自分で飲む/贈答」の用途二択（台帳の調査測定）＋よなよな対照の帰属質問'}],
          note:'共有数は目録の符号化完了後に確定' },
        system:{ palette:[{hex:'#F6F3EC',name:'奉書白'},{hex:'#1B2A5E',name:'紺'},{hex:'#B79A4B',name:'金糸'}], motif:'截金様式の白虎紋', typography:'紺の毛筆縦組み・細金の欧文', composition:'結界の完全中央対称', finish:'織・奉書の密度ある白（紙布質感）', tone:'静謐・神聖・端正' },
        prompts:{
          board:'Brand worldview moodboard, 16:9 collage, theme: the white ritual of purification. Washi hosho paper macro, woven white fabric, kirikane gold-leaf line craft, shrine morning light, folded white paper streamers abstracted, a dignified white tiger crest in kirikane style, palette chips (#F6F3EC,#1B2A5E,#B79A4B). Serene, sacred, precise. NO beer cans, no spiritual glow orbs. Editorial moodboard layout.',
          package:'Photorealistic 350ml Japanese beer can, front view, 3:4. All foam, barley and liquid imagery is PRINTED label artwork on the can surface — never real foam or liquid on or around the can. Ground: dense hosho-paper white with a subtle woven fabric relief, thin gold thread lines as borders only. A white tiger crest in kirikane (gold line inlay) style. Perfectly symmetric composition, large vertical navy brush logo 澄虎 centered. A clean band keeps realistic foam and barley for beer identity. Mandatory labels in conventional positions: 麦芽100% / ラガー×エール ブレンド / 生ビール（非熱処理）, ALC.5%, 純アルコール量14g, お酒 mark.',
          kv:'Advertising banner key visual comp, 16:9. Product hero: the paper-white 350ml beer can with fine gold thread lines (match the attached can reference EXACTLY if provided) standing on white woven fabric, soft warm light. Left two-thirds: quiet hosho-white copy space, large Japanese headline placeholder 「今日を、清める。」, small logo block bottom right. Serene dignified ad banner finish. No people.'
        }
      }, {control:false, risks:['和過多','クラフト・ニッチ']}),

      _dirSeed('sumi-s3','sumitora','S-3 気迫の様式「白虎の墨勢」', null, {
        label:'基準執行', proposition:'祓いとは、一閃の墨である。',
        executionLabel:'構図で語る — 対角の一閃',
        bet:'気枯れの実感は「侵食される」という受け身であり、欲しいのは癒しではなく断ち切る強さだ、という読み。ストロング系・エナジー系が担ってきた「効く感」の需要を、濁った強さでなく澄んだ強さで言い換えて取りに行く。',
        aim:'祓いの表現を気迫（書と日本画の動勢）の文化系から取り、4変数を「一閃の墨」から一貫導出する案。',
        coding:{A1:'銀白',A2:'金属',A3:'幾何・抽象',A4:'動的',A5:'全面図像',A6:'あり',A7:'なし',A8:'明朝・毛筆系'}, codingBasis:'設計書（4変数の決定とsystem）から同一スキーマで符号化。画像確定後にAI再符号化で検証',
        decisions:[
          { decision:'V1 支配色: 銀白の地に墨黒。コントラストで気迫を作り、地色は王道に留める。',
            seek:'強さが色数でなく明度差で立つ。',
            evidence:'地の色相を動かさないのは、色コードを破る役はS-1に分離されているため（幅のポートフォリオ設計）。' },
          { decision:'V2 素材感: 金属光沢を維持し、墨の艶（濡れた黒の反射）を重ねる。',
            seek:'光沢コードの上に墨の物質感が乗る。',
            evidence:'光沢は王道の共有慣習（目録A2）。墨の艶は書の実物観察に基づく質感で、金属と両立する。' },
          { decision:'V3 図像: 缶面に一筆の墨勢を走らせ、その中に白虎の姿態を融合する。雲龍図の系譜。',
            seek:'動勢が「邪気を斬る」気迫として読める。',
            evidence:'白虎の魔除け・邪気遮断の意味体系（記号監査に収載）と、書・日本画の動的表現の系譜（雲龍図）に接続。書芸に寄り過ぎると日本酒コードに漂流するため、泡・生表記・金属光沢で引き戻す条件付き。' },
          { decision:'V4 構図: 対角の動勢構図。ロゴブロックは可読の定位置を死守する。',
            seek:'動きの中でも2秒の可読が壊れない。',
            evidence:'必須表示の可読は規制由来の絶対条件。動勢と可読の両立は本案の検証対象。' }
        ],
        glance:'銀の缶を一閃の墨が走る。最も強い。',
        measurement:'力強さ・祓いの体感スコアと、日本酒への誤帰属率。',
        ledger:{ keeps:[{code:'地の色相＝銀白'},{code:'地の金属光沢'},{code:'泡・生表記（酒種の錨）'}],
          breaks:[{code:'図像の静的紋章', hypothesis:'墨の書芸様式は日本酒・高級酒コードに漂流する恐れ', measure:'ワンカップ大関を混ぜた帰属質問（台帳の対照缶）＋2秒識別テスト'}],
          note:'共有数は目録の符号化完了後に確定' },
        system:{ palette:[{hex:'#E8EAED',name:'銀白'},{hex:'#14161A',name:'墨黒'},{hex:'#1B2A5E',name:'紺'}], motif:'一筆の墨勢と融合した白虎の姿態（雲龍図の系譜）', typography:'力のある毛筆・紺', composition:'対角の動勢・ロゴ定位置死守', finish:'金属光沢＋墨の艶', tone:'静かに強い' },
        prompts:{
          board:'Brand worldview moodboard, 16:9 collage, theme: one sweeping stroke of ink as purification. Sumi ink stroke macro on silver-white, ink in water, a white tiger mid-motion fused with a brush stroke (unryu-zu lineage), calligraphy tools, palette chips (#E8EAED,#14161A,#1B2A5E). Kinetic yet minimal. NO beer cans, no bottles, no glasses of beer, no invented brand names, no logo lockups or label mockups. Editorial moodboard layout.',
          package:'Photorealistic 350ml Japanese beer can, front view, 3:4. All foam, barley and liquid imagery is PRINTED label artwork on the can surface — never real foam or liquid on or around the can. Ground: bright silver-white metallic. One powerful diagonal sumi ink stroke sweeps the face, a white tiger body fused inside the stroke. Strong metallic sheen plus wet-ink gloss. Logo block 澄虎 in navy brush at its conventional position, fully legible. Realistic foam and 生ビール kept prominent as beer anchors. Mandatory labels in conventional positions: 麦芽100% / ラガー×エール ブレンド / 生ビール（非熱処理）, ALC.5%, 純アルコール量14g, お酒 mark.',
          kv:'Advertising banner key visual comp, 16:9. Product hero: the silver-white 350ml beer can with a sumi stroke (match the attached can reference EXACTLY if provided), dramatic side light, condensation. Behind the copy space: one sweeping ink brush stroke on silver-white. Large Japanese headline placeholder 「静かに、強い。」, small logo block bottom right. High-contrast minimal ad banner finish. No people.'
        }
      }, {control:false, risks:['書芸漂流']}),

      _dirSeed('sumi-s4','sumitora','S-4 所作の様式「のれんの境」', null, {
        label:'基準執行', proposition:'祓いとは、のれんをくぐる所作である。',
        executionLabel:'構図で語る — 上下二界',
        bet:'気枯れの正体は「オンが切れないこと」。人は帰り道の一杯、のれんをくぐる、部屋着に着替えるという所作で毎日自分を切り替えている——その実在の所作に祓いを接続する、という読み。翠が居酒屋の境界の再定義で前年比236%を作った実証が支える。',
        aim:'祓いの表現を日常の所作（境界をくぐって切り替わる）の文化系から取り、4変数を「のれんの境」から一貫導出する、幅の攻め端。',
        coding:{A1:'青系',A2:'紙・布質感',A3:'紋章・エンブレム',A4:'静的',A5:'横帯分割',A6:'あり',A7:'なし',A8:'明朝・毛筆系'}, codingBasis:'設計書から符号化。金は本案に存在しない（藍×白の染物。金は神事S-2の専有語彙）。画像確定後にAI再符号化で検証',
        decisions:[
          { decision:'V1 支配色: 藍紺の染色と白。のれんの実在の色彙から取る。',
            seek:'日常の道具の色として親密に読める。',
            evidence:'藍染めののれんは飲食の入口の実在慣習であり、色の出典が生活の中にある。' },
          { decision:'V2 素材感: 染布のマット。金属光沢を布に譲る。',
            seek:'布の質感が「くぐる」体感を予告する。',
            evidence:'翠ジンは居酒屋の境界を再定義して前年比236%、Stella Artoisは注ぎの儀式（The Purification）をブランド資産化した——「所作の様式化」が市場で機能する前例。' },
          { decision:'V3 図像: 抜染（白抜き）の虎紋をのれんの上界に置く。',
            seek:'のれんの文法そのままに虎が座る。',
            evidence:'抜染紋はのれんの実在技法。白虎の意味体系（記号監査収載）と同居できる。' },
          { decision:'V4 構図: 上下二界。上は藍ののれん、中央のスリットから下界の王道記号（金属・泡・表記）が覗く。王道記号は圧縮しても最小可読サイズを死守。',
            seek:'「くぐる前／くぐった後」が1缶で読める。',
            evidence:'中央対称コードを最も大きく破る案であり、解読失敗＝限定品誤読の位置を測る計器を兼ねる（晴れ風批評と同型のリスク、戦略の最重要注意点）。' }
        ],
        glance:'缶の上半分がのれん。最も遠く、最も物語る。',
        measurement:'切り替わり・祓いの体感スコアと、「定番/期間限定」の帰属二択。',
        ledger:{ keeps:[{code:'下界に王道記号一式（圧縮して維持）'}],
          breaks:[{code:'中央対称構図', hypothesis:'二界構図は解読失敗＝限定品・変わり種に誤読される恐れ', measure:'「定番/期間限定どちらに見えるか」二択＋想定購入頻度（台帳の調査測定）'},{code:'地の金属光沢', hypothesis:'布地はビール可読を下げる恐れ', measure:'2秒棚識別テスト'}],
          note:'共有数は目録の符号化完了後に確定' },
        system:{ palette:[{hex:'#1F2C55',name:'藍紺'},{hex:'#F5F4EF',name:'白'},{hex:'#D9DCE0',name:'銀（下界）'}], motif:'のれん・抜染の白虎紋', typography:'抜染の白毛筆', composition:'上下二界・中央スリット', finish:'染布のマット（下界は金属）', tone:'親密で、くぐると変わる' },
        prompts:{
          board:'Brand worldview moodboard, 16:9 collage, theme: passing through the noren to switch the self. Indigo-dyed noren fabric macro, a warm light slit between fabric panels, izakaya entrance at dusk, resist-dyed white crest technique, hands parting fabric, palette chips (#1F2C55,#F5F4EF,#B79A4B). Cinematic cold/warm split. NO beer cans, no bottles, no glasses of beer, no invented brand names, no logo lockups or label mockups. Editorial moodboard layout.',
          package:'Photorealistic 350ml Japanese beer can, front view, 3:4. All foam, barley and liquid imagery is PRINTED label artwork on the can surface — never real foam or liquid on or around the can. Two-world composition: upper two-thirds is indigo dyed noren fabric with a resist-dyed white tiger crest and white brush logo 澄虎; a bright central slit reveals the lower world: conventional metallic beer ground with realistic foam, barley and all mandatory texts at minimum legible size, clearly readable. Mandatory labels in conventional positions: 麦芽100% / ラガー×エール ブレンド / 生ビール（非熱処理）, ALC.5%, 純アルコール量14g, お酒 mark.',
          kv:'Advertising banner key visual comp, 16:9. Product hero: the indigo-noren 350ml beer can (match the attached can reference EXACTLY if provided) standing in a slit of warm light between two indigo fabric panels. Copy space on the fabric: large resist-dyed white Japanese headline placeholder 「くぐって、切り替える。」, small logo block bottom right. Cinematic cold/warm split light. Crafted ad banner finish. No people.'
        }
      }, {control:false, risks:['解読失敗']}),

      _dirSeed('blend-b0','blended','B-0 統制「調律、そのまま」', null, {
        label:'基準', proposition:'調律を様式化しない。定番の文法と「季節ベストバランス」の言葉だけで語る。',
        fixedVars: BLEND_FIXED,
        bet:'「季節ベストバランス」という機能の約束は、装飾なしの言葉だけで十分に強い、という読み。統制条件を兼ねる。',
        aim:'ブレンデッド側の統制条件。',
        coding:{A1:'金・琥珀',A2:'金属',A3:'写実（麦・泡・情景）',A4:'静的',A5:'中央シンメトリー',A6:'あり',A7:'面',A8:'角ゴシック系'}, codingBasis:'設計書（4変数の決定とsystem）から同一スキーマで符号化。画像確定後にAI再符号化で検証',
        decisions:[
          { decision:'4変数すべてを共通条件に置き、差分は「季節ベストバランス」の一行と小さなブレンド比表記のみとする。',
            seek:'言葉だけで「間違いのなさ」が立つかの基準線。',
            evidence:'統制条件の必要性はパッケージ調査の定石（絶対→相対・要素分解）から。' }
        ],
        glance:'金と白の王道缶に「季節ベストバランス」の一行。',
        measurement:'安心感・購入意向の基準値。',
        ledger:{ keeps:[{code:'王道文法一式'}], breaks:[], note:'基準線' },
        system:{ palette:[{hex:'#E8D9A8',name:'金'},{hex:'#FFFFFF',name:'白'},{hex:'#8A6D2F',name:'焦金'}], motif:'麦芽の写実', typography:'骨太ゴシック+明朝', composition:'中央対称', finish:'王道の金属光沢', tone:'誠実・堂々' },
        prompts:{
          board:'Brand worldview moodboard, 16:9 collage, theme: the trustworthy everyday best. Golden barley field, brewery copper kettle, a calm dinner table, four-seasons diptych of the same living room, palette chips (#E8D9A8,#FFFFFF,#8A6D2F). Warm, reliable. NO beer cans, no bottles, no glasses of beer, no invented brand names, no logo lockups or label mockups. Editorial moodboard layout.',
          package:'Photorealistic 350ml Japanese beer can, front view, 3:4. All foam, barley and liquid imagery is PRINTED label artwork on the can surface — never real foam or liquid on or around the can. Conventional gold-and-white mainstream beer design, realistic barley and foam, bold logo, one quiet line 季節ベストバランス and a small blend-ratio note. Premium studio light, strong metallic sheen. Mandatory labels in conventional positions: 麦芽100% / ラガー×エール ブレンド / 生ビール（非熱処理）, ALC.5%, 純アルコール量14g, お酒 mark.',
          kv:'Advertising banner key visual comp, 16:9. Product hero: the gold-and-white 350ml beer can (match the attached can reference EXACTLY if provided) on a warm wood counter, golden barley bokeh backdrop. Left two-thirds: clean copy space, large Japanese headline placeholder 「季節に、調律。」, small seasonal ratio note, logo block bottom right. Trustworthy warm ad banner finish. No people.'
        }
      }, {control:true, risks:[]}),

      _dirSeed('blend-b1','blended','B-1 老舗の様式「深紺の帯」', null, {
        label:'基準執行', proposition:'調律とは、暖簾の信用である。',
        fixedVars: BLEND_FIXED,
        executionLabel:'構図で語る — 縦帯',
        bet:'「間違いない一本」を選ぶとき、生活者が最終的に信じるのは歴史と暖簾である、という読み。プレモル・ヱビスの格の文法が機能し続けている市場実績と、綾鷹のシェア2%→20%の実証が支える。',
        aim:'調律の権威を老舗（暖簾と格）の文化系から取り、4変数を一貫導出する案。',
        coding:{A1:'銀白',A2:'金属',A3:'紋章・エンブレム',A4:'静的',A5:'縦帯分割',A6:'あり',A7:'線・縁',A8:'明朝・毛筆系'}, codingBasis:'設計書（4変数の決定とsystem）から同一スキーマで符号化。画像確定後にAI再符号化で検証',
        decisions:[
          { decision:'V1 支配色: 白銀の地に深紺の帯と金の縁線。',
            seek:'格が色で立つ。',
            evidence:'綾鷹は縦毛筆×深色帯×金縁の格文法でシェア2%→20%を実証。ただし同文法は緑茶プレミアムの意匠と近接するため、泡・麦芽の写実増強でビール可読を守る条件付き。' },
          { decision:'V2 素材感: 高光沢に漆調の深みを重ねる。',
            seek:'塗りの深さが老舗の手入れを語る。',
            evidence:'光沢コード（目録A2）の維持＋漆器の実在質感からの導出。' },
          { decision:'V3 図像: 麦を家紋様式にしたエンブレム。',
            seek:'紋章コードの内側で「家」の物語を新調する。',
            evidence:'紋章・エンブレムは王道缶の共有慣習（目録A3で符号化中）。家紋化は慣習内の差分。' },
          { decision:'V4 構図: 縦帯の正統構図。ロゴは帯の中の定位置。',
            seek:'暖簾＝縦の布の記憶と構図が同型になる。',
            evidence:'縦帯分割は目録A5の水準の一つ。帯幅の適量は本案の検証対象。' }
        ],
        glance:'白銀に深紺の帯。最も重厚。',
        measurement:'格・間違いのなさスコアと、緑茶への誤帰属率。',
        ledger:{ keeps:[{code:'高光沢'},{code:'紋章図像（家紋化）'},{code:'泡・麦の写実（増強）'}],
          breaks:[{code:'地の色相＝金・銀系（紺帯の拡大）', hypothesis:'紺×金は緑茶プレミアム意匠に近接し「お茶に見える」恐れ', measure:'綾鷹を混ぜた帰属質問（台帳の対照缶）＋2秒識別テスト'}],
          note:'共有数は目録の符号化完了後に確定' },
        system:{ palette:[{hex:'#EDEDEA',name:'白銀'},{hex:'#152447',name:'深紺'},{hex:'#B79A4B',name:'金縁'}], motif:'麦の家紋化エンブレム', typography:'縦毛筆＋格式の明朝', composition:'縦帯の正統・帯内ロゴ', finish:'高光沢＋漆調の深み', tone:'重厚・信用' },
          prompts:{
          board:'Brand worldview moodboard, 16:9 collage, theme: the credibility of an old house. Indigo shop curtain of a long-established brewery, lacquerware deep gloss macro, a barley family-crest emblem study, gold rule lines on navy, craftsman hands, palette chips (#EDEDEA,#152447,#B79A4B). Dignified, established. NO beer cans, no bottles, no glasses of beer, no invented brand names, no logo lockups or label mockups. Editorial moodboard layout.',
          package:'Photorealistic 350ml Japanese beer can, front view, 3:4. All foam, barley and liquid imagery is PRINTED label artwork on the can surface — never real foam or liquid on or around the can. Ground: silver-white metallic with one deep navy vertical band edged by thin gold lines, lacquer-like depth in the gloss. Inside the band: a barley family-crest emblem and the bold logo. AMPLIFIED realistic beer foam and barley to guard beer readability. Mandatory labels in conventional positions: 麦芽100% / ラガー×エール ブレンド / 生ビール（非熱処理）, ALC.5%, 純アルコール量14g, お酒 mark.',
          kv:'Advertising banner key visual comp, 16:9. Product hero: the silver-white can with deep navy band and gold lines (match the attached can reference EXACTLY if provided), premium studio light, condensation. Left two-thirds: deep navy copy space with thin gold rules, large Japanese headline placeholder 「間違いのない一杯。」, beer foam highlight near the product, logo block bottom right. Dignified premium ad banner finish. No people. Must read as beer, never as green tea.'
        }
      }, {control:false, risks:['緑茶可読']}),

      _dirSeed('blend-b2','blended','B-2 手仕事の様式「調合室の紙」', null, {
        label:'基準執行', proposition:'調律とは、職人の手である。',
        fixedVars: BLEND_FIXED,
        executionLabel:'図像で語る — 手書きの配合',
        bet:'生活者は「人の手が調整した」に最も体温のある信頼を置く、という読み。コーヒーの季節ブレンドや茶匠のブレンドという隣接文脈が、この信頼の型を既に教育している。',
        aim:'調律の権威を工房の手仕事から取り、4変数を一貫導出する案。クラフト誤読の位置を測る計器を兼ねる。',
        coding:{A1:'白・クリーム',A2:'紙・布質感',A3:'文字ロゴのみ',A4:'静的',A5:'中央シンメトリー',A6:'なし',A7:'線・縁',A8:'角ゴシック系'}, codingBasis:'設計書（4変数の決定とsystem）から同一スキーマで符号化。画像確定後にAI再符号化で検証',
        decisions:[
          { decision:'V1 支配色: 生成りの紙色に墨。',
            seek:'工房の記録紙の色として読める。',
            evidence:'コーヒーの季節ブレンド・茶匠のブレンドという「プロの調整」の隣接文脈（戦略資料）から色彙を導出。' },
          { decision:'V2 素材感: クラフト紙・活版の質感。金属光沢を紙に譲る。',
            seek:'手で作られた実感。',
            evidence:'紙・ラベルの文法はクラフトビールの識別コードと近接する（可動域の失敗前例）。本案はその境界位置を実測する計器として設計する。' },
          { decision:'V3 図像: 手書きの配合記述と工房の検印スタンプ。',
            seek:'「今季の配合」が人の手の証拠として読める。',
            evidence:'ブレンド比という実データ（中味コンセプト）を図像化しており、意匠が中身の事実に遡れる。' },
          { decision:'V4 構図: ラベル貼付の工房構図。主要表記は定位置維持。',
            seek:'クラフト風でも定番の秩序を保つ。',
            evidence:'必須表示の可読は規制由来の絶対条件。' }
        ],
        glance:'紙の缶に手書きの配合。最も体温がある。',
        measurement:'手仕事・信頼スコアと、「定番/クラフト・限定」の帰属二択。',
        ledger:{ keeps:[{code:'表記の定位置'},{code:'麦の写実（ラベル内）'}],
          breaks:[{code:'地の光沢＝金属（紙へ）', hypothesis:'紙質感はクラフト・ニッチ・限定に誤読され、定番の座を失う恐れ', measure:'よなよなを混ぜた帰属質問＋「定番/限定」二択（台帳）'}],
          note:'共有数は目録の符号化完了後に確定' },
        system:{ palette:[{hex:'#E9E2D0',name:'生成り'},{hex:'#2B2B2B',name:'墨'},{hex:'#8A6D2F',name:'焦金'}], motif:'手書きの配合記述・工房検印', typography:'活版風の明朝＋手書き数字', composition:'ラベル貼付・記録紙の秩序', finish:'クラフト紙・活版の質感', tone:'誠実な体温' },
        prompts:{
          board:'Brand worldview moodboard, 16:9 collage, theme: the blender\'s workshop. Kraft paper macro, letterpress type, handwritten blend-ratio notebook, brass scale, stamped seals, afternoon workshop light, palette chips (#E9E2D0,#2B2B2B,#8A6D2F). Honest craft. NO beer cans, no bottles, no glasses of beer, no invented brand names, no logo lockups or label mockups. Editorial moodboard layout.',
          package:'Photorealistic 350ml Japanese beer can, front view, 3:4. All foam, barley and liquid imagery is PRINTED label artwork on the can surface — never real foam or liquid on or around the can. Ground: kraft-paper texture with a letterpress label layout, handwritten seasonal blend-ratio note and a workshop stamp seal. Mainstream anchors kept: realistic barley inside the label, all mandatory texts at conventional readable positions. Mandatory labels in conventional positions: 麦芽100% / ラガー×エール ブレンド / 生ビール（非熱処理）, ALC.5%, 純アルコール量14g, お酒 mark.',
          kv:'Advertising banner key visual comp, 16:9. Product hero: the kraft-textured 350ml beer can (match the attached can reference EXACTLY if provided) on a workshop desk, warm afternoon light. Left two-thirds: kraft copy space with a handwritten seasonal ratio note, large Japanese headline placeholder 「今季の配合、決まりました。」, logo block bottom right. Honest craft ad banner finish. No people. Must still read as a mainstream beer.'
        }
      }, {control:false, risks:['クラフト・ニッチ']}),

      _dirSeed('blend-b3','blended','B-3 設計の様式「二流の合流」', null, {
        label:'基準執行', proposition:'調律とは、精密な設計である。',
        fixedVars: BLEND_FIXED,
        executionLabel:'図像で語る — 合流のダイアグラム',
        bet:'若い生活者の信頼は職人の勘から「データと設計」へ移りつつある、という読み。スペック・数値表記への感度の高まりに賭ける。ただしこの読み自体が調査の検証対象。',
        aim:'調律の権威を精密工学（設計図の美）から取り、4変数を一貫導出する案。',
        coding:{A1:'銀白',A2:'金属',A3:'幾何・抽象',A4:'動的',A5:'中央シンメトリー',A6:'あり',A7:'面',A8:'角ゴシック系'}, codingBasis:'設計書（4変数の決定とsystem）から同一スキーマで符号化。画像確定後にAI再符号化で検証',
        decisions:[
          { decision:'V1 支配色: 白銀に金と銅の二色。ラガー×エールの二流を色で担う。',
            seek:'二つの流れが色で読める。',
            evidence:'中味コンセプト（ラガー×エールのブレンド）の直接図像化であり、意匠が中身の事実に遡れる。' },
          { decision:'V2 素材感: 精密な金属仕上げ。ヘアラインと鏡面の使い分け。',
            seek:'エンジニアリングの精度が質感で立つ。',
            evidence:'光沢コード（目録A2）の維持。' },
          { decision:'V3 図像: 金と銅の二流が合流して一本になるダイアグラム図像。合流点へ視線誘導する構成で「二つ→一つ」の解読を強制する。',
            seek:'設計図の美しさとして「調律」が読める。',
            evidence:'抽象図像は写実・紋章の慣習（目録A3）から外れるため解読失敗の恐れがあり、視線誘導はその対策として構図側に義務付ける。' },
          { decision:'V4 構図: 図面的な整列。グリッドに乗った表記。',
            seek:'精密の世界観が構図まで一貫する。',
            evidence:'表記の可読は規制由来の絶対条件。グリッドはそれを助ける。' }
        ],
        glance:'白銀に金銅の二流が合流する。最も理知的。',
        measurement:'精密・最適の体感スコアと、図像の自由再生（何の絵に見えたか）。',
        ledger:{ keeps:[{code:'金属光沢'},{code:'表記の定位置（グリッド強化）'}],
          breaks:[{code:'図像＝写実・紋章（抽象ダイアグラムへ）', hypothesis:'抽象図像は「何の絵か分からない」＝解読失敗の恐れ', measure:'自由再生（何に見えたか）＋「定番/限定」二択（台帳）'}],
          note:'共有数は目録の符号化完了後に確定' },
        system:{ palette:[{hex:'#EDEDEA',name:'白銀'},{hex:'#C8A24B',name:'金'},{hex:'#B4763B',name:'銅'}], motif:'二流合流のダイアグラム', typography:'精密なゴシック・数字強調', composition:'図面的グリッド整列', finish:'ヘアライン×鏡面の精密金属', tone:'理知・最適' },
        prompts:{
          board:'Brand worldview moodboard, 16:9 collage, theme: precision engineering of taste. Technical drawing lines, two liquid streams (gold and copper) merging into one smooth ribbon, hairline metal macro, calibration dials, grid layouts, palette chips (#EDEDEA,#C8A24B,#B4763B). Smooth engineered harmony. NO beer cans, no bottles, no glasses of beer, no invented brand names, no logo lockups or label mockups. Editorial moodboard layout.',
          package:'Photorealistic 350ml Japanese beer can, front view, 3:4. All foam, barley and liquid imagery is PRINTED label artwork on the can surface — never real foam or liquid on or around the can. Ground: precise silver-white metal, hairline and mirror finishes. Motif: an elegant diagram of two streams, gold and copper, merging into one ribbon at the center, composition guiding the eye to the merge point. Grid-aligned typography, bold logo. Realistic foam anchor kept. Mandatory labels in conventional positions: 麦芽100% / ラガー×エール ブレンド / 生ビール（非熱処理）, ALC.5%, 純アルコール量14g, お酒 mark.',
          kv:'Advertising banner key visual comp, 16:9. Product hero: the 350ml beer can with the two-stream merging motif (match the attached can reference EXACTLY if provided), backlit, condensation. Behind the copy space: two elegant liquid streams, gold and copper, merging into one ribbon. Large Japanese headline placeholder 「まざって、ちょうどいい。」, logo block bottom right. Smooth engineered ad banner finish. No people.'
        }
      }, {control:false, risks:['解読失敗']}),

      _dirSeed('blend-b4','blended','B-4 季節の様式「季節で回る缶」', '監査ギャップ未解消: 季節記号の先客・「限定品コード」との識別条件が未監査。付属の調査依頼の結果を取り込むまで、この方向は画像化に進めません。', {
        label:'凍結中', proposition:'調律とは、季節ごとに装いが変わることである（未監査）。',
        fixedVars: BLEND_FIXED,
        bet:'（監査未了。賭けの記述も監査後に設計する）',
        aim:'缶の意匠自体が季節で回る案。限定品コードとの識別が監査未了のため、設計を凍結しています。',
        decisions:[
          { decision:'季節で意匠が変わる缶は「定番」の知覚と正面衝突する可能性があるため、限定品コードとの識別条件が監査されるまで4変数の設計に入らない。',
            seek:'憶測で設計しないこと自体がこの案の現在の決定。',
            evidence:'解読失敗＝限定品誤読は戦略の最重要注意点（晴れ風批評と同型）。監査なしの設計は反証可能性を持たない。' }
        ],
        glance:'（凍結中）',
        measurement:'（監査後に設計）',
        ledger:{ keeps:[], breaks:[], note:'監査未了のため台帳未作成' },
        system:{ palette:[], motif:'', typography:'', composition:'', finish:'', tone:'' },
        prompts:{ board:'', package:'', kv:'' }
      }, {control:false, risks:['解読失敗']}),

      /* ===== ② 気枯れ・別解: 名前→知覚設計の連鎖（各方向=ネーミング型の1実装。名前は全て仮案・監査未実施） ===== */
      _dirSeed('kalt-a','kegare-alt','A-1 型A「澄雷 — 雷文の帯」', null, {
        label:'型A 資料構造の別実装', proposition:'祓いとは、雷鳴のあとの澄んだ空気である。',
        fixedVars: KALT_FIXED,
        bet:'出自: 名前の型＝資料p.10-11の参考構造（清らかさ×力強さ）／候補「澄雷」＝ツール提案の仮案（雷は生き物でない緩和形・監査未実施）。賭け: 澄虎（守護神の格）に対し、澄雷は「気象の実感」——夕立のあとの空気の澄みは誰もが身体で知っており、解読コストが最小という読み。',
        aim:'名前が変われば意匠の最適も変わることの実証台。雷を絵でなく雷文（伝統幾何文様）で言い、奇抜さに落とさない。',
        coding:{A1:'銀白×藍',A2:'金属',A3:'雷文帯',A4:'静的',A5:'中央シンメトリー',A6:'なし',A7:'幾何文様',A8:'毛筆'}, codingBasis:'設計書から符号化。画像確定後にAI再符号化',
        decisions:[{ decision:'雷の表現を絵（稲妻・空）でなく雷文の帯一周に限定する。', seek:'力強さの記号が王道の顔の中に収まり、限定品/クラフトに誤読されない。', evidence:'雷文は器物の縁で国民的に既知の伝統文様＝解読コスト最小。電通資料の注意点「斬新さ≠奇抜さ」への直接適合。' }],
        glance:'銀の王道缶の肩に藍の雷文が一周。名は澄雷。',
        measurement:'澄虎案との相対評価: 名前の意味（守護神 vs 気象）が新しさ・自分ごと感に与える差分。',
        ledger:{ keeps:[{code:'地の金属光沢'},{code:'中央対称構図'}], breaks:[{code:'図像＝写実系', hypothesis:'幾何文様帯は「和菓子・器物」連想に流れる恐れ', measure:'2秒棚の酒類識別＋連想聴取'}], note:'共有数は符号化後に確定' },
        system:{ palette:[{hex:'#D9DCE0',name:'銀'},{hex:'#22366B',name:'藍'}], motif:'雷文帯', typography:'紺毛筆縦', composition:'中央対称', finish:'金属', tone:'雷後の静けさ' },
        prompts:{ board:'', package:'', kv:'' }
      }, {control:false, risks:['器物連想']}),

      _dirSeed('kalt-b','kegare-alt','A-2 型B「ミソギ — 一筋の水流」', null, {
        label:'型B 行為の名詞化', proposition:'祓いとは、水をくぐる行為そのものである。',
        fixedVars: KALT_FIXED,
        bet:'出自: 型B（行為・儀式の名詞化）＝ツール提案の型／候補「ミソギ」＝ツール提案の仮案（神事語彙の直接使用のため記号監査要・商標監査未実施）。賭け: 「浄化された状態」でなく「浄化する行為」を名にすれば、飲む所作そのものが儀式になる——行為語の名前は想起時に体が動く、という読み。',
        aim:'カタカナ化で儀式語を現代化し、神事の具体物（御幣・鳥居）を絵に持ち込まずに行為だけを言う。',
        coding:{A1:'白',A2:'紙',A3:'水流線',A4:'流動',A5:'非対称',A6:'なし',A7:'細線',A8:'水茎カナ'}, codingBasis:'設計書から符号化',
        decisions:[{ decision:'図像は一筋の水流ラインのみ。神事の具体物は監査完了まで使わない。', seek:'記号監査の宿題（神事語彙）を名前に限定し、意匠側のリスクをゼロにする。', evidence:'S-2（神事の白）で御幣・光の玉系は監査済み/棄却済み。行為の抽象化は監査対象語彙に該当しない。' }],
        glance:'和紙白の缶を一筋の藍の水流が縦に流れる。名はミソギ。',
        measurement:'行為語の名前が「自分の儀式」想起を作るか（使用場面の自由記述）。',
        ledger:{ keeps:[{code:'下部情報帯'}], breaks:[{code:'地の光沢＝金属', hypothesis:'紙質感は日本酒・和菓子側に誤帰属の恐れ', measure:'2秒棚の酒類識別'},{code:'中央対称構図', hypothesis:'非対称は定番感を毀損の恐れ', measure:'定番/限定の帰属質問'}], note:'攻め端の執行' },
        system:{ palette:[{hex:'#F5F2EA',name:'和紙白'},{hex:'#22366B',name:'藍'}], motif:'一筋の水流', typography:'水茎カナ縦', composition:'流れの非対称', finish:'マット紙', tone:'儀式の静けさ' },
        prompts:{ board:'', package:'', kv:'' }
      }, {control:false, risks:['和菓子誤読','限定品誤読']}),

      _dirSeed('kalt-c','kegare-alt','A-3 型C「KIYOTORA — 表記の転換」', null, {
        label:'型C 表記の転換', proposition:'澄虎の意味を、ローマ字の顔で言い換える。',
        fixedVars: KALT_FIXED,
        bet:'出自: 型C（表記の転換）＝ツール提案の型／「KIYOTORA」という読み替え＝ユーザー指示由来（読み変更はネーミング領分のため音・商標の監査未実施）。賭け: 同じ名前でも表記系で世界が変わる——ローマ字×白磁の顔は国際水ブランドの文法を借り、「浄化」を無印の清潔さとして言えるという読み。',
        aim:'①タブ（漢字縦大）の完全な対照実験。名前の意味を固定し表記系だけを動かす。',
        coding:{A1:'白',A2:'磁器質',A3:'なし',A4:'静的',A5:'左上非対称',A6:'なし',A7:'細サンセリフ',A8:'ジオメトリック'}, codingBasis:'設計書から符号化',
        decisions:[{ decision:'漢字「澄虎」を消さず下部に従として残す。', seek:'読み替え（KIYO）の教育コストを漢字の並記で回収。', evidence:'翠がSUIを併記して語感を国際化した先行文法（サントリー翠の缶表記）。' }],
        glance:'白磁の缶に細いKIYOTORA。漢字は小さく下に。',
        measurement:'表記系の反転が「新しさ」と「ビール可読」に与える差分（①S-1構図執行のSUMITORA小併記との比較）。',
        ledger:{ keeps:[{code:'下部情報帯'}], breaks:[{code:'地の光沢＝金属', hypothesis:'白磁マットは清涼飲料・化粧品側への誤帰属リスク最大', measure:'2秒棚の酒類識別（本タブの攻め端）'},{code:'和文ロゴ主役', hypothesis:'ローマ字主役は輸入ビール/クラフト帰属の恐れ', measure:'国産/輸入の帰属質問'}], note:'誤読リスク最大の計器案' },
        system:{ palette:[{hex:'#F7F7F4',name:'白磁'},{hex:'#1B2A5E',name:'紺'}], motif:'なし', typography:'ジオメトリックサンセリフ', composition:'左上ロック', finish:'マット磁器', tone:'国際的な清潔' },
        prompts:{ board:'', package:'', kv:'' }
      }, {control:false, risks:['清涼飲料誤読','輸入誤読']}),

      /* ===== ③A Misty LAGER ===== */
      _dirSeed('my-1','den-misty','M-1 靄の階調', null, {
        label:'色で語る', proposition:'整うとは、靄が晴れていく途中の柔らかさである。',
        fixedVars: DEN_FIXED,
        bet:'出自: 世界観「柔らかいけどしっかり整う」＝電通資料コンセプトA／靄の階調という翻訳＝ツール提案。賭け: Mistyの直訳（靄）を彩度を落とした灰青のグラデで言えば、「柔らかさ」と「締まり」が一枚で両立するという読み。青に振れば清涼飲料、白に振れば空虚——灰が鍵。',
        aim:'世界観を色と大気だけで言う分離測定。',
        coding:{A1:'白×灰青',A2:'金属',A3:'なし',A4:'静的',A5:'中央',A6:'なし',A7:'グラデ',A8:'細セリフ'}, codingBasis:'設計書から符号化',
        decisions:[{ decision:'波紋モチーフを使わない。', seek:'「整う」の視覚語彙の先客回避。', evidence:'綾鷹が2024年の全面刷新で「波打つ心が整う波紋モチーフ」を採用済み（コカ・コーラ2024.3リリース）——波紋は緑茶の顔になっている。' }],
        glance:'白から灰青へ沈む静かな靄の缶。',
        measurement:'「柔らかいのに締まって見えるか」の両立評価＋清涼飲料誤読率。',
        ledger:{ keeps:[{code:'地の金属光沢',note:'靄の中でも金属の反射は維持'},{code:'下部情報帯'}], breaks:[{code:'地の色相域＝銀白・金系', hypothesis:'灰青は発泡酒・新ジャンル帰属の恐れ', measure:'ビール/発泡酒の帰属質問'}], note:'' },
        system:{ palette:[{hex:'#F6F7F8',name:'白'},{hex:'#AEBDC8',name:'灰青'}], motif:'なし', typography:'細セリフ横', composition:'中央', finish:'金属×粒子', tone:'靄の柔らかさ' },
        prompts:{ board:'', package:'', kv:'' }
      }, {control:false, risks:['発泡酒誤読']}),

      _dirSeed('my-2','den-misty','M-2 整う呼吸のライン', null, {
        label:'構図で語る', proposition:'整うとは、呼吸が等間隔に戻ることである。',
        fixedVars: DEN_FIXED,
        bet:'出自: 世界観＝電通資料コンセプトA／等間隔ラインという翻訳＝ツール提案。賭け: 「整う」を気分でなく秩序（等間隔）で言えば、サウナ既存語彙（棄却済み）にも波紋（綾鷹占有）にも触れずに世界観を運べるという読み。',
        aim:'均質なリズムの中の一本の太線＝「この一杯」の演出。構図単体の分離測定。',
        coding:{A1:'白',A2:'マット',A3:'なし',A4:'静的',A5:'水平リズム',A6:'なし',A7:'極細線',A8:'細セリフ'}, codingBasis:'設計書から符号化',
        decisions:[{ decision:'ラインは水平・等間隔・一本だけ太く。', seek:'秩序と「今日の一杯」の同居。', evidence:'均質パターン＋単一アクセントは視線の第一固定点を制御する定石（視認性のグラフィック原則）。' }],
        glance:'白磁に等間隔の細線。一本だけ太い。',
        measurement:'「整う」の想起がサウナ語彙なしで成立するか（自由連想）。',
        ledger:{ keeps:[{code:'中央対称構図'},{code:'下部情報帯'}], breaks:[{code:'図像＝写実系', hypothesis:'抽象ラインは文具・化粧品帰属の恐れ', measure:'カテゴリ帰属質問'}], note:'' },
        system:{ palette:[{hex:'#F7F7F4',name:'白磁'},{hex:'#5A6472',name:'鼠青'}], motif:'水平線群', typography:'細セリフ', composition:'水平リズム', finish:'マット', tone:'呼吸の秩序' },
        prompts:{ board:'', package:'', kv:'' }
      }, {control:false, risks:['文具誤読']}),

      /* ===== ③B QUIET LAGER ===== */
      _dirSeed('qt-1','den-quiet','Q-1 内包の金', null, {
        label:'素材で語る', proposition:'豊かさとは、外に見せず内に持つ金である。',
        fixedVars: DEN_FIXED,
        bet:'出自: 世界観「本当の豊かさを内に」＝電通資料コンセプトB／内側の金という実装＝ツール提案。賭け: 外面の金を封じ、缶口の縁と内側だけに金を置けば「自慢しない豊かさ」が物として伝わるという読み——プレモル系の金ギラ文法（外向きの豊かさ）との構造的差別化。',
        aim:'金の位置（外→内）だけを動かす素材の実験。',
        coding:{A1:'紺鼠',A2:'マット×金縁',A3:'なし',A4:'静的',A5:'中央',A6:'なし',A7:'縁',A8:'細セリフ'}, codingBasis:'設計書から符号化',
        decisions:[{ decision:'金は縁と内側のみ。外面はマット紺鼠。', seek:'棚では静かに、手に取り開栓した瞬間に豊かさが現れる時間差の設計。', evidence:'プレミアム系既存文法（外面金）の反転。開栓体験の演出は高級酒（内蓋の金箔等）の先行文法。' }],
        glance:'静かな紺鼠の缶。縁だけ金。',
        measurement:'棚の静けさと開栓後の豊かさ知覚の二段測定。',
        ledger:{ keeps:[{code:'中央対称構図'},{code:'下部情報帯'}], breaks:[{code:'地の色相域＝銀白・金系', hypothesis:'暗色マットはクラフト・黒ビール帰属の恐れ', measure:'味の事前想起（重い/軽い）'}], note:'' },
        system:{ palette:[{hex:'#3A4250',name:'紺鼠'},{hex:'#C8A24B',name:'金縁'}], motif:'なし', typography:'細セリフ', composition:'中央', finish:'マット×金属縁', tone:'静かな豊かさ' },
        prompts:{ board:'', package:'', kv:'' }
      }, {control:false, risks:['黒ビール誤読']}),

      _dirSeed('qt-2','den-quiet','Q-2 静けさの重心', null, {
        label:'構図で語る', proposition:'豊かさとは、低い重心の落ち着きである。',
        fixedVars: DEN_FIXED,
        bet:'出自: 世界観＝電通資料コンセプトB／低重心の構図という翻訳＝ツール提案。賭け: 要素を下1/3に沈め上2/3を余白にすれば、「余裕」が構図そのものとして伝わるという読み。麦の穂一本の細密画は豊かさの根拠を小声で言う装置。',
        aim:'重心と声量だけを動かす構図の実験。',
        coding:{A1:'墨鼠×生成り',A2:'マット',A3:'麦一本',A4:'静的',A5:'低重心非対称',A6:'なし',A7:'細密線画',A8:'細セリフ'}, codingBasis:'設計書から符号化',
        decisions:[{ decision:'ロゴ・図像・表記を下1/3に集約し、上を余白にする。', seek:'「余裕＝余白」の直接翻訳。', evidence:'低重心＝安定・落ち着きの構図文法（S-1構図執行の低い水平線と同系の原理）。' }],
        glance:'上が空、下に小さな麦とQUIET。',
        measurement:'余白量と「余裕・人間味」知覚の相関。',
        ledger:{ keeps:[{code:'下部情報帯'}], breaks:[{code:'中央対称構図', hypothesis:'非対称＋余白過多は未完成/安価の誤読リスク', measure:'品質知覚の事前評価'}], note:'' },
        system:{ palette:[{hex:'#4A4A48',name:'墨鼠'},{hex:'#EFEAE0',name:'生成り'}], motif:'麦一本', typography:'細セリフ', composition:'低重心', finish:'マット', tone:'低い声の豊かさ' },
        prompts:{ board:'', package:'', kv:'' }
      }, {control:false, risks:['安価誤読']}),

      /* ===== ③C NODE LAGER ===== */
      _dirSeed('nd-1','den-node','N-1 モードの計器', null, {
        label:'図像で語る', proposition:'ちょうどよさとは、自分で合わせた目盛の位置である。',
        fixedVars: DEN_FIXED,
        bet:'出自: 世界観「ちょうどよいモードへの結節点」＝電通資料コンセプトC／目盛という実装＝ツール提案。賭け: モード切替を計器（薄⇄濃の目盛と中点マーカー）で言えば、「自分に合っている」が主観でなく位置として見えるという読み。※B-3精密設計（製法の図面＝作り手の説明）との差分は「自分のモードの計器＝飲み手の主観装置」——概念近接は導出表で管理。',
        aim:'主観（ちょうどいい）の可視化実験。',
        coding:{A1:'銀白',A2:'金属',A3:'目盛',A4:'静的',A5:'軸対称',A6:'なし',A7:'計器',A8:'ジオメトリック'}, codingBasis:'設計書から符号化',
        decisions:[{ decision:'目盛は薄⇄濃の1軸のみ・中点にマーカー。', seek:'「濃さ自慢」でなく「位置の正しさ」の訴求。', evidence:'コンセプト文「濃い薄いではなく、ちょうどよいモード」（電通資料）の直接図像化。' }],
        glance:'銀の缶の中央に薄⇄濃の目盛。針は真ん中。',
        measurement:'目盛の解読率＋「自分ごと感」（B-3図面との相対比較）。',
        ledger:{ keeps:[{code:'地の金属光沢'},{code:'中央対称構図'}], breaks:[{code:'図像＝写実系', hypothesis:'計器は家電・ガジェット帰属の恐れ', measure:'カテゴリ帰属質問'}], note:'' },
        system:{ palette:[{hex:'#D9DCE0',name:'銀'},{hex:'#2B3A67',name:'紺'}], motif:'目盛と針', typography:'ジオメトリック', composition:'軸対称', finish:'金属', tone:'調整の理性' },
        prompts:{ board:'', package:'', kv:'' }
      }, {control:false, risks:['ガジェット誤読','B-3近接']}),

      _dirSeed('nd-2','den-node','N-2 あいだの中点', null, {
        label:'色で語る', proposition:'ちょうどよさとは、濃と淡のあいだの一点である。',
        fixedVars: DEN_FIXED,
        bet:'出自: 世界観＝電通資料コンセプトC／グラデ中点という翻訳＝ツール提案。賭け: 濃紺→淡青のグラデの真ん中に一本の白線を引けば、「あいだ」という抽象が座標として一目で伝わるという読み。N-1（計器）の絵画的言い換え＝装置の幅。',
        aim:'同じ命題を計器/色で言い分ける装置比較。',
        coding:{A1:'紺→淡青',A2:'金属',A3:'なし',A4:'静的',A5:'中点強調',A6:'なし',A7:'グラデ',A8:'サンセリフ'}, codingBasis:'設計書から符号化',
        decisions:[{ decision:'白線は中点に一本のみ。', seek:'座標の明確さ。', evidence:'nd-1と同一命題・別装置＝執行比較の設計（①で確立した幅の文法の適用）。' }],
        glance:'紺から淡青へ。真ん中に白い一線。',
        measurement:'N-1との相対: 計器と色、どちらが「ちょうどよさ」を速く運ぶか。',
        ledger:{ keeps:[{code:'地の金属光沢'},{code:'下部情報帯'}], breaks:[{code:'地の色相域＝銀白・金系', hypothesis:'青グラデは清涼飲料・水誤読の恐れ', measure:'2秒棚の酒類識別'}], note:'' },
        system:{ palette:[{hex:'#1E2C55',name:'濃紺'},{hex:'#BFD9E6',name:'淡青'}], motif:'中点線', typography:'サンセリフ', composition:'中点', finish:'金属', tone:'座標の明快' },
        prompts:{ board:'', package:'', kv:'' }
      }, {control:false, risks:['清涼飲料誤読']}),

      /* ===== ③D City LAGER ===== */
      _dirSeed('ct-1','den-city','C-1 夜のガラス', null, {
        label:'素材で語る', proposition:'都会的とは、夜のガラスに映る光の距離感である。',
        fixedVars: DEN_FIXED,
        bet:'出自: 世界観「かっこいいけどどこか冷たさもある都会的」＝電通資料コンセプトD／夜のガラスという翻訳＝ツール提案。賭け: 都会をネオンやスカイラインの絵（クラフト系の既存クリシェ）でなく「鏡面に映る夜の光の細線」で言えば、冷たさと品が両立するという読み。',
        aim:'都会の言い方から絵柄を排除する素材実験。',
        coding:{A1:'ガンメタル',A2:'鏡面',A3:'なし',A4:'静的',A5:'右上非対称',A6:'なし',A7:'反射線',A8:'エクステンデッド'}, codingBasis:'設計書から符号化',
        decisions:[{ decision:'都市の絵（ビル群・ネオン看板）を使わない。', seek:'クラフト系クリシェの回避と王道感の維持。', evidence:'ネオン/スカイライン絵柄はクラフトビールの定番文法（棚の観察・目録で符号化予定）。反射なら金属光沢コードの内側で言える。' }],
        glance:'ガンメタルの鏡面に夜の光が細く映る。',
        measurement:'「都会的」の想起が絵なしで成立するか＋冷たさの許容度（ド真ん中との両立質問）。',
        ledger:{ keeps:[{code:'地の金属光沢',note:'鏡面は光沢コードの強化形'},{code:'下部情報帯'}], breaks:[{code:'地の色相域＝銀白・金系', hypothesis:'暗色は黒ビール/輸入誤読の恐れ', measure:'帰属質問'}], note:'' },
        system:{ palette:[{hex:'#3E434B',name:'ガンメタル'},{hex:'#E8C989',name:'琥珀光'}], motif:'反射線', typography:'エクステンデッド', composition:'非対称余白', finish:'鏡面', tone:'夜の距離感' },
        prompts:{ board:'', package:'', kv:'' }
      }, {control:false, risks:['黒ビール誤読','冷たさ過剰']}),

      _dirSeed('ct-2','den-city','C-2 グリッドの静寂', null, {
        label:'構図で語る', proposition:'都会的とは、整列がつくる静けさである。',
        fixedVars: DEN_FIXED,
        bet:'出自: 世界観＝電通資料コンセプトD／スイス組版という翻訳＝ツール提案。賭け: 都会の冷たさを「規律あるグリッド組版」で言えば、冷たさが「雑味のなさ」として品に転化するという読み。※B-3図面（寸法・注記＝工学）との差分は「注記なしのグラフィズム」——導出表で管理。',
        aim:'タイポグラフィ単体で世界観を運ぶ構図実験。',
        coding:{A1:'薄鼠',A2:'マット',A3:'なし',A4:'静的',A5:'グリッド左寄せ',A6:'なし',A7:'罫線',A8:'グロテスク'}, codingBasis:'設計書から符号化',
        decisions:[{ decision:'要素はグリッド罫とタイポのみ。装飾ゼロ。', seek:'「かっこいい＝規律」の検証。', evidence:'スイス・タイポグラフィの組版文法（グリッドシステム）は都市グラフィックの正統。' }],
        glance:'薄鼠の缶に細い罫線とCITYの活字だけ。',
        measurement:'装飾ゼロで品質知覚が維持されるか（安価誤読率）。',
        ledger:{ keeps:[{code:'下部情報帯'}], breaks:[{code:'中央対称構図', hypothesis:'左寄せグリッドは文具・化粧品誤読の恐れ', measure:'カテゴリ帰属質問'},{code:'図像＝写実系', hypothesis:'完全無図像は味の手掛かり喪失', measure:'味の事前想起の量'}], note:'攻め端' },
        system:{ palette:[{hex:'#C9CCD1',name:'薄鼠'},{hex:'#17171A',name:'墨'}], motif:'罫線', typography:'グロテスク', composition:'グリッド', finish:'マット', tone:'整列の静寂' },
        prompts:{ board:'', package:'', kv:'' }
      }, {control:false, risks:['文具誤読','味想起喪失']}),

      /* ===== ブレンデッド主方向: 季節の調律（コンセプト中核の直接実装） ===== */
      _dirSeed('blend-bs','blended','B-S 季節の調律「通年の顔・可変の針」', null, {
        label:'主方向: コンセプト中核', proposition:'調律とは、定番の顔の中で針の位置だけが季節に合うことである。',
        fixedVars: BLEND_FIXED,
        bet:'出自: 「季節ベストバランス」＝サントリー資料の開発コンセプト中核（1年中最適・季節ごとの温度と湿度に合わせて）／「絵柄でなく計器で言う」＝ツール提案。賭け: 季節を絵柄（桜・雪・紅葉）で言えば限定品コードに正面衝突する（電通資料「限定品に見えるな」・B-4凍結の理由）が、通年同一の調律ダイヤル＋今季の配合数値なら「定番の顔は不変・中身の位置だけ替わる」＝コンセプトの中核差分を誤読なしで言えるという読み。権威3方向（老舗/職人/精密）は本方向の信用の裏書きに再定義。',
        aim:'コンセプトの中核（季節バランス）を主役に据える。季節記号ゼロで季節を言う。',
        coding:{A1:'銀白',A2:'金属',A3:'調律ダイヤル',A4:'可変（針位置）',A5:'中央シンメトリー',A6:'配合数値',A7:'計器',A8:'毛筆×ジオメトリック'}, codingBasis:'設計書から符号化',
        decisions:[
          { decision:'季節の表現を「春夏秋冬の文字目盛＋針＋配合数値」に限定し、季節の絵柄・色替えを使わない。', seek:'定番知覚の維持と季節差分の両立（B-4が凍結された誤読リスクの根本回避）。', evidence:'電通資料の注意点「斬新さ≠奇抜さ（限定品に見える）」。季節絵柄は限定品の定番文法（冬物語・晴れ風ら季節限定缶）＝資料の禁を正面から踏む。数値・計器は通年不変の構造。' },
          { decision:'B-1老舗/B-2職人/B-3精密は「調律の信用の裏書き」の従属幅として維持。', seek:'主方向（何を言うか＝季節調律）と裏書き（なぜ信じられるか＝権威の源泉）の役割分離。', evidence:'資料構造の同型: 開発コンセプト（季節最適の約束）とRTB（120年のブレンド技術）は別の行——方向設計も同じ分離が正しい。' }
        ],
        glance:'王道の銀缶の中央に四季の目盛と針。今季はラガー62:エール38。',
        measurement:'定番/限定の帰属（B-4凍結理由の直接検証）＋「季節で最適」の伝達率＋権威3方向との相対評価。',
        ledger:{ keeps:[{code:'地の金属光沢'},{code:'中央対称構図'},{code:'下部情報帯'}], breaks:[{code:'静的な意匠＝不変', hypothesis:'針・数値の可変要素が「毎回違う＝限定品」と誤読される恐れ', measure:'定番/限定の帰属質問（最重要検査）'}], note:'主方向。B-4（絵柄系）は監査待ちの凍結を維持' },
        system:{ palette:[{hex:'#D9DCE0',name:'銀'},{hex:'#1B2A5E',name:'紺'},{hex:'#C8A24B',name:'金'}], motif:'調律ダイヤル・針・配合数値', typography:'毛筆×ジオメトリック併用', composition:'中央対称', finish:'金属', tone:'約束の理性' },
        prompts:{ board:'', package:'', kv:'' }
      }, {control:false, risks:['限定品誤読（可変要素）']}),

      _dirSeed('my-3','den-misty','M-3 結露の窓', null, {
        label:'素材で語る', proposition:'整うとは、曇りを一本だけ拭くことである。',
        fixedVars: DEN_FIXED,
        bet:'出自: 世界観「柔らかいけどしっかり整う」＝電通資料コンセプトA／結露の窓＝ツール提案。賭け: Mistyを気象でなく「朝、曇った窓を指で拭く」という実在の所作に接地すれば、柔らかさ（曇り）と整い（一筋の明瞭）が一枚で同居するという読み。拭き跡の中にだけビール写実を覗かせ、可読の錨を兼務させる。',
        aim:'M-1（色）に対する素材・物語の装置比較。',
        coding:{A1:'磨り銀',A2:'ガラス質',A3:'窓と琥珀',A4:'静的',A5:'左寄り非対称',A6:'なし',A7:'透明抜き',A8:'細セリフ'}, codingBasis:'設計書から符号化',
        decisions:[{ decision:'ビール写実は拭き跡の中にのみ置く。', seek:'曇り（世界観）と可読（王道）の役割分担。', evidence:'湯気・入浴系の曇り表現は自主基準リスク（①で監査済み）——窓の結露は入浴文脈を持たない生活の所作。' }],
        glance:'曇ったガラスの缶。一筋だけ拭かれて琥珀が覗く。',
        measurement:'M-1/M-2との相対: 物語装置の有無が「整う」の伝達速度に与える差。',
        ledger:{ keeps:[{code:'下部情報帯'},{code:'泡・麦の写実',note:'拭き跡内に限定して維持'}], breaks:[{code:'地の光沢＝金属', hypothesis:'磨りガラス質感は化粧品・チューハイ誤読の恐れ', measure:'2秒棚の酒類識別'}], note:'' },
        system:{ palette:[{hex:'#DCE1E4',name:'磨り銀'},{hex:'#C98A1F',name:'琥珀'}], motif:'拭き跡の窓', typography:'細セリフ', composition:'左寄り', finish:'ガラス質', tone:'朝の所作' },
        prompts:{ board:'', package:'', kv:'' }
      }, {control:false, risks:['チューハイ誤読']}),

      _dirSeed('my-0','den-misty','M-0 統制「MISTY、王道のまま」', null, {
        label:'基準', proposition:'世界観を様式化しない。王道の文法と作業ラベルだけで語る。',
        fixedVars: DEN_FIXED,
        bet:'出自: 統制設計＝①S-0で確立した文法の適用（ツール判断）。賭け: M-1〜M-3の新しさスコアとの差＝「Misty世界観を様式化することの寄与量」を直接測る基準線。',
        aim:'様式化の寄与量の分離測定。',
        coding:{A1:'銀白',A2:'金属',A3:'王道写実',A4:'静的',A5:'中央シンメトリー',A6:'なし',A7:'写実',A8:'細セリフ'}, codingBasis:'設計書から符号化',
        decisions:[{ decision:'4変数すべてを王道条件に固定。', seek:'基準線。', evidence:'統制なしに様式の効果は分離できない（①S-0と同一の調査設計原則）。' }],
        glance:'完全に王道の銀缶。名前だけMISTY。',
        measurement:'新しさ・購入意向の基準値。',
        ledger:{ keeps:[{code:'地の金属光沢'},{code:'中央対称構図'},{code:'泡・麦の写実'}], breaks:[], note:'基準線' },
        system:{ palette:[{hex:'#D9DCE0',name:'銀'}], motif:'王道写実', typography:'細セリフ', composition:'中央', finish:'金属', tone:'ど真ん中' },
        prompts:{ board:'', package:'', kv:'' }
      }, {control:true, risks:[]}),

      _dirSeed('qt-3','den-quiet','Q-3 森閑の緑鼠', null, {
        label:'色で語る', proposition:'豊かさとは、森閑の深い色である。',
        fixedVars: DEN_FIXED,
        bet:'出自: 世界観「本当の豊かさを内に」＝電通資料コンセプトB／深緑鼠＝ツール提案。賭け: 内なる豊かさの色相をQ-1の紺鼠から森の深緑鼠へ動かせば、「静けさ」に自然の含意が乗るという読み。低彩度の規律は共通＝色単体の分離測定。',
        aim:'Q-1との色相比較（紺鼠 vs 緑鼠）。',
        coding:{A1:'深緑鼠',A2:'マット',A3:'なし',A4:'静的',A5:'中央',A6:'なし',A7:'金線一本',A8:'細セリフ'}, codingBasis:'設計書から符号化',
        decisions:[{ decision:'緑は彩度を落とした緑鼠に限定。', seek:'緑茶・ハイボール缶への誤帰属回避。', evidence:'高彩度の緑は緑茶（綾鷹・伊右衛門）とハイボール（角・翠ジンソーダ）の占有色相（棚の観察・目録で符号化予定）。' }],
        glance:'深い緑鼠の静かな缶。上端に金の一線。',
        measurement:'Q-1との相対: 色相が「豊かさの質感」に与える差＋緑茶誤読率。',
        ledger:{ keeps:[{code:'中央対称構図'},{code:'下部情報帯'}], breaks:[{code:'地の色相域＝銀白・金系', hypothesis:'緑系は緑茶・ハイボール誤読の恐れ', measure:'2秒棚の酒類識別（本方向の最重要検査）'}], note:'' },
        system:{ palette:[{hex:'#37413A',name:'緑鼠'},{hex:'#C8A24B',name:'金線'}], motif:'なし', typography:'細セリフ', composition:'中央', finish:'マット', tone:'森閑' },
        prompts:{ board:'', package:'', kv:'' }
      }, {control:false, risks:['緑茶誤読','ハイボール誤読']}),

      _dirSeed('qt-0','den-quiet','Q-0 統制「QUIET、王道のまま」', null, {
        label:'基準', proposition:'世界観を様式化しない基準線。',
        fixedVars: DEN_FIXED,
        bet:'出自: 統制設計＝①S-0の文法適用（ツール判断）。賭け: Q-1〜Q-3との差＝QUIET世界観の様式化の寄与量。',
        aim:'様式化の寄与量の分離測定。',
        coding:{A1:'銀白',A2:'金属',A3:'王道写実',A4:'静的',A5:'中央シンメトリー',A6:'なし',A7:'写実',A8:'細セリフ'}, codingBasis:'設計書から符号化',
        decisions:[{ decision:'4変数を王道条件に固定。', seek:'基準線。', evidence:'①S-0と同一の調査設計原則。' }],
        glance:'王道の銀缶。名前だけQUIET。', measurement:'基準値。',
        ledger:{ keeps:[{code:'地の金属光沢'},{code:'中央対称構図'},{code:'泡・麦の写実'}], breaks:[], note:'基準線' },
        system:{ palette:[{hex:'#D9DCE0',name:'銀'}], motif:'王道写実', typography:'細セリフ', composition:'中央', finish:'金属', tone:'ど真ん中' },
        prompts:{ board:'', package:'', kv:'' }
      }, {control:true, risks:[]}),

      _dirSeed('nd-3','den-node','N-3 水引の結び', null, {
        label:'図像で語る（和意匠）', proposition:'結節点とは、一本の紐が結ばれる一点である。',
        fixedVars: DEN_FIXED,
        bet:'出自: 世界観「結節点」＝電通資料コンセプトC／水引＝ツール提案。賭け: NODEの和訳として水引の結び（実在の日本の結びの意匠）を使えば、「結ばれてほどけない＝ちょうどよさが定まる」が伝統の格ごと伝わるという読み。紅白は祝儀・進物コードに直結するため単色紺で回避（導出の条件）。',
        aim:'N-1（計器＝理性）に対する和意匠（情緒）の装置比較。',
        coding:{A1:'銀白×紺',A2:'金属',A3:'水引結び',A4:'静的',A5:'中央シンメトリー',A6:'なし',A7:'線の結び',A8:'ジオメトリック'}, codingBasis:'設計書から符号化',
        decisions:[{ decision:'結びはあわじ結び・紺一色・一つだけ。', seek:'祝儀コード（紅白・蝶結び）の回避と結節点の純度。', evidence:'水引の紅白は進物・慶事の定型（百貨店包装の慣習）——単色化で意匠だけを借りる。' }],
        glance:'銀の缶の中央に紺一色の結びがひとつ。',
        measurement:'N-1/N-2との相対＋祝儀・ギフト誤読率。',
        ledger:{ keeps:[{code:'地の金属光沢'},{code:'中央対称構図'},{code:'下部情報帯'}], breaks:[{code:'図像＝写実系', hypothesis:'結びは進物・和菓子誤読の恐れ', measure:'カテゴリ帰属＋ギフト帰属質問'}], note:'' },
        system:{ palette:[{hex:'#D9DCE0',name:'銀'},{hex:'#22366B',name:'紺'}], motif:'あわじ結び', typography:'ジオメトリック', composition:'中央', finish:'金属', tone:'結びの静' },
        prompts:{ board:'', package:'', kv:'' }
      }, {control:false, risks:['進物誤読','和菓子誤読']}),

      _dirSeed('nd-0','den-node','N-0 統制「NODE、王道のまま」', null, {
        label:'基準', proposition:'世界観を様式化しない基準線。',
        fixedVars: DEN_FIXED,
        bet:'出自: 統制設計＝①S-0の文法適用（ツール判断）。賭け: N-1〜N-3との差＝NODE世界観の様式化の寄与量。',
        aim:'様式化の寄与量の分離測定。',
        coding:{A1:'銀白',A2:'金属',A3:'王道写実',A4:'静的',A5:'中央シンメトリー',A6:'なし',A7:'写実',A8:'サンセリフ'}, codingBasis:'設計書から符号化',
        decisions:[{ decision:'4変数を王道条件に固定。', seek:'基準線。', evidence:'①S-0と同一の調査設計原則。' }],
        glance:'王道の銀缶。名前だけNODE。', measurement:'基準値。',
        ledger:{ keeps:[{code:'地の金属光沢'},{code:'中央対称構図'},{code:'泡・麦の写実'}], breaks:[], note:'基準線' },
        system:{ palette:[{hex:'#D9DCE0',name:'銀'}], motif:'王道写実', typography:'サンセリフ', composition:'中央', finish:'金属', tone:'ど真ん中' },
        prompts:{ board:'', package:'', kv:'' }
      }, {control:true, risks:[]}),

      _dirSeed('ct-3','den-city','C-3 窓越しの琥珀', null, {
        label:'構図で語る（可読強化）', proposition:'都会的な距離とは、窓越しに見る温度である。',
        fixedVars: DEN_FIXED,
        bet:'出自: 世界観「かっこいいけど冷たさもある都会的」＝電通資料コンセプトD／窓の構図＝ツール提案。賭け: ガンメタルの枠（冷）の中に琥珀のビール写実（温）を一点だけ覗かせれば、冷たさと飲みたさが両立するという読み。C-1/C-2が捨てたビール写実の錨を、距離の構図ごと回収する。',
        aim:'冷たさ系方向の「味の手掛かり喪失」リスク（C-2台帳）への対抗案。',
        coding:{A1:'ガンメタル×琥珀',A2:'金属',A3:'窓と琥珀写実',A4:'静的',A5:'中央の窓',A6:'なし',A7:'枠抜き',A8:'エクステンデッド'}, codingBasis:'設計書から符号化',
        decisions:[{ decision:'写実は窓の内側のみ・面積は缶面の1/4以下。', seek:'冷たさ（世界観）と温度（可読）の面積配分の統制。', evidence:'C-2の台帳仮説「完全無図像は味の手掛かり喪失」への設計内対抗——同一タブで写実量を段階化し効果を比較できる。' }],
        glance:'冷たい枠の中央の窓に、琥珀がひとつ灯る。',
        measurement:'C-1/C-2との相対: 写実量と「飲みたさ」「都会らしさ」のトレードオフ実測。',
        ledger:{ keeps:[{code:'地の金属光沢'},{code:'泡・麦の写実',note:'窓内に限定'},{code:'下部情報帯'}], breaks:[{code:'地の色相域＝銀白・金系', hypothesis:'暗色枠は黒ビール誤読の恐れ', measure:'味の事前想起'}], note:'' },
        system:{ palette:[{hex:'#3E434B',name:'ガンメタル'},{hex:'#C98A1F',name:'琥珀'}], motif:'窓と琥珀', typography:'エクステンデッド', composition:'中央窓', finish:'金属', tone:'夜の窓' },
        prompts:{ board:'', package:'', kv:'' }
      }, {control:false, risks:['黒ビール誤読']}),

      _dirSeed('ct-0','den-city','C-0 統制「CITY、王道のまま」', null, {
        label:'基準', proposition:'世界観を様式化しない基準線。',
        fixedVars: DEN_FIXED,
        bet:'出自: 統制設計＝①S-0の文法適用（ツール判断）。賭け: C-1〜C-3との差＝City世界観の様式化の寄与量。',
        aim:'様式化の寄与量の分離測定。',
        coding:{A1:'銀白',A2:'金属',A3:'王道写実',A4:'静的',A5:'中央シンメトリー',A6:'なし',A7:'写実',A8:'グロテスク'}, codingBasis:'設計書から符号化',
        decisions:[{ decision:'4変数を王道条件に固定。', seek:'基準線。', evidence:'①S-0と同一の調査設計原則。' }],
        glance:'王道の銀缶。名前だけCITY。', measurement:'基準値。',
        ledger:{ keeps:[{code:'地の金属光沢'},{code:'中央対称構図'},{code:'泡・麦の写実'}], breaks:[], note:'基準線' },
        system:{ palette:[{hex:'#D9DCE0',name:'銀'}], motif:'王道写実', typography:'グロテスク', composition:'中央', finish:'金属', tone:'ど真ん中' },
        prompts:{ board:'', package:'', kv:'' }
      }, {control:true, risks:[]})

    ],

    refs: [],
    briefs: [
      { id:'brief-universe', status:'open', created:'2026-07-06T00:00:00Z',
        title:'浄化の意匠体系の棚卸し — 方向の範囲を確定する調査',
        trigger:'実行済みディープリサーチ44件（コンプライアンス／賭け別の論拠／定量／棚の解像度／海外予兆／同型事例の6区分）と照合済み——浄化の意匠体系の総合棚卸しはこの44件に含まれない真の残ギャップ。方向の定義の体系リストはツール内監査の一次結果であり、見落とし検査が未了のため。',
        text:'【背景】サントリーRIB「澄虎」（気枯れを祓う神聖な一杯）の缶・広告の表現方向を、意匠体系からの導出で設計している。現在の5体系はツール内の記号監査による一次列挙であり、見落としの検査をしたい（＝方向の範囲の確定）。戦略・コンセプト（誰の気枯れか・浄化の需要）は資料で決着済みのため、生活者の行動・意識の調査は本依頼の対象外。\n【確認したい事実】\n(1) 日本（必要に応じ東アジア）の視覚文化で「浄化・清め・神聖・結界」を意味してきた意匠・記号・技法の体系的棚卸し: 伝統文様／宗教美術・神事の意匠／書芸・水墨／染織・生活の意匠／建築・空間の意匠（鳥居・結界・数寄屋等）／現代の記号（サウナ・スピリチュアル等）。各記号について、意味の出典（文献・使用文脈）と、飲料・食品パッケージでの先客ブランドを付記。\n(2) 「清め・リセット・切り替え」を訴求の核にした商品パッケージの事例コーパスと成否（公開数値）。\n【出力形式】(1)体系→記号→意味の出典→先客→缶での使用可否メモ の表 (2)事例表（訴求・デザイン要素・結果・出典）。\n【判定への使い方】現5体系が引いていない体系・記号が出れば候補行を追加して採用/棄却/保留を再判定。覆われていれば「この棚卸しの範囲で」体系リストの網羅を主張する。' },
      { id:'brief-den-naming', status:'open', created:'2026-07-07T00:00:00Z',
        title:'未決ネーミングの型と先客 — ③A〜D＋季節ベストバランスの商品名候補を監査する調査',
        trigger:'③の4タブは商品名が本来のアウトプットだが、現状は缶上に第一仮案（アサギリ／シジマ／アワイ／宵）を監査未実施のまま掲示した状態（②と同方式）。各タブに生成ロジック（型）と仮案を一次提案したが、商標・先客・音・意味の監査が未実施のため。',
        text:'【背景】電通資料の世界観コンセプト4系（Misty/QUIET/NODE/City）それぞれに、名前の生成ロジックと仮案を設計済み: A=アサギリ（大気の和語）・ミスト保留／B=シジマ・フトコロ／C=アワイ・ムスビ／D=ヨイ（アーバンは棄却）。\n【確認したい事実】(1)各仮案の商標DB（酒類区分）での同一・類似、酒類・飲料の先客ブランド（特にアサギリ×日本酒、シジマ×焼酎・日本酒、宵×酒銘の使用状況） (2)音の衝突: アワイ×アワセ（同一ポートフォリオ内の識別可能性）、ヨイ×酔い（自主基準の過度飲酒想起に触れないか） (3)季節ベストバランス（ブレンデッド）の仮案: アワセ（合わせる名詞化×泡）／シラベ（調べ）／トキワ（常盤＝通年不変。菓子・他業種の先客が濃厚）の商標・先客・音。(4)各コンセプトの命名で先行市場（国内新ビール・RTD直近2年）が使った型の帰納と、当方の型一覧に無い型。\n【出力形式】仮案×検査項目の判定表／先客表（名前・カテゴリ・年・出典）／追加型の候補と根拠。\n【判定への使い方】判定表で仮案を採用/差し替え。判定で確定した名前に缶上の仮案を置換（または維持）して再現像。' },
      { id:'brief-den-lexicon', status:'open', created:'2026-07-07T00:00:00Z',
        title:'世界観4系の視覚語彙棚卸し — ③A〜Dの範囲を確定する調査',
        trigger:'③の4タブ（Misty/QUIET/NODE/City）の方向は各世界観の賭けから導出した一次案で、各タブの空白象限（具象×完了／出す×余白／情緒×場／温×質感）の充填候補と、視覚語彙の見落とし・先客が未検査のため。',
        text:'【背景】電通議論資料の世界観/情緒性コンセプト4系について、各系の意匠方向を軸導出＋マップ化済み（各3方向＋統制＋空白象限1）。範囲の見落とし検査をしたい。\n【確認したい事実】節ごとに: (A)Misty=「柔らかさ×整い」を担ってきた視覚語彙（大気・ガラス・秩序系）の棚卸しと飲料先客（特に「整う」系の意匠占有: 綾鷹2024波紋の確認含む） (B)QUIET=「内なる豊かさ・静けさ」の語彙（低彩度・内包・余白系）と高級酒の既存文法 (C)NODE=「中間・調律・結節」の語彙（計器・結び・座標系）とガジェット/進物の誤帰属境界 (D)City=「都会的距離感」の語彙（反射・グリッド・窓系）とクラフト系の占有。各系で空白象限の充填候補（実在の意匠・技法）を最低2件ずつ。\n【出力形式】系→語彙→意味の出典→先客→缶での使用可否メモ の表＋空白象限充填候補表。\n【判定への使い方】充填候補が出れば各マップの空白象限を方向化して再判定。出なければ「この棚卸しの範囲で」空白の妥当性を主張する。' },
      { id:'brief-naming-alt', status:'open', created:'2026-07-07T00:00:00Z',
        title:'浄化系ネーミングの型と先客の棚卸し — ②の範囲を確定する調査',
        trigger:'②気枯れ・別解の型一覧（A構造/B行為/C表記/D情景）はツール内の一次提案であり、型の見落としと各仮案（澄雷・ミソギ・KIYOTORA）の成立可否（商標・先客・音・宗教語の直接性）が未検査のため。関係マップの空白象限（行為×漢字）の充填可否判定にも本結果が必要。',
        text:'【背景】RIB開発コンセプト①（気枯れを祓う神聖な一杯）で、与件名「澄虎」に依存しない商品名の別解を幅出ししている。名前の生成ロジック（型）を4本仮置きし、各型1仮案で意匠連鎖まで設計済み。型の網羅と仮案の成立可否を検査したい。\n【確認したい事実】\n(1) 清め・浄化・リセットを名に持つ酒類・飲料の先客ブランドの棚卸し（国内・必要に応じ東アジア。名前／型の分類／カテゴリ／現況）。\n(2) 仮案3件の一次スクリーニング: 商標DB（酒類区分）での同一・類似の有無／読みの衝突／宗教語の直接使用の広告実例と社会的受容（特に「ミソギ」「祓」）。\n(3) 型の見落とし: 上記棚卸しから帰納される命名の型で、A〜Dに含まれないもの。\n【出力形式】(1)先客表（名前・型・カテゴリ・出典）(2)仮案×検査項目の判定表 (3)追加すべき型の候補と根拠。\n【判定への使い方】仮案の判定→採用/差し替え。追加型→derivationに行を足し空白象限の充填可否を再判定。完了時点で②の型一覧の網羅を「この棚卸しの範囲で」主張する。' },
      { id:'br-seed-b4', created:'2026-07-06T00:00:00Z', trigger:'B-4 季節で回る缶（監査ギャップ）', status:'open',
        title:'季節記号と「限定品コード」の識別条件に関する調査',
        text:'背景: サントリーの新ビールブランド（コンセプト: 季節ごとにラガー×エールのブレンド比を調律する定番ビール）で、缶面の帯・地色が四季で回転するパッケージ構造を検討している。戦略上の最重要制約は「限定品・季節限定に見えるのはNG（定番＝ド真ん中に見えること）」であり、季節の視覚記号と限定品コードの識別条件を確認したい。\n確認したい事実: (1) 国内ビール・飲料で「定番品なのに季節でパッケージが変わる」前例（サッポロ秋味等の季節限定品ではなく、通年定番の季節回転）とその市場受容。(2) 他カテゴリ（食品・日用品・タバコ等）で通年定番×季節回転パッケージを実施したブランドと、限定品と誤読された/されなかった要因の分析。(3) 消費者調査・業界資料における「限定品らしさ」を構成する視覚要素の特定（季節モチーフ・数量表記・イベント記号等の寄与）。(4) 流通側（小売バイヤー）が季節回転SKUを定番棚として扱う条件。\n出力形式: 各findingを {fact, hint, sources[{title,url,date}]} で。一次資料優先、推測はhint側に分離。' }
    ]
}));
}
function _applyVariants(p){ p.directions = p.directions.map(_expandVariants); return p; }
/* ペア弁別課題（機械実行）: 対象集合の全2缶ペアが、スキーマの8属性のうち少なくとも1つで区別できるか */
function _cbPairTest(cb){
var ids = (cb.targets||[]).map(function(t){return t.id;}).filter(function(id){return cb.table[id];});
var collisions = [];
for (var i=0;i<ids.length;i++) for (var j=i+1;j<ids.length;j++){
var a=cb.table[ids[i]].cells, b=cb.table[ids[j]].cells;
var diff = cb.schema.some(function(at){ return (a[at.id]||{}).v !== (b[at.id]||{}).v; });
if (!diff) collisions.push(ids[i]+' × '+ids[j]);
}
cb.pairTest = {
status: ids.length<2 ? 'pending' : (collisions.length ? 'failed' : 'passed'),
tested: ids.length,
collisions: collisions,
note: ids.length<2 ? '符号化された対象が2本未満のため未実施'
: (collisions.length ? '区別できないペアあり＝属性の追加が必要: '+collisions.join(' / ')
: ids.length + '本の全' + (ids.length*(ids.length-1)/2) + 'ペアが少なくとも1属性で区別可能。スキーマv1は現時点の検査を通過（画像確定後に再実行）')
};
return cb;
}
function _deriveContrast(p){
var cb = p.audit && p.audit.codebook; if (!cb) return p;
var seen = {}, out = [];
(cb.misreads||[]).forEach(function(m){
(m.reps||[]).forEach(function(r){
if (seen[r.id]) { seen[r.id].why += ' ／ ' + m.wall; return; }
var item = { id:r.id, brand:r.brand, category:m.category, why:'判定対象リスク: '+m.wall, repBasis:r.repBasis, misreadId:m.id };
seen[r.id] = item; out.push(item);
});
});
cb.contrast = out;
cb.coverage = _cbCoverage(p);
_cbComputeCodes(cb);
_cbPairTest(cb);
return p;
}
/* 網羅性の機械検査: 記録済みの全誤読リスク（可動域の失敗前例＋方向の変位注記＋規制由来）に判定手段が割当済みか */
function _cbCoverage(p){
var cb = p.audit.codebook;
var required = {};
((p.space||{}).variables||[]).forEach(function(v){ if (v.wall) required[v.wall] = true; });
(p.directions||[]).forEach(function(d){
((d.axis||{}).risks||[]).forEach(function(r){ required[r] = true; });
});
required['ノンアル誤認（規制由来）'] = true;
var reqList = Object.keys(required);
var missing = [];
reqList.forEach(function(r){
var hit = (cb.misreads||[]).some(function(mr){
return (mr.covers||[]).some(function(c){ return r.indexOf(c) >= 0 || c.indexOf(r) >= 0; });
});
if (!hit) missing.push(r);
});
return { total: reqList.length, covered: reqList.length - missing.length, missing: missing, required: reqList };
}
/* 命題の強度サンプリング（ささやく/言い切る/最大声量）— 統制・凍結以外を3水準化 */
/* プロンプト規則（image2一次リサーチ・OpenAI Cookbook準拠）: 用途宣言→対象→レイアウト→詳細→不変条件の一貫順序 / 文字は引用符でverbatim・配置と書体を明記 / 変更可能と不変を分離し不変条件は毎回言い直す / レイアウトは領域語 / 実在プロダクトとして記述 / 負の制約は具体的に。設計の言語化（値+理由）はDESIGNSに構造化し、プロンプトは機械生成＝設計書と生成物の乖離を原理排除 */
var DESIGNS = {"sumi-s0-v0": {"surface": {"v": "銀のヘアライン金属地（明度L82）", "en": "brushed bright silver aluminum, subtle vertical hairline", "why": "王道8缶の光沢コード8/8に完全準拠＝統制の定義"}, "motif": {"v": "印刷図像: 琥珀のビール液面と白い泡頭の写実を肩の帯に、金線の小さな白虎紋を胴中央下に", "en": "printed label artwork on the shoulder band: photoreal amber beer with white foam head; one small white tiger crest in fine gold line below center", "why": "王道写実系の準拠。虎紋は名前の意味の錨"}, "layout": {"v": "完全中央対称。上15%肩帯/中央60%ブランドブロック/下25%情報帯", "en": "perfect central symmetry: top 15% quality band, middle 60% brand block, bottom 25% information band", "why": "中央対称コード8/8への準拠"}, "logo": {"v": "「澄虎」紺の毛筆・縦組み・缶幅58%・光学中心（幾何中心+2%上）。下にSUMITORA細身セリフ", "en": "vertical brush-calligraphy logo 澄虎 in deep navy, 58% of can width, at optical center (2% above geometric center); SUMITORA in thin serif beneath", "why": "名前だけで運ぶ統制の命題＝名前が最大の視覚要素。光学中心は缶曲率の錯視補正"}, "copy": {"v": "まっすぐ、うまい。", "en": "まっすぐ、うまい。", "why": "統制＝装飾ゼロの宣言。読点1つの断言調"}}, "sumi-s1-vLo": {"surface": {"v": "白→淡青（#F4F7F9→#BFD9E6）の垂直グラデ、光沢は水面反射として維持", "en": "vertical gradient from white #F4F7F9 (top) to pale aqua #BFD9E6 (bottom), metallic sheen kept as soft water-light reflections", "why": "色単体で命題を運ぶ。淡青は下部・上部は白＝清涼飲料の全面ブルーと差別化"}, "motif": {"v": "図像なし（泡・麦の印刷は下部情報帯の中のみ）", "en": "NO pictorial motif on the body; printed foam and barley artwork appear ONLY inside the bottom information band", "why": "色の寄与を分離測定するため図像変数をゼロ固定"}, "layout": {"v": "中央対称。ロゴ上寄せ（上から38%）で下半分をグラデの見せ場に", "en": "central symmetry; logo centered at 38% from top, keeping the lower half as an uninterrupted gradient field", "why": "色が語る面積の最大化"}, "logo": {"v": "「澄虎」紺毛筆・縦・缶幅56%", "en": "vertical navy brush logo 澄虎 at 56% of can width", "why": "図像なしのため名前が形の主役を兼ねる"}, "copy": {"v": "澄む、一杯。", "en": "澄む、一杯。", "why": "色の体感の最少宣言"}}, "sumi-s1-v0": {"surface": {"v": "白地（#F6F8FA）・サテン金属", "en": "clean white ground #F6F8FA with satin metallic finish", "why": "図像を主役にする静かな地"}, "motif": {"v": "印刷図像: 藍1色の観世水の水紋が下1/3を覆い、水際に立つ白虎の細線画（缶幅30%）", "en": "printed artwork: indigo one-color KANZEMIZU stylized water-ripple pattern covering the lower third; a fine-line white tiger standing at the water edge, 30% of can width", "why": "伝統文様＝解読コスト最小の清流語彙。白虎はネーミング根拠の図像化"}, "layout": {"v": "上2/3=白＋ロゴ、下1/3=水紋帯。境界は静かな水平線", "en": "upper two-thirds: quiet white with the logo; lower third: the ripple band; one calm horizontal boundary", "why": "図像と名前の領域分離で両可読を守る"}, "logo": {"v": "「澄虎」紺毛筆・縦・缶幅42%・上1/3", "en": "vertical navy brush logo 澄虎 at 42% width, placed in the upper third", "why": "図像が主役のためロゴは従（統制58%→42%）"}, "copy": {"v": "濁りのない世界へ。", "en": "濁りのない世界へ。", "why": "図像の世界へ誘う"}}, "sumi-s1-vHi": {"surface": {"v": "缶面全体が夜明けの水源の風景写真: 下1/3=鏡面の水面（淡青#BFD9E6）、上=白〜淡青の空。暖色・夕景は禁止", "en": "the entire can face is a photographic dawn landscape: lower third is a mirror-calm water surface in pale aqua #BFD9E6, upper part a white-to-pale-blue dawn sky. STRICTLY cool color temperature; NO sunset, NO warm orange or golden glow", "why": "構図で語る。前ロットの夕景ドリフトを色温度の負制約で封鎖"}, "motif": {"v": "風景そのものが図像。遠景の山影は淡青灰1トーンまで", "en": "the landscape itself is the motif; distant mountain silhouettes in one pale blue-gray tone only", "why": "要素を足さず構図に語らせる"}, "layout": {"v": "低い水平線（下から30%）で横分割。空の負空間にロゴ", "en": "low horizon line at 30% from the bottom; the logo floats in the negative space of the sky", "why": "低重心=静けさの風景文法"}, "logo": {"v": "ローマ字SUMITORA・細身セリフ・横組み・缶幅24%・空の右上（漢字「澄虎」は情報帯に小さく併記）", "en": "horizontal thin roman serif wordmark SUMITORA at 24% width, upper-right of the sky; small 澄虎 in the bottom information band", "why": "風景写真の文法にはローマ字横組みが干渉最小（天然水系の実文法）。漢字縦大の同質化を破る表記系の幅出し"}, "copy": {"v": "水源から、そのまま。", "en": "水源から、そのまま。", "why": "風景=源泉直送の含意の固定"}}, "sumi-s2-vLo": {"surface": {"v": "奉書紙の白（#F6F3EC）・織目エンボス・金は極細縁線のみ", "en": "dense hosho-paper white #F6F3EC with subtle woven emboss; gold restricted to one hairline border", "why": "素材単体の分離測定。和素材は質感1点に絞る（プライドポテトの教訓）"}, "motif": {"v": "図像なし", "en": "NO pictorial motif", "why": "素材の寄与の分離"}, "layout": {"v": "完全中央対称・余白多め", "en": "perfect central symmetry with generous empty margins", "why": "白の密度を見せる"}, "logo": {"v": "「澄虎」紺毛筆・縦・缶幅54%", "en": "vertical navy brush logo 澄虎 at 54% width", "why": "素材＋名前の2要素"}, "copy": {"v": "今日を、清める。", "en": "今日を、清める。", "why": "儀式の動詞を日常語で"}}, "sumi-s2-v0": {"surface": {"v": "奉書白（#F6F3EC）・紙布マット", "en": "hosho-paper white #F6F3EC, matte paper-cloth texture", "why": "儀式の白の地"}, "motif": {"v": "印刷図像: 截金様式（金の細線象嵌）の白虎紋・缶幅34%・中央上。光の玉・オーラ厳禁", "en": "printed artwork: a white tiger crest in KIRIKANE style (fine inlaid gold lines), 34% of can width, upper center. STRICTLY no glowing orbs, no aura, no purple gradients", "why": "仏教美術の実在技法=格。スピリチュアル記号は監査で禁止"}, "layout": {"v": "結界の中央対称: 紋→ロゴ→情報帯の縦一列", "en": "shrine-like central symmetry: crest, then logo, then info band on one vertical axis", "why": "神前対称と王道対称コードの同型"}, "logo": {"v": "「澄虎」紺毛筆・縦・缶幅40%・紋の直下", "en": "vertical navy brush logo 澄虎 at 40% width, directly beneath the crest", "why": "紋が主役、名は従"}, "copy": {"v": "邪気、祓う。", "en": "邪気、祓う。", "why": "守護神図像の機能の直言"}}, "sumi-s2-vHi": {"surface": {"v": "奉書白・紙布マット", "en": "hosho-paper white, matte paper-cloth", "why": "同地で構図のみ変位"}, "motif": {"v": "印刷図像: 鳥居型の細い金枠が缶面を囲み、中心に極小（缶幅12%）の截金虎紋のみ", "en": "printed artwork: a thin gold torii-shaped rectangular frame enclosing the face; only one tiny KIRIKANE tiger crest (12% width) at the exact center", "why": "余白そのものを神聖の主役に"}, "layout": {"v": "圧倒的余白の完全対称。要素は中心軸に極小整列", "en": "overwhelming empty space, perfect symmetry; minimal elements aligned on the center axis", "why": "結界=空白の構図で語る"}, "logo": {"v": "「澄虎」紺毛筆・縦・缶幅26%・紋の下", "en": "vertical navy brush logo 澄虎 at 26% width beneath the crest", "why": "構図主役の最小可読"}, "copy": {"v": "静けさを、飲む。", "en": "静けさを、飲む。", "why": "余白の体感の言語化"}}, "sumi-s3-vLo": {"surface": {"v": "銀白金属（L*84）", "en": "bright silver-white metal", "why": "酒種可読の錨を地色で維持"}, "motif": {"v": "印刷図像: 一筆書きの墨の虎を円形紋章に収める・缶幅32%", "en": "printed artwork: a tiger drawn in ONE continuous sumi brush stroke, contained as a circular crest, 32% of can width", "why": "気迫を紋章コードの内側で言う最小リスク執行"}, "layout": {"v": "中央対称: 紋→ロゴの縦軸", "en": "central symmetry: crest above logo on one axis", "why": "王道構図の維持"}, "logo": {"v": "「澄虎」横組み毛筆・缶幅38%＋SUMITORA小併記", "en": "HORIZONTAL navy brush logo 澄虎 at 38% width with small SUMITORA beneath", "why": "紋章が縦の気迫を担うため、名は横組みで静かに支える（縦大一辺倒の同質化を破る）"}, "copy": {"v": "静かに、強い。", "en": "静かに、強い。", "why": "紋に収めた気迫"}}, "sumi-s3-v0": {"surface": {"v": "銀白金属＋墨部のみ濡れ艶グロス", "en": "bright silver-white metal; wet-ink gloss ONLY on the stroke area", "why": "素材コード維持＋墨の物質感"}, "motif": {"v": "印刷図像: 左下→右上の一閃の墨ストローク（缶面長の70%）に白抜きの虎が融合", "en": "printed artwork: ONE bold sumi ink stroke sweeping from lower-left to upper-right (70% of face length); a white tiger figure fused inside the stroke in negative space", "why": "雲龍図系譜の動勢"}, "layout": {"v": "対角の動勢。ロゴは右上の静域に固定", "en": "diagonal dynamism; the logo locked in the calm upper-right zone", "why": "動と可読の分離"}, "logo": {"v": "「澄虎」紺毛筆・縦・缶幅36%・右上", "en": "vertical navy brush logo 澄虎 at 36% width, upper right", "why": "一閃が主役"}, "copy": {"v": "一閃、澄む。", "en": "一閃、澄む。", "why": "動勢→澄みの因果を4字で"}}, "sumi-s3-vHi": {"surface": {"v": "下半分=濡れ艶の墨黒面、上半分=銀白金属。境界は破れ墨のエッジ", "en": "lower half: deep wet-gloss sumi-black field; upper half: bright silver metal; the boundary is one confident torn ink edge", "why": "墨の物質感を面で言う"}, "motif": {"v": "印刷図像: 墨面に白抜きの虎（缶幅40%）", "en": "printed artwork: a white tiger reversed out in the black field, 40% width", "why": "黒面の意味付け"}, "layout": {"v": "上下二分割。上=可読域、下=墨面", "en": "horizontal split: upper = legibility zone, lower = ink field", "why": "黒面と必須表示の共存"}, "logo": {"v": "「澄虎」紺毛筆・縦・缶幅40%・上半分中央", "en": "vertical navy brush logo at 40% width, centered in the upper half", "why": "黒面が主役"}, "copy": {"v": "濁りを、断つ。", "en": "濁りを、断つ。", "why": "墨=断絶の直言"}}, "sumi-s4-vLo": {"surface": {"v": "銀白金属", "en": "bright silver metal", "why": "王道地+帯1本の最小執行"}, "motif": {"v": "印刷図像: 缶上部22%に藍染のれん帯（織目・裾の切れ込み・抜染の白虎紋）", "en": "printed artwork: an indigo-dyed noren fabric band across the top 22% of the face, with weave texture, hem slits, and a resist-dyed white tiger crest", "why": "のれん記号を帯一本に留める"}, "layout": {"v": "帯の下は王道の中央対称", "en": "below the band: conventional central symmetry", "why": "限定品誤読の最小化"}, "logo": {"v": "「澄虎」紺毛筆・縦・缶幅44%・帯の下", "en": "vertical navy brush logo at 44% width beneath the band", "why": "帯と名の主従"}, "copy": {"v": "くぐって、切り替える。", "en": "くぐって、切り替える。", "why": "所作の直言"}}, "sumi-s4-v0": {"surface": {"v": "上2/3=藍染布（織目・染めムラ）、下1/3=銀金属の下界", "en": "upper two-thirds: indigo-dyed fabric with visible weave and dye unevenness; lower third: bright silver metallic underworld", "why": "二界の素材対比"}, "motif": {"v": "印刷図像: 布に抜染の白虎紋（缶幅30%）。中央スリットから下界が覗く", "en": "printed artwork: resist-dyed white tiger crest (30% width) on the fabric; a bright central slit reveals the lower world", "why": "くぐる前後を1缶で"}, "layout": {"v": "上下二界・中央スリット。下界に泡・麦の印刷写実と情報帯を最小可読で圧縮", "en": "two-world composition with a central slit; printed foam/barley artwork and the info band compressed into the lower world at minimum legible size", "why": "構図が主役の攻め端"}, "logo": {"v": "「澄虎」白抜き毛筆・縦・缶幅38%・のれん上", "en": "vertical resist-white brush logo at 38% width on the noren", "why": "布の文法の白抜き"}, "copy": {"v": "のれんの向こうへ。", "en": "のれんの向こうへ。", "why": "二界構図の誘い"}}, "sumi-s4-vHi": {"surface": {"v": "缶面全体が一枚の藍染布。裾のみ細い銀帯", "en": "the entire face is one indigo-dyed fabric; only a narrow silver band at the very bottom", "why": "布の全面化=素材で語る計器"}, "motif": {"v": "印刷図像: 大きな抜染白虎紋（缶幅44%）", "en": "printed artwork: one large resist-dyed white tiger crest, 44% width", "why": "布と紋の2要素"}, "layout": {"v": "中央対称・裾の銀帯に情報集約", "en": "central symmetry; all mandatory info gathered in the bottom silver band", "why": "可読の下限測定"}, "logo": {"v": "「澄虎」白抜き毛筆・縦・缶幅48%", "en": "vertical resist-white brush logo at 48% width", "why": "布に染め抜かれた名"}, "copy": {"v": "今日を、脱ぐ。", "en": "今日を、脱ぐ。", "why": "切替の身体語"}}, "blend-b0-v0": {"surface": {"v": "金（#E8D9A8）×白の王道ツートン・高光沢", "en": "conventional gold #E8D9A8 and white two-tone, high-gloss metal", "why": "統制"}, "motif": {"v": "印刷図像: 麦芽と泡の写実を中央〜下部に", "en": "printed artwork: photoreal barley ears and beer with foam head in the center-lower area", "why": "王道写実系の準拠"}, "layout": {"v": "中央対称＋肩に「季節ベストバランス」一行", "en": "central symmetry; one quiet shoulder line 季節ベストバランス", "why": "言葉だけの差分"}, "logo": {"v": "骨太ゴシック横組みロゴ・缶幅70%", "en": "bold horizontal gothic wordmark アワセ at 70% width, small roman AWASE beneath", "why": "王道の骨太"}, "copy": {"v": "季節に、調律。", "en": "季節に、調律。", "why": "機能の宣言"}}, "blend-b1-vLo": {"surface": {"v": "全面深紺（#152447）の漆調グロス・金は極細線", "en": "entire face in deep navy #152447 with lacquer-depth gloss; gold as hairlines only", "why": "色単体で格を運ぶ"}, "motif": {"v": "印刷図像: 増強した金色ビールと白泡の写実を下部帯に大きく", "en": "printed artwork: AMPLIFIED photoreal golden beer and white foam in a large lower band", "why": "緑茶可読の防波堤"}, "layout": {"v": "中央対称", "en": "central symmetry", "why": "格の正統"}, "logo": {"v": "金の毛筆縦ロゴ・缶幅50%", "en": "vertical brush wordmark アワセ in gold at 50% width", "why": "紺×金の格"}, "copy": {"v": "間違いのない一杯。", "en": "間違いのない一杯。", "why": "信用の直言"}}, "blend-b1-v0": {"surface": {"v": "白銀地＋深紺の縦帯（缶幅38%）・金の縁線", "en": "silver-white ground with one deep navy vertical band (38% of width) edged in thin gold", "why": "綾鷹型の帯の格文法"}, "motif": {"v": "印刷図像: 帯内に麦の家紋エンブレム（缶幅18%）＋帯外に麦・泡の写実", "en": "printed artwork: a barley family-crest emblem (18% width) inside the band; photoreal barley and foam outside it", "why": "家の物語×ビール可読"}, "layout": {"v": "縦帯の正統・帯内に紋→ロゴ", "en": "vertical band composition; crest above wordmark inside the band", "why": "暖簾=縦布の記憶"}, "logo": {"v": "毛筆縦ロゴ・帯内・缶幅34%", "en": "vertical brush wordmark inside the band at 34% width", "why": "帯が主役"}, "copy": {"v": "暖簾を、継ぐ味。", "en": "暖簾を、継ぐ味。", "why": "縦帯=暖簾の意味の固定"}}, "blend-b1-vHi": {"surface": {"v": "白銀金属", "en": "silver-white metal", "why": "紋を立てる地"}, "motif": {"v": "印刷図像: 紺の大きな麦の家紋（缶幅52%・金細線縁）を上部中央", "en": "printed artwork: one LARGE navy barley family crest with gold hairline (52% of width), upper center", "why": "図像で語る執行"}, "layout": {"v": "中央対称・紋→ロゴ→写実帯", "en": "central symmetry: crest, wordmark, then realistic beer band", "why": "紋章コードの最大化"}, "logo": {"v": "毛筆縦ロゴ・缶幅30%", "en": "vertical brush wordmark at 30% width", "why": "大紋が主役"}, "copy": {"v": "家の味、という安心。", "en": "家の味、という安心。", "why": "紋=家の信用"}}, "blend-b2-vLo": {"surface": {"v": "クラフト紙の生成り（#E9E2D0）・活版の押し痕", "en": "warm kraft paper #E9E2D0 with letterpress impressions", "why": "紙の質感単体"}, "motif": {"v": "図像なし。活版の罫線のみ", "en": "NO pictorial motif; letterpress rule lines only", "why": "素材の分離測定"}, "layout": {"v": "王道の中央対称を活版組版で", "en": "conventional central symmetry set in letterpress typography", "why": "クラフト誤読の最小化"}, "logo": {"v": "活版風明朝の横組みロゴ・缶幅64%", "en": "horizontal letterpress-style mincho wordmark at 64% width", "why": "紙×活字の2要素"}, "copy": {"v": "今季の配合、決まりました。", "en": "今季の配合、決まりました。", "why": "工房の報告文体"}}, "blend-b2-v0": {"surface": {"v": "生成りの紙地", "en": "warm kraft paper ground", "why": "工房の記録紙"}, "motif": {"v": "印刷図像: 手書きの配合比メモ「ラガー62:エール38 今季」と朱の検印", "en": "printed artwork: a handwritten blend-ratio note ラガー62:エール38 今季 and a red workshop inspection stamp", "why": "中味の実データの図像化"}, "layout": {"v": "記録紙の秩序: 上=ロゴ、中=手書き配合、下=情報帯", "en": "record-sheet order: wordmark top, handwritten ratio middle, info band bottom", "why": "人の手の証拠を中心に"}, "logo": {"v": "活版明朝の横組みロゴ・缶幅54%", "en": "horizontal letterpress mincho wordmark at 54% width", "why": "手書きが主役"}, "copy": {"v": "手で、合わせる。", "en": "手で、合わせる。", "why": "職人の動詞"}}, "blend-b2-vHi": {"surface": {"v": "素の銀缶＋実物のクラフト紙ラベル貼付（紙の厚み・端の浮き）", "en": "a plain brushed-silver can with a REAL kraft-paper label physically pasted on (visible paper thickness and lifted edges)", "why": "貼付の物質感=構図で語る"}, "motif": {"v": "貼付ラベル内に手書き配合と検印", "en": "on the pasted label: handwritten ratio and red stamp", "why": "工房の現物感"}, "layout": {"v": "銀地×貼りラベル。表記はラベル内に整列", "en": "composition of bare silver + pasted label; mandatory texts aligned inside the label", "why": "限定品誤読の計器"}, "logo": {"v": "活版明朝ロゴ・ラベル内・缶幅40%", "en": "letterpress mincho wordmark inside the label at 40% width", "why": "ラベルが主役"}, "copy": {"v": "職人の手が、締めた味。", "en": "職人の手が、締めた味。", "why": "手仕事の完了形"}}, "blend-b3-vLo": {"surface": {"v": "金（#C8A24B）と銅（#B4763B）の垂直二色分割・精密金属", "en": "precise vertical two-tone split: warm gold #C8A24B left, copper #B4763B right, machined metal finish", "why": "色だけで二流を言う"}, "motif": {"v": "図像なし。中央の継ぎ目1本", "en": "NO diagram; one clean center seam only", "why": "色の分離測定"}, "layout": {"v": "継ぎ目上にロゴ・グリッド整列", "en": "wordmark on the seam; grid-aligned typography", "why": "精密の秩序"}, "logo": {"v": "精密ゴシック横ロゴ・缶幅62%", "en": "horizontal precision-gothic wordmark at 62% width", "why": "2色+名の構成"}, "copy": {"v": "まざって、ちょうどいい。", "en": "まざって、ちょうどいい。", "why": "二流合一の口語"}}, "blend-b3-v0": {"surface": {"v": "白銀の精密金属（ヘアライン×鏡面）", "en": "silver-white machined metal, hairline and mirror zones", "why": "工学の地"}, "motif": {"v": "印刷図像: 金と銅の2流線が中央で合流し1本のリボンになる図（缶高55%）", "en": "printed artwork: an elegant diagram of two streams, gold and copper, merging into ONE ribbon at the center (55% of can height)", "why": "中味事実の直接図像化"}, "layout": {"v": "視線を合流点へ誘導・グリッド表記", "en": "composition guiding the eye to the merge point; grid-aligned annotations", "why": "解読失敗対策の視線設計"}, "logo": {"v": "精密ゴシック横ロゴ・缶幅48%・合流点直下", "en": "horizontal precision-gothic wordmark at 48% width, directly below the merge point", "why": "図が主役"}, "copy": {"v": "二つが、一つに。", "en": "二つが、一つに。", "why": "図の読みの固定"}}, "blend-b3-vHi": {"surface": {"v": "淡い白銀に青焼き図面の印刷（細グリッド・寸法線・注記）", "en": "pale silver printed like a blueprint: fine grid, dimension lines, small annotations", "why": "図面様式=構図で語る"}, "motif": {"v": "印刷図像: 合流図は図面内の詳細図（缶幅20%）に縮小", "en": "the merge diagram reduced to one detail figure (20% width) inside the drawing", "why": "様式が主役"}, "layout": {"v": "表題欄にロゴ、注記枠に表記を格納", "en": "wordmark in a title block; mandatory texts inside neat annotation boxes", "why": "図面文法の徹底"}, "logo": {"v": "精密ゴシックロゴ・表題欄内・缶幅36%", "en": "precision-gothic wordmark inside the title block at 36% width", "why": "様式従属"}, "copy": {"v": "設計された、うまさ。", "en": "設計された、うまさ。", "why": "工学の断言"}}};
var DESIGNS2 = {"kalt-a-v0": {"surface": {"v": "白銀金属地・上部に藍の雷文（らいもん）帯を一周", "en": "bright silver metal; one continuous band of indigo RAIMON (traditional Japanese thunder-scroll geometric pattern) around the upper shoulder", "why": "雷文＝中華圏・日本の器物で連綿と使われる伝統幾何文様（ラーメン丼の縁で国民的に既知）。「雷」を絵でなく文様で言えば奇抜さに落ちない——電通資料「斬新さ≠奇抜さ」への適合"}, "motif": {"v": "図像は雷文帯のみ。動物・気象の絵は置かない", "en": "NO pictorial motif besides the RAIMON band; no lightning bolts, no animals", "why": "名前（澄雷）が気象を言うので、絵で二重に言わない＝要素の役割分担"}, "layout": {"v": "中央対称。帯の下に縦ロゴ、下部情報帯", "en": "central symmetry; vertical logo beneath the band; conventional info band at bottom", "why": "王道対称コードの維持"}, "logo": {"v": "「澄雷」紺毛筆・縦・缶幅52%＋SUMIRAI小併記（※仮案・商標/先客/音の監査未実施）", "en": "vertical navy brush logo 澄雷 at 52% of can width, small SUMIRAI beneath", "why": "型A緩和形の仮案を可視化して比較する目的。名前の確定はネーミング監査後"}, "copy": {"v": "澄みが、走る。", "en": "澄みが、走る。", "why": "雷（走る力）→澄み（結果）の因果を最短で"}}, "kalt-b-v0": {"surface": {"v": "和紙白（#F5F2EA）マット・水流の型抜きエンボス", "en": "washi-white #F5F2EA matte with a debossed flowing-water pattern", "why": "禊＝水で清める行為。素材の白×水流の凹凸で行為の痕跡を言う"}, "motif": {"v": "印刷図像: 一筋の水流ラインが缶面を縦に流れる（藍1色・細）", "en": "printed artwork: ONE thin indigo stream line flowing vertically down the face", "why": "行為（水をくぐる）の最小図像化。神事の具体物（御幣・鳥居）は置かない＝記号監査の宿題を絵に持ち込まない"}, "layout": {"v": "水流ラインの右に縦ロゴ・下部情報帯", "en": "logo to the right of the stream line; conventional bottom info band", "why": "流れと名前の並走"}, "logo": {"v": "「ミソギ」カタカナ・水茎の細身書体・縦・缶幅46%（※仮案・神事語彙の記号監査＋商標監査未実施）", "en": "vertical katakana logo ミソギ in a slim fluid brush style at 46% width, small MISOGI beneath", "why": "カタカナ化＝儀式語の現代化（型B）。監査未実施の仮案であることを設計書に明記"}, "copy": {"v": "今日を、みそぐ。", "en": "今日を、みそぐ。", "why": "行為名をそのまま動詞に開く"}}, "kalt-c-v0": {"surface": {"v": "白磁のようなつや消し白（#F7F7F4）・光沢は水面のハイライトのみ", "en": "porcelain matte white #F7F7F4; gloss only as thin water-highlight lines", "why": "ローマ字主役＝国際水ブランドの文法（無地の白×細字）を借りる"}, "motif": {"v": "図像なし", "en": "NO pictorial motif", "why": "表記の転換だけを分離測定する執行"}, "layout": {"v": "左上にローマ字ロゴ横組み、下1/3に漢字「澄虎」小と情報帯", "en": "horizontal roman wordmark upper-left; small 澄虎 and the info band in the lower third", "why": "ローマ字が主・漢字が従の逆転構成（①タブの逆）"}, "logo": {"v": "「KIYOTORA」細身ジオメトリックサンセリフ・横組み・缶幅58%（※読み替え表記の実験＝ユーザー指示由来。音・商標の監査未実施）", "en": "horizontal thin geometric sans-serif wordmark KIYOTORA at 58% of can width; small vertical 澄虎 in navy near the bottom", "why": "型C＝表記の転換。読みの変更はネーミング領分に踏むため、確定はネーミング監査後と設計書に明記"}, "copy": {"v": "その名は、澄む。", "en": "その名は、澄む。", "why": "読み替えの意図（澄＝KIYO）を一行で教育"}}, "my-1-v0": {"surface": {"v": "白→灰青（#F6F7F8→#AEBDC8）の柔らかい靄のグラデ・粒子感", "en": "soft mist gradient from white #F6F7F8 to grey-blue #AEBDC8 with a fine atmospheric grain", "why": "Misty＝靄の直接翻訳。彩度を落とした灰青は「柔らかいけど整う」の温度（青すぎると清涼飲料・白すぎると空虚）"}, "motif": {"v": "図像なし。靄の階調そのものが図像", "en": "NO pictorial motif; the mist gradient itself is the imagery", "why": "世界観を色と大気だけで言う執行"}, "layout": {"v": "中央対称・ロゴは靄の中に静かに浮く（上から40%）", "en": "central symmetry; the logo floats quietly in the mist at 40% from top", "why": "柔らかさ＝硬いエッジを作らない"}, "logo": {"v": "「朝霧」細身セリフ・横組み・缶幅40%（仮案・監査未実施）", "en": "horizontal thin serif working label 朝霧 (ASAGIRI) at 40% of can width", "why": "商品名未決タブの表記固定。ラベルであることを設計書に明記"}, "copy": {"v": "もやの向こうで、整う。", "en": "もやの向こうで、整う。", "why": "靄（曖昧）→整い（着地）の往復を一行で"}}, "my-2-v0": {"surface": {"v": "白磁マット地に、等間隔の極細ライン（呼吸のリズム）を水平に", "en": "porcelain matte white with evenly spaced ultra-thin horizontal lines, like calm breathing rhythm", "why": "「整う」を秩序＝等間隔で言う。※波紋モチーフは綾鷹が2024年刷新で全面採用済みのため回避（先客監査）"}, "motif": {"v": "図像なし。ラインの秩序が図像", "en": "NO pictorial motif; the rhythmic line order is the imagery", "why": "呼吸・リズムの抽象化"}, "layout": {"v": "中央対称・ラインの一本だけ太く（今日の一杯の位置）", "en": "central symmetry; exactly ONE line slightly bolder than the rest", "why": "均質の中の一点＝「この一杯」の演出"}, "logo": {"v": "「凪」細身セリフ横・缶幅36%・太ラインの直上（仮案・監査未実施）", "en": "horizontal thin serif working label 凪 (NAGI) at 36% width, just above the bolder line", "why": "秩序の従属要素としての名前"}, "copy": {"v": "整う呼吸に、一杯。", "en": "整う呼吸に、一杯。", "why": "リズム＝呼吸の身体語"}}, "qt-1-v0": {"surface": {"v": "外側は静かな紺鼠（#3A4250）マット、缶口の縁と開口部の内側だけ金", "en": "quiet matte blue-grey #3A4250 body; gold ONLY on the rim line and visible inner lip of the can", "why": "「豊かさを内に」の文字通りの実装＝外は静か・内に金。外面の金を封じることで自慢しない豊かさ"}, "motif": {"v": "図像なし", "en": "NO pictorial motif", "why": "内外の対比だけで言う"}, "layout": {"v": "中央対称・要素最少", "en": "central symmetry, minimal elements", "why": "静けさの構図"}, "logo": {"v": "「懐」小さめ細身セリフ横・缶幅30%（仮案・監査未実施）", "en": "horizontal thin serif working label 懐 (FUTOKORO) at a modest 30% width", "why": "声量を下げた名前＝世界観の実装"}, "copy": {"v": "豊かさは、内にある。", "en": "豊かさは、内にある。", "why": "コンセプト文の直言"}}, "qt-2-v0": {"surface": {"v": "墨鼠（#4A4A48）×生成りの2トーン・低彩度・艶消し", "en": "two quiet tones: sumi-grey #4A4A48 and warm off-white, low saturation, matte", "why": "低彩度＝プレモル系の金ギラ・プレミアム文法と混同されない静かな豊かさ（先客回避を導出表に記録）"}, "motif": {"v": "印刷図像: 底部に小さな麦の穂1本の細密線画", "en": "printed artwork: ONE small fine-line barley ear near the bottom", "why": "豊かさの根拠（麦）を小声で一つだけ"}, "layout": {"v": "重心を下げた非対称（ロゴ下寄せ）", "en": "low-gravity asymmetric layout; logo set low", "why": "落ち着き＝低重心の構図文法"}, "logo": {"v": "「奥行」細身セリフ横・缶幅34%・下1/3（仮案・監査未実施）", "en": "horizontal thin serif working label 奥行 (OKUYUKI) at 34% width in the lower third", "why": "重心の実装"}, "copy": {"v": "静けさを、深く。", "en": "静けさを、深く。", "why": "内向きの深さ"}}, "nd-1-v0": {"surface": {"v": "白銀金属・中央に細い縦スリットのモード目盛（薄⇄濃）", "en": "bright silver metal; a slim vertical mode scale (light⇄rich) engraved at the center", "why": "結節点＝モード切替を計器で言う。※B-3（製法の図面）との差分: これは中味の説明でなく「自分のモード」の主観計器——導出表に明記"}, "motif": {"v": "印刷図像: 目盛の中点にマーカー1つ", "en": "printed artwork: one marker at the exact midpoint of the scale", "why": "「ちょうどよい」の位置の可視化"}, "layout": {"v": "目盛を軸にした左右対称・ロゴは中点の右", "en": "symmetric around the scale; logo to the right of the midpoint", "why": "計器の文法"}, "logo": {"v": "「中汲み」ジオメトリックサンセリフ横・缶幅38%（仮案・監査未実施）", "en": "horizontal geometric sans-serif working label 中汲み (NAKAGUMI) at 38% width", "why": "計器×幾何書体の整合"}, "copy": {"v": "モードを、合わせる。", "en": "モードを、合わせる。", "why": "チューニングの動詞"}}, "nd-2-v0": {"surface": {"v": "濃紺→淡青の垂直グラデ・ちょうど中間の高さに水平の細い白線", "en": "vertical gradient deep-navy to pale-aqua; ONE thin white horizontal line exactly at the midpoint", "why": "濃⇄淡のあいだ＝グラデの中点そのもの。目盛（nd-1）の絵画的な言い換え"}, "motif": {"v": "図像なし", "en": "NO pictorial motif", "why": "グラデと中点線のみ"}, "layout": {"v": "中点線の直上にロゴ", "en": "logo directly above the midpoint line", "why": "「ここがちょうどいい」の指差し"}, "logo": {"v": "「アワイ」サンセリフ横・缶幅36%（仮案・監査未実施）", "en": "horizontal sans-serif working label アワイ (AWAI) at 36% width", "why": "中立の書体"}, "copy": {"v": "濃いと淡いの、あいだへ。", "en": "濃いと淡いの、あいだへ。", "why": "コンセプト文の翻訳"}}, "ct-1-v0": {"surface": {"v": "ガンメタル（#3E434B）の鏡面に、夜の都市光の細い反射（白・琥珀の細線）が映る", "en": "gunmetal #3E434B mirror finish with thin reflections of night-city lights (white and amber hairlines)", "why": "都会的＝ネオン絵柄でなく「夜のガラスの映り込み」で言う（ネオン・スカイラインの絵はクラフト系の既存クリシェ＝導出表で棄却）"}, "motif": {"v": "図像なし。反射が図像", "en": "NO pictorial motif; the reflections are the imagery", "why": "クールの実装"}, "layout": {"v": "非対称・余白広め・ロゴ右上", "en": "asymmetric, generous negative space, logo upper right", "why": "距離感＝密着しない構図"}, "logo": {"v": "「宵」エクステンデッドサンセリフ横・缶幅42%（仮案・監査未実施）", "en": "horizontal extended sans-serif working label 宵 (YOI) at 42% width", "why": "都市グラフィックの書体文法"}, "copy": {"v": "近すぎない、一杯。", "en": "近すぎない、一杯。", "why": "ゆるい距離感の直言"}}, "ct-2-v0": {"surface": {"v": "薄鼠（#C9CCD1）の精密マット・スイス組版のグリッド罫", "en": "pale-grey #C9CCD1 precise matte with a Swiss-typographic grid of hairline rules", "why": "都会の秩序＝グリッド。冷たさは罫線の規律で（B-3図面との差分: 寸法・注記なし＝工学でなくグラフィズム）"}, "motif": {"v": "図像なし", "en": "NO pictorial motif", "why": "タイポグラフィのみ"}, "layout": {"v": "グリッドに沿う左寄せ整列", "en": "left-aligned composition locked to the grid", "why": "組版の文法"}, "logo": {"v": "「宵」グロテスクサンセリフ横・缶幅48%（仮案・監査未実施）", "en": "horizontal grotesque sans-serif working label 宵 (YOI) at 48% width", "why": "グリッドの主役"}, "copy": {"v": "静かな都会の、定番。", "en": "静かな都会の、定番。", "why": "ド真ん中宣言（電通資料の前提条件を言葉で担保）"}}, "blend-bs-v0": {"surface": {"v": "白銀金属・王道の顔。中央に円形の調律ダイヤル（四季の目盛: 春夏秋冬の文字のみ・絵柄なし）が印刷され、針が現在の配合位置を指す", "en": "conventional bright silver metal; printed at the center a circular tuning dial with four season markers (the kanji 春 夏 秋 冬 only, NO seasonal illustrations), a needle pointing at the current blend position", "why": "季節＝絵柄（桜・雪）は限定品コードと衝突（電通資料「限定品に見えるな」）。数値と計器なら「定番の顔は通年同一・中身の位置だけ替わる」＝コンセプトの中核（季節ベストバランス）を誤読なしで言える"}, "motif": {"v": "印刷図像: ダイヤルの脇に今季の配合数値（ラガー62:エール38）を小さく", "en": "printed artwork: the current blend figures ラガー62:エール38 small beside the dial", "why": "調律の証拠は数字で"}, "layout": {"v": "中央対称: ダイヤル→ロゴ→情報帯の縦軸", "en": "central symmetry: dial, wordmark, info band on one axis", "why": "王道対称×計器"}, "logo": {"v": "「アワセ」毛筆横・缶幅44%＋AWASE小（作業ラベル）", "en": "horizontal brush working label アワセ at 44% width, small AWASE beneath", "why": "既定の作業ラベル"}, "copy": {"v": "今日の空気に、合わせてある。", "en": "今日の空気に、合わせてある。", "why": "完了形＝匠が既に調律済みという約束（資料: 匠の技で1年中最適を約束）"}}};
Object.keys(DESIGNS2).forEach(function(k){ DESIGNS[k]=DESIGNS2[k]; });
var DESIGNS3 = {"my-3-v0": {"surface": {"v": "結露で曇った窓ガラスの質感（磨りガラス調の銀）に、指で拭いた一本の透明な縦線", "en": "frosted, condensation-clouded glass texture over silver; ONE clear vertical wipe line as if a finger cleared it", "why": "Misty＝曇りの物質化。拭き跡＝「整い」が始まる兆しの図像。実在の朝の所作（曇った窓を拭く）に接地"}, "motif": {"v": "拭き跡の透明線の中にだけ、印刷の琥珀ビール写実が覗く", "en": "printed photoreal amber beer visible ONLY inside the clear wipe line", "why": "曇り（柔）の中の一筋の明瞭（整い）＝世界観の二律を一枚で。ビール可読の錨も兼務"}, "layout": {"v": "中央やや左に拭き跡・ロゴは右の曇り面", "en": "the wipe line slightly left of center; logo on the frosted right", "why": "非対称の静けさ"}, "logo": {"v": "「朝露」細身セリフ横・缶幅38%（仮案・監査未実施）", "en": "horizontal thin serif working label 朝露 (ASATSUYU) at 38% width", "why": "曇り面に沈む控えめな名前"}, "copy": {"v": "曇りが、晴れる一杯。", "en": "曇りが、晴れる一杯。", "why": "素材の物語（曇→晴）を直言"}}, "my-0-v0": {"surface": {"v": "王道の銀白金属・完全定番の顔", "en": "conventional bright silver metal, fully mainstream face", "why": "統制＝Misty様式化ゼロの基準線"}, "motif": {"v": "印刷図像: 王道の琥珀ビール＋泡の写実を下部帯に", "en": "printed artwork: conventional photoreal amber beer with foam in the lower band", "why": "王道写実コード準拠"}, "layout": {"v": "完全中央対称", "en": "perfect central symmetry", "why": "統制"}, "logo": {"v": "「朝霧」細身セリフ横・缶幅48%（仮案・監査未実施）", "en": "horizontal thin serif working label 朝霧 (ASAGIRI) at 48% width", "why": "名前だけがこのタブの変数という統制"}, "copy": {"v": "軽やかで、深い。", "en": "軽やかで、深い。", "why": "資料の物性「深みがあり…飲み口は軽快」の直言"}}, "qt-3-v0": {"surface": {"v": "森閑の深緑鼠（#37413A）マット・上端に極細の金線一本", "en": "forest-quiet deep green-grey #37413A matte; ONE gold hairline at the very top", "why": "「内なる豊かさ」の色相別解＝紺鼠（Q-1）に対する深緑。低彩度の規律は共通、色だけ動かす"}, "motif": {"v": "図像なし", "en": "NO pictorial motif", "why": "色の分離測定"}, "layout": {"v": "中央対称・要素最少", "en": "central symmetry, minimal", "why": "静けさ"}, "logo": {"v": "「シジマ」細身セリフ横・缶幅32%（仮案・監査未実施）", "en": "horizontal thin serif working label シジマ (SHIJIMA) at 32% width", "why": "小声の名前"}, "copy": {"v": "深いところで、うまい。", "en": "深いところで、うまい。", "why": "内側の深さの口語"}}, "qt-0-v0": {"surface": {"v": "王道の銀白金属", "en": "conventional bright silver metal", "why": "統制"}, "motif": {"v": "印刷図像: 王道の麦と泡の写実", "en": "printed artwork: conventional barley and foam realism", "why": "王道準拠"}, "layout": {"v": "完全中央対称", "en": "perfect central symmetry", "why": "統制"}, "logo": {"v": "「懐」細身セリフ横・缶幅46%（仮案・監査未実施）", "en": "horizontal thin serif working label 懐 (FUTOKORO) at 46% width", "why": "名前だけの統制"}, "copy": {"v": "キレて、豊か。", "en": "キレて、豊か。", "why": "資料の物性「すっきりとしたキレと奥の豊かな香り」の直言"}}, "nd-3-v0": {"surface": {"v": "白銀金属地", "en": "bright silver metal", "why": "図像を立てる王道地"}, "motif": {"v": "印刷図像: 紺一色の水引の結び目ひとつ（あわじ結び・缶幅26%）を中央に。紅白は使わない", "en": "printed artwork: ONE mizuhiki decorative-cord knot (awaji knot) in a single navy line, 26% of can width, centered. NO red-and-white", "why": "結節点＝水引の結び（実在の日本の結びの意匠）。紅白は祝儀・進物コードに直結するため単色紺で回避"}, "layout": {"v": "中央対称: 結び→ロゴ→情報帯", "en": "central symmetry: knot, wordmark, info band", "why": "紋章コードの文法"}, "logo": {"v": "「ムスビ」ジオメトリック横・缶幅36%・結びの下（仮案・監査未実施）", "en": "horizontal geometric working label ムスビ (MUSUBI) at 36% width beneath the knot", "why": "結びが主役"}, "copy": {"v": "ここで、結ばれる。", "en": "ここで、結ばれる。", "why": "結節点の身体語"}}, "nd-0-v0": {"surface": {"v": "王道の銀白金属", "en": "conventional bright silver metal", "why": "統制"}, "motif": {"v": "印刷図像: 王道の麦と泡の写実", "en": "printed artwork: conventional barley and foam realism", "why": "王道準拠"}, "layout": {"v": "完全中央対称", "en": "perfect central symmetry", "why": "統制"}, "logo": {"v": "「中汲み」サンセリフ横・缶幅46%（仮案・監査未実施）", "en": "horizontal sans-serif working label 中汲み (NAKAGUMI) at 46% width", "why": "名前だけの統制"}, "copy": {"v": "力強く、軽やか。", "en": "力強く、軽やか。", "why": "資料の物性「のどごしの力強さと軽やかなコク」の直言"}}, "ct-3-v0": {"surface": {"v": "ガンメタルの窓枠様の面。中央の縦長の窓型の抜きから、印刷の琥珀ビール写実が覗く", "en": "gunmetal frame-like surface; through a tall window-shaped opening at the center, printed photoreal amber beer glows", "why": "距離感を構図で: 都会の窓越しに見る琥珀＝冷たさ（枠）と温度（中身）の同居。ビール可読の錨を最強化"}, "motif": {"v": "窓の中の琥珀写実のみ", "en": "the amber realism inside the window only", "why": "一点の温度"}, "layout": {"v": "窓は中央・ロゴは窓の上", "en": "window centered; wordmark above it", "why": "枠の文法"}, "logo": {"v": "「琥珀」エクステンデッド横・缶幅40%（仮案・監査未実施）", "en": "horizontal extended working label 琥珀 (KOHAKU) at 40% width", "why": "枠の一部としての名前"}, "copy": {"v": "窓の向こうの、一杯。", "en": "窓の向こうの、一杯。", "why": "距離×誘いの両立"}}, "ct-0-v0": {"surface": {"v": "王道の銀白金属", "en": "conventional bright silver metal", "why": "統制"}, "motif": {"v": "印刷図像: 王道の麦と泡の写実", "en": "printed artwork: conventional barley and foam realism", "why": "王道準拠"}, "layout": {"v": "完全中央対称", "en": "perfect central symmetry", "why": "統制"}, "logo": {"v": "「宵」グロテスク横・缶幅46%（仮案・監査未実施）", "en": "horizontal grotesque working label 宵 (YOI) at 46% width", "why": "名前だけの統制"}, "copy": {"v": "力と軽さの、絶妙。", "en": "力と軽さの、絶妙。", "why": "資料の物性「力強さと香りの軽快さの絶妙バランス」の直言"}}};
Object.keys(DESIGNS3).forEach(function(k){ DESIGNS[k]=DESIGNS3[k]; });
var DESIGNS4 = {"kalt-a-vLo": {"surface": {"v": "銀白金属の上部30%だけを深い藍（#22366B）の面に。境界は直線・文様なし", "en": "bright silver metal; the top 30% of the face is a solid deep-indigo #22366B field with a clean straight boundary; NO pattern", "why": "色単体の分離測定: 雷文（図像）を外し、雷雲の藍という色の連想だけで名前を支えられるかの下限"}, "motif": {"v": "図像なし", "en": "NO pictorial motif", "why": "装置=色のみ"}, "layout": {"v": "中央対称・藍面の下に縦ロゴ", "en": "central symmetry; vertical logo beneath the indigo field", "why": "王道の維持"}, "logo": {"v": "「澄雷」紺毛筆・縦・缶幅54%＋SUMIRAI小（仮案・監査未実施）", "en": "vertical navy brush logo 澄雷 at 54% of can width, small SUMIRAI beneath", "why": "色执行では名前が形の主役を兼ねる"}, "copy": {"v": "雨上がりの、一杯。", "en": "雨上がりの、一杯。", "why": "雷雨→晴れの体感を色の連想と同じ層で言う"}}, "kalt-a-vHi": {"surface": {"v": "缶面全体を藍1色の雷文グリッドが覆う（線は細く・地は銀）。攻め端", "en": "the ENTIRE face covered by a fine all-over RAIMON thunder-scroll grid in one indigo line on silver; bold treatment", "why": "構図で語る攻め端: 文様の全面化。器物（丼・風呂敷）誤読の実測計器"}, "motif": {"v": "全面雷文のみ", "en": "the all-over RAIMON grid only", "why": "文様が構図そのもの"}, "layout": {"v": "グリッドの中央に白抜きの窓を開けてロゴ", "en": "a clean reversed-white window opened at the center of the grid for the logo", "why": "可読の島を確保"}, "logo": {"v": "「澄雷」紺毛筆・縦・缶幅40%・白窓内（仮案）", "en": "vertical navy brush logo 澄雷 at 40% width inside the white window", "why": "文様主役の従属ロゴ"}, "copy": {"v": "鳴りやまない、うまさ。", "en": "鳴りやまない、うまさ。", "why": "全面文様の声量に合わせた言い切り"}}, "kalt-b-vLo": {"surface": {"v": "和紙白（#F5F2EA）マット・水流の型抜きエンボスのみ（印刷線なし）", "en": "washi-white #F5F2EA matte with ONLY a debossed flowing-water emboss; no printed line", "why": "素材単体の分離測定: 凹凸だけで「水をくぐった痕跡」が伝わるかの下限"}, "motif": {"v": "図像なし", "en": "NO pictorial motif", "why": "装置=素材のみ"}, "layout": {"v": "完全中央対称", "en": "perfect central symmetry", "why": "王道の維持"}, "logo": {"v": "「ミソギ」水茎カナ・縦・缶幅50%（仮案・記号/商標監査未実施）", "en": "vertical katakana logo ミソギ in slim fluid brush at 50% width, small MISOGI beneath", "why": "素材＋名前の2要素"}, "copy": {"v": "さわって、みそぐ。", "en": "さわって、みそぐ。", "why": "素材執行の固有文: エンボスの触覚（さわる）を行為名に接続"}}, "kalt-b-vHi": {"surface": {"v": "缶面を中央の水の帯（淡青の印刷・幅22%）が縦に貫通し、左＝乾いた和紙白／右＝濡れ色の和紙白の二界に分ける", "en": "a vertical water band (printed pale-aqua, 22% of width) runs through the face, splitting it into a dry washi-white left and a water-darkened washi right", "why": "構図で語る攻め端: くぐる前/後の二界を1缶で（S-4二界と同型の文法を水で実装）"}, "motif": {"v": "水の帯のみ", "en": "the water band only", "why": "構図が図像を兼ねる"}, "layout": {"v": "帯の右（濡れ側）に白抜きロゴ", "en": "reversed-white logo on the wet right side", "why": "くぐった後に名前が立つ物語"}, "logo": {"v": "「ミソギ」白抜き水茎カナ・縦・缶幅42%（仮案）", "en": "vertical reversed-white katakana logo ミソギ at 42% width", "why": "濡れ面の文法"}, "copy": {"v": "くぐる前と、後。", "en": "くぐる前と、後。", "why": "二界構図の直言"}}, "kalt-c-vLo": {"surface": {"v": "白磁マット（#F7F7F4）のみ・ハイライト線もなし", "en": "porcelain matte white #F7F7F4 only; no highlight lines", "why": "色（無地の白）単体の下限測定"}, "motif": {"v": "図像なし", "en": "NO pictorial motif", "why": "最小要素"}, "layout": {"v": "中央にロゴのみ・下部情報帯", "en": "logo alone at center; conventional bottom info band", "why": "無印の文法"}, "logo": {"v": "「KIYOTORA」細身ジオメトリック・横・缶幅50%＋漢字「澄虎」小（ユーザー指示由来・監査未実施）", "en": "horizontal thin geometric wordmark KIYOTORA at 50% width; small vertical 澄虎 near the bottom", "why": "表記転換の最小構成"}, "copy": {"v": "しろい、静けさ。", "en": "しろい、静けさ。", "why": "白単色の体感"}}, "kalt-c-vHi": {"surface": {"v": "白磁マットにスイス組版: KIYOTORAと成分表記を左寄せグリッドで整列（欧文主導・攻め端）", "en": "porcelain matte white set in Swiss typography: KIYOTORA and the mandatory texts left-aligned on a strict grid, roman-led", "why": "構図（欧文組版）の攻め端＝輸入/クラフト誤読の実測計器"}, "motif": {"v": "図像なし", "en": "NO pictorial motif", "why": "タイポのみ"}, "layout": {"v": "左寄せグリッド・漢字「澄虎」は右下に極小", "en": "left-aligned grid; tiny vertical 澄虎 at lower right", "why": "欧文主導の徹底"}, "logo": {"v": "「KIYOTORA」グロテスク・横・缶幅62%（仮案）", "en": "horizontal grotesque wordmark KIYOTORA at 62% width", "why": "組版の主役"}, "copy": {"v": "KIYO＝澄む。", "en": "KIYO＝澄む。", "why": "読み替えの等式を最短で教育"}}};
Object.keys(DESIGNS4).forEach(function(k){ DESIGNS[k]=DESIGNS4[k]; });
var DESIGNS5 = {"my-1-vLo": {"surface": {"v": "白一色（#F7F8F9）・靄の粒子だけ極薄", "en": "near-white #F7F8F9 with only the faintest atmospheric grain", "why": "色装置の下限: 灰青を抜き、白+粒子で柔らかさが残るか"}, "motif": {"v": "図像なし", "en": "NO pictorial motif", "why": "色のみ"}, "layout": {"v": "中央対称", "en": "central symmetry", "why": "王道"}, "logo": {"v": "「朝霧」細身セリフ横・缶幅42%（仮案・監査未実施）", "en": "horizontal thin serif working label 朝霧 (ASAGIRI) at 42% width", "why": "白面の主役"}, "copy": {"v": "しずかに、うまい。", "en": "しずかに、うまい。", "why": "白の声量に合わせる"}}, "my-1-vHi": {"surface": {"v": "靄の階調を濃く: 白→青鼠（#8FA0AE）まで沈む深いグラデ", "en": "deeper mist gradient sinking from white to blue-grey #8FA0AE", "why": "色装置の攻め端: 発泡酒/新ジャンル誤読の計器"}, "motif": {"v": "図像なし", "en": "NO pictorial motif", "why": "色のみ"}, "layout": {"v": "中央対称・ロゴは霧中に浮く", "en": "central symmetry; logo floats in the mist", "why": "柔の維持"}, "logo": {"v": "「朝霧」細身セリフ横・缶幅38%（仮案・監査未実施）", "en": "horizontal thin serif working label 朝霧 (ASAGIRI) at 38% width", "why": "霧に沈む従属"}, "copy": {"v": "深い靄の、底で。", "en": "深い靄の、底で。", "why": "深度の直言"}}, "my-2-vLo": {"surface": {"v": "白磁マット・極細ライン3本のみ（下1/3）", "en": "porcelain matte white; only THREE ultra-thin lines in the lower third", "why": "構図装置の下限: 秩序を最少本数で"}, "motif": {"v": "図像なし", "en": "NO pictorial motif", "why": "線のみ"}, "layout": {"v": "中央対称・線は下部", "en": "central symmetry; lines low", "why": "静けさ"}, "logo": {"v": "「凪」細身セリフ横・缶幅40%（仮案・監査未実施）", "en": "horizontal thin serif working label 凪 (NAGI) at 40% width", "why": "線の上の名前"}, "copy": {"v": "三本の、間。", "en": "三本の、間。", "why": "最少秩序の体感"}}, "my-2-vHi": {"surface": {"v": "等間隔ラインが缶面全体を覆い、太い一本が呼吸の頂点として上1/3に", "en": "evenly spaced lines covering the WHOLE face; the single bolder line placed high like an inhale peak", "why": "構図装置の攻め端: 全面秩序＝文具/化粧品誤読の計器"}, "motif": {"v": "図像なし", "en": "NO pictorial motif", "why": "線のみ"}, "layout": {"v": "全面リズム・ロゴは太線直下", "en": "full-face rhythm; logo just below the bold line", "why": "頂点の指差し"}, "logo": {"v": "「凪」細身セリフ横・缶幅34%（仮案・監査未実施）", "en": "horizontal thin serif working label 凪 (NAGI) at 34% width", "why": "秩序従属"}, "copy": {"v": "整いの、頂点で。", "en": "整いの、頂点で。", "why": "全面秩序の言い切り"}}, "my-3-vLo": {"surface": {"v": "結露ガラス質感のみ・拭き跡なし", "en": "frosted condensation-glass texture only; NO wipe line", "why": "素材装置の下限: 曇りだけで柔らかさが立つか"}, "motif": {"v": "図像なし", "en": "NO pictorial motif", "why": "質感のみ"}, "layout": {"v": "中央対称", "en": "central symmetry", "why": "王道"}, "logo": {"v": "「朝露」細身セリフ横・缶幅40%・曇りの中（仮案・監査未実施）", "en": "horizontal thin serif working label 朝露 (ASATSUYU) at 40% width within the frost", "why": "曇り越しの名前"}, "copy": {"v": "くもりの、向こう味。", "en": "くもりの、向こう味。", "why": "質感の直言"}}, "my-3-vHi": {"surface": {"v": "結露ガラスに大きな円の拭き跡（缶幅55%）。円内に琥珀ビール写実と情報帯", "en": "frosted glass with ONE large circular wipe (55% of width); printed amber beer realism and the info band INSIDE the circle", "why": "素材×構図の攻め端: 拭き跡を主役化し可読を円内に集約"}, "motif": {"v": "円内の琥珀写実", "en": "amber realism inside the circle", "why": "温度の一点"}, "layout": {"v": "円が構図の中心", "en": "the circle is the composition", "why": "窓の文法"}, "logo": {"v": "「朝露」細身セリフ横・缶幅36%・円の上縁（仮案・監査未実施）", "en": "horizontal thin serif 朝露 (ASATSUYU) at 36% width on the circle rim", "why": "円従属"}, "copy": {"v": "ここだけ、晴れ。", "en": "ここだけ、晴れ。", "why": "円の意味の固定"}}, "qt-1-vLo": {"surface": {"v": "紺鼠マットのみ・金は完全ゼロ", "en": "matte blue-grey only; ZERO gold anywhere", "why": "素材装置の下限: 金なしで豊かさの気配が残るか"}, "motif": {"v": "図像なし", "en": "NO pictorial motif", "why": "無音"}, "layout": {"v": "中央対称", "en": "central symmetry", "why": "静"}, "logo": {"v": "「懐」細身セリフ横・缶幅30%（仮案・監査未実施）", "en": "horizontal thin serif 懐 (FUTOKORO) at 30% width", "why": "小声"}, "copy": {"v": "なにも、飾らない。", "en": "なにも、飾らない。", "why": "ゼロ装飾の宣言"}}, "qt-1-vHi": {"surface": {"v": "紺鼠マット・開口部内側の金に加え、底面の縁にも金の輪＝手に取ると見つかる二段の内包", "en": "matte blue-grey; gold inside the lip AND a second gold ring on the bottom rim — discovered only in hand", "why": "素材装置の攻め端: 内包の演出を二段化（棚では完全に静か）"}, "motif": {"v": "図像なし", "en": "NO pictorial motif", "why": "隠す"}, "layout": {"v": "中央対称", "en": "central symmetry", "why": "静"}, "logo": {"v": "「懐」細身セリフ横・缶幅30%（仮案・監査未実施）", "en": "horizontal thin serif 懐 (FUTOKORO) at 30% width", "why": "小声"}, "copy": {"v": "見せない、金。", "en": "見せない、金。", "why": "内包の直言"}}, "qt-2-vLo": {"surface": {"v": "墨鼠×生成り・要素は下1/4に最少", "en": "sumi-grey and off-white; elements minimal in the bottom quarter", "why": "構図装置の下限: 低重心の最少構成"}, "motif": {"v": "図像なし", "en": "NO pictorial motif", "why": "余白"}, "layout": {"v": "下1/4集約・上3/4余白", "en": "bottom-quarter cluster; top three-quarters empty", "why": "余裕=余白"}, "logo": {"v": "「奥行」細身セリフ横・缶幅32%・最下部（仮案・監査未実施）", "en": "horizontal thin serif 奥行 (OKUYUKI) at 32% width at the very bottom", "why": "重心"}, "copy": {"v": "余白が、豊かさ。", "en": "余白が、豊かさ。", "why": "構図の意味の固定"}}, "qt-2-vHi": {"surface": {"v": "生成り地・要素を底辺ぎりぎりに沈め、麦一本の線画も半分だけ見切れる", "en": "off-white; elements sunk to the very base, the single barley line-drawing half-cropped by the bottom edge", "why": "構図装置の攻め端: 見切れ＝未完成/安価誤読の計器"}, "motif": {"v": "見切れる麦一本", "en": "one half-cropped barley ear", "why": "省略の美学"}, "layout": {"v": "底辺整列・上は完全な余白", "en": "baseline alignment; the rest pure emptiness", "why": "極端な低重心"}, "logo": {"v": "「奥行」細身セリフ横・缶幅30%・底辺（仮案・監査未実施）", "en": "horizontal thin serif 奥行 (OKUYUKI) at 30% width on the baseline", "why": "重心の極"}, "copy": {"v": "語尾だけの、豊かさ。", "en": "語尾だけの、豊かさ。", "why": "見切れ構図の言語化"}}, "qt-3-vLo": {"surface": {"v": "緑鼠1色・金線なし", "en": "the green-grey alone; no gold hairline", "why": "色装置の下限"}, "motif": {"v": "図像なし", "en": "NO pictorial motif", "why": "色のみ"}, "layout": {"v": "中央対称", "en": "central symmetry", "why": "静"}, "logo": {"v": "「シジマ」細身セリフ横・缶幅30%（仮案・監査未実施）", "en": "horizontal thin serif シジマ (SHIJIMA) at 30% width", "why": "小声"}, "copy": {"v": "森の、しずけさ。", "en": "森の、しずけさ。", "why": "色の連想の直言"}}, "qt-3-vHi": {"surface": {"v": "深緑鼠を濃く（#2C352F）・底に金の細帯", "en": "deeper forest green-grey #2C352F with a slim gold band at the base", "why": "色装置の攻め端: 濃緑＝黒ビール/緑茶誤読の計器"}, "motif": {"v": "図像なし", "en": "NO pictorial motif", "why": "色のみ"}, "layout": {"v": "中央対称", "en": "central symmetry", "why": "静"}, "logo": {"v": "「シジマ」細身セリフ横・缶幅32%（仮案・監査未実施）", "en": "horizontal thin serif シジマ (SHIJIMA) at 32% width", "why": "小声"}, "copy": {"v": "深緑の、底力。", "en": "深緑の、底力。", "why": "濃度の言い切り"}}, "nd-1-vLo": {"surface": {"v": "銀白金属・目盛は中央の短い一区間のみ（数字なし）", "en": "bright silver; the scale reduced to ONE short central segment, no figures", "why": "図像装置の下限: 計器の最少表現"}, "motif": {"v": "中点マーカー1つ", "en": "one midpoint marker", "why": "座標の核"}, "layout": {"v": "中央対称", "en": "central symmetry", "why": "計器"}, "logo": {"v": "「中汲み」ジオメトリック横・缶幅40%（仮案・監査未実施）", "en": "horizontal geometric 中汲み (NAKAGUMI) at 40% width", "why": "主役"}, "copy": {"v": "ここが、ちょうど。", "en": "ここが、ちょうど。", "why": "最少座標の直言"}}, "nd-1-vHi": {"surface": {"v": "銀白金属・缶面全体が精密な計器盤（同心円の目盛・複数の針は禁止、針は1本）", "en": "bright silver; the whole face a precise instrument dial with concentric graduations; exactly ONE needle", "why": "図像装置の攻め端: 計器の全面化＝ガジェット誤読の計器"}, "motif": {"v": "同心円目盛と針1本", "en": "concentric dial and one needle", "why": "計器の声量"}, "layout": {"v": "盤面が構図", "en": "the dial is the composition", "why": "計器文法"}, "logo": {"v": "「中汲み」ジオメトリック横・缶幅34%・盤の中心（仮案・監査未実施）", "en": "horizontal geometric 中汲み (NAKAGUMI) at 34% width at the dial center", "why": "盤従属"}, "copy": {"v": "針は、真ん中。", "en": "針は、真ん中。", "why": "中庸の宣言"}}, "nd-2-vLo": {"surface": {"v": "紺→淡青の弱いグラデ・中点線なし", "en": "a gentle navy-to-aqua gradient; NO midpoint line", "why": "色装置の下限: 線なしで「あいだ」が伝わるか"}, "motif": {"v": "図像なし", "en": "NO pictorial motif", "why": "色のみ"}, "layout": {"v": "中央対称", "en": "central symmetry", "why": "静"}, "logo": {"v": "「アワイ」サンセリフ横・缶幅38%・ちょうど中間の高さ（仮案・監査未実施）", "en": "horizontal sans アワイ (AWAI) at 38% width at exactly mid-height", "why": "名前自体を中点に"}, "copy": {"v": "あいだに、いる。", "en": "あいだに、いる。", "why": "位置の体感"}}, "nd-2-vHi": {"surface": {"v": "上下を濃紺と淡青の二面で切り、境界に白の太い水平帯（缶高12%）＝中間帯を面として主役化", "en": "deep navy top and pale aqua bottom, joined by a BOLD white horizontal band (12% of height) as the hero midzone", "why": "色×構図の攻め端: 中間を線でなく面に"}, "motif": {"v": "図像なし", "en": "NO pictorial motif", "why": "帯のみ"}, "layout": {"v": "白帯に全表記を集約", "en": "all texts inside the white band", "why": "帯の文法"}, "logo": {"v": "「アワイ」サンセリフ横・缶幅44%・白帯内（仮案・監査未実施）", "en": "horizontal sans アワイ (AWAI) at 44% width inside the band", "why": "帯主役"}, "copy": {"v": "まんなかを、太く。", "en": "まんなかを、太く。", "why": "面化の言い切り"}}, "nd-3-vLo": {"surface": {"v": "銀白金属・結びは細線の小紋（缶幅14%）", "en": "bright silver; the knot as a small fine-line crest, 14% width", "why": "和意匠装置の下限"}, "motif": {"v": "小さなあわじ結び", "en": "one small awaji knot", "why": "紋章の声量"}, "layout": {"v": "中央対称", "en": "central symmetry", "why": "王道"}, "logo": {"v": "「ムスビ」ジオメトリック横・缶幅42%（仮案・監査未実施）", "en": "horizontal geometric ムスビ (MUSUBI) at 42% width", "why": "名が主・結びは従"}, "copy": {"v": "小さく、結ぶ。", "en": "小さく、結ぶ。", "why": "最少の結節"}}, "nd-3-vHi": {"surface": {"v": "銀白金属・一本の紺の紐が缶面を縦に走り中央で結ばれる（結び=缶幅34%）", "en": "bright silver; ONE navy cord runs the full height and ties at the center (knot 34% of width)", "why": "和意匠装置の攻め端: 紐の物語化＝進物誤読の計器"}, "motif": {"v": "縦走する紐と結び", "en": "the running cord and its knot", "why": "結びの物語"}, "layout": {"v": "紐が構図の軸", "en": "the cord is the axis", "why": "縦軸文法"}, "logo": {"v": "「ムスビ」ジオメトリック横・缶幅36%・結びの右（仮案・監査未実施）", "en": "horizontal geometric ムスビ (MUSUBI) at 36% width beside the knot", "why": "紐従属"}, "copy": {"v": "一本が、結ばれる。", "en": "一本が、結ばれる。", "why": "物語の直言"}}, "ct-1-vLo": {"surface": {"v": "ガンメタル鏡面のみ・反射線なし", "en": "gunmetal mirror alone; no reflection lines", "why": "素材装置の下限: 鏡面単体の温度"}, "motif": {"v": "図像なし", "en": "NO pictorial motif", "why": "無音"}, "layout": {"v": "非対称・ロゴ右上", "en": "asymmetric; logo upper right", "why": "距離"}, "logo": {"v": "「宵」エクステンデッド横・缶幅42%（仮案・監査未実施）", "en": "horizontal extended 宵 (YOI) at 42% width", "why": "冷面の一語"}, "copy": {"v": "しずかな、金属。", "en": "しずかな、金属。", "why": "素材の直言"}}, "ct-1-vHi": {"surface": {"v": "ガンメタル鏡面に夜の窓明かりのグリッド反射（小さな光の矩形が規則的に）", "en": "gunmetal mirror reflecting a night grid of lit windows — small regular rectangles of light", "why": "素材装置の攻め端: 都市の気配を反射の密度で（絵柄化ぎりぎりの計器）"}, "motif": {"v": "光の矩形群（反射として）", "en": "the window-light rectangles as reflections", "why": "密度の設計"}, "layout": {"v": "非対称・光は右下に流れる", "en": "asymmetric; lights drift to the lower right", "why": "夜景の重心"}, "logo": {"v": "「宵」エクステンデッド横・缶幅40%・左上（仮案・監査未実施）", "en": "horizontal extended 宵 (YOI) at 40% width upper left", "why": "光と対角"}, "copy": {"v": "街の灯が、映る。", "en": "街の灯が、映る。", "why": "反射の言い切り"}}, "ct-2-vLo": {"surface": {"v": "薄鼠マット・罫線は2本のみ", "en": "pale-grey matte; only TWO hairline rules", "why": "構図装置の下限"}, "motif": {"v": "図像なし", "en": "NO pictorial motif", "why": "タイポのみ"}, "layout": {"v": "左寄せ・2罫", "en": "left-aligned with two rules", "why": "最少グリッド"}, "logo": {"v": "「宵」グロテスク横・缶幅50%（仮案・監査未実施）", "en": "horizontal grotesque 宵 (YOI) at 50% width", "why": "主役"}, "copy": {"v": "二本線の、都会。", "en": "二本線の、都会。", "why": "最少秩序"}}, "ct-2-vHi": {"surface": {"v": "薄鼠に全面の細グリッド＋座標風の小さな数字ラベル（意味のない装飾数字は禁止・表記の数値のみ配置）", "en": "pale-grey with a full fine grid; small coordinate-style labels using ONLY the mandatory figures (ALC.5% etc.), no decorative numbers", "why": "構図装置の攻め端: 情報を座標として組む＝文具/工学誤読の計器（B-3図面との差分=寸法線なし）"}, "motif": {"v": "図像なし", "en": "NO pictorial motif", "why": "グリッドのみ"}, "layout": {"v": "全面グリッド・左上原点", "en": "full grid; origin upper-left", "why": "座標文法"}, "logo": {"v": "「宵」グロテスク横・缶幅56%（仮案・監査未実施）", "en": "horizontal grotesque 宵 (YOI) at 56% width", "why": "グリッド主役"}, "copy": {"v": "整列した、夜。", "en": "整列した、夜。", "why": "秩序の言い切り"}}, "ct-3-vLo": {"surface": {"v": "ガンメタル面・窓は小さく（缶幅18%）琥珀は淡く", "en": "gunmetal; the window small (18% width), the amber faint", "why": "可読強化装置の下限: 最小の温度"}, "motif": {"v": "小窓の琥珀", "en": "faint amber in a small window", "why": "一点"}, "layout": {"v": "中央小窓", "en": "small central window", "why": "枠"}, "logo": {"v": "「琥珀」エクステンデッド横・缶幅42%・窓上（仮案・監査未実施）", "en": "horizontal extended 琥珀 (KOHAKU) at 42% width above the window", "why": "枠の一部"}, "copy": {"v": "とおくの、一杯。", "en": "とおくの、一杯。", "why": "距離の直言"}}, "ct-3-vHi": {"surface": {"v": "窓を縦長の大開口（缶高60%）に拡大し、琥珀とグラス無しの泡写実（印刷）を大きく", "en": "the window enlarged to a tall opening (60% of height); large printed amber-and-foam realism inside", "why": "可読強化の攻め端: 写実面積の上限＝都会らしさとのトレードオフ計器"}, "motif": {"v": "大開口の琥珀写実", "en": "large amber realism in the opening", "why": "温度最大"}, "layout": {"v": "開口が主・枠は額縁", "en": "the opening dominates; the frame is a mat", "why": "額装文法"}, "logo": {"v": "「琥珀」エクステンデッド横・缶幅38%・枠上（仮案・監査未実施）", "en": "horizontal extended 琥珀 (KOHAKU) at 38% width on the frame", "why": "額縁従属"}, "copy": {"v": "まどいっぱいの、琥珀。", "en": "まどいっぱいの、琥珀。", "why": "面積の言い切り"}}};
Object.keys(DESIGNS5).forEach(function(k){ DESIGNS[k]=DESIGNS5[k]; });
var DESIGNS6 = {"blend-bs-vLo": {"surface": {"v": "白銀金属・王道の顔。ダイヤルは置かず、中央に今季の配合数値（ラガー62:エール38）と「今季の調律」の小さな一行のみ", "en": "conventional bright silver metal; NO dial — only the current blend figures ラガー62:エール38 with a small line 今季の調律 at the center", "why": "装置の下限測定: 計器（図像）を外し、数値という事実だけで「季節最適の約束」が伝わるかを測る"}, "motif": {"v": "図像なし", "en": "NO pictorial motif", "why": "数値のみ"}, "layout": {"v": "中央対称: 数値→ロゴ→情報帯", "en": "central symmetry: figures, wordmark, info band", "why": "王道の維持"}, "logo": {"v": "「アワセ」毛筆横・缶幅46%＋AWASE小（作業ラベル）", "en": "horizontal brush working label アワセ at 46% width, small AWASE beneath", "why": "既定ラベル"}, "copy": {"v": "62対38の、今日。", "en": "62対38の、今日。", "why": "数値そのものをコピーに昇格＝下限執行の一貫性"}}, "blend-bs-vHi": {"surface": {"v": "白銀金属・調律ダイヤルを缶幅58%に大型化し、針と今季位置の目盛を強調。四季の文字目盛は維持（絵柄なし）", "en": "conventional bright silver; the tuning dial enlarged to 58% of can width, needle and current-position tick emphasized; the four season kanji markers kept, still NO seasonal illustrations", "why": "攻め端: 可変要素（針の位置）の声量を最大化。「毎回違う＝限定品」誤読が起きる閾値を実測する計器"}, "motif": {"v": "大型ダイヤルと配合数値", "en": "the large dial and the blend figures", "why": "計器主役"}, "layout": {"v": "ダイヤルが構図の中心・ロゴは下", "en": "the dial dominates; wordmark below", "why": "計器文法"}, "logo": {"v": "「アワセ」毛筆横・缶幅38%（作業ラベル）", "en": "horizontal brush working label アワセ at 38% width", "why": "ダイヤル従属"}, "copy": {"v": "針は、いまの季節。", "en": "針は、いまの季節。", "why": "可変要素の意味の固定（限定でなく調律）"}}};
Object.keys(DESIGNS6).forEach(function(k){ DESIGNS[k]=DESIGNS6[k]; });
var CAN_INVARIANTS = [
'Intended use: a package design comp of a real, shipped Japanese mainstream beer product for stakeholder review.',
'The object is a real printed 350ml aluminum beer can, front view, 3:4, studio product photography, soft even light, faint condensation.',
'CRITICAL INVARIANT: the can has a clean closed aluminum lid with a stay-tab. There is NO real foam, NO liquid and NO glass anywhere in the shot. Beer, foam or barley may appear ONLY as printed label artwork on the can surface.',
'BRAND LOCK: the ONLY wordmark that may appear anywhere is the working label specified in the LOGO line of this prompt (plus its small companion romanization or kanji, if specified there). It is a declared working label — final naming t.b.d. Never invent any other brand, maker or product name.',
'INFORMATION ARCHITECTURE (Japanese beer shelf convention, all texts verbatim, small but clearly legible): top shoulder line with 麦芽100% and ラガー×エール ブレンド; bottom information band with 生ビール（非熱処理）, ALC.5%, 純アルコール量14g and the round お酒 mark. No extra words.'
].join(' ');
var NAME_PLAN = {
/* ③A Misty — 全方向アサギリ（各方向固有の論拠つき） */
'my-1':{ name:'朝霧', basis:'漢字二字の情景型（晴れ風の文法＝棚接地）。朝霧＝「靄」と「晴れていく途中」を一語で言う命題の直訳で、大気の階調の意匠と同一の気象を描く。カナ表記は棚の漢字優位に接地しないため漢字採用' },
'my-2':{ name:'凪', basis:'生成器v2・L4。凪＝波立ちが収まって整う——「整う呼吸」の気象語の直訳で、等間隔ラインの静けさと同義。朝仕込みは「仕込み」が発酵食品一般語（調味料想起）のため棄却。喉テスト「なぎください」成立。検査: 飲食店名の先客密度・一字ゆえ缶の他要素への依存' },
'my-3':{ name:'朝露', basis:'生成器L4。結露の水滴の実在気象語＝結露の窓の意匠の直訳。朝霧（M-1・外の霧）と朝露（内の露）で同じ朝の内外を分担。検査: 日本酒・焼酎先客（白露等）＋朝霧との同タブ識別' },
'my-0':{ name:'朝霧', basis:'統制＝様式ゼロの完成案。本タブの採用第一候補を載せ、様式なしで名前だけが乗った素の姿を見る' },
/* ③B QUIET — 方向で名前が変わる（論拠が要求するため） */
'qt-1':{ name:'懐', basis:'一字型（頂の文法＝棚接地）。懐＝外から見えない内側の蓄えで、「外はマット・内側だけ金」の意匠と完全同型＝命題の直訳。シジマは静けさは言うが内包性を言わないため次点。読みの二読（フトコロ/カイ）と俗味は監査観点' },
'qt-2':{ name:'奥行', basis:'生成器L2。味評価の実在語彙「奥行きのある味わい」を借用＝名前がそのまま味の約束として読める、かつ低重心・余白の空間語として構図と二重適合。賭け: 名詞単独の据わり（喉テストは通過ギリ）' },
'qt-3':{ name:'シジマ', basis:'「森のしじま」という定型が示す通り、深い森の静けさの一語——森閑の緑鼠という色の命題と慣用レベルで接続する' },
'qt-0':{ name:'懐', basis:'統制＝様式ゼロの完成案。タブの採用第一候補（懐）を仮置きし、様式なしで名前だけが乗った素の姿を見る' },
/* ③C NODE */
'nd-1':{ name:'中汲み', basis:'生成器L1（製法宣言型）。中間の一番よいところを汲む＝日本酒の実在語で、薄⇄濃の目盛の中点という図像の製法翻訳。喉テスト成立。賭け: 中味の製法実態との整合——事実と異なれば即死' },
'nd-2':{ name:'アワイ', basis:'命題「濃と淡のあいだの一点」＝あわいの直訳。グラデの中点線と名前が同じ座標を指す' },
'nd-3':{ name:'ムスビ', basis:'結びの意匠（水引）に結びの名——名前と図像の両輪で結節点を言う。アワイ（間）は位置の語で、結ばれて定まるという本方向の動詞性を言えないため次点。おむすび・縁結びの多義は監査観点として維持' },
'nd-0':{ name:'中汲み', basis:'統制＝様式ゼロの完成案。タブの採用第一候補（中汲み）を仮置き' },
/* ③D City — アーバンは棄却済みのため全方向 宵（各論拠つき） */
'ct-1':{ name:'宵', basis:'宵＝街の灯がともり始める夜の入り。ガンメタルの鏡面に映る窓灯り＝宵の口の都会の窓、という意匠と名前が同じ時刻を描く。「酔い」同音の自主基準検査は必須（注記維持）' },
'ct-2':{ name:'宵', basis:'宵＝喧騒前の静かな夜の時間帯。グリッドの静寂（整列した夜）と同じ温度の語' },
'ct-3':{ name:'琥珀', basis:'生成器L2。ビールの色の正式語彙＝カテゴリ可読が名前単体で最強、かつ窓越しの琥珀という図像と同一語（名前と絵の完全一致）。喉テスト「琥珀ください」＝バー注文の実在感。検査: 琥珀ヱビス等の先客識別' },
'ct-0':{ name:'宵', basis:'統制＝様式ゼロの完成案。タブの採用第一候補（宵）を仮置き' },
/* 季節ベストバランス — 権威3方向は様式が要求する名前へ（宣言待ちの解消） */
'blend-b0':{ name:'アワセ', basis:'統制＝様式ゼロの完成案。第一仮案（合わせる＝季節に合わせるの動詞名詞化）を採用' },
'blend-b1':{ name:'常盤', basis:'漢字二字型（棚接地）。常盤＝「永く変わらない」——老舗の暖簾が約束する不変の信用を名前が言い、深紺の帯・家紋の意匠と同じ永続性を持つ。アワセ（行為の語）は暖簾の格を言えないため次点。菓子・他業種の先客濃厚＝監査必須' },
'blend-b2':{ name:'ブレンダーズ', basis:'生成器v2・L5×L6。配合を決める職人＝ブレンダーそのもの——手書きの配合記録・検印の意匠と同じ主語で、RTB「120年のブレンド技術」に直結する自社資産の借用。合わせ仕込みは調味料想起（プール汚染）で棄却。喉テスト＝洋酒の実在感。検査: 他社バー業態等の先客識別・ウイスキー誤読' },
'blend-b3':{ name:'シラベ', basis:'調べ＝調律の語。精密なチューニングの図面という意匠に、楽器を調律するように味を合わせるという語感が同調する。トキワ（不変）は精密設計の可変性と矛盾するため不採用' },
'blend-bs':{ name:'アワセ', basis:'合わせる＝「季節ごとの温度と湿度に合わせて」（資料原文）の動詞そのもの——季節の調律という主方向の命題の直訳。計器の意匠（合わせるための道具）とも同型' }
};
var _CANON_DEFAULT = { sumitora:'澄虎', blended:'アワセ', 'den-misty':'朝霧', 'den-quiet':'懐', 'den-node':'中汲み', 'den-city':'宵' };
var _CANON_ROMAN = { '澄虎':'SUMITORA', 'アワセ':'AWASE', '澄雷':'SUMIRAI', 'ミソギ':'MISOGI', 'アサギリ':'ASAGIRI', 'シジマ':'SHIJIMA', 'アワイ':'AWAI', '宵':'YOI', 'フトコロ':'FUTOKORO', 'ムスビ':'MUSUBI', 'シラベ':'SHIRABE', 'トキワ':'TOKIWA', '朝霧':'ASAGIRI', '懐':'FUTOKORO', '常盤':'TOKIWA', '合わせ仕込み':'AWASE-JIKOMI', '朝仕込み':'ASA-JIKOMI', '凪':'NAGI', 'ブレンダーズ':"BLENDER'S", '朝露':'ASATSUYU', '奥行':'OKUYUKI', '中汲み':'NAKAGUMI', '琥珀':'KOHAKU' };
function _canonName(conceptId, dz){
var m = dz && dz.logo && dz.logo.v && String(dz.logo.v).match(/「(.+?)」/);
return (m && m[1]) || _CANON_DEFAULT[conceptId] || null;
}
function _declareName(spec, conceptId, dirId){
var dz = spec && spec.design;
var plan = dirId && NAME_PLAN[dirId];
// 優先順: パイプライン/継承の nameChoice → 方向固有の NAME_PLAN → 設計書ロゴ欄の「」→ タブ既定名
var nm = (spec && spec.nameChoice && spec.nameChoice.name) || (plan && plan.name) || _canonName(conceptId, dz);
// 入出力ルールの防波堤: ①②以外のコンセプトに与件名「澄虎」（や虎の字を含む名前）が混入したら無効化して当該タブの正準へ戻す
if (nm && _TORA_RE.test(nm) && !_TORA_CONCEPTS[conceptId]){
if (spec && spec.nameChoice) delete spec.nameChoice;
nm = (plan && plan.name) || _CANON_DEFAULT[conceptId] || null;
}
if (nm && spec && !spec.nameChoice){
if (plan){
spec.nameChoice = { name:plan.name, basis:'方向固有の設計: '+plan.basis, status:plan.status||'商標・先客・音の監査未実施' };
} else {
var declared = !!(dz && dz.logo && dz.logo.v && String(dz.logo.v).indexOf('「'+nm+'」')>=0);
spec.nameChoice = declared
? { name:nm, basis:'この方向の設計書ロゴ欄で宣言（採用の論拠は賭け・ロゴのwhy欄）', status:'商標・先客・音の監査未実施' }
: { name:nm, basis:'暫定適用: この方向固有の名前宣言が未作成のため、タブの第一仮案を暫定採用（宣言待ち）', status:'宣言待ち・監査未実施' };
}
}
if (spec && spec.prompts){
if (nm) _injectWordmark(spec.prompts, conceptId, dz, nm);
else {
// 名前が導出できない場合（新コンセプト初期など）でも、画像モデルの名前・図像の発明は封鎖する
var guard = ' WORDMARK GUARD (hard): render ONLY the wordmark specified in the LOGO line of this prompt; NEVER render any other or invented brand name.';
['board','package','kv'].forEach(function(k){ if (spec.prompts[k]) spec.prompts[k] += guard; });
}
}
return spec;
}
function _injectWordmark(prompts, conceptId, dz, forceNm){
var nm = forceNm || _canonName(conceptId, dz);
if (!nm) return prompts;
var comp = nm === 'KIYOTORA' ? ' (small kanji companion: 澄虎)' : (_CANON_ROMAN[nm] ? ' (small companion romanization: ' + _CANON_ROMAN[nm] + ')' : '');
var line = ' WORDMARK LOCK (hard): the one and only brand wordmark that may appear anywhere in this image is 「' + nm + '」' + comp + '. Render it EXACTLY as these characters; NEVER render any other name, brand, or invented text.';
['board','package','kv'].forEach(function(k){ if (prompts && prompts[k]) prompts[k] += line; });
return prompts;
}
function _pkgPrompt(dz){
if(!dz) return '';
return [CAN_INVARIANTS,
'CAN SURFACE: '+dz.surface.en+'.',
'PRINTED MOTIF: '+dz.motif.en+'.',
'LAYOUT: '+dz.layout.en+'.',
'LOGO (exact text, verbatim, no extra characters): '+dz.logo.en+'.',
'At 2 seconds on a Japanese beer shelf this must read as a mainstream beer, never as a soft drink, tea or craft-only product.'].join(' ');
}
function _boardPrompt(dz, world){
if(!dz) return '';
return ['Brand world mood board for a Japanese beer, 16:10, editorial collage of 6-8 tiles: material close-ups, landscape/texture photography, one color palette strip, generous margins.',
'The world of THIS execution: ' + (world||'') + ' Ground/material: ' + dz.surface.en + '. Imagery family: ' + dz.motif.en + '.',
(dz.copy && dz.copy.en ? 'One small typographic tile may carry the copy 「' + dz.copy.en + '」 verbatim.' : 'No copy tile.'),
'BRAND LOCK: the only wordmark that may appear anywhere is the working label named in this prompt. Never invent any other brand, maker or product name. No can mockups on the board.'].join(' ');
}
function _kvPrompt(dz){
if(!dz) return '';
return ['Advertising banner key visual comp, 16:9, polished ad-agency finish. No people.',
'Product hero: the beer can described below standing on the right third (match the attached can reference EXACTLY if provided), faint condensation, crisp product light.',
'The can: '+dz.surface.en+' / '+dz.motif.en,
'Left two-thirds: clean copy space in the same world as the can.',
(dz.copy && dz.copy.en ? 'HEADLINE (exact text, verbatim, no extra characters, large Japanese typography in the same script family as the can logo): 「'+dz.copy.en+'」.' : 'Clean headline space left empty.'),
'Small brand logo block bottom right (the working label from the can description only). BRAND LOCK: never invent any other brand, maker or product name. NO real foam outside the printed can artwork.'].join(' ');
}
/* ================= パイプライン産スペックの完成処理 =================
「設計書が主・プロンプトはシリアライザ」の原則をパイプライン産の版にも一本化する。
- _validateDesign: 5スロット（surface/motif/layout/logo/copy）の v/en 完全性検査
- _machinePrompts: 設計書から board/package/kv を機械組み立て（CAN不変条件・必須表示・2秒棚テストが常に入る）
- _finishSpec: 検証→機械組み立て→名前宣言＋ワードマークロック注入 までの完成処理
- _buildNewDirectionVersions: 新方向の3水準（vLo=装置の下限 / v0=標準 / vHi=攻め端）をシードと同じ実験計画で構築 */
/* 統制された改訂: 派生spec の design を親と突合し、changed に宣言されていないスロットの差分を
親の値へ差し戻す。派生＝「指示した変更だけが動く」統制を、AIの規律ではなく構造で保証する。
何を動かし何を差し戻したかは spec._revision に記録され、設計書ドロワーに表示される。 */
function _controlledRevision(parentSpec, spec){
if (!(parentSpec && parentSpec.design && spec && spec.design)) { if (spec) delete spec.changed; return spec; }
var chg = (spec.changed || []).filter(function(k){ return ['surface','motif','layout','logo','copy'].indexOf(k) >= 0; });
var reverted = [];
['surface','motif','layout','logo','copy'].forEach(function(k){
var ps = parentSpec.design[k], ns = spec.design[k];
if (!ps || !ns) return;
if (chg.indexOf(k) >= 0) return;
if (String(ns.v||'') !== String(ps.v||'') || String(ns.en||'') !== String(ps.en||'')){
spec.design[k] = JSON.parse(JSON.stringify(ps));
reverted.push(k);
}
});
spec._revision = { changed: chg, reverted: reverted };
delete spec.changed;
return spec;
}
function _validateDesign(dz){
var missing = [];
['surface','motif','layout','logo','copy'].forEach(function(k){
var s = dz && dz[k];
if (!s || !String(s.v||'').trim() || !String(s.en||'').trim()) missing.push(k);
});
return missing;
}
function _machinePrompts(spec){
spec.prompts = {
board: _boardPrompt(spec.design, spec.aim || spec.worldLine || ''),
package: _pkgPrompt(spec.design),
kv: _kvPrompt(spec.design)
};
return spec;
}
function _finishSpec(spec, conceptId, dirId){
var miss = _validateDesign(spec && spec.design);
if (miss.length) throw new Error('設計書が不完全です（欠落スロット: ' + miss.join('・') + '）。もう一度生成してください');
_machinePrompts(spec);
_declareName(spec, conceptId, dirId);
return spec;
}
function _buildNewDirectionVersions(spec, conceptId, originV0){
var exes = spec.executions || null;
delete spec.executions;
var now = Date.now();
var mkv = function(sp, id, originNote){
return { id:id, parentId:null, created:new Date().toISOString(), label:sp.label||'base',
origin: originNote || { inputSummary:'', interpretation:null, matched:[], verdict:null },
spec:sp, visuals:{ board:{status:'empty'}, package:{status:'empty'}, kv:{status:'empty'} } };
};
var v0spec = _finishSpec(spec, conceptId);
var mkExec = function(ex, fallbackLabel){
if (!ex || !ex.design) return null;
var sp = JSON.parse(JSON.stringify(v0spec));
delete sp.prompts;
sp.label = ex.label || fallbackLabel;
sp.aim = ex.aim || sp.aim;
if (ex.device) sp.leadDevice = ex.device;
sp.design = ex.design;
sp.measurement = (v0spec.measurement||'') + ' 同一命題の執行3案（下限/標準/攻め端）を同一調査に入れ、命題をどの装置・声量で言うのが強いかも特定する。';
try { _finishSpec(sp, conceptId); } catch(e){ return null; } // 当該水準の設計が不完全なら、その水準だけ静かに棄却（v0は必須なので方向自体は成立）
return sp;
};
var lo = exes ? mkExec(exes.vLo, '装置の下限') : null;
var hi = exes ? mkExec(exes.vHi, '攻め端') : null;
var versions = [];
if (lo) versions.push(mkv(lo, 'v'+now+'-lo', { inputSummary:'ベース設計（執行: '+lo.label+'）', interpretation:null, matched:[], verdict:null }));
versions.push(mkv(v0spec, 'v'+now, originV0));
if (hi) versions.push(mkv(hi, 'v'+now+'-hi', { inputSummary:'ベース設計（執行: '+hi.label+'）', interpretation:null, matched:[], verdict:null }));
return { versions: versions, repId: 'v'+now };
}
var FIXED_VARS = [
{ item:'【名前の宣言】この方向群は与件「澄虎」を採用', why:'論拠: サントリー資料p.11の与件。名前は完成案の一部として各方向で宣言する（禁止は無宣言の変動のみ）。別名の完成案は派生・新方向・②タブで', verify:'設計書の商品名欄と出自' },
{ item:'ロゴの書体の系＝毛筆', why:'与件はネーミング「澄虎」のみで、書体・表記・組みはすべて設計判断。棚の毛筆優位（大手主要銘柄の和文ロゴは毛筆系）に接続して「系」だけ固定し、表記（漢字／ローマ字SUMITORA併記）・組み（縦／横）・スケール・配置は執行の変数として可変（実際に執行間で変えている）。表記の読み替え（KIYOTORA等）は②タブの検証対象として分離', verify:'調査の自由回答で書体・表記への言及を収集し、次ラウンドで表記の幅出し要否を判定' },
{ item:'缶の情報設計＝肩の品質表記＋下部情報帯（verbatim）', why:'目録の慣習コード＝ビール可読の錨。全執行で固定し誤読の防波堤にする', verify:'2秒棚テストの酒類識別率' },
{ item:'コピーのトーン＝読点1つの短い断言', why:'命題（〜である。）と同型のリズム。文言自体は執行の変数（各執行で別コピー）', verify:'KVの想起・意味一致テスト' }
];
var BLEND_FIXED = [
{ item:'【名前の宣言】現行版は第一仮案アワセを採用（LLM考案・監査未実施）', why:'名前は完成案の一部として方向ごとに宣言してよい（対案: シラベ／トキワ）。禁止は無宣言の変動のみ。画像に別名が出てしまった版は「画像から採録」で実名を正式化できる', verify:'商品名欄・採録記録' },
{ item:'缶の情報設計＝肩の品質表記＋下部情報帯（verbatim）', why:'目録の慣習コード＝ビール可読の錨', verify:'2秒棚テストの酒類識別率' },
{ item:'コピーのトーン＝読点1つの短い断言', why:'全タブ共通の骨格。文言は執行の変数', verify:'KV想起・意味一致' },
{ item:'【書体＝作業ラベル「アワセ」の仮書体（保留変数）】', why:'商品名が未決（アワセはネーミング案ではない作業ラベル）のため、書体開発はネーミング確定後の仕事。現状の毛筆はラベルの可読用の仮置きで、様式適合の書体差（B-1暖簾の毛筆／B-3製図のサンセリフ等）は各執行の設計判断＝執行の変数', verify:'ネーミング確定後に書体ラウンドを起案' }
];
var DEN_FIXED = [
{ item:'【名前の宣言】現行版はタブの第一仮案を採用（LLM考案・監査未実施）', why:'名前は完成案の一部として方向ごとに宣言してよい（対案は各タブの型2〜3）。禁止は無宣言の変動のみ', verify:'商品名欄・出自' },
{ item:'缶の情報設計＝肩の品質表記＋下部情報帯（verbatim）', why:'目録の慣習コード＝ビール可読の錨', verify:'2秒棚テストの酒類識別率' },
{ item:'コピーのトーン＝読点1つの短い断言', why:'全タブ共通の骨格。文言は執行の変数', verify:'KV想起・意味一致' },
{ item:'【書体＝仮案ネーミングの仮書体（保留変数）】', why:'商品名が未決のため書体開発はネーミング確定後の仕事。現状の書体（各タブのセリフ/サンセリフ系の和文）は仮案表記の可読用であり、書体の幅出しは本ラウンドの検証対象外と宣言', verify:'ネーミング確定後に書体ラウンドを起案' }
];
var KALT_FIXED = [
{ item:'缶の情報設計＝肩の品質表記＋下部情報帯（verbatim）', why:'目録の慣習コード＝ビール可読の錨。名前が何であれ固定', verify:'2秒棚テストの酒類識別率' },
{ item:'コピーのトーン＝読点1つの短い断言', why:'①と共通の骨格。文言は執行の変数', verify:'KVの想起・意味一致' },
{ item:'【本タブでは書体・表記系は固定しない】', why:'名前の型が表記系を決めるのが本タブの検証対象そのもの（型A=毛筆漢字／型B=水茎カナ／型C=ジオメトリック欧文）。①の「書体の系＝毛筆固定」は本タブに適用しない、と明示的に宣言', verify:'表記系×新しさ/可読のクロス集計' }
];
var VARIANT_EVIDENCE = 'パッケージ調査の実務は絶対評価→相対評価の順で複数案を比較し、要素分解で効いた要素を特定する（アスマーク・INTAGEの調査設計解説）。同一命題の執行3案（主導装置＝色/図像/構図/素材の違い）を並べることで、調査は様式の勝敗に加えて「この命題はどの設計装置で言うのが最も強いか」に答えられる。';
/* 各方向の追加執行2案（v0=基準執行と合わせて執行3案）。プロンプトは完全独立（接尾辞方式は廃止） */
var DIR_EXECUTIONS = {
'blend-bs': [
{ slot:'vLo', label:'数値で語る — 計器なし', aim:'ダイヤル（図像）を外し、配合数値だけで調律の約束が伝わるかの下限測定。', glance:'銀の王道缶に62:38の数字。', decision:'主導装置=A6数値。図像ゼロ。', seek:'数値単体の伝達力。', coding:{A1:'銀白',A2:'金属',A3:'なし',A4:'静的',A5:'中央シンメトリー',A6:'配合数値',A7:'なし',A8:'毛筆'}, pkg:'', kv:'' },
{ slot:'vHi', label:'計器で語る — ダイヤル大型化', aim:'可変要素（針）の声量最大化＝「毎回違う→限定品」誤読の閾値を実測する攻め端。', glance:'缶の主役が四季目盛の大ダイヤル。', decision:'主導装置=V3計器（大型）。四季は文字目盛のみ維持。', seek:'可変の声量と定番知覚のトレードオフ。', coding:{A1:'銀白',A2:'金属',A3:'調律ダイヤル大',A4:'可変（針）',A5:'中央シンメトリー',A6:'配合数値',A7:'計器',A8:'毛筆'}, pkg:'', kv:'' }
],
'my-1': [
{ slot:'vLo', label:'色で語る — 白の下限', aim:'灰青を抜いた白+粒子だけで柔らかさが立つかの下限。', glance:'ほぼ白。', decision:'主導装置=V1（白）。', seek:'色の下限。', coding:{A1:'白',A2:'金属',A3:'なし',A4:'静的',A5:'中央',A6:'なし',A7:'粒子',A8:'細セリフ'}, pkg:'', kv:'' },
{ slot:'vHi', label:'色で語る — 深い靄', aim:'青鼠まで沈む攻め端＝発泡酒誤読の計器。', glance:'深い霧。', decision:'主導装置=V1（深グラデ）。', seek:'誤読との相関。', coding:{A1:'白×青鼠',A2:'金属',A3:'なし',A4:'静的',A5:'中央',A6:'なし',A7:'グラデ',A8:'細セリフ'}, pkg:'', kv:'' }
],
'my-2': [
{ slot:'vLo', label:'構図で語る — 三本の間', aim:'秩序の最少本数。', glance:'白磁に3本。', decision:'主導装置=V4（最少リズム）。', seek:'構図の下限。', coding:{A1:'白',A2:'マット',A3:'なし',A4:'静的',A5:'下部3線',A6:'なし',A7:'極細線',A8:'細セリフ'}, pkg:'', kv:'' },
{ slot:'vHi', label:'構図で語る — 全面の呼吸', aim:'全面リズムの攻め端＝文具誤読の計器。', glance:'全面の等間隔線。', decision:'主導装置=V4（全面）。', seek:'誤読との相関。', coding:{A1:'白',A2:'マット',A3:'なし',A4:'静的',A5:'全面リズム',A6:'なし',A7:'極細線',A8:'細セリフ'}, pkg:'', kv:'' }
],
'my-3': [
{ slot:'vLo', label:'素材で語る — 曇りのみ', aim:'拭き跡なしの質感単体。', glance:'曇りガラスの缶。', decision:'主導装置=V2（結露質感）。', seek:'素材の下限。', coding:{A1:'磨り銀',A2:'ガラス質',A3:'なし',A4:'静的',A5:'中央',A6:'なし',A7:'曇り',A8:'細セリフ'}, pkg:'', kv:'' },
{ slot:'vHi', label:'素材×構図 — 円の晴れ間', aim:'拭き跡の主役化と可読の円内集約。', glance:'大きな円だけ晴れて琥珀。', decision:'主導装置=V2+V4（円）。', seek:'物語装置の上限。', coding:{A1:'磨り銀×琥珀',A2:'ガラス質',A3:'円窓の琥珀',A4:'静的',A5:'円中心',A6:'なし',A7:'円',A8:'細セリフ'}, pkg:'', kv:'' }
],
'qt-1': [
{ slot:'vLo', label:'素材で語る — 金ゼロ', aim:'金なしの静けさ単体。', glance:'ただ静かな紺鼠。', decision:'主導装置=V2（マット）。金ゼロ。', seek:'内包演出の寄与の分離。', coding:{A1:'紺鼠',A2:'マット',A3:'なし',A4:'静的',A5:'中央',A6:'なし',A7:'なし',A8:'細セリフ'}, pkg:'', kv:'' },
{ slot:'vHi', label:'素材で語る — 二段の内包', aim:'内包を縁+底の二段に＝発見の演出上限。', glance:'棚では静か、手の中で金。', decision:'主導装置=V2（内包×2）。', seek:'開栓体験の上限。', coding:{A1:'紺鼠×金縁',A2:'マット×金属',A3:'なし',A4:'静的',A5:'中央',A6:'なし',A7:'縁',A8:'細セリフ'}, pkg:'', kv:'' }
],
'qt-2': [
{ slot:'vLo', label:'構図で語る — 下1/4', aim:'低重心の最少構成。', glance:'下だけに要素。', decision:'主導装置=V4（低重心）。', seek:'構図の下限。', coding:{A1:'墨鼠×生成り',A2:'マット',A3:'なし',A4:'静的',A5:'低重心',A6:'なし',A7:'なし',A8:'細セリフ'}, pkg:'', kv:'' },
{ slot:'vHi', label:'構図で語る — 見切れの底辺', aim:'底辺ぎりぎり＋麦の見切れ＝安価誤読の計器。', glance:'底に沈む要素と半分の麦。', decision:'主導装置=V4（見切れ）。', seek:'省略の上限。', coding:{A1:'生成り',A2:'マット',A3:'麦半分',A4:'静的',A5:'底辺整列',A6:'なし',A7:'細密線画',A8:'細セリフ'}, pkg:'', kv:'' }
],
'qt-3': [
{ slot:'vLo', label:'色で語る — 緑鼠のみ', aim:'金線なしの色単体。', glance:'緑鼠一色。', decision:'主導装置=V1。', seek:'色の下限。', coding:{A1:'緑鼠',A2:'マット',A3:'なし',A4:'静的',A5:'中央',A6:'なし',A7:'なし',A8:'細セリフ'}, pkg:'', kv:'' },
{ slot:'vHi', label:'色で語る — 深緑の底', aim:'濃緑の攻め端＝黒ビール/緑茶誤読の計器。', glance:'深い森の色。', decision:'主導装置=V1（濃）。', seek:'濃度と誤読の相関。', coding:{A1:'深緑鼠',A2:'マット',A3:'なし',A4:'静的',A5:'中央',A6:'なし',A7:'金帯',A8:'細セリフ'}, pkg:'', kv:'' }
],
'nd-1': [
{ slot:'vLo', label:'図像で語る — 最少の座標', aim:'目盛を一区間+中点だけに。', glance:'短い目盛と点。', decision:'主導装置=V3（最少計器）。', seek:'座標の下限。', coding:{A1:'銀白',A2:'金属',A3:'中点',A4:'静的',A5:'中央',A6:'なし',A7:'点',A8:'ジオメトリック'}, pkg:'', kv:'' },
{ slot:'vHi', label:'図像で語る — 盤面の全面', aim:'計器盤の全面化＝ガジェット誤読の計器。', glance:'同心円の盤と針一本。', decision:'主導装置=V3（全面計器）。', seek:'計器の上限。', coding:{A1:'銀白',A2:'金属',A3:'計器盤',A4:'静的',A5:'同心円',A6:'なし',A7:'目盛',A8:'ジオメトリック'}, pkg:'', kv:'' }
],
'nd-2': [
{ slot:'vLo', label:'色で語る — 線なしのあいだ', aim:'中点線を外し、名前の位置だけで中間を言う。', glance:'弱いグラデと中間の名前。', decision:'主導装置=V1（弱グラデ）。', seek:'色の下限。', coding:{A1:'紺→淡青',A2:'金属',A3:'なし',A4:'静的',A5:'中間ロゴ',A6:'なし',A7:'グラデ',A8:'サンセリフ'}, pkg:'', kv:'' },
{ slot:'vHi', label:'色×構図 — 中間帯の面', aim:'中間を線でなく太い白帯（面）に。', glance:'紺と淡青を白帯がつなぐ。', decision:'主導装置=V1+V4（帯）。', seek:'面化の上限。', coding:{A1:'紺×白×淡青',A2:'金属',A3:'なし',A4:'静的',A5:'三分帯',A6:'なし',A7:'帯',A8:'サンセリフ'}, pkg:'', kv:'' }
],
'nd-3': [
{ slot:'vLo', label:'図像で語る — 小さな結び', aim:'結びを小紋に。', glance:'小さなあわじ結び。', decision:'主導装置=V3（小紋）。', seek:'和意匠の下限。', coding:{A1:'銀白',A2:'金属',A3:'小結び',A4:'静的',A5:'中央',A6:'なし',A7:'細線',A8:'ジオメトリック'}, pkg:'', kv:'' },
{ slot:'vHi', label:'図像×構図 — 一本の紐', aim:'紐が缶を縦走し中央で結ばれる物語化＝進物誤読の計器。', glance:'縦の紐と結び。', decision:'主導装置=V3+V4（縦走）。', seek:'物語の上限。', coding:{A1:'銀白×紺',A2:'金属',A3:'紐と結び',A4:'静的',A5:'縦軸',A6:'なし',A7:'紐',A8:'ジオメトリック'}, pkg:'', kv:'' }
],
'ct-1': [
{ slot:'vLo', label:'素材で語る — 鏡面のみ', aim:'反射線を外した鏡面単体。', glance:'無音のガンメタル。', decision:'主導装置=V2（鏡面）。', seek:'素材の下限。', coding:{A1:'ガンメタル',A2:'鏡面',A3:'なし',A4:'静的',A5:'右上非対称',A6:'なし',A7:'なし',A8:'エクステンデッド'}, pkg:'', kv:'' },
{ slot:'vHi', label:'素材で語る — 窓灯の反射群', aim:'夜の窓明かりのグリッド反射＝絵柄化ぎりぎりの計器。', glance:'光の矩形が規則的に映る。', decision:'主導装置=V2（反射密度）。', seek:'気配の上限。', coding:{A1:'ガンメタル×灯',A2:'鏡面',A3:'反射矩形',A4:'静的',A5:'右下重心',A6:'なし',A7:'光点',A8:'エクステンデッド'}, pkg:'', kv:'' }
],
'ct-2': [
{ slot:'vLo', label:'構図で語る — 二本の罫', aim:'グリッドの最少。', glance:'薄鼠に2本の線。', decision:'主導装置=V4（最少グリッド）。', seek:'構図の下限。', coding:{A1:'薄鼠',A2:'マット',A3:'なし',A4:'静的',A5:'左寄せ2罫',A6:'なし',A7:'罫',A8:'グロテスク'}, pkg:'', kv:'' },
{ slot:'vHi', label:'構図で語る — 座標の夜', aim:'全面グリッド＋必須数値の座標配置＝文具/工学誤読の計器。', glance:'細グリッドに整列した表記。', decision:'主導装置=V4（座標組版）。', seek:'秩序の上限。', coding:{A1:'薄鼠',A2:'マット',A3:'なし',A4:'静的',A5:'全面グリッド',A6:'数値ラベル',A7:'罫',A8:'グロテスク'}, pkg:'', kv:'' }
],
'ct-3': [
{ slot:'vLo', label:'構図で語る — 小窓の遠景', aim:'窓を小さく琥珀を淡く＝温度の下限。', glance:'遠くに一点の琥珀。', decision:'主導装置=V4（小窓）。', seek:'可読の下限。', coding:{A1:'ガンメタル×淡琥珀',A2:'金属',A3:'小窓',A4:'静的',A5:'中央小窓',A6:'なし',A7:'枠',A8:'エクステンデッド'}, pkg:'', kv:'' },
{ slot:'vHi', label:'構図で語る — 大開口', aim:'写実面積の上限＝都会らしさとのトレードオフ計器。', glance:'額縁の中いっぱいの琥珀。', decision:'主導装置=V4（大開口）。', seek:'写実量の上限。', coding:{A1:'ガンメタル×琥珀',A2:'金属',A3:'大開口写実',A4:'静的',A5:'額装',A6:'なし',A7:'枠',A8:'エクステンデッド'}, pkg:'', kv:'' }
],
'kalt-a': [
{ slot:'vLo', label:'色で語る — 雷雲の藍', aim:'雷文（図像）を外し、藍という色の連想だけで名前を支えられるかの分離測定。', glance:'銀缶の上部だけ深い藍。', decision:'主導装置=V1支配色。文様・図像ゼロ。', seek:'色単体の下限。', coding:{A1:'銀白×藍',A2:'金属',A3:'なし',A4:'静的',A5:'中央シンメトリー',A6:'なし',A7:'色面',A8:'毛筆'}, pkg:'', kv:'' },
{ slot:'vHi', label:'構図で語る — 文様の全面', aim:'雷文の全面グリッド化＝文様が構図を支配する攻め端。器物誤読の実測計器。', glance:'全面の雷文。中央に白窓とロゴ。', decision:'主導装置=V4構図（全面文様＋白窓）。', seek:'文様の声量と誤読の相関。', coding:{A1:'銀白×藍',A2:'金属',A3:'雷文全面',A4:'静的',A5:'全面グリッド',A6:'なし',A7:'幾何文様',A8:'毛筆'}, pkg:'', kv:'' }
],
'kalt-b': [
{ slot:'vLo', label:'素材で語る — 白と凹凸', aim:'印刷線を外し、エンボスの凹凸だけで「水の痕跡」が伝わるかの分離測定。', glance:'白い和紙缶。触りたくなる凹凸。', decision:'主導装置=V2素材感（エンボスのみ）。', seek:'素材単体の下限。', coding:{A1:'白',A2:'紙・凹凸',A3:'なし',A4:'静的',A5:'中央シンメトリー',A6:'なし',A7:'エンボス',A8:'水茎カナ'}, pkg:'', kv:'' },
{ slot:'vHi', label:'構図で語る — 二界の水帯', aim:'くぐる前/後の二界を1缶で言う構図の攻め端。', glance:'中央を水の帯が貫き、左右で乾/濡。', decision:'主導装置=V4構図（縦貫の帯と二界）。', seek:'構図の物語が伝わるかと限定品誤読。', coding:{A1:'白×淡青',A2:'紙',A3:'水帯',A4:'流動',A5:'縦三分割',A6:'なし',A7:'帯',A8:'水茎カナ'}, pkg:'', kv:'' }
],
'kalt-c': [
{ slot:'vLo', label:'色で語る — 白磁のみ', aim:'要素を白とロゴだけに絞った下限測定。', glance:'白磁にKIYOTORAだけ。', decision:'主導装置=V1（無地の白）。', seek:'無印文法の可読下限。', coding:{A1:'白',A2:'磁器質',A3:'なし',A4:'静的',A5:'中央',A6:'なし',A7:'なし',A8:'ジオメトリック'}, pkg:'', kv:'' },
{ slot:'vHi', label:'構図で語る — 欧文組版', aim:'スイス組版の欧文主導＝輸入/クラフト誤読の実測計器。', glance:'左寄せグリッドのKIYOTORA。漢字は極小。', decision:'主導装置=V4構図（グリッド組版）。', seek:'欧文主導の攻め端の誤読率。', coding:{A1:'白',A2:'磁器質',A3:'なし',A4:'静的',A5:'左寄せグリッド',A6:'なし',A7:'罫',A8:'グロテスク'}, pkg:'', kv:'' }
],
'sumi-s1': [
{ slot:'vLo', label:'色で語る — 水面のグラデ',
aim:'命題「澄みとは、水源の風景である。」を支配色ひとつで運ぶ執行。図像・構図は王道のまま、地色だけが水になる。',
glance:'王道レイアウトのまま、地が白→淡青の水光に沈む。',
decision:'主導装置=V1支配色（白→淡青の透明グラデ、金属光沢は水面反射として維持）。V3図像は使わず（文字ロゴのみ）、V4構図は中央対称の王道。泡・生表記は特大。',
seek:'色単体で「水源の澄み」がどこまで運べるかの分離測定。',
coding:{A1:'青系',A2:'金属',A3:'文字ロゴのみ',A4:'静的',A5:'中央シンメトリー',A6:'あり',A7:'なし',A8:'明朝・毛筆系'},
pkg:'Photorealistic 350ml Japanese beer can, front view, 3:4. All foam, barley and liquid imagery is PRINTED label artwork on the can surface — never real foam or liquid on or around the can. Completely conventional mainstream Japanese beer layout, but the ground is a luminous white-to-pale-aqua gradient like clear spring water, metallic sheen kept as water-light reflection. NO pictorial motif: only the large vertical navy brush logo 澄虎 centered, SUMITORA below. EXTRA-LARGE realistic foam head and clearly legible 生ビール as beer anchors. Mandatory labels in conventional positions: 麦芽100% / ラガー×エール ブレンド / 生ビール（非熱処理）, ALC.5%, 純アルコール量14g, お酒 mark.',
kv:'Advertising banner key visual comp, 16:9. Product hero: the white-to-aqua gradient 350ml beer can (match the attached can reference EXACTLY if provided) on a wet reflective surface. Backdrop: pure gradient of clear water light, no scenery. Large Japanese headline placeholder 「澄む、一杯。」 in navy brush, logo block bottom right. Polished ad-agency banner finish. No people.' },
{ slot:'vHi', label:'構図で語る — 水平線の風景',
aim:'命題を構図ひとつで運ぶ執行。缶の面を水源の風景そのものにする。',
glance:'缶が風景になる。下1/3が水面、上に静かな空。',
decision:'主導装置=V4構図（低い水平線・横帯分割の風景構図。下界=鏡面の水面写実、上界=夜明けの空）。V3の水紋パターンは使わず、風景の写実で語る。ロゴは空に浮かぶ。泡・生表記は水面帯に維持。',
seek:'構図（風景化）単体の運搬力と、解読失敗の位置。',
coding:{A1:'青系',A2:'金属',A3:'写実（麦・泡・情景）',A4:'静的',A5:'横帯分割',A6:'あり',A7:'なし',A8:'明朝・毛筆系'},
pkg:'Photorealistic 350ml Japanese beer can, front view, 3:4. All foam, barley and liquid imagery is PRINTED label artwork on the can surface — never real foam or liquid on or around the can. The can face is a serene landscape: lower third is a mirror-calm COLD water surface with photoreal reflections, upper part a pale COLD dawn sky in blue-grey and white, one thin low horizon line dividing them. STRICTLY no sunset, no golden hour, no warm orange or amber light anywhere — the world is cold, clear and quiet. Large vertical navy brush logo 澄虎 floating in the sky area. Realistic foam and legible 生ビール anchored on the water band. Metallic sheen as water light. Mandatory labels in conventional positions: 麦芽100% / ラガー×エール ブレンド / 生ビール（非熱処理）, ALC.5%, 純アルコール量14g, お酒 mark.',
kv:'Advertising banner key visual comp, 16:9. Product hero: the horizon-landscape 350ml beer can (match the attached can reference EXACTLY if provided) standing at the edge of a mirror-calm cold water surface at pale blue-grey dawn, low horizon behind it matching the can. No sunset, no warm orange light — cold clear light only. Large Japanese headline placeholder 「澄む、一杯。」, logo block bottom right. Polished ad-agency banner finish. No people.' } ],
'sumi-s2': [
{ slot:'vLo', label:'素材で語る — 奉書の白',
aim:'命題「祓いとは、白い儀式である。」を地の素材感ひとつで運ぶ執行。',
glance:'図像なし。紙の白の密度だけが神聖を語る。',
decision:'主導装置=V2素材感（奉書・織の密度ある白）。V3図像は使わず文字ロゴのみ、V4は王道の中央対称、金は極細の縁のみ。泡・麦は帯で維持。',
seek:'素材感単体で神聖が立つかの分離測定。',
coding:{A1:'白・クリーム',A2:'紙・布質感',A3:'文字ロゴのみ',A4:'静的',A5:'中央シンメトリー',A6:'あり',A7:'線・縁',A8:'明朝・毛筆系'},
pkg:'Photorealistic 350ml Japanese beer can, front view, 3:4. All foam, barley and liquid imagery is PRINTED label artwork on the can surface — never real foam or liquid on or around the can. Ground: dense hosho-paper white with a subtle woven relief texture, no pictorial motif at all. Only the large vertical navy brush logo 澄虎 and one hairline gold border. A clean band keeps realistic foam and barley. Serene, precise. Mandatory labels in conventional positions: 麦芽100% / ラガー×エール ブレンド / 生ビール（非熱処理）, ALC.5%, 純アルコール量14g, お酒 mark.',
kv:'Advertising banner key visual comp, 16:9. Product hero: the plain paper-white 350ml beer can (match the attached can reference EXACTLY if provided) on white woven fabric, soft morning light. Vast quiet white copy space, large Japanese headline placeholder 「今日を、清める。」, logo block bottom right. Polished ad-agency banner finish. No people.' },
{ slot:'vHi', label:'構図で語る — 結界の余白',
aim:'命題を構図（結界の完全対称と余白）で運ぶ執行。',
glance:'鳥居のような細い金の枠。中心に小さな紋。圧倒的な余白。',
decision:'主導装置=V4構図（結界＝細い金の門型フレームと完全対称、要素を極小化した余白の設計）。V3は小さな截金虎紋を中心に一点だけ。泡・表記は最小可読で下部に整列。',
seek:'余白の構図単体の神聖運搬力と、店頭視認の下限。',
coding:{A1:'白・クリーム',A2:'紙・布質感',A3:'紋章・エンブレム',A4:'静的',A5:'中央シンメトリー',A6:'なし',A7:'線・縁',A8:'明朝・毛筆系'},
pkg:'Photorealistic 350ml Japanese beer can, front view, 3:4. All foam, barley and liquid imagery is PRINTED label artwork on the can surface — never real foam or liquid on or around the can. Ground: quiet paper white. Composition is the message: a thin gold torii-like rectangular frame encloses vast empty space, with one small kirikane-style white tiger crest at the exact center and the vertical navy brush logo 澄虎 beneath it. All mandatory texts compressed to minimum legible size, aligned at the bottom. Extreme symmetry, sacred emptiness. Mandatory labels in conventional positions: 麦芽100% / ラガー×エール ブレンド / 生ビール（非熱処理）, ALC.5%, 純アルコール量14g, お酒 mark.',
kv:'Advertising banner key visual comp, 16:9. Product hero: the white can with thin gold frame (match the attached can reference EXACTLY if provided) centered in a vast empty white space like a shrine hall, single soft light beam. Minimal Japanese headline placeholder 「今日を、清める。」, logo block bottom right. Polished ad-agency banner finish. No people.' } ],
'sumi-s3': [
{ slot:'vLo', label:'図像で語る — 一筆の虎紋',
aim:'命題「祓いとは、一閃の墨である。」を図像（紋章化した一筆の虎）で運ぶ執行。構図は王道のまま。',
glance:'王道レイアウトの中心に、一筆書きの虎の紋。',
decision:'主導装置=V3図像（一筆の墨で描かれた虎を紋章サイズに収める）。V4は中央対称の王道、地は銀白金属のまま。',
seek:'墨の気迫を紋章の枠内に収めた場合の運搬力（＝日本酒漂流の最小リスク執行）。',
coding:{A1:'銀白',A2:'金属',A3:'紋章・エンブレム',A4:'静的',A5:'中央シンメトリー',A6:'あり',A7:'なし',A8:'明朝・毛筆系'},
pkg:'Photorealistic 350ml Japanese beer can, front view, 3:4. All foam, barley and liquid imagery is PRINTED label artwork on the can surface — never real foam or liquid on or around the can. Bright silver-white metallic ground, completely conventional layout. Center: a compact emblem of a tiger drawn in ONE continuous sumi ink stroke, contained like a crest, above the vertical navy brush logo 澄虎. Realistic foam and 生ビール prominent. Mandatory labels in conventional positions: 麦芽100% / ラガー×エール ブレンド / 生ビール（非熱処理）, ALC.5%, 純アルコール量14g, お酒 mark.',
kv:'Advertising banner key visual comp, 16:9. Product hero: the silver can with one-stroke tiger crest (match the attached can reference EXACTLY if provided), crisp studio light. Clean silver-white copy space with one small ink flick accent, large Japanese headline placeholder 「静かに、強い。」, logo block bottom right. Polished ad-agency banner finish. No people.' },
{ slot:'vHi', label:'素材で語る — 墨の面',
aim:'命題を素材（濡れた墨の黒い面）で運ぶ執行。',
glance:'缶の半分が墨の面。白虎が白抜きで立つ。',
decision:'主導装置=V2素材感（缶の下半を濡れ艶のある墨黒の面にし、銀白との明度差で気迫を作る）。V3は墨面の中に白抜きの虎。V4は上下の面分割。',
seek:'墨の物質感単体の強さと、黒面の酒種可読（黒ビール・ノンアル黒との識別）。',
coding:{A1:'黒',A2:'金属',A3:'紋章・エンブレム',A4:'静的',A5:'横帯分割',A6:'あり',A7:'なし',A8:'明朝・毛筆系'},
pkg:'Photorealistic 350ml Japanese beer can, front view, 3:4. All foam, barley and liquid imagery is PRINTED label artwork on the can surface — never real foam or liquid on or around the can. Upper half: bright silver-white metallic with the vertical navy brush logo 澄虎, realistic foam and 生ビール clearly legible. Lower half: a deep wet-gloss sumi-ink black field with a white tiger reversed out in negative space. The boundary is one confident torn ink edge. Mandatory labels in conventional positions: 麦芽100% / ラガー×エール ブレンド / 生ビール（非熱処理）, ALC.5%, 純アルコール量14g, お酒 mark.',
kv:'Advertising banner key visual comp, 16:9. Product hero: the half-ink 350ml beer can (match the attached can reference EXACTLY if provided) on a black lacquer surface, dramatic side light. Backdrop: silver-white with one massive wet ink field entering from below. Large white Japanese headline placeholder 「静かに、強い。」 reversed in the ink, logo block bottom right. Polished ad-agency banner finish. No people.' } ],
'sumi-s4': [
{ slot:'vLo', label:'図像で語る — のれんの紋帯',
aim:'命題「祓いとは、のれんをくぐる所作である。」を図像（藍の紋帯）で運ぶ執行。構図は王道のまま。',
glance:'銀の王道缶の上部に、藍染の紋帯が一本掛かる。',
decision:'主導装置=V3図像（缶上部に抜染虎紋入りの藍のれん帯を一本）。V4は中央対称を維持、地は銀白金属。',
seek:'のれん記号を帯一本に留めた場合の切り替え感（＝限定品誤読の最小リスク執行）。',
coding:{A1:'銀白',A2:'金属',A3:'紋章・エンブレム',A4:'静的',A5:'横帯分割',A6:'あり',A7:'なし',A8:'明朝・毛筆系'},
pkg:'Photorealistic 350ml Japanese beer can, front view, 3:4. All foam, barley and liquid imagery is PRINTED label artwork on the can surface — never real foam or liquid on or around the can. Conventional bright silver metallic beer can. Across the upper quarter hangs a single indigo-dyed noren fabric band with a resist-dyed white tiger crest and small fabric slits. Below it: conventional layout, vertical navy brush logo 澄虎, realistic foam, legible 生ビール. Mandatory labels in conventional positions: 麦芽100% / ラガー×エール ブレンド / 生ビール（非熱処理）, ALC.5%, 純アルコール量14g, お酒 mark.',
kv:'Advertising banner key visual comp, 16:9. Product hero: the silver can with indigo noren band (match the attached can reference EXACTLY if provided) on an izakaya counter at dusk, warm light. Large Japanese headline placeholder 「くぐって、切り替える。」, logo block bottom right. Polished ad-agency banner finish. No people.' },
{ slot:'vHi', label:'素材で語る — 全面の藍布',
aim:'命題を素材（全面の染布）で運ぶ執行。',
glance:'缶全体が一枚の藍染の布になる。',
decision:'主導装置=V2素材感（全面を藍染布のマット質感に。白抜きロゴと虎紋）。V4は中央対称に戻し、下部の細帯にだけ王道記号を圧縮（最小可読死守）。',
seek:'布の全面化の運搬力と、ビール可読の下限（2秒棚テストの計器）。',
coding:{A1:'青系',A2:'紙・布質感',A3:'紋章・エンブレム',A4:'静的',A5:'中央シンメトリー',A6:'あり',A7:'なし',A8:'明朝・毛筆系'},
pkg:'Photorealistic 350ml Japanese beer can, front view, 3:4. All foam, barley and liquid imagery is PRINTED label artwork on the can surface — never real foam or liquid on or around the can. The entire can surface is indigo-dyed fabric with visible weave and dye unevenness, a large resist-dyed white tiger crest and the white brush logo 澄虎 centered. One narrow bottom band keeps metallic ground, realistic foam and all mandatory texts at minimum legible size, clearly readable. Mandatory labels in conventional positions: 麦芽100% / ラガー×エール ブレンド / 生ビール（非熱処理）, ALC.5%, 純アルコール量14g, お酒 mark.',
kv:'Advertising banner key visual comp, 16:9. Product hero: the full-indigo fabric-textured can (match the attached can reference EXACTLY if provided) standing between two indigo noren panels with a warm light slit. Resist-dyed white Japanese headline placeholder 「くぐって、切り替える。」 on the fabric, logo block bottom right. Polished ad-agency banner finish. No people.' } ],
'blend-b1': [
{ slot:'vLo', label:'色で語る — 紺の地',
aim:'命題「調律とは、暖簾の信用である。」を支配色（全面の深紺）で運ぶ執行。',
glance:'帯ではなく、缶全体が深紺。金は細線のみ。',
decision:'主導装置=V1支配色（全面深紺×細金線）。V3・V4は王道（紋章＋中央対称）。泡・麦芽の写実を増強して緑茶可読を防ぐ。',
seek:'紺の全面化単体の格の運搬力と、緑茶誤帰属の位置。',
coding:{A1:'青系',A2:'金属',A3:'紋章・エンブレム',A4:'静的',A5:'中央シンメトリー',A6:'あり',A7:'線・縁',A8:'明朝・毛筆系'},
pkg:'Photorealistic 350ml Japanese beer can, front view, 3:4. All foam, barley and liquid imagery is PRINTED label artwork on the can surface — never real foam or liquid on or around the can. Ground: entire can in deep navy metallic with lacquer-like depth, thin gold hairlines only. Center: barley family-crest emblem and bold vertical brush logo. AMPLIFIED realistic golden beer foam and barley photography to guarantee beer readability. Mandatory labels in conventional positions: 麦芽100% / ラガー×エール ブレンド / 生ビール（非熱処理）, ALC.5%, 純アルコール量14g, お酒 mark.',
kv:'Advertising banner key visual comp, 16:9. Product hero: the full-navy 350ml beer can (match the attached can reference EXACTLY if provided), premium studio light. Deep navy copy space with thin gold rules, large golden beer pour with foam beside the can. Large Japanese headline placeholder 「間違いのない一杯。」, logo block bottom right. Polished ad-agency banner finish. No people.' },
{ slot:'vHi', label:'図像で語る — 家紋の大紋',
aim:'命題を図像（麦の家紋を主役化）で運ぶ執行。',
glance:'白銀の缶に、大きな麦の家紋がひとつ。',
decision:'主導装置=V3図像（麦を家紋様式化した大紋を缶面の主役に）。V1は白銀の王道、V4は中央対称。',
seek:'紋章の大型化単体の格と、視認距離での識別力。',
coding:{A1:'銀白',A2:'金属',A3:'紋章・エンブレム',A4:'静的',A5:'中央シンメトリー',A6:'あり',A7:'線・縁',A8:'明朝・毛筆系'},
pkg:'Photorealistic 350ml Japanese beer can, front view, 3:4. All foam, barley and liquid imagery is PRINTED label artwork on the can surface — never real foam or liquid on or around the can. Ground: bright silver-white metallic. One LARGE barley family crest (kamon style, navy with gold hairline) dominates the upper face like a noren crest, bold logo beneath. Realistic foam and barley kept. Mandatory labels in conventional positions: 麦芽100% / ラガー×エール ブレンド / 生ビール（非熱処理）, ALC.5%, 純アルコール量14g, お酒 mark.',
kv:'Advertising banner key visual comp, 16:9. Product hero: the silver can with a large barley kamon (match the attached can reference EXACTLY if provided), dignified studio light. Copy space: silver-white with one huge faint kamon watermark. Large Japanese headline placeholder 「間違いのない一杯。」, logo block bottom right. Polished ad-agency banner finish. No people.' } ],
'blend-b2': [
{ slot:'vLo', label:'素材で語る — 紙の地',
aim:'命題「調律とは、職人の手である。」を素材（クラフト紙の地）だけで運ぶ執行。',
glance:'紙の質感の缶。レイアウトは王道のまま。',
decision:'主導装置=V2素材感（クラフト紙×活版）。手書き要素は使わず、活版の端正な組版で王道レイアウトを維持。',
seek:'紙の質感単体の体温と、クラフト誤読の位置（手書きなし条件）。',
coding:{A1:'白・クリーム',A2:'紙・布質感',A3:'文字ロゴのみ',A4:'静的',A5:'中央シンメトリー',A6:'なし',A7:'線・縁',A8:'角ゴシック系'},
pkg:'Photorealistic 350ml Japanese beer can, front view, 3:4. All foam, barley and liquid imagery is PRINTED label artwork on the can surface — never real foam or liquid on or around the can. Ground: warm kraft-paper texture with precise letterpress typography in a completely conventional mainstream layout. No handwriting, no stamps. Bold logo, thin brass rule lines. All mandatory texts letterpress-printed at conventional positions. Mandatory labels in conventional positions: 麦芽100% / ラガー×エール ブレンド / 生ビール（非熱処理）, ALC.5%, 純アルコール量14g, お酒 mark.',
kv:'Advertising banner key visual comp, 16:9. Product hero: the kraft-textured can (match the attached can reference EXACTLY if provided) on a clean workshop desk, soft daylight. Kraft copy space with letterpress rules, large Japanese headline placeholder 「今季の配合、決まりました。」, logo block bottom right. Polished ad-agency banner finish. No people.' },
{ slot:'vHi', label:'構図で語る — 貼付ラベルの工房',
aim:'命題を構図（現物のラベルを貼った工房の缶）で運ぶ執行。',
glance:'銀缶に、手貼りの配合ラベルと検印。工房の現物感。',
decision:'主導装置=V4構図（銀の素缶に紙ラベルを貼付した構成。ラベル内に手書きの配合と検印、貼りの物質感）。地は金属に戻す。',
seek:'「人の手の痕跡」の構図単体の信頼と、限定品誤読の位置（計器）。',
coding:{A1:'銀白',A2:'金属',A3:'文字ロゴのみ',A4:'静的',A5:'中央シンメトリー',A6:'なし',A7:'なし',A8:'明朝・毛筆系'},
pkg:'Photorealistic 350ml Japanese beer can, front view, 3:4. All foam, barley and liquid imagery is PRINTED label artwork on the can surface — never real foam or liquid on or around the can. A plain brushed-silver can with a real kraft-paper label physically pasted on it (visible edges, slight paper thickness), carrying a handwritten seasonal blend ratio, a red workshop inspection stamp and letterpress brand logo. Mandatory texts printed on the label, clearly readable. Mandatory labels in conventional positions: 麦芽100% / ラガー×エール ブレンド / 生ビール（非熱処理）, ALC.5%, 純アルコール量14g, お酒 mark.',
kv:'Advertising banner key visual comp, 16:9. Product hero: the silver can with pasted kraft label (match the attached can reference EXACTLY if provided) on a workbench among blending tools, warm afternoon light. Handwritten ratio note pinned in the copy space, large Japanese headline placeholder 「今季の配合、決まりました。」, logo block bottom right. Polished ad-agency banner finish. No people.' } ],
'blend-b3': [
{ slot:'vLo', label:'色で語る — 金と銅の二色',
aim:'命題「調律とは、精密な設計である。」を支配色（二流の二色分割）で運ぶ執行。',
glance:'缶が金と銅の二色に静かに分かれる。図像なし。',
decision:'主導装置=V1支配色（金と銅の垂直二色分割。合流のダイアグラムは使わない）。V4は整列した王道。',
seek:'二色分割単体で「二つが一つに」が読めるか。',
coding:{A1:'金・琥珀',A2:'金属',A3:'文字ロゴのみ',A4:'静的',A5:'縦帯分割',A6:'あり',A7:'面',A8:'角ゴシック系'},
pkg:'Photorealistic 350ml Japanese beer can, front view, 3:4. All foam, barley and liquid imagery is PRINTED label artwork on the can surface — never real foam or liquid on or around the can. Ground: precise vertical two-tone split, warm gold metal left and copper metal right, meeting in one clean seam at the center where the bold logo sits. No diagram, no pictorial motif. Grid-aligned typography, realistic foam anchor. Mandatory labels in conventional positions: 麦芽100% / ラガー×エール ブレンド / 生ビール（非熱処理）, ALC.5%, 純アルコール量14g, お酒 mark.',
kv:'Advertising banner key visual comp, 16:9. Product hero: the gold-and-copper two-tone can (match the attached can reference EXACTLY if provided), backlit, condensation. Copy space split in the same two tones meeting behind the headline. Large Japanese headline placeholder 「まざって、ちょうどいい。」, logo block bottom right. Polished ad-agency banner finish. No people.' },
{ slot:'vHi', label:'構図で語る — 図面のグリッド',
aim:'命題を構図（設計図面のグリッドと注記）で運ぶ執行。',
glance:'缶が一枚の精密図面になる。',
decision:'主導装置=V4構図（青焼き図面様のグリッド、寸法線、配合数値の注記で缶面を設計図化）。V3の合流図はグリッドの中の一要素に縮小。',
seek:'図面様式単体の精密感と、解読失敗の位置（計器）。',
coding:{A1:'銀白',A2:'金属',A3:'幾何・抽象',A4:'静的',A5:'中央シンメトリー',A6:'なし',A7:'線・縁',A8:'角ゴシック系'},
pkg:'Photorealistic 350ml Japanese beer can, front view, 3:4. All foam, barley and liquid imagery is PRINTED label artwork on the can surface — never real foam or liquid on or around the can. Ground: pale silver-white metal printed like a precision engineering drawing: fine grid, dimension lines, small blend-ratio annotations, one small two-stream merge diagram as a detail figure. Bold logo in a title block like a drawing frame, all mandatory texts inside neat annotation boxes, clearly readable. Mandatory labels in conventional positions: 麦芽100% / ラガー×エール ブレンド / 生ビール（非熱処理）, ALC.5%, 純アルコール量14g, お酒 mark.',
kv:'Advertising banner key visual comp, 16:9. Product hero: the blueprint-style can (match the attached can reference EXACTLY if provided) on a drafting table with fine grid paper backdrop. Dimension lines pointing to the can, large Japanese headline placeholder 「まざって、ちょうどいい。」, logo block bottom right. Polished ad-agency banner finish. No people.' } ]
};
function _variantSpec(base, mod){
var sp = JSON.parse(JSON.stringify(base));
sp.label = mod.label;
sp.aim = mod.aim;
sp.glance = mod.glance;
sp.decisions = [{ decision: mod.decision, seek: mod.seek, evidence: VARIANT_EVIDENCE }].concat(base.decisions);
sp.coding = mod.coding; sp.codingBasis = '執行の設計（主導装置）から符号化。画像確定後にAI再符号化で検証';
sp.measurement = (base.measurement||'') + ' 同一命題の執行3案を同一調査に入れ、命題をどの装置で言うのが強いかも特定する。';
var dz = DESIGNS[mod._did + '-' + mod.slot];
sp.design = dz || null; sp.fixedVars = base.fixedVars || FIXED_VARS;
sp.prompts = { board: dz ? _boardPrompt(dz, mod.aim||'') : base.prompts.board, package: dz ? _pkgPrompt(dz) : mod.pkg, kv: dz ? _kvPrompt(dz) : mod.kv }; // 設計データから機械生成（ボードも版ごと）
sp.design = sp.design || base.design; _declareName(sp, mod._conceptId, mod._did);
return sp;
}
function _expandVariants(dir){
if ((dir.axis && dir.axis.control) || dir.gated) return dir;
var base = dir.versions[0];
var exes = DIR_EXECUTIONS[dir.id] || [];
var out = [];
exes.forEach(function(m){
if (m.slot !== 'vLo') return;
m._did = dir.id; m._conceptId = dir.conceptId;
out.push({ id: dir.id+'-vLo', parentId: null, created: base.created, label: m.label,
origin: { inputSummary:'ベース設計（執行: '+m.label+'）', interpretation:null, matched:[], verdict:null },
spec: _variantSpec(base.spec, m), visuals:{ board:{status:'empty'}, package:{status:'empty'}, kv:{status:'empty'} } });
});
base.label = (base.spec && base.spec.executionLabel) || '図像・構図で語る — 基準執行';
out.push(base);
exes.forEach(function(m){
if (m.slot !== 'vHi') return;
m._did = dir.id; m._conceptId = dir.conceptId;
out.push({ id: dir.id+'-vHi', parentId: null, created: base.created, label: m.label,
origin: { inputSummary:'ベース設計（執行: '+m.label+'）', interpretation:null, matched:[], verdict:null },
spec: _variantSpec(base.spec, m), visuals:{ board:{status:'empty'}, package:{status:'empty'}, kv:{status:'empty'} } });
});
dir.versions = out;
return dir;
}
/** 方向シードのヘルパ //* 方向シードのヘルパ //* 方向シードのヘルパ */
function _dirSeed(id, conceptId, name, gated, spec, axis){
return {
id: id, conceptId: conceptId, name: name, axis: axis || null,
origin: 'preset', phase: 'direction', gated: gated || null, note: '',
repVersionId: id + '-v0',
versions: [{
id: id + '-v0', parentId: null, created: '2026-07-06T00:00:00Z',
label: spec.label || 'base',
origin: { inputSummary: 'ベース設計（チャットセッションで設計・審査済み）', interpretation: null, matched: [], verdict: null },
spec: (function(){
var dz = DESIGNS[id + '-v0'];
if (dz){ spec.design = dz; spec.fixedVars = spec.fixedVars || FIXED_VARS;
spec.prompts.package = _pkgPrompt(dz); spec.prompts.kv = _kvPrompt(dz);
spec.prompts.board = _boardPrompt(dz, spec.worldLine || spec.aim || ''); }
_declareName(spec, conceptId, id);
return spec;
})(),
visuals: { board:{status:'empty'}, package:{status:'empty'}, kv:{status:'empty'} }
}]
};
}
/* ================= 公開API（google.script.run から呼ばれていた関数） ================= */
var API = {};
[getProject, resetProject, saveProject, assistantChat, updateTabPrefs, saveNote, setPhase, setRepresentative, saveBriefResult, saveBrief,
directInput, approveProposal, approveNewDirection, encodeCanToSchema, adjudicateCell, decomposeReference, deleteReference, deleteDirection,
updateConceptSheet, addConcept, clearVersionOutputs, rebuildSpecFromImage, clearDirectionOutputs, deleteVersion, generateVisual, runGrounding,
researchPlan, researchExecute, researchIntegrate, conceptIntakeBrief, getStyleGuidesView, updateArchetype, addRefTarget, removeRefTarget,
defineStyleGuide, analyzeStyleAssets, buildDirectionExecutions, saveSelection, draftConceptSheet, deleteStyleGuide, getThumbs, getFullImage
].forEach(function(fn){ API[fn.name] = fn; });
module.exports = {
API: API,
SEED_REV: SEED_REV,
readFile: _readFile,
saveFile: _saveFile,
replaceProject: replaceProject,
_internal: { seedProject: _seedProject, migrate: _migrate, loadProject: _loadProject, withLock: _withLock, mimicryCheck: _mimicryCheck, blendAllocation: _blendAllocation, lenientJSON: _lenientJSON, knowledgeFor: _knowledgeFor, hardConstraints: _hardConstraints, finishSpec: _finishSpec }
};
