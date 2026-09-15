// Read-only access to photos uploaded before the new confirmation workflow.
export function mountLegacyHistory(container,{legacyURL,statusURL}){
 const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='이전 업로드 기록';details.append(summary);container.append(details);let loaded=false;
 details.addEventListener('toggle',async()=>{if(!details.open||loaded)return;loaded=true;const body=document.createElement('div');details.append(body);
  try{const options={method:'GET',redirect:'error',signal:AbortSignal.timeout(20000)};const responses=await Promise.all([fetch(legacyURL,options),fetch(statusURL,options)]);if(responses.some(r=>!r.ok))throw Error('read_failed');const [rows,status]=await Promise.all(responses.map(r=>r.json()));let count=0;
   for(const row of Object.values(rows||{}).sort((a,b)=>(b.uploadedAt||0)-(a.uploadedAt||0))){if(row.photoPurgedAt||!/^data:image\/(jpeg|png|webp);base64,/.test(row.dataUrl||''))continue;const raw=atob(row.dataUrl.split(',')[1]),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0)),digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');if(status?.['receipt_'+digest])continue;
    const card=document.createElement('article'),label=document.createElement('p'),button=document.createElement('button'),img=document.createElement('img');card.className='br-card';label.textContent=[row.transactionDate||row.uploadDate||'이전 사진',row.vendor||row.targetVendor||'영수증'].join(' · ');button.type='button';button.textContent='사진 보기';img.alt='이전에 올린 영수증 사진';img.hidden=true;button.addEventListener('click',()=>{img.src=row.dataUrl;img.hidden=!img.hidden;button.textContent=img.hidden?'사진 보기':'사진 닫기'});card.append(label,button,img);body.append(card);count++;
   }if(!count)body.textContent='별도로 남아 있는 이전 사진이 없습니다.';
  }catch{loaded=false;body.textContent='이전 사진을 불러오지 못했습니다. 잠시 후 다시 열어 주세요.'}
 });return()=>details.remove();
}
