// 교사 화면 '평가' 탭: 척도표로 채점하고, 채점의 타당도·신뢰도를 점검하고, 세특 초안을 만들고, 점수와 세특을 따로 공개한다.
// 서버(functions/assess.js, index.js 의 assess·assessAi)가 규칙을 지킨다. 이 화면은 그 규칙이 눈에 보이게 하는 역할이다.
//  - 근거 보기: 기준마다 학생이 쓴 글을 그대로 보여 준다. 근거가 없으면 '미제출'만 고를 수 있다.
//  - 독립 채점: AI 제안은 내가 그 기준의 수준을 저장한 뒤에만 보인다.
//  - 익명 채점: 학생을 별명 대신 코드(S-1A2B)로, 모둠과 상관없는 순서로 보여 준다.
import { call, esc, toast, errMsg } from "./fb.js";
import { waitHtml, STEPS } from "./wait.js";
import { confirmModal } from "./modal.js";

const $ = (s) => document.querySelector(s);
const root = () => $("#as-root");
const st = { code: null, data: null, view: "score", kind: "group", id: null, sub: null, blind: true, draft: {}, recheck: null, rel: null, busy: false, rubricOpen: false };

// 서버와 같은 NEIS 바이트 계산(한글 3, 영문·숫자 1, 줄바꿈 2)
export const byteLen = (s) => { let n = 0; for (const ch of String(s ?? "")) n += ch === "\n" ? 2 : ch.codePointAt(0) < 128 ? 1 : 3; return n; };
const crit = (cid) => st.data.rubric.criteria.find((c) => c.id === cid);
const critsOf = (kind) => st.data.rubric.criteria.filter((c) => c.scope === (kind === "student" ? "student" : "group"));
const lvlLabel = (c, level) => (level === -1 ? "미제출" : c.levels[level]?.label || "");
const ptsOf = (c, level) => (level === -1 ? 0 : c.levels[level]?.pts ?? 0);
const subjList = () => (st.kind === "group" ? st.data.groups : st.data.students);
const subjId = (x) => (st.kind === "group" ? x.id : x.key);
const subjName = (x) => (st.kind === "group" ? x.name : st.blind ? x.code : `${x.groupId.slice(1)}모둠 ${x.nick}`);
const busy = (html) => `<div class="card">${html || waitHtml({ steps: STEPS.load })}</div>`;

export async function openAssess(code) {
  if (st.code !== code) Object.assign(st, { code, data: null, view: "score", kind: "group", id: null, sub: null, draft: {}, recheck: null, rel: null });
  if (!st.data) root().innerHTML = busy();
  try { await refresh(); } catch (e) { root().innerHTML = `<div class="notice">${esc(errMsg(e))}</div>`; return; }
  if (!st.id) { const first = subjList()[0]; st.id = first ? subjId(first) : null; if (st.id) await loadSubject(); }
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
    <div class="seg" id="as-views">${[["score", "채점"], ["seteuk", "세특"], ["reli", "신뢰도 점검"], ["rubric", "척도표"]].map(([k, n]) => `<button data-asv="${k}" class="${st.view === k ? "on" : ""}">${n}</button>`).join("")}</div>
    <div id="as-body">${st.view === "score" ? scoreHtml() : st.view === "seteuk" ? seteukHtml() : st.view === "reli" ? reliHtml() : rubricHtml()}</div>`;
  if (st.view === "reli" && !st.rel) loadReli();
}
const relBtn = (k, name, on) => `<div class="as-rel-item ${on ? "on" : ""}"><span class="tag ${on ? "" : "x"}">${name} ${on ? "공개 중" : "비공개"}</span>
  <button class="btn ${on ? "btn-plain" : "btn-primary"} btn-sm" data-asrel="${k}" type="button">${name} ${on ? "공개 끄기" : "공개하기"}</button></div>`;

function pickerHtml() {
  const list = subjList();
  const sorted = st.kind === "student" && st.blind ? [...list].sort((a, b) => a.code.localeCompare(b.code)) : list;
  return `<div class="row" style="margin-bottom:8px"><div class="seg" style="margin:0"><button data-ask="group" class="${st.kind === "group" ? "on" : ""}">모둠 칸(${st.data.groups[0]?.total || 0}개)</button><button data-ask="student" class="${st.kind === "student" ? "on" : ""}">개인 칸(${st.data.students[0]?.total || 0}개)</button></div>
      ${st.kind === "student" ? `<label class="chk"><input type="checkbox" id="as-blind" ${st.blind ? "checked" : ""}> 익명 채점</label>` : ""}</div>
    <div class="chipbar as-pick">${sorted.map((x) => `<button class="chip sm ${subjId(x) === st.id ? "on" : ""}" data-asid="${esc(subjId(x))}">${esc(subjName(x))} <span class="as-n">${x.scored}/${x.total}</span></button>`).join("") || `<span class="meta-line">아직 대상이 없어요.</span>`}</div>
    ${st.kind === "student" && st.blind ? `<div class="meta-line" style="margin-top:6px">익명 채점: 별명 대신 코드로 보여 줘요. 같은 모둠이라도 순서를 섞어 먼저 본 학생에게 끌리지 않게 해요.</div>` : ""}`;
}

function scoreHtml() {
  const d = st.data;
  const head = `<div class="card">${pickerHtml()}</div>`;
  if (!st.id) return head;
  if (!st.sub) return head + busy();
  const s = st.sub, cs = critsOf(st.kind);
  const gotAi = cs.some((c) => c.ai && s.hasAi[c.id]);
  const total = cs.reduce((n, c) => n + (s.scores[c.id] ? s.scores[c.id].pts : 0), 0), maxT = cs.reduce((n, c) => n + c.max, 0), done = cs.filter((c) => s.scores[c.id]).length;
  return head + `<div class="card as-sub">
    <div class="row" style="justify-content:space-between"><div><h3 style="margin:0">${esc(subjLabel())}</h3><div class="meta-line">채점 ${done}/${cs.length}칸 · 지금까지 ${total} / ${maxT}점</div></div>
      <div class="row"><button class="btn btn-tinted btn-sm" data-asai type="button" ${st.busy ? "disabled" : ""}>${gotAi ? "AI 제안 다시 받기" : "AI 제안 받기"}</button></div></div>
    <div class="meta-line" style="margin:6px 0 2px">AI 제안은 <b>내가 그 기준의 수준을 저장한 뒤에만</b> 보여요(먼저 보면 AI 의견에 끌려요). 같은 근거를 ${d.aiRuns}번 채점해 흔들림도 알려 줘요. 이 수업의 AI 사용 ${d.aiUsed} / ${d.aiCap}회</div></div>`
    + cs.map((c) => criterionHtml(c, s)).join("");
}
function subjLabel() {
  const x = subjList().find((y) => subjId(y) === st.id);
  return x ? subjName(x) : "";
}

function criterionHtml(c, s) {
  const sc = s.scores[c.id], ai = s.ai[c.id], ev = s.evidence[c.id] || [], empty = s.empty[c.id], rv = s.review[c.id];
  const lv = (idx, label, pts, desc, dis) => `<label class="lvopt ${sc && sc.level === idx ? "cur" : ""}"><input type="radio" name="lv-${c.id}" value="${idx}" ${sc && sc.level === idx ? "checked" : ""} ${dis ? "disabled" : ""}>
      <span class="lvh"><b>${esc(label)}</b> <span class="tag b">${pts}점</span></span><span class="lvd">${esc(desc)}</span></label>`;
  return `<div class="card as-crit" data-cid="${c.id}">
    <div class="row" style="justify-content:space-between"><h4 style="margin:0">${esc(c.elName)} › ${esc(c.name)} <span class="tag x">${c.max}점</span> <span class="tag x">${esc(c.stage)}</span></h4>${sc ? `<span class="tag">${esc(lvlLabel(c, sc.level))} ${sc.pts}점</span>` : `<span class="tag y">채점 전</span>`}</div>
    ${c.deepNotes.length ? `<div class="notice muted" style="margin:8px 0 0">심화 활동: ${c.deepNotes.map(esc).join(" ")}</div>` : ""}
    <details class="as-ev" open><summary>학생이 쓴 근거 ${empty ? `<span class="tag r">근거 없음 → 미제출만 선택</span>` : `<span class="meta-line">(${ev.length}개)</span>`}</summary>
      ${ev.length ? ev.map((e) => `<div class="logline"><div class="q">${esc(e.label)}</div><div class="a">${esc(e.text)}</div></div>`).join("") : `<div class="meta-line">기록이 없어요.</div>`}</details>
    <div class="as-lv">${c.levels.map((l) => lv(l.idx, l.label, l.pts, l.desc, empty)).join("")}${lv(-1, "미제출", 0, "근거가 비어 있어 평가할 수 없음", !empty)}</div>
    <label class="lbl" for="note-${c.id}">평가 근거 <span class="meta-line">(점수를 공개하면 학생에게 보여요. 가장 높은·낮은 수준, 또는 AI 제안과 두 수준 이상 다르면 8자 이상 꼭 써요)</span></label>
    <textarea id="note-${c.id}" maxlength="500" rows="2" placeholder="예) 세 가지를 모두 알아냈고 인물의 말을 근거로 씀">${esc(sc?.note || "")}</textarea>
    <div class="row" style="margin-top:8px"><button class="btn btn-primary btn-sm" data-assave="${c.id}" type="button">저장</button>
      ${sc ? `<span class="meta-line">저장됨${sc.revs?.length ? ` · 고친 기록 ${sc.revs.length}번` : ""}</span>` : ""}</div>
    ${aiHtml(c, sc, ai, rv, s.hasAi[c.id])}</div>`;
}
function aiHtml(c, sc, ai, rv, has) {
  if (!c.ai) return `<div class="meta-line" style="margin-top:8px">이 기준은 교사 관찰로만 채점해요(AI 제안 없음).</div>`;
  if (!sc) return has ? `<div class="meta-line" style="margin-top:8px">🔒 AI 제안이 준비돼 있어요. 수준을 저장하면 보여요.</div>` : "";
  if (!ai) return "";
  const same = ai.level === sc.level, near = Math.abs(rank(c, ai.level) - rank(c, sc.level)) === 1;
  return `<div class="as-ai ${same ? "same" : rv ? "dev" : near ? "near" : "dev"}">
    <div><b>AI 제2평정</b> ${esc(lvlLabel(c, ai.level))} ${ptsOf(c, ai.level)}점 · ${ai.n}번 채점: ${ai.levels.map((l) => esc(lvlLabel(c, l))).join(" / ")}
      ${ai.spread ? `<span class="tag y">AI도 갈렸어요</span>` : `<span class="tag">3회 일치</span>`}
      ${ai.auto ? "" : ai.quoteOk ? `<span class="tag b">인용 확인됨</span>` : `<span class="tag r">인용문을 근거에서 못 찾음</span>`}
      <span class="tag ${same ? "" : "y"}">${same ? "내 채점과 같음" : near ? "한 수준 차이" : "두 수준 이상 차이"}</span></div>
    ${ai.reason ? `<div class="meta-line">${esc(ai.reason)}</div>` : ""}${ai.quote ? `<div class="meta-line">인용: “${esc(ai.quote)}”</div>` : ""}
    ${rv ? `<div class="notice yellow" style="margin:8px 0 0">AI 제안과 두 수준 이상 달라요. 수준을 다시 살펴보거나, 그대로면 평가 근거를 8자 이상 써서 저장해 주세요.</div>` : ""}
    <div class="meta-line">AI는 제2평정자예요. 최종 판단은 교사가 해요.</div></div>`;
}
const rank = (c, level) => (level === -1 ? c.levels.length : level);

// ---------- 세특 ----------
function seteukHtml() {
  const d = st.data, list = d.students;
  if (st.kind !== "student") { st.kind = "student"; st.id = list[0]?.key || null; st.sub = null; if (st.id) loadSubject(); }
  const cur = list.find((x) => x.key === st.id);
  const dr = st.draft[st.id] || {};
  const text = dr.text ?? st.sub?.seteuk?.text ?? "";
  const bytes = byteLen(text);
  return `<div class="card"><div class="row" style="justify-content:space-between"><h3 style="margin:0">세특 초안</h3>
      <label class="meta-line">글자 수 한도 <select id="as-max">${[1000, 1500, 2000].map((n) => `<option value="${n}" ${d.seteukMax === n ? "selected" : ""}>${n}바이트(약 ${Math.round(n / 3)}자)</option>`).join("")}</select></label></div>
    <div class="meta-line">학생이 쓴 활동과 내가 매긴 평가를 바탕으로 AI가 초안을 만들어요. 근거가 연결되지 않은 문장은 자동으로 빼요. 초안은 참고용이니 꼭 읽고 고쳐 주세요.</div>
    <div class="chipbar as-pick" style="margin-top:10px">${list.map((x) => `<button class="chip sm ${x.key === st.id ? "on" : ""}" data-asid="${esc(x.key)}">${esc(`${x.groupId.slice(1)}모둠 ${x.nick}`)} ${x.hasSeteuk ? "✓" : ""}</button>`).join("") || `<span class="meta-line">학생이 없어요.</span>`}</div></div>
    ${cur ? `<div class="card"><h4 style="margin:0 0 6px">${esc(`${cur.groupId.slice(1)}모둠 ${cur.nick}`)}</h4>
      <div class="row"><button class="btn btn-tinted btn-sm" data-asdraft type="button" ${st.busy ? "disabled" : ""}>AI 초안 만들기</button></div>
      <label class="lbl" for="as-seteuk">세특 <span class="meta-line">('~함.', '~임.'으로 끝내고, 이름·점수·기관명은 쓰지 않아요)</span></label>
      <textarea id="as-seteuk" rows="9" placeholder="AI 초안을 만들거나 직접 써요">${esc(text)}</textarea>
      <div class="row" style="justify-content:space-between;margin-top:6px"><span id="as-bytes" class="${bytes > d.seteukMax ? "as-over" : "meta-line"}">${bytes} / ${d.seteukMax}바이트</span><button class="btn btn-primary btn-sm" data-asseteuk type="button">저장</button></div>
      <div id="as-sw">${warnHtml(dr)}</div>${draftNotes(dr)}</div>` : ""}`;
}
const warnHtml = (dr) => (dr.warnings || []).map((w) => `<div class="notice yellow" style="margin:8px 0 0">${esc(w)}</div>`).join("");
function draftNotes(dr) {
  if (!dr.sentences) return "";
  const ev = dr.evidence || {};
  return `<details class="as-ev" style="margin-top:10px"><summary>이 초안의 근거 보기</summary>${dr.sentences.map((s) => `<div class="logline"><div class="q">${esc(s.text)}</div>
      <div class="a">${s.evidence.map((id) => `· ${esc(ev[id]?.label || id)}: ${esc(ev[id]?.text || "")}`).join("\n")}</div></div>`).join("")}
  </details>${(dr.dropped || []).length ? `<div class="meta-line" style="margin-top:6px">뺀 문장: ${dr.dropped.map((x) => `“${esc(x.text)}”(${esc(x.why)})`).join(", ")}</div>` : ""}`;
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
    <div class="meta-line">타당도는 척도·근거·독립 채점 규칙으로, 신뢰도는 아래 지표로 점검해요. 일치도는 <b>교사와 AI가 같은 수준을 골랐는지</b>를 보는 거라, 높다고 옳은 건 아니고 낮으면 다시 살펴볼 신호예요.</div>
    ${(r.warnings || []).map((w) => `<div class="notice yellow" style="margin-top:10px">${esc(w)}</div>`).join("") || `<div class="notice green" style="margin-top:10px">지금 기준에서 걸리는 경고는 없어요.</div>`}
    <div class="as-stats">
      ${card("교사–AI 일치율", fmtN(o.exact, "%"), `${o.n}칸 비교 · 기준 ${T.exact}% 이상`, okEnough ? o.exact >= T.exact : undefined)}
      ${card("한 수준 이내", fmtN(o.adjacent, "%"), `기준 ${T.adjacent}% 이상`, okEnough ? o.adjacent >= T.adjacent : undefined)}
      ${card("가중 카파", fmtN(o.kappa), `기준 ${T.kappa} 이상(우연 일치를 뺀 값)`, okEnough && o.kappa !== null ? o.kappa >= T.kappa : undefined)}
      ${card("내 채점 경향", o.bias === null ? "—" : o.bias > 0.1 ? "후한 편" : o.bias < -0.1 ? "엄격한 편" : "비슷함", `AI보다 평균 ${fmtN(o.bias)}수준`, okEnough && o.bias !== null ? Math.abs(o.bias) < T.bias : undefined)}
      ${card("AI 3회 일치", fmtN(r.self.same, "%"), `${r.self.n}칸 · 기준 ${T.selfConsistency}% 이상`, r.self.n >= T.minPairs ? r.self.same >= T.selfConsistency : undefined)}
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
  try { await fn(); } catch (e) { toast(errMsg(e), true); } finally { st.busy = false; }
}

async function toggleRelease(k) {
  const d = st.data, on = !d.release[k];
  const name = k === "score" ? "점수" : "세특";
  if (on) {
    let warn = "";
    if (k === "score") warn = d.progress.done < d.progress.total ? `아직 채점하지 않은 칸이 ${d.progress.total - d.progress.done}개 있어요. 그 칸은 학생에게 '채점 전'으로 보여요.` : "";
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

async function makeDraft() {
  await guard(async () => {
    const b = root().querySelector("[data-asdraft]"); if (b) { b.disabled = true; b.textContent = "AI가 쓰는 중…"; }
    try {
      const r = (await call("assessAi")({ code: st.code, action: "seteuk", kind: "student", id: st.id })).data;
      st.draft[st.id] = { text: r.text, sentences: r.sentences, dropped: r.dropped, warnings: r.warnings, evidence: r.evidence };
    } finally { render(); }
  });
}

async function saveSeteuk() {
  const text = $("#as-seteuk").value;
  await guard(async () => {
    const r = (await call("assess")({ code: st.code, action: "seteukSave", id: st.id, text })).data;
    st.draft[st.id] = { ...(st.draft[st.id] || {}), text: r.text, warnings: r.warnings };
    if (st.sub) st.sub.seteuk = { text: r.text, t: Date.now() };
    const x = st.data.students.find((y) => y.key === st.id); if (x) x.hasSeteuk = !!r.text;
    toast(r.text ? "저장했어요" : "비웠어요");
    render();
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
  else if (t("[data-asdraft]")) makeDraft();
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
    await guard(async () => { const r = await call("assess")({ code: st.code, action: "config", seteukMax: Number(e.target.value) }); st.data.seteukMax = r.data.seteukMax; toast("글자 수 한도를 바꿨어요"); render(); });
  }
});
document.addEventListener("input", (e) => {
  if (e.target.id !== "as-seteuk") return;
  const n = byteLen(e.target.value), el = $("#as-bytes");
  st.draft[st.id] = { ...(st.draft[st.id] || {}), text: e.target.value };
  if (el) { el.textContent = `${n} / ${st.data.seteukMax}바이트`; el.className = n > st.data.seteukMax ? "as-over" : "meta-line"; }
});
// 수준을 고르면 선택한 칸이 강조되도록 한다(저장 전 미리보기)
document.addEventListener("change", (e) => {
  const r = e.target.closest?.('#as-root input[type="radio"]'); if (!r) return;
  r.closest(".as-lv").querySelectorAll(".lvopt").forEach((l) => l.classList.toggle("cur", l.contains(r)));
});

