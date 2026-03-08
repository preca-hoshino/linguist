# Linguist

<div align="center">

[🇨🇳 中文](README.md) | [🇬🇧 English](README.en.md) | 🇯🇵 日本語 | [🇫🇷 Français](README.fr.md) | [🇩🇪 Deutsch](README.de.md)

</div>

---

**Linguist** は Node.js + TypeScript で構築された、統一された AI モデルゲートウェイです。複数のフォーマット（OpenAI 互換形式、Gemini ネイティブ形式など）でリクエストを受け取り、データベースに保存された動的設定に基づいて異なる AI モデルプロバイダ（DeepSeek、Google Gemini、Volcengine など）にルーティングし、レスポンスを対応するユーザーフォーマットに変換してクライアントに返します。

---

## コア機能

| 機能                       | 説明                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **複数フォーマット対応**   | OpenAI 互換形式と Gemini ネイティブ形式をサポート；クライアントはコード変更なしに統合可能                                                                  |
| **マルチプロバイダ対応**   | DeepSeek、Google Gemini、Volcengine に対応；新プロバイダの追加が容易                                                                                       |
| **3 層モデルルーティング** | Provider → ProviderModel → VirtualModel；simple/load_balance/failover の 3 つのルーティング戦略をサポート；failover は全バックエンドへの自動リトライに対応 |
| **ホットリロード対応**     | 設定は PostgreSQL に保存され、LISTEN/NOTIFY で リアルタイム反映；再起動不要                                                                                |
| **Chat + Embedding**       | チャット補完とテキスト埋め込みの両方の機能に対応                                                                                                           |
| **完全な管理 API**         | RESTful 管理インターフェース；プロバイダ/モデルマッピングの CRUD 操作に対応                                                                                |
| **リクエスト監査ログ**     | 各リクエストのライフサイクル全体（pending → processing → completed/error）をデータベースに永続化                                                           |
| **管理コンソール**         | Vue 3 + mdui で構築されたモダンな管理 UI；設定管理、ログ閲覧、統計分析に対応                                                                               |
| **監視・分析機能**         | リアルタイム概要、時系列トレンド、エラー分析、トークン使用量など、多次元的な監視機能                                                                       |

---

## クイックスタート

> **本番環境への導入には Docker Compose の使用をお勧めします。**

### 前提条件

- Node.js >= 18
- PostgreSQL >= 14

### （オプション）Docker での展開

Docker Compose を使用する場合：
- Docker >= 20.10
- Docker Compose >= 2.0

### 1. 依存関係のインストール

```bash
npm install
```

### 2. 環境変数の設定

`.env` ファイルを作成します（環境変数の説明は下記を参照）：

```env
# データベース接続
DATABASE_URL=postgresql://user:password@localhost:5432/linguist

# 管理 API 認証キー（任意の文字列）
ADMIN_KEY=your-secret-admin-key

# サービスポート（デフォルト 3000）
PORT=3000

# ログレベル: error | warn | info | debug（デフォルト info）
LOG_LEVEL=info
```

### 3. データベースマイグレーションの実行（初回展開時）

**本番環境 / 初回展開時**：
```bash
npm run db:migrate
```

次のテーブルを作成します：
- `providers` — プロバイダ情報（API キー、base_url、プロトコルタイプ）
- `provider_models` — プロバイダ側の実際のモデル
- `virtual_models` — ユーザーに公開する仮想モデル
- `virtual_model_backends` — 仮想モデルとプロバイダモデルの関連付け
- `request_logs` — リクエスト監査ログ

**ローカル開発環境用** — データベースをリセットする場合：
```bash
npm run db:reset  # ⚠️ すべてのデータを削除；開発用のみ！
```

### 4. サービスの起動

#### ローカル開発モード

```bash
# 開発モード（ts-node、nodemon で ホットリロード対応）
npm run dev

# 本番モード（先にコンパイル）
npm run build && npm start
```

#### Docker Compose での展開（本番環境推奨）

バックエンドゲートウェイと PostgreSQL データベースを 1 つのコマンドで起動：

```bash
# 1. 環境変数ファイルをコピー
cp .env.example .env

# 2. すべてのサービスを起動（データベース初期化を含む）
docker-compose up -d

# 3. サービスログを表示
docker-compose logs -f
```

サービス起動後：
- **バックエンド API**：http://localhost:3000
- **ヘルスチェック**：http://localhost:3000/health


#### 利用可能なサービスエンドポイント

サービス起動後（ローカルまたは Docker）：
- ヘルスチェック：`GET http://localhost:3000/api/health`
- モデルリスト（OpenAI 形式）：`GET http://localhost:3000/v1/models`
- チャットエンドポイント（OpenAI 形式）：`POST http://localhost:3000/v1/chat/completions`
- 埋め込みエンドポイント（OpenAI 形式）：`POST http://localhost:3000/v1/embeddings`
- チャットエンドポイント（Gemini 形式）：`POST http://localhost:3000/v1beta/models/:model:generateContent`
- ストリーミングチャット（Gemini 形式）：`POST http://localhost:3000/v1beta/models/:model:streamGenerateContent`
- 管理エンドポイント：`http://localhost:3000/api/*`

---

## 3 層モデルの設定（エンドツーエンド例）

管理 API を通じてルーティングチェーンを設定します。例として「DeepSeek API の deepseek-chat モデルを使用」する場合を説明します：

> プロジェクトルートの `admin.http` を直接使用できます（VS Code REST Client 拡張が必要）。

**ステップ 1: プロバイダを作成**

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

**ステップ 2: プロバイダモデルを作成**

```http
POST http://localhost:3000/api/provider-models
Authorization: Bearer your-secret-admin-key
Content-Type: application/json

{
  "provider_id": "<ステップ 1 で返された id>",
  "name": "deepseek-chat",
  "model_type": "chat"
}
```

**ステップ 3: 仮想モデルを作成（ユーザーリクエストの model フィールド）**

```http
POST http://localhost:3000/api/virtual-models
Authorization: Bearer your-secret-admin-key
Content-Type: application/json

{
  "id": "deepseek-chat",
  "name": "DeepSeek Chat",
  "routing_strategy": "load_balance",
  "backends": [
    { "provider_model_id": "<ステップ 2 で返された id>" }
  ]
}
```

設定は即座に有効になります（再起動不要）。チャットリクエストを送信します：

```http
POST http://localhost:3000/v1/chat/completions
Content-Type: application/json

{
  "model": "deepseek-chat",
  "messages": [
    { "role": "user", "content": "こんにちは！" }
  ]
}
```

---

## サポートされているプロバイダ

| プロバイダ              | `kind` 値    | Chat  | Embedding |
| ----------------------- | ------------ | :---: | :-------: |
| DeepSeek                | `deepseek`   |   ✅   |     —     |
| Google Gemini           | `gemini`     |   ✅   |     ✅     |
| Volcengine（ByteDance） | `volcengine` |   ✅   |     ✅     |

## サポートされているユーザー API フォーマット

| フォーマット ID | チャットエンドポイント                                                                   | 埋め込みエンドポイント                    | 説明                                                    |
| --------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------- |
| `openaicompat`  | `POST /v1/chat/completions`（ストリーミング：`stream: true`）                            | `POST /v1/embeddings`                     | OpenAI 互換形式；大多数の クライアントで デフォルト対応 |
| `gemini`        | `POST /v1beta/models/:model:generateContent`（ストリーミング：`:streamGenerateContent`） | `POST /v1beta/models/:model:embedContent` | Google Gemini ネイティブ形式                            |

---

## API リファレンス

### ゲートウェイ API

| メソッド | パス                                          | フォーマット      | 説明                                                         |
| -------- | --------------------------------------------- | ----------------- | ------------------------------------------------------------ |
| `GET`    | `/api/health`                                 | —                 | ヘルスチェック；`{ status: "ok", timestamp, uptime }` を返す |
| `GET`    | `/v1/models`                                  | OpenAI 互換       | 利用可能な仮想モデルリストを返す                             |
| `POST`   | `/v1/chat/completions`                        | OpenAI 互換       | チャット補完（ストリーミング対応：`stream: true`）           |
| `POST`   | `/v1/embeddings`                              | OpenAI 互換       | テキスト埋め込み                                             |
| `POST`   | `/v1beta/models/:model:generateContent`       | Gemini ネイティブ | チャット補完（非ストリーミング）                             |
| `POST`   | `/v1beta/models/:model:streamGenerateContent` | Gemini ネイティブ | チャット補完（ストリーミング SSE）                           |
| `POST`   | `/v1beta/models/:model:embedContent`          | Gemini ネイティブ | テキスト埋め込み                                             |

### シンキングパラメータ（OpenAI 形式）

| フィールド               | 型                                | 説明                                                                          |
| ------------------------ | --------------------------------- | ----------------------------------------------------------------------------- |
| `reasoning_effort`       | `"minimal"∕"low"∕"medium"∕"high"` | 推論努力レベル；`minimal` → 無効；その他は `max_tokens` の 20%∕50%∕80% に設定 |
| `thinking.type`          | `"enabled"∕"disabled"∕"auto"`     | ディープシンキングの切り替え（明示的制御；`reasoning_effort` より優先度高）   |
| `thinking.budget_tokens` | `number`                          | シンキングトークン予算を直接指定；`reasoning_effort` より優先度高             |

### シンキングパラメータ（Gemini 形式）

| フィールド                       | 型                                | 説明                                                                                                       |
| -------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `thinkingConfig.includeThoughts` | `boolean`                         | シンキングモードを有効にするかどうか；デフォルト `true`                                                    |
| `thinkingConfig.thinkingLevel`   | `"MINIMAL"∕"LOW"∕"MEDIUM"∕"HIGH"` | シンキングレベル；`MINIMAL` は無効に映射；`LOW`∕`MEDIUM`∕`HIGH` は `maxOutputTokens` の 20%∕50%∕80% に設定 |
| `thinkingConfig.thinkingBudget`  | `number`                          | シンキングトークン予算を直接指定；`thinkingLevel` より優先度高                                             |

> `max_tokens`（または `maxOutputTokens`）が指定されない場合、パーセンテージベースのレベルは `budget_tokens` を設定せず、プロバイダのデフォルトに委ねます。

### 管理 API

すべての管理エンドポイントには `Authorization: Bearer <ADMIN_KEY>` ヘッダーが必要です。

| メソッド         | パス                       | 説明                                                         |
| ---------------- | -------------------------- | ------------------------------------------------------------ |
| `GET/POST`       | `/api/providers`           | プロバイダをリスト / 作成                                    |
| `GET/PUT/DELETE` | `/api/providers/:id`       | プロバイダを照会 / 更新 / 削除                               |
| `GET/POST`       | `/api/provider-models`     | プロバイダモデルをリスト / 作成                              |
| `GET/PUT/DELETE` | `/api/provider-models/:id` | プロバイダモデルを照会 / 更新 / 削除                         |
| `GET/POST`       | `/api/virtual-models`      | 仮想モデルをリスト / 作成                                    |
| `GET/PUT/DELETE` | `/api/virtual-models/:id`  | 仮想モデルを照会 / 更新 / 削除                               |
| `GET`            | `/api/request-logs`        | リクエストログを照会（フィルタリング・ページネーション対応） |
| `GET`            | `/api/request-logs/:id`    | 単一リクエストログの詳細を照会                               |
| `GET/POST`       | `/api/api-keys`            | ユーザー API キーをリスト / 作成                             |
| `GET/PUT/DELETE` | `/api/api-keys/:id`        | API キーを照会 / 更新 / 削除                                 |
| `POST`           | `/api/api-keys/:id/rotate` | API キーをローテーション（認証情報を再生成）                 |

---

## プロジェクト構造

> 各モジュールの詳細説明は `src/<module>/README.md` を参照してください。

```
src/
├── index.ts           # プロセスエントリーポイント；グレースフルシャットダウン処理
├── server.ts          # Express インスタンスと HTTP ルート登録
├── app/               # コア処理オーケストレーション（フォーマット非依存）
│   ├── process.ts     # メイン処理（processChatCompletion / processEmbedding）
│   ├── stream.ts      # ストリーミング転送（processStreamSend / mergeStreamChunks）
│   └── helpers.ts     # ヘルパー関数（finalizeSuccess / finalizeError）
├── api/               # ユーザー API フォーマットルーティング
│   ├── openaicompat/  # OpenAI 互換形式
│   └── gemini/        # Gemini ネイティブ形式
├── types/             # 統一内部型
├── config/            # ConfigManager（インメモリキャッシュ + LISTEN/NOTIFY）
├── db/                # PostgreSQL コネクションプール + リクエストログ
├── router/            # 仮想モデルルーティング解決
├── middleware/        # ミドルウェアチェーン実行
├── users/             # ユーザーフォーマット適配器
│   ├── error-formatting/   # エラーレスポンスフォーマッティング
│   ├── chat/openaicompat/  # OpenAI 形式チャット適配器
│   ├── chat/gemini/        # Gemini ネイティブ形式チャット適配器
│   ├── embedding/openaicompat/ # OpenAI 形式埋め込み適配器
│   └── embedding/gemini/   # Gemini 形式埋め込み適配器
├── providers/         # プロバイダ適配器
│   ├── error-mapping/ # プロバイダエラーマッピング
│   ├── chat/
│   │   ├── deepseek/
│   │   ├── gemini/
│   │   └── volcengine/
│   └── embedding/
│       ├── gemini/
│       └── volcengine/
├── admin/             # 管理 API ルート
└── utils/             # 共通ユーティリティ
ui/                   # 管理コンソール フロントエンド（Vue 3 + TypeScript + mdui）
├── src/api/          # バックエンド API クライアント層
├── src/types/        # フロントエンド型定義
├── src/utils/        # フロントエンド ユーティリティ関数
└── src/components/   # ビジネスコンポーネント・ビュー
admin.http             # 管理 API 実行可能な例
```

---

## 🐳 Docker での展開

プロジェクトは Docker および Docker Compose での展開に完全対応しており、バックエンドゲートウェイと PostgreSQL データベースを含みます。

### ワンコマンド起動

```bash
# 環境変数をコピー
cp .env.example .env

# 管理スクリプトを使用（推奨）
chmod +x scripts/docker.sh
./scripts/docker.sh up

# または Docker Compose を直接使用
docker-compose up -d
```

その後、アクセス：
- **バックエンド API**：http://localhost:3000

### ドキュメント

- **[Docker 導入ガイド](docs/DOCKER.md)** — 完全な展開、本番設定、トラブルシューティング
- **[クイックリファレンスカード](docs/DOCKER-QUICK-REF.md)** — よく使うコマンドチートシート
- **[展開サマリー](docs/DOCKER-SUMMARY.md)** — ファイルインベントリとアーキテクチャ概要

### 管理スクリプト

**Linux/macOS：** `./scripts/docker.sh`  
**Windows：** `scripts\docker.bat`

サポートされるコマンド：`up`、`down`、`logs`、`db-backup`、`shell-gateway` など。完全なリストは `./scripts/docker.sh help` を実行してください。

### 含まれるサービス

| サービス   | イメージ             | ポート |
| ---------- | -------------------- | ------ |
| PostgreSQL | `postgres:16-alpine` | 5432   |
| Gateway    | ローカルビルド       | 3000   |

---

## 開発ガイド

### 利用可能なコマンド

```bash
npm run dev        # 開発モードで起動（ts-node）
npm run build      # TypeScript を dist/ にコンパイル
npm start          # 本番モードで起動（先に build が必要）
npm test           # Jest テストを実行
npm run type-check # TypeScript 型チェック（エラーなしが必須）
npm run lint       # ESLint チェック（エラー・警告なしが必須）
npm run lint:fix   # ESLint 自動修正
npm run format     # Prettier コード整形
npm run db:migrate # データベースマイグレーションを実行
npm run db:reset   # ⚠️ データベースをリセット（開発用のみ）
```

**提交前のチェック**：コード提出前に以下をパスする必要があります：
```bash
npm run type-check && npm run lint && npm run format && npm test
```

### ゲートウェイの拡張

- **新規 AI プロバイダを追加**：[`src/providers/README.md`](src/providers/README.md)
- **新規ユーザー API フォーマットを追加**：[`src/users/README.md`](src/users/README.md)、[`src/api/README.md`](src/api/README.md)
- **新規ミドルウェアを追加**：[`src/middleware/README.md`](src/middleware/README.md)
- **管理コンソールを開発**：[`ui/README.md`](ui/README.md)
- **貢献ガイドライン**：[CONTRIBUTING.md](CONTRIBUTING.md) を参照してください

---

## テック スタック

- **ランタイム**：Node.js 18+
- **言語**：TypeScript 5
- **Web フレームワーク**：Express 5
- **データベース**：PostgreSQL 14+（`pg` コネクションプール）
- **ログ**：Winston（構造化 JSON ログ）
- **テスト**：Jest + nock（HTTP モック）
- **コード標準**：ESLint + Prettier
