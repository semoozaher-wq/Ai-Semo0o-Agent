export type FileKind =
  | 'image'
  | 'document'
  | 'code'
  | 'data'
  | 'audio'
  | 'video'
  | 'archive'
  | 'other';

export interface FileEntry {
  id: string;
  name: string;
  path: string;
  kind: FileKind;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
  starred?: boolean;
  folderId?: string;
}

export interface FolderEntry {
  id: string;
  name: string;
  parentId?: string;
  itemCount: number;
  sizeBytes: number;
}

export type Severity = 'info' | 'warning' | 'error' | 'critical';

export interface AnalysisFinding {
  id: string;
  fileId: string;
  fileName: string;
  severity: Severity;
  category: string;
  message: string;
  line?: number;
  suggestion?: string;
  autoFixable: boolean;
}

export interface FileAnalysisReport {
  id: string;
  scope: string;
  startedAt: string;
  finishedAt: string;
  filesScanned: number;
  totalBytes: number;
  byKind: Record<FileKind, number>;
  findings: AnalysisFinding[];
  /** 0..100 */
  healthScore: number;
  duplicates: number;
  largeFiles: number;
  summary: string;
}

/** The comprehensive multi-file audit configuration (the "153-file" audit). */
export interface AuditCheck {
  id: string;
  label: string;
  labelAr: string;
  description: string;
  passed: boolean;
  /** Relative weight used in the aggregate score. */
  weight: number;
  detail?: string;
}

export interface AuditConfig {
  id: string;
  name: string;
  nameAr: string;
  description: string;
  expectedFileCount: number;
  checks: AuditCheck[];
}
