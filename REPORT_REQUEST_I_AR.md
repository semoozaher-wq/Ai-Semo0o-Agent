# تقرير الإصلاح — Request I
## إصلاح فشل تشغيل Agent من واجهة Semo AI (0 خطوات / gpt-5)

---

## 1) السبب الجذري (Root Cause)

كان هناك **سببان حقيقيان مستقلان**، وكلاهما أُثبت بأدلة من بيئة الإنتاج الفعلية:

### السبب A — Backend: مجلّد مساحة العمل (WORKSPACE_ROOT) غير قابل للكتابة على Render Free (السبب الأساسي)
- فحص `GET https://ai-semo0o-agent-3.onrender.com/ready` أعاد:
  ```json
  {"ok":false,"checks":{"database":{"ok":true},
   "workspace":{"ok":false,"configured":true,"root":"/var/data/workspace",
                "error":"WORKSPACE_NOT_WRITABLE"},
   "providers":{"ok":true,"configured":1,"total":1}}}
  ```
- خطة Render المجانية **لا تحتوي على قرص دائم** مُثبَّت على `/var/data`، لذلك `mkdir('/var/data/workspace')` داخل `POST /projects` يفشل بـ `EACCES` ويُعيد `500 INTERNAL_ERROR` (تم إثباته: طلب `POST /projects` على الإنتاج أعاد `500`).
- بما أن `useAgentsStore.runTask()` تستدعي `createProject()` **أولًا**، فإنها تفشل قبل الوصول إلى `createRun`، فتظهر رسالة **"فشل التشغيل التنفيذي عبر الـBackend"** وتبقى **0 خطوات**.
- دالة `applyRuntimeDefaults()` (من طلب سابق) كانت تُعبّئ `WORKSPACE_ROOT` **فقط عندما يكون غير مُعرَّف**، بينما الإنتاج يُعرّفه صراحةً إلى مسار غير قابل للكتابة.

### السبب B — Frontend: قيمة `EXPO_PUBLIC_BACKEND_URL` خاطئة ومشوّهة داخل الحزمة المبنية
- الحزمة المنشورة فعليًا على Vercel (`entry-fbd5484f6470de7d1fd14408f320d900.js`) تحتوي حرفيًا على:
  ```js
  constructor(t=('undefined'!=typeof process?"[https://printer-turbo.onrender.com](https://printer-turbo.onrender.com)":'')){...}
  ```
- أي أن القيمة المدمجة وقت البناء هي **رابط Markdown مشوّه** يشير إلى Backend **خاطئ/ميت** (`printer-turbo.onrender.com`) وليس إلى `https://ai-semo0o-agent-3.onrender.com` (عدد مرات الظهور: `printer-turbo` = 1، و`ai-semo0o-agent-3` = 0).
- قيمة كهذه تجعل `fetch()` يفشل (`Failed to parse URL`) أو تتصل بمضيف ميت → نفس رسالة الفشل.

### ما تم استثناؤه بعد الفحص (ليس سببًا)
- **CORS سليم تمامًا**: `ALLOWED_ORIGIN = https://ai-semo0o-agent.vercel.app`، والطلبات من هذا الـOrigin تحصل على `access-control-allow-origin`، وغيرها تُرفض بـ `403 CORS_ORIGIN_DENIED`.
- **مسار agent.run في الـBackend سليم**: تشغيل E2E محلي عبر مسار مزوّد LLM الحقيقي اكتمل بنجاح (الأحداث: `planning_started → planning_completed → step_started → tool_completed → step_completed → run_finished`، والحالة `completed`).
- **لا توجد أخطاء Auth / API-contract / SSE / serialization**.

---

## 2) الملفات التي تم تعديلها

| # | الملف | النوع |
|---|-------|------|
| 1 | `backend/config/runtime-defaults.mjs` | تعديل |
| 2 | `backend/server.mjs` | تعديل |
| 3 | `src/services/api/client.ts` | تعديل |
| 4 | `src/services/api/backend-url.ts` | **جديد** |
| 5 | `backend/test/runtime-defaults.test.mjs` | تعديل (إضافة اختبارات) |
| 6 | `test/backend-url.test.ts` | **جديد** |

> لم يُحذف أي ملف أو وظيفة، ولم يُعَد بناء المشروع من الصفر — تم تعديل الحالة الحالية فقط.

---

## 3) التعديل الذي تم

### الإصلاح A (Backend) — إصلاح مسار مساحة العمل من الجذر
**`backend/config/runtime-defaults.mjs`**:
- إضافة `workspaceRootCandidates(env)` — سلسلة مرشّحين مرتّبة (نظير `databaseFileCandidates`):
  1. `WORKSPACE_ROOT` المُعرَّف، 2. `<repo>/backend/data/workspace`، 3. `<tmp>/semo0o/workspace`.
- إضافة `resolveWritableWorkspaceRoot(env)` — يُعيد أول مرشّح قابل للكتابة (ينشئه عند الحاجة)، ولا يرمي `EACCES` أبدًا (نظير `resolveDatabaseFile`).
- `applyRuntimeDefaults()` أصبح **يُصلح** `WORKSPACE_ROOT` المُعرَّف لكن غير القابل للكتابة إلى أول بديل قابل للكتابة (مع تسجيل تحذير)، ولا يلمس جذرًا صريحًا **قابلًا للكتابة** (يحافظ على سلوك المُشغِّل الذي يثبّت قرصًا حقيقيًا).

**`backend/server.mjs`**:
- استيراد `resolveWritableWorkspaceRoot`.
- `resolveWorkspaceRoot()` أصبح **دفاعيًا**: إذا كان `WORKSPACE_ROOT` مُعرَّفًا لكنه غير قابل للكتابة → يُصلحه إلى بديل قابل للكتابة (طبقة حماية ثانية حتى لو لم تُستدعَ `applyRuntimeDefaults`).
- **تم الحفاظ على سلوك الفشل المُغلَق** عند **عدم** تعريف `WORKSPACE_ROOT` في الإنتاج (`WORKSPACE_ROOT_REQUIRED`) — أي لم يُضعَف التحقق الأمني.

### الإصلاح B (Frontend) — تصحيح اشتقاق عنوان الـBackend
**`src/services/api/backend-url.ts` (جديد)**:
- `DEFAULT_BACKEND_URL = 'https://ai-semo0o-agent-3.onrender.com'` (رابط عام، ليس سرًّا).
- قراءة `process.env.EXPO_PUBLIC_BACKEND_URL` **بشكل ساكن** ليبقى Expo/Metro قادرًا على دمجه وقت البناء.
- `normalizeBackendUrl(raw)`: يقبل **فقط** رابط http(s) مجرّدًا صالحًا (trim + إزالة الشرطة المائلة الأخيرة). أي قيمة تحتاج "فكّ تغليف" (Markdown `[..](..)` أو أقواس/علامات تنصيص/مسافات) تُرفض وتُعدّ سوء إعداد → تُعيد `''`.
- `resolveBackendUrl()`: يُعيد القيمة المُطبَّعة إن كانت صالحة، وإلا **يعود إلى الـBackend الإنتاجي المعروف**.
- **لماذا الرفض بدل فكّ تغليف Markdown؟** لأن فكّ التغليف كان سيُبقي التطبيق يشير إلى المضيف **الخاطئ** (`printer-turbo`)؛ الرفض يجعل التطبيق يعود تلقائيًا إلى الـBackend الصحيح.

**`src/services/api/client.ts`**:
- استيراد `resolveBackendUrl` واستخدامه في الـconstructor: `constructor(private readonly baseUrl = resolveBackendUrl()) {}`.

---

## 4) الاختبارات التي نجحت

| الاختبار | النتيجة |
|----------|---------|
| مجموعة اختبارات الـBackend: `node --experimental-sqlite --test backend/test/*.test.mjs` | **63/63 نجحت** |
| اختبار الوحدة الجديد (Backend): `runtime-defaults.test.mjs` | **7/7 نجحت** |
| اختبار الوحدة الجديد (Frontend): `test/backend-url.test.ts` | **6/6 نجحت** |
| فحص الأنواع: `npx tsc --noEmit` | **نجح (exit 0)** |
| بناء الويب: `npm run build` (expo export) | **BUILD_EXIT=0** |
| فحص الحزمة المبنية | تحتوي `ai-semo0o-agent-3.onrender.com` وتُرفض قيمة `printer-turbo` المشوّهة |

**تحقق وقت التشغيل من اشتقاق العنوان (بعد البناء):**
- `EXPO_PUBLIC_BACKEND_URL='[https://printer-turbo.onrender.com](...)'` → المُخرَج: `https://ai-semo0o-agent-3.onrender.com` ✅
- `EXPO_PUBLIC_BACKEND_URL='http://localhost:10000'` → المُخرَج: `http://localhost:10000` ✅ (التطوير المحلي محفوظ)
- بدون متغيّر → `https://ai-semo0o-agent-3.onrender.com` ✅

---

## 5) نتيجة اختبار "agent.run" الفعلي

تم إعادة إنتاج العطل بدقة (`repro/workspace-fix.mjs`) بمحاكاة `WORKSPACE_ROOT` غير قابل للكتابة، ثم إثبات الإصلاح عبر تشغيل الـBackend الحقيقي (`createApp`) ومسار مزوّد LLM الحقيقي:

```
OLD-BEHAVIOUR: mkdir('<unwritable>/workspace') failed with ENOTDIR -> would be 500 INTERNAL_ERROR
BOOT-REPAIR:  WORKSPACE_ROOT '<unwritable>/workspace' -> '<repo>/backend/data/workspace'
createProject: 201 {"projectId":"project_...","workspaceId":"workspace_..."}
createRun:     202 {"runId":"run_...","taskId":"task_...","status":"queued"}
events:        planning_started, planning_completed, step_started, tool_completed, step_completed, run_finished
snapshot:      status=completed  usage=1  events=6
final:         "تم فحص مساحة العمل فعليًا مع دليل من أداة الملفات."
RESULT_STATUS=PASSED
```

✅ **بدأ Planner فعليًا، وظهرت خطوات تنفيذ حقيقية، واكتمل التشغيل بحالة `completed`.**

---

## 6) أي مشكلة متبقية

- **لا مشكلة برمجية متبقية تمنع تشغيل Agent.** الإصلاحان يعالجان السبب من الجذر.
- **إجراء نشر مطلوب (تشغيلي، غير برمجي):** بعد نشر الـBackend المُعدَّل على Render، سيُصلح `WORKSPACE_ROOT` تلقائيًا عند الإقلاع (وسيظهر `/ready` بحالة `workspace.ok=true`). يُنصح أيضًا بأحد الأمور التالية في لوحة Render:
  - إمّا **إزالة** متغيّر `WORKSPACE_ROOT` من بيئة Render ليأخذ الافتراضي القابل للكتابة،
  - أو ضبطه على مسار قابل للكتابة فعليًا (أو تثبيت قرص دائم على خطة مدفوعة).
- **إجراء نشر مطلوب للواجهة (تشغيلي، غير برمجي):** ضبط `EXPO_PUBLIC_BACKEND_URL = https://ai-semo0o-agent-3.onrender.com` في بيئة Vercel وإعادة النشر. **ومع ذلك**، الإصلاح البرمجي يجعل الواجهة تعمل بالـBackend الصحيح **حتى لو بقيت القيمة المشوّهة** (لأنها تُرفض ويُستخدم الافتراضي الصحيح).
- ملاحظة: `start:backend` في `package.json` لا يتضمّن `--experimental-sqlite` (تحسين اختياري فقط، لا علاقة له بالعطل؛ Render يستخدم الأمر الصحيح من `render.yaml`).

---

## 7) التزامات الطلب
- ✅ لم يُحذف أي شغل قديم ولم يُعَد البناء من الصفر.
- ✅ لم يُستخدم Gemini.
- ✅ لم تُضَف أي مفاتيح API أو أسرار إلى الكود أو GitHub (الرابط الافتراضي عام وليس سرًّا).
- ✅ أُصلح السبب في الكود، لا عبر workaround مؤقت.
- ✅ تم اختبار مسار `agent.run` فعليًا حتى بدء Planner وظهور خطوات حقيقية.
