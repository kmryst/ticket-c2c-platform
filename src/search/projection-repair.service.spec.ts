// ファイル概要:
// projection-repair service の pure helper の unit テストです（Issue #377 / PR #396）。
// updateWasApplied は「OpenSearch update API の result が 'updated' のときだけ書き込んだと
// 報告する」fail-closed 判定であり、Painless script の ctx.op = 'noop'（no-op）を
// report.applied = true と偽らないことを境界値で固定します。
// 実 store での no-op 再現（並行書き込み race）は projection.integration.spec.ts が担います。

import { updateWasApplied } from './projection-repair.service';

describe('updateWasApplied', () => {
  it("result が 'updated' のときだけ true を返す", () => {
    expect(updateWasApplied({ body: { result: 'updated' } })).toBe(true);
  });

  it("script no-op（result 'noop'）は false を返す", () => {
    expect(updateWasApplied({ body: { result: 'noop' } })).toBe(false);
  });

  it('想定外の result / body 欠落は「書き込んだ」と主張しない（fail-closed）', () => {
    expect(updateWasApplied({ body: { result: 'created' } })).toBe(false);
    expect(updateWasApplied({ body: { result: undefined } })).toBe(false);
    expect(updateWasApplied({ body: {} })).toBe(false);
    expect(updateWasApplied({})).toBe(false);
  });
});
