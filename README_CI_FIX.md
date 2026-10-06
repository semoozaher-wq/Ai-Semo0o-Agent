# إصلاح فشل GitHub Actions (Quality) — Semo AI

## ملخّص المشكلة (Root cause)

الـ workflow `Quality` كان يفشل عند خطوة **`Secret and SAST scan`** (exit code 1)، وكان سيفشل
أيضاً لاحقاً عند خطوات أخرى. السبب ليس خطأً في منطق المشروع، بل **رفع الملفات عبر واجهة
GitHub (Add files via upload) وضَع ملفين في المسار الخطأ** (أسقط بادئة `backend/`)، ولم يرفع
ملفين آخرين، وترك ملفين قديمين (stale):

| الملف على الفرع `master` | الحالة | الأثر على CI |
|---|---|---|
| `scripts/security-scan.mjs` | نسخة قديمة | يفشل عند `security:scan` (إيجابية كاذبة على `eval(`) |
| `backend/server.mjs` | **قديم** (بدون مسارات self-improve/metrics/org/ops) | يفشل 8 اختبارات backend (404) |
| `backend/tools/registry.mjs` | **قديم** | يفشل اختبارات حالة الأدوات |
| `server.mjs` (في الجذر) | **مسار خطأ** — يجب أن يكون `backend/server.mjs` | ملف زائد/مكرّر |
| `tools/registry.mjs` (في الجذر) | **مسار خطأ** — يجب أن يكون `backend/tools/registry.mjs` | ملف زائد/مكرّر |
| `package.json` | **قديم** (بدون سكربت `smoke:backend`) | يفشل عند `npm run smoke:backend` |
| `scripts/boot-smoke.sh` | **مفقود** | يفشل عند خطوة الـ boot-smoke |

### السبب المباشر لفشل الـ 51 ثانية
خطوة `security:scan` تُشغّل `scripts/security-scan.mjs` الذي يفحص كل ملفات git المتتبَّعة.
القاعدة `/\beval\s*\(/` التقطت **نصاً حرفياً** `'eval('` داخل `backend/self-improve/policy.mjs`
(قائمة `FORBIDDEN_PATCH_TOKENS` — أي أن الملف *يمنع* eval، وليس يستدعيه). هذه إيجابية كاذبة.
(ظهرت الآن فقط لأن الملف أصبح متتبَّعاً في git بعد إصلاح `.gitignore`؛ السكربت يستخدم `git ls-files`.)

---

## ما تم إصلاحه في هذه الحزمة

1. **`scripts/security-scan.mjs`** — أُعيد كتابته:
   - دعم تعليقات الاستثناء الصريحة: `security-scan:allow` / `security-scan:allow <rule>` / `security-scan:allow-file`.
   - تحسين قاعدة `eval`: تتجاهل `eval(` إذا سبقه علامة اقتباس (بيانات نصية)، وتبقى تلتقط الاستدعاء الحقيقي `eval(`.
   - تجاهل الملفات المفقودة بأمان بدل الانهيار (ENOENT).
2. **`backend/self-improve/policy.mjs`** — أُضيف تعليق استثناء صريح للسطر المعني.
3. **`backend/server.mjs`** — النسخة الصحيحة (تشمل مسارات metrics / self-improve / notifications / org / ops).
4. **`backend/tools/registry.mjs`** — النسخة الصحيحة (حالة كل أداة: live/partial/unwired/failed).
5. **`package.json`** — أُضيف سكربت `"smoke:backend": "bash scripts/boot-smoke.sh"`.
6. **`scripts/boot-smoke.sh`** — ملف جديد (اختبار E2E: health → ready → register → tools/status).
7. حذف الملفين المكرّرين في الجذر: `server.mjs` و `tools/registry.mjs`.

---

## طريقة التطبيق

### الخيار (أ) — عبر git (موصى به)
```bash
git clone https://github.com/semoozaher-wq/Ai-Semo0o-Agent.git
cd Ai-Semo0o-Agent
git checkout master

# طبّق الرقعة
git apply semo-ci-fix.patch

# إن لم تُطبَّق الرقعة لسببٍ ما، انسخ الملفات يدوياً من مجلدات هذه الحزمة (نفس المسارات)

git add -A
git commit -m "Fix CI: harden security-scan, wire self-improve server, add boot-smoke, remove stray root files"
git push origin master
```

### الخيار (ب) — عبر واجهة GitHub (Web UI)
1. **عدّل** هذه الملفات (افتح الملف → أيقونة القلم → الصق المحتوى من الحزمة → Commit):
   - `backend/server.mjs`
   - `backend/tools/registry.mjs`
   - `package.json`
   - `scripts/security-scan.mjs`
   - `backend/self-improve/policy.mjs`
2. **أنشئ** ملفاً جديداً بالمحتوى الموجود في الحزمة:
   - `scripts/boot-smoke.sh`  ← (المسار الكامل: `scripts/boot-smoke.sh`)
3. **احذف** الملفين المكرّرين في الجذر:
   - `server.mjs`
   - `tools/registry.mjs`

> ⚠️ مهم: تأكّد من كتابة المسار الكامل بادئته `backend/` عند التعديل، لأن هذا هو سبب المشكلة الأصلي.

---

## التحقّق (تم محلياً بالكامل)
شُغّلت كل خطوات الـ workflow على الحالة المصحّحة، وكلها نجحت:
`npm ci` ✅ · `security:scan` ✅ · `verify-imports backend` ✅ · `typecheck` ✅ · `lint` ✅ ·
`npm test` (90/90 backend + بقية الحزم) ✅ · `expo doctor` (21/21) ✅ · `build` ✅ ·
`browser-smoke` ✅ · `smoke:backend` ✅ (BOOT SMOKE OK).
