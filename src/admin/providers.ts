// src/admin/providers.ts — 提供商 CRUD API

import type { Request, Response } from 'express';
import { Router } from 'express';
import { db, generateShortId } from '@/db';
import { getRegisteredProviderKinds } from '@/model/http/providers';
import type { ProviderAdvancedConfig } from '@/types';
import { DEFAULT_PROVIDER_CONFIG } from '@/types';
import { buildUpdateSet, createLogger, GatewayError, logColors } from '@/utils';
import { handleAdminError } from './error';

const logger = createLogger('Admin:Providers', logColors.bold + logColors.blue);

/** 提供商请求体类型 */
interface ProviderBody {
  name?: string | undefined;
  kind?: string | undefined;
  base_url?: string | undefined;
  /** 凭证类型 */
  credential_type?: 'api_key' | 'oauth2' | 'copilot' | 'none' | undefined;
  /** 凭证数据（JSONB） */
  credential?: Record<string, unknown> | undefined;
  /** 高级配置 */
  config?: Partial<ProviderAdvancedConfig> | undefined;
}

/** SELECT 列常量（不含 is_active） */
const SELECT_COLUMNS = 'id, name, kind, base_url, credential_type, credential, config, created_at, updated_at';

const router: Router = Router();

// ==================== 列出所有提供商 ====================
router.get('/', async (req: Request, res: Response) => {
  try {
    const { search, limit, offset } = req.query;

    const limitNum = typeof limit === 'string' && limit !== '' ? Math.min(Number.parseInt(limit, 10), 100) : 10;
    const offsetNum = typeof offset === 'string' && offset !== '' ? Number.parseInt(offset, 10) : 0;

    const conditions: string[] = [];
    const values: unknown[] = [];

    if (typeof search === 'string' && search.trim() !== '') {
      conditions.push(`(name ILIKE $${String(values.length + 1)} OR kind ILIKE $${String(values.length + 1)})`);
      values.push(`%${search.trim()}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
      SELECT ${SELECT_COLUMNS}, COUNT(*) OVER() AS full_count
      FROM model_providers
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${String(values.length + 1)} OFFSET $${String(values.length + 2)}
    `;
    values.push(limitNum, offsetNum);

    logger.debug({ search, limit: limitNum, offset: offsetNum }, 'Listing providers');
    const result = await db.query(sql, values);

    const rows = result.rows;
    const firstRow = rows[0] as { full_count: string } | undefined;
    const total = firstRow ? Number.parseInt(firstRow.full_count, 10) : 0;

    const data = rows.map((row) => {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      const { full_count: _full_count, ...rest } = row;
      return rest;
    });

    const hasMore = offsetNum + data.length < total;

    logger.debug({ count: data.length, total, has_more: hasMore }, 'Providers listed');
    res.json({ object: 'list', data, total, has_more: hasMore });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 查询单个提供商 ====================
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    logger.debug({ id }, 'Getting provider by ID');
    const result = await db.query(`SELECT ${SELECT_COLUMNS} FROM model_providers WHERE id = $1`, [id]);

    if (result.rowCount === 0) {
      throw new GatewayError(404, 'not_found', `Provider ${id} not found`);
    }

    res.json({ object: 'provider', ...result.rows[0] });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 创建提供商 ====================
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body as ProviderBody;
    const { name, kind, base_url, credential_type, credential, config } = body;
    logger.debug({ name, kind }, 'Creating provider');

    if (typeof name !== 'string' || name === '' || typeof kind !== 'string' || kind === '') {
      throw new GatewayError(400, 'invalid_request', 'Fields name, kind are required');
    }

    if (typeof base_url !== 'string' || (base_url === '' && kind !== 'copilot')) {
      throw new GatewayError(400, 'invalid_request', 'Field base_url is required');
    }

    const validKinds = getRegisteredProviderKinds();
    if (!validKinds.has(kind)) {
      throw new GatewayError(
        400,
        'invalid_provider_kind',
        `Unknown provider kind '${kind}'. Valid kinds: ${[...validKinds].join(', ')}`,
      );
    }

    // 凭证处理：credential_type 默认 api_key，credential 默认空对象
    const finalCredentialType = credential_type ?? 'api_key';
    const finalCredential = credential ?? {};

    // 高级配置：合并用户传入值与默认值
    const finalConfig: ProviderAdvancedConfig = { ...DEFAULT_PROVIDER_CONFIG, ...config };

    const result = await db.query(
      `INSERT INTO model_providers (id, name, kind, base_url, credential_type, credential, config)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${SELECT_COLUMNS}`,
      [
        await generateShortId('model_providers'),
        name,
        kind,
        base_url,
        finalCredentialType,
        JSON.stringify(finalCredential),
        JSON.stringify(finalConfig),
      ],
    );

    const created = result.rows[0];
    logger.info({ id: created?.id, name, kind }, 'Provider created');
    res.status(201).json({ object: 'provider', ...result.rows[0] });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 更新提供商 ====================
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const body = req.body as ProviderBody;
    const { name, kind, base_url, credential_type, credential, config } = body;
    logger.debug({ id }, 'Updating provider');

    // 凭证防破坏处理：防止前端传回占位符覆盖真实的 credential
    let finalCredential = credential;
    if (
      finalCredential &&
      typeof finalCredential.accessToken === 'string' &&
      finalCredential.accessToken === '(saved)'
    ) {
      finalCredential = undefined;
    }

    const update = buildUpdateSet({
      name,
      kind,
      base_url,
      credential_type,
      credential: finalCredential === undefined ? undefined : JSON.stringify(finalCredential),
      config: config === undefined ? undefined : JSON.stringify({ ...DEFAULT_PROVIDER_CONFIG, ...config }),
    });

    if (!update) {
      throw new GatewayError(400, 'invalid_request', 'No fields to update');
    }

    update.values.push(id);
    const result = await db.query(
      `UPDATE model_providers SET ${update.setClause} WHERE id = $${String(update.nextIdx)}
       RETURNING ${SELECT_COLUMNS}`,
      update.values,
    );

    if (result.rowCount === 0) {
      throw new GatewayError(404, 'not_found', `Provider ${id} not found`);
    }

    logger.info({ id, fields: update.values.length - 1 }, 'Provider updated');
    res.json({ object: 'provider', ...result.rows[0] });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 删除提供商 ====================
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    logger.debug({ id }, 'Deleting provider');
    const result = await db.query('DELETE FROM model_providers WHERE id = $1 RETURNING id', [id]);

    if (result.rowCount === 0) {
      throw new GatewayError(404, 'not_found', `Provider ${id} not found`);
    }

    logger.info({ id }, 'Provider deleted');
    res.json({ id, object: 'provider', deleted: true });
  } catch (error) {
    handleAdminError(error, res);
  }
});

export { router as providersRouter };
