# الإصلاحات المنفذة — Ai-Semo0o-Agent

التاريخ: 2026-10-03

## تم إصلاحه

- إصلاح أخطاء الاستيراد في `src/services/store/*` التي كانت تكسر TypeScript وESLint.
- إضافة `.gitignore` لـ `node_modules` و`.expo` و`dist` والأسرار والمخرجات المؤقتة.
- فصل RTL عن اختيار السمة وتطبيق `dir/lang` على الويب و`I18nManager` على native.
- إصلاح مفتاح RTL في الإعدادات ليغير الاتجاه فعليًا.
- إضافة شاشة خطأ وإعادة محاولة عند فشل bootstrap.
- استبدال التخزين المؤقت native بـ AsyncStorage دائم.
- تخزين مفاتيح API في SecureStore على native، مع عدم كتابتها إلى مخزن الإعدادات العام.
- فرض الموافقة الخادمية تلقائيًا على `code.run` وعمليات الكتابة/الحذف/الإرسال الخطرة، وعدم الثقة في علم العميل وحده.
- منع الموافقة الذاتية على العمليات الخطرة، وقصر الموافقة على owner/admin.
- إضافة تحقق أساسي للمدخلات النصية وroot path، وإخفاء رسائل الأخطاء الداخلية من استجابات 5xx.
- إضافة عزل للمشروعات: المالك أو owner/admin فقط يستطيع الوصول إلى مشروع أو تشغيلاته.
- قصر cancel/pause/resume على منشئ التشغيل أو owner/admin.
- منع تداخل ticks داخل RunQueue، وتمرير AbortSignal، وإلغاء التنفيذ النشط عند pause/cancel.
- منع `finish()` من الكتابة فوق حالات paused/cancelled أو حالات غير running.
- فصل API عن العامل في systemd عبر `DISABLE_WORKER=1` وربط الخادم بـ `127.0.0.1` افتراضيًا.
- إضافة حدود headers/request للخادم.
- توسيع `npm test` ليشمل Backend tests وpain-map validation.
- تحديث اختبارات Backend لتثبت سياسة الموافقة المستقلة الجديدة.

## التحقق النهائي

- `npm run typecheck` — PASS
- `npm run lint` — PASS
- `npm test` — PASS
- `npm run build` — PASS، 17 static routes
- `npm run doctor` — PASS، 21/21
- `npm run test:backend` — PASS، 7/7
- `npm run validate:pain-map` — PASS

## ما لا يمكن اعتباره مكتملًا داخل كود محلي فقط

- ربط واجهة Expo بالكامل بـ Backend API بدل المسار المحلي؛ يتطلب قرارًا معماريًا وبيئة Backend/جلسات.
- تنفيذ جميع الأدوات المعلنة مثل web.search وemail وcalendar وimage generation؛ تحتاج adapters ومفاتيح ومزودات فعلية.
- تشغيل Docker smoke حي؛ يحتاج Docker/Podman worker فعليًا.
- RBAC تفصيلي متعدد الأعضاء على مستوى المشروع؛ الحالي يطبق عزلًا محافظًا بالمالك/الأدوار.
- ZIP picker/sharing الأصلي للموبايل؛ يحتاج إضافة مسارات UI واختبار native.
- إزالة كل تنبيهات `npm audit`؛ تحتاج ترقية Expo مدروسة واختبارات توافق، ولا ينبغي استخدام `--force` عشوائيًا.

هذه الحزمة تحتوي التعديلات المنفذة فعلًا ولا تتضمن `node_modules` أو `dist` أو `.expo`.
