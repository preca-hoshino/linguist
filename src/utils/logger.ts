import 'dotenv/config';
import winston from 'winston';

const { combine, timestamp, printf } = winston.format;

// ==================== ANSI 颜色定义 ====================
const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',

  // 前景色
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',

  // 背景色（用于醒目标注）
  bgRed: '\x1b[41m',
} as const;

/** 导出颜色常量，供各模块注册日志标签颜色 */
export const logColors = colors;

/** 根据日志级别返回对应颜色 */
function levelColor(level: string): string {
  switch (level) {
    case 'error':
      return colors.red;
    case 'warn':
      return colors.yellow;
    case 'info':
      return colors.green;
    case 'debug':
      return colors.cyan;
    default:
      return colors.white;
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
  if (typeof meta['stack'] === 'string') {
    return meta['stack'];
  }
  const err = meta['err'];
  if (err !== null && err !== undefined && typeof err === 'object' && 'stack' in err) {
    const errObj = err as Record<string, unknown>;
    if (typeof errObj['stack'] === 'string') {
      return errObj['stack'];
    }
  }
  return undefined;
}

// ==================== 日志格式 ====================
// Format: [Time][Level][Service] Message
const logFormat = printf((info) => {
  const { level, message, label: lbl, timestamp: ts, ...meta } = info;
  let msg = String(message);
  // If there are additional properties in meta (the object passed), append them
  if (Object.keys(meta).length > 0) {
    const stack = extractStack(meta);
    if (stack !== undefined) {
      msg += `\n${colorize(stack, colors.dim)}`;
    } else {
      msg += ` ${colorize(JSON.stringify(meta), colors.gray)}`;
    }
  }

  const lc = levelColor(level);
  const tsStr = colorize(`[${String(ts)}]`, colors.gray);
  const lv = colorize(`[${level.toUpperCase().padEnd(5)}]`, lc);
  const svcColor = serviceColor(String(lbl));
  const lb = colorize(`[${String(lbl)}]`, svcColor);

  return `${tsStr}${lv}${lb} ${msg}`;
});

const LOG_LEVEL = process.env['LOG_LEVEL'] ?? 'info';

// ==================== 根 Logger（共享 Transport & Format） ====================

const rootLogger = winston.createLogger({
  level: LOG_LEVEL,
  format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), logFormat),
  transports: [new winston.transports.Console()],
});

// ==================== Logger 类型与工厂 ====================

export type LogArg = string | Error | Record<string, unknown>;

/** 日志接口 */
export interface Logger {
  info(objOrMsg: LogArg, msg?: string): void;
  warn(objOrMsg: LogArg, msg?: string): void;
  error(objOrMsg: LogArg, msg?: string): void;
  debug(objOrMsg: LogArg, msg?: string): void;
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
