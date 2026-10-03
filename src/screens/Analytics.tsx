import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTheme } from '../theme';
import { AppHeader } from '../components/composite/AppHeader';
import { SectionHeader } from '../components/composite/SectionHeader';
import { StatCard } from '../components/composite/StatCard';
import { ListRow } from '../components/composite/ListRow';
import { Card } from '../components/ui/Card';
import { Text } from '../components/ui/Text';
import { Button } from '../components/ui/Button';
import { Chip } from '../components/ui/Chip';
import { Badge } from '../components/ui/Badge';
import { Divider } from '../components/ui/Divider';
import { Progress } from '../components/ui/Progress';
import { DonutChart } from '../components/charts/DonutChart';
import { BarChart } from '../components/charts/BarChart';
import { Sparkline } from '../components/charts/Sparkline';
import { useAnalyticsStore, computeTotals } from '../store/useAnalyticsStore';
import { useAgentsStore } from '../store/useAgentsStore';
import { useStoreStore } from '../store/useStoreStore';
import { formatCompact, formatCurrency, formatNumber } from '../utils/format';
import { TaskStatus } from '../types/task';

const RANGES: { label: string; days: number }[] = [
  { label: '٧ أيام', days: 7 },
  { label: '١٤ يومًا', days: 14 },
  { label: '٣٠ يومًا', days: 30 },
];

const STATUS_META: Record<TaskStatus, { label: string; tone: 'neutral' | 'primary' | 'success' | 'danger' | 'warning' }> = {
  queued: { label: 'في الانتظار', tone: 'neutral' },
  planning: { label: 'يخطط', tone: 'primary' },
  running: { label: 'قيد التنفيذ', tone: 'primary' },
  paused: { label: 'متوقف مؤقتًا', tone: 'warning' },
  completed: { label: 'مكتمل', tone: 'success' },
  completed_with_warnings: { label: 'مكتمل بتحذيرات', tone: 'warning' },
  blocked: { label: 'محجوب', tone: 'danger' },
  unverified: { label: 'غير موثّق', tone: 'warning' },
  failed: { label: 'فشل', tone: 'danger' },
  cancelled: { label: 'ملغى', tone: 'neutral' },
};

function shortDate(iso: string): string {
  const parts = iso.split('-');
  return parts.length === 3 ? `${parts[2]}/${parts[1]}` : iso;
}

export function Analytics() {
  const theme = useTheme();
  const usage = useAnalyticsStore((s) => s.usage);
  const reset = useAnalyticsStore((s) => s.reset);
  const tasks = useAgentsStore((s) => s.tasks);
  const stats = useStoreStore((s) => s.stats);
  const [range, setRange] = React.useState(30);

  const slice = React.useMemo(() => usage.slice(-range), [usage, range]);
  const totals = React.useMemo(() => computeTotals(slice), [slice]);
  const prevTotals = React.useMemo(
    () => computeTotals(usage.slice(-range * 2, -range)),
    [usage, range],
  );

  const tokenBars = React.useMemo(() => slice.map((p) => p.tokens), [slice]);
  const costTrend = React.useMemo(() => slice.map((p) => p.costUsd), [slice]);
  const labels = React.useMemo(
    () => (range <= 14 ? slice.map((p) => shortDate(p.date)) : undefined),
    [slice, range],
  );

  const avgCost = slice.length ? totals.costUsd / slice.length : 0;
  const avgTokens = slice.length ? totals.tokens / slice.length : 0;
  const deltaPct = prevTotals.tokens
    ? Math.round(((totals.tokens - prevTotals.tokens) / prevTotals.tokens) * 100)
    : 0;

  const activitySegments = [
    { label: 'مهام', value: totals.tasks, color: theme.colors.primary },
    { label: 'رسائل', value: totals.messages, color: theme.colors.accent },
  ];

  const statusCounts = React.useMemo(() => {
    const counts: Record<string, number> = {};
    tasks.forEach((t) => {
      counts[t.status] = (counts[t.status] ?? 0) + 1;
    });
    return counts;
  }, [tasks]);

  const maxStatus = Math.max(1, ...Object.values(statusCounts));

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.lg,
          paddingTop: theme.spacing.lg,
          paddingBottom: theme.spacing['4xl'],
        }}
        showsVerticalScrollIndicator={false}
      >
        <AppHeader
          title="التحليلات والاستخدام"
          subtitle="رؤى الأداء والتكلفة والنشاط"
          right={
            <Button
              label="تصفير"
              icon="refresh-outline"
              size="sm"
              variant="ghost"
              onPress={() => void reset()}
            />
          }
        />

        <View style={styles.rangeRow}>
          {RANGES.map((r) => (
            <Chip
              key={r.days}
              label={r.label}
              selected={range === r.days}
              onPress={() => setRange(r.days)}
            />
          ))}
        </View>

        <View style={styles.statRow}>
          <StatCard
            label="إجمالي الرموز"
            value={formatCompact(totals.tokens)}
            icon="cube-outline"
            tone={theme.colors.primary}
            delta={deltaPct ? `${deltaPct > 0 ? '+' : ''}${deltaPct}%` : undefined}
          />
          <StatCard
            label="التكلفة"
            value={formatCurrency(totals.costUsd)}
            icon="cash-outline"
            tone={theme.colors.accent}
          />
        </View>
        <View style={[styles.statRow, { marginTop: theme.spacing.md }]}>
          <StatCard
            label="المهام"
            value={formatNumber(totals.tasks)}
            icon="rocket-outline"
            tone={theme.colors.highlight}
          />
          <StatCard
            label="الرسائل"
            value={formatNumber(totals.messages)}
            icon="chatbubbles-outline"
            tone={theme.colors.info}
          />
        </View>

        <Card style={{ marginTop: theme.spacing.lg }}>
          <SectionHeader
            title="استهلاك الرموز"
            subtitle={`متوسط ${formatCompact(Math.round(avgTokens))} / يوم`}
            icon="analytics-outline"
          />
          <BarChart data={tokenBars} labels={labels} height={140} color={theme.colors.primary} />
        </Card>

        <Card style={{ marginTop: theme.spacing.lg }}>
          <SectionHeader
            title="اتجاه التكلفة"
            subtitle={`متوسط ${formatCurrency(avgCost)} / يوم`}
            icon="trending-up-outline"
          />
          <Sparkline data={costTrend} width={300} height={64} color={theme.colors.accent} />
          <View style={styles.costFoot}>
            <Text variant="caption" tone="muted">
              الإجمالي
            </Text>
            <Text variant="subtitle" weight="bold">
              {formatCurrency(totals.costUsd)}
            </Text>
          </View>
        </Card>

        <Card style={{ marginTop: theme.spacing.lg }}>
          <SectionHeader title="مزيج النشاط" icon="pie-chart-outline" />
          <View style={styles.donutRow}>
            <DonutChart
              segments={activitySegments}
              size={150}
              thickness={18}
              centerLabel={formatNumber(totals.tasks + totals.messages)}
              centerSub="حدث"
            />
            <View style={styles.legend}>
              {activitySegments.map((seg) => (
                <View key={seg.label} style={styles.legendItem}>
                  <View style={[styles.dot, { backgroundColor: seg.color }]} />
                  <Text variant="caption" tone="muted" style={{ flex: 1 }}>
                    {seg.label}
                  </Text>
                  <Text variant="caption" weight="semibold">
                    {formatNumber(seg.value)}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        </Card>

        <Card style={{ marginTop: theme.spacing.lg }}>
          <SectionHeader
            title="توزيع حالات المهام"
            subtitle={`${formatNumber(tasks.length)} مهمة`}
            icon="git-branch-outline"
          />
          {tasks.length === 0 ? (
            <Text variant="body" tone="muted">
              لا توجد مهام بعد. ابدأ مهمة من شاشة الوكلاء.
            </Text>
          ) : (
            (Object.keys(STATUS_META) as TaskStatus[])
              .filter((s) => statusCounts[s])
              .map((s) => (
                <View key={s} style={styles.statusRow}>
                  <View style={styles.statusHead}>
                    <Badge label={STATUS_META[s].label} tone={STATUS_META[s].tone} />
                    <Text variant="caption" tone="muted">
                      {formatNumber(statusCounts[s])}
                    </Text>
                  </View>
                  <Progress
                    value={statusCounts[s] / maxStatus}
                    color={theme.colors.primary}
                    height={6}
                    style={{ marginTop: 6 }}
                  />
                </View>
              ))
          )}
        </Card>

        <Card padded={false} style={{ marginTop: theme.spacing.lg }}>
          <View style={{ padding: theme.spacing.lg, paddingBottom: 0 }}>
            <SectionHeader title="ملخص المتجر" icon="storefront-outline" />
          </View>
          <ListRow
            title="وكلاء مثبّتون"
            subtitle="من إجمالي الكتالوج"
            icon="download-outline"
            right={
              <Text variant="label" weight="semibold">
                {stats?.installed ?? 0}/{stats?.totalAgents ?? 0}
              </Text>
            }
          />
          <Divider spacing={0} style={{ marginHorizontal: theme.spacing.lg }} />
          <ListRow
            title="تحديثات متاحة"
            subtitle="وكلاء بحاجة إلى تحديث"
            icon="cloud-download-outline"
            right={
              <Badge
                label={String(stats?.updates ?? 0)}
                tone={(stats?.updates ?? 0) > 0 ? 'warning' : 'neutral'}
              />
            }
          />
          <Divider spacing={0} style={{ marginHorizontal: theme.spacing.lg }} />
          <ListRow
            title="متوسط التقييم"
            subtitle="عبر كل الوكلاء"
            icon="star-outline"
            right={
              <Text variant="label" weight="semibold">
                {(stats?.avgRating ?? 0).toFixed(2)} ★
              </Text>
            }
          />
          <Divider spacing={0} style={{ marginHorizontal: theme.spacing.lg }} />
          <ListRow
            title="الفئات"
            subtitle="تصنيفات المتجر"
            icon="grid-outline"
            right={
              <Text variant="label" weight="semibold">
                {stats?.categories ?? 0}
              </Text>
            }
          />
        </Card>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  rangeRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  statRow: { flexDirection: 'row', gap: 12 },
  donutRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  legend: { flex: 1, gap: 8 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  costFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
  statusRow: { marginBottom: 12 },
  statusHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
