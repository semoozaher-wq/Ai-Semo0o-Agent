/**
 * ZIP service.
 *
 * Wraps JSZip so the app can:
 *   • decompress an uploaded archive and read every entry,
 *   • rebuild an archive from the (possibly modified) workspace files,
 *   • trigger a download on web / return a data URL elsewhere.
 *
 * Binary entries are carried as base64 so text and binary files round-trip
 * losslessly through the workspace.
 */

import JSZip from 'jszip';
import { base64ToBytes, bytesToBase64 } from '../../utils/base64';
import type { FileEncoding, ZipExtractResult } from '../../types/workspace';
import { isBinaryPath } from './github';

export interface ZipInputFile {
  path: string;
  content: string;
  encoding: FileEncoding;
}

export interface CreateZipOptions {
  /** Compression level 1–9 (default 6). Use 0 to store uncompressed. */
  level?: number;
}

/* -------------------------------------------------------------------------- */
/*  Extract                                                                    */
/* -------------------------------------------------------------------------- */

/** Decompress an archive and return both a manifest and decoded file contents. */
export async function extractZip(
  bytes: Uint8Array,
  options: { stripRootDir?: boolean } = {},
): Promise<ZipExtractResult> {
  const zip = await JSZip.loadAsync(bytes);
  const entries: ZipExtractResult['entries'] = [];
  const files: ZipExtractResult['files'] = [];

  const paths = Object.keys(zip.files).sort();
  const rootDir = options.stripRootDir ? detectRootDir(paths) : '';

  for (const rawPath of paths) {
    const entry = zip.files[rawPath];
    const path = stripPrefix(rawPath, rootDir);
    if (!path) continue;

    if (entry.dir) {
      entries.push({ path, sizeBytes: 0, isDirectory: true });
      continue;
    }

    const data = await entry.async('uint8array');
    const binary = isBinaryPath(path);
    entries.push({ path, sizeBytes: data.length, isDirectory: false });
    files.push({
      path,
      content: binary ? bytesToBase64(data) : decodeUtf8(data),
      encoding: binary ? 'base64' : 'utf-8',
      sizeBytes: data.length,
      isBinary: binary,
    });
  }

  return { entries, files };
}

/* -------------------------------------------------------------------------- */
/*  Create                                                                     */
/* -------------------------------------------------------------------------- */

/** Build a ZIP archive from a list of workspace files. */
export async function createZip(
  files: ZipInputFile[],
  options: CreateZipOptions = {},
): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const file of files) {
    if (file.encoding === 'base64') {
      zip.file(file.path, file.content, { base64: true });
    } else {
      zip.file(file.path, file.content);
    }
  }
  return zip.generateAsync({
    type: 'uint8array',
    compression: options.level === 0 ? 'STORE' : 'DEFLATE',
    compressionOptions: { level: options.level ?? 6 },
  });
}

/* -------------------------------------------------------------------------- */
/*  Download                                                                   */
/* -------------------------------------------------------------------------- */

export interface DownloadResult {
  filename: string;
  /** Present on web; a blob URL the caller can also use. */
  url?: string;
  /** Always present: a `data:` URL fallback for native/webview contexts. */
  dataUrl: string;
  sizeBytes: number;
}

function isWebRuntime(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function' &&
    typeof Blob !== 'undefined'
  );
}

/**
 * Trigger a browser download (web) and always return a data URL fallback.
 * On native the caller can hand the data URL to a share/save sheet.
 */
export function downloadBytes(
  bytes: Uint8Array,
  filename: string,
  mimeType = 'application/zip',
): DownloadResult {
  const dataUrl = bytesToDataUrl(bytes, mimeType);
  const result: DownloadResult = { filename, dataUrl, sizeBytes: bytes.length };

  if (isWebRuntime()) {
    try {
      const blob = new Blob([toArrayBuffer(bytes)], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      result.url = url;
    } catch {
      /* fall back to the data URL only */
    }
  }

  return result;
}

/** Build a `data:` URL from raw bytes. */
export function bytesToDataUrl(bytes: Uint8Array, mimeType = 'application/zip'): string {
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function decodeUtf8(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder('utf-8').decode(bytes);
  }
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

function detectRootDir(paths: string[]): string {
  const first = paths[0];
  if (!first) return '';
  const slash = first.indexOf('/');
  if (slash === -1) return '';
  const root = first.slice(0, slash + 1);
  return paths.every((p) => p.startsWith(root)) ? root : '';
}

function stripPrefix(path: string, prefix: string): string {
  if (!prefix) return path;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** Convenience: decode a base64 entry back to bytes. */
export function entryToBytes(file: ZipInputFile): Uint8Array {
  return file.encoding === 'base64' ? base64ToBytes(file.content) : new TextEncoder().encode(file.content);
}
