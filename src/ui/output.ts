import * as vscode from 'vscode';

/** ツールごとの Output Channel。run の開始時に clear する。 */
export class Outputs implements vscode.Disposable {
  private channels = new Map<string, vscode.OutputChannel>();

  get(name: string): vscode.OutputChannel {
    let ch = this.channels.get(name);
    if (!ch) {
      ch = vscode.window.createOutputChannel(name === 'main' ? '42 Check' : `42 Check: ${name}`);
      this.channels.set(name, ch);
    }
    return ch;
  }

  clearAll(): void {
    for (const ch of this.channels.values()) ch.clear();
  }

  dispose(): void {
    for (const ch of this.channels.values()) ch.dispose();
    this.channels.clear();
  }
}
