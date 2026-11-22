// Each header maps visible columns to hole numbers or to printed subtotal/total cells.
function parseRoundStats(text){
 const holes={},totals={},conflicts=new Set();
 const directions={L:'左',LEFT:'左','←':'左','↖':'左','左':'左',C:'中央',CENTER:'中央',CENTRE:'中央',HIT:'中央','↑':'中央','中央':'中央',R:'右',RIGHT:'右','→':'右','↗':'右','右':'右',SHORT:'ショート',LONG:'オーバー','↓':'ショート'};
 const greens={TRUE:true,FALSE:false,'◯':true,'⭕':true,'✔️':true,'✕':false,'✖':false,Y:true,YES:true,HIT:true,'✓':true,'✔':true,'○':true,'〇':true,'1':true,N:false,NO:false,MISS:false,'×':false,'✗':false,'0':false};
 function merge(obj,field,value,key){
  if(value==null||conflicts.has(key))return;
  if(obj[field]!=null&&obj[field]!==value){delete obj[field];conflicts.add(key);}
  else obj[field]=value;
 }
 for(const match of text.normalize('NFKC').matchAll(/\bGross\s*\/\s*Net\s*[:：]?\s*(\d{2,3})\s*\/\s*\d{2,3}\b/gi)){
  const gross=Number(match[1]);
  if(gross>=50&&gross<=180)merge(totals,'gross',gross,'gross');
 }
 let cols=[];
 const normalized=text.normalize('NFKC')
  .replace(/\bGreen(?:s)? in\s*\n\s*Regulation\b/gi,'Green in Regulation')
  .replace(/\bTee\s*\n\s*Shot(?:s)?\b/gi,'Tee Shot')
  .replace(/\b(Hole|Putts|Fairway|GIR|Green in Regulation)\s*\n(?=[ \t]*[\d←→↑○×])/gi,'$1 ');
 for(const raw of normalized.split(/\r?\n/)){
  const line=raw.trim().replace(/[|｜]/g,' ').replace(/\s+/g,' ');
  if(line==='---'){cols=[];continue;}
  const header=line.match(/^(?:holes?|ホール)(?:\s*no\.?)?\s*[:：]?\s+(.+)$/i);
  if(header){
   cols=header[1].toUpperCase().trim().split(/[\s,]+/);
   const nums=cols.filter(x=>/^\d+$/.test(x)).map(Number);
   if(!nums.length||nums.some((n,i)=>n<1||n>18||(i&&n!==nums[i-1]+1))||cols.some(x=>! /^(?:\d+|IN|OUT|TOTAL|合計)$/.test(x)))cols=[];
   continue;
  }
  const row=line.match(/^(putts?|パット数?|fairways?(?: hits?)?|tee shots?(?: direction| accuracy)?|ティーショット(?:方向)?|greens? in regulation|GIR|パーオン)\s*[:：]?\s+(.+)$/i);
  if(!row||!cols.length)continue;
  const values=row[2].toUpperCase().trim().split(/[\s,]+/);
  if(values.length!==cols.length)continue;
  const field=/^(putt|パット)/i.test(row[1])?'putts':/^(green|gir|パーオン)/i.test(row[1])?'gir':'direction';
  cols.forEach((c,i)=>{
   const v=values[i];
   if(c==='TOTAL'||c==='合計'){
    if(field==='putts'&&/^\d+$/.test(v)&&+v<=80)merge(totals,'putts',+v,'total-putts');
    return;
   }
   if(!/^\d+$/.test(c))return;
   const n=Number(c),hole=holes[n]??={};
   const value=field==='putts'?(/^\d+$/.test(v)&&+v<=10?+v:null):field==='gir'?greens[v]:directions[v];
   merge(hole,field,value,n+'-'+field);
  });
 }
 return {holes,totals};
}
function roundStatsRate(holes){
 const known=Object.values(holes).filter(h=>typeof h.gir==='boolean');
 return known.length?'パーオン率 '+Math.round(100*known.filter(h=>h.gir).length/known.length)+'%（'+known.filter(h=>h.gir).length+'/'+known.length+'H判定）':'';
}
function roundStatsText(holes){
 return Object.entries(holes).map(([n,h])=>n+'H '+[h.direction,h.putts!=null?h.putts+'パット':'',typeof h.gir==='boolean'?(h.gir?'パーオン ○':'パーオン ×'):''].filter(Boolean).join('・')).join(' ／ ');
}

// Re-read just the table lines. The first pass supplies row locations; the
// header establishes the visible holes even on a horizontally scrolled card.
async function readStatsTableLines(image,words,worker){
 if(!words?.length)return '';
 const holes=words.filter(w=>/^holes?$/i.test(w.text.trim()));
 const putts=words.filter(w=>/^putts?$/i.test(w.text.trim()));
 if(!holes.length||!putts.length)return '';
 await image.decode();
 const rows=[];
 for(const word of putts){
  const p=word.bbox;
  const header=holes.filter(w=>w.bbox.y1<p.y0&&Math.abs(w.bbox.x0-p.x0)<Math.max(20,p.x1-p.x0)).pop();
  if(!header)continue;
  const h=header.bbox;
  // Limit the crop to this card using the tint of the hole-number band.
  const scan=document.createElement('canvas');scan.width=image.naturalWidth;scan.height=1;
  const ctx=scan.getContext('2d');
  ctx.drawImage(image,0,Math.max(0,h.y0-1),scan.width,1,0,0,scan.width,1);
  const pixels=ctx.getImageData(0,0,scan.width,1).data;
  const tinted=x=>pixels[x*4+2]-pixels[x*4]>6 && pixels[x*4]>130 && pixels[x*4]<240;
  let right=h.x1;
  while(right<scan.width&&tinted(right))right++;
  if(right-h.x0<(h.x1-h.x0)*4)right=scan.width;
  async function line(box){
   const height=box.y1-box.y0;
   const top=Math.max(0,Math.floor(box.y0-height*.5));
   const bottom=Math.min(image.naturalHeight,Math.ceil(box.y1+height*.5));
   const width=right-h.x0+4,scale=Math.min(6,Math.max(1,48/height),3500/width);
   const c=document.createElement('canvas');c.width=Math.ceil(width*scale)+20;c.height=Math.ceil((bottom-top)*scale)+20;
   const g=c.getContext('2d');g.fillStyle='white';g.fillRect(0,0,c.width,c.height);
   g.drawImage(image,Math.max(0,h.x0-3),top,width,bottom-top,10,10,width*scale,(bottom-top)*scale);
   const bitmap=g.getImageData(0,0,c.width,c.height);
   for(let i=0;i<bitmap.data.length;i+=4){
    const tone=bitmap.data[i+1]<150?0:255;
    bitmap.data[i]=bitmap.data[i+1]=bitmap.data[i+2]=tone;
   }
   g.putImageData(bitmap,0,0);
   const data=(await worker.recognize(c)).data;
   return {text:data.text.trim().replace(/\n/g,' '),columns:(data.words||[]).map(w=>({
    token:w.text.trim(),x:Math.max(0,h.x0-3)+((w.bbox.x0+w.bbox.x1)/2-10)/scale
   }))};
  }
  const heading=await line(h),value=await line(p);
  const positioned=[];
  const columns=heading.columns.slice(1);
  if(columns.length>=2 && /^holes?\s/i.test(heading.text)){
   const gap=Math.min(...columns.slice(1).map((c,i)=>c.x-columns[i].x));
   const labels=words.filter(w=>w.bbox.x0<columns[0].x-gap/2 && w.bbox.y0>h.y1 &&
    w.bbox.y0<p.y0 && /^(fairway(?:s|hit|hits)?|regulation|gir)$/i.test(w.text.trim()));
   for(const label of labels){
    const isGreen=/regulation|gir/i.test(label.text);
    const cells=columns.map(c=>{
     const peers=words.filter(w=>{
      const center=(w.bbox.y0+w.bbox.y1)/2;
      return Math.abs((w.bbox.x0+w.bbox.x1)/2-c.x)<gap*.44 &&
       Math.abs(center-(label.bbox.y0+label.bbox.y1)/2)<(label.bbox.y1-label.bbox.y0)*(isGreen?1.3:.8);
     });
     return peers.length===1?peers[0].text.trim():'?';
    });
    positioned.push((isGreen?'GIR ':'Fairway ')+cells.join(' '));
   }
  }
  const block=[heading.text,value.text,...positioned].join('\n');
  if(Object.values(parseRoundStats(block).holes).some(v=>Object.keys(v).length))rows.push(block);
 }
 return rows.join('\n---\n');
}
