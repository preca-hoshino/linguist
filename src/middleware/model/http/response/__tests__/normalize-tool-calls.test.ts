/* eslint-disable @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-unsafe-member-access */
import type { ModelHttpContext } from '@/types';
import { normalizeResponseChatToolCallIds } from '../normalize-tool-calls';

jest.mock('@/utils', () => ({
  ...jest.requireActual<typeof import('@/utils')>('@/utils'),
  normalizeResponseToolCallIds: jest.fn((resp: unknown) => ({ ...(resp as object), normalized: true })),
}));

describe('normalizeResponseChatToolCallIds middleware', () => {
  it('should normalize response when response has choices field', () => {
    const ctx = {
      response: {
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
      },
    } as unknown as ModelHttpContext;

    normalizeResponseChatToolCallIds(ctx);
    expect((ctx.response as any).normalized).toBe(true);
  });

  it('should skip when ctx.response is undefined', () => {
    const ctx = {} as ModelHttpContext;
    expect(async () => {
      await normalizeResponseChatToolCallIds(ctx);
    }).not.toThrow();
  });

  it('should skip when response has no choices field (embedding response)', () => {
    const ctx = {
      response: { data: [] },
    } as unknown as ModelHttpContext;
    expect(async () => {
      await normalizeResponseChatToolCallIds(ctx);
    }).not.toThrow();
    expect((ctx.response as any).normalized).toBeUndefined();
  });
});
