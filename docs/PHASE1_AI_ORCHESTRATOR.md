# Phase 1 — AI Orchestrator + Real LLM Planner + Tool Architecture

## الهدف

تضيف هذه المرحلة طبقة تخطيط حقيقية فوق طبقات Provider وTool Loop الموجودة، دون إعادة بناء الخدمات أو تكرارها.

المسار الجديد هو:

```text
User goal
  -> LLMPlanner
  -> JSON Schema plan
  -> strict plan validation
  -> AgentOrchestrator
  -> permission check
  -> existing runTool()
  -> real/simulated result classification
  -> usage + cost + latency + evidence events
```

## الملفات

- `src/services/agent-engine/llm-planner.ts`
  - يرسل الهدف إلى `LLMProvider` حقيقي.
  - يطلب JSON Schema منظمًا عند دعم المزود له.
  - يدعم fallback عبر أكثر من Provider.
  - يتحقق من عدد الخطوات، أنواعها، الأدوات، المعاملات، المراجع، والدورات.
- `src/services/agent-engine/orchestrator.ts`
  - ينفذ الخطة بعد نجاح التخطيط.
  - يعيد استخدام `runTool()` الموجود، لذلك تبقى validation والصلاحيات في طبقة الأدوات الحالية.
  - يطلب موافقة صريحة للأدوات الخطرة.
  - يسجل events وusage وcost وlatency ومخرجات كل خطوة.
  - لا يحوّل نتيجة أداة افتراضية إلى نجاح موثّق.
- `src/services/ai/providers/openai.ts`
  - يمرر `responseFormat` إلى OpenAI-compatible API بصيغة `json_schema`.
- `src/types/model.ts`
  - يضيف عقدًا اختياريًا متوافقًا للخروج المنظم.
- `src/types/task.ts`
  - يضيف `toolId` و`toolArgs` اختياريين إلى `PlanStep`.
- `test/phase1-orchestrator.test.ts`
  - اختبارات التخطيط المنظم، fallback، التحقق من الأدوات، الصلاحيات، ورفض النجاح المحاكى.

## حالات النتيجة

| الحالة | المعنى |
| --- | --- |
| `completed` | توجد خطوة تحقق، وتم تنفيذها بواسطة أداة حقيقية دون تحذيرات. |
| `completed_with_warnings` | التنفيذ اكتمل، لكن توجد نتائج محاكاة أو تحذيرات تمنع اعتبارها إثباتًا إنتاجيًا. |
| `failed` | فشل التخطيط أو فشلت أداة أثناء التنفيذ. |
| `blocked` | رفضت بوابة الصلاحيات أداة خطرة. |
| `cancelled` | أُلغي التنفيذ قبل اكتماله. |
| `unverified` | لا توجد خطوة تنفيذ أو تحقق كافية لإثبات النتيجة. |

## التشغيل

```bash
npm run test:phase1
npm test
npm run typecheck
npm run lint
npm run build
npm run doctor
```

## الاستخدام البرمجي

```ts
import { AgentOrchestrator } from '@/services/agent-engine';
import { aiService } from '@/services/ai';
import { listAgentTools } from '@/services/agent-engine';

const provider = aiService.resolveProvider('gpt-5');
const result = await new AgentOrchestrator().run({
  goal: 'افحص المشروع ثم شغّل التحقق النهائي',
  model: 'gpt-5',
  providers: [provider],
  tools: listAgentTools(),
  requestPermission: async ({ tool }) => {
    // اربط هذا بواجهة موافقة المستخدم أو سياسة Backend.
    return !tool.dangerous;
  },
});
```

## حدود المرحلة

- لا تزال طبقة واجهة المستخدم غير موصولة تلقائيًا بالـ Orchestrator الجديد.
- الأدوات الافتراضية في `src/services/agent-engine/tools.ts` محاكاة آمنة عند عدم تسجيل تنفيذ حقيقي. النتيجة تُعلّم `simulated` ولا تُعتبر نجاحًا موثّقًا.
- لا توجد بعد طبقة Backend/Auth/Multi-tenancy؛ لا يجب كشف هذا المسار مباشرة للويب في الإنتاج.
- JSON Schema structured output ممرر فعليًا إلى OpenAI-compatible provider. مزودو Anthropic وGemini لديهم adapters منفصلة، ويحتاج تمرير response format الخاص بهم إلى مرحلة لاحقة عند استخدام planner معهم.
- قياس التكلفة يعتمد على أسعار النموذج الموجودة في `data/models.ts`، وهي تقديرية ويجب مزامنتها مع مصدر التسعير الفعلي قبل الفوترة.

## التحقق الفعلي

اختبارات Phase 1 الحالية: **5/5 ناجحة**. وتشمل:

- JSON منظم وخطة صالحة.
- fallback إلى مزود ثانٍ بعد فشل المزود الأول.
- رفض الأدوات غير المعروفة والدورات.
- منع الإعلان عن نجاح موثّق عند استخدام أدوات محاكاة.
- حجب الأدوات الخطرة دون موافقة صريحة.
