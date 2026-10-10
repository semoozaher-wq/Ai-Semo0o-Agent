import type { IconName } from '../components/ui/Icon';

export interface NavItem {
  key: string;
  /** Arabic label (RTL). */
  label: string;
  /** Short label used by the compact bottom bar. */
  short?: string;
  /** expo-router path. */
  href: string;
  icon: IconName;
  iconActive: IconName;
  group: 'main' | 'secondary';
}

/**
 * Primary navigation — mirrors the Semo0o reference design. The eight "main"
 * entries are the working set of the platform; the "secondary" group keeps the
 * remaining real surfaces (studio, operations, analytics) reachable without
 * cluttering the primary rail.
 *
 * There is intentionally no "store" entry — the product is a platform, not a
 * shop.
 */
export const NAV_ITEMS: NavItem[] = [
  {
    key: 'home',
    label: 'الرئيسية',
    short: 'الرئيسية',
    href: '/',
    icon: 'home-outline',
    iconActive: 'home',
    group: 'main',
  },
  {
    key: 'chats',
    label: 'المحادثات',
    short: 'المحادثات',
    href: '/chat',
    icon: 'chatbubbles-outline',
    iconActive: 'chatbubbles',
    group: 'main',
  },
  {
    key: 'projects',
    label: 'المشاريع',
    short: 'المشاريع',
    href: '/workspace',
    icon: 'briefcase-outline',
    iconActive: 'briefcase',
    group: 'main',
  },
  {
    key: 'tasks',
    label: 'المهام',
    short: 'المهام',
    href: '/agents',
    icon: 'checkbox-outline',
    iconActive: 'checkbox',
    group: 'main',
  },
  {
    key: 'files',
    label: 'الملفات',
    short: 'الملفات',
    href: '/files',
    icon: 'document-text-outline',
    iconActive: 'document-text',
    group: 'main',
  },
  {
    key: 'agents',
    label: 'الوكلاء الذكي',
    short: 'الوكلاء',
    href: '/library',
    icon: 'hardware-chip-outline',
    iconActive: 'hardware-chip',
    group: 'main',
  },
  {
    key: 'integrations',
    label: 'التكاملات',
    short: 'التكاملات',
    href: '/integrations',
    icon: 'link-outline',
    iconActive: 'link',
    group: 'main',
  },
  {
    key: 'settings',
    label: 'الإعدادات',
    short: 'الإعدادات',
    href: '/settings',
    icon: 'settings-outline',
    iconActive: 'settings',
    group: 'main',
  },
  {
    key: 'studio',
    label: 'الاستوديو',
    href: '/studio',
    icon: 'sparkles-outline',
    iconActive: 'sparkles',
    group: 'secondary',
  },
  {
    key: 'operations',
    label: 'العمليات',
    href: '/operations',
    icon: 'pulse-outline',
    iconActive: 'pulse',
    group: 'secondary',
  },
  {
    key: 'analytics',
    label: 'التحليلات',
    href: '/analytics',
    icon: 'stats-chart-outline',
    iconActive: 'stats-chart',
    group: 'secondary',
  },
];

export const MAIN_NAV = NAV_ITEMS.filter((i) => i.group === 'main');
export const SECONDARY_NAV = NAV_ITEMS.filter((i) => i.group === 'secondary');

/** Items shown in the compact mobile bottom bar. */
export const MOBILE_TABS = ['home', 'chats', 'tasks', 'files', 'settings']
  .map((key) => NAV_ITEMS.find((i) => i.key === key))
  .filter((i): i is NavItem => Boolean(i));

/** Resolve which nav item is active for a given pathname. */
export function activeKeyForPath(pathname: string): string | undefined {
  const clean = (pathname || '/').split('?')[0] ?? '';
  if (clean === '/' || clean === '') return 'home';
  // Longest-prefix match so /agent/123 still highlights the agents rail.
  const candidates = NAV_ITEMS.filter(
    (i) => i.href !== '/' && (clean === i.href || clean.startsWith(`${i.href}/`)),
  );
  if (candidates.length) {
    const best = candidates.sort((a, b) => b.href.length - a.href.length)[0];
    return best?.key;
  }
  if (clean.startsWith('/agent/')) return 'agents';
  return undefined;
}
