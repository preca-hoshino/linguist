// src/providers/copilot/constants.ts — Copilot 提供商常量

/** VS Code Copilot 的 OAuth App Client ID（已验证可用） */
export const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';

/** GitHub OAuth Device Flow 端点 */
export const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
export const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/** Copilot 短效 Token 获取端点 */
export const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';

/**
 * 模拟 VS Code 客户端的 HTTP Headers
 * 用于获取 Copilot Token 及调用 Copilot Chat API
 */
export const COPILOT_EDITOR_HEADERS: Readonly<Record<string, string>> = {
  'Editor-Version': 'vscode/1.85.0',
  'Editor-Plugin-Version': 'copilot/1.155.0',
  'User-Agent': 'GitHubCopilotChat/0.12.0',
};

/**
 * Copilot Chat API 额外请求 Headers
 * 在 COPILOT_EDITOR_HEADERS 基础上增加集成标识
 */
export const COPILOT_CHAT_HEADERS: Readonly<Record<string, string>> = {
  ...COPILOT_EDITOR_HEADERS,
  'Copilot-Integration-Id': 'vscode-chat',
};

/** Token 提前刷新余量（秒），在过期前 5 分钟触发刷新 */
export const TOKEN_REFRESH_MARGIN_SECONDS = 300;

/** Copilot 模型列表缓存 TTL（毫秒），1 小时 */
export const COPILOT_MODELS_CACHE_TTL_MS = 3_600_000;
