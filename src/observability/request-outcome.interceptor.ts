// ファイル概要:
// このファイルは HTTP エンドポイントの「SLI（Service Level Indicator）」を計測する
// 汎用 NestJS Interceptor です（ADR-0016 / Issue #225）。
// 現時点では購入 API（`POST /events/:eventId/purchases`）にのみ適用していますが、
// メトリクス名をコンストラクタ引数として受け取るため、将来他のエンドポイントにも
// そのまま再利用できます。
//
// 計測範囲: NestJS のリクエストライフサイクルは Guard → Interceptor → Handler の順で実行されます。
// そのため、Guard（例: 購入 API の JwtAuthGuard、401 認証失敗）で例外を投げた場合、
// この Interceptor には到達しません。一方、レート制限（429、購入 API では
// `PurchasesController` の handler 内で直接呼び出し）や、入力検証・404・409 などの
// service 由来の例外は handler 実行の一部として投げられるため、この Interceptor が
// 正しく捕捉します。401 が計測対象外になる点は ADR-0016 に明記しています
// （Issue #225 が元々「認証・検索は将来拡張」としてスコープ外にしていた範囲と一致するため、
// 業務判断ではなく NestJS の実行順序による技術的な帰結です）。

import {
  CallHandler,
  ExecutionContext,
  HttpException,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { emitMetric } from './emf';

// RequestOutcome は「技術的な」成功・失敗の分類です。
// PurchaseConfirmed / PurchaseRejected（ADR-0014）が表す「業務判定の結果」（confirmed / sold_out 等）
// とは別軸で、HTTP 応答レベルで「システムとして正しく応答できたか」を表します。
export type RequestOutcome =
  // success: 2xx 応答（購入 API では confirmed / rejected どちらの業務結果も 200 で返るため、
  // 業務上の拒否は success に含まれる。ADR-0016 参照）
  | 'success'
  // rate_limited: 429（レート制限超過）。既存の `<Endpoint>RateLimited` メトリクス
  // （`rate-limit.service.ts`、Issue #204）と役割が重なるが、本メトリクスは
  // 「成功率 SLI の分母」を完結させるための分類であり、ガードレールとしての
  // 詳細集計は既存メトリクス側に委ねる（意図的に分離。ADR-0016 参照）。
  | 'rate_limited'
  // invalid_request: 400 / 401 / 404 / 409 等、クライアント起因として扱う応答。
  // SLI の成功率計算からは分母ごと除外する（システム障害ではないため）。
  | 'invalid_request'
  // technical_failure: 上記以外の例外（5xx、タイムアウト、未分類の例外）。
  // 成功率 SLI の分母・分子双方に影響する「システム障害」として扱う。
  | 'technical_failure';

// INVALID_REQUEST_STATUSES はクライアント起因として SLI 分母から除外する HTTP status です。
// 401 は Guard で完結し本 Interceptor には到達しないため実際には出現しませんが、
// 万一 handler 内から明示的に投げられた場合に備えて分類だけは用意しておきます。
const INVALID_REQUEST_STATUSES = new Set([400, 401, 404, 409]);

// RATE_LIMITED_STATUS は 429 Too Many Requests です。
const RATE_LIMITED_STATUS = 429;

// classifyError は投げられた例外を RequestOutcome へ分類します。
// HttpException 以外（未処理の例外、DB ドライバのエラー等）は technical_failure として扱います。
function classifyError(error: unknown): RequestOutcome {
  if (error instanceof HttpException) {
    const status = error.getStatus();
    if (status === RATE_LIMITED_STATUS) {
      return 'rate_limited';
    }
    if (INVALID_REQUEST_STATUSES.has(status)) {
      return 'invalid_request';
    }
  }
  return 'technical_failure';
}

// RequestOutcomeInterceptor は 1 リクエストにつき次の 2 メトリクスを出します。
// - `<latencyMetricName>`（Milliseconds）: Guard 通過後から応答までの所要時間（SLI: レイテンシ）
// - `<outcomeMetricName>`（Count、dimension: Outcome）: 技術的な成功・失敗の分類（SLI: 成功率の算出元）
// 両方とも dimension は `Outcome` のみ（4 値の有限集合）で、eventId / buyerId / requestId のような
// 高カーディナリティな値は絶対に含めません（CloudWatch メトリクスのコスト・系列数爆発を防ぐため）。
export class RequestOutcomeInterceptor implements NestInterceptor {
  constructor(
    private readonly latencyMetricName: string,
    private readonly outcomeMetricName: string,
  ) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Date.now() ではなく performance.now() を使う。単調増加クロックのため、
    // システム時刻の補正（NTP 同期等）による負の経過時間・異常値を避けられる。
    const startedAt = performance.now();

    return next.handle().pipe(
      tap(() => {
        this.record('success', startedAt);
      }),
      catchError((error: unknown) => {
        this.record(classifyError(error), startedAt);
        // メトリクス出力は副作用のみなので、例外は必ず元のまま再送出し、
        // NestJS の例外フィルタ・クライアントへの応答を変えない。
        return throwError(() => error);
      }),
    );
  }

  private record(outcome: RequestOutcome, startedAt: number): void {
    const elapsedMs = performance.now() - startedAt;
    emitMetric(this.latencyMetricName, elapsedMs, 'Milliseconds', {
      Outcome: outcome,
    });
    emitMetric(this.outcomeMetricName, 1, 'Count', { Outcome: outcome });
  }
}
