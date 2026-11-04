import fs from 'node:fs';
import path from 'node:path';

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.text', '.org']);
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;
const SUMMARY_VERSION = 'v5';

/** Recursively collect readable note files under the given directories. */
export function collectReferenceFiles(dirs, options = {}) {
  const limit = options.limit ?? 50;
  const walkCap = options.walkCap ?? 60;
  const files = [];
  const errors = [];
  for (const dir of dirs || []) {
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch {
      errors.push(`路径不存在或不可读: ${dir}`);
      continue;
    }
    if (stat.isFile()) {
      if (TEXT_EXT.has(path.extname(dir).toLowerCase())) files.push(dir);
      else errors.push(`不支持的文件类型: ${dir}`);
      continue;
    }
    walk(dir, files, walkCap);
  }
  return { files: files.slice(0, limit), errors, truncated: files.length > limit };
}

function walk(dir, out, cap) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= cap) return;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out, cap);
    else if (entry.isFile() && TEXT_EXT.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
}

/** 简历/项目类文件优先排序，其余按普通笔记处理。 */
export function rankReferenceFiles(files) {
  return files.slice().sort((a, b) => scoreFile(b) - scoreFile(a));
}

function scoreFile(file) {
  // 只按文件名打分：路径里可能出现 project 等词（如 PersonalProject），会误伤全部文件
  const name = path.basename(file).toLowerCase();
  let score = 0;
  if (/简历|resume|项目|project|经历|experience/.test(name)) score += 10;
  if (name.endsWith('.md')) score += 1;
  return score;
}

/** Read files into one bounded text blob for the summarizer. */
export function readReferenceContent(files) {
  let total = 0;
  const parts = [];
  for (const file of files) {
    if (total >= MAX_TOTAL_BYTES) break;
    try {
      const buf = fs.readFileSync(file);
      const text = buf.subarray(0, MAX_FILE_BYTES).toString('utf8');
      total += buf.length;
      parts.push(`===== 文件: ${path.basename(file)} =====\n${text}`);
    } catch { /* skip unreadable */ }
  }
  return parts.join('\n\n');
}

/** Cache key for a directory set so re-selecting the same folder is cheap.
 *  SUMMARY_VERSION bumps whenever the summarization prompt changes. */
export function referenceCacheKey(dirs) {
  const parts = [SUMMARY_VERSION];
  for (const dir of dirs || []) {
    try {
      const stat = fs.statSync(dir);
      parts.push(`${dir}:${Math.floor(stat.mtimeMs)}`);
    } catch {
      parts.push(`${dir}:missing`);
    }
  }
  let hash = 0;
  const text = parts.join('|');
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}
