# تقرير حذف ملفات Legacy — Ai-Semo0o-Agent

## التنفيذ

تم فحص imports والمراجع أولًا. وُجد اعتماد حقيقي واحد على ملف محذوف:

```text
src/services/agent-engine/orchestrator.ts → src/services/ai/runtime.ts
src/services/index.ts → src/services/ai/index.ts
```

تم إصلاح الاعتماد قبل الحذف كما يلي:

- نقل حساب تكلفة النموذج إلى `src/services/agent-engine/orchestrator.ts` باستخدام `data/models`.
- إزالة `aiService` من Orchestrator.
- إزالة export القديم `./ai` من `src/services/index.ts`.
- تحديث وثائق Phase 1 وProduction Baseline إلى Backend LLM path.
- تحديث عينة File Store من المسار المحذوف إلى `src/services/api/client.ts`.

## الملفات المحذوفة

```text
legacy/App.tsx
legacy/components/BodyMap.tsx
src/services/store/useAgentsStore.ts
src/services/store/useAppStore.ts
src/services/store/useChatStore.ts
src/services/store/useWorkspaceStore.ts
src/services/ai/runtime.ts
src/services/ai/index.ts
src/services/ai/providers/anthropic.ts
src/services/ai/providers/gemini.ts
src/services/ai/providers/openai.ts
src/services/ai/providers/index.ts
CHANGES_STEP1.md
FIXES_APPLIED.md
MANIFEST.txt
PACKAGE_MANIFEST.md
REPORT_AR.md
REVIEW_REPORT_AR.md
SEMO0O_PACKAGE_MANIFEST.txt
Ai-Semo0o-Agent-final-engineering-audit.md
ANATOMY_317_IMPLEMENTATION.md
```

كما تم تطبيق تنظيف سبق طلبه:

```text
dist/**
gitignore
```

## ما لم يُحذف

لم تُحذف طبقة `src/services/ai/` المتبقية بالكامل؛ الملفات التالية ما زالت مطلوبة من اختبارات Phase 1 وLegacy Harness:

```text
src/services/ai/provider.ts
src/services/ai/tool-schema.ts
src/services/ai/tool-loop.ts
```

ولم تُحذف ملفات `src/services/store/index.ts` لأنها ما زالت تُستخدم بواسطة Store/AgentDetail عبر `storeService`.

## النتائج

| الفحص | النتيجة |
|---|---|
| فحص imports للمسارات المحذوفة | لا توجد مراجع live بعد الإصلاح |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm test` | PASS: 80 harness + 28 execution + 14 phase1 + 11 phase2 + 11 backend + pain-map validation |
| `npm run build` | PASS: 17 static routes |
| `npm run doctor -- --verbose` | PASS: 21/21 |
| Git status | الملفات المطلوبة ظاهرة Deleted |

## المشاكل المتبقية

- الحذف لم يُدفع إلى GitHub بعد؛ يلزم commit/push.
- `npm audit` يحتاج معالجة منفصلة متوافقة مع Expo، ولم يتم استخدام `--force`.
- لا يزال المنتج يحتاج SaaS memberships/invites/quotas، GitHub OAuth/PR، integrations الخاصة بالصور/التقويم/البريد، token streaming، production deployment، backup/restore، monitoring، mobile E2E، وmedical safety review لـBodyMap.

## ما ينقص التطبيق ليصبح منتجًا حقيقيًا

1. **حسابات SaaS كاملة:** email verification، password reset، MFA، organizations، memberships، invitations، roles administration، quotas وbilling.
2. **تشغيل إنتاجي فعلي:** Host دائم، Docker sandbox حي، TLS، secret manager، backup/restore، monitoring وalerts.
3. **تكاملات حقيقية:** GitHub OAuth وbranch/commit/PR/CI status، Image provider، Calendar، Email مع approval.
4. **Agent production loop:** patch/test/diff/rollback/verify موحد داخل Backend مع snapshots وapproval.
5. **Streaming وUX:** token streaming، approval UI، cancel/pause/resume/retry E2E، error recovery، native mobile E2E.
6. **Security gate:** إصلاح 30 dependency advisories، prompt-injection corpus، secret-exfiltration tests، distributed rate limiting وload tests.
7. **BodyMap:** مراجعة طبية مستقلة، disclaimers، red-flag escalation ومنع التشخيص الجازم.

## القرار

الحذف آمن من ناحية imports والاختبارات بعد نقل dependency. المشروع حاليًا **Release Candidate تقني / Internal Beta Foundation**، وليس Production SaaS مكتملًا.
