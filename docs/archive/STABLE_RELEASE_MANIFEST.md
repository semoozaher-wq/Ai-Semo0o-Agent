# STABLE RELEASE MANIFEST — Ai-Semo0o-Agent

> الحزمة: `semo0o-agent-stable-release-changes.zip`
> النطاق: تقوية الإصدار المستقر (release stabilization) فقط — بدون إعادة بناء، بدون تغيير معماري، بدون ميزات جديدة.
> كل المسارات داخل الحزمة محافظة على نفس بنية المستودع (نفس المسار الأصلي).
> ملاحظة: يوجد `MANIFEST.md` آخر في المستودع يعود لدورة سابقة ("Maestro Full Integration") — لم يُلمَس.

---

## 1) الملفات المعدّلة (Modified)

| # | المسار | المجموعة | السبب |
|---|--------|----------|-------|
| 1 | `src/services/store/useAccountStore.ts` | FIX#1 — Typecheck / duplicate | كان نسخة مكرّرة كاملة من `src/store/useAccountStore.ts` مع استيراد لا يُحلّ (`../services/api/client`) من هذا المسار، فكان يكسر `tsc --noEmit`. أُعيد كـ shim يعيد التصدير من المصدر القانوني (نفس نمط بقية ملفات `src/services/store/use*.ts`). |
| 2 | `src/components/AccountSecurityCard.tsx` | FIX#1 — Typecheck / duplicate | كان نسخة مكرّرة حرفيًا من `src/components/composite/AccountSecurityCard.tsx` باستيرادات نسبية لا تُحلّ (`../../theme`, `../ui/*`, `../../services/api/client`, `../../store/useAccountStore`, `../../services/account/security`)، فكان يكسر `tsc --noEmit`. أُعيد كـ shim يعيد التصدير من المكوّن القانوني. لا يوجد أي importer للملف العلوي. |
| 3 | `scripts/boot-smoke.sh` | FIX#2 — Runtime smoke gate | تحت `set -euo pipefail`، كان `curl -sf ... \| head -c 300` يجعل curl يخرج بالرمز 23 (CURLE_WRITE_ERROR / EPIPE) بمجرد إغلاق `head` للأنبوب، فيُسقط بوابة الـ smoke رغم نجاح كل الخطوات. الآن يُقرأ الرد كاملًا في متغيّر ثم تُطبَع معاينة (بدون SIGPIPE). |
| 4 | `backend/Dockerfile` | FIX#3 — Deployment blocker | الصورة كانت تنهار عند الإقلاع لسببين حقيقيين: (أ) `shared/recovery-contract.json` (يستورده `backend/agent/recovery.mjs`) لم يكن يُنسخ، (ب) الحزمة `jszip` (استيراد ثابت من `backend/github/service.mjs` و`backend/authoring/office.mjs`، وكلاهما يصل إليه `server.mjs`) لم تكن مثبّتة. أُضيف `COPY shared ./shared` وتثبيت `jszip@3.10.2` فقط. |
| 5 | `backend/test/browser-e2e.test.mjs` | FIX#4 — Test reliability (root/container) | عند تشغيل `npm test` كـ root (داخل حاوية) يرفض Chromium الإقلاع بدون `--no-sandbox`، فيفشل الاختبار بـ `BROWSER_EXITED_EARLY:1`. الآن يضبط الاختبار `BROWSER_NO_SANDBOX=true` للعملية الفرعية فقط عندما يكون root ولم يكن المضبّط مسبقًا — بنفس نمط `backend/test/red-team.test.mjs`. سياسة المنتج تبقى opt-in كما هي (`backend/browser/launcher.mjs` لا يضيف `--no-sandbox` إلا عند `BROWSER_NO_SANDBOX === 'true'` صراحةً؛ runners الـ CI غير root ولا تحتاجه). |

## 2) الملفات المُضافة (Added)

| # | المسار | السبب |
|---|--------|-------|
| 1 | `RELEASE_TODO.md` | ملف عمل يوثّق مراحل تقوية الإصدار (Recon → Build/Static → Tests → Runtime/E2E → Reliability/Security → Fixes → Deliverables) وحالة كل بند. |
| 2 | `STABLE_RELEASE_MANIFEST.md` | هذا المانيفست (سجل التغييرات + الاختبارات + النتائج + العوائق). |

## 3) ما لم يُدرَج في الحزمة (مقصود)

- `agent-benchmark.report.json`, `browser-e2e.report.json`, `capability-scorecard.json` — مخرجات مُولّدة تُعاد كتابتها في كل تشغيل اختبار (ليست تغييرات مصدرية). أُعيدت إلى حالتها المُلتزَمة (committed baseline).
- `browser-e2e.screenshot.png` — أثر مُولّد (لم يتغيّر أصلًا؛ اختبار E2E يكتب اللقطة في مجلد مؤقت).
- أي `node_modules/`, `.expo/`, `dist/`, `build/`, caches — ملفات بناء/اعتماديات غير لازمة.
- ملفات مكرّرة قديمة غير مُستشهد بها (`backend/package.json`, `backend/package-lock.json`, `backend/render.yaml`) — تُركت كما هي عن قصد (غير مُستخدمة من CI/Dockerfile/Render؛ الجذر هو المصدر القانوني). موثّقة كملاحظة غير حاجبة في القسم 6.

---

## 4) الاختبارات التي شُغّلت فعليًا ونتائجها

### 4.1 بوابات ثابتة (Static gates)
| الأمر | النتيجة |
|-------|---------|
| `npm run typecheck` (`tsc --noEmit`) | PASS (exit 0) — كان يفشل بـ 14 خطأ قبل FIX#1 |
| `npm run lint` (`expo lint`) | PASS (exit 0) |
| `npm run security:scan` | PASS (exit 0) |
| `node scripts/verify-imports.mjs backend` | PASS (exit 0) |
| `npm run audit:gate` | PASS (exit 0) — 21 حزمة متأثرة بتحذيرات، كلها داخل الأساس المراجَع (3 تحذيرات مقبولة، 21 حزمة مقبولة) |
| `npm run build` (`expo export --platform web`) | PASS (exit 0) — 20 مسارًا ثابتًا |

### 4.2 حزمة الاختبارات الكاملة `npm test` (EXIT=0)
| المجموعة | النتيجة |
|----------|---------|
| `test:legacy-harness` | 80/80 passed, 0 failed |
| `test:execution` | 69/69 pass, 0 fail |
| `test:phase1` | 43/43 pass, 0 fail |
| `test:frontend` | 30/30 pass, 0 fail |
| `test:phase2` | 23/23 pass, 0 fail |
| `test:backend` | 504/504 pass, 0 fail, **0 skipped** (اختبارات المتصفح نُفّذت فعليًا مع `CHROMIUM_BIN`؛ كانت 2 skipped قبل ضبط المتصفح) |
| `validate:pain-map` | PASS |

### 4.3 وقت التشغيل / E2E
| البوابة | النتيجة |
|---------|---------|
| `npm run smoke:backend` (boot-smoke: boot → /health → /ready → POST /auth/register → GET /tools/status) | PASS (exit 0) — "BOOT SMOKE OK" بعد FIX#2 |
| `npm run benchmark:agent` | PASS (exit 0) — agent-loop=100% · multi-agent=100% · long-running=100% · code-intelligence=100% · self-healing=100% · integrations=100% · `passed=true` |
| `npm run benchmark:capabilities` | PASS (exit 0) — 13/13 available (score 100)؛ 13/13 proven end-to-end |
| `npm run trial:self-improve` | PASS (exit 0) — 9/9 checks passed؛ "self-improvement pipeline is live and fail-closed" |
| `node scripts/browser-smoke.mjs` | PASS |
| `node scripts/browser-e2e.mjs` (CDP حقيقي: navigate/click/type/scroll/verify/screenshot) | PASS — 3/3 scenarios |
| `backend/test/browser-e2e.test.mjs` (كـ root بدون ضبط يدوي) | PASS (ok 1, 0 fail) بعد FIX#4 |
| محاكاة نشر Docker (`/tmp/dockersim`) | PASS — `import server.mjs` = IMPORT_OK؛ إقلاع كامل: `/health` 200، `/ready` 503 بدون مزوّد، "backend listening" |

### 4.4 التحقق من الموثوقية والأمان (Runtime wiring — تم فحصه واختباره)
- **فشل مزوّد LLM + fallback**: موجود في `backend/llm/providers.mjs` (إعادة محاولات + تتبّع صحة + إعادة تعيين الموديل عبر المزوّدين) — يغطيه `test/execution` (fallback planner) و`phase1`.
- **الأدوات عالية الخطورة + بوابة موافقة حقيقية**: `requiresApproval` مُطبّق في `backend/agent/runtime.mjs` و`backend/agent/multi-agent.mjs`؛ مصنّف المخاطر في `backend/agent/safety.mjs`.
- **Idempotency / عدم التنفيذ المزدوج**: مفاتيح idempotency + dedupeActive في `backend/queue/queue.mjs` و`backend/server.mjs` و`backend/scheduler/scheduler.mjs`.
- **تعافي العامل بعد الانهيار**: leases + heartbeat + `sweep()`/`recover()` في `queue.mjs`؛ حالة `continuation` العابرة.
- **تعدد الوكلاء (فشل/تعارض/تسوية + حدود التوازي)**: TaskGraph في `multi-agent.mjs` + سيناريو multi-agent في الـ benchmark (100%).
- **كشف انحدار التقييم**: محرّك التقييم/الـ benchmark + بوابة الانحدار.
- **سلامة الأثر بعد التخزين/إعادة التحميل/إعادة التشغيل**: SQLite (`node:sqlite`) + التحقق عبر E2E.
- **سلوك الإقلاع/الصحة/التدهور**: `validateStartupConfig` و`degradedCapabilities`؛ `/ready` يعيد 503 بدون مزوّد (مُبلّغ عنه لا كفشل).

---

## 5) حالة CI / البناء / النشر

- **CI**: `.github/workflows/ci.yml` (matrix Node 22.5 & 22.11.0: typecheck, `npm test`, `audit:gate`) و`.github/workflows/quality.yml` (security:scan, audit:gate, verify-imports backend, typecheck, lint, `npm test`, expo doctor, build, browser-smoke, browser-e2e, agent benchmark, boot-smoke, production trial). كل خطوة تُشغَّل محليًا بنجاح الآن. لم يُعدَّل أي workflow.
- **البناء (Web)**: `expo export --platform web` ينجح (20 مسارًا ثابتًا).
- **Docker**: أُصلح (FIX#3) وتحقّق عبر محاكاة كاملة.
- **Render**: `render.yaml` (الجذر) + `server.js` shim يعملان؛ `scripts/render-env-sim.sh` يعيد HTTP 200.
- **systemd / nginx**: `infra/*.service` و`infra/nginx.conf` موجودة ومتّسقة.

---

## 6) العوائق المتبقية (Remaining Blockers)

**لا يوجد عائق حاجب للإصدار (0 release blockers).**

ملاحظات غير حاجبة (موثّقة عن قصد، لم تُعدَّل لتجنّب تغييرات غير ضرورية):

1. **ملفات مكرّرة قديمة غير مُستشهد بها**: `backend/package.json` و`backend/package-lock.json` و`backend/render.yaml`.
   - `backend/package.json` يختلف عن الجذر فقط بغياب سكربت `audit:gate` وغياب `test/account-security.test.ts` من `test:frontend`.
   - `backend/render.yaml` يطابق الجذر وظيفيًا (يحتوي تعليقات توثيقية إضافية فقط).
   - **لا شيء** في CI أو Dockerfile أو Render يشير إليها؛ المصدر القانوني هو ملفات الجذر. تُركت كما هي لتجنّب تغيير غير ضروري/مخاطرة. (لو رغبت، يمكن حذفها أو مزامنتها في تغيير منفصل.)
2. **اختبارات المتصفح**: تعتمد على وجود Chromium محلي؛ تتخطّى بأمانة (skip) عند غيابه بدل أن تُبلّغ نجاحًا زائفًا. في CI (غير root) لا تحتاج `BROWSER_NO_SANDBOX`؛ في حاوية root يضبطها الاختبار تلقائيًا (FIX#4).
3. **مزوّد LLM**: غير مُهيّأ افتراضيًا في بيئة التحقق، لذا `/ready` يعيد 503 (سلوك متدهور مقصود ومُبلّغ عنه، ليس فشلًا). يتطلب مفاتيح مزوّد حقيقية للتشغيل الكامل للإنتاج.

---

## 7) طريقة التحقق (Reproduce)

```bash
# ثابت
npm run typecheck && npm run lint && npm run security:scan \
  && node scripts/verify-imports.mjs backend && npm run audit:gate && npm run build

# اختبارات
npm test

# وقت التشغيل / E2E (يتطلب Chromium للمتصفح)
export CHROMIUM_BIN="$(command -v chromium || command -v google-chrome)"
npm run smoke:backend
npm run benchmark:agent
npm run benchmark:capabilities
npm run trial:self-improve
npm run test:browser-e2e

# Docker
docker build -f backend/Dockerfile -t ai-semo0o-backend .
docker run --rm -p 8080:8080 ai-semo0o-backend   # /health → 200
```
