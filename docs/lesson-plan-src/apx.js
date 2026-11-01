// 부록 생성기: 웹앱의 실제 사건 파일·프롬프트·척도표 코드에서 직접 가져와 정리한다(손으로 옮기지 않는다).
// 설명 문장은 지도안 본문과 같은 문어체(~한다)로 쓴다. 학교급·심화 표시는 배지를 문장 앞에 두고 한 줄에 한 문장씩 쓴다.
const path = require("path");
const REPO = path.resolve(__dirname, "../..");
const F = path.join(REPO, "functions");
const { SOURCES, EVENTS, PERSONAS, MATERIALS, CASES, AFTERMATH } = require(path.join(F, "case.js"));
const prompts = require(path.join(F, "prompts.js"));
const guard = require(path.join(F, "guard.js"));
const lookup = require(path.join(F, "lookup.js"));
const conduct = require(path.join(F, "conduct.js"));
const { CHARTER } = require(path.join(F, "charter.js"));
const RB = require(path.join(F, "rubric.js"));
const AP = require(path.join(F, "autopilot.js"));
const { DEEP_KEYS } = require(path.join(F, "level.js"));

const e = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const ev = EVENTS.jeju2018;
const JEJU_IDS = new Set(Object.keys(require(path.join(F, "cases/jeju2018.js")).SOURCES));
const people = PERSONAS.filter((p) => p.events.includes("jeju2018"));
const D = JSON.parse(require("fs").readFileSync(path.join(REPO, "public/demo/data/jeju2018.json"), "utf8"));
const DROP = new Set(["N1", "N6", "N7", "C2", "C4"]);
const ids = (x) => (Array.isArray(x) ? x : [x]).filter((i) => !DROP.has(i)).join(", ");
const ul = (xs) => `<ul class="bl">${xs.map((x) => `<li>${e(x)}</li>`).join("")}</ul>`;
const ulh = (xs) => `<ul class="bl">${xs.map((x) => `<li>${x}</li>`).join("")}</ul>`; // 이미 HTML 인 항목
const BOOK = `<svg class="bk" viewBox="0 0 70 40" width="62" height="36"><path d="M35 34C28 29 14 29 4 32V11c10-3 24-3 31 2 7-5 21-5 31-2v21c-10-3-24-3-31 2z" fill="#fff" stroke="#444" stroke-width="1.6"/><path d="M35 13v21" stroke="#444" stroke-width="1.4"/><path d="M35 12c0-5 2-8 7-9-1 5-3 8-7 9z" fill="#5a9a46"/><path d="M35 12c0-4-2-7-6-8 0 4 2 7 6 8z" fill="#7bb661"/></svg>`;
const abar = (n, title) => `<div class="abar">${BOOK}<span class="an">부록 ${n}</span><span class="at">${title}</span></div>`;
const h4 = (t) => `<h4>${t}</h4>`;
const p0 = (t) => `<p class="ap0">${t}</p>`;
// 학교급·심화 배지와, 배지를 문장 앞에 둔 한 줄
const HS = `<span class="hs">고</span>`, MS = `<span class="hs m">중</span>`, DP = `<span class="hs d">심화</span>`;
const XL = (b, t) => `<div class="xl">${b}<span class="xt">${t}</span></div>`;

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
const DLH = new Set(["원칙", "항목", "장치", "설정", "관점"]);
const dl = (rows, w) => `<div class="dl">${rows.map(([k, v]) => `<div class="dr"${w ? ` style="grid-template-columns:${w} 1fr"` : ""}><div class="dk">${k}</div><div class="dv">${v}</div></div>`).join("")}</div>`;
const tbl = (head, rows, cls = "mini sm", widths = []) => head.length === 2 && DLH.has(head[0]) ? dl(rows, widths[0]) : `<table class="${cls}">${widths.length ? `<colgroup>${widths.map((w) => `<col style="width:${w}">`).join("")}</colgroup>` : ""}<tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</table>`;

// ============ 부록 2. 사건과 인물 구성 자료 ============
function apx1() {
  let h = abar(2, "사건과 인물 구성 자료");
  h += p0("인물과 사건 자료를 구성할 때 적용한 원칙, 사건의 범위와 공통 배경, 인물 아홉 명의 입장을 정리하였다. 학생에게는 편지와 대화만 제시되며, 이 부록의 내용은 AI가 인물로 응답할 때의 바탕이 된다.");

  h += h4("2-1. 인물 구성 원칙");
  h += tbl(["원칙", "내용"], [
    ["① 실제 보도에 근거", "사건의 사실(수치·날짜·제도·발언)은 신문·방송·공공기관·국제기구의 보도에서 가져오고, 문장마다 출처 ID(J·N·C·A)를 붙였다. 출처는 부록 6에 수록하였다."],
    ["② 실존 인물이 아닌 가상 인물", "인물은 여러 인터뷰와 보도를 종합하여 구성한 수업용 인물이다. 이름·나이·가족·삶의 이야기·기억에 남은 장면은 <b>창작</b>이며, 특정 개인을 가리키지 않는다(‘융합 근거’ 항목에 밝힘)."],
    ["③ 근거 진술의 종류 표시", "인물이 알고 겪은 일(근거 진술)에는 <b>사실·증언·주장·의견</b>을 표시하였다. 인물은 주장과 믿음을 자신의 생각으로 말하며, 정부나 기관이 공식 확인한 사실처럼 말하지 않는다."],
    ["④ 네 축, 아홉 명", "당사자(2), 도민(3), 시민사회(2), 제도(2)로 입장이 한쪽에 치우치지 않게 배치하였다. 모둠마다 당사자 축의 인물을 반드시 한 명 포함하게 하였다."],
    ["⑤ 틀릴 수 있는 믿음", "인물마다 사실이라고 믿지만 틀리거나 과장되었을 수 있는 내용을 하나 이상 설정하고, 실제 사실을 함께 기록하였다. 학생이 2~3단계에서 자료로 확인하도록 하기 위한 장치이다."],
    ["⑥ 범위와 경계", "사건의 시간·장소·허용 주제와 범위 밖의 내용(다른 난민 사건, 2018년 이후 정책 예측 등)을 정하였다. 민감한 주제(제주 4·3 등)는 인물이 짧게만 언급하도록 ‘조심할 이야기’로 지정하였다."],
    ["⑦ 교사 확인", "출처마다 원문에서 확인할 부분을 기록하였다(부록 6). 근거 진술은 보도와 자료를 대조하여 정리한 것이므로, <b>수업 전에 교사가 원문을 확인</b>하기를 권한다."],
  ], "mini", ["32mm", ""]);

  h += h4("2-2. 사건 개요와 범위");
  h += tbl(["항목", "내용"], [
    ["사건", e(ev.title)],
    ["개요", e(ev.summary)],
    ["대화 시점", e(ev.now)],
    ["범위", `${e(ev.scope.event)} / ${e(ev.scope.time)} / ${e(ev.scope.place)}`],
    ["허용 주제", ul(ev.scope.allowedTopics)],
    ["범위 밖", ul(ev.scope.outOfScope)],
    ["입장의 네 축", `${e(ev.axes.join(" · "))}(반드시 포함할 축: ${e(ev.requiredAxis)}, 개인으로 등장하는 축: ${e(ev.personalAxes.join("·"))})<br>이해관계자: ${e(ev.stakeholders.join(" / "))}`],
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

// ============ 부록 3. 인물 편지 ============
function apx2() {
  const AX = { 당사자: "ax1", 도민: "ax2", 시민사회: "ax3", 제도: "ax4" };
  let h = abar(3, "인물 편지 전문");
  h += p0("학생은 아홉 통의 편지를 모두 읽고, 모둠에서 서로 다른 인물을 한 명씩 고른다. 편지의 날짜와 장소는 사건 설정(" + e(D.ui.letterSign) + ")에 따른다.");
  h += `<div class="lcols">${D.letters.map((l) => { const p = people.find((x) => x.id === l.id); const ax = p ? p.axis : ""; return `<div class="letter ${AX[ax] || ""}"><div class="lstamp"><span>제주</span><span>2018</span></div><div class="lhead"><span class="lax">${e(ax)}${l.required ? " · 꼭 필요한 당사자" : ""}</span><span class="lname">${e(l.name)}</span><span class="lbrief">${e(l.brief)}</span></div><div class="lbody">${l.letter.map((t) => `<p>${e(t)}</p>`).join("")}</div><p class="sign">${e(D.ui.letterSign)}<br>${e(l.name)} 드림</p></div>`; }).join("")}</div>`;
  return h;
}

// ============ 부록 6. 출처 목록 ============
const DATE_FIX = { C5: "2016", C6: "2026-04-21", A4: "2020-02-14", C9: "2017-10" };
function apx6() {
  const ents = Object.entries(SOURCES).filter(([id]) => JEJU_IDS.has(id) && !DROP.has(id));
  let h = abar(6, "출처 목록");
  h += p0(`인물과 자료의 근거가 된 보도와 자료 ${ents.length}건이다. ID의 첫 글자는 J(사건 보도), N(보충 보도), C(해외 사례), A(이후 전개)를 뜻한다. 모든 출처는 매체·날짜·제목과 핵심 내용을 대조하여 정리하였으며, ‘원문에서 볼 점’은 수업 전에 원문에서 확인할 부분이다.`);
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
  let h = abar(4, "AI 설계의 공개: 프롬프트와 하네스");
  h += p0("이 부록은 AI-EPS 웹앱의 서버 코드를 근거로 작성하였다. <b>프롬프트는 코드가 실제로 조립한 문장을 그대로</b> 수록하였으며, 노란색으로 표시한 괄호 ( ) 안의 설명은 수업 중에 학생의 글이나 자료로 채워지는 자리이다. 모델 이름과 사고량은 서버 설정이므로 운영 중에 바뀔 수 있다(2026년 10월 기준 기본값).");

  h += h4("4-1. 단계별 AI 한눈에 보기");
  h += tbl(["단계", "AI의 역할 (신호등)", "모델·설정(기본)", "서버가 확인하는 호출 조건(선행 사고)", "횟수 한도", "AI가 내는 결과"], [
    ["1", "경험 전달자: 가상 인물과 감독자 AI (노랑)", "인물·감독자: gpt-5.6-terra, 사실 조회: gpt-5.6-luna + web_search · 사고량 low", "인물을 먼저 고름. 메시지 500자 이하(학생이 먼저 말을 걺). 대화 규칙 위반으로 중지된 학생은 사용 불가", "학생당 5번(교사가 1~50번으로 설정)", "메신저 말 1~5문장(고등학교)"],
    ["2", "생각 도우미: 질문만 하는 AI (노랑, 교사가 끌 수 있음)", "gpt-5.6-luna · 사고량 low · JSON", "처음 생각 돌아보기: ‘처음 생각의 이유·생활 장면’ 8자 이상. 원인 추측: 모둠 문제(10자 이상)와 원인 2개 이상", "학생당 8번(모둠 한도와 별도)", "유형 판정과 질문 하나(답·예시·칭찬 없음)"],
    ["3", "검색 보조자 (노랑, 선택)", "gpt-5.6-luna + 수업 자료 + 웹 검색(교사가 끌 수 있음)", "모둠 문제(10자 이상), 2단계 확인 질문(5자 이상), ‘자료와 비교’ 선택(서버 확인). 화면에서는 ‘묻기 전 내 예상’을 써야 묻기 단추가 열림", "모둠당 150회(3~5단계 합계, 교사가 10~500회로 설정)", "알려진 내용·확인할 곳·불확실한 점(10줄 이내). 사실 여부는 판정하지 않음"],
    ["4", "대안 검토자: 서로 다른 관점 3명 (노랑, 선택)", "gpt-5.6-luna로 3회 독립 호출(운영자가 관점별 모델을 지정할 수 있음)", "가장 큰 원인(10자 이상), 해결책(30자 이상)", "위 모둠 한도에 포함", "관점별 강점·약점·질문. 해결책을 고쳐 쓰거나 순위를 매기지 않음"],
    ["5", "미리보기 제공자: 시나리오 (노랑, 선택)", "gpt-5.6-terra · 사고량 medium(실패 시 low) · JSON", "최종 해결책(30자 이상), 학생의 반응 예측 2개(각 10자 이상), 시점 1·3·5년(고등학교)", "위 모둠 한도에 포함", "가능한 시나리오 2개(제목·이야기·작동 기제·뜻밖의 일·예상 문제)"],
    ["6·7", "AI 사용 불가 (빨강)", "—", "서버가 호출 자체를 차단(‘우리가 직접 생각하는 단계’)", "—", "—"],
  ], "mini xs", ["8mm", "26mm", "30mm", "42mm", "22mm", ""]);

  h += h4("4-2. 하네스(통제 장치) 설명");
  h += p0("하네스란 AI 모델 둘레에서 호출 조건·횟수·검사·기록을 정하는 서버 규칙이다. 이 규칙은 모델이 아니라 서버 코드가 집행하므로, 학생이 화면을 우회하더라도 그대로 적용된다.");
  h += tbl(["장치", "무엇을 하는가"], [
    ["① 선행 사고 조건", "단계마다 학생이 먼저 쓴 글이 서버에 저장되어 있어야 AI를 사용할 수 있다(예: 5단계는 최종 해결책과 반응 예측 2개). 조건을 충족하지 않으면 AI를 호출하지 않고 이유를 안내한다. 6·7단계의 호출은 모두 거절한다."],
    ["② 단계 순서", "3단계는 모둠 문제가, 4단계는 가장 큰 원인이, 5단계는 최종 해결책이 있어야 열린다. 3~5단계 AI는 모둠이 정한 문제·원인·확인한 사실을 프롬프트로 함께 받아 이를 기준으로 응답한다."],
    ["③ 횟수 한도", "횟수 확인과 증가를 하나의 트랜잭션으로 처리하므로, 동시에 여러 번 요청해도 한도를 넘지 않는다. 호출에 실패하면 사용 횟수를 되돌린다. 한도의 80%에 이르면 교사 화면에 알림이 표시된다."],
    ["④ 두 겹의 AI(1단계)", "인물 AI가 응답을 만들면 <b>상위 감독자 AI</b>가 학생에게 보내기 전에 규범(사건 범위, 지어낸 중요 사실, 공식 확인처럼 꾸민 표현, 지나친 장황함, 정체 노출, 입장 강요, 혐오, 개인정보)을 검사한다. 가벼운 위반은 인물의 말투로 고쳐 쓰고, 무거운 위반이나 검사 실패는 짧은 안내로 대체한다. 응답의 마지막 문장이 학생의 생각을 되묻는 질문이면 코드에서 삭제한다."],
    ["⑤ 학생 태도 확인", "1차로 규칙(정규식)이 명백한 조롱·성적 표현을 걸러 내며, 이때는 인물 AI를 호출하지 않는다. 2차로 감독자 AI가 판정한다. 위반이 확인되면 인물이 선을 긋는 응답을 하고, 학생 화면에는 경고를, 교사 화면에는 알림을 보낸다. 같은 학생이 세 번 위반하면 교사가 해제할 때까지 대화가 중지된다. 인물의 신상에 관한 질문이나 불편하거나 반대하는 질문은 위반으로 보지 않는다."],
    ["⑥ 사실 조회(웹 검색)", "인물이 자기 자료에 없는 구체적 사실(수치·날짜·제도)에 관한 질문을 받으면 사실 조회 도구(lookup)로 웹을 검색한다(응답 하나에 최대 2회). 검색 결과는 ‘데이터’로만 전달하며, 웹 문서 속의 지시문은 따르지 않는다. 찾지 못하면 인물은 모른다고 답한다. 인사와 같은 가벼운 말에는 도구를 제공하지 않는다. 검색 내용과 출처는 기록으로 남으며, 교사는 수업 설정에서 이 기능을 끌 수 있다."],
    ["⑦ 수업 자료 근거(3단계)", "검색 보조자는 모델의 기억이 아니라 <b>교사가 준비한 2단계 자료와 웹 검색 결과에 있는 내용만</b> 사용한다. 자료에 없는 내용은 ‘확인이 필요합니다’로 표시하고, 주장과 의견은 ‘누가 ~라고 주장했다’의 형식으로 제시한다."],
    ["⑧ 학교급·심화 활동", "수업 설정의 학교급과 심화 활동에 따라 프롬프트가 달라진다. 인물이 틀린 믿음을 말하는 방식(4-4 ①의 ‘믿음 표현’), 생각 도우미의 유형(원인 잇기를 켜면 ‘따로 놂’ 유형 추가), 검색 보조자의 자료 섞기(sources), 검토자의 ‘얻는 것·포기하는 것’(tradeoff) 등이 해당한다."],
    ["⑨ 개인정보 표시", "학생의 입력에 전화번호·주민등록번호·이메일·학교 이름이 포함되면 입력을 막지 않고 교사 기록에 표시하여 교사 화면에 알린다. 인물 AI의 규범에도 학생의 개인정보를 묻거나 받아 적지 않도록 규정되어 있다."],
    ["⑩ 기록과 열람", "학생 화면의 대화에는 학생에게 <b>표시된 내용만</b> 저장된다. 감독자의 판정·사유·원래 응답은 교사 전용 기록에 남는다. 2~5단계 AI 호출은 입력·출력·모델 이름과 함께 모둠 기록에 남아 모둠원이 볼 수 있으며, 교사는 ‘AI 기록’·‘대화 보기’·기록 CSV로 확인한다."],
    ["⑪ 교사의 개입", "교사는 ‘확인이 필요해요’ 알림(AI 오류·한도 근접·감독 개입 3회 이상·개인정보 의심·대화 규칙 위반·진행 정체), ‘학생에게 한마디’ 공지, 학생 대화 중지 해제, 자료 관리·인물 편집, 생각 도우미·웹 검색 끄기, 모둠당 AI 한도 조정을 할 수 있다."],
    ["⑫ 외부 전송과 보관", "AI를 호출할 때 학생이 입력한 글(대화 메시지, 모둠이 쓴 원인·해결책 등)과 위 프롬프트가 OpenAI API로 전송된다. 학생은 별명으로만 입장하며, 이름·학교와 같은 개인정보는 입력하지 않도록 안내한다. 수업 기록은 교사가 삭제하기 전까지 서버에 보관되고, 오래 사용하지 않은 익명 계정은 30일 후에 정리된다."],
  ], "mini", ["26mm", ""]);

  h += h4("4-3. 1단계 인물 대화의 처리 순서");
  h += `<ol class="flowol"><li>학생이 메시지를 보낸다(500자 이하, 질문 횟수 확인).</li><li><b>규칙 검사</b>: 명백한 조롱·성적 표현이면 인물 AI를 호출하지 않고 선을 긋는 응답(아래 대체 문구)을 보낸다.</li><li><b>인물 AI</b>가 프롬프트 ①과 직전 대화 16개를 받아 응답을 만든다. 사실을 묻는 질문에는 사실 조회(웹 검색)를 최대 2회 사용한다.</li><li><b>감독자 AI</b>가 프롬프트 ②로 인물의 응답과 학생의 태도를 검사하여 JSON으로 판정한다.</li><li><b>결과 결정</b>: 통과하면 그대로 보내고, 가벼운 위반(지어낸 사실·공식 확인처럼 꾸민 표현·장황함·정체 노출·입장 강요)이면 고친 응답을, 그 밖의 위반이나 검사 실패이면 대체 안내를 보낸다. 되묻는 마지막 문장은 삭제한다.</li><li><b>기록</b>: 학생에게 표시된 응답은 학생 대화에, 판정과 원래 응답은 교사 전용 기록에 저장하고 경고와 알림을 보낸다. 감독자 검사 자체가 실패하여 ‘다시 말해 달라’는 안내가 나간 경우에는 질문 횟수에서 제외한다.</li></ol>`;

  h += h4("4-4. 프롬프트 전문");
  h += p0("프롬프트 ①~⑦은 서버 코드가 조립한 문장 그대로이다. 인물 프롬프트는 ‘아델’(고등학교, 심화 활동 켬, 웹 검색 켬)의 예를 실었다. 다른 인물은 이름·설정·근거 진술·믿음·삶의 이야기 항목의 내용만 다르다(부록 2의 2-3).");

  const common = { text: prompts.coachPrompt(evctx(), "cause").split("\n")[0], note: "④의 맨 앞 공통 지침과 같음" };
  const PG = [["상황과 인물 설정", ["사건", "모두가 아는", "너에 대해", "네 삶", "기억나는", "마음속", "네 입장", "네가 믿", "네 생각"]], ["말하는 방식", ["말투", "말버릇", "대화 방식"]], ["근거와 규범", ["네가 알고", "상위 규범"]]];

  h += pv({ n: "①", t: "1단계 인물 AI의 시스템 프롬프트 (예: 아델)" }, [["쓰이는 곳", "1단계 학생이 인물에게 말을 걸 때마다"], ["입력", "인물 설정·근거 진술·믿음·삶의 이야기 + 직전 대화 16개 + 학생 메시지"], ["출력", "메신저 말 1~5문장"], ["모델", "gpt-5.6-terra"]], prompts.personaPrompt(ev, adel, { lookup: true, level: "high", subtle: true }), { groups: PG });
  h += p0("<b>믿음 표현의 세 가지 설정</b>: 위 프롬프트의 ‘네가 믿고 있는 것’ 바로 뒤 문장은 학교급과 심화 활동(beliefs)에 따라 아래 중 하나가 들어간다.");
  const fake = { name: "가", role: "", setting: "", story: [], episodes: [], views: [], claims: [], beliefs: [["(믿음)", ""]], stance: "", voice: "" };
  const belief = (opt) => prompts.personaPrompt(ev, fake, opt).split("\n").find((l) => l.startsWith("[네가 믿고 있는 것]"));
  h += tbl(["설정", "문장"], [[`${HS} 기본`, e(belief({ level: "high" }))], [`${MS} 기본`, e(belief({ level: "middle" }))], [`${DP} 믿음 섞기(beliefs)`, e(belief({ level: "high", subtle: true }))]], "mini xs", ["30mm", ""]);

  const g = guard.guardMessages({ event: ev, persona: adel, claims: adel.claims, history: [], studentMessage: "(학생이 보낸 질문)", reply: "(인물 AI가 만든 응답)", lookups: [], level: "high" });
  h += pv({ n: "②", t: "감독자 AI의 프롬프트 (시스템 부분)" }, [["쓰이는 곳", "인물 AI의 응답을 학생에게 보내기 직전"], ["입력", "아래 내용 + [직전 대화 3번]·[학생 질문]·[인물의 응답]"], ["출력", "JSON {ok, category, reason, fixed, conduct}"], ["모델", "gpt-5.6-terra"]], g[0].content);
  h += tbl(["판정", "처리", "학생에게 가는 대체 문구(고칠 수 없을 때)"], guard.CATEGORIES.filter((c) => c !== "ok").map((c) => [c, guard.FIXABLE.includes(c) ? "감독자가 고쳐 쓴 응답(fixed)을 보내고, 없으면 대체 문구를 보냄" : "대체 문구를 보냄", e(guard.FALLBACKS[c] || "")]).concat([["error(감독자 호출 실패)", "대체 문구를 보내고 질문 횟수를 되돌림", e(guard.FALLBACKS.error)]]), "mini xs", ["26mm", "44mm", ""]);
  h += tbl(["학생 태도", "인물이 선을 긋는 응답", "기록"], [["조롱·모욕(mockery)", e(conduct.boundaryReply("mockery")), "교사 화면 알림, 경고 1/3"], ["성적 희롱(sexual)", e(conduct.boundaryReply("sexual")), "교사 화면 알림, 세 번이면 대화 중지"]], "mini xs", ["30mm", "", "40mm"]);

  const lt = lookup.lookupTool(ev).function;
  h += pv({ n: "③", t: "사실 조회(웹 검색) 도구와 검색 지시" }, [["쓰이는 곳", "인물이 자기 자료에 없는 구체적 사실에 관한 질문을 받았을 때(최대 2회)"], ["입력", "인물이 정한 검색어(query)"], ["출력", "검색 요약과 출처(인물 AI에게 ‘데이터’로 전달)"], ["모델", "gpt-5.6-luna + web_search"]], "[인물 AI에게 주는 도구 lookup]\n" + lt.description + "\n(매개변수 query) " + lt.parameters.properties.query.description + "\n[검색 호출의 지시문]\n" + lookup.searchInstructions(ev) + "\n[검색 결과를 인물에게 돌려주는 말]\n" + lookup.toolResultText({ found: true, summary: "(검색 요약)" }) + "\n(찾지 못한 경우) " + lookup.toolResultText({ found: false }));

  h += pv({ n: "④", t: "2단계 생각 도우미 (원인 추측용)" }, [["쓰이는 곳", "2단계 ‘이 사건은 왜 생겼을까요’ 추측을 제출한 뒤"], ["입력", "모둠 문제 질문 + 학생의 추측"], ["출력", "JSON {kind, question}: 유형 판정과 질문 하나"], ["모델", "gpt-5.6-luna · 학생당 8번"]], prompts.coachPrompt(evctx(), "cause"));
  { const L = prompts.coachPrompt(evctx(), "link").split("\n"); h += p0("<b>④-2 처음 생각 돌아보기용</b>은 아래의 역할 문장과 유형 목록만 다르며, [규칙]은 ④와 같다(JSON의 kind 값만 이 유형 목록을 따른다)."); h += pv({ n: "④-2", t: "생각 도우미: 처음 생각 돌아보기용 (달라지는 부분)" }, [["쓰이는 곳", "2단계 ‘처음 내 생각 돌아보기’"], ["입력", "1단계 처음 생각의 이유·생활 장면"], ["출력", "JSON {kind, question}"], ["모델", "gpt-5.6-luna"]], L.slice(1, L.indexOf("[규칙]")).join("\n")); }

  h += pv({ n: "⑤", t: "3단계 검색 보조자 (심화: 다른 쪽 자료 섞기 켬)" }, [["쓰이는 곳", "3단계 ‘확인 질문’ 중 AI에게 묻기를 눌렀을 때"], ["입력", "모둠 문제 + 확인 질문 + 교사가 준비한 2단계 자료 + 웹 검색 요약"], ["출력", "세 제목(알려진 내용·확인할 곳·불확실한 점), 10줄 이내"], ["모델", "gpt-5.6-luna · 모둠 한도 150회에 포함"]], prompts.verifyPrompt({ ...evctx(), deep: { sources: true } }, { materials: "(교사가 준비한 2단계 실제 사건 자료 전체가 분류별로 들어감)", search: { found: true, summary: "(이번 질문으로 웹 검색해 찾은 내용 요약)", sources: [{ title: "(출처 제목)" }] } }), { common });

  h += pv({ n: "⑥", t: "4단계 대안 검토자 (관점 3개, 각각 독립 호출)" }, [["쓰이는 곳", "4단계 모둠 해결책을 쓴 뒤 ‘AI 의견 듣기’"], ["입력", "모둠 문제·핵심 원인·확인한 사실 + 해결책"], ["출력", "관점별 강점·약점·질문(고쳐 쓰거나 순위를 매기지 않음)"], ["모델", "gpt-5.6-luna 3회 독립 호출"]], prompts.feedbackPrompt(evctx(), "feasibility"), { common });
  h += p0("위 프롬프트는 첫 번째 관점(실행 가능성)으로 조립한 것이며, 관점마다 [역할] 문장의 관점 설명만 달라진다.");
  h += XL(HS, "세 관점(실행 가능성, 이해관계자 영향, 부작용과 장기 영향)의 검토자가 각각 응답한다.") + XL(MS, "두 관점(실행 가능성, 이해관계자 영향)의 검토자가 응답한다.");
  h += tbl(["관점", "역할 문장에 들어가는 관점 설명"], Object.entries(prompts.LENSES).map(([k, v]) => [k, e(v)]), "mini xs", ["24mm", ""]);

  h += pv({ n: "⑦", t: "5단계 미리보기 제공자 (시나리오, 고등학교)" }, [["쓰이는 곳", "5단계 반응 예측 2개를 쓴 뒤 ‘미래 이야기 만들기’"], ["입력", "모둠 문제·핵심 원인·확인한 사실·최종 해결책·반응 예측 + 시점(1·3·5년)"], ["출력", "JSON: 시나리오 2개(제목·이야기·작동 기제·뜻밖의 일·예상 문제)"], ["모델", "gpt-5.6-terra · 사고량 medium"]], prompts.scenarioPrompt(evctx(), 3), { common });

  h += h4("4-5. AI 설계의 한계와 교사가 확인할 점");
  h += ul([
    "AI의 응답에는 오류가 있을 수 있다. 인물의 ‘틀릴 수 있는 믿음’은 의도적으로 설계한 것이지만 그 밖의 오류도 생길 수 있으므로, 학생이 자료로 검증하도록 수업을 설계하였다(3단계).",
    "감독자 AI 역시 모델이므로 모든 위반을 걸러 내지 못할 수 있다. 교사는 수업 중 ‘확인이 필요해요’와 ‘대화 보기’로 확인하고, 감독자가 고치기 전의 원래 응답은 교사 전용 기록으로 사후에 점검할 수 있다.",
    "시나리오는 예측이 아니라 ‘가능한 전개’이다. 프롬프트에서 근거 없는 통계 수치의 생성을 금지하며, 학생이 ‘왜 그렇게 되는가’를 따져 보는 활동으로 보완한다.",
    "인물과 자료의 근거 진술은 보도와 자료를 대조하여 정리하였다. 수업 전에 교사가 원문을 확인하고, 필요하면 ‘인물 편집’과 ‘자료 관리’에서 수정한다. 교사가 직접 수정한 자료에는 원문 대조를 거치지 않았다는 경고가 표시된다.",
    "모델 이름·사고량·한도는 서버 설정이므로 학기 중에 바뀔 수 있다. 교사 화면의 ‘인물·자료 점검’ 탭에서 AI 연결 상태와 사용 중인 모델을 확인할 수 있다.",
    "수업 전에 교사가 학생 화면에서 인물과 직접 대화해 보고, 인물의 응답이 설정과 맞는지 확인하기를 권한다.",
  ]);
  return h;
}

// ============ 부록 5. 수행평가 척도표와 평가 과정 ============
// 척도표는 앱의 rubric.js(고등학교, 심화 활동 모두 켬, 모둠 기여도 켬)에서 그대로 가져오고, 평가 과정은 교사 화면 '평가' 탭과 서버 규칙(autopilot.js)을 따른다.
function apx5() {
  const deepAll = Object.fromEntries(DEEP_KEYS.map((k) => [k, true]));
  const r = RB.rubricFor("high", deepAll, { contrib: true }), mid = RB.rubricFor("middle", {}, { contrib: true });
  const gMax = r.total - r.indivMax, share = r.criteria.filter((c) => c.scope === "group").reduce((n, c) => n + c.max, 0), contrib = r.criteria.find((c) => c.id === "c63");
  const T = AP.T;
  let h = abar(5, "수행평가 척도표와 평가 과정");
  h += p0("이 수업의 수행평가는 학생이 웹앱에 기록한 판단·근거·이유를 척도표에 따라 평가한다. 척도표와 평가 과정은 AI-EPS 웹앱의 평가 기능(교사 화면 ‘평가’ 탭)을 근거로 정리하였으며, 평가 화면은 부록 1에 수록하였다.");

  h += h4("5-1. 평가 개요");
  h += tbl(["항목", "내용"], [
    ["평가 대상", "학생이 웹앱에 쓴 판단·근거·이유를 평가한다. AI에게 질문한 횟수, 글자 수, 맞춤법, AI 사용 여부는 점수에 반영하지 않는다."],
    ["배점", `100점 만점이다. 개인 영역은 ${r.indivMax}점, 모둠 영역은 ${gMax}점이다. 모둠 영역은 모둠원이 함께 받는 ${share}점과 학생마다 다르게 받는 모둠 기여도 ${contrib.max}점으로 이루어진다.`],
    ["수준과 점수", XL(HS, `${r.labels.join("·")}의 네 수준으로 평가하며, 점수는 배점의 100·80·60·40%이다.`) + XL(MS, `${mid.labels.join("·")}의 세 수준으로 평가하며, 10점 항목은 10·7·4점, 5점 항목은 5·4·2점이다.`)],
    ["미제출", "근거가 되는 글이 비어 있으면 어느 수준에도 넣지 않고 미제출(0점)로 처리한다. 글이 있는 항목은 미제출로 처리할 수 없다."],
    ["개인 항목의 근거", "모둠 산출물 가운데 원인 추측·확인 질문·해결책·반응 예측은 입력한 학생을 기준으로 나누어, 그 학생이 쓴 항목만 개인 점수의 근거로 삼는다. 토의에는 참여하였으나 입력은 다른 모둠원이 한 경우는 협력 태도(교사 관찰)와 평가 근거로 보완한다."],
    ["모둠 기여도", "학생이 인물과 대화한 뒤 모둠에 보낸 정리와 직접 쓴 원인·해결책·반응 예측이 모둠의 문제 문장·가장 큰 원인·최종 해결책에 쓰였는지를 평가한다. 정리 자체의 질은 ‘인물 이해’ 항목에서 평가하므로, 이 항목에서는 대화 내용을 근거에서 제외한다."],
    ["평가 근거", "가장 높은 수준이나 가장 낮은 수준을 부여하는 경우, AI 의견과 두 수준 이상 다르게 정하는 경우에는 평가 근거를 반드시 기록한다. 평가 근거는 점수를 공개하면 학생에게 제시된다."],
  ], "mini", ["30mm", ""]);

  h += h4("5-2. 척도표(고등학교, 심화 활동 켬, 모둠 기여도 넣음)");
  const area = (c) => (c.scope === "group" ? "모둠" : c.area === "group" ? "학생별 · 모둠 영역" : "개인");
  const rows = [];
  let last = 0;
  for (const c of r.criteria) {
    if (c.el !== last) { rows.push(`<tr class="rel"><td colspan="${r.labels.length + 1}">${e(c.elName)}</td></tr>`); last = c.el; }
    // 심화 조건은 대부분 '매우 잘함'의 조건이므로 그 칸 아래에 배지와 함께 둔다
    rows.push(`<tr><td><b>${e(c.name)}</b><div class="rmeta">${e(c.stage)}<br>${area(c)} · ${c.max}점</div></td>${c.levels.map((l, i) => `<td>${e(l.desc)}<div class="rpts">${l.pts}점</div>${i === 0 ? c.deepNotes.map((n) => XL(DP, e(n))).join("") : ""}</td>`).join("")}</tr>`);
  }
  h += `<table class="mini xs rub"><colgroup><col style="width:28mm">${r.labels.map((_, i) => `<col${i === 0 ? ' style="width:37mm"' : ""}>`).join("")}</colgroup><thead><tr><th>항목</th>${r.labels.map((l) => `<th>${e(l)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
  h += `<div class="rnote">${XL("※", "근거가 되는 글이 비어 있는 항목은 모두 미제출(0점)로 처리한다.")}${XL(MS, "중학교 척도표는 같은 항목을 세 수준의 쉬운 말로 서술하며, 학교급을 바꾸면 웹앱이 자동으로 적용한다.")}${XL(DP, "심화 조건은 수업 설정에서 해당 심화 활동을 켠 경우에만 ‘매우 잘함’의 조건으로 붙는다.")}</div>`;

  h += h4("5-3. 웹앱의 평가 과정");
  h += p0("교사 화면의 ‘평가’ 탭은 위쪽의 단계 막대(① AI 채점 → ② 확인 → ③ 세특 쓰기 → ④ 학생에게 공개)를 따라 진행한다. 단계 막대에는 단계마다 남은 일이 표시되며, 아직 끝나지 않은 첫 단계가 ‘지금’으로 표시된다.");
  h += tbl(["항목", "내용"], [
    ["① AI 채점", "교사가 ‘AI 채점 시작’을 누르면 서버가 모든 모둠과 학생을 차례로 채점한다. 교사가 화면을 닫아도 서버가 이어서 처리한다. AI는 같은 근거를 빠른 모델로 세 번 독립 채점하고, 결과가 갈리거나 인용한 문장을 학생 글에서 찾지 못한 항목만 정밀 모델로 다시 판정한다. 판정마다 근거로 든 학생 글의 문장과 이유가 기록된다."],
    ["② 확인", "AI가 확실하게 정한 점수는 ‘AI가 정한 점수(확정 전)’로 채워 두고, 그렇지 않은 항목은 ‘직접 정할 점수’로 교사에게 보낸다. 교사는 직접 정할 점수와 학생의 이의 신청을 처리하고, AI가 판단할 수 없는 협력 태도(관찰) 점수를 매긴 뒤, AI가 정한 점수를 확정한다. 확정하기 전의 점수는 학생에게 공개되지 않는다."],
    ["③ 세특 쓰기", "‘초안 모두 만들기’ 또는 학생별 ‘초안 만들기’로 세특 초안을 만든다. AI는 학생이 쓴 활동 기록만을 근거로 글의 수준을 판정하고, 기승전결 구조의 초안을 쓴 뒤 NEIS 바이트 기준 분량에 맞춘다. 근거와 연결되지 않는 문장은 삭제하며, 학생의 글이 분량에 비해 적으면 내용을 지어내지 않고 짧게 쓴다. 초안은 교사가 읽고 수정하여 저장해야 확정된다."],
    ["④ 학생에게 공개", "교사는 ‘학생 화면 미리보기’로 학생에게 보일 내용을 확인한 뒤 점수와 세특을 각각 공개한다. 학생은 ‘내 결과’에서 항목별 점수·수준·평가 근거와 세특을 확인하며, 교사가 정한 마감까지 항목마다 한 번 이의를 신청할 수 있다. 이의 신청은 ② 확인으로 모인다."],
    ["NEIS에 옮기기", "학생별 항목 점수, 개인·모둠 영역 합계, 총점, 확정되지 않은 항목, 저장한 세특을 엑셀에서 열리는 파일(CSV)로 내려받는다. 학생은 모둠과 별명으로 표시되므로 학생 이름은 교사가 대조한다."],
    ["평가에서 빼기", "결석·전학 등으로 평가할 수 없는 학생은 학생별 화면에서 사유를 기록하고 평가에서 뺀다. 이 학생은 진행률·일괄 작업·점수 집계에서 제외되며, 학생 화면에는 평가에서 제외되었다는 안내만 표시된다. 대체 평가와 인정점은 학교 규정에 따라 처리한다."],
  ], "mini", ["30mm", ""]);
  h += h4("AI가 정한 점수의 조건(‘애매한 것만 확인’ 방식)");
  h += p0("다음 조건을 모두 충족한 항목만 AI가 점수를 정하며, 하나라도 충족하지 않으면 그 이유와 함께 교사에게 보낸다.");
  h += ul([
    "세 번의 채점 결과가 같은 수준이어야 한다.",
    "AI가 근거로 인용한 문장이 학생의 글에 실제로 있어야 한다.",
    "AI가 두 수준 사이에서 판단이 애매하다고 표시하지 않아야 한다.",
    `학생의 글이 ${T.minEvidenceChars}자 이상이고, AI에게 점수를 요구하거나 규칙을 무시하라는 문장이 없어야 한다.`,
    "가장 높은 수준이나 가장 낮은 수준은 정밀 모델의 재판정 결과도 같아야 한다.",
  ]);

  h += h4("5-4. 채점 방식과 신뢰도 점검");
  h += tbl(["항목", "내용"], [
    ["채점 방식", "수업마다 세 가지 가운데 하나를 선택한다. ‘애매한 것만 확인’(기본)은 위의 조건을 충족하지 않는 점수만 교사가 확인한다. ‘AI 점수를 하나씩 확인’은 모든 점수를 교사가 열어 확인한다. ‘내가 먼저 채점’은 교사가 먼저 채점한 뒤 AI 의견을 보는 방식으로, 교사와 AI의 일치도를 점검할 때 사용한다."],
    ["AI를 내 기준에 맞춰 보기", `선택 기능이다. 교사가 표본 학생 ${T.sampleStudents}명과 모둠 일부를 AI 점수 없이 채점하면, 교사와 AI의 일치율이 ${T.calibExact}% 이상인 항목만 AI가 점수를 정한다. 결과는 같은 척도표·학교급·주제·심화 설정의 다른 수업에서도 다시 사용한다.`],
    ["채점 점검", `교사와 AI의 일치율·가중 카파·채점 경향, AI 세 번 채점의 일치율, AI 점수를 고친 비율, 교사가 다시 채점했을 때의 일치율을 제시한다. 확정한 점수 일부를 점수를 가린 채 다시 채점한 결과가 AI와 자주 다르면(${T.auditMin}개 이상에서 일치율 ${T.auditExact}% 미만) AI의 자동 확정을 멈춘다.`],
    ["이름 가리기", "학생 이름 대신 코드로 표시하고 모둠과 관계없는 순서로 배열하여, 먼저 본 학생이나 모둠에 대한 인상이 채점에 영향을 주지 않게 한다."],
    ["기록", "점수를 수정하면 이전 수준·평가 근거·시각을 다섯 번까지 기록한다. AI의 판정에는 척도표 버전, 사용한 모델, 자동 확정 여부의 판단 이유가 남는다."],
  ], "mini", ["30mm", ""]);

  h += h4("5-5. 유의 사항");
  h += ul([
    "AI는 채점을 보조할 뿐이며, 최종 점수는 교사가 확정하고 책임진다. 학교의 학업성적관리규정이 AI 보조 채점을 허용하는지 수업 전에 확인한다.",
    "AI의 자동 확정을 사용하더라도, 처음 몇 차례는 ‘AI 점수를 하나씩 확인’ 방식으로 AI의 판단을 살펴보기를 권한다.",
    "모둠 기여도와 인물 이해는 같은 정리 글과 관련되므로 두 점수가 함께 움직이는 경향이 있다. 협력 태도(관찰)와 함께 검토하여 필요하면 교사가 조정한다.",
    "세특 초안의 문장은 근거가 된 활동 기록과 함께 표시된다. 근거와 다른 문장이나 과장된 표현이 없는지 확인한 뒤 저장한다.",
  ]);
  return h;
}

module.exports = { apx1, apx2, apx4, apx5, apx6, abar, HS, MS, DP, XL };
