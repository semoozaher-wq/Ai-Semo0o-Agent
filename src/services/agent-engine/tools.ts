/**
 * Tool runtime — the bridge between the LLM "brain" and the real world.
 *
 * This module is the upgraded `tools.js`. It:
 *
 *   1. Compiles the {@link TOOLS} catalog into provider-ready JSON schemas
 *      (OpenAI / Gemini / Anthropic) via the `tool-schema` compiler.
 *   2. Validates every model-supplied argument object against the tool's strict
 *      JSON schema *before* execution (the "قواعد JSON دقيقة" layer).
 *   3. Exposes a registry so real implementations (GitHub, ZIP, workspace, …)
 *      can be plugged in — mock implementations remain the safe default.
 *   4. Provides a {@link ToolRunner} adapter that plugs straight into the
 *      agentic `runToolLoop` / `streamToolLoop`.
 */

import { getTool, TOOLS } from '../../data/tools';
import { ToolDefinition } from '../../types/tool';
import { ToolSchema } from '../../types/model';
import { sleep } from '../../utils/async';
import { uid } from '../../utils/id';
import { toOpenAITools, validateToolArguments } from '../ai/tool-schema';
import type { ToolRunOutcome, ToolRunner } from '../ai/tool-loop';

export interface ToolRunResult {
  toolId: string;
  ok: boolean;
  output: unknown;
  logs: string[];
  durationMs: number;
  error?: string;
}

export interface ToolImplementationResult {
  output: unknown;
  logs?: string[];
}

export type ToolImplementation = (
  args: Record<string, unknown>,
) => Promise<ToolImplementationResult>;

/* -------------------------------------------------------------------------- */
/*  Default (sandboxed) implementations                                        */
/* -------------------------------------------------------------------------- */

/**
 * Sandboxed default implementations. They return deterministic, realistic
 * output so the autonomous engine is fully demonstrable without external
 * credentials. Real implementations (registered via {@link registerTool}) take
 * precedence over these.
 */
const DEFAULT_IMPLEMENTATIONS: Record<string, ToolImplementation> = {
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

/* -------------------------------------------------------------------------- */
/*  Registry                                                                   */
/* -------------------------------------------------------------------------- */

/** Real implementations registered at runtime, keyed by tool id. */
const REGISTERED_IMPLEMENTATIONS: Record<string, ToolImplementation> = {};

/**
 * Register (or override) a real implementation for a tool. Services such as
 * GitHub / ZIP / workspace call this on import so the LLM can drive them.
 */
export function registerTool(toolId: string, impl: ToolImplementation): void {
  REGISTERED_IMPLEMENTATIONS[toolId] = impl;
}

export function unregisterTool(toolId: string): void {
  delete REGISTERED_IMPLEMENTATIONS[toolId];
}

function resolveImplementation(toolId: string): ToolImplementation | undefined {
  return REGISTERED_IMPLEMENTATIONS[toolId] ?? DEFAULT_IMPLEMENTATIONS[toolId];
}

export function isToolImplemented(toolId: string): boolean {
  return Boolean(resolveImplementation(toolId));
}

/** True when a *real* (non-sandboxed) implementation is registered. */
export function isToolLive(toolId: string): boolean {
  return toolId in REGISTERED_IMPLEMENTATIONS;
}

/* -------------------------------------------------------------------------- */
/*  Schema compilation                                                         */
/* -------------------------------------------------------------------------- */

/** Compile the full tool catalog into OpenAI-style function schemas. */
export function agentToolSchemas(): ToolSchema[] {
  return toOpenAITools(TOOLS);
}

/** Compile only the requested tools (by id) into provider schemas. */
export function toolSchemasFor(toolIds: string[]): ToolSchema[] {
  const defs = toolIds
    .map((id) => getTool(id))
    .filter((d): d is ToolDefinition => Boolean(d));
  return toOpenAITools(defs);
}

export function listAgentTools(): ToolDefinition[] {
  return [...TOOLS];
}

/* -------------------------------------------------------------------------- */
/*  Execution                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Run a tool by id with strict JSON-schema validation.
 *
 * Validation runs against the *compiled* schema, so enum, type, required and
 * numeric-bound rules are all enforced. Invalid input never reaches the
 * implementation — the error is returned so it can be fed back to the model.
 */
export async function runTool(
  toolId: string,
  args: Record<string, unknown> = {},
  options: { simulateLatency?: boolean } = {},
): Promise<ToolRunResult> {
  const started = Date.now();
  const logs: string[] = [];
  const definition = getTool(toolId);

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

  const impl = resolveImplementation(toolId);
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

  // Strict validation against the compiled JSON schema.
  const schema = toOpenAITools([definition])[0].function.parameters;
  const validation = validateToolArguments(schema, args);
  if (!validation.ok) {
    return {
      toolId,
      ok: false,
      output: { issues: validation.issues },
      logs,
      durationMs: Date.now() - started,
      error: `معطيات غير صالحة: ${validation.issues
        .map((i) => `${i.path || '<root>'} ${i.message}`)
        .join('; ')}`,
    };
  }

  try {
    if (options.simulateLatency !== false && !isToolLive(toolId)) {
      await sleep(120 + Math.random() * 260);
    }
    const { output, logs: implLogs } = await impl(validation.value);
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

/**
 * Adapter that lets the agentic tool-calling loop drive this runtime directly.
 * Pass it as `runTool` to {@link runToolLoop} / {@link streamToolLoop}.
 */
export const toolRunner: ToolRunner = async (
  toolId: string,
  args: Record<string, unknown>,
): Promise<ToolRunOutcome> => {
  const result = await runTool(toolId, args);
  return {
    ok: result.ok,
    output: result.output,
    error: result.error,
    logs: result.logs,
    durationMs: result.durationMs,
  };
};
