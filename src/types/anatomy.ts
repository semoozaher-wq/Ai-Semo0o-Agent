/**
 * Anatomy domain types — the interactive pain map that powers the built-in
 * "BodyMap Pain" agent. The catalogue is generated from
 * `react-native-body-parts-anatomy` (317 fragments) and lives in
 * `data/anatomyPainMap.json`.
 */

export type BodySide = 'left' | 'right' | 'center';
export type BodyView = 'front' | 'back';
export type Gender = 'male' | 'female';

/** Broad anatomical region used to bucket the 317 fragments. */
export type BodyRegion =
  | 'torso_front'
  | 'upper_limb'
  | 'head_neck'
  | 'back'
  | 'lower_limb';

export interface MuscleGroup {
  id: string;
  labelAr: string;
  labelEn?: string;
  defaultWarning?: string | null;
  defaultRecommendation: string;
}

export interface MusclePart {
  id: string;
  labelAr: string;
  labelEn?: string;
  group: string;
  region: BodyRegion | string;
  side: BodySide;
  axis?: string | null;
  gender: Gender;
  views: BodyView[];
  commonCauses: string[];
  warning?: string | null;
  recommendation?: string | null;
  reviewStatus?: string;
}

export interface AnatomyCatalog {
  generatedFrom: string;
  fragmentCount: number;
  reviewNote: string;
  groups: Record<string, MuscleGroup>;
  muscles: Record<string, MusclePart>;
}

/** A resolved educational guidance block for a selected fragment. */
export interface PainGuidance {
  part: MusclePart;
  group?: MuscleGroup;
  warning?: string | null;
  recommendation: string;
  commonCauses: string[];
}

export interface PainCheckup {
  id: string;
  partId: string;
  labelAr: string;
  intensity: number;
  painType: string;
  duration: string;
  createdAt: string;
}

/** Filter used when querying the catalogue. */
export interface AnatomyFilter {
  gender?: Gender;
  view?: BodyView;
  group?: string;
  region?: BodyRegion | string;
  side?: BodySide;
}
