import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { applyMigration, describePlan, isEmptyPlan, planMigration, renameText } from '../src/core/migrate';
import { copyProject, dirSize, ensureGitignore, freeSpaceMB, isOnRcloneMount, resetWorkDir } from '../src/core/workdir';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'c42-wd-'));

test('rclone のマウント上かを /proc/mounts の内容から判定する (最長一致のマウントで判断)', () => {
  const mounts = [
    '/dev/vda / ext4 rw 0 0',
    'gdrive: /home/u/drive fuse.rclone rw,nosuid 0 0',
    '/dev/vda /home/u/drive/local ext4 rw 0 0',
  ].join('\n');
  assert.equal(isOnRcloneMount('/home/u/drive/work', mounts), true);
  assert.equal(isOnRcloneMount('/home/u/drive', mounts), true);
  assert.equal(isOnRcloneMount('/home/u/drive/local/x', mounts), false, 'より深い非 rclone のマウントが優先される');
  assert.equal(isOnRcloneMount('/home/u/other', mounts), false);
  assert.equal(isOnRcloneMount('/home/u/drive2', mounts), false, '前方一致だけでは同じマウントとみなさない');
});

test('.gitignore に .c42checker/ を追記する (既にあれば追記しない / 改行なしの末尾にも対応)', () => {
  const d = tmp();
  assert.equal(ensureGitignore(d), true, '無ければ新規作成');
  assert.equal(fs.readFileSync(path.join(d, '.gitignore'), 'utf8'), '.c42checker/\n');
  assert.equal(ensureGitignore(d), false, '2 回目は追記しない');
  fs.writeFileSync(path.join(d, '.gitignore'), 'a.out');
  assert.equal(ensureGitignore(d), true);
  assert.equal(fs.readFileSync(path.join(d, '.gitignore'), 'utf8'), 'a.out\n.c42checker/\n');
  fs.writeFileSync(path.join(d, '.gitignore'), '/.c42checker\n');
  assert.equal(ensureGitignore(d), false, '別の書き方の既存行も認識する');
  fs.rmSync(d, { recursive: true });
});

test('resetWorkDir は .c42checker 以外を削除しない / 古い成果物を消して作り直す', () => {
  const d = tmp();
  const work = path.join(d, '.c42checker');
  fs.mkdirSync(path.join(work, 'old'), { recursive: true });
  fs.writeFileSync(path.join(work, 'old', 'a.bin'), 'x');
  resetWorkDir(work);
  assert.deepEqual(fs.readdirSync(work), []);
  assert.throws(() => resetWorkDir(d), /以外は削除しません/);
  assert.ok(fs.existsSync(d), '安全のため別名のディレクトリは触らない');
  fs.rmSync(d, { recursive: true });
});

test('dirSize / freeSpaceMB', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'a'));
  fs.writeFileSync(path.join(d, 'a', 'x'), Buffer.alloc(1000));
  fs.writeFileSync(path.join(d, 'y'), Buffer.alloc(24));
  assert.equal(dirSize(d), 1024);
  assert.ok(freeSpaceMB(d) > 0);
  fs.rmSync(d, { recursive: true });
});

test('copyProject: .c42checker / .git / *.o を除いて、root 配下のコピー先にもコピーできる', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'src'));
  fs.mkdirSync(path.join(d, '.git'));
  fs.mkdirSync(path.join(d, '.c42checker'));
  fs.writeFileSync(path.join(d, 'src', 'a.c'), 'int a;');
  fs.writeFileSync(path.join(d, 'src', 'a.o'), 'obj');
  fs.writeFileSync(path.join(d, '.git', 'HEAD'), 'x');
  const dest = path.join(d, '.c42checker', 'scan-build', 'src');
  copyProject(d, dest, 1024 * 1024);
  assert.ok(fs.existsSync(path.join(dest, 'src', 'a.c')));
  assert.equal(fs.existsSync(path.join(dest, 'src', 'a.o')), false);
  assert.equal(fs.existsSync(path.join(dest, '.git')), false);
  assert.equal(fs.existsSync(path.join(dest, '.c42checker')), false, '自分自身を再帰コピーしない');
  assert.throws(() => copyProject(d, path.join(d, 'x'), 3), /上限/);
  fs.rmSync(d, { recursive: true });
});

/* ───────── 旧名称 (c42check / .42check) からの移行 ───────── */

const OLD_SETTINGS = `{
  // 対象
  "c42check.targetDir": "src",
  "c42check.checks": { "norminette": true },
  "c42checker.mainFile": "main.c", // すでに新しい名前
  "editor.tabSize": 4
}
`;
const OLD_TASKS = '{"version":"2.0.0","tasks":[{"type":"c42check","mode":"pre-debug","label":"c42check: pre-debug"}]}';
const OLD_LAUNCH = '{"configurations":[{"preLaunchTask":"c42check: pre-debug","args":"${command:c42check.runArgs}","program":"${workspaceFolder}/.42check/debug/prog"}]}';

function oldProject(): string {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.vscode'));
  fs.writeFileSync(path.join(dir, '.vscode', 'settings.json'), OLD_SETTINGS);
  fs.writeFileSync(path.join(dir, '.vscode', 'tasks.json'), OLD_TASKS);
  fs.writeFileSync(path.join(dir, '.vscode', 'launch.json'), OLD_LAUNCH);
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.42check/\n*.o\n');
  fs.mkdirSync(path.join(dir, '.42check', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.42check', 'state', 'compdb.json'), '{"version":1}');
  return dir;
}

test('名称の置き換え: c42check と .42check だけを、単語として置き換える (c42checker や c42check_x は変えない)', () => {
  assert.deepEqual(renameText('"c42check.run" c42check: x ${command:c42check.runArgs} /.42check/debug'), {
    text: '"c42checker.run" c42checker: x ${command:c42checker.runArgs} /.c42checker/debug',
    count: 4,
  });
  assert.deepEqual(renameText('c42checker c42check_x xc42check .c42checker 42check'), { text: 'c42checker c42check_x xc42check .c42checker 42check', count: 0 });
});

test('移行の計画: 設定・task・launch・.gitignore・作業ディレクトリを拾う。計画を作るだけでは何も書かない', () => {
  const dir = oldProject();
  const plan = planMigration(dir);
  assert.deepEqual(plan.files.map((f) => path.basename(f.file)).sort(), ['launch.json', 'settings.json', 'tasks.json']);
  assert.equal(plan.files.find((f) => f.file.endsWith('settings.json'))!.count, 2, 'すでに新しい名前の c42checker.mainFile は数えない');
  assert.equal(plan.files.find((f) => f.file.endsWith('launch.json'))!.count, 3);
  assert.ok(plan.moveWorkDir && plan.gitignore);
  assert.equal(isEmptyPlan(plan), false);
  assert.ok(describePlan(dir, plan).length >= 5);
  assert.equal(fs.readFileSync(path.join(dir, '.vscode', 'settings.json'), 'utf8'), OLD_SETTINGS, '書いていない');
  assert.ok(fs.existsSync(path.join(dir, '.42check')) && !fs.existsSync(path.join(dir, '.c42checker')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('移行の適用: コメントと並びを保って書き換え、作業ディレクトリは移動して state/ を引き継ぐ。2 回目は何もない', () => {
  const dir = oldProject();
  const r = applyMigration(dir, planMigration(dir));
  assert.deepEqual(r.skipped, []);
  const settings = fs.readFileSync(path.join(dir, '.vscode', 'settings.json'), 'utf8');
  assert.equal(settings, OLD_SETTINGS.replace(/c42check\./g, 'c42checker.'), 'コメント・並び・他のキーはそのまま');
  assert.match(settings, /\/\/ 対象/);
  assert.equal(fs.readFileSync(path.join(dir, '.vscode', 'tasks.json'), 'utf8'), '{"version":"2.0.0","tasks":[{"type":"c42checker","mode":"pre-debug","label":"c42checker: pre-debug"}]}');
  assert.equal(
    fs.readFileSync(path.join(dir, '.vscode', 'launch.json'), 'utf8'),
    '{"configurations":[{"preLaunchTask":"c42checker: pre-debug","args":"${command:c42checker.runArgs}","program":"${workspaceFolder}/.c42checker/debug/prog"}]}',
  );
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'node_modules/\n.c42checker/\n*.o\n');
  assert.ok(!fs.existsSync(path.join(dir, '.42check')));
  assert.equal(fs.readFileSync(path.join(dir, '.c42checker', 'state', 'compdb.json'), 'utf8'), '{"version":1}', 'state/ を引き継ぐ');
  assert.equal(isEmptyPlan(planMigration(dir)), true, '冪等');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('移行: 新しい作業ディレクトリが既にあれば、旧い方は消さずに残す。.gitignore に新しい行があれば、旧い行を消すだけ', () => {
  const dir = oldProject();
  fs.mkdirSync(path.join(dir, '.c42checker'));
  fs.writeFileSync(path.join(dir, '.gitignore'), '.42check/\n.c42checker/\n');
  const plan = planMigration(dir);
  assert.equal(plan.moveWorkDir, undefined);
  assert.equal(plan.oldWorkDirKept, path.join(dir, '.42check'));
  const r = applyMigration(dir, plan);
  assert.ok(fs.existsSync(path.join(dir, '.42check', 'state', 'compdb.json')), '旧い方は触らない');
  assert.ok(r.lines.some((l) => /残しました/.test(l)));
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '.c42checker/\n', '重複させない');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('移行: エディタに未保存の変更があるファイルは、上書きせずに飛ばす', () => {
  const dir = oldProject();
  const settings = path.join(dir, '.vscode', 'settings.json');
  const r = applyMigration(dir, planMigration(dir), (f) => f === settings);
  assert.deepEqual(r.skipped, [settings]);
  assert.equal(fs.readFileSync(settings, 'utf8'), OLD_SETTINGS, '触らない');
  assert.match(fs.readFileSync(path.join(dir, '.vscode', 'tasks.json'), 'utf8'), /c42checker/, '他のファイルは書き換える');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('移行: 旧名称が無いプロジェクトでは、計画が空 (.code-workspace も対象)', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.vscode'));
  fs.writeFileSync(path.join(dir, '.vscode', 'settings.json'), '{"c42checker.targetDir":"src"}');
  assert.equal(isEmptyPlan(planMigration(dir)), true);
  fs.writeFileSync(path.join(dir, 'p.code-workspace'), '{"settings":{"c42check.targetDir":"src"}}');
  const plan = planMigration(dir);
  assert.deepEqual(plan.files.map((f) => path.basename(f.file)), ['p.code-workspace']);
  fs.rmSync(dir, { recursive: true, force: true });
});
