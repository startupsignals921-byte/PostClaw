import postgres from "npm:postgres";

const OPENAI_BASE_URL = "http://10.51.51.145:1234/v1";
const DB_URL = "postgres://openclaw:6599@localhost:5432/memorydb";
const AGENT_ID = Deno.env.get("AGENT_ID") || "openclaw-proto-1";

const oldMemoryId = Deno.args[0];
const newFact = Deno.args.slice(1).join(" ");

if (!oldMemoryId || !newFact) {
  console.error("Usage: deno run <script> <old_memory_id> <new_fact_text>");
  Deno.exit(1);
}

async function getEmbedding(text: string) {
  const res = await fetch(`${OPENAI_BASE_URL}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: text, model: "text-embedding-nomic-embed-text-v2-moe" }),
  });
  const data = await res.json();
  return data.data[0].embedding;
}

async function updateMemory() {
  const sql = postgres(DB_URL);
  try {
    const embedding = await getEmbedding(newFact);
    const contentHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(newFact))
        .then(b => Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join(''));

    await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;
      
      // 1. Insert the new truth
      const newMem = await tx`
        INSERT INTO memory_semantic (agent_id, access_scope, content, content_hash, embedding, embedding_model)
        VALUES (${AGENT_ID}, 'global', ${newFact}, ${contentHash}, ${JSON.stringify(embedding)}, 'nomic-embed-text-v2-moe')
        RETURNING id;
      `;
      const newId = newMem[0].id;

      // 2. Deprecate the old memory (Archive it and link the causal chain)
      await tx`
        UPDATE memory_semantic 
        SET is_archived = true, superseded_by = ${newId}
        WHERE id = ${oldMemoryId} AND agent_id = ${AGENT_ID};
      `;
    });
    console.log(`[MEMORY] Successfully updated. Old fact deprecated, new truth established.`);
  } catch(err) {
    console.error("[MEMORY] Failed to update memory:", err);
  } finally {
    await sql.end();
  }
}

updateMemory();