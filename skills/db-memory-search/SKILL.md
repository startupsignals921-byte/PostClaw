---
name: db-memory-search
description: Semantically search past memories and notes. Trigger this when you need to recall facts, user preferences, or historical context.
metadata: { "openclaw": { "requires": { "bins": ["deno"] } } }
---

# db-memory-search

To search memories, execute the following command using your shell/exec tool:
`deno run --allow-net --allow-env {baseDir}/scripts/memory_retrieve.ts "<search_query>"`
