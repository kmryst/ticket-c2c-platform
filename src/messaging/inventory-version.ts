// ファイル概要:
// このファイルは Ticket Type 単位 version と Event 集計 version を、compile-time で
// 取り違えられない別々の nominal（branded）type として定義します（Issue #377 review 6 対応）。
//
// 設計方針:
// - ADR-0031 の核心は「Ticket Type version と Event 集計 version を独立に guard する」こと。
//   この 2 値はどちらも実行時には単なる number だが、構造的に同一なため入れ替えても
//   型システムは検出できなかった。branded type で swap を compile error にする。
// - 変換・validation は DB / runtime の boundary に field 固有 constructor として集約する
//   （無意味な `as` cast を各所へ散らさない）。boundary を越えた後は型システムが swap を拒否する。
// - serialized JSON 上は従来どおり number（branded type は実行時には number そのもの）。
//
// この module は leaf（validation-primitives のみに依存）で、import cycle を作りません。

import { POSTGRES_INT4_MAX } from '../common/validation-primitives';

// TicketTypeInventoryVersion は対象 Ticket Type 単位の単調増加 version（#376 採番）です。
export type TicketTypeInventoryVersion = number & {
  readonly __brand: 'TicketTypeInventoryVersion';
};

// EventInventoryVersion は Event 互換集計単位の version です。
// TicketTypeInventoryVersion とは順序関係を持たず、独立に比較します。
export type EventInventoryVersion = number & {
  readonly __brand: 'EventInventoryVersion';
};

// InventoryVersionError は version が DB / contract の許容範囲外だったときのエラーです。
export class InventoryVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InventoryVersionError';
  }
}

// isVersionValue は version として妥当な数値（finite safe integer で 0 以上、int4 上限以内）かを判定します。
export function isVersionValue(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= POSTGRES_INT4_MAX
  );
}

// toTicketTypeInventoryVersion は DB / runtime boundary で number を
// TicketTypeInventoryVersion へ変換します（範囲外は InventoryVersionError）。
export function toTicketTypeInventoryVersion(
  value: unknown,
): TicketTypeInventoryVersion {
  if (!isVersionValue(value)) {
    throw new InventoryVersionError(
      `invalid ticket type inventory version: ${String(value)}`,
    );
  }
  return value as TicketTypeInventoryVersion;
}

// toEventInventoryVersion は DB / runtime boundary で number を
// EventInventoryVersion へ変換します（範囲外は InventoryVersionError）。
export function toEventInventoryVersion(value: unknown): EventInventoryVersion {
  if (!isVersionValue(value)) {
    throw new InventoryVersionError(
      `invalid event inventory version: ${String(value)}`,
    );
  }
  return value as EventInventoryVersion;
}
