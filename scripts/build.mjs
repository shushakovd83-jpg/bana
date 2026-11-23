import {build} from 'esbuild';
import {readFile,readdir} from 'node:fs/promises';
const files={};
for (const folder of ['docs', 'docs/assets', 'dist']) {
  for (const entry of await readdir(folder, {withFileTypes: true})) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    const url = folder === 'docs/assets' ? '/assets/' + entry.name : '/' + entry.name;
    files[url] = (await readFile(folder + '/' + entry.name)).toString('base64');
  }
}
await build({entryPoints:['src/server.mjs'],outfile:'dist/server/index.js',bundle:true,format:'esm',platform:'browser',define:{STATIC_FILES:JSON.stringify(files)}});
