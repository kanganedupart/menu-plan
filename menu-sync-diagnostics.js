(function(){
 'use strict';
 const clone=x=>JSON.parse(JSON.stringify(x)),messages={
  'confirmation-source-changed':'확정할 때의 식단과 현재 공유 식단이 다릅니다.',
  'retained-confirmed-menu-changed':'이미 확정된 식단과 다른 수정이 보관되어 있습니다.',
  'legacy-confirmation-deletion-held':'이전 버전의 확정 해제 기록을 보호하고 있습니다.',
  'menu-parent-or-slot-changed':'다른 기기에서 메뉴 분류가 변경되었습니다.',
  dependent:'앞선 미공유 입력을 먼저 확인해야 합니다.',conflict:'다른 기기의 저장 내용과 겹칩니다.'
 };
 function reason(row){return messages[row.reason]||'저장 결과를 확인하지 못했습니다.';}
 function pathText(path){return (path||[]).map(x=>({plan:'식단',confirmed:'주간 확정',fix:'메뉴 정보',alg:'알레르기',slot:'분류',slotUser:'사용자 분류'})[x]||String(x)).join(' · ');}
 function weekSummary(local,remote,ws){
  const result={week:ws,localConfirmed:!!((local.confirmed||{})[ws]),sharedConfirmed:remote?!!((remote.confirmed||{})[ws]):null,menuDifferences:[],confirmationEqual:null,localConfirmation:clone((local.confirmed||{})[ws]||null),sharedConfirmation:remote?clone((remote.confirmed||{})[ws]||null):null};
  if(!remote)return result;
  const canonical=x=>{if(x===null||x===undefined)return null;if(typeof x!=='object')return x;const v={};for(const k of Object.keys(x).sort()){const child=canonical(x[k]);if(child!==null&&!(typeof child==='object'&&!Object.keys(child).length))v[k]=child;}return Object.keys(v).length?v:null;};
  const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
  result.confirmationEqual=same((local.confirmed||{})[ws],(remote.confirmed||{})[ws]);
  for(let i=0;i<7;i++){const date=new Date(Date.parse(ws+'T00:00:00Z')+i*86400000).toISOString().slice(0,10);for(const meal of ['조식','점심','저녁']){const names=root=>((((root.plan||{})[date]||{})[meal]||{}).items||[]).map(x=>typeof x==='string'?x:x.n);const a=names(local),b=names(remote);if(!same(a,b))result.menuDifferences.push({date,meal,local:a,shared:b});}}
  return result;
 }
 function timeout(promise,label){let timer;return Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error(label+' 응답이 늦습니다.')),8000))]).finally(()=>clearTimeout(timer));}
 async function readJournal(){
  if(!indexedDB.databases)throw Error('이 브라우저에서는 기존 기록 보관소를 확인할 수 없습니다.');
  const dbs=await indexedDB.databases();if(!dbs.some(x=>x.name==='bareun_operation_journal_v1'))return [];
  return new Promise((resolve,reject)=>{let db,tx,done=false;const end=(error,value)=>{if(done)return;done=true;clearTimeout(timer);if(db)db.close();error?reject(error):resolve(value)};const timer=setTimeout(()=>{if(tx)try{tx.abort()}catch(_){}end(Error('기록 읽기 시간이 초과됐습니다.'))},8000);const request=indexedDB.open('bareun_operation_journal_v1');request.onupgradeneeded=()=>{request.transaction.abort();end(Error('기존 기록 보관소가 없습니다.'))};request.onerror=()=>end(request.error);request.onblocked=()=>end(Error('기록 보관소를 읽을 수 없습니다.'));request.onsuccess=()=>{db=request.result;if(done){db.close();return}if(!db.objectStoreNames.contains('operations')){end(Error('기록이 없습니다.'));return}tx=db.transaction('operations','readonly');let rows=[];const get=tx.objectStore('operations').getAll();get.onsuccess=()=>{rows=get.result.filter(r=>['shared-menu','shared-menu-resolutions','shared-menu-preserved-inputs'].includes(r.namespace))};tx.oncomplete=()=>end(null,rows);tx.onerror=tx.onabort=()=>end(tx.error||Error('기록 읽기 실패'));};});
 }
 async function collect(){
  const local=clone(S),detail=sharedInputCore.pendingDetails(),report={schema:'bareun-sync-diagnostic-v2',at:new Date().toISOString(),build:APP_BUILD,origin:location.origin,browser:navigator.userAgent,bootReady:!!fbReady,connected:null,pending:detail,issues:clone(setSyncBadge.issues||{}),weeks:[],journal:[],errors:[]};
  let remote=null;
  try{report.connected=!!(await timeout(firebase.database().ref('.info/connected').once('value'),'연결 확인')).val();if(report.connected&&fbRef){remote=decodeSharedStateFromFirebase((await timeout(fbRef.once('value'),'공유 식단 조회')).val());report.sharedReadAt=new Date().toISOString();}}catch(e){report.errors.push('공유 조회: '+e.message)}
  const ws=/^\d{4}-\d{2}-\d{2}$/.test(local.start||'')?local.start:null;
  if(ws)for(const week of [addDays(ws,-7),ws])report.weeks.push(weekSummary(local,remote,week));
  try{report.journal=await readJournal()}catch(e){report.errors.push('기록 조회: '+e.message)}
  return report;
 }
 let opened=null;
 function show(){
  if(opened)return;const prior=document.activeElement,overlay=document.createElement('div');opened=overlay;overlay.id='bareunSyncDiagnostic';
  overlay.style.cssText='position:fixed;inset:0;z-index:99999;background:#0005;display:flex;align-items:center;justify-content:center;padding:18px';
  const panel=document.createElement('section');panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-labelledby','bareunSyncDiagnosticTitle');panel.tabIndex=-1;panel.style.cssText='background:white;color:#203a30;border-radius:14px;padding:24px;max-width:650px;width:100%;max-height:85vh;overflow:auto;font:15px/1.6 sans-serif';overlay.appendChild(panel);
  const title=document.createElement('h2');title.id='bareunSyncDiagnosticTitle';title.textContent='식단 공유 상태';title.style.marginTop='0';panel.appendChild(title);
  const body=document.createElement('div');body.setAttribute('aria-live','polite');body.textContent='현재 공유 상태를 읽고 있습니다…';panel.appendChild(body);
  const controls=document.createElement('div');controls.style.cssText='display:flex;gap:10px;margin-top:20px';panel.appendChild(controls);
  function button(text,fn){const b=document.createElement('button');b.textContent=text;b.type='button';b.style.cssText='padding:10px 16px;border:1px solid #cdd8d2;border-radius:8px;background:white;color:inherit;font:inherit;cursor:pointer';b.onclick=fn;controls.appendChild(b);return b;}
  let report=null;const download=button('점검 파일 받기',()=>{if(!report)return;const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='바른식당_공유점검_'+report.at.replace(/[:.]/g,'-')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000)});download.disabled=true;
  function close(){document.removeEventListener('keydown',keys,true);overlay.remove();opened=null;if(prior&&prior.isConnected)prior.focus();}
  const closeButton=button('닫기',close);
  function keys(e){if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();return}if(e.key==='Tab'){const items=[download,closeButton].filter(b=>!b.disabled),first=items[0],last=items[items.length-1];if(e.shiftKey&&(document.activeElement===first||document.activeElement===panel)){e.preventDefault();last.focus()}else if(!e.shiftKey&&(document.activeElement===last||document.activeElement===panel)){e.preventDefault();first.focus()}}}
  document.addEventListener('keydown',keys,true);document.body.appendChild(overlay);panel.focus();
  function line(text){const p=document.createElement('p');p.textContent=text;p.style.cssText='margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere';body.appendChild(p);}
  collect().then(r=>{if(!overlay.isConnected)return;report=r;body.textContent='';line('공유 연결: '+(r.connected===true?'연결됨':r.connected===false?'연결되지 않음':'확인하지 못함'));line('이 브라우저에 남은 미공유 입력: '+r.pending.pending.length+'건'+(r.pending.staged.length?' · 보관 중 '+r.pending.staged.length+'건':''));
   for(const block of r.pending.blocked||[]){line(reason(block));for(const item of block.details||[])line(pathText(item.path)+' — '+reason(item));if(!(block.details||[]).length)for(const p of block.paths||[])line(pathText(p));}
   if(r.pending.pending.length&&!(r.pending.blocked||[]).length)line('미공유 입력이 있습니다. 아직 막힌 위치를 확인하지 못했습니다.');
   for(const w of r.weeks){line(w.week+' 시작 주: 이 화면 '+(w.localConfirmed?'확정':'미확정')+' / 공유 '+(w.sharedConfirmed===null?'조회 못함':w.sharedConfirmed?'확정':'미확정'));if(w.sharedConfirmed!==null){line(w.menuDifferences.length?'공유 식단과 다른 끼니: '+w.menuDifferences.length+'개':'표시된 메뉴가 공유 식단과 같습니다.');for(const d of w.menuDifferences)line(d.date+' '+d.meal+'\n이 화면: '+d.local.join(', ')+'\n공유: '+d.shared.join(', '));if(w.localConfirmed&&w.sharedConfirmed&&!w.confirmationEqual)line('확정 기록의 내용 또는 시각이 서로 다릅니다.');}}
   for(const e of r.errors)line(e);line('버전: '+r.build);download.disabled=false;
  }).catch(e=>{if(overlay.isConnected)body.textContent='점검 정보를 읽지 못했습니다. '+e.message;});
 }
 document.addEventListener('click',e=>{if(e.target.closest&&e.target.closest('#syncBadge')){e.preventDefault();show();}});
 document.addEventListener('keydown',e=>{if(e.target.id==='syncBadge'&&(e.key==='Enter'||e.key===' ')){e.preventDefault();show();}});
 function makeAccessible(){const badge=document.getElementById('syncBadge');if(badge&&!badge.hasAttribute('tabindex')){badge.tabIndex=0;badge.setAttribute('role','button');badge.setAttribute('aria-label','식단 공유 상태 자세히 보기');badge.style.cursor='pointer';}}
 new MutationObserver(makeAccessible).observe(document.body,{childList:true,subtree:true});makeAccessible();
})();
