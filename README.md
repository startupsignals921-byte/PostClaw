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

1. **Clone or copy the PostClaw repository** into your local workspace.
   ```bash
   git clone <repository-url> PostClaw
   cd PostClaw/PostClaw
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Build the plugin**
   ```bash
   npm run build
   ```

---

## Configuration

### 1. Database Connection

PostClaw needs a connection string to your PostgreSQL instance. This is the _only_ configuration required via environment variables.

1. Copy the `.env.example` file:
   ```bash
   cp .env.example .env
   ```
2. Open `.env` and set your `POSTCLAW_DB_URL`:
   ```ini
   # Replace with your PostgreSQL credentials
   POSTCLAW_DB_URL="postgres://openclaw:YOUR_PASSWORD@localhost:5432/memorydb"
   ```

### 2. Loading PostClaw in OpenClaw

To plug PostClaw into your OpenClaw instance, you need to update OpenClaw's global configuration file (usually `~/.openclaw/openclaw.json`).

1. Tell OpenClaw to load the PostClaw path in the `plugins.load.paths` array.
2. Tell OpenClaw to mount the `postclaw` plugin inside the `memory` slot.
3. Enable the plugin under `plugins.entries`.

**Example `openclaw.json` snippets:**

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/absolute/path/to/PostClaw/PostClaw"
      ]
    },
    "slots": {
      "memory": "postclaw"
    },
    "entries": {
      "postclaw": {
        "enabled": true
      }
    }
  }
}
```

### 3. OpenClaw Embedding Settings

PostClaw natively uses OpenClaw's internal LLM configuration to generate embeddings for semantic search. Ensure your OpenClaw configuration has memory search features fully specified under `agents.defaults.memorySearch`. 

Example settings inside `openclaw.json`:
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
*Note: Depending on your local embedding provider (LM Studio, Ollama, etc.), change `baseUrl` and `model` to match.*

---

## Testing

PostClaw comes with built-in development scripts to smoke-test your PostgreSQL connection and semantic integration _before_ fully launching your OpenClaw workers.

If you want to run these tests, you must compile the TypeScript code first (`npm run build`). The scripts are pre-configured to point to a localhost embedding provider as a fallback.

1. **Database Search Smoke Test:** Tests embedding generation and a `pgvector` nearest-neighbor search.
   ```bash
   node dist/test-db.js
   ```

2. **Semantic Memory Module Test:** Tests the memory insertion, categorization, volatility scoring, and retrieval logic.
   ```bash
   node dist/test-memory.js
   ```

---

## Support

If you encounter `pgvector` errors, verify your database was created with:
```sql
CREATE EXTENSION vector;
```
If you encounter module load errors, verify OpenClaw is referencing the absolute path to your `PostClaw` folder containing `package.json` and the built `dist/` artifacts.
