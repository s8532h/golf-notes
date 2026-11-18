function prepTitle(plan) {
  return [plan.date, plan.course, courseTeeLabel(plan.tee), plan.start === 10 ? "IN" : "OUT"].join(" ・ ");
}

function prepHoles(plan) {
  const rows = uniqueCourseRows(typed("course_note").filter(row => row.course === plan.course));
  return [plan.start, plan.start + 1, plan.start + 2].map(number => {
    const siblings = rows.filter(row => courseHoleNumber(row) === number);
    const row = siblings.find(row => canonicalCourseTee(row) === plan.tee);
    const entry = plan.shots[number] || {};
    return {
      number, par: row?.par, yards: row?.golfCoreYards,
      club: entry.club ?? (row?.teeClub || siblings.find(s => s.teeClub)?.teeClub || ""),
      aim: entry.aim ?? (row?.teeAim || siblings.find(s => s.teeAim)?.teeAim || "")
    };
  });
}

function prepGoal(plan) {
  return plan.goalType === "opening" ? "最初の3ホールを合計＋3以内" : plan.goal;
}

function roundGoalView(round) {
  const plan = round.preparation;
  if (!plan) return "";
  let result = "";
  if (plan.goalType === "opening") {
    const opening = (round.holes || []).slice(0, 3);
    const pars = opening.map((h, i) => h.par ?? plan.pars[i]);
    if (opening.length === 3 && pars.every(p => Number(p) > 0)) {
      const diff = opening.reduce((sum,h,i) => sum + h.score - pars[i], 0);
      result = '最初の3ホール ' + (diff > 0 ? '＋' : '') + diff + '（' + (diff <= 3 ? '達成' : '未達') + '）';
    } else result = "結果未集計（最初の3ホールのスコアとParが必要）";
  }
  return '<p class="small"><b>当日の目標</b>　' + esc(prepGoal(plan)) + (result ? '<br>' + esc(result) : '') + '</p>';
}

function prepOptions(values, selected, label = value => value) {
  return values.map(value => '<option value="'+esc(value)+'" '+(value===selected?'selected':'')+'>'+esc(label(value))+'</option>').join('');
}

function renderCourseChecklist() {
  const el = document.getElementById("courseChecklist");
  const plans = typed("round_preparation");
  const plan = plans.find(p => p.id === localStorage.getItem("activeRoundPreparation")) || plans.find(p => p.date === todayISO()) || plans[0];
  const books = typed("course_note");
  const courses = [...new Set(books.map(r => r.course).filter(Boolean))];
  const roundPicker = document.getElementById("roundPreparation");
  const pending = plans.filter(p => !typed("round").some(r => r.preparation?.id === p.id));
  roundPicker.innerHTML = '<option value="">準備を使わず記録</option>' + prepOptions(pending.map(p=>p.id),roundPicker.value,id=>prepTitle(pending.find(p=>p.id===id)));
  el.innerHTML = (plan ? '<label>準備するラウンド<select id="prepPick">'+prepOptions(plans.map(p=>p.id),plan.id,id=>prepTitle(plans.find(p=>p.id===id)))+'</select></label>' : '') +
    '<details id="prepNew" '+(!plan?'open':'')+'><summary>新しいラウンドを準備</summary><form id="prepForm"><label>プレー日<input name="date" type="date" value="'+todayISO()+'" required></label><label>コース<input name="course" list="prepCourses" maxlength="80" required placeholder="攻略ノートから選択・直接入力"></label><datalist id="prepCourses">'+prepOptions(courses)+'</datalist><label>使用ティー<select name="tee"></select></label><label>スタート<select name="start"><option value="1">OUT（1H）</option><option value="10">IN（10H）</option></select></label><button class="chip" type="submit">このラウンドを準備</button></form></details><div id="prepBody"></div>';
  function select(id) { localStorage.setItem("activeRoundPreparation",id); renderCourseChecklist(); }
  if(plan) el.querySelector("#prepPick").onchange=e=>select(e.target.value);
  const form=el.querySelector("#prepForm"), fields=form.elements;
  function updateTees() {
    const tees=[...new Set(books.filter(r=>r.course===fields.course.value.trim()).map(canonicalCourseTee))];
    if(!tees.length) tees.push("REGULAR","BACK","FRONT","LADY","未分類");
    fields.tee.innerHTML=prepOptions(tees,tees.find(t=>/^REGULAR/.test(t)),courseTeeLabel);
  }
  fields.course.oninput=updateTees; updateTees();
  form.onsubmit=e=>{
    e.preventDefault();
    const course=fields.course.value.trim();
    if(!course) return;
    const data={date:fields.date.value,course,tee:fields.tee.value,start:Number(fields.start.value)};
    const existing=plans.find(p=>Object.keys(data).every(k=>p[k]===data[k]));
    if(existing) return select(existing.id);
    const next={...data,id:makeId(),type:"round_preparation",updatedAt:new Date().toISOString(),shots:{},goalType:"opening",goal:"",green:"",ready:false};
    saved.unshift(next); persistSaved(); select(next.id);
  };
  if(!plan) return;
  const holes=prepHoles(plan), first=holes[0], body=el.querySelector("#prepBody");
  body.innerHTML='<p><b>今日の目標</b><br><span id="prepGoalText"></span></p><p><b>最初の一打 ・ '+first.number+'H</b><br><span id="prepFirst"></span></p><p class="small" id="prepGreenSummary"></p><details id="prepEdit" '+(plan.ready?'':'open')+'><summary>'+(plan.ready?'準備完了 ・ 見直す':'スタート前の準備')+'</summary><label>当日の目標<select id="prepGoalType">'+prepOptions(["opening","custom"],plan.goalType,k=>k==="opening"?"最初の3ホールを合計＋3以内":"自分で決める")+'</select></label><label id="prepCustom">目標をひとつ<input data-field="goal" maxlength="120" value="'+esc(plan.goal)+'"></label><h4>最初の3ホール</h4>'+
    holes.map(h=>'<fieldset><legend>'+h.number+'H'+(h.par?' ・ Par '+esc(h.par):'')+(h.yards?' ・ '+esc(h.yards)+'yd':'')+'</legend><label>最初のクラブ<input data-shot="club" data-hole="'+h.number+'" maxlength="60" value="'+esc(h.club)+'"></label><label>狙い所<input data-shot="aim" data-hole="'+h.number+'" maxlength="240" value="'+esc(h.aim)+'"></label></fieldset>').join('')+
    '<label>練習グリーンのメモ<input data-field="green" maxlength="160" placeholder="例：今日は少し速い" value="'+esc(plan.green)+'"></label><button class="chip active" id="prepDone">準備完了</button></details>'+
    (pending.some(p=>p.id===plan.id)?'<button class="chip" id="prepLog">この準備でスコアを記録</button>':'<p class="small">ラウンド記録に保存済み</p>');
  function summary() {
    body.querySelector("#prepGoalText").textContent=prepGoal(plan)||"目標を入力";
    const shot=plan.shots[first.number]||{};
    body.querySelector("#prepFirst").textContent=[shot.club??first.club,shot.aim??first.aim].filter(Boolean).join(" ・ ")||"クラブと狙い所を入力";
    const greenSummary=body.querySelector("#prepGreenSummary");
    greenSummary.textContent=plan.green?"グリーンの速さ・感触　"+plan.green:"";
    greenSummary.hidden=!plan.green;
    body.querySelector("#prepCustom").hidden=plan.goalType!=="custom";
  }
  function save() {plan.updatedAt=new Date().toISOString();persistSaved();summary();}
  body.onchange=e=>{
    const input=e.target;
    if(input.dataset.shot) (plan.shots[input.dataset.hole]??={})[input.dataset.shot]=input.value.trim();
    else if(input.dataset.field) plan[input.dataset.field]=input.value.trim();
    else if(input.id==="prepGoalType") plan.goalType=input.value;
    else return;
    save();
  };
  body.querySelector("#prepDone").onclick=()=>{
    if(!prepGoal(plan)?.trim()){body.querySelector('[data-field="goal"]').focus();return;}
    plan.ready=true;save();renderCourseChecklist();
  };
  const log=body.querySelector("#prepLog");
  if(log) log.onclick=()=>{roundPicker.value=plan.id;roundPicker.dispatchEvent(new Event("change"));showPage("round");};
  summary();
}

function initRoundPreparationForm() {
  const picker=document.getElementById("roundPreparation");
  picker.onchange=()=>{
    const plan=typed("round_preparation").find(p=>p.id===picker.value);
    if(plan){
      document.getElementById("roundDate").value=plan.date;
      document.getElementById("courseName").value=plan.course;
      document.getElementById("roundStartCourse").value=plan.start===10?"IN":"OUT";
    }
    document.getElementById("roundPrepGoal").textContent=plan?"当日の目標　"+(prepGoal(plan)||"未設定"):"";
  };
  for(const id of ["roundDate","courseName","roundStartCourse"]){
    document.getElementById(id).addEventListener("input",()=>{picker.value="";picker.onchange();});
  }
}
