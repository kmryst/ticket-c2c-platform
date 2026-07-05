// ファイル概要:
// このファイルは JWT を httpOnly Cookie で発行・破棄するための共通処理です（ADR-0011、Issue #142）。
// Cookie の属性（httpOnly / Secure / SameSite / Path / Max-Age）を 1 箇所に集約し、
// login / signup / logout の各 handler から同じ属性で操作できるようにします。

// @fastify/cookie を import することで、FastifyReply に setCookie / clearCookie の
// 型（module augmentation）が付きます。実際の plugin 登録は src/main.ts で行います。
import type { CookieSerializeOptions } from '@fastify/cookie';
// FastifyReply は Set-Cookie header を書き込む対象の response オブジェクトです。
import { FastifyReply } from 'fastify';
// JWT_ACCESS_TOKEN_TTL_SECONDS（1h）を Cookie の Max-Age にも使い、トークンと Cookie の寿命を揃えます。
import { JWT_ACCESS_TOKEN_TTL_SECONDS } from '../config';

// AUTH_COOKIE_NAME はアクセストークンを保持する Cookie 名です。
// JwtAuthGuard の Cookie fallback もこの名前を参照します。
export const AUTH_COOKIE_NAME = 'access_token';

// authCookieOptions は Cookie の属性を返します。
// - httpOnly: JS から読めないようにし、XSS によるトークン窃取を防ぎます（ADR-0011 決定 3）。
// - secure: HTTPS でのみ送信します。ローカル HTTP 検証時のみ COOKIE_SECURE=false で無効化できます。
// - sameSite lax: クロスサイト POST に Cookie が付かず、CSRF の主要経路を塞ぎます。
// - path /: フロントエンドと API が同一オリジン（CloudFront 統合オリジン）で共有するため全パスに送ります。
function authCookieOptions(): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE !== 'false',
    sameSite: 'lax',
    path: '/',
    maxAge: JWT_ACCESS_TOKEN_TTL_SECONDS,
  };
}

// setAuthCookie は login / signup 成功時にアクセストークンを Set-Cookie で発行します。
export function setAuthCookie(reply: FastifyReply, accessToken: string): void {
  reply.setCookie(AUTH_COOKIE_NAME, accessToken, authCookieOptions());
}

// clearAuthCookie は logout 時に Cookie を破棄します。
// 発行時と同じ属性（特に path）で消さないとブラウザが別 Cookie とみなすため、options を共有します。
export function clearAuthCookie(reply: FastifyReply): void {
  reply.clearCookie(AUTH_COOKIE_NAME, authCookieOptions());
}
