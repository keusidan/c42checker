# 容量の実測

目標: 完成品の合計 **500MB 以内** (校舎マシンの home の空きが約 1.9GB、rclone マウント上には置けないため)。
測定日: 2026-10-07。測定環境: Ubuntu 24.04 の sandbox (校舎マシンではない)。`du -sh` の結果を記載する。

## 自作分 (500MB の対象)

| 項目 | サイズ | 測定方法 |
|---|---|---|
| ソース一式 (`src/` `test/` `samples/` `docs/` 等、`node_modules` と `.git` を除く) | 約 1.6MB | `du -sh --exclude=node_modules --exclude=.git .` |
| 開発用 `node_modules` (devDependencies のみ。121 packages) | **144MB** | `du -sh node_modules` |
| `.git` | 約 0.2MB | `du -sh .git` |
| ビルド成果物: bundle 後の `dist/` (`extension.js` は production ビルドで約 49KB。残りは開発ビルドの sourcemap 約 155KB で `.vsix` には入らない) | 212KB | `du -sh dist` |
| ビルド成果物: `.vsix` | 28KB (7 ファイル) | `ls -la c42checker-0.1.0.vsix` |
| インストール後の `~/.vscode/extensions/keusidan.c42checker-0.1.0/` (`.vsix` の展開サイズ) | 約 76KB | `.vsix` 内の全ファイルの非圧縮サイズの合計 (78,144 bytes) |
| 検証時の `.42check/` (正常サンプルで全段階 + デバッグ用ビルドまで実行した後) | 約 1.7MB (`ok`: 1,713,994 bytes / `lib-ok`: 1,701,718 bytes) | `dirSize()` (再帰合計) |
| **合計 (上記の最大構成: ワークスペース 145MB + `.vsix` 展開 + `.42check/`)** | **約 147MB** | 500MB 以内 ✅ |

`du -sh .` (node_modules 込み、リポジトリ全体) は **145MB**。

内訳で支配的なのは `node_modules` (144MB)。大きい順に `@azure` 44MB、`@vscode` 33MB、`typescript` 23MB、`@esbuild` 11MB (`du -sh node_modules/* node_modules/@*/*`)。
`@azure` / `@vscode` の大半は、パッケージ化ツール `@vscode/vsce` の依存と思われる (依存関係の追跡までは行っていない)。
実行時の依存パッケージはゼロで、`.vsix` に入るのは bundle 1 ファイル + `package.json` + `LICENSE` + `README` + アイコンだけ (`.vscodeignore` で他を除外)。

### 実行時の容量制御

- `.42check/` は実行のたびに削除して作り直す。ビルドごとの上限 (`c42check.workDirMaxMB`、既定 100MB) を超えると警告して中断する (テスト `.42check/ が上限を超えたら中断する`)。
- 実行前に `statfs` (`df` と同じ情報) でワークスペースの空きを確認し、`c42check.minFreeSpaceMB` (既定 200MB) 未満なら中断する (テスト `段階 0 が失敗 (空き容量不足)`)。

### 校舎マシンで `node_modules` を残したくない場合

`.vsix` を作った後は `node_modules` が不要になる。次で 144MB を解放できる。

```sh
npm ci && npm run package && rm -rf node_modules
```

(`node_modules` が home の空きを圧迫する場合は、メイン機でビルドした `.vsix` を Drive 経由で受け渡す。これは指示のとおり「Drive は完成した `.vsix` の受け渡し用途」にあたる。)

## 依存する既存拡張機能 (500MB の対象外。別計測)

**この環境では計測できていない** (VS Code / Marketplace / Open VSX への通信が遮断されているため、拡張もバイナリも取得できない)。
次のコマンドで、導入後に実測して、この表に追記すること。

| 項目 | 測定コマンド (導入後) | サイズ |
|---|---|---|
| CodeLLDB (LLDB 同梱) | `du -sh ~/.vscode/extensions/vadimcn.vscode-lldb-*` | 未計測 |
| clangd 拡張本体 | `du -sh ~/.vscode/extensions/llvm-vs-code-extensions.vscode-clangd-*` | 未計測 |
| clangd バイナリ (拡張がダウンロードした場合) | `find ~ -type f -name 'clangd*' -path '*globalStorage*' -exec du -sh {} +` (保存先は拡張のストレージ配下と思われるが未確認) | 未計測 |

校舎の空き 1.9GB に収まるかの判定式:
`自作分 (約 147MB) + CodeLLDB + clangd 拡張 + clangd バイナリ  <  1.9GB`
左辺のうち未計測の 3 つの合計が約 1.75GB 未満であれば収まる。導入前に `df -h ~` で空きを確認すること
(clangd のダウンロード前の注意は、拡張が起動時に通知する)。
