import * as fs from 'node:fs';
import * as path from 'node:path';
import { WORK_DIR_NAME } from './workdir';

/** 改名前の作業ディレクトリ名 (改名前の拡張の名称は c42check、作業ディレクトリは .42check) */
export const OLD_WORK_DIR_NAME = '.42check';

const SETTINGS_FILES = ['.vscode/settings.json', '.vscode/tasks.json', '.vscode/launch.json'];

export interface FileRewrite {
  file: string;
  /** 書き換える箇所の数 */
  count: number;
  newText: string;
}

export interface MigrationPlan {
  /** 設定キー (c42check.*)・task の種類・コマンド ID・作業ディレクトリのパスを書き換えるファイル */
  files: FileRewrite[];
  /** 作業ディレクトリの移動 (旧 → 新)。新しい方が既にあるときは undefined */
  moveWorkDir?: { from: string; to: string };
  /** 旧い作業ディレクトリが残っているが、新しい方もあるので触らない */
  oldWorkDirKept?: string;
  /** .gitignore の書き換え (旧い `.42check/` の行を新しい名前にする) */
  gitignore?: FileRewrite;
}

export const isEmptyPlan = (p: MigrationPlan): boolean => p.files.length === 0 && !p.moveWorkDir && !p.gitignore;

/** 改名前の名称を、新しい名称にする。`c42check` は単語として (`c42checker` や `c42check_x` は変えない) 置き換える。 */
export function renameText(text: string): { text: string; count: number } {
  let count = 0;
  const next = text.replace(/\bc42check\b|\.42check\b/g, (m) => {
    count++;
    return m === 'c42check' ? 'c42checker' : '.c42checker';
  });
  return { text: next, count };
}

/** .gitignore の `.42check/` の行を新しい名前にする。新しい名前の行が既にあれば、旧い行を消すだけにする。 */
function renameGitignore(text: string): { text: string; count: number } {
  const old = /^\/?\.42check\/?$/;
  const lines = text.split('\n');
  const hasNew = lines.some((l) => /^\/?\.c42checker\/?$/.test(l.trim()));
  let count = 0;
  const out: string[] = [];
  for (const l of lines) {
    if (!old.test(l.trim())) {
      out.push(l);
      continue;
    }
    count++;
    if (!hasNew) out.push(l.replace('.42check', WORK_DIR_NAME));
  }
  return { text: out.join('\n'), count };
}

const readText = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

/** 移行の計画を作る。ファイルには一切書かない。 */
export function planMigration(root: string): MigrationPlan {
  const candidates = [...SETTINGS_FILES.map((f) => path.join(root, f))];
  try {
    for (const e of fs.readdirSync(root)) if (e.endsWith('.code-workspace')) candidates.push(path.join(root, e));
  } catch {
    /* root を読めなければ、何もしない */
  }

  const files: FileRewrite[] = [];
  for (const file of candidates) {
    const text = readText(file);
    if (text === undefined) continue;
    const r = renameText(text);
    if (r.count > 0) files.push({ file, count: r.count, newText: r.text });
  }

  const plan: MigrationPlan = { files };
  const from = path.join(root, OLD_WORK_DIR_NAME);
  const to = path.join(root, WORK_DIR_NAME);
  if (fs.existsSync(from) && fs.statSync(from).isDirectory()) {
    if (fs.existsSync(to)) plan.oldWorkDirKept = from;
    else plan.moveWorkDir = { from, to };
  }

  const gi = path.join(root, '.gitignore');
  const giText = readText(gi);
  if (giText !== undefined) {
    const r = renameGitignore(giText);
    if (r.count > 0) plan.gitignore = { file: gi, count: r.count, newText: r.text };
  }
  return plan;
}

export interface MigrationResult {
  /** 利用者に見せる、行ごとの結果 */
  lines: string[];
  /** エディタに未保存の変更があるため、書き換えなかったファイル */
  skipped: string[];
}

/**
 * 計画を適用する。エディタに未保存の変更があるファイルは、上書きせずに飛ばす (保存してからもう一度実行できる)。
 * 作業ディレクトリは移動する (.c42checker/state/ の「生成済みの記録」を引き継ぐため。消さない)。
 */
export function applyMigration(root: string, plan: MigrationPlan, isDirty: (file: string) => boolean = () => false): MigrationResult {
  const rel = (p: string) => path.relative(root, p) || p;
  const lines: string[] = [];
  const skipped: string[] = [];
  for (const f of [...plan.files, ...(plan.gitignore ? [plan.gitignore] : [])]) {
    if (isDirty(f.file)) {
      skipped.push(f.file);
      lines.push(`飛ばしました (未保存の変更があります。保存してからもう一度実行してください): ${rel(f.file)}`);
      continue;
    }
    fs.writeFileSync(f.file, f.newText);
    lines.push(`書き換えました: ${rel(f.file)} (${f.count} 箇所)`);
  }
  if (plan.moveWorkDir) {
    fs.renameSync(plan.moveWorkDir.from, plan.moveWorkDir.to);
    lines.push(`移動しました: ${rel(plan.moveWorkDir.from)}/ → ${rel(plan.moveWorkDir.to)}/`);
  }
  if (plan.oldWorkDirKept) {
    lines.push(`残しました: ${rel(plan.oldWorkDirKept)}/ (新しい ${WORK_DIR_NAME}/ もあるため。不要なら自分で消してください)`);
  }
  return { lines, skipped };
}

/** 計画の説明 (確認ダイアログ用) */
export function describePlan(root: string, plan: MigrationPlan): string[] {
  const rel = (p: string) => path.relative(root, p) || p;
  return [
    ...plan.files.map((f) => `${rel(f.file)} の c42check / ${OLD_WORK_DIR_NAME} を書き換え (${f.count} 箇所)`),
    ...(plan.gitignore ? [`.gitignore の ${OLD_WORK_DIR_NAME}/ を ${WORK_DIR_NAME}/ に書き換え`] : []),
    ...(plan.moveWorkDir ? [`${OLD_WORK_DIR_NAME}/ を ${WORK_DIR_NAME}/ に移動 (生成済みの記録を引き継ぐ)`] : []),
    ...(plan.oldWorkDirKept ? [`${OLD_WORK_DIR_NAME}/ は ${WORK_DIR_NAME}/ もあるため、そのまま残す`] : []),
  ];
}
