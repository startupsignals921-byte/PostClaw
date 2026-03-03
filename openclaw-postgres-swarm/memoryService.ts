import { sql, AGENT_ID, EMBEDDING_MODEL, getEmbedding } from "./db.js";

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
        )
        SELECT id, content, similarity, 'Direct Match' as relation FROM semantic_matches
        UNION ALL
        SELECT id, content, similarity, 'Linked: ' || relationship_type as relation FROM linked_matches
        ORDER BY similarity DESC
        LIMIT 15;
      `;

      if (results.length > 0) {
        contextString = results
          .map((r: any) => `[ID: ${r.id}] (${r.relation}) - ${r.content}`)
          .join("\n");
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
export async function fetchPersonaContext(embedding: number[]): Promise<string | null> {
  let personaContext: string | null = null;

  try {
    await sql.begin(async (tx: any) => {
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
