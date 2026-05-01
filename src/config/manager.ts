import type { Client } from 'pg';
import { createListenClient, db } from '@/db';
import { invalidateAppCache } from '@/db/apps';
import type {
  ModelType,
  ProviderAdvancedConfig,
  ProviderConfig,
  ProviderCredential,
  ResolvedRoute,
  VirtualModelBackend,
  VirtualModelConfig,
} from '@/types';
import { DEFAULT_PROVIDER_CONFIG } from '@/types';
import { createLogger, logColors, rateLimiter } from '@/utils';

const logger = createLogger('Config', logColors.bold + logColors.yellow);

// ==================== ConfigManager ====================

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

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

    // 1. 加载所有提供商（Provider 层无启停设计，启停粒度在 model_provider_models / virtual_models 层）
    const providersRes = await db.query<{
      id: string;
      kind: string;
      name: string;
      credential_type: string;
      credential: Record<string, unknown>;
      base_url: string;
      config: Record<string, unknown>;
      rpm_limit: number | null;
      tpm_limit: number | null;
    }>(
      'SELECT id, kind, name, credential_type, credential, base_url, config, rpm_limit, tpm_limit FROM model_providers',
    );

    for (const row of providersRes.rows) {
      const cred = this.parseCredential(row.credential_type, row.credential);
      const advancedConfig: ProviderAdvancedConfig = { ...DEFAULT_PROVIDER_CONFIG, ...row.config };
      newProviders.set(row.id, {
        id: row.id,
        kind: row.kind,
        name: row.name,
        credential: cred,
        baseUrl: row.base_url,
        config: advancedConfig,
        rpmLimit: row.rpm_limit ?? undefined,
        tpmLimit: row.tpm_limit ?? undefined,
      });
    }

    // 2. 加载虚拟模型 + 后端（四表联查，含 RPM/TPM 限流字段）
    const backendsRes = await db.query<{
      vm_id: string;
      vm_name: string;
      vm_model_type: string;
      routing_strategy: string;
      vm_rpm_limit: number | null;
      vm_tpm_limit: number | null;
      vm_created_at: Date;
      pm_id: string;
      pm_name: string;
      model_type: string;
      pm_capabilities: string[];
      pm_supported_parameters: string[];
      pm_rpm_limit: number | null;
      pm_tpm_limit: number | null;
      pm_timeout_ms: number | null;
      pm_model_config: Record<string, unknown> | null;
      pm_request_overrides: {
        headers?: Record<string, string | null>;
        body?: Record<string, string | null>;
      } | null;
      weight: number;
      priority: number;
      provider_id: string;
      provider_kind: string;
      provider_name: string;
      credential_type: string;
      credential: Record<string, unknown>;
      base_url: string;
      provider_config: Record<string, unknown>;
    }>(`
      SELECT
        vm.id              AS vm_id,
        vm.name            AS vm_name,
        vm.model_type      AS vm_model_type,
        vm.routing_strategy,
        vm.rpm_limit       AS vm_rpm_limit,
        vm.tpm_limit       AS vm_tpm_limit,
        vm.created_at      AS vm_created_at,
        pm.id              AS pm_id,
        pm.name            AS pm_name,
        pm.model_type,
        pm.capabilities    AS pm_capabilities,
        pm.supported_parameters AS pm_supported_parameters,
        pm.rpm_limit       AS pm_rpm_limit,
        pm.tpm_limit       AS pm_tpm_limit,
        pm.timeout_ms      AS pm_timeout_ms,
        pm.model_config    AS pm_model_config,
        pm.request_overrides AS pm_request_overrides,
        vmb.weight,
        vmb.priority,
        p.id               AS provider_id,
        p.kind             AS provider_kind,
        p.name             AS provider_name,
        p.credential_type,
        p.credential,
        p.base_url,
        p.config           AS provider_config
      FROM virtual_models vm
      JOIN virtual_model_backends vmb ON vmb.virtual_model_id = vm.id
      JOIN model_provider_models pm   ON vmb.provider_model_id = pm.id
      JOIN model_providers p          ON pm.provider_id = p.id
      WHERE vm.is_active = true
        AND pm.is_active = true
      ORDER BY vm.id, vmb.priority ASC, vmb.weight DESC
    `);
    for (const row of backendsRes.rows) {
      let config = newVirtualModels.get(row.vm_name);
      if (!config) {
        // model_type 和 routing_strategy 由管理 API 创建时严格校验，直接使用类型断言
        config = {
          id: row.vm_id,
          modelType: row.vm_model_type as ModelType,
          routingStrategy: row.routing_strategy as VirtualModelConfig['routingStrategy'],
          backends: [],
          rpmLimit: row.vm_rpm_limit ?? undefined,
          tpmLimit: row.vm_tpm_limit ?? undefined,
          createdAt: row.vm_created_at,
        };
        newVirtualModels.set(row.vm_name, config);
      }

      const existingProvider = newProviders.get(row.provider_id);
      const fallbackCred = this.parseCredential(row.credential_type, row.credential);
      const fallbackConfig: ProviderAdvancedConfig = { ...DEFAULT_PROVIDER_CONFIG, ...row.provider_config };

      config.backends.push({
        providerModelId: row.pm_id,
        actualModel: row.pm_name,
        modelType: row.model_type as ModelType,
        capabilities: row.pm_capabilities,
        supportedParameters: row.pm_supported_parameters,
        weight: row.weight,
        priority: row.priority,
        provider: existingProvider ?? {
          id: row.provider_id,
          kind: row.provider_kind,
          name: row.provider_name,
          credential: fallbackCred,
          baseUrl: row.base_url,
          config: fallbackConfig,
        },
        rpmLimit: row.pm_rpm_limit ?? undefined,
        tpmLimit: row.pm_tpm_limit ?? undefined,
        timeoutMs: row.pm_timeout_ms ?? undefined,
        modelConfig: row.pm_model_config ?? {},
        requestOverrides: row.pm_request_overrides ?? {},
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
   * 将数据库中的 credential_type + credential JSONB 解析为类型安全的 ProviderCredential
   */
  private parseCredential(credentialType: string, credential: Record<string, unknown>): ProviderCredential {
    switch (credentialType) {
      case 'api_key': {
        return { type: 'api_key', key: str(credential.key) };
      }
      case 'oauth2': {
        return {
          type: 'oauth2',
          accessToken: str(credential.accessToken),
          refreshToken: str(credential.refreshToken),
          expiresAt: str(credential.expiresAt),
          tokenEndpoint: str(credential.tokenEndpoint),
        };
      }
      case 'copilot': {
        return {
          type: 'copilot',
          accessToken: str(credential.accessToken),
        };
      }
      default: {
        return { type: 'none' };
      }
    }
  }

  /**
   * 获取虚拟模型的候选后端列表（路由模块和 caller 共用）
   *
   * 流控感知路由策略：
   * 1. 先按能力标识过滤不满足的后端
   * 2. 再剔除 RPM 或 TPM 任一已满载的后端（通过 rateLimiter 实时检测）
   * 3. 按策略选择后端：
   *    - load_balance: 按权重降序排列，选第一个（权重最高的可用后端）
   *    - failover:     按 priority 升序，选第一个可用后端
   *
   * 所有策略均只返回单个后端，调用失败即返回错误。
   *
   * @param requiredCapabilities 请求所需能力标识，用于过滤不满足的后端
   * @param requiredParameters 请求所需的参数，用于优先匹配更兼容的后端
   */
  public resolveAllBackends(
    virtualModelId: string,
    requiredCapabilities: string[] = [],
    requiredParameters: string[] = [],
  ): ResolvedRoute[] {
    const config = this.virtualModels.get(virtualModelId);
    if (!config || config.backends.length === 0) {
      return [];
    }

    const eligible = this.filterByCapabilities(config.backends, requiredCapabilities);

    const scored = this.scoreByParameters(eligible, requiredParameters);

    // 流控感知过滤：剔除 RPM 或 TPM 任一已满载的后端
    const available = this.filterByRateLimit(scored);

    if (available.length === 0 && eligible.length > 0) {
      // 所有后端因流控耗尽而不可用时，记录日志供诊断
      logger.warn({ virtualModelId, eligibleCount: eligible.length }, 'All backends rate-limited for virtual model');
    }

    const toRoute = (backend: VirtualModelBackend): ResolvedRoute => ({
      actualModel: backend.actualModel,
      modelType: config.modelType,
      capabilities: backend.capabilities,
      supportedParameters: backend.supportedParameters,
      providerKind: backend.provider.kind,
      providerId: backend.provider.id,
      provider: backend.provider,
      requestOverrides: backend.requestOverrides,
      routingStrategy: config.routingStrategy,
      timeoutMs: backend.timeoutMs,
      modelConfig: backend.modelConfig,
    });

    if (config.routingStrategy === 'load_balance') {
      // 按权重降序排列，选第一个（权重最高的可用后端）
      const sorted = [...available].sort((a, b) => b.weight - a.weight);
      const chosen = sorted[0];
      return chosen === undefined ? [] : [toRoute(chosen)];
    }

    // failover：按 priority 升序取第一个可用后端（已按 priority 排序）
    return available[0] === undefined ? [] : [toRoute(available[0])];
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
   * 软排序：按后端声明的 supported_parameters 与请求所需参数的匹配度排序
   * 全部满足的后端排在前面；无法完全满足的后端降级但不淘汰。
   */
  private scoreByParameters(backends: VirtualModelBackend[], requiredParams: string[]): VirtualModelBackend[] {
    if (requiredParams.length === 0) {
      return backends;
    }
    return [...backends].sort((a, b) => {
      const scoreA = requiredParams.filter((p) => a.supportedParameters.includes(p)).length;
      const scoreB = requiredParams.filter((p) => b.supportedParameters.includes(p)).length;
      return scoreB - scoreA; // 降序，满足更多的排前面
    });
  }

  /**
   * 按实时流控状态过滤后端列表
   * 剔除 RPM 或 TPM 任一已达到上限的后端（通过 rateLimiter 实时检测）
   * 包含模型级和提供商级两层限制：
   * - 模型级（pm）：针对单个 providerModelId 的独立限制
   * - 提供商级（p）：共享同一 provider.id 的全局并发限制
   */
  private filterByRateLimit(backends: VirtualModelBackend[]): VirtualModelBackend[] {
    return backends.filter((b) => {
      // 模型级限流
      const pmRpmFull = rateLimiter.isRpmFull('pm', b.providerModelId, b.rpmLimit);
      const pmTpmFull = rateLimiter.isTpmFull('pm', b.providerModelId, b.tpmLimit);
      if (pmRpmFull || pmTpmFull) {
        logger.debug(
          { providerModelId: b.providerModelId, actualModel: b.actualModel, pmRpmFull, pmTpmFull },
          'Backend excluded by model-level rate limit',
        );
        return false;
      }
      // 提供商级限流
      const pRpmFull = rateLimiter.isRpmFull('p', b.provider.id, b.provider.rpmLimit);
      const pTpmFull = rateLimiter.isTpmFull('p', b.provider.id, b.provider.tpmLimit);
      if (pRpmFull || pTpmFull) {
        logger.debug(
          { providerId: b.provider.id, providerModelId: b.providerModelId, pRpmFull, pTpmFull },
          'Backend excluded by provider-level rate limit',
        );
        return false;
      }
      return true;
    });
  }

  /**
   * 获取所有已注册的虚拟模型名列表
   */
  public getAllVirtualModels(): string[] {
    return [...this.virtualModels.keys()];
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

        // Apps 表变更时刷新 App 缓存
        if (
          msg.payload?.startsWith('apps:') ||
          msg.payload?.startsWith('app_allowed_models:') ||
          msg.payload?.startsWith('app_allowed_mcps:')
        ) {
          invalidateAppCache();
          logger.info('App cache invalidated due to database change');
          return;
        }

        void this.loadAll()
          .then(() => {
            logger.info('Configuration reloaded successfully');
          })
          .catch((error: unknown) => {
            logger.error(error instanceof Error ? error : new Error(String(error)), 'Failed to reload configuration');
          });
      });

      this.listenClient.on('error', (err) => {
        logger.error({ err }, 'LISTEN client error, will attempt reconnect');
        this.scheduleReconnect();
      });

      await this.listenClient.query('LISTEN config_channel');
      this.reconnectAttempts = 0; // 连接成功，重置计数
      logger.info('LISTEN/NOTIFY monitoring started on config_channel');
    } catch (error) {
      logger.error({ err: error }, 'Failed to start LISTEN/NOTIFY');
      throw error;
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
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, maxDelay);
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
      void this.startListening().catch((error: unknown) => {
        logger.error({ err: error }, 'LISTEN reconnect failed, will retry');
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
export const configManager: ConfigManager = new ConfigManager();
