const tool = {
  name:'process_booking_notifications',
  description:'Обновить закрытый Excel, отправить ожидающие уведомления о заявках и напоминания по подтверждённым броням. Возвращает только состояние доставки.',
  inputSchema:{type:'object', properties:{}, additionalProperties:false}
};

export async function notificationTool(request, authorized, processQueue) {
  if (request.method !== 'POST') return new Response(null, {status:405, headers:{Allow:'POST'}});
  let rpc;
  try { rpc = await request.json(); } catch { return new Response(null, {status:400}); }
  const headers = {'Cache-Control':'private, no-store'};
  const reply = result => Response.json({jsonrpc:'2.0', id:rpc?.id ?? null, result}, {headers});
  const error = (code, message) => Response.json({jsonrpc:'2.0', id:rpc?.id ?? null, error:{code,message}}, {headers});
  if (!rpc || rpc.jsonrpc !== '2.0') return error(-32600, 'Invalid request');
  if (rpc.method === 'server/discover') return reply({supportedVersions:['2026-07-28'],capabilities:{tools:{}}});
  if (rpc.method === 'tools/list') return reply({tools:[tool]});
  if (rpc.method !== 'tools/call') return error(-32601, 'Method not found');
  if (!authorized) return new Response(null, {status:403, headers});
  if (rpc.params?.name !== tool.name || Object.keys(rpc.params.arguments ?? {}).length) return error(-32602, 'Invalid tool call');
  try {
    const result = await processQueue();
    return reply({content:[{type:'text',text:JSON.stringify(result)}]});
  } catch {
    return reply({isError:true, content:[{type:'text',text:'Обработка прервана. Повторите вызов.'}]});
  }
}
