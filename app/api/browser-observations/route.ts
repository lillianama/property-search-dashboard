import { parseObservation, validToken } from '../../../lib/browser-observations';
import { saveObservation } from '../../../lib/browser-observation-writes';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store', 'Vary': 'Origin' };
function origin(request: Request) {
  const id = process.env.BROWSER_OBSERVATION_EXTENSION_ID;
  const supplied = request.headers.get('origin');
  return id && /^[a-p]{32}$/.test(id) && supplied === `chrome-extension://${id}` ? supplied : null;
}
export async function OPTIONS(request: Request) {
  const o = origin(request); if (!o) return new Response(null,{status:403,headers});
  return new Response(null,{status:204,headers:{...headers,'Access-Control-Allow-Origin':o,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type'}});
}
export async function POST(request: Request) {
  const o = origin(request); if (!o) return Response.json({error:'forbidden'},{status:403,headers});
  const h = {...headers,'Access-Control-Allow-Origin':o};
  if (!validToken(request.headers.get('authorization'),process.env.BROWSER_OBSERVATION_TOKEN)) return Response.json({error:'unauthorized'},{status:401,headers:h});
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return Response.json({error:'invalid request'},{status:400,headers:h});
  try {
    const reader = request.body?.getReader(); if (!reader) throw Error();
    let size = 0; const chunks: Uint8Array[] = [];
    while (true) { const {done,value} = await reader.read(); if (done) break; size += value.length; if (size > 4096) { await reader.cancel(); throw Error(); } chunks.push(value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
    const parsed = parseObservation(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
    if (!parsed) throw Error();
    try { return Response.json(await saveObservation(parsed),{headers:h}); } catch { return Response.json({error:'unavailable'},{status:503,headers:h}); }
  } catch { return Response.json({error:'invalid request'},{status:400,headers:h}); }
}
