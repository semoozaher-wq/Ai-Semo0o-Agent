export type BodySide = 'left' | 'right' | 'center';
export type BodyView = 'front' | 'back';
export type Gender = 'male' | 'female';

export type MusclePart = {
  id: string;
  labelAr: string;
  labelEn?: string;
  group: string;
  region: string;
  side: BodySide;
  views: BodyView[];
  commonCauses: string[];
  warning?: string | null;
  recommendation?: string | null;
};

export type PainMap = {
  groups: Record<string, {
    labelAr: string;
    defaultWarning?: string | null;
    defaultRecommendation: string;
  }>;
  muscles: Record<string, MusclePart>;
};
