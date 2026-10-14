import { auth, db, call, esc, toast, errMsg } from "./fb.js";
import { signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc, onSnapshot, updateDoc, collection } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const STAGES = [
  { n: 1, name: "사건 경험", ai: "Y", cap: "공감하기" },
  { n: 2, name: "원인 탐색", ai: "X", cap: "연결·원인 탐색" },
  { n: 3, name: "검증", ai: "Y", cap: "검증하기" },
  { n: 4, name: "대안 구상", ai: "Y", cap: "대안 만들기" },
  { n: 5, name: "미래 시나리오", ai: "Y", cap: "결과 예측하기" },
  { n: 6, name: "행동계획", ai: "X", cap: "실천하기" },
  { n: 7, name: "공유·성찰", ai: "X", cap: "성찰하기" },
];
const ROUNDS = [1, 3, 5];
// 성찰 체크리스트(초안): 투명성, 주체성, 개인정보 보호, 타인의 권리 침해 금지 영역. 연구 문항에 맞춰 수정하세요.
const CHECKLIST = [
  "AI를 어느 단계에서 어떤 목적으로 썼는지 말할 수 있다.",
  "AI에게 묻기 전에 내가 먼저 생각하고 정리했다.",
  "AI의 답을 그대로 쓰지 않고 내 말로 바꾸어 썼다.",
  "AI의 답 중 틀렸거나 믿기 어려운 부분을 확인했다.",
  "AI의 답을 받아들이거나 버린 이유를 설명할 수 있다.",
  "최종 판단과 결정은 우리 모둠이 직접 내렸다.",
  "AI 사용 내용을 숨기지 않고 로그로 남겼다.",
  "AI에게 내 이름, 학교 등 개인정보를 알려 주지 않았다.",
  "AI로 특정 집단을 비하하거나 다른 사람의 권리를 해치는 내용을 만들지 않았다.",
  "AI가 만든 가상 인물의 이야기를 실제 사실로 착각하지 않았다.",
];

const S = { code: null, groupId: null, nick: null, uid: null, caseInfo: null, work: {}, logs: [], stage: 1, persona: null, proposalId: null, round: 1, busy: false, aiCount: 0 };
const $ = (s) => document.querySelector(s);
const panel = $("#panel");
let groupRef = null;
const w = (path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), S.work);
const arr = (path) => w(path) || [];
const ts = (l) => l.createdAt?.toMillis?.() || 0;
const stageLogs = (n) => S.logs.filter((l) => l.stage === n).sort((a, b) => ts(a) - ts(b));

async function save(path, value) {
  try { await updateDoc(groupRef, { ["work." + path]: value }); }
  catch (e) { console.error(e); toast("저장하지 못했습니다. 연결을 확인하세요.", true); }
}

// ---------- 입장 ----------
$("#j-btn").onclick = async () => {
  const code = $("#j-code").value.trim().toUpperCase();
  const groupNo = $("#j-group").value;
  const nickname = $("#j-nick").value.trim();
  if (!code || !groupNo || !nickname) return toast("세 칸을 모두 입력하세요.", true);
  try {
    await call("joinSession")({ code, groupNo: Number(groupNo), nickname });
    localStorage.setItem("eps_code", code);
    await enter(code);
  } catch (e) { toast(errMsg(e), true); }
};

async function enter(code) {
  const mSnap = await getDoc(doc(db, `sessions/${code}/members/${S.uid}`));
  if (!mSnap.exists()) { localStorage.removeItem("eps_code"); return; }
  Object.assign(S, { code, groupId: mSnap.data().groupId, nick: mSnap.data().nickname });
  groupRef = doc(db, `sessions/${code}/groups/${S.groupId}`);
  S.caseInfo = (await call("getCase")()).data;
  S.persona = S.caseInfo.personas[0]?.id;
  $("#join").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#who").textContent = `${S.groupId.replace("g", "")}모둠 · ${S.nick}`;
  onSnapshot(groupRef, (s) => { const d = s.data() || {}; S.work = d.work || {}; S.aiCount = d.aiCount || 0; render(); });
  onSnapshot(collection(db, `sessions/${code}/groups/${S.groupId}/logs`), (s) => { S.logs = s.docs.map((d) => ({ id: d.id, ...d.data() })); render(); });
  renderTabs();
}

onAuthStateChanged(auth, async (u) => {
  if (!u) { await signInAnonymously(auth); return; }
  S.uid = u.uid;
  const saved = localStorage.getItem("eps_code");
  if (saved && !S.code) enter(saved).catch(console.error);
});

// ---------- 공통 렌더 ----------
function renderTabs() {
  $("#tabs").innerHTML = STAGES.map((s) =>
    `<button class="stage-tab ${S.stage === s.n ? "on" : ""}" data-stage="${s.n}"><b>${s.n}</b><span>${s.name}</span></button>`).join("");
}
$("#tabs").onclick = (e) => {
  const b = e.target.closest("[data-stage]"); if (!b) return;
  S.stage = Number(b.dataset.stage); renderTabs(); render(true);
};

const gyrBanner = (n) => {
  const s = STAGES[n - 1];
  if (s.ai === "X") return `<div class="notice muted"><span class="tag x">AI 사용 안 함</span> 이 단계는 우리 모둠이 스스로 생각하는 단계입니다. 활동: ${s.cap}</div>`;
  return `<div class="notice yellow"><span class="tag y">YELLOW</span> 먼저 우리가 생각해서 쓰고, 그 다음에 AI를 사용합니다. AI의 답은 그대로 쓰지 않고 우리 말로 바꿔 판단합니다. 활동: ${s.cap}</div>`;
};

function loading() { return `<div class="loading-strip"><div class="spinner"></div><span>AI가 답을 만드는 중입니다…</span></div>`; }

function listHtml(path, rowFn, empty = "아직 없습니다.") {
  const items = arr(path);
  if (!items.length) return `<div class="meta-line">${empty}</div>`;
  return `<div class="group">${items.map((it, i) =>
    `<div class="cell"><div class="grow">${rowFn(it, i)}</div><button class="btn btn-plain btn-sm" data-act="del" data-path="${path}" data-i="${i}">삭제</button></div>`).join("")}</div>`;
}
const strAdder = (path, id, ph, min = 1) =>
  `<div class="row" style="margin-top:8px"><input type="text" id="${id}" placeholder="${ph}" style="flex:1;min-width:0" /><button class="btn btn-tinted" data-act="add-str" data-path="${path}" data-input="${id}" data-min="${min}">추가</button></div>`;

let lastKey = "";
function render(force = false) {
  if (!S.caseInfo) return;
  const ae = document.activeElement;
  const typing = !force && panel.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName);
  if (typing) return;
  const html = [renderStage[S.stage](), `<div class="meta-line" style="text-align:right">우리 모둠 AI 사용 ${S.aiCount}회</div>`].join("");
  // 변경 없을 때 DOM 교체를 피한다
  const key = S.stage + html;
  if (!force && key === lastKey) return;
  lastKey = key;
  const sc = window.scrollY;
  panel.innerHTML = html;
  window.scrollTo(0, sc);
}

// ---------- 단계별 화면 ----------
const renderStage = {
  1() {
    const info = S.caseInfo, qs = arr("s1.preQuestions"), logs = stageLogs(1).filter((l) => l.payload?.personaId === S.persona);
    const persona = info.personas.find((p) => p.id === S.persona);
    const ready = qs.filter((q) => q.trim().length >= 5).length >= 3;
    return `${gyrBanner(1)}
    <div class="card"><h2>사건</h2><p>${esc(info.premise)}</p></div>
    <div class="card"><h3>① 모둠 사전 질문 만들기 <span class="tag ${ready ? "" : "x"}">${qs.length}/3 이상</span></h3>
      <p class="desc">대화하기 전에 모둠에서 토의해 인물에게 물어볼 질문을 3개 이상 만드세요. (질문 목록이 완성되어야 대화가 열립니다.)</p>
      ${listHtml("s1.preQuestions", (q) => esc(q), "질문을 추가하세요.")}
      ${strAdder("s1.preQuestions", "q1", "예) 한국에 와서 가장 힘들었던 일은 무엇인가요?", 5)}
    </div>
    <div class="card"><h3>② 가상 인물과 대화하기</h3>
      <div class="notice muted">대화 상대는 수업을 위해 만든 <b>가상의 인물</b>입니다. 실제 사실은 2단계에서 확인합니다. 모둠원마다 다른 인물과 대화해 정보를 나누어 보세요.</div>
      <div class="chipbar">${info.personas.map((p) => `<button class="chip ${p.id === S.persona ? "on" : ""}" data-act="persona" data-id="${p.id}">${esc(p.name)}</button>`).join("")}</div>
      <div class="meta-line" style="margin:8px 0">${esc(persona?.role || "")}</div>
      <div class="chat">${logs.map((l) => `<div class="bubble me">${esc(l.input)}</div><div class="bubble ai">${esc(l.output)}</div>`).join("") || `<div class="meta-line">아직 대화가 없습니다.</div>`}</div>
      ${S.busy ? loading() : ""}
      <div class="row" style="margin-top:10px"><input type="text" id="msg" maxlength="500" placeholder="${ready ? "질문을 입력하세요" : "먼저 사전 질문 3개를 만드세요"}" ${ready ? "" : "disabled"} style="flex:1;min-width:0" />
        <button class="btn btn-primary" data-act="ask-persona" ${ready && !S.busy ? "" : "disabled"}>보내기</button></div>
    </div>
    <div class="card"><h3>③ 대화에서 알게 된 점·빈틈</h3><textarea id="s1note" placeholder="궁금한 점, 더 알고 싶은 점을 적어 보세요." data-save="s1.note">${esc(w("s1.note") || "")}</textarea></div>`;
  },

  2() {
    const mats = S.caseInfo.realCaseMaterials || [];
    return `${gyrBanner(2)}
    <div class="card"><h3>실제 사건 자료</h3>
      ${mats.length ? `<div class="group">${mats.map((m) => `<div class="cell"><div class="grow"><b>${esc(m.title)}</b><br><span class="meta-line">${esc(m.source || "")}</span><br>${esc(m.summary || "")}${m.url ? `<br><a href="${esc(m.url)}" target="_blank" rel="noopener">원문 보기</a>` : ""}</div></div>`).join("")}</div>`
        : `<div class="notice muted">선생님이 제시하는 실제 사건 자료(기사, 보고서 등)를 보면서 활동하세요.</div>`}</div>
    <div class="card"><h3>① 가상 경험 ↔ 실제 사건 대조</h3>
      <p class="desc">1단계 대화에서 알게 된 내용이 실제 자료에서도 확인되는지 비교해 적으세요.</p>
      ${listHtml("s2.contrast", (r) => `<b>대화에서 들은 내용</b>: ${esc(r.virtual)}<br><b>실제 자료에서 확인</b>: ${esc(r.real)}`)}
      <label class="lbl">대화에서 들은 내용</label><input type="text" id="cv" />
      <label class="lbl">실제 자료에서 확인한 내용 (같음/다름/확인 안 됨 포함)</label><input type="text" id="cr" />
      <div style="margin-top:8px"><button class="btn btn-tinted" data-act="add-contrast">대조 추가</button></div></div>
    <div class="card"><h3>② 나·우리 지역과의 연결고리</h3>
      <p class="desc">공감을 넘어서, 이 문제가 나와 내 주변과 <b>어떻게 연결되어 있는지</b> 구체적으로 적으세요. (예: 우리 동네, 우리 학교, 내가 이용하는 제도)</p>
      ${listHtml("s2.links", (r) => `<span class="tag">${esc(r.level)}</span> ${esc(r.text)}`)}
      <div class="row" style="margin-top:8px"><select id="ll" style="width:auto"><option>개인·가족</option><option>학교·지역</option><option>제도·사회</option></select>
      <input type="text" id="lt" placeholder="어떻게 연결되어 있나요?" style="flex:1;min-width:0" /><button class="btn btn-tinted" data-act="add-link">추가</button></div></div>
    <div class="card"><h3>③ 문제의 원인 추측</h3>
      <p class="desc">개인의 노력 문제인지, 제도·사회 구조의 문제인지 여러 층위에서 생각해 보세요.</p>
      ${listHtml("s2.causes", (q) => esc(q))}${strAdder("s2.causes", "cz", "원인을 추측해 적으세요")}</div>
    <div class="card"><h3>④ 검증 질문 만들기</h3>
      <p class="desc">추측한 원인이 사실인지 확인하기 위해 3단계에서 AI와 자료로 알아볼 질문을 만드세요. (3단계에서는 여기서 만든 질문만 AI에게 물을 수 있습니다.)</p>
      ${listHtml("s2.verifyQuestions", (q) => esc(q))}${strAdder("s2.verifyQuestions", "vq", "예) 난민 가족이 일자리를 구하기 어려운 이유는 무엇일까?", 5)}</div>`;
  },

  3() {
    const vqs = arr("s2.verifyQuestions"), logs = stageLogs(3);
    return `${gyrBanner(3)}
    <div class="card"><h3>① AI에게 물어보기 (검증 질문 한 개씩)</h3>
      ${vqs.length ? `<label class="lbl">2단계에서 만든 질문 고르기</label><select id="vsel">${vqs.map((q) => `<option>${esc(q)}</option>`).join("")}</select>
      ${S.busy ? loading() : ""}<div style="margin-top:10px"><button class="btn btn-primary" data-act="ask-verify" ${S.busy ? "disabled" : ""}>AI에게 질문하기</button></div>`
        : `<div class="notice">2단계에서 검증 질문을 먼저 만들어야 합니다.</div>`}</div>
    ${logs.map((l) => { const c = w(`s3.checks.${l.id}`) || {};
      return `<div class="card" data-log="${l.id}"><div class="meta-line">질문</div><b>${esc(l.input)}</b>
      <div class="ai-out">${esc(l.output)}</div>
      <label class="lbl">직접 찾아 확인한 자료 (출처·URL)</label><input type="text" data-f="source" value="${esc(c.source || "")}" />
      <label class="lbl">판단</label><select data-f="verdict">${["", "수용", "보류", "불수용"].map((v) => `<option ${c.verdict === v ? "selected" : ""}>${v}</option>`).join("")}</select>
      <label class="lbl">이유 (내 말로)</label><textarea data-f="reason">${esc(c.reason || "")}</textarea>
      <div style="margin-top:8px"><button class="btn btn-tinted" data-act="save-check" data-id="${l.id}">검증 결과 저장</button></div></div>`; }).join("")}
    <div class="card"><h3>② 핵심 원인 도출</h3>
      <p class="desc">수용한 정보를 종합해, 이 문제의 핵심 원인이 무엇인지 모둠 토의로 정리하세요.</p>
      <textarea id="core" data-save="s3.coreCause">${esc(w("s3.coreCause") || "")}</textarea></div>`;
  },

  4() {
    const props = arr("s4.proposals"), logs = stageLogs(4);
    return `${gyrBanner(4)}
    <div class="card"><h3>① 우리 모둠 대안 쓰기</h3>
      <p class="desc">다른 지역·나라의 사례에서 얻은 아이디어로 모둠이 먼저 대안을 만드세요. (30자 이상 저장해야 AI 피드백을 받을 수 있습니다.)</p>
      ${props.map((p, i) => `<div class="card" style="box-shadow:none;background:var(--fill);padding:12px"><div class="grow">${esc(p.text)}</div>
        <div class="row" style="margin-top:8px"><button class="btn btn-primary btn-sm" data-act="ask-feedback" data-id="${p.id}" ${S.busy ? "disabled" : ""}>AI 피드백 받기</button>
        <button class="btn btn-plain btn-sm" data-act="del" data-path="s4.proposals" data-i="${i}">삭제</button></div></div>`).join("")}
      <textarea id="pt" placeholder="우리 모둠의 해결 대안을 구체적으로 적으세요."></textarea>
      <div style="margin-top:8px"><button class="btn btn-tinted" data-act="add-proposal">대안 추가</button></div>
      ${S.busy ? loading() : ""}</div>
    ${logs.map((l) => { const d = w(`s4.decisions.${l.id}`) || {}; const p = props.find((x) => x.id === l.payload?.proposalId);
      return `<div class="card" data-log="${l.id}"><div class="meta-line">피드백을 받은 대안</div><b>${esc((p?.text || l.input).slice(0, 80))}</b>
      <div class="ai-out">${esc(l.output)}</div>
      <label class="lbl">이 피드백을 어떻게 할까요?</label><select data-f="choice">${["", "수용", "수정해서 반영", "기각"].map((v) => `<option ${d.choice === v ? "selected" : ""}>${v}</option>`).join("")}</select>
      <label class="lbl">이유 (우리 말로)</label><textarea data-f="reason">${esc(d.reason || "")}</textarea>
      <div style="margin-top:8px"><button class="btn btn-tinted" data-act="save-decision" data-id="${l.id}">판단 저장</button></div></div>`; }).join("")}
    <div class="card"><h3>② 최종 대안 (피드백을 참고해 약점 보완)</h3>
      <textarea id="fin" data-save="s4.final" placeholder="1순위 대안을 고르고 약점을 보완한 최종 대안">${esc(w("s4.final") || "")}</textarea>
      <label class="lbl">최종 대안을 선택한 이유</label><textarea id="finr" data-save="s4.finalReason">${esc(w("s4.finalReason") || "")}</textarea></div>`;
  },

  5() {
    const props = arr("s4.proposals"), preds = arr("s5.predictions"), logs = stageLogs(5);
    const sh = S.caseInfo.stakeholders;
    return `${gyrBanner(5)}
    <div class="card"><h3>① 이해관계자 반응 먼저 예측하기</h3>
      <p class="desc">AI 시뮬레이션 전에, 우리 대안이 실행되면 이해관계자들이 어떻게 반응하고 서로 어떤 영향을 줄지 모둠이 먼저 예측하세요. (2개 이상)</p>
      ${listHtml("s5.predictions", (r) => `<span class="tag">${esc(r.stakeholder)}</span> ${esc(r.text)}`)}
      <div class="row" style="margin-top:8px"><select id="ps" style="width:auto">${sh.map((x) => `<option>${esc(x)}</option>`).join("")}</select>
      <input type="text" id="pp" placeholder="예측과 이유" style="flex:1;min-width:0" /><button class="btn btn-tinted" data-act="add-pred">추가</button></div></div>
    <div class="card"><h3>② AI 시뮬레이션</h3>
      <div class="notice muted">시뮬레이션은 실제 미래의 <b>예측이 아니라</b> 가능한 시나리오 중 일부입니다. 시간이 지나며 생기는 파급효과와 의도하지 않은 결과를 살펴보세요.</div>
      ${props.length ? `<label class="lbl">시뮬레이션할 대안</label><select id="sp">${props.map((p) => `<option value="${p.id}" ${p.id === S.proposalId ? "selected" : ""}>${esc(p.text.slice(0, 50))}</option>`).join("")}</select>
      <label class="lbl">몇 년 후?</label><div class="chipbar">${ROUNDS.map((r) => `<button class="chip ${S.round === r ? "on" : ""}" data-act="round" data-r="${r}">${r}년 후</button>`).join("")}</div>
      ${S.busy ? loading() : ""}<div style="margin-top:10px"><button class="btn btn-primary" data-act="ask-scenario" ${preds.length >= 2 && !S.busy ? "" : "disabled"}>시나리오 만들기</button></div>`
        : `<div class="notice">4단계에서 대안을 먼저 작성하세요.</div>`}</div>
    ${logs.map((l) => { let sc = []; try { sc = JSON.parse(l.output).scenarios || []; } catch {}
      const sel = w(`s5.selection.${l.id}`) || {};
      return `<div class="card" data-log="${l.id}"><div class="meta-line">${l.payload?.round}년 후 시나리오</div>
      ${sc.map((x, i) => `<div class="scn ${sel.idx === i ? "sel" : ""}"><b>${esc(x.title)}</b><p>${esc(x.story)}</p><div class="meta-line">새로 생긴 문제 후보: ${esc((x.newProblems || []).join(" / "))}</div>
        <button class="btn btn-plain btn-sm" data-act="pick-scn" data-id="${l.id}" data-i="${i}">이 시나리오가 더 개연성 있다</button></div>`).join("")}
      <label class="lbl">개연성이 높다고 판단한 이유 (내 말로)</label><textarea data-f="reason">${esc(sel.reason || "")}</textarea>
      <div style="margin-top:8px"><button class="btn btn-tinted" data-act="save-scn" data-id="${l.id}">판단 저장</button></div></div>`; }).join("")}
    <div class="card"><h3>③ 선택한 시나리오에서 발견한 새로운 문제</h3>
      <textarea id="np" data-save="s5.newProblem" placeholder="대안을 실행한 뒤 새로 생길 수 있는 문제는 무엇인가요?">${esc(w("s5.newProblem") || "")}</textarea></div>`;
  },

  6() {
    const p = w("s6.plan") || {};
    const f = (k, l, ph) => `<label class="lbl">${l}</label><textarea data-plan="${k}" placeholder="${ph}">${esc(p[k] || "")}</textarea>`;
    return `${gyrBanner(6)}
    <div class="card"><h3>5단계에서 발견한 새로운 문제</h3><div class="ai-out" style="background:var(--accent-tint)">${esc(w("s5.newProblem") || "아직 적지 않았습니다.")}</div></div>
    <div class="card"><h3>행동계획 세우기</h3>
      <p class="desc">우리 학교 안에서 실제로 할 수 있는 수준으로 구체적으로 계획하세요. (예: 설득하는 편지 쓰기, 우리의 실천 약속)</p>
      ${f("target", "누구에게 / 무엇에 대해", "대상(누구의 어떤 반응·문제)")}${f("content", "내용", "무엇을 전하거나 실천할 것인가")}
      ${f("method", "방법", "어떻게 실천할 것인가")}${f("effect", "기대 효과", "이 행동으로 기대하는 변화")}${f("difficulty", "예상되는 어려움과 대응", "실패한다면 어느 단계를 다시 살펴볼까?")}
      <div style="margin-top:10px"><button class="btn btn-primary" data-act="save-plan">계획 저장</button></div></div>
    <div class="card"><h3>실천 결과가 예상과 다르다면?</h3><p class="desc">이전 단계로 돌아가 다시 생각해 볼 수 있습니다.</p>
      <div class="row"><button class="btn btn-plain btn-sm" data-go="2">원인 다시 보기(2·3단계)</button><button class="btn btn-plain btn-sm" data-go="4">대안 다시 보기(4단계)</button><button class="btn btn-plain btn-sm" data-go="5">예측 다시 보기(5단계)</button></div></div>`;
  },

  7() {
    const by = [1, 3, 4, 5].map((n) => ({ n, c: stageLogs(n).length }));
    const dec = Object.values(w("s4.decisions") || {}), cnt = (k) => dec.filter((d) => d.choice === k).length;
    const checks = w("s7.checks") || {};
    return `${gyrBanner(7)}
    <div class="card"><h3>① 우리 모둠의 AI 사용 기록</h3>
      <div class="group">${by.map((b) => `<div class="cell"><span class="grow">${b.n}단계 (${STAGES[b.n - 1].name})</span><b>${b.c}회</b></div>`).join("")}
      <div class="cell"><span class="grow">AI 피드백 판단</span><span>수용 ${cnt("수용")} · 수정 ${cnt("수정해서 반영")} · 기각 ${cnt("기각")}</span></div></div></div>
    <div class="card"><h3>② 산출물 공유</h3>
      <p class="desc">발표할 내용을 간단히 정리하세요.</p>
      <textarea id="share" data-save="s7.share">${esc(w("s7.share") || "")}</textarea></div>
    <div class="card"><h3>③ AI 활용 성찰 체크리스트</h3>
      <div class="group">${CHECKLIST.map((t, i) => `<label class="cell" style="cursor:pointer"><input type="checkbox" data-chk="${i}" ${checks[i] ? "checked" : ""} style="width:20px;height:20px;margin-top:2px"><span class="grow">${esc(t)}</span></label>`).join("")}</div>
      <label class="lbl">오늘 AI를 어떻게 썼고, 무엇을 받아들이거나 버렸는지 돌아보기</label>
      <textarea id="refl" data-save="s7.reflection">${esc(w("s7.reflection") || "")}</textarea></div>`;
  },
};

// ---------- 이벤트 ----------
const val = (id) => document.getElementById(id)?.value.trim() ?? "";

async function ai(stage, type, payload) {
  S.busy = true; render(true);
  try { await call("aiRequest")({ code: S.code, stage, type, payload }); }
  catch (e) { toast(errMsg(e), true); }
  finally { S.busy = false; render(true); }
}

panel.addEventListener("click", async (e) => {
  const go = e.target.closest("[data-go]");
  if (go) { S.stage = Number(go.dataset.go); renderTabs(); render(true); return; }
  const b = e.target.closest("[data-act]"); if (!b) return;
  const a = b.dataset.act, d = b.dataset;
  const card = b.closest("[data-log]");
  const field = (f) => card?.querySelector(`[data-f=${f}]`)?.value.trim() || "";

  switch (a) {
    case "add-str": {
      const v = val(d.input);
      if (v.length < Number(d.min)) return toast(`${d.min}자 이상 입력하세요.`, true);
      await save(d.path, [...arr(d.path), v]); render(true); break;
    }
    case "del": { const l = [...arr(d.path)]; l.splice(Number(d.i), 1); await save(d.path, l); render(true); break; }
    case "persona": S.persona = d.id; render(true); break;
    case "ask-persona": { const m = val("msg"); if (!m) return; await ai(1, "persona_chat", { personaId: S.persona, message: m }); break; }
    case "add-contrast": {
      if (!val("cv") || !val("cr")) return toast("두 칸을 모두 쓰세요.", true);
      await save("s2.contrast", [...arr("s2.contrast"), { virtual: val("cv"), real: val("cr") }]); render(true); break;
    }
    case "add-link": {
      if (val("lt").length < 5) return toast("연결고리를 구체적으로 쓰세요.", true);
      await save("s2.links", [...arr("s2.links"), { level: val("ll"), text: val("lt") }]); render(true); break;
    }
    case "ask-verify": await ai(3, "verify_query", { question: val("vsel") }); break;
    case "save-check":
      await save(`s3.checks.${d.id}`, { source: field("source"), verdict: field("verdict"), reason: field("reason") }); toast("저장했어요"); break;
    case "add-proposal": {
      const t = val("pt"); if (t.length < 30) return toast("대안을 30자 이상 쓰세요.", true);
      const id = "a" + Date.now().toString(36);
      await save("s4.proposals", [...arr("s4.proposals"), { id, text: t }]); S.proposalId = id; render(true); break;
    }
    case "ask-feedback": S.proposalId = d.id; await ai(4, "proposal_feedback", { proposalId: d.id }); break;
    case "save-decision":
      await save(`s4.decisions.${d.id}`, { choice: field("choice"), reason: field("reason") }); toast("저장했어요"); break;
    case "add-pred": {
      if (val("pp").length < 10) return toast("예측과 이유를 10자 이상 쓰세요.", true);
      await save("s5.predictions", [...arr("s5.predictions"), { stakeholder: val("ps"), text: val("pp") }]); render(true); break;
    }
    case "round": S.round = Number(d.r); render(true); break;
    case "ask-scenario": {
      const pid = val("sp") || S.proposalId; S.proposalId = pid;
      await ai(5, "scenario", { proposalId: pid, round: S.round }); break;
    }
    case "pick-scn": { const cur = w(`s5.selection.${d.id}`) || {}; await save(`s5.selection.${d.id}`, { ...cur, idx: Number(d.i) }); break; }
    case "save-scn": {
      const cur = w(`s5.selection.${d.id}`) || {};
      await save(`s5.selection.${d.id}`, { ...cur, reason: field("reason") }); toast("저장했어요"); break;
    }
    case "save-plan": {
      const plan = {}; panel.querySelectorAll("[data-plan]").forEach((t) => (plan[t.dataset.plan] = t.value.trim()));
      await save("s6.plan", plan); toast("저장했어요"); break;
    }
  }
});

// 자유 서술 칸: 입력이 멈추면 자동 저장
let t;
panel.addEventListener("input", (e) => {
  const p = e.target.dataset?.save; if (!p) return;
  clearTimeout(t); t = setTimeout(() => save(p, e.target.value), 700);
});
panel.addEventListener("change", (e) => {
  const c = e.target.dataset?.chk; if (c == null) return;
  save(`s7.checks.${c}`, e.target.checked);
});
