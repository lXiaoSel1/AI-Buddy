import {mkdir, copyFile} from 'node:fs/promises';
await mkdir(new URL('./lib/', import.meta.url), {recursive: true});
await copyFile(new URL('./src/index.mjs', import.meta.url), new URL('./lib/index.js', import.meta.url));
await copyFile(new URL('./src/client.js', import.meta.url), new URL('./lib/client.js', import.meta.url));
