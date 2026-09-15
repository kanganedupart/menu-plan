export function createTransport({base,namespace}){
 const root=new URL(base);if(root.search||root.hash||root.username||root.password||!root.pathname.endsWith('/receipt_v3')||!(root.protocol==='https:'||root.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(root.hostname)))throw Error('invalid_receipt_namespace');
 const pendingKey='bareunReceiptPending:'+base+(namespace?'?ns='+namespace:'');let pending={};try{if(typeof localStorage!=='undefined')pending=JSON.parse(localStorage.getItem(pendingKey)||'{}')}catch{throw Error('보관된 요청을 읽지 못했습니다. 다시 연결해 주세요.');}
 const persist=()=>{if(typeof localStorage!=='undefined')localStorage.setItem(pendingKey,JSON.stringify(pending))};
 const stable=value=>{const sort=v=>v&&typeof v==='object'?(Array.isArray(v)?v.map(sort):Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])]))):v;return JSON.stringify(sort(JSON.parse(JSON.stringify(value))))};
 const digestOf=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
 function manifest(id,meta){if(!/^receipt_[a-f0-9]{64}$/.test(id)||!meta||meta.id!==id||meta.sha!==id.slice(8)||!Number.isInteger(meta.size)||meta.size<1||meta.size>30*1024*1024||!Number.isInteger(meta.chunks)||meta.chunks!==Math.ceil(meta.size/(384*1024))||!['image/png','image/jpeg','image/webp','image/heic','image/heif'].includes(meta.mime))throw Error('영수증 원본 정보를 확인하지 못했습니다.');return meta}
 if(namespace&&(!['127.0.0.1','localhost','[::1]'].includes(root.hostname)||!/^demo-[a-zA-Z0-9_-]+$/.test(namespace)))throw Error('invalid_test_namespace');
 const suffix=namespace?'?ns='+encodeURIComponent(namespace):'';
 let stopped=false,timer;const listeners=new Set();
 async function request(key,method='GET',body,headers={}){const r=await fetch(base+'/'+key+'.json'+suffix,{method,headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000),redirect:'error'});if(!r.ok)throw Object.assign(Error('영수증 연결을 확인하지 못했습니다.'),{status:r.status});return r.json()}
 async function poll(){if(stopped)return;try{const records=Object.values(await request('status')||{});for(const fn of listeners)fn(records)}catch{}finally{if(!stopped)timer=setTimeout(poll,3000)}}
 async function queuedUpload(id,meta,eventId){const status=await request('status/'+id);if(!status)await request('inbox/'+id,'PUT',meta);return {...(status||{id,revision:0,status:'reading'}),duplicate:meta.eventId!==eventId}}
 async function upload({bytes,mime,name,sha,eventId}){
  if(typeof eventId!=='string'||!eventId.trim())throw Error('사진 접수 번호가 없습니다.');
  const digest=await digestOf(bytes);if(digest!==sha)throw Error('사진 보관 내용을 확인하지 못했습니다.');const id='receipt_'+digest;
  const prior=await request('uploads/'+id);if(prior){manifest(id,prior);return queuedUpload(id,prior,eventId);}
  const data=new Uint8Array(bytes),chunkSize=384*1024,chunks=Math.ceil(data.length/chunkSize);if(!chunks||data.length>30*1024*1024)throw Error('사진 용량은 30MB까지 가능합니다.');
  for(let i=0;i<chunks;i++){let text='';for(const x of data.subarray(i*chunkSize,(i+1)*chunkSize))text+=String.fromCharCode(x);await request('originals/'+id+'/'+i,'PUT',btoa(text))}
  const meta=manifest(id,{id,sha,mime,name,size:data.length,chunks,eventId,uploadedAt:Date.now()});
  try{await request('uploads/'+id,'PUT',meta,{'if-match':'null_etag'})}catch(error){const existing=await request('uploads/'+id).catch(()=>null);if(!existing)throw error;manifest(id,existing);return queuedUpload(id,existing,eventId);}
  return queuedUpload(id,meta,eventId);
 }
 async function action(kind,data){const key=await digestOf(new TextEncoder().encode(stable({kind,data})));let entry=pending[key];if(!entry){entry={eventId:crypto.randomUUID(),request:{action:kind,data,createdAt:Date.now()}};pending[key]=entry;try{persist()}catch{delete pending[key];throw Error('요청을 보관하지 못해 전송하지 않았습니다.');}}const eventId=entry.eventId;try{await request('requests/'+eventId,'PUT',entry.request)}catch{/* uncertain send: keep exact event ID and inspect response */}const deadline=Date.now()+25000;while(Date.now()<deadline){let result;try{result=await request('responses/'+eventId)}catch{}if(result){delete pending[key];try{persist()}catch{}if(result.error)throw Error(result.error);return result}await new Promise(r=>setTimeout(r,600))}throw Error('반영 여부를 아직 확인하지 못했습니다. 다시 시도하면 같은 요청을 확인합니다.');}
 return {upload,confirm:data=>action('confirm',data),cancel:data=>action('cancel',data),subscribe(fn){listeners.add(fn);if(listeners.size===1){stopped=false;void poll()}return()=>{listeners.delete(fn);if(!listeners.size){stopped=true;clearTimeout(timer)}}},async getOriginal(id){const meta=manifest(id,await request('uploads/'+id)),pieces=[];let size=0;for(let i=0;i<meta.chunks;i++){const encoded=await request('originals/'+id+'/'+i);if(typeof encoded!=='string'||encoded.length>524288||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw Error('영수증 사진 일부를 확인하지 못했습니다.');const raw=atob(encoded);size+=raw.length;if(size>meta.size)throw Error('영수증 사진 크기가 일치하지 않습니다.');pieces.push(Uint8Array.from(raw,x=>x.charCodeAt(0)))}const blob=new Blob(pieces,{type:meta.mime});if(size!==meta.size||await digestOf(await blob.arrayBuffer())!==meta.sha)throw Error('영수증 원본 사진이 일치하지 않습니다.');return blob}};
}

