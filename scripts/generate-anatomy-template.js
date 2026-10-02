#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const output = process.argv[2] || path.join('data', 'anatomy.template.json');
const template = {
  groups: {
    chest: {
      labelAr: 'الصدر',
      defaultWarning: 'إذا صاحب الألم ضيق نفس أو امتد إلى الذراع أو الفك، اطلب المساعدة فورًا.',
      defaultRecommendation: 'راجع طبيبًا إذا استمر الألم أو ازداد.'
    },
    shoulder: {
      labelAr: 'الكتف',
      defaultWarning: null,
      defaultRecommendation: 'راجع طبيب عظام أو علاج طبيعي إذا استمر الألم.'
    }
  },
  muscles: {
    pectoralis_major_left: {
      id: 'pectoralis_major_left',
      labelAr: 'العضلة الصدرية الكبرى اليسرى',
      labelEn: 'Left pectoralis major',
      group: 'chest',
      region: 'chest',
      side: 'left',
      views: ['front'],
      commonCauses: ['إجهاد عضلي', 'حركة مفاجئة', 'إصابة رياضية'],
      warning: null,
      recommendation: null
    },
    trapezius_left: {
      id: 'trapezius_left',
      labelAr: 'العضلة شبه المنحرفة اليسرى',
      labelEn: 'Left trapezius',
      group: 'shoulder',
      region: 'neck_shoulders',
      side: 'left',
      views: ['front', 'back'],
      commonCauses: ['شد عضلي', 'وضعية جلوس غير مريحة'],
      warning: null,
      recommendation: null
    }
  }
};

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(template, null, 2)}\n`);
console.log(`Template written to ${output}`);
console.log('Replace the examples with the real IDs from your licensed anatomy SVG.');
