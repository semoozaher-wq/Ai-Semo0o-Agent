import React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { AppHeader } from '../src/components/composite/AppHeader';
import { Card } from '../src/components/ui/Card';
import { Text } from '../src/components/ui/Text';
import { Screen } from '../src/components/ui/Screen';
import { useTheme } from '../src/theme';
import { Icon } from '../src/components/ui/Icon';

export default function PrivacyScreen() {
  const theme = useTheme();
  const router = useRouter();
  return <Screen><ScrollView contentContainerStyle={{ paddingBottom: 40 }}><AppHeader title="سياسة الخصوصية" subtitle="مسودة — تتطلب مراجعة قانونية" left={<Pressable onPress={() => router.back()}><Icon name="arrow-back" size={22} tone="muted" /></Pressable>} /><Card><Text variant="body" style={{ lineHeight: 24 }}>نعالج بيانات الحسابات والمنظمات ومساحات العمل والـPrompts ونتائج الوكلاء والذاكرة لأغراض المصادقة والتنفيذ والأمان وقياس الاستخدام. تُعزل الذاكرة والملفات بحسب المنظمة والمشروع، ولا يُسمح بالوصول بين المستأجرين.</Text><View style={{ height: theme.spacing.lg }} /><Text variant="subtitle" weight="bold">الاحتفاظ والحذف</Text><Text variant="body" style={{ lineHeight: 24, marginTop: 8 }}>يجب أن يحدد النشر مدة الاحتفاظ والنسخ الاحتياطية. تتوفر عمليات تصدير وحذف ذاكرة المشروع في Backend، بينما يتطلب حذف الحساب والمنظمة مسارًا تشغيليًا مكتملًا قبل الإطلاق.</Text><View style={{ height: theme.spacing.lg }} /><Text variant="caption" tone="muted">يجب استكمال هوية الجهة المتحكمة، الأساس القانوني، جهة الاتصال الأمنية، والمناطق الجغرافية بمراجعة مستشار قانوني.</Text></Card></ScrollView></Screen>;
}
