/**
 * Image-to-image specialist agent.
 *
 * Transforms existing images: edits, style changes, element additions/removals.
 * Decomposes multi-edit tasks into sequential atomic generate_image calls,
 * chaining outputs as inputs.
 */
import type { AgentMemory, ImageMeta } from '$lib/types/schema';
import type { AgentDefinition } from '../types';
import {
  generateImageDeclaration,
  viewImagesDeclaration,
  readMemoryDeclaration,
  handoffDeclaration,
  handleGenerateImage,
  handleViewImages,
  handleReadMemory,
  handleHandoff
} from '../tools';
import {
  imageToImageTemplate,
  interpolate,
  buildMemorySection,
  buildImageIndex
} from '../prompts';

export function getImageToImageAgent(
  projectName: string,
  memories: AgentMemory[],
  images: ImageMeta[]
): AgentDefinition {
  return {
    systemPrompt: interpolate(imageToImageTemplate, {
      projectName,
      memorySection: buildMemorySection(memories),
      imageIndexSection: buildImageIndex(images)
    }),
    toolDeclarations: [
      generateImageDeclaration,
      viewImagesDeclaration,
      readMemoryDeclaration,
      handoffDeclaration
    ],
    toolHandlers: {
      generate_image: handleGenerateImage,
      view_images: handleViewImages,
      read_memory: handleReadMemory,
      handoff: handleHandoff
    }
  };
}
