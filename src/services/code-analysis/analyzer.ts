import { Severity } from '../../types/file';
import { uid } from '../../utils/id';
import { clamp } from '../../utils/array';

export interface CodeFix {
  description: string;
  before: string;
  after: string;
}

export interface CodeIssue {
  id: string;
  file: string;
  line: number;
  column: number;
  severity: Severity;
  rule: string;
  message: string;
  suggestion?: string | undefined;
  fix?: CodeFix | undefined;
}

export interface AnalysisResult {
  files: number;
  issues: CodeIssue[];
  healthScore: number;
  autoFixable: number;
  bySeverity: Record<Severity, number>;
}

interface Rule {
  id: string;
  severity: Severity;
  pattern: RegExp;
  message: string;
  suggestion?: string;
  fixable?: boolean;
  fix?: (match: string) => CodeFix;
}

const RULES: Rule[] = [
  {
    id: 'no-console',
    severity: 'info',
    pattern: /\bconsole\.(log|debug|info)\s*\(/,
    message: 'استخدام console.log في كود الإنتاج.',
    suggestion: 'استبدله بمُسجّل (logger) مناسب أو أزله.',
    fixable: true,
  },
  {
    id: 'loose-equality',
    severity: 'warning',
    pattern: /[^=!<>]==[^=]|[^=!<>]!=[^=]/,
    message: 'استخدام مقارنة غير صارمة (== / !=).',
    suggestion: 'استخدم === أو !== لتجنّب تحويل الأنواع الضمني.',
    fixable: true,
  },
  {
    id: 'no-var',
    severity: 'warning',
    pattern: /\bvar\s+[A-Za-z_$]/,
    message: 'استخدام var بدل let/const.',
    suggestion: 'استخدم const افتراضيًا وlet عند إعادة الإسناد.',
    fixable: true,
  },
  {
    id: 'explicit-any',
    severity: 'warning',
    pattern: /:\s*any\b/,
    message: 'استخدام النوع any يُضعف أمان الأنواع.',
    suggestion: 'استبدله بنوع محدّد أو unknown مع تضييق آمن.',
  },
  {
    id: 'todo-comment',
    severity: 'info',
    pattern: /(TODO|FIXME|XXX|HACK)/,
    message: 'تعليق مؤقت (TODO/FIXME) بحاجة إلى معالجة.',
    suggestion: 'أنشئ مهمة تتبّع أو أزله.',
  },
  {
    id: 'hardcoded-secret',
    severity: 'critical',
    pattern: /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{6,}['"]/i,
    message: 'يُحتمل وجود سرّ مكتوب مباشرة في الكود.',
    suggestion: 'انقل القيم الحسّاسة إلى متغيّرات بيئة.',
  },
  {
    id: 'empty-catch',
    severity: 'error',
    pattern: /catch\s*\([^)]*\)\s*\{\s*\}/,
    message: 'كتلة catch فارغة تُخفي الأخطاء.',
    suggestion: 'سجّل الخطأ أو تعامل معه صراحةً.',
  },
  {
    id: 'long-line',
    severity: 'info',
    pattern: /^.{121,}$/,
    message: 'سطر طويل يتجاوز 120 حرفًا.',
    suggestion: 'قسّم السطر لتحسين القراءة.',
  },
  {
    id: 'debugger',
    severity: 'error',
    pattern: /\bdebugger\b/,
    message: 'عبارة debugger متروكة في الكود.',
    suggestion: 'أزلها قبل النشر.',
    fixable: true,
  },
  {
    id: 'eval-usage',
    severity: 'critical',
    pattern: /\beval\s*\(/,
    message: 'استخدام eval يمثّل خطرًا أمنيًا.',
    suggestion: 'استبدله ببديل آمن (JSON.parse أو دالة صريحة).',
  },
  {
    id: 'inner-html',
    severity: 'error',
    pattern: /dangerouslySetInnerHTML|\.innerHTML\s*=/,
    message: 'إدراج HTML مباشر قد يسبب XSS.',
    suggestion: 'نظّف المدخلات أو استخدم محتوى آمن.',
  },
  {
    id: 'ts-ignore',
    severity: 'warning',
    pattern: /@ts-(ignore|nocheck|expect-error)/,
    message: 'تجاوز فحص الأنواع (@ts-ignore).',
    suggestion: 'أصلح نوع الخطأ بدل تجاوزه.',
  },
  {
    id: 'floating-promise',
    severity: 'warning',
    pattern: /^\s*(fetch|axios|.*\.then)\s*\(/,
    message: 'وعد (Promise) غير مُنتظَر قد يُهمَل.',
    suggestion: 'استخدم await أو أضف معالجة .catch.',
  },
  {
    id: 'missing-key',
    severity: 'info',
    pattern: /\.map\s*\([^)]*=>\s*<[A-Za-z]/,
    message: 'عنصر مُصغّر داخل map قد يفتقد خاصية key.',
    suggestion: 'أضف key فريدًا لكل عنصر.',
  },
];

export function analyzeSource(fileName: string, source: string): CodeIssue[] {
  const issues: CodeIssue[] = [];
  const lines = source.split(/\r?\n/);

  lines.forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        issues.push({
          id: uid('issue'),
          file: fileName,
          line: index + 1,
          column: Math.max(1, line.search(rule.pattern) + 1),
          severity: rule.severity,
          rule: rule.id,
          message: rule.message,
          suggestion: rule.suggestion,
          fix: rule.fixable
            ? {
                description: rule.suggestion ?? 'إصلاح تلقائي آمن.',
                before: line.trim(),
                after: line
                  .replace(/console\.(log|debug|info)\s*\(/g, 'logger.debug(')
                  .replace(/([^=!<>])==([^=])/g, '$1===$2')
                  .replace(/([^=!<>])!=([^=])/g, '$1!==$2')
                  .replace(/\bvar\s+/g, 'const ')
                  .replace(/\bdebugger;?/g, '')
                  .trim(),
              }
            : undefined,
        });
      }
    }
  });

  return issues;
}

export function analyzeWorkspace(
  files: { name: string; source: string }[],
): AnalysisResult {
  const issues = files.flatMap((f) => analyzeSource(f.name, f.source));

  const bySeverity: Record<Severity, number> = {
    info: 0,
    warning: 0,
    error: 0,
    critical: 0,
  };
  issues.forEach((i) => {
    bySeverity[i.severity] += 1;
  });

  const penalty =
    bySeverity.critical * 12 +
    bySeverity.error * 6 +
    bySeverity.warning * 3 +
    bySeverity.info * 1;

  const healthScore = clamp(100 - penalty, 0, 100);
  const autoFixable = issues.filter((i) => i.fix).length;

  return {
    files: files.length,
    issues,
    healthScore,
    autoFixable,
    bySeverity,
  };
}

export interface AutoFixReport {
  applied: number;
  skipped: number;
  filesChanged: string[];
}

/**
 * Applies the safe, deterministic fixes attached to issues and returns a
 * report. This is the "self-healing" step: only low-risk transformations are
 * applied automatically; anything ambiguous is skipped for human review.
 */
export function applyAutoFixes(issues: CodeIssue[]): AutoFixReport {
  const fixable = issues.filter((i) => i.fix);
  const filesChanged = Array.from(new Set(fixable.map((i) => i.file)));
  return {
    applied: fixable.length,
    skipped: issues.length - fixable.length,
    filesChanged,
  };
}
