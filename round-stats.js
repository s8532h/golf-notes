// Each header maps visible columns to hole numbers or to printed subtotal/total cells.
function parseRoundStats(text){
 const holes={},totals={},conflicts=new Set();
 const directions={L:'左',LEFT:'左','←':'左','↖':'左','左':'左',C:'中央',CENTER:'中央',CENTRE:'中央',HIT:'中央','↑':'中央','中央':'中央',R:'右',RIGHT:'右','→':'右','↗':'右','右':'右',SHORT:'ショート',LONG:'オーバー','⇧':'オーバー','↓':'ショート'};
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
    const totalField=field==='direction'?'fairway':field;
    const limit={putts:80,fairway:18,gir:18}[totalField];
    if(/^\d+$/.test(v)&&+v<=limit)merge(totals,totalField,+v,'total-'+totalField);
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
  ctx.drawImage(image,0,Math.max(0,h.y0-(h.y1-h.y0)),scan.width,1,0,0,scan.width,1);
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
  if(!normalizeStatsColumns(columns,gap))continue;
  const labels=words.filter(w=>w.bbox.x0>=h.x0-gap*.5 &&
   w.bbox.x0<columns[0].x-gap/2 && w.bbox.y0>h.y1 && w.bbox.y0<end);
  const positioned=[];
  const name=w=>w.text.trim().toLowerCase();
  const fairway=labels.find(w=>/^(?:f[ai]{1,3}r?way(?:s|h[i]?ts?)?|tee shot|ティーショット)$/.test(name(w)));
  const regulation=labels.find(w=>/^(regulation|gir|パーオン)$/.test(name(w)));
  const greenIn=labels.find(w=>/^greens? in$/.test(name(w))||
   (/^greens?$/.test(name(w))&&labels.some(v=>name(v)==='in'&&Math.abs(v.bbox.y0-w.bbox.y0)<5)));
  const putt=labels.find(w=>/^putts?$/.test(name(w)));
  const center=({bbox})=>(bbox.y0+bbox.y1)/2;
  const height=({bbox})=>bbox.y1-bbox.y0;
  const greenY=regulation
   ?greenIn&&regulation.bbox.y0>=greenIn.bbox.y1&&regulation.bbox.y0-greenIn.bbox.y1<height(regulation)
    ?(greenIn.bbox.y0+regulation.bbox.y1)/2:center(regulation)
   :greenIn?center(greenIn)+height(greenIn)*.76:null;
  const wrappedHit=fairway&&labels.find(w=>/^hits?$/.test(name(w))&&
   Math.abs(w.bbox.x0-fairway.bbox.x0)<height(fairway)&&
   w.bbox.y0>=fairway.bbox.y1&&w.bbox.y0-fairway.bbox.y1<height(fairway));
  const puttY=putt?center(putt):null;
  // In this table the three rows have equal spacing. Only recover an
  // unrecognized Fairway label when the predicted row contains actual badges.
  const pitch=greenY!=null&&puttY!=null?puttY-greenY:0;
  const fairwayY=fairway
   ?wrappedHit?(fairway.bbox.y0+wrappedHit.bbox.y1)/2:center(fairway)
   :pitch>gap&&pitch<gap*2?greenY-pitch:null;
  for(const [green,y,label] of [[false,fairwayY,fairway],[true,greenY,regulation||greenIn]]){
   if(y==null||y<=h.y1)continue;
   const cells=columns.map(c=>{
    const badge=/^\d+$/.test(c.token)?readStatsBadge(image,c.x,y,gap,green):'';
    if(badge)return badge;
    if(!label)return '?';
    const peers=words.filter(w=>Math.abs((w.bbox.x0+w.bbox.x1)/2-c.x)<gap*.4 &&
     Math.abs((w.bbox.y0+w.bbox.y1)/2-y)<height(label));
    const token=peers.length===1?peers[0].text.trim():'';
    if(c.token==='TOTAL')return /^\d+$/.test(token)?token:'?';
    if(!/^\d+$/.test(c.token))return '?';
    const explicit=green?/^(?:yes|no|hit|miss|[○〇◯✓✔×✗✕✖])$/i:/^(?:left|center|centre|right|[←↖↑→↗↓])$/i;
    return explicit.test(token)?token:readStatsSymbol(image,c.x,y,gap,height(label),green);
   });
   positioned.push((green?'GIR ':'Fairway ')+cells.join(' '));
  }
  if(putt)positioned.push((await line(putt.bbox)).text.replace(/[^\p{L}\d\s]+(?=\d)/gu,''));
  const block=['Hole '+columns.map(c=>c.token).join(' '),...positioned].join('\n');
  if(Object.values(parseRoundStats(block).holes).some(v=>Object.keys(v).length))rows.push(block);
 }
 return rows.join('\n---\n');
}

// A clipped or misread digit can be recovered when the rest of the
// consecutive hole numbers and the regular column spacing agree.
function normalizeStatsColumns(columns,gap){
 for(const c of columns)c.token=c.token.toUpperCase().replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g,'');
 const holes=columns.filter(c=>! /^(?:IN|OUT|TOTAL)$/.test(c.token));
 const first=Number(holes[0]?.token);
 if(first<1||!Number.isInteger(first)||first+holes.length-1>18)return false;
 const mismatches=holes.filter((c,i)=>Number(c.token)!==first+i);
 if(!mismatches.length)return true;
 if(mismatches.length>1||holes.length<4||columns.some((c,i)=>i&&c.x-columns[i-1].x>gap*1.25))return false;
 holes.forEach((c,i)=>{c.token=String(first+i);});
 return true;
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

// The scorecard draws the green check and red miss indicators as colored
// badges. Inspect their pixels, since OCR can turn the rings into letters.
function readStatsBadge(image,x,y,gap,green){
 const size=Math.floor(gap*.78);
 if(size<12)return '';
 const canvas=document.createElement('canvas');
 canvas.width=canvas.height=size;
 const ctx=canvas.getContext('2d');
 ctx.drawImage(image,Math.round(x-size/2),Math.round(y-size/2),size,size,0,0,size,size);
 const {data}=ctx.getImageData(0,0,size,size);
 const red=[],lime=[];
 for(let i=0;i<size*size;i++){
  const [r,g,b]=[data[i*4],data[i*4+1],data[i*4+2]];
  const point=[i%size,Math.floor(i/size)];
  if(r-g>38&&r-b>38)red.push(point);
  if(g-r>18&&g-b>46)lime.push(point);
 }
 const ink=red.length>lime.length?red:lime;
 if(ink.length<size*size*.055)return '';
 const xs=ink.map(p=>p[0]),ys=ink.map(p=>p[1]);
 const top=Math.min(...ys),bottom=Math.max(...ys);
 const left=Math.min(...xs),right=Math.max(...xs);
 const radius=(bottom-top)/2;
 if(radius<size*.23||radius>size*.44||Math.abs(right-left-2*radius)>radius*.3)return '';
 if(ink===lime)return green?'✓':'↑';
 if(green)return '×';

 const centerX=(left+right)/2,centerY=(top+bottom)/2;
 // Compare the mark inside the ring with an arrow shaft and two wings.
 const marks=ink.map(([px,py])=>[(px-centerX)/radius,(py-centerY)/radius])
  .filter(([px,py])=>Math.hypot(px,py)<.68);
 const distance=(x,y,ax,ay,bx,by)=>{
  const dx=bx-ax,dy=by-ay;
  const t=Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy)));
  return Math.hypot(x-ax-t*dx,y-ay-t*dy);
 };
 const turns=[['→',1,0],['↓',0,1],['←',-1,0],['⇧',0,-1]];
 const scores=turns.map(([symbol,dx,dy])=>{
  const count=marks.filter(([px,py])=>{
   const along=px*dx+py*dy,across=Math.abs(py*dx-px*dy);
   return Math.min(distance(along,across,-.55,0,.51,0),distance(along,across,.51,0,0,.51))<.14;
  }).length;
  return [symbol,count/Math.max(1,marks.length)];
 }).sort((a,b)=>b[1]-a[1]);
 return scores[0][1]>=.77&&scores[0][1]-scores[1][1]>=.14?scores[0][0]:'';
}
