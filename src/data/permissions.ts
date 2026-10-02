import {
  AgentPermission,
  AgentPermissionSpec,
  PermissionRisk,
} from '../types/agent';

export const PERMISSIONS: Record<AgentPermission, AgentPermissionSpec> = {
  internet: {
    id: 'internet',
    label: 'Internet access',
    labelAr: 'الوصول إلى الإنترنت',
    description: 'Fetch live data from the web.',
    descriptionAr: 'جلب البيانات الحية من الويب.',
    risk: 'low',
  },
  'files.read': {
    id: 'files.read',
    label: 'Read files',
    labelAr: 'قراءة الملفات',
    description: 'Read documents and datasets you share.',
    descriptionAr: 'قراءة المستندات ومجموعات البيانات التي تشاركها.',
    risk: 'medium',
  },
  'files.write': {
    id: 'files.write',
    label: 'Write files',
    labelAr: 'كتابة الملفات',
    description: 'Create and modify files in your workspace.',
    descriptionAr: 'إنشاء وتعديل الملفات في مساحة العمل.',
    risk: 'medium',
  },
  'code.execute': {
    id: 'code.execute',
    label: 'Execute code',
    labelAr: 'تنفيذ الأكواد',
    description: 'Run generated code in a sandbox.',
    descriptionAr: 'تشغيل الأكواد المولّدة داخل بيئة معزولة.',
    risk: 'high',
  },
  notifications: {
    id: 'notifications',
    label: 'Notifications',
    labelAr: 'الإشعارات',
    description: 'Send you progress and completion alerts.',
    descriptionAr: 'إرسال تنبيهات التقدم والإنجاز.',
    risk: 'low',
  },
  calendar: {
    id: 'calendar',
    label: 'Calendar',
    labelAr: 'التقويم',
    description: 'Read and create calendar events.',
    descriptionAr: 'قراءة وإنشاء أحداث التقويم.',
    risk: 'medium',
  },
  email: {
    id: 'email',
    label: 'Email',
    labelAr: 'البريد الإلكتروني',
    description: 'Draft and send emails on your behalf.',
    descriptionAr: 'صياغة وإرسال البريد الإلكتروني نيابةً عنك.',
    risk: 'high',
  },
  camera: {
    id: 'camera',
    label: 'Camera',
    labelAr: 'الكاميرا',
    description: 'Capture photos for analysis.',
    descriptionAr: 'التقاط الصور لتحليلها.',
    risk: 'medium',
  },
  microphone: {
    id: 'microphone',
    label: 'Microphone',
    labelAr: 'الميكروفون',
    description: 'Record and transcribe audio.',
    descriptionAr: 'تسجيل وتحويل الصوت إلى نص.',
    risk: 'medium',
  },
  location: {
    id: 'location',
    label: 'Location',
    labelAr: 'الموقع الجغرافي',
    description: 'Access your approximate location.',
    descriptionAr: 'الوصول إلى موقعك التقريبي.',
    risk: 'high',
  },
  payments: {
    id: 'payments',
    label: 'Payments',
    labelAr: 'المدفوعات',
    description: 'Initiate payments and purchases.',
    descriptionAr: 'بدء عمليات الدفع والشراء.',
    risk: 'high',
  },
};

export const PERMISSION_LIST: AgentPermissionSpec[] = Object.values(PERMISSIONS);

export function permissionSpec(id: AgentPermission): AgentPermissionSpec {
  return PERMISSIONS[id];
}

const RISK_ORDER: Record<PermissionRisk, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export function highestRisk(perms: AgentPermission[]): PermissionRisk {
  return perms.reduce<PermissionRisk>(
    (acc, perm) =>
      RISK_ORDER[PERMISSIONS[perm].risk] > RISK_ORDER[acc]
        ? PERMISSIONS[perm].risk
        : acc,
    'low',
  );
}
