// ファイル概要:
// このファイルは ALB target group のヘルスチェック用エンドポイントです（ADR-0011）。
// SSR ページは API 障害に巻き込まれ得るため、ヘルスチェックは API や外部依存に
// 一切触れない liveness 専用ルートとして分離します（backend の /healthz と同じ役割分担）。

export function GET(): Response {
  return Response.json({ status: "ok" });
}
