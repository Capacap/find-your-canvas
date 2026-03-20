/**
 * Shared tool declarations and handlers.
 *
 * Used by the orchestrator and by specialist subagents. Each handler
 * follows the same signature so it can plug into either context.
 */
import { Type, type FunctionDeclaration, type Part } from '@google/genai';
import { generateImage } from './gemini';
import { blobToBase64, base64ToBlob } from '$lib/utils';
import type { EventCallback, TurnActions, TurnContext, ToolExecResult, ToolHandler } from './types';

// ── Helpers ──

/** Build a functionResponse part, preserving the call id for round-tripping.
 *  Gemini 3 supports nested `parts` on functionResponse for multimodal content
 *  (e.g. images). This avoids the junk-text bug caused by sibling inlineData parts. */
export function functionResponsePart(
  toolName: string,
  callId: string | undefined,
  response: Record<string, unknown>,
  nestedParts?: Part[]
): Part {
  const fr: Part = { functionResponse: { name: toolName, id: callId, response } };
  if (nestedParts && nestedParts.length > 0) {
    (fr.functionResponse as Record<string, unknown>).parts = nestedParts;
  }
  return fr;
}

/** Build a ToolExecResult for an error, emitting an event. */
function toolErrorResult(toolName: string, callId: string | undefined, err: unknown, label: string, onEvent: EventCallback): ToolExecResult {
  const msg = err instanceof Error ? err.message : String(err);
  onEvent({ type: 'error', message: `${label}: ${msg}` });
  return { responseParts: [functionResponsePart(toolName, callId, { error: msg })] };
}

// ── Tool declarations ──

export const generateImageDeclaration: FunctionDeclaration = {
  name: 'generate_image',
  description:
    'Generate or transform an image. For new images, write a full scene prompt. For edits or transformations of existing images, pass the source image in reference_image_ids and write a short directive prompt describing what to change.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      prompt: {
        type: Type.STRING,
        description: 'Detailed image generation prompt incorporating project context.'
      },
      label: {
        type: Type.STRING,
        description: 'Short human-readable label for the image (e.g. "forest_clearing").'
      },
      aspect_ratio: {
        type: Type.STRING,
        description:
          'Aspect ratio. One of: 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 21:9. Defaults to 1:1.'
      },
      reference_image_ids: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description:
          'IDs of project images to use as visual input. Use for style reference, character consistency, image editing, or combining elements. Always pair with prompt instructions explaining how each image should be used.'
      }
    },
    required: ['prompt', 'label']
  }
};

export const viewImagesDeclaration: FunctionDeclaration = {
  name: 'view_images',
  description:
    'View one or more project images by ID. Returns the images so you can see their contents. Use this when you need to reference, compare, or iterate on previous images. Batch multiple IDs into a single call rather than calling separately.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      image_ids: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'IDs of the images to view. Max 6.'
      },
      reason: {
        type: Type.STRING,
        description: 'Brief note on why you need to see these images (helps the user follow your thinking).'
      },
      include_metadata: {
        type: Type.BOOLEAN,
        description: 'If true, return full metadata alongside each image: source, dimensions, generation prompt, favorite status. Useful when you need to inspect how an image was produced.'
      }
    },
    required: ['image_ids']
  }
};

export const readMemoryDeclaration: FunctionDeclaration = {
  name: 'read_memory',
  description:
    'Read the full content of a project memory topic by its slug. Use this to recall established decisions before making changes.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      slug: {
        type: Type.STRING,
        description: 'The slug of the memory topic to read.'
      }
    },
    required: ['slug']
  }
};

export const updateMemoryDeclaration: FunctionDeclaration = {
  name: 'update_memory',
  description:
    'Create, update, or delete a project memory topic. All fields are required on every call to keep the index coherent. To delete a topic, pass empty content.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      slug: {
        type: Type.STRING,
        description:
          'Slug for the topic. Use lowercase-kebab-case, e.g. "art-style", "characters", "world-rules". Must be unique within the project.'
      },
      title: {
        type: Type.STRING,
        description: 'Human-readable title for the topic.'
      },
      summary: {
        type: Type.STRING,
        description: '1-2 sentence summary shown in the memory index. Should capture the essence of the topic.'
      },
      content: {
        type: Type.STRING,
        description: 'Full markdown content. Pass empty string to delete the topic.'
      }
    },
    required: ['slug', 'title', 'summary', 'content']
  }
};

export const searchImagesDeclaration: FunctionDeclaration = {
  name: 'search_images',
  description:
    'Search project images by label or generation context. Use this to find images that may not appear in the system prompt index (older images fall off the most-recently-used list).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: 'Search term to match against image labels and generation context (case-insensitive).'
      }
    },
    required: ['query']
  }
};

export const searchMemoriesDeclaration: FunctionDeclaration = {
  name: 'search_memories',
  description:
    'Search project memory topics by slug, title, or summary. Use this to find memory topics that may not appear in the system prompt index.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: 'Search term to match against memory slugs, titles, and summaries (case-insensitive).'
      }
    },
    required: ['query']
  }
};

export const handoffDeclaration: FunctionDeclaration = {
  name: 'handoff',
  description:
    'Signal that your work is complete. Call this when you have finished generating/transforming images and want to return control to the orchestrator. Include a brief summary of what you produced.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      summary: {
        type: Type.STRING,
        description: 'Brief summary of what was generated or transformed, for the orchestrator to relay to the user.'
      }
    },
    required: ['summary']
  }
};

// ── Tool handlers ──

const MAX_VIEW_IMAGES = 6;

export const handleGenerateImage: ToolHandler = async (toolName, callId, args, ctx, actions, onEvent) => {
  const label = (args.label as string) || 'generated_image';
  const prompt = args.prompt as string;
  const aspectRatio = args.aspect_ratio as string | undefined;
  const referenceImageIds = (args.reference_image_ids as string[] | undefined) ?? [];

  onEvent({ type: 'image_generating', label });

  try {
    const inputImages = (await Promise.all(
      referenceImageIds.map(async (refId) => {
        const img = await actions.getImage(refId);
        if (!img) return null;
        const data = await blobToBase64(img.blob);
        return { data, mimeType: img.mimeType };
      })
    )).filter((img): img is { data: string; mimeType: string } => img !== null);

    // Touch reference images so they bubble up in the MRU index.
    if (referenceImageIds.length > 0) {
      await actions.touchImages(referenceImageIds);
    }

    const imageResponse = await generateImage(ctx.apiKey, ctx.imageModel, prompt, {
      aspectRatio,
      inputImages: inputImages.length > 0 ? inputImages : undefined,
      signal: ctx.signal
    });
    const blob = await base64ToBlob(imageResponse.imageData, imageResponse.mimeType);
    const stored = await actions.createImage(blob, label, { generationContext: prompt });

    onEvent({ type: 'image_complete', imageId: stored.id, label });

    const thumb = await actions.getImageThumbnail(stored.id);
    const imageParts = thumb
      ? [{ inlineData: { data: thumb.base64, mimeType: thumb.mimeType } }]
      : undefined;
    return {
      responseParts: [
        functionResponsePart(toolName, callId, { output: `Image generated: [image:${stored.id}] "${label}"` }, imageParts)
      ],
      imageId: stored.id
    };
  } catch (err) {
    return toolErrorResult(toolName, callId, err, 'Image generation failed', onEvent);
  }
};

export const handleViewImages: ToolHandler = async (toolName, callId, args, _ctx, actions, onEvent) => {
  const imageIds = ((args.image_ids as string[]) ?? []).slice(0, MAX_VIEW_IMAGES);
  const reason = args.reason as string | undefined;
  const includeMetadata = args.include_metadata as boolean | undefined;

  if (imageIds.length === 0) {
    return { responseParts: [functionResponsePart(toolName, callId, { error: 'No image IDs provided.' })] };
  }

  onEvent({ type: 'image_viewing', imageIds, reason });

  try {
    const imageParts: Part[] = [];
    const outputLines: string[] = [];
    const metadataLines: string[] = [];
    const notFound: string[] = [];

    for (const imageId of imageIds) {
      const thumb = await actions.getImageThumbnail(imageId);
      if (!thumb) {
        notFound.push(imageId);
        continue;
      }
      outputLines.push(imageId);
      imageParts.push({ inlineData: { data: thumb.base64, mimeType: thumb.mimeType } });

      if (includeMetadata) {
        const meta = await actions.getImageMeta(imageId);
        if (meta) {
          const fields: string[] = [
            `source: ${meta.source}`,
            `label: "${meta.label}"`,
          ];
          if (meta.width && meta.height) fields.push(`dimensions: ${meta.width}x${meta.height}`);
          if (meta.favorite) fields.push('favorite: true');
          if (meta.generationContext) fields.push(`prompt: "${meta.generationContext}"`);
          metadataLines.push(`${imageId}: { ${fields.join(', ')} }`);
        }
      }
    }

    if (imageParts.length === 0) {
      return { responseParts: [functionResponsePart(toolName, callId, { error: `Images not found: ${notFound.join(', ')}` })] };
    }

    let output = `Showing ${imageParts.length} image(s) in order: ${outputLines.join(', ')}`;
    if (notFound.length > 0) {
      output += `. Not found: ${notFound.join(', ')}`;
    }
    if (metadataLines.length > 0) {
      output += '\n\nMetadata:\n' + metadataLines.join('\n');
    }

    // Touch viewed images so they bubble up in the MRU index.
    await actions.touchImages(outputLines);

    return {
      responseParts: [functionResponsePart(toolName, callId, { output }, imageParts)]
    };
  } catch (err) {
    return toolErrorResult(toolName, callId, err, 'Failed to view images', onEvent);
  }
};

export const handleReadMemory: ToolHandler = async (toolName, callId, args, _ctx, actions, onEvent) => {
  const slug = args.slug as string;

  try {
    const memory = await actions.getAgentMemory(slug);
    if (!memory) {
      const allMemories = await actions.listAgentMemories();
      const available = allMemories.map((t) => t.slug).join(', ');
      const hint = available
        ? `Topic "${slug}" not found. Available topics: ${available}`
        : `Topic "${slug}" not found. No topics exist yet. Use update_memory to create one.`;
      return { responseParts: [functionResponsePart(toolName, callId, { error: hint })] };
    }

    // Touch so it bubbles up in the MRU index.
    await actions.touchMemory(memory.slug);

    return {
      responseParts: [
        functionResponsePart(toolName, callId, { slug: memory.slug, title: memory.title, content: memory.content })
      ]
    };
  } catch (err) {
    return toolErrorResult(toolName, callId, err, 'Failed to read memory', onEvent);
  }
};

export const handleUpdateMemory: ToolHandler = async (toolName, callId, args, _ctx, actions, onEvent) => {
  const slug = args.slug as string;
  const title = args.title as string;
  const summary = args.summary as string;
  const content = args.content as string;

  try {
    await actions.upsertAgentMemory(slug, title, summary, content);
    onEvent({ type: 'memory_updated', slug });

    const verb = content.trim() ? 'updated' : 'deleted';
    return { responseParts: [functionResponsePart(toolName, callId, { output: `Memory topic "${slug}" ${verb}.` })] };
  } catch (err) {
    return toolErrorResult(toolName, callId, err, 'Failed to update memory', onEvent);
  }
};

const MAX_SEARCH_RESULTS = 50;

export const handleSearchImages: ToolHandler = async (toolName, callId, args, _ctx, actions, _onEvent) => {
  const query = args.query as string;
  if (!query?.trim()) {
    return { responseParts: [functionResponsePart(toolName, callId, { error: 'No search query provided.' })] };
  }

  try {
    const results = await actions.searchImages(query);
    if (results.length === 0) {
      return { responseParts: [functionResponsePart(toolName, callId, { output: `No images matching "${query}".` })] };
    }

    const capped = results.slice(0, MAX_SEARCH_RESULTS);
    const lines = capped.map(img => {
      const source = img.source === 'user' ? 'user_uploaded' : 'generated';
      const fields: string[] = [`id: ${img.id}`, `source: ${source}`];
      if (img.favorite) fields.push('favorite: true');
      if (img.generationContext) {
        const genCtx = img.generationContext;
        fields.push(`prompt: "${genCtx.length > 120 ? genCtx.slice(0, 120) + '...' : genCtx}"`);
      }
      return `- ${img.label} - { ${fields.join(', ')} }`;
    });
    let output = `Found ${results.length} image(s):\n${lines.join('\n')}`;
    if (results.length > MAX_SEARCH_RESULTS) {
      output += `\n\n(showing first ${MAX_SEARCH_RESULTS} of ${results.length} results, try a more specific query)`;
    }
    return {
      responseParts: [functionResponsePart(toolName, callId, { output })]
    };
  } catch (err) {
    return { responseParts: [functionResponsePart(toolName, callId, { error: String(err) })] };
  }
};

export const handleSearchMemories: ToolHandler = async (toolName, callId, args, _ctx, actions, _onEvent) => {
  const query = args.query as string;
  if (!query?.trim()) {
    return { responseParts: [functionResponsePart(toolName, callId, { error: 'No search query provided.' })] };
  }

  try {
    const results = await actions.searchMemories(query);
    if (results.length === 0) {
      return { responseParts: [functionResponsePart(toolName, callId, { output: `No memory topics matching "${query}".` })] };
    }

    const capped = results.slice(0, MAX_SEARCH_RESULTS);
    const lines = capped.map(mem => `| \`${mem.slug}\` | ${mem.title} | ${mem.summary} |`);
    let output = `Found ${results.length} topic(s):\n| Slug | Topic | Summary |\n| --- | --- | --- |\n${lines.join('\n')}`;
    if (results.length > MAX_SEARCH_RESULTS) {
      output += `\n\n(showing first ${MAX_SEARCH_RESULTS} of ${results.length} results, try a more specific query)`;
    }
    return {
      responseParts: [functionResponsePart(toolName, callId, { output })]
    };
  } catch (err) {
    return { responseParts: [functionResponsePart(toolName, callId, { error: String(err) })] };
  }
};

export const handleHandoff: ToolHandler = async (toolName, callId, args, _ctx, _actions, _onEvent) => {
  const summary = (args.summary as string) || '';
  return {
    responseParts: [functionResponsePart(toolName, callId, { output: 'Handoff accepted.' })],
    handoff: true,
    handoffText: summary
  };
};
