(function(root,factory){
 'use strict';
 if(typeof module==='object'&&module.exports)module.exports=factory;
 else root.createBareunSharedReconnect=factory;
})(typeof globalThis!=='undefined'?globalThis:this,function(options){
 'use strict';
 const later=options.setTimeout||setTimeout,cancel=options.clearTimeout||clearTimeout;
 let connected=null,retryTimer=null,watchdog=null,inflight=false,wanted=null,attempt=0;
 const pending=()=>!!options.pending();
 function clearRetry(){if(retryTimer!==null)cancel(retryTimer);retryTimer=null;wanted=null;}
 function settled(){
  if(pending())return false;
  clearRetry();if(watchdog!==null)cancel(watchdog);watchdog=null;attempt=0;
  options.show('ok','','pending-save');
  if(connected!==false)options.show('ok','','transport');
  return true;
 }
 function begin(){
  if(settled())return;
  if(watchdog!==null)return;
  watchdog=later(()=>{watchdog=null;if(!settled())options.show('warn','입력 보관됨 · 공유 저장 지연','pending-save');},10000);
 }
 function schedule(delay){
  if(settled()||connected===false)return;
  if(inflight){wanted=wanted===null?delay:Math.min(wanted,delay);return;}
  if(retryTimer!==null)return;
  retryTimer=later(()=>{retryTimer=null;run();},delay);
 }
 function transient(error){
  const raw=String(error&&((error.code||'')+' '+(error.message||''))||error||'');
  return !/conflict|permission|denied|hash|mismatch|journal|archive|quarantine/i.test(raw)&&/network|offline|disconnect|timeout|unavailable/i.test(raw);
 }
 function failed(error){
  if(settled())return;
  begin();
  if(!transient(error)){clearRetry();return;}
  options.show('warn','입력 보관됨 · 공유 저장 재시도 중','pending-save');
  schedule(Math.min(30000,1000*Math.pow(2,Math.min(attempt++,5))));
 }
 async function run(){
  if(settled()||connected===false)return;
  if(!options.ready()){schedule(1000);return;}
  if(inflight){wanted=1000;return;}
  inflight=true;begin();
  try{await options.retry();}catch(error){failed(error);}
  finally{inflight=false;const next=wanted;wanted=null;if(!settled()&&next!==null)schedule(next);}
 }
 function connection(value){
  connected=!!value;
  if(!connected){
   clearRetry();options.show('warn',pending()?'연결 끊김 · 입력은 보관됨':'공유 연결 끊김','transport');begin();
  }else{
   options.show('ok','','transport');
   if(!settled()){begin();schedule(0);}
  }
 }
 return {connection,begin,settled,failed};
});
