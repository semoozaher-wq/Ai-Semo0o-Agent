import {
  AgentManifest,
  AgentPermission,
  InstalledAgent,
  InstallState,
  StoreCategory,
} from '../../types/agent';
import { AGENTS, STORE_CATEGORIES, getAgent } from '../../data/agents';
import { storage, STORAGE_KEYS } from '../storage';
import { sleep } from '../../utils/async';
import { clamp } from '../../utils/array';

export interface StoreQuery {
  category?: StoreCategory['id'];
  search?: string;
  pricing?: AgentManifest['pricing'] | 'all';
  minRating?: number;
  sort?: 'relevance' | 'rating' | 'installs' | 'recent' | 'name';
  installedOnly?: boolean;
}

export interface StoreStats {
  totalAgents: number;
  installed: number;
  updates: number;
  categories: number;
  avgRating: number;
}

/**
 * StoreService — the "app store" for AI agents.
 *
 * Owns the catalog (read-only manifests) and the per-user install state
 * (persisted through the KV store). Mirrors Google Play semantics: browse →
 * install → grant permissions → update → uninstall.
 */
export class StoreService {
  private installed = new Map<string, InstalledAgent>();
  private loaded = false;

  /* ------------------------------- catalog ------------------------------- */

  catalog(): AgentManifest[] {
    return AGENTS;
  }

  categories(): StoreCategory[] {
    return STORE_CATEGORIES;
  }

  get(agentId: string): AgentManifest | undefined {
    return getAgent(agentId);
  }

  search(query: StoreQuery = {}): AgentManifest[] {
    const {
      category = 'all',
      search = '',
      pricing = 'all',
      minRating = 0,
      sort = 'relevance',
      installedOnly = false,
    } = query;

    let items = [...AGENTS];

    if (category === 'featured') {
      items = items.filter((a) => a.featured || a.editorsChoice);
    } else if (category !== 'all') {
      items = items.filter((a) => a.category === category);
    }

    if (pricing !== 'all') {
      items = items.filter((a) => a.pricing === pricing);
    }

    if (minRating > 0) {
      items = items.filter((a) => a.rating >= minRating);
    }

    const q = search.trim().toLowerCase();
    if (q) {
      items = items.filter((a) =>
        [
          a.name,
          a.nameAr,
          a.tagline,
          a.taglineAr,
          a.description,
          a.descriptionAr,
          ...a.tags,
          ...a.capabilities,
          ...a.capabilitiesAr,
        ]
          .join(' ')
          .toLowerCase()
          .includes(q),
      );
    }

    if (installedOnly) {
      items = items.filter((a) => this.installed.has(a.id));
    }

    switch (sort) {
      case 'rating':
        items.sort((a, b) => b.rating - a.rating);
        break;
      case 'installs':
        items.sort((a, b) => b.installs - a.installs);
        break;
      case 'recent':
        items.sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        );
        break;
      case 'name':
        items.sort((a, b) => a.nameAr.localeCompare(b.nameAr, 'ar'));
        break;
      default:
        items.sort((a, b) => {
          const score = (x: AgentManifest) =>
            (x.featured ? 2 : 0) + (x.editorsChoice ? 1 : 0) + x.rating / 5;
          return score(b) - score(a);
        });
    }

    return items;
  }

  featured(): AgentManifest[] {
    return AGENTS.filter((a) => a.featured);
  }

  editorsChoice(): AgentManifest[] {
    return AGENTS.filter((a) => a.editorsChoice);
  }

  /* ------------------------------ install state -------------------------- */

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const stored = await storage.get<InstalledAgent[]>(
      STORAGE_KEYS.installedAgents,
    );
    if (stored) {
      stored.forEach((a) => this.installed.set(a.agentId, a));
    } else {
      // Seed a couple of built-in agents as pre-installed.
      AGENTS.filter((a) => a.builtIn).forEach((a) => {
        this.installed.set(a.id, {
          agentId: a.id,
          installedAt: new Date().toISOString(),
          version: a.version,
          enabled: true,
          state: 'installed',
          autoUpdate: true,
          grantedPermissions: a.permissions,
          runCount: 0,
        });
      });
      await this.persist();
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await storage.set(
      STORAGE_KEYS.installedAgents,
      Array.from(this.installed.values()),
    );
  }

  async listInstalled(): Promise<InstalledAgent[]> {
    await this.ensureLoaded();
    return Array.from(this.installed.values());
  }

  async getInstalled(agentId: string): Promise<InstalledAgent | undefined> {
    await this.ensureLoaded();
    return this.installed.get(agentId);
  }

  async stateOf(agentId: string): Promise<InstallState> {
    await this.ensureLoaded();
    const rec = this.installed.get(agentId);
    if (!rec) return 'not-installed';
    const manifest = getAgent(agentId);
    if (manifest && manifest.version !== rec.version) return 'update-available';
    return rec.state === 'updating' ? 'updating' : 'installed';
  }

  async install(agentId: string): Promise<InstalledAgent> {
    await this.ensureLoaded();
    const manifest = getAgent(agentId);
    if (!manifest) throw new Error(`وكيل غير معروف: ${agentId}`);

    const pending: InstalledAgent = {
      agentId,
      installedAt: new Date().toISOString(),
      version: manifest.version,
      enabled: true,
      state: 'installing',
      autoUpdate: true,
      grantedPermissions: manifest.permissions,
      runCount: 0,
    };
    this.installed.set(agentId, pending);
    await this.persist();

    await sleep(600); // simulate download + install

    const done: InstalledAgent = { ...pending, state: 'installed' };
    this.installed.set(agentId, done);
    await this.persist();
    return done;
  }

  async uninstall(agentId: string): Promise<void> {
    await this.ensureLoaded();
    this.installed.delete(agentId);
    await this.persist();
  }

  async update(agentId: string): Promise<InstalledAgent> {
    await this.ensureLoaded();
    const manifest = getAgent(agentId);
    const rec = this.installed.get(agentId);
    if (!manifest || !rec) throw new Error('لا يمكن التحديث: الوكيل غير مثبّت.');

    this.installed.set(agentId, { ...rec, state: 'updating' });
    await this.persist();
    await sleep(500);
    const updated: InstalledAgent = {
      ...rec,
      version: manifest.version,
      state: 'installed',
    };
    this.installed.set(agentId, updated);
    await this.persist();
    return updated;
  }

  async setEnabled(agentId: string, enabled: boolean): Promise<void> {
    await this.ensureLoaded();
    const rec = this.installed.get(agentId);
    if (!rec) return;
    this.installed.set(agentId, { ...rec, enabled });
    await this.persist();
  }

  async setAutoUpdate(agentId: string, autoUpdate: boolean): Promise<void> {
    await this.ensureLoaded();
    const rec = this.installed.get(agentId);
    if (!rec) return;
    this.installed.set(agentId, { ...rec, autoUpdate });
    await this.persist();
  }

  async setPinned(agentId: string, pinned: boolean): Promise<void> {
    await this.ensureLoaded();
    const rec = this.installed.get(agentId);
    if (!rec) return;
    this.installed.set(agentId, { ...rec, pinned });
    await this.persist();
  }

  async grantPermission(
    agentId: string,
    permission: AgentPermission,
  ): Promise<void> {
    await this.ensureLoaded();
    const rec = this.installed.get(agentId);
    if (!rec) return;
    const granted = Array.from(
      new Set([...rec.grantedPermissions, permission]),
    );
    this.installed.set(agentId, { ...rec, grantedPermissions: granted });
    await this.persist();
  }

  async revokePermission(
    agentId: string,
    permission: AgentPermission,
  ): Promise<void> {
    await this.ensureLoaded();
    const rec = this.installed.get(agentId);
    if (!rec) return;
    this.installed.set(agentId, {
      ...rec,
      grantedPermissions: rec.grantedPermissions.filter((p) => p !== permission),
    });
    await this.persist();
  }

  async recordRun(agentId: string): Promise<void> {
    await this.ensureLoaded();
    const rec = this.installed.get(agentId);
    if (!rec) return;
    this.installed.set(agentId, {
      ...rec,
      runCount: rec.runCount + 1,
      lastRunAt: new Date().toISOString(),
    });
    await this.persist();
  }

  async updates(): Promise<AgentManifest[]> {
    await this.ensureLoaded();
    return AGENTS.filter((a) => {
      const rec = this.installed.get(a.id);
      return rec && rec.version !== a.version;
    });
  }

  async stats(): Promise<StoreStats> {
    await this.ensureLoaded();
    const installed = this.installed.size;
    const updates = (await this.updates()).length;
    const avgRating =
      AGENTS.reduce((acc, a) => acc + a.rating, 0) / Math.max(AGENTS.length, 1);
    return {
      totalAgents: AGENTS.length,
      installed,
      updates,
      categories: STORE_CATEGORIES.length,
      avgRating: clamp(Number(avgRating.toFixed(2)), 0, 5),
    };
  }

  async reset(): Promise<void> {
    this.installed.clear();
    this.loaded = false;
    await storage.remove(STORAGE_KEYS.installedAgents);
  }
}

export const storeService = new StoreService();
