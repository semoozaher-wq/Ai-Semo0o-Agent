import React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useTheme } from '../../theme';
import { Message } from '../../types/chat';
import { Text } from '../ui/Text';
import { Icon } from '../ui/Icon';
import { Avatar } from '../ui/Avatar';

export interface ChatBubbleProps {
  message: Message;
}

export function ChatBubble({ message }: ChatBubbleProps) {
  const theme = useTheme();
  const isUser = message.role === 'user';
  const isError = message.status === 'error';

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
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', marginBottom: 12 },
  bubble: { paddingVertical: 10, paddingHorizontal: 14 },
  typing: { flexDirection: 'row', alignItems: 'center' },
});
