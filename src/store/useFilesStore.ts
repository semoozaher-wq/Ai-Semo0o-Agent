import { create } from 'zustand';
import {
  AuditConfig,
  FileAnalysisReport,
  FileEntry,
} from '../types/file';
import {
  buildReport,
  runAudit,
  auditScore,
  seedWorkspace,
} from '../services/data-engine';
import {
  AnalysisResult,
  analyzeWorkspace,
} from '../services/code-analysis';
import { storage, STORAGE_KEYS } from '../services/storage';

interface FilesState {
  files: FileEntry[];
  report: FileAnalysisReport | null;
  audit: AuditConfig | null;
  auditScore: number;
  analysis: AnalysisResult | null;
  scanning: boolean;
  hydrated: boolean;
  hydrate(): Promise<void>;
  scan(): Promise<void>;
  runAudit(): void;
  analyzeCode(): void;
  toggleStar(id: string): void;
  remove(id: string): void;
}

const SAMPLE_SOURCES: { name: string; source: string }[] = [
  {
    name: 'src/services/api/client.ts',
    source: [
      'export function complete(req) {',
      '  var result = fetch("/v1/chat", req);',
      '  console.log("request sent");',
      '  if (req.model == "gpt-5") {',
      '    return result;',
      '  }',
      '}',
    ].join('\n'),
  },
  {
    name: 'src/services/store/index.ts',
    source: [
      'const apiKey = "sk-live-abcdef123456";',
      'try {',
      '  install();',
      '} catch (e) {}',
      '// TODO: add retry logic',
      'debugger;',
    ].join('\n'),
  },
  {
    name: 'src/components/AgentCard.tsx',
    source: [
      'export function AgentCard({ items }) {',
      '  return items.map((item) => <View>{item.name}</View>);',
      '}',
    ].join('\n'),
  },
  {
    name: 'src/screens/Dashboard.tsx',
    source: [
      'export function Dashboard() {',
      '  const data: any = useData();',
      '  return <View>{data}</View>;',
      '}',
    ].join('\n'),
  },
];

export const useFilesStore = create<FilesState>((set, get) => ({
  files: [],
  report: null,
  audit: null,
  auditScore: 100,
  analysis: null,
  scanning: false,
  hydrated: false,

  async hydrate() {
    const stored = await storage.get<FileEntry[]>(STORAGE_KEYS.files);
    const files = stored && stored.length > 0 ? stored : seedWorkspace();
    set({
      files,
      report: buildReport(files, '/'),
      audit: runAudit(files),
      auditScore: auditScore(runAudit(files)),
      hydrated: true,
    });
  },

  async scan() {
    set({ scanning: true });
    const files = seedWorkspace();
    const report = buildReport(files, '/');
    const audit = runAudit(files);
    set({
      files,
      report,
      audit,
      auditScore: auditScore(audit),
      scanning: false,
    });
    await storage.set(STORAGE_KEYS.files, files);
  },

  runAudit() {
    const audit = runAudit(get().files);
    set({ audit, auditScore: auditScore(audit) });
  },

  analyzeCode() {
    set({ analysis: analyzeWorkspace(SAMPLE_SOURCES) });
  },

  toggleStar(id) {
    set((state) => ({
      files: state.files.map((f) =>
        f.id === id ? { ...f, starred: !f.starred } : f,
      ),
    }));
  },

  remove(id) {
    set((state) => ({ files: state.files.filter((f) => f.id !== id) }));
  },
}));
