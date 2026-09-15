// Local-only persistence. The injected adapter owns server authorization and idempotency.
export function createMobileUploadStore({name='bareun_receipt_upload_v1',adapter,indexedDB=globalThis.indexedDB,crypto=globalThis.crypto}={}){
 let opening,draining;const flights=new Map();
 const open=()=>opening||(opening=new Promise((resolve,reject)=>{const r=indexedDB.open(name,1);r.onupgradeneeded=()=>{const s=r.result.createObjectStore('uploads',{keyPath:'eventId'});s.createIndex('sha256','sha256')};r.onsuccess=()=>resolve(r.result);r.onerror=()=>{opening=null;reject(r.error)}}));
 async function transaction(mode,action){const db=await open();return new Promise((resolve,reject)=>{const tx=db.transaction('uploads',mode),s=tx.objectStore('uploads');let value;tx.oncomplete=()=>resolve(value);tx.onerror=tx.onabort=()=>reject(tx.error||new Error('storage_aborted'));try{action(s,v=>value=v)}catch(e){tx.abort();reject(e)}})}
 const get=id=>transaction('readonly',(s,done)=>{s.get(id).onsuccess=e=>done(e.target.result||null)});
 const list=()=>transaction('readonly',(s,done)=>{s.getAll().onsuccess=e=>done(e.target.result)});
 async function change(id,fn){return transaction('readwrite',(s,done)=>{s.get(id).onsuccess=e=>{const current=e.target.result;if(!current){done(null);return}const next=fn(current);s.put(next);done(next)}})}
 async function add(blob,{eventId=crypto.randomUUID(),fileName=blob.name||'receipt',context={}}={}){
  if(!(blob instanceof Blob)||!blob.size)throw Error('empty_photo');
  const bytes=await blob.arrayBuffer(),digest=await crypto.subtle.digest('SHA-256',bytes),sha256=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  const record={eventId,sha256,blob,fileName,mimeType:blob.type,size:blob.size,context:structuredClone(context),state:'queued',attempts:0,cancelRequested:false,createdAt:Date.now(),updatedAt:Date.now()};
  return transaction('readwrite',(s,done)=>{s.get(eventId).onsuccess=e=>{const old=e.target.result;if(old){if(old.sha256!==sha256||JSON.stringify(old.context)!==JSON.stringify(record.context)){done({conflict:true});return}done(old);return}s.add(record);done(record)}}).then(r=>{if(r.conflict)throw Error('event_id_conflict');return r});
 }
 async function adoptRemote(blob,receipt){
  if(!(blob instanceof Blob)||!blob.size||!receipt?.id||!Number.isInteger(receipt.revision)||receipt.cancelled||receipt.status==='cancelled')throw Error('invalid_remote_receipt');
  const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');
  if(!receipt.original?.sha256||receipt.original.sha256!==sha256)throw Error('original_sha_mismatch');
  const eventId='remote_'+receipt.id,record={eventId,sha256,blob,fileName:receipt.original.name||receipt.vendor||'영수증',mimeType:blob.type,size:blob.size,context:{remoteReceiptId:receipt.id},state:'uploaded',attempts:1,cancelRequested:false,createdAt:Date.now(),updatedAt:Date.now(),receipt:{...structuredClone(receipt),duplicate:false,eventId,sha256}};
  return transaction('readwrite',(s,done)=>{s.getAll().onsuccess=e=>{const old=e.target.result.find(r=>r.receipt?.id===receipt.id&&!r.receipt?.duplicate);if(old){done(old);return}s.add(record);done(record)}});
 }
 async function cancel(eventId){return change(eventId,r=>({...r,cancelRequested:true,state:r.attempts>0?'cancel-pending':'cancelled',updatedAt:Date.now()}))}
 async function run(eventId){
  if(!adapter)throw Error('upload_adapter_required');
  let row=await get(eventId);if(!row)throw Error('upload_missing');
  if(row.state==='cancelled')return row;
  // A previously attempted event can have reached the server despite a lost reply.
  if(row.cancelRequested&&row.attempts>0){if(typeof adapter.cancel!=='function')return change(eventId,r=>({...r,state:'cancel-pending',lastError:'cancel_adapter_required'}));try{const receipt=await adapter.cancel({eventId,sha256:row.sha256,context:row.context});if(!receipt||receipt.eventId!==eventId||receipt.cancelled!==true)throw Error('cancel_ack_mismatch');return change(eventId,r=>({...r,state:'cancelled',cancelReceipt:receipt,lastError:null,updatedAt:Date.now()}))}catch(e){await change(eventId,r=>({...r,state:'cancel-pending',lastError:String(e.message||e)}));throw e}}
  if(row.state==='uploaded')return row;
  row=await change(eventId,r=>r.cancelRequested?r:{...r,state:'uploading',attempts:r.attempts+1,lastError:null,updatedAt:Date.now()});
  if(row.cancelRequested)return row;
  try{const receipt=await adapter.upload({eventId,sha256:row.sha256,blob:row.blob,fileName:row.fileName,mimeType:row.mimeType,context:row.context});if(!receipt||receipt.eventId!==eventId||receipt.sha256!==row.sha256)throw Error('upload_ack_mismatch');const next=await change(eventId,r=>({...r,state:r.cancelRequested?'cancel-pending':'uploaded',receipt,lastError:null,updatedAt:Date.now()}));return next}
  catch(e){await change(eventId,r=>({...r,state:r.cancelRequested?'cancel-pending':e.permanent?'failed':'queued',lastError:String(e.message||e),updatedAt:Date.now()}));throw e}
 }
 function retry(eventId){if(flights.has(eventId))return flights.get(eventId);const work=(globalThis.navigator?.locks?globalThis.navigator.locks.request(name+':'+eventId,()=>run(eventId)):run(eventId)).finally(()=>flights.delete(eventId));flights.set(eventId,work);return work}
 function retryPending(){if(draining)return draining;draining=(async()=>{const results=[];for(const row of await list()){if(['queued','uploading','cancel-pending'].includes(row.state)){try{results.push({eventId:row.eventId,record:await retry(row.eventId)})}catch(error){results.push({eventId:row.eventId,error:String(error.message||error)})}}}return results})().finally(()=>draining=null);return draining}
 // Caller owns lifecycle: invoke retryPending on reconnect and on a backoff timer.
 async function close(){if(opening){const db=await opening;db.close();opening=null}}
 return {add,adoptRemote,get,list,cancel,retry,retryPending,close,dismissDuplicate:eventId=>change(eventId,r=>{if(!r.receipt?.duplicate)throw Error('not_duplicate');return {...r,state:'cancelled',localDismissed:true}}),saveDraft:(eventId,draft)=>change(eventId,r=>({...r,draft}))};
}
