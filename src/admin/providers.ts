// src/admin/providers.ts — 提供商 CRUD API

import type { Request, Response } from 'express';
import { Router } from 'express';
import { db } from '../db';
import { generateShortId } from '../db';
import { getRegisteredProviderKinds } from '../providers';
import { GatewayError, buildUpdateSet, createLogger, logColors } from '../utils';
import { handleError } from '../users/error-formatting';

const logger = createLogger('Admin:Providers', logColors.bold + logColors.blue);

/** 提供商请求体类型 */
interface ProviderBody {
  name?: string | undefined;
  kind?: string | undefined;
  base_url?: string | undefined;
  api_key?: string | undefined;
  config?: Record<string, unknown> | undefined;
  is_active?: boolean | undefined;
}

const router = Router();

// ==================== 列出所有提供商 ====================
router.get('/', async (_req: Request, res: Response) => {
  try {
    logger.debug('Listing all providers');
    const result = await db.query(
      'SELECT id, name, kind, base_url, config, is_active, created_at, updated_at FROM providers ORDER BY created_at DESC',
    );
    logger.debug({ count: result.rowCount }, 'Providers listed');
    res.json(result.rows);
  } catch (err) {
    handleError(err, res);
  }
});

// ==================== 创建提供商 ====================
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body as ProviderBody;
    const { name, kind, base_url, api_key, config } = body;
    logger.debug({ name, kind }, 'Creating provider');

    if (
      typeof name !== 'string' ||
      name === '' ||
      typeof kind !== 'string' ||
      kind === '' ||
      typeof base_url !== 'string' ||
      base_url === '' ||
      typeof api_key !== 'string' ||
      api_key === ''
    ) {
      throw new GatewayError(400, 'invalid_request', 'Fields name, kind, base_url, api_key are required');
    }

    const validKinds = getRegisteredProviderKinds();
    if (!validKinds.has(kind)) {
      throw new GatewayError(
        400,
        'invalid_provider_kind',
        `Unknown provider kind '${kind}'. Valid kinds: ${[...validKinds].join(', ')}`,
      );
    }

    const result = await db.query(
      `INSERT INTO providers (id, name, kind, base_url, api_key, config)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, kind, base_url, config, is_active, created_at, updated_at`,
      [await generateShortId('providers'), name, kind, base_url, api_key, JSON.stringify(config ?? {})],
    );

    const created = result.rows[0];
    logger.info({ id: created?.['id'], name, kind }, 'Provider created');
    res.status(201).json(result.rows[0]);
  } catch (err) {
    handleError(err, res);
  }
});

// ==================== 更新提供商 ====================
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const body = req.body as ProviderBody;
    const { name, kind, base_url, api_key, config, is_active } = body;
    logger.debug({ id }, 'Updating provider');

    const update = buildUpdateSet({
      name,
      kind,
      base_url,
      api_key,
      config: config !== undefined ? JSON.stringify(config) : undefined,
      is_active,
    });

    if (!update) {
      throw new GatewayError(400, 'invalid_request', 'No fields to update');
    }

    update.values.push(id);
    const result = await db.query(
      `UPDATE providers SET ${update.setClause} WHERE id = $${String(update.nextIdx)}
       RETURNING id, name, kind, base_url, config, is_active, created_at, updated_at`,
      update.values,
    );

    if (result.rowCount === 0) {
      throw new GatewayError(404, 'not_found', `Provider ${id} not found`);
    }

    logger.info({ id, fields: update.values.length - 1 }, 'Provider updated');
    res.json(result.rows[0]);
  } catch (err) {
    handleError(err, res);
  }
});

// ==================== 删除提供商 ====================
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    logger.debug({ id }, 'Deleting provider');
    const result = await db.query('DELETE FROM providers WHERE id = $1 RETURNING id', [id]);

    if (result.rowCount === 0) {
      throw new GatewayError(404, 'not_found', `Provider ${id} not found`);
    }

    logger.info({ id }, 'Provider deleted');
    res.json({ deleted: true, id });
  } catch (err) {
    handleError(err, res);
  }
});

export default router;
