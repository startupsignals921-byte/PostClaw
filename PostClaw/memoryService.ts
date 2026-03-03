import { sql, AGENT_ID, EMBEDDING_MODEL, getEmbedding, hashContent } from "./db.js";

// =============================================================================
// SEMANTIC SEARCH + GRAPH TRAVERSAL
// =============================================================================

/**
 * Semantic search + graph traversal against memory_semantic + entity_edges.
 * Returns formatted context string or null if no results found.
 */
export async function searchPostgres(userText: string): Promise<string | null> {
  let contextString: string | null = null;

  try {
    const embedding = await getEmbedding(userText);

    await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;

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
        ),
        final_matches AS (
          SELECT id, content, similarity, NULL as relationship_type FROM semantic_matches
          UNION ALL
          SELECT id, content, similarity, relationship_type FROM linked_matches
          ORDER BY similarity DESC
          LIMIT 15
        )
        SELECT * FROM final_matches;
      `;

      if (results.length > 0) {
        contextString = results
          .map((r: any) => {
            const pct = (r.similarity * 100).toFixed(1) + "%";
            const label = r.relationship_type
              ? `Linked: ${r.relationship_type}, ${pct}`
              : pct;
            return `[ID: ${r.id}] (${label}) - ${r.content}`;
          })
          .join("\n");

        // Update tracking columns
        const extractedIds = results.map((r: any) => r.id);
        await tx`
          UPDATE memory_semantic
          SET access_count = access_count + 1,
              last_accessed_at = CURRENT_TIMESTAMP
          WHERE id IN ${sql(extractedIds)}
        `;
      }
    });
  } catch (err) {
    console.error("[SEARCH] Postgres search error:", err);
  }

  return contextString;
}

// =============================================================================
// EPISODIC MEMORY
// =============================================================================

/**
 * Log an episodic memory event to memory_episodic.
 */
export async function logEpisodicMemory(
  text: string,
  embedding: number[],
  eventType: string = "user_prompt"
): Promise<void> {
  try {
    await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;

      await tx`
        INSERT INTO memory_episodic (
          agent_id, session_id, event_summary, event_type, embedding, embedding_model
        ) VALUES (
          ${AGENT_ID}, 'active-session', ${text}, ${eventType},
          ${JSON.stringify(embedding)}, ${EMBEDDING_MODEL}
        )
      `;
    });
    console.log(`[EPISODIC] Logged event (${eventType})`);
  } catch (err) {
    console.error("[EPISODIC] Failed to log:", err);
  }
}

/**
 * Log a single tool call execution to memory_episodic.
 */
export async function logEpisodicToolCall(
  toolCallId: string,
  toolName: string,
  toolArgs: string,
  embedding: number[]
): Promise<void> {
  const summary = `Agent executed tool: ${toolName} with arguments: ${toolArgs}`;

  try {
    await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;

      await tx`
        INSERT INTO memory_episodic (
          agent_id, session_id, event_summary, event_type, embedding, embedding_model, metadata
        ) VALUES (
          ${AGENT_ID}, 'active-session', ${summary}, 'tool_execution',
          ${JSON.stringify(embedding)}, ${EMBEDDING_MODEL},
          ${JSON.stringify({ tool_call_id: toolCallId, tool_name: toolName })}
        )
      `;
    });
    console.log(`[EPISODIC] 🛠️  Logged tool execution (${toolName})`);
  } catch (err) {
    console.error("[EPISODIC] Failed to log tool call:", err);
  }
}

// =============================================================================
// PERSONA CONTEXT
// =============================================================================

/**
 * Fetch persona rules (core + situational) from agent_persona.
 */
export async function fetchPersonaContext(embedding: number[] | null): Promise<string | null> {
  let personaContext: string | null = null;

  try {
    await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;

      let results;

      if (embedding) {
        // Full fetch: core + situational (similarity-ranked)
        results = await tx`
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
      } else {
        // No embedding available (e.g. first prompt) — only core rules
        results = await tx`
          SELECT category, content, 1.0 AS relevance_score
          FROM agent_persona
          WHERE is_always_active = true
          ORDER BY category;
        `;
      }

      if (results.length > 0) {
        personaContext = results
          .map((r: any) => `* **[${r.category}]**: ${r.content}`)
          .join("\n");
      }
    });
  } catch (err) {
    console.error("[PERSONA] Fetch failed:", err);
  }

  return personaContext;
}

// =============================================================================
// DYNAMIC TOOLS
// =============================================================================

/** OpenAI-compatible tool definition (function calling format). */
export interface ChatCompletionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/**
 * Fetch dynamic tools from context_environment based on embedding similarity.
 */
export async function fetchDynamicTools(embedding: number[]): Promise<ChatCompletionTool[]> {
  let dynamicTools: ChatCompletionTool[] = [];

  try {
    await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;

      const results = await tx`
        SELECT tool_name, context_data, 1 - (embedding <=> ${JSON.stringify(embedding)}) AS similarity
        FROM context_environment
        WHERE 1 - (embedding <=> ${JSON.stringify(embedding)}) > 0.35
        ORDER BY similarity DESC
        LIMIT 3;
      `;

      if (results.length > 0) {
        dynamicTools = results.map((r: any) => JSON.parse(r.context_data) as ChatCompletionTool);
        console.log(`[TOOLS] 🔧 Loaded ${dynamicTools.length} dynamic tool(s): ${dynamicTools.map(t => t.function.name).join(", ")}`);
      }
    });
  } catch (err) {
    console.error("[TOOLS] Failed to fetch dynamic tools:", err);
  }

  return dynamicTools;
}

// =============================================================================
// MEMORY STORE (replaces db-memory-store skill)
// =============================================================================

export interface MemoryOptions {
  category?: string;
  source_uri?: string;
  volatility?: "low" | "medium" | "high";
  is_pointer?: boolean;
  token_count?: number;
  confidence?: number;
  tier?: "volatile" | "session" | "daily" | "stable" | "permanent";
  usefulness_score?: number;
  expires_at?: Date | null;
  metadata?: Record<string, any>;
}

/**
 * Store a new semantic memory fact. Deduplicates via content_hash.
 */
export async function storeMemory(
  content: string,
  scope: "private" | "shared" | "global" = "private",
  options: MemoryOptions = {}
): Promise<{ id: string | null; status: string }> {
  try {
    const embedding = await getEmbedding(content);
    const contentHash = hashContent(content);

    const result = await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;

      const rows = await tx`
        INSERT INTO memory_semantic (
          agent_id, access_scope, content, content_hash, embedding, embedding_model,
          category, source_uri, volatility, is_pointer, token_count, confidence, tier, usefulness_score, expires_at, metadata
        ) VALUES (
          ${AGENT_ID}, ${scope}, ${content}, ${contentHash},
          ${JSON.stringify(embedding)}, ${EMBEDDING_MODEL},
          ${options.category || null}, ${options.source_uri || null}, ${options.volatility || 'low'}, ${options.is_pointer || false},
          ${options.token_count || 0}, ${options.confidence || 0.5}, ${options.tier || 'daily'}, ${options.usefulness_score || 0.0},
          ${options.expires_at || null}, ${options.metadata ? JSON.stringify(options.metadata) : '{}'}
        )
        ON CONFLICT (agent_id, content_hash) DO NOTHING
        RETURNING id;
      `;
      return rows;
    });

    if (result.length > 0) {
      console.log(`[MEMORY] Stored new fact: "${content.substring(0, 60)}..."`);
      return { id: result[0].id, status: "stored" };
    } else {
      console.log(`[MEMORY] Duplicate — fact already exists.`);
      return { id: null, status: "duplicate" };
    }
  } catch (err) {
    console.error("[MEMORY] Failed to store:", err);
    return { id: null, status: `error: ${err}` };
  }
}

// =============================================================================
// MEMORY UPDATE (replaces db-memory-update skill)
// =============================================================================

/**
 * Supersede an old memory with a corrected/updated fact.
 * Archives the old memory and creates a new one with a causal link.
 */
export async function updateMemory(
  oldMemoryId: string,
  newFact: string,
  options: MemoryOptions = {}
): Promise<{ newId: string | null; status: string }> {
  try {
    const embedding = await getEmbedding(newFact);
    const contentHash = hashContent(newFact);

    const result = await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;

      // Insert the new truth
      const newMem = await tx`
        INSERT INTO memory_semantic (
          agent_id, access_scope, content, content_hash, embedding, embedding_model,
          category, source_uri, volatility, is_pointer, token_count, confidence, tier, usefulness_score, expires_at, metadata
        ) VALUES (
          ${AGENT_ID}, 'global', ${newFact}, ${contentHash},
          ${JSON.stringify(embedding)}, ${EMBEDDING_MODEL},
          ${options.category || null}, ${options.source_uri || null}, ${options.volatility || 'low'}, ${options.is_pointer || false},
          ${options.token_count || 0}, ${options.confidence || 0.5}, ${options.tier || 'daily'}, ${options.usefulness_score || 0.0},
          ${options.expires_at || null}, ${options.metadata ? JSON.stringify(options.metadata) : '{}'}
        )
        RETURNING id;
      `;
      const newId = newMem[0].id;

      // Deprecate the old memory
      await tx`
        UPDATE memory_semantic
        SET is_archived = true, superseded_by = ${newId}
        WHERE id = ${oldMemoryId} AND agent_id = ${AGENT_ID};
      `;

      return newId;
    });

    console.log(`[MEMORY] Updated. Old (${oldMemoryId.substring(0, 8)}) deprecated, new truth: ${result.substring(0, 8)}`);
    return { newId: result, status: "updated" };
  } catch (err) {
    console.error("[MEMORY] Failed to update:", err);
    return { newId: null, status: `error: ${err}` };
  }
}

// =============================================================================
// MEMORY LINK (replaces db-memory-link skill)
// =============================================================================

/**
 * Create a directed edge between two memories in the knowledge graph.
 */
export async function linkMemories(
  sourceId: string,
  targetId: string,
  relationship: string
): Promise<{ status: string }> {
  try {
    await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;

      await tx`
        INSERT INTO entity_edges (agent_id, source_memory_id, target_memory_id, relationship_type, weight)
        VALUES (${AGENT_ID}, ${sourceId}, ${targetId}, ${relationship}, 1.0)
        ON CONFLICT (source_memory_id, target_memory_id, relationship_type) DO NOTHING;
      `;
    });

    console.log(`[GRAPH] Linked ${sourceId.substring(0, 8)} → ${targetId.substring(0, 8)} as "${relationship}"`);
    return { status: "linked" };
  } catch (err) {
    console.error("[GRAPH] Failed to link:", err);
    return { status: `error: ${err}` };
  }
}

// =============================================================================
// TOOL STORE (replaces db-tool-store skill)
// =============================================================================

/**
 * Store or update a tool definition in context_environment.
 */
export async function storeTool(
  toolName: string,
  toolJson: string,
  scope: "private" | "shared" | "global" = "private"
): Promise<{ status: string }> {
  try {
    const toolObj = JSON.parse(toolJson);
    const description = toolObj.function?.description || toolObj.description || "";
    const embedText = `${toolName}: ${description}`;
    const embedding = await getEmbedding(embedText);

    await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${AGENT_ID}, true)`;

      await tx`
        INSERT INTO context_environment (
          agent_id, access_scope, tool_name, context_data, embedding
        ) VALUES (
          ${AGENT_ID}, ${scope}, ${toolName}, ${toolJson}, ${JSON.stringify(embedding)}
        )
        ON CONFLICT (agent_id, tool_name) DO UPDATE SET
          context_data = EXCLUDED.context_data,
          embedding = EXCLUDED.embedding,
          access_scope = EXCLUDED.access_scope;
      `;
    });

    console.log(`[TOOLS] Stored/updated tool schema: ${toolName}`);
    return { status: "stored" };
  } catch (err) {
    console.error("[TOOLS] Failed to store tool:", err);
    return { status: `error: ${err}` };
  }
}
