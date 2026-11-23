import {readFile, writeFile} from 'node:fs/promises';

const read = path => readFile(new URL('../'+path, import.meta.url), 'utf8');
const images = {};
for (const name of ['steam','lounge','mirror','barrel']) {
  const bytes = await readFile(new URL('../assets/'+name+'.webp', import.meta.url));
  images[name] = 'data:image/webp;base64,'+bytes.toString('base64');
}
const font = await readFile(new URL('../assets/inter.woff', import.meta.url));
let css = (await read('style.css')).replaceAll('assets/inter.woff','data:font/woff;base64,'+font.toString('base64'));
let html = (await read('index.html')).replace(/^.*<link rel="preload".*\n/gm, '');
let site = (await read('site.js')).replace("'assets/' + key + '.webp'", 'embeddedPhotos[key]');
for (const [name, uri] of Object.entries(images)) {
  css = css.replaceAll('assets/'+name+'.webp',uri);
  html = html.replaceAll('assets/'+name+'.webp',uri);
}
const api = (await read('api.js')).replace("new URL('api-config.json', document.currentScript.src)", "new URL('https://shushakovd83-jpg.github.io/bana/api-config.json')");
html = html.replace('<link rel="stylesheet" href="style.css">', () => '<style>'+css+'</style>')
  .replace(/^\s*<script defer src="(?:api|site)\.js"><\/script>/gm, '')
  .replace('</body>', () => '<script>'+api+'\nconst embeddedPhotos='+JSON.stringify(images)+';\n'+site+'</script>\n</body>');
await writeFile(new URL('../downloads/vesna-offline.html',import.meta.url), html);
