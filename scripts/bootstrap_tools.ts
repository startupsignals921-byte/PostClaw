import postgres from "postgres";
import { readFile } from "fs/promises";
import { POSTCLAW_DB_URL, LM_STUDIO_URL } from "../services/db.js";

const sql = postgres(POSTCLAW_DB_URL!);
const AGENT_ID = process.env.AGENT_ID || "default_agent";

// The tools we ALWAYS want in the payload (handled by the pruner)
const CORE_TOOLS = ["read", "write", "edit", "exec", "process", "session_status"];

async function getEmbedding(text: string): Promise<number[]> {
  const res = await fetch(`${LM_STUDIO_URL}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: text, model: "text-embedding-nomic-embed-text-v2-moe" }),
  });
  const data: any = await res.json();
  return data.data[0].embedding;
}

async function bootstrapTools(promptFilePath: string) {
  try {
    const rawData = await readFile(promptFilePath, "utf-8");
    const promptJson = JSON.parse(rawData);

    if (!promptJson.tools || !Array.isArray(promptJson.tools)) {
      console.log("No tools array found in the provided JSON.");
      return;
    }

    // Filter out the core tools, we only want to store the heavy/situational ones
    const situationalTools = promptJson.tools.filter((t: any) => !CORE_TOOLS.includes(t.function.name));
    console.log(`[BOOTSTRAP] Found ${situationalTools.length} situational tools to store.`);

    for (const tool of situationalTools) {
      const toolName = tool.function.name;
      // Embed the name + description so semantic search can find it based on user intent
      const embedText = `${toolName}: ${tool.function.description}`;
      console.log(`[DB] Generating embedding for tool: ${toolName}...`);
      const embedding = await getEmbedding(embedText);

      await sql.begin(async (tx: any) => {
        await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;
        await tx`
          INSERT INTO context_environment (
            agent_id, access_scope, tool_name, context_data, embedding
          ) VALUES (
            ${AGENT_ID}, 'global', ${toolName}, ${JSON.stringify(tool)}, ${JSON.stringify(embedding)}
          )
          ON CONFLICT (agent_id, tool_name) DO UPDATE SET 
            context_data = EXCLUDED.context_data,
            embedding = EXCLUDED.embedding;
        `;
      });
    }
    console.log("[DONE] Tools bootstrapped to database successfully.");
  } catch (err) {
    console.error("Bootstrap Error:", err);
  } finally {
    await sql.end();
  }
}

const targetFile = process.argv[2];
if (targetFile) bootstrapTools(targetFile);
else console.log("Usage: node scripts/bootstrap_tools.js <path_to_debug_prompt.json>");