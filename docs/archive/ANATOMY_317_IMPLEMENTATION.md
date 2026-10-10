# دليل إضافة خريطة الجسم التفاعلية ذات 317 جزءًا

هذا الملف يشرح كيف تنتقل النسخة الحالية من 7 مناطق عامة إلى أجزاء عضلية دقيقة قابلة للضغط.

## مهم قبل البدء

الملفات الحالية تحتوي على **هيكل الربط البرمجي** فقط. يجب إضافة ملف SVG تشريحي مرخّص أو مكتبة توفر الأجزاء الـ317 فعليًا. لا تستخدم رسمة من الإنترنت بدون التأكد من الترخيص.

## تثبيت دعم SVG في Expo

```bash
npx expo install react-native-svg
```

## بنية البيانات المقترحة

استخدم معرفًا ثابتًا لكل جزء. يجب أن يطابق معرف SVG تمامًا:

```json
{
  "groups": {
    "chest": {
      "labelAr": "الصدر",
      "defaultWarning": "إذا صاحب الألم ضيق نفس أو امتد إلى الذراع أو الفك، اطلب المساعدة فورًا.",
      "defaultRecommendation": "راجع طبيبًا إذا استمر الألم أو ازداد."
    }
  },
  "muscles": {
    "pectoralis_major_left": {
      "id": "pectoralis_major_left",
      "labelAr": "العضلة الصدرية الكبرى اليسرى",
      "labelEn": "Left pectoralis major",
      "group": "chest",
      "region": "chest",
      "side": "left",
      "views": ["front"],
      "commonCauses": ["إجهاد عضلي", "حركة مفاجئة", "إصابة رياضية"],
      "warning": null,
      "recommendation": null
    }
  }
}
```

إذا لم توجد `warning` أو `recommendation` خاصة بالعضلة، استخدم القيمة الافتراضية للمجموعة.

## ربط SVG بالبيانات

كل مسار في SVG يجب أن يحمل نفس الـID:

```xml
<path id="pectoralis_major_left" d="..." />
```

وعند الضغط:

```tsx
<Path
  d={pathData}
  fill={selectedId === 'pectoralis_major_left' ? '#0E7C86' : '#D9E4E8'}
  onPress={() => onPartPress('pectoralis_major_left')}
/>
```

لا تكتب 317 مسارًا يدويًا داخل `App.tsx`. ضعها في مكوّن مستقل مثل `components/AnatomySvg.tsx` أو استخدم مكتبة جاهزة.

## ربط الشاشة

استبدل الاختيار العام:

```ts
const [region, setRegion] = useState<string | null>(null);
```

باختيار الجزء:

```ts
const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
const selectedMuscle = selectedPartId ? painMap.muscles[selectedPartId] : null;

function handlePartPress(partId: string) {
  if (!painMap.muscles[partId]) return;
  setSelectedPartId(partId);
}
```

ثم مرر البيانات إلى الخريطة:

```tsx
<AnatomySvg
  selectedId={selectedPartId}
  gender={gender}
  view={side === 'أمامي' ? 'front' : 'back'}
  onPartPress={handlePartPress}
/>
```

وفي النتائج:

```tsx
const group = selectedMuscle ? painMap.groups[selectedMuscle.group] : null;
const warning = selectedMuscle?.warning ?? group?.defaultWarning;
const recommendation = selectedMuscle?.recommendation ?? group?.defaultRecommendation;
```

## توزيع الأجزاء

احفظ لكل جزء:

- `id`: المعرف البرمجي الثابت.
- `labelAr`: الاسم العربي.
- `labelEn`: الاسم الإنجليزي اختياريًا.
- `group`: المجموعة العامة مثل الصدر أو الساق.
- `region`: المنطقة المستخدمة في الفلاتر.
- `side`: يمين أو يسار أو منتصف.
- `views`: أمامي أو خلفي.
- `commonCauses`: الأسباب العامة.
- `warning`: تحذير خاص، إن وجد.
- `recommendation`: توصية خاصة، إن وجدت.

## التحقق من وجود بيانات لكل جزء

بعد استخراج IDs من SVG، قارنها مع JSON:

```ts
for (const svgId of svgPartIds) {
  if (!painMap.muscles[svgId]) {
    console.warn(`Missing pain data for: ${svgId}`);
  }
}
```

ويجب التأكد من:

- عدم وجود IDs مكررة.
- أن عدد الأجزاء يساوي العدد المعلن من المكتبة.
- أن كل جزء له اسم عربي.
- ألا توجد توصية طبية بلا مراجعة مختص.

## التكبير والتحريك

مع SVG كبير، أضف مكتبة gesture/zoom مناسبة أو نفذ تكبيرًا محدودًا. اختبر على Android وiOS لأن الأجزاء الصغيرة قد يصعب الضغط عليها. يمكن إضافة طبقة لمس شفافة أكبر فوق الأجزاء الصغيرة بدل تغيير الرسم نفسه.

## الخطوات العملية

1. اختر مكتبة أو ملف SVG مرخّصًا.
2. ثبّت `react-native-svg`.
3. استخرج IDs الحقيقية من SVG.
4. أنشئ 317 سجلًا في `painMap.json` أو ولّدها Script.
5. اربط المسارات بالـIDs.
6. استبدل `region` بـ `selectedPartId`.
7. أضف التكبير والبحث والفلترة.
8. اختبر الضغط على جميع الأجزاء.
9. راجع البيانات والتحذيرات طبيًا وقانونيًا.

## ملف البداية الموجود في هذا المشروع

- `types/anatomy.ts`: أنواع البيانات.
- `components/BodyMap.tsx`: مكوّن اختبار يوضح فكرة الاختيار.
- `data/painMap.json`: قاعدة البيانات الحالية للمناطق العامة.
- `GITHUB_UPLOAD_GUIDE.md`: طريقة رفع المشروع وتحديثه على GitHub.

المكوّن الحالي لا يدّعي أنه يحتوي على الرسم التشريحي الحقيقي؛ هو نقطة بداية آمنة لدمج SVG المرخّص لاحقًا.
