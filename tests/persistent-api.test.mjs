import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {start} from '../src/http.mjs';

test('Pages can submit in one click, restart preserves Excel and staff cannot change VK', async () => {
  const directory = await mkdtemp(join(tmpdir(),'vesna-api-'));
  const origin='https://shushakovd83-jpg.github.io';
  const settings={PORT:'0', DATA_DIR:directory, ADMIN_PASSWORD:'owner-password-test-123', STAFF_PASSWORD_1:'staff-password-test-123'};
  let app; let base;
  async function launch() {
    app=start(settings);
    if (!app.server.listening) await once(app.server,'listening');
    base='http://127.0.0.1:'+app.server.address().port;
  }
  function call(path, method = 'GET', body, token) {
    return fetch(base+path, {method,headers:{origin,'Content-Type':'application/json',...(token ? {Authorization:'Bearer '+token} : {})},
      ...(body ? {body:JSON.stringify(body)} : {})});
  }
  try {
    await launch();
    assert.equal((await call('/health')).status,200);
    const preflight=await call('/api/bookings','OPTIONS');
    assert.equal(preflight.status,204);assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),origin);
    const data = {id:crypto.randomUUID(),day:'2099-03-05',start:'17:00',hours:3,guests:8,guestName:'Тест',phone:'+7 (000) 000-00-00',tariff:'bath'};
    assert.equal((await call('/api/bookings','POST',data)).status,201);
    await app.close();app=null;await launch();
    assert.equal((await call('/api/bookings','POST',data)).status,201);
    assert.equal((await call('/api/export.xlsx')).status,401);
    const login=await call('/api/session','POST',{password:settings.STAFF_PASSWORD_1});
    const {token,role}=await login.json();
    assert.equal(role,'staff');
    assert.equal((await call('/api/admin/vk','GET',null,token)).status,403);
    const journal=await (await call('/api/admin','GET',null,token)).json();
    assert.equal(journal.length,1);assert.equal(journal[0].id,data.id);
    const result=await call('/api/export.xlsx','GET',null,token);
    assert.equal(result.status,200);
    const file=Buffer.from(await result.arrayBuffer());
    assert.equal(file.toString('ascii',0,2),'PK');
    assert.ok(file.includes(Buffer.from(data.phone)));
    assert.equal((await call('/api/session','DELETE',null,token)).status,200);
    assert.equal((await call('/api/admin','GET',null,token)).status,401);
  } finally { if(app) await app.close(); await rm(directory,{recursive:true,force:true}); }
});
