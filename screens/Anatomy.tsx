import React from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../theme';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Chip } from '../components/ui/Chip';
import { Divider } from '../components/ui/Divider';
import { Gradient } from '../components/ui/Gradient';
import { Icon } from '../components/ui/Icon';
import { Input } from '../components/ui/Input';
import { Screen } from '../components/ui/Screen';
import { Text } from '../components/ui/Text';
import { BodyMap, BodyMapLegend } from '../components/anatomy/BodyMap';
import { anatomyService } from '../services/anatomy';
import {
  BodyView,
  Gender,
  MusclePart,
  PainCheckup,
} from '../types/anatomy';

type Step = 'welcome' | 'map' | 'details' | 'results' | 'history';

const PAIN_TYPES = ['حرقان', 'طعن', 'ضغط', 'مستمر', 'متقطع'];
const DURATIONS = ['منذ ساعات', 'منذ أيام', 'منذ أسابيع'];

const STEP_TITLE: Record<Step, string> = {
  welcome: 'خريطة الألم',
  map: 'حدّد مكان الألم',
  details: 'صف الألم',
  results: 'ملخّص إرشادي',
  history: 'الفحوصات السابقة',
};

export function Anatomy() {
  const theme = useTheme();
  const router = useRouter();

  const [step, setStep] = React.useState<Step>('welcome');
  const [gender, setGender] = React.useState<Gender>('male');
  const [view, setView] = React.useState<BodyView>('front');
  const [selectedGroup, setSelectedGroup] = React.useState<string | null>(null);
  const [selectedPartId, setSelectedPartId] = React.useState<string | null>(null);
  const [intensity, setIntensity] = React.useState(4);
  const [painType, setPainType] = React.useState('مستمر');
  const [duration, setDuration] = React.useState('منذ أيام');
  const [query, setQuery] = React.useState('');
  const [history, setHistory] = React.useState<PainCheckup[]>([]);

  const activeGroups = React.useMemo(
    () => anatomyService.activeGroups(gender, view),
    [gender, view],
  );
  const groupParts = React.useMemo(
    () => (selectedGroup ? anatomyService.byGroup(selectedGroup, gender, view) : []),
    [selectedGroup, gender, view],
  );
  const searchResults = React.useMemo(
    () => (query.trim().length >= 2 ? anatomyService.search(query, 12) : []),
    [query],
  );

  const selectedPart = selectedPartId ? anatomyService.get(selectedPartId) : null;
  const guidance = selectedPartId ? anatomyService.guidance(selectedPartId) : undefined;

  const reset = () => {
    setSelectedGroup(null);
    setSelectedPartId(null);
    setIntensity(4);
    setPainType('مستمر');
    setDuration('منذ أيام');
    setQuery('');
    setStep('map');
  };

  const saveResults = () => {
    if (!selectedPart) return;
    setHistory((items) => [
      {
        id: `${Date.now()}`,
        partId: selectedPart.id,
        labelAr: selectedPart.labelAr,
        intensity,
        painType,
        duration,
        createdAt: new Date().toLocaleDateString('ar-EG'),
      },
      ...items,
    ]);
    setStep('results');
  };

  const pickGroup = (group: string) => {
    setSelectedGroup(group);
    setSelectedPartId(null);
    setQuery('');
  };

  const pickPart = (part: MusclePart) => {
    setSelectedPartId(part.id);
    setSelectedGroup(part.group);
  };

  return (
    <Screen padded={false}>
      {/* top bar */}
      <View
        style={[
          styles.topBar,
          { paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.sm },
        ]}
      >
        <Pressable
          onPress={() => (step === 'welcome' ? router.back() : setStep('map'))}
          style={styles.iconBtn}
        >
          <Icon name="chevron-forward" size={24} tone="default" />
        </Pressable>
        <Text variant="label" tone="muted">
          {STEP_TITLE[step]}
        </Text>
        <Pressable onPress={() => setStep('history')} style={styles.iconBtn}>
          <Icon name="time-outline" size={20} tone="muted" />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.lg,
          paddingBottom: 48,
        }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* ------------------------------- welcome ------------------------------ */}
        {step === 'welcome' ? (
          <View style={{ marginTop: theme.spacing.md }}>
            <Gradient
              name="aurora"
              radius={theme.radius['2xl']}
              style={styles.hero}
            >
              <View style={styles.heroIcon}>
                <Icon name="body-outline" size={34} color="#FFFFFF" />
              </View>
              <Text variant="title" weight="extrabold" style={{ color: '#FFFFFF', marginTop: 14 }}>
                حدّد مكان الألم بدقة
              </Text>
              <Text
                variant="body"
                style={{ color: 'rgba(255,255,255,0.9)', marginTop: 8, lineHeight: 24 }}
              >
                اضغط على أي جزء من الرسم التشريحي التفاعلي (317 جزءًا)، ثم صِف الألم
                لعرض معلومات تعليمية عامة: الأسباب الشائعة، والتوصيات، والتحذيرات.
              </Text>
            </Gradient>

            <Card style={{ marginTop: theme.spacing.lg }} accent={theme.colors.warning}>
              <View style={styles.rowCenter}>
                <Icon name="warning-outline" size={18} tone="warning" />
                <Text variant="label" weight="bold" tone="warning" style={{ marginStart: 8 }}>
                  تنبيه طبي مهم
                </Text>
              </View>
              <Text variant="body" tone="muted" style={{ marginTop: 8, lineHeight: 23 }}>
                هذا التطبيق تعليمي ولا يقدّم تشخيصًا. إذا كان الألم شديدًا أو مفاجئًا أو
                يصاحبه ضيق نفس أو إغماء، اتصل بالطوارئ فورًا.
              </Text>
            </Card>

            <View style={styles.statsRow}>
              <StatPill icon="grid-outline" value={`${anatomyService.fragmentCount}`} label="جزء تشريحي" />
              <StatPill icon="apps-outline" value={`${anatomyService.groups().length}`} label="مجموعة عضلية" />
              <StatPill icon="shield-checkmark-outline" value="تعليمي" label="غير تشخيصي" />
            </View>

            <Button
              label="أوافق وأبدأ"
              icon="arrow-back"
              onPress={reset}
              fullWidth
              style={{ marginTop: theme.spacing.xl }}
            />
            <Text variant="caption" tone="subtle" align="center" style={{ marginTop: 12, lineHeight: 19 }}>
              المعلومات العامة لا تغني عن استشارة طبيب مختص.
            </Text>
          </View>
        ) : null}

        {/* --------------------------------- map -------------------------------- */}
        {step === 'map' ? (
          <View style={{ marginTop: theme.spacing.md }}>
            <View style={styles.chipRow}>
              <Chip label="ذكر" selected={gender === 'male'} onPress={() => setGender('male')} size="sm" />
              <Chip label="أنثى" selected={gender === 'female'} onPress={() => setGender('female')} size="sm" />
              <View style={styles.spacer} />
              <Chip label="أمامي" selected={view === 'front'} onPress={() => setView('front')} size="sm" />
              <Chip label="خلفي" selected={view === 'back'} onPress={() => setView('back')} size="sm" />
            </View>

            <Card style={{ marginTop: theme.spacing.md }} padded={false}>
              <View style={{ paddingVertical: theme.spacing.md }}>
                <BodyMap
                  gender={gender}
                  view={view}
                  selectedGroup={selectedGroup}
                  onSelectGroup={pickGroup}
                  availableGroups={activeGroups}
                  width={250}
                />
                <BodyMapLegend />
              </View>
            </Card>

            <View style={{ marginTop: theme.spacing.lg }}>
              <Input
                label="ابحث عن جزء"
                placeholder="مثال: الصدر، الرقبة، الرباعية…"
                value={query}
                onChangeText={setQuery}
                icon="search-outline"
              />
            </View>

            {searchResults.length > 0 ? (
              <View style={{ marginTop: theme.spacing.md }}>
                <Text variant="label" weight="semibold" style={{ marginBottom: theme.spacing.sm }}>
                  نتائج البحث
                </Text>
                {searchResults.map((part) => (
                  <Card
                    key={part.id}
                    onPress={() => pickPart(part)}
                    style={{ marginBottom: 8 }}
                    accent={part.id === selectedPartId ? theme.colors.primary : undefined}
                  >
                    <View style={styles.rowBetween}>
                      <View style={{ flex: 1 }}>
                        <Text variant="body" weight="semibold">
                          {part.labelAr}
                        </Text>
                        <Text variant="caption" tone="muted" style={{ marginTop: 2 }}>
                          {anatomyService.groupLabel(part.group)} · {anatomyService.fragmentLabel(part)}
                        </Text>
                      </View>
                      {part.id === selectedPartId ? (
                        <Icon name="checkmark-circle" size={20} tone="primary" />
                      ) : (
                        <Icon name="chevron-back" size={18} tone="subtle" />
                      )}
                    </View>
                  </Card>
                ))}
              </View>
            ) : null}

            {selectedGroup && searchResults.length === 0 ? (
              <View style={{ marginTop: theme.spacing.lg }}>
                <View style={styles.rowCenter}>
                  <Icon name="locate-outline" size={18} tone="primary" />
                  <Text variant="subtitle" weight="bold" style={{ marginStart: 8 }}>
                    {anatomyService.groupLabel(selectedGroup)}
                  </Text>
                  <Badge label={`${groupParts.length} جزء`} tone="primary" style={{ marginStart: 8 }} />
                </View>
                <Text variant="caption" tone="muted" style={{ marginTop: 6, marginBottom: theme.spacing.sm }}>
                  اختر الجزء الأدق:
                </Text>
                <View style={styles.chipWrap}>
                  {groupParts.map((part) => (
                    <Chip
                      key={part.id}
                      label={anatomyService.fragmentLabel(part)}
                      selected={part.id === selectedPartId}
                      onPress={() => pickPart(part)}
                      size="sm"
                    />
                  ))}
                </View>
              </View>
            ) : null}

            {!selectedGroup && searchResults.length === 0 ? (
              <Card style={{ marginTop: theme.spacing.lg }}>
                <View style={styles.rowCenter}>
                  <Icon name="hand-left-outline" size={18} tone="muted" />
                  <Text variant="caption" tone="muted" style={{ marginStart: 8, flex: 1 }}>
                    اضغط على منطقة في الرسم أعلاه، أو استخدم البحث للوصول إلى أي من
                    الأجزاء الـ{anatomyService.fragmentCount}.
                  </Text>
                </View>
              </Card>
            ) : null}

            <Button
              label="التالي"
              iconRight="arrow-back"
              onPress={() => setStep('details')}
              disabled={!selectedPartId}
              fullWidth
              style={{ marginTop: theme.spacing.xl }}
            />
          </View>
        ) : null}

        {/* ------------------------------- details ------------------------------ */}
        {step === 'details' && selectedPart ? (
          <View style={{ marginTop: theme.spacing.md }}>
            <Card gradient="surface" bordered={false}>
              <Text variant="caption" tone="muted">
                الجزء المحدّد
              </Text>
              <Text variant="subtitle" weight="bold" style={{ marginTop: 4 }}>
                {anatomyService.fragmentLabel(selectedPart)}
              </Text>
              <Text variant="caption" tone="subtle" style={{ marginTop: 2 }}>
                {anatomyService.groupLabel(selectedPart.group)}
              </Text>
            </Card>

            <Text variant="label" weight="semibold" style={{ marginTop: theme.spacing.xl }}>
              شدة الألم: <Text variant="label" weight="extrabold" tone="primary">{intensity} / 10</Text>
            </Text>
            <View style={styles.scale}>
              {Array.from({ length: 11 }, (_, n) => {
                const active = n <= intensity;
                return (
                  <Pressable
                    key={n}
                    onPress={() => setIntensity(n)}
                    style={[
                      styles.scaleDot,
                      {
                        backgroundColor: active ? theme.colors.primary : theme.colors.surfaceMuted,
                        borderColor: theme.colors.border,
                      },
                    ]}
                  >
                    <Text variant="caption" weight="bold" tone={active ? 'inverse' : 'muted'}>
                      {n}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <Text variant="label" weight="semibold" style={{ marginTop: theme.spacing.xl, marginBottom: theme.spacing.sm }}>
              نوع الألم
            </Text>
            <View style={styles.chipWrap}>
              {PAIN_TYPES.map((t) => (
                <Chip key={t} label={t} selected={painType === t} onPress={() => setPainType(t)} />
              ))}
            </View>

            <Text variant="label" weight="semibold" style={{ marginTop: theme.spacing.xl, marginBottom: theme.spacing.sm }}>
              منذ متى بدأ؟
            </Text>
            <View style={styles.chipWrap}>
              {DURATIONS.map((d) => (
                <Chip key={d} label={d} selected={duration === d} onPress={() => setDuration(d)} />
              ))}
            </View>

            <View style={styles.actions}>
              <Button label="رجوع" variant="secondary" onPress={() => setStep('map')} style={{ flex: 1 }} />
              <Button label="عرض الإرشاد" icon="sparkles-outline" onPress={saveResults} style={{ flex: 1 }} />
            </View>
          </View>
        ) : null}

        {/* ------------------------------- results ------------------------------ */}
        {step === 'results' && selectedPart && guidance ? (
          <View style={{ marginTop: theme.spacing.md }}>
            <Gradient name="midnight" radius={theme.radius['2xl']} style={styles.summary}>
              <Text variant="caption" style={{ color: 'rgba(255,255,255,0.7)' }}>
                الجزء المختار
              </Text>
              <Text variant="title" weight="extrabold" style={{ color: '#FFFFFF', marginTop: 6 }}>
                {anatomyService.fragmentLabel(selectedPart)}
              </Text>
              <Text variant="caption" style={{ color: 'rgba(255,255,255,0.8)', marginTop: 8 }}>
                الشدة {intensity}/10 · {painType} · {duration}
              </Text>
            </Gradient>

            {guidance.warning ? (
              <Card style={{ marginTop: theme.spacing.lg }} accent={theme.colors.danger}>
                <View style={styles.rowCenter}>
                  <Icon name="alert-circle-outline" size={18} tone="danger" />
                  <Text variant="label" weight="bold" tone="danger" style={{ marginStart: 8 }}>
                    تحذير
                  </Text>
                </View>
                <Text variant="body" tone="muted" style={{ marginTop: 8, lineHeight: 23 }}>
                  {guidance.warning}
                </Text>
              </Card>
            ) : null}

            <Card style={{ marginTop: theme.spacing.lg }}>
              <Text variant="label" weight="bold" style={{ marginBottom: theme.spacing.sm }}>
                أسباب شائعة محتملة
              </Text>
              {guidance.commonCauses.map((cause) => (
                <View key={cause} style={styles.bulletRow}>
                  <View style={[styles.bullet, { backgroundColor: theme.colors.primary }]} />
                  <Text variant="body" tone="muted" style={{ flex: 1, lineHeight: 24 }}>
                    {cause}
                  </Text>
                </View>
              ))}
            </Card>

            <Card style={{ marginTop: theme.spacing.lg }} accent={theme.colors.success}>
              <View style={styles.rowCenter}>
                <Icon name="medkit-outline" size={18} tone="success" />
                <Text variant="label" weight="bold" tone="success" style={{ marginStart: 8 }}>
                  التوصية العامة
                </Text>
              </View>
              <Text variant="body" tone="muted" style={{ marginTop: 8, lineHeight: 23 }}>
                {guidance.recommendation}
              </Text>
            </Card>

            <Text variant="caption" tone="subtle" align="center" style={{ marginTop: theme.spacing.lg, lineHeight: 19 }}>
              هذه البيانات مولّدة كقوالب تعليمية وتحتاج مراجعة طبية. لا تُعتبر تشخيصًا أو
              وصفة علاجية.
            </Text>

            <View style={styles.actions}>
              <Button label="فحص جديد" icon="refresh-outline" onPress={reset} style={{ flex: 1 }} />
              <Button
                label="السجل"
                icon="time-outline"
                variant="secondary"
                onPress={() => setStep('history')}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        ) : null}

        {/* ------------------------------- history ------------------------------ */}
        {step === 'history' ? (
          <View style={{ marginTop: theme.spacing.md }}>
            <Text variant="caption" tone="muted" style={{ marginBottom: theme.spacing.md }}>
              السجل محفوظ داخل جلسة التطبيق الحالية.
            </Text>
            {history.length === 0 ? (
              <Card>
                <View style={styles.emptyWrap}>
                  <Icon name="folder-open-outline" size={34} tone="subtle" />
                  <Text variant="body" tone="muted" style={{ marginTop: 10 }}>
                    لا توجد فحوصات محفوظة بعد.
                  </Text>
                </View>
              </Card>
            ) : (
              history.map((item) => (
                <Card key={item.id} style={{ marginBottom: 10 }}>
                  <View style={styles.rowBetween}>
                    <View style={{ flex: 1 }}>
                      <Text variant="body" weight="semibold">
                        {item.labelAr}
                      </Text>
                      <Text variant="caption" tone="muted" style={{ marginTop: 4 }}>
                        {item.createdAt} · شدة {item.intensity}/10 · {item.painType} · {item.duration}
                      </Text>
                    </View>
                    <Badge
                      label={`${item.intensity}/10`}
                      tone={item.intensity >= 7 ? 'danger' : item.intensity >= 4 ? 'warning' : 'success'}
                    />
                  </View>
                </Card>
              ))
            )}
            <Button
              label="رجوع"
              variant="secondary"
              icon="arrow-back"
              onPress={() => setStep(selectedPart ? 'results' : 'map')}
              fullWidth
              style={{ marginTop: theme.spacing.lg }}
            />
          </View>
        ) : null}

        <Divider spacing={28} />
        <Text variant="caption" tone="subtle" align="center">
          BodyMap Pain · Semo0o Labs · أداة تعليمية
        </Text>
      </ScrollView>
    </Screen>
  );
}

function StatPill({ icon, value, label }: { icon: string; value: string; label: string }) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.statPill,
        { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
      ]}
    >
      <Icon name={icon as never} size={18} tone="primary" />
      <Text variant="label" weight="extrabold" style={{ marginTop: 6 }}>
        {value}
      </Text>
      <Text variant="caption" tone="subtle">
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  hero: { padding: 22 },
  heroIcon: {
    width: 60,
    height: 60,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowCenter: { flexDirection: 'row', alignItems: 'center' },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statsRow: { flexDirection: 'row', gap: 10, marginTop: 16 },
  statPill: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 14,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  scale: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 10,
  },
  scaleDot: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  actions: { flexDirection: 'row', gap: 10, marginTop: 22 },
  summary: { padding: 22 },
  bulletRow: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 8 },
  bullet: { width: 6, height: 6, borderRadius: 3, marginTop: 9, marginEnd: 10 },
  emptyWrap: { alignItems: 'center', paddingVertical: 20 },
});
