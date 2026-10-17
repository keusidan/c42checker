// 拡張本体 (dist/extension.js) とテスト (out-test/) を esbuild で bundle する。
// 実行時の依存パッケージは無いので、vscode 以外は全て 1 ファイルに入る。
import { build, context } from 'esbuild';
import { readdirSync } from 'node:fs';

const args = new Set(process.argv.slice(2));
const production = args.has('--production');

if (args.has('--test')) {
  const entries = readdirSync('test')
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => `test/${f}`);
  await build({
    entryPoints: entries,
    outdir: 'out-test',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    sourcemap: 'inline',
    // UI 層のテストでは vscode を最小の stub に差し替える
    alias: { vscode: './test/vscode-stub.ts' },
    logLevel: 'info',
  });
} else {
  const options = {
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
    minify: production,
    sourcemap: !production,
    logLevel: 'info',
  };
  if (args.has('--watch')) {
    const ctx = await context(options);
    await ctx.watch();
  } else {
    await build(options);
  }
}
