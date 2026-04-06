// src/admin/provider-models.ts — 提供商模型 CRUD API

import type { Request, Response } from 'express';
import { Router } from 'express';
import { db, generateShortId } from '@/db';
import { buildUpdateSet, createLogger, GatewayError, logColors } from '@/utils';
import { handleAdminError } from './error';

const logger = createLogger('Admin:ProviderModels', logColors.bold + logColors.blue);

/** Chat 模型允许的能力标识（视觉 / 联网 / 思考 / 工具） */
const CHAT_CAPABILITIES = ['vision', 'web_search', 'thinking', 'tools'] as const;

/** Embedding 模型允许的能力标识（多模态 / 稀疏向量） */
const EMBEDDING_CAPABILITIES = ['multimodal', 'sparse_vector'] as const;

/** 按 model_type 索引的能力标识白名单 */
const CAPABILITIES_BY_TYPE: Record<string, readonly string[]> = {
  chat: CHAT_CAPABILITIES,
  embedding: EMBEDDING_CAPABILITIES,
};

/** 提供商模型请求体类型 */
interface ProviderModelBody {
  provider_id?: string | undefined;
  name?: string | undefined;
  model_type?: string | undefined;
  capabilities?: string[] | undefined;
  parameters?: Record<string, unknown> | undefined;
  max_tokens?: number | undefined;
  is_active?: boolean | undefined;
  pricing_tiers?: PricingTierInput[] | undefined;
  rpm_limit?: number | null | undefined;
  tpm_limit?: number | null | undefined;
}

/**
 * 阶梯计费输入类型（用于请求体校验）
 * 阶梯范围单位：K Tokens（startTokens/maxTokens 以 1K 为单位）
 * 价格单位：每百万 Token（CNY）
 */
interface PricingTierInput {
  startTokens?: number;
  maxTokens?: number | null;
  /** 每百万 Token 输入价格（CNY） */
  inputPrice?: number;
  /** 每百万 Token 输出价格（CNY） */
  outputPrice?: number;
  /** 每百万 Token 缓存命中价格（CNY） */
  cachePrice?: number;
}

/**
 * 校验阶梯计费配置
 * 确保价格非负、startTokens 递增、不超过 maxTokens 等等
 */
function validatePricingTiers(tiers: PricingTierInput[], maxTokens: number): void {
  for (const [i, tier] of tiers.entries()) {
    if (typeof tier.startTokens !== 'number' || tier.startTokens < 0) {
      throw new GatewayError(
        400,
        'invalid_request',
        `pricing_tiers[${String(i)}].startTokens must be a non-negative number`,
      );
    }
    if (tier.startTokens > maxTokens) {
      throw new GatewayError(
        400,
        'invalid_request',
        `pricing_tiers[${String(i)}].startTokens cannot exceed provider model max_tokens (${String(maxTokens)})`,
      );
    }
    if (
      tier.maxTokens !== null &&
      (typeof tier.maxTokens !== 'number' || tier.maxTokens < tier.startTokens || tier.maxTokens > maxTokens)
    ) {
      throw new GatewayError(
        400,
        'invalid_request',
        `pricing_tiers[${String(i)}].maxTokens must be between startTokens and max_tokens (${String(maxTokens)})`,
      );
    }
    if (typeof tier.inputPrice !== 'number' || tier.inputPrice < 0) {
      throw new GatewayError(
        400,
        'invalid_request',
        `pricing_tiers[${String(i)}].inputPrice must be a non-negative number`,
      );
    }
    if (typeof tier.outputPrice !== 'number' || tier.outputPrice < 0) {
      throw new GatewayError(
        400,
        'invalid_request',
        `pricing_tiers[${String(i)}].outputPrice must be a non-negative number`,
      );
    }
    if (typeof tier.cachePrice !== 'number' || tier.cachePrice < 0) {
      throw new GatewayError(
        400,
        'invalid_request',
        `pricing_tiers[${String(i)}].cachePrice must be a non-negative number`,
      );
    }
  }
  // 检查 startTokens 递增
  const sorted = [...tiers].toSorted((a, b) => (a.startTokens ?? 0) - (b.startTokens ?? 0));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (prev !== undefined && curr !== undefined && (prev.startTokens ?? 0) === (curr.startTokens ?? 0)) {
      throw new GatewayError(400, 'invalid_request', `Duplicate startTokens value: ${String(curr.startTokens)}`);
    }
  }
}

/**
 * 校验模型能力标识列表
 * 根据 modelType 选择对应白名单进行校验
 */
function validateCapabilities(modelType: string, capabilities: string[]): void {
  const allowed = CAPABILITIES_BY_TYPE[modelType];
  if (!allowed) {
    return;
  }
  const invalid = capabilities.filter((c) => !allowed.includes(c));
  if (invalid.length > 0) {
    throw new GatewayError(
      400,
      'invalid_request',
      `Invalid ${modelType} capability values: ${invalid.join(', ')}. Allowed: ${allowed.join(', ')}`,
    );
  }
}

const router: Router = Router();

// ==================== 列出所有提供商模型 ====================
router.get('/', async (req: Request, res: Response) => {
  try {
    const { provider_id, search, limit, offset } = req.query;
    const limitNum = typeof limit === 'string' && limit !== '' ? Math.min(Number.parseInt(limit, 10), 100) : 10;
    const offsetNum = typeof offset === 'string' && offset !== '' ? Number.parseInt(offset, 10) : 0;

    logger.debug(
      { providerId: provider_id ?? 'all', search, limit: limitNum, offset: offsetNum },
      'Listing provider models',
    );

    const conditions: string[] = [];
    const values: unknown[] = [];

    if (typeof provider_id === 'string' && provider_id !== '') {
      conditions.push(`pm.provider_id = $${String(values.length + 1)}`);
      values.push(provider_id);
    }

    if (typeof search === 'string' && search.trim() !== '') {
      conditions.push(
        `(pm.name ILIKE $${String(values.length + 1)} OR pm.model_type ILIKE $${String(
          values.length + 1,
        )} OR p.name ILIKE $${String(values.length + 1)})`,
      );
      values.push(`%${search.trim()}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
      SELECT pm.id, pm.provider_id, pm.name, pm.model_type, pm.capabilities, pm.parameters,
             pm.max_tokens, pm.is_active, pm.pricing_tiers, pm.rpm_limit, pm.tpm_limit,
             pm.created_at, pm.updated_at,
             p.name AS provider_name, p.kind AS provider_kind,
             COUNT(*) OVER() AS full_count
      FROM provider_models pm
      JOIN providers p ON pm.provider_id = p.id
      ${whereClause}
      ORDER BY pm.created_at DESC
      LIMIT $${String(values.length + 1)} OFFSET $${String(values.length + 2)}
    `;

    values.push(limitNum, offsetNum);

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

    logger.debug({ count: data.length, total, has_more: hasMore }, 'Provider models listed');
    res.json({ object: 'list', data, total, has_more: hasMore });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 查询单个提供商模型 ====================
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    logger.debug({ id }, 'Getting provider model by ID');

    const result = await db.query(
      `SELECT pm.id, pm.provider_id, pm.name, pm.model_type, pm.capabilities, pm.parameters,
              pm.max_tokens, pm.is_active, pm.pricing_tiers, pm.rpm_limit, pm.tpm_limit,
              pm.created_at, pm.updated_at,
              p.name AS provider_name, p.kind AS provider_kind
       FROM provider_models pm
       JOIN providers p ON pm.provider_id = p.id
       WHERE pm.id = $1`,
      [id],
    );

    if (result.rowCount === 0) {
      throw new GatewayError(404, 'not_found', `Provider model ${id} not found`);
    }

    res.json({ object: 'provider_model', ...result.rows[0] });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 创建提供商模型 ====================
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body as ProviderModelBody;
    const { provider_id, name, model_type, capabilities, parameters, max_tokens, pricing_tiers, rpm_limit, tpm_limit } =
      body;
    logger.debug({ provider_id, name, model_type }, 'Creating provider model');

    if (
      typeof provider_id !== 'string' ||
      provider_id === '' ||
      typeof name !== 'string' ||
      name === '' ||
      typeof model_type !== 'string' ||
      model_type === ''
    ) {
      throw new GatewayError(400, 'invalid_request', 'Fields provider_id, name, model_type are required');
    }

    if (!['chat', 'embedding'].includes(model_type)) {
      throw new GatewayError(400, 'invalid_request', 'model_type must be "chat" or "embedding"');
    }

    // 校验模型能力标识
    if (Array.isArray(capabilities) && capabilities.length > 0) {
      validateCapabilities(model_type, capabilities);
    }

    // 校验阶梯计费配置
    const finalMaxTokens = typeof max_tokens === 'number' && max_tokens > 0 ? max_tokens : 128;
    if (Array.isArray(pricing_tiers) && pricing_tiers.length > 0) {
      validatePricingTiers(pricing_tiers, finalMaxTokens);
    }

    // 校验 provider 存在
    const providerCheck = await db.query('SELECT id FROM providers WHERE id = $1', [provider_id]);
    if (providerCheck.rowCount === 0) {
      throw new GatewayError(404, 'not_found', `Provider ${provider_id} not found`);
    }

    const result = await db.query(
      `INSERT INTO provider_models (id, provider_id, name, model_type, capabilities, parameters, max_tokens, pricing_tiers, rpm_limit, tpm_limit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, provider_id, name, model_type, capabilities, parameters, max_tokens, pricing_tiers, rpm_limit, tpm_limit, is_active, created_at, updated_at`,
      [
        await generateShortId('provider_models'),
        provider_id,
        name,
        model_type,
        capabilities ?? [],
        JSON.stringify(parameters ?? {}),
        finalMaxTokens,
        JSON.stringify(pricing_tiers ?? []),
        rpm_limit ?? null,
        tpm_limit ?? null,
      ],
    );

    const created = result.rows[0];
    logger.info({ id: created?.id, name, model_type, provider_id }, 'Provider model created');
    res.status(201).json({ object: 'provider_model', ...result.rows[0] });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 更新提供商模型 ====================
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const body = req.body as ProviderModelBody;
    const { name, model_type, capabilities, parameters, max_tokens, is_active, pricing_tiers, rpm_limit, tpm_limit } =
      body;
    logger.debug({ id }, 'Updating provider model');

    if (model_type !== undefined && !['chat', 'embedding'].includes(model_type)) {
      throw new GatewayError(400, 'invalid_request', 'model_type must be "chat" or "embedding"');
    }

    // 校验模型能力标识（更新时根据实际 model_type 选择对应白名单）
    if (Array.isArray(capabilities) && capabilities.length > 0) {
      let effectiveType = model_type;
      if (effectiveType === undefined) {
        const currentRow = await db.query('SELECT model_type FROM provider_models WHERE id = $1', [id]);
        effectiveType = (currentRow.rows[0] as { model_type: string } | undefined)?.model_type;
      }
      if (effectiveType !== undefined && effectiveType !== '') {
        validateCapabilities(effectiveType, capabilities);
      }
    }

    // 校验阶梯计费配置
    if (Array.isArray(pricing_tiers) && pricing_tiers.length > 0) {
      let currentMaxTokens = max_tokens;
      if (typeof currentMaxTokens !== 'number' || currentMaxTokens <= 0) {
        const row = await db.query('SELECT max_tokens FROM provider_models WHERE id = $1', [id]);
        currentMaxTokens = (row.rows[0]?.max_tokens as number | undefined) ?? 128;
      }
      validatePricingTiers(pricing_tiers, currentMaxTokens);
    }

    const update = buildUpdateSet({
      name,
      model_type,
      capabilities,
      parameters: parameters === undefined ? undefined : JSON.stringify(parameters),
      max_tokens,
      is_active,
      pricing_tiers: pricing_tiers === undefined ? undefined : JSON.stringify(pricing_tiers),
      rpm_limit: rpm_limit === undefined ? undefined : rpm_limit,
      tpm_limit: tpm_limit === undefined ? undefined : tpm_limit,
    });

    if (!update) {
      throw new GatewayError(400, 'invalid_request', 'No fields to update');
    }

    update.values.push(id);
    const result = await db.query(
      `UPDATE provider_models SET ${update.setClause} WHERE id = $${String(update.nextIdx)}
       RETURNING id, provider_id, name, model_type, capabilities, parameters, max_tokens, pricing_tiers, rpm_limit, tpm_limit, is_active, created_at, updated_at`,
      update.values,
    );

    if (result.rowCount === 0) {
      throw new GatewayError(404, 'not_found', `Provider model ${id} not found`);
    }

    logger.info({ id, fields: update.values.length - 1 }, 'Provider model updated');
    res.json({ object: 'provider_model', ...result.rows[0] });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 删除提供商模型 ====================
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    logger.debug({ id }, 'Deleting provider model');
    const result = await db.query('DELETE FROM provider_models WHERE id = $1 RETURNING id', [id]);

    if (result.rowCount === 0) {
      throw new GatewayError(404, 'not_found', `Provider model ${id} not found`);
    }

    logger.info({ id }, 'Provider model deleted');
    res.json({ id, object: 'provider_model', deleted: true });
  } catch (error) {
    handleAdminError(error, res);
  }
});

export { router as providerModelsRouter };
