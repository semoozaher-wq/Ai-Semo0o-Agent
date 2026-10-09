import { useWindowDimensions } from 'react-native';

export type Breakpoint = 'mobile' | 'tablet' | 'desktop';

export interface Responsive {
  width: number;
  height: number;
  breakpoint: Breakpoint;
  /** < 640px — single column, stacked navigation */
  isMobile: boolean;
  /** 640px–1023px — comfortable two-column where useful */
  isTablet: boolean;
  /** >= 1024px — split layouts, side panels */
  isDesktop: boolean;
  /** A sensible max content width for centered reading/forms. */
  contentWidth: number;
  /** True when the layout should present a persistent side rail. */
  showSideRail: boolean;
}

/**
 * Central responsive helper. Screens consume this instead of hard-coding
 * breakpoints so the whole product scales from phones to wide desktops with a
 * single source of truth.
 */
export function useResponsive(): Responsive {
  const { width, height } = useWindowDimensions();

  const breakpoint: Breakpoint =
    width >= 1024 ? 'desktop' : width >= 640 ? 'tablet' : 'mobile';

  return {
    width,
    height,
    breakpoint,
    isMobile: breakpoint === 'mobile',
    isTablet: breakpoint === 'tablet',
    isDesktop: breakpoint === 'desktop',
    contentWidth: Math.min(width, 1180),
    showSideRail: width >= 1024,
  };
}
