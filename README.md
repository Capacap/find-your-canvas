# Find Your Canvas

The hardest part of creating is knowing where to start.

Find Your Canvas is an AI-powered creative workspace that helps users overcome blank canvas paralysis. A conversational orchestrator agent guides creative exploration through dialogue and visual experimentation, dispatching specialist subagents for image generation and editing.

**Live at:** [findyourcanvas.com](https://findyourcanvas.com) (coming soon)

## How it works

You talk to a single orchestrator agent about what you want to create. It develops creative direction with you, remembers your preferences across sessions, and dispatches specialist subagents when it's time to generate or edit images. The images aren't just output; they're part of the exploration process. You generate to see, react, and refine direction.

## Architecture

### Agent system

- **Orchestrator** — long-lived conversational agent that manages creative direction, project memory, and specialist dispatch via structured creative briefs
- **Text-to-image specialist** — short-lived subagent that translates briefs into generation prompts and produces new images (max 6 rounds)
- **Image-to-image specialist** — short-lived subagent that edits existing images, decomposing complex edits into sequential atomic transformations

Agents share a common tool system (`generate_image`, `view_images`, `read_memory`, `update_memory`, `search_images`, `search_memories`). The orchestrator additionally has `dispatch_text_to_image` and `dispatch_image_to_image`; specialists have `handoff` to signal completion.

### Context management

Agents operate within token-limited context windows using an MRU (most-recently-used) strategy:

- 30 most recent images + 20 favorited images in the visual index
- 20 most recent memory topics in the knowledge index
- `search_images` and `search_memories` tools as escape hatches for older content

### Prompt assembly

System prompts are composed from atomic `.txt` sections in `src/lib/engine/prompts/sections/`. Sections are shared across agent types where appropriate (content filter, reference image handling, confidence calibration). Dynamic context (memory index, image gallery) is interpolated at render time.

### Turn execution

The orchestrator turn loop streams a response, executes any tool calls (capped at 2 parallel due to a Gemini API issue), and repeats for up to 10 rounds. Subagent dispatch runs a complete specialist session within a single tool call. On failure, API history is rolled back to pre-turn state for safe retry.

## Evaluation

Scenario-based evals test agent behavior against defined success criteria using real Gemini text models with mocked actions (no actual image generation). An LLM-as-judge pass scores each trace on a 1-5 scale.

```sh
pnpm eval              # Run orchestrator + specialist evals (12 scenarios)
pnpm eval:judge        # Score latest traces
pnpm eval:all          # Both in sequence
pnpm eval -- -t "pat"  # Filter scenarios by name
```

Scenarios live in `eval/scenarios/{orchestrator,specialist}/` as JSON files. Traces output to `eval/traces/{timestamp}/`.

## Stack

- **Frontend:** SvelteKit 2, Svelte 5, TypeScript
- **AI:** Google Gemini API via `@google/genai` (gemini-3-flash-preview for orchestration, gemini-3.1-flash-image-preview for image generation)
- **Storage:** IndexedDB via Dexie (all data stays in the browser, no backend)
- **Evals:** Vitest + custom harness with mock stores and LLM judge

## Running locally

```sh
pnpm install
pnpm run dev
```

You'll need a [Gemini API key](https://aistudio.google.com/apikey). Enter it on the landing page. It's stored in your browser's IndexedDB, never sent to any server besides Google's API.

For evals, set `GEMINI_API_KEY` as an environment variable.

## License

MIT
