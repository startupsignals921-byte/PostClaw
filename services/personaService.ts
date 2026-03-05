/**
 * PostClaw Persona Service — CRUD for the agent_persona table.
 *
 * Mirrors the memoryService.ts pattern: uses getSql().begin() with
 * set_config('app.current_agent_id', ...) for RLS compliance.
 */

import { getSql, getEmbedding } from "./db.js";
import {
  PersonaCreateSchema,
  PersonaUpdateSchema,
  type PersonaCreate,
  type PersonaUpdate,
} from "../schemas/validation.js";

// =============================================================================
// TYPES
// =============================================================================

export interface PersonaEntry {
  id: string;
  agent_id: string;
  access_scope: string;
  category: string;
  content: string;
  is_always_active: boolean;
  created_at: string;
}

// =============================================================================
// LIST
// =============================================================================

export async function listPersonas(agentId: string): Promise<PersonaEntry[]> {
  try {
    const rows = await getSql().begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;
      return await tx`
        SELECT id, agent_id, access_scope, category, content, is_always_active, created_at
        FROM agent_persona
        WHERE agent_id = ${agentId}
        ORDER BY category ASC
      `;
    });
    return rows as PersonaEntry[];
  } catch (err) {
    console.error("[PERSONA] List failed:", err);
    throw err;
  }
}

// =============================================================================
// GET
// =============================================================================

export async function getPersona(agentId: string, personaId: string): Promise<PersonaEntry | null> {
  try {
    const rows = await getSql().begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;
      return await tx`
        SELECT id, agent_id, access_scope, category, content, is_always_active, created_at
        FROM agent_persona
        WHERE id = ${personaId} AND agent_id = ${agentId}
      `;
    });
    return rows.length > 0 ? (rows[0] as PersonaEntry) : null;
  } catch (err) {
    console.error("[PERSONA] Get failed:", err);
    throw err;
  }
}

// =============================================================================
// CREATE
// =============================================================================

export async function createPersona(
  agentId: string,
  data: PersonaCreate,
): Promise<PersonaEntry> {
  const validated = PersonaCreateSchema.parse(data);
  const embedding = await getEmbedding(validated.content);

  const rows = await getSql().begin(async (tx: any) => {
    await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;
    return await tx`
      INSERT INTO agent_persona (
        agent_id, access_scope, category, content, is_always_active, embedding
      ) VALUES (
        ${agentId}, ${validated.access_scope}, ${validated.category},
        ${validated.content}, ${validated.is_always_active},
        ${JSON.stringify(embedding)}
      )
      ON CONFLICT (agent_id, category)
      DO UPDATE SET
        content = EXCLUDED.content,
        embedding = EXCLUDED.embedding,
        is_always_active = EXCLUDED.is_always_active,
        access_scope = EXCLUDED.access_scope
      RETURNING id, agent_id, access_scope, category, content, is_always_active, created_at
    `;
  });

  console.log(`[PERSONA] Created/updated: "${validated.category}"`);
  return rows[0] as PersonaEntry;
}

// =============================================================================
// UPDATE
// =============================================================================

export async function updatePersona(
  agentId: string,
  personaId: string,
  data: PersonaUpdate,
): Promise<PersonaEntry | null> {
  const validated = PersonaUpdateSchema.parse(data);

  // If content changed, regenerate embedding
  let newEmbedding: number[] | null = null;
  if (validated.content) {
    newEmbedding = await getEmbedding(validated.content);
  }

  const rows = await getSql().begin(async (tx: any) => {
    await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;

    // Build dynamic update
    const current = await tx`
      SELECT * FROM agent_persona WHERE id = ${personaId} AND agent_id = ${agentId}
    `;
    if (current.length === 0) return [];

    const category = validated.category ?? current[0].category;
    const content = validated.content ?? current[0].content;
    const isActive = validated.is_always_active ?? current[0].is_always_active;
    const scope = validated.access_scope ?? current[0].access_scope;
    const embedding = newEmbedding ? JSON.stringify(newEmbedding) : current[0].embedding;

    return await tx`
      UPDATE agent_persona
      SET category = ${category},
          content = ${content},
          is_always_active = ${isActive},
          access_scope = ${scope},
          embedding = ${embedding}
      WHERE id = ${personaId} AND agent_id = ${agentId}
      RETURNING id, agent_id, access_scope, category, content, is_always_active, created_at
    `;
  });

  if (rows.length === 0) return null;
  console.log(`[PERSONA] Updated: ${personaId.substring(0, 8)}`);
  return rows[0] as PersonaEntry;
}

// =============================================================================
// DELETE
// =============================================================================

export async function deletePersona(agentId: string, personaId: string): Promise<boolean> {
  try {
    const result = await getSql().begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;
      return await tx`
        DELETE FROM agent_persona
        WHERE id = ${personaId} AND agent_id = ${agentId}
        RETURNING id
      `;
    });
    if (result.length > 0) {
      console.log(`[PERSONA] Deleted: ${personaId.substring(0, 8)}`);
      return true;
    }
    return false;
  } catch (err) {
    console.error("[PERSONA] Delete failed:", err);
    throw err;
  }
}

// =============================================================================
// PERSONA ↔ MEMORY LINKING
// =============================================================================

export interface PersonaLink {
  id: string;
  persona_id: string;
  memory_id: string;
  persona_category: string;
  memory_content: string;
  relationship_type: string;
  weight: number;
  created_at: string;
}

/**
 * Link a persona trait to a memory via entity_edges.
 */
export async function linkPersonaToMemory(
  agentId: string,
  personaId: string,
  memoryId: string,
  relationship: string,
  weight: number = 1.0,
): Promise<{ id: string | null; status: string }> {
  try {
    const rows = await getSql().begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;
      return await tx`
        INSERT INTO entity_edges (
          agent_id, source_persona_id, target_memory_id, relationship_type, weight
        ) VALUES (
          ${agentId}, ${personaId}, ${memoryId}, ${relationship}, ${weight}
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
    });
    if (rows.length === 0) {
      return { id: null, status: "already_exists" };
    }
    console.log(`[PERSONA] Linked persona ${personaId.substring(0, 8)} → memory ${memoryId.substring(0, 8)}`);
    return { id: rows[0].id, status: "linked" };
  } catch (err) {
    console.error("[PERSONA] Link failed:", err);
    return { id: null, status: `error: ${err}` };
  }
}

/**
 * Remove a persona↔memory link.
 */
export async function unlinkPersonaFromMemory(
  agentId: string,
  edgeId: string,
): Promise<boolean> {
  try {
    const rows = await getSql().begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;
      return await tx`
        DELETE FROM entity_edges
        WHERE id = ${edgeId}
          AND agent_id = ${agentId}
          AND (source_persona_id IS NOT NULL OR target_persona_id IS NOT NULL)
        RETURNING id
      `;
    });
    return rows.length > 0;
  } catch (err) {
    console.error("[PERSONA] Unlink failed:", err);
    throw err;
  }
}

/**
 * Get all edges connected to a persona trait.
 */
export async function getPersonaLinks(
  agentId: string,
  personaId: string,
): Promise<PersonaLink[]> {
  try {
    const rows = await getSql().begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;
      return await tx`
        SELECT e.id, e.source_persona_id AS persona_id, e.target_memory_id AS memory_id,
               p.category AS persona_category, m.content AS memory_content,
               e.relationship_type, e.weight, e.created_at
        FROM entity_edges e
        LEFT JOIN agent_persona p ON e.source_persona_id = p.id
        LEFT JOIN memory_semantic m ON e.target_memory_id = m.id
        WHERE e.agent_id = ${agentId}
          AND (e.source_persona_id = ${personaId} OR e.target_persona_id = ${personaId})
        ORDER BY e.created_at DESC
      `;
    });
    return rows as PersonaLink[];
  } catch (err) {
    console.error("[PERSONA] Get links failed:", err);
    throw err;
  }
}

