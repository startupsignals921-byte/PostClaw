import postgres from "postgres";

const LM_STUDIO_URL = "http://10.51.51.145:1234";
const DB_URL = "postgres://openclaw:6599@localhost:5432/memorydb";

const sql = postgres(DB_URL);

async function getEmbedding(text: string): Promise<number[]> {
  const res = await fetch(`${LM_STUDIO_URL}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: text, model: "text-embedding-nomic-embed-text-v2-moe" }),
  });
  const data = await res.json();
  const embedding = data.data[0].embedding;
  
  console.log(`\n[DEBUG] Generated Embedding for query: "${text.substring(0, 50)}..."`);
  console.log(`[DEBUG] Vector Dimensions: ${embedding.length}`);
  
  return embedding;
}

async function searchPostgres(query: string): Promise<string | null> {
  const embedding = await getEmbedding(query);
  
  const results = await sql`
    WITH vector_search AS (
      SELECT id, content, 1 - (embedding <=> ${JSON.stringify(embedding)}) AS vector_score
      FROM agent_memory ORDER BY embedding <=> ${JSON.stringify(embedding)} LIMIT 5
    ),
    text_search AS (
      SELECT id, content, ts_rank(fts_vector, websearch_to_tsquery('english', ${query})) AS text_score
      FROM agent_memory WHERE fts_vector @@ websearch_to_tsquery('english', ${query})
    )
    SELECT COALESCE(v.content, t.content) as content,
           (COALESCE(v.vector_score, 0) * 0.7) + (COALESCE(t.text_score, 0) * 0.3) AS combined_score
    FROM vector_search v
    FULL OUTER JOIN text_search t ON v.id = t.id
    ORDER BY combined_score DESC LIMIT 3;
  `;

  if (results.length === 0) {
    console.log(`[DEBUG] No relevant memories retrieved from database.`);
    return null;
  }

  const retrievedContext = results.map(r => r.content).join("\n");
  
  console.log(`\n[DEBUG] --- Retrieved Database Memories ---`);
  results.forEach((row, index) => {
    console.log(`Rank ${index + 1} (Score: ${row.combined_score.toFixed(4)}): ${row.content}`);
  });
  console.log(`[DEBUG] -----------------------------------`);

  return retrievedContext;
}

Deno.serve({ port: 8000, hostname: "0.0.0.0" }, async (req) => {
  const url = new URL(req.url);
  
  if (req.method === "POST" && url.pathname.includes("/chat/completions")) {
    const body = await req.json();
    
    // Find the exact array index of the last user message
    const lastUserIndex = body.messages.findLastIndex((m: any) => m.role === "user");
    
    if (lastUserIndex !== -1) {
      const lastMessage = body.messages[lastUserIndex];
      let userText = "";

      // Extract text safely
      if (typeof lastMessage.content === "string") {
        userText = lastMessage.content;
      } else if (Array.isArray(lastMessage.content)) {
        userText = lastMessage.content
          .filter((part: any) => part.type === "text")
          .map((part: any) => part.text)
          .join(" ");
      }

      if (userText.trim() !== "") {
        console.log(`\n==================================================`);
        console.log(`[REQUEST] Intercepted user message: "${userText}"`);
        
        const context = await searchPostgres(userText);
        
        if (context) {
          console.log("\n[INJECTION] Injecting context directly into the user's prompt...");
          
          const injectionString = `[SYSTEM RAG CONTEXT]\nThe following historical memories were retrieved from the database. Use them to help answer the user's query if they are relevant:\n\n${context}\n\n[END CONTEXT]\n\n`;

          // Prepend the context to the user's actual message
          if (typeof lastMessage.content === "string") {
            body.messages[lastUserIndex].content = injectionString + lastMessage.content;
          } else if (Array.isArray(lastMessage.content)) {
            body.messages[lastUserIndex].content.unshift({
              type: "text",
              text: injectionString
            });
          }
        }
      }
    } else {
      console.log("[DEBUG] No valid user message found in payload.");
    }

    return fetch(`${LM_STUDIO_URL}${url.pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...req.headers },
      body: JSON.stringify(body)
    });
  }

  // Pass-through everything else
  return fetch(`${LM_STUDIO_URL}${url.pathname}${url.search}`, {
    method: req.method,
    headers: req.headers,
    body: req.body
  });
});
