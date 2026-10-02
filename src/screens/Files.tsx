import React from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useTheme } from '../theme';
import { AppHeader } from '../components/composite/AppHeader';
import { SectionHeader } from '../components/composite/SectionHeader';
import { StatCard } from '../components/composite/StatCard';
import { ListRow } from '../components/composite/ListRow';
import { EmptyState } from '../components/composite/EmptyState';
import { Card } from '../components/ui/Card';
import { Text } from '../components/ui/Text';
import { Button } from '../components/ui/Button';
import { Chip } from '../components/ui/Chip';
import { Badge } from '../components/ui/Badge';
import { Input } from '../components/ui/Input';
import { Divider } from '../components/ui/Divider';
import { Progress } from '../components/ui/Progress';
import { Icon } from '../components/ui/Icon';
import type { IconName } from '../components/ui/Icon';
import { DonutChart } from '../components/charts/DonutChart';
import { BarChart } from '../components/charts/BarChart';
import { ProgressRing } from '../components/charts/ProgressRing';
import { useFilesStore } from '../store/useFilesStore';
import { formatBytes, formatNumber } from '../utils/format';
import { FILE_KINDS } from '../services/data-engine';
import { FileKind, Severity } from '../types/file';

type Tab = 'files' | 'audit' | 'code';

const KIND_META: Record<FileKind, { label: string; icon: IconName }> = {
  image: { label: 'صور', icon: 'image-outline' },
  document: { label: 'مستندات', icon: 'document-text-outline' },
  code: { label: 'كود', icon: 'code-slash-outline' },
  data: { label: 'بيانات', icon: 'grid-outline' },
  audio: { label: 'صوتيات', icon: 'musical-notes-outline' },
  video: { label: 'فيديو', icon: 'videocam-outline' },
  archive: { label: 'أرشيف', icon: 'archive-outline' },
  other: { label: 'أخرى', icon: 'document-outline' },
};

const SEVERITY_META: Record<Severity, { label: string; tone: 'info' | 'warning' | 'danger' }> = {
  info: { label: 'معلومة', tone: 'info' },
  warning: { label: 'تحذير', tone: 'warning' },
  error: { label: 'خطأ', tone: 'danger' },
  critical: { label: 'حرج', tone: 'danger' },
};

function kindColor(kind: FileKind, theme: ReturnType<typeof useTheme>): string {
  switch (kind) {
    case 'image':
      return theme.colors.highlight;
    case 'document':
      return theme.colors.primary;
    case 'code':
      return theme.colors.accent;
    case 'data':
      return theme.colors.info;
    case 'audio':
      return theme.colors.warning;
    case 'video':
      return theme.colors.success;
    case 'archive':
      return theme.colors.textMuted;
    default:
      return theme.colors.textSubtle;
  }
}

function healthTone(score: number): string {
  if (score >= 85) return 'success';
  if (score >= 65) return 'warning';
  return 'danger';
}

export function Files() {
  const theme = useTheme();
  const files = useFilesStore((s) => s.files);
  const report = useFilesStore((s) => s.report);
  const audit = useFilesStore((s) => s.audit);
  const auditScore = useFilesStore((s) => s.auditScore);
  const analysis = useFilesStore((s) => s.analysis);
  const scanning = useFilesStore((s) => s.scanning);
  const scan = useFilesStore((s) => s.scan);
  const runAudit = useFilesStore((s) => s.runAudit);
  const analyzeCode = useFilesStore((s) => s.analyzeCode);
  const toggleStar = useFilesStore((s) => s.toggleStar);
  const remove = useFilesStore((s) => s.remove);

  const [tab, setTab] = React.useState<Tab>('files');
  const [query, setQuery] = React.useState('');
  const [kind, setKind] = React.useState<FileKind | 'all'>('all');

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return files
      .filter((f) => (kind === 'all' ? true : f.kind === kind))
      .filter((f) =>
        q ? f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q) : true,
      )
      .sort((a, b) => b.sizeBytes - a.sizeBytes);
  }, [files, kind, query]);

  const donutSegments = React.useMemo(
    () =>
      FILE_KINDS.filter((k) => (report?.byKind[k] ?? 0) > 0).map((k) => ({
        label: KIND_META[k].label,
        value: report?.byKind[k] ?? 0,
        color: kindColor(k, theme),
      })),
    [report, theme],
  );

  const sizeBars = React.useMemo(() => {
    const totals = FILE_KINDS.map((k) =>
      files.filter((f) => f.kind === k).reduce((acc, f) => acc + f.sizeBytes, 0),
    );
    return totals.map((b) => b / 1024);
  }, [files]);

  const kindLabels = FILE_KINDS.map((k) => KIND_META[k].label);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.lg,
          paddingTop: theme.spacing.lg,
          paddingBottom: theme.spacing['4xl'],
        }}
        showsVerticalScrollIndicator={false}
      >
        <AppHeader
          title="مركز البيانات والملفات"
          subtitle={`${formatNumber(files.length)} ملف · ${formatBytes(report?.totalBytes ?? 0)}`}
          right={
            <Button
              label="فحص"
              icon="scan-outline"
              size="sm"
              variant="secondary"
              loading={scanning}
              onPress={() => void scan()}
            />
          }
        />

        {/* Tabs */}
        <View style={styles.tabs}>
          <Chip label="المستكشف" selected={tab === 'files'} onPress={() => setTab('files')} />
          <Chip label="التدقيق الشامل" selected={tab === 'audit'} onPress={() => setTab('audit')} />
          <Chip label="تحليل الكود" selected={tab === 'code'} onPress={() => setTab('code')} />
        </View>

        {tab === 'files' ? (
          <View>
            <View style={styles.statRow}>
              <StatCard
                label="إجمالي الملفات"
                value={formatNumber(files.length)}
                icon="documents-outline"
                tone={theme.colors.primary}
              />
              <StatCard
                label="الحجم الكلي"
                value={formatBytes(report?.totalBytes ?? 0)}
                icon="server-outline"
                tone={theme.colors.accent}
              />
            </View>
            <View style={[styles.statRow, { marginTop: theme.spacing.md }]}>
              <StatCard
                label="درجة السلامة"
                value={`${report?.healthScore ?? 0}/100`}
                icon="shield-checkmark-outline"
                tone={healthTone(report?.healthScore ?? 0)}
              />
              <StatCard
                label="ملاحظات مكتشفة"
                value={formatNumber(report?.findings.length ?? 0)}
                icon="alert-circle-outline"
                tone={theme.colors.warning}
              />
            </View>

            <Card style={{ marginTop: theme.spacing.lg }}>
              <SectionHeader title="توزيع أنواع الملفات" icon="pie-chart-outline" />
              <View style={styles.donutRow}>
                <DonutChart
                  segments={donutSegments}
                  size={150}
                  thickness={18}
                  centerLabel={formatNumber(files.length)}
                  centerSub="ملف"
                />
                <View style={styles.legend}>
                  {donutSegments.map((seg) => (
                    <View key={seg.label} style={styles.legendItem}>
                      <View style={[styles.dot, { backgroundColor: seg.color }]} />
                      <Text variant="caption" tone="muted" style={{ flex: 1 }}>
                        {seg.label}
                      </Text>
                      <Text variant="caption" weight="semibold">
                        {formatNumber(seg.value)}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            </Card>

            <Card style={{ marginTop: theme.spacing.lg }}>
              <SectionHeader
                title="الحجم حسب النوع"
                subtitle="بالكيلوبايت"
                icon="bar-chart-outline"
              />
              <BarChart data={sizeBars} labels={kindLabels} height={120} color={theme.colors.primary} />
            </Card>

            <View style={{ marginTop: theme.spacing.lg }}>
              <Input
                placeholder="ابحث عن ملف…"
                icon="search-outline"
                value={query}
                onChangeText={setQuery}
              />
            </View>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 8, paddingVertical: theme.spacing.md }}
            >
              <Chip label="الكل" selected={kind === 'all'} onPress={() => setKind('all')} />
              {FILE_KINDS.map((k) => (
                <Chip
                  key={k}
                  label={KIND_META[k].label}
                  icon={KIND_META[k].icon}
                  selected={kind === k}
                  onPress={() => setKind(k)}
                />
              ))}
            </ScrollView>

            <Card padded={false} style={{ marginTop: theme.spacing.sm }}>
              {filtered.length === 0 ? (
                <EmptyState
                  icon="folder-open-outline"
                  title="لا توجد ملفات مطابقة"
                  description="جرّب تعديل البحث أو الفلتر."
                />
              ) : (
                filtered.slice(0, 40).map((file, index) => (
                  <View key={file.id}>
                    {index > 0 ? <Divider spacing={0} style={{ marginHorizontal: theme.spacing.lg }} /> : null}
                    <View style={styles.fileRow}>
                      <ListRow
                        title={file.name}
                        subtitle={`${file.path} · ${formatBytes(file.sizeBytes)}`}
                        icon={KIND_META[file.kind].icon}
                        iconColor={kindColor(file.kind, theme)}
                        right={
                          <View style={styles.fileActions}>
                            <Pressable onPress={() => toggleStar(file.id)} hitSlop={8}>
                              <Icon
                                name={file.starred ? 'star' : 'star-outline'}
                                size={18}
                                color={file.starred ? theme.colors.warning : theme.colors.textSubtle}
                              />
                            </Pressable>
                            <Pressable onPress={() => remove(file.id)} hitSlop={8}>
                              <Icon name="trash-outline" size={18} tone="subtle" />
                            </Pressable>
                          </View>
                        }
                      />
                    </View>
                  </View>
                ))
              )}
            </Card>
            {filtered.length > 40 ? (
              <Text variant="caption" tone="subtle" align="center" style={{ marginTop: theme.spacing.md }}>
                يتم عرض أول 40 من {formatNumber(filtered.length)} ملف
              </Text>
            ) : null}
          </View>
        ) : null}

        {tab === 'audit' ? (
          <View>
            <Card gradient="brand" style={{ marginTop: theme.spacing.sm }}>
              <View style={styles.auditHero}>
                <ProgressRing
                  value={(auditScore ?? 0) / 100}
                  size={130}
                  thickness={12}
                  color="#FFFFFF"
                  label={`${auditScore}%`}
                  sublabel="النتيجة"
                />
                <View style={{ flex: 1, marginStart: theme.spacing.lg }}>
                  <Text variant="subtitle" weight="bold" tone="inverse">
                    {audit?.nameAr ?? 'تدقيق شامل'}
                  </Text>
                  <Text variant="caption" tone="inverse" style={{ marginTop: 6, opacity: 0.9 }}>
                    {audit?.description}
                  </Text>
                  <Text variant="caption" tone="inverse" style={{ marginTop: 8, opacity: 0.85 }}>
                    {audit?.checks.filter((c) => c.passed).length ?? 0}/
                    {audit?.checks.length ?? 0} فحص ناجح
                  </Text>
                </View>
              </View>
            </Card>

            <View style={{ marginTop: theme.spacing.lg }}>
              <SectionHeader
                title="نتائج الفحوصات"
                subtitle={`العدد المتوقع ${audit?.expectedFileCount ?? 153} ملف`}
                icon="checkmark-done-outline"
                actionLabel="إعادة"
                onAction={runAudit}
              />
              {audit?.checks.map((check) => (
                <Card key={check.id} style={{ marginBottom: theme.spacing.sm }}>
                  <View style={styles.checkRow}>
                    <Icon
                      name={check.passed ? 'checkmark-circle' : 'close-circle'}
                      size={22}
                      color={check.passed ? theme.colors.success : theme.colors.danger}
                    />
                    <View style={{ flex: 1, marginStart: theme.spacing.md }}>
                      <Text variant="label" weight="semibold">
                        {check.labelAr}
                      </Text>
                      <Text variant="caption" tone="muted" style={{ marginTop: 2 }}>
                        {check.detail ?? check.description}
                      </Text>
                    </View>
                    <Badge
                      label={check.passed ? 'ناجح' : 'فاشل'}
                      tone={check.passed ? 'success' : 'danger'}
                    />
                  </View>
                </Card>
              ))}
            </View>
          </View>
        ) : null}

        {tab === 'code' ? (
          <View>
            <Card style={{ marginTop: theme.spacing.sm }}>
              <SectionHeader
                title="المحلل الذكي للكود"
                subtitle="فحص ثابت + إصلاح تلقائي (Self-Healing)"
                icon="bug-outline"
              />
              <Text variant="body" tone="muted" style={{ lineHeight: 22 }}>
                يفحص المحلل ملفات الكود بحثًا عن الأنماط الخطرة (أسرار مكشوفة، eval، debugger،
                مقارنات غير صارمة، إلخ) ويقترح إصلاحًا تلقائيًا آمنًا.
              </Text>
              <Button
                label={analysis ? 'إعادة التحليل' : 'بدء التحليل'}
                icon="flash-outline"
                fullWidth
                style={{ marginTop: theme.spacing.md }}
                onPress={analyzeCode}
              />
            </Card>

            {analysis ? (
              <View style={{ marginTop: theme.spacing.lg }}>
                <Card>
                  <View style={styles.analysisHead}>
                    <ProgressRing
                      value={analysis.healthScore / 100}
                      size={110}
                      thickness={11}
                      color={
                        analysis.healthScore >= 85
                          ? theme.colors.success
                          : analysis.healthScore >= 65
                            ? theme.colors.warning
                            : theme.colors.danger
                      }
                      label={`${analysis.healthScore}`}
                      sublabel="سلامة"
                    />
                    <View style={{ flex: 1, marginStart: theme.spacing.lg, gap: 8 }}>
                      <Text variant="label" tone="muted">
                        {formatNumber(analysis.files)} ملف · {formatNumber(analysis.issues.length)} مشكلة
                      </Text>
                      <View style={styles.severityRow}>
                        {(Object.keys(SEVERITY_META) as Severity[]).map((sev) => (
                          <Badge
                            key={sev}
                            label={`${SEVERITY_META[sev].label} ${analysis.bySeverity[sev]}`}
                            tone={SEVERITY_META[sev].tone}
                          />
                        ))}
                      </View>
                      <Text variant="caption" tone="success">
                        {formatNumber(analysis.autoFixable)} إصلاح تلقائي متاح
                      </Text>
                    </View>
                  </View>
                </Card>

                <View style={{ marginTop: theme.spacing.lg }}>
                  <SectionHeader title="المشكلات المكتشفة" icon="list-outline" />
                  {analysis.issues.length === 0 ? (
                    <EmptyState
                      icon="checkmark-done-circle-outline"
                      title="لا توجد مشكلات"
                      description="الكود نظيف وخالٍ من الأنماط الخطرة."
                    />
                  ) : (
                    analysis.issues.map((issue) => (
                      <Card key={issue.id} style={{ marginBottom: theme.spacing.sm }}>
                        <View style={styles.issueHead}>
                          <Badge
                            label={SEVERITY_META[issue.severity].label}
                            tone={SEVERITY_META[issue.severity].tone}
                          />
                          <Text
                            variant="caption"
                            tone="subtle"
                            style={{ flex: 1, marginStart: theme.spacing.sm }}
                            numberOfLines={1}
                          >
                            {issue.file}:{issue.line}
                          </Text>
                          <Text variant="caption" tone="muted">
                            {issue.rule}
                          </Text>
                        </View>
                        <Text variant="body" style={{ marginTop: theme.spacing.sm, lineHeight: 21 }}>
                          {issue.message}
                        </Text>
                        {issue.suggestion ? (
                          <Text variant="caption" tone="muted" style={{ marginTop: 4 }}>
                            💡 {issue.suggestion}
                          </Text>
                        ) : null}
                        {issue.fix ? (
                          <View
                            style={[
                              styles.fixBox,
                              {
                                backgroundColor: theme.colors.surfaceMuted,
                                borderRadius: theme.radius.md,
                                marginTop: theme.spacing.sm,
                              },
                            ]}
                          >
                            <Text variant="caption" tone="danger" style={styles.mono}>
                              − {issue.fix.before}
                            </Text>
                            <Text variant="caption" tone="success" style={[styles.mono, { marginTop: 4 }]}>
                              + {issue.fix.after}
                            </Text>
                          </View>
                        ) : null}
                      </Card>
                    ))
                  )}
                </View>
              </View>
            ) : (
              <View style={{ marginTop: theme.spacing.lg }}>
                <EmptyState
                  icon="code-working-outline"
                  title="لم يبدأ التحليل بعد"
                  description="اضغط «بدء التحليل» لفحص ملفات الكود وإظهار النتائج."
                />
              </View>
            )}
          </View>
        ) : null}

        <View style={{ marginTop: theme.spacing.xl }}>
          <Progress value={(report?.healthScore ?? 0) / 100} color={theme.colors.accent} />
          <Text variant="caption" tone="subtle" align="center" style={{ marginTop: theme.spacing.sm }}>
            {report?.summary ?? 'جارٍ تجهيز تقرير مساحة العمل…'}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', gap: 8, marginBottom: 16, flexWrap: 'wrap' },
  statRow: { flexDirection: 'row', gap: 12 },
  donutRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  legend: { flex: 1, gap: 8 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  fileRow: { paddingHorizontal: 4 },
  fileActions: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  auditHero: { flexDirection: 'row', alignItems: 'center' },
  checkRow: { flexDirection: 'row', alignItems: 'center' },
  analysisHead: { flexDirection: 'row', alignItems: 'center' },
  severityRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  issueHead: { flexDirection: 'row', alignItems: 'center' },
  fixBox: { padding: 10 },
  mono: { fontFamily: 'monospace' },
});
