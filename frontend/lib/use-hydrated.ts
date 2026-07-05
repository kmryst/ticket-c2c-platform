// ファイル概要:
// このファイルは「React の hydration が完了したか」を返す小さな hook です（Issue #148）。
// フォームは JS のイベントハンドラ前提のため、hydration 前のネイティブ submit
// （パスワードが query string に載る GET など）を防ぐ目的と、
// E2E テストが操作可能になったことを判定するマーカー（data-hydrated 属性）に使います。
// useSyncExternalStore の server snapshot（false）/ client snapshot（true）を使う
// 定番パターンで、effect 内 setState を避けて実装します。

"use client";

import { useSyncExternalStore } from "react";

// 購読対象はないため、no-op の subscribe を返します。
const emptySubscribe = () => () => {};

export function useHydrated(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    // client では常に true（hydration 後に呼ばれる）
    () => true,
    // server render / hydration 中の初期値は false
    () => false,
  );
}
