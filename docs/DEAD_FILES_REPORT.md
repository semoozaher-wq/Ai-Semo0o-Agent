# تقرير الملفات الميتة وغير المستخدمة — Dead / Unused Files Report

**المستودع:** Ai-Semo0o-Agent
**الفرع:** `fix/p1-p2-hardening` (أساس: `master @ ae2c2a3`)
**التاريخ:** يُحدَّد وقت التشغيل
**القاعدة المتبعة:** لم يُحذف أي ملف. هذا التقرير وصفي فقط، مع الأدلة والتوصيات.
**أداة الفحص:** `scripts/dead-file-report.mjs` (مُكتشِف جديد أُضيف في هذا الفرع، قائم على عدّ المراجع الواردة للاسم الأساسي للملف).

---

## 1. المنهجية (Methodology)

1. **فحص آلي للمراجع الواردة:** مشى السكربت `scripts/dead-file-report.mjs` على المجلدات `backend/`, `src/`, `scripts/`, `app/` وعدّ عدد الملفات التي تشير إلى الاسم الأساسي (basename) لكل وحدة. النتيجة: **384 وحدة مفحوصة، 11 بلا مراجع واردة.**
2. **تحقّق يدوي مضاد (cross-check):** فُحص كل مرشّح بـ `grep -rIl` على كامل المستودع (باستثناء `node_modules` و`.git` والملف نفسه)، ثم صُنّف حسب مصدر المرجع:
   - مرجع **تنفيذي** (package.json script / CI / استيراد فعلي) ⇒ الملف **حيّ**.
   - مرجع **توثيقي فقط** (ملف `.md` أو قائمة manifest ثابتة) ⇒ الملف **ميت وظيفيًا** (لا يُنفَّذ).
   - **صفر مراجع** ⇒ مرشّح قوي للموت.
3. **فحص سطح الـ API غير المستخدم:** فُحصت دوال العميل `src/services/api/client.ts` ودوال المتجر `src/store/*.ts` بحثًا عن تعريفات بلا أي مُستدعٍ.
4. **فحص ملفات الجذر الشاردة:** `.patch`، `.log`، تقارير JSON/PNG، سكربتات تحقق لمرة واحدة.

> ملاحظة: `node_modules`، `dist/` (مخرجات البناء)، وملفات الاختبار (`test/`, `backend/test/`) مستثناة من عدّ "الموت" لأنها ليست وحدات إنتاج.

---

## 2. الملخّص التنفيذي (Executive Summary)

| الفئة | العدد | الخطورة | الإجراء الموصى به |
|---|---|---|---|
| أ. وحدات مصدرية بلا أي مرجع تنفيذي | 2 | منخفضة | حذف اختياري في PR منفصل |
| ب. سطح API/متجر غير مستخدم (داخل ملفات حيّة) | 3 | منخفضة | إزالة اختيارية أو توثيق كنقطة توسّع |
| ج. ملفات `.patch` تاريخية في الجذر | 8 | منخفضة | نقل إلى `docs/archive/` أو حذف |
| د. سكربت تحقق لمرة واحدة | 1 | منخفضة | نقل إلى `docs/archive/` أو حذف |
| هـ. مخرجات مُولَّدة (تقارير/لقطات) | 3 | منخفضة | تُولَّد آليًا؛ لا تُحذف يدويًا |
| و. مرشّحون كاذبون (مُشار إليهم فعليًا) | 8 | — | **إبقاء** |

---

## 3. الفئة (أ): وحدات مصدرية بلا أي مرجع تنفيذي

### 3.1 `scripts/serve-dist.js` — 79 سطرًا
- **الوصف:** خادم ملفات ثابتة بسيط لمجلد `dist/` (SPA fallback، يقرأ `PORT` من البيئة، CommonJS).
- **الدليل:** عدد المراجع التنفيذية = **0**.
  - لا يوجد في `package.json` أي script يشير إليه.
  - لا يوجد في `.github/workflows/ci.yml` أو `quality.yml`.
  - لا يوجد أي `import`/`require` له من أي ملف مصدري.
  - المراجع الوحيدة موجودة في قوائم ثابتة فقط: `SEMO0O_PACKAGE_MANIFEST.txt:150` ونسخته في `docs/archive/`.
- **البديل الحيّ:** خدمة الملفات الثابتة تتم عبر `vercel.json` (outputDirectory=`dist`) و`expo export --platform web`، فلا حاجة لهذا السكربت في مسار النشر.
- **التوصية:** غير مُستخدَم. حذفه آمن، أو نقله إلى `docs/archive/` إن أُريد الاحتفاظ به كأداة تطوير محلية.

### 3.2 `scripts/workspace-backend.mjs` — 238 سطرًا
- **الوصف:** أداة Node مستقلة لاستيراد GitHub / ضغط / فكّ ضغط باستخدام `jszip`، تُستدعى يدويًا من سطر الأوامر فقط.
- **الدليل:** عدد المراجع التنفيذية = **0**.
  - لا يوجد في `package.json` أي script يشير إليه.
  - لا يوجد في أي workflow.
  - لا يوجد أي `import` له.
  - المراجع الوحيدة: `SEMO0O_PACKAGE_MANIFEST.txt:152` ونسخته المؤرشفة.
- **التوصية:** غير مُستخدَم. نفس التوصية أعلاه.

> **ملاحظة عن `scripts/dead-file-report.mjs`:** يظهر أيضًا بصفر مراجع، لكنه **أداة تطوير أُضيفت في هذا الفرع** وتُشغَّل يدويًا (`node scripts/dead-file-report.mjs`)، فغياب المراجع مقصود وليس موتًا. **يُبقى.**

---

## 4. الفئة (ب): سطح API/متجر غير مستخدم (داخل ملفات حيّة)

هذه الملفات نفسها حيّة، لكنها تحتوي تعريفات لا يستدعيها أي كود.

| الرمز | الموقع | الدليل | التوصية |
|---|---|---|---|
| `backendApi.getVideoStatus()` | `src/services/api/client.ts:558` | التعريف الوحيد في العميل؛ **0 مُستدعٍ** في `src/` أو `app/` أو `test/` | إزالة أو ربطه بواجهة حالة الفيديو |
| `backendApi.generateRealVideo()` | `src/services/api/client.ts:559` | التعريف الوحيد؛ **0 مُستدعٍ** | إزالة أو ربطه بزر توليد الفيديو الحقيقي |
| `useCreationStore.artifactUrl()` | `src/store/useCreationStore.ts:140` | كان يُستدعى من `Creation.tsx`، وقد أُزيل بعد إصلاح التنزيل (الرابط لم يعد يُفتح مباشرة)؛ الآن **0 مُستدعٍ** | إزالة (أصبح بلا مُستدعٍ بعد إصلاح P1) |

**تفصيل مهم:** `backendApi.creationArtifactUrl()` **ليس ميتًا** — فهو لا يزال يُستدعى داخليًا من `fetchCreationArtifact` (سطر 544). فقط الطبقة الأعلى `useCreationStore.artifactUrl` أصبحت بلا مُستدعٍ.

---

## 5. الفئة (ج): ملفات `.patch` تاريخية في جذر المستودع

ثمانية ملفات patch تاريخية، **لا يشير إليها أي سكربت أو CI أو استيراد** (فُحص بـ grep على `*.mjs/*.js/*.sh/*.json/*.yml`). هي آثار لعمليات إصلاح سابقة رُفعت للجذر بالخطأ:

| الملف | الأسطر | ملاحظة |
|---|---|---|
| `Ai-Semo0o-Agent-EACCES-FIX.patch` | 578 | git-format patch تاريخي |
| `ci-flaky-fix.patch` | 112 | diff |
| `fix-all-errors.patch` | 951 | diff |
| `model-router.patch` | 945 | diff |
| `quality-browser-e2e-fix.patch` | 32 | git-format patch |
| `security-scan-fix.patch` | 39 | git-format patch |
| `semo-ci-fix.patch` | 1214 | diff |
| `semo0o-gap-fixes.patch` | 8032 | git-format patch |

- **الدليل:** لا مراجع تنفيذية (المطابقات الوحيدة لكلمة `.patch` كانت لأداة `files.patch` غير ذات صلة).
- **التوصية:** نقل إلى `docs/archive/` أو حذف في PR منفصل بعد التأكد من دمجها في الكود الحالي. **لم يُحذف أي منها.**

---

## 6. الفئة (د): سكربت تحقق لمرة واحدة

### `verify_fix2.mjs` — 71 سطرًا (جذر المستودع)
- **الوصف:** تحقّق موجّه لنتيجة تدقيق G1 (Fix 2): يثبت أن فشل المزوّد المباشر يعلّم المزوّد كـ"غير سليم". يبدأ خادم HTTP وهميًا ويستدعي `createLLMRouter`.
- **الدليل:** لا مراجع تنفيذية. المراجع الوحيدة في `README_FIXES.md` و`docs/archive/README_FIXES.md` (توثيق)، والوثيقة نفسها تصفه بأنه **مُرفوع بالخطأ** إلى الجذر في commit `6af98ea`.
- **التوصية:** نقله إلى `docs/archive/` أو حذفه؛ وظيفته غُطّيت باختبارات `backend/test/llm-*.test.mjs`. **لم يُحذف.**

---

## 7. الفئة (هـ): مخرجات مُولَّدة آليًا (لا تُحذف يدويًا)

هذه ليست "ميتة" بل **نواتج تشغيل** تُعيد السكربتات توليدها؛ بعضها مُدرَج في استثناءات الفحص الأمني:

| الملف | المُولِّد | ملاحظة |
|---|---|---|
| `agent-benchmark.report.json` | `scripts/agent-benchmark.mjs` (`--out`) | مخرج benchmark |
| `browser-e2e.report.json` | `scripts/browser-e2e.mjs` (`--out`) | مخرج E2E |
| `browser-e2e.screenshot.png` | `scripts/browser-e2e.mjs` (`--screenshot`) | لقطة E2E |

- **التوصية:** إبقاؤها (أو إضافتها إلى `.gitignore`). ليست مرشّحة للحذف.

---

## 8. الفئة (و): مرشّحون كاذبون — مُشار إليهم فعليًا (تُبقى)

هذه ظهرت في الفحص الآلي (بصفر مراجع *للاسم الأساسي*) لكن التحقق اليدوي أثبت أنها **مُشار إليها فعليًا**:

| الملف | مصدر المرجع الحقيقي |
|---|---|
| `scripts/agent-runtime.mjs` | `docs/PHASE1_EXECUTION_RUNTIME.md` (نقطة دخول CLI موثّقة) |
| `scripts/browser-smoke.mjs` | `package.json` → `test:browser-smoke` + CI `quality.yml` |
| `scripts/generate-317-pain-map.js` | `package.json` → `generate:anatomy` |
| `scripts/generate-anatomy-template.js` | `scripts/README.md` |
| `scripts/phase2-task-demo.mjs` | `MANIFEST.md` (عرض توضيحي) |
| `scripts/production-trial.mjs` | `package.json` → `trial:self-improve` + CI |
| `scripts/validate-pain-map.js` | `package.json` → `validate:pain-map` |
| `scripts/verify-imports.mjs` | `package.json` → `check:imports` + CI |

**الخلاصة:** هذه ليست ملفات ميتة. سبب ظهورها أن الفحص الآلي عدّ المراجع النصّية فقط، بينما الاستدعاء يتم عبر أسماء scripts في `package.json` أو مسارات CLI موثّقة.

---

## 9. إجمالي النتائج والحدود (Limitations)

- **مؤكَّد بدرجة عالية (مرشّح للحذف):** `scripts/serve-dist.js`, `scripts/workspace-backend.mjs` (بلا أي مرجع تنفيذي).
- **مؤكَّد (سطح API ميت):** `getVideoStatus`, `generateRealVideo`, `useCreationStore.artifactUrl`.
- **مؤكَّد (آثار تاريخية):** 8 ملفات `.patch` + `verify_fix2.mjs`.
- **حدود الأداة:** الفحص قائم على مطابقة الاسم الأساسي نصًّا؛ لذا قد يُغفل الاستدعاء الديناميكي (`import()` بمسار متغيّر) أو الاستدعاء عبر alias في `package.json`. لذلك اعتُمد التحقق اليدوي المضاد لكل مرشّح.
- **لم يُحذف أي ملف** التزامًا بالقاعدة. جميع ما ورد أعلاه توصيات فقط.

---

## 10. أوامر إعادة إنتاج الأدلة (Reproduction)

```bash
# 1) الفحص الآلي
node scripts/dead-file-report.mjs

# 2) تحقق مضاد لأي مرشّح (مثال)
grep -rIl --exclude-dir=node_modules --exclude-dir=.git --exclude=serve-dist.js "serve-dist.js" .

# 3) سطح API غير مستخدم
grep -rIn --exclude-dir=node_modules --exclude-dir=.git "getVideoStatus\|generateRealVideo" src app test

# 4) ملفات .patch بلا مرجع تنفيذي
grep -rIn --include="*.mjs" --include="*.js" --include="*.sh" --include="*.json" --include="*.yml" "\.patch" . | grep -v files.patch
```
