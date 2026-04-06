// tests/helpers/mock-server.ts — 基于 nock 的 API 拦截助手

import nock from 'nock';

export const setupDeepSeekMock = (baseUrl = 'https://api.deepseek.com'): nock.Scope => {
  return nock(baseUrl);
};

export const setupGeminiMock = (baseUrl = 'https://generativelanguage.googleapis.com'): nock.Scope => {
  return nock(baseUrl);
};

export const setupVolcEngineMock = (baseUrl = 'https://ark.cn-beijing.volces.com'): nock.Scope => {
  return nock(baseUrl);
};

/**
 * 清除所有拦截
 */
export const clearAllMocks = (): void => {
  nock.cleanAll();
};
