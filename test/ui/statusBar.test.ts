import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import { createTmpStatusBarItem } from '../../src/ui/statusBar';

describe('createTmpStatusBarItem', () => {
  it('renders a cloud icon with server:path text and a distinct color', () => {
    const item = createTmpStatusBarItem('staging', '/var/www/app/config.php');
    expect(item.text).toBe('$(cloud) staging:/var/www/app/config.php');
    expect(item.color).toBeInstanceOf(vscode.ThemeColor);
  });
});
