import postgres from "npm:postgres";

const OPENAI_BASE_URL = "http://10.51.51.145:1234/v1";
const DB_URL = "postgres://openclaw:6599@localhost:5432/memorydb";
const AGENT_ID = "openclaw-proto-1";

async function getEmbedding(text: string): Promise<number[]> {
  const res = await fetch(`${OPENAI_BASE_URL}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: text, model: "text-embedding-nomic-embed-text-v2-moe" }), 
  });
  const data = await res.json();
  return data.data[0].embedding;
}

async function storeMemory(content: string) {
  const embedding = await getEmbedding(content);
  const sql = postgres(DB_URL);
  
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const contentHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  
  try {
    // Explicitly casting tx to 'any' to bypass the TS definition bug
    await sql.begin(async (tx: any) => {
      await tx`
        INSERT INTO agents (id, name) 
        VALUES (${AGENT_ID}, 'OpenClaw Prototype') 
        ON CONFLICT (id) DO NOTHING;
      `;
      
await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;      
      await tx`
        INSERT INTO memory_semantic (
          agent_id, 
          content, 
          content_hash, 
          embedding, 
          embedding_model
        )
        VALUES (
          ${AGENT_ID}, 
          ${content}, 
          ${contentHash}, 
          ${JSON.stringify(embedding)},
          'nomic-embed-text-v2-moe'
        )
        ON CONFLICT (agent_id, content_hash) DO NOTHING;
      `;
    });
    console.log("Memory stored successfully.");
  } catch (err) {
    console.error("Database Error:", err);
  } finally {
    await sql.end();
  }
}

const input = Deno.args.join(" ");
if (input) storeMemory(input);