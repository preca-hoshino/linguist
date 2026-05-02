// src/admin/idempotency.ts — 管理 API 幂等性中间件
// 基于 Stripe API 设计哲学实现幂等性

import type { NextFunction, Request, Response } from 'express';
import { db } from '../db';
import { createLogger, logColors } from '../utils';

const logger = createLogger('Admin:Idempotency', logColors.magenta);

export async function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const idempotencyKey = req.header('Idempotency-Key');

  if (req.method !== 'POST' || idempotencyKey === undefined || idempotencyKey === '') {
    next();
    return;
  }

  try {
    const result = await db.query(
      `SELECT response_code, response_body FROM idempotency_keys WHERE idempotency_key = $1`,
      [idempotencyKey],
    );

    if (result.rowCount !== null && result.rowCount > 0) {
      logger.info(`Idempotency key hit: ${idempotencyKey}`);
      const row = result.rows[0];
      if (row) {
        res.status(row.response_code as number).json(row.response_body);
        return;
      }
    }

    const originalJson = res.json;

    // biome-ignore lint/suspicious/noExplicitAny: Express res.json signature requires any
    res.json = function (this: Response, body: any): Response {
      const statusCode = res.statusCode;

      // 异步记录响应，不阻挡客户端返回
      db.query(
        `INSERT INTO idempotency_keys (idempotency_key, request_path, response_code, response_body)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [idempotencyKey, req.path, statusCode, JSON.stringify(body)],
      ).catch((err: unknown) => {
        logger.error(
          err instanceof Error ? err : new Error(String(err)),
          `Failed to save idempotency key: ${idempotencyKey}`,
        );
      });

      return originalJson.call(this, body);
    };

    next();
  } catch (err) {
    next(err);
  }
}
