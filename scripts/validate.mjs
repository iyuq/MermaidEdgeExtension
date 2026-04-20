#!/usr/bin/env node
/**
 * Launches Chromium with the built extension and verifies that Mermaid,
 * PlantUML, and DOT code blocks on a test page all produce rendered SVG.
 * Fails fast with a non-zero exit code if any kind doesn't render.
 *
 * Run after `npm run build`.
 */
import { chromium } from "playwright";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const TEST_HTML = buildTestHtml();

function buildTestHtml() {
  const dot = `digraph ActionPipeline {\n  rankdir=LR;\n  A -> B; B -> C; A -> C;\n}`;
  const mermaid = `flowchart TD\n  A[Start] --> B[End]`;
  const plantuml = `@startuml\nBob -> Alice : hi\n@enduml`;
  // Azure DevOps double-encodes unknown-language fences: the HTML contains
  // literal "&amp;gt;" so textContent returns "&gt;". We simulate that here
  // to lock in the entity-decoding fix.
  const dotDoubleEncoded = dot.replace(/>/g, "&amp;gt;");
  return `<!doctype html><html><head><meta charset="utf-8"><title>validate</title></head><body>
<h2>Mermaid</h2>
<pre><code class="language-mermaid">${mermaid}</code></pre>
<h2>DOT</h2>
<pre><code class="language-dot">${dot}</code></pre>
<h2>PlantUML</h2>
<pre><code class="language-plantuml">${plantuml}</code></pre>
<h2>DOT (ADO double-encoded)</h2>
<pre><code class="language-dot" id="dot-ado">${dotDoubleEncoded}</code></pre>
<h2>DOT (bare code, no pre, no lang class)</h2>
<code id="dot-bare">${dot}</code>
</body></html>`;
}

async function serveTestHtml(context) {
  await context.route("**/validate-test.html", (route) => {
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: TEST_HTML });
  });
}

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), "mermaid-ext-validate-"));
  let failed = false;
  const errors = [];
  let context;

  try {
    // Extensions don't load in Playwright's headless-shell default. Pass
    // --headless=new so the full Chromium binary runs in the modern
    // headless mode that does support extensions.
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        "--headless=new",
        `--disable-extensions-except=${DIST}`,
        `--load-extension=${DIST}`,
      ],
    });

    const page = await context.newPage();
    page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
    });

    await serveTestHtml(context);
    await page.goto("https://example.com/validate-test.html");

    // Five blocks: Mermaid, DOT, PlantUML, DOT (double-encoded), DOT (bare code).
    // PlantUML round-trips a real HTTP call so give it headroom.
    const expectedCount = 5;
    const deadline = Date.now() + 20000;
    let count = 0;
    while (Date.now() < deadline) {
      count = await page.evaluate(() => {
        const done = Array.from(document.querySelectorAll(".mermaid-ext-container"))
          .filter(c => c.querySelector("svg, .mermaid-ext-error"));
        return done.length;
      });
      if (count >= expectedCount) break;
      await page.waitForTimeout(250);
    }

    const results = await page.evaluate(() => {
      return Array.from(document.querySelectorAll(".mermaid-ext-container")).map(c => ({
        kind: c.getAttribute("data-mermaid-ext-kind") || "unknown",
        hasSvg: !!c.querySelector(".mermaid-ext-diagram"),
        error: (() => {
          const e = c.querySelector(".mermaid-ext-error-message");
          return e ? e.textContent.slice(0, 200) : null;
        })(),
        sourcePreview: (c.previousElementSibling && c.previousElementSibling.querySelector("code"))
          ? c.previousElementSibling.querySelector("code").id || ""
          : "",
      }));
    });

    console.log("Render result:");
    console.log(JSON.stringify(results, null, 2));

    if (results.length < expectedCount) {
      errors.push(`expected ${expectedCount} containers, got ${results.length}`);
      failed = true;
    }
    for (const r of results) {
      if (!r.hasSvg) {
        const tag = r.sourcePreview ? ` [${r.sourcePreview}]` : "";
        errors.push(`${r.kind}${tag}: no SVG (error: ${r.error || "none"})`);
        failed = true;
      }
    }

    if (errors.length) {
      console.error("\nErrors:");
      for (const e of errors) console.error("  " + e);
    }
  } catch (err) {
    console.error("Harness error:", err);
    failed = true;
  } finally {
    if (context) await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  if (failed) {
    console.error("\nVALIDATION FAILED");
    process.exit(1);
  }
  console.log("\nAll blocks rendered successfully.");
}

main();
