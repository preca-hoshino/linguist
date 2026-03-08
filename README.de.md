# Linguist

<div align="center">

[🇨🇳 中文](README.md) | [🇬🇧 English](README.en.md) | [🇯🇵 日本語](README.ja.md) | [🇫🇷 Français](README.fr.md) | 🇩🇪 Deutsch

</div>

---

**Linguist** ist ein einheitliches KI-Modell-Gateway, das mit Node.js + TypeScript erstellt wurde. Es akzeptiert Anfragen in mehreren Formaten (OpenAI-kompatibles Format, natives Gemini-Format usw.), leitet sie basierend auf in der Datenbank gespeicherten dynamischen Konfigurationen an verschiedene KI-Modellanbieter (DeepSeek, Google Gemini, Volcengine usw.) weiter und konvertiert die Antworten zurück in das entsprechende Benutzerformat.

---

## Hauptmerkmale

| Merkmal                                     | Beschreibung                                                                                                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Multi-Format-Benutzeroberfläche**         | Unterstützt OpenAI-kompatibles Format und natives Gemini-Format; Clients können sich ohne Codeänderungen integrieren                                             |
| **Multi-Provider-Unterstützung**            | DeepSeek, Google Gemini, Volcengine mit Erweiterbarkeit für neue Anbieter                                                                                        |
| **Dreischichtiges Modell-Routing**          | Anbieter → AnbieterModell → VirtualModell, unterstützt drei Routing-Strategien: simple/load_balance/failover; failover versucht automatisch alle Backends erneut |
| **Dynamische Konfiguration mit Hot-Reload** | Konfigurationen werden in PostgreSQL gespeichert, werden in Echtzeit über LISTEN/NOTIFY wirksam, kein Neustart erforderlich                                      |
| **Chat + Embedding**                        | Unterstützt sowohl Chat-Vervollständigungs- als auch Text-Embedding-Funktionen                                                                                   |
| **Vollständige Management-API**             | RESTful-Management-Schnittstelle, unterstützt CRUD-Operationen für Anbieter-/Modell-Zuordnungen                                                                  |
| **Anforderungsaudit-Protokollierung**       | Vollständiger Lebenszyklus jeder Anfrage (pending → processing → completed/error) in einer Datenbank gespeichert                                                 |
| **Admin-Konsole**                           | Moderne Management-UI, erstellt mit Vue 3 + mdui, unterstützt Konfigurationsmanagement, Protokollvisualisierung und statistische Analyse                         |
| **Überwachung & Analytik**                  | Echtzeit-Überblick, zeitliche Trends, Fehleranalyse, Token-Verwendung und mehrdimensionale Überwachung                                                           |

---

## Schnellstart

> **Für die Produktionsbereitstellung wird Docker Compose empfohlen.**

### Voraussetzungen

- Node.js >= 18
- PostgreSQL >= 14

### (Optional) Docker-Bereitstellung

Wenn Sie Docker Compose verwenden, benötigen Sie nur:
- Docker >= 20.10
- Docker Compose >= 2.0

### 1. Abhängigkeiten installieren

```bash
npm install
```

### 2. Umgebungsvariablen konfigurieren

Erstellen Sie eine `.env`-Datei (siehe Umgebungsvariablen-Abschnitt unten):

```env
# Datenbankverbindung
DATABASE_URL=postgresql://user:password@localhost:5432/linguist

# Admin-API-Authentifizierungsschlüssel (beliebige benutzerdefinierte Zeichenfolge)
ADMIN_KEY=your-secret-admin-key

# Serviceport (Standard 3000)
PORT=3000

# Log-Level: error | warn | info | debug (Standard info)
LOG_LEVEL=info
```

### 3. Datenbankmigrationen ausführen (Initial-Bereitstellung)

**Für Produktion / Initial-Bereitstellung**:
```bash
npm run db:migrate
```

Dies erstellt die folgenden Tabellen:
- `providers` — Anbieter-Anmeldedaten (API-Schlüssel, base_url, Protokolltyp)
- `provider_models` — Echte Modelle von Anbietern
- `virtual_models` — Virtuelle Modelle, die Benutzern zugänglich sind
- `virtual_model_backends` — Zuordnung zwischen virtuellen und Anbietermodellen
- `request_logs` — Anforderungsaudit-Protokolle

**Für lokale Entwicklung** — falls Sie die Datenbank zurücksetzen müssen:
```bash
npm run db:reset  # ⚠️ Löscht alle Daten, nur Entwicklung!
```

### 4. Service starten

#### Lokaler Entwicklungsmodus

```bash
# Entwicklungsmodus (ts-node, Hot Reload mit nodemon)
npm run dev

# Produktionsmodus (vorher kompilieren)
npm run build && npm start
```

#### Docker Compose-Bereitstellung (für Produktion empfohlen)

Starten Sie Backend-Gateway und PostgreSQL-Datenbank mit einem Befehl:

```bash
# 1. Umgebungsvariablen kopieren
cp .env.example .env

# 2. Alle Services starten (einschließlich Datenbankinitialisierung)
docker-compose up -d

# 3. Service-Logs anzeigen
docker-compose logs -f
```

Nach dem Start der Services:
- **Backend-API**: http://localhost:3000
- **Gesundheitsprüfung**: http://localhost:3000/health

#### Verfügbare Service-Endpunkte

Nach dem Starten des Service (lokal oder Docker):
- Integritätsprüfung: `GET http://localhost:3000/api/health`
- Modelliste (OpenAI-Format): `GET http://localhost:3000/v1/models`
- Chat-Endpunkt (OpenAI-Format): `POST http://localhost:3000/v1/chat/completions`
- Embedding-Endpunkt (OpenAI-Format): `POST http://localhost:3000/v1/embeddings`
- Chat-Endpunkt (Gemini-Format): `POST http://localhost:3000/v1beta/models/:model:generateContent`
- Streaming-Chat (Gemini-Format): `POST http://localhost:3000/v1beta/models/:model:streamGenerateContent`
- Management-Endpunkte: `http://localhost:3000/api/*`

---

## Konfiguration von Modellen in drei Schichten (End-to-End-Beispiel)

Konfigurieren Sie die Routing-Kette über die Management-API. Beispiel: „Verwendung des deepseek-chat-Modells der DeepSeek-API":

> Sie können `admin.http` im Projektroot direkt verwenden (VS Code REST Client-Erweiterung erforderlich).

**Schritt 1: Anbieter erstellen**

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

**Schritt 2: Anbietermodell erstellen**

```http
POST http://localhost:3000/api/provider-models
Authorization: Bearer your-secret-admin-key
Content-Type: application/json

{
  "provider_id": "<von Schritt 1 zurückgegebene id>",
  "name": "deepseek-chat",
  "model_type": "chat"
}
```

**Schritt 3: Virtuelles Modell erstellen (das Modellfeld in Benutzeranfragen)**

```http
POST http://localhost:3000/api/virtual-models
Authorization: Bearer your-secret-admin-key
Content-Type: application/json

{
  "id": "deepseek-chat",
  "name": "DeepSeek Chat",
  "routing_strategy": "load_balance",
  "backends": [
    { "provider_model_id": "<von Schritt 2 zurückgegebene id>" }
  ]
}
```

Die Konfiguration wird sofort wirksam (kein Neustart erforderlich). Eine Chat-Anfrage senden:

```http
POST http://localhost:3000/v1/chat/completions
Content-Type: application/json

{
  "model": "deepseek-chat",
  "messages": [
    { "role": "user", "content": "Hallo!" }
  ]
}
```

---

## Unterstützte Anbieter

| Anbieter               | `kind` Wert  | Chat  | Embedding |
| ---------------------- | ------------ | :---: | :-------: |
| DeepSeek               | `deepseek`   |   ✅   |     —     |
| Google Gemini          | `gemini`     |   ✅   |     ✅     |
| Volcengine (ByteDance) | `volcengine` |   ✅   |     ✅     |

## Unterstützte Benutzer-API-Formate

| Format-ID      | Chat-Endpunkt                                                                      | Embedding-Endpunkt                        | Beschreibung                                                |
| -------------- | ---------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| `openaicompat` | `POST /v1/chat/completions` (Streaming: `stream: true`)                            | `POST /v1/embeddings`                     | OpenAI-kompatibles Format, Standard für die meisten Clients |
| `gemini`       | `POST /v1beta/models/:model:generateContent` (Streaming: `:streamGenerateContent`) | `POST /v1beta/models/:model:embedContent` | Natives Google Gemini-Format                                |

---

## API-Referenz

### Gateway-API

| Methode | Pfad                                          | Format            | Beschreibung                                                          |
| ------- | --------------------------------------------- | ----------------- | --------------------------------------------------------------------- |
| `GET`   | `/api/health`                                 | —                 | Integritätsprüfung, gibt `{ status: "ok", timestamp, uptime }` zurück |
| `GET`   | `/v1/models`                                  | OpenAI-kompatibel | Gibt Liste der verfügbaren virtuellen Modelle zurück                  |
| `POST`  | `/v1/chat/completions`                        | OpenAI-kompatibel | Chat-Vervollständigung (unterstützt Streaming: `stream: true`)        |
| `POST`  | `/v1/embeddings`                              | OpenAI-kompatibel | Text-Embedding                                                        |
| `POST`  | `/v1beta/models/:model:generateContent`       | Natives Gemini    | Chat-Vervollständigung (nicht-Streaming)                              |
| `POST`  | `/v1beta/models/:model:streamGenerateContent` | Natives Gemini    | Chat-Vervollständigung (Streaming SSE)                                |
| `POST`  | `/v1beta/models/:model:embedContent`          | Natives Gemini    | Text-Embedding                                                        |

### Denkparameter (OpenAI-Format)

| Feld                     | Typ                               | Beschreibung                                                                                      |
| ------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `reasoning_effort`       | `"minimal"∕"low"∕"medium"∕"high"` | Denkaufwand-Level; `minimal` → deaktiviert; andere setzen Budget auf 20%∕50%∕80% von `max_tokens` |
| `thinking.type`          | `"enabled"∕"disabled"∕"auto"`     | Tiefes Denken schalten (explizite Steuerung, höhere Priorität als `reasoning_effort`)             |
| `thinking.budget_tokens` | `number`                          | Direkte Angabe des Denk-Token-Budgets, höhere Priorität als `reasoning_effort`                    |

### Denkparameter (Gemini-Format)

| Feld                             | Typ                               | Beschreibung                                                                                                                |
| -------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `thinkingConfig.includeThoughts` | `boolean`                         | Denkmodus aktivieren, Standard `true`                                                                                       |
| `thinkingConfig.thinkingLevel`   | `"MINIMAL"∕"LOW"∕"MEDIUM"∕"HIGH"` | Denk-Level; `MINIMAL` auf deaktiviert abgebildet; `LOW`∕`MEDIUM`∕`HIGH` setzen Budget auf 20%∕50%∕80% von `maxOutputTokens` |
| `thinkingConfig.thinkingBudget`  | `number`                          | Direkte Angabe des Denk-Token-Budgets, höhere Priorität als `thinkingLevel`                                                 |

> Wenn `max_tokens` (oder `maxOutputTokens`) nicht angegeben werden, setzen prozentuale Level `budget_tokens` nicht und überlassen es dem Anbieter.

### Management-API

Alle Management-Endpunkte erfordern den Header `Authorization: Bearer <ADMIN_KEY>`.

| Methode          | Pfad                       | Beschreibung                                           |
| ---------------- | -------------------------- | ------------------------------------------------------ |
| `GET/POST`       | `/api/providers`           | Anbieter auflisten / erstellen                         |
| `GET/PUT/DELETE` | `/api/providers/:id`       | Anbieter abfragen / aktualisieren / löschen            |
| `GET/POST`       | `/api/provider-models`     | Anbietermodelle auflisten / erstellen                  |
| `GET/PUT/DELETE` | `/api/provider-models/:id` | Anbietermodelle abfragen / aktualisieren / löschen     |
| `GET/POST`       | `/api/virtual-models`      | Virtuelle Modelle auflisten / erstellen                |
| `GET/PUT/DELETE` | `/api/virtual-models/:id`  | Virtuelle Modelle abfragen / aktualisieren / löschen   |
| `GET`            | `/api/request-logs`        | Protokolle abfragen (unterstützt Filterung/Pagination) |
| `GET`            | `/api/request-logs/:id`    | Einzelne Protokolldetails abfragen                     |
| `GET/POST`       | `/api/api-keys`            | Benutzer-API-Schlüssel auflisten / erstellen           |
| `GET/PUT/DELETE` | `/api/api-keys/:id`        | API-Schlüssel abfragen / aktualisieren / löschen       |
| `POST`           | `/api/api-keys/:id/rotate` | API-Schlüssel drehen (Anmeldedaten neu generieren)     |

---

## Projektstruktur

> Siehe `src/<module>/README.md` für detaillierte Modullaufteilungen.

```
src/
├── index.ts           # Prozesseinstiegspunkt, Graceful-Shutdown-Bearbeitung
├── server.ts          # Express-Instanz und HTTP-Routenregistrierung
├── app/               # Core-Flow-Orchestrierung (formatunabhängig)
│   ├── process.ts     # Hauptbearbeitung (processChatCompletion / processEmbedding)
│   ├── stream.ts      # Streaming-Transport (processStreamSend / mergeStreamChunks)
│   └── helpers.ts     # Hilfsfunktionen (finalizeSuccess / finalizeError)
├── api/               # Benutzer-API-Format-Routing
│   ├── openaicompat/  # OpenAI-kompatibles Format
│   └── gemini/        # Natives Gemini-Format
├── types/             # Einheitliche interne Typen
├── config/            # ConfigManager (In-Memory-Cache + LISTEN/NOTIFY)
├── db/                # PostgreSQL-Verbindungspool + Anfrage-Protokollierung
├── router/            # Virtuelles Modell-Routing-Auflösung
├── middleware/        # Middleware-Chain-Ausführung
├── users/             # Benutzerformat-Adapter
│   ├── error-formatting/   # Fehlerantwort-Formatierung
│   ├── chat/openaicompat/  # OpenAI-Format-Chat-Adapter
│   ├── chat/gemini/        # Natives Gemini-Format-Chat-Adapter
│   ├── embedding/openaicompat/ # OpenAI-Format-Embedding-Adapter
│   └── embedding/gemini/   # Gemini-Format-Embedding-Adapter
├── providers/         # Anbieter-Adapter
│   ├── error-mapping/ # Anbieter-Fehler-Zuordnung
│   ├── chat/
│   │   ├── deepseek/
│   │   ├── gemini/
│   │   └── volcengine/
│   └── embedding/
│       ├── gemini/
│       └── volcengine/
├── admin/             # Management-API-Routen
└── utils/             # Gängige Utilities
ui/                   # Admin-Konsolen-Frontend (Vue 3 + TypeScript + mdui)
├── src/api/          # Backend-API-Client-Schicht
├── src/types/        # Frontend-Typendefinitionen
├── src/utils/        # Frontend-Hilfsfunktionen
└── src/components/   # Geschäftskomponenten und Ansichten
admin.http             # Management-API-ausführbare Beispiele
```

---

## 🐳 Docker-Bereitstellung

Das Projekt unterstützt vollständig Docker und Docker Compose-Bereitstellung, einschließlich Backend-Gateway und PostgreSQL-Datenbank.

### One-Command-Startup

```bash
# Umgebungsvariablen kopieren
cp .env.example .env

# Verwenden Sie das Verwaltungsskript (empfohlen)
chmod +x scripts/docker.sh
./scripts/docker.sh up

# Oder Docker Compose direkt verwenden
docker-compose up -d
```

Greifen Sie dann zu:
- **Backend-API**: http://localhost:3000

### Dokumentation

- **[Docker-Bereitstellungshandbuch](docs/DOCKER.md)** — Komplette Bereitstellung, Produktionskonfiguration, Fehlerbehebung
- **[Schnelle Referenzkarte](docs/DOCKER-QUICK-REF.md)** — Cheat-Sheet für häufige Befehle
- **[Bereitstellungszusammenfassung](docs/DOCKER-SUMMARY.md)** — Dateibestand und Architekturübersicht

### Verwaltungsskripte

**Linux/macOS :** `./scripts/docker.sh`  
**Windows :** `scripts\docker.bat`

Unterstützte Befehle: `up`, `down`, `logs`, `db-backup`, `shell-gateway` usw. Führen Sie `./scripts/docker.sh help` aus, um die vollständige Liste zu sehen.

### Enthaltene Services

| Service    | Image                | Port |
| ---------- | -------------------- | ---- |
| PostgreSQL | `postgres:16-alpine` | 5432 |
| Gateway    | Lokaler Build        | 3000 |

---

## Entwicklungshandbuch

### Verfügbare Befehle

```bash
npm run dev        # Im Entwicklungsmodus starten (ts-node)
npm run build      # TypeScript zu dist/ kompilieren
npm start          # Im Produktionsmodus starten (vorher build erforderlich)
npm test           # Jest-Tests ausführen
npm run type-check # TypeScript-Typprüfung (muss fehlerfrei sein)
npm run lint       # ESLint-Überprüfung (muss fehlerfrei sein)
npm run lint:fix   # ESLint Auto-Fix
npm run format     # Prettier-Code-Formatierung
npm run db:migrate # Datenbankmigrationen ausführen
npm run db:reset   # ⚠️ Datenbank zurücksetzen (nur Entwicklung)
```

**Pre-Commit-Prüfungen**: Vor dem Commit müssen Sie folgende Prüfungen bestehen:
```bash
npm run type-check && npm run lint && npm run format && npm test
```

### Erweiterung des Gateways

- **Neuen KI-Anbieter hinzufügen**: [`src/providers/README.md`](src/providers/README.md)
- **Neues Benutzer-API-Format hinzufügen**: [`src/users/README.md`](src/users/README.md), [`src/api/README.md`](src/api/README.md)
- **Neue Middleware hinzufügen**: [`src/middleware/README.md`](src/middleware/README.md)
- **Admin-Konsole entwickeln**: [`ui/README.md`](ui/README.md)
- **Beitragsrichtlinien**: Siehe [CONTRIBUTING.md](CONTRIBUTING.md)

---

## Technologie-Stack

- **Laufzeit**: Node.js 18+
- **Sprache**: TypeScript 5
- **Web-Framework**: Express 5
- **Datenbank**: PostgreSQL 14+ (`pg`-Verbindungspool)
- **Protokollierung**: Winston (strukturierte JSON-Protokolle)
- **Tests**: Jest + nock (HTTP-Mocking)
- **Code-Standards**: ESLint + Prettier
