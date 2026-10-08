import * as vscode from 'vscode';
import { findOnPath } from '../core/tools';

const CPPTOOLS = 'ms-vscode.cpptools';

/**
 * 起動時の環境チェック (どちらも通知のみ。設定やファイルは書き換えない)。
 *  - Microsoft C/C++ が入っていると clangd と競合する
 *  - clangd が PATH に無い場合の、ダウンロード前の注意
 */
export async function checkEnvironment(state: vscode.Memento): Promise<void> {
  if (vscode.extensions.getExtension(CPPTOOLS) && !state.get<boolean>('c42check.cpptoolsNotified')) {
    await state.update('c42check.cpptoolsNotified', true);
    void vscode.window.showWarningMessage(
      '42 Check: Microsoft C/C++ (ms-vscode.cpptools) が有効です。clangd と IntelliSense / 診断が競合するため、このワークスペースでは無効化することをおすすめします (設定は書き換えていません)。',
    );
  }

  const configured = vscode.workspace.getConfiguration('clangd').get<string>('path');
  if (!configured && !findOnPath('clangd') && !state.get<boolean>('c42check.clangdNotified')) {
    await state.update('c42check.clangdNotified', true);
    void vscode.window.showInformationMessage(
      '42 Check: clangd が PATH にありません。clangd 拡張がバイナリをダウンロードし、home 配下 (~/.config/Code/User/globalStorage/ 以下) に約 225MB (実測) 保存されます。空きが少ないときは `df -h ~` で確認し、clangd 拡張を入れない選択もできます (検証と F5 は clangd に依存しません)。この拡張はダウンロードを代行しません。',
    );
  }
}
