import postgres from "npm:postgres";
// NEW: Import the payload pruner
import { prunePayload } from "./payload_pruner.ts"; 

const LM_STUDIO_URL = "http://10.51.51.145:1234";
const DB_URL = "postgres://openclaw:6599@localhost:5432/memorydb";
const AGENT_ID = "openclaw-proto-1";

const sql = postgres(DB_URL);

const processedEvents = new Set<string>();
// let globalWatermark: string | null = null;

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

async function searchPostgres(userText: string): Promise<string | null> {
  let contextString: string | null = null;
  try {
    const embedding = await getEmbedding(userText);
    
    await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;
      
      // Step 1: Semantic Search + Graph Traversal
      const results = await tx`
        WITH semantic_matches AS (
          SELECT id, content, 1 - (embedding <=> ${JSON.stringify(embedding)}) AS similarity
          FROM memory_semantic
          WHERE agent_id = ${AGENT_ID} AND is_archived = false
          ORDER BY similarity DESC
          LIMIT 7
        ),
        linked_matches AS (
          SELECT m.id, m.content, 0.8 AS similarity, e.relationship_type, sm.id AS source_match_id
          FROM entity_edges e
          JOIN memory_semantic m ON (e.target_memory_id = m.id OR e.source_memory_id = m.id)
          JOIN semantic_matches sm ON (e.source_memory_id = sm.id OR e.target_memory_id = sm.id)
          WHERE e.agent_id = ${AGENT_ID} AND m.id != sm.id AND m.is_archived = false
        )
        SELECT id, content, similarity, 'Direct Match' as relation FROM semantic_matches
        UNION ALL
        SELECT id, content, similarity, 'Linked: ' || relationship_type as relation FROM linked_matches
        ORDER BY similarity DESC
        LIMIT 15;
      `;

      if (results.length > 0) {
        // Step 2: Format the output WITH THE ID so the agent can reference them
        contextString = results.map((r: any, i: number) => 
          `[ID: ${r.id}] (${r.relation}) - ${r.content}`
        ).join("\n");
        
        console.log(`\n[DEBUG] --- Retrieved Graph Memories ---`);
        results.forEach((r: any) => console.log(`(${r.relation}): ${r.content.substring(0, 50)}...`));
        console.log(`[DEBUG] -----------------------------------`);
      }
    });
  } catch (err) {
    console.error("Postgres search error:", err);
  }
  return contextString;
}

async function fetchPersonaContext(embedding: number[]): Promise<string | null> {
  let personaContext: string | null = null;
  
  try {
    await sql.begin(async (tx: any) => {
      // Set RLS scope for the query
      await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;
      
      const results = await tx`
        WITH core_persona AS (
          SELECT category, content, 1.0 AS relevance_score
          FROM agent_persona
          WHERE is_always_active = true
        ),
        situational_persona AS (
          SELECT category, content, 1 - (embedding <=> ${JSON.stringify(embedding)}) AS relevance_score
          FROM agent_persona
          WHERE is_always_active = false
          ORDER BY embedding <=> ${JSON.stringify(embedding)}
          LIMIT 3
        )
        SELECT * FROM core_persona
        UNION ALL
        SELECT * FROM situational_persona
        ORDER BY relevance_score DESC;
      `;

      if (results.length > 0) {
        // Format the rules into a clean markdown block
        personaContext = results.map((r: any) => `* **[${r.category}]**: ${r.content}`).join("\n");
        console.log(`\n[DEBUG] --- Loaded ${results.length} Persona Rules from Database ---`);
      }
    });
  } catch (err) {
    console.error("[DEBUG] Persona fetch failed:", err);
  }

  return personaContext;
}

async function fetchDynamicTools(embedding: number[]): Promise<any[]> {
  let dynamicTools: any[] = [];
  try {
    await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;
      
      // Lowered the threshold from 0.50 to 0.35
      const results = await tx`
        SELECT tool_name, context_data, 1 - (embedding <=> ${JSON.stringify(embedding)}) AS similarity
        FROM context_environment
        WHERE 1 - (embedding <=> ${JSON.stringify(embedding)}) > 0.35
        ORDER BY similarity DESC
        LIMIT 3;
      `;
      
      if (results.length > 0) {
        dynamicTools = results.map((r: any) => JSON.parse(r.context_data));
        console.log(`\n[DEBUG] 🔧 Dynamically loaded tools from DB: ${results.map((r: any) => r.tool_name).join(', ')}`);
      }
    });
  } catch (err) {
    console.error("[DEBUG] Failed to fetch dynamic tools:", err);
  }
  return dynamicTools;
}

async function logEpisodicMemory(text: string, embedding: number[], eventType: string = 'user_prompt') {
  // 1. In-Memory Debounce Check
  if (processedEvents.has(text)) return;
  
  // 2. Add to cache and prevent memory leaks by capping size
  processedEvents.add(text);
  if (processedEvents.size > 1000) processedEvents.clear();

  try {
    await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;
      
      await tx`
        INSERT INTO memory_episodic (
          agent_id, session_id, event_summary, event_type, embedding, embedding_model
        ) VALUES (
          ${AGENT_ID}, 'active-session', ${text}, ${eventType}, ${JSON.stringify(embedding)}, 'nomic-embed-text-v2-moe'
        )
      `;
    });
    console.log(`\n[OBSERVER] 📝 Logged episodic event (${eventType}) to database.`);
  } catch (err) {
    console.error("[OBSERVER] Failed to log episodic memory:", err);
  }
}

async function logEpisodicToolCalls(messages: any[]) {
  try {
    const lastAssistantIndex = messages.findLastIndex((m: any) => 
      m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0
    );
    
    if (lastAssistantIndex !== -1) {
      const assistantMessage = messages[lastAssistantIndex];
      
      for (const toolCall of assistantMessage.tool_calls) {
        const toolCallId = toolCall.id || `fallback-${toolCall.function.name}-${toolCall.function.arguments.substring(0, 20)}`;
        
        // 1. In-Memory Debounce Check
        if (processedEvents.has(toolCallId)) continue;
        
        // 2. Add to cache
        processedEvents.add(toolCallId);
        
        const toolName = toolCall.function.name;
        const toolArgs = toolCall.function.arguments;
        const summary = `Agent executed tool: ${toolName} with arguments: ${toolArgs}`;
        
        // Only generate the embedding IF it passes the cache check
        const embedding = await getEmbedding(summary);
        
        await sql.begin(async (tx: any) => {
          await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;
          await tx`
            INSERT INTO memory_episodic (
              agent_id, session_id, event_summary, event_type, embedding, embedding_model, metadata
            ) VALUES (
              ${AGENT_ID}, 'active-session', ${summary}, 'tool_execution', ${JSON.stringify(embedding)}, 'nomic-embed-text-v2-moe', ${JSON.stringify({ tool_call_id: toolCallId, tool_name: toolName })}
            )
          `;
        });
        console.log(`\n[OBSERVER] 🛠️  Logged tool execution (${toolName}) to database.`);
      }
    }
  } catch (err) {
    console.error("[OBSERVER] Failed to log episodic tool calls:", err);
  }
}

// async function getLatestCheckpoint(): Promise<any> {
//   try {
//     const result = await sql.begin(async (tx: any) => {
//       await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;
//       return await tx`
//         SELECT summary, active_tasks 
//         FROM conversation_checkpoints 
//         WHERE agent_id = ${AGENT_ID} AND session_id = 'active-session'
//         ORDER BY created_at DESC LIMIT 1
//       `;
//     });
//     return result.length > 0 ? result[0] : null;
//   } catch (e) {
//     console.error("[CHECKPOINT] Fetch error:", e);
//     return null;
//   }
// }

// async function createAndStoreCheckpoint(messagesToCompress: any[], previousSummary: string | null) {
//   console.log(`[CHECKPOINT] Synthesizing ${messagesToCompress.length} old messages...`);
  
//   // 1. Format the old messages into a raw transcript
//   let transcript = messagesToCompress.map(m => {
//     const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
//     return `[${m.role.toUpperCase()}]: ${content}`;
//   }).join('\n\n');

//   // 2. Prevent blowing out the summarizer's context window (~6000 tokens max)
//   const MAX_CHARS = 20000; 
//   if (transcript.length > MAX_CHARS) {
//      console.log(`[CHECKPOINT] Transcript too long (${transcript.length} chars). Truncating older parts to fit context window...`);
//      transcript = "... [EARLIER MESSAGES TRUNCATED FOR COMPRESSION SIZE] ...\n\n" + transcript.slice(-MAX_CHARS);
//   }

//   const systemPrompt = `
// You are the cognitive compression engine for an AI assistant. 
// Your task is to summarize the provided conversation transcript to save context space.
// ${previousSummary ? `Here is the summary of the conversation BEFORE this transcript: "${previousSummary}"\nMerge this older context with the new transcript.` : ''}

// Focus strictly on:
// 1. The user's core goals.
// 2. Important decisions made or facts established.
// 3. Tasks that are currently active or pending.

// Output EXCLUSIVELY as a raw JSON object:
// {
//   "summary": "A dense, highly detailed narrative summary of the state of the conversation.",
//   "active_tasks": {"task_1": "status", "task_2": "status"}
// }
// Do not use markdown wrappers.
// `;

//   try {
//     // Ensure the /v1/ is always present for LM Studio's OpenAI compatibility
//     const baseUrl = LM_STUDIO_URL.replace(/\/v1\/?$/, ''); 
//     const endpoint = `${baseUrl}/v1/chat/completions`;

//     const res = await fetch(endpoint, {
//       method: "POST",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify({
//         model: "qwen3.5-9b", 
//         messages: [
//           { role: "system", content: systemPrompt },
//           { role: "user", content: `Transcript:\n\n${transcript}` }
//         ],
//         temperature: 0.1,
//       }),
//     });

//     const data = await res.json();

//     // 3. Graceful Error Handling
//     if (!res.ok || !data.choices || !data.choices[0]) {
//       console.error("[CHECKPOINT] LLM API Error during compression:", JSON.stringify(data));
//       return; 
//     }

//     let jsonString = data.choices[0].message.content.trim();

//     // Strip reasoning blocks and formatting
//     jsonString = jsonString.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
//     if (jsonString.startsWith("```json")) jsonString = jsonString.replace(/^```json\n/, "").replace(/\n```$/, "");
//     if (jsonString.startsWith("```")) jsonString = jsonString.replace(/^```\n/, "").replace(/\n```$/, "");

//     const parsed = JSON.parse(jsonString);

//     await sql.begin(async (tx: any) => {
//       await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;
//       await tx`
//         INSERT INTO conversation_checkpoints (agent_id, session_id, summary, active_tasks)
//         VALUES (${AGENT_ID}, 'active-session', ${parsed.summary}, ${JSON.stringify(parsed.active_tasks)})
//       `;
//     });
//     console.log(`[CHECKPOINT] Compression complete and saved to database.`);
//   } catch (e) {
//     console.error("[CHECKPOINT] Failed to create checkpoint:", e);
//   }
// }

Deno.serve({ port: 8000, hostname: "0.0.0.0" }, async (req) => {
  const url = new URL(req.url);
  
  if (req.method === "POST" && url.pathname.includes("/chat/completions")) {
    let body = await req.json();
    
    // 1. Prune the payload (strip heavy tools and default boilerplate)
    body = prunePayload(body);

    const lastUserIndex = body.messages.findLastIndex((m: any) => m.role === "user");
    let userText = "";
    let isCompaction = false;
    let isHeartbeat = false;

    if (lastUserIndex !== -1) {
      const lastMessage = body.messages[lastUserIndex];
      if (typeof lastMessage.content === "string") {
        userText = lastMessage.content;
      } else if (Array.isArray(lastMessage.content)) {
        userText = lastMessage.content
          .filter((part: any) => part.type === "text")
          .map((part: any) => part.text)
          .join(" ");
      }

      isHeartbeat = userText.toLowerCase().includes("heartbeat") || userText.toLowerCase().includes("cron");
      isCompaction = userText.includes("<conversation>") && userText.includes("Create a structured context checkpoint summary");

      // ====================================================================
      // ROUTE A: COMPACTION RESCUE (Help OpenClaw's native compactor succeed)
      // ====================================================================
      if (isCompaction) {
        console.log(`\n==================================================`);
        console.log(`[COMPACTION RESCUE] Intercepted OpenClaw's native compaction prompt.`);
        
        // Truncate the massive transcript so LM Studio doesn't choke and crash
        const convoRegex = /<conversation>([\s\S]*?)<\/conversation>/;
        const match = userText.match(convoRegex);
        if (match && match[1].length > 20000) {
          const truncated = "\n... [EARLIER HISTORY TRUNCATED TO FIT VRAM] ...\n" + match[1].slice(-20000);
          const newContent = userText.replace(match[1], truncated);
          
          if (typeof lastMessage.content === "string") {
            body.messages[lastUserIndex].content = newContent;
          } else {
            body.messages[lastUserIndex].content[0].text = newContent;
          }
          console.log(`[COMPACTION RESCUE] Sliced massive transcript down to safe size.`);
        }
      } 
      // ====================================================================
      // ROUTE B: NORMAL CHAT (Inject RAG and Log Memories)
      // ====================================================================
      else if (userText.trim() !== "") {
        console.log(`\n==================================================`);
        console.log(`[REQUEST] Intercepted user message: "${userText.substring(0, 100)}..."`);
        
        const cleanText = userText.replace(/^\[.*?\]\s*/, "");
        const embedding = await getEmbedding(cleanText);
        
        if (!isHeartbeat) {
          logEpisodicMemory(cleanText, embedding, "user_prompt");
        }
        logEpisodicToolCalls(body.messages);
        
        const [memoryContext, personaContext, dynamicTools] = await Promise.all([
          searchPostgres(cleanText), 
          fetchPersonaContext(embedding),
          fetchDynamicTools(embedding)
        ]);
        
        if (memoryContext) {
          const injectionString = `[SYSTEM RAG CONTEXT]\nThe following historical memories were retrieved from the database. Use them to help answer the user's query if they are relevant:\n\n${memoryContext}\n\n[END CONTEXT]\n\n`;
          if (typeof lastMessage.content === "string") {
            body.messages[lastUserIndex].content = injectionString + lastMessage.content;
          } else if (Array.isArray(lastMessage.content)) {
            body.messages[lastUserIndex].content.unshift({ type: "text", text: injectionString });
          }
        }

        if (personaContext) {
          const systemIndex = body.messages.findIndex((m: any) => m.role === "system");
          if (systemIndex !== -1) {
             const identityString = `\n\n## Dynamic Database Persona\nThe following core operational rules were loaded from your database:\n${personaContext}\n`;
             body.messages[systemIndex].content += identityString;
          }
        }

        if (dynamicTools.length > 0 && body.tools) {
           body.tools.push(...dynamicTools);
        }
      }
    }

    // ====================================================================
    // STATELESS CONTEXT CLIPPER (Keep normal chats lightning fast)
    // ====================================================================
    const MAX_MESSAGES = 12;
    if (!isCompaction && body.messages.length > MAX_MESSAGES) {
       const sysMsg = body.messages[0];
       
       // Walk backwards to find the 4th most recent user message
       // This guarantees we never sever a tool-call loop
       let userMsgCount = 0;
       let cutIndex = 1;
       for (let i = body.messages.length - 1; i > 0; i--) {
          if (body.messages[i].role === "user") userMsgCount++;
          if (userMsgCount === 4) {
             cutIndex = i;
             break;
          }
       }
       body.messages = [sysMsg, ...body.messages.slice(cutIndex)];
       console.log(`[CLIPPER] Dropped old history. Payload trimmed to ${body.messages.length} messages.`);
    }

    try {
      await Deno.mkdir("debug_logs", { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const logFile = `debug_logs/prompt_dump_${timestamp}.json`;
      await Deno.writeTextFile(logFile, JSON.stringify(body, null, 2));
    } catch (e) {
      console.error("[DEBUG] Failed to write prompt debug log:", e);
    }

    return fetch(`${LM_STUDIO_URL}${url.pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...req.headers },
      body: JSON.stringify(body)
    });
  }

  return fetch(`${LM_STUDIO_URL}${url.pathname}${url.search}`, {
    method: req.method,
    headers: req.headers,
    body: req.body
  });
});