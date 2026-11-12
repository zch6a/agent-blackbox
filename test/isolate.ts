/**
 * Loaded before every test file (`node --import ./test/isolate.ts --test`, and from helpers.ts): the home folder,
 * the cache and every agent's own folder variable point into a new, empty temp folder. A test that forgets to pass
 * a root for some agent then finds nothing, instead of the real sessions of whoever runs the tests.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KEY = 'BLACKBOX_TEST_HOME';

if (!process.env[KEY]) {
  const home = mkdtempSync(join(tmpdir(), 'blackbox-test-home-'));
  for (const sub of ['AppData/Roaming', 'AppData/Local', '.local/share', '.cache', '.config']) mkdirSync(join(home, sub), { recursive: true });
  Object.assign(process.env, {
    [KEY]: home,
    BLACKBOX_HOME_OVERRIDE: home,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_CONFIG_HOME: join(home, '.config'),
    BLACKBOX_CACHE_DIR: join(home, '.cache', 'agent-blackbox'),
  });
  for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DSH_HOME', 'GEMINI_CLI_HOME', 'BLACKBOX_PRICING']) delete process.env[name];
  // Child processes (the CLI under test) inherit all of this; only the process that made the folder removes it.
  process.on('exit', () => rmSync(home, { recursive: true, force: true }));
}

export const TEST_HOME = process.env[KEY] as string;
