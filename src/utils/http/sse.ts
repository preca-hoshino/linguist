// src/utils/http/sse.ts — SSE (Server-Sent Events) 流式解析器

/**
 * 解析 SSE 流，逐行 yield `data:` 行的内容（不含前缀）
 *
 * 处理规则：
 * - 仅提取以 `data:` 开头的行
 * - 遇到 `data: [DONE]` 时停止（OpenAI/DeepSeek/VolcEngine 终止标记）
 * - 忽略空行及其他 SSE 字段（event:, id:, retry:, 注释行）
 * - Gemini 流没有 [DONE] 标记，连接关闭时自然结束
 *
 * @param body fetch Response 的 ReadableStream
 * @param signal 可选 AbortSignal — 触发后取消 reader 并终止迭代
 */
export async function* parseSSEStream(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // 监听 abort 信号：取消 reader 使在途 read() 抛出，循环自然终止
  const onAbort = (): void => {
    void reader.cancel();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch (_err) {
        // reader.cancel() 导致 read() 抛出：若由 abort 触发则静默退出
        if (signal?.aborted) {
          break;
        }
        throw _err;
      }
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // 按行拆分并逐行处理
      for (;;) {
        const newlineIdx = buffer.indexOf('\n');
        if (newlineIdx === -1) {
          break;
        }

        const line = buffer.slice(0, newlineIdx).trimEnd();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line.startsWith('data:')) {
          continue;
        }

        const data = line.slice(5).trimStart();
        if (data === '[DONE]') {
          return;
        }
        if (data.length > 0) {
          yield data;
        }
      }
    }

    // 处理缓冲区中可能残留的最后一行
    const remaining = buffer.trimEnd();
    if (remaining.startsWith('data:')) {
      const data = remaining.slice(5).trimStart();
      if (data !== '[DONE]' && data.length > 0) {
        yield data;
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
