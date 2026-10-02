import { getTool } from '../../data/tools';
import { ToolDefinition } from '../../types/tool';
import { sleep } from '../../utils/async';
import { uid } from '../../utils/id';

export interface ToolRunResult {
  toolId: string;
  ok: boolean;
  output: unknown;
  logs: string[];
  durationMs: number;
  error?: string;
}

type ToolImpl = (args: Record<string, unknown>) => Promise<{
  output: unknown;
  logs?: string[];
}>;

/**
 * Sandboxed tool implementations. In production these would call real
 * services (search API, sandboxed runtime, storage). Here they return
 * deterministic, realistic output so the autonomous engine is fully
 * demonstrable without external credentials.
 */
const IMPLEMENTATIONS: Record<string, ToolImpl> = {
  'web.search': async (args) => {
    const query = String(args.query ?? '');
    const limit = Number(args.limit ?? 5);
    const results = Array.from({ length: Math.min(limit, 5) }, (_, i) => ({
      title: `${query} — نتيجة ${i + 1}`,
      url: `https://example.com/${encodeURIComponent(query)}/${i + 1}`,
      snippet: `مقتطف ذو صلة بموضوع «${query}» يتضمّن بيانات حديثة وتحليلًا أوليًا.`,
      score: Number((0.95 - i * 0.07).toFixed(2)),
    }));
    return {
      output: { query, count: results.length, results },
      logs: [`تم العثور على ${results.length} نتائج لـ «${query}»`],
    };
  },

  'web.scrape': async (args) => {
    const url = String(args.url ?? '');
    return {
      output: {
        url,
        title: 'صفحة مستخرجة',
        wordCount: 842,
        text: 'محتوى نظيف مستخرج من الصفحة مع إزالة العناصر غير المرغوبة (إعلانات، تنقّل).',
      },
      logs: [`تم استخراج 842 كلمة من ${url}`],
    };
  },

  'code.run': async (args) => {
    const language = String(args.language ?? 'javascript');
    return {
      output: {
        language,
        exitCode: 0,
        stdout: '✓ All tests passed (12/12)',
        stderr: '',
        durationMs: 184,
      },
      logs: [`تشغيل ${language} — نجحت جميع الاختبارات`],
    };
  },

  'code.analyze': async (args) => {
    const path = String(args.path ?? '');
    return {
      output: {
        path,
        issues: [
          { severity: 'warning', line: 42, message: 'متغيّر غير مستخدم', fixable: true },
          { severity: 'error', line: 118, message: 'استخدام محتمل قبل التعريف', fixable: true },
          { severity: 'info', line: 7, message: 'يمكن تبسيط الشرط', fixable: true },
        ],
        healthScore: 88,
      },
      logs: [`فحص ${path}: 3 ملاحظات (2 قابلة للإصلاح تلقائيًا)`],
    };
  },

  'files.read': async (args) => ({
    output: { fileId: args.fileId, content: 'محتوى الملف…', encoding: 'utf-8' },
  }),

  'files.write': async (args) => ({
    output: { path: args.path, bytesWritten: String(args.content ?? '').length },
    logs: [`تمت الكتابة إلى ${args.path}`],
  }),

  'files.scan': async (args) => {
    const scope = String(args.scope ?? '/');
    return {
      output: {
        scope,
        filesScanned: 153,
        healthScore: 92,
        findings: 7,
        duplicates: 2,
        largeFiles: 3,
      },
      logs: [`تم فحص 153 ملفًا في ${scope} — درجة السلامة 92/100`],
    };
  },

  'data.profile': async (args) => ({
    output: {
      fileId: args.fileId,
      rows: 12480,
      columns: 14,
      missingPct: 2.3,
      anomalies: 37,
      numericColumns: 8,
      categoricalColumns: 6,
    },
  }),

  'data.chart': async (args) => ({
    output: {
      type: args.type,
      series: [12, 19, 8, 24, 17, 30],
      labels: ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو'],
    },
    logs: ['تم توليد الرسم البياني'],
  }),

  'image.generate': async (args) => ({
    output: { prompt: args.prompt, variants: 4, size: args.size ?? '1024x1024' },
    logs: ['تم توليد 4 تنويعات للصورة'],
  }),

  'image.analyze': async (args) => ({
    output: {
      fileId: args.fileId,
      caption: 'صورة تُظهر عناصر متعددة مع نص واضح.',
      objects: ['person', 'text', 'chart'],
      ocrText: 'نص مستخرج من الصورة',
    },
  }),

  'doc.summarize': async (args) => ({
    output: {
      fileId: args.fileId,
      summary: 'ملخص من 5 نقاط يغطّي الأفكار الرئيسية للمستند.',
      keyPoints: ['الفكرة 1', 'الفكرة 2', 'الفكرة 3', 'الفكرة 4', 'الفكرة 5'],
    },
  }),

  'pdf.extract': async (args) => ({
    output: { fileId: args.fileId, pages: 24, tables: 6, words: 8420 },
  }),

  translate: async (args) => ({
    output: { source: args.text, target: args.target, translation: '— translated text —' },
  }),

  'calendar.schedule': async (args) => ({
    output: { title: args.title, when: args.when, eventId: uid('evt') },
    logs: [`تم جدولة «${args.title}»`],
  }),

  'email.send': async (args) => ({
    output: { to: args.to, subject: args.subject, status: 'queued' },
    logs: [`تم تجهيز البريد إلى ${args.to}`],
  }),
};

export function isToolImplemented(toolId: string): boolean {
  return toolId in IMPLEMENTATIONS;
}

export async function runTool(
  toolId: string,
  args: Record<string, unknown> = {},
): Promise<ToolRunResult> {
  const started = Date.now();
  const definition: ToolDefinition | undefined = getTool(toolId);
  const logs: string[] = [];

  if (!definition) {
    return {
      toolId,
      ok: false,
      output: null,
      logs,
      durationMs: Date.now() - started,
      error: `أداة غير معروفة: ${toolId}`,
    };
  }

  const impl = IMPLEMENTATIONS[toolId];
  if (!impl) {
    return {
      toolId,
      ok: false,
      output: null,
      logs,
      durationMs: Date.now() - started,
      error: `لا يوجد تنفيذ للأداة: ${toolId}`,
    };
  }

  // Validate required parameters.
  const missing = definition.parameters
    .filter((p) => p.required && args[p.name] == null)
    .map((p) => p.name);
  if (missing.length > 0) {
    return {
      toolId,
      ok: false,
      output: null,
      logs,
      durationMs: Date.now() - started,
      error: `معطيات مطلوبة مفقودة: ${missing.join(', ')}`,
    };
  }

  try {
    await sleep(120 + Math.random() * 260);
    const { output, logs: implLogs } = await impl(args);
    logs.push(...(implLogs ?? []));
    return {
      toolId,
      ok: true,
      output,
      logs,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      toolId,
      ok: false,
      output: null,
      logs,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : 'فشل تنفيذ الأداة',
    };
  }
}
