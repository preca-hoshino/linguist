// src/middleware/types.ts — 中间件类型定义

import type { GatewayContext } from '@/types';

/**
 * 统一中间件类型
 * Chat/Embedding 共用，操作 GatewayContext
 *
 * 返回类型为 `void | Promise<void>`：
 * - 同步中间件直接返回 void（无需异步操作时，无此 `async` 关键词）
 * - 异步中间件返回 Promise（含 I/O 操作时，使用 `async` 关键词）
 */
export type Middleware = (ctx: GatewayContext) => void | Promise<void>;
