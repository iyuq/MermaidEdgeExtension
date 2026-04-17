/**
 * Mermaid Diagram Previewer - Content Script
 * Detects and renders Mermaid diagrams on web pages.
 * Handles SPA navigation (GitHub Turbo/PJAX, GitLab, Azure DevOps, etc.).
 */
(function () {
  "use strict";

  const RENDERED_ATTR = "data-mermaid-ext-rendered";
  const CONTAINER_CLASS = "mermaid-ext-container";
  let renderCounter = 0;
  let initialized = false;
  let currentTheme = "default";
  let extensionEnabled = true;
  let isRendering = false; // guard against concurrent render passes

  // ─── Detection Selectors ────────────────────────────────────────────
  const SELECTORS = [
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

  // ─── Detect Mermaid Blocks ──────────────────────────────────────────
  function detectBlocks(root) {
    const blocks = [];
    const seen = new Set();

    const searchRoot = root || document;

    // Query by selectors
    for (const selector of SELECTORS) {
      try {
        const elements = searchRoot.querySelectorAll(selector);
        for (const el of elements) {
          if (el.hasAttribute(RENDERED_ATTR) || seen.has(el)) continue;
          const source = extractSource(el);
          if (source && isMermaidSyntax(source)) {
            seen.add(el);
            blocks.push({ element: el, source });
          }
        }
      } catch (e) { /* ignore invalid selectors */ }
    }

    // Fallback: scan all <code> elements inside <pre> tags
    try {
      const allCode = searchRoot.querySelectorAll("pre > code");
      for (const el of allCode) {
        if (el.hasAttribute(RENDERED_ATTR) || seen.has(el)) continue;
        const source = extractSource(el);
        if (source && isMermaidSyntax(source)) {
          seen.add(el);
          blocks.push({ element: el, source });
        }
      }
    } catch (e) { /* ignore */ }

    return blocks;
  }

  function extractSource(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll("br").forEach(br => br.replaceWith("\n"));
    clone.querySelectorAll("div, p").forEach(block => {
      block.prepend(document.createTextNode("\n"));
    });
    return (clone.textContent || "").trim();
  }

  function isMermaidSyntax(text) {
    const trimmed = text.trimStart();
    let cleaned = trimmed.replace(/^---[\s\S]*?---\s*/g, '');
    cleaned = cleaned.replace(/^%%\{[\s\S]*?\}%%\s*/g, '');
    cleaned = cleaned.trimStart();
    return MERMAID_KEYWORDS.some(kw => cleaned.startsWith(kw));
  }

  // ─── Render a Single Block ─────────────────────────────────────────
  async function renderBlock(block) {
    const { element, source } = block;

    // Guard: element must still be in the DOM (SPA may have navigated away)
    if (!element.isConnected) return;
    if (element.hasAttribute(RENDERED_ATTR)) return;

    // Ensure mermaid is initialized
    if (!initialized && !initMermaid(currentTheme)) {
      console.error("[Mermaid Ext] mermaid library not available");
      return;
    }

    const id = `mermaid-ext-${renderCounter++}`;

    const container = document.createElement("div");
    container.className = CONTAINER_CLASS;
    container.setAttribute("data-mermaid-ext-id", id);
    container.innerHTML = '<div class="mermaid-ext-loading"><div class="mermaid-ext-spinner"></div><span>Rendering diagram...</span></div>';

    const parent = element.closest("pre") || element;

    // Guard: parent must still be in the DOM
    if (!parent.isConnected || !parent.parentNode) return;
    parent.parentNode.insertBefore(container, parent.nextSibling);

    try {
      const tempContainer = document.createElement("div");
      tempContainer.style.cssText = "position:fixed;top:-9999px;left:-9999px;visibility:hidden;";
      document.body.appendChild(tempContainer);

      const { svg } = await mermaid.render(id, source, tempContainer);
      tempContainer.remove();

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
        ${svg}`;

      const toolbar = createToolbar(source, shadow, parent);
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
        container.innerHTML = `
          <div class="mermaid-ext-error">
            <div class="mermaid-ext-error-header">
              <span class="mermaid-ext-error-icon">⚠</span>
              <span>Mermaid rendering error</span>
            </div>
            <pre class="mermaid-ext-error-message">${escapeHtml(err.message || String(err))}</pre>
          </div>`;
      }
    }
  }

  // ─── Toolbar ────────────────────────────────────────────────────────
  function createToolbar(source, diagramWrapper, originalPre) {
    const toolbar = document.createElement("div");
    toolbar.className = "mermaid-ext-toolbar";

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
    copySrcBtn.title = "Copy Mermaid source to clipboard";
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
      if (blocks.length > 0) {
        renderAllBlocks(blocks);
        return; // found blocks — stop retrying
      }
      // Schedule next attempt if there are more delays
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
  let observerTimeout = null;
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

      clearTimeout(observerTimeout);

      if (majorChange) {
        // Likely SPA navigation — do a full scan with retry cascade.
        // The content may still be loading, so retries are essential.
        scheduleScan(SPA_SCAN_DELAYS);
      } else {
        // Small mutation — just scan the added subtrees after a short debounce
        observerTimeout = setTimeout(() => {
          for (const root of addedRoots) {
            if (!root.isConnected) continue;
            const blocks = detectBlocks(root);
            if (blocks.length > 0) {
              renderAllBlocks(blocks);
            }
          }
        }, 200);
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
  async function renderAllBlocks(blocks) {
    if (isRendering) return 0;
    isRendering = true;

    let rendered = 0;
    try {
      for (const block of blocks) {
        try {
          await renderBlock(block);
          rendered++;
        } catch (e) {
          console.error("[Mermaid Ext] Failed to render block:", e);
        }
      }
      if (rendered > 0) {
        try {
          chrome.runtime.sendMessage({
            type: "DIAGRAMS_RENDERED",
            count: rendered,
          });
        } catch (e) { /* Extension context may be invalid */ }
      }
    } finally {
      isRendering = false;
    }
    return rendered;
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
      const result = await chrome.storage.sync.get(["theme", "enabled"]);
      theme = result.theme || "default";
      extensionEnabled = result.enabled !== false;
    } catch (e) { /* ignore */ }

    if (!extensionEnabled) return;

    // Always initialize mermaid eagerly so it's ready for SPA-loaded
    // content. This avoids the race where the observer finds blocks
    // before mermaid.initialize() has been called.
    if (!initMermaid(theme)) {
      console.error("[Mermaid Ext] mermaid library not available");
      return;
    }

    // Initial scan
    const blocks = detectBlocks();
    if (blocks.length > 0) {
      await renderAllBlocks(blocks);
    }

    // Watch for SPA navigation and dynamic content
    setupObserver();
    setupUrlChangeDetection();
  }

  main();
})();
