# PlantUML and DOT support

## Purpose

Extend the Mermaid previewer to render PlantUML and DOT (Graphviz) diagrams inline alongside Mermaid, reusing a single detection → render → toolbar + zoom UX so all three kinds look and behave the same on the page. Introduce a minimal `npm run build` step so the distributable extension is a clean `dist/` folder instead of the whole repo.

## Scope

In:
- PlantUML source in fenced code blocks (`plantuml`, `puml`) and `@startuml` / `@startmindmap` / etc. blocks. Rendered via a configurable server (default `https://www.plantuml.com/plantuml`).
- DOT source in fenced code blocks (`dot`, `graphviz`) and content-sniffed untagged blocks matching `(strict )?(di)?graph NAME? { … }`. Rendered via a configurable Kroki-compatible server (default `https://kroki.io`).
- Detection of bare `<code>` (no `<pre>` wrapper, no language class) with multi-line content, so hosts that drop the language class (Azure DevOps for unknown-language fences) still work.
- HTML-entity decode pass on extracted source, so hosts that double-encode fence contents (ADO: `-&gt;` in DOT arrows) still produce valid syntax.
- New "Advanced" collapsible in the popup with two URL inputs (PlantUML server, DOT server).
- `npm install && npm run build` producing a `dist/` folder with source files copied verbatim, vendor libraries pulled from `node_modules`, and every `.js` / `.css` minified.

Out:
- Client-side PlantUML or DOT rendering. A local WASM Graphviz renderer (`@viz-js/viz`) was attempted and reverted: on managed Microsoft Edge installs the WASM bundle aborted with an unrecoverable Emscripten `CompileError: WebAssembly.instantiate():` that wasn't a catchable promise rejection. Server rendering sidesteps the issue and matches the PlantUML pattern.
- Rendered-output persistence across page loads. The cache lives only for the page's lifetime.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ detectBlocks()  ──► renderBlock()  ──► toolbar + shadow SVG │
└─────────────────────────────────────────────────────────────┘
                      │
                      ├── mermaid.render(source)                 ── Mermaid
                      ├── fetch(plantumlServer/svg/<encoded>)    ── PlantUML
                      └── fetch(dotServer/graphviz/svg/<enc>)    ── DOT
```

`detectBlocks` tags each block with `kind: 'mermaid' | 'plantuml' | 'dot'`. `renderBlock` branches on `kind`. Toolbar, zoom overlay, and error card are shared across all three.

## Components

### `lib/plantuml-encoder.js`
- Exports `window.plantumlEncoder.encode(source: string): Promise<string>`.
- Compresses via `CompressionStream('deflate-raw')` and applies PlantUML's custom 64-char alphabet (`0-9 A-Z a-z - _`), 3 bytes → 4 chars.
- ~55 lines, no external dep.

### `content/content.js`
- **Detection** — three selector lists (`MERMAID_SELECTORS`, `PLANTUML_SELECTORS`, `DOT_SELECTORS`) and three content matchers (`isMermaidSyntax`, `isPlantumlSyntax`, `isDotSyntax`). `classifySource` routes untagged `<pre><code>` and bare multi-line `<code>` blocks by content. `extractSource` decodes HTML entities one extra round so double-encoded hosts don't break DOT's `->` arrows or Mermaid's `-->`.
- **Rendering** — `renderMermaid`, `renderPlantuml`, and `renderDot` each return an SVG string. All three flow into the same shadow-DOM wrapper and toolbar. DOT uses a Kroki-style encoder: `CompressionStream('deflate')` + URL-safe base64, fetched at `${dotServer}/graphviz/svg/<encoded>`.
- **Render cache** — a module-scoped `Map` keyed by `kind:source` holds the rendered SVG text. On re-render (hosts that reactively rebuild their preview DOM — Azure DevOps does — cause the same block to be re-detected), the cache hit skips the network entirely, and the whole re-render runs inside the MutationObserver's microtask before the browser can paint the intermediate source-text state. This eliminates the "diagram → text → diagram" flicker.
- **Render queue** — concurrent calls to `renderAllBlocks` enqueue into a shared FIFO with `WeakSet` dedup. Callers that arrive mid-render no longer drop blocks; the active drain loop processes everything until the queue is empty.
- **Scan cascade** — retries `detectBlocks` at `[0, 150, 400, 800, 1500]` ms after each SPA-like transition, continuing through all delays even after finding something (dedup means repeats are free). Used for initial load too, so full page refreshes pick up late-arriving blocks.
- **Config** — `plantumlServer` and `dotServer` read from `chrome.storage.sync` on init. `PLANTUML_SERVER_CHANGED` / `DOT_SERVER_CHANGED` messages trigger `reRenderAll`.

### `popup/popup.html`, `popup.js`, `popup.css`
- New "Advanced" `<details>` collapsible with two labelled URL inputs.
- Per-input: on `change` the value is validated via `new URL()` (http/https only), saved to `chrome.storage.sync`, and broadcast as the matching `*_SERVER_CHANGED` message to the active tab. Invalid URL → red border; value is not saved. Blank value resets to the default.

### `manifest.json`
- Adds `lib/plantuml-encoder.js` to `content_scripts.js`, before `content.js`.
- `host_permissions: ["<all_urls>"]` covers both PlantUML and DOT server URLs.

### `package.json`, `scripts/build.mjs`, `.gitignore`
- `package.json` declares `mermaid` (runtime) plus `esbuild` and `playwright` (dev).
- `scripts/build.mjs` — cross-platform Node ESM script, roughly 100 lines:
  1. Cleans `dist/`.
  2. Copies `manifest.json`, `background/`, `content/`, `popup/`, `icons/`, and `lib/plantuml-encoder.js` verbatim.
  3. Copies `node_modules/mermaid/dist/mermaid.min.js` into `dist/lib/`.
  4. Minifies every `.js` and `.css` in `dist/` (skipping `*.min.js`) via `esbuild.transform` with `target: "chrome120"`. Roughly 49% size reduction on our own sources.
- `.gitignore` adds `dist/` and `node_modules/`. `lib/mermaid.min.js` is no longer tracked in the repo — ownership transferred to npm.

## Data flow

```
code block on page                  popup (Advanced)
       │                                  │
       ▼                                  ▼
detectBlocks() ──► { kind, source }  chrome.storage.sync
       │                                  │
       ▼                                  ▼
renderBlock(kind)            ◄───  plantumlServer / dotServer
       │
       ├── mermaid.render(source)                          (Mermaid: local)
       ├── fetch(plantumlServer/svg/<encoded>)             (PlantUML: server)
       └── fetch(dotServer/graphviz/svg/<encoded>)         (DOT: server)
       │
       ▼
renderCache.set(kind:source, svgText)
       │
       ▼
shadow DOM ← svgText → toolbar (Source, Copy SVG, Copy Source, Zoom)
```

## Error handling

- **Fetch failure, non-200, non-SVG response** — the existing error card with kind-specific header (`Mermaid rendering error` / `PlantUML rendering error` / `DOT rendering error`). Body is `response.status response.statusText` plus the first 2 KB of the response body.
- **PlantUML encoder unavailable** (e.g., `CompressionStream` missing) — error card with `PlantUML encoder not available`.
- **Invalid server URL in popup** — input gets a red border; value is not saved.
- **Detection mis-classification** — blocks that don't match any kind's content matcher are left alone.

## Testing / verification

`npm run validate` (`scripts/validate.mjs`) launches the built extension in Playwright-managed Chromium (`--headless=new`) and serves five fixtures against an intercepted URL: Mermaid, DOT, PlantUML, DOT with ADO-style double-encoded entities, and DOT in a bare `<code>` without `<pre>` wrapper. Asserts all render SVG; exits non-zero otherwise. Caught the entity-decoding and bare-`<code>` detection gaps during development; kept as a regression guard.

Manual:

1. Paste a `@startuml`/`@enduml` block and a ```` ```dot ```` block into the same markdown page; both render inline with working Source / Copy SVG / Copy Source / Zoom buttons.
2. Open the popup → Advanced. Change either server URL to a self-hosted instance; existing blocks re-render against the new server. Change to an invalid URL; red border, no save.
3. Mermaid on the same page remains unaffected throughout.
4. On a host that reactively re-renders its preview DOM (e.g. Azure DevOps), the diagrams stay rendered without a visible "diagram → text → diagram" flicker.

## Tradeoffs explicitly accepted

- Source leaves the browser for PlantUML and DOT. Both are overridable via the popup for users with private servers. Mermaid rendering stays fully local.
- No output caching across page loads — the render cache is in-memory per page. Browser HTTP cache handles repeat loads of the same server response.
- First-render of each unique block still costs a network round-trip; only repeat renders (e.g. after the host re-mounts its preview DOM) are instant.
- Build step adds a one-time install friction (`npm install && npm run build`) in exchange for a clean source tree, reproducible deps via `package-lock.json`, and a 3 MB smaller repo.
