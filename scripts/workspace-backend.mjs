#!/usr/bin/env node
/**
 * workspace-backend.mjs — standalone Node.js backend utility for the
 * Ai-Semo0o-Agent GitHub / ZIP workflow.
 *
 * It uses only Node built-ins (`fetch`, `fs/promises`, `path`) plus `jszip`,
 * so it runs anywhere Node 18+ is available. Use it to:
 *
 *   • import a GitHub repository (any branch/sub-path) to disk,
 *   • zip a local directory,
 *   • unzip an archive.
 *
 * Usage:
 *   node scripts/workspace-backend.mjs import <github-url> [outDir] [--token=...] [--max=200]
 *   node scripts/workspace-backend.mjs zip    <dir>        <out.zip>
 *   node scripts/workspace-backend.mjs unzip  <zip>        [outDir]
 *
 * Examples:
 *   node scripts/workspace-backend.mjs import https://github.com/octocat/Hello-World ./repo
 *   node scripts/workspace-backend.mjs zip ./repo repo.zip
 *   node scripts/workspace-backend.mjs unzip repo.zip ./repo-out
 *
 * A GITHUB_TOKEN env var (or --token=) raises the API rate limit and unlocks
 * private repositories.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

const API = 'https://api.github.com';

/* -------------------------------------------------------------------------- */
/*  GitHub helpers                                                             */
/* -------------------------------------------------------------------------- */

function ghHeaders(token) {
  const h = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Ai-Semo0o-Agent',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** Parse any common GitHub reference into `{ owner, repo, ref }`. */
export function parseRepo(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('empty repository reference');

  const ssh = raw.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (ssh) return { owner: ssh[1], repo: ssh[2].replace(/\.git$/i, ''), ref: undefined };

  const rest = raw
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/^github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');

  const parts = rest.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error(`not a GitHub reference: ${input}`);

  const [owner, repo, kind, ...tail] = parts;
  const out = { owner, repo, ref: undefined, path: undefined };
  if ((kind === 'tree' || kind === 'blob') && tail.length > 0) {
    out.ref = tail[0];
    const sub = tail.slice(1).join('/');
    if (sub) out.path = sub;
  }
  return out;
}

async function fetchJson(url, token) {
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub ${res.status} ${res.statusText} for ${url}\n${body.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Download every (reasonably sized) blob of a repository to `outDir`.
 * Returns a summary object.
 */
export async function importRepo(input, outDir, options = {}) {
  const { token, maxFiles = 200, maxBytes = 1024 * 1024 } = options;
  const { owner, repo, ref, path: prefix } = parseRepo(input);

  const info = await fetchJson(`${API}/repos/${owner}/${repo}`, token);
  const branch = ref || info.default_branch || 'main';

  const tree = await fetchJson(
    `${API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    token,
  );

  const blobs = (tree.tree || []).filter(
    (e) =>
      e.type === 'blob' &&
      (!prefix || e.path === prefix || e.path.startsWith(`${prefix}/`)) &&
      (e.size === undefined || e.size <= maxBytes),
  );

  const selected = blobs.slice(0, maxFiles);
  let written = 0;

  for (const blob of selected) {
    const file = await fetchJson(
      `${API}/repos/${owner}/${repo}/contents/${blob.path}?ref=${encodeURIComponent(branch)}`,
      token,
    );
    const buffer =
      file.encoding === 'base64'
        ? Buffer.from(file.content.replace(/\n/g, ''), 'base64')
        : Buffer.from(file.content ?? '', 'utf8');

    const dest = path.join(outDir, blob.path);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, buffer);
    written += 1;
  }

  return { owner, repo, branch, total: blobs.length, written, skipped: blobs.length - written };
}

/* -------------------------------------------------------------------------- */
/*  ZIP helpers                                                                */
/* -------------------------------------------------------------------------- */

/** Recursively add a directory to a JSZip instance. */
async function addDir(zip, dir, rel = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await addDir(zip, abs, relPath);
    } else {
      zip.file(relPath, await readFile(abs));
    }
  }
}

/** Create `outZip` from a local directory. Returns the archive size in bytes. */
export async function zipDir(dir, outZip) {
  const zip = new JSZip();
  await addDir(zip, dir);
  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  await writeFile(outZip, buffer);
  return buffer.length;
}

/** Extract a ZIP archive to `outDir`. Returns the number of files written. */
export async function unzipFile(zipPath, outDir) {
  const zip = await JSZip.loadAsync(await readFile(zipPath));
  let count = 0;
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const dest = path.join(outDir, name);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, await entry.async('nodebuffer'));
    count += 1;
  }
  return count;
}

/* -------------------------------------------------------------------------- */
/*  CLI                                                                        */
/* -------------------------------------------------------------------------- */

function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (const arg of args) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) flags[m[1]] = m[2];
    else rest.push(arg);
  }
  return { flags, rest };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const { flags, rest } = parseFlags(args);
  const token = flags.token || process.env.GITHUB_TOKEN;

  if (command === 'import') {
    const [url, outDir = './repo'] = rest;
    if (!url) throw new Error('usage: import <github-url> [outDir]');
    const summary = await importRepo(url, outDir, {
      token,
      maxFiles: flags.max ? Number(flags.max) : undefined,
    });
    console.log(
      `Imported ${summary.written}/${summary.total} files from ${summary.owner}/${summary.repo}@${summary.branch} → ${outDir}`,
    );
    return;
  }

  if (command === 'zip') {
    const [dir, out] = rest;
    if (!dir || !out) throw new Error('usage: zip <dir> <out.zip>');
    const size = await zipDir(dir, out);
    console.log(`Created ${out} (${size} bytes)`);
    return;
  }

  if (command === 'unzip') {
    const [zipPath, outDir = './unzipped'] = rest;
    if (!zipPath) throw new Error('usage: unzip <zip> [outDir]');
    const count = await unzipFile(zipPath, outDir);
    console.log(`Extracted ${count} files → ${outDir}`);
    return;
  }

  console.log(
    'Ai-Semo0o-Agent workspace backend\n' +
      '  import <github-url> [outDir] [--token=...] [--max=200]\n' +
      '  zip    <dir> <out.zip>\n' +
      '  unzip  <zip> [outDir]',
  );
}

// Only run the CLI when invoked directly (not when imported for tests).
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('workspace-backend.mjs');
if (invokedDirectly) {
  main().catch((error) => {
    console.error('Error:', error.message);
    process.exit(1);
  });
}
