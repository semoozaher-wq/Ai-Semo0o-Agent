# طريقة تطبيق الحزمة (APPLY)

## القاعدة المرجعية
هذه الحزمة تُطبَّق فوق الالتزام الحالي لفرع `master` على GitHub:

```
4542e333872a064ba40400865df8d931b3433fb7   ("Add files via upload")
```

> ملاحظة مهمة: فرع `master` على GitHub يحتوي **بالفعل** على معظم ملفات الحل
> (مثل `backend/auth/access.mjs`, `src/services/api/client.ts`, `app/_layout.tsx`,
> التبويبات الجديدة `studio`/`operations`, `app/files.tsx`, `app/library.tsx`).
> لذلك هذه الحزمة تحتوي فقط على **الفرق المتبقّي**: الملفات المعدّلة حديثًا،
> والملفات المضافة، وقائمة الملفات التي يجب حذفها.

## المحتوى
- **ملفات معدّلة (7):**
  `backend/.env.example`, `backend/config/env.mjs`, `backend/server.mjs`,
  `render.yaml`, `src/screens/Auth.tsx`, `src/services/api/auth-errors.ts`,
  `src/store/useAuthStore.ts`
- **ملفات مضافة (2):**
  `backend/auth/bootstrap.mjs`, `backend/test/bootstrap.test.mjs`
- **ملفات يجب حذفها (5):** انظر `_DELETE_THESE_FILES.txt`

## خطوات التطبيق
1. فُكّ ضغط الحزمة فوق جذر المشروع (ستُستبدل الملفات المعدّلة، وتُضاف الجديدة
   في مساراتها الصحيحة).
2. نفّذ حذف الملفات الخمسة المذكورة في `_DELETE_THESE_FILES.txt`.
3. تحقّق محليًا:
   ```bash
   npm ci
   npm run typecheck        # يجب أن يخرج بكود 0
   npm run release:gate     # typecheck + phase1 + frontend
   ```
4. ارفع التعديلات (commit + push).

## التحقق الذي تم فعليًا (وليس ادّعاءً)
تم إنشاء نسخة عمل نظيفة من `origin/master` عند `4542e33`، وتطبيق هذه الحزمة
عليها، ثم تشغيل:

| الأمر | قبل | بعد |
|---|---|---|
| `npx tsc --noEmit` | فشل (كود 2) — `TS2305: no exported member 'Store'` | نجاح (كود 0) |
| `npm run release:gate` | — | نجاح (كود 0) |
| `backend/*.test.mjs` | — | 621 نجاح / 0 فشل / 2 متجاوز |

## ملاحظة عن أول حساب (Render)
أُضيف مسار جديد لإنشاء أول حساب من **متغيّرات البيئة** دون الحاجة إلى Render Shell:
```
BOOTSTRAP_ADMIN_EMAIL=you@example.com
BOOTSTRAP_ADMIN_PASSWORD=a-long-passphrase   # >= 12 حرفًا
```
يُنشئ أول مالك عند الإقلاع **فقط** إذا كانت قاعدة البيانات بلا حسابات، ويُعلّم
البريد مُتحقَّقًا منه. لا يلمس أي تثبيت قائم (no-op إذا وُجد أي حساب).
