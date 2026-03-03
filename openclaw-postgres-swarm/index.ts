// =============================================================================
// RE-EXPORTS — Single entry point for downstream consumers
// =============================================================================

export { sql, LM_STUDIO_URL, DB_URL, AGENT_ID, EMBEDDING_MODEL, getEmbedding, hashContent } from "./db.js";
export { searchPostgres, logEpisodicMemory, logEpisodicToolCall, fetchPersonaContext, fetchDynamicTools } from "./memoryService.js";
export type { ChatCompletionTool } from "./memoryService.js";

// =============================================================================
// TYPES — OpenAI Chat Completions compatible
// =============================================================================

import type { ChatCompletionTool } from "./memoryService.js";

/** A single message in the OpenAI chat format. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: ToolCallRecord[];
  tool_call_id?: string;
  name?: string;
}

/** Multimodal content part (text, image, etc). */
export interface ContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

/** A tool call record attached to an assistant message. */
export interface ToolCallRecord {
  id?: string;
  type?: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** Payload arriving at the onMessage hook (before_agent_start). */
export interface OnMessagePayload {
  messages: ChatMessage[];
  tools?: ChatCompletionTool[];
  model?: string;
  temperature?: number;
  [key: string]: unknown;
}

/** Payload arriving at the onResponse hook (agent_end). */
export interface OnResponsePayload {
  userMessage?: string;
  assistantMessage?: string;
  toolCalls?: ToolCallRecord[];
  sessionId?: string;
}

// =============================================================================
// IN-MEMORY DEDUPLICATION
// =============================================================================

const processedEvents = new Set<string>();
const MAX_CACHE_SIZE = 1000;

function isDuplicate(key: string): boolean {
  if (processedEvents.has(key)) return true;
  processedEvents.add(key);
  if (processedEvents.size > MAX_CACHE_SIZE) processedEvents.clear();
  return false;
}

// =============================================================================
// OPENCLAW PLUGIN HOOKS
// =============================================================================

import { getEmbedding } from "./db.js";
import { searchPostgres, logEpisodicMemory, logEpisodicToolCall, fetchPersonaContext, fetchDynamicTools } from "./memoryService.js";

/**
 * Extracts the text content from the last user message in a messages array.
 */
function extractUserText(messages: ChatMessage[]): string {
  const lastUserIndex = messages.findLastIndex((m) => m.role === "user");
  if (lastUserIndex === -1) return "";

  const content = messages[lastUserIndex].content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text!)
      .join(" ");
  }
  return "";
}

/**
 * Called before the prompt is sent to the LLM (before_agent_start).
 *
 * Performs three parallel DB lookups against the user's newest message:
 *   1. **JIT Tool Injection** — semantic search on `context_environment`
 *   2. **RAG Context Injection** — vector + graph search on `memory_semantic`
 *   3. **Persona Loading** — core + situational rules from `agent_persona`
 *
 * Returns the mutated payload with injected tools, context, and persona.
 */
export async function onMessage(payload: OnMessagePayload): Promise<OnMessagePayload> {
  console.log("[HOOK] onMessage triggered");

  const userText = extractUserText(payload.messages);
  if (!userText.trim()) return payload;

  const cleanText = userText.replace(/^\[.*?\]\s*/, ""); // strip bracketed prefixes
  console.log(`[HOOK] Processing: "${cleanText.substring(0, 80)}..."`);

  try {
    // Generate one embedding, then fan out all three DB queries in parallel
    const embedding = await getEmbedding(cleanText);

    const [memoryContext, personaContext, dynamicTools] = await Promise.all([
      searchPostgres(cleanText),
      fetchPersonaContext(embedding),
      fetchDynamicTools(embedding),
    ]);

    // --- 1. JIT Tool Injection ---
    if (dynamicTools.length > 0) {
      if (!payload.tools) payload.tools = [];
      payload.tools.push(...dynamicTools);
      console.log(`[HOOK] 🔧 Injected ${dynamicTools.length} dynamic tool(s)`);
    }

    // --- 2. RAG Context Injection (prepend to user message) ---
    if (memoryContext) {
      const injection = `[SYSTEM RAG CONTEXT]\nThe following historical memories were retrieved from the database. Use them to help answer the user's query if they are relevant:\n\n${memoryContext}\n\n[END CONTEXT]\n\n`;

      const lastUserIndex = payload.messages.findLastIndex((m) => m.role === "user");
      if (lastUserIndex !== -1) {
        const msg = payload.messages[lastUserIndex];
        if (typeof msg.content === "string") {
          msg.content = injection + msg.content;
        } else if (Array.isArray(msg.content)) {
          msg.content.unshift({ type: "text", text: injection });
        }
      }
      console.log(`[HOOK] 📚 Injected RAG context (${memoryContext.split("\n").length} memories)`);
    }

    // --- 3. Persona Injection (append to system message) ---
    if (personaContext) {
      const systemIndex = payload.messages.findIndex((m) => m.role === "system");
      if (systemIndex !== -1) {
        const sysMsg = payload.messages[systemIndex];
        const identityBlock = `\n\n## Dynamic Database Persona\nThe following core operational rules were loaded from your database:\n${personaContext}\n`;
        if (typeof sysMsg.content === "string") {
          sysMsg.content += identityBlock;
        }
      }
      console.log(`[HOOK] 🎭 Injected persona context`);
    }
  } catch (err) {
    console.error("[HOOK] onMessage pipeline error:", err);
  }

  return payload;
}

/**
 * Called after the model generates a response (agent_end).
 * Fires asynchronously — never blocks the LLM response stream.
 *
 * Responsible for:
 *   1. Logging the user's prompt as an episodic event
 *   2. Logging each tool execution as a separate episodic event
 */
export async function onResponse(payload: OnResponsePayload): Promise<void> {
  console.log("[HOOK] onResponse triggered");

  const promises: Promise<void>[] = [];

  // --- 1. Log the user's message as an episodic event ---
  if (payload.userMessage && payload.userMessage.trim() !== "") {
    const text = payload.userMessage.replace(/^\[.*?\]\s*/, "");

    if (!isDuplicate(text)) {
      const p = (async () => {
        try {
          const embedding = await getEmbedding(text);
          await logEpisodicMemory(text, embedding, "user_prompt");
        } catch (err) {
          console.error("[HOOK] Failed to log user episodic memory:", err);
        }
      })();
      promises.push(p);
    }
  }

  // --- 2. Log each tool call as a separate episodic event ---
  if (payload.toolCalls && payload.toolCalls.length > 0) {
    for (const toolCall of payload.toolCalls) {
      const toolCallId = toolCall.id
        || `fallback-${toolCall.function.name}-${toolCall.function.arguments.substring(0, 20)}`;

      if (isDuplicate(toolCallId)) continue;

      const p = (async () => {
        try {
          const summary = `Agent executed tool: ${toolCall.function.name} with arguments: ${toolCall.function.arguments}`;
          const embedding = await getEmbedding(summary);
          await logEpisodicToolCall(
            toolCallId,
            toolCall.function.name,
            toolCall.function.arguments,
            embedding
          );
        } catch (err) {
          console.error(`[HOOK] Failed to log tool call (${toolCall.function.name}):`, err);
        }
      })();
      promises.push(p);
    }
  }

  // Fire-and-forget: wait for all, but never throw
  if (promises.length > 0) {
    await Promise.allSettled(promises);
    console.log(`[HOOK] Episodic logging complete (${promises.length} event(s))`);
  }
}

/**
 * Called on heartbeat tick.
 * Responsible for: Sleep cycle consolidation, background maintenance.
 */
export async function onHeartbeat(): Promise<void> {
  console.log("[HOOK] onHeartbeat triggered");
  // TODO: Wire up sleep cycle and memory consolidation
}

// =============================================================================
// STANDALONE ENTRY POINT (for testing)
// =============================================================================

import { sql, DB_URL, LM_STUDIO_URL, AGENT_ID, EMBEDDING_MODEL } from "./db.js";

if (require.main === module) {
  console.log("=== openclaw-postgres-swarm plugin loaded ===");
  console.log(`  DB:     ${DB_URL}`);
  console.log(`  LM:     ${LM_STUDIO_URL}`);
  console.log(`  Agent:  ${AGENT_ID}`);
  console.log(`  Model:  ${EMBEDDING_MODEL}`);
  console.log("Hooks exported: onMessage, onResponse, onHeartbeat");

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await sql.end();
    process.exit(0);
  });
}
