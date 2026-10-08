import React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useTheme } from '../../theme';
import { Card } from '../ui/Card';
import { Text } from '../ui/Text';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Divider } from '../ui/Divider';
import { Input } from '../ui/Input';
import { Icon } from '../ui/Icon';
import { Skeleton } from '../ui/Skeleton';
import { backendApi } from '../../services/api/client';
import { useAccountStore } from '../../store/useAccountStore';
import {
  buildOtpAuthUrl,
  exportFilename,
  formatRecoveryCodes,
  isDeleteConfirmationValid,
  isValidMfaCode,
  summarizeExport,
} from '../../services/account/security';

/**
 * Real account-security console: two-factor enrollment, self-service data
 * export, and account deletion. Every action calls the backend and reflects the
 * server's actual response — the MFA badge shows the true `GET /me` state, the
 * export summary counts the real records returned, and the delete button stays
 * disabled until the typed email matches. Nothing here is simulated.
 */
export function AccountSecurityCard() {
  const theme = useTheme();
  const {
    account,
    mfaSetup,
    lastExport,
    loading,
    busy,
    error,
    load,
    beginMfa,
    confirmMfa,
    downloadExport,
    removeAccount,
    clearMfaSetup,
  } = useAccountStore();

  const [code, setCode] = React.useState('');
  const [confirmEmail, setConfirmEmail] = React.useState('');
  const [notice, setNotice] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!account && !error && !loading) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!backendApi.enabled) {
    return (
      <Card>
        <View style={styles.row}>
          <Icon name="cloud-offline-outline" size={20} tone="muted" />
          <Text variant="body" tone="muted" style={{ marginStart: 10, flex: 1 }}>
            الخادم الخلفي غير مُهيأ في هذا الإصدار، لذلك لا يمكن إدارة الأمان أو البيانات.
          </Text>
        </View>
      </Card>
    );
  }

  if (loading && !account) {
    return (
      <Card>
        <Skeleton height={20} width="55%" />
        <Skeleton height={16} width="85%" style={{ marginTop: 12 }} />
        <Skeleton height={16} width="70%" style={{ marginTop: 8 }} />
      </Card>
    );
  }

  if (error && !account) {
    return (
      <Card>
        <View style={styles.row}>
          <Icon name="alert-circle-outline" size={20} tone="danger" />
          <Text variant="body" weight="semibold" style={{ marginStart: 10, flex: 1 }}>
            تعذّر جلب بيانات الحساب
          </Text>
        </View>
        <Text variant="caption" tone="muted" style={{ marginTop: 6 }}>
          {error}
        </Text>
        <Button
          label="إعادة المحاولة"
          icon="refresh-outline"
          variant="outline"
          size="sm"
          onPress={() => void load()}
          style={{ marginTop: theme.spacing.md }}
        />
      </Card>
    );
  }

  if (!account) return null;

  const mfaOn = account.mfaEnabled;
  const otpUrl = mfaSetup ? buildOtpAuthUrl({ secret: mfaSetup.secret, account: account.email }) : null;
  const exportSummary = lastExport ? summarizeExport(lastExport) : null;
  const canDelete = isDeleteConfirmationValid(confirmEmail, account.email) && !busy;

  const onDownload = async () => {
    setNotice(null);
    const data = await downloadExport();
    if (!data) return;
    // On the web build we can hand the file straight to the browser; on native
    // the summary below is the confirmation (no filesystem module is bundled).
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      try {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = exportFilename(account.email);
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
      } catch {
        /* fall back to the on-screen summary */
      }
    }
    setNotice('تم تجهيز نسخة كاملة من بياناتك.');
  };

  const onConfirm = async () => {
    setNotice(null);
    const ok = await confirmMfa(code.trim());
    if (ok) {
      setCode('');
      setNotice('تم تفعيل المصادقة الثنائية بنجاح.');
    }
  };

  const onDelete = async () => {
    setNotice(null);
    const result = await removeAccount({ confirmEmail, scope: 'self' });
    if (result) setNotice('تم حذف الحساب وبياناتك الشخصية.');
  };

  return (
    <Card>
      <View style={styles.row}>
        <Icon name="shield-checkmark-outline" size={20} tone="primary" />
        <Text variant="subtitle" weight="bold" style={{ marginStart: 10, flex: 1 }}>
          الأمان والحساب
        </Text>
        <Badge label={mfaOn ? '2FA مُفعّل' : '2FA معطّل'} tone={mfaOn ? 'success' : 'warning'} />
      </View>

      {/* Identity */}
      <View style={{ marginTop: theme.spacing.md }}>
        <View style={styles.row}>
          <Icon name="mail-outline" size={16} tone="subtle" />
          <Text variant="caption" tone="muted" style={{ marginStart: 8, flex: 1 }}>
            {account.email}
          </Text>
          <Badge label={account.role} tone="neutral" />
        </View>
        <View style={[styles.row, { marginTop: 6 }]}>
          <Icon
            name={account.emailVerifiedAt ? 'checkmark-circle-outline' : 'alert-circle-outline'}
            size={16}
            color={account.emailVerifiedAt ? theme.colors.success : theme.colors.warning}
          />
          <Text variant="caption" tone="muted" style={{ marginStart: 8, flex: 1 }}>
            {account.emailVerifiedAt ? 'البريد موثّق' : 'البريد غير موثّق'}
          </Text>
        </View>
      </View>

      <Divider />

      {/* Two-factor authentication */}
      <Text variant="label" weight="semibold">
        المصادقة الثنائية (TOTP)
      </Text>

      {mfaOn ? (
        <Text variant="caption" tone="muted" style={{ marginTop: 6 }}>
          حسابك محميّ بعامل ثانٍ. عند تسجيل الدخول ستحتاج رمزًا من تطبيق المصادقة أو أحد رموز الاسترداد.
        </Text>
      ) : mfaSetup ? (
        <View style={{ marginTop: theme.spacing.sm }}>
          <Text variant="caption" tone="muted">
            أضف الحساب في تطبيق المصادقة باستخدام المفتاح التالي (SHA1 · 6 أرقام · 30 ثانية):
          </Text>
          <View style={[styles.codeBox, { backgroundColor: theme.colors.surfaceMuted, borderRadius: theme.radius.md, marginTop: 8 }]}>
            <Text variant="caption" weight="semibold" style={{ fontFamily: 'monospace' }}>
              {mfaSetup.secret}
            </Text>
          </View>
          {otpUrl ? (
            <Text variant="caption" tone="subtle" style={{ marginTop: 6, fontFamily: 'monospace' }} selectable>
              {otpUrl}
            </Text>
          ) : null}

          <Text variant="caption" tone="muted" style={{ marginTop: theme.spacing.md }}>
            رموز الاسترداد (تُعرض مرة واحدة فقط — احفظها في مكان آمن):
          </Text>
          <View style={[styles.codeBox, { backgroundColor: theme.colors.surfaceMuted, borderRadius: theme.radius.md, marginTop: 8 }]}>
            <Text variant="caption" style={{ fontFamily: 'monospace' }} selectable>
              {formatRecoveryCodes(mfaSetup.recoveryCodes)}
            </Text>
          </View>

          <Input
            label="رمز التحقق من التطبيق"
            icon="keypad-outline"
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
            maxLength={6}
            placeholder="123456"
            containerStyle={{ marginTop: theme.spacing.md }}
          />
          <View style={[styles.actions, { marginTop: theme.spacing.sm }]}>
            <Button
              label="تأكيد التفعيل"
              icon="checkmark-outline"
              variant="primary"
              size="sm"
              loading={busy}
              disabled={!isValidMfaCode(code) || busy}
              onPress={() => void onConfirm()}
            />
            <Button
              label="إلغاء"
              icon="close-outline"
              variant="ghost"
              size="sm"
              disabled={busy}
              onPress={() => { setCode(''); clearMfaSetup(); }}
            />
          </View>
        </View>
      ) : (
        <View style={{ marginTop: theme.spacing.sm }}>
          <Text variant="caption" tone="muted">
            فعّل عاملًا ثانيًا لحماية حسابك حتى لو تسرّب كلمة المرور.
          </Text>
          <Button
            label="تفعيل المصادقة الثنائية"
            icon="lock-closed-outline"
            variant="outline"
            size="sm"
            loading={busy}
            onPress={() => { setNotice(null); void beginMfa(); }}
            style={{ marginTop: theme.spacing.sm }}
          />
        </View>
      )}

      <Divider />

      {/* Data export */}
      <Text variant="label" weight="semibold">
        تصدير بياناتي
      </Text>
      <Text variant="caption" tone="muted" style={{ marginTop: 6 }}>
        نسخة كاملة ومحمولة من حسابك: المشاريع والمحادثات والرسائل والذاكرة والتشغيلات وسجل التدقيق.
      </Text>
      <Button
        label="تنزيل نسخة من بياناتي"
        icon="download-outline"
        variant="secondary"
        size="sm"
        loading={busy}
        onPress={() => void onDownload()}
        style={{ marginTop: theme.spacing.sm }}
      />
      {exportSummary ? (
        <Text variant="caption" tone="muted" style={{ marginTop: 6 }}>
          {exportSummary.totalRecords} سجلًا في {exportSummary.sections.length} قسمًا.
        </Text>
      ) : null}

      <Divider />

      {/* Danger zone */}
      <Text variant="label" weight="semibold" style={{ color: theme.colors.danger }}>
        حذف الحساب
      </Text>
      <Text variant="caption" tone="muted" style={{ marginTop: 6 }}>
        حذف نهائي لحسابك وبياناتك الشخصية. اكتب بريدك للتأكيد: {account.email}
      </Text>
      <Input
        label="تأكيد البريد الإلكتروني"
        icon="trash-outline"
        value={confirmEmail}
        onChangeText={setConfirmEmail}
        autoCapitalize="none"
        keyboardType="email-address"
        placeholder={account.email}
        containerStyle={{ marginTop: theme.spacing.sm }}
      />
      <Button
        label="حذف حسابي نهائيًا"
        icon="trash-outline"
        variant="danger"
        size="sm"
        loading={busy}
        disabled={!canDelete}
        onPress={() => void onDelete()}
        style={{ marginTop: theme.spacing.sm }}
      />

      {notice ? (
        <Text variant="caption" tone="success" style={{ marginTop: theme.spacing.md }}>
          {notice}
        </Text>
      ) : null}
      {error ? (
        <Text variant="caption" tone="danger" style={{ marginTop: theme.spacing.sm }}>
          {error}
        </Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  actions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  codeBox: { paddingVertical: 10, paddingHorizontal: 12 },
});
