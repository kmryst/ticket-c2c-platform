// ファイル概要:
// このファイルは InventoryChanged ドメインイベントの型付き contract と runtime parser です
// （Issue #377）。
//
// 設計の要点（ADR-0031）:
// - producer 側は compile-time 型（VersionedInventoryChangedPayload）を持ち、
//   consumer 側は runtime validation（parseInventoryChangedDetail）を持つ。
// - 既存 Worker との additive 互換のため、versioned payload も legacy field
//   （eventId / remainingQuantity）をそのまま保持する。旧 Worker は既存 field を処理し、
//   追加 field を無視できる。
// - Ticket Type 単位 version（inventoryVersion）と Event 互換集計 version
//   （eventInventoryVersion）は独立に比較する。別 Type の event 順序逆転で Event 合計が
//   巻き戻る事故を防ぐため、Type version だけで Event 集計を guard しない。
// - 一部だけ新 field を持つ壊れた payload を legacy として扱わない。versioned marker が
//   1 つでもあれば完全な versioned payload として厳格に検証し、欠損・不正なら throw する
//   （SQS message を削除させず retry / DLQ へ進める）。
// - trace context（_traceContext）は業務 contract と分離し、parser は無視する。

import { TRACE_CONTEXT_FIELD } from '../observability/trace-context';
// UUID 形式判定と int4 上限は共有 primitive を使う（review 9: validation drift 防止）。
import {
  isUuidString,
  POSTGRES_INT4_MAX,
} from '../common/validation-primitives';
// Ticket Type version と Event 集計 version は branded type で取り違えを compile error にする
// （review 6）。runtime validation boundary（この parser）で branded 値へ変換する。
import {
  EventInventoryVersion,
  TicketTypeInventoryVersion,
  toEventInventoryVersion,
  toTicketTypeInventoryVersion,
} from './inventory-version';

// SUPPORTED_INVENTORY_EVENT_VERSION は現在サポートする contract version です。
// producer はこの値を発行し、consumer はこの値だけを受理します。将来の互換破壊は
// 新しい version 番号と、consumer 側の明示的な分岐で扱います。
export const SUPPORTED_INVENTORY_EVENT_VERSION = 1;

// VersionedInventoryChangedPayload は producer が発行する version 付き payload の型です。
// eventId / remainingQuantity は legacy 互換 field（旧 Worker が読む Event 集計残数）です。
export interface VersionedInventoryChangedPayload {
  // --- legacy 互換 field（旧 Worker が処理する。additive 互換の中核） ---
  eventId: string;
  // remainingQuantity は Event 互換集計の残数です。eventRemainingQuantity と同値ですが、
  // 旧 Worker が参照する field 名を維持します。
  remainingQuantity: number;

  // --- versioned discriminant ---
  // inventoryEventVersion は contract version を表す明示的な discriminant です。
  inventoryEventVersion: number;

  // --- Ticket Type 単位の state ---
  ticketTypeId: string;
  ticketTypeName: string;
  ticketTypeTotalQuantity: number;
  ticketTypeRemainingQuantity: number;
  // inventoryVersion は対象 Ticket Type 単位の単調増加 version（#376 採番）です。
  // branded type で Event version との取り違えを compile error にします（review 6）。
  inventoryVersion: TicketTypeInventoryVersion;

  // --- Event 互換集計 ---
  eventTotalQuantity: number;
  eventRemainingQuantity: number;
  // eventInventoryVersion は Event 互換集計単位の version です。Type version とは独立に比較します。
  eventInventoryVersion: EventInventoryVersion;
}

// ParsedInventoryChanged は runtime parser の戻り値です。
// versioned / legacy を discriminated union で表し、consumer が安全に分岐できます。
export type ParsedInventoryChanged =
  | ({ kind: 'versioned' } & VersionedInventoryChangedPayload)
  | { kind: 'legacy'; eventId: string; remainingQuantity: number };

// InventoryEventContractError は壊れた versioned payload を検出したときに投げるエラーです。
// これを Worker で握り潰さず throw させることで、SQS message を削除せず retry / DLQ へ進めます。
export class InventoryEventContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InventoryEventContractError';
  }
}

// versioned marker field は「versioned payload を意図した」と判定する field 群です。
// これらが 1 つでも存在すれば、完全な versioned payload として厳格検証します。
// 一部欠損は legacy へフォールバックせず contract error にします。
const VERSIONED_MARKER_FIELDS = [
  'inventoryEventVersion',
  'ticketTypeId',
  'ticketTypeName',
  'ticketTypeTotalQuantity',
  'ticketTypeRemainingQuantity',
  'inventoryVersion',
  'eventTotalQuantity',
  'eventRemainingQuantity',
  'eventInventoryVersion',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// finite かつ safe integer で 0 以上、int4 上限以内であることを検証します。
function isNonNegativeInt(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= POSTGRES_INT4_MAX
  );
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// parseInventoryChangedDetail は EventBridge detail を安全な ParsedInventoryChanged に変換します。
// 壊れた versioned payload では InventoryEventContractError を throw します。
export function parseInventoryChangedDetail(
  detail: unknown,
): ParsedInventoryChanged {
  if (!isRecord(detail)) {
    throw new InventoryEventContractError(
      'InventoryChanged detail is not an object',
    );
  }

  if (!isUuidString(detail.eventId)) {
    throw new InventoryEventContractError(
      'InventoryChanged detail has missing or invalid eventId',
    );
  }
  const eventId = detail.eventId;

  // versioned marker が 1 つでもあれば versioned として厳格検証する。
  // trace context は業務 contract と分離しているため marker 判定に含めない。
  const hasVersionedMarker = VERSIONED_MARKER_FIELDS.some(
    (field) => detail[field] !== undefined,
  );

  if (!hasVersionedMarker) {
    // legacy payload: eventId + remainingQuantity のみ。
    if (!isNonNegativeInt(detail.remainingQuantity)) {
      throw new InventoryEventContractError(
        'legacy InventoryChanged detail has missing or invalid remainingQuantity',
      );
    }
    return {
      kind: 'legacy',
      eventId,
      remainingQuantity: detail.remainingQuantity,
    };
  }

  // ここから versioned payload の厳格検証。欠損・不正は legacy へ落とさず throw する。
  if (detail.inventoryEventVersion !== SUPPORTED_INVENTORY_EVENT_VERSION) {
    throw new InventoryEventContractError(
      `unsupported inventoryEventVersion: ${String(detail.inventoryEventVersion)}`,
    );
  }
  if (!isUuidString(detail.ticketTypeId)) {
    throw new InventoryEventContractError(
      'versioned InventoryChanged has missing or invalid ticketTypeId',
    );
  }
  if (!isNonBlankString(detail.ticketTypeName)) {
    throw new InventoryEventContractError(
      'versioned InventoryChanged has missing or invalid ticketTypeName',
    );
  }
  if (!isNonNegativeInt(detail.ticketTypeTotalQuantity)) {
    throw new InventoryEventContractError(
      'versioned InventoryChanged has invalid ticketTypeTotalQuantity',
    );
  }
  if (!isNonNegativeInt(detail.ticketTypeRemainingQuantity)) {
    throw new InventoryEventContractError(
      'versioned InventoryChanged has invalid ticketTypeRemainingQuantity',
    );
  }
  if (detail.ticketTypeRemainingQuantity > detail.ticketTypeTotalQuantity) {
    throw new InventoryEventContractError(
      'versioned InventoryChanged has ticketType remaining greater than total',
    );
  }
  if (!isNonNegativeInt(detail.inventoryVersion)) {
    throw new InventoryEventContractError(
      'versioned InventoryChanged has invalid inventoryVersion',
    );
  }
  if (!isNonNegativeInt(detail.eventTotalQuantity)) {
    throw new InventoryEventContractError(
      'versioned InventoryChanged has invalid eventTotalQuantity',
    );
  }
  if (!isNonNegativeInt(detail.eventRemainingQuantity)) {
    throw new InventoryEventContractError(
      'versioned InventoryChanged has invalid eventRemainingQuantity',
    );
  }
  if (detail.eventRemainingQuantity > detail.eventTotalQuantity) {
    throw new InventoryEventContractError(
      'versioned InventoryChanged has event remaining greater than total',
    );
  }
  if (!isNonNegativeInt(detail.eventInventoryVersion)) {
    throw new InventoryEventContractError(
      'versioned InventoryChanged has invalid eventInventoryVersion',
    );
  }
  // legacy 互換 field remainingQuantity は Event 集計残数と一致していなければならない。
  if (!isNonNegativeInt(detail.remainingQuantity)) {
    throw new InventoryEventContractError(
      'versioned InventoryChanged has invalid legacy remainingQuantity',
    );
  }
  if (detail.remainingQuantity !== detail.eventRemainingQuantity) {
    throw new InventoryEventContractError(
      'versioned InventoryChanged legacy remainingQuantity diverges from eventRemainingQuantity',
    );
  }

  return {
    kind: 'versioned',
    eventId,
    remainingQuantity: detail.remainingQuantity,
    inventoryEventVersion: SUPPORTED_INVENTORY_EVENT_VERSION,
    ticketTypeId: detail.ticketTypeId,
    ticketTypeName: detail.ticketTypeName,
    ticketTypeTotalQuantity: detail.ticketTypeTotalQuantity,
    ticketTypeRemainingQuantity: detail.ticketTypeRemainingQuantity,
    // runtime validation boundary で branded 値へ変換する（既に検証済みなので throw しない）。
    inventoryVersion: toTicketTypeInventoryVersion(detail.inventoryVersion),
    eventTotalQuantity: detail.eventTotalQuantity,
    eventRemainingQuantity: detail.eventRemainingQuantity,
    eventInventoryVersion: toEventInventoryVersion(detail.eventInventoryVersion),
  };
}

// buildVersionedInventoryChangedDetail は producer が transaction 由来の値から
// versioned payload を組み立てる helper です。compile-time 型で必須 field を強制します。
// 内部 version を公開 response へ漏らさないよう、producer 側でのみ使います。
export function buildVersionedInventoryChangedDetail(input: {
  eventId: string;
  ticketTypeId: string;
  ticketTypeName: string;
  ticketTypeTotalQuantity: number;
  ticketTypeRemainingQuantity: number;
  // 呼び出し側は DB / runtime boundary で branded 値へ変換して渡す。
  // これにより Type version と Event version の入れ替えが compile error になる（review 6）。
  inventoryVersion: TicketTypeInventoryVersion;
  eventTotalQuantity: number;
  eventRemainingQuantity: number;
  eventInventoryVersion: EventInventoryVersion;
}): VersionedInventoryChangedPayload {
  return {
    eventId: input.eventId,
    // legacy 互換 field: Event 集計残数を旧 field 名で維持する。
    remainingQuantity: input.eventRemainingQuantity,
    inventoryEventVersion: SUPPORTED_INVENTORY_EVENT_VERSION,
    ticketTypeId: input.ticketTypeId,
    ticketTypeName: input.ticketTypeName,
    ticketTypeTotalQuantity: input.ticketTypeTotalQuantity,
    ticketTypeRemainingQuantity: input.ticketTypeRemainingQuantity,
    inventoryVersion: input.inventoryVersion,
    eventTotalQuantity: input.eventTotalQuantity,
    eventRemainingQuantity: input.eventRemainingQuantity,
    eventInventoryVersion: input.eventInventoryVersion,
  };
}

// stripTraceContext は detail から trace carrier を取り除き、業務 contract だけを返します。
// contract parser は trace field を無視しますが、log などで payload を扱う際に
// trace context を業務データと混同しないための明示的な helper です。
export function stripTraceContext(
  detail: Record<string, unknown>,
): Record<string, unknown> {
  if (detail[TRACE_CONTEXT_FIELD] === undefined) {
    return detail;
  }
  const clone = { ...detail };
  delete clone[TRACE_CONTEXT_FIELD];
  return clone;
}
