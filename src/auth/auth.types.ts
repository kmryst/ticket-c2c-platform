// ファイル概要:
// このファイルはメール+パスワード認証 API（ADR-0010、Issue #133）で使う型定義をまとめた場所です。
// HTTP request body、validation 後の内部入力、JWT payload、API response の形を分けて定義し、
// controller / service / guard が認証データの意味を揃えられるようにします。

// AuthRequestBody は signup / login の HTTP request body の生の形です。
// 外部入力は信用しないため、各 field は validation 前の unknown として受けます。
export interface AuthRequestBody {
  // email はログイン ID の候補値ですが、ここではまだメール形式かどうか分かりません。
  email?: unknown;
  // password はパスワードの候補値ですが、ここではまだ長さ制約を満たすか分かりません。
  password?: unknown;
}

// ParsedCredentials は AuthService の validation を通過した後の内部入力です。
// 以降の処理は、この型の値ならメール形式・パスワード長が正しい前提で進められます。
export interface ParsedCredentials {
  // email は形式検証済みのメールアドレスです。DB 側の一意判定は lower(email) で行います。
  email: string;
  // password は 8 文字以上・bcrypt の 72 byte 制約内の平文パスワードです。
  // hash 化前の一時的な値であり、ログや response に出してはいけません。
  password: string;
}

// JwtPayload はこの API が発行・検証する JWT の claim 構造です。
// JwtAuthGuard が検証後に request.user へ添付し、@CurrentUser() で handler へ渡します。
export interface JwtPayload {
  // sub は認証済みユーザーの users.id（UUID）です。購入 API の buyer_id はこの値を使います。
  sub: string;
  // email は表示・ログ用の補助 claim です。認可判定には sub を使います。
  email: string;
  // iat は発行時刻（@nestjs/jwt が自動付与）です。
  iat?: number;
  // exp は失効時刻（signOptions.expiresIn から自動計算）です。
  exp?: number;
}

// AuthenticatedUser はクライアントへ返すユーザー情報です。
// password_hash を含む DB row をそのまま返さないための、公開してよい部分集合です。
export interface AuthenticatedUser {
  // userId は users.id の UUID です。
  userId: string;
  // email は登録済みメールアドレスです。
  email: string;
  // createdAt はアカウント作成日時（ISO 8601 文字列）です。
  createdAt: string;
}

// AuthTokenResult は signup / login 成功時にクライアントへ返す形です。
export interface AuthTokenResult {
  // accessToken は Authorization: Bearer <token> として送る JWT です。
  accessToken: string;
  // tokenType は OAuth2 の慣例に合わせた固定値です。
  tokenType: 'Bearer';
  // expiresIn はトークンの有効期間（秒）です。クライアントの再ログイン判断に使えます。
  expiresIn: number;
  // user は発行対象ユーザーの公開情報です。
  user: AuthenticatedUser;
}
