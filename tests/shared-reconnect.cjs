'use strict';
const assert=require('assert/strict'),create=require('../bareun-shared-reconnect.js');
function fixture(){
 let now=0,serial=0,hasPending=true,isReady=true,calls=0,action=async()=>{};
 const timers=new Map(),shown=[];
 const api=create({pending:()=>hasPending,ready:()=>isReady,retry:()=>{calls++;return action();},show:(...v)=>shown.push(v),setTimeout:(fn,delay)=>{timers.set(++serial,{fn,at:now+delay});return serial;},clearTimeout:id=>timers.delete(id)});
 async function tick(ms){const end=now+ms;let guard=0;while(true){const next=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;assert.ok(++guard<100,'no timer spin');now=next[1].at;timers.delete(next[0]);next[1].fn();for(let i=0;i<8;i++)await Promise.resolve();}now=end;}
 return {api,tick,shown,timers,calls:()=>calls,pending:v=>hasPending=v,ready:v=>isReady=v,action:fn=>action=fn};
}
(async()=>{
 const a=fixture();a.api.connection(false);a.api.begin();await a.tick(20000);assert.equal(a.calls(),0);assert.ok(a.shown.some(x=>x[2]==='pending-save'&&x[0]==='warn'));a.action(async()=>a.pending(false));a.api.connection(true);await a.tick(0);assert.equal(a.calls(),1);assert.equal(a.timers.size,0);
 const b=fixture();b.action(async()=>{throw Error('disconnect');});b.api.connection(true);await b.tick(0);assert.equal(b.calls(),1);await b.tick(999);assert.equal(b.calls(),1);await b.tick(1);assert.equal(b.calls(),2);await b.tick(1999);assert.equal(b.calls(),2);await b.tick(1);assert.equal(b.calls(),3);b.api.connection(false);await b.tick(30000);assert.equal(b.calls(),3);
 const c=fixture();c.ready(false);c.api.connection(true);await c.tick(3000);assert.equal(c.calls(),0);c.ready(true);await c.tick(1000);assert.equal(c.calls(),1);assert.ok(!c.shown.some(x=>x[2]==='pending-save'&&x[0]==='ok'),'pending is never ACKed by retry fulfillment');
 for(const error of ['SHARED_CONFLICT','permission denied','HASH_MISMATCH','SHARED_ACK_MISMATCH','journal timeout']){const d=fixture();d.action(async()=>{throw Error(error);});d.api.connection(true);await d.tick(60000);assert.equal(d.calls(),1,error);}
 const e=fixture();e.pending(false);e.api.connection(true);e.api.begin();e.api.failed(Error('network'));await e.tick(60000);assert.equal(e.calls(),0);assert.equal(e.timers.size,0);
 const f=fixture();let finish;f.action(()=>new Promise(r=>finish=r));f.api.connection(true);await f.tick(0);f.api.connection(false);f.api.connection(true);await f.tick(20000);assert.equal(f.calls(),1,'hung transaction remains single flight');assert.ok(f.shown.some(x=>x[0]==='warn'&&x[2]==='pending-save'));f.pending(false);finish();await f.tick(0);for(let i=0;i<8;i++)await Promise.resolve();assert.equal(f.timers.size,0);
 const g=fixture();g.action(async()=>false);g.api.connection(true);await g.tick(60000);assert.equal(g.calls(),1,'false result alone does not retry conflicts');
 console.log('shared reconnect: 7 scenarios PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});
