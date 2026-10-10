# Ai-Semo0o-Agent — Step 1 + GitHub/ZIP features (تغييرات)

هذا الأرشيف يحتوي على **الملفات المعدّلة والجديدة فقط**. لفكّ الضغط فوق المستودع:

```bash
unzip -o Ai-Semo0o-Agent-modified-files.zip -d path/to/Ai-Semo0o-Agent
npm install          # يثبّت jszip الجديد
npm run typecheck    # اختياري
```

## الخطوة 1 — الدماغ الحقيقي + استدعاء الأدوات (Tool Calling)

### أنواع جديدة/موسّعة
- `src/types/model.ts` — `JSONSchema`, `ToolSchema`, `ToolCall`, `ToolChoice`, `ProviderConfig`, رسائل/نتائج واعية بالأدوات.
- `src/types/tool.ts` — `items`, `minimum`, `maximum`, `returns`, `strict`, فئات `github`/`zip`.
- `src/types/workspace.ts` — **جديد**: أنواع مساحة العمل (ملفات، أصل، GitHub، ZIP).

### محرّك الأدوات (tools.js المطوّر)
- `src/services/ai/tool-schema.ts` — **جديد**: ترجمة `ToolDefinition` إلى JSON Schema لكل مزوّد
  (OpenAI `tools[].function.parameters` / Gemini `functionDeclarations` / Anthropic `input_schema`)
  + مُدقّق صارم للوسائط (`validateToolArguments`, `parseAndValidateToolArguments`).
- `src/services/ai/provider.ts` — **جديد**: واجهة `LLMProvider` الموحّدة.
- `src/services/ai/http.ts` — **جديد**: طبقة HTTP (`postJson`, `getJson`, `getBytes`, `streamSse`).
- `src/services/ai/tool-loop.ts` — **جديد**: حلقة الاستدعاء الوكيلية (`runToolLoop`, `streamToolLoop`).
- `src/services/ai/providers/openai.ts` — **جديد**: مزوّد OpenAI الحقيقي (chat + SSE + tool_calls).
- `src/services/ai/providers/gemini.ts` — **جديد**: مزوّد Google Gemini الحقيقي.
- `src/services/ai/providers/anthropic.ts` — **جديد**: مزوّد Anthropic Claude الحقيقي.
- `src/services/ai/providers/index.ts` — **جديد**: فهرس المزوّدين.
- `src/services/ai/runtime.ts` — سجلّ المزوّدين: يستخدم المزوّد الحقيقي عند وجود مفتاح API، وإلا يبقى الوهمي.
- `src/services/agent-engine/tools.ts` — **tools.js المطوّر**: تسجيل تنفيذات حقيقية + تحقّق صارم قبل التنفيذ.

### تهيئة
- `src/data/models.ts` — `baseUrl` + `apiModel` لكل مزوّد.

## الرسالة الثانية — GitHub + ZIP

- `src/services/workspace/github.ts` — **جديد**: تحليل رابط GitHub، شجرة الملفات، قراءة المحتوى، تنزيل ZIP.
- `src/services/workspace/zip.ts` — **جديد**: فكّ/إنشاء ZIP عبر JSZip + تنزيل (ويب/الأصلي).
- `src/services/workspace/workspace.ts` — **جديد**: نظام ملفات افتراضي + حفظ.
- `src/services/workspace/runtime.ts` — **جديد**: singleton مشترك + تدفّقات الاستيراد/التصدير.
- `src/services/workspace/tools.ts` — **جديد**: أدوات الوكيل `github.import`, `github.inspect`, `zip.import`, `zip.export`, `workspace.*`.
- `src/services/workspace/index.ts` — **جديد**: فهرس.
- `src/data/tools.ts` — 8 أدوات جديدة (GitHub/ZIP/workspace).
- `src/store/useWorkspaceStore.ts` — **جديد**: حالة مساحة العمل (استيراد/كتابة/حذف/تصدير).
- `src/screens/Workspace.tsx` — **جديد**: شاشة مساحة العمل (استيراد GitHub/ZIP، تحرير، تصدير ZIP).
- `app/workspace.tsx` — **جديد**: مسار Expo.
- `src/screens/Dashboard.tsx` + `src/screens/Files.tsx` — روابط للوصول إلى مساحة العمل.
- `package.json` — إضافة `jszip`.

## التحقّق (Verification)
- `test/harness.ts` — **جديد**: 80 اختبارًا (محرّك المخطط، المُدقّق، حلقة الأدوات، محلّل GitHub، ZIP، مساحة العمل، base64).
- `tsconfig.check.json` — **جديد**: إعداد فحص أنواع معزول للوحدات الجديدة.
- النتيجة: **80/80 اختبار ناجح** و**فحص أنواع نظيف (0 أخطاء)**.

## ملاحظة
أثناء الفحص أُصلح خطآن حقيقيان:
1. `src/services/ai/providers/gemini.ts` — نوع إرجاع `safeParse` (`Record<string, unknown>`).
2. `src/services/workspace/github.ts` — إضافة `ref?: string` إلى `GitHubImportOptions` ليدعم تحديد الفرع.
