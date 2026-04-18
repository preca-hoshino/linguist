import type { ModelHttpContext } from '@/types';
import { applyMiddlewares } from '../index';

jest.mock('@/utils', () => ({
  ...jest.requireActual<typeof import('@/utils')>('@/utils'),
  createLogger: jest.fn(() => ({
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  })),
}));

describe('applyMiddlewares', () => {
  const mockCtx = { id: 'req-test' } as unknown as ModelHttpContext;

  it('should return early with empty middlewares array', async () => {
    await expect(applyMiddlewares(mockCtx, [])).resolves.toBeUndefined();
  });

  it('should call each middleware in order with ctx', async () => {
    const calls: number[] = [];
    const mw1 = jest.fn().mockImplementation(() => {
      calls.push(1);
    });
    const mw2 = jest.fn().mockImplementation(() => {
      calls.push(2);
    });
    await applyMiddlewares(mockCtx, [mw1, mw2]);
    expect(mw1).toHaveBeenCalledWith(mockCtx);
    expect(mw2).toHaveBeenCalledWith(mockCtx);
    expect(calls).toEqual([1, 2]);
  });

  it('should propagate errors thrown by middlewares', async () => {
    const mwFail = jest.fn().mockRejectedValue(new Error('mw-error'));
    await expect(applyMiddlewares(mockCtx, [mwFail])).rejects.toThrow('mw-error');
  });
});
