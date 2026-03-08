# Linguist

<div align="center">

[🇨🇳 中文](README.md) | 🇬🇧 English | [🇯🇵 日本語](README.ja.md) | [🇫🇷 Français](README.fr.md) | [🇩🇪 Deutsch](README.de.md)

</div>

---

**Linguist** is a unified AI model gateway built with Node.js + TypeScript. It accepts requests in multiple formats (OpenAI-compatible format, Gemini native format, etc.), routes them to different AI model providers (DeepSeek, Google Gemini, Volcengine, etc.) based on dynamic configurations stored in the database, and converts responses back to the corresponding user format.

---

## Key Features

| Feature                         | Description                                                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Multi-format User Interface** | Supports OpenAI-compatible and Gemini native formats; clients can integrate without code changes                                                      |
| **Multi-provider Support**      | DeepSeek, Google Gemini, Volcengine, with extensibility for new providers                                                                             |
| **Three-tier Model Routing**    | Provider → ProviderModel → VirtualModel, supports three routing strategies: simple/load_balance/failover; failover automatically retries all backends |
| **Hot-reload Dynamic Config**   | Configurations stored in PostgreSQL, take effect in real-time via LISTEN/NOTIFY, no restart required                                                  |
| **Chat + Embedding**            | Supports both chat completion and text embedding capabilities                                                                                         |
| **Complete Management API**     | RESTful management interface supporting CRUD operations on provider/model mappings                                                                    |
| **Request Audit Logging**       | Full lifecycle of each request (pending → processing → completed/error) persisted to database                                                         |
| **Admin Console**               | Modern management UI built with Vue 3 + mdui, supporting configuration, log viewing, and statistical analysis                                         |
| **Monitoring & Analytics**      | Real-time overview, time-series trends, error analysis, token usage, and multi-dimensional monitoring                                                 |

---

## Quick Start

> **For production deployment, Docker Compose is recommended.**

### Prerequisites

- Node.js >= 18
- PostgreSQL >= 14

### (Optional) Docker Deployment

If using Docker Compose, you only need:
- Docker >= 20.10
- Docker Compose >= 2.0

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Create a `.env` file (see environment variables section below):

```env
# Database connection
DATABASE_URL=postgresql://user:password@localhost:5432/linguist

# Admin API authentication key (any custom string)
ADMIN_KEY=your-secret-admin-key

# Service port (default 3000)
PORT=3000

# Log level: error | warn | info | debug (default info)
LOG_LEVEL=info
```

### 3. Run Database Migration (First-time Deployment)

**For production / first deployment**:
```bash
npm run db:migrate
```

This creates the following tables:
- `providers` — Provider credentials (API Key, base_url, protocol type)
- `provider_models` — Real models from providers
- `virtual_models` — Virtual models exposed to users
- `virtual_model_backends` — Association between virtual and provider models
- `request_logs` — Request audit logs

**For local development** — if you need to reset the database:
```bash
npm run db:reset  # ⚠️ Deletes all data, development only!
```

### 4. Start the Service

#### Local Development Mode

```bash
# Development mode (ts-node, hot reload with nodemon)
npm run dev

# Production mode (compile first)
npm run build && npm start
```

#### Docker Compose Deployment (Recommended for Production)

Start backend gateway and PostgreSQL database with one command:

```bash
# 1. Copy environment variables
cp .env.example .env

# 2. Start all services (including database initialization)
docker-compose up -d

# 3. View service logs
docker-compose logs -f
```

After services start:
- **Backend API**: http://localhost:3000
- **Health Check**: http://localhost:3000/health


#### Available Service Endpoints

After service starts (locally or Docker):
- Health check: `GET http://localhost:3000/api/health`
- Model list (OpenAI format): `GET http://localhost:3000/v1/models`
- Chat endpoint (OpenAI format): `POST http://localhost:3000/v1/chat/completions`
- Embedding endpoint (OpenAI format): `POST http://localhost:3000/v1/embeddings`
- Chat endpoint (Gemini format): `POST http://localhost:3000/v1beta/models/:model:generateContent`
- Streaming chat (Gemini format): `POST http://localhost:3000/v1beta/models/:model:streamGenerateContent`
- Management endpoints: `http://localhost:3000/api/*`

---

## Configuring Three-tier Models (End-to-End Example)

Configure routing chain through the management API, using "DeepSeek API's deepseek-chat model" as an example:

> Use `admin.http` in the project root directly (requires VS Code REST Client extension).

**Step 1: Create a Provider**

```http
POST http://localhost:3000/api/providers
Authorization: Bearer your-secret-admin-key
Content-Type: application/json

{
  "name": "DeepSeek",
  "kind": "deepseek",
  "base_url": "https://api.deepseek.com/v1",
  "api_key": "sk-xxxxxxxxxxxxxxxx"
}
```

**Step 2: Create a Provider Model**

```http
POST http://localhost:3000/api/provider-models
Authorization: Bearer your-secret-admin-key
Content-Type: application/json

{
  "provider_id": "<id returned from step 1>",
  "name": "deepseek-chat",
  "model_type": "chat"
}
```

**Step 3: Create a Virtual Model (the model field in user requests)**

```http
POST http://localhost:3000/api/virtual-models
Authorization: Bearer your-secret-admin-key
Content-Type: application/json

{
  "id": "deepseek-chat",
  "name": "DeepSeek Chat",
  "routing_strategy": "load_balance",
  "backends": [
    { "provider_model_id": "<id returned from step 2>" }
  ]
}
```

Configuration takes effect immediately (no restart needed). Send a chat request:

```http
POST http://localhost:3000/v1/chat/completions
Content-Type: application/json

{
  "model": "deepseek-chat",
  "messages": [
    { "role": "user", "content": "Hello!" }
  ]
}
```

---

## Supported Providers

| Provider               | `kind` value | Chat  | Embedding |
| ---------------------- | ------------ | :---: | :-------: |
| DeepSeek               | `deepseek`   |   ✅   |     —     |
| Google Gemini          | `gemini`     |   ✅   |     ✅     |
| Volcengine (ByteDance) | `volcengine` |   ✅   |     ✅     |

## Supported User API Formats

| Format ID      | Chat Endpoint                                                                      | Embedding Endpoint                        | Description                                        |
| -------------- | ---------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------- |
| `openaicompat` | `POST /v1/chat/completions` (streaming: `stream: true`)                            | `POST /v1/embeddings`                     | OpenAI-compatible format, default for most clients |
| `gemini`       | `POST /v1beta/models/:model:generateContent` (streaming: `:streamGenerateContent`) | `POST /v1beta/models/:model:embedContent` | Google Gemini native format                        |

---

## API Reference

### Gateway API

| Method | Path                                          | Format            | Description                                                 |
| ------ | --------------------------------------------- | ----------------- | ----------------------------------------------------------- |
| `GET`  | `/api/health`                                 | —                 | Health check, returns `{ status: "ok", timestamp, uptime }` |
| `GET`  | `/v1/models`                                  | OpenAI-compatible | Returns list of available virtual models                    |
| `POST` | `/v1/chat/completions`                        | OpenAI-compatible | Chat completion (supports streaming: `stream: true`)        |
| `POST` | `/v1/embeddings`                              | OpenAI-compatible | Text embedding                                              |
| `POST` | `/v1beta/models/:model:generateContent`       | Gemini native     | Chat completion (non-streaming)                             |
| `POST` | `/v1beta/models/:model:streamGenerateContent` | Gemini native     | Chat completion (streaming SSE)                             |
| `POST` | `/v1beta/models/:model:embedContent`          | Gemini native     | Text embedding                                              |

### Thinking Parameters (OpenAI Format)

| Field                    | Type                              | Description                                                                                    |
| ------------------------ | --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `reasoning_effort`       | `"minimal"∕"low"∕"medium"∕"high"` | Reasoning effort level; `minimal` → disabled; others set budget at 20%∕50%∕80% of `max_tokens` |
| `thinking.type`          | `"enabled"∕"disabled"∕"auto"`     | Deep thinking toggle (explicit control, higher priority than `reasoning_effort`)               |
| `thinking.budget_tokens` | `number`                          | Direct specification of thinking token budget, higher priority than `reasoning_effort`         |

### Thinking Parameters (Gemini Format)

| Field                            | Type                              | Description                                                                                                      |
| -------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `thinkingConfig.includeThoughts` | `boolean`                         | Enable thinking mode, default `true`                                                                             |
| `thinkingConfig.thinkingLevel`   | `"MINIMAL"∕"LOW"∕"MEDIUM"∕"HIGH"` | Thinking level; `MINIMAL` maps to disabled; `LOW`∕`MEDIUM`∕`HIGH` set budget at 20%∕50%∕80% of `maxOutputTokens` |
| `thinkingConfig.thinkingBudget`  | `number`                          | Direct specification of thinking token budget, higher priority than `thinkingLevel`                              |

> When `max_tokens` (or `maxOutputTokens`) is not specified, percentage-based levels don't set `budget_tokens`, leaving it to provider defaults.

### Management API

All management endpoints require `Authorization: Bearer <ADMIN_KEY>` header.

| Method           | Path                       | Description                                |
| ---------------- | -------------------------- | ------------------------------------------ |
| `GET/POST`       | `/api/providers`           | List / Create providers                    |
| `GET/PUT/DELETE` | `/api/providers/:id`       | Query / Update / Delete provider           |
| `GET/POST`       | `/api/provider-models`     | List / Create provider models              |
| `GET/PUT/DELETE` | `/api/provider-models/:id` | Query / Update / Delete provider model     |
| `GET/POST`       | `/api/virtual-models`      | List / Create virtual models               |
| `GET/PUT/DELETE` | `/api/virtual-models/:id`  | Query / Update / Delete virtual model      |
| `GET`            | `/api/request-logs`        | Query logs (supports filtering/pagination) |
| `GET`            | `/api/request-logs/:id`    | Query single log details                   |
| `GET/POST`       | `/api/api-keys`            | List / Create user API keys                |
| `GET/PUT/DELETE` | `/api/api-keys/:id`        | Query / Update / Delete API key            |
| `POST`           | `/api/api-keys/:id/rotate` | Rotate API key (regenerate credentials)    |

---

## Project Structure

> See `src/<module>/README.md` for detailed module descriptions.

```
src/
├── index.ts           # Process entry point, graceful shutdown handling
├── server.ts          # Express instance and HTTP route registration
├── app/               # Core flow orchestration (format-agnostic)
│   ├── process.ts     # Main processing (processChatCompletion / processEmbedding)
│   ├── stream.ts      # Streaming transport (processStreamSend / mergeStreamChunks)
│   └── helpers.ts     # Helper functions (finalizeSuccess / finalizeError)
├── api/               # User API format routing
│   ├── openaicompat/  # OpenAI-compatible format
│   └── gemini/        # Gemini native format
├── types/             # Unified internal types
├── config/            # ConfigManager (in-memory cache + LISTEN/NOTIFY)
├── db/                # PostgreSQL connection pool + request logging
├── router/            # Virtual model routing resolution
├── middleware/        # Middleware chain executor
├── users/             # User format adapters
│   ├── error-formatting/   # Error response formatting
│   ├── chat/openaicompat/  # OpenAI format chat adapter
│   ├── chat/gemini/        # Gemini native format chat adapter
│   ├── embedding/openaicompat/ # OpenAI format embedding adapter
│   └── embedding/gemini/   # Gemini format embedding adapter
├── providers/         # Provider adapters
│   ├── error-mapping/ # Provider error mapping
│   ├── chat/
│   │   ├── deepseek/
│   │   ├── gemini/
│   │   └── volcengine/
│   └── embedding/
│       ├── gemini/
│       └── volcengine/
├── admin/             # Management API routes
└── utils/             # Common utilities
ui/                   # Admin console frontend (Vue 3 + TypeScript + mdui)
├── src/api/          # Backend API client layer
├── src/types/        # Frontend type definitions
├── src/utils/        # Frontend utility functions
└── src/components/   # Business components and views
admin.http             # Management API executable examples
```

---

## 🐳 Docker Deployment

The project fully supports Docker and Docker Compose deployment, including backend gateway and PostgreSQL database.

### One-Command Startup

```bash
# Copy environment variables
cp .env.example .env

# Use management script (recommended)
chmod +x scripts/docker.sh
./scripts/docker.sh up

# Or use Docker Compose directly
docker-compose up -d
```

Then access:
- **Backend API**: http://localhost:3000

### Documentation

- **[Docker Deployment Guide](docs/DOCKER.md)** — Complete deployment, production config, troubleshooting
- **[Quick Reference Card](docs/DOCKER-QUICK-REF.md)** — Common commands cheat sheet
- **[Deployment Summary](docs/DOCKER-SUMMARY.md)** — File inventory and architecture overview

### Management Scripts

**Linux/macOS:** `./scripts/docker.sh`  
**Windows:** `scripts\docker.bat`

Supported commands: `up`, `down`, `logs`, `db-backup`, `shell-gateway`, etc. Run `./scripts/docker.sh help` for full list.

### Included Services

| Service    | Image                | Port |
| ---------- | -------------------- | ---- |
| PostgreSQL | `postgres:16-alpine` | 5432 |
| Gateway    | Local build          | 3000 |

---

## Development Guide

### Available Commands

```bash
npm run dev        # Start in development mode (ts-node)
npm run build      # Compile TypeScript to dist/
npm start          # Start in production mode (requires build first)
npm test           # Run Jest tests
npm run type-check # TypeScript type checking (must be error-free)
npm run lint       # ESLint checks (must be error/warning-free)
npm run lint:fix   # ESLint auto-fix
npm run format     # Prettier code formatting
npm run db:migrate # Execute database migrations
npm run db:reset   # ⚠️ Reset database (development only)
```

**Pre-commit checks**: Before committing code, you must pass:
```bash
npm run type-check && npm run lint && npm run format && npm test
```

### Extending the Gateway

- **Add new AI provider**: [`src/providers/README.md`](src/providers/README.md)
- **Add new user API format**: [`src/users/README.md`](src/users/README.md), [`src/api/README.md`](src/api/README.md)
- **Add new middleware**: [`src/middleware/README.md`](src/middleware/README.md)
- **Develop admin console**: [`ui/README.md`](ui/README.md)
- **Contribution guidelines**: See [CONTRIBUTING.md](CONTRIBUTING.md)

---

## Technology Stack

- **Runtime**: Node.js 18+
- **Language**: TypeScript 5
- **Web Framework**: Express 5
- **Database**: PostgreSQL 14+ (`pg` connection pool)
- **Logging**: Winston (structured JSON logs)
- **Testing**: Jest + nock (HTTP mocking)
- **Code Standards**: ESLint + Prettier
