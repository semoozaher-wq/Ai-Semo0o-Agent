import React from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { ChatBubble, EmptyState } from '../components/composite';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Icon } from '../components/ui/Icon';
import { Screen } from '../components/ui/Screen';
import { Text } from '../components/ui/Text';
import { useChatStore } from '../store/useChatStore';
import { useAppStore } from '../store/useAppStore';
import { QUICK_ACTIONS } from '../data/quickActions';
import { PROVIDERS, getModel, getProvider, modelsByProvider } from '../data/models';
import { formatRelativeTime } from '../utils/format';
import { ProviderId } from '../types/model';

export function Chat() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const conversations = useChatStore((s) => s.conversations);
  const messages = useChatStore((s) => s.messages);
  const activeId = useChatStore((s) => s.activeId);
  const streaming = useChatStore((s) => s.streaming);
  const newConversation = useChatStore((s) => s.newConversation);
  const setActive = useChatStore((s) => s.setActive);
  const deleteConversation = useChatStore((s) => s.deleteConversation);
  const send = useChatStore((s) => s.send);
  const stop = useChatStore((s) => s.stop);

  const settings = useAppStore((s) => s.settings);
  const setActiveModel = useAppStore((s) => s.setActiveModel);

  const [input, setInput] = React.useState('');
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [modelOpen, setModelOpen] = React.useState(false);

  const scrollRef = React.useRef<ScrollView>(null);
  const list = activeId ? messages[activeId] ?? [] : [];
  const lastContent = list[list.length - 1]?.content;
  const model = getModel(settings.activeModel);
  const provider = model ? getProvider(model.provider) : undefined;

  const handleSend = () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');
    void send(text);
  };

  React.useEffect(() => {
    const t = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
    return () => clearTimeout(t);
  }, [list.length, lastContent]);

  return (
    <Screen padded={false} top={false}>
      <KeyboardAvoidingView
        style={{ flex: 1, paddingTop: insets.top }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        {/* header */}
        <View style={[styles.header, { paddingHorizontal: theme.spacing.lg, borderColor: theme.colors.border }]}>
          <Pressable onPress={() => setDrawerOpen(true)} style={styles.iconBtn}>
            <Icon name="menu-outline" size={24} tone="default" />
          </Pressable>

          <Pressable onPress={() => setModelOpen(true)} style={styles.modelBtn}>
            <View style={[styles.dot, { backgroundColor: provider?.accent ?? theme.colors.primary }]} />
            <Text variant="label" weight="semibold" numberOfLines={1}>
              {model?.name ?? 'اختر نموذجًا'}
            </Text>
            <Icon name="chevron-down" size={14} tone="muted" />
          </Pressable>

          <Pressable onPress={() => newConversation()} style={styles.iconBtn}>
            <Icon name="create-outline" size={22} tone="default" />
          </Pressable>
        </View>

        {/* messages */}
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: 20 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {list.length === 0 ? (
            <View style={{ marginTop: theme.spacing['2xl'] }}>
              <EmptyState
                icon="sparkles-outline"
                title="كيف يمكنني مساعدتك؟"
                description="اكتب رسالة أو اختر إجراءً سريعًا للبدء. يمكنك أيضًا تشغيل وكيل ذاتي لمهمة معقدة."
              />
              <View style={styles.quickGrid}>
                {QUICK_ACTIONS.map((qa) => (
                  <Pressable key={qa.id} onPress={() => void send(qa.prompt)} style={{ width: '48%' }}>
                    <Card style={styles.quickCard}>
                      <Icon name={qa.icon as never} size={20} tone="primary" />
                      <Text variant="label" weight="semibold" style={{ marginTop: 8 }}>
                        {qa.labelAr}
                      </Text>
                    </Card>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : (
            list.map((message) => <ChatBubble key={message.id} message={message} />)
          )}
        </ScrollView>

        {/* composer */}
        <View
          style={[
            styles.composer,
            {
              paddingHorizontal: theme.spacing.lg,
              paddingBottom: Math.max(insets.bottom, 12),
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.backgroundElevated,
            },
          ]}
        >
          <View
            style={[
              styles.inputWrap,
              {
                backgroundColor: theme.colors.surfaceMuted,
                borderColor: theme.colors.border,
                borderRadius: theme.radius.xl,
              },
            ]}
          >
            <Pressable style={styles.iconBtn}>
              <Icon name="add-outline" size={22} tone="muted" />
            </Pressable>
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder="اكتب رسالتك…"
              placeholderTextColor={theme.colors.textSubtle}
              multiline
              style={[styles.input, { color: theme.colors.text }]}
              onSubmitEditing={handleSend}
            />
            <Pressable
              onPress={streaming ? stop : handleSend}
              style={[
                styles.sendBtn,
                {
                  backgroundColor: streaming ? theme.colors.danger : theme.colors.primary,
                  borderRadius: theme.radius.pill,
                },
              ]}
            >
              <Icon name={streaming ? 'stop' : 'arrow-up'} size={18} color="#FFFFFF" />
            </Pressable>
          </View>
          <Text variant="caption" tone="subtle" align="center" style={{ marginTop: 6 }}>
            {streaming ? 'جارٍ التوليد… اضغط للإيقاف' : 'قد ينتج الذكاء الاصطناعي معلومات غير دقيقة.'}
          </Text>
        </View>
      </KeyboardAvoidingView>

      {/* conversations drawer */}
      <Modal visible={drawerOpen} transparent animationType="slide" onRequestClose={() => setDrawerOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setDrawerOpen(false)}>
          <Pressable
            style={[
              styles.drawer,
              {
                backgroundColor: theme.colors.backgroundElevated,
                paddingTop: insets.top + 16,
                borderColor: theme.colors.border,
              },
            ]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.drawerHeader}>
              <Text variant="subtitle" weight="bold">
                المحادثات
              </Text>
              <Button label="جديدة" icon="add" size="sm" onPress={() => { newConversation(); setDrawerOpen(false); }} />
            </View>
            <ScrollView showsVerticalScrollIndicator={false}>
              {conversations.length === 0 ? (
                <Text variant="caption" tone="muted" style={{ marginTop: 20 }}>
                  لا توجد محادثات محفوظة بعد.
                </Text>
              ) : (
                conversations.map((conv) => {
                  const active = conv.id === activeId;
                  return (
                    <Pressable
                      key={conv.id}
                      onPress={() => {
                        setActive(conv.id);
                        setDrawerOpen(false);
                      }}
                      style={[
                        styles.convRow,
                        {
                          backgroundColor: active ? theme.colors.primarySoft : 'transparent',
                          borderRadius: theme.radius.lg,
                        },
                      ]}
                    >
                      <View style={{ flex: 1 }}>
                        <Text variant="body" weight={active ? 'semibold' : 'regular'} numberOfLines={1}>
                          {conv.title}
                        </Text>
                        <Text variant="caption" tone="subtle" numberOfLines={1} style={{ marginTop: 2 }}>
                          {conv.lastMessagePreview ?? `${conv.messageCount} رسالة`} · {formatRelativeTime(conv.updatedAt)}
                        </Text>
                      </View>
                      <Pressable onPress={() => deleteConversation(conv.id)} style={styles.iconBtn}>
                        <Icon name="trash-outline" size={16} tone="subtle" />
                      </Pressable>
                    </Pressable>
                  );
                })
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* model picker */}
      <Modal visible={modelOpen} transparent animationType="slide" onRequestClose={() => setModelOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setModelOpen(false)}>
          <Pressable
            style={[
              styles.sheet,
              { backgroundColor: theme.colors.backgroundElevated, paddingBottom: insets.bottom + 16, borderColor: theme.colors.border },
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  modelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
    justifyContent: 'center',
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  quickGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12 },
  quickCard: { paddingVertical: 16, alignItems: 'flex-start' },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12 },
  inputWrap: { flexDirection: 'row', alignItems: 'flex-end', borderWidth: 1, paddingHorizontal: 4, paddingVertical: 4 },
  input: { flex: 1, fontSize: 15, maxHeight: 120, paddingVertical: 10, paddingHorizontal: 8, textAlign: 'right' },
  sendBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  backdrop: { flex: 1, backgroundColor: 'rgba(4,5,12,0.55)', justifyContent: 'flex-end' },
  drawer: {
    width: '84%',
    height: '100%',
    paddingHorizontal: 16,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderTopRightRadius: 24,
    borderBottomRightRadius: 24,
  },
  drawerHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  convRow: { flexDirection: 'row', alignItems: 'center', padding: 12, marginBottom: 6 },
  sheet: { borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 20, borderTopWidth: StyleSheet.hairlineWidth },
  sheetHandle: { width: 44, height: 5, borderRadius: 3, backgroundColor: 'rgba(128,128,128,0.4)', alignSelf: 'center', marginBottom: 16 },
  provHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  modelRow: { flexDirection: 'row', alignItems: 'center', padding: 12, marginBottom: 8, borderWidth: 1 },
  modelNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  modelCaps: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
});
