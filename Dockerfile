# API / Worker 共用イメージ（ADR-0006）。
# ECS タスク定義の command 差し替えで使い分ける:
#   API:    node dist/src/main.js（既定）
#   Worker: node dist/src/worker.js

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# schema-on-boot（RUN_SCHEMA_ON_BOOT=true）用にスキーマを同梱する
COPY database ./database
EXPOSE 3000
USER node
CMD ["node", "dist/src/main.js"]
