// =============================================================================
// RE-EXPORTS — Single entry point for downstream consumers
// =============================================================================

export { sql, LM_STUDIO_URL, DB_URL, AGENT_ID, EMBEDDING_MODEL, getEmbedding, hashContent } from "./db.js";
export { searchPostgres, logEpisodicMemory, logEpisodicToolCall, fetchPersonaContext, fetchDynamicTools } from "./memoryService.js";
export type { ChatCompletionTool } from "./memoryService.js";

// =============================================================================
// TYPES
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

// =============================================================================
// IN-MEMORY DEDUPLICATION
// =============================================================================

const processedEvents = new Set<string>();
const MAX_CACHE_SIZE = 1000;

/** Cache last message from message_received (fires before before_prompt_build). */
let lastReceivedMessage: string = "";

function isDuplicate(key: string): boolean {
  if (processedEvents.has(key)) return true;
  processedEvents.add(key);
  if (processedEvents.size > MAX_CACHE_SIZE) processedEvents.clear();
  return false;
}

// =============================================================================
// HELPERS
// =============================================================================

import { getEmbedding } from "./db.js";
import { searchPostgres, logEpisodicMemory, logEpisodicToolCall, fetchPersonaContext, fetchDynamicTools } from "./memoryService.js";
import * as fs from "node:fs";
import * as path from "node:path";

// const DEBUG_LOG_DIR = path.join(__dirname, "..", "debug_logs");

// function debugLog(hookName: string, suffix: string, data: any): void {
//   try {
//     if (!fs.existsSync(DEBUG_LOG_DIR)) fs.mkdirSync(DEBUG_LOG_DIR, { recursive: true });
//     const ts = new Date().toISOString().replace(/[:.]/g, "-");
//     const filename = `${hookName}_${ts}_${suffix}.json`;
//     const content = JSON.stringify(data, null, 2);
//     fs.writeFileSync(path.join(DEBUG_LOG_DIR, filename), content);
//     console.log(`[PostClaw] 📄 Debug log: ${filename} (${content.length} bytes)`);
//   } catch (err) {
//     console.error(`[PostClaw] Failed to write debug log:`, err);
//   }
// }

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

// =============================================================================
// OPENCLAW PLUGIN — Default export for plugin loader
// =============================================================================

const openclawPostgresPlugin = {
  id: "postclaw",
  name: "PostClaw",
  description: "PostgreSQL-backed RAG, memory, and persona management",

  register(api: any) {
    console.log("[PostClaw] Registering plugin hooks...");

    // -------------------------------------------------------------------------
    // before_prompt_build — Prune + replace system prompt, inject RAG context
    //
    // This is a MODIFYING hook. The handler receives:
    //   event = { prompt: string, messages: ChatMessage[] }
    //   ctx   = { agentId, sessionKey, sessionId, workspaceDir }
    //
    // Must RETURN: { systemPrompt?: string, prependContext?: string }
    //   - systemPrompt:   REPLACES the system prompt entirely
    //   - prependContext:  text prepended to the user's message context
    //
    // This replicates the old rag_proxy.ts + payload_pruner.ts pattern:
    // 1. Strip OpenClaw's default bloat sections
    // 2. Inject custom memory architecture rules
    // 3. Append persona from Postgres
    // 4. Inject RAG context as prependContext
    // -------------------------------------------------------------------------
    api.on(
      "before_prompt_build",
      async (event: any, ctx: any) => {
        try {
          // --- DEBUG: dump incoming event ---
          // debugLog("before_prompt_build", "IN", {
          //   hasPrompt: typeof event.prompt === "string",
          //   promptLength: event.prompt?.length ?? 0,
          //   promptPreview: event.prompt?.substring(0, 500) ?? null,
          //   messageCount: event.messages?.length ?? 0,
          //   messageRoles: (event.messages ?? []).map((m: any) => m.role),
          //   ctx,
          //   eventKeys: Object.keys(event),
          // });

          const messages: ChatMessage[] = event.messages ?? [];
          const userText = lastReceivedMessage || extractUserText(messages);
          const cleanText = userText.replace(/^\[.*?\]\s*/, "");
          const isHeartbeat = cleanText.toLowerCase().includes("heartbeat") || cleanText.toLowerCase().includes("cron");

          console.log(`[PostClaw] before_prompt_build: "${cleanText.substring(0, 80)}..." (heartbeat=${isHeartbeat})`);

          // ==================================================================
          // STEP 1: Prune the system prompt (strip OpenClaw default bloat)
          // ==================================================================
          let sysPrompt: string = event.prompt ?? "";

          // Strip default Tooling, Safety, and Skills rules
          sysPrompt = sysPrompt.replace(/## Tooling[\s\S]*?(?=## Workspace)/g, "");

          // Strip default Documentation and Time rules
          sysPrompt = sysPrompt.replace(/## Documentation[\s\S]*?(?=## Inbound Context)/g, "");

          // Strip the ENTIRE Project Context (all injected Markdown files)
          sysPrompt = sysPrompt.replace(/# Project Context[\s\S]*?(?=## Silent Replies)/g, "");

          // Conditionally strip Heartbeats section (keep it for heartbeat messages)
          if (!isHeartbeat) {
            sysPrompt = sysPrompt.replace(/## Heartbeats[\s\S]*?(?=## Runtime)/g, "");
          }

          // Clean up excess whitespace
          sysPrompt = sysPrompt.replace(/\n{3,}/g, "\n\n");

          // ==================================================================
          // STEP 2: Inject custom memory architecture rules
          // ==================================================================
          const agentId = AGENT_ID;

          sysPrompt += `
            ## Memory & Knowledge Management
            You are a stateful agent. Your context window is ephemeral but your PostgreSQL memory is permanent.
            Silently manage your knowledge — never ask permission to save, link, or update facts.

            - **Retrieval:** Relevant memories (with UUID tags) are auto-injected. If a relevant memory is not in the user message, perform a search for it.
            - **Search:** Use when a relevant memory is not in the user message. \`deno run -A /home/cl/.openclaw/workspace/skills/db-memory-search/script.ts "${agentId}" "<query>"\`
            - **Correct/update facts:** Use when a fact is incorrect, outdated, or needs to be updated. \`deno run -A /home/cl/.openclaw/workspace/skills/db-memory-update/script.ts "<old_id>" "<new_fact>"\`
            - **Save new facts:** Use when a new fact is learned. \`deno run -A /home/cl/.openclaw/workspace/skills/db-memory-store/script.ts "${agentId}" "global" "<fact>"\`
            - **Link related memories:** Use when two memories are related. \`deno run -A /home/cl/.openclaw/workspace/skills/db-memory-link/script.ts "<source_id>" "<target_id>" "<relationship>"\`
            - **Store a tool:** Use when a new tool is learned. \`deno run -A /home/cl/.openclaw/workspace/skills/db-tool-store/script.ts "${agentId}" "<private|global>" "<name>" "<json>"\`
            - **Sleep cycle** (consolidates short-term memory): \`deno run -A /home/cl/.openclaw/workspace/scripts/sleep_cycle.ts "${agentId}"\`
            `;

          sysPrompt += `
            ## Autonomous Heartbeats
            OpenClaw provides a native heartbeat loop — never use Linux crontab.
            To schedule background tasks, add a checklist to: /home/cl/.openclaw/workspace/HEARTBEAT.md
            On heartbeat poll: read that file. If no pending tasks, reply with ONLY: HEARTBEAT_OK
            `;

          // ==================================================================
          // STEP 3: Fetch persona + RAG context from Postgres (in parallel)
          // ==================================================================
          const result: { systemPrompt?: string; prependContext?: string } = {};

          if (!isHeartbeat) {
            const hasUserText = cleanText.trim().length > 0;
            const embedding = hasUserText ? await getEmbedding(cleanText) : null;

            const [memoryContext, personaContext] = await Promise.all([
              // RAG: only when we have user text to search against
              hasUserText ? searchPostgres(cleanText) : Promise.resolve(null),
              // Persona: always fetch (core rules work without embedding)
              fetchPersonaContext(embedding),
            ]);

            // Persona context → append to the pruned system prompt
            if (personaContext) {
              sysPrompt += `\n\n## Dynamic Database Persona\nThe following core operational rules were loaded from your database:\n${personaContext}\n`;
              console.log(`[PostClaw] 🎭 Injected persona context`);
            }

            // RAG context → prependContext (injected before the user message)
            if (memoryContext) {
              result.prependContext =
                `[SYSTEM RAG CONTEXT]\n` +
                `The following historical memories were retrieved from the database. ` +
                `Use them to help answer the user's query if they are relevant:\n\n` +
                `${memoryContext}\n\n` +
                `[END CONTEXT]`;
              console.log(`[PostClaw] 📚 Injected RAG context (${memoryContext.split("\n").length} lines)`);
            }
          }

          // Return the fully replaced system prompt
          result.systemPrompt = sysPrompt;
          console.log(`[PostClaw] ✅ System prompt replaced (${sysPrompt.length} chars)`);

          // --- DEBUG: dump outgoing result ---
          // debugLog("before_prompt_build", "OUT", {
          //   systemPromptLength: result.systemPrompt?.length ?? 0,
          //   systemPromptPreview: result.systemPrompt?.substring(0, 500) ?? null,
          //   prependContextLength: result.prependContext?.length ?? 0,
          //   prependContextPreview: result.prependContext?.substring(0, 500) ?? null,
          //   fullSystemPrompt: result.systemPrompt,
          //   fullPrependContext: result.prependContext,
          // });

          return result;
        } catch (err) {
          console.error("[PostClaw] before_prompt_build error:", err);
          return { systemPrompt: event.prompt };
        }
      },
      {
        name: "PostClaw.before-prompt-build",
        description: "Prunes default system prompt and injects memory architecture, persona, and RAG context",
      },
    );

    // -------------------------------------------------------------------------
    // JIT Dynamic Tools — registered via api.registerTool()
    //
    // Unlike before_prompt_build, tools are registered with a factory function
    // that resolves dynamically per agent invocation.
    // -------------------------------------------------------------------------
    api.registerTool(
      (toolCtx: any) => {
        // This factory runs each time the agent needs tools.
        // We can't do async here, so we return a wrapper tool that does the
        // actual dynamic lookup. The dynamic tools table holds tool definitions
        // that get injected when semantically relevant.
        //
        // For now, return null — dynamic tool injection will be handled
        // via prependContext instructions to the model.
        return null;
      },
      { names: [] },
    );

    // -------------------------------------------------------------------------
    // agent_end — Log episodic memories after agent completes
    //
    // This is a VOID hook (fire-and-forget). The handler receives:
    //   event = { messages: ChatMessage[], success: boolean, error?: string, durationMs: number }
    //   ctx   = { agentId, sessionKey, sessionId, workspaceDir, messageProvider }
    // -------------------------------------------------------------------------
    api.on(
      "agent_end",
      async (event: any, ctx: any) => {
        try {
          // --- DEBUG: dump incoming event ---
          // debugLog("agent_end", "IN", {
          //   eventKeys: Object.keys(event),
          //   messageCount: event.messages?.length ?? 0,
          //   messageRoles: (event.messages ?? []).map((m: any) => m.role),
          //   success: event.success,
          //   error: event.error,
          //   durationMs: event.durationMs,
          //   ctx,
          // });

          const messages: ChatMessage[] = event.messages ?? [];
          console.log(`[PostClaw] agent_end: ${messages.length} messages, success=${event.success}`);

          // Extract the last user message
          const lastUser = [...messages].reverse().find((m: ChatMessage) => m.role === "user");
          const userMessage = lastUser
            ? typeof lastUser.content === "string"
              ? lastUser.content
              : Array.isArray(lastUser.content)
                ? lastUser.content.filter((p: ContentPart) => p.type === "text").map((p: ContentPart) => p.text).join(" ")
                : ""
            : "";

          const promises: Promise<void>[] = [];

          // Log user message as episodic event
          if (userMessage.trim()) {
            // Strip any RAG context that OpenClaw prepended to the user message
            const text = userMessage
              .replace(/\[SYSTEM RAG CONTEXT\][\s\S]*?\[END CONTEXT\]\s*/g, "")
              .replace(/^\[.*?\]\s*/, "")
              .trim();
            if (!isDuplicate(text)) {
              promises.push(
                (async () => {
                  try {
                    const embedding = await getEmbedding(text);
                    await logEpisodicMemory(text, embedding, "user_prompt");
                  } catch (err) {
                    console.error("[PostClaw] Failed to log episodic memory:", err);
                  }
                })()
              );
            }
          }

          // Log tool calls as episodic events
          const toolCalls: ToolCallRecord[] = messages
            .filter((m: ChatMessage) => m.role === "assistant" && m.tool_calls)
            .flatMap((m: ChatMessage) => m.tool_calls ?? []);

          for (const toolCall of toolCalls) {
            const toolCallId = toolCall.id
              || `fallback-${toolCall.function.name}-${toolCall.function.arguments.substring(0, 20)}`;
            if (isDuplicate(toolCallId)) continue;

            promises.push(
              (async () => {
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
                  console.error(`[PostClaw] Failed to log tool call (${toolCall.function.name}):`, err);
                }
              })()
            );
          }

          if (promises.length > 0) {
            await Promise.allSettled(promises);
            console.log(`[PostClaw] Episodic logging complete (${promises.length} event(s))`);
          }
        } catch (err) {
          console.error("[PostClaw] agent_end error:", err);
        }
      },
      {
        name: "PostClaw.agent-end",
        description: "Logs episodic memories for user prompts and tool calls after agent completes",
      },
    );

    // -------------------------------------------------------------------------
    // message_received — Log inbound messages to episodic memory
    //
    // This is a VOID hook. The handler receives:
    //   event = { from, content, channelId, ... }  (raw message event fields)
    //   ctx   = { agentId, sessionKey, ... }
    // -------------------------------------------------------------------------
    api.on(
      "message_received",
      async (event: any, _ctx: any) => {
        try {
          // --- DEBUG: dump incoming event ---
          // debugLog("message_received", "IN", {
          //   eventKeys: Object.keys(event),
          //   content: event.content,
          //   from: event.from,
          //   channelId: event.channelId,
          //   _ctx,
          // });

          const content = event.content;
          if (!content || typeof content !== "string" || !content.trim()) return;

          const cleanText = content.replace(/^\[.*?\]\s*/, "");
          if (isDuplicate(cleanText)) return;

          // Cache for before_prompt_build (which fires after this hook)
          lastReceivedMessage = cleanText;

          const embedding = await getEmbedding(cleanText);
          await logEpisodicMemory(cleanText, embedding, "inbound_message");
          console.log("[PostClaw] Logged inbound message to episodic memory");
        } catch (err) {
          console.error("[PostClaw] message_received error:", err);
        }
      },
      {
        name: "PostClaw.message-received",
        description: "Logs inbound messages to episodic memory",
      },
    );

    console.log("[PostClaw] Plugin hooks registered successfully");
  },
};

export default openclawPostgresPlugin;

// =============================================================================
// STANDALONE ENTRY POINT (for testing)
// =============================================================================

import { sql, DB_URL, LM_STUDIO_URL, AGENT_ID, EMBEDDING_MODEL } from "./db.js";

if (require.main === module) {
  console.log("=== PostClaw-swarm plugin loaded ===");
  console.log(`  DB:     ${DB_URL}`);
  console.log(`  LM:     ${LM_STUDIO_URL}`);
  console.log(`  Agent:  ${AGENT_ID}`);
  console.log(`  Model:  ${EMBEDDING_MODEL}`);
  console.log("Hooks: before_prompt_build, agent_end, message_received");

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await sql.end();
    process.exit(0);
  });
}
