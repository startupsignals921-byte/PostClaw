import { getSql, EMBEDDING_MODEL, getEmbedding, hashContent } from "./db.js";
import { z } from "zod";
import {
  StoreMemoryInputSchema,
  UpdateMemoryInputSchema,
  type MemoryOptions,
  type SearchResultRow,
  type PersonaRow,
  type ChatCompletionTool,
} from "../schemas/validation.js";

// =============================================================================
// LAZY AGENT AUTO-REGISTRATION
// =============================================================================

const registeredAgents = new Set<string>();

export async function ensureAgent(agentId: string, workspaceDir?: string): Promise<void> {
  if (!agentId) return;
  try {
    const sql = getSql();
    await sql`
      INSERT INTO agents (id, name, workspace_dir) 
      VALUES (${agentId}, ${agentId}, ${workspaceDir || null}) 
      ON CONFLICT (id) DO UPDATE SET 
        workspace_dir = EXCLUDED.workspace_dir
      WHERE EXCLUDED.workspace_dir IS NOT NULL
    `;
    registeredAgents.add(agentId);
  } catch (err) {
    console.error(`[AGENTS] Failed to register agent ${agentId}:`, err);
  }
}

// =============================================================================
// SEMANTIC SEARCH + GRAPH TRAVERSAL
// =============================================================================

/**
 * Semantic search + graph traversal against memory_semantic + entity_edges.
 * Returns formatted context string or null if no results found.
 */
export async function searchPostgres(
  agentId: string, 
  userText: string, 
  options: { semanticLimit?: number; linkedSimilarity?: number; totalLimit?: number; maxTraversalDepth?: number } = {}
): Promise<string | null> {
  let contextString: string | null = null;
  const semanticLimit = options.semanticLimit ?? 7;
  const totalLimit = options.totalLimit ?? 15;
  const maxDepth = options.maxTraversalDepth ?? 3;

  try {
    const embedding = await getEmbedding(userText);

    // Note: postgres.js TransactionSql loses call signatures via Omit<Sql, ...>,
    // so we must use `any` for the tx callback parameter.
    await getSql().begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;

      // Recursive CTE: multi-level graph traversal with cycle detection
      const results = await tx`
        WITH RECURSIVE semantic_matches AS (
          SELECT id, content, 1 - (embedding <=> ${JSON.stringify(embedding)}) AS similarity
          FROM memory_semantic
          WHERE agent_id = ${agentId} AND is_archived = false
          ORDER BY similarity DESC
          LIMIT ${semanticLimit}
        ),
        graph_walk AS (
          -- Base case: direct semantic matches
          SELECT id, content, similarity, NULL::varchar AS relationship_type,
                 0 AS depth, ARRAY[id] AS visited
          FROM semantic_matches

          UNION ALL

          -- Recursive step: follow edges up to maxDepth hops
          SELECT m.id, m.content,
                 gw.similarity * 0.85 AS similarity,
                 e.relationship_type,
                 gw.depth + 1 AS depth,
                 gw.visited || m.id
          FROM graph_walk gw
          JOIN entity_edges e ON (
            (e.source_memory_id = gw.id OR e.target_memory_id = gw.id)
            AND e.agent_id = ${agentId}
          )
          JOIN memory_semantic m ON (
            m.id = CASE
              WHEN e.source_memory_id = gw.id THEN e.target_memory_id
              ELSE e.source_memory_id
            END
          )
          WHERE gw.depth < ${maxDepth}
            AND m.is_archived = false
            AND m.id != ALL(gw.visited)
        ),
        deduped AS (
          SELECT DISTINCT ON (id) id, content, similarity, relationship_type, depth
          FROM graph_walk
          ORDER BY id, similarity DESC
        )
        SELECT id, content, similarity, relationship_type, depth
        FROM deduped
        ORDER BY similarity DESC
        LIMIT ${totalLimit};
      `;

      console.log(`[SEARCH] Query returned ${results.length} row(s) for agent=${agentId} (max depth ${maxDepth})`);

      if (results.length > 0) {
        contextString = (results as (SearchResultRow & { depth: number })[])
          .map((r) => {
            const pct = (r.similarity * 100).toFixed(1) + "%";
            const label = r.relationship_type
              ? `Linked[${r.depth}]: ${r.relationship_type}, ${pct}`
              : pct;
            return `[ID: ${r.id}] (${label}) - ${r.content}`;
          })
          .join("\n");

        // Update tracking columns
        const extractedIds = (results as SearchResultRow[]).map((r) => r.id);
        await tx`
          UPDATE memory_semantic
          SET access_count = access_count + 1,
              last_accessed_at = CURRENT_TIMESTAMP
          WHERE id IN ${getSql()(extractedIds)}
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
export async function logEpisodicMemory(agentId: string,
  text: string,
  embedding: number[],
  eventType: string = "user_prompt"
): Promise<void> {
  try {
    // Guard against undefined values that crash the postgres driver
    if (!agentId) {
      console.error(`[EPISODIC] Skipping: agentId is ${agentId}`);
      return;
    }
    const modelName = EMBEDDING_MODEL || "text-embedding-nomic-embed-text-v2-moe";

    await getSql().begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;

      await tx`
        INSERT INTO memory_episodic (
          agent_id, session_id, event_summary, event_type, embedding, embedding_model
        ) VALUES (
          ${agentId}, 'active-session', ${text}, ${eventType},
          ${JSON.stringify(embedding)}, ${modelName}
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
export async function logEpisodicToolCall(agentId: string,
  toolCallId: string,
  toolName: string,
  toolArgs: string,
  embedding: number[]
): Promise<void> {
  const summary = `Agent executed tool: ${toolName} with arguments: ${toolArgs}`;

  try {
    if (!agentId) {
      console.error(`[EPISODIC] Skipping tool call log: agentId is ${agentId}`);
      return;
    }
    const modelName = EMBEDDING_MODEL || "text-embedding-nomic-embed-text-v2-moe";

    await getSql().begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;

      await tx`
        INSERT INTO memory_episodic (
          agent_id, session_id, event_summary, event_type, embedding, embedding_model, metadata
        ) VALUES (
          ${agentId}, 'active-session', ${summary}, 'tool_execution',
          ${JSON.stringify(embedding)}, ${modelName},
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
export async function fetchPersonaContext(
  agentId: string, 
  embedding: number[] | null,
  options: { situationalLimit?: number } = {}
): Promise<string | null> {
  let personaContext: string | null = null;
  const situationalLimit = options.situationalLimit ?? 3;

  try {
    await getSql().begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;

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
            LIMIT ${situationalLimit}
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
        personaContext = (results as PersonaRow[])
          .map((r) => `* **[${r.category}]**: ${r.content}`)
          .join("\n");
      }
    });
  } catch (err) {
    console.error("[PERSONA] Fetch failed:", err);
  }

  return personaContext;
}

// =============================================================================
// MEMORY STORE (replaces db-memory-store skill)
// MemoryOptions type is now imported from schemas/validation.ts

/**
 * Store a new semantic memory fact. Deduplicates via content_hash.
 */
export async function storeMemory(agentId: string,
  content: string,
  scope: "private" | "shared" | "global" = "private",
  options: MemoryOptions = {}
): Promise<{ id: string | null; status: string }> {
  try {
    const validated = StoreMemoryInputSchema.parse({ content, scope, options: Object.keys(options).length > 0 ? options : undefined });

    const embedding = await getEmbedding(validated.content);
    const contentHash = hashContent(validated.content);

    const result = await getSql().begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;

      const rows = await tx`
        INSERT INTO memory_semantic (
          agent_id, access_scope, content, content_hash, embedding, embedding_model,
          category, source_uri, volatility, is_pointer, token_count, confidence, tier, usefulness_score, expires_at, metadata
        ) VALUES (
          ${agentId}, ${scope}, ${content}, ${contentHash},
          ${JSON.stringify(embedding)}, ${EMBEDDING_MODEL},
          ${validated.options?.category || null}, ${validated.options?.source_uri || null}, ${validated.options?.volatility || 'low'}, ${validated.options?.is_pointer || false},
          ${validated.options?.token_count || 0}, ${validated.options?.confidence || 0.5}, ${validated.options?.tier || 'daily'}, ${validated.options?.usefulness_score || 0.0},
          ${validated.options?.expires_at || null}, ${validated.options?.metadata ? JSON.stringify(validated.options.metadata) : '{}'}
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
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      console.error("[MEMORY] Validation failed:", err.issues);
      return { id: null, status: "error: validation failed" };
    }
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
export async function updateMemory(agentId: string,
  oldMemoryId: string,
  newFact: string,
  options: MemoryOptions = {}
): Promise<{ newId: string | null; status: string }> {
  try {
    const validated = UpdateMemoryInputSchema.parse({ oldMemoryId, newFact, options: Object.keys(options).length > 0 ? options : undefined });

    const embedding = await getEmbedding(validated.newFact);
    const contentHash = hashContent(validated.newFact);

    const result = await getSql().begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;

      // Insert the new truth
      const newMem = await tx`
        INSERT INTO memory_semantic (
          agent_id, access_scope, content, content_hash, embedding, embedding_model,
          category, source_uri, volatility, is_pointer, token_count, confidence, tier, usefulness_score, expires_at, metadata
        ) VALUES (
          ${agentId}, 'global', ${validated.newFact}, ${contentHash},
          ${JSON.stringify(embedding)}, ${EMBEDDING_MODEL},
          ${validated.options?.category || null}, ${validated.options?.source_uri || null}, ${validated.options?.volatility || 'low'}, ${validated.options?.is_pointer || false},
          ${validated.options?.token_count || 0}, ${validated.options?.confidence || 0.5}, ${validated.options?.tier || 'daily'}, ${validated.options?.usefulness_score || 0.0},
          ${validated.options?.expires_at || null}, ${validated.options?.metadata ? JSON.stringify(validated.options.metadata) : '{}'}
        )
        RETURNING id;
      `;
      const newId = newMem[0].id;

      // Deprecate the old memory
      await tx`
        UPDATE memory_semantic
        SET is_archived = true, superseded_by = ${newId}
        WHERE id = ${validated.oldMemoryId} AND agent_id = ${agentId};
      `;

      return newId;
    });

    console.log(`[MEMORY] Updated. Old (${oldMemoryId.substring(0, 8)}) deprecated, new truth: ${result.substring(0, 8)}`);
    return { newId: result, status: "updated" };
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      console.error("[MEMORY] Validation failed:", err.issues);
      return { newId: null, status: "error: validation failed" };
    }
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
export async function linkMemories(agentId: string,
  sourceId: string,
  targetId: string,
  relationship: string
): Promise<{ status: string }> {
  try {
    await getSql().begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;

      await tx`
        INSERT INTO entity_edges (agent_id, source_memory_id, target_memory_id, relationship_type, weight)
        VALUES (${agentId}, ${sourceId}, ${targetId}, ${relationship}, 1.0)
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

