import React from 'react';
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useTheme } from '../theme';
import { AppHeader } from '../components/composite/AppHeader';
import { SectionHeader } from '../components/composite/SectionHeader';
import { Card } from '../components/ui/Card';
import { Text } from '../components/ui/Text';
import { Badge } from '../components/ui/Badge';
import type { BadgeTone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Divider } from '../components/ui/Divider';
import { Icon } from '../components/ui/Icon';
import type { IconName } from '../components/ui/Icon';
import { Skeleton } from '../components/ui/Skeleton';
import { IntegrationsCard } from '../components/composite/IntegrationsCard';
import { backendApi } from '../services/api/client';
import type { ApiToolDetail } from '../services/api/client';
import { useSystemStatusStore } from '../store/useSystemStatusStore';
import { useOperationsStore } from '../store/useOperationsStore';

/**
 * Operations console — the human-in-the-loop surface for the self-improvement /
 * self-healing engine plus the REAL per-tool availability matrix.
 *
 * Every value shown here is read from the backend (`/self-improve/*`,
 * `/tools/status`); nothing is assumed. Sensitive changes (applying a patch) are
 * always gated behind an explicit owner/admin approval, and any applied change
 * can be rolled back. Read-only signal detection is available to every member,
 * but the mutating actions surface the exact backend error when the caller lacks
 * the required role.
 */

const PIPELINE: { icon: IconName; label: string }[] = [
  { icon: 'search-outline', label: 'كشف' },
  { icon: 'analytics-outline', label: 'تحليل' },
  { icon: 'git-branch-outline', label: 'تخطيط' },
  { icon: 'shield-checkmark-outline', label: 'تحقّق' },
  { icon: 'rocket-outline', label: 'تطبيق' },
  { icon: 'pulse-outline', label: 'مراقبة' },
  { icon: 'arrow-undo-outline', label: 'تراجع' },
];

const TOOL_STATE_META: Record<string, { label: string; tone: BadgeTone; icon: IconName }> = {
  live: { label: 'جاهز', tone: 'success', icon: 'checkmark-circle-outline' },
  partial: { label: 'جزئي', tone: 'warning', icon: 'hourglass-outline' },
  unwired: { label: 'غير مُهيأ', tone: 'neutral', icon: 'lock-closed-outline' },
  failed: { label: 'فاشل', tone: 'danger', icon: 'bug-outline' },
  catalogOnly: { label: 'كتالوج', tone: 'neutral', icon: 'list-outline' },
  simulated: { label: 'محاكاة', tone: 'info', icon: 'flask-outline' },
};

const PROPOSAL_STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  proposed: { label: 'بانتظار الموافقة', tone: 'warning' },
  applied: { label: 'مُطبّق', tone: 'success' },
  rejected: { label: 'مرفوض', tone: 'neutral' },
  rolled_back: { label: 'تم التراجع', tone: 'info' },
  regressed: { label: 'انحدار — تراجع تلقائي', tone: 'danger' },
};

const SEVERITY_META: Record<string, { label: string; tone: BadgeTone }> = {
  high: { label: 'خطورة عالية', tone: 'danger' },
  medium: { label: 'خطورة متوسطة', tone: 'warning' },
  low: { label: 'خطورة منخفضة', tone: 'neutral' },
};

function toolMeta(state: string) {
  return TOOL_STATE_META[state] ?? { label: state, tone: 'neutral' as BadgeTone, icon: 'help-circle-outline' as IconName };
}

function formatTime(value?: string | null): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('ar');
  } catch {
    return value;
  }
}

export function Operations() {
  const theme = useTheme();
  const tools = useSystemStatusStore((s) => s.tools);
  const refreshSystem = useSystemStatusStore((s) => s.refresh);

  const signals = useOperationsStore((s) => s.signals);
  const proposals = useOperationsStore((s) => s.proposals);
  const events = useOperationsStore((s) => s.events);
  const loading = useOperationsStore((s) => s.loading);
  const refreshing = useOperationsStore((s) => s.refreshing);
  const busy = useOperationsStore((s) => s.busy);
  const error = useOperationsStore((s) => s.error);
  const notice = useOperationsStore((s) => s.notice);
  const loadedAt = useOperationsStore((s) => s.loadedAt);
  const load = useOperationsStore((s) => s.load);
  const analyze = useOperationsStore((s) => s.analyze);
  const monitor = useOperationsStore((s) => s.monitor);
  const decide = useOperationsStore((s) => s.decide);

  React.useEffect(() => {
    void load('initial');
    if (!tools) void refreshSystem();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pendingProposals = proposals.filter((p) => p.status === 'proposed');
  const appliedProposals = proposals.filter((p) => p.status === 'applied' || p.status === 'regressed');
  const toolDetails: ApiToolDetail[] = tools?.tools ?? [];

  if (!backendApi.enabled) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }}>
          <AppHeader title="العمليات" subtitle="التحسين الذاتي وحالة الأدوات" />
          <Card>
            <View style={styles.row}>
              <Icon name="cloud-offline-outline" size={20} tone="muted" />
              <Text variant="body" tone="muted" style={{ marginStart: 10, flex: 1 }}>
                الخادم الخلفي غير مُهيأ في هذا الإصدار، لذا لا يمكن عرض لوحة العمليات الحقيقية.
              </Text>
            </View>
          </Card>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.lg,
          paddingTop: theme.spacing.lg,
          paddingBottom: theme.spacing['4xl'],
        }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load('refresh')}
            tintColor={theme.colors.primary}
          />
        }
      >
        <AppHeader title="العمليات" subtitle="التحسين الذاتي الآمن · حالة الأدوات · المراقبة" />

        {/* Self-healing pipeline explainer */}
        <Card>
          <View style={styles.row}>
            <Icon name="sparkles-outline" size={20} tone="primary" />
            <Text variant="subtitle" weight="bold" style={{ marginStart: 10, flex: 1 }}>
              دورة التحسين الذاتي
            </Text>
          </View>
          <Text variant="caption" tone="muted" style={{ marginTop: theme.spacing.sm }}>
            يكتشف النظام أخطاء التشغيل المتكررة، يحللها، يقترح إصلاحًا محدودًا وآمنًا، ثم يتطلب موافقة بشرية قبل
            التطبيق. تُراقَب كل تعديلات مُطبّقة ويتم التراجع التلقائي عند تكرار الخطأ الأصلي. لا يمكن لأي إصلاح
            تجاوز الأمان أو عزل المستأجرين.
          </Text>
          <View style={[styles.pipeline, { marginTop: theme.spacing.md }]}>
            {PIPELINE.map((step, index) => (
              <React.Fragment key={step.label}>
                <View style={styles.pipelineStep}>
                  <View
                    style={[
                      styles.pipelineDot,
                      { backgroundColor: theme.colors.primarySoft, borderRadius: theme.radius.pill },
                    ]}
                  >
                    <Icon name={step.icon} size={16} tone="primary" />
                  </View>
                  <Text variant="caption" tone="muted" style={{ marginTop: 4 }}>
                    {step.label}
                  </Text>
                </View>
                {index < PIPELINE.length - 1 ? (
                  <View style={{ marginTop: -14 }}>
                    <Icon name="chevron-back-outline" size={14} tone="subtle" />
                  </View>
                ) : null}
              </React.Fragment>
            ))}
          </View>
        </Card>

        {/* Action bar */}
        <View style={[styles.row, { marginTop: theme.spacing.lg, gap: 8 }]}>
          <Button
            label="تحليل الأخطاء"
            icon="analytics-outline"
            size="sm"
            loading={busy === 'analyze'}
            onPress={() => void analyze()}
            style={{ flex: 1 }}
          />
          <Button
            label="مراقبة وتراجع"
            icon="pulse-outline"
            variant="outline"
            size="sm"
            loading={busy === 'monitor'}
            onPress={() => void monitor()}
            style={{ flex: 1 }}
          />
          <Button
            label="تحديث"
            icon="refresh-outline"
            variant="ghost"
            size="sm"
            loading={loading}
            onPress={() => void load('refresh')}
          />
        </View>

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

        {/* Signals */}
        <SectionHeader
          title="الإشارات المكتشفة"
          subtitle="أخطاء تشغيل متكررة خلال النافذة الزمنية"
          icon="warning-outline"
          style={{ marginTop: theme.spacing.xl }}
        />
        {loading && signals.length === 0 ? (
          <Card>
            <Skeleton height={18} width="70%" />
            <Skeleton height={14} width="90%" style={{ marginTop: 10 }} />
            <Skeleton height={14} width="60%" style={{ marginTop: 8 }} />
          </Card>
        ) : signals.length === 0 ? (
          <Card>
            <View style={styles.row}>
              <Icon name="checkmark-done-outline" size={18} tone="success" />
              <Text variant="body" tone="muted" style={{ marginStart: 10, flex: 1 }}>
                لا توجد إشارات أخطاء متكررة. النظام يعمل ضمن الحدود الطبيعية.
              </Text>
            </View>
          </Card>
        ) : (
          <Card padded={false}>
            {signals.map((signal, index) => (
              <React.Fragment key={signal.signature}>
                {index > 0 ? <Divider spacing={0} style={{ marginHorizontal: theme.spacing.lg }} /> : null}
                <View style={{ padding: theme.spacing.lg }}>
                  <View style={styles.row}>
                    <Icon name="alert-circle-outline" size={18} tone="warning" />
                    <Text variant="label" weight="semibold" style={{ marginStart: 10, flex: 1 }}>
                      {signal.category} · {signal.signature}
                    </Text>
                    <Badge label={`${signal.occurrences}×`} tone="warning" />
                  </View>
                  {signal.samples?.slice(0, 2).map((sample, sampleIndex) => (
                    <Text
                      key={sampleIndex}
                      variant="caption"
                      tone="subtle"
                      numberOfLines={2}
                      style={{ marginTop: 6, marginStart: 28, fontFamily: 'monospace' }}
                    >
                      {sample.error ?? sample.toolId ?? sample.runId ?? '—'}
                    </Text>
                  ))}
                </View>
              </React.Fragment>
            ))}
          </Card>
        )}

        {/* Proposals */}
        <SectionHeader
          title="مقترحات التحسين"
          subtitle={`${pendingProposals.length} بانتظار الموافقة · ${appliedProposals.length} مُطبّقة`}
          icon="git-branch-outline"
          style={{ marginTop: theme.spacing.xl }}
        />
        {proposals.length === 0 ? (
          <Card>
            <Text variant="body" tone="muted">
              لا توجد مقترحات بعد. اضغط «تحليل الأخطاء» لفحص الإشارات وإنشاء مقترحات إصلاح محدودة.
            </Text>
          </Card>
        ) : (
          proposals.map((proposal) => {
            const statusMeta = PROPOSAL_STATUS_META[proposal.status] ?? { label: proposal.status, tone: 'neutral' as BadgeTone };
            const severityMeta = SEVERITY_META[proposal.severity] ?? { label: proposal.severity, tone: 'neutral' as BadgeTone };
            const canApprove = proposal.status === 'proposed';
            const canRollback = proposal.status === 'applied' || proposal.status === 'regressed';
            return (
              <Card key={proposal.id} style={{ marginBottom: theme.spacing.md }}>
                <View style={styles.row}>
                  <Icon name="build-outline" size={18} tone="primary" />
                  <Text variant="label" weight="semibold" style={{ marginStart: 10, flex: 1 }}>
                    {proposal.title}
                  </Text>
                  <Badge label={statusMeta.label} tone={statusMeta.tone} />
                </View>
                <View style={[styles.row, { marginTop: 8, gap: 6, flexWrap: 'wrap' }]}>
                  <Badge label={severityMeta.label} tone={severityMeta.tone} />
                  <Badge label={`النوع: ${proposal.kind}`} tone="neutral" />
                  <Badge label={`${proposal.occurrences} تكرار`} tone="neutral" />
                </View>
                <Text variant="caption" tone="muted" style={{ marginTop: theme.spacing.sm }}>
                  {proposal.rationale}
                </Text>
                <View
                  style={[
                    styles.patchBox,
                    { backgroundColor: theme.colors.surfaceMuted, borderRadius: theme.radius.md, marginTop: theme.spacing.sm },
                  ]}
                >
                  <Text variant="caption" tone="subtle" style={{ fontFamily: 'monospace' }}>
                    {JSON.stringify(proposal.patch)}
                  </Text>
                </View>
                <Text variant="caption" tone="subtle" style={{ marginTop: 6 }}>
                  أُنشئ: {formatTime(proposal.createdAt)}
                  {proposal.appliedAt ? ` · طُبّق: ${formatTime(proposal.appliedAt)}` : ''}
                  {proposal.rolledBackAt ? ` · تراجع: ${formatTime(proposal.rolledBackAt)}` : ''}
                </Text>
                <View style={[styles.row, { marginTop: theme.spacing.md, gap: 8 }]}>
                  {canApprove ? (
                    <>
                      <Button
                        label="موافقة وتطبيق"
                        icon="checkmark-outline"
                        size="sm"
                        loading={busy === `approve:${proposal.id}`}
                        onPress={() => void decide('approve', proposal.id)}
                        style={{ flex: 1 }}
                      />
                      <Button
                        label="رفض"
                        icon="close-outline"
                        variant="outline"
                        size="sm"
                        loading={busy === `reject:${proposal.id}`}
                        onPress={() => void decide('reject', proposal.id)}
                        style={{ flex: 1 }}
                      />
                    </>
                  ) : null}
                  {canRollback ? (
                    <Button
                      label="تراجع"
                      icon="arrow-undo-outline"
                      variant="outline"
                      size="sm"
                      loading={busy === `rollback:${proposal.id}`}
                      onPress={() => void decide('rollback', proposal.id)}
                      style={{ flex: 1 }}
                    />
                  ) : null}
                  {!canApprove && !canRollback ? (
                    <Text variant="caption" tone="subtle">
                      لا توجد إجراءات متاحة لهذه الحالة.
                    </Text>
                  ) : null}
                </View>
              </Card>
            );
          })
        )}

        {/* Tool availability matrix */}
        <SectionHeader
          title="حالة الأدوات (Live / Partial / Unwired / Failed)"
          subtitle="تُقرأ مباشرة من الخادم — كل أداة بحالتها الفعلية وسببها"
          icon="construct-outline"
          style={{ marginTop: theme.spacing.xl }}
        />
        {toolDetails.length === 0 ? (
          <Card>
            <Text variant="body" tone="muted">
              لا تتوفر بيانات تفصيلية للأدوات بعد. اضغط تحديث لإعادة القراءة من الخادم.
            </Text>
          </Card>
        ) : (
          <Card padded={false}>
            {toolDetails.map((tool, index) => {
              const meta = toolMeta(tool.state);
              return (
                <React.Fragment key={tool.id}>
                  {index > 0 ? <Divider spacing={0} style={{ marginHorizontal: theme.spacing.lg }} /> : null}
                  <View style={[styles.row, { padding: theme.spacing.lg }]}>
                    <Icon name={meta.icon} size={18} color={theme.colors.textMuted} />
                    <View style={{ flex: 1, marginStart: 10 }}>
                      <Text variant="label" weight="semibold" style={{ fontFamily: 'monospace' }}>
                        {tool.id}
                      </Text>
                      {tool.reason ? (
                        <Text variant="caption" tone="muted" numberOfLines={2}>
                          {tool.reason}
                        </Text>
                      ) : null}
                    </View>
                    <Badge label={meta.label} tone={meta.tone} />
                  </View>
                </React.Fragment>
              );
            })}
          </Card>
        )}

        {/* Integrations / connectors — honest live state + GitHub actions */}
        <SectionHeader
          title="التكاملات والموصلات"
          subtitle="GitHub · الفوترة · مخزن المتجهات · تتبّع الأخطاء · المتصفح — تُقرأ مباشرة من الخادم"
          icon="git-network-outline"
          style={{ marginTop: theme.spacing.xl }}
        />
        <IntegrationsCard />

        {/* History / audit trail */}
        <SectionHeader
          title="سجل التحسين الذاتي"
          subtitle="كل مرحلة (كشف · تخطيط · تحقّق · تطبيق · تراجع) موثّقة"
          icon="time-outline"
          style={{ marginTop: theme.spacing.xl }}
        />
        {events.length === 0 ? (
          <Card>
            <Text variant="body" tone="muted">
              لا توجد أحداث مسجّلة بعد.
            </Text>
          </Card>
        ) : (
          <Card padded={false}>
            {events.slice(0, 25).map((event, index) => (
              <React.Fragment key={event.id}>
                {index > 0 ? <Divider spacing={0} style={{ marginHorizontal: theme.spacing.lg }} /> : null}
                <View style={[styles.row, { padding: theme.spacing.md, paddingHorizontal: theme.spacing.lg }]}>
                  <Badge label={event.phase} tone="primary" />
                  <Text variant="caption" tone="muted" numberOfLines={1} style={{ flex: 1, marginStart: 10 }}>
                    {JSON.stringify(event.detail)}
                  </Text>
                  <Text variant="caption" tone="subtle" style={{ marginStart: 8 }}>
                    {formatTime(event.createdAt)}
                  </Text>
                </View>
              </React.Fragment>
            ))}
          </Card>
        )}

        <Text variant="caption" tone="subtle" align="center" style={{ marginTop: theme.spacing.xl }}>
          {loadedAt ? `آخر تحديث: ${formatTime(loadedAt)}` : ''}
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  pipeline: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pipelineStep: { alignItems: 'center', flex: 1 },
  pipelineDot: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  banner: { flexDirection: 'row', alignItems: 'center', padding: 12 },
  patchBox: { padding: 10 },
});
