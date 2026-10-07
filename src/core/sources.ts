import * as fs from 'node:fs';
import * as path from 'node:path';

const SKIP_DIRS = new Set(['.git', '.42check', 'node_modules', '.vscode', '.cache', 'out', 'dist']);

export interface SourceScan {
  sources: string[];
  headers: string[];
}

/** targetRoot 以下の .c / .h を再帰的に集める (隠しディレクトリと .42check は除外)。 */
export function scanSources(targetRoot: string): SourceScan {
  const sources: string[] = [];
  const headers: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        walk(full);
      } else if (e.isFile()) {
        if (e.name.endsWith('.c')) sources.push(full);
        else if (e.name.endsWith('.h')) headers.push(full);
      }
    }
  };
  walk(targetRoot);
  return { sources, headers };
}

/** コメントと文字列リテラルを空白に置き換える (main の検出を誤らせないため)。 */
export function stripCommentsAndStrings(src: string): string {
  return src.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g,
    (m) => m.replace(/[^\n]/g, ' '),
  );
}

const MAIN_RE = /(^|[^\w])(int|void)\s+main\s*\(/;

export function definesMain(file: string): boolean {
  try {
    return MAIN_RE.test(stripCommentsAndStrings(fs.readFileSync(file, 'utf8')));
  } catch {
    return false;
  }
}

/**
 * include path を決める。設定値 + targetRoot + .h を含む全ディレクトリ。
 * 42 の課題は includes/ や inc/ や .c と同じ場所など、配置がまちまちなため。
 */
export function collectIncludeDirs(
  root: string,
  targetRoot: string,
  headers: string[],
  configured: string[],
): string[] {
  const set = new Set<string>();
  for (const p of configured) set.add(path.resolve(root, p));
  set.add(targetRoot);
  for (const h of headers) set.add(path.dirname(h));
  return [...set].slice(0, 64);
}

export function makeTargetExists(makefile: string, target: string): boolean {
  try {
    const re = new RegExp(`^${target}\\s*:(?!=)`, 'm');
    return re.test(fs.readFileSync(makefile, 'utf8'));
  } catch {
    return false;
  }
}

export function findMakefile(dir: string): string | undefined {
  for (const n of ['Makefile', 'makefile', 'GNUmakefile']) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}
