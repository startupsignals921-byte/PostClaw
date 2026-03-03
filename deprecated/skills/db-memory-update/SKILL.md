# Memory Update Skill

## Description

This skill is used to update a memory in the database.

## Usage

```bash
deno run skills/db-memory-update/script.ts <old_memory_id> <new_fact_text>
```

## Arguments

- `old_memory_id`: The ID of the memory to update.
- `new_fact_text`: The new fact to update the memory with.

## Example

```bash
deno run skills/db-memory-update/script.ts 1234567890 "The capital of France is Paris."
```
