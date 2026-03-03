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

async function searchMemory(query: string) {
  const embedding = await getEmbedding(query);
  const sql = postgres(DB_URL);
  
  try {
    await sql.begin(async (tx: any) => {
await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;
      
      const results = await tx`
        WITH vector_search AS (
          SELECT id, content, 1 - (embedding <=> ${JSON.stringify(embedding)}) AS vector_score
          FROM memory_semantic
          WHERE is_archived = false
          ORDER BY embedding <=> ${JSON.stringify(embedding)}
          LIMIT 10
        ),
        text_search AS (
          SELECT id, content, ts_rank(fts_vector, websearch_to_tsquery('simple', ${query})) AS text_score
          FROM memory_semantic
          WHERE is_archived = false AND fts_vector @@ websearch_to_tsquery('simple', ${query})
        )
        SELECT 
          COALESCE(v.content, t.content) as content,
          (COALESCE(v.vector_score, 0) * 0.7) + (COALESCE(t.text_score, 0) * 0.3) AS combined_score
        FROM vector_search v
        FULL OUTER JOIN text_search t ON v.id = t.id
        ORDER BY combined_score DESC
        LIMIT 5;
      `;
      
      // Explicitly typing r as 'any' to fix the TS error
      const contextStr = results.map((r: any) => r.content).join("\n---\n");
      console.log(contextStr || "No memories found.");
    });
  } catch (err) {
    console.error("Database Error:", err);
  } finally {
    await sql.end();
  }
}

const query = Deno.args.join(" ");
if (query) searchMemory(query);