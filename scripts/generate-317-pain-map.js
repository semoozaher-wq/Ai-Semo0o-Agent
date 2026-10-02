#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const packageFile = path.join(
  process.cwd(),
  'node_modules',
  'react-native-body-parts-anatomy',
  'lib',
  'module',
  'data',
  'bodyRegions.generated.js'
);
const outputFile = process.argv[2] || path.join('data', 'anatomyPainMap.json');

if (!fs.existsSync(packageFile)) {
  console.error('Anatomy package is missing. Run: npm install');
  process.exit(1);
}

const source = fs.readFileSync(packageFile, 'utf8');
const pattern = /\{\s*slug:\s*"([^"]+)",\s*parentSlug:\s*"([^"]+)",\s*side:\s*([^,]+),\s*axis:\s*([^,]+),/g;
const fragments = [];
let match;
while ((match = pattern.exec(source)) !== null) {
  const [, id, group, sideValue, axisValue] = match;
  const parts = id.split('-');
  const gender = parts[parts.length - 3];
  const view = parts[parts.length - 2];
  fragments.push({
    id,
    labelAr: `${arabicGroup(group)} ${arabicSide(sideValue)}${axisLabel(axisValue)}`.trim(),
    labelEn: `${group} ${sideValue} ${axisValue}`.replace(/null/g, '').replace(/\s+/g, ' ').trim(),
    group,
    region: regionFor(group),
    side: sideValue === 'null' ? 'center' : sideValue.replace(/"/g, ''),
    axis: axisValue === 'null' ? null : axisValue.replace(/"/g, ''),
    gender,
    views: [view],
    commonCauses: ['محتوى طبي يحتاج مراجعة مختص'],
    warning: null,
    recommendation: 'راجع طبيبًا مختصًا عند استمرار الألم أو زيادته.',
    reviewStatus: 'needs_medical_review'
  });
}

if (fragments.length !== 317) {
  console.error(`Expected 317 fragments, found ${fragments.length}`);
  process.exit(1);
}

const groups = {};
for (const fragment of fragments) {
  if (!groups[fragment.group]) {
    groups[fragment.group] = {
      labelAr: arabicGroup(fragment.group),
      defaultWarning: null,
      defaultRecommendation: 'راجع طبيبًا مختصًا عند استمرار الألم أو زيادته.'
    };
  }
}

const result = {
  generatedFrom: 'react-native-body-parts-anatomy@1.2.0',
  fragmentCount: fragments.length,
  reviewNote: 'Generated technical map. Medical causes, warnings, and recommendations require professional review before release.',
  groups,
  muscles: Object.fromEntries(fragments.map((fragment) => [fragment.id, fragment]))
};

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, `${JSON.stringify(result, null, 2)}\n`);
console.log(`Generated ${fragments.length} fragments in ${outputFile}`);

function arabicGroup(group) {
  return ({
    abs: 'عضلات البطن',
    adductors: 'العضلات المقربة',
    ankles: 'الكاحل',
    biceps: 'العضلة ذات الرأسين',
    calves: 'عضلات الساق الخلفية',
    chest: 'عضلات الصدر',
    deltoids: 'عضلات الكتف',
    feet: 'القدم',
    forearm: 'الساعد',
    gluteal: 'عضلات الألوية',
    hair: 'الشعر',
    hamstring: 'العضلات الخلفية للفخذ',
    hands: 'اليد',
    head: 'الرأس',
    knees: 'الركبة',
    'lower-back': 'أسفل الظهر',
    neck: 'الرقبة',
    obliques: 'العضلات المائلة',
    quadriceps: 'العضلات الرباعية',
    tibialis: 'العضلة الظنبوبية',
    trapezius: 'العضلة شبه المنحرفة',
    triceps: 'العضلة ثلاثية الرؤوس',
    'upper-back': 'أعلى الظهر'
  }[group] || group);
}

function arabicSide(side) {
  return ({ left: ' اليسرى', right: ' اليمنى', null: '' }[side] || '');
}

function axisLabel(axis) {
  return ({ upper: ' العلوية', middle: ' الوسطى', lower: ' السفلية', inner: ' الداخلية', center: ' الوسطى', outer: ' الخارجية', null: '' }[axis] || '');
}

function regionFor(group) {
  if (['head', 'hair', 'neck'].includes(group)) return 'head_neck';
  if (['chest', 'abs', 'obliques'].includes(group)) return 'torso_front';
  if (['upper-back', 'lower-back', 'trapezius'].includes(group)) return 'back';
  if (['biceps', 'triceps', 'deltoids', 'forearm', 'hands'].includes(group)) return 'upper_limb';
  return 'lower_limb';
}
