import { create } from 'zustand';
import {
  workspaceService,
  hydrateWorkspace,
  persistWorkspace,
  importGitHub,
  importZipBytes,
  exportWorkspaceZip,
  emptyWorkspace,
} from '../services/workspace';
import type { DownloadResult } from '../services/workspace';
import type { Workspace, WorkspaceFile } from '../types/workspace';
// Register real GitHub/ZIP/workspace tool adapters; no mock tool fallback exists.
import '../services/workspace/tools';

export interface WorkspaceExportInfo {
  filename: string;
  sizeBytes: number;
  fileCount: number;
  url?: string;
  dataUrl: string;
}

interface WorkspaceState {
  workspace: Workspace;
  hydrated: boolean;
  busy: boolean;
  error?: string;
  lastExport?: WorkspaceExportInfo;
  hydrate(): Promise<void>;
  refresh(): void;
  importRepo(url: string, opts?: { ref?: string; path?: string; maxFiles?: number; token?: string }): Promise<number>;
  importArchive(bytes: Uint8Array, name: string): Promise<number>;
  read(path: string): WorkspaceFile | undefined;
  write(path: string, content: string): void;
  remove(path: string): void;
  clear(): Promise<void>;
  exportZip(paths?: string[], name?: string): Promise<WorkspaceExportInfo>;
}

function snapshot(): Workspace {
  return workspaceService.current;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspace: emptyWorkspace(),
  hydrated: false,
  busy: false,
  error: undefined,
  lastExport: undefined,

  async hydrate() {
    const workspace = await hydrateWorkspace();
    set({ workspace, hydrated: true });
  },

  refresh() {
    set({ workspace: snapshot() });
  },

  async importRepo(url, opts) {
    set({ busy: true, error: undefined });
    try {
      const result = await importGitHub(url, {
        ref: opts?.ref,
        pathPrefix: opts?.path,
        maxFiles: opts?.maxFiles,
        token: opts?.token,
      });
      set({ workspace: snapshot(), busy: false });
      return result.fileCount;
    } catch (error) {
      set({
        busy: false,
        error: error instanceof Error ? error.message : 'فشل استيراد المستودع',
      });
      throw error;
    }
  },

  async importArchive(bytes, name) {
    set({ busy: true, error: undefined });
    try {
      const result = await importZipBytes(bytes, name);
      set({ workspace: snapshot(), busy: false });
      return result.fileCount;
    } catch (error) {
      set({
        busy: false,
        error: error instanceof Error ? error.message : 'فشل فك ضغط الأرشيف',
      });
      throw error;
    }
  },

  read(path) {
    return workspaceService.read(path);
  },

  write(path, content) {
    workspaceService.write(path, content);
    set({ workspace: snapshot() });
    void persistWorkspace();
  },

  remove(path) {
    workspaceService.delete(path);
    set({ workspace: snapshot() });
    void persistWorkspace();
  },

  async clear() {
    workspaceService.clear();
    set({ workspace: snapshot(), lastExport: undefined, error: undefined });
    await persistWorkspace();
  },

  async exportZip(paths, name) {
    const result: DownloadResult = await exportWorkspaceZip(paths, name);
    const info: WorkspaceExportInfo = {
      filename: result.filename,
      sizeBytes: result.sizeBytes,
      fileCount: workspaceService.toZipInputs(paths).length,
      url: result.url,
      dataUrl: result.dataUrl,
    };
    set({ lastExport: info });
    return info;
  },
}));
