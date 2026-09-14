(function(root,factory){
 'use strict';
 if(typeof module==='object'&&module.exports)module.exports=factory;
 else root.createBareunOperationJournal=factory;
})(typeof globalThis!=='undefined'?globalThis:this,function createBareunOperationJournal(options){
 'use strict';
 options=options||{};
 const env=typeof globalThis!=='undefined'?globalThis:{};
 const idb=options.indexedDB||env.indexedDB;
 const crypto=options.crypto||env.crypto;
 const Encoder=options.TextEncoder||env.TextEncoder;
 const namespace=options.namespace||'default';
 const databaseName='bareun_operation_journal_v1';
 const maxPayloadBytes=4*1024*1024,maxAckedBytes=16*1024*1024,maxAckedCount=100;
 let opening=null;
 function error(message,code){const e=new Error(message);e.code=code;return e;}
 if(typeof namespace!=='string'||!namespace||namespace.length>128)throw error('작업 보관 구분이 올바르지 않습니다.','INVALID_NAMESPACE');
 function validId(id){if(typeof id!=='string'||!id||id.length>512)throw error('작업 번호가 올바르지 않습니다.','INVALID_ID');}
 async function digest(raw){
  if(!crypto||!crypto.subtle||typeof Encoder!=='function')throw error('작업 내용 검증을 사용할 수 없습니다.','HASH_UNAVAILABLE');
  const result=await crypto.subtle.digest('SHA-256',new Encoder().encode(raw));
  return Array.from(new Uint8Array(result),v=>v.toString(16).padStart(2,'0')).join('');
 }
 function open(){
  if(opening)return opening;
  const promise=new Promise((resolve,reject)=>{
   if(!idb){reject(error('작업 보관소를 사용할 수 없습니다.','IDB_UNAVAILABLE'));return;}
   let request,settled=false;
   try{request=idb.open(databaseName,1);}catch(e){reject(e);return;}
   request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains('operations'))db.createObjectStore('operations',{keyPath:'id'});if(!db.objectStoreNames.contains('meta'))db.createObjectStore('meta',{keyPath:'key'});};
   request.onerror=()=>{settled=true;reject(request.error||error('작업 보관소 열기에 실패했습니다.','OPEN_FAILED'));};
   request.onblocked=()=>{settled=true;reject(error('다른 창이 작업 보관소 열기를 막고 있습니다.','OPEN_BLOCKED'));};
   request.onsuccess=()=>{const db=request.result;if(settled){db.close();return;}db.onversionchange=()=>{db.close();opening=null;};resolve(db);};
  });
  opening=promise;promise.catch(()=>{if(opening===promise)opening=null;});return promise;
 }
 async function transaction(names,mode,enqueue){
  const db=await open();
  return new Promise((resolve,reject)=>{
   let tx,result,cause;
   try{
    tx=db.transaction(names,mode);
    tx.oncomplete=()=>resolve(result);
    tx.onabort=tx.onerror=()=>reject(cause||tx.error||error('작업 보관을 완료하지 못했습니다.','TRANSACTION_FAILED'));
    const abort=e=>{cause=e;try{tx.abort();}catch(_){reject(e);}};
    const guard=fn=>()=>{try{fn();}catch(e){abort(e);}};
    enqueue(tx,value=>{result=value;},abort,guard);
   }catch(e){reject(e);}
  });
 }
 async function read(id){return transaction(['operations'],'readonly',(tx,done)=>{const request=tx.objectStore('operations').get(id);request.onsuccess=()=>done(request.result);});}
 function known(record){return !!record&&record.schemaVersion===1&&typeof record.id==='string'&&typeof record.namespace==='string'&&
  typeof record.raw==='string'&&/^[a-f0-9]{64}$/.test(record.hash||'')&&Number.isSafeInteger(record.byteLength)&&record.byteLength>=0&&record.byteLength<=maxPayloadBytes&&
  Number.isSafeInteger(record.sequence)&&record.sequence>0&&(record.retainAcknowledged===undefined||typeof record.retainAcknowledged==='boolean')&&
  (record.state==='pending'||record.state==='acked');}
 async function verify(record,id,expectedHash){
  if(!record)throw error('보관한 작업을 찾지 못했습니다.','NOT_FOUND');
  if(!known(record)||record.id!==id)throw error('보관한 작업 정보가 올바르지 않습니다.','JOURNAL_CORRUPT');
  if(record.namespace!==namespace)throw error('다른 화면의 작업 번호와 충돌했습니다.','NAMESPACE_CONFLICT');
  if(expectedHash&&record.hash!==expectedHash)throw error('작업 내용이 달라 처리를 중단했습니다.','HASH_CONFLICT');
  if(new Encoder().encode(record.raw).byteLength!==record.byteLength||await digest(record.raw)!==record.hash)throw error('보관한 작업 내용 검증에 실패했습니다.','VERIFY_FAILED');
  let payload;try{payload=JSON.parse(record.raw);}catch(_){throw error('보관한 작업을 다시 읽을 수 없습니다.','JOURNAL_CORRUPT');}
  return {id:record.id,hash:record.hash,payload:payload,state:record.state,retainAcknowledged:record.retainAcknowledged===true};
 }
 function nextSequence(tx,guard,callback){const meta=tx.objectStore('meta'),request=meta.get('sequence');request.onsuccess=guard(()=>{const previous=request.result?request.result.value:0;if(!Number.isSafeInteger(previous)||previous<0||previous>=Number.MAX_SAFE_INTEGER)throw error('작업 순번을 확인할 수 없습니다.','SEQUENCE_INVALID');const next=previous+1;meta.put({key:'sequence',value:next});callback(next);});}
 async function put(id,payload,putOptions){
  // All mutable caller data is serialized synchronously BEFORE the first await.
  validId(id);
  if(putOptions!==undefined&&(!putOptions||typeof putOptions!=='object'||Array.isArray(putOptions)))throw error('작업 보존 옵션이 올바르지 않습니다.','RETENTION_OPTION_INVALID');
  const requestedRetention=putOptions&&putOptions.retainAcknowledged;
  if(requestedRetention!==undefined&&typeof requestedRetention!=='boolean')throw error('작업 보존 옵션이 올바르지 않습니다.','RETENTION_OPTION_INVALID');
  const retainAcknowledged=requestedRetention===true;
  let raw;try{raw=JSON.stringify(payload);}catch(_){throw error('작업 내용을 보관 가능한 형식으로 만들지 못했습니다.','PAYLOAD_INVALID');}
  if(typeof raw!=='string')throw error('작업 내용이 비어 있거나 지원하지 않는 형식입니다.','PAYLOAD_INVALID');
  if(typeof Encoder!=='function')throw error('작업 크기를 확인할 수 없습니다.','HASH_UNAVAILABLE');
  const byteLength=new Encoder().encode(raw).byteLength;
  if(byteLength>maxPayloadBytes)throw error('작업 한 건이 4 MiB를 초과하여 보관하지 못했습니다.','PAYLOAD_TOO_LARGE');
  const hash=await digest(raw);
  await transaction(['operations','meta'],'readwrite',(tx,done,abort,guard)=>{
   const store=tx.objectStore('operations'),request=store.get(id);
   request.onsuccess=guard(()=>{
    const old=request.result;
    if(old){if(!known(old))throw error('기존 작업 정보가 올바르지 않아 덮어쓰지 않습니다.','JOURNAL_CORRUPT');if(old.namespace!==namespace)throw error('다른 화면의 작업 번호와 충돌했습니다.','NAMESPACE_CONFLICT');if(old.hash!==hash||old.raw!==raw)throw error('같은 작업 번호에 다른 내용이 있어 덮어쓰지 않습니다.','ID_CONFLICT');if((old.retainAcknowledged===true)!==retainAcknowledged)throw error('같은 작업 번호의 보존 정책이 달라 변경하지 않습니다.','RETENTION_CONFLICT');done(true);return;}
    nextSequence(tx,guard,sequence=>{store.add({id,namespace,hash,raw,byteLength,state:'pending',sequence,retainAcknowledged,schemaVersion:1,createdAt:new Date().toISOString()});done(true);});
   });
  });
  const verified=await verify(await read(id),id,hash);
  if(verified.retainAcknowledged!==retainAcknowledged)throw error('작업 보존 정책의 재읽기 검증에 실패했습니다.','RETENTION_CONFLICT');
  return verified;
 }
 async function get(id){validId(id);return verify(await read(id),id);}
 async function latest(){
  const rows=await transaction(['operations'],'readonly',(tx,done)=>{const request=tx.objectStore('operations').getAll();request.onsuccess=()=>done(request.result||[]);});
  const records=rows.filter(record=>record.namespace===namespace);
  if(!records.length)return null;
  let selected=null,result=null;
  for(const record of records){
   if(!known(record))throw error('최신 입력을 확인할 수 없는 기록이 있어 복원을 중단합니다.','JOURNAL_CORRUPT');
   const checked=await verify(record,record.id);
   if(!selected||record.sequence>selected.sequence){selected=record;result=checked;}
  }
  return result;
 }
 async function pending(){
  const records=await transaction(['operations'],'readonly',(tx,done)=>{const request=tx.objectStore('operations').getAll();request.onsuccess=()=>done(request.result||[]);});
  const result=[];
  for(const record of records.filter(r=>r.namespace===namespace).sort((a,b)=>a.sequence-b.sequence)){
   if(!known(record))throw error('확인이 필요한 작업 기록이 있어 자동 재전송을 중단합니다.','JOURNAL_CORRUPT');
   if(record.state==='pending')result.push(await verify(record,record.id));
  }
  return result;
 }
 async function pruneAcked(){
  const rows=await transaction(['operations'],'readonly',(tx,done)=>{const r=tx.objectStore('operations').getAll();r.onsuccess=()=>done(r.result||[]);});
  const eligible=[];
  for(const row of rows){
   // Unknown, malformed, pending, or corrupt records are NEVER deletion candidates.
   if(!known(row)||row.state!=='acked'||row.retainAcknowledged===true)continue;
   if(new Encoder().encode(row.raw).byteLength!==row.byteLength||await digest(row.raw)!==row.hash)continue;
   eligible.push(row);
  }
  eligible.sort((a,b)=>b.sequence-a.sequence);
  let count=0,bytes=0,full=false;const remove=[];
  for(const row of eligible){if(!full&&count<maxAckedCount&&bytes+row.byteLength<=maxAckedBytes){count++;bytes+=row.byteLength;}else{full=true;remove.push(row);}}
  if(!remove.length)return;
  await transaction(['operations'],'readwrite',(tx,done,abort,guard)=>{
   const store=tx.objectStore('operations');
   for(const snapshot of remove){const request=store.get(snapshot.id);request.onsuccess=guard(()=>{const current=request.result;
    if(!current)return;
    if(!known(current)||current.state!=='acked'||current.retainAcknowledged===true||current.raw!==snapshot.raw||current.hash!==snapshot.hash||current.sequence!==snapshot.sequence||current.namespace!==snapshot.namespace)throw error('정리 중 작업이 변경되어 이전 기록을 보존합니다.','PRUNE_CONFLICT');
    store.delete(snapshot.id);
   });}
   done(true);
  });
 }
 async function ack(id,expectedHash){
  validId(id);if(!/^[a-f0-9]{64}$/.test(String(expectedHash||'')))throw error('확인할 작업 해시가 필요합니다.','INVALID_HASH');
  const checked=await read(id);await verify(checked,id,expectedHash);
  await transaction(['operations','meta'],'readwrite',(tx,done,abort,guard)=>{
   const store=tx.objectStore('operations'),request=store.get(id);
   request.onsuccess=guard(()=>{
    const current=request.result;
    if(!known(current)||current.namespace!==namespace||current.hash!==expectedHash||current.raw!==checked.raw||(current.retainAcknowledged===true)!==(checked.retainAcknowledged===true))throw error('작업 확인 중 내용이 변경되었습니다.','ACK_CONFLICT');
    if(current.state==='acked'){done(true);return;}
    nextSequence(tx,guard,sequence=>{store.put(Object.assign({},current,{state:'acked',sequence,ackedAt:new Date().toISOString()}));done(true);});
   });
  });
  const verified=await verify(await read(id),id,expectedHash);
  if(verified.state!=='acked'||verified.retainAcknowledged!==(checked.retainAcknowledged===true))throw error('작업 확인 결과를 다시 검증하지 못했습니다.','ACK_VERIFY_FAILED');
  await pruneAcked();
  return verified;
 }
 async function close(){const p=opening;opening=null;if(p)(await p).close();}
 return Object.freeze({put,pending,ack,get,latest,close,databaseName,namespace,maxPayloadBytes});
});
