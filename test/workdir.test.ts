import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
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

test('.gitignore に .42check/ を追記する (既にあれば追記しない / 改行なしの末尾にも対応)', () => {
  const d = tmp();
  assert.equal(ensureGitignore(d), true, '無ければ新規作成');
  assert.equal(fs.readFileSync(path.join(d, '.gitignore'), 'utf8'), '.42check/\n');
  assert.equal(ensureGitignore(d), false, '2 回目は追記しない');
  fs.writeFileSync(path.join(d, '.gitignore'), 'a.out');
  assert.equal(ensureGitignore(d), true);
  assert.equal(fs.readFileSync(path.join(d, '.gitignore'), 'utf8'), 'a.out\n.42check/\n');
  fs.writeFileSync(path.join(d, '.gitignore'), '/.42check\n');
  assert.equal(ensureGitignore(d), false, '別の書き方の既存行も認識する');
  fs.rmSync(d, { recursive: true });
});

test('resetWorkDir は .42check 以外を削除しない / 古い成果物を消して作り直す', () => {
  const d = tmp();
  const work = path.join(d, '.42check');
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

test('copyProject: .42check / .git / *.o を除いて、root 配下のコピー先にもコピーできる', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'src'));
  fs.mkdirSync(path.join(d, '.git'));
  fs.mkdirSync(path.join(d, '.42check'));
  fs.writeFileSync(path.join(d, 'src', 'a.c'), 'int a;');
  fs.writeFileSync(path.join(d, 'src', 'a.o'), 'obj');
  fs.writeFileSync(path.join(d, '.git', 'HEAD'), 'x');
  const dest = path.join(d, '.42check', 'scan-build', 'src');
  copyProject(d, dest, 1024 * 1024);
  assert.ok(fs.existsSync(path.join(dest, 'src', 'a.c')));
  assert.equal(fs.existsSync(path.join(dest, 'src', 'a.o')), false);
  assert.equal(fs.existsSync(path.join(dest, '.git')), false);
  assert.equal(fs.existsSync(path.join(dest, '.42check')), false, '自分自身を再帰コピーしない');
  assert.throws(() => copyProject(d, path.join(d, 'x'), 3), /上限/);
  fs.rmSync(d, { recursive: true });
});
