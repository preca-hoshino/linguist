import { parseSSEStream } from '../sse';

/**
 * 构造一个模拟的 ReadableStream，将给定的 chunks 按序推送。
 * 每个 chunk 在推入队列时会被 Uint8Array 包装。
 */
function createMockStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller: ReadableStreamDefaultController): void {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  }) as unknown as ReadableStream<Uint8Array>;
}

/**
 * 辅助函数：从字符串数组创建 ReadableStream
 */
function streamFromStrings(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return createMockStream(lines.map((l) => encoder.encode(l)));
}

/**
 * 辅助函数：收集生成器的所有 yield 值
 */
async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const results: string[] = [];
  for await (const value of parseSSEStream(stream)) {
    results.push(value);
  }
  return results;
}

describe('parseSSEStream', () => {
  it('should parse single data line', async () => {
    const stream = streamFromStrings(['data: {"key":"value"}\n']);
    const results = await collectStream(stream);
    expect(results).toEqual(['{"key":"value"}']);
  });

  it('should parse multiple data lines in separate chunks', async () => {
    const encoder = new TextEncoder();
    const stream = createMockStream([encoder.encode('data: first\n'), encoder.encode('data: second\n')]);
    const results = await collectStream(stream);
    expect(results).toEqual(['first', 'second']);
  });

  it('should parse multiple data lines in a single chunk', async () => {
    const stream = streamFromStrings(['data: a\ndata: b\ndata: c\n']);
    const results = await collectStream(stream);
    expect(results).toEqual(['a', 'b', 'c']);
  });

  it('should handle data with leading whitespace after prefix', async () => {
    const stream = streamFromStrings(['data:  {"spaced":true}\n']);
    const results = await collectStream(stream);
    expect(results).toEqual(['{"spaced":true}']);
  });

  it('should stop on [DONE] marker', async () => {
    const stream = streamFromStrings(['data: first\n', 'data: [DONE]\n', 'data: should_not_appear\n']);
    const results = await collectStream(stream);
    expect(results).toEqual(['first']);
  });

  it('should ignore event:, id:, retry:, and comment lines', async () => {
    const stream = streamFromStrings([
      'event: message\n',
      'id: 42\n',
      'retry: 3000\n',
      ':comment line\n',
      'data: actual\n',
    ]);
    const results = await collectStream(stream);
    expect(results).toEqual(['actual']);
  });

  it('should skip empty data lines', async () => {
    const stream = streamFromStrings(['data: \n', 'data: real\n', 'data:\n']);
    const results = await collectStream(stream);
    expect(results).toEqual(['real']);
  });

  it('should handle chunks split mid-line (partial buffer)', async () => {
    const encoder = new TextEncoder();
    const stream = createMockStream([encoder.encode('data: {"partial'), encoder.encode('":"value"}\n')]);
    const results = await collectStream(stream);
    expect(results).toEqual(['{"partial":"value"}']);
  });

  it('should process remaining buffer after stream ends (no trailing newline)', async () => {
    const encoder = new TextEncoder();
    const stream = createMockStream([encoder.encode('data: last-line')]);
    const results = await collectStream(stream);
    expect(results).toEqual(['last-line']);
  });

  it('should handle [DONE] in remaining buffer', async () => {
    const encoder = new TextEncoder();
    const stream = createMockStream([encoder.encode('data: first\ndata: [DONE]')]);
    const results = await collectStream(stream);
    expect(results).toEqual(['first']);
  });

  it('should handle empty remaining buffer', async () => {
    const encoder = new TextEncoder();
    const stream = createMockStream([encoder.encode('\n')]);
    const results = await collectStream(stream);
    expect(results).toEqual([]);
  });

  it('should yield nothing for empty stream', async () => {
    const stream = createMockStream([]);
    const results = await collectStream(stream);
    expect(results).toEqual([]);
  });

  it('should release reader lock when done', async () => {
    const encoder = new TextEncoder();
    const stream = createMockStream([encoder.encode('data: test\n')]);
    const reader = stream.getReader();
    const releaseLockSpy = jest.spyOn(reader, 'releaseLock');
    jest.spyOn(stream, 'getReader').mockReturnValue(reader);

    const results: string[] = [];
    for await (const value of parseSSEStream(stream)) {
      results.push(value);
    }
    expect(results).toEqual(['test']);
    expect(releaseLockSpy).toHaveBeenCalled();
  });
});
