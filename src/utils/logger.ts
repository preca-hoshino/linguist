import 'dotenv/config';
import winston from 'winston';

const { combine, timestamp, printf } = winston.format;

// ==================== ANSI 颜色定义 ====================
const colors = {
  reset: '\u001B[0m',
  dim: '\u001B[2m',
  bold: '\u001B[1m',

  // 前景色
  red: '\u001B[31m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  blue: '\u001B[34m',
  magenta: '\u001B[35m',
  cyan: '\u001B[36m',
  white: '\u001B[37m',
  gray: '\u001B[90m',

  // 背景色（用于醒目标注）
  bgRed: '\u001B[41m',
} as const;

/** 导出颜色常量，供各模块注册日志标签颜色 */
export const logColors: typeof colors = colors;

/** 根据日志级别返回对应颜色 */
function levelColor(level: string): string {
  switch (level) {
    case 'error': {
      return colors.red;
    }
    case 'warn': {
      return colors.yellow;
    }
    case 'info': {
      return colors.green;
    }
    case 'debug': {
      return colors.cyan;
    }
    default: {
      return colors.white;
    }
  }
}

/**
 * 服务名称对应颜色，使不同模块日志视觉区分
 * 各模块通过 createLogger 第二参数自行注册
 */
const serviceColors: Record<string, string> = {};

/** 获取服务标签颜色 */
function serviceColor(service: string): string {
  return serviceColors[service] ?? colors.magenta;
}

/** 给文本包裹颜色 */
function colorize(text: string, color: string): string {
  return `${color}${text}${colors.reset}`;
}

/** 从 meta 对象中提取 stack 信息 */
function extractStack(meta: Record<string, unknown>): string | undefined {
  if (typeof meta.stack === 'string') {
    return meta.stack;
  }
  const err = meta.err;
  if (err !== null && err !== undefined && typeof err === 'object' && 'stack' in err) {
    const errObj = err as Record<string, unknown>;
    if (typeof errObj.stack === 'string') {
      return errObj.stack;
    }
  }
  return;
}

// ==================== 日志格式 ====================
// Format: [Time][Level][Service] Message
const logFormat = printf((info) => {
  const { level, message, label: lbl, timestamp: ts, ...meta } = info;
  let msg = String(message);
  // If there are additional properties in meta (the object passed), append them
  if (Object.keys(meta).length > 0) {
    const stack = extractStack(meta);
    msg += stack === undefined ? ` ${colorize(JSON.stringify(meta), colors.gray)}` : `\n${colorize(stack, colors.dim)}`;
  }

  const lc = levelColor(level);
  const tsStr = colorize(`[${String(ts)}]`, colors.gray);
  const lv = colorize(`[${level.toUpperCase().padEnd(5)}]`, lc);
  const svcColor = serviceColor(String(lbl));
  const lb = colorize(`[${String(lbl)}]`, svcColor);

  return `${tsStr}${lv}${lb} ${msg}`;
});

const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

// eslint-disable-next-line @typescript-eslint/naming-convention
import TransportStream from 'winston-transport';

/**
 * 自定义控制台传输层
 * 强制 Winston 通过 console.log / console.error 进行输出，
 * 而不是直接写 process.stdout。这使得 Jest 能完美拦截并缓冲测试期间的日志。
 */
class JestInterceptableConsole extends TransportStream {
  public override log(info: unknown, callback: () => void): void {
    setImmediate(() => {
      this.emit('logged', info);
    });

    callback();
  }
}

const isTestEnv = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;

const rootLogger = winston.createLogger({
  level: LOG_LEVEL,
  format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), logFormat),
  transports: [isTestEnv ? new JestInterceptableConsole() : new winston.transports.Console()],
});

// ==================== Logger 类型与工厂 ====================

export type LogArg = string | Error | Record<string, unknown>;

/** 日志接口 */
export interface Logger {
  info: (objOrMsg: LogArg, msg?: string) => void;
  warn: (objOrMsg: LogArg, msg?: string) => void;
  error: (objOrMsg: LogArg, msg?: string) => void;
  debug: (objOrMsg: LogArg, msg?: string) => void;
}

/** 将 Error 对象转为可序列化的 Record */
function errorToMeta(err: Error): Record<string, unknown> {
  return { message: err.message, stack: err.stack, name: err.name };
}

/** 将 LogArg 转为 Record 供 winston 使用 */
function toMeta(obj: LogArg): Record<string, unknown> {
  if (obj instanceof Error) {
    return errorToMeta(obj);
  }
  return obj as Record<string, unknown>;
}

/**
 * 创建带服务标签的 Logger 实例
 * 每个模块通过 createLogger('ModuleName') 创建专属日志器
 *
 * @param service 服务/模块名，显示在日志中的 [Service] 标签
 * @example
 * const log = createLogger('Config');
 * log.info('Configuration loaded');
 * // => [2024-01-01 12:00:00][INFO ][Config] Configuration loaded
 */
export function createLogger(service: string, color?: string): Logger {
  if (color !== undefined) {
    serviceColors[service] = color;
  }
  const winstonChild = rootLogger.child({ label: service });

  function log(level: 'info' | 'warn' | 'error' | 'debug') {
    return (objOrMsg: LogArg, msg?: string): void => {
      if (typeof objOrMsg === 'string') {
        winstonChild[level](objOrMsg);
      } else {
        winstonChild[level](msg ?? '', toMeta(objOrMsg));
      }
    };
  }

  return {
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    debug: log('debug'),
  };
}

// ==================== 带缓存的 Logger 工厂 ====================

/** Logger 配置规格（标签 + 颜色） */
interface LoggerSpec {
  label: string;
  color: string;
}

/**
 * 创建带缓存的 Logger 工厂
 *
 * 提供一组预注册的 key → { label, color } 映射，
 * 首次按 key 获取时创建 Logger 并缓存，后续直接复用。
 * 未在 specs 中注册的 key 使用默认标签和颜色。
 *
 * @param specs 预注册的 key → LoggerSpec 映射
 * @param defaultPrefix 未注册 key 的标签前缀（如 "Provider"）
 * @param defaultColor 未注册 key 的默认颜色
 */
export function createCachedLoggerFactory(
  specs: Record<string, LoggerSpec>,
  defaultPrefix: string,
  defaultColor: string,
): (key: string) => Logger {
  const cache: Record<string, Logger> = {};
  return (key: string): Logger => {
    if (cache[key] === undefined) {
      const spec = specs[key];
      const label = spec === undefined ? `${defaultPrefix}:${key}` : spec.label;
      const color = spec === undefined ? defaultColor : spec.color;
      cache[key] = createLogger(label, color);
    }
    return cache[key];
  };
}
