import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { galleryPage } from './bundle.ts';

const OUT = fileURLToPath(new URL('../dist/gallery.html', import.meta.url));

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, await galleryPage());
console.log(`Built ${OUT}`);
