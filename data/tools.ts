import { ToolDefinition } from '../src/types/tool';

export const TOOLS: ToolDefinition[] = [
  {
    id: 'web.search',
    name: 'Web Search',
    nameAr: 'البحث في الويب',
    description: 'Search the live web and return ranked results.',
    descriptionAr: 'البحث في الويب الحي وإرجاع نتائج مرتّبة.',
    category: 'web',
    parameters: [
      { name: 'query', type: 'string', description: 'Search query', required: true },
      { name: 'limit', type: 'number', description: 'Max results', default: 5 },
    ],
    icon: 'search',
  },
  {
    id: 'web.scrape',
    name: 'Web Scraper',
    nameAr: 'قارئ الصفحات',
    description: 'Extract clean text from a URL.',
    descriptionAr: 'استخراج النص النظيف من رابط.',
    category: 'web',
    parameters: [
      { name: 'url', type: 'string', description: 'Page URL', required: true },
    ],
    icon: 'globe',
  },
  {
    id: 'code.run',
    name: 'Code Runner',
    nameAr: 'منفّذ الأكواد',
    description: 'Execute JavaScript/Python in a sandbox.',
    descriptionAr: 'تنفيذ JavaScript/Python في بيئة معزولة.',
    category: 'code',
    parameters: [
      { name: 'language', type: 'string', description: 'Language', required: true, enumValues: ['javascript', 'python'] },
      { name: 'source', type: 'string', description: 'Source code', required: true },
    ],
    dangerous: true,
    icon: 'terminal',
  },
  {
    id: 'code.analyze',
    name: 'Code Analyzer',
    nameAr: 'محلّل الأكواد',
    description: 'Static analysis, linting and auto-fix suggestions.',
    descriptionAr: 'تحليل ساكن واقتراح إصلاحات تلقائية.',
    category: 'code',
    parameters: [
      { name: 'path', type: 'string', description: 'File or folder', required: true },
      { name: 'autofix', type: 'boolean', description: 'Apply safe fixes', default: false },
    ],
    icon: 'code',
  },
  {
    id: 'files.read',
    name: 'File Reader',
    nameAr: 'قارئ الملفات',
    description: 'Read text, JSON, CSV, or PDF contents.',
    descriptionAr: 'قراءة محتوى الملفات النصية و JSON و CSV و PDF.',
    category: 'files',
    parameters: [
      { name: 'fileId', type: 'string', description: 'File id', required: true },
    ],
    icon: 'file-text',
  },
  {
    id: 'files.write',
    name: 'File Writer',
    nameAr: 'كاتب الملفات',
    description: 'Create or update a file in the workspace.',
    descriptionAr: 'إنشاء أو تحديث ملف في مساحة العمل.',
    category: 'files',
    parameters: [
      { name: 'path', type: 'string', description: 'Target path', required: true },
      { name: 'content', type: 'string', description: 'File content', required: true },
    ],
    dangerous: true,
    icon: 'save',
  },
  {
    id: 'files.scan',
    name: 'Workspace Auditor',
    nameAr: 'مُدقّق مساحة العمل',
    description: 'Scan and audit the full file set with health checks.',
    descriptionAr: 'فحص وتدقيق كامل الملفات مع فحوصات السلامة.',
    category: 'files',
    parameters: [
      { name: 'scope', type: 'string', description: 'Folder scope', default: '/' },
      { name: 'deep', type: 'boolean', description: 'Deep analysis', default: true },
    ],
    icon: 'shield',
  },
  {
    id: 'data.profile',
    name: 'Data Profiler',
    nameAr: 'مُحلّل البيانات',
    description: 'Profile a dataset: types, stats, anomalies.',
    descriptionAr: 'تحليل مجموعة بيانات: الأنواع والإحصاءات والشذوذ.',
    category: 'data',
    parameters: [
      { name: 'fileId', type: 'string', description: 'Dataset file id', required: true },
    ],
    icon: 'bar-chart',
  },
  {
    id: 'data.chart',
    name: 'Chart Builder',
    nameAr: 'منشئ الرسوم البيانية',
    description: 'Render charts from tabular data.',
    descriptionAr: 'رسم المخططات من البيانات الجدولية.',
    category: 'data',
    parameters: [
      { name: 'type', type: 'string', description: 'Chart type', enumValues: ['bar', 'line', 'donut', 'scatter'], required: true },
      { name: 'data', type: 'object', description: 'Series data', required: true },
    ],
    icon: 'pie-chart',
  },
  {
    id: 'image.generate',
    name: 'Image Generator',
    nameAr: 'مولّد الصور',
    description: 'Generate images from a text prompt.',
    descriptionAr: 'توليد الصور من وصف نصي.',
    category: 'media',
    parameters: [
      { name: 'prompt', type: 'string', description: 'Image prompt', required: true },
      { name: 'size', type: 'string', description: 'Dimensions', default: '1024x1024' },
    ],
    icon: 'image',
  },
  {
    id: 'image.analyze',
    name: 'Vision Analyzer',
    nameAr: 'محلّل الصور',
    description: 'Describe and extract data from images.',
    descriptionAr: 'وصف واستخراج البيانات من الصور.',
    category: 'media',
    parameters: [
      { name: 'fileId', type: 'string', description: 'Image file id', required: true },
    ],
    icon: 'eye',
  },
  {
    id: 'doc.summarize',
    name: 'Document Summarizer',
    nameAr: 'ملخّص المستندات',
    description: 'Summarize long documents into key points.',
    descriptionAr: 'تلخيص المستندات الطويلة إلى نقاط رئيسية.',
    category: 'productivity',
    parameters: [
      { name: 'fileId', type: 'string', description: 'Document id', required: true },
      { name: 'length', type: 'string', description: 'Summary length', default: 'medium' },
    ],
    icon: 'align-left',
  },
  {
    id: 'pdf.extract',
    name: 'PDF Extractor',
    nameAr: 'مستخرج PDF',
    description: 'Extract text and tables from PDF files.',
    descriptionAr: 'استخراج النص والجداول من ملفات PDF.',
    category: 'files',
    parameters: [
      { name: 'fileId', type: 'string', description: 'PDF id', required: true },
      { name: 'layout', type: 'boolean', description: 'Preserve layout', default: true },
    ],
    icon: 'file',
  },
  {
    id: 'translate',
    name: 'Translator',
    nameAr: 'المترجم',
    description: 'Translate text between languages.',
    descriptionAr: 'ترجمة النصوص بين اللغات.',
    category: 'ai',
    parameters: [
      { name: 'text', type: 'string', description: 'Text', required: true },
      { name: 'target', type: 'string', description: 'Target language', required: true },
    ],
    icon: 'languages',
  },
  {
    id: 'calendar.schedule',
    name: 'Scheduler',
    nameAr: 'المجدول',
    description: 'Create calendar events and reminders.',
    descriptionAr: 'إنشاء أحداث التقويم والتذكيرات.',
    category: 'productivity',
    parameters: [
      { name: 'title', type: 'string', description: 'Event title', required: true },
      { name: 'when', type: 'string', description: 'ISO datetime', required: true },
    ],
    icon: 'calendar',
  },
  {
    id: 'email.send',
    name: 'Email Sender',
    nameAr: 'مرسل البريد',
    description: 'Draft and send an email.',
    descriptionAr: 'صياغة وإرسال بريد إلكتروني.',
    category: 'productivity',
    parameters: [
      { name: 'to', type: 'string', description: 'Recipient', required: true },
      { name: 'subject', type: 'string', description: 'Subject', required: true },
      { name: 'body', type: 'string', description: 'Body', required: true },
    ],
    dangerous: true,
    icon: 'mail',
  },
];

export const TOOLS_BY_ID: Record<string, ToolDefinition> = TOOLS.reduce(
  (acc, tool) => {
    acc[tool.id] = tool;
    return acc;
  },
  {} as Record<string, ToolDefinition>,
);

export function getTool(id: string): ToolDefinition | undefined {
  return TOOLS_BY_ID[id];
}

export function toolsByCategory(category: ToolDefinition['category']): ToolDefinition[] {
  return TOOLS.filter((t) => t.category === category);
}
