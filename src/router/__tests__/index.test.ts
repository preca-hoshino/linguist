/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { route, assertRouted } from '../index';
import { configManager } from '@/config';
import { GatewayError } from '@/utils';
import type { GatewayContext, InternalChatRequest, InternalEmbeddingRequest } from '@/types';

jest.mock('@/config', () => ({
  configManager: {
    getVirtualModelConfig: jest.fn(),
    resolveAllBackends: jest.fn(),
  },
}));

describe('Router', () => {
  let mockCtx: GatewayContext;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCtx = {
      id: 'test-req',
      requestModel: 'test-model',
      timing: {},
      audit: {},
    } as unknown as GatewayContext;
  });

  describe('assertRouted', () => {
    it('should throw if route is undefined', () => {
      expect(() => {
        assertRouted(mockCtx);
      }).toThrow(GatewayError);
      try {
        assertRouted(mockCtx);
      } catch (err) {
        expect((err as GatewayError).statusCode).toBe(500);
      }
    });

    it('should not throw if route is defined', () => {
      mockCtx.route = {
        model: 'm',
        modelType: 'chat',
        providerKind: 'p',
        providerId: 'pid',
        providerConfig: {} as any,
        strategy: 'failover',
        capabilities: [],
      };
      expect(() => {
        assertRouted(mockCtx);
      }).not.toThrow();
    });
  });

  describe('route capabilities inference', () => {
    it('should infer empty array if req is undefined', () => {
      (configManager.getVirtualModelConfig as jest.Mock).mockReturnValue({
        modelType: 'chat',
        backends: [{ id: 'b1' }],
      });
      (configManager.resolveAllBackends as jest.Mock).mockReturnValue([
        {
          actualModel: 'am',
          modelType: 'chat',
          providerKind: 'pk',
          providerId: 'pi',
          provider: {},
          routingStrategy: 's',
          capabilities: [],
        },
      ]);
      route(mockCtx, 'chat');
      expect(mockCtx.route?.capabilities).toEqual([]);
    });

    it('should infer nothing if no matching keys (empty object)', () => {
      (configManager.getVirtualModelConfig as jest.Mock).mockReturnValue({
        modelType: 'chat',
        backends: [{ id: 'b1' }],
      });
      (configManager.resolveAllBackends as jest.Mock).mockReturnValue([{ actualModel: 'am', providerKind: 'pk' }]);
      mockCtx.request = {} as any;
      route(mockCtx);
      expect(mockCtx.route?.capabilities).toEqual([]);
    });

    it('should infer chat capabilities (vision, tools, thinking)', () => {
      (configManager.getVirtualModelConfig as jest.Mock).mockReturnValue({
        modelType: 'chat',
        backends: [],
      });
      (configManager.resolveAllBackends as jest.Mock).mockReturnValue([{ actualModel: 'am', providerKind: 'pk' }]);

      const req: InternalChatRequest = {
        messages: [{ role: 'user', content: [{ type: 'image', url: 'img' }] }],
        tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
        thinking: { type: 'enabled', budget_tokens: 10 },
        stream: false,
      };
      mockCtx.request = req as unknown as any;
      route(mockCtx);
      expect(configManager.resolveAllBackends).toHaveBeenCalledWith('test-model', ['vision', 'tools', 'thinking']);
    });

    it('should not infer vision if message content is string or text parts', () => {
      (configManager.getVirtualModelConfig as jest.Mock).mockReturnValue({
        modelType: 'chat',
        backends: [],
      });
      (configManager.resolveAllBackends as jest.Mock).mockReturnValue([{ actualModel: 'am', providerKind: 'pk' }]);

      const req = {
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        ],
        thinking: { type: 'disabled' },
      };
      mockCtx.request = req as unknown as any;
      route(mockCtx);
      expect(configManager.resolveAllBackends).toHaveBeenCalledWith('test-model', []);
    });

    it('should infer embedding capabilities (multimodal, sparse_vector)', () => {
      (configManager.getVirtualModelConfig as jest.Mock).mockReturnValue({
        modelType: 'embedding',
        backends: [],
      });
      (configManager.resolveAllBackends as jest.Mock).mockReturnValue([{ actualModel: 'am', providerKind: 'pk' }]);

      const req: InternalEmbeddingRequest = {
        input: [{ type: 'image', url: 'img' }],
        sparse_embedding: 'enabled',
      };
      mockCtx.request = req as unknown as any;
      route(mockCtx, 'embedding');
      expect(configManager.resolveAllBackends).toHaveBeenCalledWith('test-model', ['multimodal', 'sparse_vector']);
    });

    it('should not infer embedding capabilities for normal text inputs', () => {
      (configManager.getVirtualModelConfig as jest.Mock).mockReturnValue({
        modelType: 'embedding',
        backends: [],
      });
      (configManager.resolveAllBackends as jest.Mock).mockReturnValue([{ actualModel: 'am', providerKind: 'pk' }]);

      const req: InternalEmbeddingRequest = {
        input: [{ type: 'text', text: 'hi' }],
        sparse_embedding: 'disabled',
      };
      mockCtx.request = req as unknown as any;
      route(mockCtx, 'embedding');
      expect(configManager.resolveAllBackends).toHaveBeenCalledWith('test-model', []);
    });
  });

  describe('route fallback & errors', () => {
    it('should throw 404 if model not found', () => {
      (configManager.getVirtualModelConfig as jest.Mock).mockReturnValue(undefined);
      expect(() => {
        route(mockCtx);
      }).toThrow(GatewayError);
    });

    it('should throw 400 if expected model type does not match', () => {
      (configManager.getVirtualModelConfig as jest.Mock).mockReturnValue({ modelType: 'embedding' });
      expect(() => {
        route(mockCtx, 'chat');
      }).toThrow(GatewayError);
    });

    it('should throw 400 if capability required but no backend supports it', () => {
      (configManager.getVirtualModelConfig as jest.Mock).mockReturnValue({
        modelType: 'chat',
        backends: [{ id: 'b1' }], // Has backends
      });
      mockCtx.request = { messages: [], tools: [{}] } as unknown as any; // wants 'tools'
      (configManager.resolveAllBackends as jest.Mock).mockReturnValue([]); // None supports it

      expect(() => {
        route(mockCtx);
      }).toThrow(GatewayError); // capability_not_supported
    });

    it('should throw 503 if no backends exist at all', () => {
      (configManager.getVirtualModelConfig as jest.Mock).mockReturnValue({
        modelType: 'chat',
        backends: [], // No backends initially
      });
      mockCtx.request = { messages: [] } as unknown as any;
      (configManager.resolveAllBackends as jest.Mock).mockReturnValue([]); // None resolves

      expect(() => {
        route(mockCtx);
      }).toThrow(GatewayError); // no_backend_available
    });

    it('should throw 500 if selected candidate is unexpectedly falsy', () => {
      (configManager.getVirtualModelConfig as jest.Mock).mockReturnValue({
        modelType: 'chat',
        backends: [{ id: 'b1' }],
      });
      (configManager.resolveAllBackends as jest.Mock).mockReturnValue([undefined]);
      expect(() => {
        route(mockCtx);
      }).toThrow(GatewayError);
    });
  });
});
