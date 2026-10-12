import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Symlink seeds for the link suites, created from the host inside the
 * bind-mounted fixture dir (relative targets, so they resolve the same way
 * inside the container). All of them live under `nested/`, so a connection
 * rooted at `/var/www/nested` sees targets both inside and outside its root.
 *
 * - `link-file -> ../hotfix.php`: file link out of the root
 * - `link-dir -> subdir`: directory link inside the root
 * - `link-rel -> ./subdir/../hotfix2.php`: relative file link inside the root
 * - `broken -> does-not-exist`: dangling link
 * - `loop-a -> loop-b`, `loop-b -> loop-a`: loop pair
 * - `up -> ..`: ancestor loop, also a directory link out of the root
 */
export const LINK_SEEDS: ReadonlyArray<readonly [name: string, target: string]> = [
  ['link-file', '../hotfix.php'],
  ['link-dir', 'subdir'],
  ['link-rel', './subdir/../hotfix2.php'],
  ['broken', 'does-not-exist'],
  ['loop-a', 'loop-b'],
  ['loop-b', 'loop-a'],
  ['up', '..'],
];

export const HOTFIX2_SEED = "<?php echo 'hotfix2';";
export const SUBDIR_FILE_SEED = "<?php echo 'subdir';";

/**
 * Recreates the link seeds and the in-root files they point at. Idempotent:
 * existing links are removed first (fs.rm on a link removes the link itself,
 * never its target), so a test that deleted or retargeted one is undone.
 * `hotfix.php` (the out-of-root target) belongs to the main seed and is not
 * written here.
 */
export async function seedLinks(fixtureDir: string): Promise<void> {
  const nested = path.join(fixtureDir, 'nested');
  await fs.mkdir(path.join(nested, 'subdir'), { recursive: true });
  await fs.writeFile(path.join(nested, 'subdir', 'sub.php'), SUBDIR_FILE_SEED, 'utf8');
  await fs.writeFile(path.join(nested, 'hotfix2.php'), HOTFIX2_SEED, 'utf8');
  for (const [name, target] of LINK_SEEDS) {
    const linkPath = path.join(nested, name);
    await fs.rm(linkPath, { force: true });
    await fs.symlink(target, linkPath);
  }
}
