// 교사 화면 '내 주제': 웹앱 안에서 새 수업 주제(사건)를 만든다. 서버 함수 topics(functions/topicApi.js)를 부른다.
//  1) 아이디어 → 사건 후보(실제 보도) → 고르기(또는 직접 적기) → 대화 시점·꼭 들어야 할 사람 정하기
//  2) 조사 → 사건 틀·인물 구성안(교사가 보고 고치거나 다시 짜기) → 인물 9명 → 자료·사례·이후 전개 → AI 점검
//  3) 검토: 출처 원문 확인(확인한 출처만 학생에게 쓰인다), 인물·사건·자료 고치기, 인물 다시 만들기 → 이 주제로 수업 만들기
// 주제는 만든 교사 계정에만 속한다. 설계는 docs/TOPIC_BUILDER.md.
import { call, esc, toast, errMsg } from "./fb.js";
import { waitHtml } from "./wait.js";
import { showModal, confirmModal } from "./modal.js";

const $ = (s) => document.querySelector(s);
const LONG = 560000; // 단계 하나가 몇 분 걸릴 수 있다(서버 제한 540초)
const api = (action, data = {}) => call("topics", LONG)({ action, ...data }).then((r) => r.data);
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "")) ? String(u) : "#");
const STEPS = [["research", "기사 조사"], ["frame", "사건 틀·인물 구성안"], ["personas", "인물"], ["extras", "자료·사례·이후 전개"], ["review", "AI 점검"]];
const ORDER = ["start", "research", "frame", "personas", "extras", "review"];
const SIDE_NAME = { A: "A쪽", B: "B쪽", 가운데: "가운데" };

let hooks = { onList: () => {}, onMakeClass: () => {} };
let list = [], usage = null, cur = null, draft = null, dirty = false, running = false, ideasResult = null, ideaInput = null;

export function initTopics(h) {
  hooks = { ...hooks, ...h };
  $("#tp-new").onclick = () => openWizard();
  $("#tp-list").onclick = (e) => { const b = e.target.closest("[data-topic]"); if (b) openTopic(b.dataset.topic); };
  window.addEventListener("beforeunload", (e) => { if (dirty || running) { e.preventDefault(); e.returnValue = ""; } });
}

// ---------- 목록 ----------
export async function loadTopics() {
  try {
    const r = await api("list");
    list = r.topics || []; usage = r.usage || null;
    renderList();
    hooks.onList(list);
  } catch (e) { $("#tp-list").innerHTML = `<div class="notice">${esc(errMsg(e))}</div>`; }
}
const ready = (t) => t.status !== "building" && !t.errors && t.usable > 0;
function renderList() {
  $("#tp-usage").textContent = usage ? `오늘 새로 만든 주제 ${usage.topics}/${usage.topicLimit}개 · 사건 후보 찾기 ${usage.ideas}/${usage.ideaLimit}번` : "";
  $("#tp-list").innerHTML = list.map((t) => {
    const tag = t.status === "building" ? `<span class="tag y">만드는 중</span>` : ready(t) ? `<span class="tag">수업에 쓸 수 있음</span>` : `<span class="tag y">검토 필요</span>`;
    const info = t.status === "building" ? "이어서 만들기" : `인물 ${t.usable}/${t.personas}명 사용 가능 · 출처 확인 ${t.verified}/${t.sources}${t.errors ? ` · 고칠 곳 ${t.errors}` : ""}`;
    return `<div class="cell cls"><div class="grow"><b>${esc(t.title)}</b> ${tag}<br><span class="meta-line">${esc(info)}${t.updatedAt ? ` · ${new Date(t.updatedAt).toLocaleString("ko-KR")}` : ""}</span></div><button class="btn btn-tinted btn-sm" data-topic="${esc(t.id)}">열기</button></div>`;
  }).join("") || `<div class="cell meta-line">아직 만든 주제가 없어요. '＋ 새 주제 만들기'로 우리 지역의 사건을 수업 주제로 만들어 보세요.</div>`;
}
function showView(v) {
  $("#tp-list-view").classList.toggle("hidden", v !== "list");
  $("#tp-wizard").classList.toggle("hidden", v !== "wizard");
  $("#tp-detail").classList.toggle("hidden", v !== "detail");
  window.scrollTo({ top: 0 });
}
async function backToList() {
  if (dirty && !(await confirmModal("저장하지 않은 고친 내용이 있어요", "목록으로 가면 고친 내용이 사라져요.", "목록으로", "머무르기", true))) return;
  cur = null; draft = null; dirty = false;
  showView("list");
  loadTopics();
}

// ---------- 1) 새 주제: 아이디어 → 후보 ----------
function openWizard() {
  ideasResult = null;
  showView("wizard");
  $("#tp-wizard").innerHTML = `<div class="card">
    <div class="row" style="justify-content:space-between"><h2 style="margin:0">새 주제 만들기</h2><button class="btn btn-plain btn-sm" data-w="back" type="button">← 내 주제</button></div>
    <p class="desc">다루고 싶은 지역이나 주제를 적으면, AI가 <b>실제로 보도된 사건</b> 후보를 찾아 드려요. 고른 사건으로 기사 조사 → 인물 9명 → 자료까지 기본 주제와 같은 방식으로 만들고, 마지막에 선생님이 출처 원문을 확인해요.</p>
    <label class="lbl" for="tp-idea">다루고 싶은 지역·주제</label><textarea id="tp-idea" rows="2" maxlength="300" placeholder="예) 거제도 지역의 문제 / 우리 동네 재개발 갈등 / 섬 지역 의료 공백">${esc(ideaInput?.idea || "")}</textarea>
    <label class="lbl" for="tp-grade">학년·과목·단원 (선택)</label><input type="text" id="tp-grade" maxlength="100" placeholder="예) 고2 통합사회, 인권 보장과 헌법" value="${esc(ideaInput?.grade || "")}" />
    <label class="lbl" for="tp-focus">수업에서 특히 다루고 싶은 것 (선택)</label><textarea id="tp-focus" rows="2" maxlength="300" placeholder="예) 일자리와 환경이 부딪히는 문제, 청소년이 직접 겪는 일">${esc(ideaInput?.focus || "")}</textarea>
    <label class="lbl" for="tp-avoid">피하고 싶은 것 (선택)</label><input type="text" id="tp-avoid" maxlength="200" placeholder="예) 정치인 개인을 둘러싼 논란" value="${esc(ideaInput?.avoid || "")}" />
    <div class="row" style="margin-top:12px"><button class="btn btn-primary" data-w="find" type="button">사건 후보 찾기</button><button class="btn btn-plain" data-w="manual" type="button">사건을 직접 적기</button></div>
    <div class="meta-line" style="margin-top:6px">${usage ? `오늘 후보 찾기 ${usage.ideas}/${usage.ideaLimit}번 · 새 주제 ${usage.topics}/${usage.topicLimit}개` : ""}</div>
  </div><div id="tp-cands"></div>`;
  $("#tp-wizard").onclick = onWizardClick;
}
const ideaFields = () => ({ idea: $("#tp-idea").value.trim(), grade: $("#tp-grade").value.trim(), focus: $("#tp-focus").value.trim(), avoid: $("#tp-avoid").value.trim() });
async function onWizardClick(e) {
  const b = e.target.closest("[data-w]"); if (!b) return;
  const w = b.dataset.w;
  if (w === "back") return backToList();
  if (w === "find") {
    ideaInput = ideaFields();
    if (ideaInput.idea.length < 2) return toast("다루고 싶은 지역이나 주제를 적어 주세요.", true);
    b.disabled = true;
    $("#tp-cands").innerHTML = `<div class="card">${waitHtml({ steps: [[0, "실제 보도된 사건을 찾는 중이에요"], [20, "기사를 읽고 후보를 고르는 중이에요"], [60, "조금 오래 걸려요. 화면을 닫지 마세요"]] })}</div>`;
    try { const r = await api("ideas", ideaInput); ideasResult = r.candidates; usage = r.usage; renderCands(); }
    catch (err) { $("#tp-cands").innerHTML = `<div class="notice">${esc(errMsg(err))}</div>`; }
    finally { b.disabled = false; }
    return;
  }
  if (w === "manual") { ideaInput = ideaFields(); return renderConfirm({ title: "", summary: "", place: "", period: "", conflict: "", stakeholders: [], requiredWho: "", now: "", links: [] }, true); }
  if (w === "pick") return renderConfirm(ideasResult[Number(b.dataset.i)], false);
  if (w === "start") return startTopic(b);
}
function renderCands() {
  $("#tp-cands").innerHTML = `<h3 style="margin:14px 4px 8px">사건 후보 (실제 보도에서 찾음)</h3>` + ideasResult.map((c, i) => `<div class="card">
    <h3 style="margin-top:0">${esc(c.title)}</h3>
    <div class="meta-line">${esc([c.place, c.period].filter(Boolean).join(" · "))}</div>
    <p>${esc(c.summary)}</p>
    ${c.conflict ? `<div class="meta-line" style="color:var(--ink)"><b>쟁점</b> ${esc(c.conflict)}</div>` : ""}
    ${(c.stakeholders || []).length ? `<div class="chipbar" style="margin:6px 0">${c.stakeholders.map((s) => `<span class="tag b">${esc(s)}</span>`).join("")}</div>` : ""}
    ${c.whyFit ? `<div class="meta-line">👍 ${esc(c.whyFit)}</div>` : ""}${c.cautions ? `<div class="meta-line">⚠ ${esc(c.cautions)}</div>` : ""}
    ${(c.links || []).length ? `<div style="margin-top:6px">${c.links.map((l) => `<div class="meta-line"><a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener noreferrer">${esc(l.title || l.url)}</a></div>`).join("")}</div>` : ""}
    <button class="btn btn-primary btn-sm" data-w="pick" data-i="${i}" type="button" style="margin-top:10px">이 사건으로 만들기</button></div>`).join("");
}
function renderConfirm(c, manual) {
  $("#tp-cands").innerHTML = `<div class="card" id="tp-confirm"><h3 style="margin-top:0">${manual ? "사건 직접 적기" : "이 사건으로 만들기"}</h3>
    <p class="desc">AI가 이 사건을 여러 각도로 다시 조사해요. ${manual ? "실제로 보도된 사건이어야 출처를 찾을 수 있어요." : ""}</p>
    <label class="lbl" for="tp-c-title">사건 이름 (기간)</label><input type="text" id="tp-c-title" maxlength="120" value="${esc(c.title)}" placeholder="예) 거제 조선소 하청 노동과 지역 경제 (2022~2025)" />
    <label class="lbl" for="tp-c-place">장소</label><input type="text" id="tp-c-place" maxlength="120" value="${esc(c.place)}" />
    <label class="lbl" for="tp-c-period">기간</label><input type="text" id="tp-c-period" maxlength="60" value="${esc(c.period)}" />
    <label class="lbl" for="tp-c-summary">무슨 일인지 (20자 이상)</label><textarea id="tp-c-summary" rows="4" maxlength="1200">${esc(c.summary)}</textarea>
    <label class="lbl" for="tp-c-conflict">쟁점 (누구와 누가 무엇으로 부딪히나)</label><textarea id="tp-c-conflict" rows="2" maxlength="400">${esc(c.conflict)}</textarea>
    <label class="lbl" for="tp-c-stake">이해관계자 (/ 로 나눠서 4개 정도)</label><input type="text" id="tp-c-stake" maxlength="300" value="${esc((c.stakeholders || []).join(" / "))}" />
    <label class="lbl" for="tp-now">인물이 학생과 대화하는 때 (대화 시점)</label><input type="text" id="tp-now" maxlength="200" value="${esc(c.now)}" placeholder="예) 2025년 3월 초, 새 대책 발표 직후" />
    <div class="meta-line">인물은 이때까지의 일만 알아요. 그 뒤의 실제 전개는 7단계 '실제로는 어떻게 되었나'에 나와요.</div>
    <label class="lbl" for="tp-req">모둠에 꼭 한 명은 있어야 할 사람</label><input type="text" id="tp-req" maxlength="120" value="${esc(c.requiredWho)}" placeholder="그 일을 가장 직접 겪는 사람들" />
    <div class="notice muted" style="margin-top:10px">실존 인물(시장·의원·단체 대표·기업인 등)은 인물로 만들지 않고 이름도 쓰지 않아요. 인물은 여러 보도를 합친 수업용 인물이에요.</div>
    <div class="row" style="margin-top:12px"><button class="btn btn-primary" data-w="start" type="button">주제 만들기 시작</button></div>
    <div class="meta-line" style="margin-top:6px">하루에 ${usage?.topicLimit ?? 3}개까지 새로 만들 수 있어요(오늘 ${usage?.topics ?? 0}개). 다 만드는 데 보통 10~20분 걸려요.</div>
    <input type="hidden" id="tp-c-links" value="${esc(JSON.stringify(c.links || []))}" /></div>`;
  $("#tp-confirm").scrollIntoView({ behavior: "smooth", block: "start" });
}
async function startTopic(b) {
  const v = (id) => $(id).value.trim();
  const candidate = { title: v("#tp-c-title"), place: v("#tp-c-place"), period: v("#tp-c-period"), summary: v("#tp-c-summary"), conflict: v("#tp-c-conflict"),
    stakeholders: v("#tp-c-stake").split("/").map((x) => x.trim()).filter(Boolean), now: v("#tp-now"), requiredWho: v("#tp-req"), links: JSON.parse($("#tp-c-links").value || "[]") };
  if (!candidate.title || candidate.summary.length < 20) return toast("사건 이름과 무슨 일인지(20자 이상)를 적어 주세요.", true);
  b.disabled = true;
  try {
    const r = await api("start", { ...(ideaInput || {}), candidate, now: candidate.now, requiredWho: candidate.requiredWho });
    usage = r.usage;
    await openTopic(r.topicId);
    runPipeline();
  } catch (e) { toast(errMsg(e), true); b.disabled = false; }
}

// ---------- 2) 만들기 진행 ----------
async function openTopic(id) {
  showView("detail");
  $("#tp-detail").innerHTML = `<div class="card">${waitHtml({ steps: [[0, "주제를 불러오는 중이에요"]] })}</div>`;
  try { setCur(await api("get", { topicId: id })); }
  catch (e) { $("#tp-detail").innerHTML = `<div class="card"><button class="btn btn-plain btn-sm" id="tp-back" type="button">← 내 주제</button><div class="notice">${esc(errMsg(e))}</div></div>`; $("#tp-back").onclick = backToList; return; }
  renderDetail();
}
function setCur(t) { cur = t; draft = structuredClone(t.file); dirty = false; }
const stepIdx = () => ORDER.indexOf(cur?.build?.step || "start");
const personasDone = () => (cur.file?.PERSONAS || []).length;
const personasTotal = () => cur.plan?.personas?.length || 9;
// 다음에 할 단계. 사건 틀을 짠 뒤에는 교사가 구성안을 보고 '인물 만들기'를 눌러야 넘어간다(planOk).
function nextAction(planOk) {
  const s = cur.build.step;
  if (s === "start") return "research";
  if (s === "research") return "frame";
  if (s === "frame") return personasDone() || planOk ? "personas" : null;
  if (s === "personas") return "extras";
  if (s === "extras") return "review";
  return null;
}
const RUN_TEXT = {
  research: [[0, "여러 각도로 기사를 찾는 중이에요(사건 흐름, 당사자 목소리, 서로 다른 주장, 숫자, 다른 지역 사례, 이후 전개)"], [60, "기사에서 사실을 한 줄씩 모으고 있어요"], [150, "출처의 매체와 날짜를 정리하는 중이에요"], [300, "조금 오래 걸려요. 화면을 닫지 마세요"]],
  frame: [[0, "사건의 틀과 인물 9명의 구성안을 짜는 중이에요"], [60, "입장이 한쪽으로 쏠리지 않게 나누고 있어요"], [180, "구성안을 점검하고 다시 다듬는 중이에요"]],
  personas: [[0, "인물을 한 명씩 만드는 중이에요(편지·삶의 이야기·생각·근거 진술)"], [90, "인물의 이야기가 근거와 맞는지 점검하는 중이에요"], [240, "조금 오래 걸려요. 화면을 닫지 마세요"]],
  extras: [[0, "2단계 자료와 4단계 사례 카드, 7단계 이후 전개를 만드는 중이에요"], [90, "근거 기사와 맞추는 중이에요"]],
  review: [[0, "AI가 인물마다 근거에 없는 사실·실존 인물 이름·비하 표현이 없는지 점검하는 중이에요"], [90, "자료와 입장 균형을 점검하는 중이에요"]],
};
async function runPipeline(planOk = false) {
  if (running) return;
  running = true;
  try {
    for (let guard = 0; guard < 20; guard++) {
      const a = nextAction(planOk);
      if (!a) break;
      renderDetail(a, Date.now());
      const r = await api(a, { topicId: cur.id });
      setCur(await api("get", { topicId: cur.id }));
      if (a === "personas" && r.made?.length) toast(`인물을 만들었어요: ${r.made.join(", ")}`);
      if (a === "frame") break; // 구성안을 교사가 먼저 본다
    }
  } catch (e) {
    toast(errMsg(e), true);
    try { setCur(await api("get", { topicId: cur.id })); } catch {}
  } finally { running = false; }
  renderDetail();
  if (cur?.build?.step === "review") loadTopics();
}

function stepsBar(runningStep) {
  const i = stepIdx();
  return `<ol class="tp-steps">${STEPS.map(([k, label], n) => {
    const done = i >= n + 1 && !(k === "frame" && runningStep === "frame") && !(k === "personas" && i === 2 && personasDone() < personasTotal());
    const on = runningStep === k;
    const extra = k === "personas" && i >= 2 ? ` (${personasDone()}/${personasTotal()})` : "";
    return `<li class="${done ? "done" : ""}${on ? " on" : ""}">${done ? "✓" : n + 1}. ${esc(label)}${extra}</li>`;
  }).join("")}</ol>`;
}

function renderDetail(runningStep, since) {
  if (!cur) return;
  const s = cur.build.step;
  const head = `<div class="card"><div class="row" style="justify-content:space-between"><button class="btn btn-plain btn-sm" id="tp-back" type="button">← 내 주제</button>
      <button class="btn btn-danger btn-sm" id="tp-del" type="button" ${running ? "disabled" : ""}>주제 삭제</button></div>
    <h2 style="margin:10px 0 4px">${esc(cur.file?.EVENT?.title || cur.title)}</h2>
    <div class="meta-line">${s === "review" ? (cur.check?.errors?.length ? "고칠 곳이 있어요" : cur.usable ? `수업에 쓸 수 있어요 · 학생에게 보이는 인물 ${cur.usable}명` : "출처 원문을 확인하면 수업에 쓸 수 있어요") : "만드는 중"} · AI 사용 ${cur.build.calls}/${cur.maxCalls}</div>
    ${stepsBar(runningStep)}
    ${runningStep ? `<div style="margin-top:10px">${waitHtml({ steps: RUN_TEXT[runningStep], since })}</div><div class="meta-line">단계마다 저장돼요. 화면을 닫았다가 다시 열면 이어서 할 수 있어요.</div>` : ""}
    ${!runningStep && cur.build.lastError && s !== "review" ? `<div class="notice yellow" style="margin-top:10px">지난번 '${esc(cur.build.lastError.step)}' 단계가 끝나지 못했어요: ${esc(cur.build.lastError.message)}</div>` : ""}
    ${!runningStep && cur.build.busy ? `<div class="notice yellow" style="margin-top:10px">다른 창에서 이 주제를 만드는 중일 수 있어요. 잠시 뒤 <button class="link" type="button" id="tp-reload">새로 고침</button>하세요.</div>` : ""}
  </div>`;
  let body = "";
  if (!runningStep) {
    if (s === "frame" && !personasDone()) body = planHtml();
    else if (s === "review") body = reviewHtml();
    else body = `<div class="card"><p class="desc">${s === "start" ? "기사 조사부터 시작해요." : "멈춘 곳부터 이어서 만들 수 있어요."}</p><button class="btn btn-primary" id="tp-go" type="button">${s === "start" ? "만들기 시작" : "이어서 만들기"}</button></div>`;
  }
  $("#tp-detail").innerHTML = head + body;
  bindDetail();
}

// ---------- 인물 구성안 ----------
function planHtml() {
  const p = cur.plan, ev = cur.file.EVENT;
  const opt = (vals, v) => vals.map((x) => `<option value="${esc(x)}" ${x === v ? "selected" : ""}>${esc(SIDE_NAME[x] || x)}</option>`).join("");
  const counts = Object.fromEntries(["A", "B", "가운데"].map((k) => [k, p.personas.filter((x) => x.side === k).length]));
  const name = (id) => p.personas.find((x) => x.id === id)?.name || id;
  return `<div class="card"><h3 style="margin-top:0">사건 틀</h3>
      <p>${esc(ev.summary)}</p>
      <div class="meta-line" style="color:var(--ink)"><b>대화 시점</b> ${esc(ev.now)}</div>
      <div class="meta-line" style="color:var(--ink)"><b>처지(축)</b> ${esc(ev.axes.join(" · "))} <span class="meta-line">· 모둠에 꼭 한 명: ${esc(ev.requiredAxis)}</span></div>
      <details style="margin-top:8px"><summary><b>모든 인물이 아는 공통 배경 ${ev.background.length}개</b> (기사 문장 그대로)</summary>${ev.background.map((c) => `<div class="meta-line" style="color:var(--ink);margin-top:4px"><span class="tag">${esc(c[2])}</span> ${esc(c[0])}</div>`).join("")}</details>
    </div>
    <div class="card"><h3 style="margin-top:0">인물 ${p.personas.length}명 구성안</h3>
      <p class="desc">인물을 만들기 전에 확인해 주세요. 입장이 한쪽으로 쏠리지 않았는지, 꼭 들어야 할 목소리가 빠지지 않았는지 보고 고칠 수 있어요. 마음에 들지 않으면 <b>다시 짜기</b>를 누르세요.</p>
      <div class="row" style="gap:8px;flex-wrap:wrap"><label class="lbl" style="margin:0">A쪽</label><input type="text" data-plan-side="A" value="${esc(p.sides.A)}" maxlength="100" style="flex:1;min-width:160px" />
        <label class="lbl" style="margin:0">B쪽</label><input type="text" data-plan-side="B" value="${esc(p.sides.B)}" maxlength="100" style="flex:1;min-width:160px" /></div>
      <div class="meta-line" style="margin:6px 0 10px">지금 분포: A쪽 ${counts.A} · 가운데 ${counts["가운데"]} · B쪽 ${counts.B}${p.balance ? ` — ${esc(p.balance)}` : ""}</div>
      ${p.personas.map((x, i) => `<div class="tp-slot" data-slot="${esc(x.id)}">
        <div class="row" style="gap:6px;flex-wrap:wrap"><b>${i + 1}.</b>
          <input type="text" data-k="name" value="${esc(x.name)}" maxlength="8" aria-label="이름" style="width:6em" />
          <select data-k="axis" aria-label="처지">${opt(ev.axes, x.axis)}</select>
          <select data-k="side" aria-label="입장 쪽">${opt(["A", "가운데", "B"], x.side)}</select>
          <span class="meta-line">${esc(x.who)}</span></div>
        <label class="lbl">역할명 (교사용)</label><input type="text" data-k="label" value="${esc(x.label)}" maxlength="120" />
        <label class="lbl">입장 (구체적인 안까지)</label><textarea data-k="stance" rows="2" maxlength="300">${esc(x.stance)}</textarea>
        <label class="lbl">학생에게 보일 한 줄 소개</label><input type="text" data-k="brief" value="${esc(x.brief)}" maxlength="60" />
        <label class="lbl">틀릴 수 있는 믿음 (없으면 비움)</label><input type="text" data-k="belief" value="${esc(x.belief)}" maxlength="300" />
      </div>`).join("")}
      <details style="margin-top:8px"><summary><b>인물끼리 스치는 장면 ${p.links.length}개</b></summary>${p.links.map((l) => `<div class="meta-line" style="color:var(--ink);margin-top:4px">· ${esc(name(l.a))} ↔ ${esc(name(l.b))}: ${esc(l.scene)}</div>`).join("")}</details>
      <div class="row" style="margin-top:14px"><button class="btn btn-primary" id="tp-make" type="button">이대로 인물 만들기</button><button class="btn btn-tinted" id="tp-plan-save" type="button">고친 구성안 저장</button><button class="btn btn-plain" id="tp-reframe" type="button">다시 짜기</button></div>
    </div>`;
}
function readPlan() {
  const p = structuredClone(cur.plan);
  document.querySelectorAll("[data-plan-side]").forEach((el) => { p.sides[el.dataset.planSide] = el.value.trim(); });
  document.querySelectorAll("[data-slot]").forEach((box) => {
    const x = p.personas.find((y) => y.id === box.dataset.slot);
    box.querySelectorAll("[data-k]").forEach((el) => { x[el.dataset.k] = el.value.trim(); });
  });
  return p;
}
const planChanged = () => JSON.stringify(readPlan()) !== JSON.stringify(cur.plan);
async function savePlan() { const t = await api("plan", { topicId: cur.id, plan: readPlan() }); setCur(t); }

// ---------- 3) 검토 ----------
const srcTag = (id) => { const s = draft.SOURCES[id]; return `<span class="tag ${s?.verified ? "" : "x"}" title="${esc(s ? `${s.outlet} ${s.date}` : "")}">${esc(id)}</span>`; };
const listArea = (path, arr, rows = 4) => `<textarea data-path="${esc(path)}" data-type="list" rows="${rows}">${esc((arr || []).join("\n"))}</textarea>`;
const textArea = (path, v, rows = 2) => `<textarea data-path="${esc(path)}" data-type="text" rows="${rows}">${esc(v || "")}</textarea>`;
const PFIELDS = [["letter", "편지 (학생이 처음 받는 글, 한 줄에 한 문단)", "list", 6], ["setting", "설정 (나이·가족·하는 일)", "text", 3], ["stance", "입장", "text", 2],
  ["voice", "말투", "text", 2], ["habits", "말버릇", "text", 2], ["inner", "마음속 고민", "text", 2], ["views", "인물의 생각 (한 줄에 하나)", "list", 5],
  ["story", "삶의 이야기 (한 줄에 하나)", "list", 6], ["episodes", "기억나는 장면 (한 줄에 하나)", "list", 5]];

function reviewHtml() {
  const f = draft, chk = cur.check || { errors: [], warnings: [] }, rv = cur.review || {};
  const srcs = Object.entries(f.SOURCES);
  const left = srcs.filter(([, s]) => !s.verified).length;
  const canClass = !chk.errors.length && cur.usable > 0 && cur.requiredOk && !dirty;
  const facts = new Map((cur.research?.facts || []).map((x) => [x.id, x]));
  const usesOf = (id) => {
    const out = [];
    f.EVENT.background.forEach((c) => c[1] === id && out.push(`공통 배경: ${c[0]}`));
    f.PERSONAS.forEach((p) => p.claims.forEach((c) => c[1] === id && out.push(`${p.name}의 근거: ${c[0]}`)));
    f.MATERIALS.forEach((m) => m.items.forEach((it) => it.src.includes(id) && out.push(`2단계 '${m.title}': ${it.text}`)));
    f.POLICY_CASES.forEach((c) => c.src.includes(id) && out.push(`4단계 사례: ${c.country} ${c.title}`));
    f.AFTERMATH.forEach((a) => a.src.includes(id) && out.push(`7단계: ${a.text}`));
    return out;
  };
  const fixesOf = (pid) => (rv.fixes || []).filter((x) => x.persona === pid);
  return `<div class="card"><h3 style="margin-top:0">검토하고 수업에 쓰기</h3>
      <div class="tp-kpis"><div><b>${cur.usable}/${f.PERSONAS.length}</b><span>학생에게 보이는 인물</span></div><div><b>${srcs.length - left}/${srcs.length}</b><span>원문 확인한 출처</span></div><div><b>${chk.errors.length}</b><span>고칠 곳</span></div><div><b>${(rv.fixes || []).length + (rv.materialFixes || []).length}</b><span>AI가 고친 곳</span></div></div>
      ${chk.errors.length ? `<div class="notice" style="margin-top:10px"><b>수업에 쓰기 전에 고칠 곳</b>${chk.errors.map((e) => `<div style="margin-top:4px">· ${esc(e.where)} — ${esc(e.msg)}</div>`).join("")}</div>` : ""}
      ${!cur.requiredOk && cur.usable ? `<div class="notice yellow" style="margin-top:10px">'${esc(f.EVENT.requiredAxis)}' 처지 인물의 출처를 확인해야 해요. 모둠마다 꼭 한 명 있어야 하는 인물이에요.</div>` : ""}
      ${rv.balance?.notes?.length ? `<div class="notice muted" style="margin-top:10px"><b>입장 균형 (AI 의견)</b>${rv.balance.notes.map((n) => `<div style="margin-top:4px">· ${esc(n)}</div>`).join("")}</div>` : ""}
      ${chk.warnings.length ? `<details style="margin-top:10px"><summary>더 다듬으면 좋은 곳 ${chk.warnings.length}개 (기본 주제와 비교)</summary>${chk.warnings.map((e) => `<div class="meta-line" style="margin-top:4px">· ${esc(e.where)} — ${esc(e.msg)}</div>`).join("")}</details>` : ""}
      <div class="row" style="margin-top:12px"><button class="btn btn-primary" id="tp-class" type="button" ${canClass ? "" : "disabled"}>이 주제로 수업 만들기</button>
        <button class="btn btn-tinted" id="tp-save" type="button" ${dirty ? "" : "disabled"}>고친 내용 저장</button></div>
      ${dirty ? `<div class="meta-line" style="margin-top:6px">고친 내용을 저장해야 수업을 만들 수 있어요.</div>` : ""}
    </div>

    <div class="card"><h3 style="margin-top:0">① 출처 원문 확인 <span class="meta-line">${srcs.length - left}/${srcs.length}</span></h3>
      <p class="desc">링크를 열어 <b>이 출처로 쓴 문장</b>이 원문과 맞는지 확인하고 체크하세요. 확인한 출처만 학생에게 보이는 인물·자료에 쓰여요(기본 주제와 같은 원칙). 틀린 문장은 아래 인물·자료에서 고치거나 빼 주세요.</p>
      ${left ? `<button class="btn btn-plain btn-sm" id="tp-verify-all" type="button">남은 ${left}개를 모두 확인함으로 표시</button>` : ""}
      ${srcs.map(([id, s]) => `<div class="tp-src"><label class="tp-check"><input type="checkbox" data-verify="${esc(id)}" ${s.verified ? "checked" : ""} /> 원문 확인 ${esc(id)}</label>
        <div class="grow"><a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a> <span class="meta-line">· ${esc(s.outlet)} · ${esc(s.date)}</span>
        <details><summary class="meta-line">이 출처로 쓴 문장 ${usesOf(id).length}개</summary>${usesOf(id).map((t) => `<div class="meta-line" style="color:var(--ink);margin-top:4px">· ${esc(t)}</div>`).join("")}
          <label class="lbl">날짜 (원문에서 확인)</label><input type="text" data-path="SOURCES.${esc(id)}.date" data-type="text" value="${esc(s.date)}" maxlength="30" /></details></div></div>`).join("")}
    </div>

    <div class="card"><h3 style="margin-top:0">② 인물 ${f.PERSONAS.length}명</h3>
      <p class="desc">학생에게는 이름·한 줄 소개·편지만 보여요. 근거 진술은 기사 문장 그대로라 고칠 수 없고, 맞지 않으면 그 출처를 확인하지 마세요(그 인물이 학생에게 나가지 않아요).</p>
      ${f.PERSONAS.map((p, i) => {
        const probs = rv.problems?.[p.id] || [], fx = fixesOf(p.id);
        const ok = p.claims.every((c) => f.SOURCES[c[1]]?.verified) && f.EVENT.background.every((c) => f.SOURCES[c[1]]?.verified);
        return `<details class="fold" data-pid="${esc(p.id)}"><summary><span><span class="tag b">${esc(p.axis)}</span> ${esc(p.name)} <span class="meta-line">· ${esc(p.label)}</span></span> <span class="tag ${ok ? "" : "y"}">${ok ? "학생에게 보임" : "출처 확인 필요"}</span></summary><div class="inner">
          ${probs.length ? `<div class="notice yellow"><b>만들 때 남은 문제</b>${probs.map((x) => `<div>· ${esc(x)}</div>`).join("")}</div>` : ""}
          ${fx.length ? `<details><summary>AI 점검이 고친 곳 ${fx.length}개</summary>${fx.map((x) => `<div class="logline"><div class="q">${esc(x.field)}${x.index !== undefined ? ` ${x.index + 1}` : ""} · ${esc(x.problem)} ${x.reason ? `<span class="meta-line">${esc(x.reason)}</span>` : ""}</div><div class="a"><s>${esc(x.before)}</s><br>${esc(x.after)}</div></div>`).join("")}</details>` : ""}
          <label class="lbl">학생에게 보일 한 줄 소개</label><input type="text" data-path="BRIEFS.${esc(p.id)}" data-type="text" value="${esc(f.BRIEFS[p.id] || "")}" maxlength="60" />
          <label class="lbl">역할명 (교사용)</label><input type="text" data-path="PERSONAS.${i}.label" data-type="text" value="${esc(p.label)}" maxlength="120" />
          ${PFIELDS.map(([k, label, type, rows]) => `<label class="lbl">${label}</label>${type === "list" ? listArea(`PERSONAS.${i}.${k}`, p[k], rows) : textArea(`PERSONAS.${i}.${k}`, p[k], rows)}`).join("")}
          ${(p.beliefs || []).length ? `<div class="notice yellow" style="margin-top:10px"><b>틀릴 수 있는 믿음</b>${p.beliefs.map((b) => `<div style="margin-top:4px">· ${esc(b[0])}<div class="meta-line">실제: ${esc(b[1])}</div></div>`).join("")}</div>` : ""}
          <div style="margin-top:10px"><b>근거 진술 (기사 문장 그대로)</b>${p.claims.map((c) => `<div class="meta-line" style="color:var(--ink);margin-top:4px"><span class="tag ${c[2] === "주장" || c[2] === "의견" ? "y" : ""}">${esc(c[2])}</span> ${esc(c[0])} ${srcTag(c[1])}</div>`).join("")}</div>
          <div class="meta-line" style="margin-top:6px">융합 근거: ${esc(p.basis)}</div>
          <div class="row" style="margin-top:12px;gap:6px;flex-wrap:wrap"><input type="text" data-regen-note="${esc(p.id)}" maxlength="400" placeholder="다시 만들 때 바랄 점 (예: 반대 이유를 더 분명하게)" style="flex:1;min-width:200px" />
            <button class="btn btn-plain btn-sm" data-regen="${esc(p.id)}" type="button">이 인물 다시 만들기</button></div>
        </div></details>`;
      }).join("")}
    </div>

    <div class="card"><h3 style="margin-top:0">③ 사건과 화면 문구</h3>
      <label class="lbl">사건 이름</label><input type="text" data-path="EVENT.title" data-type="text" value="${esc(f.EVENT.title)}" maxlength="80" />
      <label class="lbl">사건 개요</label>${textArea("EVENT.summary", f.EVENT.summary, 5)}
      <label class="lbl">교사용 메모</label>${textArea("EVENT.teacherNote", f.EVENT.teacherNote, 4)}
      <label class="lbl">대화 시점</label>${textArea("EVENT.now", f.EVENT.now, 2)}
      <details style="margin-top:8px"><summary><b>공통 배경 ${f.EVENT.background.length}개</b> (기사 문장 그대로)</summary>${f.EVENT.background.map((c) => `<div class="meta-line" style="color:var(--ink);margin-top:4px"><span class="tag">${esc(c[2])}</span> ${esc(c[0])} ${srcTag(c[1])}</div>`).join("")}</details>
      <details style="margin-top:8px"><summary><b>학생 화면의 예시 문구</b></summary>
        ${Object.entries(f.EVENT.ui).filter(([k]) => k !== "sceneHints" && k !== "requiredTag").map(([k, v]) => `<label class="lbl">${esc(UI_LABEL[k] || k)}</label><input type="text" data-path="EVENT.ui.${esc(k)}" data-type="text" value="${esc(v)}" maxlength="200" />`).join("")}
        <label class="lbl">2단계 '내 생활의 비슷한 장면' 예시 3개 (한 줄에 하나)</label>${listArea("EVENT.ui.sceneHints", f.EVENT.ui.sceneHints, 3)}</details>
    </div>

    <div class="card"><h3 style="margin-top:0">④ 2단계 실제 사건 자료</h3>
      <p class="desc">문장을 고치거나 빼세요. 수업을 만든 뒤에는 수업마다 '자료 관리'에서도 고칠 수 있어요.</p>
      ${f.MATERIALS.map((m, mi) => `<details class="fold"><summary>${esc(m.title)} <span class="meta-line">· ${m.items.length}개${m.stats ? ` · 숫자 카드 ${m.stats.length}개` : ""}</span></summary><div class="inner">
        ${(m.stats || []).map((s) => `<span class="tag b">${esc(s.label)} ${esc(s.value)}</span> `).join("")}
        ${m.items.map((it, ii) => `<div class="logline"><div class="row" style="gap:6px"><span class="kind k-${esc(it.kind)}">${esc(it.kind)}</span>${it.date ? `<b>${esc(it.date)}</b>` : ""}<span class="grow"></span>${it.src.map(srcTag).join(" ")}<button class="btn btn-plain btn-sm" data-drop="MATERIALS.${mi}.items.${ii}" type="button">빼기</button></div>
          ${textArea(`MATERIALS.${mi}.items.${ii}.text`, it.text, 2)}${(it.facts || []).length ? `<div class="meta-line">근거: ${esc(it.facts.map((id) => facts.get(id)?.text).filter(Boolean).join(" / "))}</div>` : ""}</div>`).join("")}</div></details>`).join("")}
    </div>

    <div class="card"><h3 style="margin-top:0">⑤ 4단계 다른 곳의 사례 · 7단계 이후 전개</h3>
      ${f.POLICY_CASES.map((c, ci) => `<details class="fold"><summary>${esc(c.country)} <span class="meta-line">· ${esc(c.title)}</span></summary><div class="inner">
        <label class="lbl">무엇을 했나</label>${textArea(`POLICY_CASES.${ci}.what`, c.what, 3)}<label class="lbl">어떻게 되었나</label>${textArea(`POLICY_CASES.${ci}.result`, c.result, 3)}
        <label class="lbl">생각해 볼 점</label>${textArea(`POLICY_CASES.${ci}.think`, c.think, 2)}<div class="row" style="margin-top:6px">${c.src.map(srcTag).join(" ")}<button class="btn btn-plain btn-sm" data-drop="POLICY_CASES.${ci}" type="button">이 사례 빼기</button></div></div></details>`).join("") || `<div class="meta-line">사례 카드가 없어요.</div>`}
      <h4>이후 전개 (${esc(f.EVENT.ui.afterSince || "대화 시점")} 뒤)</h4>
      ${f.AFTERMATH.map((a, ai) => `<div class="logline"><div class="row" style="gap:6px"><span class="kind k-${esc(a.kind)}">${esc(a.kind)}</span><span class="grow"></span>${a.src.map(srcTag).join(" ")}<button class="btn btn-plain btn-sm" data-drop="AFTERMATH.${ai}" type="button">빼기</button></div>${textArea(`AFTERMATH.${ai}.text`, a.text, 2)}</div>`).join("") || `<div class="meta-line">아직 보도된 이후 전개가 없어요(진행 중인 사건).</div>`}
    </div>`;
}
const UI_LABEL = {
  letterSign: "편지 끝 서명", causeExample: "2단계 원인 추측 예시", badQuestion: "3단계 나쁜 검증 질문 예", goodQuestion: "3단계 좋은 검증 질문 예", checkQuestion: "3단계 확인 질문 예",
  heardExample: "들은 말 예시", broadProblem: "너무 넓은 문제 예", decidedProblem: "결론을 정해 버린 문제 예", pickLead: "인물 고르기 안내", requiredWho: "꼭 있어야 할 인물 설명",
  casesKinds: "4단계 사례 종류", compareWith: "비교할 곳 이름", afterSince: "대화 시점(짧게)", afterExample: "7단계 예상·실제 비교 예", priorQuestion: "1단계 처음 생각 질문", priorHint: "처음 생각 답 예시",
};

// 경로(예: PERSONAS.3.letter)로 draft 값을 읽고 바꾼다
const getPath = (o, path) => path.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
function setPath(o, path, v) { const ks = path.split("."); const last = ks.pop(); const t = ks.reduce((x, k) => x[k], o); t[last] = v; }
function markDirty() {
  if (dirty) return;
  dirty = true;
  const s = $("#tp-save"); if (s) s.disabled = false;
  const c = $("#tp-class"); if (c) c.disabled = true;
}

function bindDetail() {
  $("#tp-back").onclick = backToList;
  const del = $("#tp-del");
  if (del) del.onclick = async () => {
    if (!(await confirmModal(`'${esc(cur.title)}' 주제를 삭제할까요?`, "조사 결과와 인물이 모두 지워지고 되돌릴 수 없어요. 이 주제로 이미 만든 수업은 그대로 쓸 수 있어요.", "삭제", "취소", true))) return;
    try { await api("delete", { topicId: cur.id }); toast("주제를 삭제했어요"); dirty = false; backToList(); } catch (e) { toast(errMsg(e), true); }
  };
  const rl = $("#tp-reload"); if (rl) rl.onclick = () => openTopic(cur.id);
  const go = $("#tp-go"); if (go) go.onclick = () => runPipeline();
  const make = $("#tp-make");
  if (make) make.onclick = async () => {
    try { if (planChanged()) await savePlan(); } catch (e) { return toast(errMsg(e), true); }
    runPipeline(true);
  };
  const ps = $("#tp-plan-save");
  if (ps) ps.onclick = async () => { try { await savePlan(); toast("구성안을 저장했어요"); renderDetail(); } catch (e) { toast(errMsg(e), true); } };
  const rf = $("#tp-reframe");
  if (rf) rf.onclick = async () => {
    if (!(await confirmModal("사건 틀과 구성안을 다시 짤까요?", "조사한 기사로 처음부터 다시 짜요. 지금 구성안과 고친 내용은 사라져요.", "다시 짜기", "취소"))) return;
    running = true;
    try { renderDetail("frame", Date.now()); await api("frame", { topicId: cur.id }); setCur(await api("get", { topicId: cur.id })); }
    catch (e) { toast(errMsg(e), true); }
    finally { running = false; }
    renderDetail();
  };
  const box = $("#tp-detail");
  box.oninput = (e) => {
    const el = e.target.closest("[data-path]"); if (!el) return;
    setPath(draft, el.dataset.path, el.dataset.type === "list" ? el.value.split("\n").map((x) => x.trim()).filter(Boolean) : el.value);
    markDirty();
  };
  box.onchange = async (e) => {
    const v = e.target.closest("[data-verify]"); if (!v) return;
    v.disabled = true;
    try { applyVerify(await api("verifySource", { topicId: cur.id, sourceIds: [v.dataset.verify], verified: v.checked })); }
    catch (err) { v.checked = !v.checked; toast(errMsg(err), true); }
    finally { v.disabled = false; }
  };
  box.onclick = async (e) => {
    const d = e.target.closest("[data-drop]");
    if (d) {
      const ks = d.dataset.drop.split("."), i = Number(ks.pop()), arr = getPath(draft, ks.join("."));
      arr.splice(i, 1);
      if (ks[0] === "MATERIALS") draft.MATERIALS = draft.MATERIALS.filter((m) => m.items.length || m.stats);
      markDirty(); keepOpen(() => renderDetail());
      return;
    }
    const r = e.target.closest("[data-regen]");
    if (r) return regen(r.dataset.regen);
    if (e.target.closest("#tp-save")) return saveDraft();
    if (e.target.closest("#tp-class")) return hooks.onMakeClass(cur);
    if (e.target.closest("#tp-verify-all")) return verifyAll();
  };
}
// 다시 그려도 펼쳐 둔 칸과 스크롤은 그대로
function keepOpen(fn) {
  const open = [...document.querySelectorAll("#tp-detail details[open]")].map((d) => [...document.querySelectorAll("#tp-detail details")].indexOf(d));
  const y = window.scrollY;
  fn();
  const all = [...document.querySelectorAll("#tp-detail details")];
  open.forEach((i) => all[i]?.setAttribute("open", ""));
  window.scrollTo({ top: y });
}
function applyVerify(r) {
  r.sourceIds.forEach((id) => { cur.file.SOURCES[id].verified = r.verified; draft.SOURCES[id].verified = r.verified; });
  Object.assign(cur, { usable: r.usable, requiredOk: r.requiredOk, check: r.check || cur.check });
  keepOpen(() => renderDetail());
}
async function verifyAll() {
  const ids = Object.entries(draft.SOURCES).filter(([, s]) => !s.verified).map(([id]) => id);
  const ok = await confirmModal(`출처 ${ids.length}개를 모두 확인함으로 표시할까요?`,
    "확인함으로 표시한 출처의 문장은 학생에게 사실로 보여요. 원문을 열어 문장과 맞는지 확인한 뒤에 표시해 주세요. 확인하지 못한 출처가 있으면 하나씩 체크하세요.", "모두 확인함", "취소");
  if (!ok) return;
  try { applyVerify(await api("verifySource", { topicId: cur.id, sourceIds: ids, verified: true })); toast("확인함으로 표시했어요"); } catch (e) { toast(errMsg(e), true); }
}
async function saveDraft() {
  const b = $("#tp-save"); if (b) b.disabled = true;
  try { setCur(await api("save", { topicId: cur.id, file: draft })); toast("저장했어요"); keepOpen(() => renderDetail()); loadTopics(); }
  catch (e) { toast(errMsg(e), true); if (b) b.disabled = false; }
}
async function regen(pid) {
  if (dirty && !(await confirmModal("저장하지 않은 고친 내용이 있어요", "다시 만들기 전에 고친 내용을 먼저 저장할까요?", "저장하고 다시 만들기", "취소"))) return;
  if (dirty) { try { setCur(await api("save", { topicId: cur.id, file: draft })); } catch (e) { return toast(errMsg(e), true); } }
  const p = cur.file.PERSONAS.find((x) => x.id === pid);
  const note = document.querySelector(`[data-regen-note="${pid}"]`)?.value.trim() || "";
  if (!(await confirmModal(`${esc(p.name)} 인물을 다시 만들까요?`, `편지·이야기·생각을 새로 써요. 이 인물에 직접 고친 내용은 사라져요.${note ? `<br>바랄 점: ${esc(note)}` : ""}`, "다시 만들기", "취소"))) return;
  running = true;
  const box = document.querySelector(`#tp-detail details[data-pid="${pid}"] .inner`);
  if (box) box.insertAdjacentHTML("afterbegin", `<div id="tp-regen-wait">${waitHtml({ steps: RUN_TEXT.personas })}</div>`);
  try { const r = await api("regenPersona", { topicId: cur.id, personaId: pid, note }); setCur(await api("get", { topicId: cur.id })); toast(`${r.persona} 인물을 다시 만들었어요`); }
  catch (e) { toast(errMsg(e), true); $("#tp-regen-wait")?.remove(); }
  finally { running = false; }
  keepOpen(() => renderDetail());
}

// 수업 화면에서 '이 주제로 수업 만들기'를 눌렀을 때 쓸 이름
export const topicClassTitle = (t) => `${(t.file?.EVENT?.title || t.title).replace(/\s*\([^)]*\)\s*$/, "")}, 갈등 해결 방안 제안하기`;
export { ready as topicReady };
