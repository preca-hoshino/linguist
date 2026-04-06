# ---- 构建阶段 ----
FROM node:22-alpine AS builder

WORKDIR /app

# 复制依赖定义文件
COPY package*.json ./

# 安装所有依赖（包括开发依赖，用于构建）
RUN npm ci

# 复制源代码并执行构建（TypeScript 编译）
COPY . .
RUN npm run build

# ---- 生产阶段 ----
FROM node:22-alpine

WORKDIR /app

# 从构建阶段复制生产依赖和构建产物
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# 创建非 root 用户以提升安全性（可选）
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

# 暴露端口（根据 .env.example 配置）
EXPOSE 3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# 启动应用
CMD ["node", "dist/index.js"]
