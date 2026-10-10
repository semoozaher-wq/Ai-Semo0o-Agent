# دليل النشر — Ai-Semo0o-Agent (واجهة على Vercel + باك-إند على Render)

> **الخلاصة أولًا:** مشروعك فيه **جزئين مختلفين تمامًا**، وكل جزء له مكان النشر الصحيح:
>
> | الجزء | التقنية | مكان النشر الصحيح |
> |---|---|---|
> | **الواجهة (Frontend)** | Expo / React Native Web (تصدير ويب ثابت) | **Vercel** ✅ |
> | **الباك-إند (Backend)** | سيرفر Node طويل المدى + `node:sqlite` + Worker | **Render / Railway / Fly.io / VPS** ✅ (وليس Vercel ❌) |
>
> السبب إن Vercel بيشغّل الكود على شكل **Serverless Functions** (بتنتهي بعد ثوانٍ، وقرص للقراءة فقط، ومفيش عمليات خلفية). والباك-إند بتاعك محتاج العكس تمامًا. لما Vercel حاول يبني `backend/server.mjs` كـ Function، طلع الخطأ:
>
> ```
> [RESOLVE_ERROR] Could not resolve './auth/security.mjs'
> [RESOLVE_ERROR] Could not resolve './auth/lifecycle.mjs'
> [RESOLVE_ERROR] Could not resolve './queue/queue.mjs'
> [RESOLVE_ERROR] Could not resolve './runners/code-runner.mjs'
> ```
>
> **ملاحظة مهمة:** الملفات دي **موجودة فعلًا** ومساراتها سليمة 100%. الملفات موجودة في `backend/auth/` و `backend/queue/` و `backend/runners/`. الخطأ سببه إن Vercel **نسخ ملف `server.mjs` لوحده** كـ Function، فمش لاقى الملفات اللي جنبه.

---

## 1) إثبات إن المسارات سليمة (تشغيل سكربت التحقق)

من جذر المشروع:

```bash
node scripts/verify-imports.mjs backend
```

النتيجة المتوقعة:

```
Scanned 34 files under backend
Relative imports checked: 76
Broken relative imports: 0
All relative imports resolve to existing files. ✅
```

يعني: **صفر مسار مكسور** في الباك-إند. المشكلة مش في الـ import paths، المشكلة في مكان النشر.

---

## 2) نشر الواجهة على Vercel

### أ) الإعدادات داخل المشروع (اتضافت بالفعل)
- **`vercel.json`** — بيقول لـ Vercel: ابني الواجهة بس (`npm run build` → `dist/`) واعطّل كشف الـ framework التلقائي.
- **`.vercelignore`** — بيستثني `backend/` وكل الملفات غير الخاصة بالواجهة، فـ Vercel **مش هيلمس الباك-إند خالص** وبالتالي الخطأ هيختفي.

### ب) خطوات النشر
1. ارفع المشروع على GitHub.
2. في Vercel: **Add New → Project → Import** الريبو.
3. **مهم جدًا:** في إعدادات المشروع، خلي **Root Directory = `.` (جذر الريبو)** — **مش** `backend`.
4. Vercel هيقرأ `vercel.json` تلقائيًا:
   - Build Command: `npm run build`
   - Output Directory: `dist`
5. اضغط **Deploy**.

### ج) متغيّر بيئة (اختياري لكن مفضّل)
في **Vercel → Settings → Environment Variables** أضف:

```
EXPO_PUBLIC_BACKEND_URL = https://<اسم-الباك-إند-بتاعك>.onrender.com
```

ده عنوان الباك-إند اللي الواجهة هتكلّمه.

---

## 3) نشر الباك-إند على Render

### أ) الطريقة الأسهل — Blueprint (ملف `render.yaml` جاهز)
1. في Render: **New → Blueprint** واختار نفس الريبو.
2. Render هيقرأ `render.yaml` ويعمل:
   - خدمة Web اسمها `ai-semo0o-backend`
   - أمر التشغيل: `node --experimental-sqlite backend/server.mjs`
   - الخطة الافتراضية `free` (بدون قرص دائم). لو عايز قرص دائم 1GB على `/var/data`، غيّر `plan` لـ`starter` وشيل التعليق عن بلوك `disk` في `render.yaml`.
3. بعد الإنشاء، افتح **Environment** واضبط المتغيّرات السرّية (مش موجودة في الملف لأسباب أمنية):

| المتغيّر | القيمة |
|---|---|
| `SECRETS_MASTER_KEY` | سرّ 32 بايت على الأقل — تولّده بالأمر: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `ALLOWED_ORIGIN` | دومين الواجهة على Vercel، مثال: `https://your-app.vercel.app` |
| `PUBLIC_APP_URL` | نفس قيمة `ALLOWED_ORIGIN` |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | مفاتيح مزوّدي الذكاء الاصطناعي (اختياري) |

> **ملاحظة مهمة عن قاعدة البيانات:** `DATABASE_FILE` مضبوط على `/var/data/db/agent.sqlite` (جوّه مجلد فرعي `db`). ده مقصود: الكود بيفرض إن مجلد قاعدة البيانات يكون بصلاحيات `0700`، ولو حطيت الملف مباشرة في `/var/data` هيطلع خطأ `DATABASE_DIRECTORY_NOT_PRIVATE`.
>
> **على خطة Render المجانية (Free):** مفيش قرص دائم، فمسار `/var/data/db` **مش قابل للكتابة**. الكود دلوقتي بيتحقق من قابلية الكتابة **قبل** ما ينشئ المجلد، ولو مش قابل للكتابة بيرجع تلقائيًّا لمسار آمن وقابل للكتابة (`./backend/data/agent.sqlite` وبعده مجلد النظام المؤقت) مع تسجيل تحذير — يعني السيرفر بيقلع بدون خطأ `EACCES`. ملاحظة: على الخطة المجانية قاعدة البيانات مؤقتة (بتتصفّر مع كل نشر). لو عايز تحتفظ بالبيانات، استخدم خطة مدفوعة + القرص الدائم (شيل التعليق عن بلوك `disk` في `render.yaml` وغيّر `plan` لـ`starter`).

### ب) الطريقة البديلة — Docker (لأي مكان: Fly.io / Railway / Cloud Run / VPS)
الملف `backend/Dockerfile` جاهز. من جذر المشروع:

```bash
docker build -f backend/Dockerfile -t ai-semo0o-backend .
docker run -p 8787:8787 \
  -e SECRETS_MASTER_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")" \
  -e ALLOWED_ORIGIN="https://your-app.vercel.app" \
  -v ai_semo0o_data:/data \
  ai-semo0o-backend
```

### ج) الطريقة اليدوية (VPS)
```bash
# على السيرفر (Node 22.11+)
git clone <repo> && cd Ai-Semo0o-Agent-master
cp backend/.env.example backend/.env   # ثم عدّل القيم
node --experimental-sqlite backend/server.mjs
```

---

## 4) التحقق من عمل الباك-إند

```bash
curl https://<backend-url>/health
# => {"ok":true,"service":"ai-semo0o-agent-backend","version":"2.0.0",...}

curl https://<backend-url>/ready
# => يوضّح حالة قاعدة البيانات والـ workspace ومزوّدي الـ LLM
```

---

## 5) المتغيّرات البيئية — مرجع سريع

| المتغيّر | إلزامي في الإنتاج؟ | الوصف |
|---|---|---|
| `SECRETS_MASTER_KEY` | ✅ | سرّ 32 بايت+ لتشفير الأسرار |
| `DATABASE_FILE` | ✅ | مسار مطلق لملف SQLite (جوّه مجلد فرعي خاص) |
| `WORKSPACE_ROOT` | ✅ | مسار مطلق لمجلد العمل |
| `ALLOWED_ORIGIN` | ✅ (تحذير لو ناقص) | أصل الواجهة بالضبط، ممنوع `*` |
| `BIND_HOST` | ⬜ | `0.0.0.0` على السيرفرات |
| `PORT` | ⬜ | الافتراضي `8787` |
| `DISABLE_WORKER` | ⬜ | `1` لو الاستضافة تمنع العمليات الخلفية |
| `NODE_ENV` | ⬜ | `production` |
| `OPENAI_API_KEY` وغيرها | ⬜ | مزوّدو الـ LLM |

---

## 6) أسئلة شائعة

**س: ليه ما أقدرش أشغّل الباك-إند على Vercel أصلًا؟**
ج: لأن Vercel Serverless:
- الدالة بتقف بعد 10–60 ثانية، والباك-إند سيرفر مستمر.
- القرص للقراءة فقط (ماعدا `/tmp` المؤقت)، وقاعدة `node:sqlite` محتاجة قرص دائم.
- مفيش عمليات خلفية (الـ Worker/Queue).
- `node:sqlite` تجريبي ومحتاج فلاج `--experimental-sqlite` مش مضمون على Vercel.

**س: هل أعدّل مسارات الـ import؟**
ج: لا. المسارات سليمة (0 مكسور). التعديل الوحيد المطلوب كان سطر استيراد ناقص في `server.mjs` (`access` و `fsConstants`) وده **تم إصلاحه بالفعل**.

**س: عايز كل حاجة على Vercel؟**
ج: ممكن نظريًا بتحويل الباك-إند لدوال Serverless، لكن ده يتطلّب تغيير قاعدة البيانات (مثل Turso/libSQL) وإلغاء الـ Worker — تغيير كبير ومش مستقر. الأفضل فصل النشر زي ما هو موضّح فوق.
