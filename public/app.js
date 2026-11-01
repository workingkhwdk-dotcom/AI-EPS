import { auth, db, call, esc, toast, toastAction, errMsg } from "./fb.js";
import { waitHtml, startWaitTicker, STEPS } from "./wait.js";
import { showModal, confirmModal } from "./modal.js";
import { HELP, helpSimple, helpDetail, fill } from "./help.js";
import { openResult, seenAt as resSeenAt, markSeen as resMarkSeen } from "./result.js";
import { signInAnonymously, onAuthStateChanged, setPersistence, browserSessionPersistence, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc, getDocFromServer, onSnapshot, updateDoc, collection, query, orderBy, serverTimestamp, deleteField } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// short: 휴대폰 아래 단계 막대처럼 칸이 좁은 곳에 쓰는 짧은 이름
const STAGES = [
  { n: 1, name: "이야기 듣기", short: "이야기", ai: "Y", cap: "공감하고 문제 정하기" },
  { n: 2, name: "원인 찾기", short: "원인", ai: "Y", cap: "연결·원인 찾기" },
  { n: 3, name: "사실 확인", short: "사실 확인", ai: "Y", cap: "검증하기" },
  { n: 4, name: "해결책 만들기", short: "해결책", ai: "Y", cap: "해결책 만들기" },
  { n: 5, name: "미래 그려 보기", short: "미래", ai: "Y", cap: "결과 예측하기" },
  { n: 6, name: "실천 계획", short: "실천", ai: "X", cap: "실천 계획하기" },
  { n: 7, name: "돌아보기", short: "돌아보기", ai: "X", cap: "성찰하기" },
];
const ROUNDS = [1, 3, 5];
// 7단계 AI 사용 돌아보기(체크는 선택). 연구 문항에 맞춰 수정하세요.
const CHECKLIST = [
  "AI에게 묻기 전에 내가 먼저 생각했다.",
  "AI의 답을 자료와 견주어 확인했다.",
  "최종 판단은 우리 모둠이 직접 내렸다.",
  "AI에게 개인정보를 알려 주지 않았다.",
];
// 1단계 문제 문장 점검(세 가지)
const PROBLEM_CHECKS = [
  "두 사람 이상의 바람이 함께 들어 있다.",
  "누구를 탓하거나 깎아내리는 말이 없다.",
  "답(해결책)을 미리 정해 두지 않았다.",
];
const VERDICTS = ["사실이다", "일부만 사실이다", "사실이 아니다", "확인할 수 없다"];
const CAUSE_LEVELS = ["사람들의 생각·선택", "동네·사회 분위기", "법·제도·규칙"];
// 4단계: AI 조언을 어떻게 받아들일지
const DECISIONS = ["받아들인다", "고쳐서 반영한다", "받아들이지 않는다"];
const CAUSE_STATUS = ["확인돼서 남겨요", "아직 확실하지 않아요", "버려요"];
// ---------- 학교급(중·고)과 심화 활동 (functions/level.js 와 같은 목록) ----------
// 중학교: 원인 갈래 2개, 판정 3가지, 확인 질문에 '사실인가 의견인가'와 '무엇을 보면 될까', 4단계 해결책 점검, 미래는 1년 후만.
// 심화 활동(deep)은 학교급과 따로 수업 설정에서 켜고 끈다. 값이 없는 예전 수업은 모두 꺼져 있다.
const MID = () => S.level === "middle";
const deep = (k) => S.deep?.[k] === true;
const CAUSE_LEVELS_MID = ["사람들의 생각·선택", "사회의 규칙·분위기"];
const causeLevels = () => (MID() ? CAUSE_LEVELS_MID : CAUSE_LEVELS);
const verdicts = () => (MID() ? [VERDICTS[0], VERDICTS[2], VERDICTS[3]] : VERDICTS);
const rounds = () => (MID() ? [1] : ROUNDS);
const lensCount = () => (MID() ? 2 : 3); // 4단계 AI 검토자 수(서버 level.js 의 LENSES_BY)
const FACT_OPINION = ["사실을 말한 것 같아요", "생각(의견)을 말한 것 같아요"];
// 1단계 ③ 심화: 부딪히는 두 바람 밑에 있는 가치
const VALUES = ["안전", "자유", "생계(먹고사는 일)", "평등·공정", "인권", "환경", "공동체·전통", "비용·효율", "미래 세대"];
// 2단계 ② 심화: 원인끼리 잇기
const CAUSE_RELS = ["생겼어요", "더 커졌어요"];
// 예전 수업에 남은 값도 같은 말로 보여 준다
const relText = (r) => ({ "을(를) 불러와요": "생겼어요", "을(를) 더 키워요": "더 커졌어요" }[r] || r || "생겼어요");
// 4단계 중학교 해결책 점검
const EFFECT = ["가장 큰 원인을 줄일 수 있어요", "조금 줄일 수 있어요", "잘 모르겠어요"];
const OLD_CAUSE_STATUS = ["근거로 뒷받침됨", "근거가 약함", "버림"]; // 예전 수업 기록에 남아 있는 값
const STARTERS = ["안녕하세요, 어떤 일을 하세요?", "요즘 가장 힘든 일이 뭐예요?", "앞으로 무엇을 바라세요?"];

const S = {
  code: null, groupId: null, nick: null, uid: null, info: null, me: null,
  work: {}, locked: false, strikes: 0, caseTab: null, logs: [], chat: [], picks: {}, pickSeen: false, pickedAt: 0, stage: 1, sub1: "chat", aiCount: 0, memberCount: 0, chatCount: 0, chatLimit: 5, started: true, level: "high", deep: {},
  opened: {}, busy: null, waitSince: 0, chatErr: null, sending: false, pending: null, draft: "", letterClosed: false, matTab: null, round: 1, scrollChat: false, scene: {},
};
const $ = (s) => document.querySelector(s);
const panel = $("#panel");
// 모바일 전용 화면(m.html)인지. 화면이 좁아 안내 글은 접어 두고 활동 칸을 먼저 보여 준다.
const IS_M = document.body.classList.contains("m");
// 태블릿 전용 화면(t.html): 배치는 tablet.css 가 맡고, 가로로 놓으면 편지와 대화창을 나란히 둔다
const IS_T = document.body.classList.contains("t");
// 편지와 대화창을 나란히 놓는 폭(PC 는 style.css, 태블릿은 tablet.css 와 같은 값): 편지를 펼친 채로 둔다
const WIDE = () => !IS_M && window.matchMedia(IS_T ? "(orientation:landscape) and (min-width:900px)" : "(min-width:1100px)").matches;
let groupRef = null, memberRef = null;

// ---------- 데이터 도우미 ----------
const w = (path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), S.work);
// 사건마다 다른 편지 서명과 예시 문구(서버의 getCase 가 사건에 맞게 보낸다). 없으면 사건과 무관한 문구를 쓴다.
const UI_FALLBACK = {
  letterSign: "", causeExample: "도움을 받을 수 있는 길이 좁았다", badQuestion: "그 사람들은 나쁜가?",
  goodQuestion: "그 일이 있었던 해에 몇 명이 그 일을 겪었나?", checkQuestion: "그때 그 사람들은 법적으로 그 일을 할 수 있었나?",
  heardExample: "○○: 일자리를 구하기 어려웠다", broadProblem: "사회 문제", decidedProblem: "그 제도를 없애야 한다",
  pickLead: "이 사건에는 입장이 서로 다른 여러 사람이 있었어요.", requiredWho: "꼭 들어야 할 당사자", requiredTag: "당사자",
  casesKinds: "서로 다른 정책", compareWith: "이 사건", afterSince: "대화", afterExample: "우리는 ~할 거라 예상했지만, 실제로는 ~했다",
  priorQuestion: "이 사건 이야기를 처음 들었을 때 어떤 생각이 먼저 들었나요?", priorHint: "떠오르는 대로 솔직하게 한 줄이면 돼요",
  sceneHints: ["낯선 곳에서 내가 '바깥사람'이었던 때", "새로 온 사람이나 바뀐 것이 불편했던 때", "내가 당연하게 누려 온 것"],
};
// 받침이 있으면 a, 없으면 b (예: 강서와, 제주와, 이 사건과)
const josa = (word, a, b) => { const c = String(word).trim().slice(-1).charCodeAt(0) - 0xac00; return c >= 0 && c <= 11171 && c % 28 ? a : b; };
const ui = () => ({ ...UI_FALLBACK, ...(S.info?.ui || {}) });
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
// 인물에게 더 물을 수 있는 횟수(교사가 수업 설정에서 정한 학생별 한도)
const chatLeft = () => Math.max(0, S.chatLimit - S.chatCount);
// 입력칸 글자 수 한도(모둠 문서가 너무 커져 저장이 막히지 않게)
const MAX_INPUT = 300, MAX_AREA = 1500;
// 단계 순서(서버 policy.js 와 같은 기준): 모둠 문제 → 3단계 AI, 가장 큰 원인 → 4단계 AI, 최종 해결책 → 5단계 AI
const ready = {
  problem: () => txt(w("s1.problem.hmw")).length >= 10,
  cause: () => txt(w("s3.chain.cause")).length >= 10,
  final: () => txt(w("s4.final")).length >= 30,
};
// 3단계 검색 도우미가 근거로 쓴 웹 출처
const srcLinks = (sources) => {
  const xs = (sources || []).filter((x) => /^https?:\/\//.test(x.url));
  return xs.length ? `<details class="srcnote"><summary>🔎 웹 검색 출처 ${xs.length}개</summary><div class="srcs">${xs.map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.title)}</a>`).join("")}</div></details>` : "";
};

// 저장 상태: 저장 중인 칸 수와 인터넷 연결을 화면 위쪽에 보여 준다. 연결이 끊겨도 입력은 연결되면 자동으로 저장된다(창을 닫지 않으면).
let inflight = 0, savedFlash = 0, slowTimer = null;
function renderNet() {
  const el = $("#net"); if (!el) return;
  const off = !navigator.onLine;
  let cls = "net", txt = "연결됨";
  if (off) { cls += " off"; txt = "연결 끊김"; }
  else if (inflight > 0) { cls += " saving"; txt = slowTimer === "slow" ? "저장이 늦어져요…" : "저장 중…"; }
  else if (Date.now() < savedFlash) txt = "저장됨";
  el.className = cls + (S.code ? "" : " hidden");
  el.innerHTML = `<span class="dot2"></span>${txt}`;
  let b = $("#net-banner");
  if (off && S.code) { if (!b) { b = document.createElement("div"); b.id = "net-banner"; b.className = "net-banner"; b.setAttribute("role", "alert"); document.querySelector("main").prepend(b); } b.textContent = "연결이 끊겼어요. 다시 연결되면 자동으로 저장돼요. 창을 닫지 마세요."; }
  else b?.remove();
}
window.addEventListener("online", renderNet);
window.addEventListener("offline", renderNet);
window.addEventListener("beforeunload", (e) => { if (inflight > 0 || pending.size > 0) { e.preventDefault(); e.returnValue = ""; } });

async function save(path, value) {
  if (typeof value === "string" && value.length > MAX_AREA) value = value.slice(0, MAX_AREA);
  inflight++; renderNet();
  const slow = setTimeout(() => { slowTimer = "slow"; renderNet(); }, 8000);
  try { await updateDoc(groupRef, { ["work." + path]: value }); }
  catch (e) { console.error(e); toast("저장하지 못했어요. 연결을 확인하세요.", true); }
  finally {
    clearTimeout(slow); inflight--;
    if (inflight === 0) { slowTimer = null; savedFlash = Date.now() + 2000; setTimeout(renderNet, 2100); }
    renderNet();
  }
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

// ---------- 입장·로그아웃 ----------
// 로그인 상태는 이 탭(브라우저 세션)에만 남긴다. 창을 닫으면 로그아웃되므로, 공용 PC에서 다음 학생이 앞 학생의 화면을 이어받지 않는다.
const SESSION_KEY = "eps_code";
const savedCode = () => { try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; } };
const saveCode = (c) => { try { c ? sessionStorage.setItem(SESSION_KEY, c) : sessionStorage.removeItem(SESSION_KEY); } catch {} };
try { localStorage.removeItem("eps_code"); } catch {} // 예전 방식(브라우저에 계속 남던 입장 정보) 정리

$("#j-btn").onclick = async () => {
  const code = $("#j-code").value.trim().toUpperCase();
  const groupNo = $("#j-group").value;
  const nickname = $("#j-nick").value.trim();
  const password = $("#j-pw").value;
  if (!code || !groupNo || !nickname || !password) return toast("네 칸을 모두 입력하세요.", true);
  if (!S.uid) return toast("연결하는 중이에요. 잠시 후 다시 눌러 주세요.", true);
  const btn = $("#j-btn");
  btn.disabled = true;
  // 입장하는 동안은 멈춘 것이 아니라 일하는 중임을 보여 준다(움직이는 표시와 흐르는 시간)
  const label = btn.textContent;
  btn.textContent = "입장 중…";
  $("#join-wait")?.remove();
  btn.insertAdjacentHTML("afterend", `<div id="join-wait">${waitHtml({ steps: STEPS.join, compact: true })}</div>`);
  try {
    const r = (await call("joinSession")({ code, groupNo: Number(groupNo), nickname, password })).data;
    $("#j-pw").value = "";
    remember({ code, group: groupNo, nick: nickname });
    saveCode(code);
    await enter(code, r); // 입장 응답에 수업 내용이 들어 있어 getCase 를 다시 부르지 않는다
  } catch (e) { toast(errMsg(e), true); }
  finally { btn.disabled = false; btn.textContent = label; $("#join-wait")?.remove(); }
};
// 수업이 끝난 뒤 점수·세특 보기: 입장할 때와 같은 네 칸으로 확인한다(입장하지 않는다)
$("#res-join").onclick = async () => {
  const code = $("#j-code").value.trim().toUpperCase(), groupNo = $("#j-group").value, nickname = $("#j-nick").value.trim(), password = $("#j-pw").value;
  if (!code || !groupNo || !nickname || !password) return toast("수업 코드, 모둠 번호, 별명, 비밀번호를 모두 입력하세요.", true);
  if (!S.uid) return toast("연결하는 중이에요. 잠시 후 다시 눌러 주세요.", true);
  const b = $("#res-join"); b.disabled = true;
  try { await openResult({ code, groupNo: Number(groupNo), nickname, password }); $("#j-pw").value = ""; } finally { b.disabled = false; }
};
// 입장 화면을 보는 동안 입장 기능을 미리 깨워 둔다(첫 입장이 느린 것을 줄인다). 결과는 쓰지 않는다.
function prewarm() { if (!S.code && !savedCode()) call("joinSession")({}).catch(() => {}); }
// 한글을 조합하는 중의 Enter(글자 확정)는 입장으로 보지 않는다
for (const id of ["#j-code", "#j-group", "#j-nick", "#j-pw"]) $(id).addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) $("#j-btn").click(); });
// 수업 코드: 소문자·띄어쓰기를 알아서 고치고, 6자를 다 쓰면 모둠 번호 칸으로 넘어간다
$("#j-code").addEventListener("input", (e) => {
  const el = e.target, v = el.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  if (el.value !== v) el.value = v;
  if (v.length === 6 && !/^delete/.test(e.inputType || "")) $("#j-group").focus();
});
// 이 탭에서 마지막으로 입장한 정보(코드·모둠·별명). 탭을 닫으면 지워진다.
// 주소에 ?code= 가 있으면(교사 화면의 QR) 그 코드를 먼저 채운다.
const LAST_KEY = "eps_last";
const lastJoin = () => { try { return JSON.parse(sessionStorage.getItem(LAST_KEY) || "{}"); } catch { return {}; } };
const remember = (x) => { try { sessionStorage.setItem(LAST_KEY, JSON.stringify(x)); } catch {} };
(function prefillJoin() {
  const last = lastJoin(), qc = (new URLSearchParams(location.search).get("code") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  const code = qc || last.code || "";
  if (!code) return;
  $("#j-code").value = code;
  if (last.code === code) { if (last.group) $("#j-group").value = last.group; if (last.nick) $("#j-nick").value = last.nick; }
  if (!savedCode()) ["#j-group", "#j-nick", "#j-pw"].map((x) => $(x)).find((el) => !el.value)?.focus();
})();

// '내 결과' 단추: 교사가 점수나 세특 중 하나라도 공개하면 나타나고, 새로 공개된 것을 아직 안 봤으면 강조한다
function updateResBtn(rel) {
  const b = $("#res-btn"), any = !!(rel && (rel.score || rel.seteuk));
  b.classList.toggle("hidden", !any);
  b.classList.toggle("has-new", any && (rel.t || 1) > resSeenAt(S.code));
  S.relT = rel?.t || 1;
}
$("#res-btn").onclick = async () => { const r = await openResult({ code: S.code }); if (r) { resMarkSeen(S.code, S.relT); $("#res-btn").classList.remove("has-new"); } };

// 로그아웃: 저장 중인 입력을 먼저 올리고, '입력 중' 표시를 지운 뒤, 로그인 정보를 지우고 처음 화면으로 돌아간다
let leaving = false;
async function logout(msg) {
  if (leaving) return;
  leaving = true;
  try {
    await Promise.race([flushAll().then(() => groupRef && S.uid ? save(`live.${S.uid}`, deleteField()) : null), new Promise((r) => setTimeout(r, 3000))]);
  } catch {}
  clearInterval(hb);
  saveCode(null);
  if (!msg) { const { nick, ...rest } = lastJoin(); remember(rest); }
  try { await signOut(auth); } catch {}
  if (msg) { try { sessionStorage.setItem("eps_notice", msg); } catch {} }
  location.reload();
}
// 실수로 누르지 않도록 한 번 물어본다
$("#logout").onclick = async () => {
  const ok = await confirmModal("로그아웃할까요?", "<p>쓴 내용은 저장돼 있어요. 같은 별명·비밀번호로 다시 들어오면 이어서 할 수 있어요.</p>", "로그아웃", "계속하기");
  if (ok) logout();
};

// 오래 아무것도 안 하면 자동 로그아웃(자리를 비운 채 공용 PC를 두고 간 경우)
const IDLE_MS = 30 * 60 * 1000;
let idleTimer = null;
function resetIdle() { clearTimeout(idleTimer); idleTimer = setTimeout(() => logout("오랫동안 사용하지 않아 로그아웃됐어요. 다시 입장하면 하던 것이 이어져요."), IDLE_MS); }
for (const ev of ["pointerdown", "keydown", "touchstart", "scroll"]) document.addEventListener(ev, () => { if (S.code) resetIdle(); }, { passive: true, capture: true });

async function enter(code, joined) {
  memberRef = doc(db, `sessions/${code}/members/${S.uid}`);
  let ss;
  if (joined) {
    Object.assign(S, { code, groupId: joined.groupId, nick: joined.nickname });
    S.info = joined.case; S.started = joined.started; S.chatLimit = joined.chatLimit || 5;
    setLevel(joined);
  } else {
    const mSnap = await getDoc(memberRef);
    if (!mSnap.exists()) { saveCode(null); return; }
    Object.assign(S, { code, groupId: mSnap.data().groupId, nick: mSnap.data().nickname });
    const [info, sess] = await Promise.all([call("getCase")({ code }), getDoc(doc(db, `sessions/${code}`))]);
    S.info = info.data; ss = sess.data() || {};
    // 선생님이 '수업 시작'을 누르기 전(started === false)에는 대기실을 보여 준다. 값이 없는 예전 수업은 시작된 것으로 본다.
    S.started = ss.started !== false; S.chatLimit = ss.chatLimit || 5; S.coach = ss.coach !== false;
    setLevel(ss);
  }
  groupRef = doc(db, `sessions/${code}/groups/${S.groupId}`);
  S.me = S.info.me;
  S.matTab = S.info.materials?.[0]?.id || null;
  $("#join").classList.add("hidden");
  showArea();
  addHelpButton();
  $("#who").textContent = `${S.groupId.replace("g", "")}모둠 · ${S.nick}`;
  $("#logout").classList.remove("hidden");
  resetIdle(); startWaitTicker(); renderNet();
  // 같은 별명으로 다른 화면에서 로그인하면 이 화면은 접근 권한을 잃는다 → 로그아웃 처리
  // 선생님이 다른 모둠으로 옮겨 주면, 새 모둠으로 화면을 다시 연다(로그아웃하지 않는다)
  const moved = (g) => { try { sessionStorage.setItem("eps_notice", `선생님이 ${String(g).replace("g", "")}모둠으로 옮겨 주셨어요.`); } catch {} location.reload(); };
  const lost = async (e) => {
    if (e?.code !== "permission-denied") return;
    try { const m = await getDoc(memberRef); if (m.exists() && m.data().groupId !== S.groupId) return moved(m.data().groupId); } catch {}
    logout("다른 화면에서 같은 별명으로 로그인해서 이 화면은 로그아웃됐어요.");
  };
  // 교사가 수업을 닫으면 이 화면도 로그아웃한다
  onSnapshot(doc(db, `sessions/${code}`), (s) => {
    const d = s.data() || {};
    if (d.closed) logout("수업이 끝나 닫혔어요. 수고했어요!");
    const coach = d.coach !== false, coachChanged = coach !== S.coach;
    S.chatLimit = d.chatLimit || 5; S.coach = coach; renderChatLeft();
    const levelChanged = setLevel(d);
    renderTeacherNotice(d.notice);
    if ((coachChanged || levelChanged) && S.code) scheduleRender(); // 선생님이 생각 도우미·학교급·심화 활동을 바꾸면 바로 반영한다
    applyStarted(d.started !== false);
    updateResBtn(d.release);
  }, lost);
  startStartPoll(code);
  // 내 접속 문서: 모둠 이동, 쓴 질문 수, 대화 규칙 위반으로 대화가 멈췄는지(교사가 다시 열면 바로 풀린다)
  onSnapshot(memberRef, (s) => {
    const d = s.data() || {};
    if (d.groupId && d.groupId !== S.groupId) return moved(d.groupId);
    S.chatCount = d.chatCount || 0; S.strikes = d.conduct?.strikes || 0;
    const locked = !!d.chatLocked;
    if (locked !== S.locked) { S.locked = locked; if (S.stage === 1) render(true); }
    renderChatLeft();
  }, lost);
  onSnapshot(groupRef, (s) => {
    const d = s.data() || {};
    S.work = d.work || {};
    for (const [path, p] of pending) setLocal(path, p.value); // 아직 저장 중인 내 입력은 유지
    S.aiCount = d.aiCount || 0; S.memberCount = d.memberCount || 0; S.names = d.names || {};
    S.picks = d.picks || {};
    // 모둠원이 모두 ② 정리를 제출한 순간 한 번 알려 준다
    const sub = submitted().length, tot = Math.max(S.memberCount, sub);
    if (S.subSeen !== undefined && S.subSeen < tot && sub === tot && tot > 1 && !(S.stage === 1 && S.sub1 === "group"))
      toastAction("모두 제출했어요! 모둠이 모여 문제를 정해요 👥", "모둠 문제로", () => goTo(1, "group"), 7000);
    S.subSeen = sub;
    syncMyPick();
    scheduleRender();
  }, lost);
  onSnapshot(collection(db, `sessions/${code}/groups/${S.groupId}/logs`), (s) => { S.logs = s.docs.map((d) => ({ id: d.id, ...d.data() })); scheduleRender(); });
  onSnapshot(query(collection(db, `sessions/${code}/members/${S.uid}/chat`), orderBy("createdAt")), (s) => {
    S.chat = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (S.pending && S.chat.length > S.pending.base) S.pending = null; // 서버에 기록된 말풍선으로 바꾼다
    if (S.stage === 1) { if (!$("#msgs")) render(true); else renderMsgs(); }
  });
  renderTabs();
  render(true);
  startPresence();
  warmAi();
  maybeHelp();
}

// 수업의 학교급과 심화 활동을 반영한다(입장 응답이나 수업 문서). 바뀌었으면 true.
function setLevel(d) {
  const level = d?.level === "middle" ? "middle" : "high", dp = d?.deep && typeof d.deep === "object" ? d.deep : {};
  const changed = level !== S.level || JSON.stringify(dp) !== JSON.stringify(S.deep);
  S.level = level; S.deep = dp;
  if (!rounds().includes(S.round)) S.round = rounds()[0];
  return changed;
}

// 모둠 문서의 인물 선택에서 내 인물을 맞춘다. 선생님이 풀어 준 경우(내가 고른 것이 한 번 보였다가 사라짐)에는 다시 고르게 한다.
// (방금 고른 직후에는 서버 반영이 늦을 수 있어 잠시 기다린다)
function syncMyPick() {
  const mine = Object.entries(S.picks).find(([, v]) => v?.uid === S.uid)?.[0];
  if (mine) {
    S.pickSeen = true;
    if (S.me?.id !== mine) {
      const l = (S.info?.letters || []).find((x) => x.id === mine);
      if (l) S.me = { id: l.id, name: l.name, letter: l.letter, personal: l.personal };
    }
  } else if (S.pickSeen && S.me && Date.now() - S.pickedAt > 5000) {
    S.me = null; S.pickSeen = false;
    S.scene[1] = "pick";
    toast("선생님이 인물 선택을 풀어 주셨어요. 다시 골라 주세요.");
  }
}
// AI 함수를 미리 깨워 둔다(첫 인물 대화가 늦지 않게). 결과는 쓰지 않는다. 한 화면에서 한 번만.
let warmed = false;
function warmAi() { if (warmed || !S.started || document.documentElement.classList.contains("demo")) return; warmed = true; call("aiRequest")({ warm: true }).catch(() => {}); }
// 수업 시작 여부 반영. 실시간 알림이나 아래 확인(폴링) 중 먼저 온 쪽이 처리한다.
function applyStarted(started) {
  const was = S.started; S.started = started;
  if (S.started !== was) {
    showArea();
    if (S.started) { toast("수업이 시작됐어요! 🎉"); render(true); setTimeout(() => maybeHelp(), 300); warmAi(); }
    else renderWait();
  } else if (!S.started) renderWait();
}
// 대기 중에는 실시간 알림이 늦거나 끊겨도(특히 휴대폰) 몇 초 안에 알아채도록 서버에서 직접 다시 확인한다.
// 화면을 다시 켜거나 인터넷이 돌아온 순간에도 바로 확인한다.
let startPoll = null;
function startStartPoll(code) {
  const check = async () => {
    if (S.started || document.hidden) return;
    try { applyStarted(((await getDocFromServer(doc(db, `sessions/${code}`))).data() || {}).started !== false); } catch {}
  };
  clearInterval(startPoll);
  startPoll = setInterval(check, 3000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
  window.addEventListener("online", check);
}

// 선생님 한마디: 화면 위쪽에 붙는 띠로 보여 준다(우리 모둠에 보낸 것만). 닫으면 같은 말은 다시 뜨지 않는다.
const NOTICE_SEEN = "eps_tnotice_seen";
function renderTeacherNotice(n) {
  let b = $("#t-notice");
  let seen = ""; try { seen = sessionStorage.getItem(NOTICE_SEEN) || ""; } catch {}
  const show = n?.text && (!n.groups?.length || n.groups.includes(S.groupId)) && String(n.t) !== seen;
  if (!show) { b?.remove(); return; }
  if (!b) { b = document.createElement("div"); b.id = "t-notice"; b.className = "t-notice"; b.setAttribute("role", "status"); document.querySelector("main").prepend(b); }
  if (b.dataset.t === String(n.t)) return;
  b.dataset.t = String(n.t);
  b.innerHTML = `<span class="tn-k">📣 선생님</span><span class="tn-t">${esc(n.text)}</span><button class="tn-x" type="button" aria-label="닫기">✕</button>`;
  b.querySelector(".tn-x").onclick = () => { try { sessionStorage.setItem(NOTICE_SEEN, String(n.t)); } catch {} b.remove(); };
  pop(b, "pop", 700);
  try { navigator.vibrate?.(40); } catch {}
}

// 대기실과 활동 화면 중 맞는 쪽만 보인다
// 휴대폰에서 인물과 대화하는 동안(chat-mode): 대화에 방해되는 안내를 숨긴다. 대화창은 고정하지 않고 화면 전체를 스크롤한다.
const chatModeNow = () => IS_M && S.started && S.stage === 1 && S.shown === "chat" && !!S.me && !!(priorOf() || S.chat.length);
function updateChatMode() { document.body.classList.toggle("chat-mode", chatModeNow()); }
function showArea() {
  updateChatMode();
  $("#app").classList.toggle("hidden", !S.started);
  $("#wait").classList.toggle("hidden", S.started);
}

// ---------- 대기실: 선생님이 시작하기 전에 보는 화면 ----------
// 기다리는 동안 알아야 할 것 하나(질문 횟수)만 보여 준다. 방법은 단계마다 안내 팝업이 알려 준다.
let waitKey = "";
function renderWait() {
  const box = $("#wait"); if (!box) return;
  const gno = String(S.groupId || "").replace("g", "");
  const n = Math.max(S.memberCount, 1);
  const names = Object.values(S.names || {}).sort((a, b) => a.localeCompare(b));
  const key = `${gno}|${S.nick}|${n}|${S.chatLimit}|${names.join(",")}`;
  if (key === waitKey && box.innerHTML) return;
  waitKey = key;
  box.innerHTML = `
    <div class="wait-hero"><div class="wait-orb" aria-hidden="true"><i></i><i></i><i></i></div>
      <h2>곧 시작해요</h2>
      <p>시작하면 화면이 저절로 바뀌어요.</p></div>
    <div class="card wait-me"><div class="wm-top"><span class="tag">입장 완료 ✓</span> <b>${esc(gno)}모둠 · ${esc(S.nick)}</b></div>
      <div class="wait-mates">${names.length ? `우리 모둠 <b>${names.length}명</b>: ${names.map((x) => x === S.nick ? `<b>${esc(x)}</b>` : esc(x)).join(" · ")}` : `우리 모둠 <b>${n}명</b>`}</div>
      <div class="wait-key">💬 편지를 보낸 사람에게 <b>질문은 ${S.chatLimit}번!</b></div></div>
    <p class="meta-line wait-note">모둠을 잘못 들어왔다면 선생님께 알려 주세요.</p>`;
}

// ---------- 단계 안내 팝업 ----------
// 단계(1단계는 작은 단계)에 처음 들어갈 때 '무엇을·어떻게'를 알려 주고, '이해했어요'를 누르면 바로 활동을 시작한다.
// '이해 못했어요'를 누르면 더 자세한 설명을 보여 준다. 본 안내는 이 기기에 기억해 다시 띄우지 않고, 위쪽 '?' 버튼으로 언제든 다시 볼 수 있다.
const helpKeyNow = () => (S.stage === 1 ? `1-${S.sub1}` : String(S.stage));
const helpOpts = () => ({ level: S.level, deep: S.deep });
const seenStore = () => `eps_help_${S.code}_${S.groupId}_${S.nick}`;
// 이 기기에 기억하되, 저장이 막힌 브라우저에서도 이 화면에서는 기억한다
const seenMem = {};
const seenList = () => { const k = seenStore(); if (!seenMem[k]) { try { seenMem[k] = JSON.parse(localStorage.getItem(k) || "[]"); } catch { seenMem[k] = []; } } return seenMem[k]; };
const markSeen = (k) => { const l = seenList(); if (l.includes(k)) return; l.push(k); try { localStorage.setItem(seenStore(), JSON.stringify(l)); } catch {} };
let helpBusy = false;
async function maybeHelp(force = false) {
  if (!S.started || !S.info || helpBusy) return;
  const key = helpKeyNow();
  if (!HELP[key] || (!force && seenList().includes(key))) return;
  helpBusy = true;
  // 체험(demo) 화면은 '실제 수업과 다른 점'을 안내 끝에 덧붙인다(demo/boot.js 가 정한다)
  const extra = window.EPS_HELP_EXTRA?.(key) || "";
  try {
    for (;;) {
      const v = await showModal({ title: esc(HELP[key].title), body: helpSimple(key, esc, S.chatLimit, ui(), helpOpts()) + extra,
        actions: [{ label: "이해했어요", value: "ok", kind: "btn-primary" }, { label: "이해 못했어요", value: "more" }] });
      if (v === null) return; // 다른 창이 먼저 떠서 밀려난 경우: 본 것으로 치지 않는다
      if (v === "ok") break;
      const d = await showModal({ title: esc(HELP[key].title), body: helpDetail(key, esc, S.chatLimit, ui(), helpOpts()) + extra, wide: true,
        actions: [{ label: "이해했어요", value: "ok", kind: "btn-primary" }, { label: "← 간단히 보기", value: "back" }] });
      if (d === null) return;
      if (d === "ok") break;
    }
    markSeen(key);
  } finally { helpBusy = false; }
}
function addHelpButton() {
  if ($("#help-btn")) return;
  const b = document.createElement("button");
  b.id = "help-btn"; b.type = "button"; b.className = "btn-out help-btn"; b.textContent = "?"; b.setAttribute("aria-label", "이 단계 안내 다시 보기");
  b.onclick = () => maybeHelp(true);
  $("#logout").before(b);
}

// 새 탭·새로 연 브라우저는 항상 로그아웃 상태에서 시작한다(앞 사람의 로그인이 남아 있어도 이어받지 않는다)
await setPersistence(auth, browserSessionPersistence).catch(() => {});
await auth.authStateReady?.();
if (auth.currentUser?.isAnonymous && !savedCode()) await signOut(auth).catch(() => {});
try {
  const notice = sessionStorage.getItem("eps_notice");
  if (notice) { sessionStorage.removeItem("eps_notice"); toast(notice); }
} catch {}

onAuthStateChanged(auth, async (u) => {
  if (!u) { await signInAnonymously(auth); return; }
  S.uid = u.uid;
  const saved = savedCode();
  if (saved && !S.code) enter(saved).catch(console.error);
  else prewarm();
});

// ---------- 이동 ----------
function renderTabs() {
  const html = STAGES.map((s) => { const done = !!S.info && stageDone(s.n);
    return `<button class="stage-tab ${S.stage === s.n ? "on" : ""} ${done ? "done" : ""}" data-stage="${s.n}" aria-label="${s.n}단계 ${s.name}${done ? " (완료)" : ""}" aria-current="${S.stage === s.n ? "step" : "false"}"><b>${s.n}</b><span>${IS_M ? s.short : s.name}</span></button>`; }).join("")
    + `<div class="stage-now" aria-hidden="true">${S.stage}단계 · ${esc(STAGES[S.stage - 1].name)}</div>`; // 좁은 PC 화면에서만 보임(번호 원만 남기므로 지금 단계 이름을 따로 알려 준다)
  if (html === lastTabs) return;
  lastTabs = html;
  $("#tabs").innerHTML = html;
  // 방금 마친 단계는 탭이 한 번 톡 튄다(처음 그릴 때는 제외)
  const now = new Set(STAGES.filter((x) => S.info && stageDone(x.n)).map((x) => x.n));
  if (doneTabs) for (const n of now) if (!doneTabs.has(n)) pop($(`#tabs .stage-tab[data-stage="${n}"]`), "just-done", 900);
  doneTabs = now;
}
let lastTabs = "", doneTabs = null;
// 잠깐 붙였다 떼는 표시(움직임). 같은 표시를 다시 붙이면 처음부터 다시 움직인다.
function pop(el, cls, ms) { if (!el) return; el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); setTimeout(() => el.classList.remove(cls), ms); }

// ---------- 장면(씬): 한 화면에는 지금 할 활동 하나만 ----------
// 단계마다 장면 목록(SCENES)이 있고, 화면에는 장면 하나만 보인다. 장면 = { id, name(짧은 이름), q(발문 한 줄), hint(짧은 도움말),
//   body(): 활동 칸, done(): 마쳤는지(없으면 읽기만 하는 장면), lock(): 앞에서 할 일이 남았으면 { t, go, sub, label }, sub: 1단계의 작은 단계, opt: 선택 활동 }
// 장면을 마치면 '다음'이 열리고, 단계에 들어오면 아직 안 마친 첫 장면이 바로 열린다.
// 읽기만 하는 장면은 한 번 열어 봐야 마친 것으로 친다(이 기기에 기억)
const sceneKey = (n, id) => `sc:${n}:${id}`;
const passed = (sc) => !sc.lock?.() && (sc.done ? !!sc.done() : seenList().includes(sceneKey(sc.n, sc.id)));
const scenesOf = (n) => SCENES[n]().filter(Boolean).map((x) => ({ ...x, n }));
const firstOpen = (list) => { const i = list.findIndex((x) => !passed(x)); return i < 0 ? list.length - 1 : i; };
function sceneNow(n = S.stage) {
  const list = scenesOf(n);
  let i = list.findIndex((x) => x.id === S.scene[n]);
  // 아직 열리지 않은 장면으로는 갈 수 없다(free 는 언제나 열림). 그때는 고른 것을 잊고 안 마친 첫 장면을 따라간다.
  if (i > firstOpen(list) && !list[i].free) { S.scene[n] = null; i = -1; }
  if (i < 0) i = firstOpen(list);
  return { list, i, sc: list[i] };
}
function stageDone(n) { return scenesOf(n).every(passed); }
// target: 장면 id, 1단계 작은 단계 이름(pick·chat·note·group), 'last'(마지막 장면). 없으면 아직 안 마친 첫 장면.
function goTo(stage, target) {
  flushAll();
  S.stage = stage;
  const list = scenesOf(stage), open = firstOpen(list);
  let sc = target === "last" ? list[open] : list.find((x) => x.id === target);
  if (!sc && target) { const sub = list.filter((x, j) => x.sub === target && j <= open); sc = sub.find((x) => !passed(x)) || sub[0]; }
  // 고른 장면은 고정하고, 고르지 않았으면 비워 둬서 자료가 도착하는 대로 아직 안 마친 첫 장면을 따라간다
  S.scene[stage] = sc ? sc.id : null;
  if (stage === 1) S.sub1 = (sc || list[open]).sub;
  window.scrollTo(0, 0);
  S.scrollChat = stage === 1 && S.sub1 === "chat" && S.chat.length > 0; // 대화로 돌아오면 마지막 말풍선을 보여 준다
  renderTabs(); render(true); ping();
  maybeHelp();
}
$("#tabs").onclick = (e) => { const b = e.target.closest("[data-stage]"); if (b) goTo(Number(b.dataset.stage)); };

// 장면 화면: 위에 단계와 진행 점, 큰 발문 한 줄, 짧은 도움말, 활동 칸, 아래에 이전·다음
function sceneHtml() {
  if (S.goScene?.[0] === S.stage && scenesOf(S.stage).some((x) => x.id === S.goScene[1])) { S.scene[S.stage] = S.goScene[1]; S.goScene = null; }
  let { list, i, sc } = sceneNow();
  if (!sc.done && !sc.lock?.() && !passed(sc)) { markSeen(sceneKey(S.stage, sc.id)); if (!S.scene[S.stage]) S.scene[S.stage] = sc.id; }
  S.shown = sc.id;
  if (S.stage === 1) S.sub1 = sc.sub;
  const open = firstOpen(list);
  const dots = list.map((x, j) => `<button type="button" class="sc-dot ${j === i ? "on" : ""} ${j < open || passed(x) ? "done" : ""}" data-scene="${x.id}" ${j > open && !x.free ? "disabled" : ""} aria-label="${j + 1}. ${esc(x.name)}" title="${esc(x.name)}"></button>`).join("");
  const lk = sc.lock?.();
  const body = lk ? `<div class="sc-lock" role="status"><p>${esc(lk.t)}</p>${lk.go ? `<button class="btn btn-primary" data-go="${lk.go}" data-sub="${lk.sub || ""}">${esc(lk.label)} →</button>` : ""}</div>` : sc.body();
  return `<section class="scene sid-${sc.id.replace(/[^a-z0-9-]/gi, "")}" data-scene-id="${esc(sc.id)}">
    <div class="sc-top"><span class="sc-k">${S.stage}단계 · ${esc(STAGES[S.stage - 1].name)}</span><span class="sc-who ${sc.solo ? "solo" : ""}">${sc.solo ? "👤 혼자" : "👥 모둠"}</span><span class="sc-dots" role="group" aria-label="활동 ${i + 1} / ${list.length}">${dots}</span><span class="sc-n">${i + 1} / ${list.length}</span></div>
    ${sc.q && !lk ? `<h2 class="sc-q">${esc(sc.q)}${sc.opt ? ` <span class="tag x">선택</span>` : ""}</h2>` : ""}
    ${sc.hint && !lk ? `<p class="sc-hint">${sc.hint}</p>` : ""}
    <div class="sc-body">${body}</div></section>${sceneFoot(list, i)}`;
}
function sceneFoot(list, i) {
  const sc = list[i], ok = passed(sc);
  const prev = i > 0 ? `<button class="btn btn-plain" data-scene="${list[i - 1].id}">← 이전</button>`
    : S.stage > 1 ? `<button class="btn btn-plain" data-go="${S.stage - 1}" data-sub="last">← ${S.stage - 1}단계</button>` : "<span></span>";
  const cls = `btn ${ok ? "btn-primary" : "btn-tinted"} sc-next`, dis = ok ? "" : `disabled title="이 활동을 마치면 넘어갈 수 있어요"`;
  const next = i < list.length - 1 ? `<button class="${cls}" data-scene="${list[i + 1].id}" ${dis}>다음 →</button>`
    : S.stage < 7 ? `<button class="${cls}" data-go="${S.stage + 1}" ${dis}>다음: ${S.stage + 1}단계 ${esc(STAGES[S.stage].name)} →</button>`
    : ok ? `<span class="sc-end">모두 마쳤어요. 수고했어요! 👏</span>` : "";
  return `<div class="nav-foot">${prev}${next}</div>`;
}
// 글을 쓰는 동안에도 '다음' 단추가 바로 열리게 한다(화면 전체는 글을 다 쓴 뒤에 다시 그린다)
let footOk = null;
function refreshFoot() {
  const b = panel.querySelector(".nav-foot .sc-next"); if (!b || !S.info) return;
  const sc = scenesOf(S.stage).find((x) => x.id === S.shown); if (!sc) return; // 지금 화면에 보이는 장면으로 따진다
  const ok = passed(sc);
  b.disabled = !ok; b.classList.toggle("btn-primary", ok); b.classList.toggle("btn-tinted", !ok);
  if (ok && footOk === false) pop(b, "just-ready", 1200); // 방금 마쳤으면 '다음'이 한 번 톡 튄다
  footOk = ok;
}

// ---------- 장면에서 쓰는 도우미 ----------
const filled = (path) => txt(w(path)).length > 0;
// 생각을 드러내는 칸(근거·이유)은 한 글자만 써서 넘어가지 못하게 4자부터 친다
const said = (path, n = 4) => txt(w(path)).length >= n;
const logsOf3 = (c) => stageLogs(3).filter((l) => l.payload?.checkId === c.id);
// 확인 질문 하나를 마쳤는지: AI에게 물었다면 그 답마다, 묻지 않았다면 우리가 자료로 직접 판단한 것
// 판단 한 칸(base: s3.checks.<로그ID> 또는 s3.direct.<질문ID>)에서 아직 안 쓴 것. 심화(sources)면 다른 자료·만든 쪽도 쓴다.
const JUDGE_KEYS = () => ["verdict", "source", ...(deep("sources") ? ["source2", "maker"] : [])];
const judgeMissing = (base) => JUDGE_KEYS().find((k) => (k === "verdict" ? !w(`${base}.verdict`) : !said(`${base}.${k}`)));
const judged3 = (c) => { const ls = logsOf3(c); return ls.length ? ls.every((l) => !judgeMissing(`s3.checks.${l.id}`)) : !judgeMissing(`s3.direct.${c.id}`); };
const verdicts3 = (c) => { const ls = logsOf3(c); return (ls.length ? ls.map((l) => w(`s3.checks.${l.id}.verdict`)) : [w(`s3.direct.${c.id}.verdict`)]).filter(Boolean); };
const SUPPORT = [VERDICTS[0], VERDICTS[1]]; // 사실이다·일부만 사실이다
const checkedAll = (path, n) => Array.from({ length: n }, (_, i) => !!w(`${path}.${i}`)).every(Boolean);
// ---- 학교급·심화 활동에 따라 달라지는 완료 조건 ----
// 1단계 ② 정리에서 꼭 써야 하는 칸(심화 premise 면 '당연하게 여기는 것'까지)
const noteRequired = () => ["who", "hard", "want", ...(deep("premise") ? ["premise"] : [])];
// 1단계 ③ 심화(premise): 부딪히는 두 가치와 그 까닭 가운데 아직 안 쓴 칸
const valuesMissing = () => (deep("premise") ? ["valueA", "valueB"].find((k) => !w(`s1.problem.${k}`)) || (said("s1.problem.valueWhy") ? null : "valueWhy") : null);
// 4단계 심화(tradeoff): 얻는 것·포기하는 것을 모두 쓴 해결책 수
const tradeDone = () => list("s4.proposals").filter((p) => said(`s4.trade.${p.id}.gain`) && said(`s4.trade.${p.id}.cost`)).length;
// 4단계 중학교 해결책 점검(견주기를 하지 않을 때)
const midCheck = () => MID() && !deep("tradeoff");
// 앞에서 정한 것을 한 줄로 다시 보여 준다(장면에 꼭 필요할 때만)
const recall = (k, v) => (txt(v) ? `<div class="recall"><span>${esc(k)}</span>${esc(v)}</div>` : "");

const liveWho = (path) => `<div class="live-who" data-live="${esc(path)}"></div>`;
// 저장 칸(data-save): 입력하면 자동 저장되고, 모둠원 화면에도 바로 반영된다
// 휴대폰에서는 한 줄 칸에 긴 예시가 잘리므로, 예시가 길면 두 줄 칸(textarea.short)으로 보여 준다
const fld = (path, label, ph = "", area = false, min = 0) => `${label ? `<label class="lbl">${label}</label>` : ""}${area || (IS_M && ph.length > 16)
  ? `<textarea data-save="${path}" maxlength="${area ? MAX_AREA : MAX_INPUT}" ${area ? "" : `class="short"`} placeholder="${esc(ph)}">${esc(w(path) || "")}</textarea>`
  : `<input type="text" data-save="${path}" maxlength="${MAX_INPUT}" value="${esc(w(path) || "")}" placeholder="${esc(ph)}" enterkeyhint="done" />`}${min ? cnt(path, min) : ""}${liveWho(path)}`;
// 최소 글자 수가 있는 칸: 쓰는 동안 '18 / 30자'를 보여 주고, 채우면 초록색 ✓ (누른 뒤에 오류로 알려 주지 않도록)
// target 은 '#아이디' 또는 저장 칸 경로
const cnt = (target, min) => `<div class="cnt" data-cnt-for="${esc(target)}" data-min="${min}"></div>`;
function updateCounts() {
  panel.querySelectorAll(".cnt[data-cnt-for]").forEach((c) => {
    const t = c.dataset.cntFor;
    const el = t.startsWith("#") ? document.getElementById(t.slice(1)) : [...panel.querySelectorAll("[data-save]")].find((x) => x.dataset.save === t);
    if (!el) return;
    const n = el.value.trim().length, min = Number(c.dataset.min), ok = n >= min;
    c.textContent = ok ? `✓ ${n}자` : `${n} / ${min}자`;
    c.classList.toggle("ok", ok);
  });
}
// 글이 길어지면 글 칸도 따라 늘어난다
const grow = (el) => { if (el.tagName !== "TEXTAREA") return; el.style.height = "auto"; el.style.height = `${el.scrollHeight + 2}px`; };
// 고르기: 드롭다운 대신 눌러서 고르는 칩(라디오). 고른 것은 바로 저장된다.
const pick = (path, label, opts) => {
  const cur = w(path) || "";
  const all = cur && !opts.includes(cur) ? [...opts, cur] : opts;
  return `${label ? `<div class="lbl">${label}</div>` : ""}<div class="choices" role="radiogroup" aria-label="${esc(label || "고르기")}">${all.map((o) => `<label class="choice ${cur === o ? "on" : ""}"><input type="radio" name="${esc(path)}" data-save="${path}" value="${esc(o)}" ${cur === o ? "checked" : ""}><span>${esc(o)}</span></label>`).join("")}</div>`;
};
// 저장하지 않고 화면에서만 고르는 칩(추가 칸 옆의 갈래·사람 고르기). 고른 값은 숨은 칸(id)에 들어가 val(id) 로 읽는다.
const pickLocal = (id, label, opts, first = true) => {
  const cur = S.localPick?.[id] ?? (first ? opts[0] : "");
  return `${label ? `<div class="lbl">${label}</div>` : ""}<div class="choices sm" data-pick="${id}">${opts.map((o) => `<button type="button" class="choice ${cur === o ? "on" : ""}" data-act="pick-local" data-id="${id}" data-v="${esc(o)}">${esc(o)}</button>`).join("")}</div><input type="hidden" id="${id}" value="${esc(cur)}">`;
};
// 기다리는 중 표시: 움직이는 점·막대, 흐르는 시간, 오래 걸릴 때의 안내(wait.js)
// 서버가 준 출처 주소는 http(s)만 링크로 쓴다
const safeHref = (u) => (/^https?:\/\//i.test(String(u || "")) ? String(u) : "#");
const linkHtml = (l) => `<a href="${esc(safeHref(l.url))}" target="_blank" rel="noopener noreferrer">${esc(l.title || l.outlet)}</a><span class="meta-line"> · ${esc(l.outlet)}${l.date && !/확인/.test(l.date) ? ` · ${esc(l.date)}` : ""}</span>`;
// tip: 기다리는 동안 모둠이 먼저 해 볼 수 있는 일
const loading = (msg, tip) => waitHtml({ first: msg && msg.replace(/…$/, ""), steps: STEPS.ai, since: S.waitSince || Date.now(), tip });
function listHtml(path, rowFn, empty = "아직 없어요.") {
  const items = list(path);
  if (!items.length) return `<div class="meta-line">${empty}</div>`;
  return `<div class="group">${items.map((it) =>
    `<div class="cell"><div class="grow">${rowFn(it)}${who(it) ? `<br>${who(it)}` : ""}</div><button class="btn btn-plain btn-sm" data-act="del" data-path="${path}" data-id="${it.id}">삭제</button></div>`).join("")}</div>`;
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
  if (!S.started) { renderWait(); return; }
  updateChatMode();
  if (!force && (isEditing() || ptrDown)) { deferred = true; syncLive(); return; }
  deferred = false;
  renderTabs(); // 단계 완료 표시를 최신으로
  const html = sceneHtml();
  updateChatMode(); // 장면이 정해진 뒤에 대화 화면인지 다시 본다
  const view = `${S.stage}|${S.shown}`;
  const key = `${view}|${S.busy}|${html}`;
  if (!force && key === lastKey) { syncLive(); return; }
  const before = view === lastView ? snapValues() : null;
  lastView = view;
  lastKey = key;
  const sc = window.scrollY;
  // 학생이 펼치거나 접은 상자(data-keep)는 다시 그려도 그대로 둔다
  panel.querySelectorAll("details[data-keep]").forEach((d) => { S.opened[d.dataset.keep] = d.open; });
  panel.innerHTML = html;
  panel.querySelectorAll("details[data-keep]").forEach((d) => { if (d.dataset.keep in S.opened) d.open = S.opened[d.dataset.keep]; });
  window.scrollTo(0, sc); // 다시 그려도 보던 자리를 지킨다
  // 단, 마지막 말풍선으로 내려가는 중이었다면(곧바로 다시 그려져 그 움직임이 끊긴 경우) 다시 내려간다
  if (Date.now() < latestUntil) S.scrollChat = true;
  if ($("#msgs")) { const m = $("#msg"); if (m && S.draft) m.value = S.draft; renderMsgs(); }
  panel.querySelectorAll("textarea").forEach(grow);
  flashChanged(before);
  syncLive();
  if (!before) footOk = null; // 새 장면에서는 '다음'이 톡 튀지 않는다
  refreshFoot();
}
// 같은 화면을 다시 그릴 때, 바뀐 칸과 새로 생긴 항목을 잠깐 반짝여 모둠원이 무엇을 바꿨는지 보이게 한다
let lastView = "";
function snapValues() {
  const v = new Map();
  panel.querySelectorAll("[data-save]").forEach((el) => { if (el.type !== "radio") v.set(el.dataset.save, el.type === "checkbox" ? el.checked : el.value); });
  return { v, ids: new Set([...panel.querySelectorAll('[data-act="del"][data-id]')].map((b) => b.dataset.id)) };
}
function flashChanged(before) {
  if (!before) return;
  panel.querySelectorAll("[data-save]").forEach((el) => {
    const p = el.dataset.save;
    if (el.type !== "radio" && before.v.has(p) && before.v.get(p) !== (el.type === "checkbox" ? el.checked : el.value)) pop(el.type === "checkbox" ? el.closest(".cell") : el, "flash", 1600);
  });
  panel.querySelectorAll('[data-act="del"][data-id]').forEach((b) => { if (!before.ids.has(b.dataset.id)) pop(b.closest(".cell, .card.flat"), "flash", 1600); });
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
    if (el.type === "checkbox") { if (el.checked !== !!v) { el.checked = !!v; pop(el.closest(".cell"), "flash", 1600); } }
    else if (el.type === "radio") { const on = el.value === (v ?? ""); if (el.checked !== on) { el.checked = on; if (on) pop(el.closest(".choice"), "flash", 1600); } el.closest(".choice")?.classList.toggle("on", on); }
    else if (el.value !== (v ?? "")) { el.value = v ?? ""; grow(el); pop(el, "flash", 1600); }
  });
  updateCounts();
  panel.querySelectorAll("[data-live]").forEach((el) => {
    const names = editors.filter(([, x]) => x.path === el.dataset.live).map(([, x]) => x.nick);
    el.textContent = names.length ? `✏️ ${names.join(", ")} 입력 중` : "";
  });
}

// ---------- 1단계 ① 메신저 대화 ----------
// 인물이 웹에서 찾은 내용을 바탕으로 답한 경우, 어디서 찾았는지 볼 수 있게 한다(확인하는 습관을 위해)
function srcNote(l) {
  const found = (l.lookups || []).filter((x) => x.found);
  const urls = found.flatMap((x) => x.sources || []).filter((x) => /^https?:\/\//.test(x.url));
  if (!found.length) return "";
  return `<details class="srcnote"><summary>🔎 웹에서 찾은 내용이 쓰였어요 (출처 보기)</summary><div class="srcs">${
    urls.length ? urls.map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.title)}</a>`).join("") : "출처 주소가 없어요. 꼭 다시 확인하세요."}</div></details>`;
}
// 말풍선 하나하나를 (키, HTML) 목록으로 만든다. 바뀐 곳부터 뒤쪽만 다시 그려서, 대화가 길어져도 매끄럽고 읽던 자리가 흔들리지 않는다.
function msgItems() {
  const name = S.me?.name || "", ini = esc(name.slice(0, 1));
  const rows = [];
  for (const l of S.chat) {
    rows.push([`m${l.id}`, `<div class="msg me"><div class="col"><div class="bubble">${esc(l.input)}</div><span class="time">${fmtTime(l.createdAt)}</span></div></div>`]);
    rows.push([`a${l.id}`, `<div class="msg ai"><div class="avatar sm">${ini}</div><div class="col"><span class="name">${esc(name)}</span><div class="bubble">${esc(l.output)}</div>${srcNote(l)}${l.refunded ? `<span class="time">이 답은 질문 횟수에 들어가지 않았어요</span>` : ""}<span class="time">${fmtTime(l.createdAt)}</span></div></div>`]);
    if (l.conduct) rows.push([`c${l.id}`, `<div class="sysmsg" role="status">⚠ ${esc(l.conduct.notice)}</div>`]);
  }
  if (S.pending) rows.push(["pending", `<div class="msg me"><div class="col"><div class="bubble">${esc(S.pending.text)}</div></div></div>`]);
  if (S.sending) rows.push(["typing", `<div class="msg ai typing"><div class="avatar sm">${ini}</div><div class="col"><div class="bubble"><i></i><i></i><i></i></div>${waitHtml({ steps: STEPS.chat, since: S.waitSince, compact: true })}</div></div>`]);
  if (S.chatErr && !S.sending) rows.push(["err", `<div class="msg ai err" role="alert"><div class="avatar sm">!</div><div class="col"><div class="bubble">답을 받지 못했어요. (${esc(S.chatErr.msg)})<br><button class="btn btn-plain btn-sm" style="margin-top:8px" data-act="retry-chat">다시 보내기</button></div></div></div>`]);
  if (!rows.length) rows.push(["empty", `<div class="empty">${esc(name)}에게 먼저 말을 걸어 보세요.<br>아래 예시를 눌러 시작해도 돼요.</div>`]);
  return rows;
}
// 휴대폰 대화창: 맨 아래를 보고 있는 동안은 창 크기가 바뀌어도(키보드가 올라오거나 안내 줄이 접혀도) 마지막 말풍선이 계속 보이게 한다.
// 위로 올려 읽는 중이면 건드리지 않는다.
function pinMsgs(el) {
  if (el._pinned || typeof ResizeObserver === "undefined") return;
  el._pinned = true; el._stick = true;
  el.addEventListener("scroll", () => { el._stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }, { passive: true });
  new ResizeObserver(() => { if (el.scrollHeight > el.clientHeight && el._stick) el.scrollTop = el.scrollHeight; }).observe(el);
}
let lastSig = "", latestUntil = 0;
function renderMsgs() {
  const el = $("#msgs"); if (!el) return;
  pinMsgs(el);
  const items = msgItems(), cur = [...el.children];
  let i = 0;
  while (i < cur.length && i < items.length && cur[i].dataset.k === items[i][0] && cur[i]._h === items[i][1]) i++;
  cur.slice(i).forEach((n) => n.remove());
  const tpl = document.createElement("template");
  for (const [k, html] of items.slice(i)) {
    tpl.innerHTML = html;
    const node = tpl.content.firstElementChild;
    node.dataset.k = k; node._h = html;
    el.appendChild(node);
  }
  const n = S.chat.length + (S.sending ? 1 : 0) + (S.pending ? 1 : 0);
  // 대화가 시작되면 편지는 접는다
  if (n > 0 && !S.letterClosed && !WIDE()) { document.querySelector("details.letter")?.removeAttribute("open"); S.letterClosed = true; }
  // 말풍선이 새로 생기거나 바뀌었을 때만 그 말풍선으로 이동한다
  const sig = `${S.chat.length}|${S.sending}|${!!S.pending}`;
  if (S.scrollChat || sig !== lastSig) { latestUntil = Date.now() + 1000; requestAnimationFrame(scrollToLatest); }
  S.scrollChat = false; lastSig = sig;
  renderChatLeft();
}
// 남은 질문 수를 보여 주고, 다 쓰면 입력을 막고 ② 정리로 안내한다
function renderChatLeft() {
  const el = $("#chat-left"); if (!el) return;
  $(".starters")?.classList.toggle("m-hide", S.chat.length > 0); // 모바일: 대화가 시작되면 예시 질문 줄을 접어 대화 공간을 넓힌다
  const left = chatLeft(), out = left === 0, lastQ = left === 1;
  el.innerHTML = out
    ? `질문을 모두 썼어요. <button class="link" type="button" data-go="1" data-sub="note">알아낸 것 정리하러 가기</button>`
    : `남은 질문 <b>${left}</b> / ${S.chatLimit}번${lastQ ? ` · <b class="last-q">마지막 질문이에요</b>` : S.chat.length >= 2 ? ` · <button class="link" type="button" data-go="1" data-sub="note">다 알아냈으면 정리하러 가기</button>` : ""}`;
  el.classList.toggle("out", out);
  el.classList.toggle("last", lastQ);
  const m = $("#msg"); if (m) { m.disabled = out; m.placeholder = out ? "질문을 모두 썼어요" : lastQ ? "마지막 질문 — 가장 궁금한 것을 물어보세요" : `${S.me?.name || ""}에게 메시지 보내기`; }
  const btn = $("#send-btn"); if (btn) btn.disabled = S.sending || out;
  document.querySelectorAll('[data-act="starter"]').forEach((b) => { b.disabled = out; });
  refreshFoot(); // 질문을 충분히 했으면 '다음'이 열린다
}
// 마지막 말풍선이 머리글과 입력창 사이에 보이게 한다. 이미 보이면 움직이지 않고, 길면 말풍선의 첫 줄에 맞춘다.
function scrollToLatest() {
  const last = document.querySelector("#msgs .msg:last-child"); if (!last) return;
  const top = ($(".hdr")?.offsetHeight || 0) + 8;
  // 모바일 화면에서는 입력창 아래에 단계 막대가 있다(입력 중에는 숨겨져 높이 0)
  const bottom = window.innerHeight - (($("#chat-form")?.offsetHeight || 0) + ($(".m-nav")?.offsetHeight || 0) + 8);
  const r = last.getBoundingClientRect();
  if (r.top >= top && r.bottom <= bottom) return;
  const delta = r.height > bottom - top || r.top < top ? r.top - top : r.bottom - bottom;
  window.scrollTo({ top: window.scrollY + delta, behavior: "smooth" });
}

// 인물 고르기. 서버가 겹침·당사자 규칙을 확인하고, 안 되면 이유를 알려 준다.
// 편지 창에서 '이 분과 이야기할래요'를 누르면 부른다(창이 확인을 겸하므로 다시 묻지 않는다). 고르면 true.
async function choosePersona(id) {
  const l = (S.info.letters || []).find((x) => x.id === id); if (!l) return false;
  try {
    const r = (await call("choosePersona")({ code: S.code, personaId: id })).data;
    S.me = { id: r.me.id, name: r.me.name, letter: r.me.letter, personal: r.me.personal };
    S.pickedAt = Date.now();
    S.picks = { ...Object.fromEntries(Object.entries(S.picks).filter(([, v]) => v?.uid !== S.uid)), [id]: { uid: S.uid, nick: S.nick } };
    S.pickSeen = true;
    render(true);
    return true;
  } catch (e) { toast(errMsg(e), true); render(true); return false; }
}

// 인물 카드를 누르면 편지를 창으로 띄운다(PC는 넓은 두 단이라 스크롤 없이 읽히고, 휴대폰은 아래에서 올라오는 창에 고르는 버튼이 늘 보인다).
// 창에서 바로 고르고, 고르면 곧바로 '대화하러 가기' 버튼을 보여 준다.
async function readLetter(id) {
  const l = (S.info.letters || []).find((x) => x.id === id); if (!l) return;
  const t = S.picks[id], mineId = S.me?.id, mine = id === mineId, other = t && !mine, started = S.chatCount > 0;
  const tag = mine ? `<span class="tag g">내가 고른 인물</span>` : other ? `<span class="tag x">${esc(t.nick || "친구")} 선택</span>` : l.required ? `<span class="tag y">${esc(ui().requiredTag)}</span>` : "";
  const note = mine || other ? "" : started ? `<p class="lp-note">대화를 시작해서 인물을 바꿀 수 없어요. 바꾸고 싶으면 선생님께 말씀드리세요.</p>`
    : mineId ? `<p class="lp-note">지금은 <b>${esc(S.me.name)}</b>님을 골랐어요. 이 분으로 바꿀 수 있어요.</p>` : "";
  const v = await showModal({ cls: "letter-pop", dismissible: true,
    title: `<span class="lp-head"><span class="avatar">${esc(l.name.slice(0, 1))}</span><span class="lp-t"><b>${esc(l.name)}</b><small>${esc(l.brief)}</small></span>${tag}</span>`,
    body: `<div class="lp-letter">${l.letter.map((p) => `<p>${esc(p)}</p>`).join("")}<div class="sign">${esc(ui().letterSign)}<br>${esc(l.name)} 드림</div></div>${note}`,
    actions: mine ? [{ label: "대화하러 가기 →", value: "chat", kind: "btn-primary" }, { label: "닫기", value: null }]
      : [{ label: other ? "이미 선택됨" : mineId ? "이 분으로 바꿀래요" : "이 분과 이야기할래요", value: "choose", kind: "btn-primary", disabled: !!other || started }, { label: "다른 편지", value: null }] });
  if (v === "chat") return goTo(1, "chat");
  if (v !== "choose" || !(await choosePersona(id))) return;
  const go = await showModal({ dismissible: true, title: `${esc(l.name)}님과 이야기하기로 했어요`,
    body: `<p>이제 ${esc(l.name)}님에게 직접 물어볼 차례예요.</p><p class="meta-line">대화를 시작하기 전에는 다른 인물로 바꿀 수 있어요.</p>`,
    actions: [{ label: "대화하러 가기 →", value: true, kind: "btn-primary" }, { label: "편지 더 보기", value: false }] });
  if (go === true) goTo(1, "chat");
}

async function sendChat(text) {
  if (!chatLeft()) return toast(`인물에게는 ${S.chatLimit}번까지 물을 수 있어요.`, true);
  if (!S.chat.length && !priorOf()) { S.draft = text; render(true); $("#prior-in")?.focus(); return toast("이야기를 듣기 전에, 위 질문에 내 생각을 한 줄 먼저 적어 주세요.", true); }
  S.sending = true; S.chatErr = null; S.waitSince = Date.now(); S.pending = { text, base: S.chat.length }; renderMsgs();
  try {
    await call("aiRequest")({ code: S.code, stage: 1, type: "persona_chat", payload: { message: text } });
    S.draft = "";
  } catch (e) {
    S.pending = null; S.chatErr = { text, msg: errMsg(e) };
  } finally {
    S.sending = false;
    renderMsgs();
  }
}

// 내 대화를 글 파일로 저장한다(성찰 활동이나 보관용). 내 입력과 인물의 답만 들어간다.
function downloadChat() {
  const d = new Date(), name = S.me?.name || "인물";
  const lines = [`AI-EPS 대화 기록`, `${S.nick} ↔ ${name} · ${d.toLocaleDateString("ko-KR")}`, "이 대화는 실제 이야기들을 바탕으로 만든 가상 인물과의 대화예요.", ""];
  for (const l of S.chat) lines.push(`[나] ${l.input}`, `[${name}] ${l.output}`, "");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/plain;charset=utf-8" }));
  a.download = `ai-eps-chat-${d.toISOString().slice(0, 10)}.txt`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const SEND_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>';

// 7단계: 문제 → 원인 → 해결책 → 예상 문제 → 계획이 이어지는지 한눈에 본다
function flowRows() {
  return [
    [1, "hmw", "우리 문제", txt(w("s1.problem.hmw"))],
    [3, "cause", "가장 큰 원인", txt(w("s3.chain.cause"))],
    [4, "final", "최종 해결책", txt(w("s4.final"))],
    [5, "worry", "걱정되는 문제", txt(w("s5.newProblem"))],
    [6, "plan", "실천 계획", txt(w("s6.plan.content"))],
  ];
}

// 3단계 판단 심화(sources): 다른 자료로 한 번 더 확인하고, 자료를 만든 쪽을 따진다
const sourceMore = (base) => (deep("sources") ? `${fld(`${base}.source2`, "다른 자료에서도 같았나요?", "예) 언론 보도에서도 같은 숫자가 나왔다")}
  ${fld(`${base}.maker`, "그 자료는 누가 만들었나요? 왜 그렇게 말했을까요?", "예) 정부 발표라서 ~ 쪽에서 본 숫자다")}` : "");
// 3단계 심화(causeMap): 2단계에서 이은 원인 관계를 다시 보여 준다
function linksNote() {
  const causes = list("s2.causes"), name = (id) => causes.find((q) => q.id === id)?.text;
  const ls = list("s2.causeLinks").filter((l) => name(l.from) && name(l.to));
  return ls.length ? `<div class="recall"><span>2단계에서 이은 원인</span>${ls.map((l) => `${esc(name(l.from))} 때문에 → ${esc(name(l.to))} ${esc(relText(l.rel))}`).join("<br>")}</div>` : "";
}
// 2단계 심화(causeMap): 원인끼리 잇기. 한 원인이 다른 원인을 불러오거나 키우는지 모둠이 직접 잇는다.
function causeMapHtml(causes) {
  const name = (id) => causes.find((q) => q.id === id)?.text || "(삭제된 원인)";
  const opt = (sel) => causes.map((q, i) => `<option value="${q.id}" ${i === sel ? "selected" : ""}>${esc((q.text || "").slice(0, 40))}</option>`).join("");
  return `${listHtml("s2.causeLinks", (l) => `<b>${esc(name(l.from))}</b> 때문에 → <b>${esc(name(l.to))}</b> ${esc(relText(l.rel))}`, "")}
    <div class="link-maker" id="cl-row"><select id="cl-from" aria-label="앞 원인">${opt(0)}</select><span>때문에</span>
      <select id="cl-to" aria-label="뒤 원인">${opt(1)}</select><span>이(가)</span>
      ${pickLocal("cl-rel", "", CAUSE_RELS)}
      <button class="btn btn-tinted" data-act="add-clink">잇기</button></div>`;
}

// ---------- 1단계 도우미 ----------
const findings = () => toList(w("s1.findings"));
const submitted = () => findings().filter((f) => f.submitted || (!("submitted" in f) && txt(f.text)));
// 대화 전에 적은 '처음 내 생각'
const priorOf = (uid = S.uid) => txt(w(`s1.findings.${uid}.prior`));
const mineNote = () => w(`s1.findings.${S.uid}`) || {};
const askedEnough = () => Math.max(S.chatCount, S.chat.length) >= Math.min(2, S.chatLimit);

// 생각 도우미: 답을 주지 않고 질문 하나만 돌려준다. 받은 질문은 모둠 로그에 남아 모두가 본다.
function coachBox(focus, linkId, ready, waitMsg = "", more = "") {
  if (S.coach === false) return more;
  const logs = stageLogs(2).filter((g) => g.payload?.focus === focus && (focus !== "link" || g.payload?.linkId === linkId));
  const busyKey = `coach:${focus}:${linkId}`;
  const q = (g) => { try { return JSON.parse(g.output).question || ""; } catch { return g.output || ""; } };
  return `<div class="coach">
    ${logs.map((g) => `<div class="coach-q"><span class="tag y">생각 도우미</span> ${esc(q(g))}</div>`).join("")}
    ${S.busy === busyKey ? loading("생각 도우미가 읽는 중이에요…") : ""}
    ${more ? `<div style="align-self:stretch">${more}</div>` : ""}
    ${ready ? `<button class="btn btn-plain btn-sm" data-act="ask-coach" data-focus="${focus}" data-id="${linkId}" ${S.busy ? "disabled" : ""}>${logs.length ? "고친 뒤 다시 물어보기" : "생각 도우미에게 물어보기 (선택)"}</button>`
      : waitMsg ? `<div class="meta-line">${esc(waitMsg)}</div>` : ""}</div>`;
}

// 실제 사건 자료(2단계 장면, 3단계에서 '자료 보기' 창)
const matItem = (it) => `<div class="mat-item"><span class="kind k-${esc(it.kind)}">${esc(it.kind)}</span><p>${esc(it.text)}</p><div class="cap">${esc(it.caption)}</div></div>`;
function matBody(cur) {
  if (!cur) return `<div class="notice muted">선생님이 자료를 준비하는 중이에요.</div>`;
  return cur.type === "timeline"
    ? `<div class="timeline">${cur.items.map((it) => `<div class="tl"><div class="d">${esc(it.date)}</div><p>${esc(it.text)}</p><div class="cap">${esc(it.caption)}</div></div>`).join("")}</div>`
    : `${cur.stats ? `<div class="stats">${cur.stats.map((s, i) => `<div class="stat ${i === 2 ? "g" : i === 0 ? "" : "b"}"><b>${esc(s.value)}</b><span>${esc(s.label)}</span></div>`).join("")}</div>` : ""}
       <div class="mat">${cur.items.map(matItem).join("")}</div>`;
}
const LEGEND = `<div class="legend"><span class="kind">사실</span><span class="kind k-증언">증언</span> 일어난 일 · <span class="kind k-주장">주장</span><span class="kind k-의견">의견</span> 누군가의 생각</div>`;
async function showMaterials() {
  const cats = S.info.materials || [];
  await showModal({ title: "실제 사건 자료", wide: true, dismissible: true,
    body: `${LEGEND}${cats.map((c) => `<h3 class="mat-h">${esc(c.title)}</h3>${matBody(c)}`).join("") || matBody(null)}`,
    actions: [{ label: "닫기", value: true, kind: "btn-primary" }] });
}

// ---------- 단계별 장면 ----------
// 앞 단계에서 할 일이 남았으면 그 단계 전체를 잠근 장면 하나로 보여 준다
const gate = (name, lock, scenes) => (lock ? [{ id: "lock", name, lock: () => lock }] : scenes);
const SCENES = {
  1: () => {
    const me = S.me, name = me?.name || "";
    const noMe = me ? null : { t: "먼저 이야기를 들을 사람을 골라요.", go: 1, sub: "pick", label: "사람 고르기" };
    const notYet = () => noMe || (mineNote().submitted ? null : { t: "먼저 알아낸 것을 제출해요.", go: 1, sub: "doubt", label: "제출하러 가기" });
    return [
      { id: "pick", sub: "pick", name: "사람 고르기", q: "누구의 이야기를 들어 볼까요?", hint: "카드를 눌러 편지를 읽고, 한 명을 골라요. 모둠 친구와 겹치지 않게!", done: () => !!S.me, body: pickBody },
      { solo: true, id: "prior", sub: "chat", name: "처음 내 생각", q: ui().priorQuestion, hint: "떠오르는 대로 한 줄이면 돼요. 맞고 틀린 답은 없고, 나만 봐요.", lock: () => noMe, done: () => !!priorOf() || S.chat.length > 0,
        body: () => `<textarea id="prior-in" data-save="s1.findings.${S.uid}.prior" maxlength="${MAX_AREA}" placeholder="${esc(ui().priorHint)}">${esc(priorOf())}</textarea>` },
      { solo: true, id: "chat", sub: "chat", name: "대화", q: "", lock: () => noMe || (priorOf() || S.chat.length ? null : { t: "대화 전에 처음 내 생각을 한 줄 적어요.", go: 1, sub: "prior", label: "적으러 가기" }),
        done: () => askedEnough() || !!mineNote().submitted, body: chatBody },
      { solo: true, id: "note", sub: "note", name: "알아낸 것", q: `${name}님은 어떤 사람이었나요?`, hint: "대화에서 알아낸 대로, 짧게 내 말로 써요.",
        lock: () => noMe || (mineNote().submitted || askedEnough() ? null : { t: `${name}님에게 질문을 ${Math.min(2, S.chatLimit)}번 이상 한 뒤에 정리해요.`, go: 1, sub: "chat", label: "대화하러 가기" }),
        done: () => mineNote().submitted || noteRequired().every((k) => txt(mineNote()[k]).length >= 4),
        body: () => [["who", "누구인가요?", "예) 어디에서 와서, 지금 무슨 일을 하는 사람"], ["hard", "가장 힘든 것은?", "한 가지만"], ["want", "바라는 것은?", ""],
          ...(deep("premise") ? [["premise", "당연하게 여기는 생각은?", "예) 열심히 일하면 그만큼 대가를 받아야 한다"]] : [])]
          .map(([k, l, ph]) => fld(`s1.findings.${S.uid}.${k}`, l, ph)).join("") },
      { solo: true, id: "doubt", sub: "note", name: "제출", q: `'정말 그럴까?' 싶었던 말이 있었나요?`, hint: "2·3단계에서 사실인지 확인해요. 없으면 비워 두고 제출해도 돼요.",
        lock: () => noMe || (mineNote().submitted || noteRequired().every((k) => txt(mineNote()[k]).length >= 4) ? null : { t: "알아낸 것부터 써요.", go: 1, sub: "note", label: "쓰러 가기" }),
        done: () => !!mineNote().submitted,
        body: () => mineNote().submitted
          ? `${recall("'정말 그럴까?' 싶었던 말", mineNote().doubt || "없음")}<div class="notice ok" role="status">제출했어요 ✓ <button class="btn btn-plain btn-sm" data-act="edit-note">고치기</button></div>`
          : `${fld(`s1.findings.${S.uid}.doubt`, "", `예) ${name}님은 ~라고 했는데, 정말일까?`)}<div class="sc-act"><button class="btn btn-primary" data-act="submit-note">제출하기</button></div>` },
      { id: "board", sub: "group", name: "친구들이 만난 사람", q: "친구들이 만난 사람들을 함께 읽어요", lock: notYet, body: boardBody,
        hint: `한 사람씩 돌아가며 소개해요. 👥 여기부터는 모둠이 함께 해요.` },
      { id: "conflict", sub: "group", name: "부딪히는 점", q: "누구의 바람과 누구의 걱정이 부딪히나요?", hint: "친구들 카드에서 서로 반대되는 바람을 찾아 한 문장으로 써요.", lock: notYet, done: () => filled("s1.problem.conflict"),
        body: () => fld("s1.problem.conflict", "", "예) 식당 주인은 손님이 다시 늘기를 바라지만, 신청자는 일자리가 사라질까 걱정한다", true) },
      deep("premise") && { id: "values", sub: "group", name: "부딪히는 가치", q: "두 쪽이 가장 소중하게 여기는 건 무엇일까요?", hint: "하나씩 골라요.", lock: notYet, done: () => !valuesMissing(),
        body: () => `${recall("부딪히는 점", w("s1.problem.conflict"))}<div class="row2">${pick("s1.problem.valueA", "한쪽은", VALUES)}${pick("s1.problem.valueB", "다른 쪽은", VALUES)}</div>
          ${fld("s1.problem.valueWhy", "둘 다 지키기 어려운 까닭은?", "예) 일자리를 지키려면 사람을 받아야 하는데, 그러면 주민이 불안해한다", true)}` },
      { id: "hmw", sub: "group", name: "우리 문제", q: "우리 모둠이 풀 문제를 한 문장으로 써요", hint: "<b>어떻게 하면 ~하면서도 ~할 수 있을까?</b> 꼴로 써 보세요.", lock: notYet, done: ready.problem,
        body: () => `${recall("부딪히는 점", w("s1.problem.conflict"))}${fld("s1.problem.hmw", "", "어떻게 하면 ________하면서도 ________할 수 있을까?", true, 10)}
          <details class="example" data-keep="ex-hmw" ${MID() ? "open" : ""}><summary>예시 보기</summary><div class="ex-row bad">✗ ${esc(ui().broadProblem)} <span>너무 넓어요</span></div>
          <div class="ex-row bad">✗ ${esc(ui().decidedProblem)} <span>답을 정해 버렸어요</span></div>
          <div class="ex-row good">✓ 어떻게 하면 급식 줄 서는 시간을 줄이면서도 모두가 충분히 먹을 수 있을까? <span>다른 주제의 예</span></div></details>` },
      { id: "check", sub: "group", name: "점검", q: "우리 문제, 세 가지만 점검해요", hint: "모두 맞으면 체크해요. 아니면 문장을 고쳐요.", lock: () => notYet() || (ready.problem() ? null : { t: "문제 문장을 먼저 써요.", go: 1, sub: "hmw", label: "쓰러 가기" }),
        done: () => checkedAll("s1.problem.checks", PROBLEM_CHECKS.length),
        body: () => `${recall("우리 문제", w("s1.problem.hmw"))}<div class="group">${PROBLEM_CHECKS.map((t, i) => `<label class="cell" style="cursor:pointer"><input type="checkbox" data-save="s1.problem.checks.${i}" ${w(`s1.problem.checks.${i}`) ? "checked" : ""} style="width:22px;height:22px;margin-top:1px"><span class="grow">${esc(t)}</span></label>`).join("")}</div>` },
    ];
  },

  2: () => {
    const causes = list("s2.causes"), mine = list("s2.links").filter((l) => l.by === S.uid);
    return gate("원인 찾기", ready.problem() ? null : { t: "1단계에서 모둠 문제를 먼저 정해요.", go: 1, sub: "group", label: "1단계로" }, [
      { solo: true, id: "why-me", name: "내 생각 돌아보기", q: "처음에 왜 그렇게 생각했을까요?", hint: "어디서 보거나 들었는지 떠올려요. 아래에서 골라 시작해도 돼요.",
        done: () => mine.length > 0, body: linkBody },
      { id: "mat", name: "실제 자료", q: "실제로는 어떤 일이 있었을까요?", hint: "자료를 읽고, 사실과 의견을 구별해 봐요.", body: () => {
        const cats = S.info.materials || [], cur = cats.find((c) => c.id === S.matTab) || cats[0];
        return `<div class="overview"><b>${esc(S.info.title)}</b><p>${esc(S.info.summary)}</p></div>${LEGEND}
          <div class="chipbar scroll">${cats.map((c) => `<button class="chip ${cur && c.id === cur.id ? "on" : ""}" data-act="mat-tab" data-id="${c.id}">${esc(c.title)}</button>`).join("")}</div>${matBody(cur)}`; } },
      { id: "cause", name: "원인 추측", q: "이 일은 왜 생겼을까요?", hint: `'~ 때문에'라고 생각나는 것을 하나씩 추가해요. 정답은 없어요.${deep("causeMap") ? " (두 개 이상)" : ""}`,
        done: () => causes.length >= (deep("causeMap") ? 2 : 1),
        body: () => `${listHtml("s2.causes", (q) => `${q.level ? `<span class="tag">${esc(q.level)}</span> ` : ""}${esc(q.text)}`, "")}
          ${pickLocal("cz-lv", "어디에서 생긴 일일까요?", causeLevels())}
          <div class="row add-row"><input type="text" id="cz" data-enter="add-cause" enterkeyhint="done" maxlength="${MAX_INPUT}" placeholder="예) ${esc(ui().causeExample)}" style="flex:1;min-width:0" /><button class="btn btn-tinted" data-act="add-cause">추가</button></div>
          ${coachBox("cause", "", causes.length >= 2)}` },
      deep("causeMap") && { id: "map", name: "원인 잇기", q: "어떤 원인 때문에 다른 원인이 생겼을까요?", hint: "'○○ 때문에 △△이 생겼다'처럼 두 원인을 이어 봐요.", done: () => list("s2.causeLinks").length > 0,
        lock: () => (causes.length < 2 ? { t: "원인을 두 개 이상 써야 이어 볼 수 있어요.", go: 2, sub: "cause", label: "원인 쓰러 가기" } : null), body: () => causeMapHtml(causes) },
      { id: "q", name: "확인 질문", q: "'정말 그럴까?' 싶은 말, 무엇을 찾아보면 알 수 있을까요?", hint: `숫자나 사실로 답할 수 있게 물어요. 예) ${esc(ui().goodQuestion)}`,
        done: () => list("s2.checks").length > 0, body: checkBody },
    ]);
  },

  3: () => {
    const checks = list("s2.checks"), causes = list("s2.causes");
    const lock = !ready.problem() ? { t: "1단계에서 모둠 문제를 먼저 정해요.", go: 1, sub: "group", label: "1단계로" }
      : !checks.length ? { t: "2단계에서 확인 질문을 먼저 만들어요.", go: 2, sub: "q", label: "2단계로" } : null;
    return gate("사실 확인", lock, [
      ...checks.map((c, i) => ({ id: `c-${c.id}`, name: `확인 ${i + 1}`, q: checks.length > 1 ? `그 말, 사실일까요? (${i + 1}/${checks.length})` : "그 말, 사실일까요?",
        hint: "자료를 보고 우리가 판단해요.", done: () => judged3(c), body: () => judgeBody(c) })),
      { id: "keep", name: "추측 정리", q: "확인해 보니, 우리 추측은 맞았나요?", hint: "추측마다 하나씩 골라요. 사실로 확인된 것만 '남겨요'를 고를 수 있어요.",
        lock: () => (causes.length ? null : { t: "2단계에서 원인 추측을 먼저 써요.", go: 2, sub: "cause", label: "2단계로" }),
        done: () => causes.every((q) => w(`s3.causes.${q.id}.status`)) && keptCauses().length > 0, body: keepBody },
      { id: "cause", name: "가장 큰 원인", q: "그래서 우리 문제의 가장 큰 원인은?", hint: "남긴 원인 가운데, 우리가 바꿔 볼 수 있는 것으로 골라요.", done: ready.cause,
        body: () => `${recall("우리 문제", w("s1.problem.hmw"))}${keptCauses().length ? `<div class="chipbar">${keptCauses().map((q) => `<button class="chip" data-act="use-kept" data-t="${esc(q.text)}">${esc(q.text.slice(0, 34))}</button>`).join("")}</div>` : ""}
          ${fld("s3.chain.cause", "", "한두 문장으로", true, 10)}` },
      deep("causeMap") && { id: "root", name: "뿌리 따지기", q: "이 원인만 해결하면, 다른 문제도 같이 풀릴까요?", lock: () => (ready.cause() ? null : { t: "가장 큰 원인을 먼저 써요.", go: 3, sub: "cause", label: "쓰러 가기" }),
        done: () => said("s3.chain.root"), body: () => `${recall("가장 큰 원인", w("s3.chain.cause"))}${linksNote()}${fld("s3.chain.root", "", "예) 이 원인이 줄면 ~도 함께 줄어든다. 그래서 ~", true)}` },
    ]);
  },

  4: () => {
    const props = list("s4.proposals"), logs = stageLogs(4), cases = S.info.cases || [];
    const firstThought = () => (said("s4.before") ? null : { t: "사례를 보기 전에 우리 생각부터 써요.", go: 4, sub: "before", label: "쓰러 가기" });
    return gate("해결책 만들기", ready.cause() ? null : { t: "3단계에서 가장 큰 원인을 먼저 정해요.", go: 3, sub: "cause", label: "3단계로" }, [
      { id: "before", name: "우리 첫 생각", q: "이 원인을 줄이려면 무엇을 하면 좋을까요?", hint: "다른 나라 사례를 보기 전에, 우리 생각부터 떠오르는 대로.", done: () => said("s4.before"),
        body: () => `${recall("가장 큰 원인", w("s3.chain.cause"))}${fld("s4.before", "", "예) 서로 얼굴을 보고 이야기할 자리를 만들면 좋겠다", true)}` },
      cases.length && { id: "cases", name: "다른 나라 사례", q: "다른 나라는 어떻게 했을까요?", hint: "그대로 옮기지 말고, 빌려 올 점과 피할 점을 찾아요.", lock: firstThought, body: () => {
        const cur = cases.find((c) => c.id === S.caseTab) || cases[0];
        return `<div class="chipbar scroll">${cases.map((c) => `<button class="chip ${c.id === cur.id ? "on" : ""}" data-act="case-tab" data-id="${c.id}">${esc(c.country)}</button>`).join("")}</div>
          <div class="case"><div class="case-head"><span class="tag b">${esc(cur.country)}</span><h3>${esc(cur.title)}</h3></div>
            <div class="case-sec"><b>무엇을 했나</b><p>${esc(cur.what)}</p></div>
            <div class="case-sec"><b>어떻게 되었나</b><p>${esc(cur.result)}</p></div>
            <div class="case-sec think"><b>${esc(ui().compareWith)}${josa(ui().compareWith, "과", "와")} 비교하면?</b><p>${esc(cur.think)}</p></div>
            <div class="case-src"><b>출처</b>${cur.links.map(linkHtml).join("<br>")}</div></div>`; } },
      { id: "props", name: "해결책 쓰기", q: "우리 해결책을 세 칸에 나눠 써요", hint: `누가, 무엇을, 어떻게 할지 채우고 추가해요.${deep("tradeoff") ? " 두 개 이상 써서 견줘 봐요." : ""}`, lock: firstThought,
        done: () => props.length >= (deep("tradeoff") ? 2 : 1), body: () => `${props.map((p) => `<div class="card flat item"><div class="grow">${propHtml(p.text)}</div>${who(p)}
            <div class="row" style="margin-top:8px"><button class="btn btn-tinted btn-sm" data-act="ask-feedback" data-id="${p.id}" ${S.busy ? "disabled" : ""}>AI 조언 듣기 (선택)</button>
            <button class="btn btn-plain btn-sm" data-act="del" data-path="s4.proposals" data-id="${p.id}">삭제</button></div></div>`).join("")}
          ${S.busy === "feedback" ? loading(`AI 조언자 ${lensCount()}명이 읽는 중이에요…`, "기다리는 동안 우리 해결책의 약점을 먼저 짐작해 보세요") : ""}
          <div class="who-what-how">
            <label><span>누가</span><input type="text" id="pt-who" data-next="pt-what" enterkeyhint="next" maxlength="80" placeholder="예) 시청, 우리 학교 학생회" /></label>
            <label><span>무엇을</span><input type="text" id="pt-what" data-next="pt-how" enterkeyhint="next" maxlength="120" placeholder="예) 일자리를 이어 주는 안내소를" /></label>
            <label><span>어떻게</span><input type="text" id="pt-how" data-enter="add-proposal" enterkeyhint="done" maxlength="200" placeholder="예) 여러 나라 말로 매주 연다" /></label></div>
          <div class="sc-act"><button class="btn btn-tinted" data-act="add-proposal">해결책 추가</button></div>` },
      logs.length && { id: "advice", free: true, name: "AI 조언", q: "AI 조언, 받아들일까요?", hint: "정하는 건 우리예요. AI 말이라서가 아니라 우리 생각으로 이유를 써요.",
        done: () => logs.every((l) => w(`s4.decisions.${l.id}.choice`) && said(`s4.decisions.${l.id}.reason`)), body: () => logs.map((l) => { let rv = []; try { rv = JSON.parse(l.output).reviews || []; } catch {}
          const p = props.find((x) => x.id === l.payload?.proposalId);
          return `<div class="card flat item">${recall("해결책", (p?.text || l.input).slice(0, 120))}
            ${rv.map((r) => `<div class="review"><span class="tag b">${esc(r.label)}</span><div class="ai-out">${esc(r.text)}</div></div>`).join("")}
            ${pick(`s4.decisions.${l.id}.choice`, "어떻게 할까요?", DECISIONS)}${fld(`s4.decisions.${l.id}.reason`, "그렇게 정한 이유는?", "", true)}</div>`; }).join("") },
      deep("tradeoff") && { id: "trade", name: "견주기", q: "해결책마다 좋아지는 점과 손해 보는 점은?", hint: "누가 좋아지고, 누가 부담을 지는지 생각해요.",
        lock: () => (props.length < 2 ? { t: "해결책을 두 개 이상 써야 견줄 수 있어요.", go: 4, sub: "props", label: "해결책 쓰러 가기" } : null),
        done: () => tradeDone() >= 2 && said("s4.tradeValue"), body: () => `${props.map((p, i) => `<div class="card flat item"><span class="tag b">해결책 ${i + 1}</span>${propHtml(p.text)}
            ${fld(`s4.trade.${p.id}.gain`, "👍 좋아지는 점", "누구에게 무엇이 좋아지나요?", true)}${fld(`s4.trade.${p.id}.cost`, "👎 손해 보는 점", "누가 무엇을 잃나요?", true)}</div>`).join("")}
          ${fld("s4.tradeValue", "둘 중 어느 쪽이 더 나을까요? 왜요?", "예) 1번이 더 낫다. 손해 보는 사람이 적기 때문이다", true)}` },
      { id: "final", name: "최종 해결책", q: "우리 모둠의 최종 해결책은?", hint: "누가 · 무엇을 · 어떻게. 고칠 점이 있었다면 고쳐서 써요.", lock: () => (props.length ? null : { t: "해결책을 먼저 써요.", go: 4, sub: "props", label: "쓰러 가기" }),
        done: () => ready.final() && said("s4.finalReason"), body: () => `${recall("우리 문제", w("s1.problem.hmw"))}
          ${props.length ? `<div class="lbl">쓴 해결책을 눌러 가져와 고쳐도 돼요</div><div class="chipbar">${props.map((p, i) => `<button class="chip" data-act="use-prop" data-t="${esc(p.text)}">해결책 ${i + 1}</button>`).join("")}</div>` : ""}
          ${fld("s4.final", "", "누가, 무엇을, 어떻게 할지 한두 문장으로", true, 30)}${fld("s4.finalReason", "왜 이 해결책을 골랐나요?", "예) 두 사람의 바람을 모두 지킬 수 있어서", true)}` },
      midCheck() && { id: "fair", name: "점검", q: "이 해결책, 정말 효과가 있을까요?", lock: () => (ready.final() ? null : { t: "최종 해결책을 먼저 써요.", go: 4, sub: "final", label: "쓰러 가기" }),
        done: () => !!w("s4.check.effect") && said("s4.check.fair"),
        body: () => `${recall("최종 해결책", w("s4.final"))}${pick("s4.check.effect", "가장 큰 원인을 줄일 수 있나요?", EFFECT)}${fld("s4.check.fair", "이 해결책 때문에 힘들어지는 사람은 없나요?", "예) 가게 주인이 힘들 수 있어서, 도움도 함께 준다", true)}` },
    ]);
  },

  5: () => {
    const preds = list("s5.predictions"), logs = stageLogs(5), sh = S.info.stakeholders || [];
    const picked = (l) => Number.isInteger(w(`s5.selection.${l.id}.idx`));
    return gate("미래 그려 보기", ready.final() ? null : { t: "4단계에서 최종 해결책을 먼저 써요.", go: 4, sub: "final", label: "4단계로" }, [
      { id: "pred", name: "반응 예측", q: "이 해결책을 실행하면, 사람들은 어떻게 반응할까요?", hint: `사람을 고르고, 반응과 이유를 써요. (${Math.min(preds.length, 2)}/2)`, done: () => preds.length >= 2,
        body: () => `${recall("최종 해결책", w("s4.final"))}${listHtml("s5.predictions", (r) => `<span class="tag">${esc(r.stakeholder)}</span> ${esc(r.text)}`, "")}
          ${pickLocal("ps", "누가?", sh)}
          <div class="row add-row"><input type="text" id="pp" data-enter="add-pred" enterkeyhint="done" maxlength="${MAX_INPUT}" placeholder="예) 처음엔 반대할 것 같다. 일자리를 빼앗길까 봐" style="flex:1;min-width:0" /><button class="btn btn-tinted" data-act="add-pred">추가</button></div>` },
      deep("chain") && { id: "chain", name: "연쇄 반응", q: "누군가 그렇게 반응하면, 그다음엔 무슨 일이 생길까요?", done: () => said("s5.chain"),
        body: () => fld("s5.chain", "", "예) 주민이 반대하면 시청은 설명회를 열 것이고, 그러면 오해가 조금 풀릴 것이다", true) },
      { id: "ai", free: true, name: "AI 미래 이야기", opt: true, q: "AI가 그린 미래와 견줘 볼까요?", hint: "만들지 않고 넘어가도 돼요.",
        lock: () => (preds.length >= 2 ? null : { t: "반응 예측을 두 개 먼저 써요.", go: 5, sub: "pred", label: "쓰러 가기" }),
        done: () => logs.every((l) => !picked(l) || said(`s5.selection.${l.id}.vs`)) && (!logs.length || logs.some(picked)), body: () => `
          ${rounds().length > 1 ? `<div class="chipbar">${rounds().map((r) => `<button class="chip ${S.round === r ? "on" : ""}" data-act="round" data-r="${r}">${r}년 후</button>`).join("")}</div>` : ""}
          ${S.busy === "scenario" ? loading("미래 이야기를 만드는 중이에요. 1~2분 걸릴 수 있어요…", "기다리는 동안 누가 가장 크게 반응할지 이야기해 보세요") : ""}
          ${logs.length ? "" : `<div class="sc-act"><button class="btn btn-primary" data-act="ask-scenario" ${S.busy ? "disabled" : ""}>${rounds().length > 1 ? `${S.round}년 후 ` : `${rounds()[0]}년 후 `}미래 이야기 만들기</button></div>`}
          ${logs.map((l) => { let sc = []; try { sc = JSON.parse(l.output).scenarios || []; } catch {}
            const sel = w(`s5.selection.${l.id}`) || {};
            return `<div class="meta-line">${l.payload?.round}년 후</div>${sc.map((x, i) => `<div class="scn ${sel.idx === i ? "sel" : ""}"><b>${esc(x.title)}</b><p style="margin-top:6px">${esc(x.story)}</p>
              <div class="meta-line">걱정되는 일: ${esc([].concat(x.newProblems || []).join(" / "))}</div>
              <button class="btn ${sel.idx === i ? "btn-tinted" : "btn-plain"} btn-sm" style="margin-top:8px" data-act="pick-scn" data-id="${l.id}" data-i="${i}">${sel.idx === i ? "✓ 더 그럴듯해요" : "이쪽이 더 그럴듯해요"}</button></div>`).join("")}
              ${picked(l) ? fld(`s5.selection.${l.id}.vs`, "우리 예측과 무엇이 같고, 무엇이 달랐나요?", "", true) : ""}`; }).join("")}
          ${logs.length ? `<div class="sc-act"><button class="btn btn-plain btn-sm" data-act="ask-scenario" ${S.busy ? "disabled" : ""}>다시 만들기</button></div>` : ""}` },
      { id: "worry", name: "걱정되는 문제", q: "해결책을 실행하면, 가장 걱정되는 문제는?", hint: "우리 예측이나 미래 이야기에서 골라요.", done: () => filled("s5.newProblem"),
        body: () => fld("s5.newProblem", "", "예) 일자리를 두고 다툼이 생길 수 있다", true) },
    ]);
  },

  6: () => gate("실천 계획", ready.final() ? null : { t: "4단계에서 최종 해결책을 먼저 써요.", go: 4, sub: "final", label: "4단계로" }, [
    { id: "plan", name: "할 일", q: "우리가 실제로 할 수 있는 일은 무엇인가요?", hint: MID() ? "나와 우리 반이 할 수 있는 일로 써요." : "누구에게, 무엇을, 어떻게 할지 써요.", done: () => filled("s6.plan.content"),
      body: () => `${recall("최종 해결책", w("s4.final"))}${recall("걱정되는 문제", w("s5.newProblem"))}${fld("s6.plan.target", "누구에게?", "예) 우리 학교 친구들, 시청", false)}${fld("s6.plan.content", "무엇을, 어떻게?", "예) 설득하는 편지 쓰기, 캠페인, 실천 약속", true)}` },
    deep("power") && { id: "power", name: "권한", q: "이 일은 누가 정할 수 있나요? 어떻게 알릴까요?", hint: "시청, 학교, 국회처럼 정하는 곳과, 우리 생각을 전할 방법을 써요.", done: () => said("s6.plan.authority"),
      body: () => fld("s6.plan.authority", "", "예) 시청 ○○과에 주민 제안으로 / 학교운영위원회에 건의", true) },
  ]),

  7: () => [
    { id: "real", name: "실제 전개", q: "실제로는 어떻게 되었을까요?", hint: `${esc(ui().afterSince)} 이후에 실제로 일어난 일이에요.`, body: () => (S.info.aftermath || []).length
      ? `<div class="mat">${S.info.aftermath.map((it) => `<div class="mat-item"><span class="kind k-${esc(it.kind)}">${esc(it.kind)}</span><p>${esc(it.text)}</p>
        <div class="cap">${it.links.map((l) => `<a href="${esc(safeHref(l.url))}" target="_blank" rel="noopener noreferrer">${esc(l.outlet)}${l.date && !/확인/.test(l.date) ? ` ${esc(l.date)}` : ""}</a>`).join(" · ")}</div></div>`).join("")}</div>`
      : `<div class="notice muted">선생님이 이후 전개 자료를 준비하는 중이에요.</div>` },
    { id: "compare", name: "비교", q: "우리 예상과 실제, 무엇이 같고 무엇이 달랐나요?", done: () => said("s7.compare"),
      body: () => `${recall("우리 해결책", w("s4.final"))}${recall("우리가 걱정한 문제", w("s5.newProblem"))}${fld("s7.compare", "", `예) ${ui().afterExample}`, true)}` },
    deep("why") && { id: "why", name: "달랐던 까닭", q: "왜 달랐을까요? 우리가 놓친 것은?", done: () => said("s7.why"),
      body: () => fld("s7.why", "", "예) 우리는 주민 생각만 봤는데, 실제로는 일자리 때문에 많이 떠났다", true) },
    { solo: true, id: "after", name: "내 생각의 변화", q: "처음 내 생각은 어떻게 바뀌었나요?", hint: "그대로여도 괜찮아요. 왜 그런지 써요. (혼자)", done: () => said(`s7.after.${S.uid}`),
      body: () => `${recall("처음 내 생각", priorOf() || "적지 않았어요")}${fld(`s7.after.${S.uid}`, "", "예) 처음엔 ~라고 생각했는데, ~를 알게 되어 ~", true)}` },
    { id: "share", name: "발표 준비", q: "우리 모둠 이야기를 서너 문장으로 정리해요", hint: "문제 → 원인 → 해결책 순서로, 왜 그렇게 정했는지 넣어요.", done: () => filled("s7.share"),
      body: () => `<div class="flow">${flowRows().map(([n, sc, k, v]) => `<div class="fl ${v ? "" : "miss"}"><span>${k}</span><div>${v ? esc(v) : "비어 있음"}</div>
        ${v ? "" : `<button class="link" data-go="${n}" data-sub="${sc}">${n}단계로</button>`}</div>`).join("")}</div>${fld("s7.share", "", "우리는 ~을 문제로 보고, ~ 때문이라고 생각해 ~을 하기로 했다", true)}` },
    { id: "ai", name: "AI 돌아보기", q: "오늘 AI가 한 말 중, 믿은 것과 믿지 않은 것은?", hint: "왜 그랬는지도 써요.", done: () => filled("s7.reflection"),
      body: () => `${fld("s7.reflection", "", "예) ~는 자료와 맞아서 받아들였고, ~는 확인이 안 돼서 버렸다", true)}
        <div class="group" style="margin-top:12px">${CHECKLIST.map((t, i) => `<label class="cell" style="cursor:pointer"><input type="checkbox" data-save="s7.checks.${i}" ${w(`s7.checks.${i}`) ? "checked" : ""} style="width:20px;height:20px;margin-top:2px"><span class="grow">${esc(t)}</span></label>`).join("")}</div>` },
  ],
};
// '누가: … / 무엇을: … / 어떻게: …' 로 쓴 해결책은 세 줄로 보여 준다(예전 글은 그대로)
function propHtml(t) {
  const m = /^누가: (.*) \/ 무엇을: (.*) \/ 어떻게: (.*)$/s.exec(t || "");
  return m ? `<div class="www">${[["누가", m[1]], ["무엇을", m[2]], ["어떻게", m[3]]].map(([k, v]) => `<div><span>${k}</span>${esc(v)}</div>`).join("")}</div>` : `<div>${esc(t || "")}</div>`;
}
const keptCauses = () => list("s2.causes").filter((q) => [CAUSE_STATUS[0], OLD_CAUSE_STATUS[0]].includes(w(`s3.causes.${q.id}.status`)));

// 1단계: 인물 고르기. 카드를 누르면 편지 창이 열린다. 사건마다 정한 인물(예: 난민 신청자)은 모둠에 꼭 한 명 있어야 한다.
function pickBody() {
  const letters = S.info.letters || [], mineId = S.me?.id, started = S.chatCount > 0;
  const hasRequired = letters.some((l) => l.required && S.picks[l.id]);
  const card = (l) => {
    const t = S.picks[l.id], mine = l.id === mineId, other = t && !mine;
    const state = mine ? `<span class="tag g">내가 고름</span>` : other ? `<span class="tag x">${esc(t.nick || "친구")} 선택</span>` : l.required ? `<span class="tag y">${esc(ui().requiredTag)}</span>` : "";
    return `<div class="pcard pc-pop ${mine ? "mine" : ""} ${other ? "taken" : ""}" data-id="${esc(l.id)}">
      <button type="button" class="pc-open" data-act="read-letter" data-id="${esc(l.id)}" aria-haspopup="dialog"><div class="avatar sm">${esc(l.name.slice(0, 1))}</div><div class="pc-t"><b>${esc(l.name)}</b><small>${esc(l.brief)}</small></div>${state}<span class="pc-more">${mine ? "다시 읽기" : "편지 읽기"}</span></button></div>`;
  };
  return `${hasRequired ? "" : `<div class="notice yellow" role="status">모둠에서 한 명은 꼭 <b>${esc(ui().requiredWho)}</b>${josa(ui().requiredWho, "을", "를")} 골라요.</div>`}
    ${mineId ? `<div class="notice ok pick-ok" role="status"><span><b>${esc(S.me.name)}</b>님을 골랐어요.${started ? "" : " 대화 전에는 바꿀 수 있어요."}</span></div>` : ""}
    <div class="pcards">${letters.map(card).join("")}</div>
    <div class="meta-line">우리 모둠 ${Math.max(S.memberCount, Object.keys(S.picks).length)}명 중 ${Object.keys(S.picks).length}명이 골랐어요.</div>`;
}

// 1단계: 메신저 대화. PC 넓은 화면은 편지를 옆에 펼쳐 두고, 휴대폰은 대화창이 화면 대부분을 쓴다.
function chatBody() {
  const me = S.me;
  // 처음 받는 편지는 도착하듯 내려앉는다(한 번만)
  const arrive = !S.chat.length && !seenList().includes("letter");
  if (arrive) markSeen("letter");
  const letterOpen = WIDE() || (IS_M && !S.chat.length);
  return `<div class="split chat-split"><div class="split-side"><details class="letter ${arrive ? "arrive" : ""}" data-keep="letter" ${letterOpen ? "open" : ""}>
    <summary>${esc(me.name)}에게서 편지가 왔어요</summary>
    <div class="body">${me.letter.map((p) => `<p>${esc(p)}</p>`).join("")}<div class="sign">${esc(ui().letterSign)}<br>${esc(me.name)} 드림</div></div>
  </details></div>
  <div class="split-main"><div class="goal-chips" aria-label="알아낼 것"><span>알아낼 것</span><b>① 누구인지</b><b>② 힘든 것</b><b>③ 바라는 것</b></div>
  <div class="card chat-card">
    <div class="chat-head"><div class="avatar">${esc(me.name.slice(0, 1))}</div><div><div class="nm">${esc(me.name)}</div><div class="st ${S.locked ? "off" : ""}">${S.locked ? "대화 멈춤" : "대화 중"}</div></div><div class="chat-tools"><button class="btn btn-plain btn-sm m-only" data-act="letter" aria-label="편지 다시 읽기">편지</button><button class="btn btn-plain btn-sm" data-act="dl-chat" aria-label="내 대화를 글 파일로 저장">대화 저장</button></div></div>
    <div class="chat-rule">${me.personal ? "개인적인 이야기도 물어볼 수 있어요." : "단체·기관에서 일하는 사람이라, 하는 일과 생각을 중심으로 물어봐요."} 놀리거나 모욕하는 말은 선생님께 알려지고, 3번이면 대화가 멈춰요.</div>
    <div class="msgs" id="msgs" role="log" aria-live="polite" aria-label="인물과의 대화"></div>
    <div class="starters">${STARTERS.map((q) => `<button class="chip sm" data-act="starter" data-t="${esc(q)}">${esc(q)}</button>`).join("")}</div>
    ${S.locked ? `<div class="composer locked" role="alert">대화 규칙을 여러 번 어겨 대화가 멈췄어요. 선생님께 말씀드리면 다시 열어 주실 수 있어요.</div>`
      : `<form class="composer" id="chat-form" autocomplete="off">
      <div class="chat-left" id="chat-left" role="status" aria-live="polite"></div>
      <input type="text" id="msg" maxlength="500" enterkeyhint="send" autocomplete="off" autocorrect="off" placeholder="${esc(me.name)}에게 메시지 보내기" />
      <button class="send" id="send-btn" type="submit" aria-label="보내기">${SEND_ICON}</button>
    </form>`}
  </div></div></div>`;
}

// 1단계: 친구들이 만난 사람들을 나란히 본다(제출한 사람만). 사람마다 카드 하나: 누구를 누가 만났는지, 세 가지, '정말 그럴까?'
function boardBody() {
  const all = submitted().sort((a, b) => (b.id === S.uid) - (a.id === S.uid)), done = all.length, total = Math.max(S.memberCount, done); // 내 카드가 먼저
  const row = (k, v) => (txt(v) ? `<div class="b-r"><span>${k}</span><p>${esc(v)}</p></div>` : "");
  const status = `<div class="b-status"><span class="b-count">${done} / ${total}명 제출</span>${all.map((f) => `<span class="b-who">${f.id === S.uid ? "나" : esc(f.nick || "")}</span>`).join("")}${done < total ? `<span class="b-who off">${total - done}명 기다리는 중</span>` : ""}</div>`;
  return `${status}<div class="board">${all.map((f) => `<article class="b-col">
      <header class="b-h"><span class="avatar sm">${esc((f.persona || "?").slice(0, 1))}</span><span class="b-t"><b>${esc(f.persona || "인물")}</b><small>${f.id === S.uid ? "내가" : `${esc(f.nick || "친구")}${josa(f.nick || "친구", "이", "가")}`} 만났어요</small></span></header>
      <div class="b-rows">${row("누구", f.who || f.text)}${row("힘든 것", f.hard)}${row("바라는 것", f.want)}${row("당연한 생각", f.premise)}</div>
      ${txt(f.doubt) ? `<div class="b-doubt"><span>정말 그럴까?</span>${esc(f.doubt)}</div>` : ""}</article>`).join("")}</div>`;
}

// 2단계: 처음 내 생각이 어디서 왔는지 쓰고 모둠에 보인다. 남의 문제를 '나와 비슷한 점' 찾기로 억지로 잇지 않고, 내가 당연하게 믿어 온 것에서 출발한다.
function linkBody() {
  const all = list("s2.links"), mine = all.filter((l) => l.by === S.uid), others = all.filter((l) => l.by !== S.uid);
  const view = (l, own) => `<div class="card flat item link-card">${l.prior ? `<div class="meta-line">처음 생각: ${esc(l.prior)}</div>` : ""}
      <div style="margin-top:4px">${esc(l.source)}</div>
      ${own ? coachBox("link", l.id, true, "", stageLogs(2).some((g) => g.payload?.linkId === l.id) ? fld(`s2.linkMore.${l.id}`, "질문을 받고 더 생각한 것", "", true) : "")
        : txt(w(`s2.linkMore.${l.id}`)) ? `<div class="meta-line" style="margin-top:6px">더 생각한 것: ${esc(w(`s2.linkMore.${l.id}`))}</div>` : ""}
      <div class="row" style="margin-top:8px;justify-content:space-between">${who(l)}${own ? `<button class="btn btn-plain btn-sm" data-act="del" data-path="s2.links" data-id="${l.id}">삭제</button>` : ""}</div></div>`;
  return `${recall("처음 내 생각", priorOf() || "1단계에서 적지 않았어요")}
    ${mine.length ? mine.map((l) => view(l, true)).join("") : `<div class="chipbar">${["뉴스·인터넷에서 봤어요", "주변 사람에게 들었어요", "직접 겪었어요", "그냥 그런 느낌이었어요"].map((t) => `<button class="chip" data-act="lk-start" data-t="${esc(t)}">${esc(t)}</button>`).join("")}</div><textarea id="lk-src" maxlength="${MAX_INPUT}" aria-label="처음 내 생각은 어디서 왔을까요?" placeholder="예) 뉴스 제목만 봤어요. 거기서 '가짜 난민'이라는 말을 봤어요"></textarea>
      <div class="sc-act"><button class="btn btn-tinted" data-act="add-link">모둠에 보이기</button></div>`}
    ${others.length ? `<label class="lbl">친구들의 생각</label>${others.map((l) => view(l, false)).join("")}` : ""}`;
}

// 2단계: 확인 질문 만들기. 인물에게 들은 '정말 그럴까?' 말을 누르면 칸에 들어간다.
function checkBody() {
  const doubts = submitted().filter((f) => txt(f.doubt));
  return `${list("s2.checks").map((c) => `<div class="card flat item"><div class="meta-line">${esc(c.heard)}${c.fo ? ` · ${esc(c.fo)}` : ""}</div><b>${esc(c.question)}</b>
      <div class="row" style="margin-top:6px;justify-content:space-between">${who(c)}<button class="btn btn-plain btn-sm" data-act="del" data-path="s2.checks" data-id="${c.id}">삭제</button></div></div>`).join("")}
    ${doubts.length ? `<div class="chipbar">${doubts.map((f) => `<button class="chip" data-act="use-doubt" data-t="${esc(`${f.persona || f.nick}: ${f.doubt}`)}">${esc(f.doubt.slice(0, 30))}</button>`).join("")}</div>` : ""}
    <label class="lbl" for="ch-heard">① 의심 가는 말 (누가 한 말인지도)</label><input type="text" id="ch-heard" data-next="ch-q" enterkeyhint="next" maxlength="${MAX_INPUT}" placeholder="예) ${esc(ui().heardExample)}" />
    ${MID() ? pickLocal("ch-fo", "이 말은 일어난 일(사실)일까요, 그 사람 생각(의견)일까요?", FACT_OPINION, false) : ""}
    <label class="lbl" for="ch-q">② 무엇을 찾아보면 알 수 있을까요?</label><input type="text" id="ch-q" data-enter="add-check" enterkeyhint="done" maxlength="${MAX_INPUT}" placeholder="예) ${esc(ui().checkQuestion)}" />
    <div class="sc-act"><button class="btn btn-tinted" data-act="add-check">추가</button></div>`;
}

// 3단계: 확인 질문 하나를 자료로 판단한다. AI 검색 도우미는 내 예상을 쓴 뒤에만 물을 수 있다(선택).
function judgeBody(c) {
  const logs = logsOf3(c), open3 = ready.problem();
  const judge = (base, label) => `${pick(`${base}.verdict`, label, verdicts())}${fld(`${base}.source`, "어떤 자료에서 무엇을 보고 알았나요?", "예) 사건 자료에 ~라고 나와 있다")}${sourceMore(base)}`;
  return `<div class="quote"><div class="meta-line">${esc(c.heard)}</div><b>${esc(c.question)}</b></div>
    <div class="sc-act"><button class="btn btn-tinted btn-sm" data-act="show-mat">📄 사건 자료 보기</button></div>
    ${logs.length ? "" : `<div class="judge">${judge(`s3.direct.${c.id}`, "자료를 보니, 그 말은?")}</div>
      <details class="example" data-keep="ask3-${c.id}"><summary>AI 검색 도우미에게도 물어볼래요 (선택)</summary>
        ${fld(`s3.guess.${c.id}`, "묻기 전에, 내 예상은?", "예) 아마 ~일 것 같다")}
        <div class="row" style="margin-top:10px"><button class="btn btn-primary btn-sm" data-act="ask-check" data-id="${c.id}" ${S.busy || !open3 || !said(`s3.guess.${c.id}`, 2) ? "disabled" : ""}>검색 도우미에게 묻기</button>${said(`s3.guess.${c.id}`, 2) ? "" : `<span class="meta-line">내 예상을 먼저 쓰면 열려요</span>`}</div></details>`}
    ${S.busy === "check:" + c.id ? loading("", "기다리는 동안 사건 자료에서 먼저 찾아볼까요?") : ""}
    ${logs.map((l) => `<div class="ai-block"><div class="meta-line">검색 도우미의 답</div><div class="ai-out">${esc(l.output)}</div>${srcLinks(l.payload?.sources)}
      <div class="judge">${judge(`s3.checks.${l.id}`, "확인해 보니, 그 말은?")}</div></div>`).join("")}
    ${logs.length ? `<div style="margin-top:8px"><button class="btn btn-plain btn-sm" data-act="ask-check" data-id="${c.id}" ${S.busy || !open3 ? "disabled" : ""}>다시 묻기</button></div>` : ""}`;
}

// 3단계: 추측마다 남길지 버릴지. 사실로 확인된 결과가 없으면 '확인돼서 남겨요'는 고를 수 없다.
function keepBody() {
  const checks = list("s2.checks"), all = checks.flatMap(verdicts3);
  return `<div class="group">${list("s2.causes").map((q) => {
    // 확인 질문이 이 추측을 가리키면 그 결과만, 아니면 확인한 결과 전체를 본다
    const linked = checks.filter((c) => c.causeId === q.id), vs = linked.length ? linked.flatMap(verdicts3) : all, support = vs.some((v) => SUPPORT.includes(v));
    return `<div class="cell"><div class="grow"><b>${esc(q.text)}</b>
      ${pick(`s3.causes.${q.id}.status`, "", support ? CAUSE_STATUS : CAUSE_STATUS.slice(1))}</div></div>`; }).join("")}</div>
    ${all.some((v) => SUPPORT.includes(v)) ? "" : `<div class="meta-line">아직 '사실이다'로 확인한 것이 없어요.</div>`}`;
}

// ---------- 이벤트 ----------
const val = (id) => document.getElementById(id)?.value.trim() ?? "";

async function aiGroup(stage, type, payload, busyKey) {
  await flushAll();
  S.busy = busyKey; S.waitSince = Date.now(); render(true);
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
  m.focus({ preventScroll: true }); // 키보드가 내려가지 않게 해서 이어서 바로 쓸 수 있다
});
// 보내기 버튼을 눌러도 입력칸의 초점을 뺏지 않는다(휴대폰에서 키보드가 닫혔다 열리는 것을 막는다)
panel.addEventListener("pointerdown", (e) => { if (e.target.closest("#send-btn")) e.preventDefault(); });

panel.addEventListener("click", async (e) => {
  const go = e.target.closest("[data-go]");
  if (go) { goTo(Number(go.dataset.go), go.dataset.sub || null); return; }
  const sc = e.target.closest("[data-scene]");
  if (sc && !sc.disabled) { goTo(S.stage, sc.dataset.scene); return; }
  const b = e.target.closest("[data-act]"); if (!b) return;
  const a = b.dataset.act, d = b.dataset;

  switch (a) {
    case "del": { // 묻지 않고 지운 뒤 몇 초 동안 되돌릴 수 있게 한다
      const old = (w(d.path) || {})[d.id];
      await delItem(d.path, d.id);
      if (old !== undefined) toastAction("삭제했어요", "되돌리기", () => save(`${d.path}.${d.id}`, old));
      break;
    }
    case "retry-chat": { const t = S.chatErr?.text; if (t && !S.sending) sendChat(t); break; }
    case "dl-chat": downloadChat(); break;
    case "help": maybeHelp(true); break;
    case "letter": if (S.me) await showModal({ title: `${esc(S.me.name)}에게서 온 편지`, body: S.me.letter.map((p) => `<p>${esc(p)}</p>`).join(""), dismissible: true, actions: [{ label: "닫기", value: true, kind: "btn-primary" }] }); break;
    case "read-letter": await readLetter(d.id); break;
    case "case-tab": S.caseTab = d.id; render(true); break;
    case "mat-tab": S.matTab = d.id; render(true); break;
    case "show-mat": await showMaterials(); break;
    case "pick-local": { (S.localPick ||= {})[d.id] = d.v; const h = document.getElementById(d.id); if (h) h.value = d.v;
      b.parentElement.querySelectorAll(".choice").forEach((c) => c.classList.toggle("on", c === b)); break; }
    case "starter": { const m = $("#msg"); if (m) { m.value = d.t; S.draft = d.t; m.focus(); } break; }
    case "submit-note": {
      await flushAll();
      const mine = w(`s1.findings.${S.uid}`) || {};
      if (Math.max(S.chatCount, S.chat.length) < Math.min(2, S.chatLimit)) return toast(`대화에서 질문을 ${Math.min(2, S.chatLimit)}번 이상 해야 정리할 수 있어요.`, true);
      if (noteRequired().some((k) => txt(mine[k]).length < 4)) return toast("알아낸 것을 모두 4자 이상 써야 제출할 수 있어요.", true);
      await save(`s1.findings.${S.uid}`, { ...mine, nick: S.nick, persona: S.me?.name || "", submitted: true, t: Date.now() });
      toast("제출했어요!"); break;
    }
    case "edit-note": await save(`s1.findings.${S.uid}.submitted`, false); break;
    case "ask-coach": await aiGroup(2, "coach", d.focus === "link" ? { focus: "link", linkId: d.id } : { focus: "cause" }, `coach:${d.focus}:${d.id || ""}`); break;
    case "use-kept": { const c = panel.querySelector('[data-save="s3.chain.cause"]'); if (c) { c.value = d.t; c.dispatchEvent(new Event("input", { bubbles: true })); c.focus(); } break; }
    case "use-doubt": { const h = $("#ch-heard"); if (h) { h.value = d.t; $("#ch-q")?.focus(); } break; }
    case "add-check": {
      if (val("ch-heard").length < 3 || val("ch-q").length < 5) return toast("확인할 말과 확인 질문을 구체적으로 쓰세요.", true);
      if (MID() && !val("ch-fo")) return toast("이 말이 사실인지 의견인지 먼저 골라 주세요.", true);
      await addItem("s2.checks", { heard: val("ch-heard"), question: val("ch-q"), ...(MID() ? { fo: val("ch-fo") } : {}) });
      if (S.localPick) S.localPick["ch-fo"] = ""; render(true); break;
    }
    case "add-clink": {
      const from = val("cl-from"), to = val("cl-to"), rel = val("cl-rel");
      if (!from || !to) return;
      if (from === to) return toast("서로 다른 두 원인을 골라 이어 주세요.", true);
      if (list("s2.causeLinks").some((l) => l.from === from && l.to === to)) return toast("이미 이은 두 원인이에요.", true);
      await addItem("s2.causeLinks", { from, to, rel }); render(true); break;
    }
    case "add-link": {
      if (val("lk-src").length < 8) return toast("조금 더 구체적으로 써 주세요.", true);
      await addItem("s2.links", { prior: priorOf(), source: val("lk-src") }); render(true); break;
    }
    case "add-cause": { if (val("cz").length < 4) return toast("원인을 한 문장으로 쓰세요.", true); await addItem("s2.causes", { level: val("cz-lv"), text: val("cz") }); render(true); break; }
    case "ask-check": await aiGroup(3, "verify_query", { checkId: d.id }, "check:" + d.id); break;
    case "add-proposal": {
      const [who, what, how] = ["pt-who", "pt-what", "pt-how"].map(val);
      if (!who || !what || !how) return toast("누가, 무엇을, 어떻게를 모두 채워 주세요.", true);
      const t = `누가: ${who} / 무엇을: ${what} / 어떻게: ${how}`;
      if (t.length < 30) return toast("조금 더 자세히 써 주세요.", true);
      await addItem("s4.proposals", { text: t, cause: txt(w("s3.chain.cause")) }); render(true); break;
    }
    case "use-prop": { const c = panel.querySelector('[data-save="s4.final"]'); if (c) { c.value = d.t; c.dispatchEvent(new Event("input", { bubbles: true })); c.focus(); } break; }
    case "lk-start": { const c = $("#lk-src"); if (c) { c.value = d.t + " "; c.focus(); } break; }
    case "ask-feedback": // 조언이 도착하면 바로 조언 장면을 연다
      await aiGroup(4, "proposal_feedback", { proposalId: d.id }, "feedback");
      S.goScene = [4, "advice"]; render(true); break;
    case "add-pred": {
      if (val("pp").length < 10) return toast("예측과 이유를 10자 이상 쓰세요.", true);
      await addItem("s5.predictions", { stakeholder: val("ps"), text: val("pp") }); render(true); break;
    }
    case "round": S.round = Number(d.r); render(true); break;
    case "ask-scenario": await aiGroup(5, "scenario", { proposalId: "final", round: S.round }, "scenario"); break;
    case "pick-scn": setLocal(`s5.selection.${d.id}.idx`, Number(d.i)); render(true); await save(`s5.selection.${d.id}.idx`, Number(d.i)); break;
  }
});

// 저장 칸: 글은 입력이 멈추면, 선택·체크는 바로 저장한다
panel.addEventListener("input", (e) => {
  const el = e.target;
  if (el.id === "msg") { S.draft = el.value; return; }
  grow(el); updateCounts();
  const p = el.dataset?.save;
  if (p && el.type !== "checkbox" && el.tagName !== "SELECT") { queueSave(p, el.value); refreshFoot(); }
});
panel.addEventListener("change", (e) => {
  const el = e.target;
  const p = el.dataset?.save; if (!p) return;
  if (el.type === "checkbox") { setLocal(p, el.checked); save(p, el.checked); refreshFoot(); }
  else if (el.type === "radio") { setLocal(p, el.value); save(p, el.value); el.closest(".choices")?.querySelectorAll(".choice").forEach((c) => c.classList.toggle("on", c.contains(el))); refreshFoot(); }
  else if (el.tagName === "SELECT") { setLocal(p, el.value); save(p, el.value); refreshFoot(); }
  else flushSave(p);
});
// 추가 칸에서 Enter: 다음 칸으로 가거나(data-next) 바로 추가한다(data-enter). 한글 조합 중의 Enter는 무시한다.
panel.addEventListener("keydown", (e) => {
  const el = e.target;
  if (e.key !== "Enter" || e.isComposing || el.tagName !== "INPUT") return;
  if (el.dataset.enter) { e.preventDefault(); panel.querySelector(`[data-act="${el.dataset.enter}"]`)?.click(); }
  else if (el.dataset.next) { e.preventDefault(); document.getElementById(el.dataset.next)?.focus(); }
});
// 공용 칸에 들어가면 모둠원 화면에 '입력 중'을 표시하고, 나오면 지운다
const isShared = (p) => p && !p.startsWith("s1.findings.");
// 학생이 장면 안에서 무언가를 하면 그 장면에 머문다(마쳐도 저절로 넘어가지 않고 '다음'을 누른다)
const pinScene = () => { if (S.shown && !S.scene[S.stage]) S.scene[S.stage] = S.shown; };
panel.addEventListener("pointerdown", pinScene, true);
panel.addEventListener("focusin", (e) => {
  pinScene();
  const p = e.target.dataset?.save;
  if (isShared(p) && !/checkbox|radio/.test(e.target.type) && e.target.tagName !== "SELECT") save(`live.${S.uid}`, { path: p, nick: S.nick, t: Date.now() });
});
panel.addEventListener("focusout", (e) => {
  const p = e.target.dataset?.save;
  if (p) { flushSave(p); if (isShared(p)) save(`live.${S.uid}`, deleteField()); }
  setTimeout(runDeferred, 0);
});
