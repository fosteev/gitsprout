import * as vscode from 'vscode';
import { firstFamily } from '../fonts/google';
import { downloadedFonts, downloadGoogleFont, notifyFontsChanged, pickFamilyToDownload, removeGoogleFont } from '../fonts/store';
import { setSetting } from '../graph/panel';

/** Ids implemented here; `registerStubCommands` skips them. */
export const FONT_COMMAND_IDS = ['downloadGoogleFont', 'removeGoogleFont'] as const;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Opt-in Google Fonts: the only code in the extension that talks to the network, and only on these commands. */
export function registerFontCommands(context: vscode.ExtensionContext, log: (m: string) => void): void {
  const storage = context.globalStorageUri;
  const reg = (id: (typeof FONT_COMMAND_IDS)[number], fn: (arg?: unknown) => Promise<void>) =>
    context.subscriptions.push(vscode.commands.registerCommand(`gitsprout.${id}`, fn));

  reg('downloadGoogleFont', async () => {
    const family = await pickFamilyToDownload(storage);
    if (!family) return;
    try {
      const stored = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Gitsprout: downloading “${family}”` },
        (p) => downloadGoogleFont(storage, family, (m) => p.report({ message: m })),
      );
      await setSetting('diff.fontFamily', stored);
      notifyFontsChanged();
      void vscode.window.showInformationMessage(`Gitsprout: “${stored}” downloaded; the graph diff uses it now.`);
    } catch (e) {
      log(`google font ${family}: ${errText(e)}`);
      void vscode.window.showErrorMessage(`Gitsprout: ${errText(e)}`);
    }
  });

  // `family` (from the settings page's "Remove download") skips the quick pick
  reg('removeGoogleFont', async (family) => {
    const fonts = await downloadedFonts(storage);
    if (!fonts.length) { void vscode.window.showInformationMessage('Gitsprout: no downloaded fonts.'); return; }
    const named = typeof family === 'string' ? fonts.find((f) => f.family.toLowerCase() === family.toLowerCase()) : undefined;
    const pick = named ? { label: named.family } : await vscode.window.showQuickPick(fonts.map((f) => ({ label: f.family })), { placeHolder: 'Downloaded font to remove' });
    if (!pick) return;
    try {
      await removeGoogleFont(storage, pick.label);
      const current = firstFamily(vscode.workspace.getConfiguration('gitsprout').get<string>('diff.fontFamily', ''));
      if (current.toLowerCase() === pick.label.toLowerCase()) await setSetting('diff.fontFamily', '');
      notifyFontsChanged();
      void vscode.window.showInformationMessage(`Gitsprout: “${pick.label}” removed.`);
    } catch (e) {
      log(`remove google font ${pick.label}: ${errText(e)}`);
      void vscode.window.showErrorMessage(`Gitsprout: ${errText(e)}`);
    }
  });
}
