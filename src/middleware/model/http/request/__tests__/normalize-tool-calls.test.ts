/* eslint-disable @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-unsafe-member-access */
import type { ModelHttpContext } from '@/types';
import { normalizeChatToolCallIds } from '../normalize-tool-calls';

jest.mock('@/utils', () => ({
  ...jest.requireActual<typeof import('@/utils')>('@/utils'),
  normalizeToolCallIds: jest.fn((msgs: unknown[]) => msgs.map((m) => ({ ...(m as object), normalized: true }))),
}));

describe('normalizeChatToolCallIds middleware', () => {
  it('should normalize messages when request has messages field', () => {
    const ctx = {
      request: {
        messages: [{ role: 'user', content: 'hi' }],
      },
    } as unknown as ModelHttpContext;

    normalizeChatToolCallIds(ctx);

    expect((ctx.request as any).messages[0]).toMatchObject({ normalized: true });
  });

  it('should skip when ctx.request is undefined', () => {
    const ctx = {} as ModelHttpContext;
    expect(async () => {
      await normalizeChatToolCallIds(ctx);
    }).not.toThrow();
  });

  it('should skip when request has no messages field (e.g. embedding request)', () => {
    const ctx = {
      request: { input: ['text'] },
    } as unknown as ModelHttpContext;
    expect(async () => {
      await normalizeChatToolCallIds(ctx);
    }).not.toThrow();
  });
});
