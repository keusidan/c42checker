import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Diag, Severity } from './types';

export type PathMap = (p: string) => string;

const identity: PathMap = (p) => p;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
export const stripAnsi = (s: string): string => s.replace(ANSI_RE, '');

function resolveFile(file: string, baseDir: string, map: PathMap): string {
  const abs = path.isAbsolute(file) ? file : path.resolve(baseDir, file);
  return map(path.normalize(abs));
}

/** 同じ (file, line, col, message) の重複を除く (clang-tidy はヘッダ由来で重複しやすい)。 */
export function dedupe(diags: Diag[]): Diag[] {
  const seen = new Set<string>();
  const out: Diag[] = [];
  for (const d of diags) {
    const k = `${d.file}:${d.line}:${d.col}:${d.severity}:${d.message}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(d);
  }
  return out;
}

const COMPILER_RE = /^(.+?):(\d+):(\d+): (fatal error|error|warning): (.*)$/;
const RUNTIME_RE = /^(.+?):(\d+):(\d+): runtime error: (.*)$/;

/** gcc / clang / clang-tidy / scan-build / UBSan 形式 (file:line:col: severity: message) */
export function parseCompilerOutput(
  text: string,
  baseDir: string,
  source: string,
  map: PathMap = identity,
): Diag[] {
  const diags: Diag[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    let m = COMPILER_RE.exec(line);
    if (m) {
      const sev: Severity = m[4] === 'warning' ? 'warning' : 'error';
      diags.push({
        file: resolveFile(m[1], baseDir, map),
        line: Number(m[2]),
        col: Number(m[3]),
        severity: sev,
        message: m[5],
        source,
      });
      continue;
    }
    m = RUNTIME_RE.exec(line);
    if (m) {
      diags.push({
        file: resolveFile(m[1], baseDir, map),
        line: Number(m[2]),
        col: Number(m[3]),
        severity: 'error',
        message: `runtime error: ${m[4]}`,
        source,
      });
    }
  }
  return dedupe(diags);
}

/**
 * norminette:
 *   file.c: Error!
 *   Error: SPACE_BEFORE_FUNC  (line:   5, col:   4):\tMissing space ...
 */
export function parseNorminette(text: string, baseDir: string): Diag[] {
  const diags: Diag[] = [];
  let current = '';
  // norminette は pipe 先でも ANSI カラーコードを出力する
  for (const raw of stripAnsi(text).split('\n')) {
    const line = raw.replace(/\r$/, '');
    const head = /^(.+?): (OK!|Error!)$/.exec(line);
    if (head) {
      current = head[1];
      continue;
    }
    const m = /^(Error|Notice): (\w+)\s+\(line:\s*(\d+), col:\s*(\d+)\):\s*(.*)$/.exec(line);
    if (m && current) {
      diags.push({
        file: resolveFile(current, baseDir, identity),
        line: Number(m[3]),
        col: Number(m[4]),
        severity: 'error',
        message: `${m[2]}: ${m[5]}`,
        source: 'norminette',
      });
    }
  }
  return diags;
}

function isInside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * フレームのファイル名を root 内の実ファイルに解決する。
 * 相対パスは libc 由来の `open64.c` などを root 内と誤認しないよう、実在する場合だけ採用する。
 */
function inRootFile(root: string, name: string): string | undefined {
  if (path.isAbsolute(name)) {
    const f = path.normalize(name);
    return isInside(root, f) ? f : undefined;
  }
  const f = path.resolve(root, name);
  return isInside(root, f) && existsFile(f) ? f : undefined;
}

/** `#1 0x... in fn /abs/file.c:12:5` から、root 内の最初のフレームを探す。 */
function firstFrameInRoot(
  lines: string[],
  from: number,
  root: string,
  frameRe: RegExp,
  window = 40,
): { file: string; line: number; col: number } | undefined {
  for (let i = from; i < Math.min(lines.length, from + window); i++) {
    const m = frameRe.exec(lines[i]);
    if (!m) continue;
    const file = inRootFile(root, m[1]);
    if (file) return { file, line: Number(m[2]), col: Number(m[3] ?? 1) };
  }
  return undefined;
}

// ASan/MSan: `#0 0x.. in fn file:12:5`  TSan: `#0 fn file:12:5 (prog+0x..) (BuildId: ..)`
const ASAN_FRAME = /^\s*#\d+ (?:0x[0-9a-f]+ in )?\S+ (.+?):(\d+)(?::(\d+))?(?:\s+\(.*)?\s*$/;

/** ASan / LSan / TSan / MSan / UBSan の報告を Diag にする (最初に現れる root 内のフレームの位置に付ける)。 */
export function parseSanitizer(text: string, root: string): Diag[] {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const diags: Diag[] = [];
  const headers: { re: RegExp; label: (m: RegExpExecArray) => string }[] = [
    { re: /ERROR: AddressSanitizer: (.*)$/, label: (m) => `AddressSanitizer: ${m[1]}` },
    { re: /^((?:Direct|Indirect) leak of .*)$/, label: (m) => `LeakSanitizer: ${m[1]}` },
    { re: /WARNING: ThreadSanitizer: (.*?)(?: \(pid=\d+\))?$/, label: (m) => `ThreadSanitizer: ${m[1]}` },
    { re: /WARNING: MemorySanitizer: (.*)$/, label: (m) => `MemorySanitizer: ${m[1]}` },
  ];
  lines.forEach((line, i) => {
    for (const h of headers) {
      const m = h.re.exec(line);
      if (!m) continue;
      const frame = firstFrameInRoot(lines, i + 1, root, ASAN_FRAME);
      if (frame) {
        diags.push({ ...frame, severity: 'error', message: h.label(m), source: 'sanitizer' });
      }
    }
  });
  diags.push(...parseCompilerOutput(text, root, 'ubsan').filter((d) => d.message.startsWith('runtime error')));
  return dedupe(diags);
}

export interface ValgrindParse {
  diags: Diag[];
  /** 継承されていない (= プログラムが開いた) fd が閉じられていない件数 */
  fdLeaks: number;
}

const VG_FRAME = /\((?:in [^)]*\)|(.+?):(\d+)\))/;

export function parseValgrind(text: string, root: string): ValgrindParse {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/\r$/, '').replace(/^==\d+== ?/, ''));
  const diags: Diag[] = [];
  let fdLeaks = 0;
  const atRe = /^\s+(at|by) 0x[0-9A-F]+:/i;
  lines.forEach((line, i) => {
    if (!line || /^\s/.test(line)) return;
    if (!atRe.test(lines[i + 1] ?? '')) return;
    const isFd = /^Open file descriptor \d+/.test(line);
    if (isFd) fdLeaks++;
    for (let j = i + 1; j < Math.min(lines.length, i + 30); j++) {
      if (!atRe.test(lines[j])) break;
      const m = VG_FRAME.exec(lines[j]);
      if (!m || !m[1]) continue;
      const file = inRootFile(root, m[1]);
      if (file) {
        diags.push({
          file,
          line: Number(m[2]),
          col: 1,
          severity: 'error',
          message: `valgrind: ${line}`,
          source: 'valgrind',
        });
        break;
      }
    }
  });
  return { diags: dedupe(diags), fdLeaks };
}

/** CBMC の `[prop] file f.c line 12 msg: FAILURE` */
export function parseCbmc(text: string, baseDir: string): Diag[] {
  const diags: Diag[] = [];
  for (const line of text.split('\n')) {
    const m = /^\[(.+?)\] file (.+?) line (\d+) (.*): FAILURE\s*$/.exec(line.trim());
    if (m) {
      diags.push({
        file: resolveFile(m[2], baseDir, identity),
        line: Number(m[3]),
        col: 1,
        severity: 'error',
        message: `cbmc: ${m[4]} (${m[1]})`,
        source: 'cbmc',
      });
    }
  }
  return dedupe(diags);
}

/** Frama-C Eva の `[eva:alarm] file.c:12: Warning: ...` */
export function parseFramaC(text: string, baseDir: string): Diag[] {
  const diags: Diag[] = [];
  for (const line of text.split('\n')) {
    const m = /^\[eva:alarm\] (.+?):(\d+): Warning: (.*)$/.exec(line.trim());
    if (m) {
      diags.push({
        file: resolveFile(m[1], baseDir, identity),
        line: Number(m[2]),
        col: 1,
        severity: 'error',
        message: `eva: ${m[3]}`,
        source: 'frama-c',
      });
    }
  }
  return dedupe(diags);
}

export function existsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
