'use strict';
/* 環境変数（GAS版のスクリプトプロパティに相当） */
function env(k, d){ var v = process.env[k]; return (v !== undefined && String(v).trim() !== '') ? String(v).trim() : d; }

var cfg = {
  port: Number(env('PORT', '8080')),
  basicAuth: env('APP_BASIC_AUTH', ''),          // "user:pass"（任意）
  sessionSecret: env('APP_SESSION_SECRET', ''),  // ログインCookieの署名鍵（任意。未設定なら資格情報から導出）

  storage: env('STORAGE', env('GCS_BUCKET', '') ? 'gcs' : 'local'),
  gcsBucket: env('GCS_BUCKET', ''),
  gcsPrefix: env('GCS_PREFIX', 'genzo/').replace(/^\/+/, ''),
  dataDir: env('DATA_DIR', './data'),

  provider: env('LLM_PROVIDER', 'vertex'),       // vertex | openai

  vertex: {
    project: env('VERTEX_PROJECT', env('GOOGLE_CLOUD_PROJECT', '')),
    location: env('VERTEX_LOCATION', 'global'),
    model: env('VERTEX_MODEL', 'gemini-2.5-pro'),
    imageModel: env('VERTEX_IMAGE_MODEL', 'gemini-2.5-flash-image'),
    imageLocation: env('VERTEX_IMAGE_LOCATION', 'us-central1')
  },

  openai: {
    apiKey: env('OPENAI_API_KEY', ''),
    baseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: env('OPENAI_MODEL', 'gpt-5.5'),
    imageModel: env('OPENAI_IMAGE_MODEL', 'gpt-image-2')
  }
};

/* 表示用のモデル名（監査記録の method 欄などに残る） */
cfg.modelName = function(){ return cfg.provider === 'openai' ? cfg.openai.model : cfg.vertex.model; };

module.exports = cfg;
