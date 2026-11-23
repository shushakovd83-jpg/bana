import {excel} from './excel.mjs';
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
const vkReady=e=>Boolean(e.VK_TOKEN&&e.VK_ADMIN_PEER);
function queue(row,peer,message,kind='notice'){
 row.events.push({kind,peer,message,n:crypto.getRandomValues(new Uint32Array(1))[0]%2147483646+1});
}
const details=r=>r.day+' в '+r.start+' · '+r.hours+' ч · '+r.guestName+' · '+r.phone+' · гостей: '+r.guests;
async function drain(env){
 if(!vkReady(env))return;
 const {rows}=await read(env);
 for(const row of rows){
  const remaining=slot(row,false)-Date.now();
  if(row.status==='confirmed'&&remaining>0&&remaining<=86400000){
   await change(env,all=>{
    const r=all.find(x=>x.id===row.id);
    if(r.version!==row.version||r.status!=='confirmed')return {skip:true};
    let added=false;
    for(const peer of new Set([env.VK_ADMIN_PEER,r.peer].filter(Boolean).map(String))){
     const tag=r.day+'/'+r.start+'/'+peer;
     if(r.reminders.includes(tag))continue;
     r.reminders.push(tag);queue(r,peer,'Напоминание о визите в баню «Весна»: '+details(r),'reminder');added=true;
    }
    return {skip:!added};
   });
  }
 }
 for(const row of (await read(env)).rows){
  for(const event of row.events){
   await sendVK(env,event.peer,event.message,event.n);
   await change(env,all=>{const r=all.find(x=>x.id===row.id);r.events=r.events.filter(e=>e.n!==event.n);return {};});
  }
 }
}
async function body(req){
 if(!req.headers.get('content-type')?.includes('application/json'))fail(415,'Требуется JSON.');
 if(req.headers.get('origin')&&req.headers.get('origin')!==new URL(req.url).origin)fail(403,'Запрос отклонён.');
 if(Number(req.headers.get('content-length'))>8192)fail(413,'Слишком большой запрос.');
 const text=await req.text();if(text.length>8192)fail(413,'Слишком большой запрос.');
 try{const b=JSON.parse(text);if(!b||typeof b!=='object')throw Error();return b;}catch{fail(400,'Некорректная заявка.');}
}
function asset(path,privatePage=false){
 const data=STATIC_FILES[path];if(typeof data!=='string')return new Response('Страница не найдена',{status:404});
 const mime={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',webp:'image/webp',woff:'font/woff',txt:'text/plain'};
 return new Response(Uint8Array.from(atob(data),c=>c.charCodeAt(0)),{headers:{'Content-Type':mime[path.split('.').pop()]||'application/octet-stream','Cache-Control':privatePage?'private, no-store':'no-cache','X-Content-Type-Options':'nosniff'}});
}
async function route(req,env,ctx){
 const {pathname:p}=new URL(req.url);
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
   if(!prev){slot(data);rows.push(r);if(vkReady(env))queue(r,env.VK_ADMIN_PEER,'Новая заявка: '+details(r));}
   return {skip:!!prev,value:{id:r.id,...(vkReady(env)?{vkUrl:vkLink(r.token)}:{})}};
  });
  if(vkReady(env))ctx.waitUntil(drain(env));return json(result,201);
 }
 if(['/admin','/admin/','/admin.html','/api/admin','/api/export.xlsx'].includes(p)){
  const uid=req.headers.get('oai-authenticated-user-id');
  if(!uid&&!p.startsWith('/api/'))return new Response(null,{status:302,headers:{Location:'/signin-with-chatgpt?return_to=%2Fadmin','Cache-Control':'private, no-store'}});
  if(!uid||!env.JOURNAL_OWNER_EMAIL||req.headers.get('oai-authenticated-user-email')?.toLowerCase()!==env.JOURNAL_OWNER_EMAIL.toLowerCase())return json({error:'Доступ только для владельца.'},uid?403:401);
  if(p.startsWith('/admin')&&req.method==='GET')return asset('/admin.html',true);
  if(req.method==='GET'){
   const rows=(await read(env)).rows.map(({fingerprint,token,peer,events,reminders,...publicRow})=>publicRow).sort((a,b)=>b.created.localeCompare(a.created));
   if(p==='/api/admin')return json(rows);
   return new Response(excel(rows),{headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="vesna.xlsx"','Cache-Control':'private, no-store'}});
  }
  if(p==='/api/admin'&&req.method==='POST'){
   const b=await body(req);
   await change(env,rows=>{
    const r=rows.find(x=>x.id===b.id);if(!r)fail(404,'Заявка не найдена.');
    if(r.version!==b.version)fail(409,'Обновите журнал и повторите действие.');
    if(!['new','confirmed','cancelled'].includes(b.status))fail(400,'Некорректный статус.');
    const moved=b.day!==r.day||b.start!==r.start;
    const start=slot({...r,day:b.day,start:b.start},moved||b.status==='confirmed');
    if(b.status==='confirmed'&&rows.some(x=>x.id!==r.id&&x.status==='confirmed'&&slot(x,false)<start+r.hours*3600000&&slot(x,false)+x.hours*3600000>start))fail(409,'Время занято другой подтверждённой бронью.');
    if(moved)r.previous=r.day+' '+r.start;
    if(moved||b.status!=='confirmed'){r.events=r.events.filter(x=>x.kind!=='reminder');r.reminders=[];}
    Object.assign(r,{day:b.day,start:b.start,status:b.status,version:r.version+1});
    if(vkReady(env))for(const peer of new Set([env.VK_ADMIN_PEER,r.peer].filter(Boolean)))queue(r,peer,(moved?'Перенос с '+r.previous:'Статус: '+({confirmed:'подтверждена',new:'новая',cancelled:'отменена'}[r.status]))+'. '+details(r));
    return {};
   });if(vkReady(env))ctx.waitUntil(drain(env));return json({ok:true});
  }
  return json({error:'Метод недоступен.'},405);
 }
 if(p.startsWith('/api/'))return json({error:'Не найдено.'},404);
 if(req.method!=='GET')return new Response(null,{status:405});
 return asset(p==='/'?'/index.html':p);
}
export default {async fetch(req,env,ctx){try{return await route(req,env,ctx);}catch(e){return json({error:e.status?e.message:'Сервис временно недоступен. Попробуйте ещё раз.'},e.status||503);}},async scheduled(_,env,ctx){ctx.waitUntil(drain(env));}};
