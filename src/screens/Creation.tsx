import React from 'react';
import {
  Linking,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useTheme } from '../theme';
import { AppHeader } from '../components/composite/AppHeader';
import { SectionHeader } from '../components/composite/SectionHeader';
import { EmptyState } from '../components/composite/EmptyState';
import { Card } from '../components/ui/Card';
import { Text } from '../components/ui/Text';
import { Badge } from '../components/ui/Badge';
import type { BadgeTone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Chip } from '../components/ui/Chip';
import { Divider } from '../components/ui/Divider';
import { Icon } from '../components/ui/Icon';
import type { IconName, IconTone } from '../components/ui/Icon';
import { Input } from '../components/ui/Input';
import { Progress } from '../components/ui/Progress';
import { Skeleton } from '../components/ui/Skeleton';
import { useCreationStore } from '../store/useCreationStore';
import type {
  ApiCreationJob,
  ApiCreationJobInput,
} from '../services/api/client';

/**
 * Creation Studio — the "one goal in, a real deliverable out" surface.
 *
 * This is the human face of the autonomous Director loop. The user writes a
 * single goal; Semo0o thinks (brief), plans (storyboard + bibles + prompts),
 * produces, critiques its own work, improves it, then composes and encodes a
 * real, downloadable deliverable (animated GIF preview, MJPEG/AVI video and a
 * full composition bundle).
 *
 * Everything rendered here is read from the backend `/creation/*` API — the live
 * pipeline stage, the per-iteration critic score, the manifest and the artefact
 * bytes. Nothing is faked, and any failure surfaces the exact backend error.
 */

// The ordered stages the Director emits. `progress.stage` is one of these keys.
const STAGES: { key: string; label: string; icon: IconName }[] = [
  { key: 'brief', label: 'الفهم', icon: 'bulb-outline' },
  { key: 'storyboard', label: 'التخطيط', icon: 'map-outline' },
  { key: 'bibles', label: 'الهوية', icon: 'color-palette-outline' },
  { key: 'produce', label: 'الإنتاج', icon: 'images-outline' },
  { key: 'compose', label: 'التركيب', icon: 'layers-outline' },
  { key: 'render', label: 'الرندر', icon: 'film-outline' },
  { key: 'critique', label: 'التقييم', icon: 'analytics-outline' },
  { key: 'encode', label: 'الترميز', icon: 'save-outline' },
  { key: 'bundle', label: 'التغليف', icon: 'cube-outline' },
];

const STATUS_META: Record<string, { label: string; tone: BadgeTone; icon: IconName }> = {
  running: { label: 'قيد الإنشاء', tone: 'info', icon: 'sync-outline' },
  queued: { label: 'في الانتظار', tone: 'neutral', icon: 'time-outline' },
  completed: { label: 'مكتمل', tone: 'success', icon: 'checkmark-circle-outline' },
  failed: { label: 'فشل', tone: 'danger', icon: 'alert-circle-outline' },
  cancelled: { label: 'ملغى', tone: 'warning', icon: 'close-circle-outline' },
};

const FORMAT_OPTIONS: { value: NonNullable<ApiCreationJobInput['format']>; label: string; icon: IconName }[] = [
  { value: 'landscape', label: 'أفقي 16:9', icon: 'tv-outline' },
  { value: 'portrait', label: 'عمودي 9:16', icon: 'phone-portrait-outline' },
  { value: 'square', label: 'مربع 1:1', icon: 'square-outline' },
  { value: 'wide', label: 'سينمائي 21:9', icon: 'film-outline' },
];

const RESOLUTION_OPTIONS: { value: NonNullable<ApiCreationJobInput['resolution']>; label: string }[] = [
  { value: 'draft', label: 'مسودة' },
  { value: 'standard', label: 'قياسي' },
  { value: 'high', label: 'عالي' },
  { value: 'full', label: 'كامل' },
];

const DURATION_OPTIONS = [8, 15, 25, 45];

const PALETTE_OPTIONS = ['midnight', 'sunrise', 'forest', 'ocean', 'candy', 'neon', 'corporate', 'sand', 'rose', 'mono'];

const PALETTE_LABEL: Record<string, string> = {
  midnight: 'ليلي', sunrise: 'شروق', forest: 'غابة', ocean: 'محيط', candy: 'حلوى',
  neon: 'نيون', corporate: 'مؤسسي', sand: 'رملي', rose: 'وردي', mono: 'أحادي',
};

const SUBSCORE_LABEL: Record<string, string> = {
  composition: 'التكوين', contrast: 'التباين', legibility: 'الوضوح',
  pacing: 'الإيقاع', coherence: 'الترابط', audio: 'الصوت', brand: 'الهوية',
};

const PROMPT_IDEAS = [
  'أطلق منتج SaaS جديد بفيديو إعلاني عمودي مدته 15 ثانية بأسلوب نيون',
  'اشرح كيف تعمل الخوارزميات في فيديو تعليمي هادئ مدته 40 ثانية',
  'قصة سينمائية قصيرة عن رحلة رائد أعمال، بأسلوب رملي دافئ',
];

function statusMeta(status: string) {
  return STATUS_META[status] ?? { label: status, tone: 'neutral' as BadgeTone, icon: 'help-circle-outline' as IconName };
}

/** Badge tones map onto icon tones 1:1 except `neutral`, which has no icon tone. */
function iconTone(tone: BadgeTone): IconTone {
  return tone === 'neutral' ? 'muted' : tone;
}

function stageIndex(stage?: string): number {
  if (!stage) return -1;
  return STAGES.findIndex((s) => s.key === stage);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function scoreTone(score: number): BadgeTone {
  if (score >= 0.85) return 'success';
  if (score >= 0.7) return 'info';
  if (score >= 0.5) return 'warning';
  return 'danger';
}

function scoreColor(theme: ReturnType<typeof useTheme>, score: number): string {
  if (score >= 0.85) return theme.colors.success;
  if (score >= 0.7) return theme.colors.info;
  if (score >= 0.5) return theme.colors.warning;
  return theme.colors.danger;
}

export function Creation() {
  const theme = useTheme();
  const capabilities = useCreationStore((s) => s.capabilities);
  const jobs = useCreationStore((s) => s.jobs);
  const activeJob = useCreationStore((s) => s.activeJob);
  const loading = useCreationStore((s) => s.loading);
  const submitting = useCreationStore((s) => s.submitting);
  const busy = useCreationStore((s) => s.busy);
  const error = useCreationStore((s) => s.error);
  const notice = useCreationStore((s) => s.notice);
  const load = useCreationStore((s) => s.load);
  const start = useCreationStore((s) => s.start);
  const select = useCreationStore((s) => s.select);
  const cancel = useCreationStore((s) => s.cancel);
  const clearNotice = useCreationStore((s) => s.clearNotice);
  const artifactUrl = useCreationStore((s) => s.artifactUrl);

  const [goal, setGoal] = React.useState('');
  const [format, setFormat] = React.useState<NonNullable<ApiCreationJobInput['format']>>('landscape');
  const [resolution, setResolution] = React.useState<NonNullable<ApiCreationJobInput['resolution']>>('standard');
  const [duration, setDuration] = React.useState<number>(15);
  const [palette, setPalette] = React.useState<string | undefined>(undefined);
  const [refreshing, setRefreshing] = React.useState(false);

  React.useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onRefresh = React.useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const submit = React.useCallback(async () => {
    const trimmed = goal.trim();
    if (!trimmed) return;
    const input: ApiCreationJobInput = {
      goal: trimmed,
      format,
      resolution,
      duration,
      bundle: true,
    };
    if (palette) input.palette = palette;
    const job = await start(input);
    if (job) setGoal('');
  }, [goal, format, resolution, duration, palette, start]);

  const openArtifact = React.useCallback(
    async (jobId: string, name: 'gif' | 'avi' | 'bundle') => {
      try {
        await Linking.openURL(artifactUrl(jobId, name));
      } catch {
        /* the browser blocks popups occasionally; the link is still copyable */
      }
    },
    [artifactUrl],
  );

  const providers = capabilities?.providers;
  const providerChips: { label: string; live: boolean }[] = providers
    ? [
        { label: 'صور', live: providers.image },
        { label: 'رؤية', live: providers.vision },
        { label: 'صوت بشري', live: providers.tts },
        { label: 'فيديو', live: providers.video },
        { label: 'موسيقى', live: providers.music },
        { label: 'تحليل وسائط', live: providers.mediaAnalysis },
      ]
    : [];

  return (
    <ScrollView
      style={{ backgroundColor: theme.colors.background }}
      contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: theme.spacing['5xl'] }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.primary} />
      }
    >
      <AppHeader
        title="استوديو الإنشاء"
        subtitle="هدف واحد → فيديو احترافي جاهز للتحميل"
        right={
          <Badge
            label={capabilities?.kernel ? 'المحرّك جاهز' : 'جارٍ التحقق'}
            tone={capabilities?.kernel ? 'success' : 'neutral'}
          />
        }
      />

      {error ? (
        <Card accent={theme.colors.danger} style={{ marginBottom: theme.spacing.lg }}>
          <View style={styles.row}>
            <Icon name="alert-circle-outline" size={18} tone="danger" />
            <Text variant="label" tone="danger" style={{ marginStart: 8, flex: 1 }}>
              {error}
            </Text>
          </View>
        </Card>
      ) : null}

      {notice && notice !== 'CREATION_STARTED' ? (
        <Card accent={theme.colors.success} style={{ marginBottom: theme.spacing.lg }}>
          <View style={styles.row}>
            <Icon name="checkmark-circle-outline" size={18} tone="success" />
            <Text variant="label" tone="success" style={{ marginStart: 8, flex: 1 }}>
              {notice === 'CREATION_CANCELLED' ? 'تم إلغاء المهمة.' : notice}
            </Text>
            <Button label="إخفاء" variant="ghost" size="sm" onPress={clearNotice} />
          </View>
        </Card>
      ) : null}

      {/* ---- Composer: the single goal ---- */}
      <Card style={{ marginBottom: theme.spacing.lg }}>
        <SectionHeader
          icon="sparkles-outline"
          title="ماذا تريد أن نُنشئ؟"
          subtitle="اكتب الهدف مرة واحدة — والباقي علينا."
        />
        <Input
          value={goal}
          onChangeText={setGoal}
          placeholder="مثال: فيديو إعلاني عمودي لإطلاق تطبيق جديد بأسلوب نيون…"
          multiline
          numberOfLines={4}
          style={{ minHeight: 96, textAlignVertical: 'top' }}
          icon="create-outline"
        />

        <Text variant="label" tone="muted" style={{ marginTop: theme.spacing.md, marginBottom: 6 }}>
          الصيغة
        </Text>
        <View style={styles.wrap}>
          {FORMAT_OPTIONS.map((option) => (
            <Chip
              key={option.value}
              label={option.label}
              icon={option.icon}
              selected={format === option.value}
              onPress={() => setFormat(option.value)}
            />
          ))}
        </View>

        <Text variant="label" tone="muted" style={{ marginTop: theme.spacing.md, marginBottom: 6 }}>
          الجودة
        </Text>
        <View style={styles.wrap}>
          {RESOLUTION_OPTIONS.map((option) => (
            <Chip
              key={option.value}
              label={option.label}
              selected={resolution === option.value}
              onPress={() => setResolution(option.value)}
              tone="accent"
            />
          ))}
        </View>

        <Text variant="label" tone="muted" style={{ marginTop: theme.spacing.md, marginBottom: 6 }}>
          المدة (ثانية)
        </Text>
        <View style={styles.wrap}>
          {DURATION_OPTIONS.map((value) => (
            <Chip
              key={value}
              label={`${value}s`}
              selected={duration === value}
              onPress={() => setDuration(value)}
              tone="highlight"
            />
          ))}
        </View>

        <Text variant="label" tone="muted" style={{ marginTop: theme.spacing.md, marginBottom: 6 }}>
          لوحة الألوان (اختياري — نستنتجها تلقائيًا إن تُركت فارغة)
        </Text>
        <View style={styles.wrap}>
          <Chip label="تلقائي" selected={!palette} onPress={() => setPalette(undefined)} tone="default" />
          {PALETTE_OPTIONS.map((value) => (
            <Chip
              key={value}
              label={PALETTE_LABEL[value] ?? value}
              selected={palette === value}
              onPress={() => setPalette(value)}
              tone="default"
            />
          ))}
        </View>

        <View style={[styles.wrap, { marginTop: theme.spacing.md }]}>
          {PROMPT_IDEAS.map((idea) => (
            <Chip key={idea} label={idea} size="sm" tone="default" onPress={() => setGoal(idea)} />
          ))}
        </View>

        <Button
          label="أنشئ الآن"
          icon="rocket-outline"
          fullWidth
          loading={submitting}
          disabled={!goal.trim() || submitting}
          onPress={submit}
          style={{ marginTop: theme.spacing.lg }}
        />
      </Card>

      {/* ---- Capabilities ---- */}
      <Card style={{ marginBottom: theme.spacing.lg }}>
        <SectionHeader
          icon="pulse-outline"
          title="القدرات الحقيقية"
          subtitle="ما هو مُهيّأ فعليًا على هذا الخادم الآن."
        />
        {loading && !capabilities ? (
          <View style={{ gap: 8 }}>
            <Skeleton height={16} width="60%" />
            <Skeleton height={16} width="80%" />
          </View>
        ) : (
          <>
            <View style={styles.wrap}>
              <Badge label="محرّك الوسائط" tone={capabilities?.kernel ? 'success' : 'neutral'} />
              <Badge label="الاستوديو المحلي" tone={capabilities?.localStudio ? 'success' : 'neutral'} />
              <Badge label="تدرّج تلقائي" tone="info" />
            </View>
            <Divider style={{ marginVertical: theme.spacing.md }} />
            <Text variant="caption" tone="subtle" style={{ marginBottom: 6 }}>
              مزوّدو الذكاء الاصطناعي (غير المهيّأين يعملون محليًا بدون أي اعتماد خارجي)
            </Text>
            <View style={styles.wrap}>
              {providerChips.map((chip) => (
                <Badge key={chip.label} label={chip.label} tone={chip.live ? 'success' : 'neutral'} />
              ))}
            </View>
          </>
        )}
      </Card>

      {/* ---- Active job ---- */}
      {activeJob ? (
        <ActiveJobCard
          job={activeJob}
          busy={busy === activeJob.id}
          onCancel={() => cancel(activeJob.id)}
          onOpen={openArtifact}
        />
      ) : null}

      {/* ---- History ---- */}
      <SectionHeader
        icon="time-outline"
        title="سجل الإنشاءات"
        subtitle={jobs.length ? `${jobs.length} مهمة` : undefined}
      />
      {loading && !jobs.length ? (
        <Card>
          <Skeleton height={18} width="50%" />
          <Skeleton height={14} width="80%" style={{ marginTop: 10 }} />
        </Card>
      ) : jobs.length === 0 ? (
        <Card>
          <EmptyState
            icon="film-outline"
            title="لا توجد إنشاءات بعد"
            description="اكتب هدفك في الأعلى واضغط «أنشئ الآن» لترى Semo0o يفكّر ويخطط وينفّذ ويقيّم ويحسّن ثم يسلّم النتيجة."
          />
        </Card>
      ) : (
        <View style={{ gap: theme.spacing.md }}>
          {jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              active={activeJob?.id === job.id}
              onPress={() => select(job.id)}
            />
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function ActiveJobCard({
  job,
  busy,
  onCancel,
  onOpen,
}: {
  job: ApiCreationJob;
  busy: boolean;
  onCancel: () => void;
  onOpen: (jobId: string, name: 'gif' | 'avi' | 'bundle') => void;
}) {
  const theme = useTheme();
  const meta = statusMeta(job.status);
  const idx = stageIndex(job.progress?.stage);
  const total = job.progress?.total ?? 0;
  const done = job.progress?.done ?? 0;
  const renderRatio = total > 0 ? Math.min(1, done / total) : 0;
  const overall = job.status === 'completed' ? 1 : idx >= 0 ? Math.min(0.98, (idx + 1) / STAGES.length) : 0.02;

  const critique = job.result?.critique;
  const iterations = job.result?.iterations ?? [];
  const manifest = job.result?.manifest;

  return (
    <Card gradient="surface" style={{ marginBottom: theme.spacing.lg }}>
      <View style={styles.between}>
        <View style={styles.row}>
          <Icon name={meta.icon} size={18} tone={iconTone(meta.tone)} />
          <Text variant="subtitle" weight="bold" style={{ marginStart: 8 }}>
            المهمة النشطة
          </Text>
        </View>
        <Badge label={meta.label} tone={meta.tone} />
      </View>

      <Text variant="body" tone="muted" style={{ marginTop: theme.spacing.sm }} numberOfLines={2}>
        {job.goal}
      </Text>

      {job.status === 'running' || job.status === 'queued' ? (
        <>
          <View style={[styles.between, { marginTop: theme.spacing.md }]}>
            <Text variant="caption" tone="subtle">
              المرحلة: {STAGES[idx]?.label ?? job.progress?.stage ?? '—'}
            </Text>
            {job.progress?.stage === 'render' && total > 0 ? (
              <Text variant="caption" tone="subtle">
                {done}/{total} إطار
              </Text>
            ) : null}
          </View>
          <Progress value={overall} style={{ marginTop: 6 }} />
          {job.progress?.stage === 'render' && total > 0 ? (
            <Progress value={renderRatio} color={theme.colors.accent} height={4} style={{ marginTop: 6 }} />
          ) : null}
          <View style={[styles.wrap, { marginTop: theme.spacing.md }]}>
            {STAGES.map((stage, i) => (
              <Badge
                key={stage.key}
                label={stage.label}
                tone={i < idx ? 'success' : i === idx ? 'info' : 'neutral'}
              />
            ))}
          </View>
          <Button
            label="إلغاء المهمة"
            icon="close-circle-outline"
            variant="outline"
            size="sm"
            loading={busy}
            onPress={onCancel}
            style={{ marginTop: theme.spacing.md, alignSelf: 'flex-start' }}
          />
        </>
      ) : null}

      {job.status === 'failed' ? (
        <Card accent={theme.colors.danger} style={{ marginTop: theme.spacing.md }}>
          <Text variant="label" tone="danger">
            {job.error ?? 'CREATION_FAILED'}
          </Text>
        </Card>
      ) : null}

      {critique ? (
        <>
          <Divider style={{ marginVertical: theme.spacing.md }} />
          <View style={styles.between}>
            <Text variant="label" tone="muted">
              تقييم الناقد الذاتي
            </Text>
            <View style={styles.row}>
              <Text variant="title" weight="extrabold" style={{ color: scoreColor(theme, critique.score) }}>
                {Math.round(critique.score * 100)}
              </Text>
              <Text variant="caption" tone="subtle" style={{ marginStart: 4 }}>
                /100
              </Text>
            </View>
          </View>
          <View style={{ gap: 8, marginTop: theme.spacing.sm }}>
            {Object.entries(critique.subscores ?? {}).map(([key, value]) => (
              <View key={key}>
                <View style={styles.between}>
                  <Text variant="caption" tone="subtle">
                    {SUBSCORE_LABEL[key] ?? key}
                  </Text>
                  <Text variant="caption" tone="muted">
                    {Math.round((value as number) * 100)}%
                  </Text>
                </View>
                <Progress
                  value={value as number}
                  color={scoreColor(theme, value as number)}
                  height={6}
                  style={{ marginTop: 4 }}
                />
              </View>
            ))}
          </View>

          {iterations.length > 1 ? (
            <>
              <Text variant="caption" tone="subtle" style={{ marginTop: theme.spacing.md }}>
                مسار التحسين ({iterations.length} جولات)
              </Text>
              <View style={[styles.wrap, { marginTop: 6 }]}>
                {iterations.map((it) => (
                  <Badge
                    key={it.iteration}
                    label={`جولة ${it.iteration}: ${Math.round(it.score * 100)}`}
                    tone={scoreTone(it.score)}
                  />
                ))}
              </View>
            </>
          ) : null}

          {critique.issues?.length ? (
            <>
              <Text variant="caption" tone="subtle" style={{ marginTop: theme.spacing.md }}>
                ملاحظات الناقد
              </Text>
              <View style={{ gap: 6, marginTop: 6 }}>
                {critique.issues.slice(0, 4).map((issue, i) => (
                  <View key={`${issue.area}-${i}`} style={styles.row}>
                    <Badge
                      label={issue.severity}
                      tone={issue.severity === 'high' ? 'danger' : issue.severity === 'medium' ? 'warning' : 'neutral'}
                    />
                    <Text variant="caption" tone="muted" style={{ marginStart: 8, flex: 1 }}>
                      {issue.message}
                    </Text>
                  </View>
                ))}
              </View>
            </>
          ) : null}
        </>
      ) : null}

      {manifest ? (
        <>
          <Divider style={{ marginVertical: theme.spacing.md }} />
          <View style={styles.wrap}>
            <Badge label={`${manifest.width}×${manifest.height}`} tone="neutral" />
            <Badge label={`${manifest.fps} fps`} tone="neutral" />
            <Badge label={`${manifest.frameCount} إطار`} tone="neutral" />
            <Badge label={`${Math.round(manifest.duration)}s`} tone="neutral" />
            <Badge label={manifest.hasAudio ? 'بصوت' : 'بدون صوت'} tone={manifest.hasAudio ? 'success' : 'neutral'} />
            <Badge label={`${Math.round(manifest.elapsedMs / 100) / 10}s زمن`} tone="info" />
          </View>
        </>
      ) : null}

      {job.status === 'completed' ? (
        <>
          <Divider style={{ marginVertical: theme.spacing.md }} />
          <Text variant="label" tone="muted" style={{ marginBottom: 6 }}>
            النتيجة القابلة للتحميل
          </Text>
          <View style={{ gap: 8 }}>
            <ArtifactRow
              label="معاينة متحركة (GIF)"
              icon="images-outline"
              artifact={job.artifacts.gif}
              onPress={() => onOpen(job.id, 'gif')}
            />
            <ArtifactRow
              label="فيديو (AVI / MJPEG)"
              icon="film-outline"
              artifact={job.artifacts.avi}
              onPress={() => onOpen(job.id, 'avi')}
            />
            <ArtifactRow
              label="حزمة التركيب الكاملة (ZIP)"
              icon="cube-outline"
              artifact={job.artifacts.bundle}
              onPress={() => onOpen(job.id, 'bundle')}
            />
          </View>
        </>
      ) : null}
    </Card>
  );
}

function ArtifactRow({
  label,
  icon,
  artifact,
  onPress,
}: {
  label: string;
  icon: IconName;
  artifact: { bytes: number; mimeType: string } | null;
  onPress: () => void;
}) {
  if (!artifact) {
    return (
      <View style={[styles.between, { opacity: 0.5 }]}>
        <View style={styles.row}>
          <Icon name={icon} size={18} tone="subtle" />
          <Text variant="label" tone="subtle" style={{ marginStart: 8 }}>
            {label}
          </Text>
        </View>
        <Badge label="غير متاح" tone="neutral" />
      </View>
    );
  }
  return (
    <View style={styles.between}>
      <View style={styles.row}>
        <Icon name={icon} size={18} tone="primary" />
        <View style={{ marginStart: 8 }}>
          <Text variant="label">{label}</Text>
          <Text variant="caption" tone="subtle">
            {formatBytes(artifact.bytes)} · {artifact.mimeType}
          </Text>
        </View>
      </View>
      <Button label="تحميل" icon="download-outline" size="sm" variant="secondary" onPress={onPress} />
    </View>
  );
}

function JobRow({
  job,
  active,
  onPress,
}: {
  job: ApiCreationJob;
  active: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const meta = statusMeta(job.status);
  const score = job.result?.critique?.score;
  return (
    <Card
      onPress={onPress}
      accent={active ? theme.colors.primary : undefined}
      style={{ borderWidth: active ? 1.5 : undefined }}
    >
      <View style={styles.between}>
        <Text variant="label" style={{ flex: 1, marginEnd: 8 }} numberOfLines={1}>
          {job.goal}
        </Text>
        <Badge label={meta.label} tone={meta.tone} />
      </View>
      <View style={[styles.wrap, { marginTop: theme.spacing.sm }]}>
        {score !== undefined ? <Badge label={`جودة ${Math.round(score * 100)}`} tone={scoreTone(score)} /> : null}
        <Badge label={job.progress?.stage ?? '—'} tone="neutral" />
        <Badge label={`${Math.round(job.elapsedMs / 100) / 10}s`} tone="neutral" />
        {job.artifacts.gif ? <Badge label="GIF" tone="info" /> : null}
        {job.artifacts.avi ? <Badge label="AVI" tone="info" /> : null}
        {job.artifacts.bundle ? <Badge label="ZIP" tone="info" /> : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
