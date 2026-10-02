import { AuditCheck, AuditConfig, FileEntry } from '../../types/file';
import { clamp } from '../../utils/array';

/**
 * The comprehensive multi-file audit (the "153-file" audit).
 *
 * Each check inspects the scanned workspace and returns pass/fail plus a
 * human-readable detail. The aggregate score is a weighted pass rate.
 */

type Predicate = (files: FileEntry[]) => { passed: boolean; detail: string };

interface CheckSpec {
  id: string;
  label: string;
  labelAr: string;
  description: string;
  weight: number;
  test: Predicate;
}

const specs: CheckSpec[] = [
  {
    id: 'coverage',
    label: 'File coverage',
    labelAr: 'تغطية الملفات',
    description: 'التأكد من فحص العدد المتوقع من الملفات (153).',
    weight: 1,
    test: (files) => ({
      passed: files.length >= 153,
      detail: `تم فحص ${files.length} من أصل 153 ملفًا.`,
    }),
  },
  {
    id: 'no-oversized',
    label: 'No oversized files',
    labelAr: 'لا ملفات ضخمة',
    description: 'عدم وجود ملفات تتجاوز 1 ميجابايت.',
    weight: 2,
    test: (files) => {
      const big = files.filter((f) => f.sizeBytes >= 1_000_000);
      return {
        passed: big.length === 0,
        detail: big.length === 0 ? 'لا توجد ملفات ضخمة.' : `${big.length} ملفًا يتجاوز 1 ميجابايت.`,
      };
    },
  },
  {
    id: 'no-duplicates',
    label: 'No duplicate names',
    labelAr: 'لا تكرارات بالاسم',
    description: 'عدم وجود أسماء ملفات مكرّرة داخل النطاق.',
    weight: 2,
    test: (files) => {
      const seen = new Map<string, number>();
      files.forEach((f) => seen.set(f.name, (seen.get(f.name) ?? 0) + 1));
      const dup = Array.from(seen.values()).filter((n) => n > 1).length;
      return {
        passed: dup === 0,
        detail: dup === 0 ? 'لا تكرارات.' : `${dup} اسمًا مكرّرًا.`,
      };
    },
  },
  {
    id: 'tagged',
    label: 'All files tagged',
    labelAr: 'وسم كل الملفات',
    description: 'أن يكون لكل ملف وسم واحد على الأقل.',
    weight: 1,
    test: (files) => {
      const untagged = files.filter((f) => !f.tags || f.tags.length === 0);
      return {
        passed: untagged.length === 0,
        detail:
          untagged.length === 0
            ? 'كل الملفات موسومة.'
            : `${untagged.length} ملفًا بلا وسوم.`,
      };
    },
  },
  {
    id: 'docs-present',
    label: 'Documentation present',
    labelAr: 'وجود التوثيق',
    description: 'وجود ملفات توثيق (README / docs).',
    weight: 1,
    test: (files) => {
      const docs = files.filter(
        (f) => f.kind === 'document' || /readme|docs/i.test(f.path),
      );
      return {
        passed: docs.length >= 3,
        detail: `${docs.length} ملف توثيق.`,
      };
    },
  },
  {
    id: 'code-tests',
    label: 'Code has tests',
    labelAr: 'اختبارات للكود',
    description: 'وجود ملفات اختبار مقابلة لملفات الكود.',
    weight: 2,
    test: (files) => {
      const code = files.filter((f) => f.kind === 'code').length;
      const tests = files.filter((f) => /test|spec/i.test(f.name)).length;
      const ratio = code === 0 ? 1 : tests / code;
      return {
        passed: tests > 0,
        detail: `${tests} ملف اختبار مقابل ${code} ملف كود (نسبة ${(ratio * 100).toFixed(0)}%).`,
      };
    },
  },
  {
    id: 'no-todo',
    label: 'No pending markers',
    labelAr: 'لا علامات معلّقة',
    description: 'عدم وجود TODO/FIXME في أسماء الملفات.',
    weight: 1,
    test: (files) => {
      const todo = files.filter((f) => /todo|fixme/i.test(f.name));
      return {
        passed: todo.length === 0,
        detail: todo.length === 0 ? 'لا علامات معلّقة.' : `${todo.length} ملفًا معلّقًا.`,
      };
    },
  },
  {
    id: 'no-secrets',
    label: 'No secret files',
    labelAr: 'لا ملفات أسرار',
    description: 'عدم وجود ملفات أسرار/مفاتيح مكشوفة.',
    weight: 3,
    test: (files) => {
      const secrets = files.filter((f) =>
        /(secret|\.env|credential|private[_-]?key|id_rsa)/i.test(f.name),
      );
      return {
        passed: secrets.length === 0,
        detail:
          secrets.length === 0
            ? 'لا ملفات أسرار مكشوفة.'
            : `${secrets.length} ملفًا حسّاسًا يحتاج حماية.`,
      };
    },
  },
  {
    id: 'balanced-kinds',
    label: 'Balanced file kinds',
    labelAr: 'تنوّع أنواع الملفات',
    description: 'وجود تنوّع صحي بين أنواع الملفات.',
    weight: 1,
    test: (files) => {
      const kinds = new Set(files.map((f) => f.kind));
      return {
        passed: kinds.size >= 5,
        detail: `${kinds.size} نوعًا مختلفًا من الملفات.`,
      };
    },
  },
  {
    id: 'fresh',
    label: 'Recently updated',
    labelAr: 'تحديث حديث',
    description: 'أن يكون جزء معتبر من الملفات محدّثًا خلال 90 يومًا.',
    weight: 1,
    test: (files) => {
      const cutoff = Date.now() - 90 * 86_400_000;
      const fresh = files.filter((f) => new Date(f.updatedAt).getTime() >= cutoff);
      const ratio = files.length === 0 ? 0 : fresh.length / files.length;
      return {
        passed: ratio >= 0.3,
        detail: `${(ratio * 100).toFixed(0)}% من الملفات محدّثة خلال 90 يومًا.`,
      };
    },
  },
  {
    id: 'no-empty-folders',
    label: 'No empty folders',
    labelAr: 'لا مجلدات فارغة',
    description: 'عدم وجود مجلدات بلا ملفات.',
    weight: 1,
    test: (files) => {
      const folders = new Set(files.map((f) => f.path.split('/').slice(0, -1).join('/')));
      const empty = Array.from(folders).filter(
        (folder) => !files.some((f) => f.path.startsWith(`${folder}/`)),
      );
      return {
        passed: empty.length === 0,
        detail: empty.length === 0 ? 'لا مجلدات فارغة.' : `${empty.length} مجلدًا فارغًا.`,
      };
    },
  },
  {
    id: 'structure',
    label: 'Logical structure',
    labelAr: 'بنية منطقية',
    description: 'توزّع الملفات على مجلدات منطقية.',
    weight: 1,
    test: (files) => {
      const folders = new Set(files.map((f) => f.path.split('/')[0]));
      return {
        passed: folders.size >= 4,
        detail: `${folders.size} مجلدًا رئيسيًا.`,
      };
    },
  },
];

export function runAudit(files: FileEntry[], name = 'تدقيق شامل'): AuditConfig {
  const checks: AuditCheck[] = specs.map((spec) => {
    const { passed, detail } = spec.test(files);
    return {
      id: spec.id,
      label: spec.label,
      labelAr: spec.labelAr,
      description: spec.description,
      passed,
      weight: spec.weight,
      detail,
    };
  });

  return {
    id: 'audit-153',
    name,
    nameAr: name,
    description: 'تدقيق آلي شامل لسلامة الملفات والبنية والأمان.',
    expectedFileCount: 153,
    checks,
  };
}

export function auditScore(config: AuditConfig): number {
  const totalWeight = config.checks.reduce((acc, c) => acc + c.weight, 0);
  if (totalWeight === 0) return 100;
  const earned = config.checks.reduce(
    (acc, c) => acc + (c.passed ? c.weight : 0),
    0,
  );
  return clamp(Math.round((earned / totalWeight) * 100), 0, 100);
}
