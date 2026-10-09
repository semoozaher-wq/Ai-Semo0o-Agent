import React from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import {
  Button,
  Card,
  Gradient,
  Icon,
  IconButton,
  Input,
  Logo,
  SegmentedControl,
  Text,
} from '../components/ui';
import type { IconName } from '../components/ui';
import { useResponsive } from '../hooks/useResponsive';
import { useAuthStore } from '../store/useAuthStore';

type Mode = 'login' | 'register';

interface Highlight {
  icon: IconName;
  title: string;
  desc: string;
}

const HIGHLIGHTS: Highlight[] = [
  { icon: 'rocket-outline', title: 'وكلاء أذكياء', desc: 'خطّط ونفّذ مهامًا معقّدة تلقائيًا' },
  { icon: 'chatbubbles-outline', title: 'محادثة متعددة النماذج', desc: 'GPT · Claude · Gemini في مكان واحد' },
  { icon: 'cube-outline', title: 'مساحة عمل متكاملة', desc: 'GitHub و ZIP وتحرير الملفات' },
  { icon: 'shield-checkmark-outline', title: 'أمان وخصوصية', desc: 'جلسة مصادق عليها ومفاتيح على الخادم' },
];

/**
 * Brand panel shown beside the form on wide screens. Purely presentational —
 * it never touches auth state.
 */
function HeroPanel() {
  const theme = useTheme();
  return (
    <Gradient name="nebula" style={styles.heroPanel}>
      <View style={styles.heroPanelInner}>
        <View style={styles.heroBrandRow}>
          <Logo size={52} />
          <View style={{ marginStart: 12 }}>
            <Text weight="extrabold" style={{ color: '#FFFFFF', fontSize: theme.fontSize.xl }}>
              Semo0o AI
            </Text>
            <Text style={{ color: 'rgba(255,255,255,0.75)', fontSize: theme.fontSize.sm }}>
              منصة الوكلاء الذكية
            </Text>
          </View>
        </View>

        <View style={styles.heroCenter}>
          <Text
            weight="extrabold"
            style={{ color: '#FFFFFF', fontSize: theme.fontSize['4xl'], lineHeight: 48 }}
          >
            ابنِ، شغّل، وسلّم
          </Text>
          <Text
            weight="extrabold"
            style={{ color: 'rgba(255,255,255,0.9)', fontSize: theme.fontSize['4xl'], lineHeight: 48 }}
          >
            مع وكلاء أذكياء.
          </Text>
          <Text
            style={{
              color: 'rgba(255,255,255,0.8)',
              marginTop: theme.spacing.lg,
              fontSize: theme.fontSize.md,
              lineHeight: 26,
              maxWidth: 460,
            }}
          >
            منصة ذكاء اصطناعي متكاملة: محادثة، وكلاء ذاتيون، استوديو إنشاء، ومساحة عمل
            برمجية — بواجهة عربية أصيلة.
          </Text>

          <View style={{ marginTop: theme.spacing['3xl'], gap: theme.spacing.lg }}>
            {HIGHLIGHTS.map((h) => (
              <View key={h.title} style={styles.highlightRow}>
                <View style={styles.highlightIcon}>
                  <Icon name={h.icon} size={18} color="#FFFFFF" />
                </View>
                <View style={{ flex: 1, marginStart: theme.spacing.md }}>
                  <Text weight="semibold" style={{ color: '#FFFFFF' }}>
                    {h.title}
                  </Text>
                  <Text style={{ color: 'rgba(255,255,255,0.72)', fontSize: theme.fontSize.sm }}>
                    {h.desc}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </View>

        <View style={styles.heroFooter}>
          <Icon name="lock-closed" size={14} color="rgba(255,255,255,0.7)" />
          <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: theme.fontSize.xs, marginStart: 6 }}>
            تطبيق خاص — الوصول بحساب مصادق عليه فقط
          </Text>
        </View>
      </View>
    </Gradient>
  );
}

/** Compact brand header for narrow screens. */
function CompactHero() {
  const theme = useTheme();
  return (
    <View style={styles.compactHero}>
      <Logo size={60} />
      <Text variant="title" weight="extrabold" align="center" style={{ marginTop: theme.spacing.md }}>
        Semo0o AI
      </Text>
      <Text variant="caption" tone="muted" align="center" style={{ marginTop: 2 }}>
        منصة الوكلاء الذكية — مساحة عمل خاصة
      </Text>
    </View>
  );
}

export function Auth() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useResponsive();
  const split = width >= 900;

  const status = useAuthStore((s) => s.status);
  const policy = useAuthStore((s) => s.policy);
  const error = useAuthStore((s) => s.error);
  const busy = useAuthStore((s) => s.busy);
  const mfaRequired = useAuthStore((s) => s.mfaRequired);
  const pendingVerificationEmail = useAuthStore((s) => s.pendingVerificationEmail);
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);
  const verifyEmail = useAuthStore((s) => s.verifyEmail);
  const cancelVerification = useAuthStore((s) => s.cancelVerification);
  const refreshPolicy = useAuthStore((s) => s.refreshPolicy);
  const clearError = useAuthStore((s) => s.clearError);

  const [mode, setMode] = React.useState<Mode>('login');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [showPassword, setShowPassword] = React.useState(false);
  const [tenantName, setTenantName] = React.useState('');
  const [accessKey, setAccessKey] = React.useState('');
  const [mfaCode, setMfaCode] = React.useState('');
  const [verifyToken, setVerifyToken] = React.useState('');

  React.useEffect(() => {
    void refreshPolicy();
  }, [refreshPolicy]);

  const policyKnown = policy !== null;
  const requiresAccessKey = policy?.registration.requiresAccessKey ?? false;
  const registrationOpen = policy?.registration.open ?? false;

  const activeMode: Mode =
    policyKnown && !registrationOpen && mode === 'register' ? 'login' : mode;

  const submit = async () => {
    clearError();
    if (activeMode === 'login') {
      await login({
        email: email.trim(),
        password,
        ...(mfaRequired && mfaCode ? { mfaCode: mfaCode.trim() } : {}),
      });
    } else {
      await register({
        email: email.trim(),
        password,
        ...(tenantName.trim() ? { tenantName: tenantName.trim() } : {}),
        ...(requiresAccessKey ? { accessKey: accessKey.trim() } : {}),
      });
    }
  };

  const switchMode = (next: Mode) => {
    clearError();
    setMode(next);
  };

  const modes: Mode[] = registrationOpen ? ['login', 'register'] : ['login'];

  const submitDisabled =
    !email.trim() ||
    password.length < 1 ||
    (activeMode === 'register' && !registrationOpen) ||
    (activeMode === 'register' && requiresAccessKey && !accessKey.trim());

  const passwordToggle = (
    <IconButton
      name={showPassword ? 'eye-off-outline' : 'eye-outline'}
      size="sm"
      variant="ghost"
      onPress={() => setShowPassword((v) => !v)}
      accessibilityLabel={showPassword ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
    />
  );

  const formBody = pendingVerificationEmail ? (
    <Card style={{ marginTop: theme.spacing['2xl'] }} elevation="lg">
      <View style={styles.centered}>
        <View
          style={[
            styles.verifyIcon,
            { backgroundColor: theme.colors.primarySoft, borderRadius: 999 },
          ]}
        >
          <Icon name="mail-unread-outline" size={30} tone="primary" />
        </View>
        <Text variant="title" weight="bold" align="center" style={{ marginTop: theme.spacing.md }}>
          تأكيد البريد الإلكتروني
        </Text>
        <Text variant="caption" tone="muted" align="center" style={{ marginTop: theme.spacing.xs }}>
          أُنشئ حساب {pendingVerificationEmail}. أدخل رمز التأكيد الذي وصلك لإكمال
          التفعيل ثم سجّل الدخول.
        </Text>
      </View>
      <View style={{ marginTop: theme.spacing.xl, gap: theme.spacing.md }}>
        <Input
          label="رمز التأكيد"
          icon="key-outline"
          value={verifyToken}
          onChangeText={setVerifyToken}
          autoCapitalize="none"
          placeholder="ألصق رمز التأكيد هنا"
          editable={!busy}
        />
      </View>
      {error ? (
        <View
          style={[
            styles.error,
            { backgroundColor: theme.colors.dangerSoft, borderRadius: theme.radius.lg, marginTop: theme.spacing.lg },
          ]}
        >
          <Icon name="alert-circle-outline" size={18} tone="danger" />
          <Text tone="danger" style={{ flex: 1, marginStart: theme.spacing.sm }}>
            {error}
          </Text>
        </View>
      ) : null}
      <Button
        label="تأكيد البريد"
        icon="checkmark-circle-outline"
        onPress={() => {
          void verifyEmail(verifyToken);
        }}
        loading={busy}
        disabled={!verifyToken.trim()}
        fullWidth
        size="lg"
        style={{ marginTop: theme.spacing.xl }}
      />
      <Button
        label="العودة لتسجيل الدخول"
        variant="ghost"
        onPress={() => {
          setVerifyToken('');
          cancelVerification();
        }}
        fullWidth
        style={{ marginTop: theme.spacing.sm }}
      />
    </Card>
  ) : (
    <Card style={{ marginTop: split ? 0 : theme.spacing['2xl'] }} elevation={split ? 'xl' : 'lg'}>
      <Text variant="title" weight="extrabold">
        {activeMode === 'login' ? 'مرحبًا بعودتك' : 'أنشئ حسابك'}
      </Text>
      <Text variant="caption" tone="muted" style={{ marginTop: 4 }}>
        {activeMode === 'login'
          ? 'سجّل الدخول للمتابعة إلى مساحة عملك.'
          : 'ابدأ خلال دقيقة — أنشئ حسابك الخاص.'}
      </Text>

      {modes.length > 1 ? (
        <View style={{ marginTop: theme.spacing.lg }}>
          <SegmentedControl<Mode>
            value={activeMode}
            onChange={switchMode}
            options={[
              { label: 'تسجيل الدخول', value: 'login', icon: 'log-in-outline' },
              { label: 'إنشاء حساب', value: 'register', icon: 'person-add-outline' },
            ]}
          />
        </View>
      ) : null}

      <View style={{ marginTop: theme.spacing.xl, gap: theme.spacing.md }}>
        <Input
          label="البريد الإلكتروني"
          icon="mail-outline"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
          placeholder="name@company.com"
          editable={!busy}
        />
        <Input
          label="كلمة المرور"
          icon="lock-closed-outline"
          value={password}
          onChangeText={setPassword}
          secureTextEntry={!showPassword}
          autoCapitalize="none"
          placeholder="12 حرفًا على الأقل"
          editable={!busy}
          right={passwordToggle}
        />
        {activeMode === 'register' && registrationOpen ? (
          <>
            <Input
              label="اسم مساحة العمل (اختياري)"
              icon="business-outline"
              value={tenantName}
              onChangeText={setTenantName}
              placeholder="فريق العمل"
              editable={!busy}
            />
            {requiresAccessKey ? (
              <Input
                label="مفتاح الوصول"
                icon="key-outline"
                value={accessKey}
                onChangeText={setAccessKey}
                autoCapitalize="none"
                placeholder="مفتاح الدعوة الخاص بالنشر"
                editable={!busy}
                hint="هذا النشر خاص — يتطلب مفتاح وصول لإنشاء حساب."
              />
            ) : null}
          </>
        ) : null}
        {activeMode === 'login' && mfaRequired ? (
          <Input
            label="رمز المصادقة الثنائية"
            icon="shield-checkmark-outline"
            value={mfaCode}
            onChangeText={setMfaCode}
            keyboardType="number-pad"
            maxLength={6}
            placeholder="000000"
            editable={!busy}
          />
        ) : null}
      </View>

      {error ? (
        <View
          style={[
            styles.error,
            { backgroundColor: theme.colors.dangerSoft, borderRadius: theme.radius.lg, marginTop: theme.spacing.lg },
          ]}
        >
          <Icon name="alert-circle-outline" size={18} tone="danger" />
          <Text tone="danger" style={{ flex: 1, marginStart: theme.spacing.sm }}>
            {error}
          </Text>
        </View>
      ) : null}

      {policyKnown && !registrationOpen ? (
        <View
          style={[
            styles.notice,
            { backgroundColor: theme.colors.warningSoft, borderRadius: theme.radius.lg, marginTop: theme.spacing.lg },
          ]}
        >
          <Icon name="lock-closed-outline" size={18} tone="warning" />
          <View style={{ flex: 1, marginStart: theme.spacing.sm, gap: 4 }}>
            <Text tone="warning" weight="semibold">
              هذا نشر خاص — التسجيل الذاتي مُغلق.
            </Text>
            <Text tone="warning" variant="caption">
              لا يمكن إنشاء حساب من هنا. للحصول على حساب، اطلب دعوة من مسؤول النظام.
            </Text>
          </View>
        </View>
      ) : null}

      <Button
        label={activeMode === 'login' ? 'دخول' : 'إنشاء الحساب'}
        icon="log-in-outline"
        onPress={submit}
        loading={busy || status === 'loading'}
        disabled={submitDisabled}
        fullWidth
        size="lg"
        style={{ marginTop: theme.spacing.xl }}
      />
    </Card>
  );

  const footer = (
    <View style={[styles.footer, { marginTop: theme.spacing.xl }]}>
      <Icon name="shield-checkmark" size={16} tone="subtle" />
      <Text variant="caption" tone="subtle" align="center" style={{ marginStart: theme.spacing.sm, flex: 1 }}>
        تطبيق خاص: لا يمكن فتح الواجهة أو تشغيل الوكلاء دون جلسة مصادق عليها.
      </Text>
    </View>
  );

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: theme.colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {split ? (
        <View style={styles.split}>
          <View style={styles.heroSlot}>
            <HeroPanel />
          </View>
          <ScrollView
            style={styles.formSlot}
            contentContainerStyle={[
              styles.formSlotContent,
              { paddingVertical: Math.max(insets.top, theme.spacing['3xl']) },
            ]}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.formColumn}>
              {formBody}
              {footer}
            </View>
          </ScrollView>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={[
            styles.scroll,
            {
              paddingHorizontal: theme.spacing['2xl'],
              paddingTop: Math.max(insets.top, theme.spacing['2xl']),
              paddingBottom: Math.max(insets.bottom, theme.spacing['2xl']),
            },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <CompactHero />
          {formBody}
          {footer}
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  split: { flex: 1, flexDirection: 'row' },
  heroSlot: { flex: 1.15 },
  heroPanel: { flex: 1 },
  heroPanelInner: {
    flex: 1,
    padding: 48,
    justifyContent: 'space-between',
  },
  heroBrandRow: { flexDirection: 'row', alignItems: 'center' },
  heroCenter: { flex: 1, justifyContent: 'center' },
  highlightRow: { flexDirection: 'row', alignItems: 'center' },
  highlightIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  heroFooter: { flexDirection: 'row', alignItems: 'center' },
  formSlot: { flex: 1 },
  formSlotContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 40,
  },
  formColumn: { width: '100%', maxWidth: 460, alignSelf: 'center' },
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    maxWidth: 520,
    width: '100%',
    alignSelf: 'center',
  },
  compactHero: { alignItems: 'center', marginBottom: 8 },
  centered: { alignItems: 'center' },
  verifyIcon: { width: 64, height: 64, alignItems: 'center', justifyContent: 'center' },
  error: { flexDirection: 'row', alignItems: 'center', padding: 12 },
  notice: { flexDirection: 'row', alignItems: 'flex-start', padding: 12 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
});
