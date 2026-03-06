# PostClaw — The PostgreSQL Vector Memory Plugin

<p align="center">
<img src="https://github.com/user-attachments/assets/2a7798c6-e711-40fa-bcf2-7416180651cc"
        alt="PostClaw Logo - Postmodern Artwork of a giant lobster interspersed with technology and classical designs."
        width="800"
        height="600"
        style="display: block; margin: 0 auto" />
</p>

## Overview

**PostClaw** is a memory architecture plugin designed specifically for the OpenClaw agent framework. By migrating the default text-based memory system into a PostgreSQL database equipped with `pgvector`, PostClaw gives your AI agent the ability to recall long-term facts and short-term conversations using semantic vector search.

Rather than relying on exact keyword matching ("dog"), PostClaw translates memories into mathematical arrays. This means the agent can find related context conceptually ("pets", "puppies", "vet trips") regardless of the exact phrasing.

### Core Features

* **Retrieval-Augmented Generation (RAG):** Dynamically injects highly relevant factual memories directly into the agent's context window.
* **Separation of Concerns:** Distinct tables for short-term transcripts (**Episodic Memory**) versus long-term durable truths (**Semantic Memory**).
* **The Knowledge Graph:** Explicit connections between related ideas stored in the `entity_edges` table, allowing the agent to pull secondary context automatically.
* **Automated Maintenance (The Sleep Cycle):** Background scripts that run periodically to deduplicate overlapping facts, consolidate messy conversational logs, and delete stale data—all autonomously via the LLM.
* **Data Isolation (RLS):** True multi-agent sandboxing using PostgreSQL Row-Level Security. Agent A mathematically cannot read or overwrite Agent B's private memory.

---

## 🛠 Prerequisites

To use PostClaw, your environment must meet the following infrastructure requirements:

1. **OpenClaw (v2026.3.2+):** The host agent framework installed and running.
2. **PostgreSQL 14+ with pgvector:** A running database server. The `pgvector` and `pgcrypto` extensions are strictly required for mathematical embeddings and UUID generation. *(e.g., `postgresql-16-pgvector`)*.
3. **Node.js (v18+):** For executing the plugin scripts.
4. **An Embedding Provider:** A local endpoint (like LM Studio or Ollama) running an embedding model natively (such as `nomic-embed-text-v2-moe`) to convert text into vectors.
```json
"agents": {
    "defaults": {
      "memorySearch": {
        "model": "text-embedding-nomic-embed-text-v2-moe",
        "remote": {
          "baseUrl": "http://localhost:1234/v1" // example for LM Studio
        }
      },
    }
}
```

---

## 🚀 Quick Start Guide

Assuming you have PostgreSQL installed and an OpenClaw environment ready, follow these steps to bootstrap your agent's new memory:

### 1. Install the Plugin

Using OpenClaw's built-in package manager:

```bash
openclaw plugins install @christopherlittle51/postclaw
```

### 2. Configure the Database

Run the setup script. This will ask you for a PostgreSQL administrator connection string to generate the `openclaw` user, build the schemas, and enforce RLS policies. It is safe to run this multiple times.

*Replace `<admin_user>` and `<password>` with your actual local Postgres credentials.*

```bash
openclaw postclaw setup --admin-url postgres://<admin_user>:<password>@localhost/postgres
```

### 3. Restart the Agent

Restart your OpenClaw instance to initialize the background sleep cycle timers and connect to the new database.

```bash
openclaw restart
```

---

## 🏗 Manual Installation

If you prefer to link the plugin directly from source for development purposes:

1. **Clone and Build:**

   ```bash
   git clone <repository-url> PostClaw
   cd PostClaw
   npm install
   npm run build
   ```

2. **Register the Plugin Locally:**
   Add the absolute path to your PostClaw folder inside your `~/.openclaw/openclaw.json` configuration file, instructing the engine to load it into the memory slot:

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

## 📚 Component Documentation

PostClaw is broken into four distinct functional areas. For deeper usage instructions and troubleshooting on specific features, refer to their respective READMEs:

1. **[Dashboard (`dashboard/README.md`)](./dashboard/README.md)**  
   Instructions for running the optional web interface to manually edit memories, assign personas, and visualize the Knowledge Graph.
2. **[Maintenance Scripts (`scripts/README.md`)](./scripts/README.md)**  
   Explains the database setup, instructions for compiling markdown into personas, and the mechanics behind the automated "Sleep Cycle."
3. **[Core Services (`services/README.md`)](./services/README.md)**  
   A breakdown of the logic layer, including the Database connection pool, Semantic Memory queries, and LLM mediation. Ideal for modifying how the plugin thinks.
4. **[Data Validations (`schemas/README.md`)](./schemas/README.md)**  
   Details the Zod schemas used to strictly enforce the structural integrity of LLM outputs and JSON tools, preventing AI hallucinations from corrupting the database.

---

## 🧠 Architecture Deep Dive

If you want to understand *why* this shift from plain-text files to a vector database is necessary for advanced multi-agent workflows, read the architecture comparison guide: **[DISSERTATION.md](./DISSERTATION.md)**.

---

## Dependencies

PostClaw uses the following npm packages:

* [@ambientcss/css](https://www.npmjs.com/package/@ambientcss/css)
* [@sinclair/typebox](https://www.npmjs.com/package/@sinclair/typebox)
* [dotenv](https://www.npmjs.com/package/dotenv)
* [postgres](https://www.npmjs.com/package/postgres)
* [zod](https://www.npmjs.com/package/zod)

---

## License

Open Source under the ISC License. See `LICENSE` for structural terms.
