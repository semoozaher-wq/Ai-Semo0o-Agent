import React from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useTheme } from '../theme';
import { Screen } from '../components/ui/Screen';
import { Card } from '../components/ui/Card';
import { Text } from '../components/ui/Text';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Chip } from '../components/ui/Chip';
import { Badge } from '../components/ui/Badge';
import { Icon } from '../components/ui/Icon';
import type { IconName } from '../components/ui/Icon';
import { AppHeader } from '../components/composite/AppHeader';
import { SectionHeader } from '../components/composite/SectionHeader';
import { StatCard } from '../components/composite/StatCard';
import { EmptyState } from '../components/composite/EmptyState';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { formatBytes, formatNumber } from '../utils/format';
import { base64ToBytes } from '../utils/base64';
import type { WorkspaceFile } from '../types/workspace';

/* -------------------------------------------------------------------------- */
/*  Platform helpers                                                           */
/* -------------------------------------------------------------------------- */

interface PickedFile {
  name: string;
  bytes: Uint8Array;
}

/** Open the browser file picker (web). Resolves `null` on native/unsupported. */
function pickLocalFile(accept: string): Promise<PickedFile | null> {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () =>
        resolve({ name: file.name, bytes: new Uint8Array(reader.result as ArrayBuffer) });
      reader.onerror = () => resolve(null);
      reader.readAsArrayBuffer(file);
    };
    document.body.appendChild(input);
    input.click();
    setTimeout(() => {
      if (input.parentNode) input.parentNode.removeChild(input);
    }, 1500);
  });
}

/** Trigger a browser download from a URL / data URL. */
function triggerDownload(url: string, filename: string): void {
  if (typeof document === 'undefined') return;
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

/** Decode a pasted `data:` URL (base64 or plain) into bytes. */
function decodeDataUrl(source: string): Uint8Array {
  const comma = source.indexOf(',');
  const meta = source.slice(0, comma);
  const payload = source.slice(comma + 1);
  if (/;base64/i.test(meta)) return base64ToBytes(payload);
  return new TextEncoder().encode(decodeURIComponent(payload));
}

const CODE_EXT: Record<string, IconName> = {
  ts: 'logo-javascript',
  tsx: 'logo-react',
  js: 'logo-javascript',
  jsx: 'logo-react',
  json: 'code-slash-outline',
  md: 'document-text-outline',
  css: 'color-palette-outline',
  html: 'globe-outline',
  py: 'logo-python',
  zip: 'archive-outline',
};

function fileIcon(file: WorkspaceFile): IconName {
  if (file.isBinary) return 'document-outline';
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
  return CODE_EXT[ext] ?? 'document-text-outline';
}

function sourceTone(source: WorkspaceFile['source']): 'primary' | 'accent' | 'info' | 'neutral' {
  switch (source) {
    case 'github':
      return 'primary';
    case 'zip':
      return 'accent';
    case 'generated':
      return 'info';
    default:
      return 'neutral';
  }
}

function sourceLabel(source: WorkspaceFile['source']): string {
  switch (source) {
    case 'github':
      return 'GitHub';
    case 'zip':
      return 'ZIP';
    case 'generated':
      return 'مُولّد';
    default:
      return 'محلي';
  }
}

/* -------------------------------------------------------------------------- */
/*  Screen                                                                     */
/* -------------------------------------------------------------------------- */

interface EditorState {
  path: string;
  content: string;
  isNew: boolean;
}

export function Workspace() {
  const theme = useTheme();

  const workspace = useWorkspaceStore((s) => s.workspace);
  const busy = useWorkspaceStore((s) => s.busy);
  const error = useWorkspaceStore((s) => s.error);
  const lastExport = useWorkspaceStore((s) => s.lastExport);
  const importRepo = useWorkspaceStore((s) => s.importRepo);
  const importArchive = useWorkspaceStore((s) => s.importArchive);
  const exportZip = useWorkspaceStore((s) => s.exportZip);
  const write = useWorkspaceStore((s) => s.write);
  const remove = useWorkspaceStore((s) => s.remove);
  const clear = useWorkspaceStore((s) => s.clear);

  const [repoUrl, setRepoUrl] = React.useState('');
  const [ref, setRef] = React.useState('');
  const [subPath, setSubPath] = React.useState('');
  const [zipDataUrl, setZipDataUrl] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [onlyModified, setOnlyModified] = React.useState(false);
  const [editor, setEditor] = React.useState<EditorState | null>(null);
  const [toast, setToast] = React.useState<string | null>(null);

  const files = workspace.files;

  const stats = React.useMemo(() => {
    let totalBytes = 0;
    let modified = 0;
    for (const f of files) {
      totalBytes += f.sizeBytes;
      if (f.modified) modified += 1;
    }
    return { totalBytes, modified };
  }, [files]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return files
      .filter((f: WorkspaceFile) => (onlyModified ? f.modified : true))
      .filter((f: WorkspaceFile) => (q ? f.path.toLowerCase().includes(q) : true))
      .sort((a: WorkspaceFile, b: WorkspaceFile) => a.path.localeCompare(b.path));
  }, [files, query, onlyModified]);

  const modifiedPaths = React.useMemo(
    () => files.filter((f: WorkspaceFile) => f.modified).map((f: WorkspaceFile) => f.path),
    [files],
  );

  const originLabel =
    workspace.origin.kind === 'github'
      ? 'GitHub'
      : workspace.origin.kind === 'zip'
        ? 'ZIP'
        : workspace.origin.kind === 'generated'
          ? 'مُولّد'
          : 'فارغ';

  const flash = React.useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2600);
  }, []);

  /* ------------------------------ Actions ------------------------------- */

  const onImportRepo = React.useCallback(async () => {
    const url = repoUrl.trim();
    if (!url) {
      flash('أدخل رابط مستودع GitHub أولًا');
      return;
    }
    try {
      const count = await importRepo(url, {
        ref: ref.trim() || undefined,
        path: subPath.trim() || undefined,
      });
      setRepoUrl('');
      setRef('');
      setSubPath('');
      flash(`تم استيراد ${count} ملفًا من GitHub`);
    } catch {
      /* error surfaced by the store */
    }
  }, [repoUrl, ref, subPath, importRepo, flash]);

  const onPickZip = React.useCallback(async () => {
    const picked = await pickLocalFile('.zip,application/zip');
    if (!picked) {
      flash('اختيار الملفات غير متاح هنا — الصق رابط data: بالأرشيف');
      return;
    }
    try {
      const count = await importArchive(picked.bytes, picked.name);
      flash(`تم فك ضغط ${picked.name}: ${count} ملف`);
    } catch {
      /* handled by store */
    }
  }, [importArchive, flash]);

  const onImportDataUrl = React.useCallback(async () => {
    const source = zipDataUrl.trim();
    if (!source.startsWith('data:')) {
      flash('الصق رابط data: صالحًا للأرشيف');
      return;
    }
    try {
      const bytes = decodeDataUrl(source);
      const count = await importArchive(bytes, 'archive.zip');
      setZipDataUrl('');
      flash(`تم فك الضغط: ${count} ملف`);
    } catch {
      flash('تعذّر فك ضغط الأرشيف');
    }
  }, [zipDataUrl, importArchive, flash]);

  const onExport = React.useCallback(async () => {
    try {
      const info = await exportZip(onlyModified ? modifiedPaths : undefined, workspace.name);
      flash(`تم تجهيز ${info.filename} (${info.fileCount} ملف)`);
    } catch {
      flash('تعذّر إنشاء الأرشيف');
    }
  }, [exportZip, onlyModified, modifiedPaths, workspace.name, flash]);

  const onSaveEditor = React.useCallback(() => {
    if (!editor) return;
    const path = editor.path.trim();
    if (!path) {
      flash('أدخل مسار الملف');
      return;
    }
    write(path, editor.content);
    setEditor(null);
    flash('تم حفظ الملف');
  }, [editor, write, flash]);

  const onDelete = React.useCallback(
    (path: string) => {
      remove(path);
      setEditor(null);
      flash('تم حذف الملف');
    },
    [remove, flash],
  );

  const onClear = React.useCallback(async () => {
    await clear();
    flash('تم إفراغ مساحة العمل');
  }, [clear, flash]);

  /* ------------------------------- Render ------------------------------- */

  return (
    <Screen padded={false} top>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.lg,
          paddingTop: theme.spacing.lg,
          paddingBottom: theme.spacing['5xl'],
        }}
        showsVerticalScrollIndicator={false}
      >
        <AppHeader
          title="مساحة العمل"
          subtitle="استيراد من GitHub و ZIP · تعديل · تصدير"
          right={
            <Button
              label="تصدير ZIP"
              icon="download-outline"
              size="sm"
              variant="primary"
              loading={busy}
              disabled={files.length === 0}
              onPress={() => void onExport()}
            />
          }
        />

        {/* Stats */}
        <View style={styles.statRow}>
          <StatCard
            label="ملفات مساحة العمل"
            value={formatNumber(files.length)}
            icon="documents-outline"
            tone={theme.colors.primary}
          />
          <StatCard
            label="الحجم الكلي"
            value={formatBytes(stats.totalBytes)}
            icon="server-outline"
            tone={theme.colors.accent}
          />
        </View>
        <View style={[styles.statRow, { marginTop: theme.spacing.md }]}>
          <StatCard
            label="ملفات معدّلة"
            value={formatNumber(stats.modified)}
            icon="create-outline"
            tone={theme.colors.warning}
          />
          <StatCard
            label="المصدر الحالي"
            value={originLabel}
            icon="git-branch-outline"
            tone={theme.colors.highlight}
          />
        </View>

        {/* GitHub import */}
        <Card style={{ marginTop: theme.spacing.lg }}>
          <SectionHeader title="استيراد مستودع GitHub" icon="logo-github" />
          <Input
            label="رابط المستودع"
            placeholder="https://github.com/owner/repo"
            value={repoUrl}
            onChangeText={setRepoUrl}
            icon="link-outline"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={[styles.inline, { marginTop: theme.spacing.md }]}>
            <Input
              label="الفرع / الوسم"
              placeholder="main"
              value={ref}
              onChangeText={setRef}
              icon="git-branch-outline"
              autoCapitalize="none"
              containerStyle={styles.flex1}
            />
            <Input
              label="مسار فرعي"
              placeholder="src/"
              value={subPath}
              onChangeText={setSubPath}
              icon="folder-outline"
              autoCapitalize="none"
              containerStyle={styles.flex1}
            />
          </View>
          <Button
            label="استيراد المستودع"
            icon="cloud-download-outline"
            fullWidth
            loading={busy}
            onPress={() => void onImportRepo()}
            style={{ marginTop: theme.spacing.lg }}
          />
        </Card>

        {/* ZIP import */}
        <Card style={{ marginTop: theme.spacing.lg }}>
          <SectionHeader title="رفع أرشيف ZIP" icon="archive-outline" />
          <Button
            label="اختيار ملف ZIP من الجهاز"
            icon="cloud-upload-outline"
            variant="secondary"
            fullWidth
            loading={busy}
            onPress={() => void onPickZip()}
          />
          <Input
            label="أو الصق رابط data: للأرشيف"
            placeholder="data:application/zip;base64,...."
            value={zipDataUrl}
            onChangeText={setZipDataUrl}
            icon="link-outline"
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            containerStyle={{ marginTop: theme.spacing.md }}
          />
          <Button
            label="استيراد من الرابط"
            icon="cloud-download-outline"
            variant="outline"
            fullWidth
            loading={busy}
            disabled={!zipDataUrl.trim()}
            onPress={() => void onImportDataUrl()}
            style={{ marginTop: theme.spacing.md }}
          />
        </Card>

        {/* Error banner */}
        {error ? (
          <Card accent={theme.colors.danger} style={{ marginTop: theme.spacing.lg }}>
            <View style={styles.inline}>
              <Icon name="alert-circle-outline" size={18} tone="danger" />
              <Text tone="danger" style={{ marginStart: 8, flex: 1 }}>
                {error}
              </Text>
            </View>
          </Card>
        ) : null}

        {/* Files */}
        <View style={{ marginTop: theme.spacing['2xl'] }}>
          <SectionHeader
            title="ملفات مساحة العمل"
            subtitle={`${formatNumber(filtered.length)} من ${formatNumber(files.length)}`}
            icon="folder-open-outline"
            actionLabel={files.length > 0 ? 'مسح الكل' : undefined}
            onAction={files.length > 0 ? () => void onClear() : undefined}
          />

          <View style={styles.inline}>
            <Input
              placeholder="ابحث عن ملف..."
              value={query}
              onChangeText={setQuery}
              icon="search-outline"
              containerStyle={styles.flex1}
            />
            <Chip
              label="المعدّلة فقط"
              icon="create-outline"
              selected={onlyModified}
              onPress={() => setOnlyModified((v) => !v)}
              tone="highlight"
              style={{ marginStart: theme.spacing.sm }}
            />
            <Chip
              label="ملف جديد"
              icon="add-outline"
              onPress={() => setEditor({ path: '', content: '', isNew: true })}
              tone="accent"
              style={{ marginStart: theme.spacing.sm }}
            />
          </View>

          {filtered.length === 0 ? (
            <EmptyState
              icon="folder-open-outline"
              title={files.length === 0 ? 'مساحة العمل فارغة' : 'لا نتائج مطابقة'}
              description={
                files.length === 0
                  ? 'استورد مستودع GitHub أو ارفع أرشيف ZIP للبدء، ثم صدّر الملفات المعدّلة كأرشيف.'
                  : 'جرّب تعديل البحث أو إلغاء تصفية «المعدّلة فقط».'
              }
            />
          ) : (
            <View style={{ marginTop: theme.spacing.md }}>
              {filtered.map((file: WorkspaceFile) => (
                <Pressable
                  key={file.id}
                  onPress={() =>
                    setEditor({ path: file.path, content: file.content, isNew: false })
                  }
                  style={({ pressed }) => [
                    styles.fileRow,
                    {
                      backgroundColor: theme.colors.surface,
                      borderColor: theme.colors.border,
                      borderRadius: theme.radius.lg,
                      padding: theme.spacing.md,
                      marginBottom: theme.spacing.sm,
                      opacity: pressed ? 0.8 : 1,
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.fileIcon,
                      { backgroundColor: theme.colors.surfaceMuted, borderRadius: theme.radius.md },
                    ]}
                  >
                    <Icon name={fileIcon(file)} size={18} tone="primary" />
                  </View>
                  <View style={styles.flex1}>
                    <Text variant="body" weight="medium" numberOfLines={1}>
                      {file.path}
                    </Text>
                    <View style={[styles.badges, { marginTop: 4 }]}>
                      <Badge label={sourceLabel(file.source)} tone={sourceTone(file.source)} />
                      {file.modified ? <Badge label="معدّل" tone="warning" /> : null}
                      <Text variant="caption" tone="subtle" style={{ marginStart: 6 }}>
                        {formatBytes(file.sizeBytes)}
                      </Text>
                    </View>
                  </View>
                  <Icon name="chevron-back" size={16} tone="subtle" />
                </Pressable>
              ))}
            </View>
          )}
        </View>

        {/* Export result */}
        {lastExport ? (
          <Card accent={theme.colors.success} style={{ marginTop: theme.spacing['2xl'] }}>
            <SectionHeader title="الأرشيف الجاهز" icon="checkmark-circle-outline" />
            <Text variant="body" weight="semibold">
              {lastExport.filename}
            </Text>
            <Text variant="caption" tone="muted" style={{ marginTop: 2 }}>
              {formatNumber(lastExport.fileCount)} ملف · {formatBytes(lastExport.sizeBytes)}
            </Text>
            <Button
              label="تنزيل الأرشيف"
              icon="download-outline"
              variant="success"
              fullWidth
              onPress={() =>
                triggerDownload(
                  lastExport.url ?? lastExport.dataUrl,
                  lastExport.filename,
                )
              }
              style={{ marginTop: theme.spacing.md }}
            />
          </Card>
        ) : null}
      </ScrollView>

      {/* Toast */}
      {toast ? (
        <View
          pointerEvents="none"
          style={[
            styles.toast,
            {
              backgroundColor: theme.colors.surfaceElevated,
              borderColor: theme.colors.border,
              borderRadius: theme.radius.pill,
            },
          ]}
        >
          <Text variant="label" weight="semibold">
            {toast}
          </Text>
        </View>
      ) : null}

      {/* Editor overlay */}
      {editor ? (
        <View style={[styles.overlay, { backgroundColor: theme.colors.overlay }]}>
          <View
            style={[
              styles.sheet,
              {
                backgroundColor: theme.colors.surfaceElevated,
                borderColor: theme.colors.border,
                borderRadius: theme.radius['2xl'],
                padding: theme.spacing.lg,
              },
            ]}
          >
            <View style={styles.inline}>
              <Icon name={editor.isNew ? 'add-outline' : 'document-text-outline'} size={20} tone="primary" />
              <Text variant="subtitle" weight="bold" style={{ marginStart: 8, flex: 1 }}>
                {editor.isNew ? 'ملف جديد' : 'تحرير الملف'}
              </Text>
              <Pressable onPress={() => setEditor(null)}>
                <Icon name="close-outline" size={22} tone="muted" />
              </Pressable>
            </View>

            <Input
              label="المسار"
              placeholder="src/index.ts"
              value={editor.path}
              editable={editor.isNew}
              onChangeText={(path) => setEditor({ ...editor, path })}
              icon="folder-outline"
              autoCapitalize="none"
              autoCorrect={false}
              containerStyle={{ marginTop: theme.spacing.md }}
            />

            <Text variant="label" tone="muted" style={{ marginTop: theme.spacing.md, marginBottom: 6 }}>
              المحتوى
            </Text>
            <TextInput
              value={editor.content}
              onChangeText={(content) => setEditor({ ...editor, content })}
              multiline
              editable={!editor.isNew || true}
              placeholder="اكتب محتوى الملف هنا..."
              placeholderTextColor={theme.colors.textSubtle}
              style={[
                styles.codeArea,
                {
                  backgroundColor: theme.colors.background,
                  borderColor: theme.colors.border,
                  borderRadius: theme.radius.lg,
                  color: theme.colors.text,
                },
              ]}
            />

            {!editor.isNew && editor.content.length === 0 ? (
              <Text variant="caption" tone="subtle" style={{ marginTop: 6 }}>
                ملف ثنائي أو فارغ — التحرير النصي قد لا ينطبق.
              </Text>
            ) : null}

            <View style={[styles.inline, { marginTop: theme.spacing.lg }]}>
              <Button
                label="حفظ"
                icon="save-outline"
                onPress={onSaveEditor}
                style={styles.flex1}
              />
              {!editor.isNew ? (
                <Button
                  label="حذف"
                  icon="trash-outline"
                  variant="danger"
                  onPress={() => onDelete(editor.path)}
                  style={{ marginStart: theme.spacing.sm }}
                />
              ) : null}
            </View>
          </View>
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  statRow: { flexDirection: 'row', gap: 12 },
  inline: { flexDirection: 'row', alignItems: 'center' },
  flex1: { flex: 1 },
  fileRow: { flexDirection: 'row', alignItems: 'center', borderWidth: StyleSheet.hairlineWidth },
  fileIcon: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', marginEnd: 12 },
  badges: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  toast: {
    position: 'absolute',
    bottom: 28,
    alignSelf: 'center',
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderWidth: StyleSheet.hairlineWidth,
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    padding: 16,
  },
  sheet: { borderWidth: StyleSheet.hairlineWidth, maxHeight: '90%' },
  codeArea: {
    minHeight: 180,
    maxHeight: 340,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    fontSize: 13,
    textAlignVertical: 'top',
    fontFamily: 'monospace',
    textAlign: 'left',
  },
});
