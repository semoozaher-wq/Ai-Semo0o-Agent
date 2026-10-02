export type AgentCategory =
  | 'productivity'
  | 'development'
  | 'data'
  | 'creative'
  | 'research'
  | 'health'
  | 'finance'
  | 'education'
  | 'automation'
  | 'communication';

export type AgentPermission =
  | 'internet'
  | 'files.read'
  | 'files.write'
  | 'code.execute'
  | 'notifications'
  | 'calendar'
  | 'email'
  | 'camera'
  | 'microphone'
  | 'location'
  | 'payments';

export type AgentPricing = 'free' | 'freemium' | 'premium' | 'subscription';

export type PermissionRisk = 'low' | 'medium' | 'high';

export interface AgentPermissionSpec {
  id: AgentPermission;
  label: string;
  labelAr: string;
  description: string;
  descriptionAr: string;
  risk: PermissionRisk;
}

export interface AgentVersion {
  version: string;
  releasedAt: string;
  changelog: string;
  sizeMb: number;
}

export interface AgentReview {
  id: string;
  author: string;
  avatarColor: string;
  rating: number;
  text: string;
  createdAt: string;
  helpful: number;
}

export interface AgentManifest {
  id: string;
  slug: string;
  name: string;
  nameAr: string;
  tagline: string;
  taglineAr: string;
  description: string;
  descriptionAr: string;
  category: AgentCategory;
  /** Emoji or icon key rendered in the store card. */
  icon: string;
  /** Theme gradient name or hex accent. */
  accent: string;
  author: string;
  authorVerified: boolean;
  version: string;
  pricing: AgentPricing;
  priceLabel?: string;
  rating: number;
  ratingCount: number;
  installs: number;
  sizeMb: number;
  permissions: AgentPermission[];
  capabilities: string[];
  capabilitiesAr: string[];
  screenshots: string[];
  reviews: AgentReview[];
  featured?: boolean;
  editorsChoice?: boolean;
  tags: string[];
  updatedAt: string;
  minPlatformVersion: string;
  defaultModel?: string;
  systemPrompt?: string;
  tools?: string[];
  builtIn?: boolean;
}

export type InstallState =
  | 'not-installed'
  | 'installing'
  | 'installed'
  | 'update-available'
  | 'updating';

export interface InstalledAgent {
  agentId: string;
  installedAt: string;
  version: string;
  enabled: boolean;
  pinned?: boolean;
  state: InstallState;
  autoUpdate: boolean;
  grantedPermissions: AgentPermission[];
  lastRunAt?: string;
  runCount: number;
}

export interface StoreCategory {
  id: AgentCategory | 'all' | 'featured';
  label: string;
  labelAr: string;
  icon: string;
}
