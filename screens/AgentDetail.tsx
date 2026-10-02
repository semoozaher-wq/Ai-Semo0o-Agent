import React from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../theme';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Chip } from '../components/ui/Chip';
import { Divider } from '../components/ui/Divider';
import { Gradient } from '../components/ui/Gradient';
import { Icon } from '../components/ui/Icon';
import type { IconName } from '../components/ui/Icon';
import { Rating } from '../components/ui/Rating';
import { Screen } from '../components/ui/Screen';
import { Text } from '../components/ui/Text';
import { Avatar } from '../components/ui/Avatar';
import { storeService } from '../services/store';
import { useStoreStore } from '../store/useStoreStore';
import { useAgentsStore } from '../store/useAgentsStore';
import { permissionSpec } from '../data/permissions';
import { getTool } from '../data/tools';
import { formatNumber, formatRelativeTime } from '../utils/format';
import { AgentPermission } from '../types/agent';

type Tab = 'about' | 'permissions' | 'reviews';

/**
 * Built-in agents that ship with their own interactive app screen. When a
 * user taps "run" we deep-link straight into the app instead of spinning up a
 * generic agent task.
 */
const APP_ROUTES: Record<string, string> = {
  'agent-bodymap-pain': '/anatomy',
};

function appRouteFor(agentId: string): string | undefined {
  return APP_ROUTES[agentId];
}

const RISK_TONE: Record<string, 'success' | 'warning' | 'danger'> = {
  low: 'success',
  medium: 'warning',
  high: 'danger',
};

const RISK_LABEL: Record<string, string> = {
  low: 'منخفض',
  medium: 'متوسط',
  high: 'مرتفع',
};

export function AgentDetail({ agentId }: { agentId: string }) {
  const theme = useTheme();
  const router = useRouter();
  const [tab, setTab] = React.useState<Tab>('about');
  const [busy, setBusy] = React.useState(false);

  const agent = storeService.get(agentId);
  const installed = useStoreStore((s) => s.installed);
  const install = useStoreStore((s) => s.install);
  const uninstall = useStoreStore((s) => s.uninstall);
  const update = useStoreStore((s) => s.update);
  const grantPermission = useStoreStore((s) => s.grantPermission);
  const revokePermission = useStoreStore((s) => s.revokePermission);
  const createTask = useAgentsStore((s) => s.createTask);
  const runTask = useAgentsStore((s) => s.runTask);

  if (!agent) {
    return (
      <Screen>
        <View style={styles.center}>
          <Icon name="alert-circle-outline" size={40} tone="muted" />
          <Text variant="subtitle" weight="bold" style={{ marginTop: 12 }}>
            الوكيل غير موجود
          </Text>
          <Button label="رجوع" variant="secondary" onPress={() => router.back()} style={{ marginTop: 16 }} />
        </View>
      </Screen>
    );
  }

  const rec = installed.find((a) => a.agentId === agent.id);
  const isInstalled = Boolean(rec);
  const updateAvailable = Boolean(rec && rec.version !== agent.version);
  const granted = new Set(rec?.grantedPermissions ?? []);
  const appRoute = appRouteFor(agent.id);

  const run = async () => {
    setBusy(true);
    try {
      if (!isInstalled) await install(agent.id);
      if (appRoute) {
        router.push(appRoute as never);
        return;
      }
      const task = createTask(
        `نفّذ مهمة باستخدام وكيل «${agent.nameAr}»: ${agent.taglineAr}`,
        { title: `${agent.nameAr} — مهمة سريعة`, agentId: agent.id },
      );
      void runTask(task.id);
      router.push('/agents');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        {/* top bar */}
        <View style={[styles.topBar, { paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.sm }]}>
          <Pressable onPress={() => router.back()} style={styles.iconBtn}>
            <Icon name="chevron-forward" size={24} tone="default" />
          </Pressable>
          <Text variant="label" tone="muted">
            تفاصيل الوكيل
          </Text>
          <Pressable style={styles.iconBtn}>
            <Icon name="share-social-outline" size={20} tone="muted" />
          </Pressable>
        </View>

        {/* hero */}
        <View style={{ paddingHorizontal: theme.spacing.lg, marginTop: theme.spacing.md }}>
          <View style={styles.heroRow}>
            <View
              style={[
                styles.heroIcon,
                { backgroundColor: `${theme.colors.primary}22`, borderRadius: theme.radius['2xl'] },
              ]}
            >
              <Text style={{ fontSize: 46 }}>{agent.icon}</Text>
            </View>
            <View style={{ flex: 1, marginStart: 16 }}>
              <View style={styles.nameRow}>
                <Text variant="title" weight="extrabold" numberOfLines={2} style={{ flexShrink: 1 }}>
                  {agent.nameAr}
                </Text>
                {agent.authorVerified ? <Icon name="checkmark-circle" size={18} tone="accent" /> : null}
              </View>
              <Text variant="caption" tone="muted" style={{ marginTop: 2 }}>
                {agent.author}
              </Text>
              <View style={{ marginTop: 8 }}>
                <Rating value={agent.rating} count={agent.ratingCount} />
              </View>
            </View>
          </View>

          <Text variant="body" tone="muted" style={{ marginTop: theme.spacing.lg, lineHeight: 24 }}>
            {agent.taglineAr}
          </Text>

          {/* meta strip */}
          <Card style={{ marginTop: theme.spacing.lg }} padded={false}>
            <View style={styles.metaStrip}>
              <MetaCell label="التنزيلات" value={formatNumber(agent.installs)} icon="download-outline" />
              <View style={[styles.vDivider, { backgroundColor: theme.colors.border }]} />
              <MetaCell label="الحجم" value={`${agent.sizeMb}MB`} icon="archive-outline" />
              <View style={[styles.vDivider, { backgroundColor: theme.colors.border }]} />
              <MetaCell label="الإصدار" value={agent.version} icon="pricetag-outline" />
            </View>
          </Card>

          {/* actions */}
          <View style={styles.actions}>
            {isInstalled ? (
              <>
                <Button
                  label={appRoute ? 'فتح التطبيق' : 'تشغيل الآن'}
                  icon={appRoute ? 'open-outline' : 'play'}
                  onPress={run}
                  loading={busy}
                  style={{ flex: 1 }}
                />
                {updateAvailable ? (
                  <Button label="تحديث" icon="cloud-download-outline" variant="secondary" onPress={() => update(agent.id)} />
                ) : (
                  <Button label="إزالة" icon="trash-outline" variant="outline" onPress={() => uninstall(agent.id)} />
                )}
              </>
            ) : (
              <Button
                label={busy ? 'جارٍ التثبيت…' : `تثبيت · ${agent.pricing === 'free' ? 'مجانًا' : agent.priceLabel ?? 'مدفوع'}`}
                icon="download-outline"
                onPress={() => install(agent.id)}
                loading={busy}
                fullWidth
                style={{ flex: 1 }}
              />
            )}
          </View>

          {isInstalled ? (
            <View style={[styles.installedNote, { marginTop: theme.spacing.md }]}>
              <Icon name="checkmark-circle" size={16} tone="success" />
              <Text variant="caption" tone="muted" style={{ marginStart: 6 }}>
                مثبّت · {rec?.runCount ?? 0} تشغيل
                {rec?.lastRunAt ? ` · آخر تشغيل ${formatRelativeTime(rec.lastRunAt)}` : ''}
              </Text>
            </View>
          ) : null}
        </View>

        {/* screenshots */}
        <View style={{ marginTop: theme.spacing['2xl'] }}>
          <Text variant="subtitle" weight="bold" style={{ paddingHorizontal: theme.spacing.lg, marginBottom: theme.spacing.md }}>
            لقطات الشاشة
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: theme.spacing.lg, gap: 12 }}
          >
            {agent.screenshots.map((shot, index) => (
              <Card key={index} padded={false} bordered={false} style={styles.shot}>
                <Gradient
                  name={index % 3 === 0 ? 'brand' : index % 3 === 1 ? 'ocean' : 'sunset'}
                  radius={theme.radius.lg}
                  style={styles.shotGrad}
                >
                  <View style={styles.shotInner}>
                    <Text style={{ fontSize: 34 }}>{shot}</Text>
                    <Text style={{ color: '#FFFFFF', fontSize: theme.fontSize.sm, marginTop: 8, textAlign: 'center' }}>
                      {agent.capabilitiesAr[index % agent.capabilitiesAr.length]}
                    </Text>
                  </View>
                </Gradient>
              </Card>
            ))}
          </ScrollView>
        </View>

        {/* tabs */}
        <View style={[styles.tabs, { paddingHorizontal: theme.spacing.lg, marginTop: theme.spacing['2xl'] }]}>
          {(
            [
              { id: 'about', label: 'حول' },
              { id: 'permissions', label: `الصلاحيات (${agent.permissions.length})` },
              { id: 'reviews', label: `المراجعات (${agent.reviews.length})` },
            ] as { id: Tab; label: string }[]
          ).map((t) => {
            const active = tab === t.id;
            return (
              <Pressable key={t.id} onPress={() => setTab(t.id)} style={styles.tabBtn}>
                <Text variant="label" weight="semibold" tone={active ? 'primary' : 'muted'}>
                  {t.label}
                </Text>
                {active ? (
                  <View style={[styles.tabUnderline, { backgroundColor: theme.colors.primary }]} />
                ) : (
                  <View style={styles.tabUnderline} />
                )}
              </Pressable>
            );
          })}
        </View>

        <View style={{ paddingHorizontal: theme.spacing.lg, marginTop: theme.spacing.lg }}>
          {tab === 'about' ? (
            <View>
              <Text variant="body" style={{ lineHeight: 26 }}>
                {agent.descriptionAr}
              </Text>

              <Text variant="label" weight="semibold" style={{ marginTop: theme.spacing.xl, marginBottom: theme.spacing.sm }}>
                القدرات
              </Text>
              <View style={styles.chips}>
                {agent.capabilitiesAr.map((cap) => (
                  <Chip key={cap} label={cap} tone="accent" />
                ))}
              </View>

              {agent.tools && agent.tools.length > 0 ? (
                <>
                  <Text variant="label" weight="semibold" style={{ marginTop: theme.spacing.xl, marginBottom: theme.spacing.sm }}>
                    الأدوات المستخدمة
                  </Text>
                  <View style={styles.chips}>
                    {agent.tools.map((toolId) => {
                      const tool = getTool(toolId);
                      return (
                        <Chip key={toolId} label={tool?.nameAr ?? toolId} icon={(tool?.icon as never) ?? 'build-outline'} />
                      );
                    })}
                  </View>
                </>
              ) : null}

              <Text variant="label" weight="semibold" style={{ marginTop: theme.spacing.xl, marginBottom: theme.spacing.sm }}>
                الوسوم
              </Text>
              <View style={styles.chips}>
                {agent.tags.map((tag) => (
                  <Badge key={tag} label={tag} tone="neutral" />
                ))}
              </View>
            </View>
          ) : null}

          {tab === 'permissions' ? (
            <View>
              <Text variant="caption" tone="muted" style={{ marginBottom: theme.spacing.md }}>
                يطلب هذا الوكيل الصلاحيات التالية. يمكنك منحها أو سحبها في أي وقت.
              </Text>
              {agent.permissions.map((perm: AgentPermission) => {
                const spec = permissionSpec(perm);
                const isGranted = granted.has(perm);
                return (
                  <Card key={perm} style={{ marginBottom: 10 }}>
                    <View style={styles.rowBetween}>
                      <View style={{ flex: 1 }}>
                        <View style={styles.permTitle}>
                          <Text variant="body" weight="semibold">
                            {spec.labelAr}
                          </Text>
                          <Badge label={RISK_LABEL[spec.risk]} tone={RISK_TONE[spec.risk]} />
                        </View>
                        <Text variant="caption" tone="muted" style={{ marginTop: 4 }}>
                          {spec.descriptionAr}
                        </Text>
                      </View>
                      {isInstalled ? (
                        <Pressable
                          onPress={() =>
                            isGranted ? revokePermission(agent.id, perm) : grantPermission(agent.id, perm)
                          }
                          style={[
                            styles.toggle,
                            {
                              backgroundColor: isGranted ? theme.colors.successSoft : theme.colors.surfaceMuted,
                              borderRadius: theme.radius.pill,
                            },
                          ]}
                        >
                          <Icon
                            name={isGranted ? 'checkmark' : 'close'}
                            size={14}
                            color={isGranted ? theme.colors.success : theme.colors.textSubtle}
                          />
                        </Pressable>
                      ) : (
                        <Icon name="lock-closed-outline" size={16} tone="subtle" />
                      )}
                    </View>
                  </Card>
                );
              })}
            </View>
          ) : null}

          {tab === 'reviews' ? (
            <View>
              <Card style={{ marginBottom: theme.spacing.lg }}>
                <View style={styles.reviewSummary}>
                  <View style={{ alignItems: 'center' }}>
                    <Text variant="display" weight="extrabold">
                      {agent.rating.toFixed(1)}
                    </Text>
                    <Rating value={agent.rating} showValue={false} />
                    <Text variant="caption" tone="muted" style={{ marginTop: 4 }}>
                      {formatNumber(agent.ratingCount)} تقييم
                    </Text>
                  </View>
                  <View style={{ flex: 1, marginStart: 20 }}>
                    {[5, 4, 3, 2, 1].map((star) => {
                      const ratio = star === 5 ? 0.72 : star === 4 ? 0.19 : star === 3 ? 0.05 : star === 2 ? 0.02 : 0.02;
                      return (
                        <View key={star} style={styles.barRow}>
                          <Text variant="caption" tone="subtle" style={{ width: 12 }}>
                            {star}
                          </Text>
                          <View style={[styles.barTrack, { backgroundColor: theme.colors.surfaceMuted }]}>
                            <View
                              style={{
                                width: `${ratio * 100}%`,
                                height: '100%',
                                backgroundColor: theme.colors.warning,
                                borderRadius: 4,
                              }}
                            />
                          </View>
                        </View>
                      );
                    })}
                  </View>
                </View>
              </Card>

              {agent.reviews.map((review) => (
                <Card key={review.id} style={{ marginBottom: 10 }}>
                  <View style={styles.reviewHead}>
                    <Avatar name={review.author} color={review.avatarColor} size={36} />
                    <View style={{ flex: 1, marginStart: 10 }}>
                      <Text variant="label" weight="semibold">
                        {review.author}
                      </Text>
                      <View style={styles.reviewMeta}>
                        <Rating value={review.rating} size={11} showValue={false} />
                        <Text variant="caption" tone="subtle" style={{ marginStart: 8 }}>
                          {formatRelativeTime(review.createdAt)}
                        </Text>
                      </View>
                    </View>
                  </View>
                  <Text variant="body" style={{ marginTop: 10, lineHeight: 22 }}>
                    {review.text}
                  </Text>
                  <View style={[styles.helpful, { marginTop: 10 }]}>
                    <Icon name="thumbs-up-outline" size={14} tone="subtle" />
                    <Text variant="caption" tone="subtle" style={{ marginStart: 6 }}>
                      مفيد ({review.helpful})
                    </Text>
                  </View>
                </Card>
              ))}
            </View>
          ) : null}
        </View>

        <Divider spacing={24} />
        <Text variant="caption" tone="subtle" align="center" style={{ paddingHorizontal: theme.spacing.lg }}>
          آخر تحديث {formatRelativeTime(agent.updatedAt)} · يتطلب المنصة {agent.minPlatformVersion}+
        </Text>
      </ScrollView>
    </Screen>
  );
}

function MetaCell({ label, value, icon }: { label: string; value: string; icon: IconName }) {
  return (
    <View style={styles.metaCell}>
      <Icon name={icon} size={16} tone="muted" />
      <Text variant="label" weight="semibold" style={{ marginTop: 6 }}>
        {value}
      </Text>
      <Text variant="caption" tone="subtle">
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  heroRow: { flexDirection: 'row', alignItems: 'center' },
  heroIcon: { width: 92, height: 92, alignItems: 'center', justifyContent: 'center' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  metaStrip: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14 },
  metaCell: { flex: 1, alignItems: 'center' },
  vDivider: { width: StyleSheet.hairlineWidth, height: 36 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 18 },
  installedNote: { flexDirection: 'row', alignItems: 'center' },
  shot: { width: 220, overflow: 'hidden' },
  shotGrad: { width: '100%' },
  shotInner: { height: 160, alignItems: 'center', justifyContent: 'center', padding: 16 },
  tabs: { flexDirection: 'row', gap: 20 },
  tabBtn: { alignItems: 'center' },
  tabUnderline: { height: 3, width: '100%', borderRadius: 2, marginTop: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  permTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  toggle: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  reviewSummary: { flexDirection: 'row', alignItems: 'center' },
  barRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 2 },
  barTrack: { flex: 1, height: 6, borderRadius: 4, marginStart: 8, overflow: 'hidden' },
  reviewHead: { flexDirection: 'row', alignItems: 'center' },
  reviewMeta: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  helpful: { flexDirection: 'row', alignItems: 'center' },
});
