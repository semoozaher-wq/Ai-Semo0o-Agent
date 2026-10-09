import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '../../theme';
import { Attachment, AttachmentKind, Message } from '../../types/chat';
import { Text } from '../ui/Text';
import { Icon, IconName } from '../ui/Icon';
import { Logo } from '../ui/Logo';

export interface ChatBubbleProps {
  message: Message;
  /** Called when the user taps "retry" on an interrupted assistant turn. */
  onRetry?: (() => void) | undefined;
}

const KIND_ICON: Record<AttachmentKind, IconName> = {
  image: 'image-outline',
  document: 'document-text-outline',
  audio: 'musical-notes-outline',
  code: 'code-slash-outline',
  other: 'link-outline',
};

function AttachmentPill({ attachment, onPrimary }: { attachment: Attachment; onPrimary: boolean }) {
  const theme = useTheme();
  const name = attachment.name.length > 26 ? `${attachment.name.slice(0, 25)}…` : attachment.name;
  return (
    <View
      style={[
        styles.attPill,
        {
          backgroundColor: onPrimary ? 'rgba(255,255,255,0.18)' : theme.colors.surfaceMuted,
          borderColor: onPrimary ? 'rgba(255,255,255,0.28)' : theme.colors.border,
        },
      ]}
    >
      <Icon
        name={KIND_ICON[attachment.kind]}
        size={13}
        color={onPrimary ? theme.colors.onPrimary : theme.colors.textMuted}
      />
      <Text
        variant="caption"
        numberOfLines={1}
        style={{
          marginStart: 5,
          maxWidth: 190,
          color: onPrimary ? theme.colors.onPrimary : theme.colors.textMuted,
        }}
      >
        {name}
      </Text>
    </View>
  );
}

export function ChatBubble({ message, onRetry }: ChatBubbleProps) {
  const theme = useTheme();
  const isUser = message.role === 'user';
  const isError = message.status === 'error';
  const isInterrupted = message.status === 'interrupted';
  const hasAttachments = Boolean(message.attachments && message.attachments.length > 0);

  return (
    <View style={[styles.row, { justifyContent: isUser ? 'flex-start' : 'flex-end' }]}>
      {!isUser ? (
        <View style={{ marginEnd: 8, alignSelf: 'flex-end' }}>
          <Logo size={30} icon="sparkles" />
        </View>
      ) : null}
      <View
        style={[
          styles.bubble,
          {
            backgroundColor: isUser
              ? theme.colors.primary
              : isError
                ? theme.colors.dangerSoft
                : theme.colors.surface,
            borderColor: isError ? theme.colors.danger : theme.colors.border,
            borderWidth: isUser ? 0 : StyleSheet.hairlineWidth,
            borderRadius: theme.radius.xl,
            maxWidth: '82%',
          },
        ]}
      >
        {message.content ? (
          <Text
            style={{
              color: isUser ? theme.colors.onPrimary : theme.colors.text,
              fontSize: theme.fontSize.md,
              lineHeight: 24,
            }}
          >
            {message.content}
          </Text>
        ) : message.status === 'streaming' ? (
          <View style={styles.typing}>
            <ActivityIndicator size="small" color={theme.colors.accent} />
            <Text variant="caption" tone="subtle" style={{ marginStart: 8 }}>
              يفكّر…
            </Text>
          </View>
        ) : null}

        {hasAttachments ? (
          <View style={[styles.attachments, { marginTop: message.content ? 8 : 0 }]}>
            {message.attachments!.map((attachment) => (
              <AttachmentPill key={attachment.id} attachment={attachment} onPrimary={isUser} />
            ))}
          </View>
        ) : null}

        {message.status === 'streaming' && message.content ? (
          <View style={{ marginTop: 6 }}>
            <Icon name="ellipsis-horizontal" size={14} tone="accent" />
          </View>
        ) : null}

        {isInterrupted ? (
          <View
            style={[
              styles.interrupted,
              { borderColor: theme.colors.border, marginTop: message.content ? 8 : 0 },
            ]}
          >
            <Icon name="alert-circle-outline" size={14} tone="muted" />
            <Text variant="caption" tone="muted" style={{ marginStart: 6, flex: 1 }}>
              انقطع التوليد قبل اكتماله.
            </Text>
            {onRetry ? (
              <Pressable onPress={onRetry} style={styles.retryBtn} accessibilityRole="button">
                <Text variant="caption" weight="semibold" tone="primary">
                  إعادة المحاولة
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', marginBottom: 12 },
  bubble: { paddingVertical: 10, paddingHorizontal: 14 },
  typing: { flexDirection: 'row', alignItems: 'center' },
  attachments: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  attPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  interrupted: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
  },
  retryBtn: { paddingHorizontal: 8, paddingVertical: 2 },
});
