import type { Response } from 'express';
import { applyMiddlewares } from '@/middleware';
import { dispatchChatProviderStream } from '@/providers/engine';
import { assertRouted } from '@/router';
import type { GatewayContext, InternalChatStreamChunk } from '@/types';
import { getUserChatAdapter } from '@/users';
import { normalizeStreamChunkToolCallIds } from '@/utils';
import { mergeStreamChunks, processStreamSend } from './stream';

// 只需 Mock 特定的外部依赖
jest.mock('@/providers/engine');
jest.mock('@/users');
jest.mock('@/middleware');
jest.mock('@/router');
jest.mock('@/utils', () => ({
  ...jest.requireActual<typeof import('@/utils')>('@/utils'),
  normalizeStreamChunkToolCallIds: jest.fn(),
}));

describe('Stream Data Flow', () => {
  let mockRes: jest.Mocked<Response>;
  let mockCtx: GatewayContext;

  beforeEach(() => {
    jest.resetAllMocks();

    mockRes = {
      writeHead: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
      getHeaders: jest.fn().mockReturnValue({ 'content-type': 'text/event-stream' }),
    } as unknown as jest.Mocked<Response>;

    mockCtx = {
      id: 'test-req',
      userFormat: 'openai',
      requestModel: 'test-model',
      timing: { start: 1000 },
      audit: {},
      request: { stream: true },
    } as unknown as GatewayContext;
  });

  describe('processStreamSend', () => {
    it('should iterate stream and format chunks', async () => {
      // Mock adapters
      const formatChunkMock = jest.fn((_ctx, chunk) => `data: ${JSON.stringify(chunk)}\n\n`);
      const formatEndMock = jest.fn(() => 'data: [DONE]\n\n');
      const fromInternalMock = jest.fn().mockReturnValue({ test: 'response' });

      (getUserChatAdapter as jest.Mock).mockReturnValue({
        streamResponse: { formatChunk: formatChunkMock, formatEnd: formatEndMock },
        response: { fromInternal: fromInternalMock },
      });

      // Mock generator stream
      async function* mockStream(): AsyncGenerator<unknown, void, unknown> {
        await Promise.resolve();
        yield { id: '1', choices: [{ index: 0, delta: { content: 'hello' } }] };
        yield { id: '1', choices: [{ index: 0, delta: { content: ' world' } }] };
      }

      (dispatchChatProviderStream as jest.Mock).mockResolvedValue({ stream: mockStream() });
      (normalizeStreamChunkToolCallIds as jest.Mock).mockImplementation((c: unknown) => c);

      await processStreamSend(mockCtx, mockRes, []);

      expect(assertRouted).toHaveBeenCalledWith(mockCtx);
      expect(mockRes.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({ 'Content-Type': 'text/event-stream' }),
      );

      // Write should be called for each chunk and terminator
      expect(mockRes.write).toHaveBeenCalledTimes(3);
      expect(formatChunkMock).toHaveBeenCalledTimes(2);
      expect(formatEndMock).toHaveBeenCalledTimes(1);
      expect(mockRes.end).toHaveBeenCalled();

      // Ensure timing TTFT is set
      expect(mockCtx.timing.ttft).toBeDefined();
      // Ensure context is updated with merged response
      expect(mockCtx.response).toBeDefined();
      expect(mockCtx.audit.providerResponse).toBeDefined();
      expect(mockCtx.audit.userResponse).toBeDefined();

      expect(applyMiddlewares).toHaveBeenCalled();
    });

    it('should gracefully handle empty chunks without content for TTFT', async () => {
      const formatChunkMock = jest.fn(() => '');
      const formatEndMock = jest.fn(() => null);

      (getUserChatAdapter as jest.Mock).mockReturnValue({
        streamResponse: { formatChunk: formatChunkMock, formatEnd: formatEndMock },
        response: { fromInternal: jest.fn() },
      });

      async function* mockStream(): AsyncGenerator<unknown, void, unknown> {
        await Promise.resolve();
        // No actual content delta
        yield { id: '1', choices: [{ index: 0, delta: {} }] };
      }

      (dispatchChatProviderStream as jest.Mock).mockResolvedValue({ stream: mockStream() });
      (normalizeStreamChunkToolCallIds as jest.Mock).mockImplementation((c: unknown) => c);

      await processStreamSend(mockCtx, mockRes, []);

      // Because there was no content, ttft shouldn't be recorded specifically from chunk
      expect(mockCtx.timing.ttft).toBeUndefined();
      expect(mockRes.write).not.toHaveBeenCalled();
    });
  });

  describe('mergeStreamChunks', () => {
    it('should correctly merge sequential chunks', () => {
      const chunks: InternalChatStreamChunk[] = [
        {
          created: 1,
          model: 'test',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }],
        },
        {
          created: 2,
          model: 'test',
          choices: [{ index: 0, delta: { content: ' world' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        },
      ] as unknown as InternalChatStreamChunk[];

      const result = mergeStreamChunks(chunks);

      expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
      expect(result.choices).toHaveLength(1);
      expect(result.choices[0]?.message.content).toBe('hello world');
      expect(result.choices[0]?.finish_reason).toBe('stop');
      expect(result.choices[0]?.message.role).toBe('assistant');
    });

    it('should merge multiple tool calls and reasoning contents correctly', () => {
      const chunks: InternalChatStreamChunk[] = [
        {
          created: 1,
          model: '',
          choices: [
            {
              index: 0,
              delta: {
                reasoning_content: 'thinking...',
                tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"lo' } }],
              },
              finish_reason: null,
            },
          ],
        } as unknown as InternalChatStreamChunk,
        {
          created: 2,
          model: '',
          choices: [
            {
              index: 0,
              delta: {
                reasoning_content: '\naha!',
                tool_calls: [{ index: 0, function: { arguments: 'cation": "NYC"}' } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
        } as unknown as InternalChatStreamChunk,
      ];

      const result = mergeStreamChunks(chunks);

      expect(result.choices[0]?.message.reasoning_content).toBe('thinking...\naha!');
      expect(result.choices[0]?.message.tool_calls).toHaveLength(1);
      expect(result.choices[0]?.message.tool_calls?.[0]).toEqual({
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"location": "NYC"}' },
      });
      expect(result.choices[0]?.finish_reason).toBe('tool_calls');
      // No plain content means it might be null or omitted depending on implementation
      expect(result.choices[0]?.message.content).toBeNull();
    });
  });
});
