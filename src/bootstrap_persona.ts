import postgres from "npm:postgres";

const LM_STUDIO_URL = "http://10.51.51.145:1234/v1";
const DB_URL = "postgres://openclaw:6599@localhost:5432/memorydb";
const AGENT_ID = Deno.env.get("AGENT_ID") || "openclaw-proto-1";

const sql = postgres(DB_URL);

interface PersonaChunk {
  category: string;
  content: string;
  is_always_active: boolean;
}

async function getEmbedding(text: string): Promise<number[]> {
  const res = await fetch(`${LM_STUDIO_URL}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: text, model: "text-embedding-nomic-embed-text-v2-moe" }),
  });
  const data = await res.json();
  return data.data[0].embedding;
}

async function chunkMarkdownWithLLM(markdownText: string, filename: string): Promise<PersonaChunk[]> {
  const systemPrompt = `
You are an expert data architect. Your task is to take a raw Markdown configuration file and break it down into discrete, atomic semantic chunks.
Extract the core rules, behaviors, and instructions. 

Output your response EXCLUSIVELY as a raw JSON array of objects. Do not use markdown blocks (\`\`\`json).
Each object must have:
- "category": A short, unique identifier for this rule (max 50 chars, e.g., "communication_style", "discord_rules", "file_management").
- "content": The actual text of the rule or instruction.
- "is_always_active": Boolean. Set to true ONLY IF this is a core identity trait that must be injected into every single prompt. Set to false if it is situational.
`;

  console.log(`[LLM] Asking local model to semantically chunk ${filename}...`);
  
  const res = await fetch(`${LM_STUDIO_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "unsloth/qwen3.5-35b-a3b", // Targeting your specific local model
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Here is the file to chunk:\n\n${markdownText}` }
      ],
      temperature: 0.1, // Keep it highly deterministic for JSON formatting
    }),
  });

  const data = await res.json();
  let jsonString = data.choices[0].message.content.trim();
  
  // NEW: Strip out the <think>...</think> chain-of-thought blocks
  jsonString = jsonString.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

  // Strip markdown code blocks just in case the LLM ignores the instruction
  if (jsonString.startsWith("```json")) {
    jsonString = jsonString.replace(/^```json\n/, "").replace(/\n```$/, "");
  }
  // Sometimes it just outputs ``` without the json tag
  if (jsonString.startsWith("```")) {
    jsonString = jsonString.replace(/^```\n/, "").replace(/\n```$/, "");
  }

  try {
    return JSON.parse(jsonString) as PersonaChunk[];
  } catch (e) {
    console.error("[ERROR] Failed to parse LLM output as JSON:", jsonString);
    throw e;
  }
}

async function processAndStoreFile(filePath: string) {
  try {
    const markdownText = await Deno.readTextFile(filePath);
    const filename = filePath.split('/').pop() || "unknown.md";
    
    // 1. Get the intelligent chunks from the LLM
    const chunks = await chunkMarkdownWithLLM(markdownText, filename);
    console.log(`[SUCCESS] Sliced ${filename} into ${chunks.length} semantic chunks.`);

    // 2. Process and insert each chunk into the database
    for (const chunk of chunks) {
      console.log(`[DB] Generating embedding and storing category: "${chunk.category}"...`);
      const embedding = await getEmbedding(chunk.content);
      
      await sql.begin(async (tx: any) => {
        await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;
        
        await tx`
          INSERT INTO agent_persona (
            agent_id, 
            access_scope, 
            category, 
            content, 
            is_always_active, 
            embedding
          )
          VALUES (
            ${AGENT_ID}, 
            'private', 
            ${chunk.category}, 
            ${chunk.content}, 
            ${chunk.is_always_active}, 
            ${JSON.stringify(embedding)}
          )
          ON CONFLICT (agent_id, category) 
          DO UPDATE SET 
            content = EXCLUDED.content,
            embedding = EXCLUDED.embedding,
            is_always_active = EXCLUDED.is_always_active;
        `;
      });
    }
    console.log(`[DONE] Finished bootstrapping ${filename} into Postgres!`);
    
  } catch (err) {
    console.error("Bootstrap Error:", err);
  } finally {
    await sql.end();
  }
}

const targetFile = Deno.args[0];
if (targetFile) {
  processAndStoreFile(targetFile);
} else {
  console.log("Usage: deno run --allow-net --allow-read --allow-env scripts/bootstrap_persona.ts <path_to_markdown_file>");
  Deno.exit(1);
}