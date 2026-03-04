# PostClaw Plugin for OpenClaw

**PostClaw** is a robust PostgreSQL-backed RAG, memory, and persona management plugin for the OpenClaw multi-agent framework. By replacing OpenClaw's default memory systems with PostgreSQL (and `pgvector`), PostClaw enables powerful semantic search, episodic memory tracking, cross-agent knowledge sharing, and structured persona/context injection across agent swarms.

## Features

- **Semantic Memory Integration (RAG):** Automatically embeds memories and tool calls into PostgreSQL via the `pgvector` extension for contextual retrieval.
- **Dynamic Persona Injection:** Injects RAG context and agent personas seamlessly into OpenClaw's `before_prompt_build` hook.
- **Swarm Ready:** Isolates memory contexts dynamically on a per-agent basis, avoiding hardcoded context collisons in multi-agent environments.

---

## Prerequisites

1. **OpenClaw Framework** configured and running locally or remotely.
2. **PostgreSQL Database** running with the [`pgvector`](https://github.com/pgvector/pgvector) extension enabled.
3. **Node.js** (v18+) and **npm** or **pnpm**.

---

## Installation

### Option 1: Install via `openclaw plugins` CLI (recommended)

```bash
# From a local path (copies into ~/.openclaw/extensions/postclaw/)
openclaw plugins install /path/to/PostClaw

# Or link for development (no copy, live edits)
openclaw plugins install -l /path/to/PostClaw

# Or from npm (once published)
openclaw plugins install @postclaw/postclaw
```

### Option 2: Manual path-based loading

1. **Clone or copy** the PostClaw repository into your local workspace.
   ```bash
   git clone <repository-url> PostClaw
   cd PostClaw
   ```

2. **Install dependencies and build**
   ```bash
   npm install
   npm run build
   ```

3. **Add the path** to `plugins.load.paths` in `~/.openclaw/openclaw.json` (see Configuration below).

---

## Configuration

### 1. Database Connection

PostClaw needs a PostgreSQL connection string. Configure it in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "postclaw": {
        "enabled": true,
        "config": {
          "dbUrl": "postgres://openclaw:YOUR_PASSWORD@localhost:5432/memorydb"
        }
      }
    }
  }
}
```

> **Note:** The `POSTCLAW_DB_URL` environment variable is also supported as a fallback.

### 2. Enable PostClaw as the Memory Plugin

Mount PostClaw in the `memory` slot and enable it:

```json
{
  "plugins": {
    "slots": {
      "memory": "postclaw"
    },
    "entries": {
      "postclaw": {
        "enabled": true,
        "config": {
          "dbUrl": "postgres://openclaw:YOUR_PASSWORD@localhost:5432/memorydb"
        }
      }
    }
  }
}
```

If you installed via the CLI, you're done. If loading manually, also add:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/absolute/path/to/PostClaw"
      ]
    }
  }
}
```

### 3. OpenClaw Embedding Settings

PostClaw uses OpenClaw's internal LLM configuration for embeddings. Ensure `agents.defaults.memorySearch` is configured:

```json
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "provider": "openai",
        "remote": {
          "baseUrl": "http://127.0.0.1:1234/v1/",
          "apiKey": "lm-studio"
        },
        "model": "text-embedding-nomic-embed-text-v2-moe"
      }
    }
  }
}
```

*Adjust `baseUrl` and `model` to match your local embedding provider (LM Studio, Ollama, etc.).*

---

## Testing

PostClaw includes smoke tests for verifying your PostgreSQL connection and semantic integration. Build first (`npm run build`), then:

1. **Database Search Smoke Test:** Tests embedding generation and `pgvector` nearest-neighbor search.
   ```bash
   node dist/test-db.js
   ```

2. **Semantic Memory Module Test:** Tests memory insertion, categorization, volatility scoring, and retrieval.
   ```bash
   node dist/test-memory.js
   ```

---

## Support

If you encounter `pgvector` errors, verify your database was created with:
```sql
CREATE EXTENSION vector;
```

Run `openclaw plugins doctor` to check that PostClaw's manifest and configuration are valid.
