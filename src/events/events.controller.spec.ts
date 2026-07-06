// ファイル概要:
// このファイルは EventsController のイベント登録認証必須化（production-readiness L-10、Issue #194）の単体テストです。
// - createEvent に JwtAuthGuard が適用されていること（未認証は handler 到達前に 401 になる構造の検証）
// - createEvent が作成者としてトークンの sub claim を service へ渡すこと
// - listEvents / searchEvents は未認証のまま（guard なし）であること
// を検証します。401 / 201 の実際の HTTP 挙動は dev / staging 実環境で検証します。

import { GUARDS_METADATA } from '@nestjs/common/constants';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { JwtPayload } from '../auth/auth.types';

const CREATOR_ID = '22222222-2222-4222-8222-222222222222';

function getGuards(handlerName: keyof EventsController): unknown[] {
  return (
    (Reflect.getMetadata(
      GUARDS_METADATA,
      EventsController.prototype[handlerName],
    ) as unknown[] | undefined) ?? []
  );
}

describe('EventsController', () => {
  it('createEvent には JwtAuthGuard が適用されている（イベント登録は認証必須）', () => {
    expect(getGuards('createEvent')).toContain(JwtAuthGuard);
  });

  it('listEvents / searchEvents は guard なしのまま（閲覧は誰でも可）', () => {
    expect(getGuards('listEvents')).toHaveLength(0);
    expect(getGuards('searchEvents')).toHaveLength(0);
  });

  it('createEvent は作成者としてトークンの sub claim（users.id）を service へ渡す', async () => {
    const createEvent = jest.fn(async () => ({ eventId: 'x' }));
    const controller = new EventsController({
      createEvent,
    } as unknown as EventsService);

    const user = { sub: CREATOR_ID, email: 'creator@example.com' } as JwtPayload;
    const body = { title: 't', createdBy: 'spoofed-id' };

    await controller.createEvent(user, body);

    // 第 2 引数（作成者）は body の値ではなく、検証済みトークンの sub であること。
    expect(createEvent).toHaveBeenCalledWith(body, CREATOR_ID);
  });
});
