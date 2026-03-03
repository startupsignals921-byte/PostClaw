import postgres from "npm:postgres";

const OPENAI_BASE_URL = "http://10.51.51.145:1234/v1";
const DB_URL = "postgres://openclaw:6599@localhost:5432/memorydb";
const AGENT_ID = Deno.args[0] || Deno.env.get("AGENT_ID") || "openclaw-proto-1";
const SCOPE = Deno.args[1] || "private";
const TOOL_NAME = Deno.args[2];
const TOOL_JSON_STRING = Deno.args.slice(3).join(" ");

async function storeTool() {
  const sql = postgres(DB_URL);
  try {
    const toolObj = JSON.parse(TOOL_JSON_STRING);
    const description = toolObj.function?.description || toolObj.description || "";
    const embedText = `${TOOL_NAME}: ${description}`;

    const res = await fetch(`${OPENAI_BASE_URL}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: embedText, model: "text-embedding-nomic-embed-text-v2-moe" }),
    });
    const data = await res.json();
    const embedding = data.data[0].embedding;

    await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;
      await tx`
        INSERT INTO context_environment (
          agent_id, access_scope, tool_name, context_data, embedding
        ) VALUES (
          ${AGENT_ID}, ${SCOPE}, ${TOOL_NAME}, ${TOOL_JSON_STRING}, ${JSON.stringify(embedding)}
        )
        ON CONFLICT (agent_id, tool_name) DO UPDATE SET 
          context_data = EXCLUDED.context_data,
          embedding = EXCLUDED.embedding,
          access_scope = EXCLUDED.access_scope;
      `;
    });
    console.log(`Successfully stored/updated tool schema for: ${TOOL_NAME}`);
  } catch (err) {
    console.error("Failed to store tool:", err);
  } finally {
    await sql.end();
  }
}

if (TOOL_NAME && TOOL_JSON_STRING) storeTool();