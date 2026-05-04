// src/config/manager.ts — 配置管理器编排层

import type { Client } from 'pg';
import { createListenClient } from '@/db';
import { invalidateAppCache } from '@/db/apps';
import type { ResolvedRoute, VirtualModelConfig } from '@/types';
import { createLogger, logColors } from '@/utils';
import { loadAllFromDb } from './loader';
import { resolveAllBackends } from './router';

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
    const { virtualModels } = await loadAllFromDb();
    // 原子替换缓存——只在所有查询成功后才替换（引用交换）
    this.virtualModels = virtualModels;
  }

  /**
   * 获取虚拟模型的候选后端列表（路由模块和 caller 共用）
   */
  public resolveAllBackends(
    virtualModelId: string,
    requiredCapabilities: string[] = [],
    requiredParameters: string[] = [],
  ): ResolvedRoute[] {
    const config = this.virtualModels.get(virtualModelId);
    if (!config) {
      return [];
    }
    return resolveAllBackends(config, requiredCapabilities, requiredParameters);
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
