// ファイル概要:
// projection-repair CLI の引数検証の unit テストです（Issue #377 / PR #396）。
// 完全一致 UUID 必須・dry-run 既定・mode ごとの必須 / 禁止オプションという安全制約を
// 引数境界で固定します（store への接続は不要）。

import { parseRepairArgs } from './projection-repair.cli';

const EVENT_ID = '3f2c8a34-9d1e-4c1b-8f3a-2b7c9d0e1f2a';
const TYPE_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

describe('parseRepairArgs', () => {
  it('dry-run が既定であり --apply を明示したときだけ apply=true になる', () => {
    const dryRun = parseRepairArgs(['--mode', 'delete-document', '--event-id', EVENT_ID]);
    expect(dryRun.apply).toBe(false);
    const apply = parseRepairArgs([
      '--mode', 'delete-document', '--event-id', EVENT_ID, '--apply',
    ]);
    expect(apply.apply).toBe(true);
  });

  it('--name=value 形式も受け付ける', () => {
    const args = parseRepairArgs([
      `--mode=repair-corruption`,
      `--event-id=${EVENT_ID}`,
    ]);
    expect(args.mode).toBe('repair-corruption');
    expect(args.eventId).toBe(EVENT_ID);
  });

  it('mode が不正・欠落なら throw する', () => {
    expect(() => parseRepairArgs(['--event-id', EVENT_ID])).toThrow(/--mode/);
    expect(() =>
      parseRepairArgs(['--mode', 'delete-all', '--event-id', EVENT_ID]),
    ).toThrow(/--mode/);
  });

  it('event-id は canonical UUID の完全一致を必須にする', () => {
    expect(() => parseRepairArgs(['--mode', 'delete-document'])).toThrow(/--event-id/);
    expect(() =>
      parseRepairArgs(['--mode', 'delete-document', '--event-id', 'not-a-uuid']),
    ).toThrow(/--event-id/);
    expect(() =>
      parseRepairArgs(['--mode', 'delete-document', '--event-id', `${EVENT_ID}*`]),
    ).toThrow(/--event-id/);
  });

  it('delete-ticket-type は ticket-type-id 必須、他 mode では禁止する', () => {
    expect(() =>
      parseRepairArgs(['--mode', 'delete-ticket-type', '--event-id', EVENT_ID]),
    ).toThrow(/--ticket-type-id/);
    const ok = parseRepairArgs([
      '--mode', 'delete-ticket-type', '--event-id', EVENT_ID,
      '--ticket-type-id', TYPE_ID,
    ]);
    expect(ok.ticketTypeId).toBe(TYPE_ID);
    expect(() =>
      parseRepairArgs([
        '--mode', 'delete-document', '--event-id', EVENT_ID,
        '--ticket-type-id', TYPE_ID,
      ]),
    ).toThrow(/--ticket-type-id/);
  });

  it('未知の引数は throw する（黙って無視しない）', () => {
    expect(() =>
      parseRepairArgs([
        '--mode', 'delete-document', '--event-id', EVENT_ID, '--force',
      ]),
    ).toThrow(/unknown argument/);
  });
});
