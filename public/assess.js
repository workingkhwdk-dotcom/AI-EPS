// 교사 화면 '평가' 탭: 척도표로 채점하고, 채점의 타당도·신뢰도를 점검하고, 세특 초안을 만들고, 점수와 세특을 따로 공개한다.
// 서버(functions/assess.js, index.js 의 assess·assessAi)가 규칙을 지킨다. 이 화면은 그 규칙이 눈에 보이게 하는 역할이다.
//  - 근거 보기: 기준마다 학생이 쓴 글을 그대로 보여 준다. 근거가 없으면 '미제출'만 고를 수 있다.
//  - 독립 채점: AI 제안은 내가 그 기준의 수준을 저장한 뒤에만 보인다.
//  - 익명 채점: 학생을 별명 대신 코드(S-1A2B)로, 모둠과 상관없는 순서로 보여 준다.
import { call, esc, toast, errMsg } from "./fb.js";
import { waitHtml, STEPS } from "./wait.js";
import { confirmModal, showModal } from "./modal.js";

const $ = (s) => document.querySelector(s);
const root = () => $("#as-root");
const st = { code: null, data: null, view: "score", kind: "group", id: null, sub: null, blind: true, sk: {}, emphasis: "balance", recheck: null, rel: null, busy: false, rubricOpen: false, batch: null, queue: null };

// 서버(functions/seteuk.js)와 같은 NEIS 바이트: 한글 3, 그 밖 1
export const byteLen = (str) => { let n = 0; for (let i = 0; i < String(str ?? "").length; i++) { const c = String(str).charCodeAt(i); n += (c >= 0xac00 && c <= 0xd7a3) || (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f) ? 3 : 1; } return n; };
const crit = (cid) => st.data.rubric.criteria.find((c) => c.id === cid);
const critsOf = (kind) => st.data.rubric.criteria.filter((c) => c.scope === (kind === "student" ? "student" : "group"));
const lvlLabel = (c, level) => (level === -1 ? "미제출" : c.levels[level]?.label || "");
const ptsOf = (c, level) => (level === -1 ? 0 : c.levels[level]?.pts ?? 0);
const subjList = () => (st.kind === "group" ? st.data.groups : st.data.students);
const subjId = (x) => (st.kind === "group" ? x.id : x.key);
const subjName = (x) => (st.kind === "group" ? x.name : st.blind ? x.code : `${x.groupId.slice(1)}모둠 ${x.nick}`);
const busy = (html) => `<div class="card">${html || waitHtml({ steps: STEPS.load })}</div>`;

export async function openAssess(code) {
  if (st.code !== code) Object.assign(st, { code, data: null, view: "score", kind: "group", id: null, sub: null, sk: {}, recheck: null, rel: null, queue: null });
  if (!st.data) root().innerHTML = busy();
  try { await refresh(); } catch (e) { root().innerHTML = `<div class="notice">${esc(errMsg(e))}</div>`; return; }
  if (!st.id) { const first = subjList()[0]; st.id = first ? subjId(first) : null; if (st.id) await loadSubject(); }
  if (st.data.auto?.on && st.data.queue.exceptions + st.data.queue.appeals > 0 && st.view === "score") st.view = "queue";
  render();
}

async function refresh() {
  st.data = (await call("assess")({ code: st.code, action: "get" })).data;
}
async function loadSubject() {
  st.sub = null; render();
  try { st.sub = (await call("assess")({ code: st.code, action: "subject", kind: st.kind, id: st.id })).data; }
  catch (e) { toast(errMsg(e), true); }
}

// ---------- 그리기 ----------
function render() {
  if (!st.data) return;
  const d = st.data, p = d.progress;
  root().innerHTML = `
    <div class="card as-head">
      <div class="row" style="justify-content:space-between">
        <div><h3 style="margin:0">수행평가 <span class="tag b">${d.rubric.level === "middle" ? "중학교 척도" : "고등학교 척도"}</span></h3>
          <div class="meta-line">채점 ${p.done} / ${p.total}칸${p.reviewCount ? ` · <span class="tag y">확인 필요 ${p.reviewCount}</span>` : ""} · 만점 ${d.rubric.total}점(개인 ${d.rubric.indivMax} + 모둠 ${d.rubric.total - d.rubric.indivMax})</div></div>
      </div>
      <div class="as-rel">
        ${relBtn("score", "점수", d.release.score)}${relBtn("seteuk", "세특", d.release.seteuk)}
      </div>
      <div class="meta-line" style="margin-top:6px">점수와 세특은 따로 공개해요. 공개하면 학생이 자기 화면의 <b>내 결과</b>에서 보고, 끄면 바로 보이지 않아요.</div>
    </div>
    ${batchHtml()}
    <div class="seg" id="as-views">${[...(d.auto?.on || d.queue?.appeals ? [["queue", `예외 큐${d.queue.exceptions + d.queue.appeals ? ` (${d.queue.exceptions + d.queue.appeals})` : ""}`]] : []), ["score", "채점"], ["seteuk", "세특"], ["reli", "신뢰도 점검"], ["rubric", "척도표"]].map(([k, n]) => `<button data-asv="${k}" class="${st.view === k ? "on" : ""}">${n}</button>`).join("")}</div>
    <div id="as-body">${st.view === "queue" ? queueHtml() : st.view === "score" ? scoreHtml() : st.view === "seteuk" ? seteukHtml() : st.view === "reli" ? reliHtml() : rubricHtml()}</div>`;
  if (st.view === "reli" && !st.rel) loadReli();
  if (st.view === "queue" && !st.queue) loadQueue();
}
// AI 채점 카드: 검토 방식(예외만 검토 · 교정), 일괄 채점·확정, 사용 순서. 확정과 공개는 늘 교사가 직접 누른다.
function batchHtml() {
  const d = st.data, b = st.batch, auto = d.auto?.on, aiFirst = d.mode === "ai_first", q = d.queue || {};
  const gT = d.groups.filter((g) => g.members > 0), todoG = gT.filter((g) => g.ai < d.aiTotal.group).length, todoS = d.students.filter((x) => x.ai < d.aiTotal.student).length;
  const date = (t) => (t ? new Date(t).toLocaleDateString("ko-KR") : "");
  return `<div class="card as-batch">
    <div class="row" style="justify-content:space-between"><h4 style="margin:0">AI로 채점하고, 어려운 칸만 검토</h4>
      ${auto ? "" : `<label class="meta-line">채점 방식 <select id="as-mode"><option value="ai_first" ${aiFirst ? "selected" : ""}>AI가 먼저 → 교사가 검토·수정</option><option value="independent" ${aiFirst ? "" : "selected"}>교사가 먼저 → 그 뒤 AI 제안 (독립 채점)</option></select></label>`}</div>
    <div class="as-auto"><label class="chk"><input type="checkbox" id="as-auto-on" ${auto ? "checked" : ""}> <b>예외만 검토</b> — AI가 3번 독립 채점해 일치하고 근거가 확실한 칸은 확정 후보로, 어려운 칸만 예외 큐로 보내요</label>
      ${auto ? `<label class="chk"><input type="checkbox" id="as-calib-on" ${d.auto.calib ? "checked" : ""}> <b>교정 사용</b> — AI가 내 기준과 맞는지 먼저 확인하고, 통과한 기준만 자동 통과해요(한 번 하면 같은 척도·사건의 다른 수업에서 재사용)</label>` : ""}</div>
    ${auto ? `<div class="as-count"><span class="tag ${q.exceptions ? "y" : ""}">예외 ${q.exceptions}</span><span class="tag ${d.progress.unreviewed ? "b" : ""}">확정 후보 ${d.progress.unreviewed}</span><span class="tag ${q.appeals ? "r" : ""}">이의 제기 ${q.appeals}</span><span class="tag ${q.observation ? "y" : ""}">협력 칸 미채점 ${q.observation}명</span></div>` : ""}
    ${auto && d.autoPaused ? `<div class="notice yellow">감사에서 확정한 점수를 가린 채 다시 채점해 보니 AI와 ${d.audit.exact}%만 맞아(${d.audit.n}칸) <b>자동 통과를 멈췄어요</b>. 새로 채점하는 칸은 모두 예외로 가요. <button class="link" type="button" data-asresume>다시 켜기</button></div>` : ""}
    ${auto && d.auto.calib ? calibHtml(d.calib, date) : ""}
    ${b && b.running ? `<div class="as-prog" role="status"><div><b>AI가 채점하는 중</b> ${b.done} / ${b.total} · ${esc(b.label)}</div><div class="as-bar"><i style="width:${Math.round((b.done / b.total) * 100)}%"></i></div></div>
      <div class="row"><button class="btn btn-plain btn-sm" data-asbatch type="button">${b.stop ? "멈추는 중…" : "멈추기"}</button></div>`
    : `<div class="row" style="margin-top:8px"><button class="btn btn-primary btn-sm" data-asbatch type="button">${todoG + todoS ? `✨ AI로 전체 채점 (모둠 ${todoG} · 학생 ${todoS}명)` : "✨ AI로 전체 다시 채점"}</button>
      ${auto && d.progress.unreviewed ? `<button class="btn btn-tinted btn-sm" data-asconfirmall type="button">✔ 확정 후보 ${d.progress.unreviewed}칸 일괄 확정</button>` : ""}
      ${aiFirst && !auto ? `<label class="chk"><input type="checkbox" id="as-apply" checked> 채점 뒤 AI 점수를 바로 적용(검토 전으로 표시)</label>` : ""}</div>`}
    <details class="as-ev"><summary>사용 순서</summary><ol class="as-steps">
      ${auto
        ? `<li><b>AI로 전체 채점</b>을 눌러요. 모든 모둠·학생을 AI가 3번씩 독립 채점해요(몇 분 걸려요, 멈출 수 있어요).</li>
           ${d.auto.calib ? `<li><b>교정</b>: 표본 학생·모둠을 AI 점수 없이 채점하면, AI가 내 기준과 맞는 기준만 자동 통과를 열어 줘요. 한 번 하면 같은 척도·사건의 다음 수업에서는 건너뛰어요.</li>` : ""}
           <li>채점이 끝나면 통과한 칸은 <b>확정 후보</b>(학생에게 아직 안 보임)로, 어려운 칸은 <b>예외 큐</b>로 가요. 예외 큐에서 이유와 근거를 보고 직접 정해요. 협력 칸은 AI가 못 하니 한꺼번에 적용할 수 있어요.</li>
           <li><b>✔ 확정 후보 일괄 확정</b>을 누르면 확정돼요. 마지막으로 <b>점수 공개하기</b>·<b>세특 공개하기</b>도 직접 눌러요. 학생이 점수에 이의를 제기하면 예외 큐에 나타나요.</li>`
        : aiFirst
        ? `<li><b>AI로 전체 채점</b>을 눌러요. 끝나면 AI 점수가 <b>검토 전</b>으로 적용돼요.</li><li>아래 <b>채점</b>에서 하나씩 열어 근거와 AI 점수를 비교해 맞으면 <b>✓ 확인</b>, 다르면 고쳐서 <b>저장</b>해요. 협력 칸은 직접 채점해요.</li><li><b>세특</b> 탭에서 세특을 만들고, <b>점수 공개하기</b>·<b>세특 공개하기</b>를 눌러요.</li>`
        : `<li>아래 <b>채점</b>에서 먼저 내가 채점해요(AI 점수는 가려져 있어요).</li><li>수준을 저장하면 그 칸의 AI 제안이 보여요. 크게 다르면 평가 근거를 써요.</li>`}
      <li class="meta-line">AI 채점은 대상마다 AI를 ${d.aiRuns}번 부르고, 갈리는 기준만 고성능 모델이 한 번 더 판정해요. 앞부분이 모두 같아 AI 서비스의 자동 캐시로 입력 요금이 줄어요. 이 수업의 AI 사용 ${d.aiUsed} / ${d.aiCap}회.</li>
    </ol></details></div>`;
}
// 교정 패널: 표본을 AI 점수 없이 채점 → 일치도로 기준마다 자동 통과 여부를 정하고 결과를 재사용한다
function calibHtml(c, date) {
  if (!c) return "";
  if (c.state === "none") return `<div class="as-calib"><b>교정이 아직 없어요.</b> 지금은 모든 칸이 예외 큐로 가요. 교정을 하면 AI와 내가 같게 채점한 기준만 자동 통과를 쓸 수 있어요. <div class="row" style="margin-top:6px"><button class="btn btn-tinted btn-sm" data-ascalib type="button">교정 시작</button></div></div>`;
  if (c.state === "collecting") return `<div class="as-calib"><b>교정 중</b> — <span class="tag b">🎯 교정 표본</span>으로 표시된 학생 ${c.sampleSize ? "" : ""}·모둠을 <b>AI 점수 없이</b> 채점해 주세요(채점 목록에서 고르세요). 표본을 모두 채점하면 자동으로 결과가 나와요. 표본의 AI 점수는 가려져 있어요.</div>`;
  const per = c.perCriterion || {};
  return `<div class="as-calib ok"><b>교정 완료</b> ${c.reused ? `· 다른 수업(${esc(c.from)})에서 ${date(c.t)}에 한 교정을 <b>재사용</b> 중` : `· ${date(c.t)}`} · 자동 통과 가능한 기준 <b>${c.passed} / ${c.total}</b>
    ${c.overall ? `<span class="meta-line">(표본 ${c.overall.n}칸 · 일치율 ${fmtN(c.overall.exact, "%")} · 카파 ${fmtN(c.overall.kappa)})</span>` : ""}
    <details class="as-ev"><summary>기준별 결과</summary><div class="chipbar">${Object.entries(per).map(([id, x]) => { const cr = st.data.rubric.criteria.find((y) => y.id === id); return `<span class="chip sm ${x.pass ? "on" : ""}" title="비교 ${x.n}칸 · 일치율 ${fmtN(x.exact, "%")}">${esc(cr?.name || id)} ${x.pass ? "✓" : `✗ ${x.n}칸`}</span>`; }).join("")}</div>
    <div class="meta-line">✗ 표시는 비교 표본이 모자라거나(학생 기준은 3칸, 모둠 기준은 표본 모둠 수만큼·최소 1칸) AI와 덜 맞은 기준이에요(그 기준은 계속 예외 큐로 가요). 표본 모둠이 하나뿐이면 1칸 비교라 거칠어요. 척도표나 사건·심화 설정을 바꾸면 다시 교정해요.</div></details>
    <div class="row" style="margin-top:6px"><button class="btn btn-plain btn-sm" data-ascalib type="button">다시 교정</button></div></div>`;
}
const relBtn = (k, name, on) => `<div class="as-rel-item ${on ? "on" : ""}"><span class="tag ${on ? "" : "x"}">${name} ${on ? "공개 중" : "비공개"}</span>
  <button class="btn ${on ? "btn-plain" : "btn-primary"} btn-sm" data-asrel="${k}" type="button">${name} ${on ? "공개 끄기" : "공개하기"}</button></div>`;

function pickerHtml() {
  const list = subjList();
  const sorted = st.kind === "student" && st.blind ? [...list].sort((a, b) => a.code.localeCompare(b.code)) : list;
  return `<div class="row" style="margin-bottom:8px"><div class="seg" style="margin:0"><button data-ask="group" class="${st.kind === "group" ? "on" : ""}">모둠 칸(${st.data.groups[0]?.total || 0}개)</button><button data-ask="student" class="${st.kind === "student" ? "on" : ""}">개인 칸(${st.data.students[0]?.total || 0}개)</button></div>
      ${st.kind === "student" ? `<label class="chk"><input type="checkbox" id="as-blind" ${st.blind ? "checked" : ""}> 익명 채점</label>` : ""}</div>
    <div class="chipbar as-pick">${sorted.map((x) => `<button class="chip sm ${subjId(x) === st.id ? "on" : ""}" data-asid="${esc(subjId(x))}">${x.calibSample ? "🎯 " : ""}${esc(subjName(x))}${x.exc ? ` <span class="tag y">예외 ${x.exc}</span>` : ""} <span class="as-n">${x.scored}/${x.total}</span></button>`).join("") || `<span class="meta-line">아직 대상이 없어요.</span>`}</div>
    ${st.kind === "student" && st.blind ? `<div class="meta-line" style="margin-top:6px">익명 채점: 별명 대신 코드로 보여 줘요. 같은 모둠이라도 순서를 섞어 먼저 본 학생에게 끌리지 않게 해요.</div>` : ""}`;
}

function scoreHtml() {
  const d = st.data;
  const head = `<div class="card">${pickerHtml()}</div>`;
  if (!st.id) return head;
  if (!st.sub) return head + busy();
  const s = st.sub, cs = critsOf(st.kind);
  const gotAi = cs.some((c) => c.ai && s.hasAi[c.id]);
  const calibNote = s.calibSample ? `<div class="notice muted" style="margin:8px 0 0">🎯 교정 표본이에요. AI 점수를 가린 채 채점해 주세요. 표본을 모두 채점하면 AI와 얼마나 맞는지 자동으로 계산해요.</div>` : "";
  const total = cs.reduce((n, c) => n + (s.scores[c.id] ? s.scores[c.id].pts : 0), 0), maxT = cs.reduce((n, c) => n + c.max, 0), done = cs.filter((c) => s.scores[c.id]).length;
  return head + `<div class="card as-sub">
    <div class="row" style="justify-content:space-between"><div><h3 style="margin:0">${esc(subjLabel())}</h3><div class="meta-line">채점 ${done}/${cs.length}칸 · 지금까지 ${total} / ${maxT}점</div></div>
      <div class="row"><button class="btn btn-tinted btn-sm" data-asai type="button" ${st.busy ? "disabled" : ""}>${gotAi ? "AI 다시 채점" : "AI 채점"}</button>
        ${d.mode === "ai_first" && cs.some((c) => c.ai && s.ai[c.id] && !s.scores[c.id]) ? `<button class="btn btn-primary btn-sm" data-asapply type="button" ${st.busy ? "disabled" : ""}>AI 점수 모두 적용</button>` : ""}</div></div>
    ${calibNote}<div class="meta-line" style="margin:6px 0 2px">${s.mode === "ai_first" ? "AI 점수가 미리 골라져 있어요. <b>근거를 보고 맞으면 ✓ 확인, 다르면 고쳐서 저장</b>해요." : "AI 제안은 <b>내가 그 기준의 수준을 저장한 뒤에만</b> 보여요(먼저 보면 AI 의견에 끌려요)."}</div></div>`
    + cs.map((c) => criterionHtml(c, s)).join("");
}
function subjLabel() {
  const x = subjList().find((y) => subjId(y) === st.id);
  return x ? subjName(x) : "";
}

function criterionHtml(c, s) {
  const sc = s.scores[c.id], ai = s.ai[c.id], ev = s.evidence[c.id] || [], empty = s.empty[c.id], rv = s.review[c.id];
  // AI가 먼저 채점하는 방식에서는 아직 채점하지 않은 칸에 AI 수준을 미리 골라 둔다(교사가 근거를 보고 확인하거나 고친다)
  const pre = !sc && s.mode === "ai_first" && ai && Number.isInteger(ai.level) ? ai.level : null;
  const cur = sc ? sc.level : pre;
  const unrev = sc && sc.src === "ai" && sc.reviewed === false;
  const lv = (idx, label, pts, desc, dis) => `<label class="lvopt ${cur === idx ? "cur" : ""}"><input type="radio" name="lv-${c.id}" value="${idx}" ${cur === idx ? "checked" : ""} ${dis ? "disabled" : ""}>
      <span class="lvh"><b>${esc(label)}</b> <span class="tag b">${pts}점</span></span><span class="lvd">${esc(desc)}</span></label>`;
  return `<div class="card as-crit" data-cid="${c.id}">
    <div class="row" style="justify-content:space-between"><h4 style="margin:0">${esc(c.elName)} › ${esc(c.name)} <span class="tag x">${c.max}점</span> <span class="tag x">${esc(c.stage)}</span></h4>${sc ? `<span class="tag ${unrev ? "y" : ""}">${esc(lvlLabel(c, sc.level))} ${sc.pts}점 · ${unrev ? "AI 점수 · 검토 전" : sc.src === "ai" ? "AI 그대로 ✓" : sc.src === "edited" ? "교사 수정" : "교사 채점"}</span>` : pre !== null ? `<span class="tag b">AI 제안 ${esc(lvlLabel(c, pre))} ${ptsOf(c, pre)}점 · 검토 전</span>` : `<span class="tag y">채점 전</span>`}</div>
    ${c.deepNotes.length ? `<div class="notice muted" style="margin:8px 0 0">심화 활동: ${c.deepNotes.map(esc).join(" ")}</div>` : ""}
    <details class="as-ev" open><summary>학생이 쓴 근거 ${empty ? `<span class="tag r">근거 없음 → 미제출만 선택</span>` : `<span class="meta-line">(${ev.length}개)</span>`}</summary>
      ${ev.length ? ev.map((e) => `<div class="logline"><div class="q">${esc(e.label)}</div><div class="a">${esc(e.text)}</div></div>`).join("") : `<div class="meta-line">기록이 없어요.</div>`}</details>
    <div class="as-lv">${c.levels.map((l) => lv(l.idx, l.label, l.pts, l.desc, empty)).join("")}${lv(-1, "미제출", 0, "근거가 비어 있어 평가할 수 없음", !empty)}</div>
    <label class="lbl" for="note-${c.id}">평가 근거 <span class="meta-line">(점수를 공개하면 학생에게 보여요. 가장 높은·낮은 수준, 또는 AI 제안과 두 수준 이상 다르면 8자 이상 꼭 써요)</span></label>
    <textarea id="note-${c.id}" maxlength="500" rows="2" placeholder="예) 세 가지를 모두 알아냈고 인물의 말을 근거로 씀">${esc(sc?.note ?? (pre !== null && ai?.reason ? `AI 제안: ${ai.reason}` : ""))}</textarea>
    <div class="row" style="margin-top:8px"><button class="btn btn-primary btn-sm" data-assave="${c.id}" type="button">${unrev || (pre !== null) ? "✓ 확인·저장" : "저장"}</button>
      ${sc && !unrev ? `<span class="meta-line">저장됨${sc.revs?.length ? ` · 고친 기록 ${sc.revs.length}번` : ""}</span>` : ""}</div>
    ${aiHtml(c, sc, ai, rv, s.hasAi[c.id], s.mode)}</div>`;
}
function aiHtml(c, sc, ai, rv, has, mode) {
  if (!c.ai) return `<div class="meta-line" style="margin-top:8px">이 기준은 교사 관찰로만 채점해요(AI 제안 없음).</div>`;
  if (!sc && !ai) return has ? `<div class="meta-line" style="margin-top:8px">🔒 AI 제안이 준비돼 있어요. 수준을 저장하면 보여요.</div>` : mode === "ai_first" ? `<div class="meta-line" style="margin-top:8px">아직 AI 채점 전이에요. 위 <b>AI 채점</b>을 눌러요.</div>` : "";
  if (!ai) return "";
  if (!sc) sc = { level: ai.level };
  if (ai.auto) return `<div class="meta-line" style="margin-top:8px">AI 제2평정: 학생이 쓴 근거가 비어 있어 미제출로 봤어요.</div>`;
  const same = ai.level === sc.level, near = Math.abs(rank(c, ai.level) - rank(c, sc.level)) === 1;
  return `<div class="as-ai ${same ? "same" : rv ? "dev" : near ? "near" : "dev"}">
    <div><b>AI 제2평정</b> ${esc(lvlLabel(c, ai.level))} ${ptsOf(c, ai.level)}점 · ${ai.n}번 채점: ${ai.levels.map((l) => esc(lvlLabel(c, l))).join(" / ")}
      ${ai.esc ? `<span class="tag b">고성능 재판정${ai.escFailed ? " 실패" : ""}</span>` : ""}${ai.spread ? `<span class="tag y">빠른 모델 3번이 갈렸어요</span>` : `<span class="tag">${ai.n}회 일치</span>`}
      ${ai.auto ? "" : ai.quoteOk ? `<span class="tag b">인용 확인됨</span>` : `<span class="tag r">인용문을 근거에서 못 찾음</span>`}
      <span class="tag ${same ? "" : "y"}">${same ? (mode === "ai_first" ? "AI 제안" : "내 채점과 같음") : near ? "한 수준 차이" : "두 수준 이상 차이"}</span></div>
    ${ai.reason ? `<div class="meta-line">${esc(ai.reason)}</div>` : ""}${ai.quote ? `<div class="meta-line">인용: “${esc(ai.quote)}”</div>` : ""}
    ${rv ? `<div class="notice yellow" style="margin:8px 0 0">AI 제안과 두 수준 이상 달라요. 수준을 다시 살펴보거나, 그대로면 평가 근거를 8자 이상 써서 저장해 주세요.</div>` : ""}
    <div class="meta-line">AI 점수는 제안이에요. 최종 판단은 교사가 해요.</div></div>`;
}
const rank = (c, level) => (level === -1 ? c.levels.length : level);

// ---------- 예외 큐 ----------
// AI가 통과시키지 못한 칸(이유 표시)과 학생의 이의 제기. 교사는 여기만 보면 된다.
async function loadQueue(offset = 0) {
  try { st.queue = (await call("assess")({ code: st.code, action: "queue", offset })).data; } catch (e) { toast(errMsg(e), true); st.queue = { items: [], total: 0, offset: 0, appeals: 0 }; }
  if (st.view === "queue") render();
}
function queueHtml() {
  const q = st.queue, d = st.data;
  if (!q) return busy();
  const obs = d.queue.observation;
  const bulk = obs ? `<div class="card as-bulk"><h4 style="margin:0 0 4px">협력 칸(교사 관찰) 일괄 적용</h4><div class="meta-line">AI가 채점하지 못하는 칸이에요. 학생 ${obs}명에게 같은 수준을 한꺼번에 적용해요(산출물을 한 건도 쓰지 않은 학생은 건너뛰니 따로 봐 주세요).</div>
    <div class="row" style="margin-top:8px"><select id="as-bulk-lv">${crit("c62").levels.map((l) => `<option value="${l.idx}" ${l.idx === 1 ? "selected" : ""}>${esc(l.label)} ${l.pts}점</option>`).join("")}</select>
      <input type="text" id="as-bulk-note" maxlength="100" placeholder="평가 근거 (예: 모둠 활동에 고르게 참여함)" style="flex:1;min-width:160px"><button class="btn btn-tinted btn-sm" data-asbulk type="button">적용</button></div></div>` : "";
  if (!q.items.length) return bulk + `<div class="card"><div class="notice green" style="margin:0">처리할 예외나 이의 제기가 없어요. ${d.progress.unreviewed ? "위의 <b>✔ 확정 후보 일괄 확정</b>을 눌러 확정하세요." : "점수·세특을 공개해도 좋은지 확인하세요."}</div></div>`;
  return bulk + `<div class="meta-line" style="margin:0 2px 8px">${q.total}건 중 ${q.offset + 1}~${q.offset + q.items.length}번째예요. 처리하면 목록에서 사라져요.</div>` + q.items.map(queueCard).join("")
    + (q.offset + q.items.length < q.total ? `<div class="row"><button class="btn btn-plain btn-sm" data-qmore type="button">다음 ${Math.min(12, q.total - q.offset - q.items.length)}건 보기</button></div>` : "");
}
function queueCard(it) {
  const who = it.kind === "group" ? it.code : st.blind ? it.code : `${(it.groupId || "").slice(1)}모둠 ${it.nick}`;
  const ai = it.ai, pre = it.score ? it.score.level : ai && Number.isInteger(ai.level) ? ai.level : null;
  const key = `${it.kind}|${it.id}|${it.cid}`;
  return `<div class="card as-crit q-card" data-q="${esc(key)}" data-via="${esc(it.via || "")}">
    <div class="row" style="justify-content:space-between"><h4 style="margin:0">${it.type === "appeal" ? `<span class="tag r">이의 제기</span> ` : `<span class="tag y">예외</span> `}${esc(who)} › ${esc(it.el)} › ${esc(it.name)}</h4>${it.score ? `<span class="tag">현재 ${esc(lvlLabelL(it.levels, it.score.level))} ${it.score.pts}점</span>` : ""}</div>
    ${it.appeal ? `<div class="notice yellow" style="margin:8px 0 0">학생의 이의: “${esc(it.appeal.text)}”</div>` : ""}
    ${it.reasons.length ? `<div class="as-why">${it.reasons.map((r) => `<span class="tag y">${esc(r)}</span>`).join(" ")}</div>` : ""}
    <details class="as-ev" open><summary>학생이 쓴 근거 ${it.empty ? `<span class="tag r">근거 없음</span>` : `<span class="meta-line">(${(it.evidence || []).length}개)</span>`}</summary>
      ${(it.evidence || []).length ? it.evidence.map((e) => `<div class="logline"><div class="q">${esc(e.label)}</div><div class="a">${esc(e.text)}</div></div>`).join("") : `<div class="meta-line">기록이 없어요.</div>`}</details>
    ${ai && !ai.auto ? `<div class="as-ai"><b>AI</b> ${esc(lvlLabelL(it.levels, ai.level))} · ${ai.n}번 채점: ${ai.levels.map((l) => esc(lvlLabelL(it.levels, l))).join(" / ")}${ai.esc ? ` <span class="tag b">고성능 재판정</span>` : ""}${ai.spread ? ` <span class="tag y">갈렸어요</span>` : ""}${ai.reason ? `<div class="meta-line">${esc(ai.reason)}</div>` : ""}${ai.quote ? `<div class="meta-line">인용: “${esc(ai.quote)}”</div>` : ""}</div>` : ""}
    <div class="as-lv">${[...it.levels.map((l) => [l.idx, l.label, l.pts, l.desc]), [-1, "미제출", 0, "근거가 비어 있어 평가할 수 없음"]].map(([idx, label, pts, desc]) => `<label class="lvopt ${pre === idx ? "cur" : ""}"><input type="radio" name="q-${esc(key)}" value="${idx}" ${pre === idx ? "checked" : ""} ${(idx === -1) !== !!it.empty ? "disabled" : ""}><span class="lvh"><b>${esc(label)}</b> <span class="tag b">${pts}점</span></span><span class="lvd">${esc(desc)}</span></label>`).join("")}</div>
    <textarea class="q-note" maxlength="500" rows="2" placeholder="평가 근거 (점수를 공개하면 학생에게 보여요)">${esc(it.score?.note ?? (ai?.reason && !ai.auto ? `AI 제안: ${ai.reason}` : ""))}</textarea>
    <div class="row" style="margin-top:8px"><button class="btn btn-primary btn-sm" data-qsave type="button">✓ 정하기</button>
      ${it.type === "appeal" ? `<input type="text" class="q-reply" maxlength="300" placeholder="학생에게 보낼 답(선택)" style="flex:1;min-width:140px"><button class="btn btn-tinted btn-sm" data-qresolve type="button">이의 처리 완료</button>` : ""}</div></div>`;
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
    toast("이의 제기를 처리했어요"); st.queue = null; await refresh(); render();
  });
}

// ---------- 세특 ----------
// 순서: ① 근거 확인 → ② 수준 판정(빈약하면 하향·유지·취소) → ④ 기승전결 초안 → ⑤ 분량 보정 → ⑥ 검토·직접 수정·저장.
const GRADE_CLS = { S: "s", A: "a", B: "b", C: "c" };
const EMP = [["balance", "균형"], ["academic", "학업역량"], ["leader", "리더십"], ["character", "인성"], ["growth", "성장잠재력"]];
const PART_NAME = { 기: "기 · 문제의식", 승: "승 · 과정", 전: "전 · 발견", 결: "결 · 성찰" };
const skOf = (id) => (st.sk[id] = st.sk[id] || { prep: null, gen: null, text: null, editing: false, saved: null, msg: "" });
const byteCls = (n, max) => (n > max ? "over" : n > max * 0.9 ? "warn" : "ok");

function seteukHtml() {
  const d = st.data, list = d.students;
  if (st.kind !== "student") { st.kind = "student"; st.id = list[0]?.key || null; st.sub = null; if (st.id) loadSubject(); }
  const cur = list.find((x) => x.key === st.id);
  return `<div class="card sk-root"><div class="row" style="justify-content:space-between"><h3 style="margin:0">세특 만들기</h3>
      <div class="row"><label class="meta-line">강조 관점 <select id="as-emp">${EMP.map(([k, n]) => `<option value="${k}" ${st.emphasis === k ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      <label class="meta-line">글자 수 한도 <select id="as-max">${[1000, 1500, 2000].map((n) => `<option value="${n}" ${d.seteukMax === n ? "selected" : ""}>${n}바이트(약 ${Math.round(n / 3)}자)</option>`).join("")}</select></label></div></div>
    <div class="meta-line">학생이 쓴 활동만 근거로 쓰고, 기승전결로 이어지는 한 문단을 만들어요. 순서는 <b>근거 확인 → 수준 판정 → 초안 → 분량 보정(NEIS 바이트) → 검토·저장</b>이에요. 초안은 참고용이니 꼭 읽고 고치세요.</div>
    <div class="chipbar as-pick" style="margin-top:10px">${list.map((x) => `<button class="chip sm ${x.key === st.id ? "on" : ""}" data-asid="${esc(x.key)}">${esc(`${x.groupId.slice(1)}모둠 ${x.nick}`)} ${x.hasSeteuk ? "✓" : ""}</button>`).join("") || `<span class="meta-line">학생이 없어요.</span>`}</div></div>
    ${cur ? studentSeteukHtml(cur) : ""}`;
}
function studentSeteukHtml(cur) {
  const d = st.data, k = skOf(st.id);
  const saved = st.sub?.seteuk?.text || "";
  if (k.text === null) k.text = saved;
  const bytes = byteLen(k.text), max = d.seteukMax;
  return `<div class="card sk-root"><h4 style="margin:0 0 6px">${esc(`${cur.groupId.slice(1)}모둠 ${cur.nick}`)}</h4>
    <div class="row"><button class="btn btn-primary btn-sm" data-asmake type="button" ${st.busy ? "disabled" : ""}>${k.gen || k.prep ? "✨ 다시 만들기" : "✨ 세특 만들기"}</button>
      ${st.busy && k.msg ? `<span class="sk-msg" role="status">${esc(k.msg)}</span>` : ""}</div>
    ${k.prep ? prepHtml(k.prep) : ""}
    ${k.gen ? structureHtml(k.gen) : ""}
    <div class="sk-head"><label class="lbl" for="as-seteuk" style="margin:0">세특 본문</label>
      <span class="sk-count ${byteCls(bytes, max)}" id="as-bytes"><b>${bytes.toLocaleString()}</b><small> / ${max.toLocaleString()} byte</small></span>
      <label class="sk-sw"><input type="checkbox" id="sk-edit" ${k.editing ? "checked" : ""}><span class="sk-track"><span class="sk-thumb"></span></span><span>✏️ 직접 수정</span></label></div>
    ${k.editing ? `<div class="sk-hint">수정 중이에요. 저장하면 이 글이 확정본이 돼요.</div>` : ""}
    <textarea id="as-seteuk" class="sk-text ${k.editing ? "on" : ""}" rows="9" ${k.editing ? "" : "readonly"} placeholder="✨ 세특 만들기를 누르거나, 수정 스위치를 켜고 직접 써요">${esc(k.text)}</textarea>
    <div class="row" style="justify-content:space-between;margin-top:8px"><span id="as-sw">${warnHtml(k)}</span>
      <div class="row">${k.saved ? `<span class="sk-saved">✅ 서버에 저장됨 (${k.saved.toLocaleString()} byte)</span>` : saved && k.text === saved ? `<span class="sk-saved">✅ 저장된 확정본</span>` : ""}<button class="btn btn-primary btn-sm" data-asseteuk type="button">💾 저장</button></div></div></div>`;
}
const warnHtml = (k) => (k.warnings || []).map((w) => `<div class="sk-warn">⚠️ ${esc(w)}</div>`).join("");

function prepHtml(p) {
  const susp = p.suspicion.level;
  return `<div class="sk-prep"><div class="sk-prep-h"><span class="sk-badge g-${GRADE_CLS[p.grade]}">수준 ${p.grade}</span>
      <span class="meta-line">5개 기준 가중 평균 ${p.gradeScore} / 4 · 근거 ${p.evidenceCount}개(${p.inputBytes.toLocaleString()} byte) · 본문에는 등급 이름을 쓰지 않고 표현의 밀도로만 반영해요</span>
      <label class="meta-line">등급 조정 <select id="sk-grade">${["S", "A", "B", "C"].map((g) => `<option ${(p.useGrade || p.grade) === g ? "selected" : ""}>${g}</option>`).join("")}</select></label></div>
    <div class="sk-crit">${p.criteria.map((c) => `<span class="sk-pill g-${GRADE_CLS[c.grade]}" title="${esc(c.reason)}">${esc(c.label)} ${c.grade}${c.ai_suspicion !== "낮음" ? ` 🤖${c.ai_suspicion}` : ""}</span>`).join("")}</div>
    ${susp !== "낮음" ? `<div class="sk-warn">🤖 AI 작성 의심 ${susp}: 내용이 추상적이거나 기계적인 문체가 보여요. 학생 원자료를 직접 확인해 보세요. 이 판정만으로 학생에게 불이익을 주지 마세요.</div>` : ""}
    ${p.richness.isPoor ? `<div class="sk-warn">⚠️ 근거가 빈약해요: ${p.richness.issues.map(esc).join(", ") || "목표 분량에 비해 적음"}</div>` : ""}
    ${p.needsAdjustment ? `<div class="meta-line">목표 ${p.target.toLocaleString()}바이트 대신 재료에 맞는 분량은 약 ${p.suggestedMax.toLocaleString()}바이트예요.</div>` : ""}</div>`;
}
function structureHtml(g) {
  return `<div class="sk-struct"><div class="sk-struct-h">기승전결 구조 <span class="meta-line">(초안 기준 · 직접 고치면 맞지 않을 수 있어요)</span></div>
    ${g.parts.map((p) => `<div class="sk-part p-${p.part}"><b>${PART_NAME[p.part]}</b><span>${p.sentences.length ? p.sentences.map((x) => esc(x.text)).join(" ") : `<i>비어 있음</i>`}</span></div>`).join("")}
    <div class="meta-line">📏 분량 보정: ${g.log.map((t) => t.bytes).join(" → ")} byte · ${esc(g.reason)} · 목표 ${g.target.toLocaleString()} byte · AI ${g.calls}회${g.models ? `(고성능 ${g.models.strong}·빠른 모델 ${g.models.fast})` : ""}${g.dropped.length ? ` · 뺀 문장 ${g.dropped.length}개(${g.dropped.map((x) => esc(x.why)).join(", ")})` : ""}</div>
    <details class="as-ev"><summary>문장별 근거 보기</summary>${g.parts.flatMap((p) => p.sentences).map((x) => `<div class="logline"><div class="q">${esc(x.text)}</div><div class="a">${x.evidence.map((id) => `· ${esc(g.evidence[id]?.label || id)}: ${esc(g.evidence[id]?.text || "")}`).join("\n")}</div></div>`).join("")}</details></div>`;
}

const SK_STEPS = ["📄 학생이 쓴 근거를 확인하는 중…", "🔍 수준을 판정하는 중…", "✨ 기승전결로 기록을 쓰는 중…", "📏 분량(NEIS 바이트)을 맞추는 중…", "📏 목표 범위에 맞게 다듬는 중…"];
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
      k.prep.useGrade = k.prep.grade;
      render();
      let decision;
      if (k.prep.needsAdjustment) {
        decision = await showModal({
          title: "근거가 목표 분량에 비해 적어요",
          body: `<p>학생이 쓴 활동 기록이 목표 <b>${k.prep.target.toLocaleString()}바이트</b>를 사실대로 채우기엔 부족해요.</p><ul>${k.prep.richness.issues.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
            <p><b>낮추기</b>는 학생이 쓴 내용만으로 약 ${k.prep.suggestedMax.toLocaleString()}바이트까지 쓰고, 모자라도 채우지 않아요.<br><b>유지</b>는 분량을 맞추려 자연스러운 보완을 허용해요(학생이 쓴 주제와 방향을 벗어나는 창작은 막지만, 내용을 부풀릴 수 있어요).</p>`,
          actions: [{ label: `낮추기 (약 ${k.prep.suggestedMax.toLocaleString()}B) · 권장`, value: "lower", kind: "btn-primary" }, { label: "원래 목표 유지", value: "keep" }, { label: "취소", value: "cancel" }], grid: true,
        });
        if (!decision || decision === "cancel") { toast("취소했어요. 판정 결과는 남아 있어요."); return; }
      }
      let n = 2; say(SK_STEPS[2]);
      timer = setInterval(() => say(SK_STEPS[Math.min(n++, SK_STEPS.length - 1)]), 9000);
      const grade = k.prep.useGrade;
      const r = (await call("assessAi")({ code: st.code, action: "seteukGenerate", kind: "student", id, decision, emphasis: st.emphasis, grade })).data;
      if (r.cancelled) return;
      k.gen = r; k.text = r.text; k.warnings = r.warnings;
      toast(`세특 초안을 만들었어요 (${r.bytes} byte · ${r.reason})`);
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

// ---------- 신뢰도 점검 ----------
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
  const T = r.thresholds, o = r.overall;
  const card = (title, big, sub, ok) => `<div class="as-stat ${ok === false ? "bad" : ok ? "ok" : ""}"><div class="meta-line">${title}</div><div class="big">${big}</div><div class="meta-line">${sub}</div></div>`;
  const okEnough = o.n >= T.minPairs;
  return `<div class="card"><h3>채점이 믿을 만한지 점검</h3>
    <div class="meta-line">타당도는 척도·근거·독립 채점 규칙으로, 신뢰도는 아래 지표로 점검해요. 일치도는 <b>교사와 AI가 같은 수준을 골랐는지</b>를 보는 거라, 높다고 옳은 건 아니고 낮으면 다시 살펴볼 신호예요. AI 점수를 보고 정한 칸은 독립 채점이 아니어서 일치도에서 빼고, 대신 <b>수정률</b>과 <b>재채점 표본</b>으로 점검해요.</div>
    ${(r.warnings || []).map((w) => `<div class="notice yellow" style="margin-top:10px">${esc(w)}</div>`).join("") || `<div class="notice green" style="margin-top:10px">지금 기준에서 걸리는 경고는 없어요.</div>`}
    <div class="as-stats">
      ${card("교사–AI 일치율", fmtN(o.exact, "%"), `${o.n}칸 비교 · 기준 ${T.exact}% 이상`, okEnough ? o.exact >= T.exact : undefined)}
      ${card("한 수준 이내", fmtN(o.adjacent, "%"), `기준 ${T.adjacent}% 이상`, okEnough ? o.adjacent >= T.adjacent : undefined)}
      ${card("가중 카파", fmtN(o.kappa), `기준 ${T.kappa} 이상(우연 일치를 뺀 값)`, okEnough && o.kappa !== null ? o.kappa >= T.kappa : undefined)}
      ${card("내 채점 경향", o.bias === null ? "—" : o.bias > 0.1 ? "후한 편" : o.bias < -0.1 ? "엄격한 편" : "비슷함", `AI보다 평균 ${fmtN(o.bias)}수준`, okEnough && o.bias !== null ? Math.abs(o.bias) < T.bias : undefined)}
      ${card("AI 반복 일치", fmtN(r.self.same, "%"), `${r.self.n}칸 · 기준 ${T.selfConsistency}% 이상`, r.self.n >= T.minPairs ? r.self.same >= T.selfConsistency : undefined)}
      ${card("AI 점수 수정률", fmtN(r.edit.rate, "%"), `적용한 ${r.edit.same + r.edit.changed}칸 중 ${r.edit.changed}칸 고침`, r.edit.same + r.edit.changed >= T.minPairs ? r.edit.changed > 0 && r.edit.rate <= 50 : undefined)}
      ${card("내 재채점 일치", fmtN(r.recheck.exact, "%"), `${r.recheck.n}칸 · 기준 ${T.recheckExact}% 이상`, r.recheck.n >= 5 ? r.recheck.exact >= T.recheckExact : undefined)}
    </div></div>
    ${rechecksHtml()}
    <div class="card"><h4 style="margin:0 0 6px">기준별 교사–AI 일치</h4><div class="tbl-wrap"><table class="tbl"><thead><tr><th>기준</th><th>비교</th><th>일치율</th><th>한 수준 이내</th><th>가중 카파</th></tr></thead><tbody>
      ${r.byCriterion.map((x) => `<tr><td>${esc(x.name)}</td><td>${x.n}</td><td>${fmtN(x.exact, "%")}</td><td>${fmtN(x.adjacent, "%")}</td><td>${fmtN(x.kappa)}</td></tr>`).join("")}</tbody></table></div></div>
    <div class="card"><h4 style="margin:0 0 6px">기준별 점수 분포(만점 대비 %)</h4><div class="meta-line">평균이 너무 높거나 낮거나 표준편차가 거의 0이면, 기준이 학생을 가르지 못하는 것일 수 있어요.</div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>기준</th><th>채점 수</th><th>평균</th><th>표준편차</th></tr></thead><tbody>
      ${r.distribution.map((x) => `<tr><td>${esc(x.name)}</td><td>${x.n}</td><td>${fmtN(x.mean, "%")}</td><td>${fmtN(x.sd, "%")}</td></tr>`).join("")}</tbody></table></div></div>
    <div class="card"><h4 style="margin:0 0 6px">모둠별 모둠 칸 점수 합계</h4><div class="chipbar">${r.groups.map((g) => `<span class="chip sm">${esc(g.name)} ${g.group}점</span>`).join("")}</div></div>`;
}
function rechecksHtml() {
  const rc = st.recheck;
  if (!rc) return "";
  const head = `<div class="card"><h4 style="margin:0 0 6px">재채점 표본 <span class="meta-line">(내 일관성 점검)</span></h4>
    <div class="meta-line">이미 채점한 칸 중 일부(약 1/5)를 첫 채점 결과를 가린 채 다시 채점해요. 채점하고 하루쯤 지난 뒤에 하면 더 정확해요.</div>`;
  if (!rc.items.length) return head + `<div class="notice muted" style="margin-top:10px">${rc.left ? "" : "지금 다시 채점할 표본이 없어요."}</div></div>`;
  return head + `<div class="meta-line">남은 표본 ${rc.left}칸 중 ${rc.items.length}칸을 보여 줘요.</div>` + rc.items.map((it) => {
    const c = crit(it.criterion);
    return `<div class="as-rc" data-rk="${esc(it.kind)}" data-ri="${esc(it.id)}" data-rc="${it.criterion}"><div class="row" style="justify-content:space-between"><b>${esc(it.code)} › ${esc(c.name)}</b></div>
      <details class="as-ev" open><summary>학생이 쓴 근거</summary>${it.evidence.map((e) => `<div class="logline"><div class="q">${esc(e.label)}</div><div class="a">${esc(e.text)}</div></div>`).join("") || `<div class="meta-line">기록이 없어요.</div>`}</details>
      <div class="chipbar" style="margin-top:8px">${[...c.levels.map((l) => [l.idx, `${l.label} ${l.pts}점`]), [-1, "미제출 0점"]].map(([v, n]) => `<button class="chip sm" data-rcv="${v}" type="button">${esc(n)}</button>`).join("")}</div></div>`;
  }).join("") + `</div>`;
}

// ---------- 척도표 ----------
function rubricHtml() {
  const r = st.data.rubric;
  const rows = [];
  let last = 0;
  for (const c of r.criteria) {
    if (c.el !== last) { rows.push(`<tr class="as-el"><td colspan="${r.labels.length + 2}">${esc(c.elName)}</td></tr>`); last = c.el; }
    rows.push(`<tr><td><b>${esc(c.name)}</b><div class="meta-line">${esc(c.stage)} · ${c.scope === "student" ? "개인" : "모둠"} · ${c.max}점</div>${c.deepNotes.map((n) => `<div class="meta-line">심화: ${esc(n)}</div>`).join("")}</td>${c.levels.map((l) => `<td>${esc(l.desc)}<div><span class="tag b">${l.pts}점</span></div></td>`).join("")}<td>비어 있으면 <span class="tag x">0점</span></td></tr>`);
  }
  return `<div class="card"><h3>${r.level === "middle" ? "중학교" : "고등학교"} 평가 척도표 <span class="meta-line">· 총 ${r.total}점</span></h3>
    <div class="meta-line">평가 대상은 학생이 쓴 판단·근거·이유예요. AI 질문 횟수, 글자 수, 맞춤법, AI를 썼는지는 점수에 넣지 않아요. 수업 설정에서 학교급이나 심화 활동을 바꾸면 척도표도 바뀌어요.</div>
    <div class="tbl-wrap"><table class="tbl as-rubric"><thead><tr><th>기준</th>${r.labels.map((l) => `<th>${esc(l)}</th>`).join("")}<th>미제출</th></tr></thead><tbody>${rows.join("")}</tbody></table></div></div>`;
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
    if (k === "score") warn = d.progress.done < d.progress.total ? `아직 채점하지 않은 칸이 ${d.progress.total - d.progress.done}개 있어요. 그 칸은 학생에게 '채점 전'으로 보여요.` : "";
    if (k === "score" && d.progress.unreviewed) warn += ` AI 점수를 아직 검토하지 않은 칸이 ${d.progress.unreviewed}개 있어요.`;
    if (k === "score" && d.progress.reviewCount) warn += ` AI 제안과 크게 달라 확인이 필요한 칸이 ${d.progress.reviewCount}개 있어요.`;
    if (k === "seteuk") { const n = d.students.filter((x) => !x.hasSeteuk).length; if (n) warn = `세특이 아직 없는 학생이 ${n}명 있어요. 그 학생은 '아직 없어요'로 보여요.`; }
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
    refresh().then(() => { // 진행률만 조용히 갱신
      const h = root().querySelector(".as-head .meta-line"); if (h) h.innerHTML = `채점 ${st.data.progress.done} / ${st.data.progress.total}칸${st.data.progress.reviewCount ? ` · <span class="tag y">확인 필요 ${st.data.progress.reviewCount}</span>` : ""} · 만점 ${st.data.rubric.total}점(개인 ${st.data.rubric.indivMax} + 모둠 ${st.data.rubric.total - st.data.rubric.indivMax})`;
      root().querySelectorAll("[data-asid]").forEach((b) => { const x = subjList().find((y) => subjId(y) === b.dataset.asid); const n = b.querySelector(".as-n"); if (x && n) n.textContent = `${x.scored}/${x.total}`; });
    }).catch(() => {});
  });
}

async function applyAiBtn() {
  await guard(async () => {
    const r = (await call("assess")({ code: st.code, action: "applyAi", kind: st.kind, id: st.id })).data;
    toast(r.applied ? `AI 점수 ${r.applied}칸을 적용했어요. 하나씩 확인해 주세요${r.skipped ? ` (${r.skipped}칸은 근거가 달라 제외)` : ""}` : "적용할 AI 점수가 없어요.");
    await Promise.all([loadSubject(), refresh()]); render();
  });
}
async function batchAi() {
  if (st.batch?.running) { st.batch.stop = true; render(); return; }
  const d = st.data, aiFirst = d.mode === "ai_first", applyAfter = d.auto?.on || (aiFirst && $("#as-apply")?.checked !== false);
  const need = (x, tot) => x.ai < tot;
  let targets = [...d.groups.filter((g) => g.members > 0 && need(g, d.aiTotal.group)).map((g) => ({ kind: "group", id: g.id, name: g.name })), ...d.students.filter((x) => need(x, d.aiTotal.student)).map((x) => ({ kind: "student", id: x.key, name: st.blind ? x.code : `${x.groupId.slice(1)}모둠 ${x.nick}` }))];
  const redo = !targets.length;
  if (redo) targets = [...d.groups.filter((g) => g.members > 0).map((g) => ({ kind: "group", id: g.id, name: g.name })), ...d.students.map((x) => ({ kind: "student", id: x.key, name: st.blind ? x.code : `${x.groupId.slice(1)}모둠 ${x.nick}` }))];
  if (!targets.length) return toast("채점할 대상이 없어요.", true);
  const est = Math.round(targets.length * 3.4);
  if (!(await confirmModal(redo ? "AI로 전체를 다시 채점할까요?" : "AI로 전체를 채점할까요?", `<p>모둠 ${targets.filter((t) => t.kind === "group").length}개와 학생 ${targets.filter((t) => t.kind === "student").length}명을 AI가 차례로 채점해요. AI 호출은 모두 약 ${est}번이에요(이 수업 한도 ${d.aiCap}회 중 ${d.aiUsed}회 사용).</p><p class="meta-line">${applyAfter ? (d.auto?.on ? "채점이 끝나면 통과한 칸은 <b>확정 후보</b>로, 어려운 칸은 <b>예외 큐</b>로 가요. 확정은 직접 눌러요." : "채점이 끝나면 AI 점수가 <b>검토 전</b>으로 적용돼요. 하나씩 확인·수정해 주세요.") : "채점이 끝나면 각 칸에서 AI 점수를 보고 고를 수 있어요."} 중간에 멈춰도 돼요.</p>`, "채점 시작", "취소"))) return;
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
    if (applyAfter && done) { const r = (await call("assess")({ code: st.code, action: "applyAi", all: true })).data; toast(`${stopped ? "멈췄어요. " : ""}AI 채점 ${done}곳 완료 · ${d.auto?.on ? `확정 후보 ${r.applied}칸, 예외 ${r.exceptions}칸` : `점수 ${r.applied}칸을 적용했어요(검토 전)`}${fail ? ` · ${fail}곳 실패` : ""}`); }
    else toast(`${stopped ? "멈췄어요. " : ""}AI 채점 ${done}곳 완료${fail ? ` · ${fail}곳 실패` : ""}`);
  } catch (e) { toast(errMsg(e), true); }
  await refresh(); if (st.id) await loadSubject(); render();
}

async function setAuto(patch) {
  await guard(async () => {
    const cur = st.data.auto, next = { ...cur, ...patch };
    await call("assess")({ code: st.code, action: "config", assessAuto: next });
    st.queue = null; await refresh();
    if (next.on && st.data.queue.exceptions + st.data.queue.appeals > 0) st.view = "queue"; else if (!next.on && st.view === "queue") st.view = "score";
    if (st.id) await loadSubject();
    render();
  });
}
async function startCalib() {
  const c = st.data.calib;
  if (!(await confirmModal(c?.state === "ready" ? "다시 교정할까요?" : "교정을 시작할까요?", `<p>표본 학생 6명과 학생이 있는 모둠(최대 4개)을 정해요. <b>AI 점수는 가려지니</b> 평소처럼 채점해 주세요(약 40~60칸, 20~30분). 표본을 모두 채점하면 AI와 얼마나 맞는지 계산해서 <b>자동 통과를 쓸 기준</b>을 정해요.</p><p class="meta-line">표본 채점은 그대로 최종 점수가 돼요. 교정 결과는 같은 척도표·학교급·사건·심화 설정의 다른 수업에서도 다시 쓰여요.</p>`, "교정 시작", "취소"))) return;
  await guard(async () => {
    const r = (await call("assess")({ code: st.code, action: "calibStart" })).data;
    toast(`표본 학생 ${r.students}명·모둠 ${r.groups}개를 정했어요. 🎯 표시를 채점해 주세요.`);
    st.queue = null; await refresh(); st.view = "score"; st.kind = "student"; const f = st.data.students.find((x) => x.calibSample); if (f) { st.id = f.key; await loadSubject(); } render();
  });
}
async function confirmAllBtn() {
  const n = st.data.progress.unreviewed;
  if (!(await confirmModal(`확정 후보 ${n}칸을 확정할까요?`, `<p>AI가 통과시킨 점수 ${n}칸이 <b>확정</b>돼요. 확정된 점수는 점수를 공개할 때 학생에게 보여요(공개는 따로 눌러요).</p><p class="meta-line">예외 큐에 남은 칸(${st.data.queue.exceptions}칸)은 확정되지 않아요.</p>`, "일괄 확정", "취소"))) return;
  await guard(async () => {
    const r = (await call("assess")({ code: st.code, action: "confirmAll" })).data;
    toast(`${r.confirmed}칸을 확정했어요`); st.queue = null; await refresh(); if (st.id) await loadSubject(); render();
  });
}
async function bulkCoop() {
  await guard(async () => {
    const r = (await call("assess")({ code: st.code, action: "bulkLevel", criterion: "c62", level: Number($("#as-bulk-lv").value), note: $("#as-bulk-note").value })).data;
    toast(`협력 칸 ${r.applied}명에게 적용했어요${r.skipped ? ` (산출물을 안 쓴 ${r.skipped}명은 건너뜀)` : ""}`); st.queue = null; await refresh(); render();
  });
}
async function askAi() {
  await guard(async () => {
    const b = root().querySelector("[data-asai]"); if (b) { b.disabled = true; b.textContent = "AI가 채점하는 중…"; }
    try {
      const r = (await call("assessAi")({ code: st.code, action: "score", kind: st.kind, id: st.id })).data;
      toast(`AI 제안을 받았어요 (${r.ok + r.auto}칸)${r.failedRuns ? ` · 일부 ${r.failedRuns}번 실패` : ""}`);
      await Promise.all([loadSubject(), refresh()]);
    } finally { render(); }
  });
}

// ---------- 이벤트 ----------
document.addEventListener("click", async (e) => {
  if (!e.target.closest("#as-root")) return;
  const t = (sel) => e.target.closest(sel);
  let b;
  if ((b = t("[data-asv]"))) { st.view = b.dataset.asv; if (st.view === "reli") { st.rel = null; st.recheck = null; } render(); }
  else if ((b = t("[data-asrel]"))) toggleRelease(b.dataset.asrel);
  else if ((b = t("[data-ask]"))) { st.kind = b.dataset.ask; const f = subjList()[0]; st.id = f ? subjId(f) : null; if (st.id) await loadSubject(); else st.sub = null; render(); }
  else if ((b = t("[data-asid]"))) { st.id = b.dataset.asid; if (st.view === "seteuk") st.kind = "student"; await loadSubject(); render(); }
  else if ((b = t("[data-assave]"))) saveCriterion(b.dataset.assave);
  else if (t("[data-asai]")) askAi();
  else if (t("[data-asbatch]")) batchAi();
  else if (t("[data-qsave]")) qSave(t("[data-qsave]"));
  else if (t("[data-qresolve]")) qResolve(t("[data-qresolve]"));
  else if (t("[data-qmore]")) { const o = (st.queue?.offset || 0) + 12; st.queue = null; loadQueue(o); }
  else if (t("[data-asbulk]")) bulkCoop();
  else if (t("[data-ascalib]")) startCalib();
  else if (t("[data-asconfirmall]")) confirmAllBtn();
  else if (t("[data-asresume]")) guard(async () => { await call("assess")({ code: st.code, action: "autoResume" }); await refresh(); render(); });
  else if (t("[data-asapply]")) applyAiBtn();
  else if (t("[data-asmake]")) makeSeteuk();
  else if (t("[data-asseteuk]")) saveSeteuk();
  else if ((b = t("[data-rcv]"))) {
    const box = b.closest("[data-rc]");
    await guard(async () => {
      await call("assess")({ code: st.code, action: "recheck", op: "save", kind: box.dataset.rk, id: box.dataset.ri, criterion: box.dataset.rc, level: Number(b.dataset.rcv) });
      toast("재채점을 기록했어요");
      st.rel = null; st.recheck = null; render();
    });
  }
});
document.addEventListener("change", async (e) => {
  if (!e.target.closest("#as-root")) return;
  if (e.target.id === "as-blind") { st.blind = e.target.checked; render(); }
  else if (e.target.id === "as-max") {
    await guard(async () => { const r = await call("assess")({ code: st.code, action: "config", seteukMax: Number(e.target.value) }); st.data.seteukMax = r.data.seteukMax; for (const k of Object.values(st.sk)) { k.prep = null; k.gen = null; } toast("글자 수 한도를 바꿨어요. 수준 판정을 다시 해요"); render(); });
  }
  else if (e.target.id === "as-emp") st.emphasis = e.target.value;
  else if (e.target.id === "as-auto-on") setAuto({ on: e.target.checked });
  else if (e.target.id === "as-calib-on") setAuto({ calib: e.target.checked });
  else if (e.target.id === "as-mode") {
    await guard(async () => { await call("assess")({ code: st.code, action: "config", assessMode: e.target.value }); await refresh(); await loadSubject(); toast(e.target.value === "ai_first" ? "AI가 먼저 채점하는 방식이에요" : "교사가 먼저 채점하는 방식(독립 채점)이에요"); render(); });
  }
  else if (e.target.id === "sk-grade" && st.id) skOf(st.id).prep.useGrade = e.target.value;
  else if (e.target.id === "sk-edit" && st.id) { const k = skOf(st.id); k.editing = e.target.checked; render(); if (k.editing) $("#as-seteuk")?.focus(); }
});
document.addEventListener("input", (e) => {
  if (e.target.id !== "as-seteuk" || !st.id) return;
  const k = skOf(st.id), n = byteLen(e.target.value), el = $("#as-bytes");
  k.text = e.target.value; k.saved = null; // 고치면 저장 배지를 지운다
  if (el) { el.className = `sk-count ${byteCls(n, st.data.seteukMax)}`; el.innerHTML = `<b>${n.toLocaleString()}</b><small> / ${st.data.seteukMax.toLocaleString()} byte</small>`; }
});
// 수준을 고르면 선택한 칸이 강조되도록 한다(저장 전 미리보기)
document.addEventListener("change", (e) => {
  const r = e.target.closest?.('#as-root input[type="radio"]'); if (!r) return;
  r.closest(".as-lv").querySelectorAll(".lvopt").forEach((l) => l.classList.toggle("cur", l.contains(r)));
});

