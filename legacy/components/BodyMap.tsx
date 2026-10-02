import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { MusclePart } from '../types/anatomy';

type Props = {
  muscles: MusclePart[];
  selectedId: string | null;
  onPartPress: (part: MusclePart) => void;
};

/**
 * نسخة اختبارية من خريطة الجسم.
 * عند إضافة SVG التشريحي الحقيقي، استبدل القائمة بمسارات SVG قابلة للضغط
 * مع الحفاظ على نفس onPartPress وselectedId.
 */
export function BodyMap({ muscles, selectedId, onPartPress }: Props) {
  return (
    <View>
      {muscles.map((muscle) => (
        <Pressable
          key={muscle.id}
          onPress={() => onPartPress(muscle)}
          style={{
            backgroundColor: muscle.id === selectedId ? '#0E7C86' : '#E8EEF1',
            padding: 10,
            marginBottom: 4,
            borderRadius: 8,
          }}
        >
          <Text style={{ color: muscle.id === selectedId ? '#FFFFFF' : '#29424F', textAlign: 'right' }}>
            {muscle.labelAr}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
