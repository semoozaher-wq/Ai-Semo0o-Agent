# تقرير التحقق من واجهة الدردشة — إصلاح «الواجهة القديمة»

> النطاق: التأكد من أن واجهة الدردشة التي تُبنى وتُنشر هي **النسخة الصحيحة (v2)**،
> وتحديد السبب الجذري لظهور واجهة قديمة، وإضافة حواجز تمنع تكرارها.

## 1. مسار التشغيل الفعلي (تم تتبّعه بالكامل)

```
app/_layout.tsx                      (RootLayout → ThemeProvider → RootNavigator + بوابة مصادقة صارمة)
  └─ app/(tabs)/_layout.tsx          (شريط التبويبات الخمسة: index / agents / chat / studio / operations)
       └─ app/(tabs)/chat.tsx        (import { Chat } from '../../src/screens'; export default Chat)
            └─ src/screens/index.ts  (barrel: export { Chat } from './Chat')
                 └─ src/screens/Chat.tsx   ← واجهة الدردشة الوحيدة (v2)
                      ├─ src/components/composite/ConversationsList (مدمجة) + Composer + ChatBubble
                      ├─ src/components/ui/{Badge,Button,Card,Icon,IconButton,Logo,Screen,Sheet,Text}
                      ├─ src/store/useChatStore  (المخزن القانوني)
                      ├─ src/store/useAppStore + src/hooks/useResponsive
                      └─ src/data/{quickActions,models} + src/utils/format
```

## 2. السبب الجذري (مُثبَت بالأدلة، لا افتراض)

**لا يوجد أي «نسخة قديمة» من واجهة الدردشة داخل المستودع.** الواجهة القديمة
(pre-rail) اختفت فعليًا من الشيفرة، ومسار التشغيل يشير إلى `src/screens/Chat.tsx`
(v2) فقط. الأدلة:

| الفحص | النتيجة |
|---|---|
| عدد شاشات الدردشة في المشروع | **واحدة فقط** — `src/screens/Chat.tsx` (لا شاشة مكررة/قديمة) |
| مسارات `app/` للدردشة | `app/(tabs)/chat.tsx` فقط (لا `app/chat.tsx` مكرر) |
| حجم `src/screens/Chat.tsx` | 531 سطرًا = **v2** (rail + Composer + Sheet) وليس 358/365 (القديمة) |
| `src/screens/index.ts` | يصدّر `Chat` من `./Chat` الصحيح |
| مخزنان لـ `useChatStore` | `src/store/` (القانوني) + `src/services/store/` (re-export shim) — ليسا تعارضًا |
| حزمة البناء الجديدة (`npm run build`) | تحتوي وسوم v2 (sentinel + نص المحادثات) |
| **الحزمة المنشورة فعليًا** على `ai-semo0o-agent.vercel.app` | **تحتوي أيضًا** على وسوم v2 |

**الاستنتاج:** المشكلة ليست في الشيفرة ولا في المسار ولا في استيراد قديم ولا في
شاشة مكررة. مصدر ظهور «الواجهة القديمة» هو **نسخة مبنية/مخزّنة مؤقتًا (stale
build/cache) أو نشر أقدم أو بناء أصلي (native) قديم** على جهة المستخدم — وليس
المستودع. لذلك أُضيفت حواجز على مستوى البناء/النشر تمنع تكرار المشكلة نهائيًا.

### ملاحظة إضافية مهمة
فرع `master` على GitHub **تباعد** عن العمل المحلي عبر 12 التزامًا «Add files via
upload» نقلت ملفات `docs/archive/*` إلى الجذر، وحذفت `README.md` و
`PRODUCTION_READINESS.md` و`docs/BRANCH_PROTECTION.md` و`scripts/protect-master-branch.sh`،
وأضافت ملفات `.patch`/`tmp` عابرة، **ولم تتضمّن إصلاحات Phase 4**. هذا التشويش
هو ما يبنيه Vercel. الـ ZIP المرفق يعيد المستودع إلى حالة نظيفة ومتّسقة.

## 3. الإصلاح المُنفَّذ (additive — لا حذف لأي ميزة)

| الملف | التغيير |
|---|---|
| `src/screens/Chat.tsx` | إضافة ثابت `CHAT_UI_BUNDLE_SENTINEL = 'semo0o-chat-ui-v2-rail-composer'` وربطه بـ `testID` على الحاوية الجذرية (يظهر كـ `data-testid` على الويب). لا تغيير بصري. |
| `scripts/verify-web-bundle.mjs` | **جديد** — يتحقق أن حزمة الويب المبنية تحتوي واجهة v2 (sentinel + نص v2 الحصري). يفشل البناء (exit 1) إن كانت الحزمة قديمة/خاطئة. |
| `scripts/clean.mjs` | **جديد** — يحذف `dist/` و`.expo/` و`node_modules/.cache` قبل كل بناء. |
| `package.json` | `clean` + `prebuild` (تنظيف تلقائي قبل البناء) + `verify:web`، و`build = export:web && verify:web`. |
| `vercel.json` | ترويسات صريحة: HTML `max-age=0, must-revalidate` (لا كاش قديم)، والأصول المُبصَّمة `immutable`، مع `nosniff` و`Referrer-Policy`. |

النتيجة: أي بناء (محلي أو Vercel) يبدأ نظيفًا، ويُرفض إن لم يحتوِ واجهة v2 —
فلا يمكن نشر واجهة قديمة بصمت.

## 4. نتائج الاختبارات

| الفحص | الأمر | النتيجة |
|---|---|---|
| الأنواع | `npm run typecheck` | **EXIT=0** |
| اختبارات الواجهة | `npm run test:frontend` | **38/38 ✅** |
| الحزمة الكاملة | `npm test` | **EXIT=0 — 0 فشل** (منها backend: 692 إجمالي / 686 ناجح / 6 متجاوز) |
| بوابة الواجهة (إيجابي) | `npm run verify:web` | ✅ واجهة v2 مؤكَّدة في الحزمة |
| بوابة الواجهة (سلبي) | حذف الـ sentinel ثم `verify:web` | ✅ **يفشل بـ EXIT=1** (البوابة تعمل) |
| فحص الأمان | `npm run security:scan` | 443 ملفًا — **0 نتائج** |

## 5. ما يحتاج تحققًا يدويًا (لا يمكن إثباته آليًا)

بعد إعادة النشر، تأكّد بصريًا من ظهور واجهة v2 (شريط المحادثات الجانبي + Composer +
ورقة اختيار النموذج) عبر **تحديث قسري** (`Ctrl/Cmd+Shift+R`) أو نافذة خاصة، لتفادي
أي كاش متصفح قديم. إن كنت تشغّل محليًا: `npm run clean && npx expo start -c`.
