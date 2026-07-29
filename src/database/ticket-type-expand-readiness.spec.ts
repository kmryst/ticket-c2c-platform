// ファイル概要:
// Ticket Type expand readiness checker が、結果集合の欠落・追加・重複や
// 不正な件数を成功扱いせず fail closed になることを検証します。

import {
  checkTicketTypeExpandReadiness,
  hasTicketTypeExpandViolations,
  TICKET_TYPE_EXPAND_READINESS_CATEGORIES,
  TICKET_TYPE_EXPAND_READINESS_SQL,
  TicketTypeExpandReadinessResult,
} from './ticket-type-expand-readiness';

function completeRows(violationCount = '0') {
  return TICKET_TYPE_EXPAND_READINESS_CATEGORIES.map((category) => ({
    category,
    violation_count: violationCount,
  }));
}

function completeResults(
  violationCount = 0,
): TicketTypeExpandReadinessResult[] {
  return TICKET_TYPE_EXPAND_READINESS_CATEGORIES.map((category) => ({
    category,
    violationCount,
  }));
}

describe('Ticket Type expand readiness result validation', () => {
  it('16カテゴリの完全な結果を正本順に返す', async () => {
    const rows = completeRows().reverse();
    const query = jest.fn().mockResolvedValue({ rows });

    const results = await checkTicketTypeExpandReadiness({ query });

    expect(query).toHaveBeenCalledWith(TICKET_TYPE_EXPAND_READINESS_SQL);
    expect(results).toEqual(completeResults());
    expect(hasTicketTypeExpandViolations(results)).toBe(false);
  });

  it('1カテゴリでも違反があればtrueを返す', () => {
    const results = completeResults();
    results[0].violationCount = 1;

    expect(hasTicketTypeExpandViolations(results)).toBe(true);
  });

  it.each([
    ['空配列', []],
    ['カテゴリ欠落', completeRows().slice(1)],
    ['カテゴリ重複', [...completeRows(), completeRows()[0]]],
    [
      '未知カテゴリ',
      [
        ...completeRows().slice(1),
        { category: 'unknown_category', violation_count: '0' },
      ],
    ],
  ])('%sを拒否する', async (_name, rows) => {
    await expect(
      checkTicketTypeExpandReadiness({
        query: jest.fn().mockResolvedValue(rows),
      }),
    ).rejects.toThrow(/Ticket Type readiness categor/);
  });

  it.each(['', '-1', '1.5', '1e3', '9007199254740992'])(
    '不正な件数 %p を拒否する',
    async (violationCount) => {
      const rows = completeRows();
      rows[0].violation_count = violationCount;

      await expect(
        checkTicketTypeExpandReadiness({
          query: jest.fn().mockResolvedValue(rows),
        }),
      ).rejects.toThrow(/invalid Ticket Type readiness count/);
    },
  );

  it('検証済みでない空の結果を違反0として扱わない', () => {
    expect(() => hasTicketTypeExpandViolations([])).toThrow(
      /missing Ticket Type readiness categories/,
    );
  });
});
