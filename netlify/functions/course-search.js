const { URL } = require("url");
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const clean = (s = "") => s.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
async function request(url, accept = "text/html,*/*;q=0.8", timeout = 6500) {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36", accept }, redirect: "follow", signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return (await res.text()).slice(0, 2200000);
}
async function getPage(url) {
  try { return { html: await request(url), via: "direct" }; }
  catch (a) {
    try { return { html: await request("https://r.jina.ai/" + url, "text/plain,*/*;q=0.8"), via: "reader-proxy" }; }
    catch (b) { throw new Error("直接取得: " + a.message + " / 代替取得: " + b.message); }
  }
}
function safeUrl(raw, base) { try { const u = new URL(raw, base); return ["http:", "https:"].includes(u.protocol) ? u : null; } catch { return null; } }
function extractImages(html, pageUrl) {
  const images = [], seen = new Set(), add = (src, alt) => { const u = safeUrl(src, pageUrl); if (u && !seen.has(u.href)) { seen.add(u.href); images.push({ url: u.href, alt: clean(alt || "") }); } };
  for (const m of html.matchAll(/<img\b([^>]*)>/gi)) {
    const a = m[1], src = (a.match(/\b(?:src|data-src|data-original|data-lazy-src)=["']([^"']+)["']/i) || [])[1], alt = (a.match(/\balt=["']([^"']*)["']/i) || [])[1] || "";
    if (src) add(src, alt);
  }
  for (const m of html.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) if (/(course|layout|hole|map|コース|レイアウト|ホール)/i.test(m[1])) add(m[1], "コース画像候補");
  return images;
}
function isCourseMapImage(image) {
  const value = String((image?.alt || "") + " " + (image?.url || "")).toLowerCase();
  if (image.url.includes("/coursedetail/")) return /\/img-coursedetail-\d+\.png(?:[?#]|$)/i.test(image.url);
  if (/\/courseImg\/img\/[ew]\d+\.jpg(?:[?#]|$)/i.test(image.url)) return true;
  if (/banner|bnr|logo|header|renew|campaign|recruit|mainvisual|favicon|icon/.test(value)) return false;
  return /(course.?map|coursedetail|layout|hole.?map|yardage|course.?guide|hole|\bmap\b|コース図|レイアウト|ホール)/i.test(value);
}
function parseHoleData(html, pageUrl, courseName) {
  const rows = [];
  for (const m of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...m[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(x => clean(x[1]));
    if (cells.length < 5) continue;
    const hole = Number(cells[0]), hdcp = Number(cells[1]), par = Number(cells[2]);
    if (!Number.isInteger(hole) || hole < 1 || hole > 18 || !Number.isFinite(hdcp) || !Number.isFinite(par)) continue;
    const distances = cells.slice(3).map(x => Number((x.match(/\d{2,4}/) || [])[0])).filter(Number.isFinite);
    if (!distances.length) continue;
    // Generic fallback: do not infer tee labels from a course-specific URL.
    rows.push({ hole, par, strokeIndex: hdcp, yards: distances[0], tee: "未分類", teeDistances: {} });
  }
  // Reader-proxy fallback often returns Markdown tables instead of HTML.
  for (const line of html.split(/\r?\n/)) {
    if (!line.includes("|")) continue;
    const cells=line.split("|").map(x=>clean(x));
    const hole=Number(cells[1]||cells[0]),hdcp=Number(cells[2]||cells[1]),par=Number(cells[3]||cells[2]);
    if (!Number.isInteger(hole)||hole<1||hole>18||!Number.isFinite(hdcp)||!Number.isFinite(par)) continue;
    const nums=cells.slice(cells[1]&&/^\d+$/.test(cells[1])?4:3).map(x=>Number((x.match(/\d{2,4}/)||[])[0])).filter(Number.isFinite);
    if(!nums.length)continue;
    const yards=nums[0];
    if(!rows.some(x=>x.hole===hole))rows.push({hole,par,strokeIndex:hdcp,yards,tee:"未分類",teeDistances:{}});
  }
  const details = new Map();
  const headingRe = /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi;
  const headings = [...html.matchAll(headingRe)];
  for (let i=0;i<headings.length;i++) {
    const label = clean(headings[i][2]), hm = label.match(/HOLE\s*(\d+)/i);
    if (!hm) continue;
    const hole = Number(hm[1]), end = headings[i+1]?.index ?? html.length;
    const block = html.slice(headings[i].index, end);
    const text = clean(block);
    const desc = text.replace(/^.*?HOLE\s*\d+/i, "").replace(/PAR\s*:\s*\d+.*?HDCP\s*:\s*\d+/i, "").slice(0, 900);
    const imgs = extractImages(block, pageUrl);
    details.set(hole, { description: desc, imageUrl: imgs.find(isCourseMapImage)?.url || "" });
  }
  const mdHeads=[...html.matchAll(/^#{2,6}\s*HOLE\s*(\d+)\s*$/gim)];
  for(let i=0;i<mdHeads.length;i++){
    const hole=Number(mdHeads[i][1]),start=mdHeads[i].index+mdHeads[i][0].length,end=mdHeads[i+1]?.index??html.length;
    const block=html.slice(start,end);
    const desc=block.split(/\r?\n/).map(x=>x.replace(/^\s*[-*]\s*/,"").trim()).filter(x=>x&&!x.startsWith("|")&&!/^PAR\s*:|^HDCP\s*:/i.test(x)&&!/^!\[/.test(x)).join(" ").slice(0,900);
    const im=(block.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)/)||[])[1]||"";
    if(!details.has(hole))details.set(hole,{description:desc,imageUrl:im});
  }
  // Generic detail-page parser: common Japanese course pages expose
  // "East No.1 / PAR / HDCP / A GREEN / B GREEN" as labeled content, not a table.
  const pageText=clean(html);
  const titleMatch=(courseName+" "+pageUrl).match(/\b(East|West)\s*No\.?\s*(\d{1,2})\b/i)||pageText.match(/\b(East|West)\s*No\.?\s*(\d{1,2})\b/i);
  if(titleMatch){
    const hole=Number(titleMatch[2]);
    const parMatch=pageText.match(/\bPAR\s*:?\s*(\d{1,2})\b/i);
    const hdcpMatch=pageText.match(/\bHDCP\s*:?\s*(\d{1,2})\b/i);
    const green=(name)=>{const re=new RegExp(name+"\\s*GREEN[\\s\\S]{0,160}?REGULAR\\s*:?\\s*(\\d{2,4})","i");return Number((pageText.match(re)||[])[1])||null;};
    const a=green("A"),b=green("B");
    if(hole>=1&&hole<=18&&parMatch&&(a||b)&&!rows.some(x=>x.hole===hole)){
      const featureMatch=pageText.match(/特徴\s*([\s\S]{0,700}?)(?:PAR\s*:?\s*\d|HDCP\s*:?\s*\d)/i);
      const imgs=extractImages(html,pageUrl);
      rows.push({hole,par:Number(parMatch[1]),strokeIndex:hdcpMatch?Number(hdcpMatch[1]):null,yards:a||b,tee:a?"REGULAR_A":"REGULAR_B",teeDistances:{REGULAR_A:a,REGULAR_B:b},description:featureMatch?featureMatch[1].trim():"",imageUrl:imgs.find(isCourseMapImage)?.url||"",greenDistances:{A:a,B:b},course:titleMatch[1].toLowerCase()==="east"?"東コース":"西コース"});
    }
  }
  return rows.map(r => ({ ...r, ...details.get(r.hole), course: r.course||courseName, sourceUrl: pageUrl }));
}
function parseAnegasakiTables(html,pageUrl,courseName){
 const tables=[];
 for(const mt of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)){
  const trs=[...mt[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m=>[...m[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(x=>clean(x[1])));
  if(trs.length){
   const side=mt[1].match(/href=["'][^"']*\/(east|west)_no\d+\//i)?.[1]?.toLowerCase();
   tables.push({rows:trs,course:side==="east"?"東コース":side==="west"?"西コース":""});
  }
 }
 const lines=html.split(/\r?\n/).map(x=>x.trim());
 for(let i=0;i<lines.length;i++){
  if(!/^\|?\s*HOLE\s*\|\s*PAR\s*\|\s*GREEN\s*\|/i.test(lines[i]))continue;
  let end=i+1;
  while(end<lines.length&&lines[end].includes("|"))end++;
  const block=lines.slice(i,end).map(line=>line.replace(/^\||\|$/g,"").split("|").map(x=>clean(x).replace(/^【\d+†|】$/g,"").trim()));
  const heading=lines.slice(0,i).reverse().find(line=>/^#{1,6}\s+(?:east|west)\b/i.test(line))||"";
  tables.push({rows:block,course:/west/i.test(heading)?"西コース":/east/i.test(heading)?"東コース":""});
  i=end-1;
 }
 const out=[];
 for(const table of tables){
  const block=table.rows;
  const tableCourse=table.course||(/west|西/i.test(courseName+" "+pageUrl)?"西コース":/east|東/i.test(courseName+" "+pageUrl)?"東コース":"");
  const holeRow=block.find(r=>/^HOLE$/i.test(r[0]||"")&&r.slice(1).some(x=>/No\.?\s*\d+/i.test(x)));
  const parRow=block.find(r=>/^PAR$/i.test(r[0]||""));
  const greenRow=block.find(r=>/^GREEN$/i.test(r[0]||""));
  if(!holeRow||!parRow||!greenRow)continue;
  const holes=holeRow.slice(1).map(x=>Number((x.match(/\d+/)||[])[0])).filter(n=>n>=1&&n<=18);
  if(holes.length<6)continue;
  const greenByHole=holes.map((_,j)=>String(greenRow[1+j*2]||"A").toUpperCase().includes("B")?"B":"A");
  const teeRows=block.filter(r=>/^(BACK TEE|REGULAR TEE|FRONT TEE 1|FRONT TEE 2)$/i.test((r[0]||"").trim()));
  const teeMap={};
  for(const r of teeRows){
   const label=r[0].toUpperCase().replace(/\s+/g," ").trim();
   const key=label==="BACK TEE"?"BACK":label==="REGULAR TEE"?"REGULAR":label==="FRONT TEE 1"?"FRONT1":"FRONT2";
   holes.forEach((hole,j)=>{
    const a=Number(String(r[1+j*2]||"").replace(/,/g,""))||null,b=Number(String(r[2+j*2]||"").replace(/,/g,""))||null;
    if(a)(teeMap[key+"_A"]??=[])[j]=a;
    if(b)(teeMap[key+"_B"]??=[])[j]=b;
   });
  }
  holes.forEach((hole,j)=>{
   const teeDistances={};Object.entries(teeMap).forEach(([key,vals])=>{if(vals[j])teeDistances[key]=vals[j];});
   const par=Number(parRow[j+1])||null;if(!par||!Object.keys(teeDistances).length)return;
   out.push({hole,par,strokeIndex:null,yards:teeDistances.REGULAR_A||teeDistances.REGULAR_B||teeDistances.BACK_A||null,tee:"REGULAR_A",teeDistances,green:greenByHole[j],course:tableCourse,sourceUrl:pageUrl});
  });
 }
 return out;
}
function parseMatrixTables(html,pageUrl,courseName){
 const rows=[];
 for(const mt of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)){
  const trs=[...mt[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m=>[...m[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(x=>clean(x[1])));
  if(!trs.length)continue;
  // Labeled row-wise scorecard: HOLE / HDCP / PAR / BACK Bent / REG Bent / FRONT Bent / LADY Bent.
  const headerIndex=trs.findIndex(r=>r.some(x=>/^HOLE$/i.test(x.trim()))&&r.some(x=>/HDCP/i.test(x))&&r.some(x=>/^PAR$/i.test(x.trim())));
  if(headerIndex>=0){
   const hdr=trs[headerIndex].map(x=>x.toUpperCase().replace(/\s+/g," ").trim());
   const idx={hole:hdr.findIndex(x=>x==="HOLE"),hdcp:hdr.findIndex(x=>x.includes("HDCP")),par:hdr.findIndex(x=>x==="PAR"),BACK:hdr.findIndex(x=>x.includes("BACK")),REGULAR:hdr.findIndex(x=>x.includes("REG")),FRONT:hdr.findIndex(x=>x.includes("FRONT")),LADY:hdr.findIndex(x=>x.includes("LADY"))};
   for(const row of trs.slice(headerIndex+1)){
    const hole=Number((row[idx.hole]||"").match(/\d{1,2}/)?.[0]),par=Number((row[idx.par]||"").match(/\d/)?.[0]),hdcp=Number((row[idx.hdcp]||"").match(/\d{1,2}/)?.[0]);
    if(!Number.isInteger(hole)||hole<1||hole>18||!Number.isInteger(par)||par<3||par>5)continue;
    const read=k=>{const m=(row[idx[k]]||"").match(/\d{2,4}/);return m?Number(m[0]):null;};
    const teeDistances={BACK:read("BACK"),REGULAR:read("REGULAR"),FRONT:read("FRONT"),LADY:read("LADY")};
    const yards=teeDistances.REGULAR||teeDistances.FRONT||teeDistances.BACK||teeDistances.LADY;
    if(yards)rows.push({hole,par,strokeIndex:Number.isFinite(hdcp)?hdcp:null,yards,tee:"REGULAR",teeDistances,course:/south|南/i.test(courseName+" "+pageUrl)?"南コース":/east|東/i.test(courseName+" "+pageUrl)?"東コース":/west|西/i.test(courseName+" "+pageUrl)?"西コース":"",sourceUrl:pageUrl});
   }
   if(rows.length)continue;
  }
  // Horizontal official scorecards: HOLE | 1..9, then PAR / HDCP / BACK / REG / FRONT / LADY.
  const hrow=trs.find(r=>/^HOLE$/i.test((r[0]||"").trim())&&r.slice(1).filter(x=>/^(?:[1-9]|1[0-8])$/.test(x.trim())).length>=6);
  if(hrow){
   const holeNums=hrow.slice(1).map(x=>Number(x.trim()));
   const vals={};
   for(const row of trs){
    const label=(row[0]||"").toUpperCase().replace(/\s+/g," ").trim();
    const key=/^PAR\b/.test(label)?"par":/^(?:HDCP|H[.]?D[.]?C[.]?P)\b/.test(label)?"hdcp":/^BACK\b/.test(label)?"BACK":/^REG(?:ULAR)?\b/.test(label)?"REGULAR":/^FRONT\b/.test(label)?"FRONT":/^(?:LADY|LADIES)\b/.test(label)?"LADY":null;
    if(key)vals[key]=row.slice(1).map(x=>Number((x.match(/\d{1,4}/)||[])[0])||null);
   }
   if(vals.par){
    holeNums.forEach((hole,i)=>{
     const par=vals.par[i];if(!hole||!par||par<3||par>5)return;
     const teeDistances={BACK:vals.BACK?.[i]||null,REGULAR:vals.REGULAR?.[i]||null,FRONT:vals.FRONT?.[i]||null,LADY:vals.LADY?.[i]||null};
     const primary=teeDistances.REGULAR||teeDistances.FRONT||teeDistances.BACK||teeDistances.LADY;
     rows.push({hole,par,strokeIndex:vals.hdcp?.[i]||null,yards:primary,tee:"REGULAR",teeDistances,course:/south|南/i.test(courseName+" "+pageUrl)?"南コース":/east|東/i.test(courseName+" "+pageUrl)?"東コース":/west|西/i.test(courseName+" "+pageUrl)?"西コース":"",sourceUrl:pageUrl});
    });
   }
   continue;
  }
  // Vertical tables: one hole per row with tee columns.
  let header=-1,holes=[];
  for(let i=0;i<trs.length;i++){const ns=trs[i].map(x=>Number(x.trim())).filter(n=>Number.isInteger(n)&&n>=1&&n<=18);if(ns.length>=6){header=i;holes=ns;break;}}
  if(header<0)continue;
  const v={};
  for(const row of trs.slice(header+1)){
   const label=(row[0]||"").toLowerCase().replace(/\s/g,"");
   const key=/^par/.test(label)?"par":/hdcp|ハンディ/.test(label)?"hdcp":/black|back|champion|bt/.test(label)?"BACK":/front/.test(label)?"FRONT":/blue|regular|reg|white|rgt/.test(label)?"REGULAR":/gold|senior/.test(label)?"GOLD":/red|ladies|lady/.test(label)?"LADY":null;
   if(key)v[key]=row.slice(1).map(x=>Number((x.match(/\d{1,4}/)||[])[0])||null);
  }
  if(!v.par)continue;
  holes.forEach((hole,i)=>{
   const par=v.par[i];if(!par||par<3||par>5)return;
   const teeDistances={BACK:v.BACK?.[i]||null,REGULAR:v.REGULAR?.[i]||null,FRONT:v.FRONT?.[i]||null,GOLD:v.GOLD?.[i]||null,LADY:v.LADY?.[i]||null};
   const primary=teeDistances.REGULAR||teeDistances.FRONT||teeDistances.BACK||teeDistances.GOLD||teeDistances.LADY;
   rows.push({hole,par,strokeIndex:v.hdcp?.[i]||null,yards:primary,tee:"REGULAR",teeDistances,course:/south|南/i.test(courseName+" "+pageUrl)?"南コース":/east|東/i.test(courseName+" "+pageUrl)?"東コース":/west|西/i.test(courseName+" "+pageUrl)?"西コース":"",sourceUrl:pageUrl});
  });
 }
 return rows;
}
function parseLabeledHoles(html,pageUrl,courseName){
 const text=clean(html),rows=[];
 let holeMatch=text.match(/\bHOLE\s*(?:No\.?\s*)?(\d{1,2})\b/i);
 if(!holeMatch)holeMatch=pageUrl.match(/\/(?:course|hole)\/(\d{1,2})\.html?/i);
 if(holeMatch){
  const labels=[
   ["BACK",/\bBACK(?:\s+TEE)?\b/i],
   ["REGULAR",/\bREG(?:ULAR)?(?:\s+TEE)?\b/i],
   ["FRONT",/\bFRONT(?:\s+TEE)?\b/i],
   ["LADY",/\bLAD(?:Y|IES)(?:\s+TEE)?\b/i]
  ];
  const positions=labels.map(([key,re])=>({key,index:text.search(re)})).filter(x=>x.index>=0).sort((a,b)=>a.index-b.index);
  const teeDistances={BACK:null,REGULAR:null,FRONT:null,LADY:null};
  // First support label/value pairs, then the common official-site format
  // where all tee labels are followed by a compact sequence of yardages.
  for(let i=0;i<positions.length;i++){
   const p=positions[i],end=positions[i+1]?.index??Math.min(text.length,p.index+90);
   const segment=text.slice(p.index,end);
   const nums=[...segment.matchAll(/\b(\d{2,4})\b/g)].map(x=>Number(x[1])).filter(n=>n>=80&&n<=850);
   if(nums.length)teeDistances[p.key]=nums[0];
  }
  if(positions.length>=2&&Object.values(teeDistances).filter(Boolean).length<2){
   const tail=text.slice(positions[positions.length-1].index,Math.min(text.length,positions[positions.length-1].index+180));
   const nums=[...tail.matchAll(/\b(\d{2,4})\s*y?\b/gi)].map(x=>Number(x[1])).filter(n=>n>=80&&n<=850);
   const ordered=positions.map(x=>x.key);
   if(nums.length>=2)ordered.forEach((key,i)=>{if(nums[i])teeDistances[key]=nums[i];});
  }
  const par=Number((text.match(/\bPAR\s*:?\s*([3-5])\b/i)||[])[1])||null;
  const strokeIndex=Number((text.match(/\bHDCP\s*:?\s*(\d{1,2})\b/i)||[])[1])||null;
  if(par&&Object.values(teeDistances).some(Boolean)){
   const yards=teeDistances.REGULAR||teeDistances.FRONT||teeDistances.BACK||teeDistances.LADY;
   rows.push({hole:Number(holeMatch[1]),par,strokeIndex,yards,tee:"REGULAR",teeDistances,description:text.slice(0,900),course:/south|南/i.test(courseName+" "+pageUrl)?"南コース":/east|東/i.test(courseName+" "+pageUrl)?"東コース":/west|西/i.test(courseName+" "+pageUrl)?"西コース":"",sourceUrl:pageUrl});
  }
 }
 return rows;
}
function parseHoleCards(html, pageUrl, courseName) {
  const headings = [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)];
  const rows = [];
  const handicap = new Map();
  const cells = row => [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => clean(cell[1]));
  for (const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const trs = [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(tr => cells(tr[1]));
    const holes = trs.find(row => /^HOLES?$/i.test(row[0]));
    const indices = trs.find(row => /^HDCP$/i.test(row[0]));
    if (holes && indices) holes.forEach((label,i)=>{
      const n = label.match(/^(?:No\.?\s*)?(\d{1,2})$/i);
      if(n && /^[0-9]+$/.test(indices[i])) handicap.set(Number(n[1]), Number(indices[i]));
    });
  }
  const teeNames = new Map([["バック","BACK"],["レギュラー","REGULAR"],["フロント","FRONT"],["レディース","LADY"]]);
  headings.forEach((heading,i)=>{
    const match = clean(heading[2]).match(/^(\d{1,2})\s*Hole\s*Par\s*([3-6])$/i);
    if (!match) return;
    const hole = Number(match[1]), par = Number(match[2]);
    if (hole<1 || hole>18) return;
    const block = html.slice(heading.index+heading[0].length,headings[i+1]?.index);
    const table = block.match(/<table\b[^>]*>([\s\S]*?)<\/table>/i);
    if (!table) return;
    const trs = [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(tr=>cells(tr[1]));
    const keys = (trs[0]||[]).map(name=>teeNames.get(name));
    const teeDistances = {};
    for (const row of trs.slice(1)) {
      const green = row[0]?.toUpperCase();
      if (!/^(OLD|NEW|A|B)$/.test(green)) continue;
      keys.forEach((key,j)=>{
        const distance = row[j]?.match(/^(\d{2,3})\s*(?:Y|YD)?$/i);
        if (key && distance) teeDistances[key+"_"+green]=Number(distance[1]);
      });
    }
    const tee = Object.keys(teeDistances).find(key=>key.startsWith("REGULAR_")) || Object.keys(teeDistances)[0];
    if (!tee) return;
    const description = clean(block.match(/<p\b[^>]*class=["']txt["'][^>]*>([\s\S]*?)<\/p>/i)?.[1]||"");
    const imageUrl = extractImages(block,pageUrl).find(image=>/hole\s*map/i.test(image.alt)||/\/course\/(?:east|west)\/c_[ew]\d+\.jpg$/i.test(image.url))?.url||"";
    rows.push({hole,par,strokeIndex:handicap.get(hole)??null,tee,teeDistances,yards:teeDistances[tee],description,imageUrl,course:courseName,sourceUrl:pageUrl});
  });
  return rows;
}
function yardageRows(table) {
  return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(tr =>
    [...tr[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(cell=>clean(cell[1]).normalize("NFKC").trim()));
}

function parseOfficialSections(html,pageUrl) {
  const holes=[];
  function add(hole,par,hdcp,distances,course,block,mapPattern,descriptionPattern){
    const tee=Object.keys(distances).find(key=>/^(REGULAR|WHITE)(_|$)/.test(key))||Object.keys(distances)[0];
    if(!tee||hole<1||hole>18||!(par>=3&&par<=6))return;
    holes.push({hole,par,strokeIndex:Number(hdcp)||null,tee,teeDistances:distances,yards:distances[tee],
      course,sourceUrl:pageUrl,imageUrl:extractImages(block,pageUrl).find(im=>mapPattern.test(im.url))?.url||"",
      description:descriptionPattern?clean(block.match(descriptionPattern)?.[1]||""):""});
  }
  function blocks(pattern,read){
    const markers=[...html.matchAll(pattern)];
    markers.forEach((m,i)=>read(m,html.slice(m.index,markers[i+1]?.index)));
  }
  function teeColumns(names,values,green=""){
    const aliases={"BACK TEE":"BACK","REG TEE":"REGULAR","LADIES TEE":"LADY",BT:"BACK",RGT:"REGULAR",GT:"GOLD",LT:"RED"};
    const result={};
    names.forEach((name,i)=>{
      const key=aliases[name]||(/^(BLACK|BLUE|WHITE|GOLD|RED)$/.test(name)?name:"");
      if(key&&/^\d{2,3}$/.test(values[i]))result[key+green]=Number(values[i]);
    });
    return result;
  }
  blocks(/<div\b[^>]*class="c-map_content[^"]*"[^>]*id="hole(\d+)"[^>]*>/gi,(m,block)=>{
    const table=block.match(/<table\b[^>]*>[\s\S]*?<\/table>/i);
    if(!table)return;
    const [names,...rows]=yardageRows(table[0]), distances={};
    for(const row of rows){
      const green=row[0].match(/^([A-Z])グリーン$/);
      if(green)Object.assign(distances,teeColumns(names,row,"_"+green[1]));
    }
    add(+m[1],Number(clean(block).match(/PAR\s*([3-6])/i)?.[1]),null,distances,"コース情報",block,/\/newhole\/no\d+\.png$/i,/<p class="c-map_text">([\s\S]*?)<\/p>/i);
  });
  blocks(/<h3\b[^>]*>\s*([東南西北])\s*([AB])\s*(\d+)\s*HOLE\s*<\/h3>/gi,(m,block)=>{
    const [names,row]=yardageRows(block);
    if(row)add(+m[3],+row[names.indexOf("PAR")],row[names.indexOf("HDCP")],teeColumns(names,row,"_"+m[2]),m[1]+"コース",block,/\/uploads\/\d{4}\/\d{2}\/[es]\d{2}\.png$/i);
  });
  const detail=html.match(/<h1\b[^>]*>\s*HOLE\s*(\d+)\s*<span>ホール[\s\S]*?<\/section>/i);
  if(detail){
    const [names,row]=yardageRows(detail[0]);
    if(row)add(+detail[1],+row[names.indexOf("PAR")],row[names.indexOf("HDCP")],teeColumns(names,row),"コース情報",detail[0],/\/course\/images\/\d+\.jpg$/i,/<p\b[^>]*>([\s\S]*?)<\/p>/i);
  }
  const info=html.match(/<h1>\s*(?:IN|OUT)\s+HOLE\s*<strong>NO\.(\d+)<\/strong><br\s*\/?>\s*PAR\s*(\d+)\s*\/\s*HDCP\s*(\d+)<\/h1>[\s\S]*?<\/table>/i);
  if(info){
    const rows=yardageRows(info[0]);
    add(+info[1],+info[2],info[3],teeColumns(rows.map(r=>r[0].toUpperCase()),rows.map(r=>r[1])),"コース情報",info[0],/\/course\/[AB]-h\d+\.svg$/i,/<div id="course_info_txt">\s*<p>([\s\S]*?)<\/p>/i);
  }
  // Horizontal scorecards with explicitly named tee colors.
  if(!holes.length && /(?:Blue|Black)(?: Tee)?\s*<\/t[hd]>/i.test(html)){
    for(const table of html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)){
      const rows=yardageRows(table[0]);
      const numbers=rows.find(r=>/^HOLE(?: No\.?)?$/i.test(r[0]));
      const pars=rows.find(r=>r[0]==="PAR"),hdcp=rows.find(r=>r[0]==="HDCP");
      if(!numbers||!pars||!hdcp)continue;
      const tees=rows.filter(r=>/^(Black|Blue|White|Gold|Red)( Tee)?$/i.test(r[0]));
      if(!tees.length)continue;
      numbers.forEach((n,i)=>{
        if(!/^\d{1,2}$/.test(n))return;
        const distances=teeColumns(tees.map(r=>r[0].split(" ")[0].toUpperCase()),tees.map(r=>r[i]));
        const img=html.match(new RegExp('<img[^>]+src="([^"]*/courseLayout/'+(+n<=9?1:2)+'_'+((+n-1)%9+1)+'\\.jpg[^"]*)"','i'));
        add(+n,+pars[i],hdcp[i],distances,"コース情報",img ? img[0]+">" : "",/\/courseLayout\//i);
      });
    }
  }
  return holes;
}
function teeKey(label){
  const key=String(label||"").normalize("NFKC").toUpperCase().replace(/\s*TEE$|ティー$/,"").trim();
  const green=key.match(/^(BENT|KORAI)\s+(BLUE|WHITE|BLACK|GOLD|RED)$/);
  if(green)return green[2]+"_"+green[1];
  const aliases={CHAMPION:"CHAMP",REG:"REGULAR",LADIES:"LADY",レギュラー:"REGULAR",バック:"BACK",フロント:"FRONT",レディース:"LADY"};
  return aliases[key]||(/^(BLACK|BLUE|WHITE|GOLD|RED|BACK|REGULAR|FRONT|PRINCE|SENIOR|LADY)$/.test(key)?key:null);
}
function teeValues(labels,values,suffix=""){
  const distances={};
  labels.forEach((label,i)=>{
    const key=teeKey(label);
    if(key&&/^\d{2,3}$/.test(values[i]))distances[key+suffix]=Number(values[i]);
  });
  return distances;
}
function scoreHole(hole,par,hdcp,teeDistances,sourceUrl){
  const tee=["REGULAR","REGULAR_BENT","WHITE","WHITE_BENT"].find(k=>teeDistances[k])||Object.keys(teeDistances)[0];
  if(!tee||hole<1||hole>18||!(par>=3&&par<=6))return null;
  return {hole,par,strokeIndex:Number(hdcp)||null,tee,teeDistances,yards:teeDistances[tee],sourceUrl};
}
// Course templates that render one hole at a time expose the numbered tabs on
// the guide. Request only the documented, read-only hole selector.
async function interactiveScorecard(html,url){
  const page=new URL(url);
  if(page.hostname!=="www.alpen-group.net"||!/^\/[\w-]+\/course\/$/.test(page.pathname)||!html.includes("js-hole-tab"))return null;
  const numbers=[...new Set([...html.matchAll(/data-hole="(\d+)"/g)].map(m=>Number(m[1])))];
  if(numbers.length!==18||!numbers.every((n,i)=>n===i+1))return null;
  const holes=await Promise.all(numbers.map(async n=>{
    const response=await fetch(new URL("ajax.php",url),{method:"POST",body:new URLSearchParams({hole_num:String(n)}),signal:AbortSignal.timeout(8000)});
    if(!response.ok)throw Error("ホール明細を取得できませんでした");
    const fragment=await response.text();
    if(Number(fragment.match(/Hole No\.\s*(\d+)/i)?.[1])!==n)throw Error("ホール番号を確認できませんでした");
    const [labels,values]=yardageRows(fragment.match(/<table\b[^>]*>[\s\S]*?<\/table>/i)?.[0]||"");
    if(!values)throw Error("ホールの距離表を確認できませんでした");
    const columns=labels.map(k=>k.toUpperCase());
    const h=scoreHole(n,+values[columns.indexOf("PAR")],values[columns.indexOf("HDCP")],teeValues(labels,values),url+"?hole="+n);
    if(!h)throw Error("ホールの距離が不足しています");
    h.imageUrl=extractImages(fragment,url).find(im=>/layout/i.test(im.url))?.url||"";
    h.description=clean(fragment.match(/<div class="txt">\s*<p>([\s\S]*?)<\/p>/)?.[1]||"");
    return h;
  }));
  return [{title:"コース情報",url,holes}];
}
// Identify scorecards by their axes. Keep the page course and the nine-hole
// section together so equally numbered holes on sibling courses stay distinct.
function namedScorecards(html, url) {
  const headings = [...html.matchAll(/<(h[1-4]|p)\b([^>]*)>([\s\S]*?)<\/\1>/gi)]
    .filter(m=>m[1]!=="p" || /title/i.test(m[2]))
    .map(m=>({text:clean(m[3]),index:m.index}));
  const parent = headings.find(h=>/^[^｜|]{1,35}コース$/.test(h.text))?.text || "";
  const groups = new Map();
  function add(title, holes) {
    if(!groups.has(title))groups.set(title,new Map());
    for(const h of holes)groups.get(title).set(h.hole,h);
  }
  for(const section of parseSectionScorecards(html,url,parent))add(section.title,section.holes);
  const modalHeads=[...html.matchAll(/<h2\b[^>]*>\s*No\.\s*(\d+)\s*<\/h2>/gi)];
  for(const [i,m] of modalHeads.entries()){
    const block=html.slice(m.index,modalHeads[i+1]?.index);
    const par=Number(block.match(/\bPAR\s+([3-6])\s*</i)?.[1]);
    const distances={};
    let hdcp=null;
    for(const green of block.matchAll(/<h3\b[^>]*>(ベント|コーライ)<\/h3>\s*<\/div>\s*<div[^>]*>\s*(<table\b[^>]*>[\s\S]*?<\/table>)/gi)){
      const [labels,values]=yardageRows(green[2]);
      if(!values)continue;
      hdcp=values[labels.indexOf("HDCP")];
      Object.assign(distances,teeValues(labels,values,green[1]==="ベント"?"_BENT":"_KORAI"));
    }
    const h=scoreHole(+m[1],par,hdcp,distances,url);
    if(h)add("コース情報",[h]);
  }
  for(const table of html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)){
    const rows=yardageRows(table[0]);
    const head=rows.find(r=>/^HOLE$/i.test(r[0]) && r.includes("PAR") && r.includes("HDCP") && r.some(t=>/^WHITE$/i.test(t)));
    if(head){
      for(const row of rows.filter(r=>/^\d{1,2}$/.test(r[0]))){
        const h=scoreHole(+row[0],+row[head.indexOf("PAR")],row[head.indexOf("HDCP")],teeValues(head,row),url);
        if(h)add(parent||"コース情報",[h]);
      }
    }
    const numbers=rows.find(r=>/^(HOLE(?:\s*NO\.?)?|ホール)$/i.test(r[0]) && r.slice(1).filter(v=>/^\d{1,2}$/.test(v)).length>=9);
    const pars=rows.find(r=>/^(PAR|パー)$/i.test(r[0]));
    if(!numbers||!pars)continue;
    const tees=new Map();
    for(const [label,...values] of rows){
      const key=teeKey(label);
      if(key)tees.set(key,values);
    }
    if(tees.size<2)continue;
    const heading=headings.filter(h=>h.index<table.index).pop()?.text||"";
    const section=heading.replace(/\s*(?:ヤーデージ|距離表|スコアカード|yardage|score\s*card).*$/i,"").trim();
    const name=/コース$/.test(section)&&!/(アウト|イン|OUT|IN)コース$/i.test(section)?section:"";
    const title=[...new Set([parent,name].filter(Boolean))].join(" ")||"コース情報";
    const handicap=rows.find(r=>/^(HANDI\s*CAP|HDCP|HCP|ハンディキャップ)$/i.test(r[0]));
    const holes=[];
    for(let i=1;i<numbers.length;i++){
      if(!/^(?:[1-9]|1[0-8])$/.test(numbers[i])||!/^([3-6])$/.test(pars[i]))continue;
      const distances=Object.fromEntries([...tees].filter(([,ys])=>/^\d{2,3}$/.test(ys[i-1])).map(([t,ys])=>[t,Number(ys[i-1])]));
      const h=scoreHole(+numbers[i],+pars[i],handicap?.[i],distances,url);
      if(h)holes.push(h);
    }
    if(holes.length>=9)add(title,holes);
  }
  return [...groups].map(([title,byHole])=>({title,url,holes:[...byHole.values()].sort((a,b)=>a.hole-b.hole)}))
    .filter(g=>[9,18].includes(g.holes.length)&&g.holes.every((h,i)=>h.hole===i+1));
}

// Row-wise scorecards with named tees and optional consecutive green rows.
function parseSectionScorecards(html, url, parent = "") {
  const courses = new Map();
  for (const table of html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)) {
    const rows = yardageRows(table[0]);
    const start = rows.findIndex(r=>/^(?:\((?:OUT|IN)\)\s*)?(?:HOLE(?:\s*NO\.?)?|ホール)$/i.test(r[0]) && /^(PAR|パー)$/i.test(r[1]) && /^(HD|HDCP|HCP|HANDI\s*CAP)$/i.test(r[2]));
    if(start<0)continue;
    const twoGreens=/class=["']korai["']/i.test(table[0]);
    const previousHeading=[...html.slice(0,table.index).matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi)].pop();
    const section=rows[0]?.[0]?.match(/^([^\s]{1,24}コース)(?:\s|$)/)?.[1] || clean(previousHeading?.[1]||"");
    const title=/^(アウト|イン)コース$/.test(section)?(parent||"コース情報"):(section||parent||"コース情報");
    if(!title)continue;
    const tees=rows[start].slice(3).map(t=>({REG:"REGULAR",LADIES:"LADY"})[t]||t.split(/\s|※/)[0]);
    if(!courses.has(title))courses.set(title,{title,url,holes:[]});
    for(let i=start+1;i<rows.length;i++){
      const [num,par,hdcp,...cells]=rows[i];
      if(!/^\d{1,2}$/.test(num)||!/^([3-6])$/.test(par)||cells.length!==tees.length)continue;
      const teeDistances={},leftYards={};
      tees.forEach((tee,j)=>{
        const pair=cells[j].match(/^R(\d+)\s*L(\d+)$/i);
        if(pair){teeDistances[tee]=Number(pair[1]);leftYards[tee]=Number(pair[2]);}
        else if(twoGreens){
          if(/^\d+$/.test(cells[j]))teeDistances[tee+"_BENT"]=Number(cells[j]);
          const lower=rows[i+1]?.[j];
          if(/^\d+$/.test(lower))teeDistances[tee+"_KORAI"]=Number(lower);
        }else if(/^\d+$/.test(cells[j]))teeDistances[tee]=Number(cells[j]);
      });
      if(twoGreens)i++;
      const tee=["REGULAR","GREEN_BENT","GREEN"].find(t=>teeDistances[t]);
      if(tee)courses.get(title).holes.push({hole:+num,par:+par,strokeIndex:+hdcp,tee,teeDistances,leftYards,yards:teeDistances[tee],sourceUrl:url});
    }
  }
  return [...courses.values()];
}

async function selectedClubScorecards(root){
  const host=root.hostname.replace(/^www\./,""),path=root.pathname.replace(/\/$/,"");
  let rootTitle,pages;
  if(host==="mannacc.com"&&["","/course","/course/manna-course","/course/gp-course"].includes(path)){
    rootTitle="真名カントリークラブ";
    const urls=["manna-course","gp-course"].filter(part=>!path.endsWith("-course")||path.endsWith(part)).map(part=>"https://www.mannacc.com/course/"+part+"/");
    pages=(await Promise.all(urls.map(async url=>{
      const sections=parseSectionScorecards(await request(url,"text/html",6500),url,"ゲーリー・プレーヤーコース");
      const split=url.includes("/manna-course/");
      if(sections.length!==(split?3:1)||sections.some(p=>p.holes.length!==(split?9:18)))throw Error("真名の距離表を最後まで読み取れませんでした");
      return sections;
    }))).flat();
  }else if(host==="pacificgolf.co.jp"&&["/ishioka","/ishioka/course.asp"].includes(path)){
    rootTitle="PGM石岡ゴルフクラブ";
    const url="https://www.pacificgolf.co.jp/ishioka/course.asp";
    try{
      const html=await request(url,"text/html",3500);
      const holes=parseColorScorecard(html,url);
      if(holes.length!==18)throw Error("距離表未取得");
      pages=[{title:"コース情報",url,holes}];
    }catch{
      const {url:source,rows}=require("./data/ishioka.json");
      const holes=rows.map(([hole,par,strokeIndex,BLACK,BLUE,WHITE,GOLD,RED])=>({hole,par,strokeIndex,tee:"WHITE",yards:WHITE,teeDistances:{BLACK,BLUE,WHITE,GOLD,RED},sourceUrl:source}));
      pages=[{title:"コース情報",url:source,sourceLabel:"GDO掲載の距離表（2026年11月19日確認）",holes}];
    }
  }else return null;
  if(!pages.length)throw Error("コースの距離表を取得できませんでした");
  return {root:root.href,rootTitle,pages,images:[]};
}

function parseColorScorecard(html,url){
  const holes=[];
  for(const table of html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)){
    const rows=yardageRows(table[0]);
    const numbers=rows.find(r=>r.includes("1")&&r.includes("9")||r.includes("10")&&r.includes("18"));
    const data=new Map(rows.map(r=>[r[0]?.toUpperCase(),r.slice(1)]));
    const colors=["BLACK","BLUE","WHITE","GOLD","RED"];
    if(!numbers||!colors.every(t=>data.has(t))||!data.has("PAR")||!data.has("HDCP"))continue;
    for(const [i,n] of numbers.filter(v=>/^\d{1,2}$/.test(v)).entries()){
      const teeDistances=Object.fromEntries(colors.map(t=>[t,Number(data.get(t)[i])]));
      if(!Object.values(teeDistances).every(y=>y>0))continue;
      holes.push({hole:+n,par:+data.get("PAR")[i],strokeIndex:+data.get("HDCP")[i],tee:"WHITE",yards:teeDistances.WHITE,teeDistances,sourceUrl:url});
    }
  }
  const unique=[...new Map(holes.map(h=>[h.hole,h])).values()].sort((a,b)=>a.hole-b.hole);
  return unique.every((h,i)=>h.hole===i+1&&h.par>=3&&h.par<=5)?unique:[];
}
function parsePage(html, pageUrl, via) {
  const page = new URL(pageUrl), title = clean((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || page.hostname);
  const links = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = (m[1].match(/\bhref=["']([^"']+)["']/i) || [])[1]; if (!href) continue;
    const u = safeUrl(href, page.href); if (!u || u.hostname.replace(/^www\./,"") !== page.hostname.replace(/^www\./,"")) continue;
    if(page.protocol==="https:" && u.protocol==="http:")u.protocol="https:";
    u.hash="";
    const label = clean(m[2]) + " " + clean((m[2].match(/<img\b[^>]*alt=["]([^"]*)/i)||[])[1]||"");
    if (/(コース|レイアウト|ホール|ヤーデージ|距離表|スコアカード|yardage|score.?card|course|layout|hole|east|west|south|north|東|西|南|北|no[._-]?[0-9]+|\/[0-9]+\.html|course_[a-z0-9]+)/i.test(label + " " + u.pathname) && !links.some(x=>x.url===u.href)) links.push({ title: label || u.pathname, url: u.href });
  }
  for(const area of html.matchAll(/<area\b[^>]*\bhref=["']([^"']+)["']/gi)){
    const u=safeUrl(area[1],page.href);
    if(!u||u.hostname!==page.hostname||!/(course|hole)/i.test(u.pathname))continue;
    u.hash="";
    if(!links.some(link=>link.url===u.href))links.push({title:u.pathname,url:u.href});
  }
  const sections=parseOfficialSections(html,page.href);
  if(sections.length)return {title,url:page.href,links,images:extractImages(html,page.href),holes:sections,via};
  const cards=parseHoleCards(html,page.href,title);
  if(cards.length)return {title,url:page.href,links,images:extractImages(html,page.href),holes:cards,via};
  const matrix=parseAnegasakiTables(html,page.href,title);
  if(!matrix.length){
    const scorecards=namedScorecards(html,page.href);
    if(scorecards.length)return {title,url:page.href,links,images:extractImages(html,page.href),holes:[],scorecards,via};
  }
  const details=parseHoleData(html,page.href,title);
  const scores=matrix.length?matrix:parseMatrixTables(html,page.href,title);
  const holes=scores.length?scores.map(score=>{
    const detail=details.find(d=>d.hole===score.hole && (d.imageUrl||d.description));
    return detail?{...score,imageUrl:detail.imageUrl,description:detail.description}:score;
  }):[...parseLabeledHoles(html,page.href,title),...details].filter((row,index,all)=>
    all.findIndex(other=>other.hole===row.hole&&other.course===row.course)===index);
  return {title,url:page.href,links,images:extractImages(html,page.href),holes,via};
}
async function readCoursePage(html,url,via){
  const parsed=parsePage(html,url,via);
  const cards=await interactiveScorecard(html,url);
  if(cards){parsed.scorecards=cards;parsed.holes=[];}
  return parsed;
}
exports.handler = async (event) => {
  try {
    const raw = event.queryStringParameters?.page;
    if (!raw) return { statusCode: 400, headers, body: JSON.stringify({ error: "公式サイトURLを指定してください" }) };
    const root = new URL(raw);
    if (!["http:", "https:"].includes(root.protocol) || root.hostname === "localhost" || root.hostname.endsWith(".local") || /^\d{1,3}(\.\d{1,3}){3}$/.test(root.hostname)) throw new Error("このURLは確認できません");
    const selected=await selectedClubScorecards(root);
    if(selected)return {statusCode:200,headers,body:JSON.stringify(selected)};
    const first = await getPage(root.href), rootData = await readCoursePage(first.html, root.href, first.via);
    const rootHost=root.hostname.replace(/^www\./,"");
    const clubPath=root.pathname.match(/^\/(?:grand\/[^/]+|golf\/[^/]+|golfCourse\/[^/]+\/[^/]+)(?:\/|$)/i)?.[0].replace(/\/$/,"");
    const sameHostLinks=(links)=>links.filter(x=>{const u=safeUrl(x.url,root.href);return u&&u.hostname.replace(/^www\./,"")===rootHost&&(!clubPath||u.pathname===clubPath||u.pathname.startsWith(clubPath+"/"));});
    const seen=new Set([root.href]), rawPages=[rootData];
    // Fetch first-level course pages concurrently. A single slow page must not block the others.
    const rank=link=>/yardage|score.?card|ヤーデージ|距離表|スコアカード|コース紹介|(?:^|[/-])course\/?$/i.test(link.title.trim()) || /(?:[/-]course|yardage|score.?card)\/?$/i.test(new URL(link.url).pathname) ? 2 : /コース|course|layout|guide/i.test(link.title+" "+link.url)?1:0;
    const firstLinks=sameHostLinks(rootData.links).sort((a,b)=>rank(b)-rank(a)).slice(0,24);
    const fetchBatch=async(items)=>Promise.all(items.map(async item=>{
      if(seen.has(item.url))return null;seen.add(item.url);
      try{
        const html=await request(item.url);
        return await readCoursePage(html,item.url,"direct");
      }catch(e){return {title:item.title,url:item.url,links:[],images:[],holes:[],error:e.message};}
    }));
    function collectedCards(){
      const cards=new Map();
      for(const p of rawPages)for(const card of p.scorecards||[])cards.set(card.url+"#"+card.title,card);
      return [...cards.values()];
    }

    const levelOne=(await fetchBatch(rootData.scorecards?.length?[]:firstLinks)).filter(Boolean);
    rawPages.push(...levelOne);
    // Discover likely hole detail links one level deeper, still bounded and concurrent.
    const secondLinks=[...new Map(sameHostLinks([rootData,...levelOne].flatMap(p=>p.links||[])).map(link=>[link.url,link])).values()]
      .filter(x=>rank(x)===2||/(hole|no[._-]?\d+|ホール|東|西|east|west|\/\d+\.html|course_[a-z0-9]+)/i.test(x.title+" "+x.url)||/^(?:1[0-8]?|[1-9])(?:h|番|番ホール)?$/i.test(x.title.trim()))
      .filter(x=>!seen.has(x.url))
      .sort((a,b)=>Number(/no[._-]?\d+|ホール\s*\d+/i.test(b.url+" "+b.title))-Number(/no[._-]?\d+|ホール\s*\d+/i.test(a.url+" "+a.title)))
      .slice(0,36);
    const levelTwo=(await fetchBatch(rootData.scorecards?.length?[]:rawPages.some(p=>p.scorecards?.length)?secondLinks.filter(x=>rank(x)===2):secondLinks)).filter(Boolean);
    rawPages.push(...levelTwo);
    const hasScorecards=rawPages.some(p=>p.scorecards?.length);
    const pages=[];
    // Aggregate single-hole detail pages into course buckets using semantic page labels.
    const grouped=new Map();
    for(const p of rawPages){
      for(const h of (p.holes||[])){
        const label=((h.course||"")+" "+p.title+" "+p.url);
        const match=h.course==="コース情報"?null:label.match(/(東|西|南|East|West|South)/i);
        const key=match?(match[1].toLowerCase()==="east"||match[1]==="東"?"東コース":match[1].toLowerCase()==="south"||match[1]==="南"?"南コース":"西コース"):"コース情報";
        if(!grouped.has(key))grouped.set(key,{title:key,url:p.url,links:[],images:[],holes:[],via:p.via});
        const g=grouped.get(key);
        const existingHole=g.holes.find(x=>Number(x.hole)===Number(h.hole));if(!existingHole)g.holes.push(h);else{if(Object.keys(h.teeDistances||{}).length>Object.keys(existingHole.teeDistances||{}).length)Object.assign(existingHole,{yards:h.yards,par:h.par,tee:h.tee});
        Object.assign(existingHole.teeDistances,h.teeDistances);
        existingHole.strokeIndex=h.strokeIndex??existingHole.strokeIndex;
        existingHole.description=h.description||existingHole.description;existingHole.imageUrl=h.imageUrl||existingHole.imageUrl;existingHole.layoutImageUrl=h.layoutImageUrl||existingHole.layoutImageUrl;}

      }
    }
    for(const g of grouped.values()){g.holes.sort((a,b)=>a.hole-b.hole);pages.push(g);}

    if(hasScorecards){
      const cards=collectedCards();
      for(const card of cards){
        const details=pages.find(p=>p.title===card.title);
        if(details)for(const h of card.holes){
          const d=details.holes.find(other=>other.hole===h.hole);
          if(d){h.imageUrl=d.imageUrl;h.description=d.description;}
        }
      }
      const otherCourses=pages.filter(p=>p.title!=="コース情報" && p.holes.length>=9 && !cards.some(c=>c.title===p.title));
      pages.splice(0,pages.length,...cards,...otherCourses);
    }
    const allImages = rawPages.flatMap(p => p.images.map(im => ({ ...im, pageTitle: p.title, pageUrl: p.url })));
    return { statusCode: 200, headers, body: JSON.stringify({ root: root.href, rootTitle: rootData.title.split(/\s*(?:&#8211;| – )\s*/)[0], pages, images: allImages, scannedPages: rawPages.length, sourceMode: [...new Set([first.via,...pages.map(p=>p.via).filter(Boolean)])] }) };
  } catch (e) { return { statusCode: 502, headers, body: JSON.stringify({ error: e.message || "サイトを調査できませんでした" }) }; }
};
