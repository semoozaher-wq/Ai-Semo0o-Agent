import React from 'react';
import { StyleSheet, View } from 'react-native';
import * as Linking from 'expo-linking';
import { useTheme } from '../../theme';
import { Card } from '../ui/Card';
import { Text } from '../ui/Text';
import { Badge } from '../ui/Badge';
import type { BadgeTone } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Divider } from '../ui/Divider';
import { Icon } from '../ui/Icon';
import type { IconName } from '../ui/Icon';
import { Input } from '../ui/Input';
import { Skeleton } from '../ui/Skeleton';
import { backendApi } from '../../services/api/client';
import type { ApiConnectorStatus } from '../../services/api/client';
import { useSystemStatusStore } from '../../store/useSystemStatusStore';

/**
 * Integrations / connectors console.
 *
 * Every value is read from the backend (`/integrations/status`): GitHub (OAuth +
 * token), billing provider, the embedding provider, error tracking and the
 * browser runtime. A connector that is not configured is shown as
 * «غير مُهيأ» with the exact reason — never a fake success. The only mutating
 * actions are the GitHub OAuth connect / disconnect, which surface the exact
 * backend error when the caller lacks the required role or the integration is
 * not configured server-side.
 */

type Tone = BadgeTone;

function StateRow({
  icon,
  title,
  detail,
  ok,
  tone,
  statusLabel,
}: {
  icon: IconName;
  title: string;
  detail: string;
  ok: boolean;
  tone: Tone;
  statusLabel: string;
}) {
  const theme = useTheme();
  const color = ok ? theme.colors.success : theme.colors.textMuted;
  return (
    <View style={styles.row}>
      <Icon name={icon} size={18} color={color} />
      <View style={{ flex: 1, marginStart: 10 }}>
        <Text variant="label" weight="semibold">
          {title}
        </Text>
        <Text variant="caption" tone="muted" numberOfLines={2}>
          {detail}
        </Text>
      </View>
      <Badge label={statusLabel} tone={tone} />
    </View>
  );
}

function connectorDetail(status: ApiConnectorStatus | undefined, fallback: string): string {
  if (!status) return fallback;
  if (status.configured) {
    const provider = status.provider ? ` · ${status.provider}` : '';
    const model = status.model ? ` · ${status.model}` : '';
    const host = status.host ? ` · ${status.host}` : '';
    return `مُهيأ${provider}${model}${host}`;
  }
  return status.reason ?? status.error ?? fallback;
}

export function IntegrationsCard() {
  const theme = useTheme();
  const integrations = useSystemStatusStore((s) => s.integrations);
  const loading = useSystemStatusStore((s) => s.loading);
  const refresh = useSystemStatusStore((s) => s.refresh);

  const [busy, setBusy] = React.useState<string | null>(null);
  const [oauthUrl, setOauthUrl] = React.useState<string | null>(null);
  const [oauthState, setOauthState] = React.useState<string | null>(null);
  const [code, setCode] = React.useState('');
  const [notice, setNotice] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const github = integrations?.github;
  const connection = github?.connection ?? null;

  const run = React.useCallback(
    async (key: string, action: () => Promise<unknown>, successMessage: string) => {
      setBusy(key);
      setNotice(null);
      setError(null);
      try {
        await action();
        setNotice(successMessage);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'INTEGRATION_ACTION_FAILED');
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const connect = React.useCallback(async () => {
    setBusy('github:connect');
    setNotice(null);
    setError(null);
    try {
      const started = await backendApi.startGitHubOAuth();
      setOauthUrl(started.url);
      setOauthState(started.state);
      try {
        await Linking.openURL(started.url);
        setNotice('فُتحت صفحة تفويض GitHub. بعد الموافقة انسخ رمز code والصقه هنا لإكمال الربط.');
      } catch {
        setNotice('انسخ رابط التفويض الظاهر أدناه وافتحه في المتصفح، ثم الصق رمز code لإكمال الربط.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'GITHUB_OAUTH_START_FAILED');
    } finally {
      setBusy(null);
    }
  }, []);

  const complete = React.useCallback(async () => {
    if (!oauthState || !code.trim()) return;
    await run(
      'github:complete',
      () => backendApi.completeGitHubOAuth({ state: oauthState, code: code.trim() }),
      'تم ربط حساب GitHub بنجاح.',
    );
    setOauthUrl(null);
    setOauthState(null);
    setCode('');
  }, [oauthState, code, run]);

  const disconnect = React.useCallback(async () => {
    await run('github:disconnect', () => backendApi.disconnectGitHub(), 'تم فصل حساب GitHub.');
    setOauthUrl(null);
    setOauthState(null);
  }, [run]);

  if (!backendApi.enabled) {
    return (
      <Card>
        <View style={styles.row}>
          <Icon name="cloud-offline-outline" size={20} tone="muted" />
          <Text variant="body" tone="muted" style={{ marginStart: 10, flex: 1 }}>
            الخادم الخلفي غير مُهيأ في هذا الإصدار، لذلك لا يمكن عرض حالة التكاملات الحقيقية.
          </Text>
        </View>
      </Card>
    );
  }

  if (loading && !integrations) {
    return (
      <Card>
        <Skeleton height={20} width="55%" />
        <Skeleton height={16} width="90%" style={{ marginTop: 12 }} />
        <Skeleton height={16} width="80%" style={{ marginTop: 8 }} />
        <Skeleton height={16} width="70%" style={{ marginTop: 8 }} />
      </Card>
    );
  }

  if (!integrations) {
    return (
      <Card>
        <View style={styles.row}>
          <Icon name="alert-circle-outline" size={20} tone="danger" />
          <Text variant="body" weight="semibold" style={{ marginStart: 10, flex: 1 }}>
            تعذّر جلب حالة التكاملات
          </Text>
        </View>
        <Button
          label="إعادة المحاولة"
          icon="refresh-outline"
          variant="outline"
          size="sm"
          onPress={() => void refresh()}
          style={{ marginTop: theme.spacing.md }}
        />
      </Card>
    );
  }

  const billingOk = Boolean(integrations.billing?.configured);
  const embeddingsOk = Boolean(integrations.embeddings?.configured);
  const errorTrackingOk = Boolean(integrations.errorTracking?.configured);
  const browserOk = Boolean(integrations.browser?.cdpConfigured || integrations.browser?.localLaunch);

  return (
    <Card>
      <View style={styles.row}>
        <Icon name="git-network-outline" size={20} tone="primary" />
        <Text variant="subtitle" weight="bold" style={{ marginStart: 10, flex: 1 }}>
          التكاملات والموصلات
        </Text>
        <Button
          label="تحديث"
          icon="refresh-outline"
          variant="ghost"
          size="sm"
          loading={loading}
          onPress={() => void refresh()}
        />
      </View>

      {/* GitHub — OAuth + token, with real connect / disconnect actions */}
      <View style={{ marginTop: theme.spacing.md }}>
        <StateRow
          icon="logo-github"
          title="GitHub"
          detail={
            connection
              ? `مرتبط باسم ${connection.login}${connection.scope ? ` · الصلاحيات: ${connection.scope}` : ''}`
              : github?.configured
                ? github.tokenConfigured
                  ? 'مُهيأ عبر رمز وصول على الخادم (GITHUB_TOKEN).'
                  : 'مُهيأ عبر OAuth — لم يُربط حساب بعد.'
                : 'غير مُهيأ — اضبط GITHUB_TOKEN أو OAuth على الخادم.'
          }
          ok={Boolean(connection || github?.configured)}
          tone={connection ? 'success' : github?.configured ? 'info' : 'neutral'}
          statusLabel={connection ? 'مرتبط' : github?.configured ? 'مُهيأ' : 'غير مُهيأ'}
        />

        {github?.oauthConfigured ? (
          <View style={{ marginTop: theme.spacing.sm, marginStart: 28 }}>
            {connection ? (
              <Button
                label="فصل حساب GitHub"
                icon="unlink-outline"
                variant="outline"
                size="sm"
                loading={busy === 'github:disconnect'}
                onPress={() => void disconnect()}
              />
            ) : (
              <Button
                label="ربط حساب GitHub"
                icon="link-outline"
                size="sm"
                loading={busy === 'github:connect'}
                onPress={() => void connect()}
              />
            )}

            {oauthUrl && !connection ? (
              <View style={{ marginTop: theme.spacing.md }}>
                <Text variant="caption" tone="muted" numberOfLines={3} selectable>
                  {oauthUrl}
                </Text>
                <Input
                  label="رمز code من GitHub"
                  placeholder="الصق الرمز هنا"
                  value={code}
                  onChangeText={setCode}
                  autoCapitalize="none"
                  autoCorrect={false}
                  containerStyle={{ marginTop: theme.spacing.sm }}
                />
                <Button
                  label="إكمال الربط"
                  icon="checkmark-outline"
                  size="sm"
                  loading={busy === 'github:complete'}
                  disabled={!code.trim()}
                  onPress={() => void complete()}
                  style={{ marginTop: theme.spacing.sm }}
                />
              </View>
            ) : null}
          </View>
        ) : (
          <Text variant="caption" tone="subtle" style={{ marginTop: 4, marginStart: 28 }}>
            ربط الحساب عبر OAuth غير مُهيأ على الخادم (GITHUB_OAUTH_CLIENT_ID/SECRET).
          </Text>
        )}
      </View>

      <Divider />

      <StateRow
        icon="card-outline"
        title="الفوترة (Billing)"
        detail={connectorDetail(integrations.billing, 'مزود الفوترة غير مُهيأ — الاشتراكات المدفوعة معطّلة.')}
        ok={billingOk}
        tone={billingOk ? 'success' : 'neutral'}
        statusLabel={billingOk ? 'مُهيأ' : 'غير مُهيأ'}
      />

      <Divider />

      <StateRow
        icon="cube-outline"
        title="مخزن المتجهات (Embeddings)"
        detail={connectorDetail(integrations.embeddings, 'يعمل محليًا بمُضمِّن تجزئة (local-hash-v1).')}
        ok={embeddingsOk}
        tone={embeddingsOk ? 'success' : 'info'}
        statusLabel={embeddingsOk ? 'مُهيأ' : 'محلي'}
      />

      <Divider />

      <StateRow
        icon="bug-outline"
        title="تتبّع الأخطاء (Error tracking)"
        detail={connectorDetail(integrations.errorTracking, 'غير مُهيأ — الأخطاء تُسجَّل محليًا فقط.')}
        ok={errorTrackingOk}
        tone={errorTrackingOk ? 'success' : 'neutral'}
        statusLabel={errorTrackingOk ? 'مُهيأ' : 'غير مُهيأ'}
      />

      <Divider />

      <StateRow
        icon="globe-outline"
        title="متصفح التشغيل (Browser)"
        detail={
          integrations.browser?.cdpConfigured
            ? 'متصل عبر نقطة CDP خارجية (BROWSER_CDP_URL).'
            : integrations.browser?.localLaunch
              ? 'تشغيل محلي مُفعّل (BROWSER_LAUNCH_LOCAL).'
              : 'غير مُهيأ — اضبط BROWSER_CDP_URL أو BROWSER_LAUNCH_LOCAL.'
        }
        ok={browserOk}
        tone={browserOk ? 'success' : 'neutral'}
        statusLabel={browserOk ? 'مُهيأ' : 'غير مُهيأ'}
      />

      {/* Connector-gated tools (image / vision / calendar / email) */}
      {integrations.tools.unwired.length > 0 ? (
        <>
          <Divider />
          <View style={{ marginTop: theme.spacing.md }}>
            <View style={styles.row}>
              <Icon name="lock-closed-outline" size={16} tone="warning" />
              <Text variant="label" weight="semibold" style={{ marginStart: 8, flex: 1 }}>
                أدوات بانتظار اعتماد الموصلات
              </Text>
              <Badge label={String(integrations.tools.unwired.length)} tone="warning" />
            </View>
            <View style={[styles.chips, { marginTop: 6, marginStart: 24 }]}>
              {integrations.tools.unwired.map((id) => (
                <View
                  key={id}
                  style={[styles.pill, { backgroundColor: theme.colors.surfaceMuted, borderRadius: theme.radius.sm }]}
                >
                  <Text variant="caption" tone="muted" style={{ fontFamily: 'monospace' }}>
                    {id}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        </>
      ) : null}

      {notice ? (
        <View style={[styles.banner, { backgroundColor: theme.colors.successSoft, borderRadius: theme.radius.md, marginTop: theme.spacing.md }]}>
          <Icon name="checkmark-circle-outline" size={16} tone="success" />
          <Text variant="caption" tone="success" style={{ marginStart: 8, flex: 1 }}>
            {notice}
          </Text>
        </View>
      ) : null}
      {error ? (
        <View style={[styles.banner, { backgroundColor: theme.colors.dangerSoft, borderRadius: theme.radius.md, marginTop: theme.spacing.md }]}>
          <Icon name="alert-circle-outline" size={16} tone="danger" />
          <Text variant="caption" tone="danger" style={{ marginStart: 8, flex: 1 }}>
            {error}
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  chips: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  pill: { paddingVertical: 3, paddingHorizontal: 8 },
  banner: { flexDirection: 'row', alignItems: 'center', padding: 12 },
});
