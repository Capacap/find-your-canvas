# Creative Assistant Web App - Project Plan

Portfolio project: an agentic creative assistant that orchestrates image generation as part of a larger creative workflow. Not an image generator. The orchestration is the product.

## Core Concept

The user creates a "project" (a game, a story, a visual exploration). An LLM agent maintains a design document, remembers established decisions, and generates concept art within that context. The user steers through conversation. The agent iterates, references past work, and builds on what's been established.

The differentiator from every other image gen UI: statefulness, creative reasoning, and project-level context. The agent doesn't just turn prompts into images. It makes decisions about prompting strategy, maintains continuity, and collaborates.

## Architecture

Fully client-side. No backend server. The browser talks directly to the Gemini API with the user's own key. The app deploys as static files.

This eliminates:
- Backend compute costs
- Image storage costs
- API key management
- Serverless timeout concerns from long agent turns

The orchestration logic (system prompts, tool schemas, strategy selection, project state management) runs as client-side TypeScript. For a portfolio project, the visibility is a feature: reviewers can inspect how it works.

If the project ever goes commercial, moving orchestration server-side is a straightforward refactor.

## Tech Stack

- **SvelteKit** (SPA mode, static adapter) - compiles away, file-based routing, good DX without React's weight
- **Dexie.js** - promise-based wrapper around IndexedDB with schema versioning
- **JSZip** - project export/import as zip files
- **Gemini API** - direct fetch calls, no SDK needed. Single API handles both LLM and image generation
- **Cloudflare Pages or Vercel** - free tier static hosting

No backend. No database service. No image hosting.

## Gemini API Strategy

MVP uses Gemini exclusively. Single API key from the user.

- Gemini Flash / Pro for the LLM agent
- Gemini image generation for concept art
- The LLM and image gen share context naturally within the same API

Do not add support for other providers until the core experience works. Resist the temptation.

## Image Storage

Images live in IndexedDB via Dexie.js. The flow:

1. Gemini returns an image as base64 in the API response
2. Decode to Blob, generate a local ID, store in IndexedDB
3. Project state references images by ID, not by inline data
4. On session reload, resolve IDs to blobs, create object URLs for display

Critical rule: never store base64 strings in conversation history. Store a reference like `[image:harbor_sketch_03]` and resolve at render time. This keeps IndexedDB writes small and prevents the agent's context from filling up with data URIs.

IndexedDB storage limits are generous (hundreds of MB to GB before the browser prompts the user).

### Data Loss Mitigation

IndexedDB doesn't survive browser data clears, device changes, or browser switches. The answer is export/import:

- "Download Project" button bundles everything into a zip: project JSON + image blobs as PNGs in an `images/` folder
- "Import Project" unpacks a zip back into IndexedDB
- This also enables sharing projects and moving between machines

### Demo Content

Ship a sample project zip that visitors can import to see a populated project without needing an API key. Solves the "show don't tell" problem for reviewers who won't bring their own key.

## Orchestration Layer

This is the custom code, the actual portfolio piece. No library for it.

The agent turn loop:
1. Read project state (design document, established decisions, image history)
2. Construct system prompt with relevant context
3. Call Gemini with tool definitions
4. Parse tool use responses
5. Execute tools (image generation, project state updates)
6. Yield results back to the UI
7. Repeat if the agent has more work to do

TypeScript's type system is valuable here for tool schemas and project state.

## Project State Schema

Design this early. The schema covers:
- Conversation history (with image references, not inline data)
- Design document (established decisions, locked elements)
- Image metadata (ID, generation params, relationship to conversation)
- Project-level settings

Get this right first. The rest of the app is shaped by this data model. Sketch it on paper before writing code.

## Portfolio Presentation

Two audiences, two paths:

1. **Recruiters**: 30-second video on the landing page. Explains the concept with nice visuals. They never need to open the app.
2. **Technical reviewers**: public GitHub repo they can browse. Link directly to interesting files (orchestration loop, prompt construction, state management).

### Public Repo Strategy

Public repo with a restrictive license (BSL or "All Rights Reserved - viewable for evaluation only"). Recruiters and reviewers can browse the code. You retain control if it becomes commercial.

## Key Risks

- **Prompt/orchestration visibility**: accept it. For a portfolio project, inspectability is a strength. Prompting strategies are easy to read but hard to develop. The ability to evolve the system is the real asset.
- **Cost**: solved by BYOK + client-side architecture. Your hosting cost is zero (static files on free tier).
- **IndexedDB data loss**: solved by export/import zip flow.
- **Scope creep**: the MVP is one provider (Gemini), one project type, conversation + image gen. That's it.
