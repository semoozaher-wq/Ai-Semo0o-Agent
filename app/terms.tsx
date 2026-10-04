import React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { AppHeader } from '../src/components/composite/AppHeader';
import { Card } from '../src/components/ui/Card';
import { Text } from '../src/components/ui/Text';
import { Screen } from '../src/components/ui/Screen';
import { useTheme } from '../src/theme';
import { Icon } from '../src/components/ui/Icon';

export default function TermsScreen() {
  const theme = useTheme();
  const router = useRouter();
  return <Screen><ScrollView contentContainerStyle={{ paddingBottom: 40 }}><AppHeader title="شروط الاستخدام" subtitle="مسودة — تتطلب مراجعة قانونية" left={<Pressable onPress={() => router.back()}><Icon name="arrow-back" size={22} tone="muted" /></Pressable>} /><Card><Text variant="body" style={{ lineHeight: 24 }}>يوفر Semo0o AI تنسيق الوكلاء ومساحات العمل والذاكرة عندما يكون المزود المطلوب موصولًا. ظهور أداة في الكتالوج لا يعني أن تكاملها متاح.</Text><View style={{ height: theme.spacing.lg }} /><Text variant="subtitle" weight="bold">الاستخدام المسؤول</Text><Text variant="body" style={{ lineHeight: 24, marginTop: 8 }}>يتحمل العميل مسؤولية التصاريح والملفات والحسابات التي يرسلها. تتطلب إجراءات التنفيذ والكتابة والبريد والتقويم والمتصفح موافقات وصلاحيات مناسبة، ولا يجوز اعتبار مخرجات BodyMap أو النماذج تشخيصًا طبيًا أو نصيحة مهنية.</Text><View style={{ height: theme.spacing.lg }} /><Text variant="caption" tone="muted">يجب استكمال القانون الحاكم والأسعار والاسترداد والخصوصية وحدود المسؤولية وجهة الاتصال بمراجعة قانونية قبل قبول العملاء.</Text></Card></ScrollView></Screen>;
}
