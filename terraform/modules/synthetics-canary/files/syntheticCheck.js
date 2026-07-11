// CloudWatch Synthetics canary script（Issue #256）。
//
// CloudFront 経由の外形監視。read-only の代表 3 endpoint を multi-step API canary
// （組み込みの executeHttpStep）で順に確認する。認証・secret を要する操作、
// 副作用のある操作（POST 等）は対象外。
//
// - healthzCheck: /healthz 相当の軽量到達確認（DB 等の依存に触れない liveness）
// - frontendHtmlCheck: frontend（Next.js SSR）の HTML 到達確認
// - apiReadEndpointCheck: API の代表 read endpoint（GET /events。認証不要。L-10 参照）
//
// APP_FQDN（CloudFront distribution の alias ドメイン）は run_config.environment_variables
// で Terraform から注入する。CloudFront の /api/* ルーティングはアプリ側の
// stripApiPrefix（src/api-prefix.ts）で吸収されるため、/api/healthz は
// アプリの /healthz へ写像される（ADR-0011 決定 2）。

const synthetics = require('@aws/synthetics-puppeteer');
const log = require('@aws/synthetics-logger');

const APP_FQDN = process.env.APP_FQDN;

// 1 step 分の GET リクエストを実行し、2xx 以外は例外にする。
// executeHttpStep の既定挙動（callback 省略時）は 200-299 判定だが、
// ここでは失敗理由をログへ残すため明示的に callback を渡す。
const httpGetStep = async (stepName, path) => {
  const requestOptions = {
    hostname: APP_FQDN,
    method: 'GET',
    path,
    port: 443,
    protocol: 'https:',
    headers: {
      'User-Agent': synthetics.getCanaryUserAgentString(),
    },
  };

  const validate = async (res) => {
    return new Promise((resolve, reject) => {
      if (res.statusCode < 200 || res.statusCode > 299) {
        reject(new Error(`${stepName} failed: ${res.statusCode} ${res.statusMessage}`));
        return;
      }

      res.on('data', () => {
        // レスポンス本体は検証しない（到達確認のみ）。ストリームは消費してリークを防ぐ。
      });
      res.on('end', () => resolve());
    });
  };

  await synthetics.executeHttpStep(stepName, requestOptions, validate);
};

const syntheticCheckBlueprint = async () => {
  if (!APP_FQDN) {
    throw new Error('APP_FQDN environment variable is not set');
  }

  log.info(`Running synthetic check against https://${APP_FQDN}`);

  // 1. healthz: 軽量到達確認
  await httpGetStep('healthzCheck', '/api/healthz');

  // 2. frontend HTML: SSR フロントエンドの到達確認
  await httpGetStep('frontendHtmlCheck', '/');

  // 3. API 代表 read endpoint: 認証不要の読み取り専用 endpoint
  await httpGetStep('apiReadEndpointCheck', '/api/events');
};

exports.handler = async () => {
  return await syntheticCheckBlueprint();
};
