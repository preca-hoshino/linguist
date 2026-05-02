// src/admin/virtual-models.ts — 虚拟模型 CRUD API

import type { Request, Response } from 'express';
import { Router } from 'express';
import { db, generateShortId, withTransaction } from '@/db';
import {
  buildBatchInsert,
  buildInClause,
  buildUpdateSet,
  createLogger,
  GatewayError,
  logColors,
  rateLimiter,
} from '@/utils';
import { handleAdminError } from '../error';

const logger = createLogger('Admin:VirtualModels', logColors.bold + logColors.blue);

const router: Router = Router();

// ==================== 辅助：加载虚拟模型及其后端 ====================

/** 虚拟模型后端的数据库行（含关联的提供商模型/提供商名称） */
interface BackendRow {
  [key: string]: unknown;
  provider_model_id: string;
  weight: number;
  priority: number;
  provider_model_name?: string | undefined;
  provider_name?: string | undefined;
  provider_id?: string | undefined;
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
  rpm_limit: number | null;
  tpm_limit: number | null;
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
  rpm_limit?: number | null | undefined;
  tpm_limit?: number | null | undefined;
}

const VALID_STRATEGIES = new Set(['load_balance', 'failover']);

/** 按 ID 加载虚拟模型并附带其后端列表，不存在时返回 null */
async function loadVirtualModelWithBackends(
  vmId: string,
): Promise<(VirtualModelRow & { backends: BackendRow[] }) | null> {
  const vmResult = await db.query<VirtualModelRow>(
    'SELECT id, name, description, model_type, routing_strategy, is_active, rpm_limit, tpm_limit, created_at, updated_at FROM virtual_models WHERE id = $1',
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
            pm.name AS provider_model_name, p.name AS provider_name, pm.provider_id
     FROM virtual_model_backends vmb
     JOIN model_provider_models pm ON vmb.provider_model_id = pm.id
     JOIN model_providers p ON pm.provider_id = p.id
     WHERE vmb.virtual_model_id = $1
     ORDER BY vmb.priority ASC, vmb.weight DESC`,
    [vmId],
  );

  return {
    ...vm,
    backends: backendsResult.rows,
  };
}

/** 在虚拟模型对象上附加 object 字段 */
function withObjectType<T extends Record<string, unknown>>(vm: T): T & { object: 'virtual_model' } {
  return { object: 'virtual_model', ...vm };
}

function withThroughput<T extends { id: string }>(vm: T): T & { throughput: { rpm: number; tpm: number } } {
  const throughput = {
    rpm: rateLimiter.getRpmUsage('vm', vm.id),
    tpm: rateLimiter.getTpmUsage('vm', vm.id),
  };
  return { ...vm, throughput };
}

// ==================== 列出所有虚拟模型 ====================
router.get('/', async (req: Request, res: Response) => {
  try {
    const { search, limit, offset, expand, model_type, routing_strategy, is_active } = req.query;
    const limitNum =
      typeof limit === 'string' && limit !== '' ? Math.min(Math.max(Number.parseInt(limit, 10), 1), 100) : 10;
    const offsetNum = typeof offset === 'string' && offset !== '' ? Math.max(Number.parseInt(offset, 10), 0) : 0;

    // 解析按需展开字段
    const expands = Array.isArray(expand) ? expand : typeof expand === 'string' ? [expand] : [];
    const expandBackends = expands.includes('backends');

    logger.debug(
      {
        search,
        limit: limitNum,
        offset: offsetNum,
        expandBackends,
        model_type,
        routing_strategy,
        is_active,
      },
      'Listing virtual models',
    );

    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    // 布尔筛选：is_active
    if (typeof is_active === 'string' && (is_active === 'true' || is_active === 'false')) {
      conditions.push(`is_active = $${String(paramIdx)}`);
      values.push(is_active === 'true');
      paramIdx++;
    }

    // IN 筛选：model_type
    const typeIn = buildInClause('model_type', model_type as string | string[] | undefined, paramIdx);
    if (typeIn) {
      conditions.push(typeIn.clause);
      values.push(...typeIn.values);
      paramIdx = typeIn.nextIdx;
    }

    // IN 筛选：routing_strategy
    const stratIn = buildInClause('routing_strategy', routing_strategy as string | string[] | undefined, paramIdx);
    if (stratIn) {
      conditions.push(stratIn.clause);
      values.push(...stratIn.values);
      paramIdx = stratIn.nextIdx;
    }

    if (typeof search === 'string' && search.trim() !== '') {
      conditions.push(
        `(name ILIKE $${String(paramIdx)} OR routing_strategy ILIKE $${String(
          paramIdx,
        )} OR model_type ILIKE $${String(paramIdx)})`,
      );
      values.push(`%${search.trim()}%`);
      paramIdx++;
    }

    const baseWhereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // 单独计算 total
    const countSql = `SELECT COUNT(*) AS total FROM virtual_models ${baseWhereClause}`;
    const countResult = await db.query(countSql, values);
    const total = Number.parseInt((countResult.rows[0] as { total: string } | undefined)?.total ?? '0', 10);

    const whereClause = baseWhereClause;
    values.push(limitNum, offsetNum);

    const sql = `
      SELECT id, name, description, model_type, routing_strategy, is_active, rpm_limit, tpm_limit,
             created_at, updated_at
      FROM virtual_models
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${String(paramIdx)} OFFSET $${String(paramIdx + 1)}
    `;

    const vmResult = await db.query<VirtualModelRow>(sql, values);
    const dataRows = vmResult.rows;
    const hasMore = offsetNum + dataRows.length < total;

    if (dataRows.length === 0) {
      res.json({ object: 'list', url: '/admin/virtual-models', data: [], total, has_more: false });
      return;
    }

    const vmIds = dataRows.map((vm) => vm.id);

    // 根据 expand 参数决定是否深度联表查询后端名称
    let backendResult: import('pg').QueryResult<BackendRow & { virtual_model_id: string }>;
    if (expandBackends) {
      backendResult = await db.query<BackendRow & { virtual_model_id: string }>(
        `SELECT vmb.virtual_model_id, vmb.provider_model_id, vmb.weight, vmb.priority,
                pm.name AS provider_model_name, p.name AS provider_name, pm.provider_id
         FROM virtual_model_backends vmb
         JOIN model_provider_models pm ON vmb.provider_model_id = pm.id
         JOIN model_providers p ON pm.provider_id = p.id
         WHERE vmb.virtual_model_id = ANY($1)
         ORDER BY vmb.priority ASC, vmb.weight DESC`,
        [vmIds],
      );
    } else {
      // 默认（精简模式）：只获取主键和权重信息，节省大量 Join 和内存开销
      backendResult = await db.query<BackendRow & { virtual_model_id: string }>(
        `SELECT virtual_model_id, provider_model_id, weight, priority
         FROM virtual_model_backends
         WHERE virtual_model_id = ANY($1)
         ORDER BY priority ASC, weight DESC`,
        [vmIds],
      );
    }

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
        provider_id: row.provider_id,
      });
      backendsByVm.set(row.virtual_model_id, list);
    }

    const finalData = dataRows.map((vm) =>
      withThroughput(
        withObjectType({
          ...vm,
          backends: backendsByVm.get(vm.id) ?? [],
        }),
      ),
    );

    logger.debug({ count: finalData.length, total, has_more: hasMore }, 'Virtual models listed');
    res.json({ object: 'list', url: '/admin/virtual-models', data: finalData, total, has_more: hasMore });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 获取单个虚拟模型 ====================
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { expand } = req.query;
    const expands = Array.isArray(expand) ? expand : typeof expand === 'string' ? [expand] : [];
    const expandBackends = expands.includes('backends');

    logger.debug({ id, expandBackends }, 'Getting virtual model');

    // 如果未指示深度展开，直接拿取骨架即可
    if (!expandBackends) {
      const vmResult = await db.query<VirtualModelRow>(
        'SELECT id, name, description, model_type, routing_strategy, is_active, rpm_limit, tpm_limit, created_at, updated_at FROM virtual_models WHERE id = $1',
        [id],
      );
      if (vmResult.rowCount === 0) {
        throw new GatewayError(404, 'not_found', `Virtual model ${id} not found`);
      }
      const backendResult = await db.query<BackendRow>(
        `SELECT provider_model_id, weight, priority FROM virtual_model_backends WHERE virtual_model_id = $1 ORDER BY priority ASC, weight DESC`,
        [id],
      );

      const vm = Object.assign({}, vmResult.rows[0], { backends: backendResult.rows });
      res.json(withThroughput(withObjectType(vm)));
      return;
    }

    const vm = await loadVirtualModelWithBackends(id);
    if (!vm) {
      throw new GatewayError(404, 'not_found', `Virtual model ${id} not found`);
    }
    res.json(withThroughput(withObjectType(vm)));
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 创建虚拟模型 ====================
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body as VirtualModelBody;
    const { name, description, model_type, routing_strategy, backends, rpm_limit, tpm_limit } = body;
    logger.debug({ name, model_type, routingStrategy: routing_strategy }, 'Creating virtual model');

    if (typeof name !== 'string' || name === '') {
      throw new GatewayError(400, 'invalid_request', 'Field name is required');
    }

    if (typeof model_type !== 'string' || !['chat', 'embedding'].includes(model_type)) {
      throw new GatewayError(400, 'invalid_request', 'Field model_type is required and must be "chat" or "embedding"');
    }

    const strategy =
      typeof routing_strategy === 'string' && routing_strategy !== '' ? routing_strategy : 'load_balance';
    if (!VALID_STRATEGIES.has(strategy)) {
      throw new GatewayError(400, 'invalid_request', 'routing_strategy must be one of: load_balance, failover');
    }

    if (!Array.isArray(backends) || backends.length === 0) {
      throw new GatewayError(400, 'invalid_request', 'At least one backend is required');
    }

    // 校验所有 provider_model_id 存在且 model_type 一致
    const pmIds: string[] = backends.map((b) => b.provider_model_id);
    const pmCheck = await db.query<{ id: string; model_type: string }>(
      `SELECT id, model_type FROM model_provider_models WHERE id = ANY($1)`,
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
        `INSERT INTO virtual_models (id, name, description, model_type, routing_strategy, rpm_limit, tpm_limit)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, name, description ?? '', model_type, strategy, rpm_limit ?? null, tpm_limit ?? null],
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
    res.status(201).json(result ? withThroughput(withObjectType(result)) : null);
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 更新虚拟模型 ====================
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const body = req.body as VirtualModelBody;
    const { name, description, model_type, routing_strategy, backends, is_active, rpm_limit, tpm_limit } = body;
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
    if (routing_strategy !== undefined && !VALID_STRATEGIES.has(routing_strategy)) {
      throw new GatewayError(400, 'invalid_request', 'Invalid routing_strategy');
    }

    // 确定生效的 model_type（取更新值或现有值）
    const effectiveModelType = model_type ?? existCheck.rows[0]?.model_type;

    const update = buildUpdateSet({
      name,
      description,
      model_type,
      routing_strategy,
      is_active,
      rpm_limit: rpm_limit === undefined ? undefined : rpm_limit,
      tpm_limit: tpm_limit === undefined ? undefined : tpm_limit,
    });

    // 如果提供了后端列表，则替换
    if (backends !== undefined) {
      if (!Array.isArray(backends) || backends.length === 0) {
        throw new GatewayError(400, 'invalid_request', 'At least one backend is required');
      }

      // 校验 provider_model_id 存在且 model_type 一致
      const pmIds: string[] = backends.map((b) => b.provider_model_id);
      const pmCheck = await db.query<{ id: string; model_type: string }>(
        `SELECT id, model_type FROM model_provider_models WHERE id = ANY($1)`,
        [pmIds],
      );
      if (pmCheck.rowCount !== pmIds.length) {
        const foundIds = new Set(pmCheck.rows.map((r) => r.id));
        const missing = pmIds.filter((pmId) => !foundIds.has(pmId));
        throw new GatewayError(404, 'not_found', `Provider model(s) not found: ${missing.join(', ')}`);
      }

      // 校验后端的 model_type 与虚拟模型一致

      if (effectiveModelType !== undefined) {
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
    if (!result) {
      logger.error({ id }, 'Virtual model updated but failed to reload backends');
      throw new GatewayError(500, 'internal_error', 'Virtual model updated but failed to reload');
    }
    logger.info(
      { id, fieldsUpdated: update?.values.length ?? 0, backendsReplaced: backends !== undefined },
      'Virtual model updated',
    );
    res.json(withThroughput(withObjectType(result)));
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 删除虚拟模型 ====================
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    logger.debug({ id }, 'Deleting virtual model');
    const result = await db.query('DELETE FROM virtual_models WHERE id = $1 RETURNING id', [id]);

    if (result.rowCount === 0) {
      throw new GatewayError(404, 'not_found', `Virtual model ${id} not found`);
    }

    logger.info({ id }, 'Virtual model deleted');
    res.json({ id, object: 'virtual_model', deleted: true });
  } catch (error) {
    handleAdminError(error, res);
  }
});

export { router as virtualModelsRouter };
