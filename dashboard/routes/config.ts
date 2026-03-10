import { Router } from "../router.js";
import { parseBody, sendJson, sendError } from "../helpers.js";
import { getCurrentConfig, saveConfig, loadConfig, PostClawConfig } from "../../services/config.js";

export function registerConfigRoutes(router: Router) {
  // GET /api/config — Get current PostClaw configuration
  router.get("/api/config", async (req, res) => {
    try {
      const parsedUrl = new URL(req.url!, "http://localhost");
      const agentId = parsedUrl.searchParams.get("agentId") || "main";
      const config = await loadConfig(agentId);
      sendJson(res, 200, { ok: true, data: config });
    } catch (err) {
      sendError(res, 500, `Failed to get config: ${err}`);
    }
  });

  // POST /api/config — Update PostClaw configuration
  router.post("/api/config", async (req, res) => {
    try {
      const parsedUrl = new URL(req.url!, "http://localhost");
      const agentId = parsedUrl.searchParams.get("agentId") || "main";
      const body = await parseBody<PostClawConfig>(req);
      if (!body) return sendError(res, 400, "Missing request body");

      await saveConfig(agentId, body);
      sendJson(res, 200, { ok: true, data: getCurrentConfig(agentId) });
    } catch (err) {
      sendError(res, 500, `Failed to save config: ${err}`);
    }
  });

  // POST /api/config/reset — Reset to defaults
  router.post("/api/config/reset", async (req, res) => {
    try {
      const parsedUrl = new URL(req.url!, "http://localhost");
      const agentId = parsedUrl.searchParams.get("agentId") || "main";
      // We can reset by simply deleting the config keys for this agent from the DB
      const { getSql } = await import("../../services/db.js");
      const { loadConfig } = await import("../../services/config.js");
      const sql = getSql();
      await sql.begin(async (tx: any) => {
        await tx`SELECT set_config('app.current_agent_id', ${agentId}, true)`;
        await tx`DELETE FROM plugin_config WHERE agent_id = ${agentId}`;
      });

      // Reload defaults into memory
      const config = await loadConfig(agentId);
      sendJson(res, 200, { ok: true, data: config });
    } catch (err) {
      sendError(res, 500, `Failed to reset config: ${err}`);
    }
  });
}
