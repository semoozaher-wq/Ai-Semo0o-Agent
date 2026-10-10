import React from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useTheme } from '../../theme';
import { Text } from '../ui/Text';
import { Icon, IconName } from '../ui/Icon';
import { Chip } from '../ui/Chip';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ListRow } from './ListRow';
import { Attachment, AttachmentKind } from '../../types/chat';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { uid } from '../../utils/id';
import { formatBytes } from '../../utils/format';

export interface ComposerProps {
  /**
   * Called with the trimmed text, the collected attachments and the chosen
   * turn mode when the user sends. `mode: 'agent'` routes the turn to a real
   * agent run (planner → tools → verification) instead of a plain chat reply.
   */
  onSubmit: (text: string, attachments: Attachment[], mode: TurnMode) => void;
  placeholder?: string;
  /** While true the send button becomes a stop button. */
  busy?: boolean;
  onStop?: (() => void) | undefined;
  autoFocus?: boolean;
  /** Initial turn mode. Defaults to 'chat'. */
  initialMode?: TurnMode;
}

/** A turn is either a plain chat reply or a real agent run. */
export type TurnMode = 'chat' | 'agent';

const KIND_ICON: Record<AttachmentKind, IconName> = {
  image: 'image-outline',
  document: 'document-text-outline',
  audio: 'musical-notes-outline',
  code: 'code-slash-outline',
  other: 'link-outline',
};

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'aac'];
const CODE_EXT = ['ts', 'tsx', 'js', 'jsx', 'json', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'css', 'html', 'md', 'sh', 'yml', 'yaml'];
const DOC_EXT = ['pdf', 'doc', 'docx', 'txt', 'rtf', 'xls', 'xlsx', 'csv', 'ppt', 'pptx'];

function extensionOf(name: string): string {
  return name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
}

/** Best-effort classification of an attachment from its name + mime type. */
export function attachmentKind(name: string, mimeType = ''): AttachmentKind {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  const ext = extensionOf(name);
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  if (CODE_EXT.includes(ext)) return 'code';
  if (DOC_EXT.includes(ext)) return 'document';
  return 'other';
}

function mimeFromName(name: string): string {
  const ext = extensionOf(name);
  const map: Record<string, string> = {
    ts: 'text/typescript', tsx: 'text/tsx', js: 'text/javascript', jsx: 'text/jsx',
    json: 'application/json', md: 'text/markdown', css: 'text/css', html: 'text/html',
    py: 'text/x-python', txt: 'text/plain', csv: 'text/csv', pdf: 'application/pdf',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    svg: 'image/svg+xml', webp: 'image/webp', zip: 'application/zip',
  };
  return map[ext] ?? 'application/octet-stream';
}

/** Largest device file we will read into memory and upload as base64. Mirrors
 *  the backend's MAX_ATTACHMENT_BYTES so the client fails fast with a clear
 *  message instead of letting the server reject an oversized payload. */
export const MAX_INLINE_UPLOAD_BYTES = 8 * 1024 * 1024;

export interface PickedFile {
  name: string;
  sizeBytes: number;
  mimeType: string;
  /** Base64 of the file's real bytes (no data-URL prefix), present only when the
   *  file was small enough to read. */
  dataBase64?: string;
  /** True when the file exceeded MAX_INLINE_UPLOAD_BYTES and was NOT read. */
  tooLarge?: boolean;
}

/** Read a browser File into a bare base64 string (strips the data-URL prefix). */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('READ_FAILED'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Open the platform file picker and capture the chosen file's real bytes.
 * Web only — returns `null` on native/unsupported so the caller can surface an
 * honest notice instead of pretending a file was attached. Files larger than
 * MAX_INLINE_UPLOAD_BYTES are reported (tooLarge) without being read.
 */
function pickDeviceFile(): Promise<PickedFile | null> {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.style.display = 'none';
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) {
        resolve(null);
        return;
      }
      const mimeType = file.type || mimeFromName(file.name);
      const base = { name: file.name, sizeBytes: file.size, mimeType };
      if (file.size > MAX_INLINE_UPLOAD_BYTES) {
        resolve({ ...base, tooLarge: true });
        return;
      }
      readFileAsBase64(file)
        .then((dataBase64) => resolve({ ...base, dataBase64 }))
        .catch(() => resolve(base));
    };
    document.body.appendChild(input);
    input.click();
    setTimeout(() => {
      if (input.parentNode) input.parentNode.removeChild(input);
    }, 1500);
  });
}

type SheetMode = 'closed' | 'menu' | 'workspace' | 'url';

/**
 * The main-screen composer: a large input with a real `+` attachment menu
 * (device file / workspace file / URL) and chips for everything queued before
 * sending. Reuses the app's existing stores, components and `Attachment` model.
 */
export function Composer({
  onSubmit,
  placeholder = 'اكتب فكرتك أو مهمتك…',
  busy = false,
  onStop,
  autoFocus = false,
  initialMode = 'chat',
}: ComposerProps) {
  const theme = useTheme();
  const workspaceFiles = useWorkspaceStore((s) => s.workspace.files);

  const [text, setText] = React.useState('');
  const [attachments, setAttachments] = React.useState<Attachment[]>([]);
  const [sheet, setSheet] = React.useState<SheetMode>('closed');
  const [urlInput, setUrlInput] = React.useState('');
  const [urlError, setUrlError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [mode, setMode] = React.useState<TurnMode>(initialMode);

  const addAttachment = React.useCallback((attachment: Attachment) => {
    setAttachments((prev) => [...prev, attachment]);
  }, []);

  const removeAttachment = React.useCallback((id: string) => {
    setAttachments((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const closeSheet = React.useCallback(() => {
    setSheet('closed');
    setUrlInput('');
    setUrlError('');
  }, []);

  const onPickDevice = React.useCallback(async () => {
    const picked = await pickDeviceFile();
    closeSheet();
    if (!picked) {
      setNotice('اختيار الملفات من الجهاز غير متاح على هذه المنصة.');
      return;
    }
    addAttachment({
      id: uid('att'),
      name: picked.name,
      mimeType: picked.mimeType,
      sizeBytes: picked.sizeBytes,
      kind: attachmentKind(picked.name, picked.mimeType),
      ...(picked.dataBase64 ? { dataBase64: picked.dataBase64 } : {}),
    });
    setNotice(
      picked.tooLarge
        ? `الملف أكبر من ${formatBytes(MAX_INLINE_UPLOAD_BYTES)}؛ أُرفق بالاسم فقط ولم يُقرأ محتواه.`
        : '',
    );
  }, [addAttachment, closeSheet]);

  const onPickWorkspace = React.useCallback(
    (path: string, sizeBytes: number, name: string) => {
      addAttachment({
        id: uid('att'),
        name: path,
        mimeType: mimeFromName(name),
        sizeBytes,
        uri: `workspace://${path}`,
        kind: attachmentKind(name),
      });
      closeSheet();
      setNotice('');
    },
    [addAttachment, closeSheet],
  );

  const onAddUrl = React.useCallback(() => {
    const raw = urlInput.trim();
    let parsed: URL | null = null;
    try {
      parsed = new URL(raw);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      setUrlError('أدخل رابطًا صحيحًا يبدأ بـ http:// أو https://');
      return;
    }
    addAttachment({
      id: uid('att'),
      name: raw,
      mimeType: 'text/uri-list',
      sizeBytes: 0,
      uri: parsed.toString(),
      kind: 'other',
    });
    closeSheet();
    setNotice('');
  }, [addAttachment, closeSheet, urlInput]);

  const canSend = Boolean(text.trim()) || attachments.length > 0;

  const handleSend = () => {
    if (!canSend || busy) return;
    onSubmit(text.trim(), attachments, mode);
    setText('');
    setAttachments([]);
    setNotice('');
  };

  return (
    <View>
      {attachments.length > 0 ? (
        <View style={styles.chips}>
          {attachments.map((attachment) => (
            <View key={attachment.id} style={styles.chipWrap}>
              <Chip
                label={attachment.name.length > 30 ? `${attachment.name.slice(0, 29)}…` : attachment.name}
                icon={KIND_ICON[attachment.kind]}
                tone="primary"
                size="sm"
              />
              <Pressable
                onPress={() => removeAttachment(attachment.id)}
                style={styles.chipRemove}
                accessibilityRole="button"
                accessibilityLabel="إزالة المرفق"
              >
                <Icon name="close-circle" size={16} tone="muted" />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}

      <View
        style={[
          styles.inputWrap,
          {
            backgroundColor: theme.colors.surfaceMuted,
            borderColor: theme.colors.border,
            borderRadius: theme.radius.xl,
          },
        ]}
      >
        <Pressable
          onPress={() => setSheet('menu')}
          style={styles.iconBtn}
          accessibilityRole="button"
          accessibilityLabel="إضافة مرفق"
        >
          <Icon name="add-outline" size={24} tone="muted" />
        </Pressable>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.textSubtle}
          multiline
          autoFocus={autoFocus}
          style={[styles.input, { color: theme.colors.text }]}
        />
        <Pressable
          onPress={() => setMode((prev) => (prev === 'agent' ? 'chat' : 'agent'))}
          disabled={busy}
          style={[
            styles.modeBtn,
            {
              backgroundColor: mode === 'agent' ? theme.colors.accent : theme.colors.surface,
              borderColor: mode === 'agent' ? theme.colors.accent : theme.colors.border,
              borderRadius: theme.radius.pill,
            },
          ]}
          accessibilityRole="button"
          accessibilityState={{ selected: mode === 'agent' }}
          accessibilityLabel={mode === 'agent' ? 'وضع الوكيل مُفعّل' : 'تفعيل وضع الوكيل'}
        >
          <Icon name="sparkles-outline" size={14} color={mode === 'agent' ? '#FFFFFF' : theme.colors.textSubtle} />
          <Text
            variant="caption"
            weight="bold"
            style={{ color: mode === 'agent' ? '#FFFFFF' : theme.colors.textSubtle, marginLeft: 4 }}
          >
            وكيل
          </Text>
        </Pressable>
        <Pressable
          onPress={busy ? onStop : handleSend}
          disabled={!busy && !canSend}
          style={[
            styles.sendBtn,
            {
              backgroundColor: busy
                ? theme.colors.danger
                : canSend
                  ? theme.colors.primary
                  : theme.colors.surfaceMuted,
              borderRadius: theme.radius.pill,
            },
          ]}
          accessibilityRole="button"
          accessibilityLabel={busy ? 'إيقاف' : 'إرسال'}
        >
          <Icon
            name={busy ? 'stop' : 'arrow-up'}
            size={18}
            color={busy || canSend ? '#FFFFFF' : theme.colors.textSubtle}
          />
        </Pressable>
      </View>

      {notice ? (
        <Text variant="caption" tone="subtle" style={{ marginTop: 6 }}>
          {notice}
        </Text>
      ) : null}

      <Modal visible={sheet !== 'closed'} transparent animationType="slide" onRequestClose={closeSheet}>
        <Pressable style={styles.backdrop} onPress={closeSheet}>
          <Pressable
            style={[
              styles.sheet,
              { backgroundColor: theme.colors.backgroundElevated, borderColor: theme.colors.border },
            ]}
            onPress={(event) => event.stopPropagation()}
          >
            <View style={styles.sheetHandle} />

            {sheet === 'menu' ? (
              <>
                <Text variant="subtitle" weight="bold" style={{ marginBottom: theme.spacing.md }}>
                  إضافة مرفق
                </Text>
                <ListRow
                  title="ملف من الجهاز"
                  subtitle="اختر ملفًا من جهازك"
                  icon="cloud-upload-outline"
                  onPress={() => void onPickDevice()}
                  showChevron
                />
                <ListRow
                  title="ملف من مساحة العمل"
                  subtitle={`${workspaceFiles.length} ملف متاح`}
                  icon="folder-open-outline"
                  onPress={() => setSheet('workspace')}
                  showChevron
                />
                <ListRow
                  title="رابط / موقع"
                  subtitle="أضف رابطًا خارجيًا"
                  icon="link-outline"
                  onPress={() => setSheet('url')}
                  showChevron
                />
              </>
            ) : null}

            {sheet === 'workspace' ? (
              <>
                <View style={styles.sheetHeader}>
                  <Text variant="subtitle" weight="bold">
                    ملفات مساحة العمل
                  </Text>
                  <Pressable onPress={() => setSheet('menu')} accessibilityRole="button" accessibilityLabel="رجوع">
                    <Icon name="chevron-back" size={20} tone="muted" />
                  </Pressable>
                </View>
                {workspaceFiles.length === 0 ? (
                  <Text variant="caption" tone="muted" style={{ marginTop: theme.spacing.md }}>
                    مساحة العمل فارغة. استورد مستودعًا أو أرشيفًا من شاشة مساحة العمل أولًا.
                  </Text>
                ) : (
                  <ScrollView style={{ maxHeight: 380 }} showsVerticalScrollIndicator={false}>
                    {workspaceFiles.map((file) => (
                      <ListRow
                        key={file.id}
                        title={file.path}
                        subtitle={formatBytes(file.sizeBytes)}
                        icon="document-text-outline"
                        onPress={() => onPickWorkspace(file.path, file.sizeBytes, file.name)}
                        showChevron
                      />
                    ))}
                  </ScrollView>
                )}
              </>
            ) : null}

            {sheet === 'url' ? (
              <>
                <View style={styles.sheetHeader}>
                  <Text variant="subtitle" weight="bold">
                    إضافة رابط
                  </Text>
                  <Pressable onPress={() => setSheet('menu')} accessibilityRole="button" accessibilityLabel="رجوع">
                    <Icon name="chevron-back" size={20} tone="muted" />
                  </Pressable>
                </View>
                <Input
                  label="الرابط"
                  placeholder="https://example.com"
                  value={urlInput}
                  onChangeText={(value) => {
                    setUrlInput(value);
                    setUrlError('');
                  }}
                  icon="link-outline"
                  autoCapitalize="none"
                  autoCorrect={false}
                  {...(urlError ? { error: urlError } : {})}
                  containerStyle={{ marginTop: theme.spacing.md }}
                />
                <Button
                  label="إضافة الرابط"
                  icon="add"
                  fullWidth
                  onPress={onAddUrl}
                  style={{ marginTop: theme.spacing.md }}
                />
              </>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  chipWrap: { flexDirection: 'row', alignItems: 'center' },
  chipRemove: { marginStart: -6, marginEnd: 2, padding: 2 },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderWidth: 1,
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  modeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 34,
    paddingHorizontal: 10,
    borderWidth: 1,
    marginBottom: 3,
  },
  input: {
    flex: 1,
    fontSize: 15,
    minHeight: 40,
    maxHeight: 160,
    paddingVertical: 10,
    paddingHorizontal: 8,
    textAlign: 'right',
  },
  sendBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  backdrop: { flex: 1, backgroundColor: 'rgba(4,5,12,0.55)', justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sheetHandle: {
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(128,128,128,0.4)',
    alignSelf: 'center',
    marginBottom: 16,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
});
