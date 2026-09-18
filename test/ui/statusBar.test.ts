import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { createTmpStatusBarItem, TmpStatusBar } from '../../src/ui/statusBar';

describe('createTmpStatusBarItem', () => {
  it('renders a cloud icon with server:path text and a distinct color', () => {
    const item = createTmpStatusBarItem('staging', '/var/www/app/config.php');
    expect(item.text).toBe('$(cloud) staging:/var/www/app/config.php');
    expect(item.color).toBeInstanceOf(vscode.ThemeColor);
  });
});

describe('TmpStatusBar', () => {
  it('creates exactly one status bar item no matter how many files are downloaded', () => {
    const createSpy = vi.spyOn(vscode.window, 'createStatusBarItem');
    const bar = new TmpStatusBar();
    try {
      bar.showFor('staging', '/var/www/a.php', '/tmp/a.php');
      bar.showFor('staging', '/var/www/b.php', '/tmp/b.php');
      expect(createSpy).toHaveBeenCalledTimes(1);
    } finally {
      createSpy.mockRestore();
      bar.dispose();
    }
  });

  it('retargets the single item to the latest download', () => {
    const bar = new TmpStatusBar();
    try {
      bar.showFor('staging', '/var/www/a.php', '/tmp/a.php');
      bar.showFor('prod', '/srv/b.php', '/tmp/b.php');
      const item = bar.currentItem;
      expect(item?.text).toBe('$(cloud) prod:/srv/b.php');
    } finally {
      bar.dispose();
    }
  });

  it('shows the right label when the active editor switches between known tmp files, hides otherwise', () => {
    const bar = new TmpStatusBar();
    try {
      bar.showFor('staging', '/var/www/a.php', '/tmp/a.php');
      const item = bar.currentItem!;
      const showSpy = vi.spyOn(item, 'show');
      const hideSpy = vi.spyOn(item, 'hide');

      bar.handleActiveEditorChanged('/tmp/a.php');
      expect(item.text).toBe('$(cloud) staging:/var/www/a.php');
      expect(showSpy).toHaveBeenCalled();

      bar.handleActiveEditorChanged('/home/user/local.php');
      expect(hideSpy).toHaveBeenCalled();

      bar.handleActiveEditorChanged(undefined);
      expect(hideSpy).toHaveBeenCalledTimes(2);
    } finally {
      bar.dispose();
    }
  });

  it('dispose() disposes the item and forgets tracked files', () => {
    const bar = new TmpStatusBar();
    bar.showFor('staging', '/var/www/a.php', '/tmp/a.php');
    const item = bar.currentItem!;
    const disposeSpy = vi.spyOn(item, 'dispose');
    bar.dispose();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(bar.currentItem).toBeUndefined();
  });
});
