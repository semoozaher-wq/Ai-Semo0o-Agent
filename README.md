# Semo0o AI — منصّة الذكاء الاصطناعي المتكاملة

> **منصّة عربية أولًا (RTL) لبناء وتشغيل وكلاء الذكاء الاصطناعي المستقلّين** — متجر تطبيقات على طراز Google Play، محرّك وكلاء ذاتي يشبه Manus AI، محادثة متقدّمة متعددة النماذج، ومحرّك تحليل بيانات وفحص ملفات (نظام الـ 153 ملفًا). مبنيّة بـ **Expo + React Native + TypeScript** وتعمل على الويب و iOS و Android من نفس الشيفرة.

[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Expo](https://img.shields.io/badge/Expo-57-000020?logo=expo&logoColor=white)](https://expo.dev/)
[![React Native](https://img.shields.io/badge/React%20Native-0.86-61DAFB?logo=react&logoColor=black)](https://reactnative.dev/)
[![React](https://img.shields.io/badge/React-19.2-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## نظرة عامة

**Semo0o AI** هو إعادة بناء كاملة لمشروع `Ai-Semo0o-Agent` ليصبح منصّة ذكاء اصطناعي إنتاجية تنافس **Super MyNinja AI** و **Manus AI**. يجمع المشروع بين:

| القدرة | الوصف |
| --- | --- |
| 🤖 **محرّك الوكلاء المستقلّ** | خطّ إنتاج كامل: تخطيط ← تنفيذ ← أدوات ← ذاكرة ← تأمّل ← إصلاح ذاتي |
| 🛍️ **متجر الوكلاء** | تصفّح، تثبيت، منح صلاحيات، تحديث، وإلغاء تثبيت الوكلاء والملحقات |
| 💬 **محادثة متقدّمة** | منتقي نماذج، أدوات، مرفقات، بثّ مباشر (streaming)، وتاريخ محادثات |
| 🧠 **تحليل الكود والإصلاح الذاتي** | محلّل ثابت + كاشف أخطاء + مصحّح تلقائي (self-healing) |
| 📊 **محرّك البيانات** | فاحص ملفات، تدقيق 153 ملفًا، توصيف مجموعات البيانات، كشف الشذوذ |
| 🩺 **BodyMap Pain** | وكيل مدمج تفاعلي لخريطة الجسم التشريحية (317 جزءًا / 23 مجموعة عضلية) |
| 📈 **التحليلات** | استخدام، رموز (tokens)، مهام، رسوم بيانية SVG خفيفة |
| ⚙️ **الإعدادات** | مزوّدو النماذج، مفاتيح API، الثيم، اللغة، الخصوصية |

---

## البنية المعمارية

```
Ai-Semo0o-Agent/
├── app/                          # التوجيه (Expo Router — file-based routing)
│   ├── _layout.tsx               # التخطيط الجذري + المزوّدات + RTL + الثيم
│   ├── (tabs)/
│   │   ├── _layout.tsx           # شريط التبويبات السفلي
│   │   ├── index.tsx             # لوحة التحكم (Dashboard)
│   │   ├── store.tsx             # المتجر (Store)
│   │   ├── chat.tsx              # المحادثة (Chat)
│   │   ├── agents.tsx            # الوكلاء (Agents)
│   │   └── files.tsx             # الملفات (Files)
│   ├── agent/[id].tsx            # تفاصيل الوكيل (ديناميكي)
│   ├── anatomy.tsx               # BodyMap Pain (وكيل مدمج)
│   ├── analytics.tsx             # التحليلات
│   ├── settings.tsx              # الإعدادات
│   └── +not-found.tsx            # صفحة 404
│
├── src/
│   ├── types/                    # أنواع النطاق (Domain types)
│   │   ├── agent.ts  chat.ts  file.ts  model.ts  task.ts  tool.ts
│   │   ├── anatomy.ts            # أنواع خريطة الجسم التشريحية
│   │   └── common.ts  index.ts
│   │
│   ├── theme/                    # نظام التصميم (Design tokens)
│   │   ├── tokens.ts             # الألوان، المسافات، نصف القطر، الظلال
│   │   ├── theme.ts              # الثيم الفاتح + الداكن + التدرّجات
│   │   └── ThemeProvider.tsx     # مزوّد الثيم + الخطوط + RTL
│   │
│   ├── data/                     # كتالوجات البيانات الثابتة
│   │   ├── agents.ts             # 18 وكيلًا + 12 تصنيفًا + تقييمات
│   │   ├── tools.ts              # 16 أداة (ويب، كود، بيانات، وسائط…)
│   │   ├── models.ts             # 15 نموذجًا عبر 6 مزوّدين
│   │   ├── permissions.ts        # 11 صلاحية
│   │   ├── taskTemplates.ts      # 8 قوالب مهام جاهزة
│   │   └── quickActions.ts       # إجراءات سريعة
│   │
│   ├── services/                 # طبقة الخدمات (Business logic)
│   │   ├── ai/                   # تجريد مزوّدي النماذج + البثّ + التضمينات
│   │   │   ├── runtime.ts        # LLMProvider + محرّك محاكاة واعٍ بالنيّة
│   │   │   └── index.ts          # سجلّ المزوّدين + getProvider()
│   │   ├── agent-engine/         # محرّك الوكلاء المستقلّ
│   │   │   ├── planner.ts        # تحليل المهمة → خطة خطوات
│   │   │   ├── executor.ts       # تنفيذ الخطوات + إعادة المحاولة
│   │   │   ├── tools.ts          # سجلّ الأدوات + التنفيذ المعزول
│   │   │   ├── memory.ts         # الذاكرة قصيرة/طويلة المدى
│   │   │   └── index.ts
│   │   ├── code-analysis/        # المحلّل الثابت + الإصلاح الذاتي
│   │   │   ├── analyzer.ts       # 14 قاعدة فحص
│   │   │   └── index.ts
│   │   ├── data-engine/          # محرّك البيانات
│   │   │   ├── scanner.ts        # فاحص الملفات
│   │   │   ├── audit.ts          # تدقيق 153 ملفًا
│   │   │   ├── profiler.ts       # توصيف مجموعات البيانات + كشف الشذوذ
│   │   │   └── index.ts
│   │   ├── store/                # خدمة المتجر (تثبيت/صلاحيات/تحديث)
│   │   ├── anatomy/              # خدمة خريطة الجسم (317 جزءًا)
│   │   ├── storage/              # طبقة الاستمرارية (KVStore)
│   │   └── index.ts
│   │
│   ├── store/                    # إدارة الحالة (Zustand)
│   │   ├── useAppStore.ts  useChatStore.ts  useAgentsStore.ts
│   │   ├── useStoreStore.ts  useFilesStore.ts  useAnalyticsStore.ts
│   │   └── persist.ts            # تجريد KVStore (localStorage / ذاكرة)
│   │
│   ├── components/               # مكتبة المكوّنات
│   │   ├── ui/                   # العناصر الأولية (14 مكوّنًا)
│   │   ├── composite/            # المكوّنات المركّبة (8 مكوّنات)
│   │   ├── charts/               # رسوم SVG خفيفة (Sparkline/Bar/Donut/Ring)
│   │   └── anatomy/              # خريطة الجسم التفاعلية (BodyMap)
│   │
│   ├── screens/                  # شاشات التطبيق (9 شاشات)
│   ├── hooks/                    # خطّافات مخصّصة (useBootstrap)
│   └── utils/                    # أدوات مساعدة (id, format, text, async…)
│
├── data/
│   ├── anatomyPainMap.json       # 317 جزءًا + 23 مجموعة عضلية
│   └── painMap.json              # قاعدة البيانات الأصلية
│
├── scripts/                      # أدوات البناء والتوليد
│   ├── generate-317-pain-map.js  # توليد خريطة التشريح
│   ├── validate-pain-map.js      # التحقق من صحة البيانات
│   └── serve-dist.js             # خادم معاينة ثابت (SPA fallback)
│
├── legacy/                       # النسخة الأصلية (BodyMap Pain) — للرجوع
├── app.json  tsconfig.json  babel.config.js  metro.config.js  eslint.config.js
└── package.json
```

**المسار الحالي (`@/*` → `./src/*`)** يُتيح استيرادات نظيفة مثل `import { anatomyService } from '@/services/anatomy'`.

---

## المزايا الأساسية

### 1) محرّك الوكلاء المستقلّ (Autonomous Agent Engine)

يشبه Manus AI في تنفيذه الكامل للمهام المعقّدة دون تدخّل بشري:

```
المهمة (Task)
   │
   ▼
[Planner]  ──►  تحليل النية، تفكيك المهمة إلى خطوات مرتّبة مع الاعتماديات
   │
   ▼
[Executor] ──►  تنفيذ كل خطوة عبر سجلّ الأدوات، مع إعادة المحاولة عند الفشل
   │
   ▼
[Tools]    ──►  web.search · web.scrape · code.run · data.profile · file.read …
   │
   ▼
[Memory]   ──►  ذاكرة قصيرة المدى (سياق الجلسة) + طويلة المدى (المعرفة)
   │
   ▼
[Reflection] ─►  تقييم النتيجة، كشف الفشل، وإعادة التخطيط عند الحاجة
   │
   ▼
[Self-healing] ─►  إصلاح ذاتي للأخطاء قبل التسليم
```

### 2) متجر الوكلاء (Google-Play Style Store)

تجربة كاملة مستوحاة من Google Play:

- **تصفّح** حسب 12 تصنيفًا (إنتاجية، تطوير، بيانات، إبداع، بحث، صحة، مالية، تعليم، أتمتة، تواصل…).
- **صفحة تفاصيل** لكل وكيل: لقطات شاشة، وصف، تقييمات ومراجعات، الإصدار، السعر.
- **تثبيت** مع **منح صلاحيات** صريح (11 صلاحية: الشبكة، الملفات، الكود، الكاميرا، الموقع…).
- **تحديث** الوكلاء المثبّتين مع سجلّ الإصدارات.
- **إلغاء التثبيت** وإدارة التخزين.

### 3) المحادثة المتقدّمة (Advanced Chat)

- منتقي **15 نموذجًا** عبر **6 مزوّدين** (OpenAI، Anthropic، Google، Mistral، Meta، محلي).
- **بثّ مباشر** للردود (streaming) مع مؤشّر كتابة.
- **أدوات مضمّنة** قابلة للاستدعاء داخل المحادثة.
- **مرفقات** ورفع ملفات، وتاريخ محادثات منظّم.

### 4) تحليل الكود والإصلاح الذاتي (Self-Healing Code)

محلّل ثابت بـ **14 قاعدة** يكشف ويصلح:

`no-console` · `loose-equality` · `no-var` · `explicit-any` · `todo-comment` · `hardcoded-secret` · `empty-catch` · `long-line` · `debugger` · `eval-usage` · `inner-html` · `ts-ignore` · `floating-promise` · `missing-key`

كل مشكلة تُصنّف حسب الخطورة (حرجة/عالية/متوسطة/منخفضة) مع **إصلاح تلقائي** مقترح.

### 5) محرّك البيانات ونظام الـ 153 ملفًا (Data Engine)

- **فاحص ملفات** يحلّل البنية، الحجم، النوع، والاعتماديات.
- **تدقيق 153 ملفًا** يكشف الملفات المكرّرة، غير المستخدمة، والمشكِلة.
- **توصيف مجموعات البيانات** (عدد الصفوف/الأعمدة، الأنواع، القيم المفقودة).
- **كشف الشذوذ** الإحصائي (القيم المتطرّفة، الانحرافات).

### 6) BodyMap Pain — وكيل مدمج (Built-in Agent)

النسخة الأصلية محفوظة كـ **وكيل مدمج** داخل المتجر (تصنيف "الصحة"):

- خريطة جسم **SVG تفاعلية** (أمامي/خلفي، ذكر/أنثى).
- **317 جزءًا عضليًا** موزّعة على **23 مجموعة** و5 مناطق تشريحية.
- مسار كامل: ترحيب ← خريطة ← تفاصيل ← نتائج ← سجل.
- تسجيل شدة الألم (0–10)، نوعه، ومدّته، مع الأسباب الشائعة والتحذيرات والتوصيات.

---

## التقنيات المستخدمة

| التقنية | الإصدار | الاستخدام |
| --- | --- | --- |
| **Expo** | 57.0.26 | منصّة البناء والتشغيل |
| **React Native** | 0.86.3 | واجهة أصلية متعدّدة المنصّات |
| **React** | 19.2.3 | مكتبة الواجهة |
| **TypeScript** | 6.0.3 | أمان الأنواع (strict) |
| **Expo Router** | 57.0.24 | توجيه قائم على الملفات |
| **Zustand** | 5.0.15 | إدارة الحالة |
| **react-native-svg** | 15.15.4 | الرسوم البيانية والخريطة التشريحية |
| **@expo/vector-icons** | 15.0.2 | الأيقونات (Ionicons) |
| **react-native-web** | 0.21.2 | تشغيل الويب |

---

## البدء السريع

### المتطلّبات

- Node.js 20+
- npm 10+

### التثبيت

```bash
git clone https://github.com/semoozher-wq/Ai-Semo0o-Agent.git
cd Ai-Semo0o-Agent
npm install
```

### التشغيل

```bash
npm start          # Expo Dev Server
npm run web        # تشغيل الويب
npm run android    # أندرويد
npm run ios        # iOS
```

### فحوصات الجودة

```bash
npm run typecheck  # tsc --noEmit  → 0 أخطاء
npm run lint       # ESLint        → 0 أخطاء / 0 تحذيرات
npm run doctor     # expo-doctor   → 21/21 فحصًا ناجحًا
```

### بناء الويب (معاينة ثابتة)

```bash
npm run export:web                 # expo export --platform web → dist/
node scripts/serve-dist.js         # خادم معاينة محلي (SPA fallback)
```

### توليد بيانات التشريح

```bash
npm run generate:anatomy           # توليد data/anatomyPainMap.json
npm run validate:pain-map          # التحقق من صحة البيانات
```

---

## حالة الجودة (Quality Status)

| الفحص | النتيجة |
| --- | --- |
| `tsc --noEmit` | ✅ **0 أخطاء** |
| ESLint | ✅ **0 أخطاء / 0 تحذيرات** |
| `expo-doctor` | ✅ **21/21 فحصًا ناجحًا** |
| Web export | ✅ **16 مسارًا ثابتًا** |
| حجم الشيفرة | ~**12,450** سطرًا من TypeScript/TSX |

---

## المسارات المتاحة (Routes)

| المسار | الوصف |
| --- | --- |
| `/` | لوحة التحكم |
| `/store` | متجر الوكلاء |
| `/chat` | المحادثة المتقدّمة |
| `/agents` | الوكلاء + منشئ المهام |
| `/files` | مدير الملفات + محلّل 153 ملفًا |
| `/agent/[id]` | تفاصيل وكيل |
| `/anatomy` | BodyMap Pain (وكيل مدمج) |
| `/analytics` | التحليلات |
| `/settings` | الإعدادات |

---

## الأمان والخصوصية

- **منح صلاحيات صريح**: لا يصل أي وكيل إلى الشبكة أو الملفات أو الكود دون موافقة المستخدم.
- **تنفيذ معزول**: أدوات الكود تعمل في بيئة معزولة (sandbox).
- **تخزين محلي**: البيانات تبقى على الجهاز عبر طبقة `KVStore` (localStorage على الويب).
- **تنبيه طبي**: BodyMap Pain أداة تعليمية فقط وليست بديلًا عن الطبيب.

---

## خريطة الطريق

- [ ] ربط مزوّدي النماذج الحقيقيين (مفاتيح API فعلية).
- [ ] تنفيذ أدوات الويب والكود على الخادم.
- [ ] نشر سحابي متعدّد المستخدمين + مصادقة.
- [ ] مراجعة طبية لمحتوى BodyMap Pain قبل النشر.
- [ ] إعداد النشر إلى Google Play و App Store.

---

## المساهمة

راجع `CONTRIBUTING.md` قبل فتح Issue أو Pull Request. لا تُضِف محتوى طبيًا جديدًا دون مصدر ومراجعة مختص.

## الترخيص

MIT — راجع ملف `LICENSE`.

---

<div align="center">

**صُنع بـ ❤️ للمستخدم العربي** — Semo0o AI © 2025

</div>
