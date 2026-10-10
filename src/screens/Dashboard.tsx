import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme, useThemeController } from '../theme';
import { AppHeader, AgentCard, Composer } from '../components/composite';
import { Badge } from '../components/ui/Badge';
import { Card } from '../components/ui/Card';
import { Gradient } from '../components/ui/Gradient';
import { Icon, IconName } from '../components/ui/Icon';
import { Screen } from '../components/ui/Screen';
import { Text } from '../components/ui/Text';
import { Semo0oMark } from '../components/brand/Semo0oLogo';
import { useResponsive } from '../hooks/useResponsive';
import { useAppStore } from '../store/useAppStore';
import { useAgentsStore } from '../store/useAgentsStore';
import { useChatStore } from '../store/useChatStore';
import { QUICK_ACTIONS } from '../data/quickActions';
import { featuredAgents } from '../data/agents';
import { PROVIDERS, getModel, getProvider, modelsByProvider } from '../data/models';
import { ProviderId } from '../types/model';
import { Attachment } from '../types/chat';

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'صباح الخير';
  return 'مساء الخير';
}

/** Map the data-layer quick-action icon keys onto real Ionicons glyphs. */
const QA_ICONS: Record<string, IconName> = {
  'align-left': 'reorder-three-outline',
  code: 'code-slash-outline',
  languages: 'language-outline',
  'bar-chart': 'bar-chart-outline',
  zap: 'flash-outline',
  'check-square': 'checkmark-done-outline',
};

/** A compact real-navigation shortcut shown under the composer. */
interface Shortcut {
  key: string;
  label: string;
  hint: string;
  icon: IconName;
  href: string;
}

const SHORTCUTS: Shortcut[] = [
  {
    key: 'projects',
    label: 'المشاريع',
    hint: 'مساحات العمل · GitHub و ZIP',
    icon: 'briefcase-outline',
    href: '/workspace',
  },
  {
    key: 'tasks',
    label: 'المهام',
    hint: 'تخطيط وتنفيذ ومتابعة',
    icon: 'checkbox-outline',
    href: '/agents',
  },
  {
    key: 'files',
    label: 'الملفات',
    hint: 'رفع وفحص وتحليل',
    icon: 'document-text-outline',
    href: '/files',
  },
];

export function Dashboard() {
  const theme = useTheme();
  const { toggleMode, mode: themeMode } = useThemeController();
  const router = useRouter();
  const { isMobile } = useResponsive();

  const settings = useAppStore((s) => s.settings);
  const setActiveModel = useAppStore((s) => s.setActiveModel);
  const tasks = useAgentsStore((s) => s.tasks);
  const send = useChatStore((s) => s.send);
  const newConversation = useChatStore((s) => s.newConversation);
  const streaming = useChatStore((s) => s.streaming);
  const stop = useChatStore((s) => s.stop);

  const [modelOpen, setModelOpen] = React.useState(false);

  const model = getModel(settings.activeModel);
  const provider = model ? getProvider(model.provider) : undefined;

  const runningTask = tasks.find((t) => t.status === 'running' || t.status === 'planning');

  const startChat = (prompt?: string) => {
    if (!newConversation()) return;
    if (prompt) void send(prompt);
    router.push('/chat');
  };

  const startChatWithAttachments = (
    text: string,
    attachments: Attachment[],
    mode: 'chat' | 'agent' = 'chat',
  ) => {
    if (!newConversation()) return;
    if (text || attachments.length > 0) void send(text, { attachments, mode });
    router.push('/chat');
  };

  const featured = featuredAgents().slice(0, 6);
  const markSize = isMobile ? 76 : 96;

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
                <Pressable onPress={toggleMode} style={styles.iconBtn} accessibilityLabel="تبديل المظهر">
                  <Icon
                    name={themeMode === 'dark' ? 'sunny-outline' : 'moon-outline'}
                    size={20}
                    tone="muted"
                  />
                </Pressable>
                <Pressable
                  onPress={() => router.push('/settings')}
                  style={styles.iconBtn}
                  accessibilityLabel="الإعدادات"
                >
                  <Icon name="settings-outline" size={20} tone="muted" />
                </Pressable>
              </>
            }
          />
        </View>

        {/* ------------------------------ hero ------------------------------ */}
        <View style={[styles.hero, { paddingHorizontal: theme.spacing.lg }]}>
          {/* soft brand glow behind the mark */}
          <View style={styles.glowWrap} pointerEvents="none">
            <Gradient
              name="brand"
              radius={999}
              style={[styles.glow, { opacity: theme.mode === 'dark' ? 0.22 : 0.14 }]}
            />
          </View>

          <Semo0oMark size={markSize} />

          <Text
            weight="extrabold"
            style={{
              fontSize: isMobile ? theme.fontSize['2xl'] : theme.fontSize['3xl'],
              marginTop: 18,
              textAlign: 'center',
              color: theme.colors.text,
            }}
          >
            مرحباً بك في Semo0o
          </Text>
          <Text
            style={{
              marginTop: 8,
              textAlign: 'center',
              color: theme.colors.textMuted,
              fontSize: theme.fontSize.md,
              lineHeight: 24,
              maxWidth: 520,
            }}
          >
            مساعدك الذكي في فهم المحتويات ودراستها — اسأل، ارفع ملفًا، أو ابدأ مهمة ليعمل الوكلاء نيابةً عنك.
          </Text>

          {/* composer */}
          <View
            style={[
              styles.composerCard,
              {
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.border,
                borderRadius: theme.radius['2xl'],
              },
            ]}
          >
            <Composer
              onSubmit={startChatWithAttachments}
              busy={streaming}
              onStop={stop}
              placeholder="اكتب سؤالك هنا… أو أرفق ملفًا أو رابطًا"
            />
          </View>

          {/* model selector */}
          <Pressable
            onPress={() => setModelOpen(true)}
            style={[styles.modelChip, { borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceMuted }]}
            accessibilityRole="button"
            accessibilityLabel="اختر النموذج"
          >
            <View style={[styles.dot, { backgroundColor: provider?.accent ?? theme.colors.primary }]} />
            <Text style={{ color: theme.colors.text, fontSize: theme.fontSize.sm, fontWeight: '600' }}>
              {model ? model.name : 'اختر النموذج'}
            </Text>
            <Icon name="chevron-down" size={14} tone="muted" />
          </Pressable>
        </View>

        {/* -------------------------- quick actions ------------------------- */}
        <View style={{ marginTop: theme.spacing['3xl'] }}>
          <View style={{ paddingHorizontal: theme.spacing.lg, marginBottom: theme.spacing.md }}>
            <Text variant="subtitle" weight="bold">
              ابدأ بسرعة
            </Text>
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
                    <Icon name={QA_ICONS[qa.icon] ?? 'flash-outline'} size={20} tone="primary" />
                  </View>
                  <Text variant="label" weight="semibold" style={{ marginTop: 10 }} numberOfLines={1}>
                    {qa.labelAr}
                  </Text>
                </Card>
              </Pressable>
            ))}
          </ScrollView>
        </View>

        {/* --------------------------- shortcuts ---------------------------- */}
        <View style={{ paddingHorizontal: theme.spacing.lg, marginTop: theme.spacing['3xl'] }}>
          <Text variant="subtitle" weight="bold" style={{ marginBottom: theme.spacing.md }}>
            تنقّل سريع
          </Text>
          <View style={[styles.shortcutRow, isMobile && styles.shortcutColumn]}>
            {SHORTCUTS.map((s) => (
              <Pressable
                key={s.key}
                onPress={() => router.push(s.href as never)}
                style={{ flex: 1 }}
                accessibilityRole="button"
                accessibilityLabel={s.label}
              >
                <Card style={styles.shortcutCard}>
                  <View
                    style={[
                      styles.shortcutIcon,
                      { backgroundColor: theme.colors.accentSoft, borderRadius: theme.radius.md },
                    ]}
                  >
                    <Icon name={s.icon} size={20} color={theme.colors.accent} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text variant="body" weight="semibold">
                      {s.label}
                    </Text>
                    <Text variant="caption" tone="muted" numberOfLines={1} style={{ marginTop: 2 }}>
                      {s.hint}
                    </Text>
                  </View>
                  <Icon name="chevron-back" size={16} tone="subtle" />
                </Card>
              </Pressable>
            ))}
          </View>
        </View>

        {/* --------------------------- running task ------------------------- */}
        {runningTask ? (
          <View style={{ paddingHorizontal: theme.spacing.lg, marginTop: theme.spacing['3xl'] }}>
            <Text variant="subtitle" weight="bold" style={{ marginBottom: theme.spacing.md }}>
              قيد التنفيذ الآن
            </Text>
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
        <View style={{ marginTop: theme.spacing['3xl'] }}>
          <View
            style={[
              styles.rowBetween,
              { paddingHorizontal: theme.spacing.lg, marginBottom: theme.spacing.md },
            ]}
          >
            <Text variant="subtitle" weight="bold">
              وكلاء مميّزون
            </Text>
            <Pressable onPress={() => router.push('/library')} style={styles.linkRow}>
              <Text variant="label" tone="accent">
                المكتبة
              </Text>
              <Icon name="chevron-back" size={14} tone="accent" />
            </Pressable>
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
      </ScrollView>

      {/* ------------------------- model selector ------------------------- */}
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
  hero: {
    alignItems: 'center',
    paddingTop: 12,
  },
  glowWrap: {
    position: 'absolute',
    top: -10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glow: {
    width: 260,
    height: 260,
  },
  composerCard: {
    width: '100%',
    maxWidth: 720,
    marginTop: 26,
    padding: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  modelChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 16,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  quickCard: { width: 112, alignItems: 'center', paddingVertical: 16, paddingHorizontal: 8 },
  quickIcon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  shortcutRow: { flexDirection: 'row', gap: 12 },
  shortcutColumn: { flexDirection: 'column' },
  shortcutCard: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  shortcutIcon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
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
  modelRow: { flexDirection: 'row', alignItems: 'center', padding: 12, marginBottom: 8, borderWidth: 1 },
  modelNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  modelCaps: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
});
