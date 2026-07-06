// ファイル概要:
// このファイルはユーザーフローの E2E テストです（Issue #148）。
// signup → login → イベント登録 → 検索 → 購入（confirmed / sold_out）→ logout を
// 実バックエンド + 実 DB / Valkey に対して直列で検証します。
// 検索はローカルでは DB フォールバック、実環境（E2E_BASE_URL 指定時）では
// OpenSearch への非同期プロジェクション反映を expect.poll で待ちます。

import { expect, Page, test } from "@playwright/test";

// テスト実行ごとに一意な識別子。メール・イベント種別の衝突を避けます。
const runId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const email = `e2e-${runId}@example.com`;
const password = "Password123!";
const eventType = `e2e-${runId}`;
const eventTitle = `E2E イベント ${runId}`;

// 販売枚数。全量購入 → 追加購入で sold_out を再現します。
const totalQuantity = 3;

test.describe.configure({ mode: "serial" });

// ヘッダーの認証状態表示（client fetch）が反映されるのを待つヘルパーです。
async function expectLoggedIn(page: Page) {
  await expect(page.getByTestId("current-user-email")).toHaveText(email, {
    timeout: 15_000,
  });
}

// フォーム操作前に hydration 完了（data-hydrated 属性）を待つヘルパーです。
async function waitForForm(page: Page) {
  await expect(page.locator("form[data-hydrated]")).toBeVisible({
    timeout: 30_000,
  });
}

test("signup すると自動ログインされヘッダーにメールが表示される", async ({ page }) => {
  await page.goto("/signup");
  await waitForForm(page);
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill(password);
  await page.getByRole("button", { name: "登録する" }).click();
  await page.waitForURL("**/");
  await expectLoggedIn(page);
});

test("logout して再度 login できる", async ({ page }) => {
  // 各テストは新しいブラウザコンテキスト（Cookie なし）で始まるため、login から検証します。
  await page.goto("/login");
  await waitForForm(page);
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill(password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL("**/");
  await expectLoggedIn(page);

  await page.getByRole("button", { name: "ログアウト" }).click();
  await expect(page.getByRole("link", { name: "ログイン" })).toBeVisible();

  // 誤ったパスワードは 401 のエラーメッセージを表示します。
  await page.goto("/login");
  await waitForForm(page);
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill("WrongPassword1!");
  await page.getByRole("button", { name: "ログイン" }).click();
  // Next.js の route announcer も role=alert を持つため、メッセージ要素に限定します。
  await expect(page.locator('p[role="alert"]')).toContainText(
    "メールアドレスまたはパスワードが違います",
  );
});

test("イベントを登録すると詳細ページと一覧に表示される", async ({ page }) => {
  await login(page);

  await page.goto("/events/new");
  await waitForForm(page);
  await page.getByLabel("タイトル").fill(eventTitle);
  await page.getByLabel("種別（eventType）").fill(eventType);
  await page.getByLabel("開催日時").fill("2026-08-01T19:00");
  await page.getByLabel("緯度（任意）").fill("35.68");
  await page.getByLabel("経度（任意）").fill("139.76");
  await page.getByLabel("販売枚数").fill(String(totalQuantity));
  await page.getByRole("button", { name: "登録する" }).click();

  // 詳細ページへ遷移し、残枚数が全量で表示されます。
  await page.waitForURL("**/events/**");
  await expect(page.getByRole("heading", { name: eventTitle })).toBeVisible();
  await expect(page.getByTestId("remaining-quantity")).toContainText(
    `残り ${totalQuantity} / ${totalQuantity} 枚`,
  );

  // トップの一覧（SSR）にも表示されます。
  await page.goto("/");
  await expect(
    page.getByTestId("event-card").filter({ hasText: eventTitle }),
  ).toBeVisible();
});

test("検索（eventType）で登録イベントがヒットする", async ({ page }) => {
  // 実環境では EventBridge → SQS → Worker → OpenSearch の反映待ちがあるため、
  // ヒットするまで検索ページの再読み込みをポーリングします（最長 90 秒）。
  await expect
    .poll(
      async () => {
        await page.goto(`/search?eventType=${encodeURIComponent(eventType)}`);
        return page
          .getByTestId("event-card")
          .filter({ hasText: eventTitle })
          .count();
      },
      { timeout: 90_000, intervals: [3_000] },
    )
    .toBeGreaterThan(0);
});

test("購入が confirmed になり、売り切れ後は rejected(sold_out) になる", async ({
  page,
}) => {
  await login(page);

  // 検索結果（または一覧）からイベント詳細へ。
  await page.goto("/");
  await page
    .getByTestId("event-card")
    .filter({ hasText: eventTitle })
    .click();
  await page.waitForURL("**/events/**");

  // 全量を購入して confirmed を確認します（購入ボタンの hydration を待ってから操作）。
  await expect(page.getByTestId("purchase-button")).toHaveAttribute(
    "data-hydrated",
    "true",
    { timeout: 30_000 },
  );
  await page.getByLabel("枚数").fill(String(totalQuantity));
  await page.getByTestId("purchase-button").click();
  await expect(page.getByTestId("purchase-confirmed")).toContainText(
    "購入が確定しました",
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("purchase-confirmed")).toContainText("残り 0 枚");

  // 売り切れ後の追加購入は rejected（sold_out_precheck / insufficient_inventory）になります。
  await page.getByLabel("枚数").fill("1");
  await page.getByTestId("purchase-button").click();
  await expect(page.getByTestId("purchase-rejected")).toContainText(
    /sold_out|insufficient_inventory/,
    { timeout: 20_000 },
  );
});

test("アクセストークン失効後も silent refresh でログイン状態が維持される", async ({
  page,
  context,
}) => {
  // ログインして access_token / refresh_token の両 Cookie を得ます。
  await login(page);

  // access_token Cookie だけを削除し、「アクセストークン期限切れ・リフレッシュトークン有効」を再現します
  // （15 分の実経過を待たずに期限切れ相当の状態を作る。ADR-0012 / Issue #169）。
  const cookies = await context.cookies();
  await context.clearCookies();
  await context.addCookies(cookies.filter((c) => c.name !== "access_token"));

  // ページ再読込でヘッダーの認証確認（GET /api/auth/me）が 401 → silent refresh → リトライされ、
  // ログイン状態の表示が透過的に維持されることを確認します。
  await page.goto("/");
  await expectLoggedIn(page);

  // refresh で新しい access_token Cookie が貼り直されていることも確認します。
  const refreshedCookies = await context.cookies();
  expect(
    refreshedCookies.some((c) => c.name === "access_token" && c.value.length > 0),
  ).toBe(true);
});

test("未ログインで購入すると login へ誘導される", async ({ page }) => {
  await page.goto("/");
  await page
    .getByTestId("event-card")
    .filter({ hasText: eventTitle })
    .click();
  await page.waitForURL("**/events/**");
  await expect(page.getByTestId("purchase-button")).toHaveAttribute(
    "data-hydrated",
    "true",
    { timeout: 30_000 },
  );
  await page.getByTestId("purchase-button").click();
  await page.waitForURL("**/login?next=**");
  await expect(page.getByRole("heading", { name: "ログイン" })).toBeVisible();
});

// login は既存アカウントでログインする共通処理です。
async function login(page: Page) {
  await page.goto("/login");
  await waitForForm(page);
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill(password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL("**/");
  await expectLoggedIn(page);
}
