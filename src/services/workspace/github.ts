/**
 * GitHub service.
 *
 * Lets the app (and the agent) point at any public repository URL, inspect its
 * file tree, read individual files, and download the whole repo as a ZIP — all
 * through the official REST API. A personal access token is optional but
 * raises the rate limit and unlocks private repos.
 */

import { getBytes, getJson } from '../ai/http';
import { bytesToBase64, decodeBase64 } from '../../utils/base64';
import type {
  FileEncoding,
  GitHubFileContent,
  GitHubRepoRef,
  GitHubTreeEntry,
} from '../../types/workspace';

const API = 'https://api.github.com';

export interface GitHubOptions {
  token?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/* -------------------------------------------------------------------------- */
/*  URL parsing                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Parse any common GitHub reference into a structured {@link GitHubRepoRef}.
 *
 * Supports:
 *   • https://github.com/owner/repo
 *   • https://github.com/owner/repo/tree/<branch>/<sub/path>
 *   • https://github.com/owner/repo/blob/<branch>/<file>
 *   • git@github.com:owner/repo.git
 *   • github.com/owner/repo
 *   • owner/repo
 *
 * Returns `null` when the input is not a recognisable GitHub reference.
 */
export function parseGitHubUrl(input: string): GitHubRepoRef | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;

  // SSH form: git@github.com:owner/repo.git
  const ssh = raw.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (ssh) {
    return {
      owner: ssh[1],
      repo: ssh[2].replace(/\.git$/i, ''),
      url: `https://github.com/${ssh[1]}/${ssh[2].replace(/\.git$/i, '')}`,
    };
  }

  // Strip protocol + host.
  let rest = raw
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/^github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');

  // Bare `owner/repo`.
  const parts = rest.split('/').filter(Boolean);
  if (parts.length < 2) return null;

  const [owner, repo, kind, ...tail] = parts;
  const ref: GitHubRepoRef = {
    owner,
    repo,
    url: `https://github.com/${owner}/${repo}`,
  };

  if ((kind === 'tree' || kind === 'blob') && tail.length > 0) {
    ref.ref = tail[0];
    const sub = tail.slice(1).join('/');
    if (kind === 'tree' && sub) ref.path = sub;
    if (kind === 'blob' && sub) ref.path = sub;
  } else if (kind === 'releases' || kind === 'commits') {
    // Not a tree/blob reference — ignore the extra segment.
  } else if (tail.length > 0) {
    // Unknown layout; treat remaining as a sub-path on the default branch.
    ref.path = [kind, ...tail].join('/');
  }

  return ref;
}

/* -------------------------------------------------------------------------- */
/*  Tree + contents                                                            */
/* -------------------------------------------------------------------------- */

interface RawTreeResponse {
  tree?: Array<{ path: string; type: string; size?: number; sha: string }>;
  truncated?: boolean;
}

/** Resolve a ref (branch/tag) to its commit SHA, defaulting to HEAD. */
export async function resolveRef(
  ref: GitHubRepoRef,
  options: GitHubOptions = {},
): Promise<string> {
  if (ref.ref) return ref.ref;
  const repo = await getJson<{ default_branch: string }>(
    `${API}/repos/${ref.owner}/${ref.repo}`,
    { headers: headers(options.token), signal: options.signal, timeoutMs: options.timeoutMs },
  );
  return repo.default_branch ?? 'main';
}

/** Fetch the recursive file tree for a repo at a given ref. */
export async function fetchRepoTree(
  ref: GitHubRepoRef,
  options: GitHubOptions = {},
): Promise<GitHubTreeEntry[]> {
  const resolved = await resolveRef(ref, options);
  const data = await getJson<RawTreeResponse>(
    `${API}/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(
      resolved,
    )}?recursive=1`,
    { headers: headers(options.token), signal: options.signal, timeoutMs: options.timeoutMs },
  );
  return (data.tree ?? [])
    .filter((entry) => entry.type === 'blob' || entry.type === 'tree')
    .map((entry) => ({
      path: entry.path,
      type: entry.type === 'tree' ? 'tree' : 'blob',
      size: entry.size,
      sha: entry.sha,
    }));
}

interface RawContentResponse {
  content?: string;
  encoding?: string;
  size?: number;
  type?: string;
}

/** Read a single file's content (decoded to text, or base64 for binaries). */
export async function fetchFileContent(
  ref: GitHubRepoRef,
  path: string,
  options: GitHubOptions = {},
): Promise<GitHubFileContent> {
  const resolved = await resolveRef(ref, options);
  const data = await getJson<RawContentResponse>(
    `${API}/repos/${ref.owner}/${ref.repo}/contents/${path}?ref=${encodeURIComponent(
      resolved,
    )}`,
    { headers: headers(options.token), signal: options.signal, timeoutMs: options.timeoutMs },
  );

  const rawB64 = (data.content ?? '').replace(/\n/g, '');
  const sizeBytes = data.size ?? 0;

  if (isBinaryPath(path)) {
    return { path, content: rawB64, encoding: 'base64', sizeBytes };
  }
  return { path, content: decodeBase64(rawB64), encoding: 'utf-8', sizeBytes };
}

/* -------------------------------------------------------------------------- */
/*  ZIP download                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Download the whole repository (or a sub-directory) as a ZIP archive using
 * GitHub's codeload endpoint — no API rate-limit cost.
 */
export async function downloadRepoZip(
  ref: GitHubRepoRef,
  options: GitHubOptions = {},
): Promise<Uint8Array> {
  const resolved = await resolveRef(ref, options);
  const url = `https://codeload.github.com/${ref.owner}/${ref.repo}/zip/${encodeURIComponent(
    resolved,
  )}`;
  return getBytes(url, {
    headers: options.token ? { Authorization: `Bearer ${options.token}` } : undefined,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 60_000,
  });
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svgz', 'tiff',
  'pdf', 'zip', 'gz', 'tar', 'rar', '7z', 'bz2', 'xz',
  'mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac',
  'mp4', 'mov', 'avi', 'mkv', 'webm',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'exe', 'dll', 'so', 'dylib', 'bin', 'wasm', 'class', 'o', 'a',
  'psd', 'ai', 'sketch', 'db', 'sqlite', 'pyc',
]);

/** Heuristic: is a path likely to contain binary data? */
export function isBinaryPath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return BINARY_EXTENSIONS.has(ext);
}

export interface GitHubImportResult {
  ref: GitHubRepoRef;
  resolvedRef: string;
  files: GitHubFileContent[];
  tree: GitHubTreeEntry[];
  skipped: number;
}

export interface GitHubImportOptions extends GitHubOptions {
  /** Branch, tag, or commit SHA to import (overrides the ref parsed from the URL). */
  ref?: string;
  /** Max files to pull content for (default 80). */
  maxFiles?: number;
  /** Only import files under this sub-path. */
  pathPrefix?: string;
  /** Skip files larger than this (default 512 KB). */
  maxFileBytes?: number;
}

/**
 * High-level import: resolve the ref, fetch the tree, then download the
 * contents of each (non-binary, reasonably sized) file. Binary files are
 * returned base64-encoded so the workspace can round-trip them into a ZIP.
 */
export async function importGitHubRepo(
  ref: GitHubRepoRef,
  options: GitHubImportOptions = {},
): Promise<GitHubImportResult> {
  const resolvedRef = await resolveRef(ref, options);
  const prefix = options.pathPrefix ?? ref.path;
  const maxFiles = options.maxFiles ?? 80;
  const maxFileBytes = options.maxFileBytes ?? 512 * 1024;

  const tree = await fetchRepoTree({ ...ref, ref: resolvedRef }, options);
  const blobs = tree.filter((entry) => {
    if (entry.type !== 'blob') return false;
    if (prefix && !entry.path.startsWith(prefix)) return false;
    if (entry.size !== undefined && entry.size > maxFileBytes) return false;
    return true;
  });

  const selected = blobs.slice(0, maxFiles);
  const files: GitHubFileContent[] = [];

  // Fetch with a small concurrency window to stay polite to the API.
  const CONCURRENCY = 6;
  for (let i = 0; i < selected.length; i += CONCURRENCY) {
    const batch = selected.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(
      batch.map((entry) =>
        fetchFileContent({ ...ref, ref: resolvedRef }, entry.path, options).catch(
          () => null,
        ),
      ),
    );
    for (const file of settled) if (file) files.push(file);
  }

  return {
    ref,
    resolvedRef,
    files,
    tree,
    skipped: blobs.length - files.length,
  };
}

/** Encode arbitrary bytes as base64 (re-exported for convenience). */
export function bytesToBase64String(bytes: Uint8Array): string {
  return bytesToBase64(bytes);
}
