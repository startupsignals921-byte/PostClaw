// =============================================================================
// RE-EXPORTS — Single entry point for downstream consumers
// =============================================================================

export { getSql, LM_STUDIO_URL, POSTCLAW_DB_URL, EMBEDDING_MODEL, getEmbedding, hashContent, setEmbeddingConfig, setDbUrl, validateEmbeddingDimension } from "./services/db.js";
export { ensureAgent, searchPostgres, logEpisodicMemory, logEpisodicToolCall, fetchPersonaContext, storeMemory, updateMemory, linkMemories } from "./services/memoryService.js";
export { listPersonas, getPersona, createPersona, updatePersona, deletePersona } from "./services/personaService.js";

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

import { getCurrentConfig, loadConfig } from "./services/config.js";

function isDuplicate(key: string): boolean {
  const maxCacheSize = getCurrentConfig().dedup.maxCacheSize;
  if (processedEvents.has(key)) return true;
  processedEvents.add(key);
  if (processedEvents.size > maxCacheSize) processedEvents.clear();
  return false;
}
let lastReceivedMessage: string = "";

// =============================================================================
// HELPERS
// =============================================================================

import { getEmbedding, setEmbeddingConfig, setDbUrl } from "./services/db.js";
import { ensureAgent, searchPostgres, logEpisodicMemory, logEpisodicToolCall, fetchPersonaContext, storeMemory, updateMemory, linkMemories } from "./services/memoryService.js";
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
    const debugLogging = pluginConfig?.debugLogging === true;
    const debugLog = (...args: any[]) => {
      if (debugLogging) console.log("[PostClaw DEBUG]", ...args);
    };

    if (pluginConfig?.dbUrl) {
      setDbUrl(pluginConfig.dbUrl);
      console.log("[PostClaw] Database URL configured via plugin config");
    }

    // Extract LLM configuration from OpenClaw (defaulting to localhost if not found)
    const memoryConfig = api.config?.agents?.defaults?.memorySearch;
    const llmUrl = memoryConfig?.remote?.baseUrl || "http://127.0.0.1:1234/v1";
    const llmModel = memoryConfig?.remote?.model || memoryConfig?.model || "text-embedding-nomic-embed-text-v2-moe";
    setEmbeddingConfig(llmUrl, llmModel);

    const agentId = "main";
    const workspaceDir = api.config?.workspaceDir;
    ensureAgent(agentId, workspaceDir).then(() => {
      loadConfig(agentId).then(() => {
        console.log("[PostClaw] Configuration loaded successfully");
        // Verify that the configured embedding model dimensions match the schema
        import("./services/db.js").then(({ validateEmbeddingDimension }) => {
          validateEmbeddingDimension(agentId).catch((err) => {
             console.error("[PostClaw] Failed initial embedding validation check:", err);
          });
        });
      });
    });

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
          debugLog("before_prompt_build event:", JSON.stringify(event, null, 2));
          debugLog("before_prompt_build ctx:", JSON.stringify(ctx, null, 2));

          const messages: ChatMessage[] = event.messages ?? [];
          const userText = lastReceivedMessage || extractUserText(messages);
          lastReceivedMessage = "";  // consume once — prevent stale leak into heartbeats
          const cleanText = userText.replace(/^\[.*?\]\s*/, "");

          // Detect heartbeat via ctx metadata (preferred) with keyword fallback
          const agentId = ctx.agentId;
          const provider = ctx?.messageProvider ?? "";
          const isHeartbeat = provider === "heartbeat" || provider === "cron";

          // Lazy-register the agent if not already in the DB
          await ensureAgent(agentId, ctx.workspaceDir);

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
          const config = await loadConfig(agentId);

          for (const [key, promptValue] of Object.entries(config.prompts)) {
            // Special case for heartbeat
            if (key === 'heartbeatRules') {
              const heartbeatPrompt = promptValue.replace("{{heartbeatFilePath}}", config.prompts.heartbeatFilePath || "/home/cl/.openclaw/workspace/HEARTBEAT.md");
              sysPrompt += `\n\n${heartbeatPrompt}\n`;
            } else if (key !== 'heartbeatFilePath') {
              sysPrompt += `\n\n${promptValue}\n`;
            }
          }

          // ==================================================================
          // STEP 3: Fetch persona + RAG context from Postgres (in parallel)
          // ==================================================================
          const result: { systemPrompt?: string; prependContext?: string } = {};

          if (!isHeartbeat) {
            const hasUserText = cleanText.trim().length > 0;
            const embedding = hasUserText ? await getEmbedding(cleanText) : null;

            const [memoryContext, personaContext] = await Promise.all([
              // RAG: only when we have user text to search against
              hasUserText ? searchPostgres(agentId, cleanText, {
                semanticLimit: config.rag.semanticLimit,
                linkedSimilarity: config.rag.linkedSimilarity,
                totalLimit: config.rag.totalLimit,
                trackAs: "injection"
              }) : Promise.resolve(null),
              // Persona: always fetch (core rules work without embedding)
              fetchPersonaContext(agentId, embedding, {
                situationalLimit: config.persona.situationalLimit
              }),
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
        description: `Search the agent's long-term semantic memory using natural language. Returns the most relevant stored facts with their UUIDs and metadata.

Each result includes: id (UUID), content, category, tier (permanent/stable/daily/session/volatile), volatility (low/medium/high), confidence (0.0–1.0), usefulness_score, access_count, injection_count, is_pointer, is_archived, metadata (JSON), created_at, updated_at, and expires_at.

Results also include graph-linked memories discovered via multi-hop traversal of the entity_edges knowledge graph. Linked results include persona↔memory cross-links.`,
        parameters: Type.Object({
          query: Type.String({ description: "Natural language search query. Be specific — this drives vector cosine similarity matching against stored memory embeddings." }),
        }),
        async execute(_toolCallId: string, args: { query: string }, _signal: unknown, _onUpdate: unknown, ctx?: any) {
          const agentId = toolCallIdToAgentId.get(_toolCallId) || ctx?.agentId || "main";
          debugLog("memory_search mapped agentId:", agentId);
          await ensureAgent(agentId, ctx?.workspaceDir);
          const config = getCurrentConfig();
          const result = await searchPostgres(agentId, args.query, {
            semanticLimit: config.rag.semanticLimit,
            linkedSimilarity: config.rag.linkedSimilarity,
            totalLimit: config.rag.totalLimit
          });
          return result || "No memories found matching that query.";
        },
      },
      { names: ["memory_search"] },
    );

    // --- memory_store: Save a new durable fact ---
    api.registerTool(
      {
        name: "memory_store",
        description: `Store a new durable fact in the semantic memory database. Each memory is embedded as a vector for similarity search and can be linked in the knowledge graph.

Columns you control:
- content: The fact text (required). Will be embedded for vector search.
- category: Short tag for grouping (e.g. 'preference', 'project_detail', 'family_details', 'technical', 'behavioral_rule'). Used for filtering.
- tier: Permanence level. 'permanent' = never auto-archived. 'stable' = protected from low-value cleanup. 'daily' = standard. 'session' = current session only. 'volatile' = may be cleaned up quickly.
- volatility: Expected change rate. 'low' = stable facts (names, dates). 'medium' = may change (preferences, statuses). 'high' = frequently changing (moods, temporary states). Affects sleep cycle scoring.
- metadata: JSON object for additional context (e.g. {"source": "user_stated", "topic": "birthday"}).
- confidence: Your confidence in the fact (0.0 to 1.0). Default is 0.5.
- usefulness_score: How useful this fact is for future inference. Default is 0.0.
- expires_at: For volatile or session-tied facts, the ISO timestamp when it should be archived.
- scope: The access scope: 'private' (this agent only), 'shared' (accessible by some other agents in the same circle), or 'global' (accessible by all agents on the system).

Auto-managed columns (do not set): access_count, injection_count, is_pointer, content_hash, embedding, token_count.`,
        parameters: Type.Object({
          content: Type.String({ description: "The fact or knowledge to store. Should be a clear, self-contained statement." }),
          scope: Type.Optional(Type.Union([Type.Literal("private"), Type.Literal("shared"), Type.Literal("global")], { default: "private", description: "Who can access this memory. Use 'private' for agent-specific data, 'shared' for circle data, or 'global' for facts all agents should know." })),
          category: Type.Optional(Type.String({ description: "Short categorical tag for grouping and filtering (e.g. 'preference', 'project_detail'). Memories without categories are harder to filter." })),
          source_uri: Type.Optional(Type.String({ description: "Optional URL or resource URI to trace the origin of the memory." })),
          volatility: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], { default: "low", description: "Expected change rate for facts: 'low' for stable, 'high' for temporary state." })),
          is_pointer: Type.Optional(Type.Boolean({ description: "Whether this memory is merely a soft pointer to external knowledge. Defaults to false." })),
          embedding_model: Type.Optional(Type.String({ description: "Optional override for the model used to embed this semantic value." })),
          tier: Type.Optional(Type.Union([Type.Literal("volatile"), Type.Literal("session"), Type.Literal("daily"), Type.Literal("stable"), Type.Literal("permanent")], { default: "daily", description: "Permanence level. 'permanent' and 'stable' are protected from automatic archival." })),
          confidence: Type.Optional(Type.Number({ description: "Your confidence in the fact (0.0 to 1.0). Default is 0.5." })),
          usefulness_score: Type.Optional(Type.Number({ description: "Tracker for inference usefulness. Default is 0.0." })),
          injection_count: Type.Optional(Type.Integer({ description: "Override auto-tracked injection count." })),
          access_count: Type.Optional(Type.Integer({ description: "Override auto-tracked access count." })),
          last_injected_at: Type.Optional(Type.String({ description: "Timestamp of last injection (ISO string)." })),
          last_accessed_at: Type.Optional(Type.String({ description: "Timestamp of last access (ISO string)." })),
          expires_at: Type.Optional(Type.String({ description: "Optional expiration timestamp (ISO string) for volatile memories." })),
          created_at: Type.Optional(Type.String({ description: "Timestamp of creation (ISO string)." })),
          updated_at: Type.Optional(Type.String({ description: "Timestamp of last update (ISO string)." })),
          is_archived: Type.Optional(Type.Boolean({ description: "Whether the memory is considered archived/inactive. Defaults to false." })),
          superseded_by: Type.Optional(Type.String({ description: "UUID pointer to a memory replacing this one." })),
          metadata: Type.Optional(Type.Any({ description: "JSON object of additional context (e.g. {source: 'user_stated', topic: 'birthday', related_to: 'family'}). Stored as JSONB for flexible querying." }))
        }),
        async execute(_toolCallId: string, args: MemoryStoreArgs, _signal: unknown, _onUpdate: unknown, ctx?: any) {
          debugLog("memory_store args:", JSON.stringify(args, null, 2));
          debugLog("memory_store ctx (from execute params):", JSON.stringify(ctx, null, 2));
          const agentId = toolCallIdToAgentId.get(_toolCallId) || ctx?.agentId || "main";
          debugLog("memory_store mapped agentId:", agentId);
          await ensureAgent(agentId, ctx?.workspaceDir);
          const { content, scope, ...options } = args;
          const result = await storeMemory(agentId, content, scope, options as any);
          return JSON.stringify(result);
        },
      },
      { names: ["memory_store"] },
    );

    // --- memory_update: Supersede an old fact with a corrected one ---
    api.registerTool(
      {
        name: "memory_update",
        description: `Correct or update an existing memory. Archives the old fact (sets is_archived=true, superseded_by=new_id) and creates a fresh memory with the corrected content, preserving the causal chain.

The new memory inherits nothing from the old one — you must re-specify category, tier, volatility, metadata, and scope. The old memory remains searchable if you query archived content but won't appear in normal retrieval.

Columns you can modify:
- new_fact: The new corrected fact.
- scope: The access scope: 'private' (this agent only), 'shared', or 'global' (accessible by all agents).
- category: Short tag for grouping (e.g. 'preference', 'project_detail').
- tier: Permanence level. 'permanent' = never auto-archived. 'stable' = protected from low-value cleanup. 'daily' = standard. 'session' = current session. 'volatile' = quickly cleaned.
- volatility: Expected change rate. 'low' = stable facts, 'medium' = may change, 'high' = expected to change quickly.
- metadata: JSON object for additional context.
- confidence: Your confidence in the fact (0.0 to 1.0). Default is 0.5.
- usefulness_score: How useful this fact is for future inference. Default is 0.0.
- expires_at: For volatile or session-tied facts, the ISO timestamp when it should be archived.

Use this instead of memory_store when you know the UUID of the outdated fact.`,
        parameters: Type.Object({
          old_memory_id: Type.String({ description: "UUID of the outdated memory to supersede. This memory will be archived and linked via superseded_by." }),
          new_fact: Type.String({ description: "The corrected or updated fact. Will be re-embedded for vector search." }),
          scope: Type.Optional(Type.Union([Type.Literal("private"), Type.Literal("shared"), Type.Literal("global")], { default: "private", description: "Who can access this memory. Use 'private' for agent-specific data, 'shared' for circle data, or 'global' for facts all agents should know." })),
          category: Type.Optional(Type.String({ description: "Category for the new memory (e.g. 'preference', 'project_detail'). Does NOT carry over from old memory." })),
          source_uri: Type.Optional(Type.String({ description: "Optional URL or resource URI to trace the origin of the memory." })),
          volatility: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], { default: "low", description: "Expected change rate for facts: 'low' for stable, 'high' for temporary state." })),
          is_pointer: Type.Optional(Type.Boolean({ description: "Whether this memory is merely a soft pointer to external knowledge. Defaults to false." })),
          embedding_model: Type.Optional(Type.String({ description: "Optional override for the model used to embed this semantic value." })),
          tier: Type.Optional(Type.Union([Type.Literal("volatile"), Type.Literal("session"), Type.Literal("daily"), Type.Literal("stable"), Type.Literal("permanent")], { default: "daily", description: "Permanence level for the new memory. Set to 'permanent' for core facts that should never be auto-archived." })),
          confidence: Type.Optional(Type.Number({ description: "Your confidence in the fact (0.0 to 1.0). Default is 0.5." })),
          usefulness_score: Type.Optional(Type.Number({ description: "Tracker for inference usefulness. Default is 0.0." })),
          injection_count: Type.Optional(Type.Integer({ description: "Override auto-tracked injection count." })),
          access_count: Type.Optional(Type.Integer({ description: "Override auto-tracked access count." })),
          last_injected_at: Type.Optional(Type.String({ description: "Timestamp of last injection (ISO string)." })),
          last_accessed_at: Type.Optional(Type.String({ description: "Timestamp of last access (ISO string)." })),
          expires_at: Type.Optional(Type.String({ description: "Optional expiration timestamp (ISO string) for volatile memories." })),
          created_at: Type.Optional(Type.String({ description: "Timestamp of creation (ISO string)." })),
          updated_at: Type.Optional(Type.String({ description: "Timestamp of last update (ISO string)." })),
          is_archived: Type.Optional(Type.Boolean({ description: "Whether the memory is considered archived/inactive. Defaults to false." })),
          superseded_by: Type.Optional(Type.String({ description: "UUID pointer to a memory replacing this one." })),
          metadata: Type.Optional(Type.Any({ description: "JSON metadata for the new memory. Does NOT carry over from old memory." }))
        }),
        async execute(_toolCallId: string, args: MemoryUpdateArgs, _signal: unknown, _onUpdate: unknown, ctx?: any) {
          debugLog("memory_update args:", JSON.stringify(args, null, 2));
          const agentId = toolCallIdToAgentId.get(_toolCallId) || ctx?.agentId || "main";
          debugLog("memory_update mapped agentId:", agentId);
          await ensureAgent(agentId, ctx?.workspaceDir);
          const { old_memory_id, new_fact, scope, ...options } = args;
          const result = await updateMemory(agentId, old_memory_id, new_fact, scope, options as any);
          return JSON.stringify(result);
        },
      },
      { names: ["memory_update"] },
    );

    // --- memory_link: Create a knowledge graph edge between two memories ---
    api.registerTool(
      {
        name: "memory_link",
        description: `Create a directed relationship edge between two nodes in the knowledge graph (entity_edges table). Links can connect memory↔memory or persona↔memory. Linked memories are discovered during RAG retrieval via multi-hop graph traversal.

Relationship types: 'related_to' (general topical), 'elaborates' (B adds detail to A), 'contradicts' (B conflicts with A), 'depends_on' (B needs A), 'part_of' (B is subset of A), 'defines' (A defines context for B, typically persona→memory), 'supports' (B provides evidence for A).

The edge weight defaults to 1.0. Edges are also auto-discovered during the sleep cycle, but you should create them immediately when the relationship is obvious.`,
        parameters: Type.Object({
          source_id: Type.String({ description: "UUID of the source node (memory or persona trait)" }),
          target_id: Type.String({ description: "UUID of the target node (memory or persona trait)" }),
          relationship: Type.String({ description: "Relationship type: 'related_to', 'elaborates', 'contradicts', 'depends_on', 'part_of', 'defines', or 'supports'" }),
        }),
        async execute(_toolCallId: string, args: { source_id: string; target_id: string; relationship: string }, _signal: unknown, _onUpdate: unknown, ctx?: any) {
          debugLog("memory_link args:", JSON.stringify(args, null, 2));
          const agentId = toolCallIdToAgentId.get(_toolCallId) || ctx?.agentId || "main";
          debugLog("memory_link mapped agentId:", agentId);
          await ensureAgent(agentId, ctx?.workspaceDir);
          const result = await linkMemories(agentId, args.source_id, args.target_id, args.relationship);
          return JSON.stringify(result);
        },
      },
      { names: ["memory_link"] },
    );

    // --- persona_list: List all persona entries ---
    api.registerTool(
      {
        name: "persona_list",
        description: `List all persona traits for the current agent from the agent_persona table.

Each entry includes: id (UUID), category (unique per agent, e.g. 'core_identity', 'communication_style'), content (the rule text), is_always_active (whether injected into every prompt), embedding (vector for situational matching), and created_at.

Persona traits tagged is_always_active=true are always in the system prompt. Others are selected by cosine similarity to the current user message.`,
        parameters: Type.Object({}),
        async execute(_toolCallId: string, _args: Record<string, never>, _signal: unknown, _onUpdate: unknown, ctx?: any) {
          const agentId = toolCallIdToAgentId.get(_toolCallId) || ctx?.agentId || "main";
          debugLog("persona_list mapped agentId:", agentId);
          await ensureAgent(agentId, ctx?.workspaceDir);
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
        description: "Get a specific persona trait by its UUID. Returns the full record: id, category, content, is_always_active, embedding, and created_at.",
        parameters: Type.Object({
          persona_id: Type.String({ description: "UUID of the persona entry" }),
        }),
        async execute(_toolCallId: string, args: { persona_id: string }, _signal: unknown, _onUpdate: unknown, ctx?: any) {
          const agentId = toolCallIdToAgentId.get(_toolCallId) || ctx?.agentId || "main";
          debugLog("persona_get mapped agentId:", agentId);
          await ensureAgent(agentId, ctx?.workspaceDir);
          const persona = await getPersona(agentId, args.persona_id);
          return persona ? JSON.stringify(persona) : "Persona not found.";
        },
      },
      { names: ["persona_get"] },
    );

    // --- persona_create: Create a new persona entry ---
    api.registerTool(
      {
        name: "persona_create",
        description: `Create a new persona trait for the current agent. 
**CRITICAL INSTRUCTION**: You must explicitly report the creation of any new persona trait to the user. Do not use this tool unless explicitly instructed or permitted by the user to do so.

Each entry requires a category (must be unique per agent, e.g. 'core_identity', 'communication_style') and content (the rule text). is_always_active determines whether it is injected into every system prompt (true) or selected by cosine similarity (false).`,
        parameters: Type.Object({
          category: Type.String({ description: "Category name (must be unique per agent, e.g. 'core_identity', 'communication_style', 'behavioral_rule')" }),
          content: Type.String({ description: "The content text of the persona rule. Will be embedded for situational matching." }),
          is_always_active: Type.Optional(Type.Boolean({ description: "If true, this persona trait is always injected into the system prompt. If false, it is only injected when contextually relevant. Defaults to false." })),
          scope: Type.Optional(Type.Union([Type.Literal("private"), Type.Literal("shared"), Type.Literal("global")], { default: "private", description: "Who can access this persona. 'private' (this agent only) or 'global' (all agents share this trait)." })),
        }),
        async execute(_toolCallId: string, args: { category: string; content: string; is_always_active?: boolean; scope?: "private" | "shared" | "global" }, _signal: unknown, _onUpdate: unknown, ctx?: any) {
          const agentId = toolCallIdToAgentId.get(_toolCallId) || ctx?.agentId || "main";
          debugLog("persona_create mapped agentId:", agentId);
          await ensureAgent(agentId, ctx?.workspaceDir);
          try {
            const newPersona = await createPersona(agentId, {
              category: args.category,
              content: args.content,
              is_always_active: args.is_always_active ?? false,
              access_scope: args.scope || "private"
            });
            return JSON.stringify(newPersona);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `Error creating persona: ${msg}`;
          }
        },
      },
      { names: ["persona_create"] },
    );

    // --- persona_update: Update a persona entry ---
    api.registerTool(
      {
        name: "persona_update",
        description: `Update an existing persona trait. You can change the category, content, or is_always_active flag.

Changing content will re-embed the persona for situational matching. Categories are unique per agent — changing a category effectively reclassifies the trait. Setting is_always_active=true means this persona is injected into every system prompt regardless of relevance.`,
        parameters: Type.Object({
          persona_id: Type.String({ description: "UUID of the persona entry to update" }),
          category: Type.Optional(Type.String({ description: "New category name (must be unique per agent, e.g. 'core_identity', 'communication_style', 'behavioral_rule')" })),
          content: Type.Optional(Type.String({ description: "New content text. Will be re-embedded for situational matching." })),
          is_always_active: Type.Optional(Type.Boolean({ description: "If true, this persona trait is always injected into the system prompt. If false, it is only injected when contextually relevant." })),
          scope: Type.Optional(Type.Union([Type.Literal("private"), Type.Literal("shared"), Type.Literal("global")], { description: "Update access scope. 'private', 'shared', or 'global'." })),
        }),
        async execute(_toolCallId: string, args: { persona_id: string; category?: string; content?: string; is_always_active?: boolean; scope?: "private" | "shared" | "global" }, _signal: unknown, _onUpdate: unknown, ctx?: any) {
          const agentId = toolCallIdToAgentId.get(_toolCallId) || ctx?.agentId || "main";
          debugLog("persona_update mapped agentId:", agentId);
          await ensureAgent(agentId, ctx?.workspaceDir);
          const { persona_id, scope, ...updates } = args;
          const payload = scope ? { ...updates, access_scope: scope } : updates;
          const result = await updatePersona(agentId, persona_id, payload);
          return result ? JSON.stringify(result) : "Persona not found.";
        },
      },
      { names: ["persona_update"] },
    );

    // --- persona_delete: Delete a persona entry ---
    api.registerTool(
      {
        name: "persona_delete",
        description: "Delete a persona trait by its UUID. This also removes any persona↔memory edges in the entity_edges knowledge graph that reference this persona.",
        parameters: Type.Object({
          persona_id: Type.String({ description: "UUID of the persona entry to delete. Cascades to remove associated graph edges." }),
        }),
        async execute(_toolCallId: string, args: { persona_id: string }, _signal: unknown, _onUpdate: unknown, ctx?: any) {
          const agentId = toolCallIdToAgentId.get(_toolCallId) || ctx?.agentId || "main";
          debugLog("persona_delete mapped agentId:", agentId);
          await ensureAgent(agentId, ctx?.workspaceDir);
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
    const toolCallIdToAgentId = new Map<string, string>();

    api.on("before_tool_call", async (event: any, ctx: any) => {
      debugLog("before_tool_call event:", JSON.stringify(event, null, 2));
      debugLog("before_tool_call ctx:", JSON.stringify(ctx, null, 2));
      const agentId = ctx?.agentId;
      if (agentId && event.toolCallId) {
        toolCallIdToAgentId.set(event.toolCallId, agentId);
      }
    });

    api.on(
      "agent_end",
      async (event: AgentEndEvent, ctx: AgentEndCtx) => {
        try {
          debugLog("agent_end event:", JSON.stringify(event, null, 2));
          debugLog("agent_end ctx:", JSON.stringify(ctx, null, 2));

          const messages: ChatMessage[] = event.messages ?? [];
          const agentId = ctx.agentId;
          const provider = ctx?.messageProvider ?? "";
          const isHeartbeat = provider === "heartbeat" || provider === "cron";

          // Lazy-register the agent if not already in the DB
          await ensureAgent(agentId, ctx.workspaceDir);

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

          if (userMessage.includes("[POSTCLAW_INTERNAL_LLM_CALL_DO_NOT_LOG]")) {
            console.log("[PostClaw] Skipped episodic logging for internal script call");
            return;
          }

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
        const config = getCurrentConfig();
        startService({
          intervalHours: sleepIntervalHours || 6,
          config: config.sleep
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
