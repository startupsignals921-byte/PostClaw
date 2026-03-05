/**
 * Dashboard API Routes — Memory management endpoints.
 *
 * GET    /api/memories           — List memories (paginated, filterable)
 * POST   /api/memories           — Create memory
 * PUT    /api/memories/:id       — Update memory
 * DELETE /api/memories/:id       — Archive memory
 * POST   /api/memories/import    — Import from markdown content
 */

import { Router } from "../router.js";
import { parseBody, sendJson, sendError } from "../helpers.js";
import { getSql, getEmbedding, hashContent, EMBEDDING_MODEL } from "../../services/db.js";
import { ensureAgent, storeMemory } from "../../services/memoryService.js";
import {
  MemoryListQuerySchema,
  DashboardMemoryCreateSchema,
  DashboardMemoryUpdateSchema,
  MemoryImportSchema,
} from "../../schemas/validation.js";

// =============================================================================
// REGISTER ROUTES
// =============================================================================

export function registerMemoryRoutes(router: Router): void {
  // LIST — paginated, filterable
  router.get("/api/memories", async (_req, res, ctx) => {
    const q = MemoryListQuerySchema.parse(ctx.query);
    const sql = getSql();

    const rows = await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${q.agentId}, true)`;

      // Build dynamic WHERE clauses
      const conditions: string[] = [`agent_id = '${q.agentId}'`];
      if (q.archived === "false") conditions.push("is_archived = false");
      else if (q.archived === "true") conditions.push("is_archived = true");
      if (q.category) conditions.push(`category = '${q.category}'`);
      if (q.tier) conditions.push(`tier = '${q.tier}'`);

      const whereClause = conditions.join(" AND ");
      const searchClause = q.search
        ? `AND content ILIKE '%${q.search.replace(/'/g, "''")}%'`
        : "";

      return await tx.unsafe(`
        SELECT id, content, category, tier, volatility, access_scope,
               access_count, usefulness_score, is_archived, is_pointer,
               confidence, metadata, created_at, updated_at, expires_at
        FROM memory_semantic
        WHERE ${whereClause} ${searchClause}
        ORDER BY created_at DESC
        LIMIT ${q.limit} OFFSET ${q.offset}
      `);
    });

    // Also get total count
    const countResult = await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${q.agentId}, true)`;
      const archived = q.archived === "true" ? true : q.archived === "false" ? false : null;
      if (archived === null) {
        return await tx`SELECT count(*)::int as total FROM memory_semantic WHERE agent_id = ${q.agentId}`;
      }
      return await tx`SELECT count(*)::int as total FROM memory_semantic WHERE agent_id = ${q.agentId} AND is_archived = ${archived}`;
    });

    sendJson(res, 200, {
      ok: true,
      data: { memories: rows, total: countResult[0]?.total || 0 },
    });
  });

  // CREATE
  router.post("/api/memories", async (req, res, ctx) => {
    const agentId = ctx.query.agentId || "main";
    const body = await parseBody(req);
    if (!body) return sendError(res, 400, "Invalid JSON body");

    try {
      const data = DashboardMemoryCreateSchema.parse(body);
      await ensureAgent(agentId);
      const result = await storeMemory(agentId, data.content, data.scope, {
        category: data.category,
        tier: data.tier,
        volatility: data.volatility,
        metadata: data.metadata,
      });
      sendJson(res, 201, { ok: true, data: result });
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : "Create failed");
    }
  });

  // UPDATE
  router.put("/api/memories/:id", async (req, res, ctx) => {
    const agentId = ctx.query.agentId || "main";
    const body = await parseBody(req);
    if (!body) return sendError(res, 400, "Invalid JSON body");

    try {
      const data = DashboardMemoryUpdateSchema.parse(body);
      const sql = getSql();

      const rows = await sql.begin(async (tx: any) => {
        await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;

        const current = await tx`
          SELECT * FROM memory_semantic WHERE id = ${ctx.params.id} AND agent_id = ${agentId}
        `;
        if (current.length === 0) return [];

        // Re-embed if content changed
        let embedding = current[0].embedding;
        let contentHash = current[0].content_hash;
        if (data.content && data.content !== current[0].content) {
          embedding = JSON.stringify(await getEmbedding(data.content));
          contentHash = hashContent(data.content);
        }

        return await tx`
          UPDATE memory_semantic SET
            content = ${data.content ?? current[0].content},
            content_hash = ${contentHash},
            category = ${data.category !== undefined ? data.category : current[0].category},
            tier = ${data.tier ?? current[0].tier},
            volatility = ${data.volatility ?? current[0].volatility},
            is_archived = ${data.is_archived ?? current[0].is_archived},
            metadata = ${data.metadata ? JSON.stringify(data.metadata) : current[0].metadata},
            embedding = ${embedding}
          WHERE id = ${ctx.params.id} AND agent_id = ${agentId}
          RETURNING id, content, category, tier, is_archived
        `;
      });

      if (rows.length === 0) return sendError(res, 404, "Memory not found");
      sendJson(res, 200, { ok: true, data: rows[0] });
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : "Update failed");
    }
  });

  // GET ONE
  router.get("/api/memories/:id", async (_req, res, ctx) => {
    const agentId = ctx.query.agentId || "main";
    const sql = getSql();

    const rows = await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;
      return await tx`
        SELECT id, content, category, tier, access_scope,
               access_count, usefulness_score, is_archived, is_pointer,
               confidence, metadata, created_at, updated_at, expires_at
        FROM memory_semantic
        WHERE id = ${ctx.params.id} AND agent_id = ${agentId}
      `;
    });

    if (rows.length === 0) return sendError(res, 404, "Memory not found");
    sendJson(res, 200, { ok: true, data: rows[0] });
  });

  // EDGES for a specific memory
  router.get("/api/memories/:id/edges", async (_req, res, ctx) => {
    const agentId = ctx.query.agentId || "main";
    const memoryId = ctx.params.id;
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
          AND (e.source_memory_id = ${memoryId} OR e.target_memory_id = ${memoryId})
        ORDER BY e.created_at DESC
      `;
    });

    sendJson(res, 200, { ok: true, data: rows });
  });

  // DELETE (archive)
  router.delete("/api/memories/:id", async (_req, res, ctx) => {
    const agentId = ctx.query.agentId || "main";
    const sql = getSql();

    const rows = await sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;
      return await tx`
        UPDATE memory_semantic SET is_archived = true
        WHERE id = ${ctx.params.id} AND agent_id = ${agentId}
        RETURNING id
      `;
    });

    if (rows.length === 0) return sendError(res, 404, "Memory not found");
    sendJson(res, 200, { ok: true, data: { archived: true } });
  });

  // IMPORT from markdown
  router.post("/api/memories/import", async (req, res, ctx) => {
    const agentId = ctx.query.agentId || "main";
    const body = await parseBody(req);
    if (!body) return sendError(res, 400, "Invalid JSON body");

    try {
      const data = MemoryImportSchema.parse(body);
      await ensureAgent(agentId);

      // Split markdown by headings or double newlines into chunks
      const chunks = data.content
        .split(/(?=^#{1,3}\s)/m)
        .flatMap((section) => section.split(/\n{2,}/))
        .map((s) => s.trim())
        .filter((s) => s.length > 10);

      const results = [];
      for (const chunk of chunks) {
        const result = await storeMemory(agentId, chunk, "private", {
          tier: data.tier,
          source_uri: data.source_filename,
          category: "imported",
        });
        results.push(result);
      }

      sendJson(res, 201, {
        ok: true,
        data: { imported: results.length, chunks: results },
      });
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : "Import failed");
    }
  });
}
