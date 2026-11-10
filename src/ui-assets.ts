import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The `ui/` folder ships next to `dist/` (published) or `src/` (dev); find it either way. */
const here = dirname(fileURLToPath(import.meta.url));
const UI_DIR = [join(here, '..', 'ui'), join(here, '..', '..', 'ui')].find((d) => existsSync(join(d, 'index.html'))) ?? join(here, '..', 'ui');

export function uiFile(name: string): string {
  return join(UI_DIR, name);
}
