// src/db/users/index.ts — 用户模块出口

export type { UserUpdateData } from './repository';
export {
  countUsers,
  createUser,
  deleteUser,
  findByEmail,
  findByOidcSub,
  findById,
  getUserAvatarData,
  listUsers,
  updateUser,
} from './repository';
