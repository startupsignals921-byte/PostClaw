import postgres from "npm:postgres";

const OPENAI_BASE_URL = "http://10.51.51.145:1234/v1";
const DB_URL = "postgres://openclaw:6599@localhost:5432/memorydb";

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
    // Hybrid search: Combines vector distance and text rank
    const results = await sql`
      WITH vector_search AS (
        SELECT id, content, 1 - (embedding <=> ${JSON.stringify(embedding)}) AS vector_score
        FROM agent_memory
        ORDER BY embedding <=> ${JSON.stringify(embedding)}
        LIMIT 10
      ),
      text_search AS (
        SELECT id, content, ts_rank(fts_vector, websearch_to_tsquery('english', ${query})) AS text_score
        FROM agent_memory
        WHERE fts_vector @@ websearch_to_tsquery('english', ${query})
      )
      SELECT 
        COALESCE(v.content, t.content) as content,
        (COALESCE(v.vector_score, 0) * 0.7) + (COALESCE(t.text_score, 0) * 0.3) AS combined_score
      FROM vector_search v
      FULL OUTER JOIN text_search t ON v.id = t.id
      ORDER BY combined_score DESC
      LIMIT 5;
    `;
    
    // Output only the raw concatenated text to save LLM context
    const contextStr = results.map(r => r.content).join("\n---\n");
    console.log(contextStr);
  } finally {
    await sql.end();
  }
}

const query = Deno.args.join(" ");
if (query) searchMemory(query);
