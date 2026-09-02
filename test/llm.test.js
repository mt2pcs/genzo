'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('../server/llm');

test('OpenAI 形式 messages → Gemini request 変換', () => {
  const req = _internal.toGeminiRequest([
    { role: 'system', content: 'SYS' },
    { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'file', file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,BBBB' } }] },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'fix' }
  ]);
  assert.equal(req.systemInstruction.parts[0].text, 'SYS');
  assert.equal(req.contents.length, 3);
  assert.equal(req.contents[0].role, 'user');
  assert.deepEqual(req.contents[0].parts[0], { text: 'hello' });
  assert.deepEqual(req.contents[0].parts[1], { inlineData: { mimeType: 'image/png', data: 'AAAA' } });
  assert.deepEqual(req.contents[0].parts[2], { inlineData: { mimeType: 'application/pdf', data: 'BBBB' } });
  assert.equal(req.contents[1].role, 'model');
  assert.equal(req.contents[2].parts[0].text, 'fix');
});

test('thinkingConfig: effort の写像', () => {
  assert.deepEqual(_internal.thinkingConfig('gemini-2.5-pro', 'high'), { thinkingBudget: 24576 });
  assert.deepEqual(_internal.thinkingConfig('gemini-2.5-flash', 'low'), { thinkingBudget: 1024 });
  assert.deepEqual(_internal.thinkingConfig('gemini-3-pro-preview', 'medium'), { thinkingLevel: 'high' });
  assert.equal(_internal.thinkingConfig('gemini-2.5-pro', undefined), null);
});

test('parseDataUri', () => {
  assert.deepEqual(_internal.parseDataUri('data:image/jpeg;base64,/9j/'), { mime: 'image/jpeg', data: '/9j/' });
  assert.equal(_internal.parseDataUri('https://x'), null);
});
