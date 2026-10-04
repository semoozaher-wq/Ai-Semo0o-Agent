import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../theme';
import { Card } from '../ui/Card';
import { Text } from '../ui/Text';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Divider } from '../ui/Divider';
import { Icon, IconName } from '../ui/Icon';
import { Skeleton } from '../ui/Skeleton';
import { useSystemStatusStore } from '../../store/useSystemStatusStore';
import { backendApi } from '../../services/api/client';

/**
 * Surfaces the REAL backend status of every capability, provider and the billing
 * integration. A capability that is not configured is shown as «غير مُهيأ» with the
 * exact tool id, so an operator never mistakes an unavailable feature for a ready
 * one. All values come from `/tools/status`, `/models/status`, `/billing/status`
 * and `/ready`; nothing is assumed.
 */
function CheckRow({ label, ok, detail }: { label: string; ok: boolean; detail?: string }) {
  const theme = useTheme();
  return (
    <View style={styles.row}>
      <Icon
        name={ok ? 'checkmark-circle' : 'close-circle'}
        size={18}
        color={ok ? theme.colors.success : theme.colors.danger}
      />
      <View style={{ flex: 1, marginStart: 10 }}>
        <Text variant="label" weight="semibold">
          {label}
        </Text>
        {detail ? (
          <Text variant="caption" tone="muted">
            {detail}
          </Text>
        ) : null}
      </View>
      <Badge label={ok ? 'سليم' : 'خلل'} tone={ok ? 'success' : 'danger'} />
    </View>
  );
}

function CapabilityGroup({
  icon,
  title,
  tone,
  ids,
  emptyLabel,
}: {
  icon: IconName;
  title: string;
  tone: 'success' | 'warning' | 'danger' | 'neutral';
  ids: string[];
  emptyLabel: string;
}) {
  const theme = useTheme();
  const toneColor: Record<string, string> = {
    success: theme.colors.success,
    warning: theme.colors.warning,
    danger: theme.colors.danger,
    neutral: theme.colors.textMuted,
  };
  return (
    <View style={{ marginTop: theme.spacing.md }}>
      <View style={styles.row}>
        <Icon name={icon} size={16} color={toneColor[tone]} />
        <Text variant="label" weight="semibold" style={{ marginStart: 8, flex: 1 }}>
          {title}
        </Text>
        <Badge label={String(ids.length)} tone={tone === 'neutral' ? 'neutral' : tone} />
      </View>
      {ids.length === 0 ? (
        <Text variant="caption" tone="muted" style={{ marginTop: 4, marginStart: 24 }}>
          {emptyLabel}
        </Text>
      ) : (
        <View style={[styles.chips, { marginTop: 6, marginStart: 24 }]}>
          {ids.map((id) => (
            <View
              key={id}
              style={[
                styles.pill,
                { backgroundColor: theme.colors.surfaceMuted, borderRadius: theme.radius.sm },
              ]}
            >
              <Text variant="caption" tone="muted" style={{ fontFamily: 'monospace' }}>
                {id}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

export function SystemStatusCard() {
  const theme = useTheme();
  const { tools, models, billing, ready, readyStatus, loading, error, loadedAt, refresh } =
    useSystemStatusStore();

  React.useEffect(() => {
    if (!tools && !error && !loading) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!backendApi.enabled) {
    return (
      <Card>
        <View style={styles.row}>
          <Icon name="cloud-offline-outline" size={20} tone="muted" />
          <Text variant="body" tone="muted" style={{ marginStart: 10, flex: 1 }}>
            الخادم الخلفي غير مُهيأ في هذا الإصدار، لذا لا يمكن عرض حالة القدرات الحقيقية.
          </Text>
        </View>
      </Card>
    );
  }

  if (loading && !tools) {
    return (
      <Card>
        <Skeleton height={20} width="60%" />
        <Skeleton height={16} width="90%" style={{ marginTop: 12 }} />
        <Skeleton height={16} width="80%" style={{ marginTop: 8 }} />
        <Skeleton height={16} width="70%" style={{ marginTop: 8 }} />
      </Card>
    );
  }

  if (error && !tools) {
    return (
      <Card>
        <View style={styles.row}>
          <Icon name="alert-circle-outline" size={20} tone="danger" />
          <Text variant="body" weight="semibold" style={{ marginStart: 10, flex: 1 }}>
            تعذّر جلب حالة النظام
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
          onPress={() => void refresh()}
          style={{ marginTop: theme.spacing.md }}
        />
      </Card>
    );
  }

  const summary = tools?.summary;
  const providers = models?.providers ?? [];
  const configuredProviders = providers.filter((p) => p.configured);
  const readyOk = ready?.ok ?? false;
  const readyLabel = readyStatus === null ? 'غير معروف' : readyOk ? 'جاهز' : 'غير جاهز';
  const readyTone = readyStatus === null ? 'neutral' : readyOk ? 'success' : 'danger';

  return (
    <Card>
      <View style={styles.row}>
        <Icon name="server-outline" size={20} tone="primary" />
        <Text variant="subtitle" weight="bold" style={{ marginStart: 10, flex: 1 }}>
          حالة النظام والقدرات
        </Text>
        <Badge label={readyLabel} tone={readyTone as 'success' | 'danger' | 'neutral'} />
      </View>

      {ready?.checks ? (
        <View style={{ marginTop: theme.spacing.md }}>
          <CheckRow
            label="قاعدة البيانات"
            ok={ready.checks.database?.ok ?? false}
            detail="اتصال فعلي واستعلام اختبار"
          />
          <Divider spacing={0} />
          <CheckRow
            label="مساحة العمل"
            ok={ready.checks.workspace?.ok ?? false}
            detail={ready.checks.workspace?.configured === false ? 'غير مُقيّدة (وضع تطوير)' : 'قابلة للكتابة'}
          />
          <Divider spacing={0} />
          <CheckRow
            label="مزودو الذكاء الاصطناعي"
            ok={ready.checks.providers?.ok ?? false}
            detail={`${ready.checks.providers?.configured ?? 0} مُهيأ من ${ready.checks.providers?.total ?? providers.length}`}
          />
        </View>
      ) : null}

      {/* Providers — real configured/healthy state */}
      <View style={{ marginTop: theme.spacing.lg }}>
        <Text variant="label" weight="semibold">
          مزودو الذكاء الاصطناعي
        </Text>
        {providers.length === 0 ? (
          <Text variant="caption" tone="muted" style={{ marginTop: 4 }}>
            لا يوجد مزود مُهيأ على الخادم. اضبط مفتاحًا بيئيًا (OPENAI/GEMINI/ANTHROPIC) ثم أعد التشغيل.
          </Text>
        ) : (
          <View style={[styles.chips, { marginTop: 6 }]}>
            {providers.map((provider, index) => {
              const ok = provider.configured && provider.healthy !== false;
              return (
                <Badge
                  key={provider.id ?? provider.name ?? index}
                  label={`${provider.name ?? provider.id ?? 'مزود'} · ${ok ? 'متاح' : 'غير مُهيأ'}`}
                  tone={ok ? 'success' : 'neutral'}
                />
              );
            })}
          </View>
        )}
        <Text variant="caption" tone="muted" style={{ marginTop: 6 }}>
          {configuredProviders.length} مزود مُهيأ من {providers.length}
        </Text>
      </View>

      {/* Capabilities — real live vs unwired */}
      <View style={{ marginTop: theme.spacing.lg }}>
        <Text variant="label" weight="semibold">
          القدرات (Tools)
        </Text>
        {tools ? (
          <>
            <CapabilityGroup
              icon="flash-outline"
              title="جاهزة للتشغيل"
              tone="success"
              ids={tools.live ?? []}
              emptyLabel="لا توجد أدوات جاهزة."
            />
            <CapabilityGroup
              icon="lock-closed-outline"
              title="غير مُهيأة (تتطلب بيانات اعتماد)"
              tone="warning"
              ids={tools.unwired ?? []}
              emptyLabel="كل الأدوات مُهيأة."
            />
            {summary ? (
              <Text variant="caption" tone="muted" style={{ marginTop: theme.spacing.md }}>
                الإجمالي: {summary.live} جاهزة · {summary.unwired} غير مُهيأة · {summary.dangerous} تتطلب موافقة
              </Text>
            ) : null}
          </>
        ) : (
          <Text variant="caption" tone="muted" style={{ marginTop: 4 }}>
            لا تتوفر بيانات الأدوات.
          </Text>
        )}
      </View>

      {/* Billing — real provider state */}
      <View style={{ marginTop: theme.spacing.lg }}>
        <Text variant="label" weight="semibold">
          الفوترة
        </Text>
        <View style={[styles.row, { marginTop: 6 }]}>
          <Icon
            name={billing?.configured ? 'card-outline' : 'card-outline'}
            size={16}
            color={billing?.configured ? theme.colors.success : theme.colors.textMuted}
          />
          <Text variant="caption" tone="muted" style={{ marginStart: 8, flex: 1 }}>
            {billing?.configured
              ? `مزود الفوترة مُهيأ (${billing.provider ?? 'stripe'}) · الخطة: ${billing.plan ?? 'free'}`
              : 'مزود الفوترة غير مُهيأ — الاشتراكات المدفوعة معطّلة.'}
          </Text>
          <Badge
            label={billing?.configured ? 'مُهيأ' : 'غير مُهيأ'}
            tone={billing?.configured ? 'success' : 'neutral'}
          />
        </View>
      </View>

      <View style={[styles.row, { marginTop: theme.spacing.lg }]}>
        <Text variant="caption" tone="subtle" style={{ flex: 1 }}>
          {loadedAt ? `آخر تحديث: ${new Date(loadedAt).toLocaleTimeString('ar')}` : ''}
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
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  chips: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  pill: { paddingVertical: 3, paddingHorizontal: 8 },
});
