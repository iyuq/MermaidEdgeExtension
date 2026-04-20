/**
 * Mermaid / PlantUML / DOT Diagram Previewer - Content Script
 * Detects and renders Mermaid, PlantUML, and DOT (Graphviz) diagrams.
 * Handles SPA navigation (GitHub Turbo/PJAX, GitLab, Azure DevOps, etc.).
 */
(function () {
  "use strict";

  const RENDERED_ATTR = "data-mermaid-ext-rendered";
  const CONTAINER_CLASS = "mermaid-ext-container";
  const DEFAULT_PLANTUML_SERVER = "https://www.plantuml.com/plantuml";
  const DEFAULT_DOT_SERVER = "https://kroki.io";
  let renderCounter = 0;
  let initialized = false;
  let currentTheme = "default";
  let extensionEnabled = true;
  let plantumlServer = DEFAULT_PLANTUML_SERVER;
  let dotServer = DEFAULT_DOT_SERVER;
  let activeRender = null;                     // in-flight render promise
  const pendingQueue = [];                     // blocks waiting for the active render to drain
  const queuedElements = new WeakSet();        // dedup across concurrent callers
  const renderCache = new Map();               // `${kind}:${source}` → svgText, keeps re-renders sync

  // ─── Detection Selectors ────────────────────────────────────────────
  const MERMAID_SELECTORS = [
    'pre > code.language-mermaid',
    'pre > code.lang-mermaid',
    'code.language-mermaid',
    'code.lang-mermaid',
    'pre.mermaid',
    'div.mermaid',
    '[data-lang="mermaid"] > code',
    '[data-language="mermaid"] > code',
    'code.highlight-source-mermaid',
    'pre[lang="mermaid"]',
    'pre[data-lang="mermaid"]',
    'td.blob-code-inner .language-mermaid',
    '.js-render-mermaid',
  ];

  const PLANTUML_SELECTORS = [
    'pre > code.language-plantuml',
    'pre > code.language-puml',
    'pre > code.lang-plantuml',
    'pre > code.lang-puml',
    'code.language-plantuml',
    'code.language-puml',
    'code.lang-plantuml',
    'code.lang-puml',
    'pre.plantuml',
    '[data-lang="plantuml"] > code',
    '[data-language="plantuml"] > code',
    'pre[lang="plantuml"]',
    'pre[data-lang="plantuml"]',
  ];

  const DOT_SELECTORS = [
    'pre > code.language-dot',
    'pre > code.language-graphviz',
    'pre > code.lang-dot',
    'pre > code.lang-graphviz',
    'code.language-dot',
    'code.language-graphviz',
    'code.lang-dot',
    'code.lang-graphviz',
    'pre.dot',
    'pre.graphviz',
    '[data-lang="dot"] > code',
    '[data-lang="graphviz"] > code',
    '[data-language="dot"] > code',
    '[data-language="graphviz"] > code',
    'pre[lang="dot"]',
    'pre[lang="graphviz"]',
    'pre[data-lang="dot"]',
    'pre[data-lang="graphviz"]',
  ];

  const MERMAID_KEYWORDS = [
    'graph ', 'graph\n', 'flowchart ', 'flowchart\n',
    'sequenceDiagram', 'classDiagram', 'stateDiagram',
    'erDiagram', 'gantt', 'pie', 'mindmap', 'timeline',
    'gitGraph', 'quadrantChart', 'requirementDiagram',
    'C4Context', 'C4Container', 'C4Component', 'C4Deployment', 'C4Dynamic',
    'sankey-beta', 'xychart-beta', 'block-beta', 'packet-beta',
    'kanban', 'architecture-beta', 'radar-beta', 'treemap-beta',
    'journey', 'zenuml',
  ];

  const PLANTUML_KEYWORDS = [
    '@startuml', '@startmindmap', '@startgantt', '@startsalt',
    '@startwbs', '@startditaa', '@startjson', '@startyaml',
  ];

  // The opening brace distinguishes DOT's `graph Name {` from Mermaid's
  // `graph TB\n…` flowchart syntax.
  const DOT_SYNTAX_RE = /^\s*(?:strict\s+)?(?:di)?graph(?:\s+[A-Za-z_]\w*)?\s*\{/;

  // ─── Initialize Mermaid ─────────────────────────────────────────────
  function initMermaid(theme) {
    if (typeof mermaid === "undefined") return false;
    currentTheme = theme || "default";
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "loose",
      theme: currentTheme,
      logLevel: "error",
      flowchart: { useMaxWidth: true },
      sequence: { useMaxWidth: true },
      gantt: { useMaxWidth: true },
      journey: { useMaxWidth: true },
      timeline: { useMaxWidth: true },
      class: { useMaxWidth: true },
      state: { useMaxWidth: true },
      er: { useMaxWidth: true },
      pie: { useMaxWidth: true },
      quadrantChart: { useMaxWidth: true },
      xyChart: { useMaxWidth: true },
      mindmap: { useMaxWidth: true },
    });
    initialized = true;
    return true;
  }

  // ─── Detect Diagram Blocks ──────────────────────────────────────────
  function detectBlocks(root) {
    const blocks = [];
    const seen = new Set();

    const searchRoot = root || document;

    const tryAdd = (el, kind) => {
      if (seen.has(el) || el.hasAttribute(RENDERED_ATTR)) return;
      const source = extractSource(el);
      if (!source) return;
      const resolvedKind = kind || classifySource(source);
      if (!resolvedKind) return;
      seen.add(el);
      blocks.push({ element: el, source, kind: resolvedKind });
    };

    const runSelectors = (selectors, kind) => {
      for (const selector of selectors) {
        try {
          searchRoot.querySelectorAll(selector).forEach(el => tryAdd(el, kind));
        } catch (e) { /* ignore invalid selectors */ }
      }
    };

    runSelectors(MERMAID_SELECTORS, "mermaid");
    runSelectors(PLANTUML_SELECTORS, "plantuml");
    runSelectors(DOT_SELECTORS, "dot");

    // Fallback: classify by content.
    try {
      // <pre><code>…</code></pre>
      searchRoot.querySelectorAll("pre > code").forEach(el => tryAdd(el, null));
      // Bare <code>…</code> with multi-line content. Some hosts (e.g. Azure
      // DevOps for unknown-language fences) render fenced blocks this way.
      // Multi-line filter avoids false-positives on inline code.
      searchRoot.querySelectorAll("code").forEach(el => {
        if (el.parentElement && el.parentElement.tagName === "PRE") return;
        if (el.textContent && el.textContent.indexOf("\n") !== -1) tryAdd(el, null);
      });
    } catch (e) { /* ignore */ }

    return blocks;
  }

  function extractSource(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll("br").forEach(br => br.replaceWith("\n"));
    clone.querySelectorAll("div, p").forEach(block => {
      block.prepend(document.createTextNode("\n"));
    });
    return decodeHtmlEntities((clone.textContent || "").trim());
  }

  // Some hosts (Azure DevOps for unknown-language fences) double-encode
  // code-block contents — the HTML contains `&amp;gt;`, so textContent
  // yields the literal string `&gt;`. Run one extra decode pass so arrows
  // like `->` and `-->` survive. No-op on correctly-encoded hosts.
  function decodeHtmlEntities(text) {
    if (!/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/i.test(text)) return text;
    const ta = document.createElement("textarea");
    ta.innerHTML = text;
    return ta.value;
  }

  function classifySource(text) {
    if (isMermaidSyntax(text)) return "mermaid";
    if (isPlantumlSyntax(text)) return "plantuml";
    if (isDotSyntax(text)) return "dot";
    return null;
  }

  function isMermaidSyntax(text) {
    const trimmed = text.trimStart();
    let cleaned = trimmed.replace(/^---[\s\S]*?---\s*/g, '');
    cleaned = cleaned.replace(/^%%\{[\s\S]*?\}%%\s*/g, '');
    cleaned = cleaned.trimStart();
    return MERMAID_KEYWORDS.some(kw => cleaned.startsWith(kw));
  }

  function isPlantumlSyntax(text) {
    const trimmed = text.trimStart();
    return PLANTUML_KEYWORDS.some(kw => trimmed.startsWith(kw));
  }

  function isDotSyntax(text) {
    return DOT_SYNTAX_RE.test(text);
  }

  // ─── Render a Single Block ─────────────────────────────────────────
  async function renderBlock(block) {
    const { element, source, kind } = block;

    // Guard: element must still be in the DOM (SPA may have navigated away)
    if (!element.isConnected) return;
    if (element.hasAttribute(RENDERED_ATTR)) return;

    if (kind === "mermaid" && !initialized && !initMermaid(currentTheme)) {
      console.error("[Mermaid Ext] mermaid library not available");
      return;
    }

    const id = `mermaid-ext-${renderCounter++}`;

    const container = document.createElement("div");
    container.className = CONTAINER_CLASS;
    container.setAttribute("data-mermaid-ext-id", id);
    container.setAttribute("data-mermaid-ext-kind", kind);
    container.innerHTML = '<div class="mermaid-ext-loading"><div class="mermaid-ext-spinner"></div><span>Rendering diagram...</span></div>';

    const parent = element.closest("pre") || element;

    // Guard: parent must still be in the DOM
    if (!parent.isConnected || !parent.parentNode) return;
    parent.parentNode.insertBefore(container, parent.nextSibling);

    try {
      const cacheKey = `${kind}:${source}`;
      let svgText = renderCache.get(cacheKey);
      if (svgText === undefined) {
        svgText = kind === "plantuml" ? await renderPlantuml(source)
                : kind === "dot"      ? await renderDot(source)
                : await renderMermaid(id, source);
        renderCache.set(cacheKey, svgText);
      }

      // Guard: check everything is still in the DOM after async render
      if (!element.isConnected || !container.isConnected) {
        container.remove();
        return;
      }

      container.innerHTML = "";

      const wrapper = document.createElement("div");
      wrapper.className = "mermaid-ext-diagram";
      const shadow = wrapper.attachShadow({ mode: "open" });
      shadow.innerHTML = `
        <style>
          :host { display: flex; justify-content: center; align-items: center; padding: 16px; cursor: zoom-in; min-height: 60px; overflow: auto; }
          svg { max-width: 100%; height: auto; }
        </style>
        ${svgText}`;

      const toolbar = createToolbar(source, shadow, parent, kind);
      container.appendChild(toolbar);
      container.appendChild(wrapper);

      wrapper.addEventListener("click", () => {
        const liveSvg = shadow.querySelector("svg");
        if (liveSvg) openZoomOverlay(liveSvg);
      });

      element.setAttribute(RENDERED_ATTR, "true");
      parent.classList.add("mermaid-ext-original-hidden");
      container.setAttribute("data-source-visible", "false");

    } catch (err) {
      const orphan = document.getElementById(id);
      if (orphan) orphan.remove();
      const orphanD = document.getElementById("d" + id);
      if (orphanD) orphanD.remove();

      if (container.isConnected) {
        const label = kind === "plantuml" ? "PlantUML rendering error"
                    : kind === "dot"      ? "DOT rendering error"
                    : "Mermaid rendering error";
        container.innerHTML = `
          <div class="mermaid-ext-error">
            <div class="mermaid-ext-error-header">
              <span class="mermaid-ext-error-icon">⚠</span>
              <span>${escapeHtml(label)}</span>
            </div>
            <pre class="mermaid-ext-error-message">${escapeHtml(err.message || String(err))}</pre>
          </div>`;
      }
    }
  }

  async function renderMermaid(id, source) {
    const tempContainer = document.createElement("div");
    tempContainer.style.cssText = "position:fixed;top:-9999px;left:-9999px;visibility:hidden;";
    document.body.appendChild(tempContainer);
    try {
      const { svg } = await mermaid.render(id, source, tempContainer);
      return svg;
    } finally {
      tempContainer.remove();
    }
  }

  async function renderPlantuml(source) {
    if (!window.plantumlEncoder || typeof window.plantumlEncoder.encode !== "function") {
      throw new Error("PlantUML encoder not available");
    }
    const encoded = await window.plantumlEncoder.encode(source);
    const base = (plantumlServer || DEFAULT_PLANTUML_SERVER).replace(/\/+$/, "");
    const url = `${base}/svg/${encoded}`;
    const response = await fetch(url);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`${response.status} ${response.statusText}\n${body.slice(0, 2048)}`);
    }
    const text = await response.text();
    if (!/<svg[\s>]/i.test(text)) {
      throw new Error(`Unexpected response from ${base}:\n${text.slice(0, 2048)}`);
    }
    return text;
  }

  // Kroki-compatible DOT rendering. Compresses with zlib (CompressionStream
  // 'deflate') then encodes as URL-safe base64 — matches kroki.io's
  // /graphviz/svg/<encoded> endpoint.
  async function krokiEncode(source) {
    const bytes = new TextEncoder().encode(source);
    const stream = new Response(bytes).body.pipeThrough(new CompressionStream("deflate"));
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    let binary = "";
    for (let i = 0; i < compressed.length; i++) binary += String.fromCharCode(compressed[i]);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_");
  }

  async function renderDot(source) {
    const encoded = await krokiEncode(source);
    const base = (dotServer || DEFAULT_DOT_SERVER).replace(/\/+$/, "");
    const url = `${base}/graphviz/svg/${encoded}`;
    const response = await fetch(url);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`${response.status} ${response.statusText}\n${body.slice(0, 2048)}`);
    }
    const text = await response.text();
    if (!/<svg[\s>]/i.test(text)) {
      throw new Error(`Unexpected response from ${base}:\n${text.slice(0, 2048)}`);
    }
    return text;
  }

  // ─── Toolbar ────────────────────────────────────────────────────────
  function createToolbar(source, diagramWrapper, originalPre, kind) {
    const toolbar = document.createElement("div");
    toolbar.className = "mermaid-ext-toolbar";
    const sourceLabel = kind === "plantuml" ? "PlantUML"
                       : kind === "dot"     ? "DOT"
                       : "Mermaid";

    const toggleBtn = document.createElement("button");
    toggleBtn.className = "mermaid-ext-btn";
    toggleBtn.textContent = "Source";
    toggleBtn.title = "Toggle source code";
    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isHidden = originalPre.classList.contains("mermaid-ext-original-hidden");
      if (isHidden) {
        originalPre.classList.remove("mermaid-ext-original-hidden");
        toggleBtn.classList.add("mermaid-ext-btn-active");
      } else {
        originalPre.classList.add("mermaid-ext-original-hidden");
        toggleBtn.classList.remove("mermaid-ext-btn-active");
      }
    });

    const copySvgBtn = document.createElement("button");
    copySvgBtn.className = "mermaid-ext-btn";
    copySvgBtn.textContent = "Copy SVG";
    copySvgBtn.title = "Copy SVG to clipboard";
    copySvgBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const svgEl = diagramWrapper.querySelector("svg");
      if (svgEl) {
        navigator.clipboard.writeText(svgEl.outerHTML).then(() => {
          copySvgBtn.textContent = "Copied!";
          setTimeout(() => { copySvgBtn.textContent = "Copy SVG"; }, 1500);
        });
      }
    });

    const copySrcBtn = document.createElement("button");
    copySrcBtn.className = "mermaid-ext-btn";
    copySrcBtn.textContent = "Copy Source";
    copySrcBtn.title = `Copy ${sourceLabel} source to clipboard`;
    copySrcBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(source).then(() => {
        copySrcBtn.textContent = "Copied!";
        setTimeout(() => { copySrcBtn.textContent = "Copy Source"; }, 1500);
      });
    });

    const zoomBtn = document.createElement("button");
    zoomBtn.className = "mermaid-ext-btn";
    zoomBtn.textContent = "Zoom";
    zoomBtn.title = "Open diagram in fullscreen";
    zoomBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const svgEl = diagramWrapper.querySelector("svg");
      if (svgEl) openZoomOverlay(svgEl);
    });

    toolbar.appendChild(toggleBtn);
    toolbar.appendChild(copySvgBtn);
    toolbar.appendChild(copySrcBtn);
    toolbar.appendChild(zoomBtn);

    return toolbar;
  }

  // ─── Zoom Overlay ───────────────────────────────────────────────────
  const MIN_SCALE = 0.25;
  const MAX_SCALE = 5;
  const BUTTON_STEP = 0.25;
  const WHEEL_STEP = 0.1;
  const FIT_W_RATIO = 0.95;
  const FIT_H_RATIO = 0.90;

  function openZoomOverlay(svgElement) {
    const existing = document.getElementById("mermaid-ext-zoom-overlay");
    if (existing) existing.remove();
    if (!svgElement) return;

    // Mermaid SVGs declare width="100%" with no intrinsic height, so a clone
    // detached from its container collapses to the ~300×150 CSS default.
    // Measure the live element first and size the clone in explicit pixels.
    let baseWidth = 0;
    let baseHeight = 0;
    const rect = svgElement.getBoundingClientRect();
    baseWidth = rect.width;
    baseHeight = rect.height;
    if ((!baseWidth || !baseHeight) && svgElement.viewBox && svgElement.viewBox.baseVal) {
      baseWidth = svgElement.viewBox.baseVal.width || baseWidth;
      baseHeight = svgElement.viewBox.baseVal.height || baseHeight;
    }

    const maxInitW = window.innerWidth * FIT_W_RATIO;
    const maxInitH = window.innerHeight * FIT_H_RATIO;
    if (baseWidth > maxInitW || baseHeight > maxInitH) {
      const fit = Math.min(maxInitW / baseWidth, maxInitH / baseHeight);
      baseWidth *= fit;
      baseHeight *= fit;
    }

    const overlay = document.createElement("div");
    overlay.id = "mermaid-ext-zoom-overlay";
    overlay.className = "mermaid-ext-zoom-overlay";

    const close = () => {
      overlay.remove();
      document.removeEventListener("keydown", onKeydown);
    };
    const onKeydown = (e) => { if (e.key === "Escape") close(); };

    const closeBtn = document.createElement("button");
    closeBtn.className = "mermaid-ext-zoom-close";
    closeBtn.textContent = "\u00D7";
    closeBtn.title = "Close (Esc)";
    closeBtn.addEventListener("click", close);

    const content = document.createElement("div");
    content.className = "mermaid-ext-zoom-content";

    const svg = svgElement.cloneNode(true);
    svg.style.maxWidth = "none";
    svg.style.maxHeight = "none";
    if (baseWidth && baseHeight) {
      svg.style.width = baseWidth + "px";
      svg.style.height = baseHeight + "px";
    }
    content.appendChild(svg);

    const zoomControls = document.createElement("div");
    zoomControls.className = "mermaid-ext-zoom-controls";
    zoomControls.innerHTML = `
      <button class="mermaid-ext-btn" id="mermaid-ext-zoom-out" title="Zoom out">\u2212</button>
      <span id="mermaid-ext-zoom-level">100%</span>
      <button class="mermaid-ext-btn" id="mermaid-ext-zoom-in" title="Zoom in">+</button>
      <button class="mermaid-ext-btn" id="mermaid-ext-zoom-reset" title="Reset zoom">Reset</button>
    `;

    overlay.appendChild(closeBtn);
    overlay.appendChild(zoomControls);
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    const zoomLevelEl = overlay.querySelector("#mermaid-ext-zoom-level");
    let scale = 1;
    const setScale = (next) => {
      scale = Math.min(Math.max(next, MIN_SCALE), MAX_SCALE);
      if (baseWidth && baseHeight) {
        svg.style.width = (baseWidth * scale) + "px";
        svg.style.height = (baseHeight * scale) + "px";
      }
      zoomLevelEl.textContent = `${Math.round(scale * 100)}%`;
    };

    overlay.querySelector("#mermaid-ext-zoom-in").addEventListener("click", () => setScale(scale + BUTTON_STEP));
    overlay.querySelector("#mermaid-ext-zoom-out").addEventListener("click", () => setScale(scale - BUTTON_STEP));
    overlay.querySelector("#mermaid-ext-zoom-reset").addEventListener("click", () => setScale(1));
    overlay.addEventListener("wheel", (e) => {
      e.preventDefault();
      setScale(scale + (e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP));
    }, { passive: false });

    document.addEventListener("keydown", onKeydown);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  }

  // ─── Full-page scan with retry ──────────────────────────────────────
  // SPA frameworks render content asynchronously. A single scan right
  // after navigation often fires before the markdown/code blocks are in
  // the DOM. We retry with increasing delays to catch late renders.
  let scanTimer = null;
  function scheduleScan(delaysMs) {
    // Cancel any pending scan sequence
    if (scanTimer) clearTimeout(scanTimer);

    function attempt(index) {
      if (!extensionEnabled) return;
      const blocks = detectBlocks();
      if (blocks.length > 0) renderAllBlocks(blocks);
      // Keep running the cascade even after a find — blocks can arrive
      // later in the same SPA transition (e.g. markdown preview batches).
      // renderAllBlocks dedups by element, so repeat detections are free.
      if (index < delaysMs.length - 1) {
        scanTimer = setTimeout(() => attempt(index + 1), delaysMs[index + 1] - delaysMs[index]);
      }
    }

    // First attempt immediately or after the first delay
    if (delaysMs[0] === 0) {
      attempt(0);
    } else {
      scanTimer = setTimeout(() => attempt(0), delaysMs[0]);
    }
  }

  // Delays for retry scans after SPA navigation (ms from navigation event)
  const SPA_SCAN_DELAYS = [0, 150, 400, 800, 1500];

  // ─── MutationObserver ───────────────────────────────────────────────
  function setupObserver() {
    const observer = new MutationObserver((mutations) => {
      if (!extensionEnabled) return;

      // Check if this looks like a major content swap (SPA navigation).
      // Heuristic: if any single mutation added a large subtree, treat it
      // as a navigation and do a full-page scan with retries.
      let majorChange = false;
      const addedRoots = new Set();

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            addedRoots.add(node);
            // A node with many descendants is likely a page-level swap
            if (node.childNodes && node.childNodes.length > 10) {
              majorChange = true;
            }
          }
        }
      }

      if (majorChange) {
        // Likely SPA navigation — do a full scan with retry cascade.
        // The content may still be loading, so retries are essential.
        scheduleScan(SPA_SCAN_DELAYS);
        return;
      }
      // Small mutation — render synchronously in the observer callback so
      // cache-hit re-renders (after hosts like ADO wipe our container on
      // their own re-render) land before the next browser paint. This is
      // what eliminates the "diagram → text → diagram" flicker.
      for (const root of addedRoots) {
        if (!root.isConnected) continue;
        const blocks = detectBlocks(root);
        if (blocks.length > 0) renderAllBlocks(blocks);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  // ─── URL Change Detection ───────────────────────────────────────────
  // SPA navigation via pushState/replaceState doesn't trigger
  // MutationObserver immediately. We intercept these calls and also
  // listen for popstate (back/forward).
  function setupUrlChangeDetection() {
    let lastUrl = location.href;

    function onUrlChange() {
      const newUrl = location.href;
      if (newUrl === lastUrl) return;
      lastUrl = newUrl;

      // Clean up stale rendered diagrams whose original elements are
      // no longer in the DOM (previous page's content was removed).
      document.querySelectorAll("." + CONTAINER_CLASS).forEach(el => {
        const id = el.getAttribute("data-mermaid-ext-id");
        // If the container's preceding sibling (the original code block)
        // is gone, remove the container too.
        if (!el.previousElementSibling ||
            !el.previousElementSibling.classList.contains("mermaid-ext-original-hidden")) {
          // Could be orphaned — but we'll let the scan handle fresh content.
        }
      });

      // Schedule a scan cascade for the new page content
      scheduleScan(SPA_SCAN_DELAYS);
    }

    // Intercept history.pushState and replaceState
    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;

    history.pushState = function () {
      origPushState.apply(this, arguments);
      onUrlChange();
    };
    history.replaceState = function () {
      origReplaceState.apply(this, arguments);
      onUrlChange();
    };

    // Back/forward navigation
    window.addEventListener("popstate", onUrlChange);

    // Some SPAs use hashchange
    window.addEventListener("hashchange", onUrlChange);

    // GitHub Turbo-specific: listen for turbo:load
    document.addEventListener("turbo:load", onUrlChange);

    // GitLab / generic: listen for page:load, content:loaded, etc.
    document.addEventListener("page:load", onUrlChange);
    document.addEventListener("content:loaded", onUrlChange);
  }

  // ─── Render All Blocks ──────────────────────────────────────────────
  // Enqueue blocks into a single shared queue. If a render loop is already
  // active, it drains the queue when it gets there — callers that fire
  // during an in-flight render no longer drop blocks on the floor.
  async function renderAllBlocks(blocks) {
    let queued = 0;
    for (const block of blocks) {
      if (queuedElements.has(block.element)) continue;
      queuedElements.add(block.element);
      pendingQueue.push(block);
      queued++;
    }
    if (activeRender) return queued;
    activeRender = drainQueue();
    try { await activeRender; } finally { activeRender = null; }
    return queued;
  }

  async function drainQueue() {
    let rendered = 0;
    while (pendingQueue.length > 0) {
      const block = pendingQueue.shift();
      try {
        await renderBlock(block);
        rendered++;
      } catch (e) {
        console.error("[Mermaid Ext] Failed to render block:", e);
      }
    }
    if (rendered > 0) {
      try {
        chrome.runtime.sendMessage({ type: "DIAGRAMS_RENDERED", count: rendered });
      } catch (e) { /* Extension context may be invalid */ }
    }
  }

  // ─── Re-render All ──────────────────────────────────────────────────
  async function reRenderAll(theme) {
    document.querySelectorAll("." + CONTAINER_CLASS).forEach(el => el.remove());
    document.querySelectorAll("[" + RENDERED_ATTR + "]").forEach(el => {
      el.removeAttribute(RENDERED_ATTR);
      const parent = el.closest("pre") || el;
      parent.classList.remove("mermaid-ext-original-hidden");
    });

    renderCounter = 0;
    initialized = false;
    initMermaid(theme);

    const blocks = detectBlocks();
    await renderAllBlocks(blocks);
  }

  // ─── Message Handler ────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "GET_STATUS") {
      const count = document.querySelectorAll("." + CONTAINER_CLASS).length;
      sendResponse({ count, theme: currentTheme, enabled: extensionEnabled });
      return true;
    }
    if (msg.type === "THEME_CHANGED") {
      reRenderAll(msg.theme);
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "TOGGLE_ENABLED") {
      extensionEnabled = msg.enabled;
      if (!extensionEnabled) {
        document.querySelectorAll("." + CONTAINER_CLASS).forEach(el => el.remove());
        document.querySelectorAll("[" + RENDERED_ATTR + "]").forEach(el => {
          el.removeAttribute(RENDERED_ATTR);
          const parent = el.closest("pre") || el;
          parent.classList.remove("mermaid-ext-original-hidden");
        });
      } else {
        const blocks = detectBlocks();
        renderAllBlocks(blocks);
      }
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "RE_RENDER_ALL") {
      reRenderAll(currentTheme);
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "PLANTUML_SERVER_CHANGED") {
      plantumlServer = msg.server || DEFAULT_PLANTUML_SERVER;
      reRenderAll(currentTheme);
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "DOT_SERVER_CHANGED") {
      dotServer = msg.server || DEFAULT_DOT_SERVER;
      reRenderAll(currentTheme);
      sendResponse({ ok: true });
      return true;
    }
  });

  // ─── Utility ────────────────────────────────────────────────────────
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── Main Entry ─────────────────────────────────────────────────────
  async function main() {
    let theme = "default";
    try {
      const result = await chrome.storage.sync.get(["theme", "enabled", "plantumlServer", "dotServer"]);
      theme = result.theme || "default";
      extensionEnabled = result.enabled !== false;
      plantumlServer = result.plantumlServer || DEFAULT_PLANTUML_SERVER;
      dotServer = result.dotServer || DEFAULT_DOT_SERVER;
    } catch (e) { /* ignore */ }

    if (!extensionEnabled) return;

    // Always initialize mermaid eagerly so it's ready for SPA-loaded
    // content. This avoids the race where the observer finds blocks
    // before mermaid.initialize() has been called.
    if (!initMermaid(theme)) {
      console.error("[Mermaid Ext] mermaid library not available");
      return;
    }

    // Watch for SPA navigation and dynamic content first so anything the
    // page adds *during* the scan cascade still gets picked up.
    setupObserver();
    setupUrlChangeDetection();

    // Initial scan uses the same retry cascade as SPA transitions — some
    // hosts (e.g. Azure DevOps markdown preview) add diagram blocks after
    // document_idle, so a single scan would miss the late arrivals.
    scheduleScan(SPA_SCAN_DELAYS);
  }

  main();
})();
