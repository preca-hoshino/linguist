// src/admin/provider-models.ts — 提供商模型 CRUD API

import type { Request, Response } from 'express';
import { Router } from 'express';
import { db } from '../db';
import { generateShortId } from '../db';
import { GatewayError, buildUpdateSet, createLogger, logColors } from '../utils';
import { handleError } from '../users/error-formatting';

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
  is_active?: boolean | undefined;
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

const router = Router();

// ==================== 列出所有提供商模型 ====================
router.get('/', async (req: Request, res: Response) => {
  try {
    const providerId = req.query['provider_id'];
    logger.debug({ providerId: providerId ?? 'all' }, 'Listing provider models');

    let sql = `
      SELECT pm.id, pm.provider_id, pm.name, pm.model_type, pm.capabilities, pm.parameters,
             pm.is_active, pm.created_at, pm.updated_at,
             p.name AS provider_name, p.kind AS provider_kind
      FROM provider_models pm
      JOIN providers p ON pm.provider_id = p.id
    `;
    const values: unknown[] = [];

    if (typeof providerId === 'string' && providerId !== '') {
      sql += ' WHERE pm.provider_id = $1';
      values.push(providerId);
    }

    sql += ' ORDER BY pm.created_at DESC';

    const result = await db.query(sql, values);
    logger.debug({ count: result.rowCount }, 'Provider models listed');
    res.json(result.rows);
  } catch (err) {
    handleError(err, res);
  }
});

// ==================== 创建提供商模型 ====================
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body as ProviderModelBody;
    const { provider_id, name, model_type, capabilities, parameters } = body;
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

    // 校验 provider 存在
    const providerCheck = await db.query('SELECT id FROM providers WHERE id = $1', [provider_id]);
    if (providerCheck.rowCount === 0) {
      throw new GatewayError(404, 'not_found', `Provider ${provider_id} not found`);
    }

    const result = await db.query(
      `INSERT INTO provider_models (id, provider_id, name, model_type, capabilities, parameters)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, provider_id, name, model_type, capabilities, parameters, is_active, created_at, updated_at`,
      [
        await generateShortId('provider_models'),
        provider_id,
        name,
        model_type,
        capabilities ?? [],
        JSON.stringify(parameters ?? {}),
      ],
    );

    const created = result.rows[0];
    logger.info({ id: created?.['id'], name, model_type, provider_id }, 'Provider model created');
    res.status(201).json(result.rows[0]);
  } catch (err) {
    handleError(err, res);
  }
});

// ==================== 更新提供商模型 ====================
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const body = req.body as ProviderModelBody;
    const { name, model_type, capabilities, parameters, is_active } = body;
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

    const update = buildUpdateSet({
      name,
      model_type,
      capabilities,
      parameters: parameters !== undefined ? JSON.stringify(parameters) : undefined,
      is_active,
    });

    if (!update) {
      throw new GatewayError(400, 'invalid_request', 'No fields to update');
    }

    update.values.push(id);
    const result = await db.query(
      `UPDATE provider_models SET ${update.setClause} WHERE id = $${String(update.nextIdx)}
       RETURNING id, provider_id, name, model_type, capabilities, parameters, is_active, created_at, updated_at`,
      update.values,
    );

    if (result.rowCount === 0) {
      throw new GatewayError(404, 'not_found', `Provider model ${id} not found`);
    }

    logger.info({ id, fields: update.values.length - 1 }, 'Provider model updated');
    res.json(result.rows[0]);
  } catch (err) {
    handleError(err, res);
  }
});

// ==================== 删除提供商模型 ====================
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    logger.debug({ id }, 'Deleting provider model');
    const result = await db.query('DELETE FROM provider_models WHERE id = $1 RETURNING id', [id]);

    if (result.rowCount === 0) {
      throw new GatewayError(404, 'not_found', `Provider model ${id} not found`);
    }

    logger.info({ id }, 'Provider model deleted');
    res.json({ deleted: true, id });
  } catch (err) {
    handleError(err, res);
  }
});

export default router;
