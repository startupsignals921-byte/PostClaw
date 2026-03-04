/**
 * PostClaw Dashboard — Frontend Application
 *
 * Tab management, API calls, DOM updates, D3 knowledge graph.
 */

// =============================================================================
// STATE
// =============================================================================

let currentAgent = "main";
let memoryPage = 0;
const PAGE_SIZE = 50;

// =============================================================================
// UTILITIES
// =============================================================================

function $(id) { return document.getElementById(id); }

async function api(method, path, body = null) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${path}${sep}agentId=${encodeURIComponent(currentAgent)}`;
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "API error");
  return data.data;
}

function toast(message, type = "info") {
  const container = $("toast-container");
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function tierBadge(tier) {
  return `<span class="badge badge-${tier || 'daily'}">${tier || "daily"}</span>`;
}

function boolBadge(val) {
  return `<span class="badge badge-${val}">${val ? "✓" : "✗"}</span>`;
}

function truncate(str, len = 80) {
  if (!str) return "";
  return str.length > len ? str.substring(0, len) + "…" : str;
}

// =============================================================================
// TAB MANAGEMENT
// =============================================================================

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    $(`tab-${btn.dataset.tab}`).classList.add("active");

    // Load data for the active tab
    if (btn.dataset.tab === "personas") loadPersonas();
    if (btn.dataset.tab === "memories") loadMemories();
    if (btn.dataset.tab === "graph") loadGraph();
    if (btn.dataset.tab === "config") loadConfig();
  });
});

// =============================================================================
// AGENT SELECTOR
// =============================================================================

async function loadAgents() {
  try {
    const agents = await api("GET", "/api/agents");
    const select = $("agent-select");
    select.innerHTML = "";
    agents.forEach(a => {
      const opt = document.createElement("option");
      opt.value = a.id;
      opt.textContent = a.name || a.id;
      if (a.id === currentAgent) opt.selected = true;
      select.appendChild(opt);
    });
  } catch { /* agents table might be empty */ }
}

$("agent-select").addEventListener("change", (e) => {
  currentAgent = e.target.value;
  // Reload active tab
  const activeTab = document.querySelector(".tab-btn.active");
  if (activeTab) activeTab.click();
});

// =============================================================================
// PERSONAS
// =============================================================================

async function loadPersonas() {
  try {
    const personas = await api("GET", "/api/personas");
    const container = $("persona-list");
    if (personas.length === 0) {
      container.innerHTML = '<p class="hint">No persona entries yet. Create one above.</p>';
      return;
    }
    container.innerHTML = `
      <table class="data-table">
        <thead><tr>
          <th>Category</th><th>Content</th><th>Always Active</th><th>Actions</th>
        </tr></thead>
        <tbody>${personas.map(p => `
          <tr>
            <td><strong>${p.category}</strong></td>
            <td title="${p.content.replace(/"/g, '&quot;')}">${truncate(p.content, 120)}</td>
            <td>${boolBadge(p.is_always_active)}</td>
            <td class="actions">
              <button class="btn-sm btn-secondary" onclick="editPersona('${p.id}')">✏️</button>
              <button class="btn-sm btn-danger" onclick="deletePersonaRow('${p.id}', '${p.category}')">🗑️</button>
            </td>
          </tr>
        `).join("")}</tbody>
      </table>`;
  } catch (err) { toast(err.message, "error"); }
}

// Store personas data for editing
let _personasCache = [];

async function editPersona(id) {
  try {
    const persona = await api("GET", `/api/personas/${id}`);
    $("persona-form-id").value = id;
    $("persona-category").value = persona.category;
    $("persona-content").value = persona.content;
    $("persona-always-active").checked = persona.is_always_active;
    $("persona-form").style.display = "block";
  } catch (err) { toast(err.message, "error"); }
}
window.editPersona = editPersona;

async function deletePersonaRow(id, category) {
  if (!confirm(`Delete persona "${category}"?`)) return;
  try {
    await api("DELETE", `/api/personas/${id}`);
    toast("Persona deleted", "success");
    loadPersonas();
  } catch (err) { toast(err.message, "error"); }
}
window.deletePersonaRow = deletePersonaRow;

$("btn-new-persona").addEventListener("click", () => {
  $("persona-form-id").value = "";
  $("persona-category").value = "";
  $("persona-content").value = "";
  $("persona-always-active").checked = false;
  $("persona-form").style.display = "block";
});

$("btn-cancel-persona").addEventListener("click", () => {
  $("persona-form").style.display = "none";
});

$("btn-save-persona").addEventListener("click", async () => {
  const id = $("persona-form-id").value;
  const data = {
    category: $("persona-category").value,
    content: $("persona-content").value,
    is_always_active: $("persona-always-active").checked,
  };
  try {
    if (id) {
      await api("PUT", `/api/personas/${id}`, data);
      toast("Persona updated", "success");
    } else {
      await api("POST", "/api/personas", data);
      toast("Persona created", "success");
    }
    $("persona-form").style.display = "none";
    loadPersonas();
  } catch (err) { toast(err.message, "error"); }
});

// Workspace files
async function loadWorkspaceFiles() {
  try {
    const files = await api("GET", "/api/workspace-files");
    const container = $("workspace-files");
    if (files.length === 0) {
      container.innerHTML = '<span class="hint">No .md files found in workspace</span>';
      return;
    }
    container.innerHTML = files.map(f =>
      `<button class="workspace-file-btn" onclick="loadWorkspaceFile('${f.name}')">${f.name}</button>`
    ).join("");
  } catch { /* workspace might not be configured */ }
}
window.loadWorkspaceFile = async function(filename) {
  try {
    const file = await api("GET", `/api/workspace-files/${filename}`);
    $("workspace-content").textContent = file.content;
    $("workspace-content").style.display = "block";
  } catch (err) { toast(err.message, "error"); }
};

// =============================================================================
// MEMORIES
// =============================================================================

async function loadMemories() {
  const search = $("memory-search").value;
  const tier = $("memory-tier-filter").value;
  const archived = $("memory-archived-filter").value;

  let params = `limit=${PAGE_SIZE}&offset=${memoryPage * PAGE_SIZE}`;
  if (search) params += `&search=${encodeURIComponent(search)}`;
  if (tier) params += `&tier=${tier}`;
  if (archived) params += `&archived=${archived}`;

  try {
    const result = await api("GET", `/api/memories?${params}`);
    const container = $("memory-list");
    const memories = result.memories;
    if (memories.length === 0) {
      container.innerHTML = '<p class="hint">No memories found.</p>';
      $("memory-pagination").innerHTML = "";
      return;
    }
    container.innerHTML = `
      <table class="data-table">
        <thead><tr>
          <th>Content</th><th>Category</th><th>Tier</th><th>Access</th><th>Actions</th>
        </tr></thead>
        <tbody>${memories.map(m => `
          <tr>
            <td title="${(m.content || '').replace(/"/g, '&quot;')}">${truncate(m.content, 100)}</td>
            <td>${m.category || "—"}</td>
            <td>${tierBadge(m.tier)}</td>
            <td>${m.access_count || 0}</td>
            <td class="actions">
              <button class="btn-sm btn-secondary" onclick="editMemory('${m.id}')">✏️</button>
              <button class="btn-sm btn-danger" onclick="archiveMemory('${m.id}')">🗑️</button>
            </td>
          </tr>
        `).join("")}</tbody>
      </table>`;

    // Pagination
    const totalPages = Math.ceil(result.total / PAGE_SIZE);
    $("memory-pagination").innerHTML = totalPages > 1
      ? `<button class="btn-sm btn-secondary" ${memoryPage === 0 ? "disabled" : ""} onclick="memPrev()">← Prev</button>
         <span>Page ${memoryPage + 1} of ${totalPages} (${result.total} total)</span>
         <button class="btn-sm btn-secondary" ${memoryPage >= totalPages - 1 ? "disabled" : ""} onclick="memNext()">Next →</button>`
      : `<span>${result.total} memories</span>`;
  } catch (err) { toast(err.message, "error"); }
}

window.memPrev = () => { if (memoryPage > 0) { memoryPage--; loadMemories(); } };
window.memNext = () => { memoryPage++; loadMemories(); };

window.editMemory = async function(id) {
  try {
    const result = await api("GET", `/api/memories?limit=1&search=`);
    const mem = result.memories.find(m => m.id === id);
    if (!mem) return toast("Memory not found", "error");
    $("memory-form-id").value = id;
    $("memory-content").value = mem.content;
    $("memory-category").value = mem.category || "";
    $("memory-tier").value = mem.tier || "daily";
    $("memory-form").style.display = "block";
  } catch (err) { toast(err.message, "error"); }
};

window.archiveMemory = async function(id) {
  if (!confirm("Archive this memory?")) return;
  try {
    await api("DELETE", `/api/memories/${id}`);
    toast("Memory archived", "success");
    loadMemories();
  } catch (err) { toast(err.message, "error"); }
};

$("btn-new-memory").addEventListener("click", () => {
  $("memory-form-id").value = "";
  $("memory-content").value = "";
  $("memory-category").value = "";
  $("memory-tier").value = "daily";
  $("memory-form").style.display = "block";
  $("import-form").style.display = "none";
});

$("btn-cancel-memory").addEventListener("click", () => {
  $("memory-form").style.display = "none";
});

$("btn-save-memory").addEventListener("click", async () => {
  const id = $("memory-form-id").value;
  const data = {
    content: $("memory-content").value,
    category: $("memory-category").value || undefined,
    tier: $("memory-tier").value,
  };
  try {
    if (id) {
      await api("PUT", `/api/memories/${id}`, data);
      toast("Memory updated", "success");
    } else {
      await api("POST", "/api/memories", data);
      toast("Memory created", "success");
    }
    $("memory-form").style.display = "none";
    loadMemories();
  } catch (err) { toast(err.message, "error"); }
});

// Import
$("btn-import-memory").addEventListener("click", () => {
  $("import-form").style.display = "block";
  $("memory-form").style.display = "none";
});
$("btn-cancel-import").addEventListener("click", () => {
  $("import-form").style.display = "none";
});
$("btn-run-import").addEventListener("click", async () => {
  const content = $("import-content").value;
  const filename = $("import-filename").value;
  if (!content.trim()) return toast("No content to import", "error");
  try {
    const result = await api("POST", "/api/memories/import", {
      content, source_filename: filename || undefined,
    });
    toast(`Imported ${result.imported} chunks`, "success");
    $("import-form").style.display = "none";
    loadMemories();
  } catch (err) { toast(err.message, "error"); }
});

// Filter listeners
$("memory-search").addEventListener("input", debounce(() => { memoryPage = 0; loadMemories(); }, 300));
$("memory-tier-filter").addEventListener("change", () => { memoryPage = 0; loadMemories(); });
$("memory-archived-filter").addEventListener("change", () => { memoryPage = 0; loadMemories(); });

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// =============================================================================
// KNOWLEDGE GRAPH (D3.js)
// =============================================================================

let graphSimulation = null;
let graphZoom = null;
let graphLabelsVisible = true;

async function loadGraph() {
  try {
    const data = await api("GET", "/api/graph");
    renderGraph(data);
    $("graph-stats").textContent = `${data.nodes.length} nodes, ${data.edges.length} edges`;
  } catch (err) { toast(err.message, "error"); }
}

function renderGraph(data) {
  const svg = d3.select("#graph-svg");
  svg.selectAll("*").remove();

  const container = $("graph-container");
  const width = container.clientWidth;
  const height = container.clientHeight;

  svg.attr("viewBox", [0, 0, width, height]);

  // ── Defs: glow filters + arrowhead markers ──
  const defs = svg.append("defs");

  // Glow filter
  const glow = defs.append("filter").attr("id", "glow");
  glow.append("feGaussianBlur").attr("stdDeviation", "3").attr("result", "color");
  glow.append("feMerge").selectAll("feMergeNode")
    .data(["color", "SourceGraphic"])
    .join("feMergeNode").attr("in", d => d);

  // Tier colors
  const tierColor = {
    permanent: "#4ade80", stable: "#4f9cf7", daily: "#f7b955",
    session: "#a78bfa", volatile: "#f7555a",
  };

  // Relationship colors
  const relColor = {
    related_to: "#6b7280", elaborates: "#4f9cf7", contradicts: "#f7555a",
    depends_on: "#f7b955", part_of: "#a78bfa",
  };

  // Arrowhead markers for each relationship
  Object.entries(relColor).forEach(([rel, color]) => {
    defs.append("marker")
      .attr("id", `arrow-${rel}`)
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 20)
      .attr("refY", 0)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-5L10,0L0,5")
      .attr("fill", color)
      .attr("opacity", 0.6);
  });

  // ── Zoom behavior ──
  const world = svg.append("g").attr("class", "graph-world");

  graphZoom = d3.zoom()
    .scaleExtent([0.1, 6])
    .on("zoom", (event) => {
      world.attr("transform", event.transform);
    });

  svg.call(graphZoom);
  // Disable double-click zoom (conflicts with node interaction)
  svg.on("dblclick.zoom", null);

  // ── Force simulation ──
  if (graphSimulation) graphSimulation.stop();

  const nodeCount = data.nodes.length;
  const chargeStrength = nodeCount > 100 ? -60 : nodeCount > 50 ? -80 : -100;
  const linkDist = nodeCount > 100 ? 80 : 120;

  graphSimulation = d3.forceSimulation(data.nodes)
    .force("link", d3.forceLink(data.edges).id(d => d.id).distance(linkDist))
    .force("charge", d3.forceManyBody().strength(chargeStrength))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force("collision", d3.forceCollide().radius(d => nodeRadius(d) + 4))
    .force("x", d3.forceX(width / 2).strength(0.06))
    .force("y", d3.forceY(height / 2).strength(0.06))
    .alphaDecay(0.03);

  // ── Edges ──
  const link = world.append("g").attr("class", "graph-edges")
    .selectAll("line")
    .data(data.edges)
    .join("line")
    .attr("class", "graph-edge")
    .attr("stroke", d => relColor[d.relationship] || "#6b7280")
    .attr("stroke-width", d => Math.max(0.5, Math.sqrt(d.weight || 1)))
    .attr("marker-end", d => `url(#arrow-${d.relationship || "related_to"})`);

  // Edge labels
  const linkLabel = world.append("g").attr("class", "graph-edge-labels")
    .selectAll("text")
    .data(data.edges)
    .join("text")
    .attr("class", "graph-edge-label")
    .text(d => d.relationship || "");

  // ── Nodes ──
  const node = world.append("g").attr("class", "graph-nodes")
    .selectAll("g")
    .data(data.nodes)
    .join("g")
    .attr("class", "graph-node")
    .call(d3.drag()
      .on("start", dragStart)
      .on("drag", dragging)
      .on("end", dragEnd));

  // Outer glow ring
  node.append("circle")
    .attr("class", "node-glow")
    .attr("r", d => nodeRadius(d) + 4)
    .attr("fill", "none")
    .attr("stroke", d => tierColor[d.tier] || "#6b7280")
    .attr("stroke-width", 2)
    .attr("stroke-opacity", 0.15)
    .attr("filter", "url(#glow)");

  // Main circle
  node.append("circle")
    .attr("class", "node-circle")
    .attr("r", d => nodeRadius(d))
    .attr("fill", d => tierColor[d.tier] || "#6b7280")
    .attr("stroke", "rgba(255,255,255,0.15)")
    .attr("stroke-width", 1.5);

  // Labels
  node.append("text")
    .attr("class", "node-label")
    .text(d => d.label ? d.label.substring(0, 30) : "")
    .attr("dx", d => nodeRadius(d) + 5)
    .attr("dy", 4)
    .style("display", graphLabelsVisible ? "block" : "none");

  // Click → detail panel
  node.on("click", (_event, d) => {
    showGraphDetail(d);
    // Highlight selected
    node.selectAll(".node-circle").attr("stroke", "rgba(255,255,255,0.15)").attr("stroke-width", 1.5);
    d3.select(_event.currentTarget).select(".node-circle").attr("stroke", "#fff").attr("stroke-width", 3);
  });

  // Hover tooltip
  node.on("mouseenter", function(_event, d) {
    d3.select(this).select(".node-label").style("display", "block");
  }).on("mouseleave", function() {
    if (!graphLabelsVisible) d3.select(this).select(".node-label").style("display", "none");
  });

  // ── Legend ──
  renderGraphLegend(tierColor);

  // ── Tick ──
  graphSimulation.on("tick", () => {
    link
      .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
      .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
    linkLabel
      .attr("x", d => (d.source.x + d.target.x) / 2)
      .attr("y", d => (d.source.y + d.target.y) / 2);
    node.attr("transform", d => `translate(${d.x},${d.y})`);
  });

  // Auto-fit after simulation stabilizes
  graphSimulation.on("end", () => {
    fitGraphToView(data.nodes, width, height);
  });

  function dragStart(event, d) {
    if (!event.active) graphSimulation.alphaTarget(0.3).restart();
    d.fx = d.x; d.fy = d.y;
  }
  function dragging(event, d) { d.fx = event.x; d.fy = event.y; }
  function dragEnd(event, d) {
    if (!event.active) graphSimulation.alphaTarget(0);
    d.fx = null; d.fy = null;
  }
}

function nodeRadius(d) {
  return Math.max(5, Math.min(14, 4 + Math.sqrt(d.accessCount || 1) * 2));
}

function fitGraphToView(nodes, width, height) {
  if (!nodes || nodes.length === 0 || !graphZoom) return;
  const svg = d3.select("#graph-svg");

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  nodes.forEach(d => {
    if (d.x < minX) minX = d.x;
    if (d.x > maxX) maxX = d.x;
    if (d.y < minY) minY = d.y;
    if (d.y > maxY) maxY = d.y;
  });

  const padding = 60;
  const graphWidth = maxX - minX + padding * 2;
  const graphHeight = maxY - minY + padding * 2;
  const scale = Math.min(width / graphWidth, height / graphHeight, 2);
  const tx = width / 2 - (minX + maxX) / 2 * scale;
  const ty = height / 2 - (minY + maxY) / 2 * scale;

  svg.transition().duration(500)
    .call(graphZoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
}

function renderGraphLegend(tierColor) {
  const legendContainer = $("graph-legend");
  if (!legendContainer) return;
  legendContainer.innerHTML = Object.entries(tierColor).map(([tier, color]) =>
    `<span class="legend-item"><span class="legend-dot" style="background:${color}"></span>${tier}</span>`
  ).join("");
}

function showGraphDetail(d) {
  const panel = $("graph-detail");
  if (!panel) return;
  panel.style.display = "block";
  panel.innerHTML = `
    <div class="detail-header">
      <span class="badge badge-${d.tier || 'daily'}">${d.tier || "daily"}</span>
      <span class="detail-category">${d.category || "uncategorized"}</span>
      <button class="btn-sm btn-secondary" onclick="this.closest('.graph-detail-panel').style.display='none'">✕</button>
    </div>
    <p class="detail-content">${d.label || "—"}</p>
    <div class="detail-stats">
      <span>Access: <strong>${d.accessCount || 0}</strong></span>
      <span>Score: <strong>${(d.score || 0).toFixed(2)}</strong></span>
      <span class="detail-id">${d.id}</span>
    </div>
  `;
}

// Controls
$("btn-refresh-graph").addEventListener("click", loadGraph);

$("btn-fit-graph").addEventListener("click", () => {
  if (!graphSimulation) return;
  const container = $("graph-container");
  const nodes = graphSimulation.nodes();
  fitGraphToView(nodes, container.clientWidth, container.clientHeight);
});

$("btn-toggle-labels").addEventListener("click", () => {
  graphLabelsVisible = !graphLabelsVisible;
  d3.selectAll(".node-label").style("display", graphLabelsVisible ? "block" : "none");
  $("btn-toggle-labels").textContent = graphLabelsVisible ? "🏷️ Labels On" : "🏷️ Labels Off";
});


// =============================================================================
// SCRIPTS
// =============================================================================

$("btn-run-sleep").addEventListener("click", async () => {
  const status = $("sleep-status");
  status.textContent = "Running...";
  status.className = "script-status running";
  try {
    await api("POST", "/api/scripts/sleep", { agentId: currentAgent });
    status.textContent = "Sleep cycle started! Check server logs for progress.";
    status.className = "script-status success";
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = "script-status error";
  }
});

$("btn-run-persona-import").addEventListener("click", async () => {
  const file = $("persona-import-file").value;
  if (!file.trim()) return toast("Enter a file path", "error");
  const status = $("persona-import-status");
  status.textContent = "Running...";
  status.className = "script-status running";
  try {
    await api("POST", "/api/scripts/persona-import", { agentId: currentAgent, file });
    status.textContent = "Persona import started! Check server logs for progress.";
    status.className = "script-status success";
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = "script-status error";
  }
});

// =============================================================================
// CONFIGURATION
// =============================================================================

async function loadConfig() {
  try {
    const config = await api("GET", "/api/config");
    
    // RAG
    $("cfg-rag-semantic-limit").value = config.rag.semanticLimit;
    $("cfg-rag-total-limit").value = config.rag.totalLimit;
    $("cfg-rag-linked-similarity").value = config.rag.linkedSimilarity;

    // Persona
    $("cfg-persona-situational-limit").value = config.persona.situationalLimit;
    $("cfg-tools-similarity").value = config.dynamicTools.similarityThreshold;
    $("cfg-tools-max").value = config.dynamicTools.maxTools;

    // Prompts
    $("cfg-prompt-memory").value = config.prompts.memoryRules;
    $("cfg-prompt-persona").value = config.prompts.personaRules;
    $("cfg-prompt-heartbeat").value = config.prompts.heartbeatRules;
    $("cfg-prompt-heartbeat-path").value = config.prompts.heartbeatFilePath;

    // Sleep
    $("cfg-sleep-dedup-threshold").value = config.sleep.duplicateSimilarityThreshold;
    $("cfg-sleep-low-value-age").value = config.sleep.lowValueAgeDays;
    $("cfg-sleep-link-min").value = config.sleep.linkSimilarityMin;
    $("cfg-sleep-link-max").value = config.sleep.linkSimilarityMax;

    // Technical
    $("cfg-dedup-cache").value = config.dedup.maxCacheSize;

  } catch (err) { toast(err.message, "error"); }
}

$("btn-save-config").addEventListener("click", async () => {
  const data = {
    rag: {
      semanticLimit: parseInt($("cfg-rag-semantic-limit").value),
      totalLimit: parseInt($("cfg-rag-total-limit").value),
      linkedSimilarity: parseFloat($("cfg-rag-linked-similarity").value)
    },
    persona: {
      situationalLimit: parseInt($("cfg-persona-situational-limit").value)
    },
    dynamicTools: {
      similarityThreshold: parseFloat($("cfg-tools-similarity").value),
      maxTools: parseInt($("cfg-tools-max").value)
    },
    prompts: {
      memoryRules: $("cfg-prompt-memory").value,
      personaRules: $("cfg-prompt-persona").value,
      heartbeatRules: $("cfg-prompt-heartbeat").value,
      heartbeatFilePath: $("cfg-prompt-heartbeat-path").value
    },
    sleep: {
      // Keep other sleep settings at their defaults if not in UI
      episodicBatchLimit: 100,
      duplicateScanLimit: 200,
      linkCandidatesPerMemory: 5,
      linkBatchSize: 20,
      linkScanLimit: 50,
      lowValueProtectedTiers: ['permanent', 'stable'],
      
      duplicateSimilarityThreshold: parseFloat($("cfg-sleep-dedup-threshold").value),
      lowValueAgeDays: parseInt($("cfg-sleep-low-value-age").value),
      linkSimilarityMin: parseFloat($("cfg-sleep-link-min").value),
      linkSimilarityMax: parseFloat($("cfg-sleep-link-max").value),
    },
    dedup: {
      maxCacheSize: parseInt($("cfg-dedup-cache").value)
    }
  };

  try {
    await api("POST", "/api/config", data);
    toast("Configuration saved!", "success");
    loadConfig();
  } catch (err) { toast(err.message, "error"); }
});

$("btn-reset-config").addEventListener("click", async () => {
  if (!confirm("Reset all settings to defaults?")) return;
  try {
    await api("POST", "/api/config/reset");
    toast("Configuration reset to defaults", "success");
    loadConfig();
  } catch (err) { toast(err.message, "error"); }
});

// =============================================================================
// INIT
// =============================================================================

(async function init() {
  await loadAgents();
  loadPersonas();
  loadWorkspaceFiles();
  loadConfig(); // Pre-load config state
})();
