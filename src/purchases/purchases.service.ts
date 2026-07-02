// ファイル概要:
// このファイルは在庫 PoC の購入判定ロジック本体です。
// request validation、PostgreSQL transaction、在庫の conditional UPDATE、
// requestId による idempotency、購入履歴 INSERT、API response 作成をまとめて扱います。

// BadRequestException は入力値不正を 400 として返すために使います。
// Injectable は service を NestJS の DI 対象として登録する decorator です。
// InternalServerErrorException は DB seed 不整合など、API 内部前提の崩れを 500 として返すために使います。
// NotFoundException は event が存在しない場合を 404 として返すために使います。
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
// DatabaseService は PostgreSQL の PoolClient を借りるための共有 service です。
import { DatabaseService } from '../database/database.service';
// InventoryCacheService は Valkey による購入前段フィルタです（未設定時は fail-open）。
import { InventoryCacheService } from '../cache/inventory-cache.service';
// DomainEventsService は購入確定を EventBridge へ伝えるための publisher です。
import { DomainEventsService } from '../messaging/domain-events.service';
// purchase.types は controller と service の間で共有する入力・出力の型です。
import {
  ParsedPurchaseInput,
  PurchaseRequestBody,
  PurchaseResult,
} from './purchase.types';

// UUID_PATTERN は eventId / buyerId が UUID 文字列かどうかを見る正規表現です。
const UUID_PATTERN =
  // i flag により、UUID の英字部分は大文字小文字どちらも許可します。
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// PostgreSQL INTEGER は int4 なので、DB へ送る前に上限を service で検証します。
// これにより、pg の 22003 エラーではなく API の 400 として返せます。
const POSTGRES_INT4_MAX = 2_147_483_647;

// EventRow は event 存在確認 SELECT の結果型です。
interface EventRow {
  // id は events.id の UUID です。
  id: string;
}

// InventoryUpdateRow は conditional UPDATE が成功したときの RETURNING 結果型です。
interface InventoryUpdateRow {
  // remaining_quantity は UPDATE 後の残在庫です。
  remaining_quantity: number;
}

// ExistingConfirmedPurchaseRow は requestId 再送時に既存 confirmed row を読むための結果型です。
interface ExistingConfirmedPurchaseRow {
  // purchase_id は response の purchaseId に変換する purchases.id です。
  purchase_id: string;
  // event_id は response に戻す購入対象 event id です。
  event_id: string;
  // buyer_id は response に戻す購入者 id です。
  buyer_id: string;
  // quantity は元の confirmed 購入枚数です。
  quantity: number;
  // status は confirmed に固定されます。
  status: 'confirmed';
  // rejection_reason は confirmed では null です。
  rejection_reason: string | null;
  // remaining_quantity_after は元の confirmed 時点の残在庫 snapshot です。
  remaining_quantity_after: number | null;
}

// ExistingRejectedPurchaseRow は requestId 再送時に既存 rejected row を読むための結果型です。
interface ExistingRejectedPurchaseRow {
  // purchase_id は response の purchaseId に変換する purchases.id です。
  purchase_id: string;
  // event_id は response に戻す購入対象 event id です。
  event_id: string;
  // buyer_id は response に戻す購入者 id です。
  buyer_id: string;
  // quantity は元の rejected 購入枚数です。
  quantity: number;
  // status は rejected に固定されます。
  status: 'rejected';
  // rejection_reason は rejected の理由で、DB 制約上 null ではありません。
  rejection_reason: string;
  // remaining_quantity_after は rejected では在庫確保していないため null です。
  remaining_quantity_after: null;
}

// PurchaseRow は INSERT INTO purchases RETURNING id の結果型です。
interface PurchaseRow {
  // id は新しく作成された purchases row の UUID です。
  id: string;
}

// PurchasesService を NestJS の DI に登録します。
@Injectable()
// PurchasesService は購入リクエストの validation、transaction、在庫更新、購入履歴作成を担当します。
export class PurchasesService {
  // constructor injection で DB 接続管理・前段フィルタ・イベント発行の各 service を受け取ります。
  constructor(
    private readonly database: DatabaseService,
    private readonly inventoryCache: InventoryCacheService,
    private readonly domainEvents: DomainEventsService,
  ) {}

  // createPurchase は購入 API の本体です。
  // 流れは「入力検証 -> Valkey 前段フィルタ -> transaction 開始 -> 再送確認 -> 在庫 conditional UPDATE -> 購入履歴 INSERT」です。
  async createPurchase(
    // eventId は URL path parameter から渡された購入対象 event id です。
    eventId: string,
    // body は HTTP request body です。controller では検証せず service でまとめて検証します。
    body: unknown,
  ): Promise<PurchaseResult> {
    // 入力を検証し、以降の処理で信用できる ParsedPurchaseInput に変換します。
    const input = parsePurchaseInput(eventId, body);

    // Valkey 前段フィルタです（technical-validation-plan の初期アーキテクチャ仮説）。
    // カウンタ上で売り切れなら PostgreSQL に到達させず即時拒否します。
    // requestId 付きは idempotent replay の可能性があるため DB 判定へ流します。
    const gate = input.requestId
      ? ('unknown' as const)
      : await this.inventoryCache.reserve(input.eventId, input.quantity);

    if (gate === 'sold_out') {
      // 前段拒否は DB に履歴を残さない設計です（DB 保護がこのフィルタの目的のため）。
      return {
        purchaseId: null,
        eventId: input.eventId,
        buyerId: input.buyerId,
        quantity: input.quantity,
        status: 'rejected',
        rejectionReason: 'sold_out_precheck',
        remainingQuantity: null,
      };
    }

    try {
      const result = await this.executePurchaseTransaction(input, gate);

      // 確定購入は EventBridge へ伝搬し、Worker が検索プロジェクションを更新します。
      if (result.status === 'confirmed') {
        await this.domainEvents.publish('TicketPurchased', {
          eventId: result.eventId,
          purchaseId: result.purchaseId,
          quantity: result.quantity,
          remainingQuantity: result.remainingQuantity,
        });
        await this.domainEvents.publish('InventoryChanged', {
          eventId: result.eventId,
          remainingQuantity: result.remainingQuantity,
        });
      }

      return result;
    } catch (error) {
      // reserve 済みのまま DB 確定に失敗した場合は、カウンタを戻して次のリクエストに在庫を返します。
      if (gate === 'reserved') {
        await this.inventoryCache.release(input.eventId, input.quantity);
      }
      throw error;
    }
  }

  // executePurchaseTransaction は PostgreSQL transaction による購入確定の本体です。
  private async executePurchaseTransaction(
    input: ParsedPurchaseInput,
    // gate は前段フィルタの結果で、DB 判定後のカウンタ補正に使います。
    gate: 'reserved' | 'unknown',
  ): Promise<PurchaseResult> {
    // DB transaction を張るため、pool から専用 client を 1 つ借ります。
    const client = await this.database.connect();
    // rollbackError は ROLLBACK 自体が失敗したかを finally の release に伝えるための変数です。
    let rollbackError: Error | undefined;

    // ここから DB transaction 内で購入判定を進めます。
    try {
      // BEGIN により、以降の SELECT / UPDATE / INSERT を 1 つの transaction にまとめます。
      await client.query('BEGIN');

      // event row を FOR SHARE で lock し、存在確認と後続 INSERT の間に削除されないようにします。
      // この lock は在庫数を守る主役ではなく、参照整合性を transaction 内で安定させるためのものです。
      const event = await client.query<EventRow>(
        // event が存在するかを確認しつつ、同じ transaction 中の削除競合を避けます。
        'SELECT id FROM events WHERE id = $1 FOR SHARE',
        // $1 は入力検証済みの eventId です。
        [input.eventId],
      );

      // rowCount が 0 なら、指定された event は存在しません。
      if (!event.rowCount) {
        // event がない場合は購入対象がないので 404 を返します。
        throw new NotFoundException('event not found');
      }

      // requestId がある場合は、同じ購入リクエストがすでに confirmed 済みか確認します。
      const existingConfirmed = input.requestId
        // confirmed 済みなら在庫を二重に減らしてはいけないため、先に探します。
        ? await findExistingConfirmedPurchase(client, input)
        // requestId がなければ idempotency 対象外なので確認しません。
        : null;

      // idempotent replay の confirmed ケースです。
      // 同じ buyer/event/requestId がすでに confirmed なら、在庫更新を再実行せず元の結果を返します。
      if (existingConfirmed?.rowCount) {
        // 読み取りだけで結果が確定したので transaction を正常終了します。
        await client.query('COMMIT');

        // 既存 row を API response の形に変換して返します。
        return toPurchaseResult(existingConfirmed.rows[0]);
      }

      // ここが在庫 PoC の最重要 SQL です。
      // remaining_quantity >= quantity を満たすときだけ在庫を減らす conditional UPDATE です。
      const inventoryUpdate = await client.query<InventoryUpdateRow>(
        // PostgreSQL の UPDATE は row lock を取りながら条件評価するため、同時購入でも在庫が 0 未満になりません。
        `
          UPDATE ticket_inventory
          SET
            remaining_quantity = remaining_quantity - $2,
            version = version + 1,
            updated_at = now()
          WHERE event_id = $1
            AND remaining_quantity >= $2
          RETURNING remaining_quantity
        `,
        // $1 は eventId、$2 は購入枚数です。
        [input.eventId, input.quantity],
      );

      // UPDATE が 1 row 更新できた場合だけ、在庫確保に成功した confirmed とみなします。
      // 0 row の場合は、在庫不足または在庫 row 不在です。
      const confirmed = inventoryUpdate.rowCount === 1;
      // rejectedRemaining は在庫不足で拒否した時点の DB 残在庫です。
      // 前段カウンタと DB がずれていた場合の補正（syncCounter）に使います。
      let rejectedRemaining: number | null = null;

      // confirmed できなかった場合は、rejected として扱う前に原因を確認します。
      if (!confirmed) {
        // event は存在するのに在庫 row がない場合は、売り切れではなく DB seed / 設定不備です。
        // その区別のため、ticket_inventory を確認しつつ現在の残在庫も取得します。
        const inventory = await client.query<InventoryUpdateRow>(
          'SELECT remaining_quantity FROM ticket_inventory WHERE event_id = $1',
          // $1 は入力検証済みの eventId です。
          [input.eventId],
        );

        // 在庫 row があれば、補正用に現在の残在庫を控えます。
        if (inventory.rowCount) {
          rejectedRemaining = inventory.rows[0].remaining_quantity;
        }

        // 在庫 row がない場合は PoC の前提崩れです。
        if (!inventory.rowCount) {
          // ローカル検証で原因が追えるよう、eventId を structured log に含めます。
          console.error('ticket inventory not found for existing event', {
            // 対象 eventId をログに残します。
            eventId: input.eventId,
          });
          // クライアント入力の問題ではないため、500 として返します。
          throw new InternalServerErrorException(
            // 詳細すぎない message で、在庫設定不備を示します。
            'ticket inventory is not configured',
          );
        }

        // requestId がある rejected は、同じ rejected 結果を再利用できるか確認します。
        if (input.requestId) {
          // idempotent replay の rejected ケースです。
          // 同じ buyer/event/requestId の rejected を何度も INSERT しないようにします。
          const existingRejected = await findExistingRejectedPurchase(
            // 同じ transaction client で確認します。
            client,
            // buyer/event/requestId の scope は input にまとまっています。
            input,
          );

          // 既存 rejected row があれば、新しい rejected row は作りません。
          if (existingRejected.rowCount) {
            // 読み取りだけで結果が確定したので transaction を正常終了します。
            await client.query('COMMIT');

            // 既存 rejected row を API response の形に変換して返します。
            return toPurchaseResult(existingRejected.rows[0]);
          }
        }
      }

      // rejectionReason は confirmed なら null、rejected なら理由文字列を入れます。
      const rejectionReason = confirmed ? null : 'insufficient_inventory';
      // confirmed の場合は、UPDATE が返した「更新直後の残在庫」を response snapshot として保存します。
      // これがないと requestId 再送時に、後から変わった現在在庫を返してしまいます。
      const remainingQuantityAfter = confirmed
        // confirmed なら UPDATE RETURNING remaining_quantity の値を使います。
        ? inventoryUpdate.rows[0].remaining_quantity
        // rejected は在庫を確保していないので、残在庫 snapshot は null です。
        : null;

      // confirmed / rejected のどちらでも、API が下した判定を purchases table に記録します。
      const purchase = await client.query<PurchaseRow>(
        // INSERT 後に response 用の purchase id が必要なので RETURNING id を指定します。
        `
          INSERT INTO purchases (
            event_id,
            buyer_id,
            request_id,
            quantity,
            status,
            rejection_reason,
            remaining_quantity_after
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id
        `,
        [
          // event_id は購入対象 event です。
          input.eventId,
          // buyer_id は購入者です。
          input.buyerId,
          // request_id は idempotency key です。未指定なら null 相当になります。
          input.requestId,
          // quantity は購入希望枚数です。
          input.quantity,
          // status は conditional UPDATE の成否から決まります。
          confirmed ? 'confirmed' : 'rejected',
          // rejection_reason は status と DB CHECK 制約で整合します。
          rejectionReason,
          // remaining_quantity_after は confirmed replay 用の snapshot です。
          remainingQuantityAfter,
        ],
      );

      // 在庫更新と購入履歴 INSERT が両方成功したので transaction を確定します。
      await client.query('COMMIT');

      // COMMIT 後に前段カウンタを DB の残在庫と揃えます（Valkey は正本ではないため上書きでよい）。
      if (confirmed && gate === 'unknown' && remainingQuantityAfter !== null) {
        // 前段を通らず confirmed した場合、カウンタを DB 基準へ同期します。
        await this.inventoryCache.syncCounter(
          input.eventId,
          remainingQuantityAfter,
        );
      } else if (!confirmed && gate === 'reserved') {
        // 前段は在庫ありと判定したが DB は在庫不足だった場合、カウンタを DB 残在庫へ補正します。
        await this.inventoryCache.syncCounter(
          input.eventId,
          rejectedRemaining ?? 0,
        );
      }

      // 新規に作った purchase row を API response として返します。
      return {
        // purchaseId は INSERT RETURNING id の値です。
        purchaseId: purchase.rows[0].id,
        // eventId は request 対象をそのまま返します。
        eventId: input.eventId,
        // buyerId は request body の購入者をそのまま返します。
        buyerId: input.buyerId,
        // quantity は request body の購入枚数をそのまま返します。
        quantity: input.quantity,
        // status は在庫確保できたかどうかで決まります。
        status: confirmed ? 'confirmed' : 'rejected',
        // rejectionReason は rejected の理由、または confirmed の null です。
        rejectionReason,
        // remainingQuantity は confirmed 後の snapshot、または rejected の null です。
        remainingQuantity: remainingQuantityAfter,
      };
    // try block 内の DB 操作や validation 後処理で失敗した場合はここへ来ます。
    } catch (error) {
      // transaction が途中まで進んでいる可能性があるため、まず ROLLBACK を試みます。
      try {
        // ROLLBACK により、未確定の在庫更新や購入履歴 INSERT を取り消します。
        await client.query('ROLLBACK');
      // ROLLBACK 自体が失敗した場合は、接続が壊れている可能性があります。
      } catch (err) {
        // release に渡せる Error 形へ正規化します。
        rollbackError =
          err instanceof Error ? err : new Error('ROLLBACK failed');
        // rollback 失敗は重要なのでログに残します。
        console.error('ROLLBACK failed:', rollbackError);
        // 壊れた接続で rollback 失敗した場合でも、元の購入エラーを優先して後続で throw します。
      }

      // rollback が成功し、requestId がある場合だけ、unique constraint 競合の救済を試します。
      if (!rollbackError && input.requestId) {
        // race handling:
        // 同じ requestId の 2 リクエストが同時に来ると、両方が early replay check をすり抜けることがあります。
        // その場合、unique index に負けた側は既存 row を再読込して idempotent response に変換します。
        if (isConfirmedRequestIdConflict(error)) {
          // confirmed unique constraint に負けた場合、すでに作られた confirmed row を探します。
          const existingConfirmed = await findExistingConfirmedPurchase(
            // rollback 後の同じ client で再読込します。
            client,
            // buyer/event/requestId は input から使います。
            input,
          );

          // 既存 confirmed row が読めたら、それを成功応答として返します。
          if (existingConfirmed.rowCount) {
            // 在庫を再更新せず、既存 row の内容だけを返します。
            return toPurchaseResult(existingConfirmed.rows[0]);
          }
        }

        // rejected unique constraint に負けた場合も同じ考え方で救済します。
        if (isRejectedRequestIdConflict(error)) {
          // すでに作られた rejected row を探します。
          const existingRejected = await findExistingRejectedPurchase(
            // rollback 後の同じ client で再読込します。
            client,
            // buyer/event/requestId は input から使います。
            input,
          );

          // 既存 rejected row が読めたら、それを rejected 応答として返します。
          if (existingRejected.rowCount) {
            // 新しい rejected row を作らず、既存 row の内容だけを返します。
            return toPurchaseResult(existingRejected.rows[0]);
          }
        }
      }

      // 既知の requestId 競合として救済できなかった error は、そのまま上位へ投げます。
      throw error;
    // DB client は成功・失敗に関係なく必ず pool へ返します。
    } finally {
      // rollbackError がある場合は壊れた接続として pool に伝えます。
      client.release(rollbackError);
    }
  }
}

// findExistingConfirmedPurchase は requestId の confirmed 再送結果を探す helper です。
function findExistingConfirmedPurchase(
  // client は transaction 中の PoolClient でも、rollback 後の client でも使える query interface です。
  client: { query: typeof import('pg').Client.prototype.query },
  // input には buyerId / eventId / requestId の検索 scope が入っています。
  input: ParsedPurchaseInput,
) {
  // purchases_request_id_uq と同じ buyer + event + requestId の scope で confirmed row を探します。
  return client.query<ExistingConfirmedPurchaseRow>(
    // response に必要な値を purchases table から取得します。
    `
      SELECT
        id AS purchase_id,
        event_id,
        buyer_id,
        quantity,
        status,
        rejection_reason,
        remaining_quantity_after
      FROM purchases
      WHERE buyer_id = $1
        AND event_id = $2
        AND request_id = $3
        AND status = 'confirmed'
      LIMIT 1
    `,
    // $1=buyerId、$2=eventId、$3=requestId です。
    [input.buyerId, input.eventId, input.requestId],
  );
}

// findExistingRejectedPurchase は requestId の rejected 再送結果を探す helper です。
function findExistingRejectedPurchase(
  // client は transaction 中の PoolClient でも、rollback 後の client でも使える query interface です。
  client: { query: typeof import('pg').Client.prototype.query },
  // input には buyerId / eventId / requestId の検索 scope が入っています。
  input: ParsedPurchaseInput,
) {
  // 同じ rejected 再送で purchases row が無限に増えないよう、既存 rejected row を探します。
  return client.query<ExistingRejectedPurchaseRow>(
    // response に必要な値を purchases table から取得します。
    `
      SELECT
        id AS purchase_id,
        event_id,
        buyer_id,
        quantity,
        status,
        rejection_reason,
        remaining_quantity_after
      FROM purchases
      WHERE buyer_id = $1
        AND event_id = $2
        AND request_id = $3
        AND status = 'rejected'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    // $1=buyerId、$2=eventId、$3=requestId です。
    [input.buyerId, input.eventId, input.requestId],
  );
}

// toPurchaseResult は DB row を API response の PurchaseResult に変換します。
function toPurchaseResult(
  // purchase は confirmed row または rejected row のどちらかです。
  purchase: ExistingConfirmedPurchaseRow | ExistingRejectedPurchaseRow,
): PurchaseResult {
  // DB の snake_case column を API の camelCase field に詰め替えます。
  return {
    // purchase_id は response では purchaseId として返します。
    purchaseId: purchase.purchase_id,
    // event_id は response では eventId として返します。
    eventId: purchase.event_id,
    // buyer_id は response では buyerId として返します。
    buyerId: purchase.buyer_id,
    // quantity は DB と API で同じ意味です。
    quantity: purchase.quantity,
    // status は confirmed / rejected をそのまま返します。
    status: purchase.status,
    // rejection_reason は response では rejectionReason として返します。
    rejectionReason: purchase.rejection_reason,
    // remaining_quantity_after は response では remainingQuantity として返します。
    remainingQuantity: purchase.remaining_quantity_after,
  };
}

// isConfirmedRequestIdConflict は confirmed 用 unique constraint の衝突かを判定します。
function isConfirmedRequestIdConflict(error: unknown): boolean {
  // constraint 名で判定し、他の unique violation と混同しないようにします。
  return isConstraintViolation(error, 'purchases_request_id_uq');
}

// isRejectedRequestIdConflict は rejected 用 unique constraint の衝突かを判定します。
function isRejectedRequestIdConflict(error: unknown): boolean {
  // constraint 名で判定し、他の unique violation と混同しないようにします。
  return isConstraintViolation(error, 'purchases_rejected_request_id_uq');
}

// isConstraintViolation は PostgreSQL error が指定 constraint の unique violation かを判定します。
function isConstraintViolation(error: unknown, constraint: string): boolean {
  // unknown のまま property に触らず、object かつ null でないことから確認します。
  return (
    // pg error は object として渡ってきます。
    typeof error === 'object' &&
    // null は object 扱いされるため除外します。
    error !== null &&
    // PostgreSQL error code を持っているか確認します。
    'code' in error &&
    // 23505 は PostgreSQL の unique_violation です。
    error.code === '23505' &&
    // constraint 名まで確認します。
    'constraint' in error &&
    // 呼び出し元が指定した constraint と一致する場合だけ true にします。
    error.constraint === constraint
  );
}

// parsePurchaseInput は外部入力を検証し、内部で信用できる形に変換します。
function parsePurchaseInput(
  // eventId は URL path parameter 由来の外部入力です。
  eventId: string,
  // body は HTTP request body 由来の外部入力です。
  body: unknown,
): ParsedPurchaseInput {
  // この PoC では validation を購入 workflow の近くに置いて、処理全体を 1 ファイルで追えるようにしています。
  // 本番 API では DTO や validation pipe へ分離する選択肢があります。
  // eventId は DB query に使う前に UUID 形式かを確認します。
  if (!UUID_PATTERN.test(eventId)) {
    // URL の eventId が UUID でなければ 400 として返します。
    throw new BadRequestException('eventId must be a UUID');
  }

  // body は null ではなく、配列でもなく、通常の object である必要があります。
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    // JSON object 以外は購入 request として扱えないため 400 を返します。
    throw new BadRequestException('request body must be an object');
  }

  // ここまでで body は object なので、PurchaseRequestBody として field を検証します。
  const requestBody = body as PurchaseRequestBody;

  // buyerId は必須で、UUID 文字列である必要があります。
  if (
    // buyerId が string でなければ UUID として扱えません。
    typeof requestBody.buyerId !== 'string' ||
    // string でも UUID 形式でなければ拒否します。
    !UUID_PATTERN.test(requestBody.buyerId)
  ) {
    // buyerId 不正はクライアント入力の問題なので 400 を返します。
    throw new BadRequestException('buyerId must be a UUID');
  }

  // quantity は必須で、PostgreSQL INTEGER に収まる正の整数である必要があります。
  if (
    // quantity が number でなければ拒否します。
    typeof requestBody.quantity !== 'number' ||
    // 小数は購入枚数として扱わないため拒否します。
    !Number.isInteger(requestBody.quantity) ||
    // 0 枚以下の購入は意味がないため拒否します。
    requestBody.quantity <= 0 ||
    // PostgreSQL INTEGER の上限を超える値は DB に渡す前に拒否します。
    requestBody.quantity > POSTGRES_INT4_MAX
  ) {
    // quantity 不正はクライアント入力の問題なので 400 を返します。
    throw new BadRequestException(
      // message には許可される上限も含めます。
      'quantity must be a positive integer up to 2147483647',
    );
  }

  // requestId は任意ですが、指定するなら空でない string である必要があります。
  if (
    // undefined は requestId 未指定として許可します。
    requestBody.requestId !== undefined &&
    // 指定されているのに string でない場合は拒否します。
    (typeof requestBody.requestId !== 'string' ||
      // 空文字は idempotency key として機能しないため拒否します。
      requestBody.requestId.length === 0)
  ) {
    // requestId 不正はクライアント入力の問題なので 400 を返します。
    throw new BadRequestException('requestId must be a non-empty string');
  }

  // ここまでの検証を通過した値だけを ParsedPurchaseInput として返します。
  return {
    // eventId は UUID 検証済みです。
    eventId,
    // buyerId は UUID 検証済みです。
    buyerId: requestBody.buyerId,
    // quantity は正の整数かつ PostgreSQL INTEGER 範囲内です。
    quantity: requestBody.quantity,
    // requestId は undefined または空でない string です。
    requestId: requestBody.requestId,
  };
}
