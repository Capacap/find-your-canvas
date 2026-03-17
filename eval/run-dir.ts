/**
 * Creates a timestamped run directory for eval trace output.
 *
 * Vitest runs eval files in separate worker threads, so module-level
 * singletons don't share across files. Instead, vite.config.ts sets
 * EVAL_RUN_ID once at startup, and all workers derive the same
 * directory name from it. The manifest and symlink are written
 * idempotently so the first worker to arrive creates them and
 * subsequent workers reuse the directory.
 */
import { mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { TEXT_MODEL, IMAGE_MODEL } from '$lib/types/schema';

const TRACES_ROOT = join(import.meta.dirname, 'traces');

interface RunManifest {
  timestamp: string;
  gitCommit: string;
  gitDirty: boolean;
  textModel: string;
  imageModel: string;
}

function getGitInfo(): { commit: string; dirty: boolean } {
  try {
    const commit = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
    const status = execSync('git status --porcelain', { encoding: 'utf-8' }).trim();
    return { commit, dirty: status.length > 0 };
  } catch {
    return { commit: 'unknown', dirty: false };
  }
}

let runDir: string | null = null;

/** Returns the run directory path, creating it on first call per worker. */
export function getRunDir(): string {
  if (runDir) return runDir;

  const dirName = process.env.EVAL_RUN_ID ?? 'default';
  runDir = join(TRACES_ROOT, dirName);
  mkdirSync(runDir, { recursive: true });

  const manifestPath = join(runDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    const git = getGitInfo();
    const manifest: RunManifest = {
      timestamp: new Date().toISOString(),
      gitCommit: git.commit,
      gitDirty: git.dirty,
      textModel: TEXT_MODEL,
      imageModel: IMAGE_MODEL
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  }

  // Update the `latest` symlink for quick access.
  const latestLink = join(TRACES_ROOT, 'latest');
  try { rmSync(latestLink); } catch {}
  try { symlinkSync(dirName, latestLink); } catch {}

  return runDir;
}
