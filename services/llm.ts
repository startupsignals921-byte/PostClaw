/**
 * Shared LLM helper — routes chat completion requests through the OpenClaw
 * agent CLI (`openclaw agent --agent main --message "..." --json`).
 *
 * This means all LLM calls automatically use whatever primary model is
 * configured in openclaw.json (e.g. google/gemini-flash-lite-latest).
 */

import { execFile } from "child_process";
import { OpenClawAgentResponseSchema } from "../schemas/validation.js";

// ─── LLM via OpenClaw Agent CLI ─────────────────────────────────────────────

/**
 * Send a prompt to the configured primary model by shelling out to the
 * OpenClaw agent CLI. Returns the raw assistant response text with
 * chain-of-thought and markdown fences stripped.
 *
 * @param prompt  Combined system + user prompt (the CLI only takes a
 *                single --message, so the caller should merge them).
 * @param agentId Agent to run as (default: "main").
 */
export async function callLLMviaAgent(
  prompt: string,
  agentId = "main",
): Promise<string> {
  const taggedPrompt = `[POSTCLAW_INTERNAL_LLM_CALL_DO_NOT_LOG]\n\n${prompt}`;
  const args = [
    "agent",
    "--agent", agentId,
    "--session-id", `postclaw-internal-${agentId}`,
    "--message", taggedPrompt,
    "--json",
  ];

  const result = await new Promise<string>((resolve, reject) => {
    execFile("openclaw", args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message;
        if (err.message.includes("ENOENT")) {
          reject(new Error(
            `'openclaw' CLI not found on PATH. Make sure OpenClaw is installed.`
          ));
        } else {
          reject(new Error(`openclaw agent failed: ${msg}`));
        }
        return;
      }
      resolve(stdout);
    });
  });

  // Parse the JSON output from `openclaw agent --json`
  // Structure: { status, result: { payloads: [{ text }] } }
  let text = "";
  try {
    const raw: unknown = JSON.parse(result);
    const parsed = OpenClawAgentResponseSchema.safeParse(raw);

    if (!parsed.success) {
      // Not valid JSON structure — fall through to raw text handling
      throw new Error("Invalid JSON structure");
    }

    if (parsed.data.status !== "ok") {
      throw new Error(`openclaw agent returned status "${parsed.data.status}": ${parsed.data.summary || ""}`);
    }

    text = parsed.data.result?.payloads?.[0]?.text ?? "";
    if (!text) {
      console.warn("openclaw agent returned empty text payload. Returning empty string instead of throwing.");
      return "";
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith("openclaw agent")) throw e;
    // Not valid JSON — use raw output, stripping ANSI codes and CLI chrome
    text = result
      .replace(/\x1b\[[0-9;]*m/g, "")   // strip ANSI color codes
      .replace(/^.*?◇\s*/s, "")          // strip everything before ◇
      .replace(/HEARTBEAT_OK\s*$/s, "")  // strip trailing heartbeat
      .trim();
  }

  // Strip <think>...</think> chain-of-thought blocks
  text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

  // Strip markdown code blocks
  if (text.startsWith("```json")) {
    text = text.replace(/^```json\n/, "").replace(/\n```$/, "");
  }
  if (text.startsWith("```")) {
    text = text.replace(/^```\n/, "").replace(/\n```$/, "");
  }

  return text;
}
