---
name: db-memory-store
description: Save durable facts, preferences, or notes into the persistent Postgres database. Trigger this when the user asks you to remember something.
metadata: { "openclaw": { "requires": { "bins": ["deno"] } } }
---

# db-memory-store

To store a memory, execute the following command using your shell/exec tool:
`deno run --allow-net --allow-env {baseDir}/scripts/memory_store.ts "<exact_text_to_store>"`
