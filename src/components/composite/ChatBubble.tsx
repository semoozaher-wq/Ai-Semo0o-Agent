import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '../../theme';
import { Message } from '../../types/chat';
import { Text } from '../ui/Text';
import { Icon } from '../ui/Icon';
import { Avatar } from '../ui/Avatar';

export interface ChatBubbleProps {
  message: Message;
  /** Called when the user taps "retry" on an interrupted assistant turn. */
  onRetry?: (() => void) | undefined;
}

export function ChatBubble({ message, onRetry }: ChatBubbleProps) {
  const theme = useTheme();
  const isUser = message.role === 'user';
  const isError = message.status === 'error';
  const isInterrupted = message.status === 'interrupted';

  return (
    <View
      style={[
        styles.row,
        { justifyContent: isUser ? 'flex-start' : 'flex-end' },
      ]}
    >
      {!isUser ? (
        <View style={{ marginEnd: 8, alignSelf: 'flex-end' }}>
          <Avatar emoji="🤖" size={30} color={theme.colors.primary} />
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
            borderColor: theme.colors.border,
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

        {message.status === 'streaming' && message.content ? (
          <View style={{ marginTop: 6 }}>
            <Icon name="ellipsis-horizontal" size={14} tone="accent" />
          </View>
        ) : null}

        {isInterrupted ? (
          <View style={[styles.interrupted, { borderColor: theme.colors.border, marginTop: message.content ? 8 : 0 }]}>
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
  interrupted: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
  },
  retryBtn: { paddingHorizontal: 8, paddingVertical: 2 },
});
