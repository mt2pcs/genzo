'use strict';
/* LLM 層: GAS版の _chat / _genImage / _groundedAudit（OpenAI互換API）を、
   Vertex AI（Gemini・Gemini画像生成/Imagen・Google検索グラウンディング）に置き換える。
   OpenAI 互換は LLM_PROVIDER=openai で従来どおり使える。
   呼び出し側の契約は GAS 版と同じ:
     chat(messages, {json, maxTokens, effort})           → 本文文字列（OpenAI形式のmessagesを受ける）
     genImage(prompt, {size, aspectRatio}, refImages)    → PNG の base64
     groundedSearch(prompt)                              → { text, cites:[{title,url}] } */
var cfg = require('./config');

function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
function parseDataUri(url){
  var m = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(String(url || ''));
  if (!m) return null;
  return { mime: m[1] || 'application/octet-stream', data: m[2] };
}

/* ================= Vertex AI ================= */
var _auth = null, _projectPromise = null;
function auth(){
  if (!_auth){
    var GoogleAuth = require('google-auth-library').GoogleAuth;
    _auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  }
  return _auth;
}
async function vertexProject(){
  if (cfg.vertex.project) return cfg.vertex.project;
  if (!_projectPromise) _projectPromise = auth().getProjectId();
  var p = await _projectPromise;
  if (!p) throw new Error('VERTEX_PROJECT が未設定で、ADC からもプロジェクトIDを取得できませんでした');
  return p;
}
async function vertexHeaders(){
  var token = await auth().getAccessToken();
  if (!token) throw new Error('Vertex AI のアクセストークンを取得できません（ADC / サービスアカウントの設定を確認）');
  return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
}
function vertexHost(location){ return location === 'global' ? 'https://aiplatform.googleapis.com' : 'https://' + location + '-aiplatform.googleapis.com'; }
async function vertexModelUrl(model, method, location){
  var loc = location || cfg.vertex.location;
  var project = await vertexProject();
  return vertexHost(loc) + '/v1/projects/' + project + '/locations/' + loc + '/publishers/google/models/' + model + ':' + method;
}

/* OpenAI 形式の messages → Gemini の systemInstruction + contents */
function toGeminiParts(content){
  if (content == null) return [];
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  var parts = [];
  (Array.isArray(content) ? content : [content]).forEach(function(c){
    if (!c) return;
    if (typeof c === 'string'){ if (c) parts.push({ text: c }); return; }
    if (c.type === 'text'){ if (c.text) parts.push({ text: String(c.text) }); return; }
    if (c.type === 'image_url'){
      var d = parseDataUri(c.image_url && c.image_url.url);
      if (d) parts.push({ inlineData: { mimeType: d.mime, data: d.data } });
      else if (c.image_url && c.image_url.url) parts.push({ fileData: { mimeType: 'image/png', fileUri: c.image_url.url } });
      return;
    }
    if (c.type === 'file'){
      var fd = parseDataUri(c.file && c.file.file_data);
      if (fd) parts.push({ inlineData: { mimeType: fd.mime, data: fd.data } });
      return;
    }
    if (c.inlineData || c.text) parts.push(c);
  });
  return parts;
}
function toGeminiRequest(messages){
  var system = [], contents = [];
  (messages || []).forEach(function(m){
    if (!m) return;
    if (m.role === 'system' || m.role === 'developer'){ toGeminiParts(m.content).forEach(function(p){ if (p.text) system.push(p.text); }); return; }
    var role = m.role === 'assistant' ? 'model' : 'user';
    var parts = toGeminiParts(m.content);
    if (!parts.length) return;
    // Gemini は同一ロールの連続を嫌うため結合する
    var last = contents[contents.length - 1];
    if (last && last.role === role) last.parts = last.parts.concat(parts);
    else contents.push({ role: role, parts: parts });
  });
  var req = { contents: contents };
  if (system.length) req.systemInstruction = { parts: [{ text: system.join('\n\n') }] };
  return req;
}
/* reasoning_effort → thinkingConfig（2.5系は予算トークン、3系は thinkingLevel） */
function thinkingConfig(model, effort){
  if (!effort) return null;
  if (/^gemini-3/.test(model)) return { thinkingLevel: effort === 'low' ? 'low' : 'high' };
  var budget = { low: 1024, medium: 8192, high: 24576 }[effort];
  return budget ? { thinkingBudget: budget } : null;
}
function candidateText(d){
  var cand = d && d.candidates && d.candidates[0];
  var parts = (cand && cand.content && cand.content.parts) || [];
  return { text: parts.filter(function(p){ return typeof p.text === 'string' && !p.thought; }).map(function(p){ return p.text; }).join(''), finish: cand && cand.finishReason, cand: cand };
}
async function vertexChat(messages, opts){
  opts = opts || {};
  var model = cfg.vertex.model;
  var req = toGeminiRequest(messages);
  req.generationConfig = {};
  if (opts.json) req.generationConfig.responseMimeType = 'application/json';
  if (opts.maxTokens) req.generationConfig.maxOutputTokens = opts.maxTokens;
  var th = thinkingConfig(model, opts.effort);
  if (th) req.generationConfig.thinkingConfig = th;
  var url = await vertexModelUrl(model, 'generateContent');
  var last = '';
  for (var i = 0; i < 3; i++){
    var res = await fetch(url, { method: 'POST', headers: await vertexHeaders(), body: JSON.stringify(req) });
    var body = await res.text();
    if (res.status === 200){
      var d = JSON.parse(body);
      var ct = candidateText(d);
      if (ct.text) return ct.text;
      var fr = ct.finish || (d.promptFeedback && d.promptFeedback.blockReason) || '?';
      last = 'contentが空 (finishReason=' + fr + ', maxOutputTokens=' + (req.generationConfig.maxOutputTokens || 'default') + ')';
      if (fr === 'MAX_TOKENS'){
        // 思考トークンが上限を食い潰したケース: 上限を倍にして自己回復（GAS版と同じ規律）
        req.generationConfig.maxOutputTokens = Math.min((req.generationConfig.maxOutputTokens || 4000) * 2, 65536);
        continue;
      }
    } else {
      last = 'API ' + res.status + ': ' + body.slice(0, 300);
      if (opts.json && res.status === 400 && /response_mime_type|responseMimeType/i.test(body)){ delete req.generationConfig.responseMimeType; continue; }
      if (res.status === 429 || res.status >= 500){ await sleep(1200 * (i + 1)); continue; }
    }
    await sleep(600);
  }
  throw new Error('Vertex AI 呼び出し失敗: ' + last);
}
/* Google検索グラウンディング（OpenAI Responses API の web_search に相当） */
async function vertexGrounded(prompt){
  var model = cfg.vertex.model;
  var req = { contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ googleSearch: {} }], generationConfig: { maxOutputTokens: 8000 } };
  var url = await vertexModelUrl(model, 'generateContent');
  var last = '';
  for (var i = 0; i < 2; i++){
    var res = await fetch(url, { method: 'POST', headers: await vertexHeaders(), body: JSON.stringify(req) });
    var body = await res.text();
    if (res.status === 200){
      var d = JSON.parse(body);
      var ct = candidateText(d);
      var cites = [];
      var gm = ct.cand && ct.cand.groundingMetadata;
      ((gm && gm.groundingChunks) || []).forEach(function(c){ if (c && c.web && c.web.uri) cites.push({ title: c.web.title || '', url: c.web.uri }); });
      if (ct.text) return { text: ct.text, cites: cites };
      last = '出力が空 (finishReason=' + (ct.finish || '?') + ')';
    } else {
      last = 'API ' + res.status + ': ' + body.slice(0, 300);
    }
    await sleep(800);
  }
  throw new Error('グラウンディング失敗: ' + last);
}
/* 画像生成: Gemini 画像モデル（generateContent・参照画像つき編集可）/ Imagen（:predict・テキストのみ） */
async function vertexImage(prompt, opts, refImages){
  opts = opts || {};
  var model = cfg.vertex.imageModel;
  var aspect = opts.aspectRatio || '1:1';
  if (/^imagen/.test(model)){
    var url = await vertexModelUrl(model, 'predict', cfg.vertex.imageLocation);
    var req = { instances: [{ prompt: prompt }], parameters: { sampleCount: 1, aspectRatio: aspect, personGeneration: 'allow_adult', safetySetting: 'block_only_high' } };
    var res = await fetch(url, { method: 'POST', headers: await vertexHeaders(), body: JSON.stringify(req) });
    var body = await res.text();
    if (res.status !== 200) throw new Error('画像API ' + res.status + ': ' + body.slice(0, 300));
    var d = JSON.parse(body);
    var b64 = d.predictions && d.predictions[0] && d.predictions[0].bytesBase64Encoded;
    if (!b64) throw new Error('画像が返りませんでした' + (d.predictions && d.predictions[0] && d.predictions[0].raiFilteredReason ? '（' + d.predictions[0].raiFilteredReason + '）' : ''));
    return b64;
  }
  var parts = [];
  (refImages || []).forEach(function(r){ parts.push({ inlineData: { mimeType: r.mime || 'image/png', data: r.buffer.toString('base64') } }); });
  parts.push({ text: prompt });
  var greq = { contents: [{ role: 'user', parts: parts }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'], imageConfig: { aspectRatio: aspect } } };
  var gurl = await vertexModelUrl(model, 'generateContent');
  var last = '';
  for (var i = 0; i < 2; i++){
    var gres = await fetch(gurl, { method: 'POST', headers: await vertexHeaders(), body: JSON.stringify(greq) });
    var gbody = await gres.text();
    if (gres.status === 200){
      var gd = JSON.parse(gbody);
      var cand = gd.candidates && gd.candidates[0];
      var img = ((cand && cand.content && cand.content.parts) || []).filter(function(p){ return p.inlineData && /^image\//.test(p.inlineData.mimeType || ''); })[0];
      if (img) return img.inlineData.data;
      last = '画像が返りませんでした (finishReason=' + ((cand && cand.finishReason) || (gd.promptFeedback && gd.promptFeedback.blockReason) || '?') + ')';
    } else {
      last = '画像API ' + gres.status + ': ' + gbody.slice(0, 300);
      if (gres.status === 400 && /imageConfig|aspectRatio|responseModalities/i.test(gbody)){ delete greq.generationConfig.imageConfig; greq.generationConfig.responseModalities = ['IMAGE']; continue; }
      if (gres.status === 429 || gres.status >= 500){ await sleep(1500 * (i + 1)); continue; }
    }
    await sleep(600);
  }
  throw new Error(last);
}

/* ================= OpenAI 互換（GAS版と同じ挙動） ================= */
function openaiKey(){ var k = cfg.openai.apiKey; if (!k) throw new Error('OPENAI_API_KEY が環境変数に未設定です。'); return k; }
async function openaiChat(messages, opts){
  opts = opts || {};
  var key = openaiKey();
  var payload = { model: cfg.openai.model, messages: messages };
  if (opts.json) payload.response_format = { type: 'json_object' };
  if (opts.maxTokens) payload.max_completion_tokens = opts.maxTokens;
  if (opts.effort) payload.reasoning_effort = opts.effort;
  var last = '';
  for (var i = 0; i < 3; i++){
    var res = await fetch(cfg.openai.baseUrl + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(payload) });
    var body = await res.text();
    if (res.status === 200){
      var d = JSON.parse(body);
      var ch = d.choices && d.choices[0];
      var c = ch && ch.message && ch.message.content;
      if (c) return c;
      var fr = (ch && ch.finish_reason) || '?';
      last = 'contentが空 (finish_reason=' + fr + ', max_completion_tokens=' + (payload.max_completion_tokens || 'default') + ')';
      if (fr === 'length'){ payload.max_completion_tokens = Math.min((payload.max_completion_tokens || 2000) * 2, 16000); continue; }
    } else {
      last = 'API ' + res.status + ': ' + body.slice(0, 300);
      if (opts.json && res.status === 400 && /response_format/i.test(body)){ delete payload.response_format; continue; }
      if (res.status === 429 || res.status >= 500){ await sleep(1200 * (i + 1)); continue; }
    }
    await sleep(600);
  }
  throw new Error('OpenAI呼び出し失敗: ' + last);
}
async function openaiGrounded(prompt){
  var key = openaiKey();
  var payload = { model: cfg.openai.model, tools: [{ type: 'web_search' }], input: prompt };
  var last = '';
  for (var i = 0; i < 2; i++){
    var res = await fetch(cfg.openai.baseUrl + '/responses', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(payload) });
    var body = await res.text();
    if (res.status === 200){
      var d = JSON.parse(body);
      var text = '', cites = [];
      (d.output || []).forEach(function(item){
        (item.content || []).forEach(function(c){
          if (c.type === 'output_text'){
            text += (c.text || '');
            (c.annotations || []).forEach(function(a){ if (a && (a.type === 'url_citation' || a.url)) cites.push({ title: a.title || '', url: a.url || '' }); });
          }
        });
      });
      if (!text && d.output_text) text = d.output_text;
      if (text) return { text: text, cites: cites };
      last = '出力が空';
    } else {
      last = 'API ' + res.status + ': ' + body.slice(0, 300);
    }
    await sleep(800);
  }
  throw new Error('グラウンディング失敗: ' + last);
}
async function openaiImage(prompt, opts, refImages){
  opts = opts || {};
  var key = openaiKey();
  var size = opts.size || '1024x1024';
  var res = null;
  if (refImages && refImages.length){
    var form = new FormData();
    form.append('model', cfg.openai.imageModel); form.append('prompt', prompt); form.append('size', size); form.append('n', '1');
    refImages.forEach(function(r, i){ form.append('image[]', new Blob([r.buffer], { type: r.mime || 'image/png' }), 'ref' + i + '.png'); });
    res = await fetch(cfg.openai.baseUrl + '/images/edits', { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: form });
    if (res.status !== 200) res = null;
  }
  if (!res){
    res = await fetch(cfg.openai.baseUrl + '/images/generations', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: cfg.openai.imageModel, prompt: prompt, size: size, quality: 'medium', n: 1 }) });
  }
  var body = await res.text();
  if (res.status !== 200) throw new Error('画像API ' + res.status + ': ' + body.slice(0, 300));
  var d = JSON.parse(body);
  var b64 = d.data && d.data[0] && d.data[0].b64_json;
  if (!b64) throw new Error('画像が返りませんでした');
  return b64;
}

/* ================= 公開API ================= */
function isOpenAI(){ return cfg.provider === 'openai'; }
module.exports = {
  chat: function(messages, opts){ return isOpenAI() ? openaiChat(messages, opts) : vertexChat(messages, opts); },
  groundedSearch: function(prompt){ return isOpenAI() ? openaiGrounded(prompt) : vertexGrounded(prompt); },
  genImage: function(prompt, opts, refImages){ return isOpenAI() ? openaiImage(prompt, opts, refImages) : vertexImage(prompt, opts, refImages); },
  modelName: function(){ return cfg.modelName(); },
  searchToolName: function(){ return isOpenAI() ? 'web_search' : 'Google Search grounding'; },
  describe: function(){
    return isOpenAI() ? ('openai-compatible ' + cfg.openai.baseUrl + ' / ' + cfg.openai.model + ' / ' + cfg.openai.imageModel)
      : ('vertex-ai ' + cfg.vertex.location + ' / ' + cfg.vertex.model + ' / ' + cfg.vertex.imageModel);
  },
  _internal: { toGeminiRequest: toGeminiRequest, thinkingConfig: thinkingConfig, parseDataUri: parseDataUri }
};
