// ファイル概要:
// このファイルはメール+パスワード認証のビジネスロジック本体です（ADR-0010、Issue #133）。
// request validation、bcrypt によるパスワード hash 化・照合、JWT の発行、
// 認証済みユーザー情報の取得をまとめて扱います。DB アクセスは UsersService に委譲します。

// BadRequestException は入力値不正を 400 として返すために使います。
// ConflictException はメール重複を 409 として返すために使います。
// Injectable は service を NestJS の DI 対象として登録する decorator です。
// UnauthorizedException は資格情報不一致・トークン主体消失を 401 として返すために使います。
import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
// JwtService は @nestjs/jwt の署名・検証 helper です（Passport は使いません。ADR-0010）。
import { JwtService } from '@nestjs/jwt';
// bcrypt はパスワードの hash 化（コストファクター 12）と照合に使います。
import { compare, hash } from 'bcrypt';
// JWT_ACCESS_TOKEN_TTL_SECONDS は response の expiresIn に返す有効期限（15 分）です。
import { JWT_ACCESS_TOKEN_TTL_SECONDS } from '../config';
// UsersService は users テーブルへの raw SQL アクセス層です。
import { UserRow, UsersService } from '../users/users.service';
// RefreshTokensService はリフレッシュトークンの発行・rotate・失効の正本です（ADR-0012、Issue #165）。
import {
  RefreshTokensService,
  REVOKE_REASON_LOGOUT,
  TokenClientMeta,
} from './refresh-tokens.service';
// auth.types は controller と service の間で共有する入力・出力の型です。
import {
  AuthenticatedUser,
  AuthRequestBody,
  AuthTokenResult,
  JwtPayload,
  ParsedCredentials,
} from './auth.types';

// BCRYPT_COST_FACTOR は 2026 年時点の OWASP 推奨帯に合わせた値です（ADR-0010）。
// 値を上げると総当たり耐性が増す代わりに、signup / login のレイテンシが倍々で増えます。
const BCRYPT_COST_FACTOR = 12;

// EMAIL_PATTERN は「@ を挟んで空白なし + ドメインに . を含む」だけの緩い形式検証です。
// RFC 完全準拠の正規表現は保守コストに見合わないため、明らかな入力ミスの検出に絞ります。
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// EMAIL_MAX_LENGTH は RFC 5321 のアドレス長上限です。DB の TEXT 型に長さ制約がないため service で守ります。
const EMAIL_MAX_LENGTH = 254;

// PASSWORD_MIN_LENGTH は最低限の強度確保のための下限です。
const PASSWORD_MIN_LENGTH = 8;

// PASSWORD_MAX_BYTES は bcrypt が先頭 72 byte しか見ないという仕様上の上限です。
// これを超える入力を黙って切り詰めると「後半だけ違うパスワード」が同一視されるため、明示的に拒否します。
const PASSWORD_MAX_BYTES = 72;

// DUMMY_PASSWORD_HASH は「存在しないメール」へのログイン試行でも bcrypt 比較を 1 回実行するための捨てハッシュです。
// これがないと、応答時間の差からメールアドレスの存在有無を推測できてしまいます（user enumeration 対策）。
// 値は 'dummy-timing-equalizer-not-a-real-password' をコストファクター 12 で hash 化した固定文字列で、
// PASSWORD_MAX_BYTES 検証を通過するどの入力とも一致しません（元文字列の直接入力も長さ検証内だが照合対象にならない捨て値）。
const DUMMY_PASSWORD_HASH =
  '$2b$12$EQ1HuYaX8g.4em0LdU6AS.xm/iikRB/m1eLrmhdgYey3VWNqG6o1O';

// AuthService を NestJS の DI に登録します。
@Injectable()
// AuthService は signup / login / me の認証フロー本体を担当します。
export class AuthService {
  // constructor injection でユーザーデータアクセス・JWT 署名・リフレッシュトークンの各 service を受け取ります。
  constructor(
    private readonly users: UsersService,
    private readonly jwtService: JwtService,
    private readonly refreshTokens: RefreshTokensService,
  ) {}

  // signup は新規ユーザーを作成し、そのままログイン済みとしてトークンを返します。
  // meta はリフレッシュトークン発行時に記録する調査用のクライアント情報（IP / User-Agent）です。
  async signup(body: unknown, meta: TokenClientMeta): Promise<AuthTokenResult> {
    // 入力を検証し、以降の処理で信用できる ParsedCredentials に変換します。
    const credentials = parseCredentials(body);

    // 平文パスワードはここで hash 化し、以降どこにも保持しません。
    const passwordHash = await hash(credentials.password, BCRYPT_COST_FACTOR);

    try {
      // users テーブルへ INSERT します。email 重複は DB の unique index が最終防衛線です。
      const user = await this.users.createUser(credentials.email, passwordHash);
      // 作成できたユーザーに対して即座にトークンを発行します。
      return this.issueTokens(user, meta);
    } catch (error) {
      // 事前 SELECT での存在確認はレース（同時 signup）に負けるため行わず、
      // unique violation を 409 に変換する方式で一意性を守ります。
      if (isEmailUniqueViolation(error)) {
        throw new ConflictException('email is already registered');
      }

      // 既知のメール重複以外は、元の例外として NestJS に渡します。
      throw error;
    }
  }

  // login はメール+パスワードを照合し、一致すればトークンを返します。
  async login(body: unknown, meta: TokenClientMeta): Promise<AuthTokenResult> {
    // signup と同じ validation を通し、形式不正は 400 として先に返します。
    const credentials = parseCredentials(body);

    // lower(email) で照合するため、登録時と大文字小文字が違ってもログインできます。
    const user = await this.users.findByEmail(credentials.email);

    // ユーザー不在でも bcrypt 比較を 1 回実行し、応答時間からの存在推測を防ぎます。
    const passwordMatches = await compare(
      credentials.password,
      user ? user.password_hash : DUMMY_PASSWORD_HASH,
    );

    // 「メールが存在しない」と「パスワードが違う」は区別せず、同じ 401 を返します。
    if (!user || !passwordMatches) {
      throw new UnauthorizedException('invalid email or password');
    }

    // 資格情報が一致したのでトークンを発行します。
    return this.issueTokens(user, meta);
  }

  // refresh はリフレッシュトークンを rotate し、新しいアクセストークン + リフレッシュトークンを返します（ADR-0012）。
  async refresh(
    rawRefreshToken: string | undefined,
    meta: TokenClientMeta,
  ): Promise<AuthTokenResult> {
    // Cookie にも body にもトークンが無ければ 401 です。エラー文言は他の失敗理由と同じに丸めます。
    if (!rawRefreshToken) {
      throw new UnauthorizedException('invalid or expired refresh token');
    }

    // rotate は行ロック付き transaction で旧トークンを消費し、新トークンを発行します。
    // 使用済みトークンの再提示（reuse）はこの中でファミリー失効まで行われます。
    const rotated = await this.refreshTokens.rotate(rawRefreshToken, meta);

    // トークンは有効でも、rotate 後にユーザーが削除されている可能性があるため DB を正とします。
    const user = await this.users.findById(rotated.userId);
    if (!user) {
      throw new UnauthorizedException('invalid or expired refresh token');
    }

    // 新しいアクセストークンを発行し、rotate 済みの新リフレッシュトークンと合わせて返します。
    return this.buildTokenResult(user, rotated.token, rotated.expiresIn);
  }

  // logout は提示されたリフレッシュトークンのファミリーを失効させます。
  // トークンが無い・不明な場合も成功として扱います（Cookie 破棄は controller が常に行うため）。
  async logout(rawRefreshToken: string | undefined): Promise<void> {
    if (!rawRefreshToken) {
      return;
    }

    await this.refreshTokens.revokeFamilyByToken(
      rawRefreshToken,
      REVOKE_REASON_LOGOUT,
    );
  }

  // getMe は JwtAuthGuard 検証済みの payload から現在のユーザー情報を返します。
  async getMe(payload: JwtPayload): Promise<AuthenticatedUser> {
    // トークンは有効でも、発行後にユーザーが削除されている可能性があるため DB を正とします。
    const user = await this.users.findById(payload.sub);

    // 主体が消えたトークンは無効として 401 を返します。
    if (!user) {
      throw new UnauthorizedException('user no longer exists');
    }

    // password_hash を含まない公開形へ変換して返します。
    return toAuthenticatedUser(user);
  }

  // issueTokens はユーザー row からアクセストークン + 新規ファミリーのリフレッシュトークンを発行します。
  private async issueTokens(
    user: UserRow,
    meta: TokenClientMeta,
  ): Promise<AuthTokenResult> {
    // login / signup では新しいトークンファミリーを開始します（ADR-0012）。
    const issued = await this.refreshTokens.issue(user.id, meta);
    return this.buildTokenResult(user, issued.token, issued.expiresIn);
  }

  // buildTokenResult はアクセストークンを署名し、API response の形へ組み立てる共通処理です。
  private async buildTokenResult(
    user: UserRow,
    refreshToken: string,
    refreshExpiresIn: number,
  ): Promise<AuthTokenResult> {
    // payload は認可判定に使う sub（users.id）と、補助情報の email だけに絞ります。
    const payload: JwtPayload = { sub: user.id, email: user.email };

    // 署名アルゴリズム（HS256）と有効期限は JwtModule の登録時設定で固定されています。
    const accessToken = await this.jwtService.signAsync({ ...payload });

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: JWT_ACCESS_TOKEN_TTL_SECONDS,
      refreshToken,
      refreshExpiresIn,
      user: toAuthenticatedUser(user),
    };
  }
}

// toAuthenticatedUser は DB row をクライアントへ返せる公開形へ変換します。
function toAuthenticatedUser(user: UserRow): AuthenticatedUser {
  return {
    // id は response では userId として返します。
    userId: user.id,
    // email は登録時の表記のまま返します。
    email: user.email,
    // created_at は JSON で扱いやすい ISO 8601 文字列にします。
    createdAt: user.created_at.toISOString(),
  };
}

// isEmailUniqueViolation は pg error が users_email_uq の unique violation かを判定します。
function isEmailUniqueViolation(error: unknown): boolean {
  // unknown のまま property に触らず、object かつ null でないことから確認します。
  return (
    typeof error === 'object' &&
    error !== null &&
    // 23505 は PostgreSQL の unique_violation です。
    'code' in error &&
    error.code === '23505' &&
    // constraint 名まで見て、email 一意 index の競合だけを 409 に変換します。
    'constraint' in error &&
    error.constraint === 'users_email_uq'
  );
}

// parseCredentials は外部入力を検証し、内部で信用できる形に変換します。
// 購入 API の parsePurchaseInput と同じく、hand-written validation で 1 ファイル内に判断を置きます。
function parseCredentials(body: unknown): ParsedCredentials {
  // body は null ではなく、配列でもなく、通常の object である必要があります。
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('request body must be an object');
  }

  // ここまでで body は object なので、AuthRequestBody として field を検証します。
  const requestBody = body as AuthRequestBody;

  // email は必須で、メール形式の文字列である必要があります。
  if (
    typeof requestBody.email !== 'string' ||
    // RFC 5321 のアドレス長上限を超える値は拒否します。
    requestBody.email.length > EMAIL_MAX_LENGTH ||
    // 明らかな形式ミス（@ なし・空白混入など）を拒否します。
    !EMAIL_PATTERN.test(requestBody.email)
  ) {
    throw new BadRequestException('email must be a valid email address');
  }

  // password は必須で、下限文字数と bcrypt の byte 上限を満たす必要があります。
  if (
    typeof requestBody.password !== 'string' ||
    // 短すぎるパスワードは強度不足として拒否します。
    requestBody.password.length < PASSWORD_MIN_LENGTH ||
    // マルチバイト文字を考慮し、文字数ではなく byte 数で bcrypt の 72 byte 制約を守ります。
    Buffer.byteLength(requestBody.password, 'utf8') > PASSWORD_MAX_BYTES
  ) {
    throw new BadRequestException(
      // message には下限と上限の両方を含めます。
      `password must be at least ${PASSWORD_MIN_LENGTH} characters and at most ${PASSWORD_MAX_BYTES} bytes`,
    );
  }

  // ここまでの検証を通過した値だけを ParsedCredentials として返します。
  return {
    email: requestBody.email,
    password: requestBody.password,
  };
}
