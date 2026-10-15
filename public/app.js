import { auth, db, call, esc, toast, errMsg } from "./fb.js";
import { signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc, onSnapshot, updateDoc, collection, query, orderBy, serverTimestamp, deleteField } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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
// 1단계 ③ 문제 문장 점검표
const PROBLEM_CHECKS = [
  "두 사람 이상의 처지가 함께 들어 있다.",
  "특정 집단을 탓하거나 깎아내리는 말이 없다.",
  "답(해결책)을 미리 정해 두지 않았다.",
  "대화에서 들은 말로 뒷받침할 수 있다.",
  "우리가 조사하고 대안을 낼 수 있는 크기다.",
];
const SRC_TYPES = ["통계·숫자", "정부·기관 발표", "법·제도", "언론 보도", "당사자 증언"];
const COMPARE = ["자료와 같다", "자료와 다르다", "자료에 없다"];
const VERDICTS = ["사실이다", "일부만 사실이다", "사실이 아니다", "확인할 수 없다"];
const CAUSE_LEVELS = ["개인", "지역·사회", "제도·정책"];
const CAUSE_STATUS = ["근거로 뒷받침됨", "근거가 약함", "버림"];
// 단계마다 AI가 맡는 역할을 분명히 보여 준다(AI가 하는 일 / 하지 않는 일 / 우리가 하는 일)
const ROLES = {
  1: { ai: "인터뷰 상대 (가상 인물)", does: "자기가 겪은 일과 생각을 말해요.", not: "무엇이 사실인지, 무엇이 정답인지 말하지 않아요. 틀린 말을 할 수도 있어요.", me: "질문하고, 사실인지 확인할 말을 골라 둬요." },
  3: { ai: "검색 도우미", does: "알려진 내용과 확인할 수 있는 곳을 알려 줘요.", not: "들은 말이나 원인 가설이 맞는지 틀린지 판정하지 않아요.", me: "자료와 비교해서 사실인지 우리가 판정해요." },
  4: { ai: "검토자 3명", does: "우리 대안의 강점, 약점, 생각할 질문을 말해요.", not: "대안을 대신 쓰거나 순위를 매기지 않아요.", me: "검토 의견을 받아들일지 버릴지 우리가 정해요." },
  5: { ai: "미래 시뮬레이터", does: "대안을 실행한 뒤 가능한 미래 2가지를 보여 줘요.", not: "정답이나 확실한 예측이 아니에요.", me: "어느 쪽이 더 그럴듯한지, 왜 그런지 우리가 판단해요." },
};
// 1단계의 작은 단계: 혼자 대화 → 혼자 정리·제출 → 모둠이 모여 문제 정하기
const SUBS = [
  { id: "chat", name: "① 대화", who: "혼자" },
  { id: "note", name: "② 정리·제출", who: "혼자" },
  { id: "group", name: "③ 모둠 문제", who: "모둠" },
];
const STARTERS = ["안녕하세요, 어떤 일을 하세요?", "요즘 가장 힘든 일이 뭐예요?", "앞으로 무엇을 바라세요?"];

const S = {
  code: null, groupId: null, nick: null, uid: null, info: null, me: null,
  work: {}, logs: [], chat: [], stage: 1, sub1: "chat", aiCount: 0, memberCount: 0,
  busy: null, sending: false, pending: null, draft: "", letterClosed: false, matTab: null, proposalId: null, round: 1, scrollChat: false,
};
const $ = (s) => document.querySelector(s);
const panel = $("#panel");
let groupRef = null, memberRef = null;

// ---------- 데이터 도우미 ----------
const w = (path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), S.work);
// 모둠 산출물 목록은 {항목ID: 항목} 지도로 저장해, 여러 학생이 동시에 추가해도 서로 덮어쓰지 않는다.
function toList(x) {
  if (Array.isArray(x)) return x.map((v, i) => (v && typeof v === "object" ? { id: String(v.id ?? i), ...v } : { id: String(i), text: v }));
  return Object.entries(x || {}).map(([id, v]) => ({ id, ...(v && typeof v === "object" ? v : { text: v }) })).sort((a, b) => (a.t || 0) - (b.t || 0));
}
const list = (path) => toList(w(path));
const ts = (l) => l.createdAt?.toMillis?.() || 0;
const stageLogs = (n) => S.logs.filter((l) => l.stage === n).sort((a, b) => ts(a) - ts(b));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const fmtTime = (t) => { const d = t?.toDate?.(); return d ? `${d.getHours() < 12 ? "오전" : "오후"} ${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")}` : ""; };
const txt = (v) => (typeof v === "string" ? v.trim() : "");

async function save(path, value) {
  try { await updateDoc(groupRef, { ["work." + path]: value }); }
  catch (e) { console.error(e); toast("저장하지 못했습니다. 연결을 확인하세요.", true); }
}
const addItem = async (path, obj) => { const id = newId(); await save(`${path}.${id}`, { ...obj, t: Date.now(), by: S.uid, nick: S.nick }); return id; };
const delItem = (path, id) => save(`${path}.${id}`, deleteField());
const who = (it) => (it.nick ? `<span class="authored">${esc(it.nick)}</span>` : "");

// 화면의 값을 먼저 바꿔 두고(다시 그려도 입력이 사라지지 않게) 칸별로 따로 모아서 저장한다.
function setLocal(path, value) {
  const keys = path.split(".");
  let o = S.work;
  for (const k of keys.slice(0, -1)) { if (o[k] == null || typeof o[k] !== "object") o[k] = {}; o = o[k]; }
  o[keys[keys.length - 1]] = value;
}
const pending = new Map(); // 경로 → { value, timer }
function queueSave(path, value, delay = 600) {
  setLocal(path, value);
  clearTimeout(pending.get(path)?.timer);
  pending.set(path, { value, timer: setTimeout(() => flushSave(path), delay) });
}
function flushSave(path) {
  const p = pending.get(path); if (!p) return;
  clearTimeout(p.timer); pending.delete(path);
  return save(path, p.value);
}
const flushAll = () => Promise.all([...pending.keys()].map(flushSave));

// ---------- 접속·단계 신호(교사 화면에서 누가 어느 단계인지 보는 용도) ----------
let hb = null;
function ping() { if (memberRef) updateDoc(memberRef, { stage: S.stage, lastSeen: serverTimestamp() }).catch(() => {}); }
function startPresence() {
  ping();
  clearInterval(hb);
  hb = setInterval(() => { if (!document.hidden) ping(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) ping(); });
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
  memberRef = doc(db, `sessions/${code}/members/${S.uid}`);
  const mSnap = await getDoc(memberRef);
  if (!mSnap.exists()) { localStorage.removeItem("eps_code"); return; }
  Object.assign(S, { code, groupId: mSnap.data().groupId, nick: mSnap.data().nickname });
  groupRef = doc(db, `sessions/${code}/groups/${S.groupId}`);
  S.info = (await call("getCase")({ code })).data;
  S.me = S.info.me;
  S.matTab = S.info.materials?.[0]?.id || null;
  $("#join").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#who").textContent = `${S.groupId.replace("g", "")}모둠 · ${S.nick}`;
  onSnapshot(groupRef, (s) => {
    const d = s.data() || {};
    S.work = d.work || {};
    for (const [path, p] of pending) setLocal(path, p.value); // 아직 저장 중인 내 입력은 유지
    S.aiCount = d.aiCount || 0; S.memberCount = d.memberCount || 0;
    scheduleRender();
  });
  onSnapshot(collection(db, `sessions/${code}/groups/${S.groupId}/logs`), (s) => { S.logs = s.docs.map((d) => ({ id: d.id, ...d.data() })); scheduleRender(); });
  onSnapshot(query(collection(db, `sessions/${code}/members/${S.uid}/chat`), orderBy("createdAt")), (s) => {
    S.chat = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (S.pending && S.chat.length > S.pending.base) S.pending = null; // 서버에 기록된 말풍선으로 바꾼다
    if (S.stage === 1 && S.sub1 === "chat") { if (!$("#msgs")) render(true); else renderMsgs(); }
  });
  renderTabs();
  render(true);
  startPresence();
}

onAuthStateChanged(auth, async (u) => {
  if (!u) { await signInAnonymously(auth); return; }
  S.uid = u.uid;
  const saved = localStorage.getItem("eps_code");
  if (saved && !S.code) enter(saved).catch(console.error);
});

// ---------- 이동 ----------
function renderTabs() {
  $("#tabs").innerHTML = STAGES.map((s) =>
    `<button class="stage-tab ${S.stage === s.n ? "on" : ""}" data-stage="${s.n}"><b>${s.n}</b><span>${s.name}</span></button>`).join("");
}
function goTo(stage, sub) {
  flushAll();
  S.stage = stage;
  if (sub) S.sub1 = sub;
  window.scrollTo(0, 0);
  S.scrollChat = stage === 1 && S.sub1 === "chat" && S.chat.length > 0; // 대화로 돌아오면 마지막 말풍선을 보여 준다
  renderTabs(); render(true); ping();
}
$("#tabs").onclick = (e) => { const b = e.target.closest("[data-stage]"); if (b) goTo(Number(b.dataset.stage)); };

// ---------- 공통 조각 ----------
function roleBox(n) {
  const r = ROLES[n];
  if (!r) return `<div class="role x"><div class="role-h"><span class="tag x">AI 사용 안 함</span><b>이 단계는 우리 모둠이 직접 생각합니다.</b></div></div>`;
  return `<div class="role"><div class="role-h"><span class="tag y">AI 역할</span><b>${esc(r.ai)}</b></div>
    <div class="role-g"><div><span>AI가 하는 일</span>${esc(r.does)}</div><div><span>AI가 하지 않는 일</span>${esc(r.not)}</div><div class="me"><span>우리가 하는 일</span>${esc(r.me)}</div></div></div>`;
}
function problemBar() {
  const p = w("s1.problem") || {};
  if (!txt(p.hmw)) return `<div class="problem-bar empty">아직 모둠 문제를 정하지 않았어요. <button class="link" data-go="1" data-sub="group">1단계 ③에서 정하기</button></div>`;
  return `<div class="problem-bar"><div class="pb-k">우리 모둠의 문제 <button class="link" data-go="1" data-sub="group">고치기</button></div>
    <div class="pb-q">${esc(p.hmw)}</div>${txt(p.situation) ? `<div class="pb-s">${esc(p.situation)}</div>` : ""}</div>`;
}
const shared = `<span class="tag b">모둠 공용 · 실시간</span>`;
const liveWho = (path) => `<div class="live-who" data-live="${esc(path)}"></div>`;
// 저장 칸(data-save): 입력하면 자동 저장되고, 모둠원 화면에도 바로 반영된다
const fld = (path, label, ph = "", area = false) => `${label ? `<label class="lbl">${label}</label>` : ""}${area
  ? `<textarea data-save="${path}" placeholder="${esc(ph)}">${esc(w(path) || "")}</textarea>`
  : `<input type="text" data-save="${path}" value="${esc(w(path) || "")}" placeholder="${esc(ph)}" />`}${liveWho(path)}`;
const pick = (path, label, opts) => {
  const cur = w(path) || "";
  const all = cur && !opts.includes(cur) ? [...opts, cur] : opts;
  return `${label ? `<label class="lbl">${label}</label>` : ""}<select data-save="${path}"><option value="">선택하세요</option>${all.map((o) => `<option ${cur === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
};
const loading = (msg = "AI가 답을 만드는 중입니다…") => `<div class="loading-strip"><div class="spinner"></div><span>${msg}</span></div>`;
function listHtml(path, rowFn, empty = "아직 없습니다.") {
  const items = list(path);
  if (!items.length) return `<div class="meta-line">${empty}</div>`;
  return `<div class="group">${items.map((it) =>
    `<div class="cell"><div class="grow">${rowFn(it)}${who(it) ? `<br>${who(it)}` : ""}</div><button class="btn btn-plain btn-sm" data-act="del" data-path="${path}" data-id="${it.id}">삭제</button></div>`).join("")}</div>`;
}
function footer() {
  let prev = null, next = null;
  if (S.stage === 1) {
    const i = SUBS.findIndex((x) => x.id === S.sub1);
    if (i > 0) prev = { s: 1, sub: SUBS[i - 1].id, label: SUBS[i - 1].name };
    next = i < SUBS.length - 1 ? { s: 1, sub: SUBS[i + 1].id, label: SUBS[i + 1].name } : { s: 2, label: "2단계 원인 탐색" };
  } else {
    prev = S.stage === 2 ? { s: 1, sub: "group", label: "1단계 ③ 모둠 문제" } : { s: S.stage - 1, label: `${S.stage - 1}단계 ${STAGES[S.stage - 2].name}` };
    if (S.stage < 7) next = { s: S.stage + 1, label: `${S.stage + 1}단계 ${STAGES[S.stage].name}` };
  }
  const btn = (x, cls, text) => `<button class="btn ${cls}" data-go="${x.s}" data-sub="${x.sub || ""}">${text}</button>`;
  return `<div class="nav-foot">${prev ? btn(prev, "btn-plain", `← ${esc(prev.label)}`) : "<span></span>"}
    ${next ? btn(next, "btn-primary", `다음: ${esc(next.label)} →`) : `<span class="meta-line">마지막 단계입니다. 수고했어요!</span>`}</div>
    <div class="meta-line" style="text-align:right;margin-top:8px">우리 모둠 AI 사용 ${S.aiCount}회</div>`;
}

// ---------- 그리기 ----------
// 다른 모둠원이 바꾼 내용은 바로 그린다. 단, 내가 글을 쓰는 중이거나 누르는 중이면 그 칸만 맞추고 나머지는 나중에 그린다.
let lastKey = "", deferred = false, ptrDown = false;
const isEditing = () => {
  const a = document.activeElement;
  return panel.contains(a) && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && !/checkbox|radio/.test(a.type)));
};
function render(force = false) {
  if (!S.info) return;
  if (!force && (isEditing() || ptrDown)) { deferred = true; syncLive(); return; }
  deferred = false;
  const html = renderStage[S.stage]() + footer();
  const key = `${S.stage}|${S.sub1}|${S.busy}|${html}`;
  if (!force && key === lastKey) { syncLive(); return; }
  lastKey = key;
  const sc = window.scrollY;
  panel.innerHTML = html;
  window.scrollTo(0, sc); // 다시 그려도 보던 자리를 지킨다
  if ($("#msgs")) { const m = $("#msg"); if (m && S.draft) m.value = S.draft; renderMsgs(); }
  syncLive();
}
// 다른 칸으로 옮겨 가는 도중(포커스가 잠깐 비는 순간)에 다시 그리지 않도록 한 박자 늦춘다
let renderTimer = null;
function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(() => render(), 0); }
function runDeferred() { if (deferred && !isEditing() && !ptrDown) render(); }
document.addEventListener("pointerdown", () => { ptrDown = true; }, true);
for (const ev of ["pointerup", "pointercancel"]) document.addEventListener(ev, () => { ptrDown = false; setTimeout(runDeferred, 0); }, true);

// 공용 칸의 값과 '입력 중' 표시를 최신으로 맞춘다(내가 쓰고 있는 칸은 건드리지 않는다)
function syncLive() {
  const now = Date.now();
  const editors = Object.entries(w("live") || {}).filter(([uid, x]) => uid !== S.uid && x?.path && now - (x.t || 0) < 120000);
  panel.querySelectorAll("[data-save]").forEach((el) => {
    if (el === document.activeElement || pending.has(el.dataset.save)) return;
    const v = w(el.dataset.save);
    if (el.type === "checkbox") el.checked = !!v;
    else if (el.value !== (v ?? "")) el.value = v ?? "";
  });
  panel.querySelectorAll("[data-live]").forEach((el) => {
    const names = editors.filter(([, x]) => x.path === el.dataset.live).map(([, x]) => x.nick);
    el.textContent = names.length ? `✏️ ${names.join(", ")} 입력 중` : "";
  });
}

// ---------- 1단계 ① 메신저 대화 ----------
function msgsHtml() {
  const name = S.me?.name || "", ini = esc(name.slice(0, 1));
  const rows = [];
  for (const l of S.chat) {
    rows.push(`<div class="msg me"><div class="col"><div class="bubble">${esc(l.input)}</div><span class="time">${fmtTime(l.createdAt)}</span></div></div>`);
    rows.push(`<div class="msg ai"><div class="avatar sm">${ini}</div><div class="col"><span class="name">${esc(name)}</span><div class="bubble">${esc(l.output)}</div><span class="time">${fmtTime(l.createdAt)}</span></div></div>`);
  }
  if (S.pending) rows.push(`<div class="msg me"><div class="col"><div class="bubble">${esc(S.pending.text)}</div></div></div>`);
  if (S.sending) rows.push(`<div class="msg ai typing"><div class="avatar sm">${ini}</div><div class="col"><div class="bubble"><i></i><i></i><i></i></div></div></div>`);
  if (!rows.length) rows.push(`<div class="empty">${esc(name)}에게 먼저 말을 걸어 보세요.<br>아래 예시를 눌러 시작해도 돼요.</div>`);
  return rows.join("");
}
let lastSig = "";
function renderMsgs() {
  const el = $("#msgs"); if (!el) return;
  el.innerHTML = msgsHtml();
  const n = S.chat.length + (S.sending ? 1 : 0) + (S.pending ? 1 : 0);
  // 대화가 시작되면 편지는 접는다
  if (n > 0 && !S.letterClosed) { document.querySelector("details.letter")?.removeAttribute("open"); S.letterClosed = true; }
  // 말풍선이 새로 생기거나 바뀌었을 때만 그 말풍선으로 이동한다
  const sig = `${S.chat.length}|${S.sending}|${!!S.pending}`;
  if (S.scrollChat || sig !== lastSig) requestAnimationFrame(scrollToLatest);
  S.scrollChat = false; lastSig = sig;
  const btn = $("#send-btn"); if (btn) btn.disabled = S.sending;
}
// 마지막 말풍선이 머리글과 입력창 사이에 보이게 한다. 이미 보이면 움직이지 않고, 길면 말풍선의 첫 줄에 맞춘다.
function scrollToLatest() {
  const last = document.querySelector("#msgs .msg:last-child"); if (!last) return;
  const top = ($(".hdr")?.offsetHeight || 0) + 8;
  const bottom = window.innerHeight - (($("#chat-form")?.offsetHeight || 0) + 8);
  const r = last.getBoundingClientRect();
  if (r.top >= top && r.bottom <= bottom) return;
  const delta = r.height > bottom - top || r.top < top ? r.top - top : r.bottom - bottom;
  window.scrollTo({ top: window.scrollY + delta, behavior: "smooth" });
}

async function sendChat(text) {
  S.sending = true; S.pending = { text, base: S.chat.length }; renderMsgs();
  try {
    await call("aiRequest")({ code: S.code, stage: 1, type: "persona_chat", payload: { message: text } });
    S.draft = "";
  } catch (e) {
    toast(errMsg(e), true);
    S.pending = null; S.draft = text; const m = $("#msg"); if (m) m.value = text;
  } finally {
    S.sending = false;
    renderMsgs();
  }
}

const SEND_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>';

// 7단계: 문제 → 원인 → 대안 → 예상 문제 → 계획이 이어지는지 한눈에 본다
function flowRows() {
  const plan = w("s6.plan") || {};
  return [
    [1, "group", "우리 문제", txt(w("s1.problem.hmw"))],
    [3, "", "핵심 원인", txt(w("s3.chain.cause"))],
    [4, "", "최종 대안", txt(w("s4.final"))],
    [5, "", "예상되는 문제", txt(w("s5.newProblem"))],
    [6, "", plan.type === "patch" ? "대안 보완안" : "행동 계획", txt(plan.content)],
  ];
}

// 검증 질문이 어느 원인 가설을 확인하는지 표시
function causeTag(c) {
  if (!c.causeId) return "";
  const q = list("s2.causes").find((x) => x.id === c.causeId);
  return `<div style="margin-bottom:6px"><span class="tag">원인 가설</span> ${esc(q?.text || "(삭제된 원인)")}</div>`;
}

// ---------- 1단계 ②·③ 도우미 ----------
const findings = () => toList(w("s1.findings"));
const submitted = () => findings().filter((f) => f.submitted || (!("submitted" in f) && txt(f.text)));
const NOTE_FIELDS = [
  ["who", "1. 이 사람은 누구인가요?", "예) 어디에서 와서, 지금 무슨 일을 하는 사람"],
  ["hard", "2. 이 사람이 가장 힘들거나 걱정하는 것은?", "한 가지만 골라 쓰세요"],
  ["want", "3. 이 사람이 바라는 것은?", "이 사람이 원하는 것"],
  ["quote", "4. 기억에 남는 말 (대화에서 그대로 옮기기)", "따옴표 없이 그대로 옮겨 쓰세요"],
  ["doubt", "5. 사실인지 확인하고 싶은 말", "2단계에서 검증할 말"],
];
function findingCard(f, mine = false) {
  const rows = NOTE_FIELDS.filter(([k]) => txt(f[k])).map(([k, l]) => `<div class="f-row"><span>${esc(l.replace(/^\d\.\s*/, "").replace(/ \(.*\)$/, ""))}</span>${esc(f[k])}</div>`).join("");
  return `<div class="finding"><div class="f-head"><b>${esc(f.nick || "모둠원")}</b>${f.persona ? ` 님이 만난 <b>${esc(f.persona)}</b>` : ""}${mine ? ' <span class="tag">내 제출</span>' : ""}</div>
    ${rows || `<div class="f-row">${esc(f.text || "")}</div>`}</div>`;
}

const renderStage = {
  1() {
    const nav = `<div class="subnav">${SUBS.map((x) => `<button class="${S.sub1 === x.id ? "on" : ""}" data-go="1" data-sub="${x.id}">${x.name}<small>${x.who}</small></button>`).join("")}</div>`;
    if (!S.me) return `${roleBox(1)}<div class="notice">배정된 인물이 없습니다. 선생님께 알려 주세요.</div>`;
    return roleBox(1) + nav + sub1[S.sub1]();
  },

  2() {
    const cats = S.info.materials || [];
    const cur = cats.find((c) => c.id === S.matTab) || cats[0];
    const doubts = submitted().filter((f) => txt(f.doubt));
    const itemHtml = (it) => `<div class="mat-item"><span class="kind k-${esc(it.kind)}">${esc(it.kind)}</span><p>${esc(it.text)}</p><div class="cap">${esc(it.caption)}</div></div>`;
    const matBody = !cur ? `<div class="notice muted">선생님이 실제 자료를 준비하는 중입니다.</div>`
      : cur.type === "timeline"
        ? `<div class="timeline">${cur.items.map((it) => `<div class="tl"><div class="d">${esc(it.date)}</div><p>${esc(it.text)}</p><div class="cap">${esc(it.caption)}</div></div>`).join("")}</div>`
        : `${cur.stats ? `<div class="stats">${cur.stats.map((s, i) => `<div class="stat ${i === 2 ? "g" : i === 0 ? "" : "b"}"><b>${esc(s.value)}</b><span>${esc(s.label)}</span></div>`).join("")}</div>` : ""}
           <div class="mat">${cur.items.map(itemHtml).join("")}</div>`;
    return `${roleBox(2)}${problemBar()}
    <details class="fold" open><summary>실제 사건 자료</summary><div class="inner">
      <p class="desc">인물에게 들은 말과 비교할 자료입니다. <span class="kind">사실</span> <span class="kind k-증언">증언</span>은 일어난 일, <span class="kind k-주장">주장</span> <span class="kind k-의견">의견</span>은 누군가의 생각입니다.</p>
      <div class="chipbar scroll">${cats.map((c) => `<button class="chip ${cur && c.id === cur.id ? "on" : ""}" data-act="mat-tab" data-id="${c.id}">${esc(c.title)}</button>`).join("")}</div>
      ${matBody}</div></details>

    <div class="card"><h3>① 나·우리와 이어 보기 ${shared}</h3>
      <p class="desc">원인을 찾기 전에, 인물의 처지가 우리 주변과 어떻게 이어지는지 찾아보세요. 원인을 여러 층위에서 보는 데 도움이 됩니다.</p>
      ${listHtml("s2.links", (r) => `<span class="tag">${esc(r.level)}</span> <b>${esc(r.situation)}</b><br>이어지는 점: ${esc(r.point)}<br>확인하는 방법: ${esc(r.confirm)}`)}
      <label class="lbl">어느 층위에서 이어지나요?</label>
      <select id="lk-level">${CAUSE_LEVELS.map((x) => `<option>${x}</option>`).join("")}</select>
      <label class="lbl">인물의 처지 (한 문장)</label><input type="text" id="lk-sit" placeholder="예) 말이 통하지 않아 일자리를 구하기 어렵다" />
      <label class="lbl">우리 주변에서 비슷한 점</label><input type="text" id="lk-pt" placeholder="예) 우리 동네 시장에도 외국인 노동자가 일한다" />
      <label class="lbl">정말 그런지 확인하는 방법</label><input type="text" id="lk-cf" placeholder="예) 구청 외국인 지원 현황을 찾아본다" />
      <div style="margin-top:10px"><button class="btn btn-tinted" data-act="add-link">추가</button></div></div>

    <div class="card"><h3>② 원인 추측하기 (가설) ${shared}</h3>
      <p class="desc">위의 '우리 모둠의 문제'가 왜 생겼을까요? 아직은 추측(가설)입니다. 층위마다 하나 이상 쓰세요. 3단계에서 확인합니다.</p>
      ${listHtml("s2.causes", (q) => `${q.level ? `<span class="tag">${esc(q.level)}</span> ` : ""}${esc(q.text)}`)}
      <div class="row" style="margin-top:8px"><select id="cz-lv" style="width:auto">${CAUSE_LEVELS.map((x) => `<option>${x}</option>`).join("")}</select>
        <input type="text" id="cz" placeholder="예) 난민 신청자가 일할 수 있는 길이 좁았다" style="flex:1;min-width:0" /><button class="btn btn-tinted" data-act="add-cause">추가</button></div></div>

    <div class="card"><h3>③ 확인할 것을 검증 질문으로 바꾸기 ${shared}</h3>
      <p class="desc">확인할 것은 두 가지입니다. <b>인물에게 들은 말이 사실인지</b>, 그리고 <b>②의 원인 가설이 맞는지</b>. 각각을 질문으로 바꾸고, 위 자료와 먼저 비교해 보세요.</p>
      <div class="example"><b>좋은 검증 질문</b>은 ① 예/아니오나 숫자로 답할 수 있고 ② 언제·어디서·누가가 분명하고 ③ 확인할 자료가 있습니다.
        <div class="ex-row bad">✗ 난민은 위험한가? <span>생각(의견)을 묻는 질문이라 자료로 확인할 수 없어요</span></div>
        <div class="ex-row good">✓ 2018년에 제주에 온 예멘 난민 신청자는 몇 명인가? <span>숫자로 답할 수 있고 자료가 있어요</span></div></div>
      ${list("s2.checks").map((c) => `<div class="card flat" style="margin-bottom:10px">
        ${causeTag(c)}<div><span class="tag b">확인할 말</span> ${esc(c.heard)}</div>
        <div style="margin-top:6px"><span class="tag y">검증 질문</span> <b>${esc(c.question)}</b>${c.srcType ? ` <span class="tag x">${esc(c.srcType)}</span>` : ""}</div>
        ${pick(`s2.checks.${c.id}.real`, "위 자료와 비교하면?", COMPARE)}
        <div class="row" style="margin-top:8px;justify-content:space-between">${who(c)}<button class="btn btn-plain btn-sm" data-act="del" data-path="s2.checks" data-id="${c.id}">삭제</button></div></div>`).join("") || `<div class="meta-line" style="margin-bottom:8px">아직 없습니다. 아래에 추가하세요.</div>`}
      ${doubts.length ? `<label class="lbl">모둠원이 확인하고 싶다고 한 말 (누르면 아래 칸에 들어가요)</label>
        <div class="chipbar">${doubts.map((f) => `<button class="chip" data-act="use-doubt" data-t="${esc(`${f.persona || f.nick}: ${f.doubt}`)}">${esc(f.doubt.slice(0, 30))}</button>`).join("")}</div>` : ""}
      <label class="lbl">무엇을 확인하나요?</label><select id="ch-cause"><option value="">인물에게 들은 말</option>${list("s2.causes").map((q) => `<option value="${q.id}">원인 가설: ${esc((q.text || "").slice(0, 40))}</option>`).join("")}</select>
      <label class="lbl">확인할 말 (들은 말이면 누가 한 말인지 함께)</label><input type="text" id="ch-heard" placeholder="예) ○○: 일자리를 구하기 어려웠다" />
      <label class="lbl">검증 질문</label><input type="text" id="ch-q" placeholder="예) 2018년 제주의 난민 신청자는 합법적으로 일할 수 있었나?" />
      <label class="lbl">무엇으로 확인할까요?</label><select id="ch-src">${SRC_TYPES.map((x) => `<option>${x}</option>`).join("")}</select>
      <div style="margin-top:10px"><button class="btn btn-tinted" data-act="add-check">추가</button></div></div>`;
  },

  3() {
    const checks = list("s2.checks"), causes = list("s2.causes");
    const verdictsFor = (cid) => checks.filter((c) => c.causeId === cid)
      .flatMap((c) => stageLogs(3).filter((l) => l.payload?.checkId === c.id).map((l) => w(`s3.checks.${l.id}.verdict`)).filter(Boolean));
    const kept = causes.filter((q) => w(`s3.causes.${q.id}.status`) === CAUSE_STATUS[0]);
    return `${roleBox(3)}${problemBar()}
    <div class="card"><h3>① 검증 질문 확인하기 ${shared}</h3>
      <p class="desc">순서: <b>AI에게 묻기 → 2단계 자료나 직접 찾은 자료와 비교 → 사실인지 판정</b>. AI의 답도 확인할 대상입니다.</p>
      ${!checks.length ? `<div class="notice">2단계 ③에서 검증 질문을 먼저 만드세요. <button class="link" data-go="2">2단계로 가기</button></div>` : ""}</div>
    ${checks.map((c) => {
      const logs = stageLogs(3).filter((l) => l.payload?.checkId === c.id);
      return `<div class="card">
        ${causeTag(c)}<div><span class="tag b">확인할 말</span> ${esc(c.heard)}</div>
        <div style="margin-top:6px"><span class="tag y">검증 질문</span> <b>${esc(c.question)}</b></div>
        ${c.real ? `<div class="meta-line" style="margin-top:6px">2단계 자료 비교: ${esc(c.real)}</div>` : ""}
        ${logs.length ? "" : `<div class="row" style="margin-top:10px"><button class="btn btn-primary btn-sm" data-act="ask-check" data-id="${c.id}" ${S.busy ? "disabled" : ""}>AI 검색 도우미에게 묻기</button></div>`}
        ${S.busy === "check:" + c.id ? loading() : ""}
        ${logs.map((l) => `<div style="margin-top:12px"><div class="meta-line">AI 검색 도우미의 답</div><div class="ai-out">${esc(l.output)}</div>
          <div class="judge">${pick(`s3.checks.${l.id}.verdict`, "판정: 확인할 말은 사실인가요?", VERDICTS)}
          ${fld(`s3.checks.${l.id}.source`, "판정 근거: 어떤 자료에서 무엇을 확인했나요?", "예) 2단계 '심사 결과' 자료에 인도적 체류 412명이라고 나와 있다")}
          ${fld(`s3.checks.${l.id}.reason`, "AI 답 점검: 자료와 다르거나 확인되지 않은 부분은?", "없으면 '없음'")}</div></div>`).join("")}
        ${logs.length ? `<div style="margin-top:8px"><button class="btn btn-plain btn-sm" data-act="ask-check" data-id="${c.id}" ${S.busy ? "disabled" : ""}>다시 묻기</button></div>` : ""}
      </div>`; }).join("")}
    <div class="card"><h3>② 원인 가설 점검하기 ${shared}</h3>
      <p class="desc">2단계에서 추측한 원인마다 위의 검증 결과를 보고, 남길지 버릴지 정하세요.</p>
      ${causes.length ? `<div class="group">${causes.map((q) => { const vs = verdictsFor(q.id);
        return `<div class="cell"><div class="grow">${q.level ? `<span class="tag">${esc(q.level)}</span> ` : ""}<b>${esc(q.text)}</b>
          <div class="meta-line">${vs.length ? `관련 검증 판정: ${esc(vs.join(", "))}` : "관련 검증 질문이 없습니다. 판단 근거가 약해요."}</div>
          ${pick(`s3.causes.${q.id}.status`, "", CAUSE_STATUS)}</div></div>`; }).join("")}</div>`
        : `<div class="notice">2단계 ②에서 원인 가설을 먼저 쓰세요. <button class="link" data-go="2">2단계로 가기</button></div>`}</div>
    <div class="card"><h3>③ 핵심 원인 정하기 ${shared}</h3>
      <p class="desc">'근거로 뒷받침됨'인 원인에서 출발해 <b>사실 → 뜻 → 원인</b> 순서로 이어 쓰세요.</p>
      ${kept.length ? `<div class="notice muted"><b>남긴 원인</b><br>${kept.map((q) => `· ${esc(q.text)}`).join("<br>")}</div>` : ""}
      ${fld("s3.chain.evidence", "① 확인된 사실", "위에서 '사실이다'로 판정한 내용", true)}
      ${fld("s3.chain.meaning", "② 그 사실이 뜻하는 것", "그 사실은 무엇을 보여 주나요?", true)}
      ${fld("s3.chain.cause", "③ 그래서 우리 문제의 핵심 원인은", "남긴 원인 중 가장 중요한 것을 한두 문장으로", true)}</div>`;
  },

  4() {
    const props = list("s4.proposals"), logs = stageLogs(4);
    const cause = txt(w("s3.chain.cause"));
    return `${roleBox(4)}${problemBar()}
    ${cause ? `<div class="notice muted"><b>3단계에서 정한 핵심 원인</b><br>${esc(cause)}</div>` : ""}
    <div class="card"><h3>① 우리 모둠 대안 쓰기 ${shared}</h3>
      <p class="desc">위의 핵심 원인을 줄일 대안을 먼저 우리끼리 쓰세요. 여러 개를 써서 비교해도 좋아요. <b>누가, 무엇을, 어떻게</b> 할지 30자 이상 써야 AI 검토를 받을 수 있어요.</p>
      ${props.map((p) => `<div class="card flat" style="margin-bottom:10px"><div class="grow">${esc(p.text)}</div>${who(p)}
        <div class="row" style="margin-top:8px"><button class="btn btn-primary btn-sm" data-act="ask-feedback" data-id="${p.id}" ${S.busy ? "disabled" : ""}>AI 검토 받기</button>
        <button class="btn btn-plain btn-sm" data-act="del" data-path="s4.proposals" data-id="${p.id}">삭제</button></div></div>`).join("")}
      <textarea id="pt" placeholder="예) 누가: ○○이 / 무엇을: ○○을 / 어떻게: ○○ 방식으로"></textarea>
      <div style="margin-top:8px"><button class="btn btn-tinted" data-act="add-proposal">대안 추가</button></div>
      ${S.busy === "feedback" ? loading("검토자 3명이 각자 검토하는 중입니다…") : ""}</div>
    ${logs.map((l) => { let rv = []; try { rv = JSON.parse(l.output).reviews || []; } catch {}
      const p = props.find((x) => x.id === l.payload?.proposalId);
      return `<div class="card"><div class="meta-line">검토를 받은 대안</div><b>${esc((p?.text || l.input).slice(0, 80))}</b>
      <p class="desc" style="margin-top:6px">검토자 3명은 서로의 의견을 모릅니다. 의견을 비교하고, 받아들일지 우리가 정하세요.</p>
      ${rv.map((r) => `<div class="card flat" style="margin-bottom:8px"><span class="tag b">${esc(r.label)}</span><div class="ai-out" style="background:transparent;padding:6px 0 0">${esc(r.text)}</div></div>`).join("")}
      <div class="judge">${fld(`s4.decisions.${l.id}.compare`, "세 의견에서 공통으로 지적한 점은?", "", true)}
      ${pick(`s4.decisions.${l.id}.choice`, "이 검토를 어떻게 할까요?", ["수용", "수정해서 반영", "기각"])}
      ${fld(`s4.decisions.${l.id}.reason`, "그렇게 정한 이유", "", true)}</div></div>`; }).join("")}
    <div class="card"><h3>② 최종 대안 ${shared}</h3>
      <p class="desc">대안 하나를 골라 검토에서 나온 약점을 보완해 쓰세요. 5단계에서 이 최종 대안으로 미래를 시뮬레이션합니다.</p>
      ${fld("s4.final", "", "보완한 최종 대안 (누가, 무엇을, 어떻게)", true)}
      ${fld("s4.finalReason", "이 대안을 고른 이유", "", true)}
      ${pick("s4.finalFit", "이 대안은 우리 문제 질문의 두 바람('~하면서도 ~')을 모두 다루나요?", ["둘 다 다룬다", "한쪽만 다룬다"])}
      ${w("s4.finalFit") === "한쪽만 다룬다" ? `<div class="notice yellow">한쪽만 다룬다면 대안을 보완하거나, 1단계 ③의 문제 질문이 너무 넓지 않은지 다시 보세요.</div>` : ""}</div>`;
  },

  5() {
    const preds = list("s5.predictions"), logs = stageLogs(5);
    const sh = S.info.stakeholders || [];
    const final = txt(w("s4.final"));
    // 최종 대안을 먼저 보여 주고, 아직 없으면 후보 대안으로도 해 볼 수 있다
    const opts = [...(final.length >= 30 ? [{ id: "final", text: `[최종] ${final}` }] : []), ...list("s4.proposals")];
    if (!opts.some((o) => o.id === S.proposalId)) S.proposalId = opts[0]?.id || null;
    const altText = (l) => (l.payload?.proposalId === "final" ? "최종 대안" : "후보 대안");
    return `${roleBox(5)}${problemBar()}
    <div class="notice muted"><b>4단계 최종 대안</b><br>${final ? esc(final) : "아직 쓰지 않았어요. <button class=\"link\" data-go=\"4\">4단계 ②에서 쓰기</button>"}</div>
    <div class="card"><h3>① 이해관계자 반응 예측하기 ${shared}</h3>
      <p class="desc">AI보다 먼저 예측하세요. 위의 최종 대안이 실행되면 각 이해관계자는 어떻게 반응할까요? 2개 이상 써야 시뮬레이션을 할 수 있어요.</p>
      ${listHtml("s5.predictions", (r) => `<span class="tag">${esc(r.stakeholder)}</span> ${esc(r.text)}`)}
      <div class="row" style="margin-top:8px"><select id="ps" style="width:auto">${sh.map((x) => `<option>${esc(x)}</option>`).join("")}</select>
      <input type="text" id="pp" placeholder="예) 반대할 것이다. 왜냐하면 ~" style="flex:1;min-width:0" /><button class="btn btn-tinted" data-act="add-pred">추가</button></div></div>
    <div class="card"><h3>② AI 시뮬레이션</h3>
      <p class="desc">대안을 실행하고 몇 년 뒤의 가능한 미래 2가지를 봅니다. 정답이 아니라 '그럴 수도 있는' 미래입니다.</p>
      ${opts.length ? `<label class="lbl">시뮬레이션할 대안</label><select id="sp">${opts.map((p) => `<option value="${p.id}" ${p.id === S.proposalId ? "selected" : ""}>${esc((p.text || "").slice(0, 50))}</option>`).join("")}</select>
      <label class="lbl">몇 년 후?</label><div class="chipbar">${ROUNDS.map((r) => `<button class="chip ${S.round === r ? "on" : ""}" data-act="round" data-r="${r}">${r}년 후</button>`).join("")}</div>
      ${S.busy === "scenario" ? loading("시나리오를 만드는 중입니다. 1~2분 걸릴 수 있어요…") : ""}<div style="margin-top:10px"><button class="btn btn-primary" data-act="ask-scenario" ${preds.length >= 2 && !S.busy ? "" : "disabled"}>시나리오 만들기</button></div>`
        : `<div class="notice">4단계에서 최종 대안을 30자 이상 먼저 쓰세요.</div>`}</div>
    ${logs.map((l) => { let sc = []; try { sc = JSON.parse(l.output).scenarios || []; } catch {}
      const sel = w(`s5.selection.${l.id}`) || {};
      return `<div class="card"><div class="meta-line">${altText(l)} · ${l.payload?.round}년 후 시나리오</div>
      ${sc.map((x, i) => `<div class="scn ${sel.idx === i ? "sel" : ""}"><b>${esc(x.title)}</b><p style="margin-top:6px">${esc(x.story)}</p>
        <div class="mech"><b>왜 그렇게 되나 (작동 기제)</b> ${esc(x.mechanism || "")}</div>
        <div class="meta-line">의도하지 않은 결과: ${esc([].concat(x.unintended || []).join(" / "))}</div>
        <div class="meta-line">예상되는 문제: ${esc([].concat(x.newProblems || []).join(" / "))}</div>
        <button class="btn ${sel.idx === i ? "btn-tinted" : "btn-plain"} btn-sm" style="margin-top:8px" data-act="pick-scn" data-id="${l.id}" data-i="${i}">${sel.idx === i ? "✓ 더 그럴듯하다고 고름" : "이쪽이 더 그럴듯하다"}</button></div>`).join("")}
      <div class="judge">${fld(`s5.selection.${l.id}.mech`, "작동 기제 점검: 현실에서도 그렇게 될까요? 약한 부분은?", "", true)}
      ${fld(`s5.selection.${l.id}.reason`, "그럴듯하다고 고른 이유", "", true)}</div></div>`; }).join("")}
    <div class="card"><h3>③ 대안 실행 뒤 생길 수 있는 문제 ${shared}</h3>
      ${fld("s5.newProblem", "", "고른 시나리오에서 가장 걱정되는 문제", true)}</div>`;
  },

  6() {
    const type = w("s6.plan.type") || "action";
    const isAct = type === "action";
    return `${roleBox(6)}${problemBar()}
    <div class="card"><h3>지금까지 정한 것</h3>
      <div class="meta-line">4단계 최종 대안</div><div class="ai-out">${esc(w("s4.final") || "아직 적지 않았습니다.")}</div>
      <div class="meta-line">5단계에서 예상한 문제</div><div class="ai-out" style="background:var(--accent-tint)">${esc(w("s5.newProblem") || "아직 적지 않았습니다.")}</div></div>
    <div class="card"><h3>무엇을 계획할까요? ${shared}</h3>
      <div class="chipbar"><button class="chip ${isAct ? "on" : ""}" data-act="plan-type" data-v="action">행동 계획</button><button class="chip ${!isAct ? "on" : ""}" data-act="plan-type" data-v="patch">대안 보완안</button></div>
      <p class="desc" style="margin-top:10px">${isAct ? "우리가 학교 안에서 실제로 할 수 있는 일을 계획하세요. (예: 설득하는 편지 쓰기, 실천 약속)" : "5단계에서 예상한 문제가 생기지 않도록 대안을 어떻게 고칠지 계획하세요."}</p>
      ${fld("s6.plan.target", isAct ? "누구에게 / 무엇에 대해" : "막으려는 문제", "", true)}
      ${fld("s6.plan.content", isAct ? "할 일" : "고칠 내용", "", true)}
      ${fld("s6.plan.method", "방법", "어떻게 할 것인가", true)}
      ${fld("s6.plan.effect", "기대 효과", "이 계획으로 기대하는 변화", true)}
      ${fld("s6.plan.difficulty", "예상되는 어려움과 대응", "잘 안 되면 어느 단계를 다시 볼까요?", true)}</div>
    <div class="card"><h3>결과가 예상과 다르다면?</h3><p class="desc">앞 단계로 돌아가 다시 생각할 수 있습니다.</p>
      <div class="row"><button class="btn btn-plain btn-sm" data-go="1" data-sub="group">문제 다시 보기</button><button class="btn btn-plain btn-sm" data-go="3">원인 다시 보기</button><button class="btn btn-plain btn-sm" data-go="4">대안 다시 보기</button><button class="btn btn-plain btn-sm" data-go="5">예측 다시 보기</button></div></div>`;
  },

  7() {
    const rows = [[1, "인물 대화 (나)", S.chat.length], ...[3, 4, 5].map((n) => [n, `${n}단계 ${STAGES[n - 1].name}`, stageLogs(n).length])];
    const dec = Object.values(w("s4.decisions") || {}), cnt = (k) => dec.filter((d) => d.choice === k).length;
    return `${roleBox(7)}
    <div class="card"><h3>① AI 사용 기록</h3>
      <div class="group">${rows.map((b) => `<div class="cell"><span class="grow">${b[1]}</span><b>${b[2]}회</b></div>`).join("")}
      <div class="cell"><span class="grow">AI 검토에 대한 판단</span><span>수용 ${cnt("수용")} · 수정 ${cnt("수정해서 반영")} · 기각 ${cnt("기각")}</span></div></div></div>
    <div class="card"><h3>② 우리 모둠의 흐름</h3>
      <p class="desc">앞 단계에서 정한 것입니다. 빈 칸이 있거나 서로 이어지지 않으면 그 단계로 돌아가 고치세요.</p>
      <div class="flow">${flowRows().map(([n, sub, k, v]) => `<div class="fl ${v ? "" : "miss"}"><span>${k}</span><div>${v ? esc(v) : "비어 있음"}</div>
        <button class="link" data-go="${n}" data-sub="${sub || ""}">${n}단계</button></div>`).join("")}</div></div>
    <div class="card"><h3>③ 발표 준비 ${shared}</h3>
      <p class="desc">위의 흐름을 바탕으로, 왜 그렇게 정했는지 근거를 넣어 짧게 정리하세요.</p>
      ${fld("s7.share", "", "", true)}</div>
    <div class="card"><h3>④ AI 활용 점검 ${shared}</h3>
      <div class="group">${CHECKLIST.map((t, i) => `<label class="cell" style="cursor:pointer"><input type="checkbox" data-save="s7.checks.${i}" ${w(`s7.checks.${i}`) ? "checked" : ""} style="width:20px;height:20px;margin-top:2px"><span class="grow">${esc(t)}</span></label>`).join("")}</div>
      ${fld("s7.reflection", "오늘 AI의 답 중 무엇을 받아들이고 무엇을 버렸나요? 왜 그랬나요?", "", true)}</div>`;
  },
};

const sub1 = {
  chat() {
    const info = S.info, me = S.me;
    return `<div class="card"><h2>${esc(info.title)}</h2><p>${esc(info.summary)}</p></div>
    <details class="letter" ${S.chat.length ? "" : "open"}>
      <summary>${esc(me.name)}에게서 온 편지</summary>
      <div class="body">${me.letter.map((p) => `<p>${esc(p)}</p>`).join("")}<div class="sign">${esc(me.name)} 드림</div></div>
    </details>
    <div class="notice muted"><b>할 일</b> ${esc(me.name)}에게 질문해 세 가지를 알아내세요: <b>① 누구인지 ② 무엇이 힘든지 ③ 무엇을 바라는지</b>. 다 알아냈으면 아래 '다음'을 누르세요.</div>
    <div class="card chat-card">
      <div class="chat-head"><div class="avatar">${esc(me.name.slice(0, 1))}</div><div><div class="nm">${esc(me.name)}</div><div class="st">대화 중</div></div></div>
      <div class="msgs" id="msgs"></div>
      <div class="starters">${STARTERS.map((q) => `<button class="chip sm" data-act="starter" data-t="${esc(q)}">${esc(q)}</button>`).join("")}</div>
      <form class="composer" id="chat-form" autocomplete="off">
        <input type="text" id="msg" maxlength="500" placeholder="${esc(me.name)}에게 메시지 보내기" />
        <button class="send" id="send-btn" type="submit" aria-label="보내기">${SEND_ICON}</button>
      </form>
    </div>`;
  },

  note() {
    const mine = w(`s1.findings.${S.uid}`) || {};
    const others = submitted().filter((f) => f.id !== S.uid);
    const done = submitted().length;
    const total = Math.max(S.memberCount, done);
    const status = `<div class="meta-line">모둠 제출 현황: <b>${done} / ${total}명</b></div>`;
    if (!mine.submitted) {
      return `<div class="card"><h3>② 알아낸 점 정리하고 제출하기 <span class="tag x">혼자</span></h3>
        <p class="desc">${esc(S.me.name)}와의 대화에서 알아낸 것을 <b>내 말로</b> 쓰세요. 1~3번은 꼭 써야 제출할 수 있어요. 제출하면 모둠원 화면에 보입니다.</p>
        ${NOTE_FIELDS.map(([k, l, ph]) => fld(`s1.findings.${S.uid}.${k}`, l, ph)).join("")}
        <div class="row" style="margin-top:14px;justify-content:space-between">${status}<button class="btn btn-primary" data-act="submit-note">제출하기</button></div></div>
        <div class="notice muted">제출하면 모둠원이 제출한 내용도 볼 수 있어요. (지금 ${done}명 제출)</div>`;
    }
    return `<div class="card"><h3>② 내가 제출한 내용</h3>${findingCard({ ...mine, nick: S.nick }, true)}
      <div class="row" style="margin-top:10px;justify-content:space-between">${status}<button class="btn btn-plain btn-sm" data-act="edit-note">수정하기</button></div></div>
    <div class="card"><h3>모둠원이 제출한 내용</h3>
      ${others.map((f) => findingCard(f)).join("") || `<div class="meta-line">아직 제출한 모둠원이 없습니다.</div>`}
      ${done < total ? `<div class="meta-line" style="margin-top:8px">모두 제출하면 ③ 모둠 문제 정하기로 넘어가세요.</div>` : ""}</div>`;
  },

  group() {
    const mine = w(`s1.findings.${S.uid}`) || {};
    if (!mine.submitted) return `<div class="notice">먼저 ② 알아낸 점을 제출하세요. 그래야 모둠원의 이야기를 함께 볼 수 있어요. <button class="link" data-go="1" data-sub="note">②로 가기</button></div>`;
    const all = submitted();
    const done = all.length, total = Math.max(S.memberCount, done);
    const chk = (i) => `<label class="cell" style="cursor:pointer"><input type="checkbox" data-save="s1.problem.checks.${i}" ${w(`s1.problem.checks.${i}`) ? "checked" : ""} style="width:20px;height:20px;margin-top:2px"><span class="grow">${esc(PROBLEM_CHECKS[i])}</span></label>`;
    return `<div class="notice green"><b>여기부터는 모둠 활동입니다.</b> 화면을 같이 보며 얼굴을 맞대고 이야기하세요. 아래 칸은 모둠 공용이라 누가 써도 모든 모둠원 화면에 바로 나타납니다.</div>
    <div class="card"><h3>1) 모둠원이 만난 사람들 나란히 보기</h3>
      <p class="desc">각자 만난 사람을 돌아가며 1분씩 소개하세요. 같은 사건을 서로 어떻게 다르게 보는지, 같은 처지라도 생각이 어떻게 다른지 찾아보세요. (제출 ${done} / ${total}명)</p>
      <div class="board">${all.map((f) => `<div class="b-col"><div class="b-h">${esc(f.persona || "인물")}<small>${esc(f.nick || "")}</small></div>
        <div class="b-r"><span>누구</span>${esc(f.who || f.text || "")}</div><div class="b-r"><span>힘든 것</span>${esc(f.hard || "")}</div><div class="b-r"><span>바라는 것</span>${esc(f.want || "")}</div></div>`).join("")}</div></div>
    <div class="card"><h3>2) 같은 점 찾기 ${shared}</h3>
      ${fld("s1.problem.common", "여러 사람이 함께 겪거나 걱정하는 것은?", "예) ○○와 △△ 모두 ~을 걱정한다", true)}</div>
    <div class="card"><h3>3) 부딪히는 점 찾기 ${shared}</h3>
      ${fld("s1.problem.conflict", "누구의 바람과 누구의 걱정이 부딪히나요?", "예) ○○는 ~을 원하지만, △△는 ~을 걱정한다", true)}</div>
    <div class="card"><h3>4) 우리 모둠의 문제를 한 문장으로 ${shared}</h3>
      <p class="desc">2)와 3)을 합쳐 '어떻게 하면 ~하면서도 ~할 수 있을까?' 질문으로 쓰세요. 한쪽 편만 드는 질문이 아니라 <b>부딪히는 두 바람을 함께 담는</b> 질문이 좋습니다.</p>
      <div class="example"><div class="ex-row bad">✗ 난민 문제 <span>너무 넓어요</span></div>
        <div class="ex-row bad">✗ 난민을 받아들여야 한다 <span>이미 답을 정한 주장이에요</span></div>
        <div class="ex-row good">✓ (다른 주제 예시) 어떻게 하면 급식 줄 서는 시간을 줄이면서도 모두가 충분히 먹을 수 있을까?</div></div>
      ${fld("s1.problem.situation", "문제 상황: 누가 어떤 어려움을 겪고 있나요? (한두 문장)", "", true)}
      ${fld("s1.problem.hmw", "우리가 풀 질문", "어떻게 하면 ________하면서도 ________할 수 있을까?", true)}</div>
    <div class="card"><h3>5) 점검하기 ${shared}</h3>
      <p class="desc">모두 체크되면 2단계로 넘어가세요. 체크가 안 되는 칸이 있으면 4)를 고치세요.</p>
      <div class="group">${PROBLEM_CHECKS.map((_, i) => chk(i)).join("")}</div></div>`;
  },
};

// ---------- 이벤트 ----------
const val = (id) => document.getElementById(id)?.value.trim() ?? "";

async function aiGroup(stage, type, payload, busyKey) {
  await flushAll();
  S.busy = busyKey; render(true);
  try { await call("aiRequest")({ code: S.code, stage, type, payload }); }
  catch (e) { toast(errMsg(e), true); }
  finally { S.busy = null; render(true); }
}

panel.addEventListener("submit", (e) => {
  if (e.target.id !== "chat-form") return;
  e.preventDefault();
  const m = $("#msg"); const text = m.value.trim();
  if (!text || S.sending) return;
  m.value = ""; S.draft = "";
  sendChat(text);
});

panel.addEventListener("click", async (e) => {
  const go = e.target.closest("[data-go]");
  if (go) { goTo(Number(go.dataset.go), go.dataset.sub || null); return; }
  const b = e.target.closest("[data-act]"); if (!b) return;
  const a = b.dataset.act, d = b.dataset;

  switch (a) {
    case "del": if (confirm("삭제할까요? 모둠원 화면에서도 사라집니다.")) await delItem(d.path, d.id); break;
    case "mat-tab": S.matTab = d.id; render(true); break;
    case "starter": { const m = $("#msg"); if (m) { m.value = d.t; S.draft = d.t; m.focus(); } break; }
    case "submit-note": {
      await flushAll();
      const mine = w(`s1.findings.${S.uid}`) || {};
      if (["who", "hard", "want"].some((k) => txt(mine[k]).length < 2)) return toast("1~3번을 모두 써야 제출할 수 있어요.", true);
      await save(`s1.findings.${S.uid}`, { ...mine, nick: S.nick, persona: S.me?.name || "", submitted: true, t: Date.now() });
      toast("제출했어요. 모둠원의 내용을 확인하세요."); break;
    }
    case "edit-note": await save(`s1.findings.${S.uid}.submitted`, false); break;
    case "use-doubt": { const h = $("#ch-heard"); if (h) { h.value = d.t; $("#ch-q")?.focus(); } break; }
    case "add-check": {
      if (val("ch-heard").length < 3 || val("ch-q").length < 5) return toast("확인할 말과 검증 질문을 구체적으로 쓰세요.", true);
      await addItem("s2.checks", { heard: val("ch-heard"), question: val("ch-q"), srcType: val("ch-src"), causeId: val("ch-cause") }); render(true); break;
    }
    case "add-link": {
      if (val("lk-sit").length < 4 || val("lk-pt").length < 4 || val("lk-cf").length < 4) return toast("세 칸을 모두 구체적으로 쓰세요.", true);
      await addItem("s2.links", { level: val("lk-level"), situation: val("lk-sit"), point: val("lk-pt"), confirm: val("lk-cf") }); render(true); break;
    }
    case "add-cause": { if (val("cz").length < 4) return toast("원인을 한 문장으로 쓰세요.", true); await addItem("s2.causes", { level: val("cz-lv"), text: val("cz") }); render(true); break; }
    case "ask-check": await aiGroup(3, "verify_query", { checkId: d.id }, "check:" + d.id); break;
    case "add-proposal": {
      const t = val("pt"); if (t.length < 30) return toast("대안을 30자 이상 쓰세요.", true);
      S.proposalId = await addItem("s4.proposals", { text: t }); render(true); break;
    }
    case "ask-feedback": S.proposalId = d.id; await aiGroup(4, "proposal_feedback", { proposalId: d.id }, "feedback"); break;
    case "add-pred": {
      if (val("pp").length < 10) return toast("예측과 이유를 10자 이상 쓰세요.", true);
      await addItem("s5.predictions", { stakeholder: val("ps"), text: val("pp") }); render(true); break;
    }
    case "round": S.round = Number(d.r); render(true); break;
    case "ask-scenario": { const pid = val("sp") || S.proposalId; S.proposalId = pid; await aiGroup(5, "scenario", { proposalId: pid, round: S.round }, "scenario"); break; }
    case "pick-scn": setLocal(`s5.selection.${d.id}.idx`, Number(d.i)); render(true); await save(`s5.selection.${d.id}.idx`, Number(d.i)); break;
    case "plan-type": setLocal("s6.plan.type", d.v); render(true); await save("s6.plan.type", d.v); break;
  }
});

// 저장 칸: 글은 입력이 멈추면, 선택·체크는 바로 저장한다
panel.addEventListener("input", (e) => {
  const el = e.target;
  if (el.id === "msg") { S.draft = el.value; return; }
  const p = el.dataset?.save;
  if (p && el.type !== "checkbox" && el.tagName !== "SELECT") queueSave(p, el.value);
});
panel.addEventListener("change", (e) => {
  const el = e.target;
  // 원인 가설을 고르면 확인할 말 칸에 그 원인을 넣어 준다
  if (el.id === "ch-cause") { const q = list("s2.causes").find((x) => x.id === el.value); const h = $("#ch-heard"); if (q && h) h.value = q.text; return; }
  const p = el.dataset?.save; if (!p) return;
  if (el.type === "checkbox") { setLocal(p, el.checked); save(p, el.checked); }
  else if (el.tagName === "SELECT") { setLocal(p, el.value); save(p, el.value); if (p === "s4.finalFit") render(true); }
  else flushSave(p);
});
// 공용 칸에 들어가면 모둠원 화면에 '입력 중'을 표시하고, 나오면 지운다
const isShared = (p) => p && !p.startsWith("s1.findings.");
panel.addEventListener("focusin", (e) => {
  const p = e.target.dataset?.save;
  if (isShared(p) && e.target.type !== "checkbox" && e.target.tagName !== "SELECT") save(`live.${S.uid}`, { path: p, nick: S.nick, t: Date.now() });
});
panel.addEventListener("focusout", (e) => {
  const p = e.target.dataset?.save;
  if (p) { flushSave(p); if (isShared(p)) save(`live.${S.uid}`, deleteField()); }
  setTimeout(runDeferred, 0);
});
