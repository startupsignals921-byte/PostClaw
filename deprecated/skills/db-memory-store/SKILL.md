---
name: db-memory-store
description: Save durable facts, preferences, or notes into the persistent Postgres database. Trigger this when the user asks you to remember something.
metadata: { "openclaw": { "requires": { "bins": ["deno"] } } }
---

# db-memory-store

To store a memory, execute the following command using your shell/exec tool:
`/home/cl/.deno/bin/deno run --allow-net --allow-env /home/cl/.openclaw/workspace/skills/db-memory-store/script.ts "<exact_text_to_store>"`
