# 容量の実測

目標: 自作分の合計 **500MB 以内**。CodeLLDB と clangd は 500MB の対象外で、別に計測し、home の空きに収まるかを確認する (rclone マウント上には置けないため)。

- 自作分の測定日: 2026-10-07。環境: Ubuntu 24.04 の sandbox (`du -sh` の結果)
- 依存拡張・校舎の空き容量の測定日: 2026-10-08。環境: 校舎マシン (Ubuntu 22.04) の実機。**ユーザーが共有した検証報告に基づく数値で、私は再現していない**

**前提の訂正**: 当初は校舎の home の空きを約 1.9GB と想定していたが、実測は **約 1.1GB** (4.7GB 中 3.6GB 使用) だった。

## 自作分 (500MB の対象)

| 項目 | サイズ | 測定方法 |
|---|---|---|
| ソース一式 (`src/` `test/` `samples/` `docs/` 等、`node_modules` と `.git` を除く) | 約 1.6MB | `du -sh --exclude=node_modules --exclude=.git .` |
| 開発用 `node_modules` (devDependencies のみ。121 packages) | **144MB** | `du -sh node_modules` |
| `.git` | 約 0.2MB | `du -sh .git` |
| ビルド成果物: bundle 後の `dist/` (`extension.js` は production ビルドで約 75KB。残りは開発ビルドの sourcemap 約 155KB で `.vsix` には入らない) | 212KB | `du -sh dist` |
| ビルド成果物: `.vsix` | 41KB (7 ファイル) | `ls -la c42checker-0.1.0.vsix` |
| インストール後の `~/.vscode/extensions/keusidan.c42checker-0.1.0/` (`.vsix` の展開サイズ) | 約 123KB | `.vsix` 内の全ファイルの非圧縮サイズの合計 (126,387 bytes) |
| 検証時の `.42check/` (正常サンプルで全段階 + デバッグ用ビルドまで実行した後) | 約 1.7MB (`ok`: 1,713,994 bytes / `lib-ok`: 1,701,718 bytes) | `dirSize()` (再帰合計) |
| **合計 (上記の最大構成: ワークスペース 145MB + `.vsix` 展開 + `.42check/`)** | **約 147MB** | 500MB 以内 ✅ |

`du -sh .` (node_modules 込み、リポジトリ全体) は **145MB**。

内訳で支配的なのは `node_modules` (144MB)。大きい順に `@azure` 44MB、`@vscode` 33MB、`typescript` 23MB、`@esbuild` 11MB (`du -sh node_modules/* node_modules/@*/*`)。
`@azure` / `@vscode` の大半は、パッケージ化ツール `@vscode/vsce` の依存と思われる (依存関係の追跡までは行っていない)。
実行時の依存パッケージはゼロで、`.vsix` に入るのは bundle 1 ファイル + `package.json` + `LICENSE` + `README` + アイコンだけ (`.vscodeignore` で他を除外)。

### 実行時の容量制御

- `.42check/` は実行のたびに削除して作り直す。ビルドごとの上限 (`c42check.workDirMaxMB`、既定 100MB) を超えると警告して中断する (テスト `.42check/ が上限を超えたら中断する`)。
- 実行前に `statfs` (`df` と同じ情報) でワークスペースの空きを確認し、`c42check.minFreeSpaceMB` (既定 200MB) 未満なら中断する (テスト `段階 0 が失敗 (空き容量不足)`)。

### 校舎でビルドしない (推奨)

校舎の Node は v12.22.9 で、ビルドには Node 22 以上が要る (`@vscode/vsce` が 22 以上、esbuild が 18 以上)。
メイン機でビルドした `.vsix` を Drive 経由で受け渡す (指示のとおり、Drive は完成した `.vsix` の受け渡し用途)。
どうしても校舎でビルドする場合は、公式の `tar.xz` を home に展開して Node 22 を入れる方法があるが、展開後に約 205MB かかる。
ビルド後は `rm -rf node_modules` で 144MB を解放できる。

## 依存する既存拡張機能 (500MB の対象外。別計測)

校舎の実機での実測 (2026-10-08、ユーザー報告):

| 項目 | サイズ | 備考 |
|---|---|---|
| CodeLLDB (LLDB 同梱) | **165MB** | 版 1.12.2 |
| clangd 拡張本体 | **1.5MB** | |
| clangd バイナリ | **225MB** | 拡張が自動でダウンロード (版 23.1.0)。保存先は `~/.config/Code/User/globalStorage/llvm-vs-code-extensions.vscode-clangd/install/`。`.vsix` のインストールの約 1 分後にダウンロードされ、`clangd.path` がユーザー設定に自動で書き込まれた |
| 42 Check 本体 (インストール後) | **92KB** | 当初見積もり (約 76KB) より大きい。README の追記と、その後の機能追加による |
| 小計 (依存と本体) | **約 392MB** | |

### 合計と、空きに収まるか

| 構成 | 合計 | 校舎の空き 1.1GB に対して |
|---|---|---|
| 自作分のみ (`node_modules` を含む開発ワークスペース) | 約 147MB | **500MB の目標内** ✅ |
| 自作分 + CodeLLDB + clangd (拡張 + バイナリ) | 約 **540MB** (147 + 165 + 1.5 + 225) | 収まる (約 49%)。ただし 500MB を超える ⚠ |
| 上記 + 校舎で Node 22 を展開してビルドする場合 | 約 **745MB** (+ 205MB) | 収まるが、残りは約 350MB。`.42check/` の上限 (100MB) と空き容量の閾値 (既定 200MB) を考えると余裕は小さい ⚠ |
| 推奨: メイン機で `.vsix` をビルドし、校舎には `.vsix` だけ持っていく | 約 **392MB** (依存と本体のみ。`node_modules` と Node は不要) | 十分収まる ✅ |

- 「500MB 以内」は自作分の目標で、依存拡張は対象外だった。ただし依存込みの約 540MB はこの目標も超えているので、
  推奨構成 (校舎ではビルドしない) を採ることで、校舎に置く量を約 392MB に抑えられる。
- clangd バイナリ (225MB) が最大の項目。空きが足りないときは、**clangd 拡張を入れない**という選択ができる (検証と F5 は clangd に依存しない)。
  clangd 拡張は入れると自動でバイナリをダウンロードするため、入れる前に `df -h ~` で空きを確認すること。
- 測定コマンド (別の環境で再測定するとき):
  `du -sh ~/.vscode/extensions/vadimcn.vscode-lldb-*`、`du -sh ~/.vscode/extensions/llvm-vs-code-extensions.vscode-clangd-*`、
  `du -sh ~/.config/Code/User/globalStorage/llvm-vs-code-extensions.vscode-clangd`、`df -h ~`
