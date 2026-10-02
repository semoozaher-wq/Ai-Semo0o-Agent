/**
 * Workspace tool implementations.
 *
 * Registers the GitHub / ZIP / workspace tools with the agent tool runtime so
 * the LLM can drive them directly via tool calling. Importing this module wires
 * everything up (side-effect on import).
 */

import { registerTool } from '../agent-engine/tools';
import { workspaceService, importGitHub, importZipBytes } from './runtime';
import { fetchFileContent, fetchRepoTree, parseGitHubUrl, resolveRef } from './github';
import { base64ToBytes } from '../../utils/base64';

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`الحقل «${key}» مطلوب`);
  }
  return value.trim();
}

/** Resolve a ZIP source (workspace path or data URL) to raw bytes. */
function resolveZipBytes(source: string): Uint8Array {
  if (source.startsWith('data:')) {
    const comma = source.indexOf(',');
    const meta = source.slice(0, comma);
    const payload = source.slice(comma + 1);
    if (/;base64/i.test(meta)) return base64ToBytes(payload);
    return new TextEncoder().encode(decodeURIComponent(payload));
  }
  const file = workspaceService.read(source);
  if (!file) throw new Error(`لم يتم العثور على الأرشيف: ${source}`);
  return file.encoding === 'base64'
    ? base64ToBytes(file.content)
    : new TextEncoder().encode(file.content);
}

export function registerWorkspaceTools(): void {
  /* ------------------------------- GitHub -------------------------------- */

  registerTool('github.import', async (args) => {
    const url = requireString(args, 'url');
    const result = await importGitHub(url, {
      ref: typeof args.ref === 'string' ? args.ref : undefined,
      pathPrefix: typeof args.path === 'string' ? args.path : undefined,
      maxFiles: typeof args.maxFiles === 'number' ? args.maxFiles : undefined,
    });
    return {
      output: result,
      logs: [
        `تم استيراد ${result.fileCount} ملفًا من ${result.repo}@${result.ref}` +
          (result.skipped > 0 ? ` (تم تخطّي ${result.skipped})` : ''),
      ],
    };
  });

  registerTool('github.inspect', async (args) => {
    const url = requireString(args, 'url');
    const ref = parseGitHubUrl(url);
    if (!ref) throw new Error(`رابط GitHub غير صالح: ${url}`);

    const path = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : undefined;
    if (path) {
      const file = await fetchFileContent(ref, path);
      const preview = file.content.length > 4000 ? `${file.content.slice(0, 4000)}…` : file.content;
      return {
        output: { repo: `${ref.owner}/${ref.repo}`, path, encoding: file.encoding, sizeBytes: file.sizeBytes, content: preview },
        logs: [`تمت قراءة ${path} (${file.sizeBytes} بايت)`],
      };
    }

    const resolved = await resolveRef(ref);
    const tree = await fetchRepoTree({ ...ref, ref: resolved });
    const blobs = tree.filter((t) => t.type === 'blob');
    return {
      output: {
        repo: `${ref.owner}/${ref.repo}`,
        ref: resolved,
        fileCount: blobs.length,
        tree: blobs.slice(0, 200).map((t) => ({ path: t.path, size: t.size })),
      },
      logs: [`شجرة ${ref.owner}/${ref.repo}@${resolved}: ${blobs.length} ملف`],
    };
  });

  /* --------------------------------- ZIP --------------------------------- */

  registerTool('zip.import', async (args) => {
    const source = requireString(args, 'source');
    const bytes = resolveZipBytes(source);
    const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : source.split('/').pop() || 'archive.zip';
    const result = await importZipBytes(bytes, name);
    return {
      output: result,
      logs: [`تم فك ضغط ${name}: ${result.fileCount} ملف من ${result.entries} عنصر`],
    };
  });

  registerTool('zip.export', async (args) => {
    const paths = Array.isArray(args.paths) ? (args.paths as unknown[]).map(String) : undefined;
    const name = typeof args.name === 'string' ? args.name : undefined;
    const bytes = await workspaceService.exportZip(paths);
    const fileCount = workspaceService.toZipInputs(paths).length;
    const filename = (name ?? `${workspaceService.current.name || 'workspace'}.zip`).replace(/[^\w.-]+/g, '-');
    return {
      output: {
        filename: filename.endsWith('.zip') ? filename : `${filename}.zip`,
        sizeBytes: bytes.length,
        fileCount,
        ready: true,
      },
      logs: [`تم تجهيز أرشيف ${filename} (${fileCount} ملف، ${bytes.length} بايت)`],
    };
  });

  /* ------------------------------ Workspace ------------------------------ */

  registerTool('workspace.list', async (args) => {
    const prefix = typeof args.prefix === 'string' ? args.prefix : undefined;
    const files = workspaceService.list(prefix);
    return {
      output: {
        count: files.length,
        files: files.slice(0, 300).map((f) => ({ path: f.path, sizeBytes: f.sizeBytes, modified: f.modified })),
      },
      logs: [`مساحة العمل تحتوي على ${files.length} ملف`],
    };
  });

  registerTool('workspace.read', async (args) => {
    const path = requireString(args, 'path');
    const file = workspaceService.read(path);
    if (!file) throw new Error(`لم يتم العثور على الملف: ${path}`);
    const preview =
      file.encoding === 'base64'
        ? `[binary ${file.sizeBytes} bytes]`
        : file.content.length > 6000
          ? `${file.content.slice(0, 6000)}…`
          : file.content;
    return {
      output: { path: file.path, encoding: file.encoding, sizeBytes: file.sizeBytes, content: preview },
    };
  });

  registerTool('workspace.write', async (args) => {
    const path = requireString(args, 'path');
    const content = typeof args.content === 'string' ? args.content : String(args.content ?? '');
    const file = workspaceService.write(path, content);
    return {
      output: { path: file.path, sizeBytes: file.sizeBytes, modified: file.modified },
      logs: [`تمت كتابة ${file.path} (${file.sizeBytes} بايت)`],
    };
  });

  registerTool('workspace.delete', async (args) => {
    const path = requireString(args, 'path');
    const deleted = workspaceService.delete(path);
    return {
      output: { path, deleted },
      logs: [deleted ? `تم حذف ${path}` : `الملف غير موجود: ${path}`],
    };
  });
}

// Wire the tools up as soon as this module is imported.
registerWorkspaceTools();
