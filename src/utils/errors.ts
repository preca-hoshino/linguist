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

  /** 关联的参数字段名（由 withParam() 设置） */
  private param: string | null = null;

  /** 关联的参数字段名 getter（供 handleAdminError 等使用） */
  public get errorParam(): string | null {
    return this.param;
  }

  public constructor(statusCode: number, errorCode: string, message: string, providerDetail?: ProviderErrorDetail) {
    super(message);
    this.name = 'GatewayError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.providerDetail = providerDetail;

    // 保持正确的原型链并捕获干净的堆栈信息
    Object.setPrototypeOf(this, GatewayError.prototype);
  }

  /**
   * 设置关联的请求参数字段名（链式调用）
   * @example throw new GatewayError(400, 'invalid_request', 'Field is required').withParam('name');
   */
  public withParam(p: string): this {
    this.param = p;
    return this;
  }
}
