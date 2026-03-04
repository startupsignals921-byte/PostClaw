# PostClaw — PostgreSQL Memory Plugin for OpenClaw

<p align="center">
<img src="https://github.com/user-attachments/assets/2a7798c6-e711-40fa-bcf2-7416180651cc"
        alt="PostClaw Logo - Postmodern Artwork of a giant lobster interspersed with technology and classical designs."
        width="800"
        height="600"
        style="display: block; margin: 0 auto" />
</p>

**PostClaw** replaces OpenClaw's default memory system with a PostgreSQL backend powered by `pgvector`. It provides semantic search, episodic memory, knowledge graph linking, dynamic persona injection, and autonomous memory management for multi-agent swarms.

---

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Database Setup](#database-setup)
- [Configuration](#configuration)
- [Plugin Hooks](#plugin-hooks)
- [Agent Tools](#agent-tools)
- [CLI Commands](#cli-commands)
- [Background Services](#background-services)
- [Database Schema](#database-schema)
- [Row-Level Security](#row-level-security)
- [Persona Bootstrap](#persona-bootstrap)
- [Sleep Cycle](#sleep-cycle)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

---

## Features

| Feature | Description |
|---------|-------------|
| **Semantic Memory (RAG)** | Stores memories as vector embeddings in PostgreSQL via `pgvector` for contextual retrieval |
| **Episodic Memory** | Automatically logs user prompts and tool calls as short-term memory events |
| **Knowledge Graph** | Links related memories with typed, directed edges for graph-augmented retrieval |
| **Dynamic Persona Injection** | Injects agent-specific persona rules and RAG context into every prompt |
| **Duplicate Detection** | Identifies and merges near-duplicate memories during background maintenance |
| **Multi-Agent Isolation** | Row-Level Security (RLS) ensures agents can only read/write their own data |
| **Autonomous Management** | Agents silently store, update, link, and search memories without user prompts |

---

## Prerequisites

1. **OpenClaw** — installed and configured
2. **PostgreSQL** (v14+) — installed and running. Depending on your system, you may need the `postgresql-<version>-pgvector` package installed. The `pgvector` extension is installed automatically by the setup command.
3. **Node.js** (v18+) and **npm**
4. **Embedding Provider** — LM Studio, Ollama, or any OpenAI-compatible endpoint serving an embedding model (e.g. `nomic-embed-text-v2-moe`)

   ```json
           "memorySearch": {
                "provider": "openai",
                "remote": {
                  "baseUrl": "http://<IP-ADDRESS>:<PORT>/v1",
                  "apiKey": "<API-KEY>"
                },
                "model": "text-embedding-nomic-embed-text-v2-moe"
              }
   ```

5. **Tools Enabled** - At the least, you need the following permissions setup in your `openclaw.json`. This is a **Breaking Change** introduced in 2026.3.2 of OpenClaw:

   ```json
        "tools": {
            "profile": "messaging",
            "alsoAllow": ["postclaw"] // OR group:plugins if you have other plugins installed.
          },
   ```

---

## Quick Start

```bash
# PREREQUISITES
## You must have a password assigned to your postgres user if you are running openclaw from another user.
sudo -u postgres psql -c "ALTER USER postgres WITH PASSWORD 'YOUR_PASSWORD';"

## Install pgvector plugin (change xx to your postgres version:
sudo apt install postgresql-xx-pgvector  # Ubuntu/Debian example.

# 1. Install the plugin
openclaw plugins install @christopherlittle51/postclaw  # from npm
# OR from a local path:
openclaw plugins install /path/to/PostClaw

# 2. Set up the database (creates DB, user, schema, everything)
openclaw postclaw setup --admin-url postgres://<POSTGRES-USERNAME>:<PASSWORD>@[IP ADDRESS/localhost]/postgres

# 3. Restart the gateway
openclaw restart
```

Done. PostClaw will automatically:

- Connect to the database using the credential it just generated
- Start injecting RAG context and persona rules into every prompt
- Begin logging episodic memory after each agent turn
- Run the sleep cycle in the background every 6 hours

---

## Installation

### From npm (recommended)

```bash
openclaw plugins install @christopherlittle51/postclaw
```

### From local path

```bash
# Copy into ~/.openclaw/extensions/postclaw/
openclaw plugins install /path/to/PostClaw

# Or link for development (live edits, no copy)
openclaw plugins install -l /path/to/PostClaw
```

### Manual

```bash
git clone <repository-url> PostClaw
cd PostClaw
npm install
npm run build
```

Then add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "load": { "paths": ["/absolute/path/to/PostClaw"] },
    "slots": { "memory": "postclaw" },
    "entries": {
      "postclaw": { "enabled": true }
    }
  }
}
```

---

## Database Setup

### Automated Setup

```bash
openclaw postclaw setup [options]
```

This command:

1. Connects to PostgreSQL as a superuser
2. Creates the `memorydb` database (if it doesn't exist)
3. Installs the `vector` and `pgcrypto` extensions
4. Creates the `openclaw` app user with a **random password**
5. Creates the `system_admin` role with RLS bypass
6. Builds all tables, triggers, indices, and RLS policies
7. Auto-updates `~/.openclaw/openclaw.json` with the connection string

#### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--admin-url <url>` | `postgres://localhost/postgres` | Superuser connection string |
| `--db-name <name>` | `memorydb` | Database name |
| `--db-user <user>` | `openclaw` | App user name |
| `--db-password <pass>` | *auto-generated* | App user password |
| `--skip-config` | `false` | Don't auto-update `openclaw.json` |

#### Examples

```bash
# Local PostgreSQL with default peer auth
openclaw postclaw setup

# Remote / password-protected PostgreSQL
openclaw postclaw setup --admin-url postgres://postgres:mysecretpass@db.example.com:5432/postgres

# Custom database and user names
openclaw postclaw setup --db-name myagent_memory --db-user myagent --db-password hunter2
```

#### Output

```
🦐 PostClaw Database Setup

  ✅  Connected to Postgres as superuser
  ✅  Created database 'memorydb'
  ✅  Created user 'openclaw'
  ✅  Created role 'system_admin'
  ✅  Schema created (6 tables, 14 indices, 18 RLS policies)
  ✅  Granted permissions

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Database:     memorydb
  App User:     openclaw
  App Password: kR9x!mQ2vL8nP4wZ
  Admin User:   system_admin
  Admin Pass:   bN7yT3xK1mR5sW9e

  Connection:   postgres://openclaw:kR9x!mQ2vL8nP4wZ@localhost:5432/memorydb

  ✅ openclaw.json updated with dbUrl
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Save these credentials! They won't be shown again.
```

The setup is **fully idempotent** — safe to re-run without errors.

---

## Configuration

All configuration lives in `~/.openclaw/openclaw.json`:

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
          "dbUrl": "postgres://openclaw:PASSWORD@localhost:5432/memorydb",
          "sleepIntervalHours": 6
        }
      }
    }
  },
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

### Config Properties

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `dbUrl` | `string` | — | PostgreSQL connection string (**required**) |
| `adminDbUrl` | `string` | — | Superuser connection (only used by `postclaw setup`) |
| `sleepIntervalHours` | `number` | `6` | Hours between background sleep cycles. Set to `0` to disable. |

The `POSTCLAW_DB_URL` environment variable is also supported as a fallback for `dbUrl`.

---

## Plugin Hooks

PostClaw registers three hooks with the OpenClaw lifecycle:

### 1. `message_received` (void)

**When:** Every inbound message before agent processing begins.

**What it does:** Caches the raw message text so the next `before_prompt_build` has the real user text (not the system-modified version).

### 2. `before_prompt_build` (modifying)

**When:** Before the LLM prompt is assembled for each agent turn.

**What it does:**

1. **Prunes the system prompt** — strips OpenClaw's default bloat (Tooling rules, Documentation, Project Context markdown)
2. **Injects memory architecture rules** — teaches the agent how to use its memory tools
3. **Fetches persona context** — pulls `agent_persona` rules from Postgres (core rules always, situational rules ranked by embedding similarity)
4. **Runs RAG search** — performs a vector similarity search on `memory_semantic` + traverses `entity_edges` for linked memories
5. **Loads dynamic tools** — fetches tool schemas from `context_environment` ranked by embedding similarity
6. **Injects everything** — returns the modified system prompt and prepended RAG context

**Returns:** `{ systemPrompt, prependContext, tools }`

### 3. `agent_end` (void)

**When:** After the agent completes a turn (response generated).

**What it does:**

1. **Logs user prompt** as an episodic memory event (with embedding)
2. **Logs each tool call** the agent made as a separate episodic event
3. Skips heartbeat/cron runs to avoid noise

---

## Agent Tools

PostClaw registers 5 native tools that the agent can invoke autonomously:

### `memory_search`

Search the semantic memory database by natural language query.

```
memory_search({ query: "user's preferred programming language" })
→ { results: "[ID: abc...] (92.3%) - The user prefers TypeScript..." }
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` | ✅ | Natural language search query |
| `max_results` | `number` | — | Max results to return (default: 5) |

### `memory_store`

Store a new semantic memory fact with embedding.

```
memory_store({
  content: "The user's server runs Ubuntu 22.04 on a Hetzner VPS",
  scope: "private",
  category: "infrastructure",
  tier: "permanent",
  confidence: 0.95
})
→ { id: "550e8400-...", status: "stored" }
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | `string` | ✅ | The fact to store |
| `scope` | `"private" \| "shared" \| "global"` | — | Visibility (default: `private`) |
| `category` | `string` | — | Semantic category label |
| `volatility` | `"low" \| "medium" \| "high"` | — | How likely to change |
| `tier` | `"volatile" \| "session" \| "daily" \| "stable" \| "permanent"` | — | Retention tier |
| `confidence` | `number` | — | 0.0–1.0 confidence score |
| `metadata` | `object` | — | Arbitrary JSON metadata |

### `memory_update`

Supersede an existing memory with a corrected fact. Archives the old memory and links the new one.

```
memory_update({
  old_memory_id: "550e8400-...",
  new_fact: "The user's server now runs Ubuntu 24.04",
  tier: "permanent"
})
→ { newId: "7c9e6679-...", status: "updated" }
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `old_memory_id` | `string` | ✅ | UUID of the memory to supersede |
| `new_fact` | `string` | ✅ | The corrected/updated content |
| All `memory_store` options | — | — | Same options available |

### `memory_link`

Create a directed edge in the knowledge graph between two memories.

```
memory_link({
  source_id: "550e8400-...",
  target_id: "7c9e6679-...",
  relationship: "elaborates"
})
→ { status: "linked" }
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `source_id` | `string` | ✅ | UUID of the source memory |
| `target_id` | `string` | ✅ | UUID of the target memory |
| `relationship` | `string` | ✅ | Edge type: `related_to`, `elaborates`, `contradicts`, `depends_on`, `part_of` |

### `tool_store`

Reserved for potential future use, if OpenClaw ever provides a hook or API call that allows tool injections.

```
tool_store({
  tool_name: "deploy_server",
  tool_json: '{"type":"function","function":{"name":"deploy_server",...}}',
  scope: "global"
})
→ { status: "stored" }
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tool_name` | `string` | ✅ | Unique tool name |
| `tool_json` | `string` | ✅ | Full JSON schema (OpenAI function-calling format) |
| `scope` | `"private" \| "shared" \| "global"` | — | Visibility (default: `private`) |

---

## CLI Commands

All CLI commands are registered under the `postclaw` namespace:

### `openclaw postclaw setup`

Bootstrap the database from scratch. See [Database Setup](#database-setup).

### `openclaw postclaw persona <file>`

Ingest a Markdown persona file into the `agent_persona` table.

```bash
# Bootstrap your agent's personality
openclaw postclaw persona ~/my-agent/SOUL.md

# Specify an agent ID
openclaw postclaw persona ~/my-agent/AGENTS.md --agent-id discord-bot

# Use a specific LLM for chunking
openclaw postclaw persona ~/my-agent/SOUL.md --llm-model qwen3.5-35b
```

**How it works:**

1. Reads the Markdown file
2. Sends it to your configured LLM with a system prompt asking it to extract atomic persona rules
3. For each extracted rule, generates an embedding and upserts it into `agent_persona`
4. Uses `ON CONFLICT ... DO UPDATE` — safe to re-run when you update the source file

| Option | Default | Description |
|--------|---------|-------------|
| `--agent-id <id>` | `main` | Agent to store persona under |
| `--llm-model <model>` | Agent's primary model | Model for semantic chunking |

### `openclaw postclaw sleep`

Trigger a manual sleep cycle (knowledge graph maintenance). See [Sleep Cycle](#sleep-cycle).

```bash
openclaw postclaw sleep
openclaw postclaw sleep --agent-id my-agent
```

| Option | Default | Description |
|--------|---------|-------------|
| `--agent-id <id>` | `main` | Agent to run maintenance for |
| `--llm-model <model>` | `qwen3.5-9b` | Model for consolidation/linking |

---

## Background Services

### Sleep Cycle Service

The sleep cycle runs automatically in the background while the gateway is running. It starts on plugin load and repeats on the configured interval.

**Default interval:** 6 hours

**Configure in `openclaw.json`:**

```json
{
  "plugins": {
    "entries": {
      "postclaw": {
        "config": {
          "sleepIntervalHours": 6
        }
      }
    }
  }
}
```

Set `sleepIntervalHours` to `0` to disable the background service entirely. You can still run it manually via `openclaw postclaw sleep`.

---

## Database Schema

PostClaw creates 6 tables:

### `agents`

Registry of all known agents. Auto-populated when an agent first sends a message.

| Column | Type | Description |
|--------|------|-------------|
| `id` | `VARCHAR(100)` PK | Agent identifier |
| `name` | `VARCHAR(255)` | Display name |
| `default_embedding_model` | `VARCHAR(100)` | Default model for this agent |
| `embedding_dimensions` | `INT` | Vector dimensions |

### `memory_semantic`

Core fact storage with vector embeddings.

| Column | Type | Description |
|--------|------|-------------|
| `id` | `UUID` PK | Memory ID |
| `agent_id` | `VARCHAR(100)` FK | Owning agent |
| `access_scope` | `ENUM` | `private`, `shared`, or `global` |
| `content` | `TEXT` | The memory content |
| `content_hash` | `VARCHAR(64)` | SHA-256 for deduplication |
| `embedding` | `vector` | pgvector embedding |
| `embedding_model` | `VARCHAR(100)` | Model used for embedding |
| `category` | `VARCHAR(50)` | Semantic category label |
| `volatility` | `ENUM` | `low`, `medium`, `high` |
| `tier` | `ENUM` | `volatile`, `session`, `daily`, `stable`, `permanent` |
| `confidence` | `REAL` | 0.0–1.0 score |
| `usefulness_score` | `REAL` | Derived quality metric |
| `access_count` | `INT` | Times retrieved via RAG |
| `injection_count` | `INT` | Times injected into prompt |
| `is_archived` | `BOOLEAN` | Soft-deleted flag |
| `superseded_by` | `UUID` FK | Points to the replacement memory |
| `metadata` | `JSONB` | Arbitrary extra data |

### `memory_episodic`

Short-term event log (user prompts and tool calls).

| Column | Type | Description |
|--------|------|-------------|
| `id` | `UUID` PK | Event ID |
| `agent_id` | `VARCHAR(100)` FK | Owning agent |
| `session_id` | `VARCHAR(100)` | Session grouping |
| `event_summary` | `TEXT` | What happened |
| `event_type` | `VARCHAR(50)` | `user_prompt`, `tool_execution` |
| `embedding` | `vector` | pgvector embedding |
| `is_archived` | `BOOLEAN` | Consolidated by sleep cycle |

### `entity_edges`

Knowledge graph: directed, typed edges between semantic memories.

| Column | Type | Description |
|--------|------|-------------|
| `source_memory_id` | `UUID` FK | Edge source |
| `target_memory_id` | `UUID` FK | Edge target |
| `relationship_type` | `VARCHAR(100)` | `related_to`, `elaborates`, `contradicts`, `depends_on`, `part_of` |
| `weight` | `REAL` | Edge weight (default: 1.0) |

### `agent_persona`

Per-agent persona rules (core identity + situational context).

| Column | Type | Description |
|--------|------|-------------|
| `agent_id` | `VARCHAR(100)` FK | Owning agent |
| `category` | `VARCHAR(50)` | Rule category (unique per agent) |
| `content` | `TEXT` | The rule text |
| `is_always_active` | `BOOLEAN` | Core identity → always injected |
| `embedding` | `vector` | For situational similarity ranking |

### `context_environment`

Dynamic tool schemas stored with embeddings. Reserved for potential future use.

| Column | Type | Description |
|--------|------|-------------|
| `agent_id` | `VARCHAR(100)` FK | Owning agent |
| `tool_name` | `VARCHAR(100)` | Unique tool name |
| `context_data` | `TEXT` | Full JSON tool schema |
| `embedding` | `vector` | For relevance-based loading |

---

## Row-Level Security

PostClaw enforces strict multi-agent isolation via PostgreSQL RLS:

- **Private memories:** Only the owning agent can read, write, update, or delete
- **Shared memories:** Any agent can read, only the owner can mutate
- **Global memories:** Any agent can read, updates preserve global scope
- **Knowledge graph edges:** Visible if you authored them or they connect to shared/global memories
- **Immutable ownership:** A trigger prevents agents from reassigning `agent_id` on existing records
- **`system_admin` role:** Has `BYPASSRLS` for admin queries and maintenance scripts

---

## Persona Bootstrap

The persona system lets you inject agent identity from Markdown files:

```bash
openclaw postclaw persona ~/my-agent/SOUL.md --agent-id my-agent
```

### How it works

1. **Read** — loads the Markdown file
2. **Chunk** — sends it to your LLM with a prompt asking for atomic persona extractions
3. **Classify** — each chunk gets a `category`, `content`, and `is_always_active` flag
4. **Embed** — generates a vector embedding for each chunk
5. **Store** — upserts into `agent_persona` (updates on category conflict)

### Example Markdown → Database

**Input (`SOUL.md`):**

```markdown
# Agent Identity

You are a helpful AI assistant named Echo. You always respond in a warm,
conversational tone and never refuse reasonable requests.

# Discord Behavior

When interacting on Discord:
- Use emojis sparingly but naturally
- Keep responses under 2000 characters
- React with 👍 to acknowledge commands
```

**Output (agent_persona rows):**

| category | is_always_active | content |
|----------|-----------------|---------|
| `agent_identity` | `true` | You are a helpful AI assistant named Echo... |
| `communication_style` | `true` | Always respond in a warm, conversational tone... |
| `discord_formatting` | `false` | Use emojis sparingly but naturally... |
| `discord_length` | `false` | Keep responses under 2000 characters... |
| `discord_reactions` | `false` | React with 👍 to acknowledge commands |

Core rules (`is_always_active = true`) are injected into **every** prompt. Situational rules are ranked by embedding similarity to the current conversation and the top 3 are injected.

---

## Sleep Cycle

The sleep cycle is an autonomous maintenance agent that runs 4 phases of knowledge graph housekeeping.

### Phase 1: Episodic Consolidation

Reads unarchived episodic memories (user prompts + tool calls), sends the transcript to the LLM, and extracts durable long-term facts. These facts are stored as `tier: 'permanent'` semantic memories. The original episodic entries are archived.

### Phase 2: Duplicate Detection

Scans semantic memories for near-duplicates using cosine similarity (threshold: 0.80). When duplicates are found, the memory with the highest usefulness + access score survives; the rest are archived with `superseded_by` pointing to the survivor.

### Phase 3: Low-Value Cleanup

Archives semantic memories that:

- Have `access_count = 0` (never retrieved via RAG)
- Are older than 7 days
- Are **not** in protected tiers (`permanent` or `stable`)

### Phase 4: Link Discovery

Finds semantically related-but-distinct memory pairs (similarity 0.65–0.92) that don't already have edges. Sends candidate pairs to the LLM for relationship classification. Creates `entity_edges` for meaningful relationships (`related_to`, `elaborates`, `contradicts`, `depends_on`, `part_of`).

### Running

```bash
# Manual trigger
openclaw postclaw sleep --agent-id my-agent

# Background (automatic)
# Set sleepIntervalHours in config (default: 6, set to 0 to disable)
```

---

## Testing

### Database Smoke Test

Tests connectivity, table existence, and end-to-end vector search:

```bash
npm run build && node dist/test-db.js
```

### Semantic Memory Test

Tests memory storage with all columns, search retrieval, and access tracking:

```bash
npm run build && node dist/test-memory.js
```

### Plugin Health Check

```bash
openclaw plugins doctor
```

---

## Troubleshooting

### `pgvector` extension error

```
ERROR: could not open extension control file "pgvector"
```

Install the `pgvector` extension for your PostgreSQL version:

```bash
# Ubuntu/Debian
sudo apt install postgresql-16-pgvector

# macOS (Homebrew)
brew install pgvector
```

### Connection refused

```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

Ensure PostgreSQL is running:

```bash
sudo systemctl status postgresql
sudo systemctl start postgresql
```

### Embedding API error

```
Embedding API error: 400 Bad Request
```

Verify your embedding provider is running and the model is loaded:

```bash
curl http://127.0.0.1:1234/v1/models
```

### Sleep cycle not running

Check that `sleepIntervalHours` is not set to `0` in your config. Check gateway logs for:

```
[SLEEP SERVICE] Started — will run every 6h for agent="main"
```

### RLS permission denied

If you see permission errors, ensure the `app.current_agent_id` session variable is being set. PostClaw does this automatically via `set_config('app.current_agent_id', ...)` in every transaction.

---

## License

ISC
