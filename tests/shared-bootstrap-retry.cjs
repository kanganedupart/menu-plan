const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const src=fs.readFileSync(require('path').join(__dirname,'../menu-plan.html'),'utf8');const snippet=src.slice(src.indexOf('let sharedBootstrapFlight='),src.indexOf('/* 조리장이 짠 식단을')); 
function setup(failures=1,journalFailure=false){
 let probes=0,init=0,listeners=0,resolved=0,rejected=0,prepare=0,intervals=0,serial=0,applied=0;
 const timers=new Map(),events={},ref={once:async()=>({val:()=>({plan:{day:{}}})}),on:()=>listeners++};
 const c={Promise,Math,console,FB_ON:true,fbReady:false,fbRef:null,fbApplying:false,menuBootFailed:false,S:{start:'x',plan:{}},saveQueued:false,pendingRecoveryHold:false,pendingRemoteState:null,
 window:{FIREBASE_CONFIG:{},addEventListener:(n,f)=>events[n]=f},firebase:{apps:[],initializeApp(){init++;this.apps.push({})},database:()=>({ref:()=>ref})},
 setTimeout:(f,d)=>{timers.set(++serial,{f,d});return serial},clearTimeout:id=>timers.delete(id),setInterval:()=>intervals++,
 sharedPrepare:async()=>{prepare++;if(journalFailure)throw Error('JOURNAL_CORRUPT')},centralWriteProbe:async()=>{if(++probes<=failures)throw Error('NETWORK')},
 sharedResolveConnection:()=>resolved++,sharedRejectConnection:()=>rejected++,sharedInputCore:{hasPending:()=>true},queueSharedStateWrite:()=>{},
 decodeSharedStateFromFirebase:x=>x,stateRepairMissingTs:()=>{},sharedOverlayRemote:x=>x,applyRemoteState:()=>applied++,resetSharedStateForEmptyRemote:()=>{},dirtyReset:()=>{},stateClone:x=>x,
 setSyncBadge:()=>{},centralMarkReady:()=>{},centralMarkBlocked:()=>{},render:()=>{},bootRender:()=>{assert.equal(c.menuBootFailed,false,'successful retry must clear failure before rendering')},checkAppVersion:()=>{},applyPendingRemoteState:()=>{}};
 vm.createContext(c);vm.runInContext(snippet,c);
 return {c,events,timers,ref,applied:()=>applied,state:()=>({probes,init,listeners,resolved,rejected,prepare,intervals}),retry:async()=>{const row=[...timers].find(([,v])=>v.d<=30000);assert.ok(row);timers.delete(row[0]);row[1].f();await c.initFirebase();}};
}
(async()=>{
 const h=setup();await h.c.initFirebase();assert.equal(h.c.fbReady,false);assert.equal(h.state().rejected,0);assert.equal(h.timers.size,1);
 await h.retry();assert.equal(h.c.fbReady,true);assert.deepEqual(h.state(),{probes:2,init:1,listeners:1,resolved:1,rejected:0,prepare:2,intervals:1});
 await h.c.initFirebase();h.events.online();h.events.focus();assert.equal(h.state().listeners,1);assert.equal(h.state().init,1);
 const parallel=setup(0);await Promise.all([parallel.c.initFirebase(),parallel.c.initFirebase(),parallel.c.initFirebase()]);assert.equal(parallel.state().probes,1);
 const terminal=setup(0,true);await terminal.c.initFirebase();terminal.events.online();assert.equal(terminal.state().rejected,1);assert.equal(terminal.timers.size,0);assert.equal(terminal.state().probes,0);
 const backoff=setup(100);for(let i=0;i<9;i++){await backoff.c.initFirebase();assert.ok([...backoff.timers.values()].every(t=>t.d<=30000));await backoff.retry();}assert.equal(backoff.state().init,1);
 const wake=setup(1);await wake.c.initFirebase();wake.events.online();assert.equal([...wake.timers.values()][0].d,0);await wake.retry();assert.equal(wake.c.fbReady,true);
 const hung=setup(0);let lateResolve;hung.ref.once=()=>new Promise(r=>lateResolve=r);const flight=hung.c.initFirebase();
 for(let i=0;i<30;i++)await Promise.resolve();assert.equal(typeof lateResolve,'function');
 const deadline=[...hung.timers].find(([,t])=>t.d===20000);assert.ok(deadline);hung.timers.delete(deadline[0]);deadline[1].f();await flight;
 assert.equal(hung.c.fbReady,false);assert.equal(hung.state().rejected,0);assert.equal(hung.applied(),0);
 hung.ref.once=async()=>({val:()=>({plan:{fresh:{}}})});await hung.retry();assert.equal(hung.c.fbReady,true);assert.equal(hung.applied(),1);
 lateResolve({val:()=>({plan:{obsolete:{}}})});for(let i=0;i<10;i++)await Promise.resolve();assert.equal(hung.applied(),1);assert.equal(hung.state().listeners,1);
 assert.ok([...hung.timers.values()].every(t=>t.d!==20000),'network deadline timers cleaned');
 console.log(JSON.stringify({pass:true,cases:['transient retry','single SDK init/listener','concurrent init deduplication','durable corruption terminal','bounded backoff','online wake','hanging read timeout and reconnect','late old read cannot apply','deadline timer cleanup','failure cleared before render'],productionWrites:0}));
})().catch(e=>{console.error(e);process.exitCode=1});
