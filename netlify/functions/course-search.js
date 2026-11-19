const { URL } = require("url");
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const clean = (s = "") => s.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
async function request(url, accept = "text/html,*/*;q=0.8") {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36", accept }, redirect: "follow", signal: AbortSignal.timeout(1800) });
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
function parsePage(html, pageUrl, via) {
  const page = new URL(pageUrl), title = clean((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || page.hostname);
  const links = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = (m[1].match(/\bhref=["']([^"']+)["']/i) || [])[1]; if (!href) continue;
    const u = safeUrl(href, page.href); if (!u || u.hostname !== page.hostname) continue;
    u.hash="";
    const label = clean(m[2]) + " " + clean((m[2].match(/<img\b[^>]*alt=["]([^"]*)/i)||[])[1]||"");
    if (/(コース|レイアウト|ホール|course|layout|hole|east|west|south|north|東|西|南|北|no[._-]?[0-9]+|\/[0-9]+\.html|course_[a-z0-9]+)/i.test(label + " " + u.pathname) && !links.some(x=>x.url===u.href)) links.push({ title: label || u.pathname, url: u.href });
  }
  const cards=parseHoleCards(html,page.href,title);
  if(cards.length)return {title,url:page.href,links,images:extractImages(html,page.href),holes:cards,via};
  const matrix=parseAnegasakiTables(html,page.href,title);
  const details=parseHoleData(html,page.href,title);
  const scores=matrix.length?matrix:parseMatrixTables(html,page.href,title);
  const holes=scores.length?scores.map(score=>{
    const detail=details.find(d=>d.hole===score.hole && (d.imageUrl||d.description));
    return detail?{...score,imageUrl:detail.imageUrl,description:detail.description}:score;
  }):[...parseLabeledHoles(html,page.href,title),...details].filter((row,index,all)=>
    all.findIndex(other=>other.hole===row.hole&&other.course===row.course)===index);
  return {title,url:page.href,links,images:extractImages(html,page.href),holes,via};
}
exports.handler = async (event) => {
  try {
    const raw = event.queryStringParameters?.page;
    if (!raw) return { statusCode: 400, headers, body: JSON.stringify({ error: "公式サイトURLを指定してください" }) };
    const root = new URL(raw);
    if (!["http:", "https:"].includes(root.protocol) || root.hostname === "localhost" || root.hostname.endsWith(".local") || /^\d{1,3}(\.\d{1,3}){3}$/.test(root.hostname)) throw new Error("このURLは確認できません");
    const first = await getPage(root.href), rootData = parsePage(first.html, root.href, first.via);
    const rootHost=root.hostname.replace(/^www\./,"");
    const sameHostLinks=(links)=>links.filter(x=>{const u=safeUrl(x.url,root.href);return u&&u.hostname.replace(/^www\./,"")===rootHost;});
    const seen=new Set([root.href]), rawPages=[rootData];
    // Fetch first-level course pages concurrently. A single slow page must not block the others.
    const firstLinks=sameHostLinks(rootData.links).sort((a,b)=>Number(/course|layout|コース|レイアウト|guide/i.test(b.title+" "+b.url))-Number(/course|layout|コース|レイアウト|guide/i.test(a.title+" "+a.url))).slice(0,24);
    const fetchBatch=async(items)=>Promise.all(items.map(async item=>{
      if(seen.has(item.url))return null;seen.add(item.url);
      try{
        const html=await request(item.url);
        return parsePage(html,item.url,"direct");
      }catch(e){return {title:item.title,url:item.url,links:[],images:[],holes:[],error:e.message};}
    }));
    const levelOne=(await fetchBatch(firstLinks)).filter(Boolean);
    rawPages.push(...levelOne);
    // Discover likely hole detail links one level deeper, still bounded and concurrent.
    const secondLinks=[...new Map(sameHostLinks([rootData,...levelOne].flatMap(p=>p.links||[])).map(link=>[link.url,link])).values()]
      .filter(x=>/(hole|no[._-]?\d+|ホール|東|西|east|west|\/\d+\.html|course_[a-z0-9]+)/i.test(x.title+" "+x.url)||/^(?:1[0-8]?|[1-9])(?:h|番|番ホール)?$/i.test(x.title.trim()))
      .filter(x=>!seen.has(x.url))
      .sort((a,b)=>Number(/no[._-]?\d+|ホール\s*\d+/i.test(b.url+" "+b.title))-Number(/no[._-]?\d+|ホール\s*\d+/i.test(a.url+" "+a.title)))
      .slice(0,36);
    const levelTwo=(await fetchBatch(secondLinks)).filter(Boolean);
    rawPages.push(...levelTwo);
    const pages=[];
    // Aggregate single-hole detail pages into course buckets using semantic page labels.
    const grouped=new Map();
    for(const p of rawPages){
      for(const h of (p.holes||[])){
        const label=((h.course||"")+" "+p.title+" "+p.url);
        const match=label.match(/(東|西|南|East|West|South)/i);
        const key=match?(match[1].toLowerCase()==="east"||match[1]==="東"?"東コース":match[1].toLowerCase()==="south"||match[1]==="南"?"南コース":"西コース"):"コース情報";
        if(!grouped.has(key))grouped.set(key,{title:key,url:p.url,links:[],images:[],holes:[],via:p.via});
        const g=grouped.get(key);
        const existingHole=g.holes.find(x=>Number(x.hole)===Number(h.hole));if(!existingHole)g.holes.push(h);else{if(Object.keys(h.teeDistances||{}).length>Object.keys(existingHole.teeDistances||{}).length)Object.assign(existingHole,{teeDistances:h.teeDistances,yards:h.yards,par:h.par,tee:h.tee});
        existingHole.strokeIndex=h.strokeIndex??existingHole.strokeIndex;
        existingHole.description=h.description||existingHole.description;existingHole.imageUrl=h.imageUrl||existingHole.imageUrl;existingHole.layoutImageUrl=h.layoutImageUrl||existingHole.layoutImageUrl;}

      }
    }
    for(const g of grouped.values()){g.holes.sort((a,b)=>a.hole-b.hole);pages.push(g);}

    const allImages = rawPages.flatMap(p => p.images.map(im => ({ ...im, pageTitle: p.title, pageUrl: p.url })));
    return { statusCode: 200, headers, body: JSON.stringify({ root: root.href, rootTitle: rootData.title, pages, images: allImages, scannedPages: rawPages.length, sourceMode: [...new Set([first.via,...pages.map(p=>p.via).filter(Boolean)])] }) };
  } catch (e) { return { statusCode: 502, headers, body: JSON.stringify({ error: e.message || "サイトを調査できませんでした" }) }; }
};
