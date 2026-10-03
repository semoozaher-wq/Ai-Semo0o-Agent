import {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResult,
  ProviderConfigMap,
  ProviderId,
  TokenUsage,
} from '../../types/model';
import { getModel } from '../../data/models';
import { estimateTokens } from '../../utils/text';
import { uid } from '../../utils/id';
import { sleep } from '../../utils/async';
import type { LLMProvider, ProviderFactory } from './provider';
import {
  createAnthropicProvider,
  createGeminiProvider,
  createOpenAIProvider,
} from './providers';

/* -------------------------------------------------------------------------- */
/*  Intent-aware mock response generator                                      */
/* -------------------------------------------------------------------------- */

type Intent =
  | 'code'
  | 'summarize'
  | 'translate'
  | 'plan'
  | 'research'
  | 'data'
  | 'image'
  | 'greeting'
  | 'general';

function detectIntent(text: string): Intent {
  const t = text.toLowerCase();
  if (/^(hi|hello|hey|مرحبا|أهلا|السلام)/.test(t)) return 'greeting';
  if (/(كود|برمج|code|function|bug|خطأ|refactor|api|typescript|python)/.test(t))
    return 'code';
  if (/(لخّص|لخص|summar|ملخص|نقاط رئيسية)/.test(t)) return 'summarize';
  if (/(ترجم|translate|بالعربية|بالإنجليزية|translation)/.test(t)) return 'translate';
  if (/(خطة|plan|خطوات|roadmap|جدول|schedule)/.test(t)) return 'plan';
  if (/(ابحث|research|مصادر|تقرير|sources|report|مقارنة)/.test(t)) return 'research';
  if (/(بيانات|data|csv|تحليل|chart|رسم|إحصاء|dataset)/.test(t)) return 'data';
  if (/(صورة|image|رسم|generate.*image|تصميم)/.test(t)) return 'image';
  return 'general';
}

function mockBody(intent: Intent, prompt: string): string {
  const topic = prompt.trim().slice(0, 120) || 'طلبك';
  switch (intent) {
    case 'greeting':
      return `مرحبًا! 👋 أنا **Semo0o AI**، منصّتك الذكية لتنفيذ المهام المعقّدة.\n\nيمكنني:\n- 🔍 البحث والتحليل من مصادر متعددة\n- 🧩 كتابة وتصحيح الأكواد (إصلاح ذاتي)\n- 📊 تحليل البيانات وبناء الرسوم البيانية\n- 🤖 تشغيل وكلاء مستقلّين لإنجاز مهام كاملة\n\nما الذي تودّ أن نبدأ به اليوم؟`;
    case 'code':
      return `### حلّ مقترح\n\nقمت بتحليل طلبك حول: _${topic}_\n\n\`\`\`typescript\n// توليد دالة آمنة مع معالجة الأخطاء\nexport function solve(input: string): Result {\n  if (!input) {\n    return { ok: false, error: 'INPUT_REQUIRED' };\n  }\n  // ... منطق الحل\n  return { ok: true, value: process(input) };\n}\n\`\`\`\n\n**نقاط رئيسية:**\n1. عزل الحالات الحدّية (input فارغ، أنواع خاطئة).\n2. إرجاع نتيجة صريحة بدل رمي الاستثناءات.\n3. إضافة اختبارات وحدة تغطّي المسارات الحرجة.\n\nهل تريد أن أُولّد الاختبارات وأتحقق من تشغيلها في بيئة معزولة؟`;
    case 'summarize':
      return `### الملخّص التنفيذي\n\n**الفكرة الأساسية:** ${topic}\n\n**النقاط الرئيسية:**\n- 🎯 الهدف: توضيح الجوهر في أقل عدد من الكلمات.\n- 🔑 الركائز: ثلاث ركائز أساسية تدعم الموضوع.\n- ⚠️ التحذيرات: نقطة تحتاج انتباهًا خاصًا.\n- ✅ التوصية: خطوة عملية تالية واضحة.\n\n**الخلاصة في سطر:** الفكرة قابلة للتنفيذ وذات أثر مباشر إذا بدأت بالركيزة الأولى.`;
    case 'translate':
      return `### الترجمة\n\n**النص الأصلي:**\n> ${topic}\n\n**الترجمة (مع الحفاظ على النبرة):**\n> _Translation that preserves tone, idioms, and formatting while remaining natural in the target language._\n\nملاحظة: حافظت على المصطلحات التقنية دون ترجمة حرفية لضمان الدقة.`;
    case 'plan':
      return `### خطة العمل\n\n**الهدف:** ${topic}\n\n**المراحل:**\n1. **الاستكشاف** — جمع المتطلبات وفهم السياق.\n2. **التصميم** — رسم الحل وتحديد المعايير.\n3. **التنفيذ** — بناء النواة على مراحل صغيرة قابلة للاختبار.\n4. **التحقق** — اختبارات آلية ومراجعة.\n5. **الإطلاق والتحسين** — قياس النتائج والتكرار.\n\n**الجدول الزمني المقترح:** أسبوع للاستكشاف والتصميم، 2–3 أسابيع للتنفيذ، أسبوع للتحقق.`;
    case 'research':
      return `### تقرير بحثي\n\n**الموضوع:** ${topic}\n\n**المنهجية:** فحصت 12 مصدرًا، قارنت الادّعاءات، واستبعدت 4 مصادر منخفضة الموثوقية.\n\n**النتائج الرئيسية:**\n- 📌 الاتجاه الغالب: نمو متسارع مع تباين في التبنّي حسب القطاع.\n- 📌 الفجوة: نقص في الحلول المتخصّصة للأسواق الناطقة بالعربية.\n- 📌 الفرصة: دمج الوكلاء المستقلّين يقلّل زمن التنفيذ بنسبة 40–60%.\n\n**المراجع:**\n1. دراسة قطاعية (2026).\n2. تقرير سوقي محدّث.\n3. تحليل منافسين أولي.\n\n> ⚠️ الأرقام تقديرية وتحتاج تحققًا ميدانيًا قبل الاعتماد.`;
    case 'data':
      return `### تحليل البيانات\n\n**النطاق:** ${topic}\n\n**الملف التعريفي:**\n| المقياس | القيمة |\n| --- | --- |\n| عدد السجلات | 12,480 |\n| الأعمدة | 14 |\n| القيم المفقودة | 2.3% |\n| الشذوذ المكتشف | 37 صفًا |\n\n**الرؤى:**\n- 📈 ارتباط قوي بين المتغيّرين الرئيسيين (r ≈ 0.82).\n- ⚠️ 3 قيم شاذة تستدعي مراجعة يدوية.\n- 💡 التوصية: تنظيف القيم المفقودة ثم إعادة التشغيل.\n\nهل أُنشئ الرسوم البيانية الآن؟`;
    case 'image':
      return `### توليد الصورة\n\n**الوصف:** ${topic}\n\nجهّزت الوصف التالي للنموذج البصري:\n> _A polished, high-detail illustration matching your description, cinematic lighting, clean composition, no text._\n\nسأولّد 4 تنويعات ثم أعرضها للمقارنة. هل تفضّل نمطًا واقعيًا أم فنيًا؟`;
    default:
      return `### إجابة\n\nسؤالك حول **${topic}** مهم. إليك تحليلًا منظّمًا:\n\n**السياق:** فهمت طلبك وأنا أعالجه عبر التخطيط متعدد الخطوات.\n\n**الخلاصة:**\n- الفكرة قابلة للتنفيذ بخطوات واضحة.\n- العامل الحاسم هو جودة المدخلات ووضوح الهدف.\n- يمكنني تحويلها إلى مهمة مستقلّة ينفّذها الوكيل تلقائيًا.\n\nهل تريد أن أبدأ التنفيذ الآن، أم أن نضيف تفاصيل أكثر أولًا؟`;
  }
}

function buildResponseText(req: ChatCompletionRequest): string {
  const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
  const prompt = lastUser?.content ?? '';
  const intent = detectIntent(prompt);
  const body = mockBody(intent, prompt);
  return body;
}

/* -------------------------------------------------------------------------- */
/*  Mock provider                                                             */
/* -------------------------------------------------------------------------- */

export class MockProvider implements LLMProvider {
  readonly live = false;
  constructor(public id: ProviderId, private latencyMs = 220) {}

  private usage(req: ChatCompletionRequest, output: string): TokenUsage {
    const promptTokens = req.messages.reduce(
      (acc, m) => acc + estimateTokens(m.content),
      0,
    );
    const completionTokens = estimateTokens(output);
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  }

  async complete(req: ChatCompletionRequest): Promise<ChatCompletionResult> {
    await sleep(this.latencyMs);
    const content = buildResponseText(req);
    return {
      id: uid('cmpl'),
      model: req.model,
      content,
      usage: this.usage(req, content),
      finishReason: 'stop',
    };
  }

  async *stream(
    req: ChatCompletionRequest,
  ): AsyncGenerator<ChatCompletionChunk> {
    const id = uid('cmpl');
    const content = buildResponseText(req);
    const tokens = content.split(/(\s+)/);
    await sleep(this.latencyMs);
    let buffer = '';
    for (let i = 0; i < tokens.length; i += 1) {
      buffer += tokens[i];
      // Emit in small batches for a natural cadence.
      if (i % 2 === 0 || i === tokens.length - 1) {
        yield { id, delta: buffer, done: false };
        buffer = '';
        await sleep(12);
      }
    }
    if (buffer) yield { id, delta: buffer, done: false };
    yield { id, delta: '', done: true };
  }
}

/* -------------------------------------------------------------------------- */
/*  Provider registry + AIService                                             */
/* -------------------------------------------------------------------------- */

export class ProviderRegistry {
  private providers = new Map<ProviderId, LLMProvider>();

  register(provider: LLMProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: ProviderId): LLMProvider | undefined {
    return this.providers.get(id);
  }

  has(id: ProviderId): boolean {
    return this.providers.has(id);
  }

  list(): ProviderId[] {
    return Array.from(this.providers.keys());
  }
}

export const providerRegistry = new ProviderRegistry();

// Register mock providers for every known provider id so the app is fully
// functional out of the box. Real providers replace these at runtime whenever
// an API key is configured (see `configureProviders`).
(['openai', 'anthropic', 'google', 'mistral', 'meta', 'local'] as ProviderId[]).forEach(
  (id) => providerRegistry.register(new MockProvider(id)),
);

/**
 * Swap in real HTTP providers for every provider that has an API key.
 * Providers without a key keep their mock fallback, so the app never breaks.
 */
export function configureProviders(configs: ProviderConfigMap): void {
  const factories: Partial<Record<ProviderId, ProviderFactory>> = {
    openai: createOpenAIProvider,
    anthropic: createAnthropicProvider,
    google: createGeminiProvider,
  };

  (Object.keys(factories) as ProviderId[]).forEach((id) => {
    const config = configs[id];
    const factory = factories[id];
    if (!factory || !config?.apiKey) return;
    providerRegistry.register(factory({ config }));
  });
}

/** True when a real (non-mock) provider is active for the given model. */
export function isLiveModel(modelId: string): boolean {
  const model = getModel(modelId);
  const providerId = model?.provider ?? 'openai';
  return providerRegistry.get(providerId)?.live ?? false;
}

export interface AIServiceOptions {
  /** Simulated network latency for the mock runtime. */
  latencyMs?: number;
}

export class AIService {
  constructor(private registry: ProviderRegistry = providerRegistry) {}

  /** Register real providers from a `settings.apiKeys` map. */
  configure(configs: ProviderConfigMap): void {
    configureProviders(configs);
  }

  resolveProvider(modelId: string): LLMProvider {
    const model = getModel(modelId);
    const providerId = model?.provider ?? 'openai';
    const provider = this.registry.get(providerId);
    if (!provider) {
      throw new Error(`No provider registered for "${providerId}"`);
    }
    return provider;
  }

  async chat(req: ChatCompletionRequest): Promise<ChatCompletionResult> {
    return this.resolveProvider(req.model).complete(req);
  }

  stream(req: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk> {
    return this.resolveProvider(req.model).stream(req);
  }

  /** Deterministic pseudo-embedding for local similarity search. */
  async embed(text: string, dims = 64): Promise<number[]> {
    const vec = new Array<number>(dims).fill(0);
    const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      let h = 0;
      for (let i = 0; i < token.length; i += 1) {
        h = (h * 31 + token.charCodeAt(i)) >>> 0;
      }
      vec[h % dims] += 1;
    }
    const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
    return vec.map((v) => v / norm);
  }

  estimateCostUsd(modelId: string, usage: TokenUsage): number {
    const model = getModel(modelId);
    if (!model) return 0;
    return (
      (usage.promptTokens / 1_000_000) * model.inputPricePerMTokens +
      (usage.completionTokens / 1_000_000) * model.outputPricePerMTokens
    );
  }
}

export const aiService = new AIService();
