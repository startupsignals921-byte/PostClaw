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

async function storeMemory(content: string) {
  const embedding = await getEmbedding(content);
  const sql = postgres(DB_URL);
  
  try {
    await sql`
      INSERT INTO agent_memory (content, embedding)
      VALUES (${content}, ${JSON.stringify(embedding)})
    `;
    console.log("Memory stored successfully.");
  } finally {
    await sql.end();
  }
}

// Accept input from the command line arguments
const input = Deno.args.join(" ");
if (input) storeMemory(input);
