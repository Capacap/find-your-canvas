/**
 * Prompt template loader.
 *
 * Templates are plain text files with {{variable}} placeholders.
 * Vite's ?raw import inlines them at build time, so there's no
 * runtime file I/O and they work in the static SPA build.
 */

import systemTemplate from './system.txt?raw';
import designDocFullTemplate from './design-doc-full.txt?raw';
import designDocEmptyTemplate from './design-doc-empty.txt?raw';
import memoryIndexTemplate from './memory-index.txt?raw';
import memoryEmptyTemplate from './memory-empty.txt?raw';

/** Replace {{key}} placeholders with values from the provided map. */
function interpolate(template: string, vars: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

export {
	systemTemplate,
	designDocFullTemplate,
	designDocEmptyTemplate,
	memoryIndexTemplate,
	memoryEmptyTemplate,
	interpolate
};
