// ファイル概要:
// このファイルは InventoryChanged contract parser の単体テストです（Issue #377）。
// versioned / legacy payload の正常 parse、部分 versioned payload を legacy 扱いしないこと、
// UUID / safe integer / 非負数量 / remaining<=total / version の検証を固定します。

import {
  InventoryEventContractError,
  buildVersionedInventoryChangedDetail,
  parseInventoryChangedDetail,
  SUPPORTED_INVENTORY_EVENT_VERSION,
} from './inventory-event.contract';

const EVENT_ID = '11111111-1111-1111-1111-111111111111';
const TYPE_ID = '22222222-2222-2222-2222-222222222222';

function validVersioned(overrides: Record<string, unknown> = {}) {
  return {
    eventId: EVENT_ID,
    remainingQuantity: 40,
    inventoryEventVersion: SUPPORTED_INVENTORY_EVENT_VERSION,
    ticketTypeId: TYPE_ID,
    ticketTypeName: 'General Admission',
    ticketTypeTotalQuantity: 50,
    ticketTypeRemainingQuantity: 40,
    inventoryVersion: 3,
    eventTotalQuantity: 50,
    eventRemainingQuantity: 40,
    eventInventoryVersion: 3,
    ...overrides,
  };
}

describe('parseInventoryChangedDetail', () => {
  it('versioned payload を正常 parse する', () => {
    const parsed = parseInventoryChangedDetail(validVersioned());
    expect(parsed.kind).toBe('versioned');
    if (parsed.kind !== 'versioned') return;
    expect(parsed.ticketTypeId).toBe(TYPE_ID);
    expect(parsed.inventoryVersion).toBe(3);
    expect(parsed.eventInventoryVersion).toBe(3);
  });

  it('legacy payload（eventId + remainingQuantity のみ）を正常 parse する', () => {
    const parsed = parseInventoryChangedDetail({
      eventId: EVENT_ID,
      remainingQuantity: 12,
    });
    expect(parsed.kind).toBe('legacy');
    if (parsed.kind !== 'legacy') return;
    expect(parsed.remainingQuantity).toBe(12);
  });

  it('_traceContext があっても legacy として parse できる（trace は業務 contract と分離）', () => {
    const parsed = parseInventoryChangedDetail({
      eventId: EVENT_ID,
      remainingQuantity: 12,
      _traceContext: { 'x-amzn-trace-id': 'Root=1-abc' },
    });
    expect(parsed.kind).toBe('legacy');
  });

  it('部分 versioned payload を legacy 扱いせず throw する', () => {
    // ticketTypeId だけある壊れた payload。legacy へフォールバックさせない。
    expect(() =>
      parseInventoryChangedDetail({
        eventId: EVENT_ID,
        remainingQuantity: 12,
        ticketTypeId: TYPE_ID,
      }),
    ).toThrow(InventoryEventContractError);
  });

  it('eventId が UUID でない場合は throw する', () => {
    expect(() =>
      parseInventoryChangedDetail({ eventId: 'nope', remainingQuantity: 1 }),
    ).toThrow(InventoryEventContractError);
  });

  it('ticketTypeId が UUID でない versioned は throw する', () => {
    expect(() =>
      parseInventoryChangedDetail(validVersioned({ ticketTypeId: 'nope' })),
    ).toThrow(InventoryEventContractError);
  });

  it('数量が safe integer でない場合は throw する', () => {
    expect(() =>
      parseInventoryChangedDetail(
        validVersioned({ ticketTypeRemainingQuantity: 1.5 }),
      ),
    ).toThrow(InventoryEventContractError);
  });

  it('数量が負の場合は throw する', () => {
    expect(() =>
      parseInventoryChangedDetail(validVersioned({ ticketTypeRemainingQuantity: -1 })),
    ).toThrow(InventoryEventContractError);
  });

  it('Type remaining > total は throw する', () => {
    expect(() =>
      parseInventoryChangedDetail(
        validVersioned({ ticketTypeRemainingQuantity: 60, ticketTypeTotalQuantity: 50 }),
      ),
    ).toThrow(InventoryEventContractError);
  });

  it('Event remaining > total は throw する', () => {
    expect(() =>
      parseInventoryChangedDetail(
        validVersioned({
          eventRemainingQuantity: 60,
          eventTotalQuantity: 50,
          remainingQuantity: 60,
        }),
      ),
    ).toThrow(InventoryEventContractError);
  });

  it('version が負の場合は throw する', () => {
    expect(() =>
      parseInventoryChangedDetail(validVersioned({ inventoryVersion: -1 })),
    ).toThrow(InventoryEventContractError);
  });

  it('legacy remainingQuantity が eventRemainingQuantity と食い違う versioned は throw する', () => {
    expect(() =>
      parseInventoryChangedDetail(validVersioned({ remainingQuantity: 39 })),
    ).toThrow(InventoryEventContractError);
  });

  it('未対応 contract version は throw する', () => {
    expect(() =>
      parseInventoryChangedDetail(validVersioned({ inventoryEventVersion: 999 })),
    ).toThrow(InventoryEventContractError);
  });

  it('必須 field 欠損（ticketTypeName なし）は throw する', () => {
    const payload = validVersioned();
    delete (payload as Record<string, unknown>).ticketTypeName;
    expect(() => parseInventoryChangedDetail(payload)).toThrow(
      InventoryEventContractError,
    );
  });
});

describe('buildVersionedInventoryChangedDetail', () => {
  it('legacy 互換 field remainingQuantity を eventRemainingQuantity と一致させる', () => {
    const detail = buildVersionedInventoryChangedDetail({
      eventId: EVENT_ID,
      ticketTypeId: TYPE_ID,
      ticketTypeName: 'GA',
      ticketTypeTotalQuantity: 50,
      ticketTypeRemainingQuantity: 40,
      inventoryVersion: 3,
      eventTotalQuantity: 100,
      eventRemainingQuantity: 90,
      eventInventoryVersion: 5,
    });
    expect(detail.remainingQuantity).toBe(90);
    expect(detail.inventoryEventVersion).toBe(SUPPORTED_INVENTORY_EVENT_VERSION);
    // producer が組んだ payload は parser を通る（round-trip）。
    expect(parseInventoryChangedDetail(detail).kind).toBe('versioned');
  });
});
