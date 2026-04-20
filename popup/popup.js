/**
 * Mermaid Diagram Previewer - Popup Script
 */
(function () {
  "use strict";

  let currentTheme = "default";
  let renderCounter = 0;
  const DEFAULT_PLANTUML_SERVER = "https://www.plantuml.com/plantuml";
  const DEFAULT_DOT_SERVER = "https://kroki.io";

  // ─── Templates for all 23 diagram types ─────────────────────────────
  const TEMPLATES = {
    flowchart: `flowchart TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Process]
    B -->|No| D[End]
    C --> D`,

    sequence: `sequenceDiagram
    participant A as Alice
    participant B as Bob
    A->>B: Hello Bob!
    B-->>A: Hi Alice!
    A->>B: How are you?
    B-->>A: Great, thanks!`,

    class: `classDiagram
    class Animal {
        +String name
        +int age
        +makeSound()
    }
    class Dog {
        +fetch()
    }
    class Cat {
        +scratch()
    }
    Animal <|-- Dog
    Animal <|-- Cat`,

    state: `stateDiagram-v2
    [*] --> Idle
    Idle --> Processing : Submit
    Processing --> Success : Done
    Processing --> Error : Fail
    Success --> [*]
    Error --> Idle : Retry`,

    er: `erDiagram
    CUSTOMER ||--o{ ORDER : places
    ORDER ||--|{ LINE-ITEM : contains
    PRODUCT ||--o{ LINE-ITEM : "is in"
    CUSTOMER {
        string name
        string email
    }
    ORDER {
        int id
        date created
    }`,

    gantt: `gantt
    title Project Timeline
    dateFormat YYYY-MM-DD
    section Design
        Wireframes     :a1, 2024-01-01, 7d
        Mockups        :a2, after a1, 5d
    section Development
        Frontend       :b1, after a2, 14d
        Backend        :b2, after a2, 14d
    section Testing
        QA             :c1, after b1, 7d`,

    pie: `pie title Browser Market Share
    "Chrome" : 65
    "Safari" : 19
    "Firefox" : 4
    "Edge" : 4
    "Other" : 8`,

    mindmap: `mindmap
    root((Project))
        Frontend
            React
            CSS
            TypeScript
        Backend
            Node.js
            Database
            API
        DevOps
            CI/CD
            Monitoring`,

    timeline: `timeline
    title Product Launch Timeline
    2024-Q1 : Research
            : User Interviews
    2024-Q2 : Design
            : Prototyping
    2024-Q3 : Development
            : Testing
    2024-Q4 : Launch
            : Marketing`,

    gitgraph: `gitGraph
    commit
    commit
    branch feature
    checkout feature
    commit
    commit
    checkout main
    merge feature
    commit`,

    quadrant: `quadrantChart
    title Reach and engagement of campaigns
    x-axis Low Reach --> High Reach
    y-axis Low Engagement --> High Engagement
    quadrant-1 We should expand
    quadrant-2 Need to promote
    quadrant-3 Re-evaluate
    quadrant-4 May be improved
    Campaign A: [0.3, 0.6]
    Campaign B: [0.45, 0.23]
    Campaign C: [0.57, 0.69]
    Campaign D: [0.78, 0.34]`,

    requirement: `requirementDiagram
    requirement test_req {
        id: 1
        text: The system shall do X
        risk: high
        verifymethod: test
    }
    element test_entity {
        type: simulation
    }
    test_entity - satisfies -> test_req`,

    c4: `C4Context
    title System Context Diagram
    Person(user, "User", "A user of the system")
    System(system, "System", "The main system")
    System_Ext(email, "Email System", "Sends emails")
    Rel(user, system, "Uses")
    Rel(system, email, "Sends emails using")`,

    sankey: `sankey-beta

Agricultural "ichthyol" waste,Bio-conversion,124.729
Bio-conversion,Liquid,0.597
Bio-conversion,Losses,26.862
Bio-conversion,Solid,280.322
Bio-conversion,Gas,81.144`,

    xychart: `xychart-beta
    title "Sales Revenue"
    x-axis [Jan, Feb, Mar, Apr, May, Jun]
    y-axis "Revenue (in $)" 4000 --> 11000
    bar [5000, 6000, 7500, 8200, 9800, 10500]
    line [5000, 6000, 7500, 8200, 9800, 10500]`,

    block: `block-beta
    columns 3
    a["Frontend"] b["API Gateway"] c["Backend"]
    d["Database"]:3`,

    packet: `packet-beta
    0-15: "Source Port"
    16-31: "Destination Port"
    32-63: "Sequence Number"
    64-95: "Acknowledgment Number"
    96-99: "Data Offset"
    100-105: "Reserved"
    106-111: "Flags"
    112-127: "Window Size"`,

    kanban: `kanban
    Todo
        id1[Task 1]
        id2[Task 2]
    In Progress
        id3[Task 3]
    Done
        id4[Task 4]`,

    architecture: `architecture-beta
    group api(cloud)[API]

    service db(database)[Database] in api
    service server(server)[Server] in api
    service disk(disk)[Storage] in api

    db:R -- L:server
    server:R -- L:disk`,

    journey: `journey
    title My working day
    section Go to work
        Make tea: 5: Me
        Go upstairs: 3: Me
        Do work: 1: Me, Cat
    section Go home
        Go downstairs: 5: Me
        Sit down: 5: Me`,

    zenuml: `zenuml
    title Order Service
    @Actor Client
    @Boundary OrderController
    @Entity OrderService

    Client->OrderController.binds("bindForm") {
        OrderController->OrderService.binds("bindForm") {
            return bindedForm
        }
    }`,
  };

  // ─── Initialize ─────────────────────────────────────────────────────
  async function init() {
    // Load saved settings
    try {
      const result = await chrome.storage.sync.get(["theme", "enabled", "plantumlServer", "dotServer"]);
      currentTheme = result.theme || "default";
      const enabled = result.enabled !== false;

      document.getElementById("enableToggle").checked = enabled;
      setActiveTheme(currentTheme);

      const serverInput = document.getElementById("plantumlServer");
      if (serverInput) {
        serverInput.value = result.plantumlServer && result.plantumlServer !== DEFAULT_PLANTUML_SERVER
          ? result.plantumlServer
          : "";
      }

      const dotInput = document.getElementById("dotServer");
      if (dotInput) {
        dotInput.value = result.dotServer && result.dotServer !== DEFAULT_DOT_SERVER
          ? result.dotServer
          : "";
      }
    } catch (e) { /* ignore */ }

    // Initialize mermaid for popup preview
    if (typeof mermaid !== "undefined") {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "loose",
        theme: currentTheme,
        logLevel: "error",
      });
    }

    // Get status from current tab
    updateStatus();

    // Setup event listeners
    setupListeners();

    // Auto-render the default template
    renderPreview();
  }

  // ─── Status ─────────────────────────────────────────────────────────
  async function updateStatus() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) return;

      chrome.tabs.sendMessage(tab.id, { type: "GET_STATUS" }, (response) => {
        const statusText = document.getElementById("statusText");
        const statusDot = document.querySelector(".status-dot");

        if (chrome.runtime.lastError || !response) {
          statusText.textContent = "Not active on this page";
          statusDot.className = "status-dot inactive";
          return;
        }

        if (response.count > 0) {
          statusText.textContent = `${response.count} diagram${response.count !== 1 ? 's' : ''} rendered on this page`;
          statusDot.className = "status-dot found";
        } else {
          statusText.textContent = "No Mermaid diagrams found on this page";
          statusDot.className = "status-dot";
        }
      });
    } catch (e) {
      document.getElementById("statusText").textContent = "Unable to check page";
    }
  }

  // ─── Event Listeners ────────────────────────────────────────────────
  function setupListeners() {
    // Enable/Disable toggle
    document.getElementById("enableToggle").addEventListener("change", async (e) => {
      const enabled = e.target.checked;
      await chrome.storage.sync.set({ enabled });

      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.id) {
          chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_ENABLED", enabled });
        }
      } catch (e) { /* ignore */ }
    });

    // Theme buttons
    document.querySelectorAll(".theme-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const theme = btn.dataset.theme;
        currentTheme = theme;
        setActiveTheme(theme);

        // Save and notify
        await chrome.storage.sync.set({ theme });

        // Re-init mermaid for popup preview
        if (typeof mermaid !== "undefined") {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "loose",
            theme: currentTheme,
            logLevel: "error",
          });
        }

        // Re-render popup preview
        renderPreview();

        // Notify content script
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab && tab.id) {
            chrome.tabs.sendMessage(tab.id, { type: "THEME_CHANGED", theme });
          }
        } catch (e) { /* ignore */ }
      });
    });

    // Template selector
    document.getElementById("templateSelect").addEventListener("change", (e) => {
      const key = e.target.value;
      if (key && TEMPLATES[key]) {
        document.getElementById("editor").value = TEMPLATES[key];
        renderPreview();
      }
      e.target.value = ""; // Reset dropdown
    });

    // Render button
    document.getElementById("renderBtn").addEventListener("click", renderPreview);

    // Ctrl+Enter to render
    document.getElementById("editor").addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        renderPreview();
      }
      // Tab key inserts spaces
      if (e.key === "Tab") {
        e.preventDefault();
        const textarea = e.target;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        textarea.value = textarea.value.substring(0, start) + "    " + textarea.value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + 4;
      }
    });

    // Copy SVG button
    document.getElementById("copyBtn").addEventListener("click", () => {
      const preview = document.getElementById("preview");
      const svg = preview.querySelector("svg");
      if (svg) {
        navigator.clipboard.writeText(svg.outerHTML).then(() => {
          const btn = document.getElementById("copyBtn");
          btn.textContent = "Copied!";
          setTimeout(() => { btn.textContent = "Copy SVG"; }, 1500);
        });
      }
    });

    // Clear button
    document.getElementById("clearBtn").addEventListener("click", () => {
      document.getElementById("editor").value = "";
      document.getElementById("preview").innerHTML = '<div class="preview-placeholder">Click "Render" to preview your diagram</div>';
      document.getElementById("previewError").style.display = "none";
    });

    // Server URL inputs: one for PlantUML, one for DOT/Kroki.
    bindServerInput("plantumlServer", DEFAULT_PLANTUML_SERVER, "PLANTUML_SERVER_CHANGED");
    bindServerInput("dotServer", DEFAULT_DOT_SERVER, "DOT_SERVER_CHANGED");
  }

  function bindServerInput(storageKey, defaultValue, messageType) {
    const input = document.getElementById(storageKey);
    if (!input) return;
    input.addEventListener("change", async () => {
      const raw = input.value.trim();
      const server = raw || defaultValue;
      if (raw && !isValidUrl(raw)) {
        input.classList.add("invalid");
        return;
      }
      input.classList.remove("invalid");
      await chrome.storage.sync.set({ [storageKey]: server });
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.id) {
          chrome.tabs.sendMessage(tab.id, { type: messageType, server });
        }
      } catch (e) { /* ignore */ }
    });
  }

  function isValidUrl(value) {
    try {
      const u = new URL(value);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch (e) {
      return false;
    }
  }

  // ─── Render Preview ─────────────────────────────────────────────────
  async function renderPreview() {
    const source = document.getElementById("editor").value.trim();
    const preview = document.getElementById("preview");
    const errorEl = document.getElementById("previewError");

    if (!source) {
      preview.innerHTML = '<div class="preview-placeholder">Enter Mermaid syntax and click "Render"</div>';
      errorEl.style.display = "none";
      return;
    }

    if (typeof mermaid === "undefined") {
      errorEl.textContent = "Mermaid library not loaded";
      errorEl.style.display = "block";
      return;
    }

    preview.innerHTML = '<div class="preview-placeholder">Rendering...</div>';
    errorEl.style.display = "none";

    try {
      const id = `popup-mermaid-${renderCounter++}`;
      const { svg } = await mermaid.render(id, source);
      preview.innerHTML = svg;
    } catch (err) {
      preview.innerHTML = '<div class="preview-placeholder">Rendering failed</div>';
      errorEl.textContent = err.message || String(err);
      errorEl.style.display = "block";
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────
  function setActiveTheme(theme) {
    document.querySelectorAll(".theme-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.theme === theme);
    });
  }

  // ─── Start ──────────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", init);
})();
