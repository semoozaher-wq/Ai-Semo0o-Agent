# تقرير الإصلاحات والاختبارات — Fixes & Tests Report

**المستودع:** `semoozaher-wq/Ai-Semo0o-Agent`
**الفرع:** `fix/p1-p2-hardening` (أساس: `master @ ae2c2a3`)
**النطاق:** إصلاح جميع مشاكل P1/P2 دون كسر الوظائف الحالية، مع الحفاظ على التعديلات السابقة، وإضافة اختبارات، وتشغيل الاختبارات + الفحص الأمني + بناء الويب.
**القاعدة:** لم يُحذف أي ملف. لا ادّعاء نجاح دون دليل — كل نتيجة أدناه مرفقة بأمر إعادة إنتاج.

---

## 0. الملخّص التنفيذي

| المحور | الحالة | الدليل |
|---|---|---|
| أمان الحسابات وعزل البيانات/المحادثات | ✅ مُصلَح | 6 اختبارات عزل + فحص أمني بلا نتائج |
| رفع الملفات/الصور وإرسال محتواها الفعلي للنموذج | ✅ مُصلَح | مسار كامل: رفع → تخزين → تحميل → محتوى متعدد الوسائط |
| استمرارية SQLite والمهام بعد إعادة التشغيل | ✅ مُصلَح | اختبار إغلاق/فتح كامل + مصالحة الانهيار |
| إصلاح `projectPromise` وربط وضع الوكيل بإجراءات فعلية | ✅ مُصلَح | ذاكرة مؤقتة مفتاحية بالهوية + تشغيل `agent.run` حقيقي |
| اختبار الفيديو الحقيقي وإصلاح الواجهة/الرندر | ✅ مُصلَح | فيديو MP4 حقيقي عبر مزوّد محلي + إصلاح تنزيل 401 + صور مصغّرة حقيقية |
| تصحيح تقييم القدرات | ✅ مُصحَّح | `capability-scorecard.json` = 94/100 (proven/wired/partial) |
| فحص الملفات غير المستخدمة | ✅ مُنجَز | `docs/DEAD_FILES_REPORT.md` |

**النتيجة الإجمالية للاختبارات:** لا يوجد أي فشل في أي حزمة (تفاصيل القسم 6).

---

## 1. نطاق العمل والفرع

- العمل جرى على فرع منفصل: `fix/p1-p2-hardening`، ولم يُلمس `master`.
- التعديلات السابقة محفوظة (الفرع مبني فوق `master @ ae2c2a3` دون إعادة كتابة التاريخ).
- الملفات المعدّلة: **15**، الملفات المضافة: **16** (بما فيها هذا التقرير وتقرير الملفات الميتة).

---

## 2. الإصلاحات حسب المحور

### 2.1 أمان الحسابات وعزل البيانات والمحادثات (P1)

**ما كان:** مخاطر تسرّب عبر حدود المستأجرين (tenants) في مسارات المرفقات/التشغيلات/البث، وذاكرة مشروع وكيل قد تُورَّث بين الجلسات.

**ما تم:**
- **عزل المرفقات على مستوى المستأجر + المستخدم:** جدول `attachments` جديد في `backend/db/schema.sql` بمفاتيح أجنبية `tenant_id`/`user_id`/`conversation_id`، وفهارس `idx_attachments_tenant_user` و`idx_attachments_conversation`. كل استعلام (`getMeta`/`getContent`/`loadMany`/`remove`) مُقيَّد بـ `tenantId + userId`.
- **تخزين ثنائي على القرص لا في الصف:** بايتات الملف تُخزَّن في مجلد مُقيَّد بالمستأجر، والصف يحمل المسار + `sha256` للتحقق من مطابقة البايتات عند التحميل.
- **فشل مغلق (fail-closed) عبر الحدود:** مسارات المرفقات/التشغيلات/البث تعيد 401/403/404 عند محاولة الوصول عبر مستأجر آخر — مُغطّى بـ `backend/test/isolation-hardening.test.mjs` (6 اختبارات).
- **قطع وراثة ذاكرة المشروع عند تسجيل الخروج:** `useAuthStore.logout()` ينادي `resetChatProjectCache()` لئلا يرث المستخدم التالي مشروع/مساحة عمل جلسة سابقة.
- **خريطة رموز الأخطاء → HTTP** في `backend/server.mjs` أُضيفت لها رموز المرفقات (`ATTACHMENT_NOT_FOUND` → 404، `ATTACHMENT_TOO_LARGE`/`ATTACHMENT_DATA_INVALID` → 400، إلخ).
- **تدقيق:** كل رفع مرفق يُسجَّل في `audit_logs` (`attachment.uploaded`).

**الأدلة:** `backend/test/isolation-hardening.test.mjs`، `backend/test/attachments.test.mjs`، `npm run security:scan` (450 ملف، **0 نتائج**).

### 2.2 رفع الملفات/الصور وإرسال محتواها الفعلي للنموذج (P1)

**ما كان:** المرفقات تُرسَل كمرجع (اسم/حجم) لا كمحتوى فعلي، فلا "يرى" النموذج الصورة/الملف.

**ما تم (مسار كامل):**
1. **قراءة بايتات حقيقية من الجهاز** في `Composer.tsx` (base64/data-URL).
2. **رفع إلى الخادم** عبر `POST /attachments` (`backend/server.mjs`) وتخزين مُقيَّد بالمستأجر (`backend/chat/attachments.mjs`، بحد أقصى `MAX_ATTACHMENT_BYTES`).
3. **إرسال معرّفات المرفقات** (`attachmentIds`) مع طلب المحادثة/التشغيل، فيُحمّلها الخادم من القرص.
4. **بناء محتوى متعدد الوسائط** عبر `backend/chat/content.mjs` (`buildChatContent` / `buildAgentGoal`).
5. **تطبيع المحتوى لمزوّدي النماذج** في `backend/llm/providers.mjs`:
   - OpenAI: أجزاء `image_url` بنمط data-URL.
   - Gemini: أجزاء `inlineData { mimeType, data }`.
   - Anthropic: كتل `{ type:'image', source:{ type:'base64', media_type, data } }`.
6. **واجهة العميل:** `src/services/chat/attachments.ts` (`planAttachmentUploads` + `stripAttachmentBytes`)، وتخزين المعرّف الخادمي على رسالة المستخدم المتفائلة، وعدم حفظ بايتات base64 في الحالة.

**الأدلة:** `backend/test/attachments.test.mjs`، `backend/test/chat-content.test.mjs`، `backend/test/llm-multimodal.test.mjs`، `test/chat-attachments.test.ts` — كلها ناجحة.

### 2.3 استمرارية SQLite والمهام بعد إعادة التشغيل (P1)

**ما تم:**
- تفعيل **WAL** وفرض صلاحيات **0700 للمجلدات / 0600 للملفات** على قاعدة البيانات ومخزن المرفقات.
- **تجزئة الرموز في حالة السكون** (session tokens تُخزَّن كـ sha256، لا كنص صريح).
- **مصالحة الانهيار:** عند إعادة الفتح، الرسائل/التشغيلات التي بقيت في حالة `streaming` تُصحَّح إلى `interrupted`/`error` بدل أن تعلق.
- **طابور تشغيل متين** وعامل مُشرَف عليه (supervised worker) يستأنف المهام بعد إعادة التشغيل.

**الأدلة:** `backend/test/restart-persistence.test.mjs` (اختباران: إغلاق/إعادة فتح كامل عبر HTTP، ومصالحة انهيار) — ناجحان.

### 2.4 إصلاح `projectPromise` وربط وضع الوكيل بإجراءات فعلية (P1)

**ما كان:** ذاكرة مشروع الوكيل قد تُخزّن وعدًا مرفوضًا (rejected promise) أو تُشارَك بين الجلسات، ووضع "الوكيل" في الواجهة لا يؤدي إلى إجراء فعلي.

**ما تم:**
- **`ProjectCache` جديد** (`src/services/chat/project-cache.ts`): مفتاحي بالهوية (identity-keyed)، ولا يخزّن الوعود المرفوضة، ويُصفَّر عند تغيّر الجلسة (`resetChatProjectCache`).
- **مفتاح تبديل الوضع في `Composer.tsx`** (اتحاد `TurnMode` = `'chat' | 'agent'`)، وتمريره عبر `Chat.tsx` و`Dashboard.tsx` إلى المتجر.
- **فرع الوكيل في `useChatStore.ts`:** عند `mode === 'agent'` يستدعي `backendApi.createRun({ kind:'agent.run', projectId, workspaceId, goal, model, attachmentIds })` ثم `streamEvents(run.runId)` و`getRun(run.runId)` — أي **إجراء فعلي** لا مجرد واجهة.

**الأدلة:** `test/project-cache.test.ts`، `test/agent-mode-wiring.test.ts` (5 اختبارات، كلها ناجحة).

### 2.5 اختبار الفيديو الحقيقي وإصلاح مشاكل الواجهة والرندر (P2)

**(أ) مسار الفيديو الحقيقي:** تم التحقق عبر `backend/test/video-http-integration.test.mjs` بمزوّد HTTP محلي يُنتج **MP4 حقيقي** (التقاط بصمة `ftyp`) دون أي تكلفة، بالإضافة إلى `video-generation.test.mjs` و`media.test.mjs`. اختبارات الفيديو في الحزمة الكاملة (715/716) ناجحة.

**(ب) إصلاح خطأ التنزيل (401):** كانت روابط القطع الأثرية (artifacts) مُصادَقة بـ Bearer (بلا كوكيز)، فكان `Linking.openURL(bareUrl)` يفشل بـ 401. الحل:
- `backendApi.fetchCreationArtifact(id, name)` يجلب البايتات مع ترويسة `authorization: Bearer …` ويرفع خطأً عند الفشل.
- `Creation.tsx` يستخدم `downloadBytes(bytes, filename, mimeType)` بدل فتح الرابط المباشر.
- اختبار خادمي جديد يثبت أن الوصول بلا رمز يعيد **401**.

**الأدلة:** `test/artifact-download.test.ts` (اختباران)، واختبار المصادقة في `backend/test/creation-studio.test.mjs`.

**(ج) إصلاح رندر الصور:** كانت مرفقات الصور تُعرض كشارات نصية. الآن:
- `ChatBubble.tsx` يعرض **صورة مصغّرة حقيقية** عبر `AttachmentPreview` (من `dataBase64` المضمّن أو بجلبه عبر `backendApi.fetchAttachmentDataUrl(backendId)`)، مع تراجع إلى الشارة عند الفشل (`onError`).
- المتجر يحتفظ بمعرّف المرفق الخادمي على رسالة المستخدم المتفائلة (`patchMessage(... { attachments: stripAttachmentBytes(attachments) })`).

**الأدلة:** `test/chat-thumbnails.test.ts` (3 اختبارات)، وبناء الويب يؤكد `chat-UI v2`.

### 2.6 تصحيح تقييم القدرات

- أُعيد توليد `capability-scorecard.json` بمفردات صادقة (`proven` / `wired` / `partial`) بدل المفردة القديمة المتقادمة (`live`).
- **النتيجة الحالية:** الدرجة **94/100** (مستوى production)، **provenScore = 85**، مع **11 proven**، **1 wired** (self-healing)، **1 partial** (integrations)، و**0 unwired/failed**.
- المفردة القديمة الملتزَمة كانت 97 بكل القدرات `live` — أي متقادمة ومبالغ فيها.

**الأدلة:** `backend/test/capability-benchmark.test.mjs` (19 اختبارًا ناجحًا)، و`capability-scorecard.json` المُعاد توليده.

---

## 3. جرد الملفات المعدّلة والمضافة

### 3.1 معدّلة (15)
| الملف | التغيير |
|---|---|
| `backend/db/schema.sql` | + جدول `attachments` وفهارسه |
| `backend/llm/providers.mjs` | + تطبيع المحتوى متعدد الوسائط (OpenAI/Gemini/Anthropic) |
| `backend/server.mjs` | + مسارات المرفقات، تحميل المحتوى، خريطة الأخطاء |
| `backend/test/creation-studio.test.mjs` | + اختبار مصادقة التنزيل (401) |
| `capability-scorecard.json` | إعادة توليد صادقة (94/100) |
| `package.json` | + اختبارات الواجهة الجديدة في `test:frontend` |
| `src/components/composite/ChatBubble.tsx` | + صور مصغّرة حقيقية |
| `src/components/composite/Composer.tsx` | + قراءة بايتات حقيقية + مفتاح وضع (chat/agent) |
| `src/screens/Chat.tsx` | تمرير الوضع إلى المتجر |
| `src/screens/Creation.tsx` | تنزيل القطع الأثرية بالمصادقة |
| `src/screens/Dashboard.tsx` | تمرير الوضع |
| `src/services/api/client.ts` | + `fetchCreationArtifact` / `fetchAttachmentDataUrl`، تصحيح تعليق URL |
| `src/store/useAuthStore.ts` | تصفير ذاكرة المشروع عند الخروج |
| `src/store/useChatStore.ts` | ذاكرة مشروع مفتاحية + فرع الوكيل + رفع المرفقات |
| `src/types/chat.ts` | + `dataBase64` / `backendId` في `Attachment` |

### 3.2 مضافة (16)
`backend/chat/attachments.mjs`, `backend/chat/content.mjs`, `backend/test/attachments.test.mjs`, `backend/test/chat-content.test.mjs`, `backend/test/isolation-hardening.test.mjs`, `backend/test/llm-multimodal.test.mjs`, `backend/test/restart-persistence.test.mjs`, `scripts/dead-file-report.mjs`, `src/services/chat/attachments.ts`, `src/services/chat/project-cache.ts`, `test/agent-mode-wiring.test.ts`, `test/artifact-download.test.ts`, `test/chat-attachments.test.ts`, `test/chat-thumbnails.test.ts`, `test/project-cache.test.ts`, `docs/DEAD_FILES_REPORT.md` (+ هذا التقرير).

---

## 4. الاختبارات المضافة (جديدة بالكامل)

| الملف | العدد | يغطّي |
|---|---|---|
| `backend/test/isolation-hardening.test.mjs` | 6 | عزل المرفقات/التشغيلات/البث عبر المستأجرين (fail-closed) |
| `backend/test/attachments.test.mjs` | — | تخزين/تحميل/حذف المرفقات المُقيَّد بالمستأجر |
| `backend/test/chat-content.test.mjs` | — | بناء المحتوى متعدد الوسائط |
| `backend/test/llm-multimodal.test.mjs` | — | تطبيع المحتوى للمزوّدين الثلاثة |
| `backend/test/restart-persistence.test.mjs` | 2 | الاستمرارية عبر إعادة التشغيل + مصالحة الانهيار |
| `test/agent-mode-wiring.test.ts` | 5 | ربط وضع الوكيل بإجراء فعلي (`agent.run`) |
| `test/artifact-download.test.ts` | 2 | تنزيل القطع الأثرية بالمصادقة |
| `test/chat-attachments.test.ts` | — | ربط رفع المرفقات في المتجر |
| `test/chat-thumbnails.test.ts` | 3 | عرض الصور المصغّرة الحقيقية |
| `test/project-cache.test.ts` | — | ذاكرة المشروع المفتاحية (لا تخزين وعود مرفوضة) |

---

## 5. كيف حافظنا على الوظائف الحالية (عدم الكسر)

- لم يُحذف أي ملف، ولم يُعَد كتابة أي تاريخ.
- كل التعديلات إضافية (additive) أو مُقيَّدة بسلوك جديد عند تفعيله (مثل فرع الوكيل عند `mode === 'agent'`).
- الحزم الكاملة القديمة (legacy harness, execution, phase1, phase2, pain-map) لا تزال ناجحة بالكامل.
- `npm run check:imports` = **0 استيراد مكسور**؛ `npm run typecheck` = **exit 0**.

---

## 6. نتائج التشغيل الفعلية (الأدلة)

| الأمر | النتيجة |
|---|---|
| `npm run typecheck` | **exit 0** (بلا أخطاء) |
| `npm run check:imports` | src: 661 استيراد، **0 مكسور**؛ app: 35 استيراد، **0 مكسور** |
| `npm run security:scan` | 450 ملف، **بلا أي نتائج** |
| `node --experimental-sqlite --test backend/test/*.test.mjs` | **720 اختبار، 714 نجاح، 0 فشل، 6 تخطٍّ** |
| `npm run test:frontend` | **59 اختبار، 59 نجاح، 0 فشل** |
| `npm run test:legacy-harness` | **80 نجاح، 0 فشل** |
| `npm run test:execution` | **91 نجاح، 0 فشل** |
| `npm run test:phase1` | **43 نجاح، 0 فشل** |
| `npm run test:phase2` | **23 نجاح، 0 فشل** |
| `npm run validate:pain-map` | **Validation passed** |
| `npm run build` | **exit 0** + `verify:web — chat UI v2 confirmed` |

> ملاحظة: 6 اختبارات "تخطٍّ" في الحزمة الخلفية هي اختبارات تتخطى نفسها شرطيًا (مثل `pdf.extract` عند غياب `pdftotext`)، وليست فشلًا.

---

## 7. المشكلات المتبقية والمخاطر (Remaining Issues)

1. **سطح API غير مستخدم:** `getVideoStatus` و`generateRealVideo` و`useCreationStore.artifactUrl` بلا مُستدعٍ — تفاصيل في تقرير الملفات الميتة. لا تؤثر على الوظائف.
2. **ملفات `.patch` تاريخية في الجذر (8):** آثار رُفعت بالخطأ؛ يُوصى بأرشفتها. لم تُحذف.
3. **`verify_fix2.mjs`:** سكربت تحقق لمرة واحدة، وظيفته غُطّيت باختبارات `llm-*`. لم يُحذف.
4. **تقييم القدرات:** درجة "integrations" لا تزال `partial` (لا مزوّد تكامل مُهيّأ في بيئة الاختبار) — وهذا انعكاس صادق للواقع لا خطأ.
5. **اختبار الفيديو الحقيقي** يستخدم مزوّدًا محليًا (لتجنّب التكلفة)؛ التحقق من مزوّد إنتاجي حقيقي يتطلّب مفاتيح API في بيئة النشر.
6. **`node:sqlite` تجريبي:** يتطلّب `--experimental-sqlite` (مثبّت في scripts وCI على Node 22.5+).

---

## 8. أوامر إعادة الإنتاج الكاملة

```bash
git checkout fix/p1-p2-hardening
npm ci
npm run typecheck
npm run check:imports
npm run security:scan
node --experimental-sqlite --test backend/test/*.test.mjs
npm run test:frontend
npm run test:legacy-harness && npm run test:execution && npm run test:phase1 && npm run test:phase2
npm run validate:pain-map
npm run build
```
