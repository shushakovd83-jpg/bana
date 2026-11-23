import http from 'node:http';
import {pathToFileURL} from 'node:url';
import service from './server.mjs';
import {openStorage} from './database.mjs';
import {adminAccess} from './admin-access.mjs';

export function start(settings = process.env) {
  const access = adminAccess(settings);
  const store = openStorage(settings.DATA_DIR || '/data');
  const env = {...settings, BUCKET:store.bucket, VK_SETTINGS_KEY:settings.VK_SETTINGS_KEY || store.key, ACCESS:access};
  const busy = new Set();
  function background(promise) {
    const handled = promise.catch(() => console.error('Ожидающие уведомления будут обработаны повторно.')).finally(() => busy.delete(handled));
    busy.add(handled);
  }
  let checking = false;
  async function tick() {
    if (checking) return;
    checking = true;
    try { await service.scheduled(null,env); } finally { checking = false; }
  }
  const server = http.createServer(async (input, output) => {
    try {
      const chunks = [];
      let size = 0;
      const maxBody = input.url === '/vk/callback' ? 131072 : 8192;
      for await (const part of input) {
        size += part.length;
        if (size > maxBody) { output.writeHead(413).end(); return; }
        chunks.push(part);
      }
      const method = input.method;
      // The static website is the only browser origin allowed to read private API responses.
      const path = new URL(input.url, 'http://localhost').pathname;
      const req = new Request('http://localhost'+path, {
        method, headers:input.headers,
        body:['GET','HEAD'].includes(method) ? undefined : Buffer.concat(chunks)
      });
      const result = await service.fetch(req,env,{address:input.socket.remoteAddress, waitUntil:background});
      output.writeHead(result.status, Object.fromEntries(result.headers));
      output.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      if (!output.headersSent) output.writeHead(503, {'Cache-Control':'no-store'});
      output.end();
    }
  });
  const timer = setInterval(() => background(tick()), 60000);
  timer.unref();
  server.listen(Number(settings.PORT ?? 3000), '0.0.0.0', () => background(tick()));
  return {server, async close() {
    clearInterval(timer);
    await new Promise(resolve => server.close(resolve));
    await Promise.all(busy);
    store.close();
  }};
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const app = start();
  process.once('SIGTERM', () => app.close().catch(() => { process.exitCode=1; }));
}
