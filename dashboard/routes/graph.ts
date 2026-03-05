/**
 * Dashboard API Routes — Knowledge graph endpoints.
 *
 * GET    /api/graph        — Full graph data for D3 visualization (memories + personas)
 * GET    /api/edges        — List edges
 * POST   /api/edges        — Create edge (memory↔memory or persona↔memory)
 * DELETE /api/edges/:id    — Delete edge
 */

import { Router } from "../router.js";
import { parseBody, sendJson, sendError } from "../helpers.js";
import { getSql } from "../../services/db.js";
import { GraphEdgeCreateSchema } from "../../schemas/validation.js";

// =============================================================================
// REGISTER ROUTES
// =============================================================================

export function registerGraphRoutes(router: Router): void {
  // FULL GRAPH — nodes + edges for D3 force graph (includes persona nodes)
  router.get("/api/graph", async (_req, res, ctx) => {
    const agentId = ctx.query.agentId || "main";
    const sql = getSql();

    const result = await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;

      const memoryNodes = await tx`
        SELECT id, content, category, tier, access_count, usefulness_score, is_archived
        FROM memory_semantic
        WHERE agent_id = ${agentId} AND is_archived = false
        ORDER BY created_at DESC
        LIMIT 200
      `;

      const personaNodes = await tx`
        SELECT id, category, content, is_always_active
        FROM agent_persona
        WHERE agent_id = ${agentId}
      `;

      const edges = await tx`
        SELECT id, source_memory_id, target_memory_id,
               source_persona_id, target_persona_id,
               relationship_type, weight
        FROM entity_edges
        WHERE agent_id = ${agentId}
      `;

      return { memoryNodes, personaNodes, edges };
    });

    // Build node ID set for edge filtering
    const nodeIds = new Set([
      ...result.memoryNodes.map((n: any) => n.id),
      ...result.personaNodes.map((n: any) => n.id),
    ]);

    // Filter to only include edges where both source and target exist in nodes
    const validEdges = result.edges.filter((e: any) => {
      const src = e.source_memory_id || e.source_persona_id;
      const tgt = e.target_memory_id || e.target_persona_id;
      return nodeIds.has(src) && nodeIds.has(tgt);
    });

    sendJson(res, 200, {
      ok: true,
      data: {
        nodes: [
          ...result.memoryNodes.map((n: any) => ({
            id: n.id,
            type: "memory",
            label: n.content.substring(0, 80),
            category: n.category,
            tier: n.tier,
            accessCount: n.access_count,
            score: n.usefulness_score,
          })),
          ...result.personaNodes.map((n: any) => ({
            id: n.id,
            type: "persona",
            label: n.content.substring(0, 80),
            category: n.category,
            tier: n.is_always_active ? "permanent" : "stable",
            accessCount: 0,
            score: 0,
            isAlwaysActive: n.is_always_active,
          })),
        ],
        edges: validEdges.map((e: any) => ({
          id: e.id,
          source: e.source_memory_id || e.source_persona_id,
          target: e.target_memory_id || e.target_persona_id,
          relationship: e.relationship_type,
          weight: e.weight,
          sourceType: e.source_persona_id ? "persona" : "memory",
          targetType: e.target_persona_id ? "persona" : "memory",
        })),
      },
    });
  });

  // LIST EDGES
  router.get("/api/edges", async (_req, res, ctx) => {
    const agentId = ctx.query.agentId || "main";
    const sql = getSql();

    const rows = await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;
      return await tx`
        SELECT e.id, e.source_memory_id, e.target_memory_id,
               e.source_persona_id, e.target_persona_id,
               e.relationship_type, e.weight, e.created_at,
               s.content AS source_content, t.content AS target_content,
               sp.category AS source_persona_category, tp.category AS target_persona_category
        FROM entity_edges e
        LEFT JOIN memory_semantic s ON e.source_memory_id = s.id
        LEFT JOIN memory_semantic t ON e.target_memory_id = t.id
        LEFT JOIN agent_persona sp ON e.source_persona_id = sp.id
        LEFT JOIN agent_persona tp ON e.target_persona_id = tp.id
        WHERE e.agent_id = ${agentId}
        ORDER BY e.created_at DESC
        LIMIT 200
      `;
    });

    sendJson(res, 200, { ok: true, data: rows });
  });

  // CREATE EDGE (supports memory↔memory and persona↔memory)
  router.post("/api/edges", async (req, res, ctx) => {
    const agentId = ctx.query.agentId || "main";
    const body = await parseBody(req);
    if (!body) return sendError(res, 400, "Invalid JSON body");

    try {
      const data = GraphEdgeCreateSchema.parse(body);
      const sql = getSql();

      const rows = await sql.begin(async (tx: any) => {
        await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;
        return await tx`
          INSERT INTO entity_edges (
            agent_id, source_memory_id, target_memory_id,
            source_persona_id, target_persona_id,
            relationship_type, weight
          ) VALUES (
            ${agentId},
            ${data.source_memory_id || null}, ${data.target_memory_id || null},
            ${data.source_persona_id || null}, ${data.target_persona_id || null},
            ${data.relationship_type}, ${data.weight}
          )
          ON CONFLICT DO NOTHING
          RETURNING id
        `;
      });

      if (rows.length === 0) {
        return sendJson(res, 200, { ok: true, data: { status: "already_exists" } });
      }
      sendJson(res, 201, { ok: true, data: { id: rows[0].id } });
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : "Create failed");
    }
  });

  // DELETE EDGE
  router.delete("/api/edges/:id", async (_req, res, ctx) => {
    const agentId = ctx.query.agentId || "main";
    const sql = getSql();

    const rows = await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;
      return await tx`
        DELETE FROM entity_edges
        WHERE id = ${ctx.params.id} AND agent_id = ${agentId}
        RETURNING id
      `;
    });

    if (rows.length === 0) return sendError(res, 404, "Edge not found");
    sendJson(res, 200, { ok: true, data: { deleted: true } });
  });
}
