# src/db/apps — 应用（App）数据模块

> 父模块：参见 [db/README.md](../README.md)

## 简介

管理应用（App）的持久化数据和内存缓存。每个 App 拥有一个固定的 API Key，并维护允许访问的模型和 MCP 白名单。

## 目录结构

```
apps/
├── cache.ts      # 内存缓存（loadAppCache / invalidateAppCache / lookupApp / lookupAppByKey）
├── queries.ts    # CRUD 操作（listApps / getAppById / createApp / updateApp / deleteApp / rotateAppKey）
├── types.ts      # AppCacheEntry 类型定义
└── index.ts      # 统一导出
```

## 核心接口

### AppCacheEntry

```typescript
interface AppCacheEntry {
  id: string;
  name: string;
  isActive: boolean;
  apiKey: string;
  allowedModelIds: string[];  // 虚拟模型内部 ID 白名单
  allowedMcpIds: string[];    // 虚拟 MCP 内部 ID 白名单
}
```

### 缓存操作

| 函数 | 说明 |
|---|---|
| `lookupApp(appId)` | 按 ID 查找 App（懒加载缓存） |
| `lookupAppByKey(apiKey)` | 按 API Key 查找 App（鉴权热路径） |
| `invalidateAppCache()` | 清除缓存（写操作后自动调用） |

### CRUD 操作

| 函数 | 说明 |
|---|---|
| `listApps(opts)` | 游标分页查询（支持 search/is_active/starting_after） |
| `getAppById(id)` | 查询单个 App 详情 |
| `createApp(input)` | 创建 App（自动生成 API Key） |
| `updateApp(id, input)` | 更新 App（name/is_active/allowed_model_ids/allowed_mcp_ids） |
| `deleteApp(id)` | 删除 App |
| `rotateAppKey(id)` | 轮换 API Key（生成新 Key 并更新缓存） |

## 缓存策略

双索引内存 Map（`Map<id, AppCacheEntry>` + `Map<apiKey, AppCacheEntry>`），所有写操作（create/update/delete/rotateKey）执行后自动调用 `invalidateAppCache()`，下次读取时触发重新加载。
