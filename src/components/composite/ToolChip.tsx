import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../theme';
import { ToolDefinition } from '../../types/tool';
import { Text } from '../ui/Text';
import { Icon, IconName } from '../ui/Icon';

const CATEGORY_ICON: Record<ToolDefinition['category'], IconName> = {
  web: 'globe-outline',
  code: 'code-slash-outline',
  data: 'stats-chart-outline',
  files: 'folder-outline',
  media: 'image-outline',
  system: 'settings-outline',
  productivity: 'briefcase-outline',
  ai: 'sparkles-outline',
  github: 'logo-github',
  zip: 'archive-outline',
};

export interface ToolChipProps {
  tool: ToolDefinition;
  active?: boolean;
}

export function ToolChip({ tool, active = false }: ToolChipProps) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.chip,
        {
          backgroundColor: active ? theme.colors.accentSoft : theme.colors.surfaceMuted,
          borderRadius: theme.radius.pill,
          borderColor: active ? theme.colors.accent : theme.colors.border,
          borderWidth: StyleSheet.hairlineWidth,
          paddingVertical: 6,
          paddingHorizontal: 10,
        },
      ]}
    >
      <Icon
        name={CATEGORY_ICON[tool.category]}
        size={14}
        tone={active ? 'accent' : 'muted'}
      />
      <Text
        variant="caption"
        tone={active ? 'accent' : 'muted'}
        style={{ marginStart: 6 }}
      >
        {tool.nameAr}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start' },
});
