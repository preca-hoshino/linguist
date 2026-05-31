// common — 跨协议通用类型
export type * from './common/api';
export type * from './common/billing';
export * from './common/config';
export * from './common/permissions';
export type * from './common/provider';

// http — HTTP V1 协议层（无状态）
export type * from './http/context';
export type * from './http/chat';
export type * from './http/embedding';

// ws — WebSocket V2 协议层（有状态）
export type * from './ws/context';
export type * from './ws/realtime';

// mcp — MCP 协议层（协议代理）
export type * from './mcp/context';
export type * from './mcp/protocol';
