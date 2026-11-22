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
 if(!holes.length)return '';
 await image.decode();
 const rows=[];
 for(const header of holes){
  const h=header.bbox;
  const end=holes.find(w=>w.bbox.y0>h.y1)?.bbox.y0??image.naturalHeight;
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
  const heading=await line(h);
  const columns=heading.columns.slice(1);
  if(!/^holes?\s/i.test(heading.text)||columns.length<2)continue;
  const gap=Math.min(...columns.slice(1).map((c,i)=>c.x-columns[i].x));
  if(gap<=0)continue;
  const labels=words.filter(w=>w.bbox.x0>=h.x0-gap*.5 &&
   w.bbox.x0<columns[0].x-gap/2 && w.bbox.y0>h.y1 && w.bbox.y0<end);
  const positioned=[];
  for(const label of labels){
   const name=label.text.trim().toLowerCase();
   const box=label.bbox;
   if(/^putts?$/.test(name)){
    positioned.push((await line(box)).text);
    continue;
   }
   const green=/^(regulation|gir|パーオン)$/.test(name);
   if(!green&&!/^(fairway(?:s|hit|hits)?|tee shot|ティーショット)$/.test(name))continue;
   const height=box.y1-box.y0;
   const wraps=green&&name==='regulation'||!green;
   const other=wraps&&labels.find(w=>w!==label &&
    Math.abs(w.bbox.x0-box.x0)<height &&
    (green
     ? /^green(?:s)?$/i.test(w.text.trim())&&box.y0>=w.bbox.y1&&box.y0-w.bbox.y1<height
     : /^hits?$/i.test(w.text.trim())&&w.bbox.y0>=box.y1&&w.bbox.y0-box.y1<height));
   const y=(Math.min(box.y0,other?.bbox.y0??box.y0)+Math.max(box.y1,other?.bbox.y1??box.y1))/2;
   const cells=columns.map(c=>{
    if(!/^\d+$/.test(c.token))return '?';
    const peers=words.filter(w=>Math.abs((w.bbox.x0+w.bbox.x1)/2-c.x)<gap*.4 &&
     Math.abs((w.bbox.y0+w.bbox.y1)/2-y)<height);
    const token=peers.length===1?peers[0].text.trim():'';
    const explicit=green?/^(?:yes|no|hit|miss|[○〇◯✓✔×✗✕✖])$/i:/^(?:left|center|centre|right|[←↖↑→↗↓])$/i;
    return explicit.test(token)?token:readStatsSymbol(image,c.x,y,gap,height,green);
   });
   positioned.push((green?'GIR ':'Fairway ')+cells.join(' '));
  }
  const block=[heading.text,...positioned].join('\n');
  if(Object.values(parseRoundStats(block).holes).some(v=>Object.keys(v).length))rows.push(block);
 }
 return rows.join('\n---\n');
}

// Normalize a glyph to its ink bounds before comparing it with examples.
function statsSymbolMask(ctx,width,height){
 const pixels=ctx.getImageData(0,0,width,height).data;
 let left=width,right=-1,top=height,bottom=-1;
 const ink=(x,y)=>{
  const i=4*(y*width+x);
  return Math.min(pixels[i],pixels[i+1],pixels[i+2])<165;
 };
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  if(!ink(x,y))continue;
  left=Math.min(left,x);right=Math.max(right,x);
  top=Math.min(top,y);bottom=Math.max(bottom,y);
 }
 const w=right-left+1,h=bottom-top+1;
 if(w<4||h<4||left===0||right===width-1||top===0||bottom===height-1)return null;
 return {ratio:w/h,ink:Array.from({length:256},(_,i)=>ink(
  left+Math.floor((i%16+.5)*w/16),top+Math.floor((Math.floor(i/16)+.5)*h/16)
 ))};
}
const roundStatsSymbolTemplates=new Map();
function readStatsSymbol(image,x,y,gap,height,green){
 const canvas=document.createElement('canvas');
 canvas.width=Math.floor(gap*.84);
 canvas.height=Math.ceil(Math.min(gap*.95,height*2.4));
 if(canvas.width<8||canvas.height<8)return '?';
 const ctx=canvas.getContext('2d',{willReadFrequently:true});
 ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);
 ctx.drawImage(image,Math.round(x-canvas.width/2),Math.round(y-canvas.height/2),
  canvas.width,canvas.height,0,0,canvas.width,canvas.height);
 const mask=statsSymbolMask(ctx,canvas.width,canvas.height);
 if(!mask)return '?';
 if(!roundStatsSymbolTemplates.has(green)){
  canvas.width=canvas.height=48;
  const groups=green?{'✓':'✓✔○','×':'×✕✖✗'}:{'←':'←↖','↑':'↑','→':'→↗','↓':'↓'};
  const templates=[];
  for(const [value,glyphs] of Object.entries(groups))for(const glyph of glyphs){
   for(const circled of [false,true]){
    for(const weight of [400,700]){
     ctx.fillStyle='white';ctx.fillRect(0,0,48,48);
     ctx.fillStyle=ctx.strokeStyle='black';
     if(circled){
      ctx.lineWidth=2;ctx.beginPath();ctx.arc(24,24,17,0,Math.PI*2);ctx.stroke();
     }
     ctx.font=weight+' '+(circled?24:36)+'px sans-serif';
     ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(glyph,24,24);
     const sample=statsSymbolMask(ctx,48,48);
     if(sample)templates.push({value,...sample});
    }
   }
  }
  roundStatsSymbolTemplates.set(green,templates);
 }
 const scores=new Map();
 for(const sample of roundStatsSymbolTemplates.get(green)){
  const stretch=Math.abs(Math.log(mask.ratio/sample.ratio));
  if(stretch>.5)continue;
  let union=0,difference=0;
  mask.ink.forEach((pixel,i)=>{
   if(pixel||sample.ink[i])union++;
   if(pixel!==sample.ink[i])difference++;
  });
  const score=difference/union+stretch*.2;
  scores.set(sample.value,Math.min(scores.get(sample.value)??Infinity,score));
 }
 const [best,next]=[...scores].sort((a,b)=>a[1]-b[1]);
 return best&&best[1]<=.43&&(!next||next[1]-best[1]>=.09)?best[0]:'?';
}
