import { ChatQuickAction } from '../src/types/chat';

export const QUICK_ACTIONS: ChatQuickAction[] = [
  {
    id: 'qa-summarize',
    label: 'Summarize',
    labelAr: 'لخّص',
    icon: 'align-left',
    prompt: 'لخّص النص التالي في نقاط رئيسية واضحة:\n\n',
  },
  {
    id: 'qa-code',
    label: 'Write code',
    labelAr: 'اكتب كودًا',
    icon: 'code',
    prompt: 'اكتب كودًا نظيفًا وموثّقًا لـ: ',
  },
  {
    id: 'qa-translate',
    label: 'Translate',
    labelAr: 'ترجم',
    icon: 'languages',
    prompt: 'ترجم النص التالي إلى الإنجليزية مع الحفاظ على النبرة:\n\n',
  },
  {
    id: 'qa-analyze',
    label: 'Analyze data',
    labelAr: 'حلّل بيانات',
    icon: 'bar-chart',
    prompt: 'حلّل البيانات التالية واستخرج أهم الأنماط والرؤى:\n\n',
  },
  {
    id: 'qa-brainstorm',
    label: 'Brainstorm',
    labelAr: 'عصف ذهني',
    icon: 'zap',
    prompt: 'اقترح 10 أفكار مبتكرة حول: ',
  },
  {
    id: 'qa-plan',
    label: 'Make a plan',
    labelAr: 'ضع خطة',
    icon: 'check-square',
    prompt: 'ضع خطة عمل تفصيلية خطوة بخطوة لـ: ',
  },
];
