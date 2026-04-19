# src/middleware/model — 模型 API 专属中间件

> 父模块：参见 [middleware/README.md](../README.md)

## 简介

存放与模型 HTTP API 相关的中间件，按协议层进一步细分。当前仅包含 `http/` 子目录，对应 Express HTTP 请求层的中间件实现。

## 目录结构

```
model/
└── http/          # HTTP 请求/响应中间件
    ├── request/   # 请求阶段中间件（路由解析前）
    └── response/  # 响应阶段中间件（提供商返回后）
```

> 详细内容参见 [`model/http/README.md`](http/README.md)

## 设计说明

`model/` 层级作为未来扩展点保留，便于在 HTTP 之外接入其他传输协议（如 WebSocket、gRPC）的模型中间件。当前所有实现均在 `http/` 子目录中。
