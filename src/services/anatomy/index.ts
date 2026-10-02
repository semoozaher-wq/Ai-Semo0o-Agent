import anatomyRaw from '../../../data/anatomyPainMap.json';
import {
  AnatomyCatalog,
  AnatomyFilter,
  BodyView,
  Gender,
  MuscleGroup,
  MusclePart,
  PainGuidance,
} from '../../types/anatomy';

/**
 * AnatomyService — read-only access layer over the generated 317-fragment
 * anatomy catalogue. Keeps all data-shaping logic out of the UI so the
 * BodyMap screen stays declarative.
 */

const CATALOG = anatomyRaw as unknown as AnatomyCatalog;

/** Region display metadata (Arabic-first). */
export const REGION_META: Record<
  string,
  { labelAr: string; icon: string }
> = {
  head_neck: { labelAr: 'الرأس والرقبة', icon: 'happy-outline' },
  torso_front: { labelAr: 'الجذع الأمامي', icon: 'body-outline' },
  back: { labelAr: 'الظهر', icon: 'body-outline' },
  upper_limb: { labelAr: 'الطرفان العلويان', icon: 'hand-left-outline' },
  lower_limb: { labelAr: 'الطرفان السفليان', icon: 'walk-outline' },
};

/** The interactive body-map hotspots, mapped to catalogue groups. */
export interface BodyHotspot {
  group: string;
  labelAr: string;
  /** Regions (front/back) where the hotspot is visible. */
  views: BodyView[];
}

export const BODY_HOTSPOTS: BodyHotspot[] = [
  { group: 'head', labelAr: 'الرأس', views: ['front', 'back'] },
  { group: 'hair', labelAr: 'فروة الرأس', views: ['back'] },
  { group: 'neck', labelAr: 'الرقبة', views: ['front', 'back'] },
  { group: 'trapezius', labelAr: 'شبه المنحرفة', views: ['back'] },
  { group: 'deltoids', labelAr: 'الأكتاف', views: ['front', 'back'] },
  { group: 'chest', labelAr: 'الصدر', views: ['front'] },
  { group: 'abs', labelAr: 'البطن', views: ['front'] },
  { group: 'obliques', labelAr: 'العضلات المائلة', views: ['front'] },
  { group: 'upper-back', labelAr: 'أعلى الظهر', views: ['back'] },
  { group: 'lower-back', labelAr: 'أسفل الظهر', views: ['back'] },
  { group: 'biceps', labelAr: 'ذات الرأسين', views: ['front'] },
  { group: 'triceps', labelAr: 'ثلاثية الرؤوس', views: ['back'] },
  { group: 'forearm', labelAr: 'الساعد', views: ['front', 'back'] },
  { group: 'hands', labelAr: 'اليدان', views: ['front', 'back'] },
  { group: 'gluteal', labelAr: 'الأرداف', views: ['back'] },
  { group: 'adductors', labelAr: 'العضلات المقربة', views: ['front'] },
  { group: 'quadriceps', labelAr: 'الرباعية', views: ['front'] },
  { group: 'hamstring', labelAr: 'المأبضية', views: ['back'] },
  { group: 'knees', labelAr: 'الركبتان', views: ['front', 'back'] },
  { group: 'tibialis', labelAr: 'الظنبوب', views: ['front'] },
  { group: 'calves', labelAr: 'السمانة', views: ['back'] },
  { group: 'ankles', labelAr: 'الكاحلان', views: ['front', 'back'] },
  { group: 'feet', labelAr: 'القدمان', views: ['front', 'back'] },
];

class AnatomyService {
  get catalog(): AnatomyCatalog {
    return CATALOG;
  }

  get fragmentCount(): number {
    return CATALOG.fragmentCount;
  }

  get reviewNote(): string {
    return CATALOG.reviewNote;
  }

  /** All muscle groups, ordered by the hotspot order. */
  groups(): MuscleGroup[] {
    return Object.entries(CATALOG.groups).map(([id, g]) => ({
      ...g,
      id,
    }));
  }

  group(id: string): MuscleGroup | undefined {
    const g = CATALOG.groups[id];
    return g ? { ...g, id } : undefined;
  }

  groupLabel(id: string): string {
    return CATALOG.groups[id]?.labelAr ?? id;
  }

  /** Every fragment in the catalogue. */
  all(): MusclePart[] {
    return Object.values(CATALOG.muscles);
  }

  get(id: string): MusclePart | undefined {
    return CATALOG.muscles[id];
  }

  /** Fragments filtered by gender / view / group / region / side. */
  filter(filter: AnatomyFilter = {}): MusclePart[] {
    const { gender, view, group, region, side } = filter;
    return this.all().filter((m) => {
      if (gender && m.gender !== gender) return false;
      if (view && !m.views.includes(view)) return false;
      if (group && m.group !== group) return false;
      if (region && m.region !== region) return false;
      if (side && m.side !== side) return false;
      return true;
    });
  }

  /** Fragments belonging to a group for a given gender + view. */
  byGroup(group: string, gender: Gender, view: BodyView): MusclePart[] {
    return this.filter({ group, gender, view });
  }

  /** Groups that actually have fragments for a gender + view. */
  activeGroups(gender: Gender, view: BodyView): string[] {
    const set = new Set<string>();
    this.filter({ gender, view }).forEach((m) => set.add(m.group));
    return Array.from(set);
  }

  /** Free-text search across Arabic/English labels, groups and causes. */
  search(query: string, limit = 40): MusclePart[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const scored = this.all()
      .map((m) => {
        const haystack = [
          m.labelAr,
          m.labelEn ?? '',
          this.groupLabel(m.group),
          ...m.commonCauses,
        ]
          .join(' ')
          .toLowerCase();
        const idx = haystack.indexOf(q);
        return idx === -1 ? null : { m, idx };
      })
      .filter((x): x is { m: MusclePart; idx: number } => x !== null)
      .sort((a, b) => a.idx - b.idx);
    return scored.slice(0, limit).map((x) => x.m);
  }

  /** Resolve the educational guidance for a fragment, with group fallbacks. */
  guidance(partId: string): PainGuidance | undefined {
    const part = this.get(partId);
    if (!part) return undefined;
    const group = this.group(part.group);
    const warning = part.warning ?? group?.defaultWarning ?? null;
    const recommendation =
      part.recommendation ??
      group?.defaultRecommendation ??
      'راجع طبيبًا مختصًا عند استمرار الألم أو زيادته.';
    return {
      part,
      group,
      warning,
      recommendation,
      commonCauses: part.commonCauses,
    };
  }

  /** A short human label for a fragment, e.g. "عضلات الصدر · يمين". */
  fragmentLabel(part: MusclePart): string {
    const sideAr =
      part.side === 'left' ? 'يسار' : part.side === 'right' ? 'يمين' : 'منتصف';
    const axisAr = part.axis ? ` · ${part.axis}` : '';
    return `${part.labelAr} · ${sideAr}${axisAr}`;
  }

  /** Group fragments by region for list rendering. */
  byRegion(gender: Gender, view: BodyView): {
    region: string;
    labelAr: string;
    parts: MusclePart[];
  }[] {
    const parts = this.filter({ gender, view });
    const order = ['head_neck', 'torso_front', 'back', 'upper_limb', 'lower_limb'];
    const buckets = new Map<string, MusclePart[]>();
    parts.forEach((p) => {
      const list = buckets.get(p.region) ?? [];
      list.push(p);
      buckets.set(p.region, list);
    });
    return order
      .filter((r) => buckets.has(r))
      .map((r) => ({
        region: r,
        labelAr: REGION_META[r]?.labelAr ?? r,
        parts: buckets.get(r) ?? [],
      }));
  }
}

export const anatomyService = new AnatomyService();
