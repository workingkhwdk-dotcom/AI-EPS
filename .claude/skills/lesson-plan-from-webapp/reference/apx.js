// 부록 생성기: 웹앱의 실제 사건 파일·프롬프트 코드에서 직접 가져와 정리한다(손으로 옮기지 않는다).
const path = require("path");
const REPO = path.resolve(__dirname, "../..");
const F = path.join(REPO, "functions");
const { SOURCES, EVENTS, PERSONAS, MATERIALS, CASES, AFTERMATH } = require(path.join(F, "case.js"));
const prompts = require(path.join(F, "prompts.js"));
const guard = require(path.join(F, "guard.js"));
const lookup = require(path.join(F, "lookup.js"));
const conduct = require(path.join(F, "conduct.js"));
const { CHARTER } = require(path.join(F, "charter.js"));

const e = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const ev = EVENTS.jeju2018;
const JEJU_IDS = new Set(Object.keys(require(path.join(F, "cases/jeju2018.js")).SOURCES));
const people = PERSONAS.filter((p) => p.events.includes("jeju2018"));
const D = JSON.parse(require("fs").readFileSync(path.join(REPO, "public/demo/data/jeju2018.json"), "utf8"));
const CROSS = { ok: "교차 확인", partial: "일부 확인", fixed: "고쳐 씀", todo: "확인 못 함" };
const DROP = new Set(["N1", "N6", "N7", "C2", "C4"]);
const ids = (x) => (Array.isArray(x) ? x : [x]).filter((i) => !DROP.has(i)).join(", ");
const ul = (xs) => `<ul class="bl">${xs.map((x) => `<li>${e(x)}</li>`).join("")}</ul>`;
const BOOK = `<svg class="bk" viewBox="0 0 70 40" width="62" height="36"><path d="M35 34C28 29 14 29 4 32V11c10-3 24-3 31 2 7-5 21-5 31-2v21c-10-3-24-3-31 2z" fill="#fff" stroke="#444" stroke-width="1.6"/><path d="M35 13v21" stroke="#444" stroke-width="1.4"/><path d="M35 12c0-5 2-8 7-9-1 5-3 8-7 9z" fill="#5a9a46"/><path d="M35 12c0-4-2-7-6-8 0 4 2 7 6 8z" fill="#7bb661"/></svg>`;
const abar = (n, title, note = "") => `<div class="abar">${BOOK}<span class="an">부록 ${n}</span><span class="at">${title}</span></div>`;
const h3 = (t, note = "") => { const m = /^부록 (\d+)\. (.*)$/.exec(t); return m ? abar(m[1], m[2], note) : `<h3 class="ap">${t}</h3>`; };
const h4 = (t) => `<h4>${t}</h4>`;
const p0 = (t) => `<p class="ap0">${t}</p>`;
const pre = (t) => `<pre class="prm">${e(t)}</pre>`;

// ---- 프롬프트를 [라벨] 단위로 나눠 읽기 쉬운 표로 보여 준다(문장은 코드가 만든 그대로) ----
const PH = /\((?:모둠이|교사가|이번 질문|학생이|인물 AI가|출처 제목|검색 요약|믿음|이번 질문으로)[^)]*\)/g;
const inl = (t) => e(t).replace(PH, (m) => `<span class="ph">${m}</span>`).replace(/^(?:\[|\()(증언|사실|주장|의견)(?:\]|\))\s*/, '<i class="tg">$1</i>');
function parsePrompt(text) {
  const secs = [{ label: "", lines: [] }];
  for (const ln of text.split("\n")) {
    const m = /^\[([^\]]+)\]\s*(.*)$/.exec(ln);
    if (m) secs.push({ label: m[1], lines: m[2] ? [m[2]] : [] }); else if (ln.trim()) secs[secs.length - 1].lines.push(ln);
  }
  return secs.filter((s) => s.label || s.lines.length);
}
function body(lines) {
  let out = "", ul = [];
  const flush = () => { if (ul.length) { out += `<ul class="pbl">${ul.map((x) => `<li>${inl(x)}</li>`).join("")}</ul>`; ul = []; } };
  for (const ln of lines) {
    let m;
    if ((m = /^- (.*)$/.exec(ln))) ul.push(m[1]);
    else if ((m = /^(\d+(?:-\d+)*)\.\s+(.*)$/.exec(ln))) { flush(); out += `<div class="pn"><b>${m[1]}</b><span>${inl(m[2])}</span></div>`; }
    else if ((m = /^■\s*(.*?)(?::\s*(.*))?$/.exec(ln))) { flush(); out += `<div class="pn sq"><b>■</b><span>${m[2] !== undefined ? `<u>${e(m[1])}</u> ${inl(m[2])}` : e(m[1])}</span></div>`; }
    else { flush(); out += `<p class="pp">${inl(ln)}</p>`; }
  }
  flush();
  return out;
}
// meta: [[쓰이는 곳, ...], ...], opt.groups: [[묶음 이름, [라벨 앞부분...]]], opt.common: 앞 프롬프트와 같은 첫 문단
function pv(title, meta, text, opt = {}) {
  let secs = parsePrompt(text);
  let h = `<div class="pvtop"><div class="pcardhd"><span class="pcn">${title.n}</span><span class="pct">${e(title.t)}</span></div>`;
  h += `<div class="pmeta">${meta.map(([k, v]) => `<div><b>${k}</b><span>${v}</span></div>`).join("")}</div></div>`;
  const rows = []; let grp = "";
  for (const s of secs) {
    if (opt.groups && s.label) { const g = opt.groups.find(([, ls]) => ls.some((l) => s.label.startsWith(l))); if (g && g[0] !== grp) { grp = g[0]; rows.push(`<div class="pg">${e(grp)}</div>`); } }
    let main = s.label, note = "";
    const q = /^(.*?)\s*\((.*)\)$/.exec(s.label); if (q) { main = q[1]; note = q[2]; }
    let lines = s.lines;
    if (!s.label && opt.common && lines[0] === opt.common.text) lines = [`(${opt.common.note})`, ...lines.slice(1)];
    const chip = s.label ? `<span class="pl">${e(main)}</span>${note ? `<span class="pln">${e(note)}</span>` : ""}` : `<span class="pl h">머리말</span>`;
    rows.push(`<div class="prow${lines.length > 9 ? " long" : ""}"><div class="k">${chip}</div><div class="v">${body(lines)}</div></div>`);
  }
  return h + `<div class="pv">${rows.join("")}</div>`;
}
const DLH = new Set(["원칙", "항목", "장치", "설정", "관점(고등)"]);
const dl = (rows, w) => `<div class="dl">${rows.map(([k, v]) => `<div class="dr"${w ? ` style="grid-template-columns:${w} 1fr"` : ""}><div class="dk">${k}</div><div class="dv">${v}</div></div>`).join("")}</div>`;
const tbl = (head, rows, cls = "mini sm", widths = []) => head.length === 2 && DLH.has(head[0]) ? dl(rows, widths[0]) : `<table class="${cls}">${widths.length ? `<colgroup>${widths.map((w) => `<col style="width:${w}">`).join("")}</colgroup>` : ""}<tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</table>`;

// ============ 부록 1. 사건과 인물 구성 자료 ============
function apx1() {
  let h = h3("부록 2. 사건과 인물 구성 자료", "※ 1단계 인물(가상 인물)을 만들 때 쓴 자료를 구성 순서대로 정리함");
  h += p0("인물과 사건 자료를 만들 때 따른 원칙과 사건의 범위, 공통 배경, 인물 아홉 명의 입장을 정리했습니다. 학생에게는 편지와 대화만 보이고, 여기 정리한 내용은 AI가 인물로 말할 때 바탕이 됩니다.");

  h += h4("2-1. 인물 구성 원칙");
  h += tbl(["원칙", "내용"], [
    ["① 실제 보도에 근거", "사건의 사실(수치·날짜·제도·발언)은 신문·방송·공공기관·국제기구의 보도에서 가져오고, 문장마다 출처 ID(J·N·C·A)를 붙입니다. 출처는 부록 5에 모았습니다."],
    ["② 실존 인물이 아닌 가상 인물", "인물은 여러 인터뷰·보도를 융합해 만든 수업용 인물입니다. 이름·나이·가족·삶의 이야기·기억나는 장면은 <b>창작</b>이며, 특정 개인을 나타내지 않습니다(‘융합 근거’ 항목에 밝힘)."],
    ["③ 근거 진술에 종류 표시", "인물이 ‘알고 겪은 일’(근거 진술)에는 <b>사실·증언·주장·의견</b> 표시가 붙습니다. 인물은 주장·믿음을 자기 생각으로 말하되, 정부·기관이 공식 확인한 사실처럼 꾸미지 않습니다."],
    ["④ 네 축, 아홉 명", "당사자(2) · 도민(3) · 시민사회(2) · 제도(2). 한쪽으로 쏠리지 않는 입장 분포를 두고, 모둠에는 당사자 축 인물이 꼭 한 명 있도록 합니다."],
    ["⑤ 틀릴 수 있는 믿음", "인물마다 ‘사실이라고 믿지만 틀리거나 과장일 수 있는 것’을 하나 이상 설계하고, 실제는 어떤지 함께 적어 둡니다. 학생이 2~3단계에서 자료로 확인하게 하려는 장치입니다."],
    ["⑥ 범위와 경계", "사건의 시간·장소·허용 주제·범위 밖(예: 다른 난민 사건, 2018년 이후 정책 예측)을 정하고, 민감한 이야기(예: 제주 4·3)는 인물이 짧게만 말하도록 ‘조심할 이야기’를 둡니다."],
    ["⑦ 교사 확인", "출처마다 교사가 원문에서 볼 점을 적어 두었습니다(부록 5). 근거 진술은 보도와 자료를 대조해 정리한 것이므로 <b>수업 전에 교사가 원문을 확인</b>해 주세요."],
  ], "mini", ["32mm", ""]);

  h += h4("2-2. 사건 개요와 범위");
  h += tbl(["항목", "내용"], [
    ["사건", e(ev.title)],
    ["개요", e(ev.summary)],
    ["대화 시점", e(ev.now)],
    ["범위", `${e(ev.scope.event)} / ${e(ev.scope.time)} / ${e(ev.scope.place)}`],
    ["허용 주제", ul(ev.scope.allowedTopics)],
    ["범위 밖", ul(ev.scope.outOfScope)],
    ["입장의 네 축", `${e(ev.axes.join(" · "))} (꼭 있어야 할 축: ${e(ev.requiredAxis)}, 개인으로 등장하는 축: ${e(ev.personalAxes.join("·"))}) · 이해관계자: ${e(ev.stakeholders.join(" / "))}`],
  ], "mini", ["24mm", ""]);
  h += h4("사건 공통 배경(모든 인물이 아는 사실)");
  h += tbl(["진술", "종류", "출처"], ev.background.map(([t, id, k]) => [e(t), k, e(ids(id))]), "mini sm", ["", "12mm", "13mm"]);

  h += `<div class="pb"></div>`;
  h += h4("2-3. 인물 아홉 명 한눈에");
  h += tbl(["이름", "축", "역할", "입장", "틀릴 수 있는 믿음(학생 검증용)"], people.map((p) => [
    `<b>${e(p.name)}</b>`, e(p.axis), e(p.role), e(p.stance), ul((p.beliefs || []).map((b) => b[0])),
  ]), "mini xs tight", ["14mm", "15mm", "36mm", "36mm", ""]);

  return h;
}

// ============ 부록 2. 인물 편지 ============
function apx2() {
  const AX = { 당사자: "ax1", 도민: "ax2", 시민사회: "ax3", 제도: "ax4" };
  let h = h3("부록 3. 인물 편지 전문", "※ 1단계에서 학생이 읽는 편지(웹앱 탑재)");
  h += p0("학생은 아홉 통을 모두 읽고 모둠에서 한 사람이 한 명씩 고릅니다. 편지의 날짜·장소는 사건 설정(" + e(D.ui.letterSign) + ")입니다.");
  h += `<div class="lcols">${D.letters.map((l) => { const p = people.find((x) => x.id === l.id); const ax = p ? p.axis : ""; return `<div class="letter ${AX[ax] || ""}"><div class="lstamp"><span>제주</span><span>2018</span></div><div class="lhead"><span class="lax">${e(ax)}${l.required ? " · 꼭 필요한 당사자" : ""}</span><span class="lname">${e(l.name)}</span><span class="lbrief">${e(l.brief)}</span></div><div class="lbody">${l.letter.map((t) => `<p>${e(t)}</p>`).join("")}</div><p class="sign">${e(D.ui.letterSign)}<br>${e(l.name)} 드림</p></div>`; }).join("")}</div>`;
  return h;
}

// ============ 부록 5. 출처 목록 ============
const DATE_FIX = { C5: "2016", C6: "2026-04-21", A4: "2020-02-14", C9: "2017-10" };
function apx6() {
  const ents = Object.entries(SOURCES).filter(([id]) => JEJU_IDS.has(id) && !DROP.has(id));
  let h = h3("부록 5. 출처 목록", "※ 인물·자료의 근거가 된 보도와 자료 " + ents.length + "건");
  h += p0("ID 앞글자는 J(사건 보도), N(보충 보도), C(해외 사례), A(이후 전개)입니다. 모든 출처는 매체·날짜·제목과 핵심 내용을 대조해 정리했습니다. ‘원문에서 볼 점’은 수업 전에 원문을 열어 확인할 부분입니다.");
  h += tbl(["ID", "매체·날짜·제목", "원문에서 볼 점"], ents.map(([id, s]) => {
    const date = DATE_FIX[id] ? e(DATE_FIX[id]) : /확인/.test(s.date) ? "" : e(s.date);
    return [id, `<b>${e(s.outlet.replace(/,\s*확인 필요/g, "").replace(/\s*\(확인 필요\)/g, ""))}</b> ${date}<br>${e(s.title)}${s.titleIsDescriptive ? " (설명 문구)" : ""}<br><span class="url">${e(s.url)}</span>`, e(s.check)];
  }), "mini sm src", ["11mm", "84mm", ""]);
  return h;
}

// ============ 부록 4. AI 설계의 공개 ============
function apx4() {
  const evctx = (over = {}) => ({ summary: ev.summary, premise: ev.summary, level: "high", deep: { sources: true, tradeoff: true, causeMap: true }, problem: "(모둠이 1단계에서 정한 문제 질문이 들어감)", cause: "(모둠이 3단계에서 정한 가장 큰 원인이 들어감)", evidence: "(모둠이 확인한 사실이 들어감)", ...over });
  const adel = people.find((p) => p.id === "j_applicant");
  let h = h3("부록 4. AI 설계의 공개: 프롬프트와 하네스", "※ 수업에서 쓰이는 AI가 어떻게 만들어졌고 어떻게 통제되는지");
  h += p0("이 부록은 AI-EPS 웹앱의 서버 코드를 근거로 작성했습니다. <b>프롬프트는 코드가 실제로 조립한 문장 그대로</b>이며, 대괄호 ( ) 안의 설명은 수업 중에 학생 글이나 자료로 채워지는 자리입니다. 모델 이름과 사고량은 서버 설정이라 운영 중 바뀔 수 있습니다(2026-10 기준 기본값).");

  h += h4("4-1. 단계별 AI 한눈에 보기");
  h += tbl(["단계", "AI의 역할 (신호등)", "모델·설정(기본)", "서버가 확인하는 호출 조건(선행 사고)", "횟수 한도", "AI가 내는 결과"], [
    ["1", "경험 전달자: 가상 인물 + 감독자 AI (노랑)", "인물·감독자: gpt-5.6-terra, 사실 조회: gpt-5.6-luna + web_search · 사고량 low", "인물을 먼저 고름. 메시지 500자 이하(사전 질문 없이 학생이 먼저 말을 걺). 대화 규칙으로 멈춘 학생은 불가", "학생당 5번(교사가 1~50으로 설정)", "메신저 말 1~5문장(고등)"],
    ["2", "생각 도우미: 질문만 하는 AI (노랑, 교사가 끌 수 있음)", "gpt-5.6-luna · 사고량 low · JSON", "연결: 내가 쓴 ‘처음 생각의 이유·생활 장면’ 8자 이상. 원인: 모둠 문제(10자 이상)와 원인 2개 이상", "학생당 8번(모둠 한도와 따로 셈)", "유형 판정 + 질문 하나(답·예시·칭찬 없음)"],
    ["3", "검색 보조자 (노랑, 선택)", "gpt-5.6-luna + 수업 자료 + 웹 검색(교사가 끌 수 있음)", "모둠 문제(10자 이상), 2단계 확인 질문(5자 이상), ‘자료와 비교’ 선택(서버 확인). 화면에서는 ‘묻기 전 내 예상’을 써야 묻기 단추가 열림", "모둠당 150회(3~5단계 합계, 교사가 10~500으로 설정)", "알려진 내용·확인할 곳·불확실한 점(10줄 이내). 맞다 틀리다는 정하지 않음"],
    ["4", "대안 검토자: 서로 다른 관점 3명 (노랑, 선택)", "gpt-5.6-luna로 3회 독립 호출(운영자가 모델을 나눠 지정할 수 있음)", "가장 큰 원인(10자 이상), 해결책(30자 이상)", "위 모둠 한도에 포함", "관점별 강점·약점·질문. 고쳐 쓰거나 순위를 매기지 않음"],
    ["5", "미리보기 제공자: 시나리오 (노랑, 선택)", "gpt-5.6-terra · 사고량 medium(실패 시 low) · JSON", "최종 해결책(30자 이상), 학생의 반응 예측 2개(각 10자 이상), 시점 1·3·5년(고등)", "위 모둠 한도에 포함", "가능한 시나리오 2개(제목·이야기·작동 기제·뜻밖의 일·예상 문제)"],
    ["6·7", "AI 사용 불가 (빨강)", "—", "서버가 호출 자체를 차단(‘우리가 직접 생각하는 단계’)", "—", "—"],
  ], "mini xs", ["8mm", "26mm", "30mm", "42mm", "22mm", ""]);

  h += h4("4-2. 하네스(통제 장치) 설명");
  h += p0("하네스란 AI 모델 둘레에서 호출 조건·횟수·검사·기록을 정하는 서버 규칙입니다. 이 규칙은 모델이 아니라 서버 코드가 집행하므로, 학생이 화면을 우회해도 바뀌지 않습니다.");
  h += tbl(["장치", "무엇을 하는가"], [
    ["① 선행 사고 문", "단계마다 학생이 먼저 쓴 글이 서버에 저장되어 있어야 AI가 열립니다(예: 5단계는 최종 해결책과 반응 예측 2개). 조건이 안 되면 AI를 부르지 않고 이유를 안내합니다. 6·7단계 호출은 무조건 거절합니다."],
    ["② 단계 순서", "3단계는 모둠 문제가, 4단계는 가장 큰 원인이, 5단계는 최종 해결책이 있어야 열립니다. 3~5단계 AI는 모둠이 정한 문제·원인·확인한 사실을 프롬프트에 함께 받아 그 기준으로 답합니다."],
    ["③ 횟수 한도", "횟수 확인과 증가를 한 번에(트랜잭션) 처리해 동시에 눌러도 한도를 넘지 않습니다. 호출이 실패하면 횟수를 되돌려 줍니다. 교사 화면에서 한도가 80%에 이르면 알림이 뜹니다."],
    ["④ 두 겹의 AI(1단계)", "인물 AI가 답을 만들면, <b>상위 감독자 AI</b>가 학생에게 보내기 전에 규범(사건 범위, 지어낸 중요 사실, 공식 확인처럼 꾸밈, 지나친 장황함, 정체 노출, 입장 강요, 혐오, 개인정보)을 검사합니다. 가벼운 위반은 인물 말투로 고쳐 쓰고, 무거운 위반이나 검사 실패는 짧은 안내로 바꿉니다. 마지막 문장이 학생의 생각을 되묻는 질문이면 코드가 지웁니다."],
    ["⑤ 학생 태도 감시", "1차는 규칙(정규식)으로 명백한 조롱·성적 표현을 잡고(이때 인물 AI는 호출하지 않음), 2차는 감독자 AI가 판정합니다. 위반하면 인물이 선을 긋는 답을 하고 학생 화면에 경고, 교사 화면에 신호가 갑니다. 같은 학생이 3번 어기면 교사가 풀어 줄 때까지 대화가 멈춥니다. 신상 질문, 불편하거나 반대하는 질문은 위반이 아닙니다."],
    ["⑥ 사실 조회(웹 검색)", "인물이 자기 자료에 없는 구체적 사실(수치·날짜·제도)을 질문받으면 lookup 도구로 웹에서 찾아봅니다(답 하나에 최대 2번). 검색 결과는 ‘데이터’로만 전달하며 웹 문서 속 지시문은 따르지 않습니다. 못 찾으면 인물이 모른다고 답합니다. 인사 같은 가벼운 말에는 도구를 주지 않습니다. 검색 내용과 출처는 기록에 남고, 교사가 수업 설정에서 끌 수 있습니다."],
    ["⑦ 수업 자료 근거(3단계)", "검색 보조자는 모델의 기억이 아니라 <b>교사가 준비한 2단계 자료와 웹 검색 결과에 있는 내용만</b> 씁니다. 자료에 없으면 ‘확인이 필요합니다’라고 쓰고, 주장·의견은 ‘누가 ~라고 주장했다’로 씁니다."],
    ["⑧ 학교급·심화 활동", "수업 설정의 학교급과 심화 활동이 프롬프트를 바꿉니다. 인물의 틀린 믿음을 어떻게 말하는지(4-4 ①의 ‘믿음 표현’), 생각 도우미의 유형(원인 잇기를 켜면 ‘따로 놂’ 유형 추가), 검색 보조자의 자료 섞기(sources), 검토자의 ‘얻는 것·포기하는 것’(tradeoff) 등이 달라집니다."],
    ["⑨ 개인정보 표시", "학생 입력에 전화번호·주민등록번호·이메일·학교 이름이 있으면 막지 않고 교사 기록에 표시해 교사 화면에 알립니다. 인물 AI도 학생의 개인정보를 묻거나 받아 적지 않도록 규범에 있습니다."],
    ["⑩ 기록과 열람", "학생 화면의 대화에는 학생에게 <b>보인 내용만</b> 저장됩니다. 감독자의 판정·사유·원래 응답은 교사 전용 기록에 남습니다. 2~5단계 AI 호출은 모둠 기록에 입력·출력·모델 이름과 함께 남아 모둠원이 볼 수 있고, 교사는 ‘AI 기록’·‘대화 보기’·기록 CSV로 확인합니다."],
    ["⑪ 교사의 개입", "‘확인이 필요해요’ 알림(AI 오류·한도 근접·감독 개입 3회 이상·개인정보 의심·대화 규칙 위반·막힘), ‘학생에게 한마디’ 공지, 학생 대화 멈춤 해제, 자료 관리·인물 편집, 생각 도우미·웹 검색 끄기, 모둠당 AI 한도 조정이 가능합니다."],
    ["⑫ 외부 전송과 보관", "AI를 부를 때 학생이 입력한 글(대화 메시지, 모둠이 쓴 원인·해결책 등)과 위 프롬프트가 OpenAI API로 전송됩니다. 학생은 별명으로만 입장하며 이름·학교 같은 개인정보는 쓰지 않도록 안내합니다. 수업 기록은 교사가 삭제하기 전까지 서버에 있고, 오래 쓰지 않은 익명 계정은 30일 뒤 정리됩니다."],
  ], "mini", ["26mm", ""]);

  h += h4("4-3. 1단계 인물 대화의 처리 순서");
  h += `<ol class="flowol"><li>학생이 메시지를 보냅니다(500자 이하, 질문 횟수 확인).</li><li><b>규칙 검사</b>: 명백한 조롱·성적 표현이면 인물 AI를 부르지 않고 선을 긋는 답(아래 대체 문구)을 냅니다.</li><li><b>인물 AI</b>가 프롬프트 ①과 직전 대화 16개를 받아 답을 만듭니다. 사실을 물으면 lookup(웹 검색)을 최대 2번 씁니다.</li><li><b>감독자 AI</b>가 프롬프트 ②로 인물의 답과 학생 태도를 검사해 JSON으로 판정합니다.</li><li><b>결과 결정</b>: 통과하면 그대로, 가벼운 위반(지어낸 사실·공식 확인처럼 꾸밈·장황·정체 노출·입장 강요)이면 고친 답, 그 밖의 위반·검사 실패면 대체 안내를 학생에게 보냅니다. 되묻는 마지막 문장은 지웁니다.</li><li><b>기록</b>: 학생에게 보인 말은 학생 대화에, 판정·원래 응답은 교사 전용 기록에 저장하고 경고·알림을 보냅니다. 감독자 검사 자체가 실패해 ‘다시 말해 달라’가 나간 경우는 질문 횟수에서 빼 줍니다.</li></ol>`;

  h += h4("4-4. 프롬프트 전문");
  h += p0("프롬프트 ①~⑦은 서버 코드가 조립한 문장 그대로입니다. 인물 프롬프트는 예시로 ‘아델’(고등학교, 심화 켬, 웹 검색 켬)의 것을 실었습니다. 다른 인물은 이름·설정·근거 진술·믿음·삶의 이야기 칸의 내용만 다릅니다(부록 2의 2-4).");

  const common = { text: prompts.coachPrompt(evctx(), "cause").split("\n")[0], note: "④의 맨 앞 공통 지침과 같음" };
  const PG = [["상황과 인물 설정", ["사건", "모두가 아는", "너에 대해", "네 삶", "기억나는", "마음속", "네 입장", "네가 믿", "네 생각"]], ["말하는 방식", ["말투", "말버릇", "대화 방식"]], ["근거와 규범", ["네가 알고", "상위 규범"]]];

  h += pv({ n: "①", t: "1단계 인물 AI의 시스템 프롬프트 (예: 아델)" }, [["쓰이는 곳", "1단계 학생이 인물에게 말을 걸 때마다"], ["입력", "인물 설정·근거 진술·믿음·삶의 이야기 + 직전 대화 16개 + 학생 메시지"], ["출력", "메신저 말 1~5문장"], ["모델", "gpt-5.6-terra"]], prompts.personaPrompt(ev, adel, { lookup: true, level: "high", subtle: true }), { groups: PG });
  h += p0("<b>믿음 표현의 세 가지 설정</b>(위 프롬프트의 ‘네가 믿고 있는 것’ 바로 뒤 문장): 학교급과 심화 활동 ‘beliefs’에 따라 아래 중 하나가 들어갑니다.");
  const fake = { name: "가", role: "", setting: "", story: [], episodes: [], views: [], claims: [], beliefs: [["(믿음)", ""]], stance: "", voice: "" };
  const belief = (opt) => prompts.personaPrompt(ev, fake, opt).split("\n").find((l) => l.startsWith("[네가 믿고 있는 것]"));
  h += tbl(["설정", "문장"], [["고등학교 기본", e(belief({ level: "high" }))], ["중학교", e(belief({ level: "middle" }))], ["심화(beliefs 켬)", e(belief({ level: "high", subtle: true }))]], "mini xs", ["22mm", ""]);

  const g = guard.guardMessages({ event: ev, persona: adel, claims: adel.claims, history: [], studentMessage: "(학생이 보낸 질문)", reply: "(인물 AI가 만든 응답)", lookups: [], level: "high" });
  h += pv({ n: "②", t: "감독자 AI의 프롬프트 (시스템 부분)" }, [["쓰이는 곳", "인물 AI의 답을 학생에게 보내기 직전"], ["입력", "아래 내용 + [직전 대화 3번]·[학생 질문]·[인물의 응답]"], ["출력", "JSON {ok, category, reason, fixed, conduct}"], ["모델", "gpt-5.6-terra"]], g[0].content);
  h += tbl(["판정", "처리", "학생에게 가는 대체 문구(고칠 수 없을 때)"], guard.CATEGORIES.filter((c) => c !== "ok").map((c) => [c, guard.FIXABLE.includes(c) ? "감독자가 고쳐 쓴 답(fixed)을 보냄, 없으면 대체 문구" : "대체 문구", e(guard.FALLBACKS[c] || "")]).concat([["error(감독자 호출 실패)", "대체 문구, 질문 횟수는 되돌림", e(guard.FALLBACKS.error)]]), "mini xs", ["26mm", "44mm", ""]);
  h += tbl(["학생 태도", "인물이 선을 긋는 답", "기록"], [["조롱·모욕(mockery)", e(conduct.boundaryReply("mockery")), "교사 화면 알림, 경고 1/3"], ["성적 희롱(sexual)", e(conduct.boundaryReply("sexual")), "교사 화면 알림, 3번이면 대화 멈춤"]], "mini xs", ["30mm", "", "40mm"]);

  const lt = lookup.lookupTool(ev).function;
  h += pv({ n: "③", t: "사실 조회(웹 검색) 도구와 검색 지시" }, [["쓰이는 곳", "인물이 자기 자료에 없는 구체적 사실을 질문받았을 때(최대 2번)"], ["입력", "인물이 정한 검색어(query)"], ["출력", "검색 요약과 출처 → 인물 AI에게 ‘데이터’로 전달"], ["모델", "gpt-5.6-luna + web_search"]], "[인물 AI에게 주는 도구 lookup]\n" + lt.description + "\n(매개변수 query) " + lt.parameters.properties.query.description + "\n[검색 호출의 지시문]\n" + lookup.searchInstructions(ev) + "\n[검색 결과를 인물에게 돌려주는 말]\n" + lookup.toolResultText({ found: true, summary: "(검색 요약)" }) + "\n(찾지 못한 경우) " + lookup.toolResultText({ found: false }));

  h += pv({ n: "④", t: "2단계 생각 도우미 (원인 추측용)" }, [["쓰이는 곳", "2단계 ‘이 사건은 왜 생겼을까요’ 추측을 제출한 뒤"], ["입력", "모둠 문제 질문 + 학생의 추측들"], ["출력", "JSON {kind, question}: 유형 판정 + 질문 하나"], ["모델", "gpt-5.6-luna · 학생당 8번"]], prompts.coachPrompt(evctx(), "cause"));
  { const L = prompts.coachPrompt(evctx(), "link").split("\n"); h += p0("<b>④-2 처음 생각 돌아보기용</b>은 아래 역할 문장과 유형 목록만 다르고 [규칙]은 ④와 같습니다(JSON의 kind 값만 이 유형 목록)."); h += pv({ n: "④-2", t: "생각 도우미: 처음 생각 돌아보기용 (달라지는 부분)" }, [["쓰이는 곳", "2단계 ‘처음 내 생각 돌아보기’"], ["입력", "1단계 처음 생각의 이유·생활 장면"], ["출력", "JSON {kind, question}"], ["모델", "gpt-5.6-luna"]], L.slice(1, L.indexOf("[규칙]")).join("\n")); }

  h += pv({ n: "⑤", t: "3단계 검색 보조자 (심화: 다른 쪽 자료 섞기 켬)" }, [["쓰이는 곳", "3단계 ‘확인 질문’ 중 AI에게 묻기를 눌렀을 때"], ["입력", "모둠 문제 + 확인 질문 + 교사가 준비한 2단계 자료 + 웹 검색 요약"], ["출력", "세 제목(알려진 내용·확인할 곳·불확실한 점), 10줄 이내"], ["모델", "gpt-5.6-luna · 모둠 한도 150회에 포함"]], prompts.verifyPrompt({ ...evctx(), deep: { sources: true } }, { materials: "(교사가 준비한 2단계 실제 사건 자료 전체가 분류별로 들어감)", search: { found: true, summary: "(이번 질문으로 웹 검색해 찾은 내용 요약)", sources: [{ title: "(출처 제목)" }] } }), { common });

  h += pv({ n: "⑥", t: "4단계 대안 검토자 (관점 3개, 서로 모르고 각각 호출)" }, [["쓰이는 곳", "4단계 모둠 해결책을 쓴 뒤 ‘AI 의견 듣기’"], ["입력", "모둠 문제·핵심 원인·확인한 사실 + 해결책"], ["출력", "관점별 강점·약점·질문 (고쳐 쓰거나 순위를 매기지 않음)"], ["모델", "gpt-5.6-luna 3회 독립 호출"]], prompts.feedbackPrompt(evctx(), "feasibility"), { common });
  h += p0("위는 첫 관점(실행 가능성)으로 조립한 것이며, 관점마다 [역할] 문장의 관점 설명만 바뀝니다.");
  h += tbl(["관점(고등)", "역할 문장에 들어가는 관점 설명"], Object.entries(prompts.LENSES).map(([k, v]) => [k, e(v)]), "mini xs", ["24mm", ""]);

  h += pv({ n: "⑦", t: "5단계 미리보기 제공자 (시나리오, 고등학교)" }, [["쓰이는 곳", "5단계 반응 예측 2개를 쓴 뒤 ‘미래 이야기 만들기’"], ["입력", "모둠 문제·핵심 원인·확인한 사실·최종 해결책·반응 예측 + 시점(1·3·5년)"], ["출력", "JSON: 시나리오 2개(제목·이야기·작동 기제·뜻밖의 일·예상 문제)"], ["모델", "gpt-5.6-terra · 사고량 medium"]], prompts.scenarioPrompt(evctx(), 3), { common });

  h += h4("4-5. AI 설계의 한계와 교사가 확인할 점");
  h += ul([
    "AI는 틀릴 수 있습니다. 인물의 ‘틀릴 수 있는 믿음’은 일부러 설계한 것이지만, 그 밖의 오류도 생길 수 있으므로 학생이 자료로 검증하도록 수업이 설계되어 있습니다(3단계).",
    "감독자 AI도 모델이므로 모든 위반을 잡지 못할 수 있습니다. 교사 화면의 ‘확인이 필요해요’와 ‘대화 보기’로 수업 중 확인하고, 감독자가 고치기 전의 원래 응답은 교사 전용 기록으로 사후 점검할 수 있습니다.",
    "시나리오는 예측이 아니라 ‘가능한 전개’입니다. 프롬프트가 근거 없는 통계 수치 생성을 금지하지만, 학생이 ‘왜 그렇게 되나’를 따져 보게 하는 활동으로 보완합니다.",
    "인물과 자료의 근거 진술은 보도와 자료를 대조해 정리했으며, 수업 전에 교사가 원문을 확인하고 필요하면 ‘인물 편집’·‘자료 관리’에서 고쳐야 합니다. 직접 고친 자료는 원문 대조를 거치지 않았다는 경고가 표시됩니다.",
    "모델 이름·사고량·한도는 서버 설정이라 학기 중 바뀔 수 있습니다. 교사 화면의 ‘인물·자료 점검’ 탭에서 AI 연결 상태와 쓰이는 모델을 확인할 수 있습니다.",
    "수업 전에 교사가 직접 학생 화면으로 인물과 대화해 보고, 인물의 말이 설정과 맞는지 확인하기를 권합니다.",
  ]);
  return h;
}
function h5p(t) { return `<h5 class="ph">${e(t)}</h5>`; }

module.exports = { apx1, apx2, apx4, apx6, abar };
