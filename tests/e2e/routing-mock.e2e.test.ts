import request from 'supertest';
import nock from 'nock';
import { app } from '@/server';
import { db } from '@/db';
import { configManager } from '@/config';

// 模拟数据库
jest.mock('@/db', () => ({
  db: {
    query: jest.fn(),
  },
  createListenClient: jest.fn(),
  generateShortId: jest.fn(),
  markProcessing: jest.fn(),
  markSuccess: jest.fn(),
  markError: jest.fn(),
}));

jest.mock('@/utils', () => ({
  ...jest.requireActual<typeof import('@/utils')>('@/utils'),
  createLogger: jest.fn(() => ({
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  })),
}));

describe('Phase B: Routing Mock with Nock', () => {
  const mockQuery = db.query as jest.MockedFunction<typeof db.query>;

  beforeAll(async () => {
    process.env.REQUIRE_API_KEY = 'false';
    // 模拟 configManager 从数据库拉取提供商与虚拟模型映射的过程
    mockQuery.mockImplementation(async (sql: string, values?: any[]) => {
      const q = sql.toLowerCase();
      // 这里模拟验证 API Key (SELECT ... FROM apps ...)
      if (q.includes('apps')) {
        return {
          rowCount: 1,
          rows: [
            { 
              id: 'app-test', 
              api_key: 'test-token', 
              name: 'Test App', 
              is_active: true,
              allowed_model_ids: ['deepseek-mock'],
              allowed_mcp_ids: []
            }
          ]
        } as any;
      }
      
      // 优先匹配 virtual_models (因为它也包含 model_providers 关键字)
      if (q.includes('virtual_models')) {
        return {
          rows: [
            {
              vm_id: 'deepseek-mock',
              vm_name: 'deepseek-mock',
              vm_model_type: 'chat',
              routing_strategy: 'load_balance',
              pm_id: 'mock-pm-id',
              pm_name: 'deepseek-chat',
              model_type: 'chat',
              weight: 100,
              priority: 0,
              provider_id: 'provider-deepseek',
              provider_kind: 'deepseek', 
              provider_name: 'DeepSeek Mock Provider',
              credential_type: 'api_key',
              credential: { key: 'sk-mock-deepseek' },
              base_url: 'https://api.deepseek.com',
              provider_config: {},
              pm_capabilities: ['cache', 'stream'],
              pm_supported_parameters: ['temperature', 'top_p'],
              pm_model_config: {},
              vm_created_at: new Date('2024-01-01T00:00:00Z'),
            },
          ],
          command: 'SELECT',
          rowCount: 1,
          oid: 0,
          fields: [],
        } as any;
      }
      
      // 模拟加载提供商
      if (q.includes('model_providers')) {
        return {
          rows: [
            {
              id: 'provider-deepseek',
              kind: 'deepseek',
              name: 'DeepSeek Mock Provider',
              credential_type: 'api_key',
              credential: { key: 'sk-mock-deepseek' },
              base_url: 'https://api.deepseek.com',
              config: {},
            },
          ],
          command: 'SELECT',
          rowCount: 1,
          oid: 0,
          fields: [],
        } as any;
      }

      return { rowCount: 0, rows: [] } as any;
    });

    await configManager.loadAll();
  });

  afterAll(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  it('should successfully intercept the real external API request via nock and return zero-cost mock response', async () => {
    // 拦截外发的 HTTP POST 请求给 deepseek
    nock('https://api.deepseek.com')
      .post('/chat/completions')
      .reply(200, {
        id: 'mock-deepseek-chat-id',
        object: 'chat.completion',
        created: Date.now(),
        model: 'deepseek-chat',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '这是一个没有花真钱的Mock响应，证明缓存等复杂能力路由成功。' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      });

    const response = await request(app)
      .post('/model/openai-compat/v1/chat/completions')
      .set('Authorization', 'Bearer test-token')
      .send({
        model: 'deepseek-mock',
        messages: [{ role: 'user', content: '你好，Nock拦截测试正常吗？' }],
        temperature: 0.8,
      });

    console.log(JSON.stringify(response.body, null, 2));
    if (response.status !== 200) {
      throw new Error('Test failed with status ' + response.status + ' body: ' + JSON.stringify(response.body));
    }
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('id');
    expect(response.body.choices[0].message.content).toContain('没有花真钱的Mock响应');
  });
});
