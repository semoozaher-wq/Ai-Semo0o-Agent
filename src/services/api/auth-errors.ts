/**
 * Arabic, user-facing copy for the authentication-gate error codes the backend
 * returns. This module is intentionally pure — it imports neither react-native
 * nor the network client — so the copy is unit-testable and reusable by any
 * surface that needs to explain an auth failure.
 *
 * The codes mirror the backend's error taxonomy (see backend/server.mjs and
 * backend/auth/access.mjs). Unknown codes pass through unchanged so a new
 * backend error is never silently swallowed.
 */
export const AUTH_MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: 'انتهت الجلسة. سجّل الدخول من جديد.',
  INVALID_CREDENTIALS: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
  MFA_REQUIRED: 'أدخل رمز المصادقة الثنائية لإكمال الدخول.',
  MFA_CODE_INVALID: 'رمز المصادقة الثنائية غير صحيح.',
  ACCESS_KEY_INVALID: 'مفتاح الوصول غير صحيح. هذا التطبيق خاص.',
  REGISTRATION_DISABLED: 'التسجيل الذاتي مغلق في هذا النشر. تواصل مع مسؤول النظام.',
  EMAIL_ALREADY_REGISTERED: 'هذا البريد الإلكتروني مسجّل بالفعل.',
  PASSWORD_POLICY_FAILED: 'كلمة المرور يجب أن تكون 12 حرفًا على الأقل.',
  EMAIL_VERIFICATION_REQUIRED: 'يجب تأكيد البريد الإلكتروني قبل الدخول.',
  ACCOUNT_TOKEN_INVALID_OR_EXPIRED: 'رمز التأكيد غير صحيح أو انتهت صلاحيته. اطلب رمزًا جديدًا.',
  BACKEND_API_NOT_CONFIGURED: 'لم يتم ضبط عنوان الخادم (Backend).',
  SESSION_UNAVAILABLE: 'تعذّر الاتصال بالخادم. تحقّق من اتصالك بالشبكة ثم أعد المحاولة.',
  RATE_LIMITED: 'محاولات كثيرة جدًا. انتظر قليلًا ثم أعد المحاولة.',
};

/** Map a thrown error (or code) to a human-readable Arabic message. */
export function humanizeAuthError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  return AUTH_MESSAGES[code] ?? code;
}
