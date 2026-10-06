import {
  AnalysisFinding,
  FileAnalysisReport,
  FileEntry,
  FileKind,
} from '../../types/file';
import { uid, hashString } from '../../utils/id';
import { clamp } from '../../utils/array';

/* -------------------------------------------------------------------------- */
/*  Kind / MIME mapping                                                       */
/* -------------------------------------------------------------------------- */

const EXT_KIND: Record<string, FileKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  pdf: 'document',
  doc: 'document',
  docx: 'document',
  txt: 'document',
  md: 'document',
  rtf: 'document',
  ts: 'code',
  tsx: 'code',
  js: 'code',
  jsx: 'code',
  py: 'code',
  java: 'code',
  go: 'code',
  rs: 'code',
  json: 'data',
  csv: 'data',
  tsv: 'data',
  xlsx: 'data',
  xml: 'data',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  zip: 'archive',
  tar: 'archive',
  gz: 'archive',
  rar: 'archive',
};

const KIND_MIME: Record<FileKind, string> = {
  image: 'image/png',
  document: 'application/pdf',
  code: 'text/typescript',
  data: 'application/json',
  audio: 'audio/mpeg',
  video: 'video/mp4',
  archive: 'application/zip',
  other: 'application/octet-stream',
};

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function kindForExtension(name: string): FileKind {
  return EXT_KIND[extensionOf(name)] ?? 'other';
}

export function mimeForKind(kind: FileKind): string {
  return KIND_MIME[kind];
}

export const FILE_KINDS: FileKind[] = [
  'image',
  'document',
  'code',
  'data',
  'audio',
  'video',
  'archive',
  'other',
];

/* -------------------------------------------------------------------------- */
/*  Deterministic workspace seed (the "153-file" workspace)                   */
/* -------------------------------------------------------------------------- */

const FOLDERS = [
  'src/services',
  'src/components',
  'src/screens',
  'src/store',
  'src/utils',
  'data',
  'docs',
  'assets/images',
  'reports',
  'scripts',
];

const STEMS = [
  'agent-engine',
  'planner',
  'executor',
  'memory',
  'tool-registry',
  'runtime',
  'scanner',
  'profiler',
  'audit',
  'store-service',
  'chat-store',
  'agents-store',
  'files-store',
  'theme-tokens',
  'format',
  'id',
  'async',
  'array',
  'text',
  'button',
  'card',
  'chip',
  'badge',
  'input',
  'avatar',
  'progress',
  'skeleton',
  'dashboard',
  'store-screen',
  'chat-screen',
  'files-screen',
  'analytics',
  'settings',
  'agent-detail',
  'body-map',
  'pain-map',
  'anatomy-317',
  'report-q1',
  'report-q2',
  'report-q3',
  'executive-summary',
  'README',
  'CHANGELOG',
  'package',
  'tsconfig',
  'babel',
  'metro',
  'app',
  'models',
  'permissions',
  'quick-actions',
  'task-templates',
  'agents-catalog',
];

const EXTS = ['ts', 'tsx', 'tsx', 'ts', 'json', 'md', 'png', 'csv', 'pdf', 'js'];

const WORKSPACE_SIZE = 153;

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

/** Builds a deterministic, realistic 153-file workspace for analysis demos. */
export function seedWorkspace(size = WORKSPACE_SIZE): FileEntry[] {
  const entries: FileEntry[] = [];
  let i = 0;

  outer: for (const folder of FOLDERS) {
    for (const stem of STEMS) {
      const ext = EXTS[i % EXTS.length];
      const name = `${stem}.${ext}`;
      const path = `${folder}/${name}`;
      const kind = kindForExtension(name);
      const seed = hashString(path);
      const sizeBytes = 512 + (seed % 46_000);
      const ageDays = seed % 240;

      entries.push({
        id: uid('file'),
        name,
        path,
        kind,
        mimeType: mimeForKind(kind),
        sizeBytes,
        createdAt: isoDaysAgo(ageDays + 30),
        updatedAt: isoDaysAgo(ageDays),
        tags: [folder.split('/')[0] ?? ''],
        starred: seed % 17 === 0,
      });

      i += 1;
      if (entries.length >= size) break outer;
    }
  }

  return entries;
}

/* -------------------------------------------------------------------------- */
/*  Reporting                                                                 */
/* -------------------------------------------------------------------------- */

function countByKind(files: FileEntry[]): Record<FileKind, number> {
  const byKind = FILE_KINDS.reduce(
    (acc, k) => ({ ...acc, [k]: 0 }),
    {} as Record<FileKind, number>,
  );
  files.forEach((f) => {
    byKind[f.kind] += 1;
  });
  return byKind;
}

const LARGE_FILE_BYTES = 1_000_000;

export function buildReport(files: FileEntry[], scope = '/'): FileAnalysisReport {
  const startedAt = new Date().toISOString();
  const byKind = countByKind(files);
  const totalBytes = files.reduce((acc, f) => acc + f.sizeBytes, 0);

  // Duplicate detection by file name.
  const nameCount = new Map<string, number>();
  files.forEach((f) => nameCount.set(f.name, (nameCount.get(f.name) ?? 0) + 1));
  const duplicates = Array.from(nameCount.values()).filter((n) => n > 1).length;

  const largeFiles = files.filter((f) => f.sizeBytes >= LARGE_FILE_BYTES).length;

  const findings: AnalysisFinding[] = [];

  files.forEach((f) => {
    if (f.sizeBytes >= LARGE_FILE_BYTES) {
      findings.push({
        id: uid('find'),
        fileId: f.id,
        fileName: f.name,
        severity: 'warning',
        category: 'size',
        message: `ملف كبير الحجم (${(f.sizeBytes / 1_048_576).toFixed(1)} ميجابايت).`,
        suggestion: 'فكّر في ضغطه أو تقسيمه إلى أجزاء أصغر.',
        autoFixable: false,
      });
    }
    if (f.kind === 'other') {
      findings.push({
        id: uid('find'),
        fileId: f.id,
        fileName: f.name,
        severity: 'info',
        category: 'format',
        message: 'نوع ملف غير معروف قد يحتاج معالجة خاصة.',
        suggestion: 'تحقق من الصيغة أو حوّلها إلى صيغة مدعومة.',
        autoFixable: false,
      });
    }
    if (!f.tags || f.tags.length === 0) {
      findings.push({
        id: uid('find'),
        fileId: f.id,
        fileName: f.name,
        severity: 'info',
        category: 'metadata',
        message: 'ملف بلا وسوم (tags) مما يصعّب البحث.',
        suggestion: 'أضف وسمًا وصفيًا.',
        autoFixable: true,
      });
    }
    if (f.kind === 'code' && /TODO|FIXME/i.test(f.name)) {
      findings.push({
        id: uid('find'),
        fileId: f.id,
        fileName: f.name,
        severity: 'warning',
        category: 'quality',
        message: 'ملف يحمل وسم عمل غير مكتمل.',
        suggestion: 'أكمل العمل المعلّق قبل النشر.',
        autoFixable: false,
      });
    }
  });

  const penalty =
    findings.filter((x) => x.severity === 'critical').length * 12 +
    findings.filter((x) => x.severity === 'error').length * 6 +
    findings.filter((x) => x.severity === 'warning').length * 3 +
    findings.filter((x) => x.severity === 'info').length * 1;

  const healthScore = clamp(100 - Math.round(penalty / 4), 0, 100);

  const summary =
    `تم فحص ${files.length} ملفًا بإجمالي ${(totalBytes / 1_048_576).toFixed(1)} ميجابايت. ` +
    `اكتُشفت ${findings.length} ملاحظة، منها ${duplicates} تكرار بالاسم و${largeFiles} ملفًا كبيرًا. ` +
    `درجة السلامة العامة ${healthScore}/100.`;

  return {
    id: uid('report'),
    scope,
    startedAt,
    finishedAt: new Date().toISOString(),
    filesScanned: files.length,
    totalBytes,
    byKind,
    findings,
    healthScore,
    duplicates,
    largeFiles,
    summary,
  };
}

/** A small, deterministic tree used by the file-manager UI. */
export interface FolderNode {
  path: string;
  name: string;
  fileCount: number;
  sizeBytes: number;
  children: FolderNode[];
}

export function buildTree(files: FileEntry[]): FolderNode {
  const root: FolderNode = {
    path: '/',
    name: 'الجذر',
    fileCount: 0,
    sizeBytes: 0,
    children: [],
  };

  const index = new Map<string, FolderNode>([['/', root]]);

  const ensure = (path: string): FolderNode => {
    const existing = index.get(path);
    if (existing) return existing;
    const parts = path.split('/');
    const name = parts[parts.length - 1] ?? '';
    const parentPath = parts.slice(0, -1).join('/') || '/';
    const parent = ensure(parentPath);
    const node: FolderNode = {
      path,
      name,
      fileCount: 0,
      sizeBytes: 0,
      children: [],
    };
    parent.children.push(node);
    index.set(path, node);
    return node;
  };

  files.forEach((f) => {
    const parts = f.path.split('/');
    parts.pop();
    const folderPath = parts.join('/') || '/';
    const node = ensure(folderPath);
    node.fileCount += 1;
    node.sizeBytes += f.sizeBytes;

    // Bubble counts up to the root.
    let cursor: FolderNode | undefined = node;
    while (cursor && cursor.path !== '/') {
      const parentPath = cursor.path.split('/').slice(0, -1).join('/') || '/';
      const parent = index.get(parentPath);
      if (!parent) break;
      cursor = parent;
    }
  });

  const recompute = (node: FolderNode): { count: number; size: number } => {
    let count = node.fileCount;
    let size = node.sizeBytes;
    node.children.forEach((child) => {
      const sub = recompute(child);
      count += sub.count;
      size += sub.size;
    });
    node.fileCount = count;
    node.sizeBytes = size;
    return { count, size };
  };
  recompute(root);

  return root;
}
