import * as vscode from 'vscode';
import type { Diag } from '../core/types';

/** Problems パネルへの出力。実行のたびに丸ごと入れ替える。 */
export class Problems implements vscode.Disposable {
  private collection = vscode.languages.createDiagnosticCollection('c42check');
  private byFile = new Map<string, vscode.Diagnostic[]>();

  clear(): void {
    this.collection.clear();
    this.byFile.clear();
  }

  add(diags: Diag[]): void {
    for (const d of diags) {
      const line = Math.max(0, d.line - 1);
      const col = Math.max(0, d.col - 1);
      const diag = new vscode.Diagnostic(
        new vscode.Range(line, col, line, col + 1),
        d.message,
        d.severity === 'error'
          ? vscode.DiagnosticSeverity.Error
          : d.severity === 'warning'
            ? vscode.DiagnosticSeverity.Warning
            : vscode.DiagnosticSeverity.Information,
      );
      diag.source = `42check:${d.source}`;
      const list = this.byFile.get(d.file) ?? [];
      list.push(diag);
      this.byFile.set(d.file, list);
    }
    for (const [file, list] of this.byFile) this.collection.set(vscode.Uri.file(file), list);
  }

  dispose(): void {
    this.collection.dispose();
  }
}
