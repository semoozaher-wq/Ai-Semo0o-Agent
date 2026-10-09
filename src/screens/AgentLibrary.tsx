import React from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../theme';
import { AppHeader, SectionHeader, AgentCard, EmptyState } from '../components/composite';
import { Badge } from '../components/ui/Badge';
import { Card } from '../components/ui/Card';
import { Chip } from '../components/ui/Chip';
import { Gradient } from '../components/ui/Gradient';
import { Icon } from '../components/ui/Icon';
import { Input } from '../components/ui/Input';
import { Screen } from '../components/ui/Screen';
import { Text } from '../components/ui/Text';
import { storeService, StoreQuery } from '../services/store';
import { useStoreStore } from '../store/useStoreStore';
import { AgentManifest } from '../types/agent';
import { formatNumber } from '../utils/format';

/**
 * Agent Library — the catalogue of ready-made agents that can be activated in a
 * single tap. This is a first-class capability of the platform (not a store):
 * each entry is an agent blueprint with its own capabilities, permissions and
 * runnable goal. Everything shown is read from the local agent catalogue
 * (`storeService`); activation is persisted through `useStoreStore` and mirrored
 * to the backend.
 */

const SORTS: { id: NonNullable<StoreQuery['sort']>; label: string }[] = [
  { id: 'relevance', label: 'الأنسب' },
  { id: 'rating', label: 'الأعلى تقييمًا' },
  { id: 'installs', label: 'الأكثر تفعيلًا' },
  { id: 'recent', label: 'الأحدث' },
  { id: 'name', label: 'أبجديًا' },
];

export function AgentLibrary() {
  const theme = useTheme();
  const router = useRouter();
  const installed = useStoreStore((s) => s.installed);
  const stats = useStoreStore((s) => s.stats);
  const install = useStoreStore((s) => s.install);

  const [query, setQuery] = React.useState('');
  const [category, setCategory] = React.useState<StoreQuery['category']>('all');
  const [sort, setSort] = React.useState<NonNullable<StoreQuery['sort']>>('relevance');
  const [installingId, setInstallingId] = React.useState<string | null>(null);

  const categories = storeService.categories();
  const results = React.useMemo(
    () => storeService.search({ category, search: query, sort }),
    [category, query, sort],
  );

  const featured = storeService.featured();
  const updates = React.useMemo(() => {
    return installed
      .map((rec) => storeService.get(rec.agentId))
      .filter((m): m is AgentManifest => Boolean(m) && m!.version !== installed.find((r) => r.agentId === m!.id)?.version);
  }, [installed]);

  const installedIds = new Set(installed.map((a) => a.agentId));

  const handleInstall = async (agent: AgentManifest) => {
    setInstallingId(agent.id);
    try {
      await install(agent.id);
    } finally {
      setInstallingId(null);
    }
  };

  return (
    <Screen padded={false}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.sm }}>
          <AppHeader
            title="مكتبة الوكلاء"
            subtitle={
              stats
                ? `${stats.totalAgents} وكيلًا جاهزًا · ${stats.installed} مُفعّل · ${stats.categories} تصنيفًا`
                : 'وكلاء جاهزون للتفعيل بضغطة واحدة'
            }
            right={
              <Pressable onPress={() => router.push('/agents')} style={styles.iconBtn}>
                <Icon name="rocket-outline" size={22} tone="muted" />
              </Pressable>
            }
          />

          <Input
            icon="search-outline"
            placeholder="ابحث عن وكيل، أداة، أو قدرة…"
            value={query}
            onChangeText={setQuery}
            returnKeyType="search"
          />

          {/* categories */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8, paddingVertical: theme.spacing.md }}
          >
            {categories.map((cat) => (
              <Chip
                key={cat.id}
                label={cat.labelAr}
                icon={cat.icon as never}
                selected={category === cat.id}
                onPress={() => setCategory(cat.id)}
              />
            ))}
          </ScrollView>
        </View>

        {/* featured banner */}
        {category === 'all' && !query ? (
          <View style={{ marginTop: theme.spacing.sm }}>
            <View style={{ paddingHorizontal: theme.spacing.lg }}>
              <SectionHeader title="وكلاء مقترحون" icon="sparkles-outline" />
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: theme.spacing.lg, gap: 12 }}
            >
              {featured.map((agent) => (
                <Pressable key={agent.id} onPress={() => router.push(`/agent/${agent.id}`)}>
                  <Card padded={false} bordered={false} style={styles.banner}>
                    <Gradient name="brand" radius={theme.radius.xl} style={styles.bannerGrad}>
                      <View style={styles.bannerInner}>
                        <Text style={{ fontSize: 40 }}>{agent.icon}</Text>
                        <Text
                          weight="extrabold"
                          numberOfLines={1}
                          style={{ color: '#FFFFFF', fontSize: theme.fontSize.xl, marginTop: 12 }}
                        >
                          {agent.nameAr}
                        </Text>
                        <Text
                          numberOfLines={2}
                          style={{
                            color: 'rgba(255,255,255,0.85)',
                            fontSize: theme.fontSize.sm,
                            marginTop: 4,
                            minHeight: 36,
                          }}
                        >
                          {agent.taglineAr}
                        </Text>
                        <View style={styles.bannerMeta}>
                          <Icon name="star" size={13} color="#FFD166" />
                          <Text style={{ color: '#FFFFFF', fontSize: theme.fontSize.xs, marginStart: 4 }}>
                            {agent.rating.toFixed(1)} · {formatNumber(agent.installs)} تفعيل
                          </Text>
                        </View>
                      </View>
                    </Gradient>
                  </Card>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        ) : null}

        {/* updates */}
        {updates.length > 0 && category === 'all' && !query ? (
          <View style={{ paddingHorizontal: theme.spacing.lg, marginTop: theme.spacing['2xl'] }}>
            <SectionHeader title="تحديثات متاحة" icon="cloud-download-outline" />
            <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
              {updates.map((agent, index) => (
                <View key={agent.id}>
                  {index > 0 ? <View style={[styles.divider, { backgroundColor: theme.colors.border }]} /> : null}
                  <View style={styles.updateRow}>
                    <Text style={{ fontSize: 26 }}>{agent.icon}</Text>
                    <View style={{ flex: 1, marginStart: 12 }}>
                      <Text variant="body" weight="semibold" numberOfLines={1}>
                        {agent.nameAr}
                      </Text>
                      <Text variant="caption" tone="muted">
                        الإصدار {agent.version} متاح
                      </Text>
                    </View>
                    <Chip label="تحديث" icon="download-outline" selected onPress={() => handleInstall(agent)} />
                  </View>
                </View>
              ))}
            </Card>
          </View>
        ) : null}

        {/* results header + sort */}
        <View style={{ paddingHorizontal: theme.spacing.lg, marginTop: theme.spacing['2xl'] }}>
          <SectionHeader
            title={query ? `نتائج البحث (${results.length})` : 'كل الوكلاء'}
            icon="apps-outline"
          />
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8, paddingBottom: theme.spacing.md }}
          >
            {SORTS.map((s) => (
              <Chip
                key={s.id}
                label={s.label}
                selected={sort === s.id}
                onPress={() => setSort(s.id)}
                tone="accent"
                size="sm"
              />
            ))}
          </ScrollView>
        </View>

        {/* results list */}
        <View style={{ paddingHorizontal: theme.spacing.lg, gap: 12 }}>
          {results.length === 0 ? (
            <EmptyState
              icon="search-outline"
              title="لا توجد نتائج"
              description="جرّب كلمة بحث أخرى أو اختر تصنيفًا مختلفًا."
            />
          ) : (
            results.map((agent) => {
              const rec = installed.find((a) => a.agentId === agent.id);
              const updateAvailable = Boolean(rec && rec.version !== agent.version);
              return (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  installed={installedIds.has(agent.id)}
                  updateAvailable={updateAvailable}
                  installing={installingId === agent.id}
                  onPress={() => router.push(`/agent/${agent.id}`)}
                  onInstall={() => handleInstall(agent)}
                />
              );
            })
          )}
        </View>

        {/* footer note */}
        <View style={{ paddingHorizontal: theme.spacing.lg, marginTop: theme.spacing['2xl'] }}>
          <Card>
            <View style={styles.rowBetween}>
              <View style={{ flex: 1 }}>
                <Text variant="label" weight="semibold">
                  نظام الصلاحيات والأمان
                </Text>
                <Text variant="caption" tone="muted" style={{ marginTop: 4 }}>
                  كل وكيل يطلب صلاحيات محددة، ويمكنك منحها أو سحبها في أي وقت.
                </Text>
              </View>
              <Badge label="آمن" tone="success" />
            </View>
          </Card>
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  banner: { width: 300, overflow: 'hidden' },
  bannerGrad: { width: '100%' },
  bannerInner: { padding: 20 },
  bannerMeta: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  updateRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  divider: { height: StyleSheet.hairlineWidth },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
