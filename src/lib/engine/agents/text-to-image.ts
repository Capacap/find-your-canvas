/**
 * Text-to-image specialist agent.
 *
 * Generates new images from text descriptions. Has access to project images
 * (via view_images) and project memory (via read_memory) for consistency.
 */
import type { AgentMemory, ImageMeta } from '$lib/types/schema';
import type { AgentDefinition } from '../types';
import {
  generateImageDeclaration,
  viewImagesDeclaration,
  readMemoryDeclaration,
  searchImagesDeclaration,
  searchMemoriesDeclaration,
  handoffDeclaration,
  handleGenerateImage,
  handleViewImages,
  handleReadMemory,
  handleSearchImages,
  handleSearchMemories,
  handleHandoff
} from '../tools';
import {
  textToImageTemplate,
  interpolate,
  buildMemorySection,
  buildImageIndex
} from '../prompts';

export function getTextToImageAgent(
  projectName: string,
  memories: AgentMemory[],
  images: ImageMeta[],
  totalMemoryCount?: number,
  totalImageCount?: number
): AgentDefinition {
  return {
    systemPrompt: interpolate(textToImageTemplate, {
      projectName,
      memorySection: buildMemorySection(memories, totalMemoryCount),
      imageIndexSection: buildImageIndex(images, totalImageCount)
    }),
    toolDeclarations: [
      generateImageDeclaration,
      viewImagesDeclaration,
      readMemoryDeclaration,
      searchImagesDeclaration,
      searchMemoriesDeclaration,
      handoffDeclaration
    ],
    toolHandlers: {
      generate_image: handleGenerateImage,
      view_images: handleViewImages,
      read_memory: handleReadMemory,
      search_images: handleSearchImages,
      search_memories: handleSearchMemories,
      handoff: handleHandoff
    }
  };
}
