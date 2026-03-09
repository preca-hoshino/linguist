import type { Client } from 'pg';
import { db, createListenClient, invalidateApiKeyCache } from '../db';
import type { ProviderConfig, VirtualModelBackend, VirtualModelConfig, ResolvedRoute } from '../types';
import { createLogger, logColors } from '../utils';

const logger = createLogger('Config', logColors.bold + logColors.yellow);

// ==================== ConfigManager ====================

/**
 * 动态配置管理器
 *
 * 从 PostgreSQL 加载提供商配置和模型映射到内存，
 * 通过 LISTEN/NOTIFY 机制监听数据库变更实现配置热更新。
 */
export class ConfigManager {
  /** 虚拟模型配置缓存 (virtualModelId → VirtualModelConfig) */
  private virtualModels = new Map<string, VirtualModelConfig>();

  /** LISTEN 客户端 */
  private listenClient: Client | null = null;

  /** 是否正在停止 */
  private stopping = false;

  /** 重连尝试次数 */
  private reconnectAttempts = 0;

  /** 重连定时器 */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 从数据库加载所有配置到内存
   */
  public async loadAll(): Promise<void> {
    const start = Date.now();
    logger.debug('Loading configuration from database...');

    // 使用临时容器加载，查询完成后再原子替换——避免查询失败导致缓存清空
    const newProviders = new Map<string, ProviderConfig>();
    const newVirtualModels = new Map<string, VirtualModelConfig>();

    // 1. 加载活跃的提供商
    const providersRes = await db.query<{
      id: string;
      kind: string;
      name: string;
      api_key: string;
      base_url: string;
      config: Record<string, unknown>;
    }>('SELECT id, kind, name, api_key, base_url, config FROM providers WHERE is_active = true');

    for (const row of providersRes.rows) {
      newProviders.set(row.id, {
        id: row.id,
        kind: row.kind,
        name: row.name,
        apiKey: row.api_key,
        baseUrl: row.base_url,
        config: row.config,
      });
    }

    // 2. 加载虚拟模型 + 后端（四表联查）
    const backendsRes = await db.query<{
      vm_id: string;
      vm_name: string;
      vm_model_type: string;
      routing_strategy: string;
      pm_id: string;
      pm_name: string;
      model_type: string;
      pm_capabilities: string[];
      weight: number;
      priority: number;
      provider_id: string;
      provider_kind: string;
      provider_name: string;
      api_key: string;
      base_url: string;
      provider_config: Record<string, unknown>;
    }>(`
      SELECT
        vm.id              AS vm_id,
        vm.name            AS vm_name,
        vm.model_type      AS vm_model_type,
        vm.routing_strategy,
        pm.id              AS pm_id,
        pm.name            AS pm_name,
        pm.model_type,
        pm.capabilities    AS pm_capabilities,
        vmb.weight,
        vmb.priority,
        p.id               AS provider_id,
        p.kind             AS provider_kind,
        p.name             AS provider_name,
        p.api_key,
        p.base_url,
        p.config           AS provider_config
      FROM virtual_models vm
      JOIN virtual_model_backends vmb ON vmb.virtual_model_id = vm.id
      JOIN provider_models pm         ON vmb.provider_model_id = pm.id
      JOIN providers p                ON pm.provider_id = p.id
      WHERE vm.is_active = true
        AND pm.is_active = true
        AND p.is_active  = true
      ORDER BY vm.id, vmb.priority ASC, vmb.weight DESC
    `);

    for (const row of backendsRes.rows) {
      let config = newVirtualModels.get(row.vm_name);
      if (!config) {
        // model_type 和 routing_strategy 由管理 API 创建时严格校验，直接使用类型断言
        config = {
          id: row.vm_id,
          modelType: row.vm_model_type as 'chat' | 'embedding',
          routingStrategy: row.routing_strategy as VirtualModelConfig['routingStrategy'],
          backends: [],
        };
        newVirtualModels.set(row.vm_name, config);
      }

      config.backends.push({
        providerModelId: row.pm_id,
        actualModel: row.pm_name,
        modelType: row.model_type as 'chat' | 'embedding',
        capabilities: row.pm_capabilities,
        weight: row.weight,
        priority: row.priority,
        provider: newProviders.get(row.provider_id) ?? {
          id: row.provider_id,
          kind: row.provider_kind,
          name: row.provider_name,
          apiKey: row.api_key,
          baseUrl: row.base_url,
          config: row.provider_config,
        },
      });
    }

    const duration = Date.now() - start;

    // 原子替换缓存——只在所有查询成功后才替换（引用交换）
    this.virtualModels = newVirtualModels;

    logger.info(
      { providers: newProviders.size, virtualModels: this.virtualModels.size, duration },
      'Configuration loaded from database',
    );
  }

  /**
   * 获取虚拟模型的候选后端列表（路由模块和 caller 共用）
   *
   * - load_balance: 加权随机选一个后端，仅返回该后端（不重试）
   * - failover:     按 priority 升序，返回第一个激活的后端（不重试）
   *
   * 所有策略均只返回单个后端，调用失败即返回错误。
   *
   * @param requiredCapabilities 请求所需能力标识，用于过滤不满足的后端
   */
  public resolveAllBackends(virtualModelId: string, requiredCapabilities: string[] = []): ResolvedRoute[] {
    const config = this.virtualModels.get(virtualModelId);
    if (!config || config.backends.length === 0) {
      return [];
    }

    const eligible = this.filterByCapabilities(config.backends, requiredCapabilities);

    const toRoute = (backend: VirtualModelBackend): ResolvedRoute => ({
      actualModel: backend.actualModel,
      modelType: config.modelType,
      capabilities: backend.capabilities,
      providerKind: backend.provider.kind,
      providerId: backend.provider.id,
      provider: backend.provider,
      routingStrategy: config.routingStrategy,
    });

    switch (config.routingStrategy) {
      case 'load_balance': {
        // 加权随机选一个，只返回这一个（不重试）
        const totalWeight = eligible.reduce((s, b) => s + b.weight, 0);
        let rand = Math.random() * totalWeight;
        let chosen = eligible[0];
        for (const b of eligible) {
          rand -= b.weight;
          if (rand <= 0) {
            chosen = b;
            break;
          }
        }
        return chosen !== undefined ? [toRoute(chosen)] : [];
      }
      case 'failover':
      default:
        // 按 priority 升序取第一个后端（已按 priority 排序），不重试
        return eligible[0] !== undefined ? [toRoute(eligible[0])] : [];
    }
  }

  /**
   * 按能力标识过滤后端列表
   * 后端必须拥有所有 requiredCapabilities 中列出的能力才被保留
   */
  private filterByCapabilities(backends: VirtualModelBackend[], requiredCapabilities: string[]): VirtualModelBackend[] {
    if (requiredCapabilities.length === 0) {
      return backends;
    }
    return backends.filter((b) => requiredCapabilities.every((cap) => b.capabilities.includes(cap)));
  }

  /**
   * 获取所有已注册的虚拟模型名列表
   */
  public getAllVirtualModels(): string[] {
    return Array.from(this.virtualModels.keys());
  }

  /**
   * 获取虚拟模型配置
   */
  public getVirtualModelConfig(virtualModelId: string): VirtualModelConfig | undefined {
    return this.virtualModels.get(virtualModelId);
  }

  // ==================== LISTEN/NOTIFY ====================

  /**
   * 启动 LISTEN/NOTIFY 监听
   * 使用独立的 pg.Client 连接（不能使用连接池）
   * 当收到 config_channel 通知时自动重新加载配置
   */
  public async startListening(): Promise<void> {
    this.stopping = false;
    try {
      this.listenClient = createListenClient();
      await this.listenClient.connect();

      this.listenClient.on('notification', (msg) => {
        logger.info({ channel: msg.channel, payload: msg.payload }, 'Received config change notification');

        // API Key 表变更时仅刷新 key 缓存，无需重载全部配置
        if (msg.payload?.startsWith('api_keys:')) {
          invalidateApiKeyCache();
          logger.info('API key cache invalidated due to database change');
          return;
        }

        void this.loadAll()
          .then(() => {
            logger.info('Configuration reloaded successfully');
          })
          .catch((err: unknown) => {
            logger.error(err instanceof Error ? err : new Error(String(err)), 'Failed to reload configuration');
          });
      });

      this.listenClient.on('error', (err) => {
        logger.error({ err }, 'LISTEN client error, will attempt reconnect');
        this.scheduleReconnect();
      });

      await this.listenClient.query('LISTEN config_channel');
      this.reconnectAttempts = 0; // 连接成功，重置计数
      logger.info('LISTEN/NOTIFY monitoring started on config_channel');
    } catch (err) {
      logger.error({ err }, 'Failed to start LISTEN/NOTIFY');
      throw err;
    }
  }

  /**
   * 指数退避重连 LISTEN 客户端
   */
  private scheduleReconnect(): void {
    if (this.stopping) {
      return;
    }
    const maxDelay = 60_000;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), maxDelay);
    this.reconnectAttempts++;
    logger.info({ attempt: this.reconnectAttempts, delayMs: delay }, 'Scheduling LISTEN client reconnect');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopping) {
        return;
      }
      // 清理旧连接
      if (this.listenClient) {
        this.listenClient.end().catch((): void => {
          // 忽略关闭连接时的错误
        });
        this.listenClient = null;
      }
      void this.startListening().catch((err: unknown) => {
        logger.error({ err }, 'LISTEN reconnect failed, will retry');
        this.scheduleReconnect();
      });
    }, delay);
  }

  /**
   * 停止 LISTEN/NOTIFY 监听并关闭客户端
   */
  public async stopListening(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.listenClient) {
      const client = this.listenClient;
      this.listenClient = null;
      // 先尝试 UNLISTEN，连接已断开时忽略错误
      try {
        await client.query('UNLISTEN config_channel');
      } catch {
        // 连接可能已因 ECONNRESET 断开，忽略
      }
      // 无论 UNLISTEN 是否成功，都尝试关闭连接
      try {
        await client.end();
        logger.info('LISTEN/NOTIFY monitoring stopped');
      } catch {
        // 连接已断开，静默忽略
      }
    }
  }
}

/** ConfigManager 全局单例 */
export const configManager = new ConfigManager();
