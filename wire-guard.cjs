'use strict';
// Firebase WebSocket containment for the isolated verification harness only.
function createWireGuard(options){
 const {scope,send,onViolation}=options;
 if(!/^\/menuplan\/_verification_sync\/[a-f0-9]{40}$/.test(scope))throw Error('Invalid isolated scope');
 if(typeof send!=='function'||typeof onViolation!=='function')throw Error('Wire callbacks required');
 const maxFrames=options.maxFrames??128,maxChars=options.maxChars??2097152,timeoutMs=options.timeoutMs??10000;
 if(!Number.isInteger(maxFrames)||maxFrames<2||maxFrames>1024||!Number.isInteger(maxChars)||maxChars<1||maxChars>16777216||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw Error('Invalid guard bounds');
 const timers=options.timers||{setTimeout,clearTimeout};
 let closed=false,count=0,frames=[],parts=[],chars=0,timer=null;
 function clear(){if(timer!==null)timers.clearTimeout(timer);timer=null;count=0;frames=[];parts=[];chars=0}
 function fail(error){if(closed)return false;closed=true;clear();onViolation(error instanceof Error?error:new Error(String(error)));return false}
 function validate(text){
  const msg=JSON.parse(text);
  if(!msg||typeof msg!=='object'||Array.isArray(msg)||!['d','c'].includes(msg.t))throw Error('Unexpected Firebase wire envelope');
  if(msg.t==='d'){
   const action=msg.d?.a,p=msg.d?.b?.p;
   if(typeof action!=='string')throw Error('Missing Firebase action');
   if(p!==undefined){
    if(typeof p!=='string')throw Error('Non-string Firebase path');
    const normalized='/'+p.replace(/^\//,'');
    if(normalized.split('/').some(segment=>segment==='.'||segment==='..'))throw Error('Noncanonical Firebase path');
    if(!(normalized===scope||normalized.startsWith(scope+'/')||(normalized==='/.info/connected'&&['q','n'].includes(action))))throw Error('Blocked Firebase path '+normalized);
    if(options.onPath)options.onPath({action,path:normalized});
   }else if(['p','m','q','n','o','om','oc'].includes(action))throw Error('Missing Firebase path '+action);
  }
 }
 function push(message){
  if(closed)return false;
  try{
   if(typeof message!=='string'&&!Buffer.isBuffer(message))throw Error('Unexpected WebSocket message type');
   const text=String(message);
   if(count){
    chars+=text.length;if(chars>maxChars)throw Error('Firebase frame payload exceeds bound');
    frames.push(message);parts.push(text);
    if(parts.length<count)return true;
    validate(parts.join(''));
    const ready=frames.slice();clear();for(const frame of ready)send(frame);return true;
   }
   if(text==='0'){send(message);return true}
   if(/^\d+$/.test(text)){
    const n=Number(text);if(!Number.isSafeInteger(n)||n<2||n>maxFrames)throw Error('Firebase frame count exceeds bound');
    count=n;frames=[message];parts=[];chars=0;
    timer=timers.setTimeout(()=>fail(Error('Firebase fragmented message timed out')),timeoutMs);return true;
   }
   if(text.length>maxChars)throw Error('Firebase payload exceeds bound');
   validate(text);send(message);return true;
  }catch(e){return fail(e)}
 }
 return {push,close(){closed=true;clear()},get closed(){return closed}};
}
module.exports={createWireGuard};
