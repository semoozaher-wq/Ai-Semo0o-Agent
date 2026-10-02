import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';
import { I18nManager, useColorScheme } from 'react-native';
import { darkTheme, lightTheme, Theme, ThemeMode } from './theme';

export type ThemePreference = 'system' | ThemeMode;

interface ThemeContextValue {
  theme: Theme;
  mode: ThemeMode;
  preference: ThemePreference;
  isRTL: boolean;
  setPreference: (pref: ThemePreference) => void;
  toggleMode: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  children: React.ReactNode;
  /** Force a mode (used by the static web preview). */
  initialPreference?: ThemePreference;
  /** Force RTL/LTR (used by the static web preview). */
  initialRTL?: boolean;
}

export function ThemeProvider({
  children,
  initialPreference = 'dark',
  initialRTL = true,
}: ThemeProviderProps) {
  const systemScheme = useColorScheme();
  const [preference, setPreferenceState] =
    useState<ThemePreference>(initialPreference);
  const [isRTL, setIsRTL] = useState<boolean>(initialRTL);

  const resolvedMode: ThemeMode =
    preference === 'system'
      ? systemScheme === 'light'
        ? 'light'
        : 'dark'
      : preference;

  const theme = resolvedMode === 'dark' ? darkTheme : lightTheme;

  const setPreference = useCallback((pref: ThemePreference) => {
    setPreferenceState(pref);
    const rtl = pref === 'light' ? I18nManager.isRTL : true;
    setIsRTL(rtl);
  }, []);

  const toggleMode = useCallback(() => {
    setPreferenceState((prev) => {
      const current =
        prev === 'system'
          ? systemScheme === 'light'
            ? 'light'
            : 'dark'
          : prev;
      return current === 'dark' ? 'light' : 'dark';
    });
  }, [systemScheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      mode: resolvedMode,
      preference,
      isRTL,
      setPreference,
      toggleMode,
    }),
    [theme, resolvedMode, preference, isRTL, setPreference, toggleMode],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): Theme {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return ctx.theme;
}

export function useThemeController(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useThemeController must be used within a ThemeProvider');
  }
  return ctx;
}
