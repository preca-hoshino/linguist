// src/config/loader.ts — 从数据库加载提供商与虚拟模型配置

import type {
  ModelThinkingConfig,
  ModelType,
  ProviderAdvancedConfig,
  ProviderConfig,
  ProviderCredential,
  VirtualModelConfig,
} from '@/types';
import { DEFAULT_PROVIDER_CONFIG } from '@/types';
import { createLogger, logColors } from '@/utils';
import { db } from '@/db';

const logger = createLogger('Config:Loader', logColors.bold + logColors.yellow);

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// ========== 凭证解析 ==========

/**
 * 将数据库中的 credential_type + credential JSONB 解析为类型安全的 ProviderCredential
 */
export function parseCredential(credentialType: string, credential: Record<string, unknown>): ProviderCredential {
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

// ========== 数据库加载 ==========

export interface LoadedConfig {
  providers: Map<string, ProviderConfig>;
  virtualModels: Map<string, VirtualModelConfig>;
}

/**
 * 从数据库加载所有提供商和虚拟模型配置
 *
 * 使用临时容器加载，查询完成后再原子替换——避免查询失败导致缓存清空
 */
export async function loadAllFromDb(): Promise<LoadedConfig> {
  const start = Date.now();
  logger.debug('Loading configuration from database...');

  const newProviders = new Map<string, ProviderConfig>();
  const newVirtualModels = new Map<string, VirtualModelConfig>();

  // 1. 加载所有提供商
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
  }>('SELECT id, kind, name, credential_type, credential, base_url, config, rpm_limit, tpm_limit FROM model_providers');

  for (const row of providersRes.rows) {
    const cred = parseCredential(row.credential_type, row.credential);
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
    vm_thinking_config: Record<string, unknown> | null;
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
    pm_thinking_config: Record<string, unknown> | null;
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
        vm.thinking_config AS vm_thinking_config,
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
        pm.thinking_config AS pm_thinking_config,
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
      config = {
        id: row.vm_id,
        modelType: row.vm_model_type as ModelType,
        routingStrategy: row.routing_strategy as VirtualModelConfig['routingStrategy'],
        backends: [],
        rpmLimit: row.vm_rpm_limit ?? undefined,
        tpmLimit: row.vm_tpm_limit ?? undefined,
        thinkingConfig: (row.vm_thinking_config as ModelThinkingConfig | null) ?? undefined,
        createdAt: row.vm_created_at,
      };
      newVirtualModels.set(row.vm_name, config);
    }

    const existingProvider = newProviders.get(row.provider_id);
    const fallbackCred = parseCredential(row.credential_type, row.credential);
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
      thinkingConfig: (row.pm_thinking_config as ModelThinkingConfig | null) ?? undefined,
      requestOverrides: row.pm_request_overrides ?? {},
    });
  }

  const duration = Date.now() - start;
  logger.info(
    { providers: newProviders.size, virtualModels: newVirtualModels.size, duration },
    'Configuration loaded from database',
  );

  return { providers: newProviders, virtualModels: newVirtualModels };
}
