# GENZO — Cloud Run 用イメージ
FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# 依存だけ先に入れてレイヤキャッシュを効かせる（sharp はプリビルドバイナリを取得する）
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY public ./public

# Cloud Run は $PORT を注入する（既定 8080）
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server/index.js"]
