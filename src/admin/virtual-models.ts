// src/admin/virtual-models.ts — 虚拟模型 CRUD API

import type { Request, Response } from 'express';
import { Router } from 'express';
import { db, withTransaction } from '../db';
import { generateShortId } from '../db';
import { GatewayError, buildUpdateSet, buildBatchInsert, createLogger, logColors } from '../utils';
import { handleError } from '../users/error-formatting';

const logger = createLogger('Admin:VirtualModels', logColors.bold + logColors.blue);

const router = Router();

// ==================== 辅助：加载虚拟模型及其后端 ====================

/** 虚拟模型后端的数据库行（含关联的提供商模型/提供商名称） */
interface BackendRow {
  [key: string]: unknown;
  provider_model_id: string;
  weight: number;
  priority: number;
  provider_model_name?: string | undefined;
  provider_name?: string | undefined;
}

/** 虚拟模型的数据库行 */
interface VirtualModelRow {
  [key: string]: unknown;
  id: string;
  name: string;
  description: string;
  model_type: string;
  routing_strategy: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** 后端输入请求体 */
interface BackendInput {
  provider_model_id: string;
  weight?: number | undefined;
  priority?: number | undefined;
}

/** 虚拟模型请求体 */
interface VirtualModelBody {
  name?: string | undefined;
  description?: string | undefined;
  model_type?: string | undefined;
  routing_strategy?: string | undefined;
  is_active?: boolean | undefined;
  backends?: BackendInput[] | undefined;
}

const VALID_STRATEGIES = ['load_balance', 'failover'];

/** 按 ID 加载虚拟模型并附带其后端列表，不存在时返回 null */
async function loadVirtualModelWithBackends(
  vmId: string,
): Promise<(VirtualModelRow & { backends: BackendRow[] }) | null> {
  const vmResult = await db.query<VirtualModelRow>(
    'SELECT id, name, description, model_type, routing_strategy, is_active, created_at, updated_at FROM virtual_models WHERE id = $1',
    [vmId],
  );
  if (vmResult.rowCount === 0) {
    return null;
  }

  const vm = vmResult.rows[0];
  if (vm === undefined) {
    return null;
  }

  const backendsResult = await db.query<BackendRow>(
    `SELECT vmb.provider_model_id, vmb.weight, vmb.priority,
            pm.name AS provider_model_name, p.name AS provider_name
     FROM virtual_model_backends vmb
     JOIN provider_models pm ON vmb.provider_model_id = pm.id
     JOIN providers p ON pm.provider_id = p.id
     WHERE vmb.virtual_model_id = $1
     ORDER BY vmb.priority ASC, vmb.weight DESC`,
    [vmId],
  );

  return {
    ...vm,
    backends: backendsResult.rows,
  };
}

// ==================== 列出所有虚拟模型 ====================
router.get('/', async (_req: Request, res: Response) => {
  try {
    logger.debug('Listing all virtual models');
    const vmResult = await db.query<VirtualModelRow>(
      'SELECT id, name, description, model_type, routing_strategy, is_active, created_at, updated_at FROM virtual_models ORDER BY created_at DESC',
    );

    // 批量加载所有后端
    const backendResult = await db.query<BackendRow & { virtual_model_id: string }>(
      `SELECT vmb.virtual_model_id, vmb.provider_model_id, vmb.weight, vmb.priority,
              pm.name AS provider_model_name, p.name AS provider_name
       FROM virtual_model_backends vmb
       JOIN provider_models pm ON vmb.provider_model_id = pm.id
       JOIN providers p ON pm.provider_id = p.id
       ORDER BY vmb.priority ASC, vmb.weight DESC`,
    );

    // 分组
    const backendsByVm = new Map<string, BackendRow[]>();
    for (const row of backendResult.rows) {
      const list = backendsByVm.get(row.virtual_model_id) ?? [];
      list.push({
        provider_model_id: row.provider_model_id,
        weight: row.weight,
        priority: row.priority,
        provider_model_name: row.provider_model_name,
        provider_name: row.provider_name,
      });
      backendsByVm.set(row.virtual_model_id, list);
    }

    const result = vmResult.rows.map((vm) => ({
      ...vm,
      backends: backendsByVm.get(vm.id) ?? [],
    }));

    logger.debug({ count: result.length }, 'Virtual models listed');
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// ==================== 获取单个虚拟模型 ====================
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    logger.debug({ id }, 'Getting virtual model');
    const vm = await loadVirtualModelWithBackends(id);
    if (!vm) {
      throw new GatewayError(404, 'not_found', `Virtual model ${id} not found`);
    }
    res.json(vm);
  } catch (err) {
    handleError(err, res);
  }
});

// ==================== 创建虚拟模型 ====================
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body as VirtualModelBody;
    const { name, description, model_type, routing_strategy, backends } = body;
    logger.debug({ name, model_type, routingStrategy: routing_strategy }, 'Creating virtual model');

    if (typeof name !== 'string' || name === '') {
      throw new GatewayError(400, 'invalid_request', 'Field name is required');
    }

    if (typeof model_type !== 'string' || !['chat', 'embedding'].includes(model_type)) {
      throw new GatewayError(400, 'invalid_request', 'Field model_type is required and must be "chat" or "embedding"');
    }

    const strategy =
      typeof routing_strategy === 'string' && routing_strategy !== '' ? routing_strategy : 'load_balance';
    if (!VALID_STRATEGIES.includes(strategy)) {
      throw new GatewayError(400, 'invalid_request', 'routing_strategy must be one of: load_balance, failover');
    }

    if (!Array.isArray(backends) || backends.length === 0) {
      throw new GatewayError(400, 'invalid_request', 'At least one backend is required');
    }

    // 校验所有 provider_model_id 存在且 model_type 一致
    const pmIds: string[] = backends.map((b) => b.provider_model_id);
    const pmCheck = await db.query<{ id: string; model_type: string }>(
      `SELECT id, model_type FROM provider_models WHERE id = ANY($1)`,
      [pmIds],
    );
    if (pmCheck.rowCount !== pmIds.length) {
      const foundIds = new Set(pmCheck.rows.map((r) => r.id));
      const missing = pmIds.filter((pmId) => !foundIds.has(pmId));
      throw new GatewayError(404, 'not_found', `Provider model(s) not found: ${missing.join(', ')}`);
    }

    // 校验后端的 model_type 与虚拟模型一致
    const mismatch = pmCheck.rows.filter((r) => r.model_type !== model_type);
    if (mismatch.length > 0) {
      const ids = mismatch.map((r) => r.id).join(', ');
      throw new GatewayError(
        400,
        'model_type_mismatch',
        `Virtual model type is "${model_type}" but provider model(s) [${ids}] have a different type`,
      );
    }

    // 事务：插入虚拟模型 + 批量插入后端关联
    const id = await generateShortId('virtual_models');
    await withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO virtual_models (id, name, description, model_type, routing_strategy)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, name, description ?? '', model_type, strategy],
      );

      const backendRows = backends.map((b) => [id, b.provider_model_id, b.weight ?? 1, b.priority ?? 0]);
      const batch = buildBatchInsert(backendRows, 4);
      await tx.query(
        `INSERT INTO virtual_model_backends (virtual_model_id, provider_model_id, weight, priority)
         VALUES ${batch.valuesClause}`,
        batch.values,
      );
    });

    const result = await loadVirtualModelWithBackends(id);
    logger.info({ id, name, strategy, backendsCount: backends.length }, 'Virtual model created');
    res.status(201).json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// ==================== 更新虚拟模型 ====================
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const body = req.body as VirtualModelBody;
    const { name, description, model_type, routing_strategy, backends, is_active } = body;
    logger.debug({ id }, 'Updating virtual model');

    // 检查虚拟模型是否存在
    const existCheck = await db.query<{ id: string; model_type: string }>(
      'SELECT id, model_type FROM virtual_models WHERE id = $1',
      [id],
    );
    if (existCheck.rowCount === 0) {
      throw new GatewayError(404, 'not_found', `Virtual model ${id} not found`);
    }

    if (model_type !== undefined && !['chat', 'embedding'].includes(model_type)) {
      throw new GatewayError(400, 'invalid_request', 'model_type must be "chat" or "embedding"');
    }

    // 更新虚拟模型基本字段
    if (routing_strategy !== undefined && !VALID_STRATEGIES.includes(routing_strategy)) {
      throw new GatewayError(400, 'invalid_request', 'Invalid routing_strategy');
    }

    // 确定生效的 model_type（取更新值或现有值）
    const effectiveModelType = model_type ?? existCheck.rows[0]?.model_type;

    const update = buildUpdateSet({ name, description, model_type, routing_strategy, is_active });

    // 如果提供了后端列表，则替换
    if (backends !== undefined) {
      if (!Array.isArray(backends) || backends.length === 0) {
        throw new GatewayError(400, 'invalid_request', 'At least one backend is required');
      }

      // 校验 provider_model_id 存在且 model_type 一致
      const pmIds: string[] = backends.map((b) => b.provider_model_id);
      const pmCheck = await db.query<{ id: string; model_type: string }>(
        `SELECT id, model_type FROM provider_models WHERE id = ANY($1)`,
        [pmIds],
      );
      if (pmCheck.rowCount !== pmIds.length) {
        const foundIds = new Set(pmCheck.rows.map((r) => r.id));
        const missing = pmIds.filter((pmId) => !foundIds.has(pmId));
        throw new GatewayError(404, 'not_found', `Provider model(s) not found: ${missing.join(', ')}`);
      }

      // 校验后端的 model_type 与虚拟模型一致
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (effectiveModelType !== undefined && effectiveModelType !== null) {
        const mismatch = pmCheck.rows.filter((r) => r.model_type !== effectiveModelType);
        if (mismatch.length > 0) {
          const ids = mismatch.map((r) => r.id).join(', ');
          throw new GatewayError(
            400,
            'model_type_mismatch',
            `Virtual model type is "${effectiveModelType}" but provider model(s) [${ids}] have a different type`,
          );
        }
      }
    }

    // 事务：更新基本字段 + 替换后端
    await withTransaction(async (tx) => {
      if (update) {
        update.values.push(id);
        await tx.query(
          `UPDATE virtual_models SET ${update.setClause} WHERE id = $${String(update.nextIdx)}`,
          update.values,
        );
      }

      if (backends !== undefined) {
        await tx.query('DELETE FROM virtual_model_backends WHERE virtual_model_id = $1', [id]);
        const backendRows = backends.map((b) => [id, b.provider_model_id, b.weight ?? 1, b.priority ?? 0]);
        const batch = buildBatchInsert(backendRows, 4);
        await tx.query(
          `INSERT INTO virtual_model_backends (virtual_model_id, provider_model_id, weight, priority)
           VALUES ${batch.valuesClause}`,
          batch.values,
        );
      }
    });

    const result = await loadVirtualModelWithBackends(id);
    logger.info(
      { id, fieldsUpdated: update?.values.length ?? 0, backendsReplaced: backends !== undefined },
      'Virtual model updated',
    );
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// ==================== 删除虚拟模型 ====================
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    logger.debug({ id }, 'Deleting virtual model');
    const result = await db.query('DELETE FROM virtual_models WHERE id = $1 RETURNING id', [id]);

    if (result.rowCount === 0) {
      throw new GatewayError(404, 'not_found', `Virtual model ${id} not found`);
    }

    logger.info({ id }, 'Virtual model deleted');
    res.json({ deleted: true, id });
  } catch (err) {
    handleError(err, res);
  }
});

export default router;
