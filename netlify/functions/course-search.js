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
    details.set(hole, { description: desc, imageUrl: imgs[0]?.url || "" });
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
      rows.push({hole,par:Number(parMatch[1]),strokeIndex:hdcpMatch?Number(hdcpMatch[1]):null,yards:a||b,tee:a?"REG（Aグリーン）":"REG（Bグリーン）",description:featureMatch?featureMatch[1].trim():"",imageUrl:imgs[0]?.url||"",greenDistances:{A:a,B:b},course:titleMatch[1].toLowerCase()==="east"?"東コース":"西コース"});
    }
  }
  return rows.map(r => ({ ...r, ...details.get(r.hole), course: courseName, sourceUrl: pageUrl }));
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
 // Most official hole-detail pages contain exactly one hole and a labeled tee row.
 // Read the values after the complete header instead of assuming HTML table markup.
 const header=/BACK\s+TEE[\s|｜]*REG\s+TEE[\s|｜]*LADIES\s+TEE[\s|｜]*PAR[\s|｜]*HDCP/i;
 const hm=header.exec(text);
 let holeMatch=text.match(/\bHOLE\s*(?:No\.?\s*)?(\d{1,2})\b/i);
 if(!holeMatch)holeMatch=pageUrl.match(/\/(?:course|hole)\/(\d{1,2})\.html?/i);
 if(hm&&holeMatch){
  const tail=text.slice(hm.index+hm[0].length,hm.index+hm[0].length+260);
  const nums=[...tail.matchAll(/\b\d{1,4}\b/g)].map(x=>Number(x[0]));
  // First three are tee yardages, followed by PAR and HDCP.
  const valid=nums.findIndex((n,i)=>n>=100&&n<=800&&nums[i+1]>=100&&nums[i+1]<=800&&nums[i+2]>=100&&nums[i+2]<=800&&nums[i+3]>=3&&nums[i+3]<=5&&nums[i+4]>=1&&nums[i+4]<=18);
  if(valid>=0){
   const [back,reg,ladies,par,hdcp]=nums.slice(valid,valid+5);
   rows.push({hole:Number(holeMatch[1]),par,strokeIndex:hdcp,yards:reg,tee:"REG",teeDistances:{BACK:back,REG:reg,LADIES:ladies},description:text.slice(0,900),course:/south|南/i.test(courseName+" "+pageUrl)?"南コース":/east|東/i.test(courseName+" "+pageUrl)?"東コース":/west|西/i.test(courseName+" "+pageUrl)?"西コース":"",sourceUrl:pageUrl});
  }
 }
 // Generic fallback for pages whose labels are presented vertically rather than in a row.
 if(!rows.length){
  const re=/(?:HOLE\s*No\.?\s*|HOLE\s*|ホール\s*)(\d{1,2})/gi,heads=[...text.matchAll(re)];
  for(let i=0;i<heads.length;i++){
   const hole=Number(heads[i][1]);if(hole<1||hole>18)continue;
   const block=text.slice(heads[i].index,heads[i+1]?.index??Math.min(text.length,heads[i].index+1800));
   const par=Number((block.match(/\bPAR\s*:?\s*([3-5])\b/i)||[])[1]),hdcp=Number((block.match(/\bHDCP\s*:?\s*(\d{1,2})\b/i)||[])[1]);
   if(!par)continue;
   const get=label=>Number((block.match(new RegExp(label+"[^0-9]{0,20}(\\d{2,4})","i"))||[])[1])||null;
   const back=get("BACK(?:\\s+TEE)?"),reg=get("REG(?:ULAR)?(?:\\s+TEE)?"),ladies=get("LADIES(?:\\s+TEE)?");
   if(back||reg||ladies)rows.push({hole,par,strokeIndex:hdcp||null,yards:reg||back||ladies,tee:reg?"REG":back?"BACK":"LADIES",teeDistances:{BACK:back,REG:reg,LADIES:ladies},description:block.slice(0,700),sourceUrl:pageUrl});
  }
 }
 return rows;
}
function parsePage(html, pageUrl, via) {
  const page = new URL(pageUrl), title = clean((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || page.hostname);
  const links = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = (m[1].match(/\bhref=["']([^"']+)["']/i) || [])[1]; if (!href) continue;
    const u = safeUrl(href, page.href); if (!u || u.hostname !== page.hostname) continue;
    const label = clean(m[2]) + " " + clean((m[2].match(/<img\b[^>]*alt=["]([^"]*)/i)||[])[1]||"");
    if (/(コース|レイアウト|ホール|course|layout|hole|east|west|south|north|東|西|南|北|no[._-]?[0-9]+|\/[0-9]+\.html|course_[a-z0-9]+)/i.test(label + " " + u.pathname) && !links.some(x=>x.url===u.href)) links.push({ title: label || u.pathname, url: u.href });
  }
  return { title, url: page.href, links, images: extractImages(html, page.href), holes: [...parseMatrixTables(html,page.href,title),...parseLabeledHoles(html,page.href,title),...parseHoleData(html,page.href,title)].filter((x,i,a)=>a.findIndex(y=>y.hole===x.hole)===i), via };
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
    const seen=new Set([root.href]), rawPages=[];
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
    const secondLinks=sameHostLinks(levelOne.flatMap(p=>p.links||[]))
      .filter(x=>/(hole|no[._-]?\d+|ホール|東|西|east|west|\/\d+\.html|course_[a-z0-9]+)/i.test(x.title+" "+x.url)||/^(?:1[0-8]?|[1-9])(?:h|番|番ホール)?$/i.test(x.title.trim()))
      .filter(x=>!seen.has(x.url)).slice(0,36);
    const levelTwo=(await fetchBatch(secondLinks)).filter(Boolean);
    rawPages.push(...levelTwo);
    const pages=[];
    // Aggregate single-hole detail pages into course buckets using semantic page labels.
    const grouped=new Map();
    for(const p of rawPages){
      for(const h of (p.holes||[])){
        const label=(p.title+" "+p.url+" "+(h.course||""));
        const match=label.match(/(東|西|南|East|West|South)/i);
        const key=match?(match[1].toLowerCase()==="east"||match[1]==="東"?"東コース":match[1].toLowerCase()==="south"||match[1]==="南"?"南コース":"西コース"):"コース情報";
        if(!grouped.has(key))grouped.set(key,{title:key,url:p.url,links:[],images:[],holes:[],via:p.via});
        const g=grouped.get(key);
        if(!g.holes.some(x=>Number(x.hole)===Number(h.hole)))g.holes.push(h);
        g.images.push(...(p.images||[]));
      }
    }
    for(const g of grouped.values()){g.holes.sort((a,b)=>a.hole-b.hole);pages.push(g);}
    for(const p of rawPages)if((p.holes||[]).length>=9&&!pages.some(g=>g.url===p.url))pages.push(p);
    const allImages = rawPages.flatMap(p => p.images.map(im => ({ ...im, pageTitle: p.title, pageUrl: p.url })));
    return { statusCode: 200, headers, body: JSON.stringify({ root: root.href, rootTitle: rootData.title, pages, images: [...rootData.images.map(im=>({...im,pageTitle:rootData.title,pageUrl:root.href})),...allImages], scannedPages: rawPages.length + 1, sourceMode: [...new Set([first.via,...pages.map(p=>p.via).filter(Boolean)])] }) };
  } catch (e) { return { statusCode: 502, headers, body: JSON.stringify({ error: e.message || "サイトを調査できませんでした" }) }; }
};
