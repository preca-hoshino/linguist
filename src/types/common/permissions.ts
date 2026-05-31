// src/types/common/permissions.ts — 权限模型类型定义

/**
 * 权限模块列表
 */
export const PERMISSION_MODULES = ['models', 'mcp', 'apps', 'users', 'settings'] as const;

export type PermissionModule = (typeof PERMISSION_MODULES)[number];

/**
 * 权限级别：view（只读）、edit（读写）
 * 所有登录用户默认拥有 view 权限
 * edit 隐含 view
 */
export type PermissionLevel = 'view' | 'edit';

/**
 * 用户权限对象 — 每个模块独立权限级别
 */
export interface UserPermissions {
  readonly models: PermissionLevel;
  readonly mcp: PermissionLevel;
  readonly apps: PermissionLevel;
  readonly users: PermissionLevel;
  readonly settings: PermissionLevel;
}

/**
 * 默认权限（全部 view — 由管理员显式提升）
 */
export const DEFAULT_PERMISSIONS: UserPermissions = {
  models: 'view',
  mcp: 'view',
  apps: 'view',
  users: 'view',
  settings: 'view',
} as const;

/**
 * 权限级别数值映射（用于比较）
 */
const LEVEL_VALUE: Record<PermissionLevel, number> = {
  view: 1,
  edit: 2,
} as const;

/**
 * 检查权限是否满足要求（edit 隐含 view）
 *
 * @example
 * hasPermission(user.permissions, 'models', 'view')  // true if models is 'view' or 'edit'
 * hasPermission(user.permissions, 'models', 'edit')   // true only if models is 'edit'
 */
export function hasPermission(permissions: UserPermissions, module: PermissionModule, level: PermissionLevel): boolean {
  return LEVEL_VALUE[permissions[module]] >= LEVEL_VALUE[level];
}

/**
 * 检查是否拥有全部模块的 edit 权限
 */
export function isFullAccess(permissions: UserPermissions): boolean {
  return PERMISSION_MODULES.every((m) => permissions[m] === 'edit');
}

/**
 * 验证权限对象结构合法性
 */
export function validatePermissions(input: unknown): input is UserPermissions {
  if (typeof input !== 'object' || input === null) {
    return false;
  }
  const obj = input as Record<string, unknown>;
  const validLevels = new Set<PermissionLevel>(['view', 'edit']);

  for (const module of PERMISSION_MODULES) {
    if (!validLevels.has(obj[module] as PermissionLevel)) {
      return false;
    }
  }
  return true;
}

/**
 * 检查 operator 是否有权限管理 target（操作者的权限覆盖目标用户）
 * 所有模块中，operator 的级别必须 >= target 的级别
 *
 * @example
 * canManageUser(operatorPerms, targetPerms)  // true if operator >= target on ALL modules
 */
export function canManageUser(operator: UserPermissions, target: UserPermissions): boolean {
  return PERMISSION_MODULES.every((m) => LEVEL_VALUE[operator[m]] >= LEVEL_VALUE[target[m]]);
}
