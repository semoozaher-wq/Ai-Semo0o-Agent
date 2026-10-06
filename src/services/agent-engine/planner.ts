import { Plan, PlanStep, StepKind } from '../../types/task';
import { uid } from '../../utils/id';

interface StepSeed {
  kind: StepKind;
  title: string;
  description: string;
}

interface PlanTemplate {
  id: string;
  match: RegExp;
  reasoning: string;
  steps: StepSeed[];
}

const TEMPLATES: PlanTemplate[] = [
  {
    id: 'research',
    match: /(ابحث|بحث|research|تقرير|report|مصادر|sources|تحليل منافس|competitive)/i,
    reasoning:
      'المهمة بحثية، لذا أبدأ بتوضيح السؤال ثم أجمع المصادر وأتحقق منها قبل الصياغة.',
    steps: [
      { kind: 'reason', title: 'توضيح السؤال', description: 'تفكيك الهدف إلى أسئلة فرعية قابلة للبحث.' },
      { kind: 'search', title: 'جمع المصادر', description: 'البحث في الويب وجمع 10+ مصادر موثوقة.' },
      { kind: 'analyze', title: 'تحليل المحتوى', description: 'استخراج الادّعاءات الرئيسية ومقارنتها.' },
      { kind: 'verify', title: 'التحقق من الحقائق', description: 'مطابقة الادّعاءات مع مصادر متعددة.' },
      { kind: 'write', title: 'صياغة التقرير', description: 'كتابة تقرير منظّم بالمراجع.' },
      { kind: 'reflect', title: 'مراجعة الجودة', description: 'فحص الاكتمال والدقة قبل التسليم.' },
    ],
  },
  {
    id: 'build',
    match: /(ابن|ابنِ|build|برمج|code|تطبيق|app|api|refactor|أصلح|fix|bug)/i,
    reasoning:
      'المهمة هندسية، لذا أخطط، أبني على مراحل صغيرة، أختبر، ثم أصلح الأخطاء ذاتيًا.',
    steps: [
      { kind: 'reason', title: 'تحليل المتطلبات', description: 'تحديد المدخلات والمخرجات والقيود.' },
      { kind: 'code', title: 'تصميم البنية', description: 'رسم المكوّنات وواجهاتها.' },
      { kind: 'code', title: 'تنفيذ النواة', description: 'كتابة الكود الأساسي بشكل معياري.' },
      { kind: 'code', title: 'إضافة الاختبارات', description: 'توليد اختبارات تغطّي المسارات الحرجة.' },
      { kind: 'tool', title: 'تشغيل الاختبارات', description: 'تنفيذ الاختبارات في بيئة معزولة.' },
      { kind: 'analyze', title: 'فحص ساكن', description: 'تحليل الأكواد واكتشاف الأخطاء والثغرات.' },
      { kind: 'code', title: 'إصلاح ذاتي', description: 'إصلاح الأخطاء المكتشفة وإعادة الاختبار.' },
      { kind: 'reflect', title: 'التوثيق والتسليم', description: 'توثيق النتيجة وملخص التغييرات.' },
    ],
  },
  {
    id: 'data',
    match: /(بيانات|data|csv|تحليل|dataset|chart|رسم|إحصاء|تدقيق|audit|ملفات|files)/i,
    reasoning:
      'المهمة تحليلية، لذا أبدأ بالفحص، ثم التنظيف، ثم الاستكشاف، وأخيرًا العرض البصري.',
    steps: [
      { kind: 'reason', title: 'فهم البيانات', description: 'تحديد الملفات والأعمدة والأنواع.' },
      { kind: 'analyze', title: 'الملف التعريفي', description: 'حساب الإحصاءات وكشف القيم المفقودة.' },
      { kind: 'analyze', title: 'كشف الشذوذ', description: 'رصد القيم الشاذة والتكرارات.' },
      { kind: 'tool', title: 'بناء الرسوم', description: 'توليد رسوم بيانية توضيحية.' },
      { kind: 'write', title: 'الملخص التنفيذي', description: 'كتابة الرؤى والتوصيات.' },
    ],
  },
  {
    id: 'content',
    match: /(محتوى|content|مقال|post|تسويق|marketing|seo|نص|copy)/i,
    reasoning:
      'المهمة إبداعية، لذا أبدأ بفهم الجمهور والنبرة، ثم أنتج مسوّدة، ثم أحسّنها.',
    steps: [
      { kind: 'reason', title: 'تحليل الجمهور', description: 'تحديد الجمهور المستهدف والنبرة.' },
      { kind: 'search', title: 'بحث الكلمات المفتاحية', description: 'جمع الكلمات والاتجاهات.' },
      { kind: 'write', title: 'مسوّدة المحتوى', description: 'كتابة النسخة الأولى.' },
      { kind: 'analyze', title: 'تحسين SEO', description: 'تحسين العناوين والبنية.' },
      { kind: 'reflect', title: 'مراجعة نهائية', description: 'تدقيق اللغة والاتساق.' },
    ],
  },
];

const GENERIC: PlanTemplate = {
  id: 'generic',
  match: /.*/,
  reasoning:
    'مهمة عامة، لذا أتّبع دورة: تخطيط ← تنفيذ ← تحقق ← انعكاس.',
  steps: [
    { kind: 'reason', title: 'فهم الهدف', description: 'تفكيك الطلب إلى مهام فرعية.' },
    { kind: 'search', title: 'جمع المعلومات', description: 'الحصول على ما يلزم من بيانات.' },
    { kind: 'analyze', title: 'المعالجة', description: 'تحليل المعلومات واتخاذ القرارات.' },
    { kind: 'write', title: 'إنتاج المخرجات', description: 'صياغة النتيجة النهائية.' },
    { kind: 'reflect', title: 'التحقق والتسليم', description: 'مراجعة الجودة قبل التسليم.' },
  ],
};

export function selectTemplate(goal: string): PlanTemplate {
  return TEMPLATES.find((t) => t.match.test(goal)) ?? GENERIC;
}

export function createPlan(goal: string, _model: string): Plan {
  const template = selectTemplate(goal);
  const steps: PlanStep[] = template.steps.map((seed, index) => ({
    id: uid('step'),
    index,
    kind: seed.kind,
    title: seed.title,
    description: seed.description,
    dependsOn: index === 0 ? [] : [`step-${index - 1}`],
    status: 'pending',
  }));

  // Re-map dependsOn to real step ids.
  steps.forEach((step, index) => {
    step.dependsOn = index === 0 ? [] : [steps[index - 1]?.id ?? ''];
  });

  return {
    id: uid('plan'),
    goal,
    createdAt: new Date().toISOString(),
    steps,
    reasoning: template.reasoning,
  };
}

/**
 * Re-plans after a failure: inserts a recovery step before the failed one.
 */
export function replan(plan: Plan, failedStepId: string): Plan {
  const idx = plan.steps.findIndex((s) => s.id === failedStepId);
  if (idx < 0) return plan;
  const recovery: PlanStep = {
    id: uid('step'),
    index: idx,
    kind: 'reflect',
    title: 'خطة استرداد',
    description: 'تحليل سبب الفشل وتعديل المسار قبل إعادة المحاولة.',
    dependsOn: idx === 0 ? [] : [plan.steps[idx - 1]?.id ?? ''],
    status: 'pending',
  };
  const steps = [...plan.steps];
  steps.splice(idx, 0, recovery);
  return {
    ...plan,
    steps: steps.map((s, i) => ({ ...s, index: i })),
  };
}

export function planProgress(steps: PlanStep[]): number {
  if (steps.length === 0) return 0;
  const done = steps.filter(
    (s) => s.status === 'completed' || s.status === 'skipped',
  ).length;
  return done / steps.length;
}
