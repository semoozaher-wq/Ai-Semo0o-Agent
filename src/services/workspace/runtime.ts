/**
 * Workspace runtime — the shared singleton and high-level import/export flows.
 *
 * Both the UI store and the agent tools operate on the *same*
 * {@link workspaceService} instance, so a repo the agent imports is instantly
 * visible in the workspace screen (and vice-versa).
 */

import { WorkspaceService, loadWorkspace, saveWorkspace } from './workspace';
import { importGitHubRepo, parseGitHubUrl, type GitHubImportOptions } from './github';
import { extractZip, type DownloadResult } from './zip';
import type { Workspace, WorkspaceOrigin } from '../../types/workspace';

export const workspaceService = new WorkspaceService();

/** Load the persisted workspace into the singleton. */
export async function hydrateWorkspace(): Promise<Workspace> {
  const ws = await loadWorkspace();
  workspaceService.setWorkspace(ws);
  return ws;
}

/** Persist the current workspace. */
export async function persistWorkspace(): Promise<void> {
  await saveWorkspace(workspaceService.current);
}

/* -------------------------------------------------------------------------- */
/*  GitHub import                                                              */
/* -------------------------------------------------------------------------- */

export interface ImportGitHubResult {
  repo: string;
  ref: string;
  fileCount: number;
  skipped: number;
  paths: string[];
}

/** Parse a GitHub URL, fetch the repo, and load its files into the workspace. */
export async function importGitHub(
  url: string,
  options: GitHubImportOptions = {},
): Promise<ImportGitHubResult> {
  const ref = parseGitHubUrl(url);
  if (!ref) throw new Error(`رابط GitHub غير صالح: ${url}`);

  const result = await importGitHubRepo(ref, options);
  const origin: WorkspaceOrigin = {
    kind: 'github',
    ref: ref.url,
    importedAt: new Date().toISOString(),
  };
  const inputs = result.files.map((f) => ({
    path: f.path,
    content: f.content,
    encoding: f.encoding,
    source: 'github' as const,
    sourceRef: ref.url,
  }));
  workspaceService.addFiles(inputs, origin);
  await persistWorkspace();

  return {
    repo: `${ref.owner}/${ref.repo}`,
    ref: result.resolvedRef,
    fileCount: inputs.length,
    skipped: result.skipped,
    paths: inputs.map((f) => f.path),
  };
}

/* -------------------------------------------------------------------------- */
/*  ZIP import                                                                 */
/* -------------------------------------------------------------------------- */

export interface ImportZipResult {
  name: string;
  fileCount: number;
  entries: number;
  paths: string[];
}

/** Decompress a ZIP archive and load its entries into the workspace. */
export async function importZipBytes(
  bytes: Uint8Array,
  name: string,
): Promise<ImportZipResult> {
  const { files, entries } = await extractZip(bytes, { stripRootDir: true });
  const origin: WorkspaceOrigin = {
    kind: 'zip',
    ref: name,
    importedAt: new Date().toISOString(),
  };
  const inputs = files.map((f) => ({
    path: f.path,
    content: f.content,
    encoding: f.encoding,
    source: 'zip' as const,
    sourceRef: name,
  }));
  workspaceService.addFiles(inputs, origin);
  await persistWorkspace();

  return {
    name,
    fileCount: inputs.length,
    entries: entries.length,
    paths: inputs.map((f) => f.path),
  };
}

/* -------------------------------------------------------------------------- */
/*  ZIP export                                                                 */
/* -------------------------------------------------------------------------- */

export async function exportWorkspaceZip(
  paths?: string[],
  filename?: string,
): Promise<DownloadResult> {
  return workspaceService.exportZipFile(paths, filename);
}
