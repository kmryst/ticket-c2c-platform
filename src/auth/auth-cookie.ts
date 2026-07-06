// ファイル概要:
// このファイルは JWT / リフレッシュトークンを httpOnly Cookie で発行・破棄するための共通処理です
// （ADR-0011 Issue #142、ADR-0012 Issue #165）。
// Cookie の属性（httpOnly / Secure / SameSite / Path / Max-Age）を 1 箇所に集約し、
// login / signup / refresh / logout の各 handler から同じ属性で操作できるようにします。

// @fastify/cookie を import することで、FastifyReply に setCookie / clearCookie の
// 型（module augmentation）が付きます。実際の plugin 登録は src/main.ts で行います。
import type { CookieSerializeOptions } from '@fastify/cookie';
// FastifyReply は Set-Cookie header を書き込む対象の response オブジェクトです。
import { FastifyReply } from 'fastify';
// JWT_ACCESS_TOKEN_TTL_SECONDS を access_token Cookie の Max-Age に使い、トークンと Cookie の寿命を揃えます。
// REFRESH_TOKEN_TTL_SECONDS（14 日）は refresh_token Cookie の Max-Age です（ADR-0012）。
import {
  JWT_ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} from '../config';

// AUTH_COOKIE_NAME はアクセストークンを保持する Cookie 名です。
// JwtAuthGuard の Cookie fallback もこの名前を参照します。
export const AUTH_COOKIE_NAME = 'access_token';

// REFRESH_COOKIE_NAME はリフレッシュトークンを保持する Cookie 名です（ADR-0012 決定）。
// アクセストークンとは名前・Path・Max-Age を分離します。
export const REFRESH_COOKIE_NAME = 'refresh_token';

// REFRESH_COOKIE_PATH は refresh_token Cookie をブラウザが送信するパスの限定です。
// ブラウザは常に /api/* で API を呼ぶ（CloudFront 統合オリジン / next rewrite）ため、
// /api/auth に絞ることで refresh / logout 系以外のリクエストにリフレッシュトークンが同乗しません（ADR-0012）。
const REFRESH_COOKIE_PATH = '/api/auth';

// authCookieOptions はアクセストークン Cookie の属性を返します。
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

// refreshCookieOptions はリフレッシュトークン Cookie の属性を返します。
// httpOnly / secure / sameSite はアクセストークンと同方針で、Path と Max-Age だけを分けます。
function refreshCookieOptions(): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE !== 'false',
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_TOKEN_TTL_SECONDS,
  };
}

// setAuthCookie は login / signup / refresh 成功時にアクセストークンを Set-Cookie で発行します。
export function setAuthCookie(reply: FastifyReply, accessToken: string): void {
  reply.setCookie(AUTH_COOKIE_NAME, accessToken, authCookieOptions());
}

// clearAuthCookie は logout 時にアクセストークン Cookie を破棄します。
// 発行時と同じ属性（特に path）で消さないとブラウザが別 Cookie とみなすため、options を共有します。
export function clearAuthCookie(reply: FastifyReply): void {
  reply.clearCookie(AUTH_COOKIE_NAME, authCookieOptions());
}

// setRefreshCookie は login / signup / refresh 成功時にリフレッシュトークンを Set-Cookie で発行します。
export function setRefreshCookie(reply: FastifyReply, refreshToken: string): void {
  reply.setCookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
}

// clearRefreshCookie は logout / refresh 失敗時にリフレッシュトークン Cookie を破棄します。
export function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
}
