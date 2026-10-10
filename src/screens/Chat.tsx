import React from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, useThemeController } from '../theme';
import { ChatBubble, Composer } from '../components/composite';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Icon } from '../components/ui/Icon';
import { IconButton } from '../components/ui/IconButton';
import { Logo } from '../components/ui/Logo';
import { Screen } from '../components/ui/Screen';
import { Sheet } from '../components/ui/Sheet';
import { Text } from '../components/ui/Text';
import { useChatStore } from '../store/useChatStore';
import { useAppStore } from '../store/useAppStore';
import { useResponsive } from '../hooks/useResponsive';
import { QUICK_ACTIONS } from '../data/quickActions';
import { PROVIDERS, getModel, getProvider, modelsByProvider } from '../data/models';
import { formatRelativeTime } from '../utils/format';
import { ProviderId } from '../types/model';
import { Attachment, Conversation } from '../types/chat';

/**
 * Stable, build-time sentinel for the chat surface.
 *
 * `scripts/verify-web-bundle.mjs` asserts this exact token is present in the
 * exported web bundle, so a STALE or OLD chat bundle can never be shipped
 * silently again (the historical "old chat UI" regression, where a cached/old
 * bundle kept rendering the pre-rail chat). It is attached to the root
 * container as a `testID` (rendered as `data-testid` on web) so the bundler
 * always keeps the literal. Do NOT change it without updating the verifier.
 */
export const CHAT_UI_BUNDLE_SENTINEL = 'semo0o-chat-ui-v2-rail-composer';

interface ConversationsListProps {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

/** Shared conversation list — used by the desktop rail and the mobile sheet. */
function ConversationsList({ conversations, activeId, onSelect, onDelete }: ConversationsListProps) {
  const theme = useTheme();

  if (conversations.length === 0) {
    return (
      <Text variant="caption" tone="muted" style={{ marginTop: theme.spacing.md }}>
        لا توجد محادثات محفوظة بعد. ابدأ محادثة جديدة لتظهر هنا.
      </Text>
    );
  }

  return (
    <View>
      {conversations.map((conv) => {
        const active = conv.id === activeId;
        return (
          <Pressable
            key={conv.id}
            onPress={() => onSelect(conv.id)}
            style={[
              styles.convRow,
              {
                backgroundColor: active ? theme.colors.primarySoft : 'transparent',
                borderRadius: theme.radius.lg,
              },
            ]}
          >
            <View
              style={[
                styles.convIcon,
                { backgroundColor: active ? theme.colors.primary : theme.colors.surfaceMuted },
              ]}
            >
              <Icon
                name="chatbubble-ellipses-outline"
                size={15}
                color={active ? theme.colors.onPrimary : theme.colors.textMuted}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text variant="body" weight={active ? 'semibold' : 'regular'} numberOfLines={1}>
                {conv.title}
              </Text>
              <Text variant="caption" tone="subtle" numberOfLines={1} style={{ marginTop: 2 }}>
                {conv.lastMessagePreview ?? `${conv.messageCount} رسالة`} · {formatRelativeTime(conv.updatedAt)}
              </Text>
            </View>
            <Pressable
              onPress={() => onDelete(conv.id)}
              style={styles.convDelete}
              accessibilityRole="button"
              accessibilityLabel="حذف المحادثة"
            >
              <Icon name="trash-outline" size={15} tone="subtle" />
            </Pressable>
          </Pressable>
        );
      })}
    </View>
  );
}

interface ModelGroupsProps {
  activeModel: string;
  onSelect: (id: string) => void;
}

/** Grouped model catalogue rendered inside the model picker sheet. */
function ModelGroups({ activeModel, onSelect }: ModelGroupsProps) {
  const theme = useTheme();

  return (
    <View>
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
              const active = m.id === activeModel;
              return (
                <Pressable
                  key={m.id}
                  onPress={() => onSelect(m.id)}
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
    </View>
  );
}

export function Chat() {
  const theme = useTheme();
  const { isRTL } = useThemeController();
  const insets = useSafeAreaInsets();
  const responsive = useResponsive();

  const conversations = useChatStore((s) => s.conversations);
  const messages = useChatStore((s) => s.messages);
  const activeId = useChatStore((s) => s.activeId);
  const streaming = useChatStore((s) => s.streaming);
  const newConversation = useChatStore((s) => s.newConversation);
  const setActive = useChatStore((s) => s.setActive);
  const deleteConversation = useChatStore((s) => s.deleteConversation);
  const send = useChatStore((s) => s.send);
  const stop = useChatStore((s) => s.stop);
  const retryInterrupted = useChatStore((s) => s.retryInterrupted);

  const settings = useAppStore((s) => s.settings);
  const setActiveModel = useAppStore((s) => s.setActiveModel);

  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [modelOpen, setModelOpen] = React.useState(false);

  const scrollRef = React.useRef<ScrollView>(null);
  const list = activeId ? messages[activeId] ?? [] : [];
  const lastContent = list[list.length - 1]?.content;
  const model = getModel(settings.activeModel);
  const provider = model ? getProvider(model.provider) : undefined;
  const activeConversation = conversations.find((c) => c.id === activeId);
  const title = activeConversation?.title ?? 'محادثة جديدة';
  const isEmpty = list.length === 0;

  const handleSubmit = React.useCallback(
    (text: string, attachments: Attachment[]) => {
      if (streaming) return;
      void send(text, { attachments });
    },
    [send, streaming],
  );

  React.useEffect(() => {
    const t = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
    return () => clearTimeout(t);
  }, [list.length, lastContent]);

  const maxWidthStyle = responsive.isDesktop ? { maxWidth: 860 } : null;

  return (
    <Screen padded={false} top={false}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        <View style={styles.body} testID={CHAT_UI_BUNDLE_SENTINEL}>
          {responsive.showSideRail ? (
            <View
              style={[
                styles.rail,
                {
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.backgroundElevated,
                  paddingTop: insets.top,
                },
              ]}
            >
              <View style={[styles.railHeader, { paddingHorizontal: theme.spacing.lg }]}>
                <View style={styles.brandRow}>
                  <Logo size={30} />
                  <Text variant="subtitle" weight="bold" style={{ marginStart: 10 }}>
                    المحادثات
                  </Text>
                </View>
                <IconButton
                  name="add"
                  size="sm"
                  variant="soft"
                  onPress={() => newConversation()}
                  accessibilityLabel="محادثة جديدة"
                />
              </View>
              <ScrollView
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{ padding: theme.spacing.md }}
              >
                <ConversationsList
                  conversations={conversations}
                  activeId={activeId}
                  onSelect={setActive}
                  onDelete={deleteConversation}
                />
              </ScrollView>
            </View>
          ) : null}

          <View style={styles.main}>
            <View
              style={[
                styles.header,
                {
                  paddingHorizontal: theme.spacing.lg,
                  paddingTop: insets.top + theme.spacing.sm,
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.backgroundElevated,
                },
              ]}
            >
              {!responsive.showSideRail ? (
                <IconButton
                  name="menu-outline"
                  size="md"
                  onPress={() => setDrawerOpen(true)}
                  accessibilityLabel="المحادثات"
                />
              ) : (
                <Logo size={36} />
              )}

              <View style={[styles.titleCol, { marginHorizontal: theme.spacing.sm }]}>
                <Text variant="label" weight="bold" numberOfLines={1}>
                  {title}
                </Text>
                <Pressable
                  onPress={() => setModelOpen(true)}
                  style={styles.modelPill}
                  accessibilityRole="button"
                  accessibilityLabel="تغيير النموذج"
                >
                  <View
                    style={[styles.dot, { backgroundColor: provider?.accent ?? theme.colors.primary }]}
                  />
                  <Text variant="caption" tone="muted" numberOfLines={1} style={{ maxWidth: 150 }}>
                    {model?.name ?? 'اختر نموذجًا'}
                  </Text>
                  <Icon name="chevron-down" size={12} tone="subtle" />
                </Pressable>
              </View>

              {streaming ? <Badge label="جارٍ التوليد" tone="accent" /> : null}

              <IconButton
                name="create-outline"
                size="md"
                onPress={() => newConversation()}
                accessibilityLabel="محادثة جديدة"
              />
            </View>

            <ScrollView
              ref={scrollRef}
              contentContainerStyle={{
                padding: theme.spacing.lg,
                paddingBottom: theme.spacing.xl,
                flexGrow: 1,
              }}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              <View style={[styles.messagesInner, maxWidthStyle]}>
                {isEmpty ? (
                  <View style={[styles.emptyWrap, { marginTop: theme.spacing['2xl'] }]}>
                    <Logo size={64} />
                    <Text
                      variant="title"
                      weight="bold"
                      align="center"
                      style={{ marginTop: theme.spacing.lg }}
                    >
                      كيف يمكنني مساعدتك؟
                    </Text>
                    <Text
                      variant="body"
                      tone="muted"
                      align="center"
                      style={{ marginTop: 6, maxWidth: 420 }}
                    >
                      اكتب رسالة أو اختر إجراءً سريعًا للبدء. يمكنك أيضًا تشغيل وكيل ذاتي لمهمة معقدة.
                    </Text>
                    <View style={[styles.quickGrid, { marginTop: theme.spacing.xl }]}>
                      {QUICK_ACTIONS.map((qa) => (
                        <Pressable
                          key={qa.id}
                          onPress={() => void send(qa.prompt)}
                          style={[
                            styles.quickItem,
                            { width: responsive.isDesktop ? '31%' : '48%' },
                          ]}
                        >
                          <Card elevation="sm" glass style={styles.quickCard}>
                            <View
                              style={[styles.quickIcon, { backgroundColor: theme.colors.primarySoft }]}
                            >
                              <Icon name={qa.icon as never} size={18} tone="primary" />
                            </View>
                            <Text
                              variant="label"
                              weight="semibold"
                              numberOfLines={2}
                              style={{ marginTop: 10 }}
                            >
                              {qa.labelAr}
                            </Text>
                          </Card>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                ) : (
                  list.map((message) => (
                    <ChatBubble
                      key={message.id}
                      message={message}
                      onRetry={
                        message.status === 'interrupted' && activeId
                          ? () => void retryInterrupted(activeId)
                          : undefined
                      }
                    />
                  ))
                )}
              </View>
            </ScrollView>

            <View
              style={[
                styles.composerBar,
                {
                  paddingHorizontal: theme.spacing.lg,
                  paddingTop: theme.spacing.md,
                  paddingBottom: Math.max(insets.bottom, theme.spacing.md),
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.backgroundElevated,
                },
              ]}
            >
              <View style={[styles.messagesInner, maxWidthStyle]}>
                <Composer
                  onSubmit={handleSubmit}
                  busy={streaming}
                  onStop={stop}
                  placeholder="اكتب رسالتك…"
                />
                <Text variant="caption" tone="subtle" align="center" style={{ marginTop: 6 }}>
                  {streaming
                    ? 'جارٍ التوليد… اضغط للإيقاف'
                    : 'قد ينتج الذكاء الاصطناعي معلومات غير دقيقة.'}
                </Text>
              </View>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>

      <Sheet
        side={isRTL ? 'right' : 'left'}
        visible={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="المحادثات"
        footer={
          <Button
            label="محادثة جديدة"
            icon="add"
            fullWidth
            onPress={() => {
              newConversation();
              setDrawerOpen(false);
            }}
          />
        }
      >
        <ConversationsList
          conversations={conversations}
          activeId={activeId}
          onSelect={(id) => {
            setActive(id);
            setDrawerOpen(false);
          }}
          onDelete={deleteConversation}
        />
      </Sheet>

      <Sheet
        visible={modelOpen}
        onClose={() => setModelOpen(false)}
        title="اختر النموذج"
        subtitle="النماذج المتاحة عبر المزوّدين المفعّلين"
        maxHeight="82%"
      >
        <ModelGroups
          activeModel={settings.activeModel}
          onSelect={(id) => {
            setActiveModel(id);
            setModelOpen(false);
          }}
        />
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, flexDirection: 'row' },
  rail: {
    width: 300,
    borderEndWidth: StyleSheet.hairlineWidth,
  },
  railHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
  },
  brandRow: { flexDirection: 'row', alignItems: 'center' },
  main: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  titleCol: { flex: 1 },
  modelPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    marginTop: 3,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 999,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  messagesInner: { width: '100%', alignSelf: 'center' },
  emptyWrap: { alignItems: 'center' },
  quickGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    width: '100%',
  },
  quickItem: { marginBottom: 12 },
  quickCard: { paddingVertical: 16, alignItems: 'flex-start' },
  quickIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  composerBar: { borderTopWidth: StyleSheet.hairlineWidth },
  convRow: { flexDirection: 'row', alignItems: 'center', padding: 10, marginBottom: 6 },
  convIcon: {
    width: 30,
    height: 30,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    marginEnd: 10,
  },
  convDelete: { padding: 6 },
  provHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  modelRow: { flexDirection: 'row', alignItems: 'center', padding: 12, marginBottom: 8, borderWidth: 1 },
  modelNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  modelCaps: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
});
