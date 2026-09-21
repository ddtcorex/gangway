import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

describe('mapping-sync contributions', () => {
  it('declares the 6 mapping commands with exact titles', async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const titles = new Map(pkg.contributes.commands.map((c: { command: string; title: string }) => [c.command, c.title]));
    expect(titles.get('gangway.uploadMappedFile')).toBe('Gangway: Upload to Mapped Remote');
    expect(titles.get('gangway.uploadMappedFolder')).toBe('Gangway: Upload to Mapped Remote');
    expect(titles.get('gangway.downloadMappedFile')).toBe('Gangway: Download to Workspace');
    expect(titles.get('gangway.downloadMappedFolder')).toBe('Gangway: Download to Workspace');
    expect(titles.get('gangway.downloadToWorkspaceFile')).toBe('Gangway: Download File from Server to Workspace');
    expect(titles.get('gangway.downloadToWorkspaceFolder')).toBe('Gangway: Download Folder from Server to Workspace');
  });

  it('names folder menus by destination (temp vs workspace) and safety (preview)', async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const titles = new Map(pkg.contributes.commands.map((c: { command: string; title: string }) => [c.command, c.title]));
    expect(titles.get('gangway.downloadFolder')).toBe('Gangway: Download Folder from Server to Temp');
    expect(titles.get('gangway.uploadFolder')).toBe('Gangway: Upload Folder from Temp to Server');
    expect(titles.get('gangway.syncFolder')).toBe('Gangway: Preview Sync Folder with Server…');
    expect(titles.get('gangway.syncWorkspaceUp')).toBe('Gangway: Sync Workspace to Server (Preview)');
    expect(titles.get('gangway.syncWorkspaceDown')).toBe('Gangway: Sync Workspace from Server (Preview)');
  });

  it('wires explorer/context for local and view/item/context for remote', async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const explorer = pkg.contributes.menus['explorer/context'];
    const byCommand = (id: string) => explorer.filter((m: { command: string }) => m.command === id);
    expect(byCommand('gangway.uploadMappedFile').length).toBe(1);
    expect(byCommand('gangway.uploadMappedFolder').length).toBe(1);
    expect(byCommand('gangway.downloadMappedFile').length).toBe(1);
    expect(byCommand('gangway.downloadMappedFolder').length).toBe(1);
    expect(byCommand('gangway.compareWorkspaceFile').length).toBe(1);
    const tree = pkg.contributes.menus['view/item/context'];
    const treeBy = (id: string) => tree.filter((m: { command: string }) => m.command === id);
    expect(treeBy('gangway.downloadToWorkspaceFile').length).toBe(1);
    expect(treeBy('gangway.downloadToWorkspaceFolder').length).toBe(1);
  });

  it('declares the workspace-compare command with its exact title', async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const titles = new Map(pkg.contributes.commands.map((c: { command: string; title: string }) => [c.command, c.title]));
    expect(titles.get('gangway.compareWorkspaceFile')).toBe('Gangway: Compare Workspace with Server');
  });

  it('binds Ctrl+Alt+Shift+X to upload the mapped file open in the editor', async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const bindings = pkg.contributes.keybindings.filter(
      (k: { command: string }) => k.command === 'gangway.uploadMappedFile',
    );
    expect(bindings).toHaveLength(1);
    expect(bindings[0].key).toBe('ctrl+alt+shift+x');
    expect(bindings[0].mac).toBe('cmd+alt+shift+x');
    expect(bindings[0].when).toBe('editorTextFocus && resourceScheme == file');
  });

  it('declares no trash commands and titles delete as permanent', async () => {    const pkg = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const ids = pkg.contributes.commands.map((c: { command: string }) => c.command);
    expect(ids).not.toContain('gangway.restoreFromTrash');
    expect(ids).not.toContain('gangway.emptyTrash');
    const titles = new Map(pkg.contributes.commands.map((c: { command: string; title: string }) => [c.command, c.title]));
    expect(titles.get('gangway.deleteRemote')).toBe('Gangway: Delete Remote File/Folder (Permanent)');
    const menus = [...pkg.contributes.menus['view/item/context'], ...(pkg.contributes.menus['view/title'] ?? [])];
    expect(menus.filter((m: { command: string }) => m.command === 'gangway.restoreFromTrash' || m.command === 'gangway.emptyTrash')).toHaveLength(0);
  });
});
