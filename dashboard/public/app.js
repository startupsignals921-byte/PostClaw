/**
 * PostClaw Dashboard — Frontend application
 *
 * Vanilla JS SPA: tab management, agent selection, CRUD for personas/memories,
 * D3.js knowledge graph with persona nodes, memory linking, workspace import,
 * script runner, and full config editor.
 */

// =============================================================================
// GLOBALS
// =============================================================================

let currentAgent = "main";
const API = "";
let memoryPage = { offset: 0, limit: 50, total: 0 };
let graphInstances = { simulation: null, svg: null, g: null, zoom: null };
let showLabels = true;
let allNodes = [];   // cached for link search
let allEdges = [];   // cached for link search
let shiftLinkState = null; // { sourceNode, line } for shift+drag linking

// =============================================================================
// UTILS
// =============================================================================

async function api(path, opts = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${API}${path}${sep}agentId=${encodeURIComponent(currentAgent)}`;
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  return res.json();
}

function toast(msg, type = "info") {
  const container = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function badge(value, prefix = "badge") {
  return `<span class="badge ${prefix}-${value}">${value}</span>`;
}

function truncate(str, max = 80) {
  if (!str) return "";
  return str.length > max ? str.substring(0, max) + "…" : str;
}

// =============================================================================
// TAB MANAGEMENT
// =============================================================================

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    const panel = document.getElementById(`tab-${btn.dataset.tab}`);
    if (panel) panel.classList.add("active");

    if (btn.dataset.tab === "graph") loadGraph();
    if (btn.dataset.tab === "config") loadConfig();
  });
});

// =============================================================================
// AGENT SELECTION
// =============================================================================

async function loadAgents() {
  const res = await api("/api/agents");
  if (!res.ok) return;
  const select = document.getElementById("agent-select");
  select.innerHTML = res.data.map((a) => `<option value="${a.id}">${a.id}</option>`).join("");
  select.value = currentAgent;
}

document.getElementById("agent-select").addEventListener("change", (e) => {
  currentAgent = e.target.value;
  loadPersonas();
  loadMemories();
  loadWorkspaceFiles();
});

// =============================================================================
// PERSONAS
// =============================================================================

async function loadPersonas() {
  const res = await api("/api/personas");
  if (!res.ok) return;

  const container = document.getElementById("persona-list");
  if (res.data.length === 0) {
    container.innerHTML = '<p class="hint">No persona entries yet.</p>';
    return;
  }

  container.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Category</th><th>Content</th><th>Always Active</th><th>Actions</th></tr></thead>
      <tbody>
        ${res.data
      .map(
        (p) => `
          <tr>
            <td>${p.category}</td>
            <td title="${p.content.replace(/"/g, "&quot;")}">${truncate(p.content, 60)}</td>
            <td>${badge(String(p.is_always_active))}</td>
            <td class="actions">
              <button class="btn-sm btn-secondary" onclick="editPersona('${p.id}')">✏️</button>
              <button class="btn-sm btn-danger" onclick="deletePersona('${p.id}')">🗑️</button>
            </td>
          </tr>`,
      )
      .join("")}
      </tbody>
    </table>
  `;
}

document.getElementById("btn-new-persona").addEventListener("click", () => {
  document.getElementById("persona-form-id").value = "";
  document.getElementById("persona-category").value = "";
  document.getElementById("persona-content").value = "";
  document.getElementById("persona-always-active").checked = false;
  document.getElementById("persona-form").style.display = "block";
});

document.getElementById("btn-cancel-persona").addEventListener("click", () => {
  document.getElementById("persona-form").style.display = "none";
});

document.getElementById("btn-save-persona").addEventListener("click", async () => {
  const id = document.getElementById("persona-form-id").value;
  const body = {
    category: document.getElementById("persona-category").value,
    content: document.getElementById("persona-content").value,
    is_always_active: document.getElementById("persona-always-active").checked,
  };

  const res = id
    ? await api(`/api/personas/${id}`, { method: "PUT", body: JSON.stringify(body) })
    : await api("/api/personas", { method: "POST", body: JSON.stringify(body) });

  if (res.ok) {
    toast(id ? "Persona updated" : "Persona created", "success");
    document.getElementById("persona-form").style.display = "none";
    loadPersonas();
  } else {
    toast(res.error || "Failed", "error");
  }
});

window.editPersona = async function (id) {
  const res = await api(`/api/personas/${id}`);
  if (!res.ok) return toast("Not found", "error");
  const p = res.data;
  document.getElementById("persona-form-id").value = p.id;
  document.getElementById("persona-category").value = p.category;
  document.getElementById("persona-content").value = p.content;
  document.getElementById("persona-always-active").checked = p.is_always_active;
  document.getElementById("persona-form").style.display = "block";
};

window.deletePersona = async function (id) {
  if (!confirm("Delete this persona entry?")) return;
  const res = await api(`/api/personas/${id}`, { method: "DELETE" });
  if (res.ok) {
    toast("Deleted", "success");
    loadPersonas();
  } else {
    toast(res.error || "Failed", "error");
  }
};

// =============================================================================
// MEMORIES
// =============================================================================

async function loadMemories() {
  const search = document.getElementById("memory-search").value;
  const tier = document.getElementById("memory-tier-filter").value;
  const archived = document.getElementById("memory-archived-filter").value;

  const params = new URLSearchParams({
    limit: memoryPage.limit,
    offset: memoryPage.offset,
  });
  if (search) params.set("search", search);
  if (tier) params.set("tier", tier);
  if (archived) params.set("archived", archived);

  const res = await api(`/api/memories?${params}`);
  if (!res.ok) return;

  const memories = res.data.memories || res.data;
  memoryPage.total = res.data.total ?? memories.length;
  const container = document.getElementById("memory-list");

  if (memories.length === 0) {
    container.innerHTML = '<p class="hint">No memories found.</p>';
    document.getElementById("memory-pagination").innerHTML = "";
    return;
  }

  container.innerHTML = `
    <table class="data-table">
      <thead><tr>
        <th>Content</th><th>Category</th><th>Tier</th><th>Vol.</th><th>Conf.</th>
        <th>Score</th><th>Acc.</th><th>Inj.</th><th>Created</th><th>Actions</th>
      </tr></thead>
      <tbody>
        ${memories
      .map(
        (m) => {
          const created = m.created_at ? new Date(m.created_at).toLocaleDateString() : '—';
          const conf = m.confidence != null ? m.confidence.toFixed(2) : '—';
          const vol = m.volatility || '—';
          const score = m.usefulness_score != null ? m.usefulness_score.toFixed(1) : '—';
          const acc = m.access_count ?? 0;
          const inj = m.injection_count ?? 0;
          return `
          <tr${m.is_pointer ? ' class="memory-pointer"' : ''}>
            <td title="${(m.content || '').replace(/"/g, '&quot;')}">${truncate(m.content, 50)}</td>
            <td>${m.category || '—'}</td>
            <td>${badge(m.tier || 'daily')}</td>
            <td><span class="vol-${vol}">${vol}</span></td>
            <td>${conf}</td>
            <td>${score}</td>
            <td>${acc}</td>
            <td>${inj}</td>
            <td>${created}</td>
            <td class="actions">
              <button class="btn-sm btn-secondary" onclick="editMemory('${m.id}')">✏️</button>
              <button class="btn-sm btn-danger" onclick="deleteMemory('${m.id}')">🗑️</button>
            </td>
          </tr>`;
        },
      )
      .join('')}
      </tbody>
    </table>
  `;

  renderPagination();
}

function renderPagination() {
  const el = document.getElementById("memory-pagination");
  const page = Math.floor(memoryPage.offset / memoryPage.limit) + 1;
  const totalPages = Math.max(1, Math.ceil(memoryPage.total / memoryPage.limit));
  el.innerHTML = `
    <button class="btn-sm btn-secondary" onclick="prevMemoryPage()" ${memoryPage.offset === 0 ? "disabled" : ""}>← Prev</button>
    <span>Page ${page} of ${totalPages} (${memoryPage.total} total)</span>
    <button class="btn-sm btn-secondary" onclick="nextMemoryPage()" ${page >= totalPages ? "disabled" : ""}>Next →</button>
  `;
}

window.prevMemoryPage = function () {
  memoryPage.offset = Math.max(0, memoryPage.offset - memoryPage.limit);
  loadMemories();
};

window.nextMemoryPage = function () {
  memoryPage.offset += memoryPage.limit;
  loadMemories();
};

document.getElementById("memory-search").addEventListener(
  "input",
  debounce(() => {
    memoryPage.offset = 0;
    loadMemories();
  }, 300),
);

document.getElementById("memory-tier-filter").addEventListener("change", () => {
  memoryPage.offset = 0;
  loadMemories();
});

document.getElementById("memory-archived-filter").addEventListener("change", () => {
  memoryPage.offset = 0;
  loadMemories();
});

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

document.getElementById("btn-new-memory").addEventListener("click", () => {
  document.getElementById("memory-form-id").value = "";
  document.getElementById("memory-content").value = "";
  document.getElementById("memory-category").value = "";
  document.getElementById("memory-tier").value = "daily";
  document.getElementById("memory-edge-list").innerHTML = "";
  document.getElementById("memory-form").style.display = "block";
});

document.getElementById("btn-cancel-memory").addEventListener("click", () => {
  document.getElementById("memory-form").style.display = "none";
});

document.getElementById("btn-save-memory").addEventListener("click", async () => {
  const id = document.getElementById("memory-form-id").value;
  const body = {
    content: document.getElementById("memory-content").value,
    category: document.getElementById("memory-category").value || undefined,
    tier: document.getElementById("memory-tier").value,
  };

  const res = id
    ? await api(`/api/memories/${id}`, { method: "PUT", body: JSON.stringify(body) })
    : await api("/api/memories", { method: "POST", body: JSON.stringify(body) });

  if (res.ok) {
    toast(id ? "Memory updated" : "Memory created", "success");
    document.getElementById("memory-form").style.display = "none";
    loadMemories();
  } else {
    toast(res.error || "Failed", "error");
  }
});

window.editMemory = async function (id) {
  const res = await api(`/api/memories/${id}`);
  if (!res.ok) return toast("Not found", "error");
  const m = res.data;
  document.getElementById("memory-form-id").value = m.id;
  document.getElementById("memory-content").value = m.content;
  document.getElementById("memory-category").value = m.category || "";
  document.getElementById("memory-tier").value = m.tier || "daily";
  document.getElementById("memory-form").style.display = "block";
  loadMemoryEdges(id);
};

window.deleteMemory = async function (id) {
  if (!confirm("Archive this memory?")) return;
  const res = await api(`/api/memories/${id}`, { method: "DELETE" });
  if (res.ok) {
    toast("Archived", "success");
    loadMemories();
  } else {
    toast(res.error || "Failed", "error");
  }
};

// =============================================================================
// MEMORY LINKING
// =============================================================================

async function loadMemoryEdges(memoryId) {
  const res = await api(`/api/memories/${memoryId}/edges`);
  const container = document.getElementById("memory-edge-list");

  if (!res.ok || !res.data.length) {
    container.innerHTML = '<p class="hint" style="font-size:0.8rem;">No links yet.</p>';
    return;
  }

  container.innerHTML = res.data
    .map((e) => {
      const isSrc = e.source_memory_id === memoryId;
      const targetLabel = isSrc
        ? truncate(e.target_content || e.target_persona_category || "Unknown", 50)
        : truncate(e.source_content || e.source_persona_category || "Unknown", 50);
      const targetType = (isSrc ? (e.target_persona_id ? "persona" : "memory") : (e.source_persona_id ? "persona" : "memory"));
      return `
        <div class="edge-item">
          <span class="edge-rel">${e.relationship_type}</span>
          <span class="edge-type-badge">${targetType}</span>
          <span class="edge-target">${isSrc ? "→" : "←"} ${targetLabel}</span>
          <button class="btn-sm btn-danger" onclick="deleteEdge('${e.id}', '${memoryId}')">✕</button>
        </div>
      `;
    })
    .join("");
}

window.deleteEdge = async function (edgeId, memoryId) {
  const res = await api(`/api/edges/${edgeId}`, { method: "DELETE" });
  if (res.ok) {
    toast("Link removed", "success");
    loadMemoryEdges(memoryId);
  } else {
    toast(res.error || "Failed", "error");
  }
};

// Link target search
const linkSearchInput = document.getElementById("link-target-search");
const linkSearchResults = document.getElementById("link-target-results");

linkSearchInput.addEventListener(
  "input",
  debounce(async () => {
    const q = linkSearchInput.value.trim().toLowerCase();
    if (q.length < 2) {
      linkSearchResults.style.display = "none";
      return;
    }

    const res = await api(`/api/memories/search?search=${encodeURIComponent(q)}`);
    if (!res.ok || !res.data || res.data.length === 0) {
      linkSearchResults.style.display = "none";
      return;
    }

    linkSearchResults.innerHTML = res.data
      .map(
        (r) => `
      <div class="link-search-item" data-id="${r.id}" data-type="${r.type}">
        <span class="node-type ${r.type}">${r.type}</span>
        <span>${truncate(r.content, 60)}</span>
      </div>
    `,
      )
      .join("");
    linkSearchResults.style.display = "block";
  }, 300),
);

linkSearchResults.addEventListener("click", (e) => {
  const item = e.target.closest(".link-search-item");
  if (!item) return;
  document.getElementById("link-target-id").value = item.dataset.id;
  document.getElementById("link-target-type").value = item.dataset.type;
  linkSearchInput.value = item.querySelector("span:last-child").textContent;
  linkSearchResults.style.display = "none";
});

document.getElementById("btn-add-link").addEventListener("click", async () => {
  const memoryId = document.getElementById("memory-form-id").value;
  const targetId = document.getElementById("link-target-id").value;
  const targetType = document.getElementById("link-target-type").value;
  const relationship = document.getElementById("link-relationship").value.trim();

  if (!memoryId || !targetId || !relationship) {
    return toast("Select a target and enter a relationship type", "error");
  }

  const body = { relationship_type: relationship };
  if (targetType === "persona") {
    body.source_memory_id = memoryId;
    body.target_persona_id = targetId;
  } else {
    body.source_memory_id = memoryId;
    body.target_memory_id = targetId;
  }

  const res = await api("/api/edges", { method: "POST", body: JSON.stringify(body) });
  if (res.ok) {
    toast("Link created", "success");
    linkSearchInput.value = "";
    document.getElementById("link-target-id").value = "";
    document.getElementById("link-relationship").value = "";
    loadMemoryEdges(memoryId);
  } else {
    toast(res.error || "Link failed", "error");
  }
});

// =============================================================================
// IMPORT (paste markdown)
// =============================================================================

document.getElementById("btn-import-memory").addEventListener("click", () => {
  document.getElementById("import-form").style.display =
    document.getElementById("import-form").style.display === "none" ? "block" : "none";
});

document.getElementById("btn-cancel-import").addEventListener("click", () => {
  document.getElementById("import-form").style.display = "none";
});

document.getElementById("btn-run-import").addEventListener("click", async () => {
  const content = document.getElementById("import-content").value;
  const source_filename = document.getElementById("import-filename").value || undefined;

  if (!content.trim()) return toast("Paste some content first", "error");

  const res = await api("/api/memories/import", {
    method: "POST",
    body: JSON.stringify({ content, source_filename }),
  });

  if (res.ok) {
    toast(`Imported ${res.data.imported} memories`, "success");
    document.getElementById("import-form").style.display = "none";
    document.getElementById("import-content").value = "";
    loadMemories();
  } else {
    toast(res.error || "Import failed", "error");
  }
});

// =============================================================================
// WORKSPACE FILES
// =============================================================================

async function loadWorkspaceFiles() {
  const res = await api("/api/workspace-files");
  const container = document.getElementById("workspace-files");

  if (!res.ok || !res.data.length) {
    container.innerHTML = '<p class="hint">No .md files in workspace.</p>';
    return;
  }

  container.innerHTML = res.data
    .map(
      (f) => `
    <div style="display:inline-flex;flex-direction:column;gap:0.15rem;">
      <button class="workspace-file-btn" onclick="viewWorkspaceFile('${f.name}')">${f.name}</button>
      <div class="workspace-import-actions">
        <button class="workspace-import-btn" onclick="importWorkspaceTo('${f.name}', 'persona')" title="Import as persona entries via LLM">→ Persona</button>
        <button class="workspace-import-btn" onclick="importWorkspaceTo('${f.name}', 'memory')" title="Import as memory facts via LLM">→ Memory</button>
      </div>
    </div>
  `,
    )
    .join("");
}

window.viewWorkspaceFile = async function (filename) {
  const res = await api(`/api/workspace-files/${encodeURIComponent(filename)}`);
  if (!res.ok) return toast(res.error || "Failed to read", "error");
  const el = document.getElementById("workspace-content");
  el.textContent = res.data.content;
  el.style.display = "block";
};

window.importWorkspaceTo = async function (filename, target) {
  const tierPrompt = target === "memory" ? " (tier: stable)" : "";
  if (!confirm(`Import "${filename}" as ${target} entries${tierPrompt}?\n\nThis uses LLM to semantically chunk the file.`)) return;

  toast(`Importing ${filename} as ${target}… (LLM processing)`, "info");

  const res = await api("/api/workspace-import", {
    method: "POST",
    body: JSON.stringify({ filename, target }),
  });

  if (res.ok) {
    toast(`Imported ${res.data.imported}/${res.data.total} ${target} entries from ${filename}`, "success");
    if (target === "persona") loadPersonas();
    else loadMemories();
  } else {
    toast(res.error || "Import failed", "error");
  }
};

// =============================================================================
// KNOWLEDGE GRAPH (D3.js)
// =============================================================================

const TIER_COLORS = {
  permanent: "#4ade80",
  stable: "#4f9cf7",
  daily: "#f7b955",
  session: "#a78bfa",
  volatile: "#f7555a",
};

const PERSONA_COLOR = "#f7b955";
const MEMORY_DEFAULT_COLOR = "#4f9cf7";

async function loadGraph() {
  const res = await api("/api/graph");
  if (!res.ok) return;

  allNodes = res.data.nodes;
  allEdges = res.data.edges;

  const svg = d3.select("#graph-svg");
  svg.selectAll("*").remove();

  const container = document.getElementById("graph-container");
  const width = container.clientWidth;
  const height = container.clientHeight;

  svg.attr("width", width).attr("height", height);

  // Defs for arrowheads
  const defs = svg.append("defs");
  defs
    .append("marker")
    .attr("id", "arrowhead")
    .attr("viewBox", "0 -5 10 10")
    .attr("refX", 20)
    .attr("refY", 0)
    .attr("markerWidth", 6)
    .attr("markerHeight", 6)
    .attr("orient", "auto")
    .append("path")
    .attr("d", "M0,-5L10,0L0,5")
    .attr("fill", "#6b7280");

  const g = svg.append("g");

  // Zoom
  const zoom = d3.zoom().scaleExtent([0.1, 5]).on("zoom", (event) => {
    g.attr("transform", event.transform);
  });
  svg.call(zoom);

  // Force simulation
  const simulation = d3
    .forceSimulation(res.data.nodes)
    .force(
      "link",
      d3
        .forceLink(res.data.edges)
        .id((d) => d.id)
        .distance(120),
    )
    .force("charge", d3.forceManyBody().strength(-200))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force("collision", d3.forceCollide().radius(30));

  // Edges
  const link = g
    .append("g")
    .selectAll("line")
    .data(res.data.edges)
    .join("line")
    .attr("class", "graph-edge")
    .attr("stroke", (d) => {
      if (d.sourceType === "persona" || d.targetType === "persona") return PERSONA_COLOR;
      return "#6b7280";
    })
    .attr("stroke-width", (d) => Math.max(1, d.weight))
    .attr("marker-end", "url(#arrowhead)");

  // Edge labels
  const edgeLabel = g
    .append("g")
    .selectAll("text")
    .data(res.data.edges)
    .join("text")
    .attr("class", "graph-edge-label")
    .text((d) => d.relationship);

  // Nodes
  const node = g
    .append("g")
    .selectAll("g")
    .data(res.data.nodes)
    .join("g")
    .attr("class", "graph-node")
    .call(
      d3.drag()
        .filter((event) => !event.shiftKey)  // let shift+drag fall through to link handler
        .on("start", dragStart)
        .on("drag", dragging)
        .on("end", dragEnd)
    );

  // Glow
  node
    .append("circle")
    .attr("class", "node-glow")
    .attr("r", (d) => nodeRadius(d) + 6)
    .attr("fill", "none")
    .attr("stroke", (d) => nodeColor(d))
    .attr("stroke-width", 3)
    .attr("stroke-opacity", 0);

  // Memory nodes = circles, Persona nodes = diamonds
  node.each(function (d) {
    const el = d3.select(this);
    if (d.type === "persona") {
      const size = 10;
      el.append("path")
        .attr("class", "node-diamond")
        .attr("d", `M0,${-size} L${size},0 L0,${size} L${-size},0 Z`)
        .attr("fill", PERSONA_COLOR)
        .attr("stroke", "#0f1117")
        .attr("stroke-width", 1.5);
    } else {
      el.append("circle")
        .attr("class", "node-circle")
        .attr("r", nodeRadius(d))
        .attr("fill", nodeColor(d))
        .attr("stroke", "#0f1117")
        .attr("stroke-width", 1.5);
    }
  });

  // Labels
  node
    .append("text")
    .attr("class", "node-label")
    .attr("dy", (d) => nodeRadius(d) + 14)
    .attr("text-anchor", "middle")
    .text((d) => truncate(d.label, 20))
    .style("display", showLabels ? "block" : "none");

  // Click handler
  node.on("click", (_event, d) => showNodeDetail(d));

  // Shift+drag to link — use native mousedown since D3 drag ignores shift events
  node.on("mousedown.link", function (event, d) {
    if (!event.shiftKey) return;
    event.stopPropagation();
    event.preventDefault();
    const svgEl = document.getElementById("graph-svg");
    const pt = svgEl.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const ctm = g.node().getScreenCTM();
    if (!ctm) return;
    const svgPt = pt.matrixTransform(ctm.inverse());

    const line = g
      .append("line")
      .attr("class", "graph-link-preview")
      .attr("x1", d.x)
      .attr("y1", d.y)
      .attr("x2", d.x)
      .attr("y2", d.y);

    shiftLinkState = { sourceNode: d, line };
  });

  svg.on("mousemove", function (event) {
    if (!shiftLinkState) return;
    const pt = this.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const svgPt = pt.matrixTransform(g.node().getScreenCTM().inverse());
    shiftLinkState.line.attr("x2", svgPt.x).attr("y2", svgPt.y);
  });

  svg.on("mouseup", async function (event) {
    if (!shiftLinkState) return;
    shiftLinkState.line.remove();
    const source = shiftLinkState.sourceNode;
    shiftLinkState = null;

    // Find target node under cursor
    const target = findNodeAt(event, res.data.nodes, g);
    if (!target || target.id === source.id) return;

    const relationship = prompt(`Link "${truncate(source.label, 30)}" → "${truncate(target.label, 30)}"\n\nRelationship type:`);
    if (!relationship) return;

    const body = { relationship_type: relationship };
    if (source.type === "persona") body.source_persona_id = source.id;
    else body.source_memory_id = source.id;
    if (target.type === "persona") body.target_persona_id = target.id;
    else body.target_memory_id = target.id;

    const linkRes = await api("/api/edges", { method: "POST", body: JSON.stringify(body) });
    if (linkRes.ok) {
      toast("Link created", "success");
      loadGraph();
    } else {
      toast(linkRes.error || "Link failed", "error");
    }
  });

  // Tick
  simulation.on("tick", () => {
    link
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);

    edgeLabel
      .attr("x", (d) => (d.source.x + d.target.x) / 2)
      .attr("y", (d) => (d.source.y + d.target.y) / 2);

    node.attr("transform", (d) => `translate(${d.x},${d.y})`);
  });

  // Store
  graphInstances = { simulation, svg, g, zoom };

  // Legend
  renderLegend();

  // Stats
  document.getElementById("graph-stats").textContent =
    `${res.data.nodes.length} nodes • ${res.data.edges.length} edges — Scroll to zoom • Drag to pan • Click node for details • Shift+drag to link`;

  function dragStart(event, d) {
    if (event.sourceEvent && event.sourceEvent.shiftKey) return;
    if (!event.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
  }

  function dragging(event, d) {
    if (event.sourceEvent && event.sourceEvent.shiftKey) return;
    d.fx = event.x;
    d.fy = event.y;
  }

  function dragEnd(event, d) {
    if (!event.active) simulation.alphaTarget(0);
    d.fx = null;
    d.fy = null;
  }
}

function findNodeAt(event, nodes, gGroup) {
  const svgEl = document.getElementById("graph-svg");
  const pt = svgEl.createSVGPoint();
  pt.x = event.clientX;
  pt.y = event.clientY;
  const svgPt = pt.matrixTransform(gGroup.node().getScreenCTM().inverse());

  let closest = null;
  let minDist = Infinity;
  for (const n of nodes) {
    const dx = n.x - svgPt.x;
    const dy = n.y - svgPt.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 20 && dist < minDist) {
      minDist = dist;
      closest = n;
    }
  }
  return closest;
}

function nodeRadius(d) {
  if (d.type === "persona") return 10;
  const base = 6;
  return Math.min(base + (d.accessCount || 0) * 0.5, 18);
}

function nodeColor(d) {
  if (d.type === "persona") return PERSONA_COLOR;
  return TIER_COLORS[d.tier] || MEMORY_DEFAULT_COLOR;
}

function renderLegend() {
  const legend = document.getElementById("graph-legend");
  const items = [
    ...Object.entries(TIER_COLORS).map(([tier, color]) => `<div class="legend-item"><span class="legend-dot" style="background:${color}"></span>${tier}</div>`),
    `<div class="legend-item"><span class="legend-diamond" style="background:${PERSONA_COLOR}"></span>persona</div>`,
  ];
  legend.innerHTML = items.join("");
}

function showNodeDetail(d) {
  const panel = document.getElementById("graph-detail");
  panel.style.display = "block";

  const typeLabel = d.type === "persona" ? "🎭 Persona Trait" : "🧠 Memory";
  panel.innerHTML = `
    <div class="detail-header">
      <strong>${typeLabel}</strong>
      <span class="detail-category">${d.category || "uncategorized"}</span>
      ${badge(d.tier || "—")}
      <span class="detail-id">${d.id.substring(0, 8)}</span>
      <button class="btn-sm btn-secondary" onclick="document.getElementById('graph-detail').style.display='none'">✕</button>
    </div>
    <div class="detail-content">${d.label}</div>
    <div class="detail-stats">
      <span>Accesses: ${d.accessCount || 0}</span>
      <span>Score: ${d.score != null ? d.score.toFixed(1) : "—"}</span>
      ${d.isAlwaysActive ? "<span>Always Active ✅</span>" : ""}
    </div>
  `;
}

// Graph controls
document.getElementById("btn-fit-graph").addEventListener("click", () => {
  if (!graphInstances.svg || !graphInstances.zoom) return;
  graphInstances.svg
    .transition()
    .duration(500)
    .call(graphInstances.zoom.transform, d3.zoomIdentity);
});

document.getElementById("btn-toggle-labels").addEventListener("click", () => {
  showLabels = !showLabels;
  d3.selectAll(".node-label").style("display", showLabels ? "block" : "none");
  document.getElementById("btn-toggle-labels").textContent = showLabels ? "🏷️ Labels On" : "🏷️ Labels Off";
});

document.getElementById("btn-refresh-graph").addEventListener("click", () => loadGraph());

// =============================================================================
// SCRIPTS
// =============================================================================

document.getElementById("btn-run-sleep").addEventListener("click", async () => {
  const statusEl = document.getElementById("sleep-status");
  statusEl.textContent = "Running sleep cycle…";
  statusEl.className = "script-status running";

  const res = await api("/api/scripts/sleep", { method: "POST", body: JSON.stringify({}) });

  if (res.ok) {
    statusEl.textContent = "✅ " + (res.data?.message || "Complete");
    statusEl.className = "script-status success";
  } else {
    statusEl.textContent = "❌ " + (res.error || "Failed");
    statusEl.className = "script-status error";
  }
});

document.getElementById("btn-run-persona-import").addEventListener("click", async () => {
  const file = document.getElementById("persona-import-file").value;
  if (!file) return toast("Enter a file path", "error");

  const statusEl = document.getElementById("persona-import-status");
  statusEl.textContent = "Importing…";
  statusEl.className = "script-status running";

  const res = await api("/api/scripts/persona-import", {
    method: "POST",
    body: JSON.stringify({ file }),
  });

  if (res.ok) {
    statusEl.textContent = "✅ " + (res.data?.message || "Done");
    statusEl.className = "script-status success";
  } else {
    statusEl.textContent = "❌ " + (res.error || "Failed");
    statusEl.className = "script-status error";
  }
});

// =============================================================================
// CONFIG
// =============================================================================

const CONFIG_MAP = [
  { id: "cfg-rag-semantic-limit", path: "rag.semanticLimit", type: "number" },
  { id: "cfg-rag-total-limit", path: "rag.totalLimit", type: "number" },
  { id: "cfg-rag-linked-similarity", path: "rag.linkedSimilarity", type: "number" },
  { id: "cfg-rag-max-traversal-depth", path: "rag.maxTraversalDepth", type: "number" },
  { id: "cfg-persona-situational-limit", path: "persona.situationalLimit", type: "number" },
  { id: "cfg-prompt-memory", path: "prompts.memoryRules", type: "text" },
  { id: "cfg-prompt-persona", path: "prompts.personaRules", type: "text" },
  { id: "cfg-prompt-heartbeat", path: "prompts.heartbeatRules", type: "text" },
  { id: "cfg-prompt-heartbeat-path", path: "prompts.heartbeatFilePath", type: "text" },
  { id: "cfg-sleep-dedup-threshold", path: "sleep.dedupSimilarityThreshold", type: "number" },
  { id: "cfg-sleep-low-value-age", path: "sleep.lowValueAgeDays", type: "number" },
  { id: "cfg-sleep-link-min", path: "sleep.linkMinSimilarity", type: "number" },
  { id: "cfg-sleep-link-max", path: "sleep.linkMaxSimilarity", type: "number" },
  { id: "cfg-sleep-episodic-batch", path: "sleep.episodicBatchLimit", type: "number" },
  { id: "cfg-sleep-dedup-scan", path: "sleep.duplicateScanLimit", type: "number" },
  { id: "cfg-sleep-link-candidates", path: "sleep.linkCandidatesPerMemory", type: "number" },
  { id: "cfg-sleep-link-batch", path: "sleep.linkBatchSize", type: "number" },
  { id: "cfg-sleep-link-scan", path: "sleep.linkScanLimit", type: "number" },
  { id: "cfg-sleep-protected-tiers", path: "sleep.lowValueProtectedTiers", type: "csv" },
  { id: "cfg-dedup-cache", path: "dedup.maxCacheSize", type: "number" },
];

function getConfigValue(cfg, path) {
  return path.split(".").reduce((o, k) => o?.[k], cfg);
}

function setConfigValue(cfg, path, value) {
  const keys = path.split(".");
  let obj = cfg;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!obj[keys[i]]) obj[keys[i]] = {};
    obj = obj[keys[i]];
  }
  obj[keys[keys.length - 1]] = value;
}

async function loadConfig() {
  const res = await api("/api/config");
  if (!res.ok) return;
  const cfg = res.data;

  for (const item of CONFIG_MAP) {
    const el = document.getElementById(item.id);
    if (!el) continue;
    const val = getConfigValue(cfg, item.path);
    if (item.type === "csv" && Array.isArray(val)) {
      el.value = val.join(", ");
    } else {
      el.value = val ?? "";
    }
  }
}

document.getElementById("btn-save-config").addEventListener("click", async () => {
  const res = await api("/api/config");
  if (!res.ok) return;
  const cfg = res.data;

  for (const item of CONFIG_MAP) {
    const el = document.getElementById(item.id);
    if (!el) continue;
    let val;
    if (item.type === "number") {
      val = parseFloat(el.value);
      if (isNaN(val)) continue;
    } else if (item.type === "csv") {
      val = el.value.split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      val = el.value;
    }
    setConfigValue(cfg, item.path, val);
  }

  const saveRes = await api("/api/config", {
    method: "POST",
    body: JSON.stringify(cfg),
  });

  if (saveRes.ok) {
    toast("Configuration saved", "success");
  } else {
    toast(saveRes.error || "Save failed", "error");
  }
});

document.getElementById("btn-reset-config").addEventListener("click", async () => {
  if (!confirm("Reset all settings to defaults?")) return;
  const res = await api("/api/config/reset", { method: "POST" });
  if (res.ok) {
    toast("Reset to defaults", "success");
    loadConfig();
  } else {
    toast(res.error || "Reset failed", "error");
  }
});

// =============================================================================
// LIGHT SLIDER
// =============================================================================

const FILL_LIGHT = 0.75;

function applyLighting(key) {
  const root = document.documentElement;
  const k = parseFloat(key);

  root.style.setProperty('--amb-key-light-intensity', k);
  root.style.setProperty('--amb-fill-light-intensity', FILL_LIGHT);

  // Text must always contrast against amb-surface (lightness ≈ key × 100%).
  // Step function: dark surface → light text, light surface → dark text.
  const s = k * 100;
  let textL, secL, mutL;

  if (s < 50) {
    textL = 92;
    secL = 68;
    mutL = 55;
  } else {
    textL = 10;
    secL = 30;
    mutL = 40;
  }

  root.style.setProperty('--text-primary', `hsl(0 0% ${textL}%)`);
  root.style.setProperty('--text-secondary', `hsl(0 0% ${secL}%)`);
  root.style.setProperty('--text-muted', `hsl(0 0% ${mutL}%)`);

  const kDisp = document.getElementById('key-light-value');
  if (kDisp) kDisp.textContent = k.toFixed(2);
}

function initLightSlider() {
  const slider = document.getElementById('key-light-slider');
  if (!slider) return;

  const stored = localStorage.getItem('postclaw-key-light');
  if (stored) slider.value = stored;

  applyLighting(slider.value);

  slider.addEventListener('input', () => {
    applyLighting(slider.value);
    localStorage.setItem('postclaw-key-light', slider.value);
  });
}

// =============================================================================
// INIT
// =============================================================================

async function init() {
  initLightSlider();
  await loadAgents();
  loadPersonas();
  loadMemories();
  loadWorkspaceFiles();
}

init();
