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
      ## Persistent Memory Engine
      You are equipped with a PostgreSQL vector database. Your context window is ephemeral.
      You MUST proactively save user preferences, architectural rules, and durable facts.

      When saving a memory, you must decide its access scope:
      - "private": Only you can see it (use for agent-specific state or scratchpad notes).
      - "global": All other agents in the swarm can see it (use for universal rules, server IPs, and user preferences).

      To save a memory, use your \`exec\` tool to run this exact command:
      deno run --allow-net --allow-env /home/cl/.openclaw/workspace/skills/db-memory-store/script.ts "${agentId}" "<private|global>" "<exact_text_to_remember>"
      `;
    sysPrompt += memoryRules;

    const denoLocation = `
      ## Deno Location
      Deno is installed at: /home/cl/.deno/bin/deno
      `;
    sysPrompt += denoLocation;

    body.messages[systemIndex].content = sysPrompt;
  } 

  // ====================================================================
  // 2. JIT TOOL FILTERING
  // ====================================================================
  if (body.tools && Array.isArray(body.tools)) {
    const coreTools = ["read", "write", "edit", "exec", "process", "session_status"];
    const activeTools = [...coreTools];

    if (userText.includes("search") || userText.includes("web") || userText.includes("google")) {
      activeTools.push("web_search", "web_fetch");
    }
    if (userText.includes("browser") || userText.includes("chrome") || userText.includes("navigate")) {
      activeTools.push("browser");
    }
    if (userText.includes("message") || userText.includes("discord") || userText.includes("telegram")) {
      activeTools.push("message", "sessions_send", "sessions_list");
    }
    if (userText.includes("canvas") || userText.includes("draw")) {
      activeTools.push("canvas");
    }

    const originalToolCount = body.tools.length;
    body.tools = body.tools.filter((t: any) => activeTools.includes(t.function.name));
    
    console.log(`[PRUNER] Reduced tool schema from ${originalToolCount} to ${body.tools.length} tools.`);
  }

  return body;
}