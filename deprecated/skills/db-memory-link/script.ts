import postgres from "npm:postgres";

const DB_URL = "postgres://openclaw:6599@localhost:5432/memorydb";
const AGENT_ID = Deno.env.get("AGENT_ID") || "openclaw-proto-1";

const sourceId = Deno.args[0];
const targetId = Deno.args[1];
const relationship = Deno.args[2];

if (!sourceId || !targetId || !relationship) {
  console.error("Usage: deno run <script> <source_id> <target_id> <relationship_type>");
  Deno.exit(1);
}

async function linkMemories() {
  const sql = postgres(DB_URL);
  try {
    await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;
      
      // Upsert the edge into the graph
      await tx`
        INSERT INTO entity_edges (agent_id, source_memory_id, target_memory_id, relationship_type, weight)
        VALUES (${AGENT_ID}, ${sourceId}, ${targetId}, ${relationship}, 1.0)
        ON CONFLICT (source_memory_id, target_memory_id, relationship_type) DO NOTHING;
      `;
    });
    console.log(`[GRAPH] Successfully linked ${sourceId} -> ${targetId} as "${relationship}"`);
  } catch(err) {
    console.error("[GRAPH] Failed to link memories:", err);
  } finally {
    await sql.end();
  }
}

linkMemories();