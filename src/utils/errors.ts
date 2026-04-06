import type { ProviderErrorDetail } from '@/types/provider';

/**
 * 网关统一错误类
 * 所有可预期的业务错误均通过此类抛出
 */
export class GatewayError extends Error {
  /** HTTP 状态码 */
  public readonly statusCode: number;

  /** 机器可读的错误代码 */
  public readonly errorCode: string;

  /** 提供商原始错误详情（仅提供商来源的错误携带） */
  public readonly providerDetail?: ProviderErrorDetail | undefined;

  public constructor(statusCode: number, errorCode: string, message: string, providerDetail?: ProviderErrorDetail) {
    super(message);
    this.name = 'GatewayError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.providerDetail = providerDetail;

    // 保持正确的原型链并捕获干净的堆栈信息
    Object.setPrototypeOf(this, GatewayError.prototype);
  }
}
