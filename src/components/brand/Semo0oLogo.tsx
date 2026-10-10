import React from 'react';
import { StyleProp, TextStyle, View, ViewStyle } from 'react-native';
import Svg, {
  Circle,
  Defs,
  LinearGradient,
  Path,
  Stop,
} from 'react-native-svg';
import { useTheme } from '../../theme';
import { Text } from '../ui/Text';

/* -------------------------------------------------------------------------- */
/*  Geometry — the original Semo0o "S" ribbon + neural nodes                   */
/* -------------------------------------------------------------------------- */

const S_PATH =
  'M330 168 C 330 132, 296 112, 256 112 C 210 112, 178 136, 178 172 ' +
  'C 178 206, 214 220, 256 230 C 298 240, 334 254, 334 292 ' +
  'C 334 330, 300 356, 256 356 C 210 356, 180 336, 178 302';

const TRACE_TOP = 'M330 168 L392 168 L420 140';
const TRACE_BOTTOM = 'M178 302 L120 302 L92 330';

export interface Semo0oMarkProps {
  size?: number;
  /** Render the circuit traces + terminal nodes (default true). */
  detailed?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * The Semo0o brand mark — an original monogram: a continuous gradient "S"
 * ribbon that doubles as a neural/circuit path, terminated by two glowing
 * nodes. Drawn with react-native-svg so it stays razor sharp at every size
 * (sidebar, app icon, splash, favicon).
 */
export function Semo0oMark({ size = 40, detailed = true, style }: Semo0oMarkProps) {
  const uid = React.useId().replace(/[:]/g, '');
  const stroke = `sStroke-${uid}`;
  const nodeA = `sNodeA-${uid}`;
  const nodeB = `sNodeB-${uid}`;

  return (
    <View style={[{ width: size, height: size }, style]}>
      <Svg width={size} height={size} viewBox="0 0 512 512">
        <Defs>
          <LinearGradient id={stroke} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#A78BFA" />
            <Stop offset="0.5" stopColor="#6C5CE7" />
            <Stop offset="1" stopColor="#22D3EE" />
          </LinearGradient>
          <LinearGradient id={nodeA} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#C4B5FD" />
            <Stop offset="1" stopColor="#7C3AED" />
          </LinearGradient>
          <LinearGradient id={nodeB} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#A5F3FC" />
            <Stop offset="1" stopColor="#06B6D4" />
          </LinearGradient>
        </Defs>

        {detailed ? (
          <>
            <Path
              d={TRACE_TOP}
              stroke={`url(#${stroke})`}
              strokeWidth={12}
              strokeLinecap="round"
              fill="none"
              opacity={0.5}
            />
            <Path
              d={TRACE_BOTTOM}
              stroke={`url(#${stroke})`}
              strokeWidth={12}
              strokeLinecap="round"
              fill="none"
              opacity={0.5}
            />
            <Circle cx={420} cy={140} r={10} fill={`url(#${stroke})`} opacity={0.7} />
            <Circle cx={92} cy={330} r={10} fill={`url(#${stroke})`} opacity={0.7} />
          </>
        ) : null}

        <Path
          d={S_PATH}
          stroke={`url(#${stroke})`}
          strokeWidth={48}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />

        {detailed ? (
          <>
            <Circle cx={330} cy={168} r={30} fill={`url(#${nodeA})`} />
            <Circle cx={330} cy={168} r={12} fill="#0C1230" />
            <Circle cx={178} cy={302} r={30} fill={`url(#${nodeB})`} />
            <Circle cx={178} cy={302} r={12} fill="#0C1230" />
          </>
        ) : null}
      </Svg>
    </View>
  );
}

export interface Semo0oLogoProps {
  /** Height of the mark, in px. The wordmark scales relative to it. */
  size?: number;
  orientation?: 'horizontal' | 'stacked';
  /** Show the "AI AGENT PLATFORM" tagline. */
  tagline?: boolean;
  /** Wordmark colour override (defaults to the theme text colour). */
  color?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * Full Semo0o lockup — mark + wordmark, optionally with the tagline. Adapts to
 * the active theme so it reads correctly on the navy canvas and on light
 * surfaces alike.
 */
export function Semo0oLogo({
  size = 44,
  orientation = 'horizontal',
  tagline = false,
  color,
  style,
}: Semo0oLogoProps) {
  const theme = useTheme();
  const textColor = color ?? theme.colors.text;

  const wordStyle: TextStyle = {
    fontFamily: 'Poppins_700Bold',
    fontSize: size * 0.86,
    letterSpacing: -1,
    color: textColor,
    includeFontPadding: false,
  };
  const tagStyle: TextStyle = {
    fontFamily: 'Poppins_500Medium',
    fontSize: Math.max(8, size * 0.2),
    letterSpacing: size * 0.09,
    color: theme.colors.textMuted,
    includeFontPadding: false,
  };

  if (orientation === 'stacked') {
    return (
      <View style={[{ alignItems: 'center' }, style]}>
        <Semo0oMark size={size * 1.5} />
        <View style={{ marginTop: size * 0.28, alignItems: 'center' }}>
          <Text style={wordStyle}>Semo0o</Text>
          {tagline ? <Text style={[tagStyle, { marginTop: 2 }]}>AI AGENT PLATFORM</Text> : null}
        </View>
      </View>
    );
  }

  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center' }, style]}>
      <Semo0oMark size={size} />
      <View style={{ marginStart: size * 0.28 }}>
        <Text style={wordStyle}>Semo0o</Text>
        {tagline ? <Text style={[tagStyle, { marginTop: -2 }]}>AI AGENT PLATFORM</Text> : null}
      </View>
    </View>
  );
}
