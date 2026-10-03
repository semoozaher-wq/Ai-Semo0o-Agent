import React from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { AppHeader, SectionHeader, EmptyState, ListRow } from '../components/composite';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Chip } from '../components/ui/Chip';
import { Gradient } from '../components/ui/Gradient';
import { Icon, IconName } from '../components/ui/Icon';
import { Input } from '../components/ui/Input';
import { Progress } from '../components/ui/Progress';
import { Screen } from '../components/ui/Screen';
import { Text } from '../components/ui/Text';
import { useAgentsStore, LogEntry } from '../store/useAgentsStore';
import { useAppStore } from '../store/useAppStore';
import { TASK_TEMPLATES } from '../data/taskTemplates';
import { PROVIDERS, getModel, getProvider, modelsByProvider } from '../data/models';
import { StepKind, Task, TaskStatus, TaskStep } from '../types/task';
import { ProviderId } from '../types/model';
import { formatRelativeTime } from '../utils/format';

const STEP_ICON: Record<StepKind, IconName> = {
  reason: 'bulb-outline',
  tool: 'construct-outline',
  search: 'search-outline',
  code: 'code-slash-outline',
  write: 'create-outline',
  analyze: 'analytics-outline',
  verify: 'shield-checkmark-outline',
  reflect: 'refresh-outline',
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: 'في الانتظار',
  planning: 'يتخطّط',
  running: 'قيد التنفيذ',
  paused: 'متوقّف',
  completed: 'مكتملة',
  completed_with_warnings: 'مكتملة بتحذيرات',
  blocked: 'محجوبة',
  unverified: 'غير موثّقة',
  failed: 'فشلت',
  cancelled: 'ملغاة',
};

const TEMPLATE_SAMPLES: Record<string, string> = {
  '{topic}': 'أثر الذكاء الاصطناعي على التعليم',
  '{idea}': 'تطبيق لإدارة المهام الذكية',
  '{file}': 'data/sales-2026.csv',
  '{brand}': 'Semo0o',
  '{market}': 'تطبيقات الوكلاء الأذكياء',
  '{repo}': 'Ai-Semo0o-Agent',
  '{destination}': 'طوكيو',
  '{days}': '7',
  '{budget}': '5000 ريال',
};

function fillTemplate(goal: string): string {
  return Object.entries(TEMPLATE_SAMPLES).reduce(
    (acc, [token, value]) => acc.split(token).join(value),
    goal,
  );
}

function statusTone(status: TaskStatus): 'neutral' | 'accent' | 'success' | 'danger' | 'warning' {
  switch (status) {
    case 'completed':
      return 'success';
    case 'completed_with_warnings':
      return 'warning';
    case 'blocked':
      return 'danger';
    case 'running':
    case 'planning':
      return 'accent';
    case 'failed':
      return 'danger';
    case 'unverified':
      return 'warning';
    case 'cancelled':
      return 'warning';
    default:
      return 'neutral';
  }
}

function stepColor(status: TaskStep['status'], theme: ReturnType<typeof useTheme>): string {
  switch (status) {
    case 'completed':
      return theme.colors.success;
    case 'running':
      return theme.colors.accent;
    case 'failed':
      return theme.colors.danger;
    case 'skipped':
      return theme.colors.textMuted;
    default:
      return theme.colors.textSubtle;
  }
}

function StepTimeline({ task }: { task: Task }) {
  const theme = useTheme();
  if (task.steps.length === 0) {
    return (
      <Text variant="caption" tone="muted" style={{ marginTop: theme.spacing.sm }}>
        لم يبدأ التخطيط بعد…
      </Text>
    );
  }
  return (
    <View style={{ marginTop: theme.spacing.md }}>
      {task.steps.map((step, index) => {
        const color = stepColor(step.status, theme);
        const isLast = index === task.steps.length - 1;
        return (
          <View key={step.id} style={styles.stepRow}>
            <View style={styles.stepRail}>
              <View
                style={[
                  styles.stepDot,
                  {
                    backgroundColor:
                      step.status === 'running' ? theme.colors.accent : theme.colors.surfaceMuted,
                    borderColor: color,
                  },
                ]}
              >
                <Icon
                  name={STEP_ICON[step.kind]}
                  size={14}
                  color={step.status === 'running' ? '#FFFFFF' : color}
                />
              </View>
              {!isLast ? (
                <View style={[styles.stepLine, { backgroundColor: theme.colors.border }]} />
              ) : null}
            </View>
            <View style={styles.stepBody}>
              <View style={styles.stepTitleRow}>
                <Text variant="body" weight="semibold" numberOfLines={2} style={{ flex: 1 }}>
                  {step.title}
                </Text>
                {step.status === 'running' ? (
                  <Badge label="جارٍ" tone="accent" />
                ) : step.status === 'completed' ? (
                  <Icon name="checkmark-circle" size={16} tone="success" />
                ) : step.status === 'failed' ? (
                  <Icon name="alert-circle" size={16} tone="danger" />
                ) : null}
              </View>
              {step.output ? (
                <Text
                  variant="caption"
                  tone="muted"
                  numberOfLines={3}
                  style={{ marginTop: 2 }}
                >
                  {step.output.split('\n').slice(-1)[0]}
                </Text>
              ) : null}
              {step.toolInvocations && step.toolInvocations.length > 0 ? (
                <View style={styles.toolRow}>
                  {step.toolInvocations.map((inv) => (
                    <Badge
                      key={inv.id}
                      label={`${inv.toolId} · ${inv.durationMs ?? 0}ms`}
                      tone={inv.status === 'success' ? 'info' : 'danger'}
                    />
                  ))}
                </View>
              ) : null}
              {step.verificationStatus ? (
                <View style={styles.toolRow}>
                  <Badge
                    label={`Verification: ${step.verificationStatus}`}
                    tone={step.verificationStatus === 'VERIFIED' ? 'success' : step.verificationStatus === 'UNVERIFIED' ? 'warning' : 'danger'}
                  />
                  {step.retries ? <Badge label={`Retry ×${step.retries}`} tone="warning" /> : null}
                </View>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function LogConsole({ logs }: { logs: LogEntry[] }) {
  const theme = useTheme();
  const colorFor = (level: LogEntry['level']) =>
    level === 'success'
      ? theme.colors.success
      : level === 'warn'
        ? theme.colors.warning
        : level === 'error'
          ? theme.colors.danger
          : theme.colors.textMuted;

  if (logs.length === 0) return null;
  return (
    <View
      style={[
        styles.console,
        { backgroundColor: theme.colors.background, borderRadius: theme.radius.lg },
      ]}
    >
      {logs.slice(-12).map((log) => (
        <Text
          key={log.id}
          variant="caption"
          style={{ color: colorFor(log.level), marginBottom: 3, fontFamily: 'monospace' }}
        >
          {log.message}
        </Text>
      ))}
    </View>
  );
}

export function Agents() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const tasks = useAgentsStore((s) => s.tasks);
  const logs = useAgentsStore((s) => s.logs);
  const runningId = useAgentsStore((s) => s.runningId);
  const createTask = useAgentsStore((s) => s.createTask);
  const runTask = useAgentsStore((s) => s.runTask);
  const cancel = useAgentsStore((s) => s.cancel);
  const approvalRequest = useAgentsStore((s) => s.approvalRequest);
  const approve = useAgentsStore((s) => s.approve);
  const reject = useAgentsStore((s) => s.reject);
  const removeTask = useAgentsStore((s) => s.removeTask);
  const clear = useAgentsStore((s) => s.clear);

  const settings = useAppStore((s) => s.settings);
  const setActiveModel = useAppStore((s) => s.setActiveModel);

  const [goal, setGoal] = React.useState('');
  const [modelOpen, setModelOpen] = React.useState(false);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  const model = getModel(settings.activeModel);
  const provider = model ? getProvider(model.provider) : undefined;
  const running = runningId ? tasks.find((t) => t.id === runningId) : undefined;

  const start = () => {
    const text = goal.trim();
    if (!text || runningId) return;
    const task = createTask(text, { model: settings.activeModel });
    setGoal('');
    setExpandedId(task.id);
    void runTask(task.id);
  };

  const runningLogs = runningId ? logs[runningId] ?? [] : [];

  return (
    <Screen padded={false}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.sm }}>
          <AppHeader
            title="الوكلاء الأذكياء"
            subtitle="محرّك تنفيذ ذاتي يخطّط وينفّذ ويتحقّق تلقائيًا"
            right={
              <Pressable onPress={() => void clear()} style={styles.iconBtn}>
                <Icon name="trash-outline" size={20} tone="muted" />
              </Pressable>
            }
          />
        </View>

        {/* --------------------------- task builder --------------------------- */}
        <View style={{ paddingHorizontal: theme.spacing.lg }}>
          <Card>
            <View style={styles.rowBetween}>
              <Text variant="subtitle" weight="bold">
                مهمة جديدة
              </Text>
              <Pressable onPress={() => setModelOpen(true)} style={styles.modelBtn}>
                <View
                  style={[styles.dot, { backgroundColor: provider?.accent ?? theme.colors.primary }]}
                />
                <Text variant="caption" tone="muted">
                  {model?.name ?? 'اختر نموذجًا'}
                </Text>
                <Icon name="chevron-down" size={12} tone="muted" />
              </Pressable>
            </View>

            <Input
              icon="flag-outline"
              placeholder="صِف المهمة المعقّدة التي تريد تنفيذها…"
              value={goal}
              onChangeText={setGoal}
              multiline
              style={{ minHeight: 72, textAlignVertical: 'top', paddingTop: 10 }}
              containerStyle={{ marginTop: theme.spacing.md }}
            />

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 8, paddingTop: theme.spacing.md }}
            >
              {TASK_TEMPLATES.map((tpl) => (
                <Chip
                  key={tpl.id}
                  label={tpl.titleAr}
                  tone="accent"
                  size="sm"
                  selected={goal === fillTemplate(tpl.goal)}
                  onPress={() => setGoal(fillTemplate(tpl.goal))}
                />
              ))}
            </ScrollView>

            <Button
              label={runningId ? 'جارٍ التنفيذ…' : 'تشغيل المهمة'}
              icon="flash"
              onPress={start}
              disabled={!goal.trim() || Boolean(runningId)}
              loading={Boolean(runningId)}
              fullWidth
              style={{ marginTop: theme.spacing.lg }}
            />
          </Card>
        </View>

        {/* --------------------------- running task --------------------------- */}
        {running ? (
          <View style={{ paddingHorizontal: theme.spacing.lg, marginTop: theme.spacing['2xl'] }}>
            <SectionHeader title="قيد التنفيذ الآن" icon="sync-outline" />
            <Card bordered={false} style={{ overflow: 'hidden', padding: 0 }}>
              <Gradient name="brand" radius={theme.radius.xl} style={styles.runGrad}>
                <View style={styles.runInner}>
                  <View style={styles.rowBetween}>
                    <View style={{ flex: 1 }}>
                      <Text
                        weight="bold"
                        numberOfLines={2}
                        style={{ color: '#FFFFFF', fontSize: theme.fontSize.lg }}
                      >
                        {running.title}
                      </Text>
                      <Text
                        numberOfLines={2}
                        style={{ color: 'rgba(255,255,255,0.85)', fontSize: theme.fontSize.sm, marginTop: 4 }}
                      >
                        {running.goal}
                      </Text>
                    </View>
                    <Badge label={`${Math.round(running.progress * 100)}%`} tone="accent" />
                  </View>
                  <View style={{ marginTop: theme.spacing.md }}>
                    <Progress value={running.progress} color="#FFFFFF" trackColor="rgba(255,255,255,0.25)" />
                  </View>
                </View>
              </Gradient>
            </Card>

            <Card style={{ marginTop: theme.spacing.md }}>
              <StepTimeline task={running} />
              <LogConsole logs={runningLogs} />
              <Button
                label="إيقاف التنفيذ"
                icon="stop-circle-outline"
                variant="danger"
                onPress={cancel}
                fullWidth
                style={{ marginTop: theme.spacing.md }}
              />
            </Card>
          </View>
        ) : null}

        {/* ----------------------------- task list ---------------------------- */}
        <View style={{ paddingHorizontal: theme.spacing.lg, marginTop: theme.spacing['2xl'] }}>
          <SectionHeader
            title="سجل المهام"
            icon="list-outline"
            subtitle={`${tasks.length} مهمة`}
          />
          {tasks.length === 0 ? (
            <Card>
              <EmptyState
                icon="flash-outline"
                title="لا توجد مهام بعد"
                description="اكتب هدفك أو اختر قالبًا جاهزًا، وسيقوم الوكلاء بالتخطيط والتنفيذ والتحقق تلقائيًا."
              />
            </Card>
          ) : (
            <View style={{ gap: 12 }}>
              {tasks.map((task) => {
                const expanded = expandedId === task.id;
                const taskLogs = logs[task.id] ?? [];
                return (
                  <Card key={task.id} padded={false}>
                    <Pressable
                      onPress={() => setExpandedId(expanded ? null : task.id)}
                      style={styles.taskHead}
                    >
                      <View
                        style={[
                          styles.taskIcon,
                          { backgroundColor: theme.colors.primarySoft, borderRadius: theme.radius.md },
                        ]}
                      >
                        <Icon
                          name={
                            task.status === 'completed'
                              ? 'checkmark-done-circle'
                              : task.status === 'completed_with_warnings'
                                ? 'warning'
                                : task.status === 'blocked'
                                  ? 'lock-closed'
                              : task.status === 'running' || task.status === 'planning'
                                ? 'sync'
                                : task.status === 'failed'
                                  ? 'alert-circle'
                                  : task.status === 'cancelled'
                                    ? 'close-circle'
                                    : 'time-outline'
                          }
                          size={20}
                          color={
                            task.status === 'completed'
                              ? theme.colors.success
                              : task.status === 'completed_with_warnings'
                                ? theme.colors.warning
                                : task.status === 'blocked'
                                  ? theme.colors.danger
                              : task.status === 'running' || task.status === 'planning'
                                ? theme.colors.accent
                                : task.status === 'failed'
                                  ? theme.colors.danger
                                  : theme.colors.textMuted
                          }
                        />
                      </View>
                      <View style={{ flex: 1, marginStart: 12 }}>
                        <Text variant="body" weight="semibold" numberOfLines={2}>
                          {task.title}
                        </Text>
                        <Text variant="caption" tone="subtle" numberOfLines={1} style={{ marginTop: 2 }}>
                          {task.steps.length} خطوات · {task.model} · {formatRelativeTime(task.updatedAt)}
                        </Text>
                      </View>
                      <Badge label={STATUS_LABEL[task.status]} tone={statusTone(task.status)} />
                      <Icon
                        name={expanded ? 'chevron-up' : 'chevron-down'}
                        size={18}
                        tone="muted"
                      />
                    </Pressable>

                    {expanded ? (
                      <View style={[styles.taskBody, { borderColor: theme.colors.border }]}>
                        <StepTimeline task={task} />
                        {task.result ? (
                          <View
                            style={[
                              styles.result,
                              { backgroundColor: theme.colors.successSoft, borderRadius: theme.radius.lg },
                            ]}
                          >
                            <Text variant="label" weight="semibold" tone="success">
                              نتيجة المهمة
                            </Text>
                            <Text variant="caption" style={{ marginTop: 6, lineHeight: 20 }}>
                              {task.result.replace(/[#*]/g, '').slice(0, 420)}
                            </Text>
                          </View>
                        ) : null}
                        <LogConsole logs={taskLogs} />
                        <View style={styles.taskActions}>
                          {task.status === 'failed' || task.status === 'cancelled' ? (
                            <Button
                              label="إعادة التشغيل"
                              icon="refresh"
                              size="sm"
                              variant="secondary"
                              onPress={() => void runTask(task.id)}
                            />
                          ) : null}
                          <Button
                            label="حذف"
                            icon="trash-outline"
                            size="sm"
                            variant="ghost"
                            onPress={() => void removeTask(task.id)}
                          />
                        </View>
                      </View>
                    ) : null}
                  </Card>
                );
              })}
            </View>
          )}
        </View>

        {/* ----------------------------- tools note --------------------------- */}
        <View style={{ paddingHorizontal: theme.spacing.lg, marginTop: theme.spacing['2xl'] }}>
          <Card>
            <ListRow
              title="سجل الأدوات المتصلة"
              subtitle="بحث ويب · تنفيذ أكواد · تحليل ملفات · تحليل بيانات · توليد رسوم"
              icon="construct-outline"
              showChevron
            />
          </Card>
        </View>
      </ScrollView>

      {/* --------------------------- approval surface ------------------------ */}
      <Modal visible={Boolean(approvalRequest)} transparent animationType="slide" onRequestClose={reject}>
        <Pressable style={styles.backdrop} onPress={reject}>
          <Pressable
            style={[styles.sheet, { backgroundColor: theme.colors.backgroundElevated, paddingBottom: insets.bottom + 16, borderColor: theme.colors.border }]}
            onPress={(event) => event.stopPropagation()}
          >
            <View style={styles.sheetHandle} />
            <View style={styles.rowBetween}>
              <Text variant="subtitle" weight="bold">موافقة مطلوبة</Text>
              <Badge label={approvalRequest?.risk === 'high' ? 'مخاطر عالية' : 'مخاطر متوسطة'} tone={approvalRequest?.risk === 'high' ? 'danger' : 'warning'} />
            </View>
            <Text variant="body" weight="semibold" style={{ marginTop: theme.spacing.lg }}>
              {approvalRequest?.toolName ?? 'أداة خطرة'}
            </Text>
            <Text variant="caption" tone="muted" style={{ marginTop: 6, lineHeight: 20 }}>
              {approvalRequest?.reason ?? 'طلب تنفيذ عملية تحتاج صلاحية.'}
            </Text>
            <Text variant="label" weight="semibold" style={{ marginTop: theme.spacing.lg }}>الملفات أو المسارات المتأثرة</Text>
            <Text variant="caption" tone="muted" style={{ marginTop: 4 }}>
              {approvalRequest?.affectedFiles.length ? approvalRequest.affectedFiles.join('، ') : 'لم يحدد الوكيل ملفات بعينها'}
            </Text>
            <Text variant="caption" tone="muted" style={{ marginTop: theme.spacing.md }}>
              {approvalRequest?.reversible ? 'العملية قابلة للتراجع.' : 'العملية قد لا تكون قابلة للتراجع.'}
            </Text>
            <View style={[styles.taskActions, { marginTop: theme.spacing.lg }]}>
              <Button label="رفض" variant="outline" onPress={reject} style={{ flex: 1 }} />
              <Button label="موافقة وتنفيذ" variant="danger" onPress={approve} style={{ flex: 1 }} />
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ---------------------------- model picker --------------------------- */}
      <Modal
        visible={modelOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setModelOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setModelOpen(false)}>
          <Pressable
            style={[
              styles.sheet,
              {
                backgroundColor: theme.colors.backgroundElevated,
                paddingBottom: insets.bottom + 16,
                borderColor: theme.colors.border,
              },
            ]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.sheetHandle} />
            <Text variant="subtitle" weight="bold" style={{ marginBottom: theme.spacing.md }}>
              محرّك النموذج
            </Text>
            <ScrollView style={{ maxHeight: 440 }} showsVerticalScrollIndicator={false}>
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
                            <Text variant="body" weight="semibold">
                              {m.name}
                            </Text>
                            <Text variant="caption" tone="muted" numberOfLines={1}>
                              {m.description}
                            </Text>
                          </View>
                          {active ? <Icon name="checkmark-circle" size={20} tone="primary" /> : null}
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
  iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  modelBtn: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  runGrad: { width: '100%' },
  runInner: { padding: 20 },
  stepRow: { flexDirection: 'row' },
  stepRail: { width: 30, alignItems: 'center' },
  stepDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepLine: { width: 2, flex: 1, minHeight: 18, marginVertical: 2 },
  stepBody: { flex: 1, marginStart: 10, paddingBottom: 14 },
  stepTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  toolRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  console: { padding: 12, marginTop: 12 },
  taskHead: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 8 },
  taskIcon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  taskBody: { paddingHorizontal: 14, paddingBottom: 14, borderTopWidth: StyleSheet.hairlineWidth },
  result: { padding: 12, marginTop: 12 },
  taskActions: { flexDirection: 'row', gap: 8, marginTop: 12, justifyContent: 'flex-end' },
  backdrop: { flex: 1, backgroundColor: 'rgba(4,5,12,0.55)', justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sheetHandle: {
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(128,128,128,0.4)',
    alignSelf: 'center',
    marginBottom: 16,
  },
  provHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
  },
});
