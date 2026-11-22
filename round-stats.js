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
