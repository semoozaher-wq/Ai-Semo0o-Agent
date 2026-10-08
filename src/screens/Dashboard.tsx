import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme, useThemeController } from '../theme';
import {
  AppHeader,
  SectionHeader,
  StatCard,
  AgentCard,
  EmptyState,
  ListRow,
  Composer,
} from '../components/composite';
import { Badge } from '../components/ui/Badge';
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
import { PROVIDERS, getModel, getProvider, modelsByProvider } from '../data/models';
import { ProviderId } from '../types/model';
import { Attachment } from '../types/chat';
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
  const setActiveModel = useAppStore((s) => s.setActiveModel);
  const tasks = useAgentsStore((s) => s.tasks);
  const installed = useStoreStore((s) => s.installed);
  const files = useFilesStore((s) => s.files);
  const report = useFilesStore((s) => s.report);
  const usage = useAnalyticsStore((s) => s.usage);
  const send = useChatStore((s) => s.send);
  const newConversation = useChatStore((s) => s.newConversation);
  const streaming = useChatStore((s) => s.streaming);
  const stop = useChatStore((s) => s.stop);

  const [modelOpen, setModelOpen] = React.useState(false);

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

  const startChatWithAttachments = (text: string, attachments: Attachment[]) => {
    if (!newConversation()) return;
    if (text || attachments.length > 0) void send(text, { attachments });
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

                <View
                  style={[
                    styles.composerCard,
                    { backgroundColor: theme.colors.background, borderRadius: theme.radius.xl },
                  ]}
                >
                  <Composer
                    onSubmit={startChatWithAttachments}
                    busy={streaming}
                    onStop={stop}
                    placeholder="اكتب فكرتك أو مهمتك… أو أرفق ملفًا أو رابطًا"
                  />
                </View>

                <Pressable
                  onPress={() => setModelOpen(true)}
                  style={styles.heroModel}
                  accessibilityRole="button"
                  accessibilityLabel="اختر النموذج"
                >
                  <View style={[styles.dot, { backgroundColor: provider?.accent ?? '#FFFFFF' }]} />
                  <Text style={{ color: 'rgba(255,255,255,0.9)', fontSize: theme.fontSize.sm }}>
                    {model ? model.name : 'اختر النموذج'}
                  </Text>
                  <Icon name="chevron-down" size={14} color="rgba(255,255,255,0.9)" />
                </Pressable>
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

        {/* --------------------------- workspace ---------------------------- */}
        <View style={{ paddingHorizontal: theme.spacing.lg, marginTop: theme.spacing['2xl'] }}>
          <Card onPress={() => router.push('/workspace')} gradient="brand">
            <View style={styles.rowBetween}>
              <View style={{ flex: 1 }}>
                <Text variant="subtitle" weight="bold" style={{ color: '#FFFFFF' }}>
                  مساحة العمل · GitHub و ZIP
                </Text>
                <Text variant="caption" style={{ marginTop: 2, color: 'rgba(255,255,255,0.9)' }}>
                  استورد مستودعًا أو ارفع أرشيفًا، عدّل الملفات، ثم صدّرها كـ ZIP.
                </Text>
              </View>
              <Icon name="cube-outline" size={26} color="#FFFFFF" />
            </View>
          </Card>
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

      <Modal visible={modelOpen} transparent animationType="slide" onRequestClose={() => setModelOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setModelOpen(false)}>
          <Pressable
            style={[
              styles.sheet,
              { backgroundColor: theme.colors.backgroundElevated, borderColor: theme.colors.border },
            ]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.sheetHandle} />
            <Text variant="subtitle" weight="bold" style={{ marginBottom: theme.spacing.md }}>
              اختر النموذج
            </Text>
            <ScrollView style={{ maxHeight: 460 }} showsVerticalScrollIndicator={false}>
              {(Object.keys(PROVIDERS) as ProviderId[]).map((pid) => {
                const prov = PROVIDERS[pid];
                const models = modelsByProvider(pid);
                if (models.length === 0) return null;
                return (
                  <View key={pid} style={{ marginBottom: theme.spacing.lg }}>
                    <View style={styles.provHeader}>
                      <View style={[styles.dot, { backgroundColor: prov.accent }]} />
                      <Text variant="label" weight="semibold">
                        {prov.nameAr}
                      </Text>
                      {!prov.requiresApiKey ? <Badge label="بدون مفتاح" tone="success" /> : null}
                    </View>
                    {models.map((m) => {
                      const active = m.id === settings.activeModel;
                      return (
                        <Pressable
                          key={m.id}
                          onPress={() => {
                            setActiveModel(m.id);
                            setModelOpen(false);
                          }}
                          style={[
                            styles.modelRow,
                            {
                              borderColor: active ? theme.colors.primary : theme.colors.border,
                              backgroundColor: active ? theme.colors.primarySoft : theme.colors.surface,
                              borderRadius: theme.radius.lg,
                            },
                          ]}
                        >
                          <View style={{ flex: 1 }}>
                            <View style={styles.modelNameRow}>
                              <Text variant="body" weight="semibold">
                                {m.name}
                              </Text>
                              {m.recommended ? <Badge label="موصى به" tone="accent" /> : null}
                            </View>
                            <Text variant="caption" tone="muted" numberOfLines={2} style={{ marginTop: 2 }}>
                              {m.description}
                            </Text>
                            <View style={styles.modelCaps}>
                              <Badge label={`${Math.round(m.contextWindow / 1000)}K سياق`} tone="neutral" />
                              <Badge label={`سرعة ${m.speed}/5`} tone="info" />
                              <Badge label={`جودة ${m.quality}/5`} tone="primary" />
                            </View>
                          </View>
                          {active ? <Icon name="checkmark-circle" size={22} tone="primary" /> : null}
                        </Pressable>
                      );
                    })}
                  </View>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
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
  composerCard: { marginTop: 20, padding: 6 },
  heroModel: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16 },
  dot: { width: 8, height: 8, borderRadius: 4, marginEnd: 8 },
  statsRow: { flexDirection: 'row', gap: 12 },
  quickCard: { width: 108, alignItems: 'center', paddingVertical: 16, paddingHorizontal: 8 },
  quickIcon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  divider: { height: StyleSheet.hairlineWidth },
  backdrop: { flex: 1, backgroundColor: 'rgba(4,5,12,0.55)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 20, borderTopWidth: StyleSheet.hairlineWidth },
  sheetHandle: { width: 44, height: 5, borderRadius: 3, backgroundColor: 'rgba(128,128,128,0.4)', alignSelf: 'center', marginBottom: 16 },
  provHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  modelRow: { flexDirection: 'row', alignItems: 'center', padding: 12, marginBottom: 8, borderWidth: 1 },
  modelNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  modelCaps: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
});
