// ファイル概要:
// このファイルは「React の hydration が完了したか」を返す小さな hook です（Issue #148）。
// フォームは JS のイベントハンドラ前提のため、hydration 前のネイティブ submit
// （パスワードが query string に載る GET など）を防ぐ目的と、
// E2E テストが操作可能になったことを判定するマーカー（data-hydrated 属性）に使います。

"use client";

import { useEffect, useState } from "react";

export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  return hydrated;
}
