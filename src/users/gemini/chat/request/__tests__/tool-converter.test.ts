import { convertToolConfig, convertTools } from '../tool-converter';
import type { GeminiTool, GeminiToolConfig } from '../types';

describe('Gemini Tool Converter', () => {
  describe('convertTools', () => {
    it('应该处理 undefined', () => {
      expect(convertTools()).toEqual([]);
    });

    it('应该转换普通 functionDeclarations 并规范化 scheme', () => {
      const tools: GeminiTool[] = [
        {
          functionDeclarations: [
            {
              name: 'getWeather',
              description: 'Get the current weather',
              parameters: {
                type: 'OBJECT',
                properties: {
                  location: { type: 'STRING' },
                  nullableProp: { type: 'NULL' }, // should be removed
                },
              },
            },
          ],
        },
      ];

      const converted = convertTools(tools);
      expect(converted).toEqual([
        {
          type: 'function',
          function: {
            name: 'getWeather',
            description: 'Get the current weather',
            parameters: {
              type: 'object',
              properties: {
                location: { type: 'string' },
                nullableProp: {},
              },
            },
          },
        },
      ]);
    });

    it('应该处理复杂的组合 schema (anyOf/type arrays) 并移除 null', () => {
      const tools: GeminiTool[] = [
        {
          functionDeclarations: [
            {
              name: 'complexTool',
              parameters: {
                type: 'OBJECT',
                properties: {
                  prop1: { type: ['STRING', 'NULL'] },
                  prop2: {
                    anyOf: [{ type: 'NUMBER' }, { type: 'null' }],
                  },
                },
              },
            },
          ],
        },
      ];

      const converted = convertTools(tools);
      expect(converted).toEqual([
        {
          type: 'function',
          function: {
            name: 'complexTool',
            description: undefined,
            parameters: {
              type: 'object',
              properties: {
                prop1: { type: 'string' },
                prop2: {
                  anyOf: [{ type: 'number' }],
                },
              },
            },
          },
        },
      ]);
    });

    it('应该处理 array 元素、复合allOf/oneOf和无效 type 字段的回退情况', () => {
      const tools: GeminiTool[] = [
        {
          functionDeclarations: [
            {
              name: 'edgeCases',
              parameters: {
                type: 'OBJECT',
                properties: {
                  multiType: { type: ['STRING', 'NUMBER', 'NULL'] },
                  numericType: { type: 123 as unknown as string }, // hits typeof type !== string
                  arrItems: {
                    type: 'ARRAY',
                    items: { type: 'integer' },
                  },
                  comboOf: {
                    oneOf: [{ type: 'STRING' }, null as unknown as object, 'not-an-object' as unknown as object],
                    allOf: [{ type: 'BOOLEAN' }],
                    anyOf: ['invalid' as unknown as object],
                  },
                },
              },
            },
          ],
        },
      ];

      const converted = convertTools(tools);
      expect(converted).toEqual([
        {
          type: 'function',
          function: {
            name: 'edgeCases',
            description: undefined,
            parameters: {
              type: 'object',
              properties: {
                multiType: { type: ['string', 'number'] },
                numericType: { type: 123 },
                arrItems: {
                  type: 'array',
                  items: { type: 'integer' },
                },
                comboOf: {
                  oneOf: [{ type: 'string' }, null, 'not-an-object'],
                  allOf: [{ type: 'boolean' }],
                  anyOf: ['invalid'],
                },
              },
            },
          },
        },
      ]);
    });

    it('如果 parameters 不是 object，应该强制加上 type: object', () => {
      const tools: GeminiTool[] = [
        {
          functionDeclarations: [
            {
              name: 'emptyParams',
              parameters: undefined as never,
            },
            {
              name: 'nullParams',
              parameters: null as never,
            },
          ],
        },
      ];

      const converted = convertTools(tools);
      expect(converted).toEqual([
        {
          type: 'function',
          function: {
            name: 'emptyParams',
            description: undefined,
            parameters: { type: 'object', properties: {} },
          },
        },
        {
          type: 'function',
          function: {
            name: 'nullParams',
            description: undefined,
            parameters: { type: 'object', properties: {} },
          },
        },
      ]);
    });

    it('如果 parameters 不是 object 类型而是 string（或其他配置），应包裹一层 object 并添加缺少的 properties', () => {
      const tools: GeminiTool[] = [
        {
          functionDeclarations: [
            {
              name: 'stringParams',
              parameters: {
                type: 'STRING',
              } as unknown as Record<string, unknown>,
            },
          ],
        },
      ];

      const converted = convertTools(tools);
      expect(converted).toEqual([
        {
          type: 'function',
          function: {
            name: 'stringParams',
            description: undefined,
            parameters: { type: 'object', properties: {} },
          },
        },
      ]);
    });
  });

  describe('convertToolConfig', () => {
    it('应该处理 undefined', () => {
      expect(convertToolConfig()).toBeUndefined();
    });

    it('应该转换 mode: NONE', () => {
      const config: GeminiToolConfig = { functionCallingConfig: { mode: 'NONE' } };
      expect(convertToolConfig(config)).toBe('none');
    });

    it('应该转换 mode: AUTO', () => {
      const config: GeminiToolConfig = { functionCallingConfig: { mode: 'AUTO' } };
      expect(convertToolConfig(config)).toBe('auto');
    });

    it('应该转换 mode: ANY 会返回 required 如果没有 specified func', () => {
      const config: GeminiToolConfig = { functionCallingConfig: { mode: 'ANY' } };
      expect(convertToolConfig(config)).toBe('required');
    });

    it('如果 mode: ANY 且有 allowedFunctionNames，则指定特定的函数', () => {
      const config: GeminiToolConfig = {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: ['getWeather'],
        },
      };
      expect(convertToolConfig(config)).toEqual({
        type: 'function',
        function: { name: 'getWeather' },
      });
    });
  });
});
