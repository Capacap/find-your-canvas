/**
 * Orchestrator agent definition.
 *
 * The orchestrator is the user-facing conversational agent. It dispatches
 * image work to specialists, manages project memory, and provides creative
 * direction. This module defines what the orchestrator knows (system prompt)
 * and can do (tools + handlers). The turn loop harness lives in ../turn.ts.
 */
import { Type, type FunctionDeclaration, type Part } from '@google/genai';
import type { AgentMemory, ImageMeta } from '$lib/types/schema';
import type { AgentDefinition, ToolHandler } from '../types';
import {
  orchestratorTemplate,
  interpolate,
  buildMemorySection,
  buildImageIndex
} from '../prompts';
import {
  functionResponsePart,
  viewImagesDeclaration,
  readMemoryDeclaration,
  updateMemoryDeclaration,
  searchImagesDeclaration,
  searchMemoriesDeclaration,
  handleViewImages,
  handleReadMemory,
  handleUpdateMemory,
  handleSearchImages,
  handleSearchMemories
} from '../tools';
import { runSubagent } from '../subagent';
import { getTextToImageAgent } from './text-to-image';
import { getImageToImageAgent } from './image-to-image';

// ── System prompt construction ──

/**
 * Build the orchestrator's system prompt. Exported so the context tab
 * can reconstruct it as a fallback when no session snapshot exists.
 */
export function buildOrchestratorPrompt(
  projectName: string,
  agentMemories: AgentMemory[],
  projectImages: ImageMeta[],
  totalMemoryCount?: number,
  totalImageCount?: number
): string {
  return interpolate(orchestratorTemplate, {
    projectName,
    memorySection: buildMemorySection(agentMemories, totalMemoryCount),
    imageIndexSection: buildImageIndex(projectImages, totalImageCount)
  });
}

// ── Dispatch tool declarations ──

const dispatchTextToImageDeclaration: FunctionDeclaration = {
  name: 'dispatch_text_to_image',
  description:
    'Dispatch an image generation task to the text-to-image specialist. Write a creative brief describing what you want and why, with reference image IDs, constraints, and project context. The specialist handles prompt engineering.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      prompt: {
        type: Type.STRING,
        description: 'Creative brief: what to create, why, reference image IDs with usage notes, aspect ratio, constraints, and relevant project context. Describe intent, not prompt structure.'
      }
    },
    required: ['prompt']
  }
};

const dispatchImageToImageDeclaration: FunctionDeclaration = {
  name: 'dispatch_image_to_image',
  description:
    'Dispatch an image transformation task to the image-to-image specialist. Provide the source image ID, what should change, and what should be preserved. The specialist handles prompt engineering and multi-edit decomposition.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      prompt: {
        type: Type.STRING,
        description: 'Creative brief: source image ID, what to change, what to preserve, why, and relevant project context. For multiple edits, describe each desired change.'
      }
    },
    required: ['prompt']
  }
};

// ── Dispatch handlers ──

function makeDispatchHandler(
  agentType: 'text-to-image' | 'image-to-image',
  getAgent: typeof getTextToImageAgent
): ToolHandler {
  return async (toolName, callId, args, ctx, actions, onEvent) => {
    const prompt = args.prompt as string;
    const dispatchId = callId ?? crypto.randomUUID();

    onEvent({ type: 'subagent_start', agentType, dispatchId });

    try {
      const definition = getAgent(ctx.projectName, ctx.agentMemories, ctx.projectImages, ctx.totalMemoryCount, ctx.totalImageCount);
      const result = await runSubagent(definition, prompt, ctx, actions, onEvent);

      onEvent({ type: 'subagent_end', agentType, dispatchId, imageIds: result.imageIds });

      // Build the response the orchestrator sees: summary text + image thumbnails.
      const thumbParts: Part[] = [];
      for (const imageId of result.imageIds) {
        const thumb = await actions.getImageThumbnail(imageId);
        if (thumb) {
          thumbParts.push({ inlineData: { data: thumb.base64, mimeType: thumb.mimeType } });
        }
      }

      const imageRefs = result.imageIds.map((id) => `[image:${id}]`).join(' ');
      const output = result.text
        ? `${result.text}${imageRefs ? '\n\nGenerated: ' + imageRefs : ''}`
        : imageRefs ? `Generated: ${imageRefs}` : 'Specialist completed with no output.';

      return {
        responseParts: [functionResponsePart(toolName, callId, { output }, thumbParts.length > 0 ? thumbParts : undefined)],
        imageIds: result.imageIds,
        subagentSession: {
          agentType,
          dispatchId,
          systemPrompt: result.systemPrompt,
          history: result.history
        }
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onEvent({ type: 'error', message: `${agentType} specialist failed: ${msg}` });
      onEvent({ type: 'subagent_end', agentType, dispatchId, imageIds: [] });
      return { responseParts: [functionResponsePart(toolName, callId, { error: msg })] };
    }
  };
}

// ── Agent definition ──

export function getOrchestratorAgent(
  projectName: string,
  memories: AgentMemory[],
  images: ImageMeta[],
  totalMemoryCount?: number,
  totalImageCount?: number
): AgentDefinition {
  return {
    systemPrompt: buildOrchestratorPrompt(projectName, memories, images, totalMemoryCount, totalImageCount),
    toolDeclarations: [
      dispatchTextToImageDeclaration,
      dispatchImageToImageDeclaration,
      viewImagesDeclaration,
      readMemoryDeclaration,
      updateMemoryDeclaration,
      searchImagesDeclaration,
      searchMemoriesDeclaration
    ],
    toolHandlers: {
      dispatch_text_to_image: makeDispatchHandler('text-to-image', getTextToImageAgent),
      dispatch_image_to_image: makeDispatchHandler('image-to-image', getImageToImageAgent),
      view_images: handleViewImages,
      read_memory: handleReadMemory,
      update_memory: handleUpdateMemory,
      search_images: handleSearchImages,
      search_memories: handleSearchMemories
    }
  };
}
