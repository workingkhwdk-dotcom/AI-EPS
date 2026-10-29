// 교사 화면 '평가' 탭. 처음 쓰는 선생님도 위에서부터 따라가면 끝나도록 네 단계로 나눈다.
//   ① 채점(AI가 먼저 채점, 모둠·학생별로 보고 고치기) → ② 확인(선생님 판단이 필요한 것만) → ③ 세특 쓰기 → ④ 학생에게 공개
// 단계 막대가 곧 메뉴이고, 아직 안 끝난 첫 단계를 '지금'으로 짚는다. 가끔 쓰는 척도표·채점 점검·채점 방식은 오른쪽 위 도구로 뺐다.
// 서버(functions/assess.js, index.js 의 assess·assessAi)가 규칙을 지킨다. 이 화면은 그 규칙이 눈에 보이게 하는 역할이다.
//  - 근거 보기: 항목마다 학생이 쓴 글을 그대로 보여 준다. 글이 없으면 '미제출'만 고를 수 있다.
//  - 독립 채점('내가 먼저 채점'): AI 의견은 내가 그 항목의 수준을 저장한 뒤에만 보인다.
//  - 이름 가리기: 학생을 별명 대신 코드(S-1A2B)로, 모둠과 상관없는 순서로 보여 준다.
// 화면 글은 선생님이 쓰는 말로 쓴다. 서버·README 의 용어와는 이렇게 대응한다:
//   칸 → 항목, 예외(큐) → 직접 정할 점수(② 확인), 확정 후보 → AI가 정한 점수(확정 전), 예외만 검토 → '애매한 것만 확인',
//   교정 → AI를 내 기준에 맞춰 보기, 감사 정지 → AI 자동 확정 멈춤, 제2평정 → AI 의견, 이의 제기 → 이의 신청, 신뢰도 점검 → 채점 점검
import { call, esc, toast, errMsg } from "./fb.js";
import { waitHtml, STEPS } from "./wait.js";
import { confirmModal, showModal } from "./modal.js";

const $ = (s) => document.querySelector(s);
const root = () => $("#as-root");
const st = { code: null, data: null, view: null, kind: "group", id: null, sub: null, blind: true, sk: {}, emphasis: "balance", recheck: null, rel: null, busy: false, batch: null, queue: null };

// 서버(functions/seteuk.js)와 같은 NEIS 바이트: 한글 3, 그 밖 1
export const byteLen = (str) => { let n = 0; for (let i = 0; i < String(str ?? "").length; i++) { const c = String(str).charCodeAt(i); n += (c >= 0xac00 && c <= 0xd7a3) || (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f) ? 3 : 1; } return n; };
const crit = (cid) => st.data.rubric.criteria.find((c) => c.id === cid);
const critsOf = (kind) => st.data.rubric.criteria.filter((c) => c.scope === (kind === "student" ? "student" : "group"));
const lvlLabel = (c, level) => (level === -1 ? "미제출" : c.levels[level]?.label || "");
const ptsOf = (c, level) => (level === -1 ? 0 : c.levels[level]?.pts ?? 0);
const subjList = () => (st.kind === "group" ? st.data.groups : st.data.students);
const subjId = (x) => (st.kind === "group" ? x.id : x.key);
const stuName = (x) => `${x.groupId.slice(1)}모둠 ${x.nick}`;
const subjName = (x) => (st.kind === "group" ? x.name : st.blind ? x.code : stuName(x));
const busy = (html) => `<div class="card">${html || waitHtml({ steps: STEPS.load })}</div>`;

// ---------- 단계(메뉴) ----------
const STEP_VIEWS = ["score", "queue", "seteuk", "release"];
const TOOLS = [["rubric", "척도표"], ["reli", "채점 점검"], ["settings", "채점 방식"]];
// 채점 방식 셋: auto(애매한 것만 확인, 기본) · manual(AI 점수를 하나씩 확인) · independent(내가 먼저 채점)
const howOf = (d) => (d.auto?.on ? "auto" : d.mode === "independent" ? "independent" : "manual");
const aiStarted = (d) => d.groups.some((g) => g.ai) || d.students.some((x) => x.ai);
// 채점 진행: 학생이 없는 모둠(만들었지만 안 쓴 모둠)은 빼고 센다. 그래야 다 하면 '끝났어요'가 된다.
function liveProgress(d) {
  const subs = [...d.groups.filter((g) => g.members > 0), ...d.students];
  return { done: subs.reduce((n, x) => n + x.scored, 0), total: subs.reduce((n, x) => n + x.total, 0) };
}
function aiLeftOf(d) { // AI 채점이 남은 모둠·학생 수(학생이 없는 모둠은 뺀다)
  const g = d.groups.filter((x) => x.members > 0 && x.ai < d.aiTotal.group).length, s = d.students.filter((x) => x.ai < d.aiTotal.student).length;
  return { g, s, n: g + s };
}
// 단계마다 이름·끝났는지·한 줄 상태
function stepsOf(d) {
  const p = { ...d.progress, ...liveProgress(d) }, q = d.queue || {}, how = howOf(d), left = aiLeftOf(d);
  const anyone = d.students.length > 0;
  const s1 = how === "independent"
    ? { name: "채점", done: anyone && p.done >= p.total, sub: anyone ? `${p.done} / ${p.total}항목` : "학생이 없어요" }
    : { name: "AI 채점", done: anyone && left.n === 0, sub: !anyone ? "학생이 없어요" : !left.n ? "끝났어요" : aiStarted(d) ? `${left.n}곳 남음` : "아직 안 했어요" };
  let n2, sub2;
  if (how === "auto") {
    const fix = q.exceptions + q.appeals;
    n2 = fix + q.observation + p.unreviewed;
    sub2 = fix ? `직접 정할 것 ${fix}개` : q.observation ? `협력 점수 ${q.observation}명` : p.unreviewed ? `확정할 점수 ${p.unreviewed}개` : "끝났어요";
  } else {
    n2 = q.appeals + (how === "manual" ? p.unreviewed + (p.total - p.done) : 0);
    sub2 = n2 ? `확인할 것 ${n2}개` : "끝났어요";
  }
  const s2 = { name: "확인", done: s1.done && !n2, sub: s1.done ? sub2 : "① 다음에" };
  const nSk = d.students.filter((x) => x.hasSeteuk).length;
  const s3 = { name: "세특 쓰기", done: anyone && nSk === d.students.length, sub: `${nSk} / ${d.students.length}명` };
  const r = d.release;
  const s4 = { name: "학생에게 공개", done: r.score && r.seteuk, sub: r.score && r.seteuk ? "모두 공개 중" : r.score ? "점수만 공개 중" : r.seteuk ? "세특만 공개 중" : "아직 비공개" };
  return [s1, s2, s3, s4];
}
const nowStep = (d) => { const S = stepsOf(d), i = S.findIndex((s) => !s.done); return i < 0 ? 3 : i; };
function stepsNav(d) {
  const S = stepsOf(d), now = nowStep(d);
  return `<nav class="as-stepnav" id="as-views" aria-label="평가 순서">${S.map((s, i) => {
    const v = STEP_VIEWS[i], on = st.view === v;
    return `<button type="button" data-asv="${v}" class="as-step ${on ? "on" : ""} ${s.done ? "done" : i === now ? "now" : ""}" ${on ? 'aria-current="step"' : ""}><b>${s.done ? "✓" : i + 1}</b><span class="nm">${s.name}${i === now && !s.done ? ' <i class="as-now">지금</i>' : ""}</span><span class="sb">${esc(s.sub)}</span></button>`;
  }).join("")}</nav>`;
}
// 다음 단계로 가는 단추(빈 화면·끝난 화면에서 '이제 뭐 하지?'를 없앤다)
const goBtn = (v, label, kind = "btn-primary") => `<button class="btn ${kind} btn-sm" type="button" data-asv="${v}">${label}</button>`;

export async function openAssess(code) {
  if (st.code !== code) Object.assign(st, { code, data: null, view: null, kind: "group", id: null, sub: null, sk: {}, recheck: null, rel: null, queue: null });
  if (!st.data) root().innerHTML = busy();
  try { await refresh(); } catch (e) { root().innerHTML = `<div class="notice">${esc(errMsg(e))}</div>`; return; }
  if (!st.view) st.view = STEP_VIEWS[nowStep(st.data)]; // 처음 열면 '지금' 단계로
  await goView(st.view);
}

async function refresh() {
  st.data = (await call("assess")({ code: st.code, action: "get" })).data;
}
async function loadSubject() {
  st.sub = null; render();
  try { st.sub = (await call("assess")({ code: st.code, action: "subject", kind: st.kind, id: st.id })).data; }
  catch (e) { toast(errMsg(e), true); }
}
// 화면 바꾸기: 채점·세특은 고를 대상을 맞추고, 확인·점검은 늘 새로 불러온다
async function goView(v) {
  st.view = v;
  if (v === "reli") { st.rel = null; st.recheck = null; }
  if (v === "queue") st.queue = null;
  if (v === "seteuk" && st.kind !== "student") { st.kind = "student"; st.id = null; }
  // AI 채점 전에는 채점 화면에서 첫 모둠을 저절로 열지 않는다(할 일 하나만 보이게). 고르면 연다.
  const auto1 = v === "seteuk" || howOf(st.data) === "independent" || aiStarted(st.data);
  if ((v === "score" || v === "seteuk") && !subjList().some((x) => subjId(x) === st.id)) { const f = auto1 ? subjList()[0] : null; st.id = f ? subjId(f) : null; st.sub = null; }
  render();
  if ((v === "score" || v === "seteuk") && st.id && (!st.sub || st.sub.kind !== st.kind || st.sub.id !== st.id)) { await loadSubject(); render(); }
}
// 목록에서 대상 하나를 바로 연다(② 확인·교정 안내에서 '채점하러 가기')
async function openSubject(kind, id) {
  st.view = "score"; st.kind = kind; st.id = id;
  await loadSubject(); render();
  root().querySelector(".as-sub")?.scrollIntoView({ block: "start", behavior: "smooth" });
}

// ---------- 그리기 ----------
const VIEWS = { score: () => scoreHtml(), queue: () => queueHtml(), seteuk: () => seteukHtml(), release: () => releaseHtml(), rubric: () => rubricHtml(), reli: () => reliHtml(), settings: () => settingsHtml() };
function render() {
  if (!st.data) return;
  const d = st.data, p = liveProgress(d);
  root().innerHTML = `
    <div class="card as-head">
      <div class="as-head-top"><div><h3 style="margin:0">수행평가</h3>
        <div class="meta-line">${d.rubric.level === "middle" ? "중학교" : "고등학교"} 척도표 · ${d.rubric.total}점 만점(개인 ${d.rubric.indivMax} + 모둠 ${d.rubric.total - d.rubric.indivMax}) · 채점 ${p.done} / ${p.total}항목</div></div>
        <div class="as-tools">${TOOLS.map(([k, n]) => `<button type="button" class="link ${st.view === k ? "on" : ""}" data-asv="${k}">${n}</button>`).join("")}</div></div>
      ${stepsNav(d)}
    </div>
    <div id="as-body">${(VIEWS[st.view] || VIEWS.score)()}</div>`;
  if (st.view === "reli" && !st.rel) loadReli();
  if (st.view === "queue" && !st.queue) loadQueue();
}

// ---------- ① 채점 ----------
function scoreHtml() { return runHtml() + browserHtml(); }
// AI 채점 카드: 지금 방식에 맞는 한 줄 안내와 단추 하나. 확정과 공개는 늘 선생님이 직접 누른다.
function runHtml() {
  const d = st.data, b = st.batch, how = howOf(d), left = aiLeftOf(d), started = aiStarted(d), S = stepsOf(d);
  if (b && b.running) return `<div class="card as-batch"><div class="as-prog" role="status"><div><b>AI가 채점하는 중</b> ${b.done} / ${b.total} · ${esc(b.label)}</div><div class="as-bar"><i style="width:${Math.round((b.done / b.total) * 100)}%"></i></div></div>
    <div class="row" style="margin-top:8px"><button class="btn btn-plain btn-sm" data-asbatch type="button">${b.stop ? "멈추는 중…" : "멈추기"}</button><span class="meta-line">이 창을 닫으면 멈춰요. 멈춘 곳부터 다시 할 수 있어요.</span></div></div>`;
  const indep = how === "independent";
  const title = indep ? "선생님이 먼저 채점해요" : "AI가 먼저 채점해요";
  const desc = how === "auto" ? "학생이 쓴 글을 AI가 척도표에 맞춰 세 번씩 채점해요. 세 번 결과가 같고 근거가 분명한 점수는 정해 두고, 애매한 것만 <b>② 확인</b>으로 보내요."
    : how === "manual" ? "AI가 먼저 채점해 수준을 골라 둬요. 아래에서 모둠·학생을 하나씩 열어 맞으면 <b>✓ 확인</b>, 다르면 고쳐서 저장해요."
    : "아래에서 모둠·학생을 골라 먼저 채점해요. AI 의견은 미리 준비해 두고, 선생님이 저장한 항목만 보여 줘요.";
  const runLabel = `✨ ${indep ? "AI 의견 준비" : started ? "남은 곳 AI 채점" : "AI 채점 시작"} (모둠 ${left.g} · 학생 ${left.s}명)`;
  const done = d.students.length > 0 && !left.n;
  const notes = [
    how === "auto" && d.autoPaused ? pausedHtml() : "",
    how === "auto" && d.calib?.state === "collecting" ? `<div class="notice muted" style="margin:10px 0 0">🎯 <b>AI를 내 기준에 맞춰 보는 중</b>이에요. 아래 목록에서 🎯 표시된 학생·모둠을 AI 점수 없이 채점해 주세요. 다 채점하면 결과가 저절로 나와요.</div>` : "",
  ].join("");
  return `<div class="card as-batch"><h4 style="margin:0 0 4px">${title}</h4><div class="meta-line">${desc}</div>${notes}
    ${done
      ? `<div class="notice green" style="margin:10px 0 0">✓ ${indep ? "AI 의견을 준비해 뒀어요." : "AI 채점을 마쳤어요."}</div>
        <div class="row" style="margin-top:10px">${!indep && !S[1].done ? goBtn("queue", "② 확인하러 가기 →") : ""}<button class="btn btn-plain btn-sm" data-asbatch type="button">처음부터 다시 채점</button></div>`
      : `<div class="row" style="margin-top:10px"><button class="btn btn-primary" data-asbatch type="button" ${d.students.length ? "" : "disabled"}>${d.students.length ? runLabel : "아직 들어온 학생이 없어요"}</button></div>`}</div>`;
}
const pausedHtml = () => `<div class="notice yellow" style="margin:10px 0 0">선생님이 다시 채점해 본 점수와 AI가 자주 달라서(${st.data.audit.n}개 중 ${st.data.audit.exact}% 일치) <b>AI 자동 확정을 멈췄어요</b>. 지금은 모든 점수가 ② 확인으로 가요. <button class="link" type="button" data-asresume>다시 켜기</button></div>`;

function browserHtml() {
  const d = st.data;
  const head = `<div class="card">${pickerHtml()}${st.id ? "" : `<div class="meta-line" style="margin-top:8px">${aiStarted(d) || howOf(d) === "independent" ? "모둠이나 학생을 누르면 항목별 점수와 학생이 쓴 글이 열려요." : "AI 채점이 끝나면 여기서 모둠·학생별 점수를 보고 고칠 수 있어요. 지금 눌러서 미리 볼 수도 있어요."}</div>`}</div>`;
  if (!st.id) return head;
  if (!st.sub) return head + busy();
  const s = st.sub, cs = critsOf(st.kind);
  const gotAi = cs.some((c) => c.ai && s.hasAi[c.id]);
  const calibNote = s.calibSample ? `<div class="notice muted" style="margin:8px 0 0">🎯 AI를 내 기준에 맞춰 보는 샘플이에요. AI 점수를 가린 채 평소처럼 채점해 주세요.</div>` : "";
  const total = cs.reduce((n, c) => n + (s.scores[c.id] ? s.scores[c.id].pts : 0), 0), maxT = cs.reduce((n, c) => n + c.max, 0), done = cs.filter((c) => s.scores[c.id]).length;
  return head + `<div class="card as-sub">
    <div class="row" style="justify-content:space-between"><div><h3 style="margin:0">${esc(subjLabel())}</h3><div class="meta-line">채점 ${done} / ${cs.length}항목 · 지금까지 ${total} / ${maxT}점</div></div>
      <div class="row"><button class="btn btn-tinted btn-sm" data-asai type="button" ${st.busy ? "disabled" : ""}>${gotAi ? "AI 다시 채점" : "AI 채점"}</button>
        ${d.mode === "ai_first" && !d.auto?.on && cs.some((c) => c.ai && s.ai[c.id] && !s.scores[c.id]) ? `<button class="btn btn-primary btn-sm" data-asapply type="button" ${st.busy ? "disabled" : ""}>AI 점수 모두 적용</button>` : ""}</div></div>
    ${calibNote}<div class="meta-line" style="margin:6px 0 2px">${s.mode === "ai_first" ? "AI가 고른 수준이 미리 표시돼 있어요. 학생 글을 보고 맞으면 <b>✓ 확인·저장</b>, 다르면 고쳐서 저장해요." : "AI 의견은 선생님이 수준을 <b>저장한 뒤에만</b> 보여요(먼저 보면 AI 판단에 끌리기 쉬워요)."}</div></div>`
    + cs.map((c) => criterionHtml(c, s)).join("");
}
function pickerHtml() {
  const list = subjList(), how = howOf(st.data);
  const sorted = st.kind === "student" && st.blind ? [...list].sort((a, b) => a.code.localeCompare(b.code)) : list;
  const flags = (x) => `${x.exc ? ` <span class="tag y">확인 ${x.exc}</span>` : ""}${how === "manual" && x.unreviewed ? ` <span class="tag b">확인 전 ${x.unreviewed}</span>` : ""}`;
  return `<div class="row" style="justify-content:space-between;margin-bottom:8px"><h4 style="margin:0">모둠·학생별 점수</h4>
      ${st.kind === "student" ? `<label class="chk" title="별명 대신 코드로, 모둠과 상관없는 순서로 보여 줘요(먼저 본 학생에게 끌리지 않게)"><input type="checkbox" id="as-blind" ${st.blind ? "checked" : ""}> 이름 가리고 채점</label>` : ""}</div>
    <div class="seg" style="margin-bottom:8px"><button data-ask="group" class="${st.kind === "group" ? "on" : ""}">모둠별 (${st.data.groups[0]?.total || 0}항목)</button><button data-ask="student" class="${st.kind === "student" ? "on" : ""}">학생별 (${st.data.students[0]?.total || 0}항목)</button></div>
    <div class="chipbar as-pick">${sorted.map((x) => `<button class="chip sm ${subjId(x) === st.id ? "on" : ""}" data-asid="${esc(subjId(x))}">${x.calibSample ? "🎯 " : ""}${esc(subjName(x))}${flags(x)} <span class="as-n">${x.scored}/${x.total}</span></button>`).join("") || `<span class="meta-line">아직 대상이 없어요.</span>`}</div>`;
}
function subjLabel() {
  const x = subjList().find((y) => subjId(y) === st.id);
  return x ? subjName(x) : "";
}

function criterionHtml(c, s) {
  const sc = s.scores[c.id], ai = s.ai[c.id], ev = s.evidence[c.id] || [], empty = s.empty[c.id], rv = s.review[c.id];
  // AI가 먼저 채점하는 방식에서는 아직 채점하지 않은 항목에 AI 수준을 미리 골라 둔다(선생님이 학생 글을 보고 확인하거나 고친다)
  const pre = !sc && s.mode === "ai_first" && ai && Number.isInteger(ai.level) ? ai.level : null;
  const cur = sc ? sc.level : pre;
  const unrev = sc && sc.src === "ai" && sc.reviewed === false;
  const lv = (idx, label, pts, desc, dis) => `<label class="lvopt ${cur === idx ? "cur" : ""}"><input type="radio" name="lv-${c.id}" value="${idx}" ${cur === idx ? "checked" : ""} ${dis ? "disabled" : ""}>
      <span class="lvh"><b>${esc(label)}</b> <span class="tag b">${pts}점</span></span><span class="lvd">${esc(desc)}</span></label>`;
  const state = sc ? `<span class="tag ${unrev ? "y" : ""}">${esc(lvlLabel(c, sc.level))} ${sc.pts}점 · ${unrev ? "AI 점수 · 확정 전" : sc.src === "ai" ? "AI 점수 확정" : sc.src === "edited" ? "선생님이 고침" : "선생님 채점"}</span>`
    : pre !== null ? `<span class="tag b">AI ${esc(lvlLabel(c, pre))} ${ptsOf(c, pre)}점 · 확인 전</span>` : `<span class="tag y">채점 전</span>`;
  return `<div class="card as-crit" data-cid="${c.id}">
    <div class="row" style="justify-content:space-between"><h4 style="margin:0">${esc(c.elName)} › ${esc(c.name)} <span class="tag x">${c.max}점</span> <span class="tag x">${esc(c.stage)}</span></h4>${state}</div>
    ${c.deepNotes.length ? `<div class="notice muted" style="margin:8px 0 0">심화 활동: ${c.deepNotes.map(esc).join(" ")}</div>` : ""}
    <details class="as-ev" open><summary>학생이 쓴 글 ${empty ? `<span class="tag r">쓴 글 없음 → 미제출</span>` : `<span class="meta-line">(${ev.length}개)</span>`}</summary>
      ${ev.length ? ev.map((e) => `<div class="logline"><div class="q">${esc(e.label)}</div><div class="a">${esc(e.text)}</div></div>`).join("") : `<div class="meta-line">기록이 없어요.</div>`}</details>
    <div class="as-lv">${c.levels.map((l) => lv(l.idx, l.label, l.pts, l.desc, empty)).join("")}${lv(-1, "미제출", 0, "쓴 글이 없어 평가할 수 없음", !empty)}</div>
    <label class="lbl" for="note-${c.id}">평가 근거 <span class="meta-line">· 점수를 공개하면 학생에게 보여요 · 가장 높거나 낮은 수준, AI와 두 수준 이상 다르면 8자 이상</span></label>
    <textarea id="note-${c.id}" maxlength="500" rows="2" placeholder="예) 세 가지를 모두 알아냈고 인물의 말을 근거로 씀">${esc(sc?.note ?? (pre !== null && ai?.reason ? `AI 제안: ${ai.reason}` : ""))}</textarea>
    <div class="row" style="margin-top:8px"><button class="btn btn-primary btn-sm" data-assave="${c.id}" type="button">${unrev || (pre !== null) ? "✓ 확인·저장" : "저장"}</button>
      ${sc && !unrev ? `<span class="meta-line">저장됨${sc.revs?.length ? ` · 고친 기록 ${sc.revs.length}번` : ""}</span>` : ""}</div>
    ${aiHtml(c, sc, ai, rv, s.hasAi[c.id], s.mode)}</div>`;
}
// AI 의견 상자: 결과·이유·근거 문장만 쓰고, 모델 이름 같은 속사정은 보이지 않는다
function aiHtml(c, sc, ai, rv, has, mode) {
  if (!c.ai) return `<div class="meta-line" style="margin-top:8px">수업 중 선생님이 관찰해 매기는 항목이에요(AI 의견 없음). <b>② 확인</b>에서 여러 학생에게 한꺼번에 매길 수 있어요.</div>`;
  if (!sc && !ai) return has ? `<div class="meta-line" style="margin-top:8px">🔒 AI 의견이 준비돼 있어요. 수준을 저장하면 보여요.</div>` : mode === "ai_first" ? `<div class="meta-line" style="margin-top:8px">아직 AI가 채점하지 않았어요. 위의 <b>AI 채점</b>을 눌러요.</div>` : "";
  if (!ai) return "";
  if (!sc) sc = { level: ai.level };
  if (ai.auto) return `<div class="meta-line" style="margin-top:8px">AI 의견: 학생이 쓴 글이 없어 미제출로 봤어요.</div>`;
  const same = ai.level === sc.level, near = Math.abs(rank(c, ai.level) - rank(c, sc.level)) === 1;
  const cmp = !sc.src || (sc.src === "ai" && sc.reviewed === false) ? "" : same ? "내 채점과 같음" : near ? "내 채점과 한 수준 차이" : "내 채점과 두 수준 이상 차이";
  return `<div class="as-ai ${same ? "same" : rv ? "dev" : near ? "near" : "dev"}">
    <div><b>AI 의견</b> ${esc(lvlLabel(c, ai.level))} ${ptsOf(c, ai.level)}점
      ${ai.spread ? `<span class="tag y">세 번 결과가 달랐어요</span>` : `<span class="tag">세 번 모두 같음</span>`}
      ${ai.quoteOk ? `<span class="tag b">근거 문장 확인</span>` : `<span class="tag r">근거 문장을 학생 글에서 못 찾음</span>`}
      ${cmp ? `<span class="tag ${same ? "" : "y"}">${cmp}</span>` : ""}</div>
    ${ai.reason ? `<div class="meta-line">${esc(ai.reason)}</div>` : ""}${ai.quote ? `<div class="meta-line">근거로 든 문장: “${esc(ai.quote)}”</div>` : ""}
    ${ai.spread ? `<div class="meta-line">세 번 채점: ${ai.levels.map((l) => esc(lvlLabel(c, l))).join(" / ")}</div>` : ""}
    ${rv ? `<div class="notice yellow" style="margin:8px 0 0">AI 의견과 두 수준 이상 달라요. 다시 살펴보거나, 그대로라면 평가 근거를 8자 이상 써서 저장해 주세요.</div>` : ""}
    <div class="meta-line">AI 의견은 참고예요. 최종 판단은 선생님이 해요.</div></div>`;
}
const rank = (c, level) => (level === -1 ? c.levels.length : level);

// ---------- ② 확인 ----------
// 선생님이 볼 것만 모은다: 직접 정할 점수(AI가 정하지 못한 것·이의 신청), 협력(관찰) 점수, AI가 정한 점수 확정.
async function loadQueue(offset = 0) {
  try { st.queue = (await call("assess")({ code: st.code, action: "queue", offset })).data; } catch (e) { toast(errMsg(e), true); st.queue = { items: [], total: 0, offset: 0, appeals: 0 }; }
  if (st.view === "queue") render();
}
// 할 일 한 줄: 번호, 이름, 상태, (있으면) 바로 하는 단추·입력
const todoRow = (n, name, sub, done, extra = "") => `<div class="as-todo ${done ? "done" : ""}"><b class="as-todo-n">${done ? "✓" : n}</b><div class="as-todo-b"><div><b>${name}</b> <span class="meta-line">${sub}</span></div>${extra}</div></div>`;
function queueHtml() {
  const q = st.queue, d = st.data, how = howOf(d), p = d.progress;
  if (how !== "independent" && !aiStarted(d) && !d.queue.appeals) return `<div class="card"><div class="notice muted" style="margin:0">먼저 <b>① AI 채점</b>을 해 주세요. 채점이 끝나면 선생님이 확인할 것만 여기에 모여요.</div><div class="row" style="margin-top:10px">${goBtn("score", "① AI 채점으로")}</div></div>`;
  if (!q) return busy();
  const obs = d.queue.observation, c62 = crit("c62");
  const bulk = obs && c62 ? `<div class="row as-bulk" style="margin-top:8px"><select id="as-bulk-lv" aria-label="협력 태도 수준">${c62.levels.map((l) => `<option value="${l.idx}" ${l.idx === 1 ? "selected" : ""}>${esc(l.label)} ${l.pts}점</option>`).join("")}</select>
      <input type="text" id="as-bulk-note" maxlength="100" placeholder="평가 근거 (예: 모둠 활동에 고르게 참여함)" style="flex:1;min-width:160px"><button class="btn btn-tinted btn-sm" data-asbulk type="button">${obs}명에게 매기기</button></div>
      <div class="meta-line" style="margin-top:4px">모둠 산출물을 한 건도 쓰지 않은 학생은 건너뛰어요. 그 학생은 ① 채점에서 따로 매겨요.</div>` : "";
  const rows = [];
  if (how === "auto") {
    rows.push(todoRow(1, "직접 정할 점수", q.total ? `${q.total}개 남음${q.appeals ? ` (이의 신청 ${q.appeals}건 포함)` : ""} · 아래에서 하나씩 정해요` : "다 정했어요", !q.total));
    rows.push(todoRow(2, "협력 태도(관찰) 점수", obs ? `${obs}명 남음 · AI가 볼 수 없어 선생님이 매겨요` : "다 매겼어요", !obs, bulk));
    rows.push(todoRow(3, "AI가 정한 점수 확정", p.unreviewed ? `${p.unreviewed}개 · 확정해야 공개했을 때 학생에게 보여요` : "다 확정했어요", !p.unreviewed,
      p.unreviewed ? `<div class="row" style="margin-top:8px"><button class="btn btn-primary btn-sm" data-asconfirmall type="button">✔ ${p.unreviewed}개 한꺼번에 확정</button><span class="meta-line">미리 보고 싶으면 ① 채점에서 열어 볼 수 있어요.</span></div>` : ""));
  } else {
    const left = [...d.groups.filter((g) => g.members > 0).map((g) => ({ kind: "group", id: g.id, name: g.name, n: g.total - g.scored + (g.unreviewed || 0) })),
      ...d.students.map((x) => ({ kind: "student", id: x.key, name: st.blind ? x.code : stuName(x), n: x.total - x.scored + (x.unreviewed || 0) }))].filter((x) => x.n > 0);
    const nLeft = left.reduce((s, x) => s + x.n, 0);
    if (q.appeals) rows.push(todoRow(1, "학생의 이의 신청", `${q.appeals}건 · 아래에서 하나씩 처리해요`, false));
    rows.push(todoRow(rows.length + 1, how === "manual" ? "AI 점수 확인" : "채점", nLeft ? `${nLeft}개 남음 · 눌러서 열어요` : "다 했어요", !nLeft,
      nLeft ? `<div class="chipbar" style="margin-top:8px">${left.map((x) => `<button class="chip sm" type="button" data-asgo="${x.kind}|${esc(x.id)}">${esc(x.name)} <span class="tag y">${x.n}</span></button>`).join("")}</div>` : ""));
    rows.push(todoRow(rows.length + 1, "협력 태도(관찰) 점수", obs ? `${obs}명 남음` : "다 매겼어요", !obs, bulk));
  }
  const allDone = stepsOf(d)[1].done;
  const head = `<div class="card"><h3 style="margin:0 0 4px">선생님이 확인할 것</h3>
    <div class="meta-line">${how === "auto" ? "AI가 확실하게 정하지 못한 점수와 학생의 이의 신청만 모았어요. 위에서부터 하면 돼요." : "아직 확인하거나 채점하지 않은 것을 모았어요."}</div>
    ${how === "auto" && d.autoPaused ? pausedHtml() : ""}
    <div class="as-todos">${rows.join("")}</div>
    ${allDone ? `<div class="notice green" style="margin:12px 0 0">확인할 것을 모두 마쳤어요.</div><div class="row" style="margin-top:10px">${goBtn("seteuk", "③ 세특 쓰기로 →")}</div>
      ${how === "auto" ? `<div class="meta-line" style="margin-top:8px">AI 점수를 믿어도 되는지 궁금하면 <button class="link" type="button" data-asv="reli">채점 점검</button>에서 몇 개를 다시 채점해 보세요. 자주 다르면 AI 자동 확정이 저절로 멈춰요.</div>` : ""}` : ""}</div>`;
  if (!q.items.length) return head;
  return head + `<h4 class="as-list-h">${how === "auto" ? "직접 정할 점수" : "이의 신청"} <span class="meta-line">${q.total}개 중 ${q.offset + 1}~${q.offset + q.items.length}번째 · 정하면 목록에서 사라져요</span></h4>` + q.items.map(queueCard).join("")
    + (q.offset + q.items.length < q.total ? `<div class="row"><button class="btn btn-plain btn-sm" data-qmore type="button">다음 ${Math.min(12, q.total - q.offset - q.items.length)}개 보기</button></div>` : "");
}
function queueCard(it) {
  const who = it.kind === "group" ? it.code : st.blind ? it.code : `${(it.groupId || "").slice(1)}모둠 ${it.nick}`;
  const ai = it.ai, pre = it.score ? it.score.level : ai && Number.isInteger(ai.level) ? ai.level : null;
  const key = `${it.kind}|${it.id}|${it.cid}`;
  return `<div class="card as-crit q-card" data-q="${esc(key)}" data-via="${esc(it.via || "")}">
    <div class="row" style="justify-content:space-between"><h4 style="margin:0">${it.type === "appeal" ? `<span class="tag r">이의 신청</span> ` : `<span class="tag y">확인 필요</span> `}${esc(who)} › ${esc(it.el)} › ${esc(it.name)}</h4>${it.score ? `<span class="tag">지금 점수 ${esc(lvlLabelL(it.levels, it.score.level))} ${it.score.pts}점</span>` : ""}</div>
    ${it.appeal ? `<div class="notice yellow" style="margin:8px 0 0">학생 의견: “${esc(it.appeal.text)}”</div>` : ""}
    ${it.reasons.length ? `<div class="as-why"><span class="meta-line">AI가 정하지 못한 까닭</span>${it.reasons.map((r) => `<span class="tag y">${esc(r)}</span>`).join(" ")}</div>` : ""}
    <details class="as-ev" open><summary>학생이 쓴 글 ${it.empty ? `<span class="tag r">쓴 글 없음</span>` : `<span class="meta-line">(${(it.evidence || []).length}개)</span>`}</summary>
      ${(it.evidence || []).length ? it.evidence.map((e) => `<div class="logline"><div class="q">${esc(e.label)}</div><div class="a">${esc(e.text)}</div></div>`).join("") : `<div class="meta-line">기록이 없어요.</div>`}</details>
    ${ai && !ai.auto ? `<div class="as-ai"><b>AI 의견</b> ${esc(lvlLabelL(it.levels, ai.level))}${ai.spread ? ` <span class="tag y">세 번 결과가 달랐어요</span>` : ""}${ai.reason ? `<div class="meta-line">${esc(ai.reason)}</div>` : ""}${ai.quote ? `<div class="meta-line">근거로 든 문장: “${esc(ai.quote)}”</div>` : ""}<div class="meta-line">세 번 채점: ${ai.levels.map((l) => esc(lvlLabelL(it.levels, l))).join(" / ")}</div></div>` : ""}
    <div class="as-lv">${[...it.levels.map((l) => [l.idx, l.label, l.pts, l.desc]), [-1, "미제출", 0, "쓴 글이 없어 평가할 수 없음"]].map(([idx, label, pts, desc]) => `<label class="lvopt ${pre === idx ? "cur" : ""}"><input type="radio" name="q-${esc(key)}" value="${idx}" ${pre === idx ? "checked" : ""} ${(idx === -1) !== !!it.empty ? "disabled" : ""}><span class="lvh"><b>${esc(label)}</b> <span class="tag b">${pts}점</span></span><span class="lvd">${esc(desc)}</span></label>`).join("")}</div>
    <textarea class="q-note" maxlength="500" rows="2" placeholder="평가 근거 (점수를 공개하면 학생에게 보여요)">${esc(it.score?.note ?? (ai?.reason && !ai.auto ? `AI 제안: ${ai.reason}` : ""))}</textarea>
    <div class="row" style="margin-top:8px"><button class="btn btn-primary btn-sm" data-qsave type="button">✓ 이 점수로 정하기</button>
      ${it.type === "appeal" ? `<input type="text" class="q-reply" maxlength="300" placeholder="학생에게 보낼 답(선택)" style="flex:1;min-width:140px"><button class="btn btn-tinted btn-sm" data-qresolve type="button">이의 신청 처리 완료</button>` : ""}</div></div>`;
}
const lvlLabelL = (levels, level) => (level === -1 ? "미제출" : levels[level]?.label || "");
async function qSave(btn) {
  const card = btn.closest("[data-q]"), [kind, id, cid] = card.dataset.q.split("|");
  const pick = card.querySelector('input[type="radio"]:checked');
  if (!pick) return toast("수준을 먼저 고르세요.", true);
  await guard(async () => {
    await call("assess")({ code: st.code, action: "save", kind, id, criterion: cid, level: Number(pick.value), note: card.querySelector(".q-note").value });
    toast("저장했어요"); st.queue = null; await refresh(); render();
  });
}
async function qResolve(btn) {
  const card = btn.closest("[data-q]"), [, , cid] = card.dataset.q.split("|");
  await guard(async () => {
    await call("assess")({ code: st.code, action: "resolveAppeal", id: card.dataset.via, criterion: cid, reply: card.querySelector(".q-reply")?.value || "" });
    toast("이의 신청을 처리했어요"); st.queue = null; await refresh(); render();
  });
}

// ---------- ③ 세특 쓰기 ----------
// 서버 순서: 학생 글 확인 → 글 수준 판정(빈약하면 짧게·맞추기·취소) → 기승전결 초안 → 분량(NEIS 바이트) 맞추기 → 검토·직접 수정·저장.
// 화면에는 결과와 꼭 고를 것만 두고, 초안을 만든 과정(문장별 근거·분량 맞추기)은 접어 둔다.
const GRADE_CLS = { S: "s", A: "a", B: "b", C: "c" };
const GRADE_NAME = { S: "매우 우수", A: "우수", B: "보통", C: "미흡" };
const EMP = [["balance", "균형"], ["academic", "학업역량"], ["leader", "리더십"], ["character", "인성"], ["growth", "성장잠재력"]];
const PART_NAME = { 기: "기 · 문제의식", 승: "승 · 과정", 전: "전 · 발견", 결: "결 · 성찰" };
const skOf = (id) => (st.sk[id] = st.sk[id] || { prep: null, gen: null, text: null, editing: false, saved: null, msg: "" });
const byteCls = (n, max) => (n > max ? "over" : n > max * 0.9 ? "warn" : "ok");
const bytesHtml = (n, max) => `<b>${n.toLocaleString()}</b><small> / ${max.toLocaleString()}바이트</small>`;

function seteukHtml() {
  const d = st.data, list = d.students, cur = list.find((x) => x.key === st.id), nSk = list.filter((x) => x.hasSeteuk).length;
  return `<div class="card sk-root"><div class="row" style="justify-content:space-between;align-items:flex-start"><div><h3 style="margin:0">세특 쓰기</h3><div class="meta-line">저장 ${nSk} / ${list.length}명</div></div>
      <div class="row"><label class="meta-line">분량 <select id="as-max">${[1000, 1500, 2000].map((n) => `<option value="${n}" ${d.seteukMax === n ? "selected" : ""}>${n.toLocaleString()}바이트 (한글 약 ${Math.round(n / 3)}자)</option>`).join("")}</select></label>
      <label class="meta-line">강조할 점 <select id="as-emp">${EMP.map(([k, n]) => `<option value="${k}" ${st.emphasis === k ? "selected" : ""}>${n}</option>`).join("")}</select></label></div></div>
    <div class="meta-line" style="margin-top:6px">학생이 수업에서 쓴 글만 바탕으로 초안을 만들어요(하지 않은 활동은 쓰지 않아요). 초안은 꼭 읽고 고친 뒤 저장하세요.</div>
    <div class="chipbar as-pick" style="margin-top:10px">${list.map((x) => `<button class="chip sm ${x.key === st.id ? "on" : ""}" data-asid="${esc(x.key)}">${esc(stuName(x))}${x.hasSeteuk ? " ✓" : ""}</button>`).join("") || `<span class="meta-line">학생이 없어요.</span>`}</div>
    ${list.length && nSk === list.length ? `<div class="row" style="margin-top:10px">${goBtn("release", "모두 저장했어요 · ④ 공개로 →")}</div>` : ""}</div>
    ${cur ? studentSeteukHtml(cur) : ""}`;
}
function studentSeteukHtml(cur) {
  const d = st.data, k = skOf(st.id), list = d.students, i = list.findIndex((x) => x.key === st.id), next = list[i + 1];
  if (!st.sub || st.sub.id !== st.id) return busy(); // 불러오기 전에 그리면 저장된 세특이 빈 글로 덮인다
  const saved = st.sub.seteuk?.text || "";
  if (k.text === null) k.text = saved;
  const bytes = byteLen(k.text), max = d.seteukMax;
  return `<div class="card sk-root"><div class="row" style="justify-content:space-between"><h4 style="margin:0">${esc(stuName(cur))}</h4>${next ? `<button class="btn btn-plain btn-sm" data-asnext="${esc(next.key)}" type="button">다음 학생 →</button>` : ""}</div>
    <div class="row" style="margin-top:8px"><button class="btn btn-primary btn-sm" data-asmake type="button" ${st.busy ? "disabled" : ""}>${k.gen || k.prep ? "✨ 초안 다시 만들기" : "✨ 초안 만들기"}</button>
      ${st.busy && k.msg ? `<span class="sk-msg" role="status">${esc(k.msg)}</span>` : ""}</div>
    ${k.prep ? prepHtml(k.prep) : ""}
    <div class="sk-head"><label class="lbl" for="as-seteuk" style="margin:0">세특</label>
      <span class="sk-count ${byteCls(bytes, max)}" id="as-bytes">${bytesHtml(bytes, max)}</span>
      <label class="sk-sw"><input type="checkbox" id="sk-edit" ${k.editing ? "checked" : ""}><span class="sk-track"><span class="sk-thumb"></span></span><span>✏️ 직접 고치기</span></label></div>
    ${k.editing ? `<div class="sk-hint">고치는 중이에요. 저장하면 이 글이 최종본이 돼요.</div>` : ""}
    <textarea id="as-seteuk" class="sk-text ${k.editing ? "on" : ""}" rows="9" ${k.editing ? "" : "readonly"} placeholder="✨ 초안 만들기를 누르거나, ✏️ 직접 고치기를 켜고 써요">${esc(k.text)}</textarea>
    <div class="row" style="justify-content:space-between;margin-top:8px"><span id="as-sw">${warnHtml(k)}</span>
      <div class="row">${k.saved ? `<span class="sk-saved">✅ 저장했어요</span>` : saved && k.text === saved ? `<span class="sk-saved">✅ 저장된 세특</span>` : ""}<button class="btn btn-primary btn-sm" data-asseteuk type="button">💾 저장</button></div></div>
    ${k.gen ? structureHtml(k.gen) : ""}</div>`;
}
const warnHtml = (k) => (k.warnings || []).map((w) => `<div class="sk-warn">⚠️ ${esc(w)}</div>`).join("");

function prepHtml(p) {
  const susp = p.suspicion.level, g = p.useGrade || p.grade;
  return `<div class="sk-prep"><div class="sk-prep-h"><span class="sk-badge g-${GRADE_CLS[p.grade]}">학생 글 수준 ${p.grade} · ${GRADE_NAME[p.grade]}</span>
      <span class="meta-line">활동 기록 ${p.evidenceCount}개를 읽었어요</span>
      <label class="meta-line">수준 바꾸기 <select id="sk-grade">${["S", "A", "B", "C"].map((x) => `<option value="${x}" ${g === x ? "selected" : ""}>${x} · ${GRADE_NAME[x]}</option>`).join("")}</select></label></div>
    ${susp !== "낮음" ? `<div class="sk-warn">🤖 AI가 대신 쓴 글일 수 있어요(${susp}): 내용이 추상적이거나 기계적인 문체가 보여요. 학생 글을 직접 확인해 보세요. 이 판정만으로 학생에게 불이익을 주지 마세요.</div>` : ""}
    ${p.richness.isPoor ? `<div class="sk-warn">⚠️ 학생 글이 적어요: ${p.richness.issues.map(esc).join(", ") || "분량에 비해 적음"}</div>` : ""}
    <details class="as-ev"><summary>수준은 어떻게 정했나요?</summary><div class="sk-crit">${p.criteria.map((c) => `<span class="sk-pill g-${GRADE_CLS[c.grade]}" title="${esc(c.reason)}">${esc(c.label)} ${c.grade}${c.ai_suspicion !== "낮음" ? ` 🤖${c.ai_suspicion}` : ""}</span>`).join("")}</div>
      <div class="meta-line" style="margin-top:6px">탐구 깊이·논리·자기주도·연계·성찰 다섯 가지를 보고 정해요(평균 ${p.gradeScore} / 4). 수준은 표현의 밀도에만 쓰고 세특에 등급을 쓰지는 않아요. 수준을 바꾼 뒤 <b>초안 다시 만들기</b>를 누르면 반영돼요.</div></details></div>`;
}
function structureHtml(g) {
  const last = g.log.at(-1)?.bytes ?? g.bytes;
  return `<details class="as-ev sk-struct"><summary>초안을 어떻게 썼나요? <span class="meta-line">문장마다 어떤 활동을 근거로 했는지</span></summary>
    ${g.parts.map((p) => `<div class="sk-part p-${p.part}"><b>${PART_NAME[p.part]}</b><div>${p.sentences.length ? p.sentences.map((x) => `<div class="sk-sent">${esc(x.text)}<div class="meta-line">근거: ${x.evidence.map((id) => esc(g.evidence[id]?.label || id)).join(", ")}</div></div>`).join("") : `<i>비어 있음</i>`}</div></div>`).join("")}
    <div class="meta-line">분량: ${last.toLocaleString()}바이트로 맞췄어요(목표 ${g.target.toLocaleString()}바이트 · ${g.log.length}번 다듬음)${g.dropped.length ? ` · 근거가 없어 뺀 문장 ${g.dropped.length}개` : ""}. 직접 고치면 이 구조와 달라질 수 있어요.</div></details>`;
}

const SK_STEPS = ["📄 학생이 쓴 글을 읽는 중…", "🔍 글 수준을 살펴보는 중…", "✨ 초안을 쓰는 중…", "📏 분량을 맞추는 중…", "📏 마지막으로 다듬는 중…"];
async function makeSeteuk() {
  const k = skOf(st.id), id = st.id;
  await guard(async () => {
    let timer = null;
    const say = (m) => { k.msg = m; const el = root().querySelector(".sk-msg"); if (el) el.textContent = m; else render(); };
    try {
      k.editing = false; k.saved = null; // 다시 만들면 이전 저장 배지와 편집 상태를 초기화한다
      render(); say(SK_STEPS[0]);
      say(SK_STEPS[1]);
      k.prep = (await call("assessAi")({ code: st.code, action: "seteukPrep", kind: "student", id })).data;
      k.prep.useGrade = k.gradeOverride || k.prep.grade; // 선생님이 바꾼 수준은 다시 만들 때도 쓴다
      render();
      let decision;
      if (k.prep.needsAdjustment) {
        decision = await showModal({
          title: "학생 글이 분량에 비해 적어요",
          body: `<p>학생이 쓴 활동 기록으로는 <b>${k.prep.target.toLocaleString()}바이트</b>를 사실대로 채우기 어려워요.</p><ul>${k.prep.richness.issues.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
            <p><b>짧게 쓰기</b>는 학생이 쓴 내용만으로 약 ${k.prep.suggestedMax.toLocaleString()}바이트까지 쓰고, 모자라도 채우지 않아요.<br><b>분량 맞추기</b>는 분량을 채우려 자연스럽게 보태요(학생이 한 활동의 방향은 지키지만 내용이 부풀 수 있어요).</p>`,
          actions: [{ label: `짧게 쓰기 (약 ${k.prep.suggestedMax.toLocaleString()}바이트) · 권장`, value: "lower", kind: "btn-primary" }, { label: "분량 맞추기", value: "keep" }, { label: "취소", value: "cancel" }], grid: true,
        });
        if (!decision || decision === "cancel") { toast("취소했어요. 글 수준 판정은 남아 있어요."); return; }
      }
      let n = 2; say(SK_STEPS[2]);
      timer = setInterval(() => say(SK_STEPS[Math.min(n++, SK_STEPS.length - 1)]), 9000);
      const grade = k.prep.useGrade;
      const r = (await call("assessAi")({ code: st.code, action: "seteukGenerate", kind: "student", id, decision, emphasis: st.emphasis, grade })).data;
      if (r.cancelled) return;
      k.gen = r; k.text = r.text; k.warnings = r.warnings;
      toast(`초안을 만들었어요 (${r.bytes.toLocaleString()}바이트). 읽고 고친 뒤 저장하세요.`);
    } finally { clearInterval(timer); k.msg = ""; render(); }
  });
}

async function saveSeteuk() {
  const k = skOf(st.id), id = st.id, text = $("#as-seteuk").value;
  await guard(async () => {
    const r = (await call("assess")({ code: st.code, action: "seteukSave", id, text })).data;
    k.text = r.text; k.warnings = r.warnings; k.editing = false; k.saved = r.bytes; // 저장하면 읽기 전용으로 돌아간다
    if (st.sub) st.sub.seteuk = { text: r.text, t: Date.now() };
    const x = st.data.students.find((y) => y.key === id); if (x) x.hasSeteuk = !!r.text;
    toast(r.text ? "저장했어요" : "비웠어요");
    render();
  });
}

// ---------- ④ 학생에게 공개 ----------
function releaseHtml() {
  const d = st.data, p = { ...d.progress, ...liveProgress(d) }, r = d.release, nStu = d.students.length, nSk = d.students.filter((x) => x.hasSeteuk).length;
  const left = [p.total - p.done ? `채점 안 한 항목 ${p.total - p.done}개` : "", p.unreviewed ? `확정 전 AI 점수 ${p.unreviewed}개` : "", p.reviewCount ? `AI와 크게 달라 평가 근거가 필요한 항목 ${p.reviewCount}개` : ""].filter(Boolean);
  const row = (k, name, on, ready, note) => `<div class="as-rel-item ${on ? "on" : ""}"><div class="as-rel-txt"><div><b>${name}</b> <span class="tag ${on ? "" : "x"}">${on ? "공개 중" : "비공개"}</span></div><div class="meta-line">${ready}</div>${note ? `<div class="meta-line">${note}</div>` : ""}</div>
    <button class="btn ${on ? "btn-plain" : "btn-primary"} btn-sm" data-asrel="${k}" type="button">${on ? "공개 끄기" : `${name} 공개하기`}</button></div>`;
  return `<div class="card"><h3 style="margin:0 0 4px">학생에게 공개하기</h3>
    <div class="meta-line">공개하면 학생이 자기 화면의 <b>내 결과</b>에서 봐요(수업이 끝난 뒤에도 입장 정보로 볼 수 있어요). 점수와 세특은 따로 공개하고, 끄면 바로 안 보여요.</div>
    <div class="as-rel">
      ${row("score", "점수", r.score, left.length ? `⚠ ${left.join(" · ")}` : "✓ 모두 채점·확정했어요", "학생은 항목별 점수·수준·평가 근거를 보고, 항목마다 한 번 이의 신청을 할 수 있어요. 이의 신청은 ② 확인에 모여요.")}
      ${row("seteuk", "세특", r.seteuk, nSk < nStu ? `⚠ 세특을 저장하지 않은 학생 ${nStu - nSk}명` : "✓ 모든 학생의 세특을 저장했어요", "")}
    </div></div>`;
}

// ---------- 도구: 척도표 ----------
function rubricHtml() {
  const r = st.data.rubric;
  const rows = [];
  let last = 0;
  for (const c of r.criteria) {
    if (c.el !== last) { rows.push(`<tr class="as-el"><td colspan="${r.labels.length + 2}">${esc(c.elName)}</td></tr>`); last = c.el; }
    rows.push(`<tr><td><b>${esc(c.name)}</b><div class="meta-line">${esc(c.stage)} · ${c.scope === "student" ? "개인" : "모둠"} · ${c.max}점</div>${c.deepNotes.map((n) => `<div class="meta-line">심화: ${esc(n)}</div>`).join("")}</td>${c.levels.map((l) => `<td data-lv="${esc(l.label)}">${esc(l.desc)}<div><span class="tag b">${l.pts}점</span></div></td>`).join("")}<td data-lv="미제출">쓴 글이 없으면 <span class="tag x">0점</span></td></tr>`);
  }
  return `<div class="card"><h3>${r.level === "middle" ? "중학교" : "고등학교"} 척도표 <span class="meta-line">· 총 ${r.total}점</span></h3>
    <div class="meta-line">학생이 쓴 판단·근거·이유를 평가해요. AI에게 물은 횟수, 글자 수, 맞춤법, AI를 썼는지는 점수에 넣지 않아요. <b>수업 설정</b>에서 학교급이나 심화 활동을 바꾸면 척도표도 바뀌어요.</div>
    <div class="tbl-wrap"><table class="tbl as-rubric"><thead><tr><th>항목</th>${r.labels.map((l) => `<th>${esc(l)}</th>`).join("")}<th>미제출</th></tr></thead><tbody>${rows.join("")}</tbody></table></div></div>`;
}

// ---------- 도구: 채점 점검(타당도·신뢰도) ----------
async function loadReli() {
  $("#as-body").innerHTML = busy();
  try {
    const [rel, rc] = await Promise.all([call("assess")({ code: st.code, action: "reliability" }), call("assess")({ code: st.code, action: "recheck" })]);
    st.rel = rel.data; st.recheck = rc.data;
  } catch (e) { $("#as-body").innerHTML = `<div class="notice">${esc(errMsg(e))}</div>`; return; }
  if (st.view === "reli") $("#as-body").innerHTML = reliHtml();
}
const fmtN = (v, u = "") => (v === null || v === undefined ? "—" : `${v}${u}`);
function reliHtml() {
  const r = st.rel;
  if (!r) return busy();
  const T = r.thresholds, o = r.overall, ed = r.edit || { same: 0, changed: 0, rate: null };
  const card = (title, big, sub, ok) => `<div class="as-stat ${ok === false ? "bad" : ok ? "ok" : ""}"><div class="meta-line">${title}</div><div class="big">${big}</div><div class="meta-line">${sub}</div></div>`;
  const okEnough = o.n >= T.minPairs;
  return `${rechecksHtml()}<div class="card"><h3>채점 점검</h3>
    <div class="meta-line">선생님과 AI가 같은 글에 같은 수준을 골랐는지, 선생님 채점이 한결같은지 봐요. 비슷하다고 꼭 옳은 건 아니고, 많이 다르면 다시 살펴볼 신호예요. AI 점수를 보고 정한 점수는 비교에서 빼고, 대신 <b>고친 비율</b>과 <b>다시 채점해 보기</b>로 점검해요.</div>
    ${(r.warnings || []).map((w) => `<div class="notice yellow" style="margin-top:10px">${esc(w)}</div>`).join("") || `<div class="notice green" style="margin-top:10px">지금은 걸리는 것이 없어요.</div>`}
    <div class="as-stats">
      ${card("AI와 같은 수준", fmtN(o.exact, "%"), `${o.n}개 비교 · ${T.exact}% 이상이면 좋음`, okEnough ? o.exact >= T.exact : undefined)}
      ${card("한 수준 안으로 비슷", fmtN(o.adjacent, "%"), `${T.adjacent}% 이상이면 좋음`, okEnough ? o.adjacent >= T.adjacent : undefined)}
      ${card("일치도(카파)", fmtN(o.kappa), `우연히 맞은 것을 뺀 값 · ${T.kappa} 이상이면 좋음`, okEnough && o.kappa !== null ? o.kappa >= T.kappa : undefined)}
      ${card("내 채점 경향", o.bias === null ? "—" : o.bias > 0.1 ? "후한 편" : o.bias < -0.1 ? "엄격한 편" : "비슷함", `AI보다 평균 ${fmtN(o.bias)}수준`, okEnough && o.bias !== null ? Math.abs(o.bias) < T.bias : undefined)}
      ${card("AI 세 번 결과가 같음", fmtN(r.self.same, "%"), `${r.self.n}개 · ${T.selfConsistency}% 이상이면 좋음`, r.self.n >= T.minPairs ? r.self.same >= T.selfConsistency : undefined)}
      ${card("AI 점수를 고친 비율", fmtN(ed.rate, "%"), `적용한 ${ed.same + ed.changed}개 중 ${ed.changed}개 고침`, ed.same + ed.changed >= T.minPairs ? ed.changed > 0 && ed.rate <= 50 : undefined)}
      ${card("다시 채점했을 때 같음", fmtN(r.recheck.exact, "%"), `${r.recheck.n}개 · ${T.recheckExact}% 이상이면 좋음`, r.recheck.n >= 5 ? r.recheck.exact >= T.recheckExact : undefined)}
    </div></div>
    <div class="card"><h4 style="margin:0 0 6px">항목별 AI와의 일치</h4><div class="tbl-wrap"><table class="tbl"><thead><tr><th>항목</th><th>비교</th><th>같은 수준</th><th>한 수준 안</th><th>카파</th></tr></thead><tbody>
      ${r.byCriterion.map((x) => `<tr><td>${esc(x.name)}</td><td>${x.n}</td><td>${fmtN(x.exact, "%")}</td><td>${fmtN(x.adjacent, "%")}</td><td>${fmtN(x.kappa)}</td></tr>`).join("")}</tbody></table></div></div>
    <div class="card"><h4 style="margin:0 0 6px">항목별 점수 분포(만점 대비 %)</h4><div class="meta-line">평균이 너무 높거나 낮거나 표준편차가 거의 0이면, 그 항목이 학생을 가르지 못하는 것일 수 있어요.</div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>항목</th><th>채점 수</th><th>평균</th><th>표준편차</th></tr></thead><tbody>
      ${r.distribution.map((x) => `<tr><td>${esc(x.name)}</td><td>${x.n}</td><td>${fmtN(x.mean, "%")}</td><td>${fmtN(x.sd, "%")}</td></tr>`).join("")}</tbody></table></div></div>
    <div class="card"><h4 style="margin:0 0 6px">모둠별 모둠 점수 합계</h4><div class="chipbar">${r.groups.map((g) => `<span class="chip sm">${esc(g.name)} ${g.group}점</span>`).join("")}</div></div>`;
}
// 다시 채점해 보기: 이미 채점한 것 일부를 처음 점수를 가린 채 다시 매긴다(선생님의 일관성, '애매한 것만 확인'에서는 AI 자동 확정의 점검)
function rechecksHtml() {
  const rc = st.recheck;
  if (!rc) return "";
  const head = `<div class="card"><h4 style="margin:0 0 6px">다시 채점해 보기 <span class="meta-line">(몇 분이면 돼요)</span></h4>
    <div class="meta-line">이미 채점한 것 중 몇 개를 처음 점수를 가린 채 다시 매겨요. 채점하고 하루쯤 지난 뒤에 하면 더 정확해요.${howOf(st.data) === "auto" ? " AI가 정한 점수와 자주 다르면 AI 자동 확정이 저절로 멈춰요." : ""}</div>`;
  if (!rc.items.length) return head + `<div class="notice muted" style="margin-top:10px">${rc.left ? "" : "지금 다시 채점할 것이 없어요. 채점을 더 하면 생겨요."}</div></div>`;
  return head + `<div class="meta-line">남은 ${rc.left}개 중 ${rc.items.length}개를 보여 줘요.</div>` + rc.items.map((it) => {
    const c = crit(it.criterion);
    return `<div class="as-rc" data-rk="${esc(it.kind)}" data-ri="${esc(it.id)}" data-rc="${it.criterion}"><div class="row" style="justify-content:space-between"><b>${esc(it.code)} › ${esc(c.name)}</b></div>
      <details class="as-ev" open><summary>학생이 쓴 글</summary>${it.evidence.map((e) => `<div class="logline"><div class="q">${esc(e.label)}</div><div class="a">${esc(e.text)}</div></div>`).join("") || `<div class="meta-line">기록이 없어요.</div>`}</details>
      <div class="chipbar" style="margin-top:8px">${[...c.levels.map((l) => [l.idx, `${l.label} ${l.pts}점`]), [-1, "미제출 0점"]].map(([v, n]) => `<button class="chip sm" data-rcv="${v}" type="button">${esc(n)}</button>`).join("")}</div></div>`;
  }).join("") + `</div>`;
}

// ---------- 도구: 채점 방식 ----------
// 예전의 '예외만 검토' 켜고 끄기와 '채점 방식' 고르기를 세 가지 중 하나로 합쳤다(어긋난 조합이 생기지 않게).
function settingsHtml() {
  const d = st.data, how = howOf(d);
  const opt = (v, title, desc, rec) => `<label class="lvopt as-how ${how === v ? "cur" : ""}"><input type="radio" name="as-how" value="${v}" ${how === v ? "checked" : ""}><span class="lvh"><b>${title}</b>${rec ? ' <span class="tag b">권장</span>' : ""}</span><span class="lvd">${desc}</span></label>`;
  return `<div class="card"><h3 style="margin:0 0 4px">채점 방식</h3><div class="meta-line">이 수업에만 적용돼요. 어느 방식이든 확정과 공개는 선생님이 직접 눌러요.</div>
    <div class="as-lv">${opt("auto", "애매한 것만 확인", "AI가 세 번 채점해 결과가 같고 근거가 분명한 점수는 정해 두고, 나머지만 ② 확인으로 보내요. 가장 높거나 낮은 수준, 학생 글이 너무 짧은 경우도 선생님이 확인해요.", true)}
      ${opt("manual", "AI 점수를 하나씩 확인", "AI가 고른 수준이 미리 표시돼요. 모둠·학생마다 열어 맞으면 확인, 다르면 고쳐요.")}
      ${opt("independent", "내가 먼저 채점", "AI 의견은 선생님이 수준을 저장한 뒤에만 보여요. 선생님과 AI의 채점이 얼마나 비슷한지 점검할 때 써요.")}</div></div>
    ${how === "auto" ? calibCardHtml() : ""}`;
}
function calibCardHtml() {
  const d = st.data, on = d.auto.calib;
  return `<div class="card"><h4 style="margin:0">AI를 내 기준에 맞춰 보기 <span class="meta-line">(선택)</span></h4>
    <div class="meta-line" style="margin-top:4px">샘플 학생 6명과 모둠 몇 개를 AI 점수 없이 채점하면(20~30분), 선생님과 AI가 잘 맞는 항목만 AI가 정하고 나머지는 모두 ② 확인으로 보내요. 한 번 하면 같은 주제·학교급의 다음 수업에서도 그대로 써요.</div>
    <label class="chk" style="margin-top:8px"><input type="checkbox" id="as-calib-on" ${on ? "checked" : ""}> 사용하기</label>
    ${on ? calibHtml(d.calib) : ""}${d.autoPaused ? pausedHtml() : ""}</div>`;
}
function calibHtml(c) {
  if (!c) return "";
  const date = (t) => (t ? new Date(t).toLocaleDateString("ko-KR") : "");
  if (c.state === "none") return `<div class="as-calib"><b>아직 맞춰 보지 않았어요.</b> 그동안은 모든 점수가 ② 확인으로 가요. <div class="row" style="margin-top:6px"><button class="btn btn-tinted btn-sm" data-ascalib type="button">맞춰 보기 시작</button></div></div>`;
  if (c.state === "collecting") return `<div class="as-calib"><b>맞춰 보는 중</b> — ① 채점의 목록에서 🎯 표시된 학생·모둠을 <b>AI 점수 없이</b> 채점해 주세요. 다 채점하면 결과가 저절로 나와요(샘플의 AI 점수는 가려져 있어요).
    <div class="row" style="margin-top:6px"><button class="btn btn-tinted btn-sm" data-ascalibgo type="button">🎯 샘플 채점하러 가기</button></div></div>`;
  const per = c.perCriterion || {};
  return `<div class="as-calib ok"><b>맞춰 봤어요</b> ${c.reused ? `· 다른 수업(${esc(c.from)})에서 ${date(c.t)}에 맞춘 결과를 <b>그대로 쓰는 중</b>` : `· ${date(c.t)}`} · AI가 정하는 항목 <b>${c.passed} / ${c.total}</b>
    ${c.overall ? `<span class="meta-line">(샘플 ${c.overall.n}개 · 같은 수준 ${fmtN(c.overall.exact, "%")} · 카파 ${fmtN(c.overall.kappa)})</span>` : ""}
    <details class="as-ev"><summary>항목별 결과</summary><div class="chipbar">${Object.entries(per).map(([id, x]) => { const cr = st.data.rubric.criteria.find((y) => y.id === id); return `<span class="chip sm ${x.pass ? "on" : ""}" title="비교 ${x.n}개 · 같은 수준 ${fmtN(x.exact, "%")}">${esc(cr?.name || id)} ${x.pass ? "✓" : `✗ ${x.n}개`}</span>`; }).join("")}</div>
    <div class="meta-line">✗ 항목은 샘플이 모자라거나(학생 항목 3개, 모둠 항목은 샘플 모둠 수만큼) 선생님과 덜 맞은 항목이라 계속 ② 확인으로 가요. 샘플 모둠이 하나뿐이면 비교가 거칠어요. 척도표나 주제·심화 설정을 바꾸면 다시 맞춰 봐요.</div></details>
    <div class="row" style="margin-top:6px"><button class="btn btn-plain btn-sm" data-ascalib type="button">다시 맞춰 보기</button></div></div>`;
}

// ---------- 동작 ----------
async function guard(fn) {
  if (st.busy) return;
  st.busy = true;
  try { await fn(); } catch (e) { toast(errMsg(e), true); }
  finally { st.busy = false; root()?.querySelectorAll("[data-asai],[data-asmake]").forEach((b) => { b.disabled = false; }); } // 일하는 동안 막았던 단추를 푼다(안에서 다시 그렸어도)
}

async function toggleRelease(k) {
  const d = st.data, on = !d.release[k];
  const name = k === "score" ? "점수" : "세특";
  if (on) {
    let warn = "";
    const lp = liveProgress(d);
    if (k === "score") warn = lp.done < lp.total ? `아직 채점하지 않은 항목이 ${lp.total - lp.done}개 있어요. 그 항목은 학생에게 '채점 전'으로 보여요.` : "";
    if (k === "score" && d.progress.unreviewed) warn += ` 확정하지 않은 AI 점수가 ${d.progress.unreviewed}개 있어요. 확정 전 점수는 학생에게 보이지 않아요.`;
    if (k === "score" && d.progress.reviewCount) warn += ` AI 의견과 크게 달라 평가 근거가 필요한 항목이 ${d.progress.reviewCount}개 있어요.`;
    if (k === "seteuk") { const n = d.students.filter((x) => !x.hasSeteuk).length; if (n) warn = `세특을 저장하지 않은 학생이 ${n}명 있어요. 그 학생에게는 '아직 없어요'로 보여요.`; }
    const ok = await confirmModal(`${name}을(를) 공개할까요?`, `<p>학생이 자기 화면의 <b>내 결과</b>에서 ${k === "score" ? "자기 점수와 수준별 평가 근거" : "자기 세특"}를 볼 수 있어요. ${name}만 공개되고 ${k === "score" ? "세특" : "점수"}는 그대로예요.</p>${warn ? `<p class="meta-line">${esc(warn)}</p>` : ""}`, "공개하기", "취소");
    if (!ok) return;
  }
  await guard(async () => {
    const r = await call("assess")({ code: st.code, action: "release", [k]: on });
    st.data.release = r.data.release;
    toast(`${name} ${on ? "공개했어요" : "공개를 껐어요"}`);
    render();
  });
}

async function saveCriterion(cid) {
  const card = root().querySelector(`[data-cid="${cid}"]`);
  const pick = card.querySelector(`input[name="lv-${cid}"]:checked`);
  if (!pick) return toast("수준을 먼저 고르세요.", true);
  const note = card.querySelector("textarea").value;
  await guard(async () => {
    const r = (await call("assess")({ code: st.code, action: "save", kind: st.kind, id: st.id, criterion: cid, level: Number(pick.value), note })).data;
    st.sub.scores[cid] = r.score;
    if (r.ai) { st.sub.ai[cid] = r.ai; }
    if (r.review) st.sub.review[cid] = r.review; else delete st.sub.review[cid];
    toast("저장했어요");
    const y = window.scrollY;
    render(); window.scrollTo(0, y);
    refresh().then(() => { // 단계 막대·진행률·목록 숫자만 조용히 갱신(입력 중인 다른 항목은 건드리지 않는다)
      const head = root().querySelector(".as-head");
      if (head) { const t = document.createElement("div"); t.innerHTML = stepsNav(st.data); head.querySelector("#as-views")?.replaceWith(t.firstElementChild); const m = head.querySelector(".as-head-top .meta-line"), lp = liveProgress(st.data); if (m) m.textContent = m.textContent.replace(/채점 \d+ \/ \d+항목/, `채점 ${lp.done} / ${lp.total}항목`); }
      root().querySelectorAll("[data-asid]").forEach((b) => { const x = subjList().find((y) => subjId(y) === b.dataset.asid); const n = b.querySelector(".as-n"); if (x && n) n.textContent = `${x.scored}/${x.total}`; });
    }).catch(() => {});
  });
}

async function applyAiBtn() {
  await guard(async () => {
    const r = (await call("assess")({ code: st.code, action: "applyAi", kind: st.kind, id: st.id })).data;
    toast(r.applied ? `AI 점수 ${r.applied}개를 적용했어요. 하나씩 확인해 주세요${r.skipped ? ` (${r.skipped}개는 학생 글과 맞지 않아 뺐어요)` : ""}` : "적용할 AI 점수가 없어요.");
    await Promise.all([loadSubject(), refresh()]); render();
  });
}
async function batchAi() {
  if (st.batch?.running) { st.batch.stop = true; render(); return; }
  const d = st.data, how = howOf(d), applyAfter = how !== "independent"; // AI가 먼저 채점하는 방식이면 끝나고 바로 적용(확정 전)
  const need = (x, tot) => x.ai < tot;
  const nameOf = (x) => (st.blind ? x.code : stuName(x));
  let targets = [...d.groups.filter((g) => g.members > 0 && need(g, d.aiTotal.group)).map((g) => ({ kind: "group", id: g.id, name: g.name })), ...d.students.filter((x) => need(x, d.aiTotal.student)).map((x) => ({ kind: "student", id: x.key, name: nameOf(x) }))];
  const redo = !targets.length;
  if (redo) targets = [...d.groups.filter((g) => g.members > 0).map((g) => ({ kind: "group", id: g.id, name: g.name })), ...d.students.map((x) => ({ kind: "student", id: x.key, name: nameOf(x) }))];
  if (!targets.length) return toast("채점할 대상이 없어요.", true);
  const est = Math.round(targets.length * 3.4);
  const after = how === "auto" ? "끝나면 확실한 점수는 정해 두고(확정 전), 애매한 것은 <b>② 확인</b>으로 보내요. 확정은 선생님이 직접 눌러요."
    : how === "manual" ? "끝나면 AI 점수가 <b>확인 전</b>으로 채워져요. 모둠·학생마다 열어 확인·수정해 주세요." : "끝나면 선생님이 저장한 항목마다 AI 의견을 볼 수 있어요.";
  if (!(await confirmModal(redo ? "처음부터 다시 채점할까요?" : "AI 채점을 시작할까요?", `<p>모둠 ${targets.filter((t) => t.kind === "group").length}개와 학생 ${targets.filter((t) => t.kind === "student").length}명을 AI가 차례로 채점해요(몇 분 걸려요). ${after}</p><p class="meta-line">중간에 멈춰도 돼요. ${redo ? "이미 선생님이 정한 점수는 바뀌지 않아요. " : ""}AI 사용 약 ${est}번(이 수업 한도 ${d.aiCap}번 중 ${d.aiUsed}번 씀).</p>`, "채점 시작", "취소"))) return;
  st.batch = { running: true, done: 0, total: targets.length, label: "", stop: false };
  let fail = 0;
  render();
  for (const t of targets) {
    if (st.batch.stop) break;
    st.batch.label = t.name; render();
    try { await call("assessAi")({ code: st.code, action: "score", kind: t.kind, id: t.id }); }
    catch (e) { fail++; if (/한도/.test(errMsg(e))) { toast(errMsg(e), true); break; } }
    st.batch.done++;
  }
  const stopped = st.batch.stop, done = st.batch.done;
  st.batch = null;
  try {
    if (applyAfter && done) { const r = (await call("assess")({ code: st.code, action: "applyAi", all: true })).data; toast(`${stopped ? "멈췄어요. " : ""}AI 채점 ${done}곳 끝 · ${how === "auto" ? `AI가 정한 점수 ${r.applied}개, 선생님이 정할 것 ${r.exceptions}개` : `AI 점수 ${r.applied}개를 채웠어요(확인 전)`}${fail ? ` · ${fail}곳 실패` : ""}`); }
    else toast(`${stopped ? "멈췄어요. " : ""}AI 채점 ${done}곳 끝${fail ? ` · ${fail}곳 실패` : ""}`);
  } catch (e) { toast(errMsg(e), true); }
  st.queue = null; await refresh(); if (st.id) await loadSubject(); render();
}

// 채점 방식 바꾸기: 방식 하나를 서버의 두 설정(assessMode·assessAuto)으로 나눠 저장한다
async function setHow(how) {
  await guard(async () => {
    const cur = st.data.auto || { on: true, calib: false };
    await call("assess")({ code: st.code, action: "config", assessMode: how === "independent" ? "independent" : "ai_first" });
    await call("assess")({ code: st.code, action: "config", assessAuto: { on: how === "auto", calib: cur.calib } });
    st.queue = null; await refresh();
    if (st.id) await loadSubject();
    toast({ auto: "애매한 것만 확인하는 방식이에요", manual: "AI 점수를 하나씩 확인하는 방식이에요", independent: "선생님이 먼저 채점하는 방식이에요" }[how]);
    render();
  });
}
async function setCalib(on) {
  await guard(async () => {
    await call("assess")({ code: st.code, action: "config", assessAuto: { on: true, calib: on } });
    st.queue = null; await refresh(); render();
  });
}
async function startCalib() {
  const c = st.data.calib;
  if (!(await confirmModal(c?.state === "ready" ? "다시 맞춰 볼까요?" : "AI를 내 기준에 맞춰 볼까요?", `<p>샘플로 학생 6명과 학생이 있는 모둠(최대 4개)을 골라요. <b>샘플의 AI 점수는 가려지니</b> 평소처럼 채점해 주세요(약 40~60개, 20~30분). 다 채점하면 AI와 얼마나 맞는지 계산해서 <b>AI가 정해도 되는 항목</b>을 골라요.</p><p class="meta-line">샘플에 매긴 점수는 그대로 최종 점수가 돼요. 결과는 같은 척도표·학교급·주제·심화 설정의 다른 수업에서도 다시 쓰여요.</p>`, "시작", "취소"))) return;
  await guard(async () => {
    const r = (await call("assess")({ code: st.code, action: "calibStart" })).data;
    toast(`샘플로 학생 ${r.students}명·모둠 ${r.groups}개를 골랐어요. 🎯 표시를 채점해 주세요.`);
    st.queue = null; await refresh(); await goCalibSample();
  });
}
async function goCalibSample() {
  const f = st.data.students.find((x) => x.calibSample), g = st.data.groups.find((x) => x.calibSample);
  if (f) await openSubject("student", f.key); else if (g) await openSubject("group", g.id); else { st.view = "score"; render(); }
}
async function confirmAllBtn() {
  const n = st.data.progress.unreviewed;
  if (!(await confirmModal(`AI가 정한 점수 ${n}개를 확정할까요?`, `<p>확정한 점수는 점수를 공개할 때 학생에게 보여요(공개는 ④에서 따로 눌러요).</p><p class="meta-line">아직 직접 정하지 않은 점수(${st.data.queue.exceptions}개)는 확정되지 않아요. 확정한 뒤에도 ① 채점에서 고칠 수 있어요.</p>`, "확정", "취소"))) return;
  await guard(async () => {
    const r = (await call("assess")({ code: st.code, action: "confirmAll" })).data;
    toast(`${r.confirmed}개를 확정했어요`); st.queue = null; await refresh(); if (st.id) await loadSubject(); render();
  });
}
async function bulkCoop() {
  await guard(async () => {
    const r = (await call("assess")({ code: st.code, action: "bulkLevel", criterion: "c62", level: Number($("#as-bulk-lv").value), note: $("#as-bulk-note").value })).data;
    toast(`협력 태도 점수를 ${r.applied}명에게 매겼어요${r.skipped ? ` (산출물을 안 쓴 ${r.skipped}명은 건너뜀)` : ""}`); st.queue = null; await refresh(); render();
  });
}
async function askAi() {
  await guard(async () => {
    const b = root().querySelector("[data-asai]"); if (b) { b.disabled = true; b.textContent = "AI가 채점하는 중…"; }
    try {
      const r = (await call("assessAi")({ code: st.code, action: "score", kind: st.kind, id: st.id })).data;
      toast(`AI 의견을 받았어요 (${r.ok + r.auto}개)${r.failedRuns ? ` · 일부 ${r.failedRuns}번 실패` : ""}`);
      await Promise.all([loadSubject(), refresh()]);
    } finally { render(); }
  });
}

// ---------- 이벤트 ----------
document.addEventListener("click", async (e) => {
  if (!e.target.closest("#as-root")) return;
  const t = (sel) => e.target.closest(sel);
  let b;
  if ((b = t("[data-asv]"))) { goView(b.dataset.asv); if (STEP_VIEWS.includes(b.dataset.asv) && b.closest("#as-body")) window.scrollTo({ top: root().getBoundingClientRect().top + window.scrollY - 70, behavior: "smooth" }); }
  else if ((b = t("[data-asrel]"))) toggleRelease(b.dataset.asrel);
  else if ((b = t("[data-ask]"))) { st.kind = b.dataset.ask; const f = subjList()[0]; st.id = f ? subjId(f) : null; if (st.id) await loadSubject(); else st.sub = null; render(); }
  else if ((b = t("[data-asid]"))) { st.id = b.dataset.asid; await loadSubject(); render(); }
  else if ((b = t("[data-asnext]"))) { st.id = b.dataset.asnext; await loadSubject(); render(); root().querySelectorAll(".sk-root")[1]?.scrollIntoView({ block: "start", behavior: "smooth" }); }
  else if ((b = t("[data-asgo]"))) { const [kind, id] = b.dataset.asgo.split("|"); openSubject(kind, id); }
  else if ((b = t("[data-assave]"))) saveCriterion(b.dataset.assave);
  else if (t("[data-asai]")) askAi();
  else if (t("[data-asbatch]")) batchAi();
  else if (t("[data-qsave]")) qSave(t("[data-qsave]"));
  else if (t("[data-qresolve]")) qResolve(t("[data-qresolve]"));
  else if (t("[data-qmore]")) { const o = (st.queue?.offset || 0) + 12; st.queue = null; loadQueue(o); }
  else if (t("[data-asbulk]")) bulkCoop();
  else if (t("[data-ascalibgo]")) goCalibSample();
  else if (t("[data-ascalib]")) startCalib();
  else if (t("[data-asconfirmall]")) confirmAllBtn();
  else if (t("[data-asresume]")) guard(async () => { await call("assess")({ code: st.code, action: "autoResume" }); await refresh(); render(); toast("AI 자동 확정을 다시 켰어요"); });
  else if (t("[data-asapply]")) applyAiBtn();
  else if (t("[data-asmake]")) makeSeteuk();
  else if (t("[data-asseteuk]")) saveSeteuk();
  else if ((b = t("[data-rcv]"))) {
    const box = b.closest("[data-rc]");
    await guard(async () => {
      await call("assess")({ code: st.code, action: "recheck", op: "save", kind: box.dataset.rk, id: box.dataset.ri, criterion: box.dataset.rc, level: Number(b.dataset.rcv) });
      toast("다시 채점한 결과를 기록했어요");
      st.rel = null; st.recheck = null; render();
    });
  }
});
document.addEventListener("change", async (e) => {
  if (!e.target.closest("#as-root")) return;
  if (e.target.id === "as-blind") { st.blind = e.target.checked; render(); }
  else if (e.target.id === "as-max") {
    await guard(async () => { const r = await call("assess")({ code: st.code, action: "config", seteukMax: Number(e.target.value) }); st.data.seteukMax = r.data.seteukMax; for (const k of Object.values(st.sk)) { k.prep = null; k.gen = null; } toast("분량을 바꿨어요. 초안을 다시 만들면 반영돼요"); render(); });
  }
  else if (e.target.id === "as-emp") st.emphasis = e.target.value;
  else if (e.target.name === "as-how") setHow(e.target.value);
  else if (e.target.id === "as-calib-on") setCalib(e.target.checked);
  else if (e.target.id === "sk-grade" && st.id) { const k = skOf(st.id); k.gradeOverride = e.target.value; k.prep.useGrade = e.target.value; }
  else if (e.target.id === "sk-edit" && st.id) { const k = skOf(st.id); k.editing = e.target.checked; render(); if (k.editing) $("#as-seteuk")?.focus(); }
});
document.addEventListener("input", (e) => {
  if (e.target.id !== "as-seteuk" || !st.id) return;
  const k = skOf(st.id), n = byteLen(e.target.value), el = $("#as-bytes");
  k.text = e.target.value; k.saved = null; // 고치면 저장 배지를 지운다
  if (el) { el.className = `sk-count ${byteCls(n, st.data.seteukMax)}`; el.innerHTML = bytesHtml(n, st.data.seteukMax); }
});
// 수준을 고르면 선택한 칸이 강조되도록 한다(저장 전 미리보기)
document.addEventListener("change", (e) => {
  const r = e.target.closest?.('#as-root input[type="radio"]'); if (!r) return;
  r.closest(".as-lv").querySelectorAll(".lvopt").forEach((l) => l.classList.toggle("cur", l.contains(r)));
});
