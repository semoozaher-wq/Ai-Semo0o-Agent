# تقرير فحص وربط Ai-Semo0o-Agent

## النتيجة التنفيذية

تم تحويل مسار التشغيل الرئيسي من تنفيذ محلي في الواجهة إلى مسار Backend فعلي:

> **User → Auth → Project/Workspace isolation → Queue → Server LLM → Plan → Permission → Tool → Evidence → Verify → Final LLM result → SSE → Expo**

تم الحفاظ على الواجهة الحالية وRTL، ولم تتم إعادة بناء طبقات موجودة؛ أُضيفت طبقة الربط الخلفية فوقها، مع إزالة اعتماد Chat/Agents على `AIService` المباشر في العميل.

## ما كان موجودًا قبل التنفيذ

- تطبيق Expo/Web بواجهة عربية RTL وStores للمحادثات والوكلاء.
- Backend بـ SQLite وAuth وTenant/Project/Workspace isolation.
- Queue/Worker وCode Runner بحدود Sandbox موجودة.
- Planner/Orchestrator/Tool Calling واختبارات Phase 1/2 موجودة في طبقة التنفيذ.
- Tool Registry كان يعلن أدوات كثيرة، لكن معظمها لم يكن متصلًا بمسار Backend الفعلي.
- الاختبارات السابقة كانت قوية، لكن لم يكن هناك مسار موحد من API إلى LLM والأدوات وSSE.

## ما تم ربطه وتنفيذه

### 1. LLM Server-side

- أُضيف `backend/llm/providers.mjs` لدعم OpenAI-compatible وGemini وAnthropic.
- المفاتيح لا تدخل إلى Expo ولا تُرسل من العميل؛ تُقرأ من متغيرات بيئة Backend فقط.
- Retry وTimeout وHTTP error handling موحدة.
- تم دعم `OPENAI_API_BASE` حتى يعمل الخادم مع OpenAI-compatible proxy.
- تم التحقق فعليًا من موصل OpenAI مع `gpt-5` وكانت الاستجابة `BACKEND_LLM_OK`.

### 2. Agent Runtime

- أُضيف `backend/agent/runtime.mjs` لدورة:
  - Planner ينتج خطة JSON مقيدة بالأدوات المسجلة.
  - إعادة تخطيط واحدة عند اختيار Tool غير موجود أو خطة غير صالحة.
  - Tool Calling من LLM مع التحقق من اسم الأداة.
  - Permission gate للأدوات الخطرة.
  - تنفيذ فعلي للأداة.
  - Evidence hash وTool Call record.
  - Verification gate يمنع إعلان النجاح بلا output صالح.
  - Final LLM synthesis مع ذكر الدليل والقيود.
  - Self-healing محدود: Diagnose → Repair args → Retry مرة واحدة → Verify.
  - يمنع مسار الإصلاح الذاتي تعديل security/auth/policy.

### 3. أدوات حقيقية

تم توصيل الأدوات التالية بتنفيذ Backend حقيقي:

- `web.scrape`: جلب صفحة عامة مع SSRF protection وحد نص.
- `web.search`: Tavily عند ضبط `TAVILY_API_KEY`.
- `files.read`, `files.write`, `files.scan`: داخل Workspace مع منع traversal.
- `code.run`: يمر عبر Sandbox/runner الموجود مع حدود التنفيذ.
- `code.analyze`: فحص static bounded بدون تعديل.
- `data.profile`: CSV/JSON profiling.
- `pdf.extract`: `pdftotext` على ملف داخل Workspace.
- `doc.summarize`, `translate`: عبر LLM الخادمي.

الأدوات التالية **ليست Mock**؛ وهي مرفوضة بوضوح حتى يتم توصيل Connector فعلي:

- `image.generate`
- `image.analyze`
- `calendar.schedule`
- `email.send`

### 4. Queue وWorker وSSE

- تسجيل `agent.run` في Queue وWorker.
- حالات التشغيل: queued/running/waiting_approval/completed/failed/blocked/cancelled/unverified.
- Cancel وRetry عبر API.
- حفظ checkpoint للعودة بعد Permission.
- SSE على `/runs/:id/events` للأحداث: planning, permission, tool, self-healing, verification, run_finished.
- عميل Expo يستهلك SSE ويعرض تقدم Agent بدل استدعاء AI مباشر.

### 5. Auth وIsolation وSecrets

- تسجيل دخول/تسجيل جهاز تلقائي بحساب مستقل لكل تثبيت، مع Session token.
- عزل Tenant/Project/Workspace بقي كما هو، مع تثبيت `root_path` للمشروع بدل قيمة فارغة.
- إزالة حفظ API keys من الواجهة؛ شاشة Settings تعرض أن المفاتيح تُدار على الخادم.
- قالب إعداد آمن في `backend/.env.example` بلا أسرار.
- Audit log وEvidence وUsage/Token/Cost tracking مضافة إلى SQLite.

## الملفات المضافة

- `backend/agent/catalog.mjs`
- `backend/agent/runtime.mjs`
- `backend/llm/providers.mjs`
- `backend/runtime-shared.mjs`
- `backend/test/agent-runtime.test.mjs`
- `backend/.env.example`

## الملفات المعدلة

- `backend/db/schema.sql`
- `backend/queue/queue.mjs`
- `backend/server.mjs`
- `backend/tools/registry.mjs`
- `backend/worker.mjs`
- `src/services/api/client.ts`
- `src/store/useChatStore.ts`
- `src/store/useAgentsStore.ts`
- `src/store/useAppStore.ts`
- `src/hooks/useBootstrap.ts`
- `src/screens/Settings.tsx`
- ملفات Store/imports التي كانت مكررة أو ذات مسارات مفقودة من الفحص السابق.
- تمت إعادة ملفات `dist` المولدة إلى حالة Git الأصلية حتى لا تختلط مخرجات البناء بتعديلات المصدر.

## الاختبارات والتحقق

نجحت جميع الفحوصات:

- `npm run typecheck`: **نجاح**
- `npm run lint`: **نجاح، دون أخطاء أو تحذيرات**
- الاختبار الشامل: **80/80** في harness
- اختبارات execution: **28/28**
- اختبارات Phase 1: **14/14**
- اختبارات Phase 2: **11/11**
- اختبارات Backend: **8/8**
- `npm run doctor`: **21/21**
- `npm run build`: **نجاح**
- اختبار E2E Auth → Project → Queue → Tool → Evidence → SSE: **نجاح**
- اختبار E2E حقيقي مع OpenAI `gpt-5`: **نجاح**؛ نفّذ `files.scan` وأنتج جوابًا نهائيًا بالدليل، وسُجلت 2 Evidence وUsage: 2,943 token مع cost tracking.

## المتبقي فقط

1. يجب ضبط مفاتيح Gemini/Anthropic/Tavily في بيئة الإنتاج إذا أريد تفعيلها؛ البيئة الحالية تحوي OpenAI فقط.
2. أدوات الصور والبريد والتقويم تحتاج Connectors حقيقية قبل تفعيلها، وهي الآن تفشل صراحة ولا تدعي النجاح.
3. يلزم تشغيل `backend/worker.mjs` كخدمة مستقلة في الإنتاج مع Secret Manager ونسخ احتياطي SQLite/ترقية قاعدة بيانات مناسبة.
4. SSE يعرض تقدم التشغيل ونتائجه؛ لا يوجد حاليًا token-by-token streaming من مزود LLM لأن مزودات proxy الحالية لا تعتمد streaming موحدًا.
5. Bootstrap auth التلقائي مناسب لتجربة الجهاز؛ للمنتج متعدد المستخدمين يجب إضافة شاشة Login/Invite وإدارة أعضاء Workspace.

## تشغيل Backend

```bash
cp backend/.env.example .env
# ضع الأسرار في Secret Manager أو بيئة التشغيل، لا في Git
node backend/worker.mjs
node backend/server.mjs
```

يجب ضبط `EXPO_PUBLIC_BACKEND_URL` في Expo إلى عنوان Backend، ولا يجب وضع أي `OPENAI_API_KEY` أو مفاتيح مزودين في Expo.
