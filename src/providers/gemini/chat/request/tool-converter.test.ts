import type { ToolDefinition } from '@/types';
import { convertToolChoice, convertTools } from './tool-converter';

describe('Gemini Provider Tool Converter', () => {
  describe('convertTools', () => {
    it('应该转换普通 properties 并去除 null type', () => {
      const tools: ToolDefinition[] = [
        {
          type: 'function',
          function: {
            name: 'getWeather',
            description: 'Gets weather',
            parameters: {
              type: 'object',
              properties: {
                location: { type: 'string' },
                nullable: { type: 'null' },
                mixed: { type: ['string', 'null'] },
              },
            },
          },
        },
      ];
      const result = convertTools(tools);
      expect(result).toEqual([
        {
          functionDeclarations: [
            {
              name: 'getWeather',
              description: 'Gets weather',
              parameters: {
                type: 'object',
                properties: {
                  location: { type: 'string' },
                  nullable: {},
                  mixed: { type: 'string' },
                },
              },
            },
          ],
        },
      ]);
    });

    it('如果 parameters is undefined, null 或非 object，应该强转为 {type: "object"}', () => {
      const tools: ToolDefinition[] = [
        { type: 'function', function: { name: 'f1', parameters: null as unknown as Record<string, unknown> } },
        { type: 'function', function: { name: 'f2', parameters: undefined as unknown as Record<string, unknown> } },
      ];
      expect(convertTools(tools)).toEqual([
        {
          functionDeclarations: [
            { name: 'f1', description: undefined, parameters: { type: 'object', properties: {} } },
            { name: 'f2', description: undefined, parameters: { type: 'object', properties: {} } },
          ],
        },
      ]);
    });
  });

  describe('convertToolChoice', () => {
    it('应该转换 none, auto, required 字符串格式', () => {
      expect(convertToolChoice('none')).toEqual({ functionCallingConfig: { mode: 'NONE' } });
      expect(convertToolChoice('auto')).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
      expect(convertToolChoice('required')).toEqual({ functionCallingConfig: { mode: 'ANY' } });
    });

    it('如果传入了特定函数，应该转换成 ANY + allowedFunctionNames', () => {
      expect(convertToolChoice({ type: 'function', function: { name: 'f' } })).toEqual({
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: ['f'],
        },
      });
    });
  });
});
