import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMAND_IDS, VIEW_IDS } from '../src/commands/ids';

const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));

describe('manifest', () => {
  it('contributes exactly the commands the extension registers', () => {
    const declared = pkg.contributes.commands.map((c: { command: string }) => c.command).sort();
    expect(declared).toEqual(COMMAND_IDS.map((id) => `gitsprout.${id}`).sort());
  });

  it('contributes exactly the views the extension registers', () => {
    const declared = pkg.contributes.views.gitsprout.map((v: { id: string }) => v.id).sort();
    expect(declared).toEqual(VIEW_IDS.map((id) => `gitsprout.${id}`).sort());
  });

  it('references only declared commands in menus and keybindings', () => {
    const ids = new Set(pkg.contributes.commands.map((c: { command: string }) => c.command));
    const used = [
      ...Object.values<{ command: string }[]>(pkg.contributes.menus).flat().map((m) => m.command),
      ...pkg.contributes.keybindings.map((k: { command: string }) => k.command),
    ];
    for (const c of used) expect(ids.has(c), c).toBe(true);
  });
});
