/**
 * Dashboard API Routes — Workspace & agent endpoints.
 *
 * GET  /api/agents                      — List agents
 * GET  /api/workspace-files             — List .md files from workspace dir
 * GET  /api/workspace-files/:filename   — Read workspace .md file content
 * POST /api/workspace-import            — LLM-powered import of .md file as persona or memory
 */

import { Router } from "../router.js";
import { parseBody, sendJson, sendError } from "../helpers.js";
import { getSql, getEmbedding } from "../../services/db.js";
import { ensureAgent, storeMemory } from "../../services/memoryService.js";
import { callLLMviaAgent } from "../../services/llm.js";
import { readdir, readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { z } from "zod";
import {
  WorkspaceImportSchema,
  PersonaChunkSchema,
} from "../../schemas/validation.js";

// =============================================================================
// REGISTER ROUTES
// =============================================================================

export function registerWorkspaceRoutes(router: Router): void {
  // LIST AGENTS
  router.get("/api/agents", async (_req, res) => {
    try {
      const sql = getSql();
      const rows = await sql`
        SELECT id, name, is_active, created_at FROM agents ORDER BY created_at ASC
      `;
      sendJson(res, 200, { ok: true, data: rows });
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : "Failed to list agents");
    }
  });

  // LIST WORKSPACE .md FILES
  router.get("/api/workspace-files", async (_req, res, ctx) => {
    const agentId = ctx.query.agentId || "main";
    const sql = getSql();

    try {
      const agents = await sql`SELECT workspace_dir FROM agents WHERE id = ${agentId}`;
      const workspaceDir = agents[0]?.workspace_dir;

      if (!workspaceDir) {
        return sendJson(res, 200, { ok: true, data: [] });
      }

      const entries = await readdir(workspaceDir, { withFileTypes: true });
      const mdFiles = entries
        .filter((e) => e.isFile() && extname(e.name).toLowerCase() === ".md")
        .map((e) => ({
          name: e.name,
          path: join(workspaceDir, e.name),
        }));
      sendJson(res, 200, { ok: true, data: mdFiles });
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : "Failed to read workspace");
    }
  });

  // READ WORKSPACE .md FILE
  router.get("/api/workspace-files/:filename", async (_req, res, ctx) => {
    const agentId = ctx.query.agentId || "main";
    const sql = getSql();

    try {
      const agents = await sql`SELECT workspace_dir FROM agents WHERE id = ${agentId}`;
      const workspaceDir = agents[0]?.workspace_dir;

      if (!workspaceDir) {
        return sendError(res, 404, "Workspace directory not configured for this agent");
      }

      const filename = ctx.params.filename;

      // Security: only allow .md files, no path traversal
      if (!filename.endsWith(".md") || filename.includes("..") || filename.includes("/")) {
        return sendError(res, 400, "Only .md files allowed, no path traversal");
      }

      const content = await readFile(join(workspaceDir, filename), "utf-8");
      sendJson(res, 200, { ok: true, data: { name: filename, content } });
    } catch {
      sendError(res, 404, `File not found in workspace`);
    }
  });

  // WORKSPACE IMPORT — LLM-powered import of .md file as persona entries or memory chunks
  router.post("/api/workspace-import", async (req, res, ctx) => {
    const agentId = ctx.query.agentId || "main";
    const body = await parseBody(req);
    if (!body) return sendError(res, 400, "Invalid JSON body");

    try {
      const data = WorkspaceImportSchema.parse(body);
      const sql = getSql();

      // Read the workspace file
      const agents = await sql`SELECT workspace_dir FROM agents WHERE id = ${agentId}`;
      const workspaceDir = agents[0]?.workspace_dir;
      if (!workspaceDir) {
        return sendError(res, 400, "Workspace directory not configured for this agent");
      }

      // Security check
      if (data.filename.includes("..") || data.filename.includes("/")) {
        return sendError(res, 400, "No path traversal allowed");
      }

      const markdownText = await readFile(join(workspaceDir, data.filename), "utf-8");
      await ensureAgent(agentId);

      if (data.target === "persona") {
        // Use LLM to semantically chunk into persona entries (same as bootstrap_persona.ts)
        const systemPrompt = `You are an expert data architect. Break down this Markdown file into discrete, atomic semantic chunks.
Extract the core rules, behaviors, and instructions.

Output your response EXCLUSIVELY as a raw JSON array of objects. Do not use markdown blocks.
Each object must have:
- "category": A short, unique identifier for this rule (max 50 chars, e.g., "communication_style", "discord_rules").
- "content": The actual text of the rule or instruction.
- "is_always_active": Boolean. Set to true ONLY for core identity traits that must be injected into every prompt. Set to false if situational.`;

        const combined = `${systemPrompt}\n\nHere is the file to chunk:\n\n${markdownText}`;
        const jsonString = await callLLMviaAgent(combined);

        let chunks;
        try {
          chunks = z.array(PersonaChunkSchema).parse(JSON.parse(jsonString));
        } catch {
          return sendError(res, 500, "LLM returned invalid persona chunks");
        }

        let stored = 0;
        for (const chunk of chunks) {
          try {
            const embedding = await getEmbedding(chunk.content);
            await sql.begin(async (tx: any) => {
              await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;
              await tx`
                INSERT INTO agent_persona (
                  agent_id, access_scope, category, content, is_always_active, embedding
                ) VALUES (
                  ${agentId}, 'private', ${chunk.category}, ${chunk.content},
                  ${chunk.is_always_active}, ${JSON.stringify(embedding)}
                )
                ON CONFLICT (agent_id, category)
                DO UPDATE SET
                  content = EXCLUDED.content,
                  embedding = EXCLUDED.embedding,
                  is_always_active = EXCLUDED.is_always_active
              `;
            });
            stored++;
          } catch (err) {
            console.error(`[IMPORT] Failed to store persona "${chunk.category}":`, err);
          }
        }

        sendJson(res, 201, {
          ok: true,
          data: { target: "persona", imported: stored, total: chunks.length, filename: data.filename },
        });
      } else {
        // Memory target: use LLM to extract durable facts
        const systemPrompt = `You are a knowledge extraction expert. Extract discrete, atomic facts from this Markdown file.
Each fact should be a standalone piece of knowledge that is worth remembering.

Output your response EXCLUSIVELY as a raw JSON array of strings. Do not use markdown blocks.
Each string should be a single fact or piece of knowledge.`;

        const combined = `${systemPrompt}\n\nHere is the file:\n\n${markdownText}`;
        const jsonString = await callLLMviaAgent(combined);

        let facts: string[];
        try {
          facts = z.array(z.string().min(1)).parse(JSON.parse(jsonString));
        } catch {
          return sendError(res, 500, "LLM returned invalid memory facts");
        }

        const results = [];
        for (const fact of facts) {
          const result = await storeMemory(agentId, fact, "private", {
            tier: data.tier,
            source_uri: data.filename,
            category: "imported",
          });
          results.push(result);
        }

        sendJson(res, 201, {
          ok: true,
          data: {
            target: "memory",
            imported: results.filter((r) => r.status === "stored").length,
            total: facts.length,
            filename: data.filename,
          },
        });
      }
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : "Import failed");
    }
  });
}
