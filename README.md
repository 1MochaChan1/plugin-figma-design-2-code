# D2C Figma Plugin

Figma plugin that extracts design data from your Figma frames and sends it to the local bridge server for code generation.

## Setup

1. Open Figma Desktop
2. **Plugins → Development → Import plugin from manifest**
3. Navigate to this directory and select `manifest.json`
4. Plugin appears under **Plugins → Development → "D2C Figma"**

## Usage

1. Select a frame or component in your Figma file
2. Run the plugin: **Plugins → Development → D2C Figma**
3. Select the target framework from the dropdown (or use Auto-detect)
4. Enter the absolute path to your client repository (must contain `.ai-project-context.md`)
5. Optionally uncheck "Include screenshot" for models that don't support vision
6. Click **Generate**

The plugin will:
1. Extract design data into a structured "Pen Blueprint" JSON
2. Capture a 2x PNG screenshot (if enabled)
3. POST to `http://localhost:3000/compile/start` to create a compile job
4. Open an `EventSource` connection to `http://localhost:3000/compile/stream/:jobId`
5. Stream live progress (status messages + token counter) back to the UI
6. Write the generated files to your client repository

## Streaming

The plugin uses native browser `EventSource` to receive live progress events from the bridge server. This avoids Figma's long-request timeout issues and lets you see a running token counter while the LLM generates code.

## Requirements

- Figma Desktop app
- Bridge server running locally (`d2c-figma/bridge-server`)
- `.ai-project-context.md` in the target repository root
- Browser/EventSource support (provided by Figma's plugin iframe)

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Plugin registration and permissions |
| `code.js` | Sandbox code — extracts design data from Figma |
| `code.ts` | TypeScript source (reference/documentation) |
| `ui.html` | Plugin UI panel |
