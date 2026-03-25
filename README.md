# Mermaid Diagram Previewer

A Microsoft Edge extension that automatically detects and renders Mermaid code blocks on any web page.

![Inline Rendering](store/screenshots/1-inline-rendering.png)

## Features

- **Auto-Detection** — Finds and renders Mermaid code blocks on GitHub, GitLab, Azure DevOps, Confluence, Bitbucket, MkDocs, Docusaurus, and any Markdown-based site
- **All 23 Diagram Types** — Flowchart, Sequence, Class, State, ER, Gantt, Pie, Mindmap, Timeline, Git Graph, Quadrant, Requirement, C4, Sankey, XY Chart, Block, Packet, Kanban, Architecture, Radar, Treemap, User Journey, ZenUML
- **4 Themes** — Default, Dark, Forest, Neutral
- **Click to Zoom** — Fullscreen overlay with scroll-wheel zoom
- **One-Click Copy** — Copy rendered SVG or Mermaid source to clipboard
- **Built-in Editor** — Popup editor with live preview and templates for all 23 diagram types
- **SPA Support** — Works with single-page apps (GitHub Turbo, GitLab, Azure DevOps) via URL change detection and retry scanning
- **Lightweight** — Only loads the Mermaid rendering engine when code blocks are detected

![Popup Editor](store/screenshots/2-popup-editor.png)

## Supported Diagram Types

![Diagram Types](store/screenshots/3-diagram-types.png)

## Install from Source

1. Clone this repo
2. Run `npm install` to download the Mermaid library
3. Open `edge://extensions/`
4. Enable **Developer mode**
5. Click **Load unpacked** and select the repo folder

## Project Structure

```
├── manifest.json              # MV3 extension manifest
├── background/
│   └── service-worker.js      # Badge updates, SPA navigation handling
├── content/
│   ├── content.js             # Detection, rendering, observer, zoom
│   └── content.css            # Diagram container, toolbar, overlay styles
├── popup/
│   ├── popup.html             # Extension popup UI
│   ├── popup.js               # Editor, preview, theme switching, templates
│   └── popup.css              # Popup styles
├── lib/
│   └── mermaid.min.js         # Mermaid library (v11.13.0)
└── icons/                     # Extension icons (16/32/48/128px)
```

## Enable in InPrivate Mode

1. Go to `edge://extensions/`
2. Find **Mermaid Diagram Previewer** → click **Details**
3. Toggle **Allow in InPrivate** to ON

## License

MIT
