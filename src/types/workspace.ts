/**
 * Workspace domain types.
 *
 * A "workspace" is the app's virtual file system: a flat, path-keyed set of
 * files that can originate from the local device, an imported GitHub repo, or
 * an uploaded ZIP archive. The agent (and the user) can read, write, delete and
 * re-export these files — which is what powers the GitHub/ZIP workflow.
 */

export type WorkspaceOriginKind = 'empty' | 'github' | 'zip' | 'generated';

export interface WorkspaceOrigin {
  kind: WorkspaceOriginKind;
  /** Repo URL, archive name, or free-form label. */
  ref?: string;
  /** ISO timestamp of the import. */
  importedAt?: string;
}

export type FileEncoding = 'utf-8' | 'base64';

export interface WorkspaceFile {
  id: string;
  /** Normalized, POSIX-style path, e.g. `src/index.ts`. */
  path: string;
  /** Basename of {@link path}. */
  name: string;
  /** Text content, or base64 when {@link isBinary}. */
  content: string;
  encoding: FileEncoding;
  sizeBytes: number;
  isBinary: boolean;
  source: WorkspaceOriginKind;
  /** Repo URL / archive name the file came from. */
  sourceRef?: string | undefined;
  /** True when the file was created or edited inside the app. */
  modified: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  files: WorkspaceFile[];
  origin: WorkspaceOrigin;
  createdAt: string;
  updatedAt: string;
}

/* -------------------------------------------------------------------------- */
/*  GitHub                                                                     */
/* -------------------------------------------------------------------------- */

export interface GitHubRepoRef {
  owner: string;
  repo: string;
  /** Branch, tag or commit SHA. */
  ref?: string;
  /** Optional sub-directory to scope the import to. */
  path?: string;
  /** Canonical web URL. */
  url: string;
}

export interface GitHubTreeEntry {
  path: string;
  type: 'blob' | 'tree';
  size?: number | undefined;
  sha: string;
}

export interface GitHubFileContent {
  path: string;
  content: string;
  encoding: FileEncoding;
  sizeBytes: number;
}

/* -------------------------------------------------------------------------- */
/*  ZIP                                                                        */
/* -------------------------------------------------------------------------- */

export interface ZipEntryInfo {
  path: string;
  sizeBytes: number;
  isDirectory: boolean;
}

export interface ZipExtractResult {
  entries: ZipEntryInfo[];
  files: {
    path: string;
    content: string;
    encoding: FileEncoding;
    sizeBytes: number;
    isBinary: boolean;
  }[];
}
