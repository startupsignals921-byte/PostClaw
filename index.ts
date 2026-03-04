// =============================================================================
// RE-EXPORTS — Single entry point for downstream consumers
// =============================================================================

export { getSql, LM_STUDIO_URL, POSTCLAW_DB_URL, EMBEDDING_MODEL, getEmbedding, hashContent, setEmbeddingConfig, setDbUrl } from "./services/db.js";
export { ensureAgent, searchPostgres, logEpisodicMemory, logEpisodicToolCall, fetchPersonaContext, fetchDynamicTools, storeMemory, updateMemory, linkMemories, storeTool } from "./services/memoryService.js";
export { listPersonas, getPersona, createPersona, updatePersona, deletePersona } from "./services/personaService.js";
export type { ChatCompletionTool } from "./services/memoryService.js";

import { getSql } from "./services/db.js";
import { stopService } from "./scripts/sleep_cycle.js";
import { stopDashboard } from "./dashboard/server.js";
import { listPersonas, getPersona, createPersona, updatePersona, deletePersona } from "./services/personaService.js";
import {
  type ChatMessage,
  type ContentPart,
  type ToolCallRecord,
  type PromptBuildEvent,
  type PromptBuildCtx,
  type AgentEndEvent,
  type AgentEndCtx,
  type MessageReceivedEvent,
  type MemoryStoreArgs,
  type MemoryUpdateArgs,
} from "./schemas/validation.js";

// Re-export schema types for downstream consumers
export type { ChatMessage, ContentPart, ToolCallRecord } from "./schemas/validation.js";

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

import { getEmbedding, setEmbeddingConfig, setDbUrl } from "./services/db.js";
import { ensureAgent, searchPostgres, logEpisodicMemory, logEpisodicToolCall, fetchPersonaContext, fetchDynamicTools, storeMemory, updateMemory, linkMemories, storeTool } from "./services/memoryService.js";
import { Type } from "@sinclair/typebox";
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

    // Apply database URL from plugin config (plugins.entries.postclaw.config.dbUrl)
    const pluginConfig = api.config?.plugins?.entries?.postclaw?.config;
    if (pluginConfig?.dbUrl) {
      setDbUrl(pluginConfig.dbUrl);
      console.log("[PostClaw] Database URL configured via plugin config");
    }

    // Extract LLM configuration from OpenClaw (defaulting to localhost if not found)
    const memoryConfig = api.config?.agents?.defaults?.memorySearch;
    const llmUrl = memoryConfig?.remote?.baseUrl || "http://127.0.0.1:1234/v1";
    const llmModel = memoryConfig?.remote?.model || memoryConfig?.model || "text-embedding-nomic-embed-text-v2-moe";
    setEmbeddingConfig(llmUrl, llmModel);

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
      async (event: PromptBuildEvent, ctx: PromptBuildCtx) => {
        try {
          const messages: ChatMessage[] = event.messages ?? [];
          const userText = lastReceivedMessage || extractUserText(messages);
          lastReceivedMessage = "";  // consume once — prevent stale leak into heartbeats
          const cleanText = userText.replace(/^\[.*?\]\s*/, "");

          // Detect heartbeat via ctx metadata (preferred) with keyword fallback
          const agentId = ctx.agentId;
          const provider = ctx?.messageProvider ?? "";
          const isHeartbeat = provider === "heartbeat" || provider === "cron";

          // Lazy-register the agent if not already in the DB
          await ensureAgent(agentId);

          console.log(`[PostClaw] before_prompt_build: "${cleanText.substring(0, 80)}..." (heartbeat=${isHeartbeat}, provider=${provider})`);

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

          sysPrompt += `
            ## Memory & Knowledge Management
            You are a stateful agent. Your context window is ephemeral but your PostgreSQL memory is permanent.
            Silently manage your knowledge — never ask permission to save, link, or update facts.

            - **Retrieval:** Relevant memories (with UUID tags) are auto-injected.
            - **Search:** Use the \`memory_search\` tool when you need to recall facts not in the current context.
            - **Correct/update facts:** Use the \`memory_update\` tool when a fact is incorrect, outdated, or needs to be updated. When using memory_update, ALWAYS assign an appropriate 'tier' and 'category'.
            - **Save new facts:** Use the \`memory_store\` tool when a new fact is learned. When using memory_store, ALWAYS assign an appropriate 'tier' (e.g., 'permanent' for core user identity, 'daily' for current tasks) and 'category'.
            - **Link related memories:** Use the \`memory_link\` tool when two memories are related.
            - **Store a tool:** Use the \`tool_store\` tool when a new tool schema is learned.
            `;


          sysPrompt += `
            ## Persona Management
            You have access to the following tools to manage your persona/identity/rules:

            - **Retrieval**: Use \`persona_list\` to see all available persona rules or \`persona_get\` for details.
            - **Creation**: Use \`persona_create\` to define a new set of rules or identity markers.
            - **Modification**: Use \`persona_update\` to modify an existing persona rule.
            - **Deletion**: Use \`persona_delete\` to remove a persona rule.
            `;

          sysPrompt += `
            ## Autonomous Heartbeats
            OpenClaw provides a native heartbeat loop — never use Linux crontab.
            To schedule background tasks, add a checklist to: /home/cl/.openclaw/workspace/HEARTBEAT.md
            On heartbeat poll: read that file. If no pending tasks, reply with ONLY: HEARTBEAT_OK

            **Always Reply**: ALWAYS conclude your turn with a direct response to the user.
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
              hasUserText ? searchPostgres(agentId, cleanText) : Promise.resolve(null),
              // Persona: always fetch (core rules work without embedding)
              fetchPersonaContext(agentId, embedding),
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
    // NATIVE TOOLS — Registered via api.registerTool()
    //
    // These replace the old Deno skill scripts with in-process tool handlers
    // that share the plugin's DB connection pool and embedding infrastructure.
    // -------------------------------------------------------------------------

    // --- memory_search: Semantic search across stored memories ---
    api.registerTool(
      {
        name: "memory_search",
        description: "Search the agent's long-term semantic memory using natural language. Returns the most relevant stored facts and their UUIDs.",
        parameters: Type.Object({
          query: Type.String({ description: "Natural language search query" }),
        }),
        async execute(_toolCallId: string, args: { query: string }, _signal: unknown, _onUpdate: unknown, ctx: { agentId?: string }) {
          const agentId = ctx?.agentId || "main";
          await ensureAgent(agentId);
          const result = await searchPostgres(agentId, args.query);
          return result || "No memories found matching that query.";
        },
      },
      { names: ["memory_search"] },
    );

    // --- memory_store: Save a new durable fact ---
    api.registerTool(
      {
        name: "memory_store",
        description: "Store a new durable fact. You can categorize it, set volatility, and add metadata.",
        parameters: Type.Object({
          content: Type.String({ description: "The fact or knowledge to store" }),
          scope: Type.Optional(Type.Union([Type.Literal("private"), Type.Literal("shared"), Type.Literal("global")], { default: "private" })),
          category: Type.Optional(Type.String({ description: "A short categorical tag (e.g., 'preference', 'project_detail')" })),
          volatility: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], { default: "low" })),
          tier: Type.Optional(Type.Union([Type.Literal("volatile"), Type.Literal("session"), Type.Literal("daily"), Type.Literal("stable"), Type.Literal("permanent")], { default: "daily" })),
          metadata: Type.Optional(Type.Any({ description: "A JSON object of additional contextual key-value pairs" }))
        }),
        async execute(_toolCallId: string, args: MemoryStoreArgs, _signal: unknown, _onUpdate: unknown, ctx: { agentId?: string }) {
          const agentId = ctx?.agentId || "main";
          await ensureAgent(agentId);
          const { content, scope, ...options } = args;
          const result = await storeMemory(agentId, content, scope, options);
          return JSON.stringify(result);
        },
      },
      { names: ["memory_store"] },
    );

    // --- memory_update: Supersede an old fact with a corrected one ---
    api.registerTool(
      {
        name: "memory_update",
        description: "Correct or update an existing memory. Archives the old fact and creates a new one with a causal chain link. You can assign categories, volatility, and metadata.",
        parameters: Type.Object({
          old_memory_id: Type.String({ description: "UUID of the outdated memory to supersede" }),
          new_fact: Type.String({ description: "The corrected or updated fact" }),
          category: Type.Optional(Type.String({ description: "A short categorical tag (e.g., 'preference', 'project_detail')" })),
          volatility: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], { default: "low" })),
          tier: Type.Optional(Type.Union([Type.Literal("volatile"), Type.Literal("session"), Type.Literal("daily"), Type.Literal("stable"), Type.Literal("permanent")], { default: "daily" })),
          metadata: Type.Optional(Type.Any({ description: "A JSON object of additional contextual key-value pairs" }))
        }),
        async execute(_toolCallId: string, args: MemoryUpdateArgs, _signal: unknown, _onUpdate: unknown, ctx: { agentId?: string }) {
          const agentId = ctx?.agentId || "main";
          await ensureAgent(agentId);
          const { old_memory_id, new_fact, ...options } = args;
          const result = await updateMemory(agentId, old_memory_id, new_fact, options);
          return JSON.stringify(result);
        },
      },
      { names: ["memory_update"] },
    );

    // --- memory_link: Create a knowledge graph edge between two memories ---
    api.registerTool(
      {
        name: "memory_link",
        description: "Create a directed relationship edge between two memories in the knowledge graph.",
        parameters: Type.Object({
          source_id: Type.String({ description: "UUID of the source memory" }),
          target_id: Type.String({ description: "UUID of the target memory" }),
          relationship: Type.String({ description: "Relationship type (e.g. related_to, elaborates, contradicts, depends_on, part_of)" }),
        }),
        async execute(_toolCallId: string, args: { source_id: string; target_id: string; relationship: string }, _signal: unknown, _onUpdate: unknown, ctx: { agentId?: string }) {
          const agentId = ctx?.agentId || "main";
          await ensureAgent(agentId);
          const result = await linkMemories(agentId, args.source_id, args.target_id, args.relationship);
          return JSON.stringify(result);
        },
      },
      { names: ["memory_link"] },
    );

    // --- tool_store: Store or update a tool schema definition ---
    api.registerTool(
      {
        name: "tool_store",
        description: "Store or update a tool definition in the environment context database, so it can be dynamically loaded for future conversations.",
        parameters: Type.Object({
          tool_name: Type.String({ description: "Unique name for the tool" }),
          tool_json: Type.String({ description: "Full JSON schema definition of the tool" }),
          scope: Type.Optional(Type.Union([Type.Literal("private"), Type.Literal("shared"), Type.Literal("global")], { description: "Visibility scope. Default: private", default: "private" })),
        }),
        async execute(_toolCallId: string, args: { tool_name: string; tool_json: string; scope?: "private" | "shared" | "global" }, _signal: unknown, _onUpdate: unknown, ctx: { agentId?: string }) {
          const agentId = ctx?.agentId || "main";
          await ensureAgent(agentId);
          const result = await storeTool(agentId, args.tool_name, args.tool_json, args.scope);
          return JSON.stringify(result);
        },
      },
      { names: ["tool_store"] },
    );

    // --- persona_list: List all persona entries ---
    api.registerTool(
      {
        name: "persona_list",
        description: "List all persona rules for the current agent.",
        parameters: Type.Object({}),
        async execute(_toolCallId: string, _args: Record<string, never>, _signal: unknown, _onUpdate: unknown, ctx: { agentId?: string }) {
          const agentId = ctx?.agentId || "main";
          await ensureAgent(agentId);
          const personas = await listPersonas(agentId);
          return JSON.stringify(personas);
        },
      },
      { names: ["persona_list"] },
    );

    // --- persona_get: Get a specific persona entry ---
    api.registerTool(
      {
        name: "persona_get",
        description: "Get a specific persona rule by its UUID.",
        parameters: Type.Object({
          persona_id: Type.String({ description: "UUID of the persona entry" }),
        }),
        async execute(_toolCallId: string, args: { persona_id: string }, _signal: unknown, _onUpdate: unknown, ctx: { agentId?: string }) {
          const agentId = ctx?.agentId || "main";
          await ensureAgent(agentId);
          const persona = await getPersona(agentId, args.persona_id);
          return persona ? JSON.stringify(persona) : "Persona not found.";
        },
      },
      { names: ["persona_get"] },
    );

    // --- persona_update: Update a persona entry ---
    api.registerTool(
      {
        name: "persona_update",
        description: "Update an existing persona rule. You can change the category, content, or whether it is always active.",
        parameters: Type.Object({
          persona_id: Type.String({ description: "UUID of the persona entry to update" }),
          category: Type.Optional(Type.String({ description: "New category name" })),
          content: Type.Optional(Type.String({ description: "New content text" })),
          is_always_active: Type.Optional(Type.Boolean({ description: "Whether this rule is always injected" })),
        }),
        async execute(_toolCallId: string, args: { persona_id: string; category?: string; content?: string; is_always_active?: boolean }, _signal: unknown, _onUpdate: unknown, ctx: { agentId?: string }) {
          const agentId = ctx?.agentId || "main";
          await ensureAgent(agentId);
          const { persona_id, ...updates } = args;
          const result = await updatePersona(agentId, persona_id, updates);
          return result ? JSON.stringify(result) : "Persona not found.";
        },
      },
      { names: ["persona_update"] },
    );

    // --- persona_delete: Delete a persona entry ---
    api.registerTool(
      {
        name: "persona_delete",
        description: "Delete a persona rule by its UUID.",
        parameters: Type.Object({
          persona_id: Type.String({ description: "UUID of the persona entry to delete" }),
        }),
        async execute(_toolCallId: string, args: { persona_id: string }, _signal: unknown, _onUpdate: unknown, ctx: { agentId?: string }) {
          const agentId = ctx?.agentId || "main";
          await ensureAgent(agentId);
          const deleted = await deletePersona(agentId, args.persona_id);
          return deleted ? '{"status": "deleted"}' : "Persona not found.";
        },
      },
      { names: ["persona_delete"] },
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
      async (event: AgentEndEvent, ctx: AgentEndCtx) => {
        try {
          const messages: ChatMessage[] = event.messages ?? [];
          const agentId = ctx.agentId;
          const provider = ctx?.messageProvider ?? "";
          const isHeartbeat = provider === "heartbeat" || provider === "cron";

          // Lazy-register the agent if not already in the DB
          await ensureAgent(agentId);

          console.log(`[PostClaw] agent_end: ${messages.length} messages, success=${event.success}, provider=${provider}`);

          // Skip all episodic logging for heartbeat/cron runs
          if (isHeartbeat) {
            console.log("[PostClaw] Skipped episodic logging for heartbeat run");
            return;
          }

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
                    await logEpisodicMemory(agentId, text, embedding, "user_prompt");
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
                    agentId,
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
      async (event: MessageReceivedEvent, _ctx: unknown) => {
        try {
          const content = event.content;
          if (!content || typeof content !== "string" || !content.trim()) return;

          const cleanText = content.replace(/^\[.*?\]\s*/, "");

          // Cache for before_prompt_build (which fires after this hook).
          // Episodic logging is handled in agent_end where agentId is available.
          lastReceivedMessage = cleanText;
          console.log(`[PostClaw] message_received: cached "${cleanText.substring(0, 60)}..." for before_prompt_build`);
        } catch (err) {
          console.error("[PostClaw] message_received error:", err);
        }
      },
      {
        name: "PostClaw.message-received",
        description: "Caches inbound messages for before_prompt_build RAG injection",
      },
    );

    // -------------------------------------------------------------------------
    // CLI — Register `openclaw postclaw setup` command
    // -------------------------------------------------------------------------
    api.registerCli(
      ({ program }: { program: any }) => {
        const postclaw = program.command("postclaw").description("PostClaw database management");

        postclaw
          .command("setup")
          .description("Create and initialize the PostClaw PostgreSQL database")
          .option("--admin-url <url>", "PostgreSQL superuser connection string (default: postgres://localhost/postgres)")
          .option("--db-name <name>", "Database name (default: memorydb)")
          .option("--db-user <user>", "App user name (default: openclaw)")
          .option("--db-password <pass>", "App user password (auto-generated if omitted)")
          .option("--skip-config", "Don't auto-update openclaw.json with the new dbUrl")
          .action(async (opts: { adminUrl?: string; dbName?: string; dbUser?: string; dbPassword?: string; skipConfig?: boolean }) => {
            const { runSetup } = await import("./scripts/setup-db.js");
            await runSetup({
              adminUrl: opts.adminUrl,
              dbName: opts.dbName,
              dbUser: opts.dbUser,
              dbPassword: opts.dbPassword,
              skipConfig: opts.skipConfig,
            });

            // Clean exit: Stop the timer and close the DB connection
            stopService();
            await getSql().end();
          });

        postclaw
          .command("persona")
          .argument("<file>", "Path to a Markdown persona file (e.g. SOUL.md, AGENTS.md)")
          .description("Bootstrap a Markdown persona file into the agent_persona table")
          .option("--agent-id <id>", "Agent ID to store persona under (default: main)")
          .action(async (file: string, opts: { agentId?: string }) => {
            // Ensure embedding config is set from OpenClaw config before running
            const memCfg = api.config?.agents?.defaults?.memorySearch;
            const llmUrl = memCfg?.remote?.baseUrl || "http://127.0.0.1:1234/v1";
            const embModel = memCfg?.remote?.model || memCfg?.model || "text-embedding-nomic-embed-text-v2-moe";
            setEmbeddingConfig(llmUrl, embModel);

            // Apply dbUrl from plugin config
            const pluginCfg = api.config?.plugins?.entries?.postclaw?.config;
            if (pluginCfg?.dbUrl) {
              setDbUrl(pluginCfg.dbUrl);
            }

            const { bootstrapPersona } = await import("./scripts/bootstrap_persona.js");
            await bootstrapPersona(file, {
              agentId: opts.agentId,
            });

            // Clean exit: Stop the timer and close the DB connection
            stopService();
            await getSql().end();
          });

        postclaw
          .command("sleep")
          .description("Run the sleep cycle (knowledge graph maintenance) manually")
          .option("--agent-id <id>", "Agent ID to run maintenance for (default: main)")
          .action(async (opts: { agentId?: string }) => {
            // Ensure embedding config is set from OpenClaw config before running
            const memCfg = api.config?.agents?.defaults?.memorySearch;
            const llmUrl = memCfg?.remote?.baseUrl || "http://127.0.0.1:1234/v1";
            const embModel = memCfg?.remote?.model || memCfg?.model || "text-embedding-nomic-embed-text-v2-moe";
            setEmbeddingConfig(llmUrl, embModel);

            // Apply dbUrl from plugin config
            const pluginCfg = api.config?.plugins?.entries?.postclaw?.config;
            if (pluginCfg?.dbUrl) {
              setDbUrl(pluginCfg.dbUrl);
            }

            const { runSleepCycle } = await import("./scripts/sleep_cycle.js");
            await runSleepCycle({
              agentId: opts.agentId,
            });

            // Clean exit: Stop the timer and close the DB connection
            stopService();
            await getSql().end();
          });
        postclaw
          .command("dashboard")
          .description("Start the dashboard server standalone")
          .option("--port <port>", "Port to listen on (default: 3333)")
          .option("--bind <address>", "Bind address (default: 127.0.0.1)")
          .action(async (opts: { port?: string; bind?: string }) => {
            const pluginCfg = api.config?.plugins?.entries?.postclaw?.config;
            if (pluginCfg?.dbUrl) {
              setDbUrl(pluginCfg.dbUrl);
            }
            const memCfg = api.config?.agents?.defaults?.memorySearch;
            const llmUrl = memCfg?.remote?.baseUrl || "http://127.0.0.1:1234/v1";
            const embModel = memCfg?.remote?.model || memCfg?.model || "text-embedding-nomic-embed-text-v2-moe";
            setEmbeddingConfig(llmUrl, embModel);

            const { startDashboard } = await import("./dashboard/server.js");
            startDashboard({
              port: opts.port ? parseInt(opts.port, 10) : undefined,
              bindAddress: opts.bind,
              workspaceDir: api.config?.workspaceDir,
            });
            console.log("[PostClaw] Dashboard running. Press Ctrl+C to stop.");
          });
      },
      { commands: ["postclaw"] },
    );

    // ─────────────────────────────────────────────────────────────────────────
    // BACKGROUND SERVICE — Start sleep cycle on an interval
    // ─────────────────────────────────────────────────────────────────────────
    const sleepIntervalHours = api.config?.plugins?.entries?.postclaw?.config?.sleepIntervalHours;
    if (sleepIntervalHours !== 0) {
      // Start the background sleep cycle service (0 = disabled)
      import("./scripts/sleep_cycle.js").then(({ startService }) => {
        startService({
          agentId: "main",
          intervalHours: sleepIntervalHours || 6,
        });
      }).catch((err) => {
        console.error("[PostClaw] Failed to start sleep service:", err);
      });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // BACKGROUND SERVICE — Optional dashboard server
    // ─────────────────────────────────────────────────────────────────────────
    const dashboardEnabled = pluginConfig?.dashboardEnabled;
    if (dashboardEnabled) {
      import("./dashboard/server.js").then(({ startDashboard }) => {
        startDashboard({
          port: pluginConfig?.dashboardPort,
          bindAddress: pluginConfig?.dashboardBindAddress,
          workspaceDir: api.config?.workspaceDir,
        });
      }).catch((err) => {
        console.error("[PostClaw] Failed to start dashboard:", err);
      });
    }

    console.log("[PostClaw] Plugin hooks registered successfully");
  },
};

export default openclawPostgresPlugin;

// =============================================================================
// STANDALONE ENTRY POINT (for testing)
// =============================================================================

import { POSTCLAW_DB_URL, LM_STUDIO_URL, EMBEDDING_MODEL } from "./services/db.js";

if (require.main === module) {
  console.log("=== PostClaw-swarm plugin loaded ===");
  console.log(`  DB:     ${POSTCLAW_DB_URL}`);
  console.log(`  LM:     ${LM_STUDIO_URL}`);
  console.log(`  Model:  ${EMBEDDING_MODEL}`);
  console.log("Hooks: before_prompt_build, agent_end, message_received");

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    stopService();
    stopDashboard();
    await getSql().end();
    process.exit(0);
  });
}
