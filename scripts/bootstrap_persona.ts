/**
 * PostClaw Persona Bootstrap Script
 *
 * Takes a Markdown file (e.g. SOUL.md, AGENTS.md) and uses the configured LLM
 * to intelligently chunk it into discrete persona rules, then stores each chunk
 * in the agent_persona table with embeddings for semantic retrieval.
 *
 * Usage (via OpenClaw CLI):
 *   openclaw postclaw persona <file> [--agent-id <id>]
 *
 * Usage (standalone):
 *   node dist/scripts/bootstrap_persona.js <file> [--agent-id <id>]
 */

import { readFile } from "fs/promises";
import { resolve } from "path";
import { getSql, getEmbedding, setEmbeddingConfig, LM_STUDIO_URL, EMBEDDING_MODEL } from "../services/db.js";
import { ensureAgent } from "../services/memoryService.js";
import { callLLMviaAgent } from "../services/llm.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface PersonaChunk {
  category: string;
  content: string;
  is_always_active: boolean;
}

// ─── LLM Chunking ───────────────────────────────────────────────────────────

async function chunkMarkdownWithLLM(
  markdownText: string,
  filename: string,
): Promise<PersonaChunk[]> {
  const systemPrompt = `
You are an expert data architect. Your task is to take a raw Markdown configuration file and break it down into discrete, atomic semantic chunks.
Extract the core rules, behaviors, and instructions.

Output your response EXCLUSIVELY as a raw JSON array of objects. Do not use markdown blocks (\`\`\`json).
Each object must have:
- "category": A short, unique identifier for this rule (max 50 chars, e.g., "communication_style", "discord_rules", "file_management").
- "content": The actual text of the rule or instruction.
- "is_always_active": Boolean. Set to true ONLY IF this is a core identity trait that must be injected into every single prompt. Set to false if it is situational.
`;

  console.log(`  📄  Asking LLM to semantically chunk ${filename}...`);

  // Route through OpenClaw's configured primary model via the CLI
  const combined = `${systemPrompt}\n\nHere is the file to chunk:\n\n${markdownText}`;
  const jsonString = await callLLMviaAgent(combined);

  try {
    return JSON.parse(jsonString) as PersonaChunk[];
  } catch (e) {
    console.error("  ❌  Failed to parse LLM output as JSON:", jsonString.substring(0, 200));
    throw e;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

export interface PersonaBootstrapOptions {
  agentId?: string;
}

export async function bootstrapPersona(
  filePath: string,
  opts: PersonaBootstrapOptions = {},
): Promise<void> {
  const agentId = opts.agentId || "main";
  const absPath = resolve(filePath);
  const filename = absPath.split("/").pop() || "unknown.md";

  console.log(`\n🦐 PostClaw Persona Bootstrap\n`);
  console.log(`  File:    ${absPath}`);
  console.log(`  Agent:   ${agentId}`);
  console.log();

  // 1. Read the file
  let markdownText: string;
  try {
    markdownText = await readFile(absPath, "utf-8");
    console.log(`  ✅  Read ${filename} (${markdownText.length} chars)`);
  } catch (err: any) {
    console.error(`  ❌  Cannot read file: ${err.message}`);
    throw err;
  }

  // 2. Chunk with LLM (routed through OpenClaw's configured primary model)
  const chunks = await chunkMarkdownWithLLM(markdownText, filename);
  console.log(`  ✅  LLM produced ${chunks.length} semantic chunks`);

  // 3. Ensure agent exists
  await ensureAgent(agentId);

  // 4. Generate embeddings and store each chunk
  const sql = getSql();
  let stored = 0;

  for (const chunk of chunks) {
    try {
      console.log(`  💾  Storing: "${chunk.category}" (always_active=${chunk.is_always_active})`);
      const embedding = await getEmbedding(chunk.content);

      await sql.begin(async (tx: any) => {
        await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;

        await tx`
          INSERT INTO agent_persona (
            agent_id, access_scope, category, content, is_always_active, embedding
          ) VALUES (
            ${agentId}, 'private', ${chunk.category}, ${chunk.content},
            ${chunk.is_always_active}, ${JSON.stringify(embedding)}
          )
          ON CONFLICT (agent_id, category)
          DO UPDATE SET
            content = EXCLUDED.content,
            embedding = EXCLUDED.embedding,
            is_always_active = EXCLUDED.is_always_active
        `;
      });
      stored++;
    } catch (err: any) {
      console.error(`  ⚠️  Failed to store "${chunk.category}": ${err.message}`);
    }
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  ✅ Bootstrapped ${stored}/${chunks.length} persona chunks from ${filename}`);
  console.log(`     Agent: ${agentId}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

// ─── Standalone CLI entry point ──────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));

  function getArg(name: string): string | undefined {
    const idx = args.indexOf(name);
    if (idx === -1) return undefined;
    return args[idx + 1];
  }

  if (!file) {
    console.log("Usage: node dist/scripts/bootstrap_persona.js <file.md> [--agent-id <id>]");
    process.exit(1);
  }

  bootstrapPersona(file, {
    agentId: getArg("--agent-id"),
  })
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}