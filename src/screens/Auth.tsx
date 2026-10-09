import React from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useTheme } from '../theme';
import { Button, Card, Gradient, Icon, Input, Text } from '../components/ui';
import { useAuthStore } from '../store/useAuthStore';

type Mode = 'login' | 'register';

/**
 * The private-app gate. Rendered INSTEAD of the application whenever there is no
 * live session, so an unauthorised visitor who has the URL only ever sees this
 * screen — never a dashboard, a store, or any agent surface.
 *
 * Registration is offered ONLY when the deployment actually accepts self-service
 * sign-ups (open registration or a shared access key). When the deployment is
 * fully closed, the register affordance is removed entirely instead of leaving a
 * button that can only fail at the server — the visitor is told how to obtain
 * access (an invitation from the operator).
 */
export function Auth() {
  const theme = useTheme();
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
  const [tenantName, setTenantName] = React.useState('');
  const [accessKey, setAccessKey] = React.useState('');
  const [mfaCode, setMfaCode] = React.useState('');
  const [verifyToken, setVerifyToken] = React.useState('');

  React.useEffect(() => { void refreshPolicy(); }, [refreshPolicy]);

  // Fail-closed until the policy is known: only show the register affordance once
  // the server has confirmed that self-service sign-up is actually possible.
  const policyKnown = policy !== null;
  const requiresAccessKey = policy?.registration.requiresAccessKey ?? false;
  const registrationOpen = policy?.registration.open ?? false;

  // If the deployment turns out to be closed, never leave the user stranded on a
  // register form that cannot succeed.
  React.useEffect(() => {
    if (policyKnown && !registrationOpen && mode === 'register') setMode('login');
  }, [policyKnown, registrationOpen, mode]);

  const submit = async () => {
    clearError();
    if (mode === 'login') {
      await login({ email: email.trim(), password, ...(mfaRequired && mfaCode ? { mfaCode: mfaCode.trim() } : {}) });
    } else {
      await register({
        email: email.trim(),
        password,
        ...(tenantName.trim() ? { tenantName: tenantName.trim() } : {}),
        ...(requiresAccessKey ? { accessKey: accessKey.trim() } : {}),
      });
    }
  };

  const switchMode = (next: Mode) => { clearError(); setMode(next); };

  // The register tab is rendered only when sign-up is genuinely available.
  const modes: Mode[] = registrationOpen ? ['login', 'register'] : ['login'];

  const submitDisabled =
    !email.trim() ||
    password.length < 1 ||
    (mode === 'register' && !registrationOpen) ||
    (mode === 'register' && requiresAccessKey && !accessKey.trim());

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: theme.colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[styles.scroll, { padding: theme.spacing['2xl'] }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.heroWrap}>
          <Gradient name="brand" radius={theme.radius['2xl']} style={styles.logo}>
            <Icon name="sparkles" size={34} color="#FFFFFF" />
          </Gradient>
          <Text variant="display" weight="extrabold" align="center" style={{ marginTop: theme.spacing.lg }}>
            Semo0o AI
          </Text>
          <Text variant="subtitle" tone="muted" align="center" style={{ marginTop: theme.spacing.xs }}>
            منصة الوكلاء الذكية — مساحة عمل خاصة
          </Text>
        </View>

        {pendingVerificationEmail ? (
          <Card style={{ marginTop: theme.spacing['2xl'] }}>
            <View style={styles.heroWrap}>
              <Icon name="mail-unread-outline" size={30} tone="primary" />
              <Text variant="title" weight="bold" align="center" style={{ marginTop: theme.spacing.sm }}>
                تأكيد البريد الإلكتروني
              </Text>
              <Text variant="caption" tone="muted" align="center" style={{ marginTop: theme.spacing.xs }}>
                أُنشئ حساب {pendingVerificationEmail}. أدخل رمز التأكيد الذي وصلك لإكمال التفعيل ثم سجّل الدخول.
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
              <View style={[styles.error, { backgroundColor: theme.colors.dangerSoft, borderRadius: theme.radius.lg, marginTop: theme.spacing.lg }]}>
                <Icon name="alert-circle-outline" size={18} tone="danger" />
                <Text tone="danger" style={{ flex: 1, marginStart: theme.spacing.sm }}>{error}</Text>
              </View>
            ) : null}
            <Button
              label="تأكيد البريد"
              icon="checkmark-circle-outline"
              onPress={() => { void verifyEmail(verifyToken); }}
              loading={busy}
              disabled={!verifyToken.trim()}
              fullWidth
              size="lg"
              style={{ marginTop: theme.spacing.xl }}
            />
            <Button
              label="العودة لتسجيل الدخول"
              variant="ghost"
              onPress={() => { setVerifyToken(''); cancelVerification(); }}
              fullWidth
              style={{ marginTop: theme.spacing.sm }}
            />
          </Card>
        ) : (
        <Card style={{ marginTop: theme.spacing['2xl'] }}>
          {modes.length > 1 ? (
            <View style={[styles.segment, { backgroundColor: theme.colors.surfaceMuted, borderRadius: theme.radius.pill, padding: 4 }]}>
              {modes.map((item) => {
                const active = mode === item;
                return (
                  <Pressable
                    key={item}
                    onPress={() => switchMode(item)}
                    style={[
                      styles.segmentItem,
                      {
                        borderRadius: theme.radius.pill,
                        backgroundColor: active ? theme.colors.primary : 'transparent',
                      },
                    ]}
                  >
                    <Text weight="semibold" align="center" style={{ color: active ? theme.colors.onPrimary : theme.colors.textMuted }}>
                      {item === 'login' ? 'تسجيل الدخول' : 'إنشاء حساب'}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}

          <View style={{ marginTop: modes.length > 1 ? theme.spacing.xl : 0, gap: theme.spacing.md }}>
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
              secureTextEntry
              autoCapitalize="none"
              placeholder="12 حرفًا على الأقل"
              editable={!busy}
            />
            {mode === 'register' && registrationOpen ? (
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
            {mode === 'login' && mfaRequired ? (
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
            <View style={[styles.error, { backgroundColor: theme.colors.dangerSoft, borderRadius: theme.radius.lg, marginTop: theme.spacing.lg }]}>
              <Icon name="alert-circle-outline" size={18} tone="danger" />
              <Text tone="danger" style={{ flex: 1, marginStart: theme.spacing.sm }}>{error}</Text>
            </View>
          ) : null}

          {policyKnown && !registrationOpen ? (
            <View style={[styles.notice, { backgroundColor: theme.colors.warningSoft, borderRadius: theme.radius.lg, marginTop: theme.spacing.lg }]}>
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
            label={mode === 'login' ? 'دخول' : 'إنشاء الحساب'}
            icon="log-in-outline"
            onPress={submit}
            loading={busy || status === 'loading'}
            disabled={submitDisabled}
            fullWidth
            size="lg"
            style={{ marginTop: theme.spacing.xl }}
          />
        </Card>
        )}

        <View style={[styles.footer, { marginTop: theme.spacing.xl }]}>
          <Icon name="shield-checkmark" size={16} tone="subtle" />
          <Text variant="caption" tone="subtle" align="center" style={{ marginStart: theme.spacing.sm, flex: 1 }}>
            تطبيق خاص: لا يمكن فتح الواجهة أو تشغيل الوكلاء دون جلسة مصادق عليها.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { flexGrow: 1, justifyContent: 'center', maxWidth: 520, width: '100%', alignSelf: 'center' },
  heroWrap: { alignItems: 'center' },
  logo: { width: 84, height: 84, alignItems: 'center', justifyContent: 'center' },
  segment: { flexDirection: 'row' },
  segmentItem: { flex: 1, paddingVertical: 10 },
  error: { flexDirection: 'row', alignItems: 'center', padding: 12 },
  notice: { flexDirection: 'row', alignItems: 'flex-start', padding: 12 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
});
