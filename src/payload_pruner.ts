// src/payload_pruner.ts

export function prunePayload(body: any): any {
  if (!body.messages || !Array.isArray(body.messages)) return body;

  const lastUserIndex = body.messages.findLastIndex((m: any) => m.role === "user");
  let userText = "";
  if (lastUserIndex !== -1) {
    const lastMessage = body.messages[lastUserIndex];
    if (typeof lastMessage.content === "string") {
      userText = lastMessage.content.toLowerCase();
    } else if (Array.isArray(lastMessage.content)) {
      userText = lastMessage.content
        .filter((part: any) => part.type === "text")
        .map((part: any) => part.text)
        .join(" ")
        .toLowerCase();
    }
  }

  // ====================================================================
  // 1. ABSOLUTE MINIMUM SYSTEM PROMPT PRUNING
  // ====================================================================
  const systemIndex = body.messages.findIndex((m: any) => m.role === "system");
  if (systemIndex !== -1 && typeof body.messages[systemIndex].content === "string") {
    let sysPrompt = body.messages[systemIndex].content;

    // 1. Nuke all default Tooling, Safety, and Skills rules
    sysPrompt = sysPrompt.replace(/## Tooling[\s\S]*?(?=## Workspace)/g, "");

    // 2. Nuke default Documentation and Time rules
    sysPrompt = sysPrompt.replace(/## Documentation[\s\S]*?(?=## Inbound Context)/g, "");

    // 3. Nuke the ENTIRE Project Context (all injected Markdown files)
    sysPrompt = sysPrompt.replace(/# Project Context[\s\S]*?(?=## Silent Replies)/g, "");

    // 4. Conditional Heartbeat Pruning
    const isHeartbeat = userText.includes("heartbeat") || userText.includes("cron");
    if (!isHeartbeat) {
      sysPrompt = sysPrompt.replace(/## Heartbeats[\s\S]*?(?=## Runtime)/g, "");
    }

    // Clean up excess whitespace
    sysPrompt = sysPrompt.replace(/\n{3,}/g, "\n\n");

    // 5. Inject Lean Memory Instructions (Using Dynamic Agent ID)
    const agentId = Deno.env.get("AGENT_ID") || "openclaw-proto-1";
    const memoryRules = `
      ## Autonomous Cognitive Architecture
      You are a stateful, proactive agent. Your context window is ephemeral, but your PostgreSQL memory is permanent. 
      CRITICAL DIRECTIVE: You must actively and silently manage your own knowledge base. Do NOT ask the user for permission to save, link, or update facts. If you learn something, act on it immediately using your \`exec\` tool.

      1. **AUTOMATIC RETRIEVAL:** Relevant past memories (with UUID tags) are automatically injected into your prompt. Do not attempt to search for them.
      2. **PROACTIVE LEARNING:** If the user reveals a new preference, project detail, or durable fact, you MUST permanently save it:
        deno run -A /home/cl/.openclaw/workspace/skills/db-memory-store/script.ts "openclaw-proto-1" "global" "<exact_text_to_remember>"
      3. **GRAPH LINKING:** If a newly learned fact relates to an older memory ID currently in your context, explicitly connect them:
        deno run -A /home/cl/.openclaw/workspace/skills/db-memory-link/script.ts "<source_id>" "<target_id>" "<relationship>"
      4. **MEMORY CORRECTION:** If the user corrects you, or a fact changes, you MUST deprecate the old memory ID and establish the new truth:
        deno run -A /home/cl/.openclaw/workspace/skills/db-memory-update/script.ts "<old_memory_id>" "<new_corrected_fact>"
      `;
    sysPrompt += memoryRules;

    const denoLocation = `
      ## Deno Location
      Deno is installed at: /home/cl/.deno/bin/deno
      `;
    sysPrompt += denoLocation;

    const sleepCycle = `
      ## Sleep Cycle
      You are equipped with a sleep cycle that consolidates your short-term memory into durable facts.
      When you receive a user prompt, you should proactively run the sleep cycle to extract durable facts.
      
      To run the sleep cycle, use your \`exec\` tool to run this exact command:
      deno run --allow-net --allow-env /home/cl/.openclaw/workspace/scripts/sleep_cycle.ts "${agentId}"
      `;
    sysPrompt += sleepCycle;

    const heartbeats = `
      ## Autonomous Heartbeats
      OpenClaw provides a native background heartbeat loop. NEVER use Linux crontab.
      To schedule future work or background tasks, use your file tools to add a checklist to: /home/cl/.openclaw/workspace/HEARTBEAT.md
      When you receive a heartbeat poll, read that file. If you have no pending tasks, reply with ONLY: HEARTBEAT_OK
      `;
    sysPrompt += heartbeats;

    const toolStore = `
      ## Tool Store
      You are equipped with a tool store that allows you to store and retrieve tools for later use.
      To store a tool, use your \`exec\` tool to run this exact command:
      deno run --allow-net --allow-env /home/cl/.openclaw/workspace/skills/db-tool-store/script.ts "${agentId}" "<private|global>" "<tool_name>" "<tool_json>"
      `;
    sysPrompt += toolStore;

    body.messages[systemIndex].content = sysPrompt;
  } 

  // ====================================================================
  // 2. STRIP ALL NON-CORE TOOLS (Proxy will dynamically re-inject them)
  // ====================================================================
  if (body.tools && Array.isArray(body.tools)) {
    const coreTools = ["read", "write", "edit", "exec", "process", "session_status"];
    const originalToolCount = body.tools.length;
    
    // Nuke everything except the core toolkit
    body.tools = body.tools.filter((t: any) => coreTools.includes(t.function.name));
    
    console.log(`[PRUNER] Stripped tools from ${originalToolCount} down to ${body.tools.length} core tools.`);
  }

  return body;
}