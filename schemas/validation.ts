import { z } from "zod";

// =============================================================================
// SHARED ENUMS & PRIMITIVES
// =============================================================================

export const AccessScopeSchema = z.enum(["private", "shared", "global"]);
export const VolatilitySchema = z.enum(["low", "medium", "high"]);
export const MemoryTierSchema = z.enum(["volatile", "session", "daily", "stable", "permanent"]);
export const ChatRoleSchema = z.enum(["system", "user", "assistant", "tool"]);

// =============================================================================
// MEMORY OPTIONS (single source of truth — replaces the manual interface)
// =============================================================================

export const MemoryOptionsSchema = z.object({
    category: z.string().max(50).optional().nullable(),
    source_uri: z.string().url().max(512).optional().nullable(),
    volatility: VolatilitySchema.optional().nullable(),
    is_pointer: z.boolean().optional().nullable(),
    token_count: z.number().int().optional().nullable(),
    tier: MemoryTierSchema.optional().nullable(),
    confidence: z.number().min(0).max(1).optional().nullable(),
    usefulness_score: z.number().optional().nullable(),
    expires_at: z.date().optional().nullable(),
    metadata: z.record(z.string(), z.any()).optional().nullable(),
});

export type MemoryOptions = z.infer<typeof MemoryOptionsSchema>;

export const StoreMemoryInputSchema = z.object({
    content: z.string().min(1),
    scope: AccessScopeSchema.default("private"),
    options: MemoryOptionsSchema.optional(),
});

export type StoreMemoryInput = z.infer<typeof StoreMemoryInputSchema>;

export const UpdateMemoryInputSchema = z.object({
    oldMemoryId: z.string().uuid(),
    newFact: z.string().min(1),
    options: MemoryOptionsSchema.optional(),
});

export type UpdateMemoryInput = z.infer<typeof UpdateMemoryInputSchema>;

// =============================================================================
// DATABASE ROW SHAPES — typed results from postgres queries
// =============================================================================

export const SearchResultRowSchema = z.object({
    id: z.string().uuid(),
    content: z.string(),
    similarity: z.number(),
    relationship_type: z.string().nullable().optional(),
});

export type SearchResultRow = z.infer<typeof SearchResultRowSchema>;

export const EpisodicRowSchema = z.object({
    id: z.string().uuid(),
    event_type: z.string(),
    event_summary: z.string(),
    created_at: z.coerce.date(),
});

export type EpisodicRow = z.infer<typeof EpisodicRowSchema>;

export const PersonaRowSchema = z.object({
    category: z.string(),
    content: z.string(),
    relevance_score: z.number(),
});

export type PersonaRow = z.infer<typeof PersonaRowSchema>;

export const MemorySemanticRowSchema = z.object({
    id: z.string().uuid(),
    content: z.string(),
    embedding: z.any(),
    usefulness_score: z.number().nullable().optional(),
    access_count: z.number().nullable().optional(),
    created_at: z.coerce.date().optional(),
});

export type MemorySemanticRow = z.infer<typeof MemorySemanticRowSchema>;

export const DuplicateCandidateRowSchema = z.object({
    id: z.string().uuid(),
    content: z.string(),
    usefulness_score: z.number().nullable().optional(),
    access_count: z.number().nullable().optional(),
});

export type DuplicateCandidateRow = z.infer<typeof DuplicateCandidateRowSchema>;

export const StaleMemoryRowSchema = z.object({
    id: z.string().uuid(),
    content: z.string(),
    tier: z.string(),
    access_count: z.number(),
    created_at: z.coerce.date(),
});

export type StaleMemoryRow = z.infer<typeof StaleMemoryRowSchema>;

export const LinkCandidateRowSchema = z.object({
    id: z.string().uuid(),
    content: z.string(),
    similarity: z.number(),
});

export type LinkCandidateRow = z.infer<typeof LinkCandidateRowSchema>;

/** OpenAI-compatible tool definition (function calling format). */
export interface ChatCompletionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

// =============================================================================
// LLM / API RESPONSE SCHEMAS
// =============================================================================

export const EmbeddingDataSchema = z.object({
    embedding: z.array(z.number()),
});

export const EmbeddingApiResponseSchema = z.object({
    data: z.array(EmbeddingDataSchema).min(1),
});

export type EmbeddingApiResponse = z.infer<typeof EmbeddingApiResponseSchema>;

export const OpenClawAgentResponseSchema = z.object({
    status: z.string(),
    summary: z.string().optional(),
    result: z.object({
        payloads: z.array(z.object({
            text: z.string(),
        })),
    }).optional(),
});

export type OpenClawAgentResponse = z.infer<typeof OpenClawAgentResponseSchema>;

/** LLM output from sleep_cycle Phase 1: episodic consolidation */
export const SleepCycleResultSchema = z.object({
    session_summary: z.string(),
    extracted_durable_facts: z.array(z.string()),
});

export type SleepCycleResult = z.infer<typeof SleepCycleResultSchema>;

/** LLM output from sleep_cycle Phase 4: link classification */
export const LinkClassificationSchema = z.object({
    source_id: z.string(),
    target_id: z.string(),
    relationship: z.string(),
});

export type LinkClassification = z.infer<typeof LinkClassificationSchema>;

/** LLM output from bootstrap_persona.ts */
export const PersonaChunkSchema = z.object({
    category: z.string(),
    content: z.string(),
    is_always_active: z.boolean(),
});

export type PersonaChunk = z.infer<typeof PersonaChunkSchema>;

// =============================================================================
// OPENCLAW PLUGIN HOOK EVENT / CONTEXT TYPES
// =============================================================================

export const ContentPartSchema = z.object({
    type: z.string(),
    text: z.string().optional(),
    image_url: z.object({ url: z.string() }).optional(),
});

export type ContentPart = z.infer<typeof ContentPartSchema>;

export const ToolCallRecordSchema = z.object({
    id: z.string().optional(),
    type: z.literal("function").optional(),
    function: z.object({
        name: z.string(),
        arguments: z.string(),
    }),
});

export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;

export const ChatMessageSchema = z.object({
    role: ChatRoleSchema,
    content: z.union([z.string(), z.array(ContentPartSchema), z.null()]),
    tool_calls: z.array(ToolCallRecordSchema).optional(),
    tool_call_id: z.string().optional(),
    name: z.string().optional(),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** Event payload for the before_prompt_build hook */
export interface PromptBuildEvent {
    prompt?: string;
    messages?: ChatMessage[];
}

/** Context for the before_prompt_build hook */
export interface PromptBuildCtx {
    agentId: string;
    sessionKey?: string;
    sessionId?: string;
    workspaceDir?: string;
    messageProvider?: string;
}

/** Event payload for the agent_end hook */
export interface AgentEndEvent {
    messages?: ChatMessage[];
    success: boolean;
    error?: string;
    durationMs: number;
}

/** Context for the agent_end hook */
export interface AgentEndCtx {
    agentId: string;
    sessionKey?: string;
    sessionId?: string;
    workspaceDir?: string;
    messageProvider?: string;
}

/** Event payload for the message_received hook */
export interface MessageReceivedEvent {
    from?: string;
    content?: string;
    channelId?: string;
}

// =============================================================================
// TOOL ARGUMENT SCHEMAS (for runtime validation in execute handlers)
// =============================================================================

export const MemoryStoreArgsSchema = z.object({
    content: z.string(),
    scope: AccessScopeSchema.optional().default("private"),
    category: z.string().optional(),
    volatility: VolatilitySchema.optional(),
    tier: MemoryTierSchema.optional(),
    metadata: z.record(z.string(), z.any()).optional(),
});

export type MemoryStoreArgs = z.infer<typeof MemoryStoreArgsSchema>;

export const MemoryUpdateArgsSchema = z.object({
    old_memory_id: z.string(),
    new_fact: z.string(),
    category: z.string().optional(),
    volatility: VolatilitySchema.optional(),
    tier: MemoryTierSchema.optional(),
    metadata: z.record(z.string(), z.any()).optional(),
});

export type MemoryUpdateArgs = z.infer<typeof MemoryUpdateArgsSchema>;

export const MemoryLinkArgsSchema = z.object({
    source_id: z.string(),
    target_id: z.string(),
    relationship: z.string(),
});

export type MemoryLinkArgs = z.infer<typeof MemoryLinkArgsSchema>;

export const ToolStoreArgsSchema = z.object({
    tool_name: z.string(),
    tool_json: z.string(),
    scope: AccessScopeSchema.optional().default("private"),
});

export type ToolStoreArgs = z.infer<typeof ToolStoreArgsSchema>;

// =============================================================================
// BOOTSTRAP TOOLS SCHEMA
// =============================================================================

export const ToolFunctionSchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
});

export const ToolDefinitionSchema = z.object({
    type: z.literal("function").optional(),
    function: ToolFunctionSchema,
});

export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export const PromptJsonSchema = z.object({
    tools: z.array(ToolDefinitionSchema),
});

export type PromptJson = z.infer<typeof PromptJsonSchema>;

// =============================================================================
// DASHBOARD API SCHEMAS
// =============================================================================

/** Create a new persona entry */
export const PersonaCreateSchema = z.object({
    category: z.string().min(1).max(50),
    content: z.string().min(1),
    is_always_active: z.boolean().default(false),
    access_scope: AccessScopeSchema.default("private"),
});

export type PersonaCreate = z.infer<typeof PersonaCreateSchema>;

/** Update an existing persona entry */
export const PersonaUpdateSchema = z.object({
    category: z.string().min(1).max(50).optional(),
    content: z.string().min(1).optional(),
    is_always_active: z.boolean().optional(),
    access_scope: AccessScopeSchema.optional(),
});

export type PersonaUpdate = z.infer<typeof PersonaUpdateSchema>;

/** Create a new memory via dashboard */
export const DashboardMemoryCreateSchema = z.object({
    content: z.string().min(1),
    scope: AccessScopeSchema.default("private"),
    category: z.string().max(50).optional(),
    tier: MemoryTierSchema.default("daily"),
    volatility: VolatilitySchema.default("low"),
    metadata: z.record(z.string(), z.any()).optional(),
});

export type DashboardMemoryCreate = z.infer<typeof DashboardMemoryCreateSchema>;

/** Update a memory via dashboard */
export const DashboardMemoryUpdateSchema = z.object({
    content: z.string().min(1).optional(),
    category: z.string().max(50).optional().nullable(),
    tier: MemoryTierSchema.optional(),
    volatility: VolatilitySchema.optional(),
    is_archived: z.boolean().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
});

export type DashboardMemoryUpdate = z.infer<typeof DashboardMemoryUpdateSchema>;

/** Import memories from markdown content */
export const MemoryImportSchema = z.object({
    content: z.string().min(1),
    source_filename: z.string().optional(),
    tier: MemoryTierSchema.default("stable"),
});

export type MemoryImport = z.infer<typeof MemoryImportSchema>;

/** Create a knowledge graph edge (memory↔memory) */
export const GraphEdgeCreateSchema = z.object({
    source_memory_id: z.string().uuid().optional(),
    target_memory_id: z.string().uuid().optional(),
    source_persona_id: z.string().uuid().optional(),
    target_persona_id: z.string().uuid().optional(),
    relationship_type: z.string().min(1).max(100),
    weight: z.number().min(0).max(10).default(1.0),
}).refine(
    (d) => (d.source_memory_id || d.source_persona_id) && (d.target_memory_id || d.target_persona_id),
    { message: "At least one source and one target ID required" },
);

export type GraphEdgeCreate = z.infer<typeof GraphEdgeCreateSchema>;

/** Create a persona↔memory edge */
export const PersonaEdgeCreateSchema = z.object({
    persona_id: z.string().uuid(),
    memory_id: z.string().uuid(),
    relationship_type: z.string().min(1).max(100),
    weight: z.number().min(0).max(10).default(1.0),
});

export type PersonaEdgeCreate = z.infer<typeof PersonaEdgeCreateSchema>;

/** Import workspace .md file as persona entries or memory chunks */
export const WorkspaceImportSchema = z.object({
    filename: z.string().min(1),
    target: z.enum(["persona", "memory"]),
    tier: MemoryTierSchema.default("stable"),
});

export type WorkspaceImport = z.infer<typeof WorkspaceImportSchema>;

/** Trigger a script run */
export const ScriptRunSchema = z.object({
    agentId: z.string().default("main"),
    file: z.string().optional(),
});

export type ScriptRun = z.infer<typeof ScriptRunSchema>;

/** Standard API response wrapper */
export const ApiResponseSchema = z.object({
    ok: z.boolean(),
    data: z.any().optional(),
    error: z.string().optional(),
});

export type ApiResponse = z.infer<typeof ApiResponseSchema>;

/** Memory list query params */
export const MemoryListQuerySchema = z.object({
    agentId: z.string().default("main"),
    limit: z.coerce.number().int().min(1).max(500).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    category: z.string().optional(),
    tier: MemoryTierSchema.optional(),
    archived: z.enum(["true", "false", "all"]).default("false"),
    search: z.string().optional(),
});

export type MemoryListQuery = z.infer<typeof MemoryListQuerySchema>;
