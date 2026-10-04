import React from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Ellipse, G, Rect } from 'react-native-svg';
import { useTheme } from '../../theme';
import { Text } from '../ui/Text';
import { BodyView, Gender } from '../../types/anatomy';

/**
 * Interactive, dependency-free anatomical body map.
 *
 * Renders a stylised humanoid silhouette built from primitive SVG shapes and
 * makes each muscle group tappable. The 317-fragment catalogue is far too
 * granular to draw as vector paths, so the map exposes the 23 muscle *groups*
 * and the screen drills down to individual fragments.
 */

type Shape =
  | { kind: 'ellipse'; group: string; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'rect'; group: string; x: number; y: number; w: number; h: number; r: number };

const VIEWBOX_W = 240;
const VIEWBOX_H = 470;

/** Neutral, non-interactive silhouette scaffolding (drawn beneath groups). */
const NEUTRAL: Shape[] = [
  { kind: 'rect', group: '__torso', x: 96, y: 92, w: 48, h: 130, r: 22 },
  { kind: 'rect', group: '__pelvis', x: 98, y: 206, w: 44, h: 34, r: 14 },
];

const FRONT: Shape[] = [
  { kind: 'ellipse', group: 'head', cx: 120, cy: 54, rx: 27, ry: 31 },
  { kind: 'rect', group: 'neck', x: 110, y: 80, w: 20, h: 22, r: 8 },
  { kind: 'ellipse', group: 'deltoids', cx: 76, cy: 116, rx: 19, ry: 17 },
  { kind: 'ellipse', group: 'deltoids', cx: 164, cy: 116, rx: 19, ry: 17 },
  { kind: 'ellipse', group: 'chest', cx: 101, cy: 132, rx: 21, ry: 24 },
  { kind: 'ellipse', group: 'chest', cx: 139, cy: 132, rx: 21, ry: 24 },
  { kind: 'rect', group: 'abs', x: 101, y: 158, w: 38, h: 58, r: 13 },
  { kind: 'ellipse', group: 'obliques', cx: 92, cy: 182, rx: 9, ry: 26 },
  { kind: 'ellipse', group: 'obliques', cx: 148, cy: 182, rx: 9, ry: 26 },
  { kind: 'ellipse', group: 'biceps', cx: 60, cy: 154, rx: 13, ry: 26 },
  { kind: 'ellipse', group: 'biceps', cx: 180, cy: 154, rx: 13, ry: 26 },
  { kind: 'ellipse', group: 'forearm', cx: 49, cy: 210, rx: 11, ry: 28 },
  { kind: 'ellipse', group: 'forearm', cx: 191, cy: 210, rx: 11, ry: 28 },
  { kind: 'ellipse', group: 'hands', cx: 45, cy: 256, rx: 10, ry: 14 },
  { kind: 'ellipse', group: 'hands', cx: 195, cy: 256, rx: 10, ry: 14 },
  { kind: 'ellipse', group: 'adductors', cx: 108, cy: 244, rx: 13, ry: 30 },
  { kind: 'ellipse', group: 'adductors', cx: 132, cy: 244, rx: 13, ry: 30 },
  { kind: 'ellipse', group: 'quadriceps', cx: 104, cy: 282, rx: 16, ry: 42 },
  { kind: 'ellipse', group: 'quadriceps', cx: 136, cy: 282, rx: 16, ry: 42 },
  { kind: 'ellipse', group: 'knees', cx: 104, cy: 334, rx: 13, ry: 13 },
  { kind: 'ellipse', group: 'knees', cx: 136, cy: 334, rx: 13, ry: 13 },
  { kind: 'ellipse', group: 'tibialis', cx: 104, cy: 374, rx: 12, ry: 34 },
  { kind: 'ellipse', group: 'tibialis', cx: 136, cy: 374, rx: 12, ry: 34 },
  { kind: 'ellipse', group: 'ankles', cx: 104, cy: 416, rx: 9, ry: 9 },
  { kind: 'ellipse', group: 'ankles', cx: 136, cy: 416, rx: 9, ry: 9 },
  { kind: 'ellipse', group: 'feet', cx: 104, cy: 434, rx: 13, ry: 11 },
  { kind: 'ellipse', group: 'feet', cx: 136, cy: 434, rx: 13, ry: 11 },
];

const BACK: Shape[] = [
  { kind: 'ellipse', group: 'head', cx: 120, cy: 54, rx: 27, ry: 31 },
  { kind: 'ellipse', group: 'hair', cx: 120, cy: 42, rx: 29, ry: 24 },
  { kind: 'rect', group: 'neck', x: 110, y: 80, w: 20, h: 22, r: 8 },
  { kind: 'ellipse', group: 'trapezius', cx: 120, cy: 104, rx: 40, ry: 18 },
  { kind: 'ellipse', group: 'deltoids', cx: 76, cy: 116, rx: 19, ry: 17 },
  { kind: 'ellipse', group: 'deltoids', cx: 164, cy: 116, rx: 19, ry: 17 },
  { kind: 'rect', group: 'upper-back', x: 94, y: 116, w: 52, h: 48, r: 14 },
  { kind: 'rect', group: 'lower-back', x: 101, y: 168, w: 38, h: 44, r: 12 },
  { kind: 'ellipse', group: 'triceps', cx: 60, cy: 154, rx: 13, ry: 26 },
  { kind: 'ellipse', group: 'triceps', cx: 180, cy: 154, rx: 13, ry: 26 },
  { kind: 'ellipse', group: 'forearm', cx: 49, cy: 210, rx: 11, ry: 28 },
  { kind: 'ellipse', group: 'forearm', cx: 191, cy: 210, rx: 11, ry: 28 },
  { kind: 'ellipse', group: 'hands', cx: 45, cy: 256, rx: 10, ry: 14 },
  { kind: 'ellipse', group: 'hands', cx: 195, cy: 256, rx: 10, ry: 14 },
  { kind: 'ellipse', group: 'gluteal', cx: 107, cy: 226, rx: 17, ry: 15 },
  { kind: 'ellipse', group: 'gluteal', cx: 133, cy: 226, rx: 17, ry: 15 },
  { kind: 'ellipse', group: 'hamstring', cx: 104, cy: 282, rx: 16, ry: 42 },
  { kind: 'ellipse', group: 'hamstring', cx: 136, cy: 282, rx: 16, ry: 42 },
  { kind: 'ellipse', group: 'knees', cx: 104, cy: 334, rx: 13, ry: 13 },
  { kind: 'ellipse', group: 'knees', cx: 136, cy: 334, rx: 13, ry: 13 },
  { kind: 'ellipse', group: 'calves', cx: 104, cy: 374, rx: 13, ry: 34 },
  { kind: 'ellipse', group: 'calves', cx: 136, cy: 374, rx: 13, ry: 34 },
  { kind: 'ellipse', group: 'ankles', cx: 104, cy: 416, rx: 9, ry: 9 },
  { kind: 'ellipse', group: 'ankles', cx: 136, cy: 416, rx: 9, ry: 9 },
  { kind: 'ellipse', group: 'feet', cx: 104, cy: 434, rx: 13, ry: 11 },
  { kind: 'ellipse', group: 'feet', cx: 136, cy: 434, rx: 13, ry: 11 },
];

export interface BodyMapProps {
  gender: Gender;
  view: BodyView;
  selectedGroup: string | null;
  onSelectGroup: (group: string) => void;
  /** Groups that have fragments for the current gender/view. */
  availableGroups?: string[];
  /** Rendered width; height is derived from the aspect ratio. */
  width?: number;
}

export function BodyMap({
  gender,
  view,
  selectedGroup,
  onSelectGroup,
  availableGroups,
  width = 260,
}: BodyMapProps) {
  const theme = useTheme();
  const shapes = view === 'front' ? FRONT : BACK;
  const height = (width * VIEWBOX_H) / VIEWBOX_W;

  const baseFill = theme.colors.surfaceMuted;
  const neutralFill = theme.colors.surfaceElevated;
  const stroke = theme.colors.border;
  const selectedFill = theme.colors.primary;
  const available = availableGroups ? new Set(availableGroups) : null;

  const fillFor = (group: string) => {
    if (group === selectedGroup) return selectedFill;
    if (group.startsWith('__')) return neutralFill;
    if (available && !available.has(group)) return theme.colors.surfaceElevated;
    return baseFill;
  };

  return (
    <View style={styles.wrap}>
      <Svg
        width={width}
        height={height}
        viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
        accessibilityRole="image"
        accessibilityLabel="خريطة تشريحية تفاعلية؛ المعلومات تعليمية وليست تشخيصًا طبيًا"
      >
        {/* neutral scaffolding */}
        {NEUTRAL.map((s, i) =>
          s.kind === 'rect' ? (
            <Rect
              key={`n${i}`}
              x={s.x}
              y={s.y}
              width={s.w}
              height={s.h}
              rx={s.r}
              fill={neutralFill}
              stroke={stroke}
              strokeWidth={1}
            />
          ) : null,
        )}

        {/* interactive muscle groups */}
        {shapes.map((s, i) => {
          const isNeutral = s.group.startsWith('__');
          const isSelected = s.group === selectedGroup;
          const fill = fillFor(s.group);
          const common = {
            fill,
            stroke: isSelected ? theme.colors.primary : stroke,
            strokeWidth: isSelected ? 2 : 1,
            onPress: isNeutral ? undefined : () => onSelectGroup(s.group),
          } as const;

          if (s.kind === 'ellipse') {
            return (
              <Ellipse
                key={`s${i}`}
                cx={s.cx}
                cy={s.cy}
                rx={s.rx}
                ry={s.ry}
                {...common}
                accessibilityLabel={isNeutral ? undefined : `اختيار مجموعة ${s.group}`}
              />
            );
          }
          return (
            <Rect
              key={`s${i}`}
              x={s.x}
              y={s.y}
              width={s.w}
              height={s.h}
              rx={s.r}
              {...common}
              accessibilityLabel={isNeutral ? undefined : `اختيار مجموعة ${s.group}`}
            />
          );
        })}

        {/* centre line hint */}
        <G>
          <Rect
            x={VIEWBOX_W / 2 - 0.5}
            y={20}
            width={1}
            height={VIEWBOX_H - 40}
            fill={theme.colors.border}
            opacity={0.35}
          />
        </G>
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 14,
    marginTop: 10,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 12, height: 12, borderRadius: 6, borderWidth: 1 },
});

/** Small legend rendered beneath the map. */
export function BodyMapLegend() {
  const theme = useTheme();
  const items = [
    { color: theme.colors.primary, label: 'محدد' },
    { color: theme.colors.surfaceMuted, label: 'قابل للاختيار' },
    { color: theme.colors.surfaceElevated, label: 'غير متاح' },
  ];
  return (
    <View style={styles.legend}>
      {items.map((it) => (
        <View key={it.label} style={styles.legendItem}>
          <View
            style={[
              styles.dot,
              { backgroundColor: it.color, borderColor: theme.colors.border },
            ]}
          />
          <Text variant="caption" tone="muted">
            {it.label}
          </Text>
        </View>
      ))}
    </View>
  );
}
