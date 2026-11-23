import {syncWorkbook, downloadWorkbook} from './workbook.mjs';
import {setVKToken, vkCredentials} from './vk-settings.mjs';
import {sendVK, callback, vkLink} from './vk.mjs';
const KEY='private/journal-v1.json';
const json=(v,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'private, no-store'}});
function fail(status,message){throw Object.assign(new Error(message),{status});}
async function read(env){const obj=await env.BUCKET.get(KEY);return {etag:obj?.etag,rows:obj?await obj.json():[]};}
async function change(env,apply){
 for(let i=0;i<8;i++){
  const {etag,rows}=await read(env);
  const result=apply(rows);
  if(result.skip)return result.value;
  const stored=await env.BUCKET.put(KEY,JSON.stringify(rows),{onlyIf:etag?{etagMatches:etag}:{etagDoesNotMatch:'*'}});
  if(stored)return result.value;
 }
 fail(409,'Журнал обновляется. Повторите действие.');
}
function slot(b,checkFuture=true){
 const date=new Date(b.day+'T00:00:00Z');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(b.day)||!Number.isFinite(+date)||date.toISOString().slice(0,10)!==b.day||!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.start))fail(400,'Проверьте дату и время.');
 const minutes=Number(b.start.slice(0,2))*60+Number(b.start.slice(3));
 if(!Number.isInteger(b.hours)||b.hours<3||b.hours>13||minutes<600||minutes+b.hours*60>1380)fail(400,'Минимум 3 часа в период с 10:00 до 23:00.');
 const t=Date.parse(b.day+'T'+b.start+':00+05:00');
 if(checkFuture&&t<=Date.now())fail(400,'Выберите будущее время.');
 return t;
}
function validate(b){
 if(typeof b.id!=='string'||!/^\w{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(b.id))fail(400,'Некорректный номер заявки.');
 if(typeof b.guestName!=='string'||!b.guestName.trim()||b.guestName.length>80||typeof b.phone!=='string'||!/^\+?[0-9 ().-]{10,24}$/.test(b.phone)||!/^\d{10,15}$/.test(b.phone.replace(/\D/g,'')))fail(400,'Проверьте имя и номер телефона.');
 if(!Number.isInteger(b.guests)||b.guests<1||b.guests>12||!['bath','barrel'].includes(b.tariff))fail(400,'Проверьте тариф и число гостей.');
 slot(b,false);
 return Object.fromEntries(['id','day','start','hours','guests','guestName','phone','tariff'].map(k=>[k,b[k]]));
}
function queue(row, peer, message, kind = 'notice') {
 const n = crypto.getRandomValues(new Uint32Array(1))[0] % 2147483646 + 1;
 row.events.push({kind, peer, message, n});
}

function details(row) {
 const minutes = Number(row.start.slice(0, 2)) * 60 + Number(row.start.slice(3)) + row.hours * 60;
 const end = String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
 const barrel = row.tariff === 'barrel';
 const price = barrel ? 4500 + row.hours * 1500 : row.hours * 1800;
 return [row.day.split('-').reverse().join('.') + ', ' + row.start + '–' + end,
  row.guestName + ' · ' + row.phone, 'Гостей: ' + row.guests,
  (barrel ? 'Баня с кедровой бочкой' : 'Только баня') + ' · ' + price + ' ₽'].join('\n');
}

async function queueReminders(env, adminPeer) {
 await change(env, rows => {
  let added = false;
  for (const row of rows) {
   const remaining = slot(row, false) - Date.now();
   if (row.status !== 'confirmed' || remaining <= 0 || remaining > 86400000) continue;
   for (const peer of new Set([adminPeer, row.peer].filter(Boolean).map(String))) {
    const tag = row.day + '/' + row.start + '/' + peer;
    if (row.reminders.includes(tag)) continue;
    row.reminders.push(tag);
    queue(row, peer, 'Напоминание о визите в баню «Весна»:\n' + details(row), 'reminder');
    added = true;
   }
  }
  return {skip: !added};
 });
}

async function dispatch(env, bookingId, force = false) {
 const credentials = await vkCredentials(env);
 const result = {connected: !!credentials, sent: 0, failed: 0};
 if (!credentials) return result;
 if (!bookingId) await queueReminders(env, credentials.VK_ADMIN_PEER);

 const {rows} = await read(env);
 // Give the current booking the first send attempt, then retry other due events.
 const first = bookingId && rows.find(row => row.id === bookingId);
 const ordered = first ? [first, ...rows.filter(row => row !== first)] : rows;
 let attempts = 0;
 for (const row of ordered) {
  for (const event of row.events) {
   if (!force && event.retryAfter && Date.parse(event.retryAfter) > Date.now()) continue;
   if (++attempts > 10) return result;
   const peer = event.peer === 'admin' ? credentials.VK_ADMIN_PEER : event.peer;
   try {
    // VK uses the saved random_id to deduplicate parallel workers and retries.
    await sendVK(credentials, peer, event.message, event.n);
   } catch {
    await change(env, current => {
     const pending = current.find(r => r.id === row.id)?.events.find(e => e.n === event.n);
     if (!pending) return {skip:true};
     pending.attempts = (pending.attempts || 0) + 1;
     const delayMinutes = Math.min(360, 2 ** Math.min(pending.attempts - 1, 9));
     pending.retryAfter = new Date(Date.now() + delayMinutes * 60000).toISOString();
     return {};
    });
    result.failed++;
    continue;
   }
   await change(env, current => {
    const entry = current.find(r => r.id === row.id);
    if (!entry || !entry.events.some(e => e.n === event.n)) return {skip: true};
    entry.events = entry.events.filter(e => e.n !== event.n);
    if (event.kind === 'booking') entry.adminNotifiedAt = new Date().toISOString();
    return {};
   });
   result.sent++;
  }
 }
 return result;
}

const pagesOrigin = 'https://shushakovd83-jpg.github.io';
function publicFileRequest(req) {
 return req.headers.get('origin') === 'null' && new URL(req.url).pathname === '/api/bookings';
}
function allowedOrigin(req, env) {
 const origin = req.headers.get('origin');
 return !origin || publicFileRequest(req) || origin === (env.PAGES_ORIGIN || pagesOrigin) || origin === new URL(req.url).origin;
}
async function body(req){
 if(!req.headers.get('content-type')?.includes('application/json'))fail(415,'Требуется JSON.');
 if(Number(req.headers.get('content-length'))>8192)fail(413,'Слишком большой запрос.');
 const text=await req.text();if(text.length>8192)fail(413,'Слишком большой запрос.');
 try{const b=JSON.parse(text);if(!b||typeof b!=='object')throw Error();return b;}catch{fail(400,'Некорректная заявка.');}
}
async function route(req,env,ctx){
 const {pathname:p}=new URL(req.url);
 if (!allowedOrigin(req, env)) fail(403,'Запрос отклонён.');
 if (req.method === 'GET' && ['/', '/admin', '/admin/'].includes(p)) {
  const destination=pagesOrigin + '/bana/' + (p === '/' ? '' : 'admin/');
  return new Response(null,{status:302,headers:{Location:destination,'Cache-Control':'no-store'}});
 }
 if (p === '/health' && req.method === 'GET') return json({service:'vesna-bookings', ready:true});
 if (p === '/api/session' && req.method === 'POST') {
  const data=await body(req);
  return json(env.ACCESS.signIn(data.password, ctx.address));
 }
 if (p === '/api/session' && req.method === 'DELETE') {
  env.ACCESS.signOut(req);
  return json({ok:true});
 }
 if(p==='/vk/callback')return callback(req,env,(token,peer)=>change(env,rows=>{
  const row=rows.find(r=>r.token===token);
  if(!row||row.peer)return {skip:true};row.peer=peer;return {};
 }));
 if(p==='/api/bookings'&&req.method==='POST'){
  const data=validate(await body(req));const fingerprint=JSON.stringify(data);
  const result=await change(env,rows=>{
   const prev=rows.find(r=>r.id===data.id);
   if(prev&&prev.fingerprint!==fingerprint)fail(409,'Используйте новый номер заявки.');
   const r=prev||{...data,fingerprint,status:'new',version:1,previous:'',created:new Date().toISOString(),events:[],reminders:[],token:crypto.randomUUID()};
   if (!prev) {
    slot(data);
    queue(r, 'admin', 'Новая заявка в баню «Весна»\n' + details(r), 'booking');
    rows.push(r);
   }
   return {skip:!!prev,value:{id:r.id,...(env.VK_GROUP_ID && env.VK_CALLBACK_SECRET && env.VK_CONFIRMATION ? {vkUrl:vkLink(r.token)} : {})}};
  });
  await syncWorkbook(env, read);
  ctx.waitUntil(dispatch(env, data.id));
  return json(result,201);
 }
 if (['/api/admin','/api/export.xlsx','/api/admin/vk','/api/admin/vk/retry'].includes(p)) {
  const role=env.ACCESS.role(req);
  if (!role) return json({error:'Войдите в журнал.'},401);
  if (p.startsWith('/api/admin/vk') && role !== 'owner') return json({error:'Настройки ВК доступны владельцу.'},403);
  if (p === '/api/admin/vk' && req.method === 'GET') {
   const credentials = await vkCredentials(env);
   const {rows} = await read(env);
   const pending = rows.reduce((n,r) => n + r.events.length, 0);
   return json({connected: !!credentials, pending});
  }
  if (p === '/api/admin/vk' && req.method === 'POST') {
   const {token} = await body(req);
   await setVKToken(env, token);
   ctx.waitUntil(dispatch(env));
   return json({connected: true});
  }
  if (p === '/api/admin/vk/retry' && req.method === 'POST') {
   await body(req);
   return json(await dispatch(env, undefined, true));
  }
  if (p === '/api/export.xlsx' && req.method === 'GET') return downloadWorkbook(env, read);
  if (p === '/api/admin' && req.method === 'GET') {
   const {rows} = await read(env);
   return json(rows.map(({fingerprint,token,peer,events,reminders,...r}) => ({...r,
    notification: r.adminNotifiedAt ? 'sent' : events.some(e => e.kind === 'booking') ? 'pending' : 'unknown'
   })).sort((a,b) => b.created.localeCompare(a.created)));
  }
  if(p==='/api/admin'&&req.method==='POST'){
   const b=await body(req);
   await change(env,rows=>{
    const r=rows.find(x=>x.id===b.id);if(!r)fail(404,'Заявка не найдена.');
    if (r.version !== b.version) {
     // An earlier attempt may have stored the change before the workbook was ready.
     if (r.version === b.version + 1 && r.day === b.day && r.start === b.start && r.status === b.status) return {skip:true};
     fail(409,'Обновите журнал и повторите действие.');
    }
    if(!['new','confirmed','cancelled'].includes(b.status))fail(400,'Некорректный статус.');
    const moved=b.day!==r.day||b.start!==r.start;
    const start=slot({...r,day:b.day,start:b.start},moved||b.status==='confirmed');
    if(b.status==='confirmed'&&rows.some(x=>x.id!==r.id&&x.status==='confirmed'&&slot(x,false)<start+r.hours*3600000&&slot(x,false)+x.hours*3600000>start))fail(409,'Время занято другой подтверждённой бронью.');
    if(moved)r.previous=r.day+' '+r.start;
    if(moved||b.status!=='confirmed'){r.events=r.events.filter(x=>x.kind!=='reminder');r.reminders=[];}
    Object.assign(r,{day:b.day,start:b.start,status:b.status,version:r.version+1});
    for(const peer of new Set(['admin',r.peer].filter(Boolean)))queue(r,peer,(moved?'Перенос с '+r.previous:'Статус: '+({confirmed:'подтверждена',new:'новая',cancelled:'отменена'}[r.status]))+'. '+details(r));
    return {};
   });
   await syncWorkbook(env, read);
   ctx.waitUntil(dispatch(env, b.id));
   return json({ok:true});
  }
  return json({error:'Метод недоступен.'},405);
 }
 return json({error:'Страница не найдена.'},404);
}
export default {
 async fetch(req, env, ctx) {
  const fromPages = req.headers.get('origin') === (env.PAGES_ORIGIN || pagesOrigin) || publicFileRequest(req);
  const preflight = fromPages && req.method === 'OPTIONS';
  let response;
  try {
   response = preflight ? new Response(null, {status:204}) : await route(req, env, ctx);
  } catch (e) {
   response = json({error:e.status ? e.message : 'Сервис временно недоступен. Попробуйте ещё раз.'},e.status || 503);
  }
  if (fromPages) {
   response.headers.set('Access-Control-Allow-Origin', req.headers.get('origin'));
   response.headers.append('Vary', 'Origin');
   if (preflight) {
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
   }
  }
  return response;
 },
 async scheduled(_,env) { await syncWorkbook(env, read); return dispatch(env); }
};
