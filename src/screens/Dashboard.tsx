import React from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme, useThemeController } from '../theme';
import {
  AppHeader,
  SectionHeader,
  StatCard,
  AgentCard,
  EmptyState,
  ListRow,
} from '../components/composite';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Gradient } from '../components/ui/Gradient';
import { Icon } from '../components/ui/Icon';
import { Screen } from '../components/ui/Screen';
import { Text } from '../components/ui/Text';
import { Chip } from '../components/ui/Chip';
import { Sparkline } from '../components/charts/Sparkline';
import { useAppStore } from '../store/useAppStore';
import { useAgentsStore } from '../store/useAgentsStore';
import { useStoreStore } from '../store/useStoreStore';
import { useFilesStore } from '../store/useFilesStore';
import { useAnalyticsStore, computeTotals } from '../store/useAnalyticsStore';
import { useChatStore } from '../store/useChatStore';
import { QUICK_ACTIONS } from '../data/quickActions';
import { featuredAgents } from '../data/agents';
import { getModel, getProvider } from '../data/models';
import { formatCompact, formatNumber } from '../utils/format';

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'صباح الخير';
  if (h < 17) return 'مساء الخير';
  return 'مساء الخير';
}

export function Dashboard() {
  const theme = useTheme();
  const { toggleMode, mode } = useThemeController();
  const router = useRouter();

  const settings = useAppStore((s) => s.settings);
  const tasks = useAgentsStore((s) => s.tasks);
  const installed = useStoreStore((s) => s.installed);
  const files = useFilesStore((s) => s.files);
  const report = useFilesStore((s) => s.report);
  const usage = useAnalyticsStore((s) => s.usage);
  const send = useChatStore((s) => s.send);
  const newConversation = useChatStore((s) => s.newConversation);

  const totals = computeTotals(usage);
  const model = getModel(settings.activeModel);
  const provider = model ? getProvider(model.provider) : undefined;

  const completedTasks = tasks.filter((t) => t.status === 'completed').length;
  const runningTask = tasks.find((t) => t.status === 'running' || t.status === 'planning');

  const trend = usage.slice(-14).map((p) => p.tokens);

  const startChat = (prompt?: string) => {
    if (!newConversation()) return;
    if (prompt) void send(prompt);
    router.push('/chat');
  };

  const featured = featuredAgents().slice(0, 6);

  return (
    <Screen padded={false}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
      >
        {/* ----------------------------- header ----------------------------- */}
        <View style={{ paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.sm }}>
          <AppHeader
            title={`${greeting()} 👋`}
            subtitle="مركز قيادة Semo0o AI"
            right={
              <>
                <Pressable onPress={toggleMode} style={styles.iconBtn}>
                  <Icon
                    name={mode === 'dark' ? 'sunny-outline' : 'moon-outline'}
                    size={20}
                    tone="muted"
                  />
                </Pressable>
                <Pressable onPress={() => router.push('/settings')} style={styles.iconBtn}>
                  <Icon name="settings-outline" size={20} tone="muted" />
                </Pressable>
              </>
            }
          />
        </View>

        {/* ------------------------------ hero ------------------------------ */}
        <View style={{ paddingHorizontal: theme.spacing.lg }}>
          <Card padded={false} bordered={false} style={styles.hero}>
            <Gradient name="aurora" radius={theme.radius.xl} style={styles.heroGrad}>
              <View style={styles.heroInner}>
                <View style={styles.heroTop}>
                  <View style={styles.heroBadge}>
                    <Icon name="sparkles" size={14} color="#FFFFFF" />
                    <Text
                      weight="semibold"
                      style={{ color: '#FFFFFF', marginStart: 6, fontSize: theme.fontSize.sm }}
                    >
                      منصة ذكاء اصطناعي مستقلة
                    </Text>
                  </View>
                </View>

                <Text
                  weight="extrabold"
                  style={{ color: '#FFFFFF', fontSize: theme.fontSize['3xl'], marginTop: 14 }}
                >
                  ماذا نبني اليوم؟
                </Text>
                <Text
                  style={{
                    color: 'rgba(255,255,255,0.85)',
                    fontSize: theme.fontSize.md,
                    marginTop: 6,
                    lineHeight: 22,
                  }}
                >
                  شغّل وكلاء أذكياء لتنفيذ المهام المعقّدة تلقائيًا — بحث، برمجة، تحليل بيانات، وتقارير.
                </Text>

                <View style={styles.heroActions}>
                  <Button
                    label="ابدأ مهمة"
                    icon="flash"
                    variant="secondary"
                    onPress={() => router.push('/agents')}
                    style={{ backgroundColor: '#FFFFFF' }}
                  />
                  <Button
                    label="محادثة جديدة"
                    icon="chatbubbles-outline"
                    variant="ghost"
                    onPress={() => startChat()}
                  />
                </View>

                {provider && model ? (
                  <View style={styles.heroModel}>
                    <View style={[styles.dot, { backgroundColor: provider.accent }]} />
                    <Text style={{ color: 'rgba(255,255,255,0.9)', fontSize: theme.fontSize.sm }}>
                      النموذج النشط: {model.name}
                    </Text>
                  </View>
                ) : null}
              </View>
            </Gradient>
          </Card>
        </View>

        {/* ------------------------------ stats ----------------------------- */}
        <View style={[styles.statsRow, { paddingHorizontal: theme.spacing.lg, marginTop: theme.spacing.lg }]}>
          <StatCard
            label="مهام مكتملة"
            value={formatNumber(completedTasks)}
            icon="checkmark-done-circle-outline"
            tone={theme.colors.success}
          />
          <StatCard
            label="رموز مستهلكة"
            value={formatCompact(totals.tokens)}
            icon="pulse-outline"
            tone={theme.colors.accent}
            trend={trend}
          />
        </View>
        <View style={[styles.statsRow, { paddingHorizontal: theme.spacing.lg, marginTop: theme.spacing.md }]}>
          <StatCard
            label="وكلاء مثبّتون"
            value={formatNumber(installed.length)}
            icon="grid-outline"
            tone={theme.colors.highlight}
            onPress={() => router.push('/store')}
          />
          <StatCard
            label="ملفات مفحوصة"
            value={formatNumber(files.length)}
            icon="folder-open-outline"
            tone={theme.colors.warning}
            onPress={() => router.push('/files')}
          />
        </View>

        {/* -------------------------- quick actions ------------------------- */}
        <View style={{ marginTop: theme.spacing['2xl'] }}>
          <View style={{ paddingHorizontal: theme.spacing.lg }}>
            <SectionHeader title="إجراءات سريعة" icon="flash-outline" subtitle="ابدأ بضغطة واحدة" />
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: theme.spacing.lg, gap: 10 }}
          >
            {QUICK_ACTIONS.map((qa) => (
              <Pressable key={qa.id} onPress={() => startChat(qa.prompt)}>
                <Card padded={false} style={styles.quickCard}>
                  <View
                    style={[
                      styles.quickIcon,
                      { backgroundColor: theme.colors.primarySoft, borderRadius: theme.radius.lg },
                    ]}
                  >
                    <Icon name={qa.icon as never} size={20} tone="primary" />
                  </View>
                  <Text variant="label" weight="semibold" style={{ marginTop: 10 }}>
                    {qa.labelAr}
                  </Text>
                </Card>
              </Pressable>
            ))}
          </ScrollView>
        </View>

        {/* --------------------------- running task ------------------------- */}
        {runningTask ? (
          <View style={{ paddingHorizontal: theme.spacing.lg, marginTop: theme.spacing['2xl'] }}>
            <SectionHeader title="قيد التنفيذ الآن" icon="sync-outline" />
            <Card onPress={() => router.push('/agents')} accent={theme.colors.accent}>
              <View style={styles.rowBetween}>
                <View style={{ flex: 1 }}>
                  <Text variant="body" weight="semibold" numberOfLines={1}>
                    {runningTask.title}
                  </Text>
                  <Text variant="caption" tone="muted" numberOfLines={1} style={{ marginTop: 2 }}>
                    {runningTask.goal}
                  </Text>
                </View>
                <Badge label={`${Math.round(runningTask.progress * 100)}%`} tone="accent" />
              </View>
            </Card>
          </View>
        ) : null}

        {/* ------------------------- featured agents ------------------------ */}
        <View style={{ marginTop: theme.spacing['2xl'] }}>
          <View style={{ paddingHorizontal: theme.spacing.lg }}>
            <SectionHeader
              title="وكلاء مميّزون"
              icon="star-outline"
              actionLabel="المتجر"
              onAction={() => router.push('/store')}
            />
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: theme.spacing.lg, gap: 12 }}
          >
            {featured.map((agent) => (
              <View key={agent.id} style={{ width: 280 }}>
                <AgentCard
                  agent={agent}
                  onPress={() => router.push(`/agent/${agent.id}`)}
                  onInstall={() => router.push(`/agent/${agent.id}`)}
                />
              </View>
            ))}
          </ScrollView>
        </View>

        {/* ---------------------------- activity ---------------------------- */}
        <View style={{ paddingHorizontal: theme.spacing.lg, marginTop: theme.spacing['2xl'] }}>
          <SectionHeader
            title="النشاط"
            icon="analytics-outline"
            actionLabel="التحليلات"
            onAction={() => router.push('/analytics')}
          />
          <Card>
            <View style={styles.rowBetween}>
              <View>
                <Text variant="caption" tone="muted">
                  آخر 14 يومًا
                </Text>
                <Text variant="title" weight="extrabold">
                  {formatCompact(totals.tokens)} رمز
                </Text>
              </View>
              <Badge label={`$${totals.costUsd.toFixed(2)}`} tone="success" />
            </View>
            <View style={{ marginTop: theme.spacing.md, alignItems: 'center' }}>
              <Sparkline data={trend} width={320} height={64} color={theme.colors.primary} />
            </View>
          </Card>
        </View>

        {/* --------------------------- recent tasks ------------------------- */}
        <View style={{ paddingHorizontal: theme.spacing.lg, marginTop: theme.spacing['2xl'] }}>
          <SectionHeader
            title="أحدث المهام"
            icon="list-outline"
            actionLabel="الكل"
            onAction={() => router.push('/agents')}
          />
          <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
            {tasks.length === 0 ? (
              <EmptyState
                icon="flash-outline"
                title="لا توجد مهام بعد"
                description="أنشئ مهمة وسيقوم الوكيل الذاتي بالتخطيط والتنفيذ والتحقق تلقائيًا."
                actionLabel="إنشاء مهمة"
                onAction={() => router.push('/agents')}
              />
            ) : (
              tasks.slice(0, 4).map((task, index) => (
                <View key={task.id}>
                  {index > 0 ? <View style={[styles.divider, { backgroundColor: theme.colors.border }]} /> : null}
                  <ListRow
                    title={task.title}
                    subtitle={`${task.steps.length} خطوات · ${task.model}`}
                    icon={
                      task.status === 'completed'
                        ? 'checkmark-circle'
                        : task.status === 'running'
                          ? 'sync'
                          : task.status === 'failed'
                            ? 'alert-circle'
                            : 'time-outline'
                    }
                    iconColor={
                      task.status === 'completed'
                        ? theme.colors.success
                        : task.status === 'running'
                          ? theme.colors.accent
                          : task.status === 'failed'
                            ? theme.colors.danger
                            : theme.colors.textMuted
                    }
                    onPress={() => router.push('/agents')}
                    showChevron
                  />
                </View>
              ))
            )}
          </Card>
        </View>

        {/* --------------------------- health card -------------------------- */}
        {report ? (
          <View style={{ paddingHorizontal: theme.spacing.lg, marginTop: theme.spacing['2xl'] }}>
            <SectionHeader title="سلامة مساحة العمل" icon="shield-checkmark-outline" />
            <Card onPress={() => router.push('/files')}>
              <View style={styles.rowBetween}>
                <View style={{ flex: 1 }}>
                  <Text variant="subtitle" weight="bold">
                    {report.filesScanned} ملفًا · {report.healthScore}/100
                  </Text>
                  <Text variant="caption" tone="muted" style={{ marginTop: 4 }}>
                    {report.findings.length} ملاحظة · {report.duplicates} تكرار · {report.largeFiles} ملف كبير
                  </Text>
                </View>
                <Chip
                  label={report.healthScore >= 85 ? 'ممتاز' : report.healthScore >= 65 ? 'جيد' : 'يحتاج مراجعة'}
                  tone={report.healthScore >= 85 ? 'accent' : 'highlight'}
                  selected
                />
              </View>
            </Card>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  iconBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hero: { overflow: 'hidden' },
  heroGrad: { width: '100%' },
  heroInner: { padding: 22 },
  heroTop: { flexDirection: 'row', justifyContent: 'space-between' },
  heroBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
  },
  heroActions: { flexDirection: 'row', gap: 10, marginTop: 20, flexWrap: 'wrap' },
  heroModel: { flexDirection: 'row', alignItems: 'center', marginTop: 16 },
  dot: { width: 8, height: 8, borderRadius: 4, marginEnd: 8 },
  statsRow: { flexDirection: 'row', gap: 12 },
  quickCard: { width: 108, alignItems: 'center', paddingVertical: 16, paddingHorizontal: 8 },
  quickIcon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  divider: { height: StyleSheet.hairlineWidth },
});
