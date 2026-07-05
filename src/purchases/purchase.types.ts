// ファイル概要:
// このファイルは購入 API で使う TypeScript の型定義をまとめた場所です。
// HTTP request body、validation 後の内部入力、API response の形を分けて定義し、
// controller / service / PoC script が購入データの意味を揃えられるようにします。

// PurchaseStatus は購入 API が返す判定結果です。
// confirmed は在庫を確保できた状態、rejected は在庫不足などで確保できなかった状態です。
export type PurchaseStatus = 'confirmed' | 'rejected';

// PurchaseRequestBody は HTTP request body の生の形です。
// 外部入力は信用しないため、各 field は validation 前の unknown として受けます。
// buyerId は認証統合（ADR-0010、Issue #135）でクライアント申告を廃止しました。
// JWT の sub claim（users.id）を購入者として使うため、body には含めません。
export interface PurchaseRequestBody {
  // buyerId は受け付けなくなった旧 field です。移行漏れのクライアントが
  // 黙って無視されて混乱しないよう、指定された場合は validation で 400 にします。
  buyerId?: unknown;
  // quantity は購入枚数の候補値ですが、ここではまだ正の整数かどうか分かりません。
  quantity?: unknown;
  // requestId は idempotency key の候補値ですが、ここではまだ文字列かどうか分かりません。
  requestId?: unknown;
}

// ParsedPurchaseInput は PurchasesService の validation を通過した後の内部入力です。
// 以降の処理は、この型の値なら UUID / 数量 / requestId の形式が正しい前提で進められます。
export interface ParsedPurchaseInput {
  // eventId は URL path から来た、購入対象イベントの UUID です。
  eventId: string;
  // buyerId は JwtAuthGuard 検証済みトークンの sub claim（users.id）です。
  // クライアント申告値ではないため、購入者のなりすましはトークンなしには成立しません。
  buyerId: string;
  // quantity は購入したい枚数で、PostgreSQL INTEGER に収まる正の整数です。
  quantity: number;
  // requestId は同じリクエストの再送を見分けるための任意の idempotency key です。
  requestId?: string;
}

// PurchaseResult は controller からクライアントへ返す購入結果です。
// confirmed / rejected を同じ形にしておくと、PoC script 側で集計しやすくなります。
export interface PurchaseResult {
  // purchaseId は purchases table に記録された購入履歴 row の UUID です。
  // Valkey 前段フィルタで即時拒否した場合は DB に記録しないため null になります。
  purchaseId: string | null;
  // eventId はどのイベントへの購入判定だったかを response に戻すための値です。
  eventId: string;
  // buyerId はどの購入者からの購入判定だったかを response に戻すための値です。
  buyerId: string;
  // quantity はこの購入判定で要求された枚数です。
  quantity: number;
  // status は在庫確保に成功したか、拒否されたかを表します。
  status: PurchaseStatus;
  // rejectionReason は rejected の理由です。confirmed の場合は null です。
  rejectionReason: string | null;
  // remainingQuantity は confirmed 後の残在庫 snapshot です。rejected の場合は null です。
  remainingQuantity: number | null;
}
