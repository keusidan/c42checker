import * as fs from 'node:fs';
import * as path from 'node:path';

export const WORK_DIR_NAME = '.42check';

/** .42check/ を丸ごと消して作り直す。実行のたびに古い成果物を残さないため。 */
export function resetWorkDir(workDir: string, keep: string[] = []): void {
  if (path.basename(workDir) !== WORK_DIR_NAME) {
    throw new Error(`安全のため ${WORK_DIR_NAME} 以外は削除しません: ${workDir}`);
  }
  if (keep.length === 0) {
    fs.rmSync(workDir, { recursive: true, force: true });
  } else {
    for (const e of fs.existsSync(workDir) ? fs.readdirSync(workDir) : []) {
      if (!keep.includes(e)) fs.rmSync(path.join(workDir, e), { recursive: true, force: true });
    }
  }
  fs.mkdirSync(workDir, { recursive: true });
}

/** ディレクトリ配下の合計サイズ (bytes)。symlink は辿らない。 */
export function dirSize(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) total += fs.lstatSync(p).size;
      } catch {
        /* 消えたファイルは無視 */
      }
    }
  };
  walk(dir);
  return total;
}

/** df 相当 (statfs) で、dir があるファイルシステムの空き容量 (MB) を返す。 */
export function freeSpaceMB(dir: string): number {
  const s = fs.statfsSync(dir);
  return Math.floor((Number(s.bavail) * Number(s.bsize)) / (1024 * 1024));
}

/** /proc/mounts から、dir が rclone (fuse.rclone) のマウント上にあるかを判定する。 */
export function isOnRcloneMount(dir: string, mountsText?: string): boolean {
  let text = mountsText;
  if (text === undefined) {
    try {
      text = fs.readFileSync('/proc/mounts', 'utf8');
    } catch {
      return false;
    }
  }
  let real = dir;
  try {
    real = fs.realpathSync(dir);
  } catch {
    /* そのまま使う */
  }
  let best: { mount: string; fstype: string; src: string } | undefined;
  for (const line of text.split('\n')) {
    const [src, mount, fstype] = line.split(' ');
    if (!mount || !fstype) continue;
    const m = mount.replace(/\\040/g, ' ');
    const inside = real === m || real.startsWith(m.endsWith('/') ? m : m + '/');
    if (inside && (!best || m.length > best.mount.length)) best = { mount: m, fstype, src };
  }
  return !!best && /rclone/i.test(`${best.fstype} ${best.src}`);
}

/** .gitignore に .42check/ が無ければ追記する。追記したら true。 */
export function ensureGitignore(root: string): boolean {
  const file = path.join(root, '.gitignore');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    /* 無ければ新規作成 */
  }
  if (text.split('\n').some((l) => /^\/?\.42check\/?$/.test(l.trim()))) return false;
  const sep = text === '' || text.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(file, `${text}${sep}${WORK_DIR_NAME}/\n`);
  return true;
}

/**
 * scan-build 用に、ビルド成果物を除いたプロジェクトのコピーを作る。
 * fs.cpSync は「コピー先がコピー元の配下」だと拒否するため (.42check は root 配下)、自前で再帰する。
 */
export function copyProject(srcRoot: string, dest: string, maxBytes: number): void {
  const skip = new Set(['.git', WORK_DIR_NAME, 'node_modules', '.vscode']);
  let copied = 0;
  const walk = (from: string, to: string) => {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      if (skip.has(e.name) || /\.(o|a|so|d)$/.test(e.name)) continue;
      const f = path.join(from, e.name);
      const t = path.join(to, e.name);
      if (e.isDirectory()) {
        walk(f, t);
      } else if (e.isFile()) {
        copied += fs.statSync(f).size;
        if (copied > maxBytes) {
          throw new Error(`コピー対象が上限 (${Math.floor(maxBytes / 1048576)}MB) を超えました`);
        }
        fs.copyFileSync(f, t);
      }
    }
  };
  walk(srcRoot, dest);
}
