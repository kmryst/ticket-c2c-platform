// ファイル概要:
// このファイルは Next.js の設定です（ADR-0011）。
// - output "standalone": ECS 配備用に依存込みの最小サーバー（.next/standalone）を生成します。
// - rewrites: ローカル開発・E2E 用に /api/* をバックエンド API へ転送します。
//   AWS 実環境では CloudFront が /api/* を ALB（API target group）へ振り分けるため、
//   このリライトには到達しません（API_PROXY_TARGET 未設定なら無効）。
//   転送先パスから /api を外すのは、ALB/CloudFront 経路で API 側の rewriteUrl が
//   /api プレフィックスを除去するのと同じ写像に揃えるためです。

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() {
    const target = process.env.API_PROXY_TARGET;
    if (!target) {
      return [];
    }
    return [
      {
        source: "/api/:path*",
        destination: `${target}/:path*`,
      },
    ];
  },
};

export default nextConfig;
