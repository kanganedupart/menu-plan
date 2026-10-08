'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const source=fs.readFileSync(path.join(__dirname,'../menu-plan.html'),'utf8');
const badge=source.slice(source.indexOf('function setSyncBadge('),source.indexOf('function describeSaveError('));
function fixture(){
 let element=null,pending=false,failure=null;
 const context={syncState:'',sharedInputCore:{hasPending:()=>pending,failure:()=>failure},document:{getElementById:()=>element,querySelector:()=>({appendChild:el=>element=el}),createElement:()=>({style:{},dataset:{},setAttribute(){},removeAttribute(key){delete this[key];}})}};
 vm.createContext(context);vm.runInContext(badge,context);
 return {set:context.setSyncBadge,el:()=>element,pending:v=>pending=v,failure:v=>failure=v};
}
const a=fixture();a.pending(true);a.set('busy','입력 보관됨 · 공유 대기','menu');assert.equal(a.el().style.display,'inline-flex');assert.equal(a.el().dataset.state,'busy');a.set('ok','공유 저장됨','menu');assert.equal(a.el().style.display,'inline-flex','remaining input must not look saved');a.set('warn','메뉴 오류','menu');a.set('busy','발주 저장 중','order');assert.equal(a.el().textContent,'메뉴 오류','warning wins over busy');a.set('ok','','order');assert.equal(a.el().textContent,'메뉴 오류','order ACK cannot clear menu warning');a.pending(false);a.set('ok','','menu');assert.equal(a.el().style.display,'none');
const b=fixture();b.set('warn','연결 끊김','transport');b.set('busy','공유 대기','menu');b.set('ok','','transport');assert.equal(b.el().textContent,'공유 대기');assert.equal(b.el().dataset.state,'busy');b.set('warn','저장 지연','pending-save');b.set('ok','','menu');assert.equal(b.el().textContent,'저장 지연');b.set('ok','','pending-save');assert.equal(b.el().style.display,'none');
const c=fixture();c.set('warn','원문 기록 오류','menu');c.failure(Error('journal'));c.set('ok','','menu');assert.equal(c.el().textContent,'원문 기록 오류');c.failure(null);c.set('ok','','menu');assert.equal(c.el().style.display,'none');
const attach=source.slice(source.indexOf('let sharedTransportBound='),source.indexOf('let sharedUiSaveState='));
const values=[];let listeners=0,callback;
const context={sharedReconnect:{connection:value=>values.push(value)},firebase:{database:()=>({ref:p=>{assert.equal(p,'.info/connected');return {on:(event,fn)=>{assert.equal(event,'value');listeners++;callback=fn;}};}})}};
vm.createContext(context);vm.runInContext(attach,context);context.attachSharedTransport();context.attachSharedTransport();assert.equal(listeners,1);callback({val:()=>false});callback({val:()=>true});assert.deepEqual(values,[false,true]);assert.ok(!attach.includes('fbReady='),'transport must not reset bootstrap readiness');
assert.match(source,/sharedReconnect\.failed\(error\)/,'direct waiter failures must reach retry monitor');assert.match(source,/sharedReconnect\.failed\(e\)/,'background flush failures must reach retry monitor');
console.log('shared status visibility: busy, warning, scoped ACK and transport integration PASS');
