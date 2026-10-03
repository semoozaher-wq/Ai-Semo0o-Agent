# المرحلة الثانية — Intelligence + Browser + Platform

أضيفت هذه المرحلة كطبقة مستقلة في `phase2-core/` حتى لا تمنح واجهة Expo صلاحيات filesystem أو terminal أو browser مباشرة. التشغيل الفعلي يتم من Node/Backend موثوق، وتستقبل الواجهة نتائج وأدلة فقط.

## المكونات

### Dynamic Planner

- `TaskGraph` يبني DAG حقيقيًا مع `dependsOn`.
- يتحقق من المراجع المفقودة والدورات.
- `ready()` يعيد المهام القابلة للتنفيذ.
- `executeTaskGraph()` ينفذ parallel batches فقط عندما لا يوجد تعارض في موارد `reads` و`writes`.
- يدعم `maxAttempts` و`replan` callback، ويتوقف بفشل صريح بدل إعادة لا نهائية.

### Project Intelligence

`buildProjectIntelligence(root)` ينتج:

- قائمة ملفات المصدر.
- Symbol Index للـ functions/classes/interfaces/types/constants.
- Import Graph وDependency Graph.
- Test Mapping مبدئي.
- parser field يوضح المصدر: `typescript-ast` عند توفر TypeScript Compiler API، أو `lexical-fallback` فقط عند تشغيل Backend بلا حزمة TypeScript.

يتم استدعاء TypeScript Compiler API فعليًا في Backend عبر `createSourceFile` وAST visitor، مع provenance صريح لكل symbol/import. أصلحت مرحلة التدقيق resolver بحيث يتحقق من وجود الملف قبل إدخاله إلى graph، وأضافت استخراج متغيرات declarations وربط الاختبارات بمصادرها المستوردة. fallback لا يُستخدم بصمت.

### RAG

- Chunking قابل لضبط الحجم والتداخل.
- Embeddings محلية حتمية hashed-token vectors كـfallback آمن.
- `createRemoteEmbeddingProvider()` يوفر adapter فعليًا لمزود OpenAI-compatible/HTTP دون ربط مفتاح داخل الكود؛ الـVector Store يقبل adapter قابلًا للاستبدال.
- `PersistentVectorStore` يحفظ vectors وmetadata في JSON.
- cosine retrieval.
- `rerank()` يضيف lexical overlap إلى score.

يمكن استبدال embedding adapter بخدمة إنتاجية لاحقًا دون تغيير واجهة التخزين.

### Persistent Memory

`ProjectMemory` يحفظ:

- project context.
- task history.
- failures.
- fixes/context events.
- recall مبنيًا على tokens.

### Browser Agent

`BrowserAgent` يستخدم Chrome DevTools Protocol عبر WebSocket مُعطى مسبقًا:

- navigate.
- click/type/scroll.
- DOM extraction.
- screenshot bytes.
- console and network event capture.
- Browser verification checks.

تم إصلاح `type()` ليستخدم `Input.insertText` عبر CDP بعد focus/select بدل تعديل `element.value` مباشرة؛ هذا يحاكي إدخال المستخدم ويطلق أحداث المتصفح التي تحتاجها أطر React/Vue. الاختبار الحالي يثبت contract، بينما اختبار E2E يتطلب Chrome/Chromium CDP حيًا.

لا يدير كلمات مرور أو تسجيل دخول تلقائيًا؛ يجب تمرير CDP session مصرح به من مشغل النظام.

### Backend Platform

`PlatformStore` يحفظ JSON دائمًا للكيانات:

- users.
- projects.
- workspaces.
- agent runs.
- logs.
- usage.
- API key hashes فقط، مع last4 دون السر.

هذه طبقة domain/persistence محلية؛ ليست SaaS multi-tenant production API حتى الآن. قبل الإنتاج يجب استبدالها بقاعدة بيانات معاملات، auth/authorization، encryption at rest، rate limiting، migrations، وaudit controls.

### Agent Store

`AgentPackageStore` يدعم:

- install/update.
- permission checks.
- dependency checks.
- uninstall.
- rollback إلى آخر نسخة.
- history audit.

## التشغيل والاختبارات

```bash
npm run test:phase2
npm run typecheck
npm run lint
npm run build
```

اختبارات Phase 2 موجودة في `test/phase2-core.test.mjs` وتغطي DAG/replan، intelligence، RAG persistence، memory، platform، package permissions/rollback، وBrowser CDP contract.

## نتيجة مراجعة المكونات

| المكوّن | النتيجة بعد الإصلاح |
| --- | --- |
| Dynamic Planner / DAG | منفّذ: dependencies، cycles، ready، parallel conflict safety |
| Replan | منفّذ بحد محاولات وفشل نهائي موثق |
| AST / Symbol Index | TypeScript AST فعلي عند توفر compiler API، مع provenance واختبار ناجح |
| Import / Dependency Graph | resolver يتحقق من الملفات، والـdependency graph مبني من edges محلولة |
| Test Mapping | يربط test file بالمصادر المستوردة؛ ما زال mapping static وليس runtime coverage |
| Embeddings | local fallback + remote semantic adapter؛ المزود الإنتاجي يُحدد بالتكوين |
| Retrieval / Reranking | cosine + lexical rerank؛ reranker ML خارجي ما زال adapter غير موصول |
| Browser type | CDP Input.insertText؛ يحتاج E2E على Chrome حي |
| Platform | Domain store دائم محلي، وليس SaaS production |
| Auth / Multi-tenant DB / HTTP API | غير مدّعاة كمكتملة وتحتاج قرار بنية وتشغيل مستقل |

## حدود المرحلة

- لا يوجد ربط افتراضي بقاعدة بيانات أو مزود embeddings مدفوع؛ يوجد adapter HTTP معزول يمكن تهيئته.
- لا يوجد endpoint HTTP دائم أو auth server؛ `PlatformStore` هو domain store محلي مقصود للـbackend adapter.
- Browser Agent يحتاج Chrome/Chromium CDP WebSocket حيًا؛ الاختبار الآلي يتحقق من العقدة دون فتح موقع خارجي.
- لا يمكن اعتبار JSON persistence بديلًا عن DB عند تعدد المستخدمين أو العمليات المتزامنة.
- لا تُحفظ أسرار API نفسها إطلاقًا؛ فقط hash وlast4.
