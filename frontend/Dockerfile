# フロントエンド（Next.js SSR）イメージ（ADR-0011）。
# standalone output を使い、node_modules 全体ではなく必要最小の依存だけを実行イメージへ持ち込む。
# backend の Dockerfile と同じく multi-stage / non-root で構成する。

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json next.config.ts postcss.config.mjs ./
COPY public ./public
COPY app ./app
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# standalone サーバー本体（server.js + 最小 node_modules）
COPY --from=build /app/.next/standalone ./
# クライアント静的アセット（/_next/static。CloudFront で長期キャッシュする対象）
COPY --from=build /app/.next/static ./.next/static
# public 配下（favicon 等）
COPY --from=build /app/public ./public
EXPOSE 3000
USER node
CMD ["node", "server.js"]
