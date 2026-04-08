// src/admin/copilot-oauth.ts — Copilot OAuth Device Flow 管理 API
//
// 为管理员提供 Copilot OAuth Device Flow 授权端点。
// 路由挂载在 /api/oauth/copilot/ 下（通过 adminRouter 传递 /api 前缀）。
// 响应格式遵循 Stripe API 风格（object 字段标识资源类型）。
//
// 为未来不同厂商的 OAuth 流程保持独立文件：
// - 本文件：Copilot (GitHub)
// - 未来如需：google-oauth.ts, azure-oauth.ts 等

import type { Request, Response } from 'express';
import { Router } from 'express';
import { db } from '@/db';
import { COPILOT_CLIENT_ID, GITHUB_ACCESS_TOKEN_URL, GITHUB_DEVICE_CODE_URL } from '@/providers/copilot/constants';
import { createLogger, GatewayError, logColors } from '@/utils';
import { handleAdminError } from './error';

const logger = createLogger('Admin:Copilot:OAuth', logColors.bold + logColors.cyan);

const router: Router = Router();

/** GitHub Device Code API 响应结构 */
interface GitHubDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

/** GitHub Access Token API 响应结构 */
interface GitHubAccessTokenResponse {
  access_token?: string;
  error?: string;
}

/** GitHub User API 响应结构 */
interface GitHubUserResponse {
  login: string;
}

// ==================== POST /device-codes — 发起 Device Flow ====================

/**
 * 创建 Copilot OAuth Device Code
 *
 * 无需请求体，使用硬编码的 VS Code Copilot client_id。
 *
 * Response 201:
 * {
 *   "object": "device_code",
 *   "device_code": "xxx",
 *   "user_code": "XXXX-XXXX",
 *   "verification_uri": "https://github.com/login/device",
 *   "expires_in": 900,
 *   "interval": 5
 * }
 */
router.post('/device-codes', async (_req: Request, res: Response) => {
  try {
    logger.debug('Initiating Copilot OAuth Device Flow');

    const response = await fetch(GITHUB_DEVICE_CODE_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: COPILOT_CLIENT_ID,
        scope: 'read:user',
      }).toString(),
    });

    if (!response.ok) {
      const body = await response.text();
      logger.error({ status: response.status, body }, 'GitHub device code request failed');
      throw new GatewayError(
        502,
        'provider_error',
        `GitHub device code request failed: HTTP ${String(response.status)}`,
      );
    }

    const data = (await response.json()) as GitHubDeviceCodeResponse;

    logger.info({ userCode: data.user_code }, 'Copilot device code created');

    res.status(201).json({
      object: 'device_code',
      device_code: data.device_code,
      user_code: data.user_code,
      verification_uri: data.verification_uri,
      expires_in: data.expires_in,
      interval: data.interval,
    });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== POST /device-codes/:device_code/poll — 轮询换取 Token ====================

/** poll 端点请求体 */
interface PollRequestBody {
  provider_id?: unknown;
}

/**
 * 轮询 OAuth 授权状态，换取 access_token
 *
 * Request: { "provider_id": "..." }  ← 可选
 *
 * provider_id 为可选参数：
 * - 有 provider_id：授权成功时自动写入数据库，返回脱敏的 token_prefix
 * - 无 provider_id：授权成功时返回完整 access_token（供前端创建模式暂存）
 *
 * Response 200 - pending:  { "object": "oauth_token", "status": "pending" }
 * Response 200 - complete: { "object": "oauth_token", "status": "complete", ... }
 * Response 200 - expired:  { "object": "oauth_token", "status": "expired" }
 */
router.post('/device-codes/:device_code/poll', async (req: Request, res: Response) => {
  try {
    const deviceCode = req.params.device_code as string;
    const body = req.body as PollRequestBody;
    const providerId = typeof body.provider_id === 'string' && body.provider_id !== '' ? body.provider_id : undefined;

    logger.debug({ deviceCode: `${deviceCode.slice(0, 8)}...`, providerId }, 'Polling Copilot OAuth token');

    // 如果有 provider_id，验证 provider 存在
    if (providerId !== undefined) {
      const providerResult = await db.query('SELECT id FROM providers WHERE id = $1', [providerId]);
      if (providerResult.rowCount === 0) {
        throw new GatewayError(404, 'not_found', `Provider ${providerId} not found`);
      }
    }

    // 轮询 GitHub 获取 access_token
    const response = await fetch(GITHUB_ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: COPILOT_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
    });

    if (!response.ok) {
      const errBody = await response.text();
      logger.error({ status: response.status, body: errBody }, 'GitHub access token request failed');
      throw new GatewayError(
        502,
        'provider_error',
        `GitHub access token request failed: HTTP ${String(response.status)}`,
      );
    }

    const data = (await response.json()) as GitHubAccessTokenResponse;

    // Case: 成功获取 access_token
    if (typeof data.access_token === 'string' && data.access_token !== '') {
      const accessToken = data.access_token;

      if (providerId !== undefined) {
        // 有 provider_id：直接写入数据库，返回脱敏前缀
        await db.query(
          `UPDATE providers
           SET credential_type = 'copilot',
               credential = $1::jsonb,
               updated_at = NOW()
           WHERE id = $2`,
          [JSON.stringify({ accessToken }), providerId],
        );
        logger.info({ providerId }, 'Copilot access token saved to provider');

        res.json({
          object: 'oauth_token',
          status: 'complete',
          provider_id: providerId,
          token_prefix: accessToken.slice(0, 12),
        });
      } else {
        // 无 provider_id：返回完整 token 供前端暂存
        logger.info('Copilot access token obtained (no provider_id, returning to client)');
        res.json({
          object: 'oauth_token',
          status: 'complete',
          provider_id: null,
          access_token: accessToken,
        });
      }
      return;
    }

    // Case: authorization_pending 或 slow_down — 用户尚未完成授权
    if (data.error === 'authorization_pending' || data.error === 'slow_down') {
      res.json({ object: 'oauth_token', status: 'pending' });
      return;
    }

    // Case: 已过期或被拒绝
    logger.warn({ error: data.error }, 'Copilot OAuth authorization failed or expired');
    res.json({ object: 'oauth_token', status: 'expired' });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== POST /verify — 验证已有凭证 ====================

/** verify 端点请求体 */
interface VerifyRequestBody {
  provider_id?: unknown;
}

/** providers 表查询行结构 */
interface ProviderCredentialRow {
  credential_type: string;
  credential: Record<string, unknown>;
}

/**
 * 验证 provider 存储的 access_token 是否仍然有效
 *
 * Request: { "provider_id": "..." }
 *
 * Response 200 - valid:   { "object": "oauth_verification", "valid": true, "github_login": "username" }
 * Response 200 - invalid: { "object": "oauth_verification", "valid": false }
 */
router.post('/verify', async (req: Request, res: Response) => {
  try {
    const body = req.body as VerifyRequestBody;
    const providerId = body.provider_id;

    if (typeof providerId !== 'string' || providerId === '') {
      throw new GatewayError(400, 'invalid_request', 'Field "provider_id" is required and must be a non-empty string');
    }

    logger.debug({ providerId }, 'Verifying Copilot OAuth token');

    // 查询 provider 的凭证
    const result = await db.query(`SELECT credential_type, credential FROM providers WHERE id = $1`, [providerId]);

    if (result.rowCount === 0) {
      throw new GatewayError(404, 'not_found', `Provider ${providerId} not found`);
    }

    const row = result.rows[0] as unknown as ProviderCredentialRow;

    if (
      row.credential_type !== 'copilot' ||
      typeof row.credential.accessToken !== 'string' ||
      row.credential.accessToken === ''
    ) {
      res.json({ object: 'oauth_verification', valid: false });
      return;
    }

    const accessToken = row.credential.accessToken;

    // 用 access_token 调用 GitHub user API 验证有效性
    const ghResponse = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `token ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!ghResponse.ok) {
      logger.debug({ providerId, status: ghResponse.status }, 'Copilot access token is invalid');
      res.json({ object: 'oauth_verification', valid: false });
      return;
    }

    const user = (await ghResponse.json()) as GitHubUserResponse;
    logger.info({ providerId, githubLogin: user.login }, 'Copilot access token verified');

    res.json({
      object: 'oauth_verification',
      valid: true,
      github_login: user.login,
    });
  } catch (error) {
    handleAdminError(error, res);
  }
});

export { router as copilotOAuthRouter };
