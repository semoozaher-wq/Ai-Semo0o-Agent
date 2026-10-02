/**
 * Workspace service — the app's virtual file system.
 *
 * Holds a flat, path-keyed set of files that can come from GitHub, an uploaded
 * ZIP, or the agent itself. Supports read/write/delete/list, ZIP import and
 * export, and JSON persistence through the shared `storage` layer.
 */

import { uid } from '../../utils/id';
import { storage, STORAGE_KEYS } from '../storage';
import { createZip, downloadBytes, type DownloadResult, type ZipInputFile } from './zip';
import { isBinaryPath } from './github';
import type {
  FileEncoding,
  Workspace,
  WorkspaceFile,
  WorkspaceOrigin,
  WorkspaceOriginKind,
} from '../../types/workspace';

/** Normalize a path to POSIX form and strip leading/trailing slashes. */
export function normalizePath(input: string): string {
  return (input ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg && seg !== '.')
    .reduce<string[]>((acc, seg) => {
      if (seg === '..') acc.pop();
      else acc.push(seg);
      return acc;
    }, [])
    .join('/');
}

function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

function utf8Size(text: string): number {
  // Count UTF-8 bytes without depending on TextEncoder.
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

export interface NewFileInput {
  path: string;
  content: string;
  encoding?: FileEncoding;
  source?: WorkspaceOriginKind;
  sourceRef?: string;
  modified?: boolean;
}

/** Build a {@link WorkspaceFile} from raw input. */
export function makeWorkspaceFile(input: NewFileInput): WorkspaceFile {
  const path = normalizePath(input.path);
  const encoding = input.encoding ?? 'utf-8';
  const isBinary = encoding === 'base64' || isBinaryPath(path);
  const now = new Date().toISOString();
  const sizeBytes =
    encoding === 'base64'
      ? Math.floor((input.content.length * 3) / 4)
      : utf8Size(input.content);
  return {
    id: uid('wfile'),
    path,
    name: basename(path),
    content: input.content,
    encoding,
    sizeBytes,
    isBinary,
    source: input.source ?? 'generated',
    sourceRef: input.sourceRef,
    modified: input.modified ?? false,
    createdAt: now,
    updatedAt: now,
  };
}

export function emptyWorkspace(name = 'مساحة العمل'): Workspace {
  const now = new Date().toISOString();
  return {
    id: uid('ws'),
    name,
    files: [],
    origin: { kind: 'empty' },
    createdAt: now,
    updatedAt: now,
  };
}

export interface WorkspaceStats {
  fileCount: number;
  totalBytes: number;
  byExtension: Record<string, number>;
  modifiedCount: number;
}

export class WorkspaceService {
  private workspace: Workspace;

  constructor(workspace: Workspace = emptyWorkspace()) {
    this.workspace = workspace;
  }

  get current(): Workspace {
    return this.workspace;
  }

  get files(): WorkspaceFile[] {
    return this.workspace.files;
  }

  /** Replace the in-memory workspace (used on hydration). */
  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  list(prefix?: string): WorkspaceFile[] {
    const p = prefix ? normalizePath(prefix) : '';
    return this.workspace.files
      .filter((f) => (p ? f.path === p || f.path.startsWith(`${p}/`) : true))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  read(path: string): WorkspaceFile | undefined {
    const p = normalizePath(path);
    return this.workspace.files.find((f) => f.path === p);
  }

  /** Create or update a file. Returns the resulting file. */
  write(path: string, content: string, encoding: FileEncoding = 'utf-8'): WorkspaceFile {
    const p = normalizePath(path);
    const existing = this.workspace.files.find((f) => f.path === p);
    if (existing) {
      const updated: WorkspaceFile = {
        ...existing,
        content,
        encoding,
        isBinary: encoding === 'base64' || isBinaryPath(p),
        sizeBytes: encoding === 'base64' ? Math.floor((content.length * 3) / 4) : utf8Size(content),
        modified: true,
        updatedAt: new Date().toISOString(),
      };
      this.replace(updated);
      return updated;
    }
    const created = makeWorkspaceFile({ path: p, content, encoding, source: 'generated', modified: true });
    this.workspace.files.push(created);
    this.touch();
    return created;
  }

  delete(path: string): boolean {
    const p = normalizePath(path);
    const before = this.workspace.files.length;
    this.workspace.files = this.workspace.files.filter((f) => f.path !== p);
    if (this.workspace.files.length !== before) {
      this.touch();
      return true;
    }
    return false;
  }

  /** Bulk-add files (from GitHub/ZIP). Existing paths are overwritten. */
  addFiles(inputs: NewFileInput[], origin?: WorkspaceOrigin): WorkspaceFile[] {
    const added: WorkspaceFile[] = [];
    for (const input of inputs) {
      const file = makeWorkspaceFile(input);
      const idx = this.workspace.files.findIndex((f) => f.path === file.path);
      if (idx >= 0) this.workspace.files[idx] = { ...file, createdAt: this.workspace.files[idx].createdAt };
      else this.workspace.files.push(file);
      added.push(file);
    }
    if (origin) this.workspace.origin = origin;
    this.touch();
    return added;
  }

  setOrigin(origin: WorkspaceOrigin): void {
    this.workspace.origin = origin;
    this.touch();
  }

  setName(name: string): void {
    this.workspace.name = name;
    this.touch();
  }

  clear(): void {
    this.workspace = emptyWorkspace(this.workspace.name);
  }

  stats(): WorkspaceStats {
    const byExtension: Record<string, number> = {};
    let totalBytes = 0;
    let modifiedCount = 0;
    for (const file of this.workspace.files) {
      totalBytes += file.sizeBytes;
      if (file.modified) modifiedCount += 1;
      const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '(none)';
      byExtension[ext] = (byExtension[ext] ?? 0) + 1;
    }
    return {
      fileCount: this.workspace.files.length,
      totalBytes,
      byExtension,
      modifiedCount,
    };
  }

  toZipInputs(paths?: string[]): ZipInputFile[] {
    const scope = paths && paths.length > 0 ? new Set(paths.map(normalizePath)) : null;
    return this.workspace.files
      .filter((f) => !scope || scope.has(f.path))
      .map((f) => ({ path: f.path, content: f.content, encoding: f.encoding }));
  }

  /** Build a ZIP of the current files (optionally scoped to specific paths). */
  async exportZip(paths?: string[]): Promise<Uint8Array> {
    return createZip(this.toZipInputs(paths));
  }

  /** Build and download a ZIP, returning the download metadata. */
  async exportZipFile(paths?: string[], filename?: string): Promise<DownloadResult> {
    const bytes = await this.exportZip(paths);
    const safeName = (filename ?? `${this.workspace.name || 'workspace'}.zip`).replace(/[^\w.-]+/g, '-');
    return downloadBytes(bytes, safeName.endsWith('.zip') ? safeName : `${safeName}.zip`);
  }

  private replace(file: WorkspaceFile): void {
    const idx = this.workspace.files.findIndex((f) => f.path === file.path);
    if (idx >= 0) this.workspace.files[idx] = file;
    this.touch();
  }

  private touch(): void {
    this.workspace = { ...this.workspace, updatedAt: new Date().toISOString() };
  }
}

/* -------------------------------------------------------------------------- */
/*  Persistence                                                                */
/* -------------------------------------------------------------------------- */

export const WORKSPACE_STORAGE_KEY = `${STORAGE_KEYS.files}.workspace`;

export async function loadWorkspace(): Promise<Workspace> {
  const saved = await storage.get<Workspace>(WORKSPACE_STORAGE_KEY);
  return saved ?? emptyWorkspace();
}

export async function saveWorkspace(workspace: Workspace): Promise<void> {
  await storage.set(WORKSPACE_STORAGE_KEY, workspace);
}
