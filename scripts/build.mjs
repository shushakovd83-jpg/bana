import {build} from 'esbuild';
import {readFile,readdir} from 'node:fs/promises';
const files={};
for(const dir of ['', 'assets/']){
 for(const f of await readdir('dist/'+dir,{withFileTypes:true})){
  if(!f.isFile())continue;
  const path=dir+f.name;
  files['/'+path]=(await readFile('dist/'+path)).toString('base64');
 }
}
await build({entryPoints:['src/server.mjs'],outfile:'dist/server/index.js',bundle:true,format:'esm',platform:'browser',define:{STATIC_FILES:JSON.stringify(files)}});
