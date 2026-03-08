# Linguist

<div align="center">

[🇨🇳 中文](README.md) | [🇬🇧 English](README.en.md) | [🇯🇵 日本語](README.ja.md) | 🇫🇷 Français | [🇩🇪 Deutsch](README.de.md)

</div>

---

**Linguist** est une passerelle unifiée de modèles d'IA construite avec Node.js + TypeScript. Elle accepte les requêtes dans plusieurs formats (format compatible OpenAI, format natif Gemini, etc.), les achemine vers différents fournisseurs de modèles d'IA (DeepSeek, Google Gemini, Volcengine, etc.) en fonction des configurations dynamiques stockées dans la base de données, et convertit les réponses vers le format utilisateur correspondant.

---

## Fonctionnalités clés

| Fonctionnalité                 | Description                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Interface utilisateur multi-formats** | Prend en charge le format compatible OpenAI et le format natif Gemini ; les clients peuvent s'intégrer sans modifications de code                                                           |
| **Support multi-fournisseur**      | DeepSeek, Google Gemini, Volcengine, avec extensibilité pour les nouveaux fournisseurs                                                                                 |
| **Routage de modèles en trois tiers**    | Fournisseur → ModèleFournisseur → ModèleVirtuel, supporte trois stratégies de routage : simple/équilibrage_charge/basculement ; le basculement réessaye automatiquement tous les backends      |
| **Configuration dynamique avec rechargement à chaud**   | Les configurations sont stockées dans PostgreSQL, prennent effet en temps réel via LISTEN/NOTIFY, aucun redémarrage requis                                                      |
| **Chat + Embedding** | Prend en charge la complétion de chat et les capacités d'intégration de texte                                                                                          |
| **API de gestion complète**     | Interface de gestion RESTful supporting des opérations CRUD sur les mappages fournisseur/modèle                                                                         |
| **Journalisation d'audit des requêtes**       | Cycle de vie complet de chaque requête (pending → processing → completed/error) persisté dans la base de données                                             |
| **Console d'administration**               | Interface de gestion moderne construite avec Vue 3 + mdui, supportant la gestion de configuration, la visualisation des journaux et l'analyse statistique                                             |
| **Surveillance et analytique**      | Aperçu en temps réel, tendances chronologiques, analyse des erreurs, utilisation des tokens et surveillance multidimensionnelle                                                     |

---

## Démarrage rapide

> **Pour le déploiement en production, Docker Compose est recommandé.**

### Conditions préalables

- Node.js >= 18
- PostgreSQL >= 14

### (Optionnel) Déploiement Docker

Si vous utilisez Docker Compose, vous avez seulement besoin :
- Docker >= 20.10
- Docker Compose >= 2.0

### 1. Installer les dépendances

```bash
npm install
```

### 2. Configurer les variables d'environnement

Créez un fichier `.env` (voir la section des variables d'environnement ci-dessous) :

```env
# Connexion à la base de données
DATABASE_URL=postgresql://user:password@localhost:5432/linguist

# Clé d'authentification de l'API d'administration (n'importe quelle chaîne personnalisée)
ADMIN_KEY=your-secret-admin-key

# Port de service (par défaut 3000)
PORT=3000

# Niveau de journalisation : error | warn | info | debug (par défaut info)
LOG_LEVEL=info
```

### 3. Exécuter la migration de la base de données (Premier déploiement)

**Pour la production / premier déploiement** :
```bash
npm run db:migrate
```

Cela crée les tables suivantes :
- `providers` — Credentials du fournisseur (API Key, base_url, type de protocole)
- `provider_models` — Modèles réels des fournisseurs
- `virtual_models` — Modèles virtuels exposés aux utilisateurs
- `virtual_model_backends` — Association entre modèles virtuels et modèles de fournisseur
- `request_logs` — Journaux d'audit des requêtes

**Pour le développement local** — si vous avez besoin de réinitialiser la base de données :
```bash
npm run db:reset  # ⚠️ Supprime toutes les données, développement uniquement!
```

### 4. Démarrer le service

#### Mode de développement local

```bash
# Mode développement (ts-node, hot reload avec nodemon)
npm run dev

# Mode production (compiler d'abord)
npm run build && npm start
```

#### Déploiement Docker Compose (Recommandé pour la production)

Démarrez la passerelle backend et la base de données PostgreSQL avec une seule commande :

```bash
# 1. Copier les variables d'environnement
cp .env.example .env

# 2. Démarrer tous les services (y compris l'initialisation de la base de données)
docker-compose up -d

# 3. Afficher les journaux des services
docker-compose logs -f
```

Après le démarrage des services :
- **API Backend** : http://localhost:3000
- **Vérification de santé** : http://localhost:3000/health

#### Points de terminaison de service disponibles

Après le démarrage du service (localement ou Docker) :
- Vérification de santé : `GET http://localhost:3000/api/health`
- Liste des modèles (format OpenAI) : `GET http://localhost:3000/v1/models`
- Point de terminaison du chat (format OpenAI) : `POST http://localhost:3000/v1/chat/completions`
- Point de terminaison d'intégration (format OpenAI) : `POST http://localhost:3000/v1/embeddings`
- Point de terminaison du chat (format Gemini) : `POST http://localhost:3000/v1beta/models/:model:generateContent`
- Chat en continu (format Gemini) : `POST http://localhost:3000/v1beta/models/:model:streamGenerateContent`
- Points de terminaison d'administration : `http://localhost:3000/api/*`

---

## Configuration des modèles en trois tiers (Exemple de bout en bout)

Configurez la chaîne de routage via l'API de gestion, en utilisant « modèle deepseek-chat de l'API DeepSeek » comme exemple :

> Vous pouvez utiliser directement `admin.http` dans la racine du projet (requires VS Code REST Client extension).

**Étape 1 : Créer un fournisseur**

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

**Étape 2 : Créer un modèle de fournisseur**

```http
POST http://localhost:3000/api/provider-models
Authorization: Bearer your-secret-admin-key
Content-Type: application/json

{
  "provider_id": "<id retourné à l'étape 1>",
  "name": "deepseek-chat",
  "model_type": "chat"
}
```

**Étape 3 : Créer un modèle virtuel (le champ model dans les requêtes utilisateur)**

```http
POST http://localhost:3000/api/virtual-models
Authorization: Bearer your-secret-admin-key
Content-Type: application/json

{
  "id": "deepseek-chat",
  "name": "DeepSeek Chat",
  "routing_strategy": "load_balance",
  "backends": [
    { "provider_model_id": "<id retourné à l'étape 2>" }
  ]
}
```

La configuration prend effet immédiatement (aucun redémarrage requis). Envoyez une requête de chat :

```http
POST http://localhost:3000/v1/chat/completions
Content-Type: application/json

{
  "model": "deepseek-chat",
  "messages": [
    { "role": "user", "content": "Bonjour!" }
  ]
}
```

---

## Fournisseurs pris en charge

| Fournisseur         | Valeur `kind` | Chat | Embedding |
| ---------------------- | ------------ | :--: | :-------: |
| DeepSeek         | `deepseek`   |  ✅  |     —     |
| Google Gemini    | `gemini`     |  ✅  |     ✅     |
| Volcengine (ByteDance) | `volcengine` |  ✅  |     ✅     |

## Formats d'API utilisateur pris en charge

| ID de format      | Point de terminaison du chat                                                                   | Point de terminaison d'intégration                        | Description                              |
| -------------- | ------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------- |
| `openaicompat` | `POST /v1/chat/completions` (streaming: `stream: true`)                         | `POST /v1/embeddings`                     | Format compatible OpenAI, par défaut pour la plupart des clients |
| `gemini`       | `POST /v1beta/models/:model:generateContent` (streaming: `:streamGenerateContent`) | `POST /v1beta/models/:model:embedContent` | Format natif Google Gemini              |

---

## Référence de l'API

### API Gateway

| Méthode | Chemin                                          | Format         | Description                                              |
| ------ | --------------------------------------------- | -------------- | -------------------------------------------------------- |
| `GET`  | `/api/health`                                 | —              | Vérification de santé, retourne `{ status: "ok", timestamp, uptime }` |
| `GET`  | `/v1/models`                                  | Compatible OpenAI | Retourne la liste des modèles virtuels disponibles                |
| `POST` | `/v1/chat/completions`                        | Compatible OpenAI | Complétion du chat (supporte streaming: `stream: true`)     |
| `POST` | `/v1/embeddings`                              | Compatible OpenAI | Intégration de texte                                           |
| `POST` | `/v1beta/models/:model:generateContent`       | Natif Gemini  | Complétion du chat (non-streaming)                          |
| `POST` | `/v1beta/models/:model:streamGenerateContent` | Natif Gemini  | Complétion du chat (streaming SSE)                          |
| `POST` | `/v1beta/models/:model:embedContent`          | Natif Gemini  | Intégration de texte                                           |

### Paramètres de réflexion (Format OpenAI)

| Champ                    | Type                              | Description                                                                                     |
| ------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `reasoning_effort`       | `"minimal"∕"low"∕"medium"∕"high"` | Niveau d'effort de raisonnement ; `minimal` → désactivé ; les autres définissent le budget à 20%∕50%∕80% de `max_tokens` |
| `thinking.type`          | `"enabled"∕"disabled"∕"auto"`     | Commutateur de réflexion profonde (contrôle explicite, priorité plus élevée que `reasoning_effort`)                 |
| `thinking.budget_tokens` | `number`                          | Spécification directe du budget de token de réflexion, priorité plus élevée que `reasoning_effort`          |

### Paramètres de réflexion (Format Gemini)

| Champ                            | Type                              | Description                                                                                                     |
| -------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `thinkingConfig.includeThoughts` | `boolean`                         | Activer le mode de réflexion, défaut `true`                                                                            |
| `thinkingConfig.thinkingLevel`   | `"MINIMAL"∕"LOW"∕"MEDIUM"∕"HIGH"` | Niveau de réflexion ; `MINIMAL` mappé à désactivé ; `LOW`∕`MEDIUM`∕`HIGH` définissent le budget à 20%∕50%∕80% de `maxOutputTokens` |
| `thinkingConfig.thinkingBudget`  | `number`                          | Spécification directe du budget de token de réflexion, priorité plus élevée que `thinkingLevel`                             |

> Quand `max_tokens` (ou `maxOutputTokens`) ne sont pas spécifiés, les niveaux basés sur des pourcentages ne définissent pas `budget_tokens`, en laissant la responsabilité au fournisseur.

### API de gestion

Tous les points de terminaison de gestion nécessitent un en-tête `Authorization: Bearer <ADMIN_KEY>`.

| Méthode             | Chemin                       | Description                              |
| ------------------ | -------------------------- | ---------------------------------------- |
| `GET/POST`         | `/api/providers`           | Lister / Créer des fournisseurs                  |
| `GET/PUT/DELETE`   | `/api/providers/:id`       | Interroger / Mettre à jour / Supprimer un fournisseur         |
| `GET/POST`         | `/api/provider-models`     | Lister / Créer des modèles de fournisseur            |
| `GET/PUT/DELETE`   | `/api/provider-models/:id` | Interroger / Mettre à jour / Supprimer un modèle de fournisseur   |
| `GET/POST`         | `/api/virtual-models`      | Lister / Créer des modèles virtuels             |
| `GET/PUT/DELETE`   | `/api/virtual-models/:id`  | Interroger / Mettre à jour / Supprimer un modèle virtuel    |
| `GET`              | `/api/request-logs`        | Interroger les journaux (supports du filtrage/pagination) |
| `GET`              | `/api/request-logs/:id`    | Interroger les détails d'un journal unique                 |
| `GET/POST`         | `/api/api-keys`            | Lister / Créer des clés API utilisateur              |
| `GET/PUT/DELETE`   | `/api/api-keys/:id`        | Interroger / Mettre à jour / Supprimer une clé API     |
| `POST`             | `/api/api-keys/:id/rotate` | Faire tourner la clé API (régénérer les credentials)  |

---

## Structure du projet

> Voir `src/<module>/README.md` pour les descriptions de module détaillées.

```
src/
├── index.ts           # Point d'entrée du processus, gestion de l'arrêt gracieux
├── server.ts          # Instance Express et enregistrement des routes HTTP
├── app/               # Orchestration de flux principal (sans format spécifique)
│   ├── process.ts     # Traitement principal (processChatCompletion / processEmbedding)
│   ├── stream.ts      # Transport en continu (processStreamSend / mergeStreamChunks)
│   └── helpers.ts     # Fonctions d'aide (finalizeSuccess / finalizeError)
├── api/               # Routage au format API utilisateur
│   ├── openaicompat/  # Format compatible OpenAI
│   └── gemini/        # Format natif Gemini
├── types/             # Types internes unifiés
├── config/            # ConfigManager (cache en mémoire + LISTEN/NOTIFY)
├── db/                # Pool de connexion PostgreSQL + journalisation des requêtes
├── router/            # Résolution du routage du modèle virtuel
├── middleware/        # Exécuteur de chaîne middleware
├── users/             # Adaptateurs de format utilisateur
│   ├── error-formatting/   # Formatage de réponse d'erreur
│   ├── chat/openaicompat/  # Adaptateur chat format OpenAI
│   ├── chat/gemini/        # Adaptateur chat format natif Gemini
│   ├── embedding/openaicompat/ # Adaptateur embedding format OpenAI
│   └── embedding/gemini/   # Adaptateur embedding format Gemini
├── providers/         # Adaptateurs de fournisseur
│   ├── error-mapping/ # Mappage d'erreur de fournisseur
│   ├── chat/
│   │   ├── deepseek/
│   │   ├── gemini/
│   │   └── volcengine/
│   └── embedding/
│       ├── gemini/
│       └── volcengine/
├── admin/             # Routes API de gestion
└── utils/             # Utilitaires communs
ui/                   # Frontend de console d'administration (Vue 3 + TypeScript + mdui)
├── src/api/          # Couche client API backend
├── src/types/        # Définitions de type frontend
├── src/utils/        # Fonctions utilitaire frontend
└── src/components/   # Composants métier et vues
admin.http             # Exemples exécutables d'API de gestion
```

---

## 🐳 Déploiement Docker

Le projet prend complètement en charge le déploiement Docker et Docker Compose, y compris la passerelle backend et la base de données PostgreSQL.

### Démarrage en une commande

```bash
# Copier les variables d'environnement
cp .env.example .env

# Utiliser le script de gestion (recommandé)
chmod +x scripts/docker.sh
./scripts/docker.sh up

# Ou utiliser Docker Compose directement
docker-compose up -d
```

Ensuite, accédez :
- **API Backend** : http://localhost:3000

### Documentation

- **[Guide de déploiement Docker](docs/DOCKER.md)** — Déploiement complet, configuration de production, dépannage
- **[Carte de référence rapide](docs/DOCKER-QUICK-REF.md)** — Feuille de triche des commandes courantes
- **[Résumé de déploiement](docs/DOCKER-SUMMARY.md)** — Inventaire des fichiers et aperçu de l'architecture

### Scripts de gestion

**Linux/macOS :** `./scripts/docker.sh`  
**Windows :** `scripts\docker.bat`

Commandes supportées : `up`, `down`, `logs`, `db-backup`, `shell-gateway`, etc. Exécutez `./scripts/docker.sh help` pour la liste complète.

### Services inclus

| Service    | Image                | Port |
| ---------- | -------------------- | ---- |
| PostgreSQL | `postgres:16-alpine` | 5432 |
| Gateway    | Build local          | 3000 |

---

## Guide de développement

### Commandes disponibles

```bash
npm run dev        # Démarrer en mode développement (ts-node)
npm run build      # Compiler TypeScript vers dist/
npm start          # Démarrer en mode production (requires build first)
npm test           # Exécuter les tests Jest
npm run type-check # Vérification de type TypeScript (must be error-free)
npm run lint       # Vérifications ESLint (must be error/warning-free)
npm run lint:fix   # Auto-correction ESLint
npm run format     # Formatage de code Prettier
npm run db:migrate # Exécuter les migrations de base de données
npm run db:reset   # ⚠️ Réinitialiser la base de données (développement uniquement)
```

**Contrôles pré-commit** : Avant de valider le code, vous devez réussia :
```bash
npm run type-check && npm run lint && npm run format && npm test
```

### Extension de la passerelle

- **Ajouter un nouveau fournisseur d'IA** : [`src/providers/README.md`](src/providers/README.md)
- **Ajouter un nouveau format d'API utilisateur** : [`src/users/README.md`](src/users/README.md), [`src/api/README.md`](src/api/README.md)
- **Ajouter un nouveau middleware** : [`src/middleware/README.md`](src/middleware/README.md)
- **Développer la console d'administration** : [`ui/README.md`](ui/README.md)
- **Directives de contribution** : Voir [CONTRIBUTING.md](CONTRIBUTING.md)

---

## Pile technologique

- **Runtime** : Node.js 18+
- **Langage** : TypeScript 5
- **Framework web** : Express 5
- **Base de données** : PostgreSQL 14+ (pool de connexion `pg`)
- **Journalisation** : Winston (journaux JSON structurés)
- **Test** : Jest + nock (mocking HTTP)
- **Normes de code** : ESLint + Prettier
