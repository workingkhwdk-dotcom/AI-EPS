import { auth, db, call, esc, toast, toastAction, errMsg } from "./fb.js";
import { waitHtml, startWaitTicker, STEPS } from "./wait.js";
import { showModal, confirmModal } from "./modal.js";
import { initTopics, loadTopics, topicClassTitle, topicReady } from "./topics.js";
import { runTour } from "./tour.js";
import { openAssess } from "./assess.js";
startWaitTicker();
import { GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, query, where, orderBy, onSnapshot, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const $ = (s) => document.querySelector(s);
const STAGE_NAMES = ["", "이야기 듣기", "원인 찾기", "사실 확인", "해결책 만들기", "미래 그려 보기", "실천 계획", "돌아보기"]; // 학생 화면과 같은 이름
const ONLINE_MS = 75 * 1000; // 학생 화면은 30초마다 접속 신호를 보낸다
const fmt = (ts) => (ts?.toDate ? ts.toDate().toLocaleString("ko-KR") : "");
// 외부(검색 결과 등)에서 온 주소는 http(s) 만 링크로 쓴다(javascript: 같은 주소 차단)
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "")) ? String(u) : "#");
const hasKeys = (o) => o && typeof o === "object" && Object.keys(o).length > 0;
const filled = (v) => (typeof v === "string" ? v.trim() !== "" : hasKeys(v));

let picked = new Set(), conduct = [], assigns = {}, current = null, curTitle = "", unsubs = [], members = [], groups = [], gFilter = "all";
let logsBy = {}, cmpStage = 1, workGid = null; // 모둠별 AI 기록, 단계별 모아 보기 단계, 열어 둔 모둠 산출물
let tickTimer = null;

// ---------- 로그인 ----------
// 휴대폰 브라우저가 팝업을 막으면 같은 창에서 구글 로그인으로 넘어갔다가 돌아온다.
// 단, 앱 안에서 열린 화면(카카오톡·네이버·인스타그램·Claude 앱 등)과 일부 iOS 브라우저는 넘어가는 동안 임시 저장소가 지워져
// "missing initial state" 오류가 나므로, 그런 곳에서는 넘어가지 않고 Safari·Chrome 에서 열도록 안내한다.
const inAppBrowser = () => /KAKAOTALK|NAVER|Instagram|FBAN|FBAV|Line\/|DaumApps|; wv\)|Claude/i.test(navigator.userAgent) ||
  (/iPhone|iPad|iPod/.test(navigator.userAgent) && !/Safari\//.test(navigator.userAgent));
const GUIDE = "이 화면에서는 구글 로그인이 되지 않아요. 오른쪽 위 메뉴에서 'Safari(또는 Chrome)로 열기'를 누르거나, 아래 이메일·비밀번호로 로그인하세요.";
const googleLogin = () => signInWithPopup(auth, new GoogleAuthProvider()).catch((e) => {
  if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment", "auth/cancelled-popup-request"].includes(e?.code)) {
    if (inAppBrowser()) return toast(GUIDE, true);
    return signInWithRedirect(auth, new GoogleAuthProvider());
  }
  if (e?.code === "auth/popup-closed-by-user") return;
  toast(errMsg(e), true);
});
// 구글 로그인 화면에서 돌아왔을 때 실패했다면 영어 오류 대신 안내 문구를 보여 준다
getRedirectResult(auth).catch((e) => toast(/initial state|storage/i.test(e?.message || "") ? GUIDE : errMsg(e), true));
$("#login-btn").onclick = googleLogin;
// 이메일·비밀번호 교사 계정(관리자가 만든 계정이나 교사용 계정 만들기에서 만든 계정)
$("#pw-form").onsubmit = async (e) => {
  e.preventDefault();
  const email = $("#pw-email").value.trim(), pass = $("#pw-pass").value;
  if (!email || !pass) { toast("이메일과 비밀번호를 입력하세요.", true); return; }
  const b = $("#pw-btn"); b.disabled = true;
  try { await signInWithEmailAndPassword(auth, email, pass); $("#pw-pass").value = ""; }
  catch (err) {
    const bad = ["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-email"].includes(err?.code);
    toast(bad ? "이메일 또는 비밀번호가 맞지 않습니다." : err?.code === "auth/too-many-requests" ? "여러 번 틀려 잠시 막혔습니다. 조금 뒤에 다시 시도하세요." : errMsg(err), true);
  } finally { b.disabled = false; }
};
$("#t-logout").onclick = () => signOut(auth).then(() => location.reload());

// 로그인 화면 ↔ 교사용 계정 만들기 화면. 주소에 #signup 이 있으면 계정 만들기부터 보여 준다.
// u 가 있으면(로그인했지만 아직 교사가 아닌 계정) 인증 문구 입력 칸만 보여 준다.
let wantSignup = location.hash === "#signup", signupOpen = true, busySignup = false;
function showAuth(view, u) {
  $("#main").classList.add("hidden");
  $("#login").classList.toggle("hidden", view !== "login");
  $("#signup").classList.toggle("hidden", view !== "signup");
  $("#su-new").classList.toggle("hidden", !!u);
  $("#su-approve").classList.toggle("hidden", !u);
  $("#to-login").classList.toggle("hidden", !!u);
  $("#su-who").textContent = u?.email || "";
  if (u && !signupOpen) $("#su-approve .desc").textContent = `${u.email} 계정은 교사로 등록되어 있지 않아요. 지금은 교사 가입을 받지 않으니 관리자에게 문의하세요.`;
}
const setHash = (h) => history.replaceState(null, "", h ? "#" + h : location.pathname + location.search);
$("#to-signup").onclick = () => { wantSignup = true; setHash("signup"); showAuth("signup", null); };
$("#to-login").onclick = () => { wantSignup = false; setHash(""); showAuth("login", null); };
$("#su-google").onclick = googleLogin;
$("#su-switch").onclick = () => { wantSignup = true; signOut(auth).then(() => showAuth("signup", null)); };

const signupError = (err) => ({
  "auth/email-already-in-use": "이미 있는 이메일이에요. 로그인 화면에서 그 계정으로 로그인한 뒤 인증 문구를 넣으세요.",
  "auth/invalid-email": "이메일 주소를 다시 확인하세요.",
  "auth/weak-password": "비밀번호가 너무 쉬워요. 8자 이상으로 더 길게 만들어 주세요.",
  "auth/operation-not-allowed": "이메일 가입이 꺼져 있어요. 구글 계정으로 가입하거나 관리자에게 문의하세요.",
}[err?.code] || errMsg(err));
// 이메일·비밀번호로 가입: 계정을 만들고 바로 인증 문구로 승인받는다. 문구가 틀리면 방금 만든 계정을 지운다.
$("#su-form").onsubmit = async (e) => {
  e.preventDefault();
  const email = $("#su-email").value.trim(), p1 = $("#su-pass").value, p2 = $("#su-pass2").value, code = $("#su-code").value.trim();
  if (!email) return toast("이메일을 입력하세요.", true);
  if (p1.length < 8) return toast("비밀번호는 8자 이상으로 만들어 주세요.", true);
  if (p1 !== p2) return toast("비밀번호 확인이 맞지 않아요.", true);
  if (!code) return toast("교사 인증 문구를 입력하세요.", true);
  const b = $("#su-btn"); b.disabled = true; busySignup = true;
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, p1);
    try { await call("registerTeacher")({ code }); }
    catch (err) { await cred.user.delete().catch(() => signOut(auth)); throw err; }
    $("#su-pass").value = $("#su-pass2").value = $("#su-code").value = "";
    busySignup = false; setHash("");
    toast("교사 계정이 만들어졌어요. 다음부터는 이 이메일과 비밀번호로 로그인하세요.");
    enterMain(auth.currentUser);
  } catch (err) {
    busySignup = false;
    toast(signupError(err), true);
    showAuth("signup", null);
  } finally { b.disabled = false; }
};
// 로그인은 했지만 교사가 아닌 계정(처음 쓰는 구글 계정 등): 인증 문구로 승인
$("#su-approve-btn").onclick = async () => {
  const code = $("#su-code2").value.trim();
  if (!code) return toast("교사 인증 문구를 입력하세요.", true);
  const b = $("#su-approve-btn"); b.disabled = true;
  try {
    await call("registerTeacher")({ code });
    $("#su-code2").value = ""; setHash("");
    toast("교사로 승인됐어요.");
    enterMain(auth.currentUser);
  } catch (err) { toast(errMsg(err), true); }
  finally { b.disabled = false; }
};

let listUnsub = null, entered = false;
function enterMain(u) {
  $("#login").classList.add("hidden"); $("#signup").classList.add("hidden");
  $("#main").classList.remove("hidden");
  $("#t-logout").classList.remove("hidden");
  $("#who").textContent = u.email || "";
  if (entered) return;
  entered = true;
  listSessions(u.uid); eventIds().forEach((id) => refreshCase(id).catch(() => {}));
  setTimeout(() => runTour("teacher-main", TOUR_MAIN), 700); // 처음 들어온 교사에게 화면 사용법(한 번만)
  loadTopics(); // 수업 만들기·점검의 사건 목록에 '내 주제'를 넣는다
}
onAuthStateChanged(auth, async (u) => {
  if (busySignup) return; // 이메일 가입 중에는 가입 처리가 화면을 정한다
  const ok = u && !u.isAnonymous;
  $("#t-logout").classList.toggle("hidden", !ok);
  $("#who").textContent = ok ? u.email : "";
  if (!ok) return showAuth(wantSignup ? "signup" : "login", null);
  // 로그인했어도 교사로 승인된 계정인지 서버에 묻는다. 아니면 인증 문구 입력으로.
  // 확인 자체가 안 되면(네트워크 등) 교사 화면을 보여 주고, 권한은 서버가 호출마다 다시 확인한다.
  let teacher = true;
  try { const r = (await call("teacherStatus")()).data || {}; teacher = r.teacher !== false; signupOpen = r.signupOpen !== false; } catch {}
  if (auth.currentUser?.uid !== u.uid) return; // 확인하는 사이 계정이 바뀌었다
  if (!teacher) return showAuth("signup", u);
  enterMain(u);
});

// ---------- 처음 쓰는 교사를 위한 사용법 안내(tour.js) ----------
// 교사 화면에 처음 들어올 때 한 번, 수업을 처음 열 때 한 번. 위쪽 '사용법 다시 보기'로 지금 화면의 안내를 다시 본다.
const GUIDE_LINK = `<a href="guide.html" target="_blank" rel="noopener">수업 흐름 · 중고 차이 안내</a>`;
const TOUR_MAIN = [
  { title: "AI-EPS 교사 화면에 오신 걸 환영해요", text: `<p>학생들이 실제 사회 갈등 사건 속 사람들을 AI 인물로 만나 7단계로 문제를 푸는 수업을 여기서 만들고 진행해요.</p><p>수업 전체 흐름과 중학교·고등학교 수업의 차이는 ${GUIDE_LINK}에 정리해 두었어요.</p>` },
  { el: "#tabs", title: "세 가지 작업", text: "<p><b>내 수업</b>: 수업을 만들고 진행해요.<br><b>내 주제</b>: 다루고 싶은 지역·사건으로 새 주제를 만들어요.<br><b>인물·자료 점검</b>: 인물의 근거와 출처를 수업 전에 확인해요.</p>" },
  { el: "#new-toggle", title: "수업 만들기", text: "<p>사건(주제)과 <b>학교급(중학교·고등학교)</b>, 모둠 수, 학생별 인물 질문 횟수를 정해 수업을 만들어요. 학교급에 따라 AI의 말 수준과 활동 구조가 달라져요.</p>" },
  { el: "#sessions", title: "내 수업 목록", text: "<p>만든 수업이 여기에 쌓여요. <b>열기</b>를 누르면 수업 코드와 진행 현황이 보여요. 중학교 수업에는 '중학교' 표시가 붙어요.</p>" },
  { el: "#t-help", title: "도움이 필요할 때", text: "<p>수업 흐름 안내는 언제든 새 창으로 열 수 있고, <b>사용법 다시 보기</b>로 지금 화면의 안내를 다시 볼 수 있어요.</p>" },
];
const TOUR_CLASS = [
  { el: ".code-row", title: "수업 코드", text: "<p>학생은 이 코드와 모둠 번호, 별명, 비밀번호로 입장해요. 옆의 QR이나 <b>크게 띄우기</b>로 화면에 띄워 알려 주세요.</p>" },
  { el: "#lobby", title: "수업 시작", text: "<p>학생들은 들어와서 대기실에서 기다려요. 모둠이 다 모이면 <b>수업 시작하기</b>를 눌러요.</p>" },
  { el: "#notice-card", title: "학생에게 한마디", text: "<p>\"5분 남았어요\" 같은 짧은 공지를 모든 모둠이나 한 모둠에게 보내요. 학생 화면 위쪽에 떠요.</p>" },
  { el: "#students", title: "학생과 모둠 진행", text: "<p>학생마다 지금 몇 단계인지, 질문을 몇 번 썼는지 보여요. 아래 <b>모둠 진행</b>에서 대화 기록과 AI 기록을 열어 볼 수 있어요. 문제가 생기면 위쪽 <b>확인이 필요해요</b>에 바로 나타나요.</p>" },
  { el: "#ctabs", title: "수업 메뉴", text: "<p><b>자료 관리</b>·<b>인물 편집</b>으로 이 수업만의 자료를 고치고, <b>평가</b>에서 척도표로 채점하고 세특을 쓰고 점수·세특을 따로 공개해요. <b>수업 설정</b>에서는 학교급과 <b>심화 활동</b>을 하나씩 켜고 꺼요.</p>" },
  { el: "#csv-btn", title: "기록 남기기와 닫기", text: "<p>수업이 끝나면 <b>기록 CSV</b>를 받아 두고, 위쪽 단추로 수업을 닫아요. 닫으면 학생이 더 쓸 수 없어요.</p>" },
];
$("#tour-btn").onclick = () => { const inClass = !$("#class-view").classList.contains("hidden"); runTour(inClass ? "teacher-class" : "teacher-main", inClass ? TOUR_CLASS : TOUR_MAIN, { force: true }); };

// ---------- 탭 ----------
function showTab(name) {
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  for (const t of ["classes", "topics", "check"]) $(`#tab-${t}`).classList.toggle("hidden", t !== name);
  if (name === "check") loadCheck($("#check-event").value);
  if (name === "topics") loadTopics();
}
$("#tabs").onclick = (e) => { const b = e.target.closest("[data-tab]"); if (b) showTab(b.dataset.tab); };

// 수업을 연 뒤의 세 가지 작업: 진행 현황 / 자료 관리 / 수업 설정
function showCTab(name) {
  document.querySelectorAll("#ctabs button").forEach((b) => b.classList.toggle("on", b.dataset.ctab === name));
  for (const t of ["live", "materials", "personas", "assess", "settings"]) $(`#cpane-${t}`).classList.toggle("hidden", t !== name);
  if (name === "materials") loadMats();
  if (name === "personas") loadPersonaEdit();
  if (name === "assess") openAssess(current);
  if (name === "settings") fillSettings();
}
$("#ctabs").onclick = (e) => { const b = e.target.closest("[data-ctab]"); if (b) showCTab(b.dataset.ctab); };

// ---------- 사건 고르기 ----------
// 사건 목록은 수업 만들기 칸의 <select id="t-event"> 에 있다. 점검 탭의 사건 고르기도 같은 목록을 쓴다.
// 내가 만든 주제는 'topic:<주제 ID>' 값으로 '내 주제' 묶음에 들어간다(수업에 쓸 수 있는 주제만).
const eventIds = () => [...$("#t-event").options].map((o) => o.value).filter((v) => !v.startsWith("topic:"));
const TOPIC = "topic:";
const caseArgs = (v) => (String(v).startsWith(TOPIC) ? { topicId: v.slice(TOPIC.length) } : { eventId: v });
$("#check-event").innerHTML = $("#t-event").innerHTML;
function setTopicOptions(list) {
  const ok = list.filter(topicReady);
  for (const sel of [$("#t-event"), $("#check-event")]) {
    const keep = sel.value;
    sel.querySelector("optgroup[data-topics]")?.remove();
    if (ok.length) {
      const g = document.createElement("optgroup");
      g.label = "내 주제"; g.dataset.topics = "1";
      g.innerHTML = ok.map((t) => `<option value="${TOPIC}${esc(t.id)}" data-title="${esc(topicClassTitle(t))}">${esc(t.title)}</option>`).join("");
      sel.appendChild(g);
    }
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
    if (sel === $("#t-event")) [...sel.options].forEach((o) => defaultTitles.add(o.dataset.title));
  }
}
// 내 주제 화면의 '이 주제로 수업 만들기': 수업 탭의 새 수업 칸을 그 주제로 열어 준다
initTopics({
  onList: setTopicOptions,
  onMakeClass: (t) => {
    showTab("classes"); closeSession(); toggleNew(true);
    $("#t-event").value = TOPIC + t.id;
    $("#t-title").value = topicClassTitle(t);
    // 중학교용으로 만든 주제면 학교급도 중학교로 맞춰 둔다(바꿀 수 있다)
    $("#t-level").value = t.input?.level === "middle" ? "middle" : "high"; $("#t-level").onchange();
    $("#new-form").scrollIntoView({ behavior: "smooth", block: "start" });
  },
});
$("#check-event").onchange = () => loadCheck($("#check-event").value);
// 사건을 바꾸면, 교사가 고치지 않은 수업 이름은 그 사건의 기본 이름으로 바꾼다
const defaultTitles = new Set([...$("#t-event").options].map((o) => o.dataset.title));
$("#t-event").onchange = () => {
  const o = $("#t-event").selectedOptions[0];
  if (!$("#t-title").value.trim() || defaultTitles.has($("#t-title").value)) $("#t-title").value = o.dataset.title;
};

// ---------- 수업 만들기·목록 ----------
const toggleNew = (open) => $("#new-form").classList.toggle("hidden", !open);
$("#new-toggle").onclick = () => toggleNew($("#new-form").classList.contains("hidden"));
$("#new-cancel").onclick = () => toggleNew(false);
$("#create-btn").onclick = async () => {
  const btn = $("#create-btn");
  btn.disabled = true;
  try {
    const title = $("#t-title").value;
    const ev = caseArgs($("#t-event").value);
    const { data } = await call("createSession")({ title, ...ev, groupCount: Number($("#t-groups").value), chatLimit: Number($("#t-chatlimit").value), level: $("#t-level").value });
    toast(`수업을 만들었습니다. 코드: ${data.code}`);
    toggleNew(false);
    openSession(data.code, title.trim() || "수업", ev.topicId);
  } catch (e) { toast(errMsg(e), true); }
  finally { btn.disabled = false; }
};

let sessionRows = [];
function listSessions(uid) {
  listUnsub?.();
  listUnsub = onSnapshot(query(collection(db, "sessions"), where("teacherUid", "==", uid)), (s) => {
    sessionRows = s.docs.map((d) => ({ code: d.id, ...d.data() })).sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    $("#sessions").innerHTML = sessionRows.map((r) =>
      `<div class="cell cls"><div class="grow"><b>${esc(r.title)}</b>${r.closed ? ` <span class="tag r">닫힘</span>` : r.started === false ? ` <span class="tag y">대기 중</span>` : ` <span class="tag">진행 중</span>`}${r.level === "middle" ? ` <span class="tag b">중학교</span>` : ""}<br><span class="meta-line"><span class="code">${r.code}</span> · ${r.groupCount}모둠 · ${fmt(r.createdAt)}</span></div><button class="btn btn-tinted btn-sm" data-code="${r.code}">열기</button></div>`
    ).join("") || `<div class="cell meta-line">아직 수업이 없어요. '＋ 새 수업 만들기'로 시작하세요.</div>`;
    if (current) {
      const cur = sessionRows.find((r) => r.code === current);
      if (cur) { curTitle = cur.title; $("#d-title").textContent = cur.title; renderOpen(); }
    }
  }, (e) => toast(errMsg(e), true));
}
$("#sessions").onclick = (e) => { const b = e.target.closest("[data-code]"); if (b) openSession(b.dataset.code); };
$("#back-btn").onclick = closeSession;

// ---------- 수업 현황 ----------
function progressOf(work) {
  const w = work || {};
  return [
    hasKeys(w.s1?.findings) || filled(w.s1?.problem?.hmw),
    hasKeys(w.s2?.checks),
    hasKeys(w.s3?.checks) || filled(w.s3?.chain?.cause),
    hasKeys(w.s4?.proposals) || filled(w.s4?.final),
    hasKeys(w.s5?.selection) || filled(w.s5?.newProblem),
    hasKeys(w.s6?.plan),
    filled(w.s7?.reflection) || filled(w.s7?.compare) || hasKeys(w.s7?.checks),
  ];
}

function openSession(code, title, topicId) {
  title = title || sessionRows.find((r) => r.code === code)?.title || "수업";
  // 내가 만든 주제의 수업이면 그 수업의 인물 이름을 따로 불러와 현황 표에 쓴다
  if (topicId || sessionRows.find((r) => r.code === code)?.topicId) call("getCase")({ code, admin: true }).then(({ data }) => { data.personas.forEach((p) => (personaLabels[p.id] = `${p.name} · ${p.label}`)); renderDash(); }).catch(() => {});
  current = code; curTitle = title; gFilter = "all"; conduct = []; logsBy = {}; workGid = null; mat.loaded = false; pe.loaded = false; assigns = {}; picked = new Set();
  unsubs.forEach((u) => u()); unsubs = [];
  clearInterval(tickTimer);
  $("#class-list-view").classList.add("hidden");
  $("#class-view").classList.remove("hidden");
  showCTab("live");
  $("#detail").classList.add("hidden");
  $("#d-title").textContent = title;
  $("#d-code").textContent = code;
  for (const k of Object.keys(changedAt)) delete changedAt[k];
  renderQr();
  renderOpen();
  setTimeout(() => runTour("teacher-class", TOUR_CLASS), 900); // 처음 연 수업에서 수업 화면 사용법(한 번만)
  piiBy = {};
  unsubs.push(onSnapshot(query(collection(db, `sessions/${code}/alerts`), orderBy("createdAt", "desc")), (s) => {
    const before = conduct.length;
    conduct = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (before && conduct.length > before) toast("⚠ 대화 규칙 위반 신호가 새로 들어왔습니다", true);
    renderDash();
  }));
  unsubs.push(onSnapshot(collection(db, `sessions/${code}/guardlog`), (s) => { piiBy = {}; s.docs.forEach((d) => { const x = d.data(); if ((x.pii || []).length) piiBy[x.uid] = (piiBy[x.uid] || 0) + 1; }); renderDash(); }));
  unsubs.push(onSnapshot(collection(db, `sessions/${code}/assign`), (s) => { assigns = Object.fromEntries(s.docs.map((d) => [d.id, d.data().personaId])); renderDash(); }));
  unsubs.push(onSnapshot(collection(db, `sessions/${code}/members`), (s) => { members = s.docs.map((d) => ({ uid: d.id, ...d.data() })); renderDash(); }));
  unsubs.push(onSnapshot(collection(db, `sessions/${code}/groups`), (s) => {
    groups = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => parseInt(a.id.slice(1)) - parseInt(b.id.slice(1)));
    for (const g of groups) {
      if (logsBy[g.id]) continue;
      logsBy[g.id] = [];
      unsubs.push(onSnapshot(query(collection(db, `sessions/${code}/groups/${g.id}/logs`), orderBy("createdAt")), (ls) => {
        logsBy[g.id] = ls.docs.map((d) => ({ id: d.id, ...d.data() }));
        renderWorkViews();
      }));
    }
    renderDash();
    renderWorkViews();
  }));
  tickTimer = setInterval(renderDash, 15000); // 접속 상태를 주기적으로 갱신
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function closeSession() {
  closePresent();
  unsubs.forEach((u) => u()); unsubs = [];
  clearInterval(tickTimer);
  current = null; members = []; groups = []; logsBy = {};
  $("#class-view").classList.add("hidden");
  $("#class-list-view").classList.remove("hidden");
  window.scrollTo({ top: 0 });
}

const isOnline = (m) => m.lastSeen?.toMillis && Date.now() - m.lastSeen.toMillis() < ONLINE_MS;
const ago = (m) => { const t = m.lastSeen?.toMillis?.(); if (!t) return "기록 없음"; const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}초 전` : s < 3600 ? `${Math.round(s / 60)}분 전` : `${Math.round(s / 3600)}시간 전`; };
const personaLabels = {}; // 인물 ID → 교사용 역할명 (getCase 로 채움)

// 현황 숫자 칸의 선 아이콘(24칸 기준)
const kpiSvg = (d) => `<svg class="kpi-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const KPI_ICON = {
  online: kpiSvg('<circle cx="12" cy="12" r="3"/><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4"/>'),
  people: kpiSvg('<circle cx="9" cy="8.5" r="3"/><path d="M3.5 20c0-3 2.5-5.5 5.5-5.5s5.5 2.5 5.5 5.5"/><circle cx="16.5" cy="9.5" r="2.3"/><path d="M16 14.6c2.6.3 4.5 2.5 4.5 5.1"/>'),
  ai: kpiSvg('<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V16A1.5 1.5 0 0 1 4 14.5z"/><path d="M8.5 9h7M8.5 12h4.5"/>'),
  guard: kpiSvg('<path d="M12 3l7 3v5.5c0 4.3-2.9 7.8-7 9.5-4.1-1.7-7-5.2-7-9.5V6z"/><path d="M12 8.5v4M12 15.5v.01"/>'),
  flag: kpiSvg('<path d="M5 21V4"/><path d="M5 4.5h11l-2 4 2 4H5"/>'),
  pause: kpiSvg('<circle cx="12" cy="12" r="8.5"/><path d="M10 9v6M14 9v6"/>'),
};
function renderDash() {
  if (!current) return;
  trackChanges();
  renderLobby();
  renderAlerts();
  renderPresent();
  renderNoticeCard();
  const online = members.filter(isOnline).length;
  const ai = members.reduce((n, m) => n + (m.aiCount || 0), 0); // 인물 대화 + 3~5단계
  const guard = groups.reduce((n, g) => n + (g.guardCount || 0), 0);
  const lockedN = members.filter((m) => m.chatLocked).length;
  $("#kpis").innerHTML = [["접속 중", `${online}명`, "", "online"], ["참여 학생", `${members.length}명`, "", "people"], ["AI 호출", `${ai}회`, "", "ai"], ["감독자 개입", `${guard}회`, "", "guard"],
    ["규칙 위반 신호", `${conduct.length}건`, conduct.length ? "warn" : "", "flag"], ["대화 멈춤", `${lockedN}명`, lockedN ? "warn" : "", "pause"]]
    .map(([k, v, c, ic]) => `<div class="kpi ${c || ""}">${KPI_ICON[ic]}<div><b>${v}</b><span>${k}</span></div></div>`).join("");

  // 규칙 위반 신호: 최근 것부터. 대화가 멈춘 학생은 다시 열 수 있다
  $("#conduct-card").classList.toggle("hidden", !conduct.length);
  $("#conduct-list").innerHTML = conduct.slice(0, 30).map((a) => {
    const m = members.find((x) => x.uid === a.uid);
    return `<div class="alert-row"><div class="grow">
      <div><span class="tag r">${esc(CONDUCT_LABELS[a.category] || a.category)}</span> <b>${esc(a.nickname)}</b> <span class="meta-line">· ${esc((a.groupId || "").replace("g", ""))}모둠 · ${esc(personaLabels[a.personaId] || "")} · ${fmt(a.createdAt)} · 경고 ${a.strikes}/3${a.by === "rule" ? " · 규칙 검사" : " · 감독자 판정"}</span></div>
      <div class="alert-msg">“${esc(a.input)}”</div></div>
      <div class="row"><button class="btn btn-tinted btn-sm" data-chat="${a.uid}">대화 보기</button>
      ${m?.chatLocked ? `<button class="btn btn-danger btn-sm" data-unlock="${a.uid}">대화 다시 열기</button>` : ""}</div></div>`;
  }).join("");

  $("#g-filter").innerHTML = [`<button class="chip sm ${gFilter === "all" ? "on" : ""}" data-g="all">전체</button>`,
    ...groups.map((g) => `<button class="chip sm ${gFilter === g.id ? "on" : ""}" data-g="${g.id}">${esc(g.name)}</button>`)].join("");

  const rows = members.filter((m) => gFilter === "all" || m.groupId === gFilter)
    .sort((a, b) => parseInt(a.groupId.slice(1)) - parseInt(b.groupId.slice(1)) || (a.nickname || "").localeCompare(b.nickname || ""));
  $("#students").innerHTML = rows.map((m) => `<tr>
    <td><input type="checkbox" data-pick="${m.uid}" ${picked.has(m.uid) ? "checked" : ""} aria-label="${esc(m.nickname)} 선택" style="width:18px;height:18px"></td>
    <td><b>${esc(m.nickname)}</b></td><td>${esc(m.groupId.replace("g", ""))}모둠</td>
    <td>${esc(personaLabels[assigns[m.uid] || m.personaId] || assigns[m.uid] || m.personaId || "")}</td>
    <td><span class="pill">${m.stage || 1}. ${STAGE_NAMES[m.stage || 1]}</span></td>
    <td><span class="dot ${isOnline(m) ? "on" : ""}"></span>${isOnline(m) ? "접속 중" : `자리 비움 · ${ago(m)}`}
      ${m.chatLocked ? ` <span class="tag r">대화 멈춤</span>` : m.conduct?.total ? ` <span class="tag y" title="누적 위반">⚠ ${m.conduct.total}</span>` : ""}</td>
    <td>${m.chatCount || 0} / ${curRow()?.chatLimit || 5}번</td>
    <td class="row" style="flex-wrap:nowrap"><button class="btn btn-tinted btn-sm" data-chat="${m.uid}">대화 보기</button><button class="btn btn-plain btn-sm" data-reset="${m.uid}" data-nick="${esc(m.nickname)}">비번 초기화</button><button class="btn btn-plain btn-sm" data-move="${m.uid}" data-nick="${esc(m.nickname)}" data-g="${esc(m.groupId)}">모둠 이동</button>${assigns[m.uid] || m.personaId ? `<button class="btn btn-plain btn-sm" data-unpick="${m.uid}" data-nick="${esc(m.nickname)}">인물 풀기</button>` : ""}</td></tr>`).join("");
  renderBulk();
  $("#no-students").textContent = rows.length ? "" : "아직 입장한 학생이 없어요. 위 수업 코드를 알려 주세요.";

  $("#groups").innerHTML = groups.map((g) => {
    const ms = members.filter((m) => m.groupId === g.id);
    const pr = progressOf(g.work);
    const cur = ms.length ? Math.max(...ms.map((m) => m.stage || 1)) : 0;
    const st = stuckMin(g);
    return `<tr><td><b>${esc(g.name)}</b>${st ? ` <span class="tag y" title="산출물·대화가 ${st}분째 그대로예요">${st}분째 그대로</span>` : ""}</td><td>${ms.length}명 <span class="meta-line">(접속 ${ms.filter(isOnline).length})</span></td>
      <td><span class="dots">${pr.map((f, i) => `<i class="${f ? "on" : ""} ${cur === i + 1 ? "cur" : ""}" title="${i + 1}단계 ${STAGE_NAMES[i + 1]}"></i>`).join("")}</span></td>
      <td>${g.aiCount || 0}회${g.lastAiError ? ` <span class="tag r" title="${esc(g.lastAiError.message)}">오류</span>` : ""}</td>
      <td>${g.guardCount || 0}회${g.conductCount ? ` <span class="tag r">위반 ${g.conductCount}</span>` : ""}</td>
      <td class="row" style="flex-wrap:nowrap"><button class="btn btn-tinted btn-sm" data-gwork="${g.id}">산출물</button><button class="btn btn-plain btn-sm" data-glog="${g.id}">AI 기록</button></td></tr>`;
  }).join("");
}

$("#g-filter").onclick = (e) => { const b = e.target.closest("[data-g]"); if (b) { gFilter = b.dataset.g; renderDash(); } };
$("#copy-btn").onclick = async () => { try { await navigator.clipboard.writeText(current); toast("코드를 복사했어요"); } catch { toast(`수업 코드: ${current}`); } };
$("#detail-close").onclick = () => { workGid = null; $("#detail").classList.add("hidden"); };

// ---------- 대화·기록 보기 ----------
function showDetail(title, html) {
  $("#detail-title").textContent = title;
  $("#detail-body").innerHTML = html;
  $("#detail").classList.remove("hidden");
  $("#detail").scrollIntoView({ behavior: "smooth", block: "start" });
}
const guardTag = (g) => (!g || g.ok ? "" : ` <span class="tag ${g.how === "fixed" ? "y" : "r"}">감독자 ${g.how === "fixed" ? "수정" : "대체"} · ${esc(g.category)}</span>`)
  + (g?.trimmed ? ` <span class="tag x" title="마지막의 되묻는 문장을 서버가 지움">되묻기 삭제</span>` : "");

// 인물이 웹에서 찾아 본 기록(검색어, 찾은 내용 요약, 출처)
const lookupHtml = (ls) => (ls || []).length ? `<details><summary class="meta-line">🔎 웹 검색 ${ls.length}회 (${ls.filter((x) => x.found).length}회 찾음)</summary>${ls.map((x) =>
  `<div class="meta-line" style="color:var(--ink);margin:4px 0">검색어: ${esc(x.query)}<br>${x.found ? `찾은 내용: ${esc(x.summary)}<br>${(x.sources || []).map((u) => `<a href="${esc(safeUrl(u.url))}" target="_blank" rel="noopener noreferrer">${esc(u.title)}</a>`).join(" · ")}` : "믿을 만한 자료를 찾지 못함 → 인물은 모른다고 답함"}</div>`).join("")}</details>` : "";

// 교사 전용 기록(감독자 판정·원래 응답·개인정보 표시). 예전 대화는 대화 문서 안에 guard 가 있어 그것도 받아 준다.
async function loadGuardLogs(uidFilter) {
  const snap = await getDocs(uidFilter ? query(collection(db, `sessions/${current}/guardlog`), where("uid", "==", uidFilter)) : collection(db, `sessions/${current}/guardlog`));
  return Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
}
const piiTag = (pii) => (pii || []).length ? ` <span class="tag r" title="학생이 입력에 개인정보를 적었습니다">개인정보 의심 · ${pii.map(esc).join(", ")}</span>` : "";

// 검색 교차 확인 결과(원문 대조 전 참고용)
const CROSS = { ok: ["", "교차 확인"], partial: ["y", "일부 확인"], fixed: ["b", "고쳐 씀"], todo: ["x", "확인 못 함"] };
const crossTag = (s) => s.crossCheck ? `<div class="meta-line" style="margin-top:2px"><span class="tag ${CROSS[s.crossCheck.status]?.[0] ?? "x"}">${CROSS[s.crossCheck.status]?.[1] || esc(s.crossCheck.status)}</span> ${esc(s.crossCheck.note)}</div>` : "";
const CONDUCT_LABELS = { mockery: "조롱·모욕", sexual: "성적 희롱" };

async function loadChat(uid) {
  workGid = null;
  const m = members.find((x) => x.uid === uid);
  const pid = assigns[uid] || m?.personaId;
  const [snap, glogs] = await Promise.all([getDocs(query(collection(db, `sessions/${current}/members/${uid}/chat`), orderBy("createdAt"))), loadGuardLogs(uid)]);
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const html = rows.map((l) => {
    const gl = glogs[l.id] || {};
    const g = gl.guard || l.guard;
    return `<div class="logline">
    <div class="q">학생 ${esc(l.input)}${piiTag(gl.pii)}${gl.conduct ? ` <span class="tag r">${esc(CONDUCT_LABELS[gl.conduct.category] || "규칙 위반")} · 경고 ${gl.conduct.strikes}/3 · ${gl.conduct.by === "rule" ? "규칙 검사" : "감독자 판정"}</span>` : ""}</div>
    <div class="a">${esc(m?.nickname || "")} ↔ ${esc(personaLabels[pid] || pid || "")}: ${esc(l.output)}${guardTag(g)}</div>
    ${lookupHtml(l.lookups)}
    ${g && (!g.ok || g.trimmed) ? `<details><summary class="meta-line">감독자 판정 보기</summary><div class="meta-line">사유: ${esc(g.reason)}<br>인물의 원래 응답: ${esc(g.original || "")}</div></details>` : ""}
    <div class="meta-line">${fmt(l.createdAt)} · ${esc(l.model)}</div></div>`;
  }).join("") || `<div class="meta-line">대화가 없습니다.</div>`;
  showDetail(`${m?.nickname || ""} · ${personaLabels[pid] || ""} 대화`, html);
}

const prettyLog = (l) => {
  let body = l.output;
  try {
    const j = JSON.parse(l.output);
    if (j.reviews) body = j.reviews.map((r) => `[${r.label}]\n${r.text}`).join("\n\n");
    else if (j.question) body = `[생각 도우미${j.kind ? ` · ${j.kind}` : ""}] ${j.question}`;
    else if (j.scenarios) body = j.scenarios.map((s) => `■ ${s.title}\n${s.story}\n작동 기제: ${s.mechanism || ""}`).join("\n\n");
  } catch {}
  return body;
};
async function loadGroupLogs(gid) {
  const snap = await getDocs(query(collection(db, `sessions/${current}/groups/${gid}/logs`), orderBy("createdAt")));
  const g = groups.find((x) => x.id === gid);
  const html = (g?.lastAiError ? `<div class="notice">최근 AI 오류 (${g.lastAiError.stage}단계): ${esc(g.lastAiError.message)}</div>` : "") +
    (snap.docs.map((d) => d.data()).map((l) => `<div class="logline"><div class="meta-line">${l.stage}단계 · ${esc(l.nickname)} · ${fmt(l.createdAt)} · ${esc(l.model)}</div>
      <div class="q">${esc(l.input)}</div><div class="a">${esc(prettyLog(l))}</div></div>`).join("") || `<div class="meta-line">2~5단계 AI 기록이 없습니다.</div>`);
  showDetail(`${g?.name || gid} 2~5단계 AI 기록`, html);
}
function renderBulk() {
  const n = picked.size;
  $("#bulk-reset").disabled = !n;
  $("#bulk-n").textContent = n ? `${n}명 선택됨` : "학생을 선택하면 한꺼번에 비번을 초기화할 수 있어요";
}
$("#students").onchange = (e) => {
  const c = e.target.closest("[data-pick]"); if (!c) return;
  c.checked ? picked.add(c.dataset.pick) : picked.delete(c.dataset.pick);
  renderBulk();
};
$("#stu-all").onchange = (e) => {
  document.querySelectorAll("#students [data-pick]").forEach((c) => { c.checked = e.target.checked; e.target.checked ? picked.add(c.dataset.pick) : picked.delete(c.dataset.pick); });
  renderBulk();
};
const PW_RESET_BODY = "<p>학생이 같은 별명으로 다시 입장하면서 새 비밀번호를 정해요. 하던 내용은 그대로 이어져요.</p>";
$("#bulk-reset").onclick = async () => {
  if (!picked.size || !(await confirmModal(`${picked.size}명의 비밀번호를 지울까요?`, PW_RESET_BODY, "비밀번호 지우기", "취소"))) return;
  try { const { data } = await call("resetStudentPassword")({ code: current, uids: [...picked] }); toast(`${data.count}명의 비밀번호를 초기화했습니다.`); picked.clear(); renderDash(); }
  catch (err) { toast(errMsg(err), true); }
};
$("#students").onclick = async (e) => {
  const up = e.target.closest("[data-unpick]");
  if (up) {
    if (!(await confirmModal("고른 인물을 풀까요?", `<p><b>${esc(up.dataset.nick)}</b> 학생이 고른 인물을 풀어 다시 고르게 합니다. 이 학생의 <b>대화 기록은 지워지고</b> 질문 횟수도 처음으로 돌아갑니다.</p>`, "풀기", "취소", true))) return;
    try { await call("resetPersonaChoice")({ code: current, uid: up.dataset.unpick }); toast(`'${up.dataset.nick}' 학생의 인물 선택을 풀었습니다.`); }
    catch (err) { toast(errMsg(err), true); }
    return;
  }
  const mv = e.target.closest("[data-move]");
  if (mv) return moveDialog(mv.dataset.move, mv.dataset.nick, mv.dataset.g);
  const r = e.target.closest("[data-reset]");
  if (r) {
    if (!(await confirmModal(`'${esc(r.dataset.nick)}' 학생의 비밀번호를 지울까요?`, PW_RESET_BODY, "비밀번호 지우기", "취소"))) return;
    try { await call("resetStudentPassword")({ code: current, uid: r.dataset.reset }); toast(`'${r.dataset.nick}' 비밀번호를 초기화했습니다.`); }
    catch (err) { toast(errMsg(err), true); }
    return;
  }
  const b = e.target.closest("[data-chat]"); if (b) loadChat(b.dataset.chat).catch((err) => toast(errMsg(err), true));
};
$("#conduct-list").onclick = async (e) => {
  const c = e.target.closest("[data-chat]"); if (c) return loadChat(c.dataset.chat).catch((err) => toast(errMsg(err), true));
  const u = e.target.closest("[data-unlock]"); if (!u) return;
  u.disabled = true;
  try { await call("unlockChat")({ code: current, uid: u.dataset.unlock }); toast("대화를 다시 열었습니다"); }
  catch (err) { toast(errMsg(err), true); u.disabled = false; }
};
$("#groups").onclick = (e) => {
  const w = e.target.closest("[data-gwork]");
  if (w) { workGid = w.dataset.gwork; renderWorkViews(); $("#detail").scrollIntoView({ behavior: "smooth", block: "start" }); return; }
  const b = e.target.closest("[data-glog]"); if (b) { workGid = null; loadGroupLogs(b.dataset.glog).catch((err) => toast(errMsg(err), true)); }
};

// CSV: 연구·평가 기록용. 엑셀에서 한글이 깨지지 않도록 BOM 포함
$("#csv-btn").onclick = async () => {
  const csvBtn = $("#csv-btn"); csvBtn.disabled = true; const label = csvBtn.textContent; csvBtn.textContent = "기록을 모으는 중…";
  try {
  const lines = [["구분", "모둠", "단계", "별명", "시각", "모델", "학생 입력", "AI 응답", "감독자 판정", "개인정보 의심", "웹 검색(검색어 | 찾음 | 출처)"]];
  const T = (l) => fmt(l.createdAt);
  const glogs = await loadGuardLogs();
  for (const m of members) {
    const s = await getDocs(query(collection(db, `sessions/${current}/members/${m.uid}/chat`), orderBy("createdAt")));
    s.docs.forEach((d) => {
      const l = d.data(), gl = glogs[d.id] || {}, g = gl.guard || l.guard;
      lines.push(["인물 대화", m.groupId, 1, m.nickname, T(l), l.model, l.input, l.output,
        g ? `${g.ok ? "통과" : g.how}:${g.category}:${g.original || ""}` : "", (gl.pii || []).join(" "),
        (l.lookups || []).map((x) => `${x.query} | ${x.found ? "찾음" : "못 찾음"} | ${(x.sources || []).map((u) => u.url).join(" ")}`).join("\n")]);
    });
  }
  for (const g of groups) {
    const s = await getDocs(query(collection(db, `sessions/${current}/groups/${g.id}/logs`), orderBy("createdAt")));
    s.docs.map((d) => d.data()).forEach((l) => lines.push(["모둠 AI", g.id, l.stage, l.nickname, T(l), l.model, l.input, l.output, "", "", ""]));
  }
  for (const g of groups) workRows(g).forEach(([st, item, by, text]) => lines.push(["모둠 산출물", g.id, st, by, "", "", item, text, "", "", ""]));
  const csv = lines.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  a.download = `ai-eps-${current}.csv`; a.click();
  } catch (e) { toast(errMsg(e), true); }
  finally { csvBtn.disabled = false; csvBtn.textContent = label; }
};

// ---------- 점검 (교사 전용) ----------
// 인물 ID → "이름 · 역할" 표를 채운다(수업 현황 화면에서 교사만 인물을 알아볼 수 있도록)
async function refreshCase(eventId) {
  const { data } = await call("getCase")(caseArgs(eventId));
  data.personas.forEach((p) => (personaLabels[p.id] = `${p.name} · ${p.label}`));
  renderDash();
  return data;
}
async function loadCheck(eventId) {
  try {
    const data = await refreshCase(eventId);
    $("#check-note").innerHTML = `<div class="notice muted">교사 메모: ${esc(data.event.teacherNote)}</div>
      <div class="notice muted"><b>모든 인물이 아는 사건 공통 배경</b> (인물은 자기 진술과 이 배경에 있는 핵심 사실만 말합니다)${(data.event.background || []).map((c) =>
        `<div style="margin-top:4px"><span class="tag ${c.kind === "주장" || c.kind === "의견" ? "y" : ""}">${esc(c.kind)}</span> ${esc(c.text)} <span class="tag ${c.verified ? "" : "x"}">${esc(c.src)}</span></div>`).join("")}</div>
      <div class="notice muted">인물 ${data.personas.length}명은 네 축(${esc((data.event.axes || []).join("·"))})으로 나뉩니다. 학생은 1단계에서 모든 인물의 편지를 읽고 모둠이 상의해 한 명씩 직접 고릅니다(모둠 안에서 겹치지 않고, ${esc(data.event.requiredAxis || "당사자")} 인물은 모둠에 꼭 한 명). 누가 누구를 골랐는지는 수업 현황의 '인물(교사용)' 열에서 봅니다. 잘못 골랐으면 그 줄의 '인물 풀기'로 다시 고르게 할 수 있습니다.</div>`;
    $("#persona-count").textContent = data.personas.length;
    $("#persona-check").innerHTML = data.personas.map((p) => {
      const ok = p.sources.every((s) => s.verified);
      return `<details class="fold"><summary><span><span class="tag b">${esc(p.axis || "")}</span> ${esc(p.name)} <span class="meta-line">· ${esc(p.label)}</span></span> <span class="tag ${ok ? "" : "y"}">${ok ? "원문 대조 완료" : "대조 필요"}</span></summary><div class="inner">
        <div class="meta-line">입장: ${esc(p.stance)}</div><div class="meta-line">설정: ${esc(p.setting)}</div><div class="meta-line">말투: ${esc(p.voice)}</div><div class="meta-line">융합 근거: ${esc(p.basis)}</div>
        <div style="margin-top:10px"><b>인물의 생각 (학생이 물으면 말하는 의견)</b>${(p.views || []).map((v) => `<div class="meta-line" style="color:var(--ink);margin-top:4px">· ${esc(v)}</div>`).join("")}</div>
        <details style="margin-top:10px"><summary><b>삶의 이야기·기억나는 장면 (창작)</b></summary>
          ${(p.story || []).map((v) => `<div class="meta-line" style="color:var(--ink);margin-top:4px">· ${esc(v)}</div>`).join("")}
          <div style="margin-top:8px"><b>기억나는 장면</b></div>${(p.episodes || []).map((v) => `<div class="meta-line" style="color:var(--ink);margin-top:4px">· ${esc(v)}</div>`).join("")}
          <div class="meta-line" style="margin-top:8px">마음속 고민: ${esc(p.inner || "")}</div><div class="meta-line">말버릇: ${esc(p.habits || "")}</div></details>
        ${(p.beliefs || []).length ? `<div class="notice yellow" style="margin-top:10px"><b>이 인물이 사실이라고 믿는 것 (틀리거나 과장일 수 있음)</b><div class="meta-line">학생이 다른 인물의 말·자료와 견주어 3단계에서 검증하도록 넣은 장치입니다.</div>${p.beliefs.map((b) => `<div style="margin-top:6px">· ${esc(b.text)}<div class="meta-line">실제: ${esc(b.note)}</div></div>`).join("")}</div>` : ""}
        ${(p.limits || []).length ? `<div class="notice yellow" style="margin-top:10px"><b>조심할 이야기</b>${p.limits.map((v) => `<div style="margin-top:4px">· ${esc(v)}</div>`).join("")}</div>` : ""}
        <div style="margin-top:10px"><b>학생에게 보이는 편지</b><div class="ai-out">${p.letter.map(esc).join("\n\n")}</div></div>
        <div style="margin-top:10px"><b>근거 진술</b>${p.claims.map((c) => `<div class="meta-line" style="color:var(--ink);margin-top:4px"><span class="tag ${c.kind === "주장" || c.kind === "의견" ? "y" : ""}">${esc(c.kind)}</span> ${esc(c.text)} <span class="tag x">${esc(c.src)}</span></div>`).join("")}</div>
        <div style="margin-top:10px"><b>출처 (원문을 열어 진술과 대조)</b>${p.sources.map((s) => `<div style="margin-top:8px"><span class="tag ${s.verified ? "" : "x"}">${s.id}</span>
          <a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a>${s.titleIsDescriptive ? ' <span class="meta-line">(제목은 설명 문구, 실제 제목 확인)</span>' : ""}
          <div class="meta-line">${esc(s.outlet)} · ${esc(s.date)}</div><div class="meta-line">확인할 것: ${esc(s.check)}</div>${crossTag(s)}</div>`).join("")}</div></div></details>`;
    }).join("");
    $("#material-check").innerHTML = data.materials.map((c) => `<details class="fold"><summary>${esc(c.title)} <span class="meta-line">· ${c.items.length}개</span></summary><div class="inner">
      ${c.items.map((it) => `<div class="logline"><span class="kind k-${esc(it.kind)}">${esc(it.kind)}</span> ${it.date ? `<b>${esc(it.date)}</b> ` : ""}${esc(it.text)}
        <div class="meta-line">${it.src.map((id) => `<span class="tag ${it.verified ? "" : "x"}">${id}</span>`).join(" ")} 학생에게 보이는 캡션: ${esc(it.caption)}${it.verified ? "" : " · 미검증"}</div></div>`).join("")}</div></details>`).join("");
    const srcList = (sources) => sources.map((s) => `<div style="margin-top:8px"><span class="tag ${s.verified ? "" : "x"}">${s.id}</span>
      <a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a>${s.titleIsDescriptive ? ' <span class="meta-line">(제목은 설명 문구, 실제 제목 확인)</span>' : ""}
      <div class="meta-line">${esc(s.outlet)} · ${esc(s.date)}</div><div class="meta-line">확인할 것: ${esc(s.check)}</div>${crossTag(s)}</div>`).join("");
    $("#case-check").innerHTML = (data.cases || []).map((c) => `<details class="fold"><summary><span>${esc(c.country)} <span class="meta-line">· ${esc(c.title)}</span></span> <span class="tag ${c.verified ? "" : "y"}">${c.verified ? "원문 대조 완료" : "대조 필요"}</span></summary><div class="inner">
      <div class="meta-line" style="color:var(--ink)"><b>무엇을 했나</b> ${esc(c.what)}</div>
      <div class="meta-line" style="color:var(--ink);margin-top:4px"><b>어떻게 되었나</b> ${esc(c.result)}</div>
      <div class="meta-line" style="margin-top:4px"><b>생각해 볼 점</b> ${esc(c.think)}</div>
      <div style="margin-top:10px"><b>출처</b>${srcList(c.sources)}</div></div></details>`).join("");
    $("#after-check").innerHTML = `<details class="fold"><summary>이후 전개 <span class="meta-line">· ${(data.aftermath || []).length}개</span></summary><div class="inner">
      ${(data.aftermath || []).map((it) => `<div class="logline"><span class="kind k-${esc(it.kind)}">${esc(it.kind)}</span> ${esc(it.text)}
        <div class="meta-line">${it.src.map((id) => `<span class="tag ${it.verified ? "" : "x"}">${id}</span>`).join(" ")} ${esc(it.caption)}${it.verified ? "" : " · 미검증"}</div></div>`).join("")}
      <div style="margin-top:10px"><b>출처</b>${srcList([...new Map((data.aftermath || []).flatMap((a) => a.sources).map((s) => [s.id, s])).values()])}</div></div></details>`;
  } catch (e) { $("#persona-check").innerHTML = `<div class="notice">${esc(errMsg(e))}</div>`; }
}

// ---------- 모둠 산출물 (학생이 적은 문제·원인·대안·시나리오·계획) ----------
const PROBLEM_CHECK_N = 5, REFLECT_N = 10;
const tx = (v) => (typeof v === "string" ? v.trim() : "");
const listOf = (x) => Object.entries(x || {}).map(([id, v]) => ({ id, ...(v && typeof v === "object" ? v : { text: v }) })).sort((a, b) => (a.t || 0) - (b.t || 0));
const countTrue = (o) => Object.values(o || {}).filter(Boolean).length;
const joinLines = (...xs) => xs.filter(([, v]) => tx(String(v ?? ""))).map(([k, v]) => (k ? `${k}: ${v}` : v)).join("\n");
const parse = (s) => { try { return JSON.parse(s); } catch { return {}; } };

// 단계별 산출물을 [{ title, rows: [[항목, 내용, 작성자]] }] 로 정리한다. 화면과 CSV가 함께 쓴다.
function stageSections(n, g) {
  const w = g.work || {}, logs = logsBy[g.id] || [];
  const ofStage = (k) => logs.filter((l) => l.stage === k);
  switch (n) {
    case 1: {
      const pb = w.s1?.problem || {};
      return [
        { title: "개인 제출 (모둠원이 만난 인물)", rows: listOf(w.s1?.findings).map((f) => [
          `${f.nick || "모둠원"} → ${f.persona || "인물"}${f.submitted === false ? " (수정 중·미제출)" : ""}`,
          joinLines(["대화 전 내 생각", f.prior], ["누구", f.who], ["힘든 것", f.hard], ["바라는 것", f.want], ["당연하게 여기는 것", f.premise], ["'어?' 했던 순간", f.surprise], ["기억에 남는 말", f.quote], ["정말 그럴까?", f.doubt], ["", f.text]), f.nick]) },
        { title: "모둠 문제 정의", rows: [
          ["같은 점", pb.common], ["서로 다르게 말한 것", pb.disputes], ["부딪히는 점", pb.conflict], ["부딪히는 가치", [pb.valueA, pb.valueB].filter(Boolean).join(" ↔ ")], ["가치를 함께 지키기 어려운 까닭", pb.valueWhy], ["문제 상황", pb.situation], ["우리가 풀 질문", pb.hmw],
          ["점검표", hasKeys(pb.checks) ? `${countTrue(pb.checks)} / ${PROBLEM_CHECK_N}` : ""]].filter(([, v]) => tx(v)) },
      ];
    }
    case 2: return [
      { title: "처음 내 생각 돌아보기", rows: listOf(w.s2?.links).map((r) => [r.angle || r.level || "연결", joinLines(
        ["처음 생각", r.prior], ["흔들린 순간", r.surprise], ["처음 생각의 이유", r.source], ["내 생활의 비슷한 순간", r.scene], ["더 알고 싶은 것", r.question],
        ["처지", r.situation], ["이어지는 점", r.point], ["확인 방법", r.confirm],
        ...ofStage(2).filter((l) => l.payload?.linkId === r.id).map((l) => ["생각 도우미", prettyLog(l)]), ["더 생각한 것", w.s2?.linkMore?.[r.id]]), r.nick]) },
      { title: "원인 추측", rows: [...listOf(w.s2?.causes).map((c) => [c.level || "원인", c.text, c.nick]),
        ...listOf(w.s2?.causeLinks).map((l) => ["원인 잇기", `${listOf(w.s2?.causes).find((x) => x.id === l.from)?.text || "(삭제됨)"} → ${l.rel || ""} → ${listOf(w.s2?.causes).find((x) => x.id === l.to)?.text || "(삭제됨)"}`, l.nick]),
        ...ofStage(2).filter((l) => l.payload?.focus === "cause").map((l) => ["생각 도우미", prettyLog(l), l.nickname])] },
      { title: "검증 질문", rows: listOf(w.s2?.checks).map((c) => [`확인할 말: ${c.heard || ""}`, joinLines(
        ["관련 원인 추측", c.causeId ? listOf(w.s2?.causes).find((x) => x.id === c.causeId)?.text || "(삭제됨)" : ""],
        ["사실·의견", c.fo], ["검증 질문", c.question], ["틀렸다면", c.refute], ["확인할 곳", c.look], ["확인할 자료", c.srcType], ["자료 비교", c.real]), c.nick]) },
    ];
    case 3: {
      const checks = listOf(w.s2?.checks);
      const ch = w.s3?.chain || {};
      return [
        { title: "검증 결과", rows: ofStage(3).map((l) => {
          const c = checks.find((x) => x.id === l.payload?.checkId), v = w.s3?.checks?.[l.id] || {};
          return [`질문: ${c?.question || l.input}`, joinLines(["판정", v.verdict], ["판정 근거", v.source], ["다른 자료", v.source2], ["자료를 만든 쪽", v.maker], ["AI 답 점검", v.reason], ["AI 답", l.output]), l.nickname];
        }) },
        { title: "원인 가설 점검", rows: listOf(w.s2?.causes).map((q) => [q.text, w.s3?.causes?.[q.id]?.status || "판단 안 함", q.nick]) },
        { title: "핵심 원인", rows: [["확인된 사실", ch.evidence], ["뜻하는 것", ch.meaning], ["핵심 원인", ch.cause], ["뿌리 따져 보기", ch.root]].filter(([, v]) => tx(v)) },
      ];
    }
    case 4: {
      const props = listOf(w.s4?.proposals);
      return [
        { title: "모둠 대안", rows: props.map((p) => ["대안", joinLines(["", p.text], ["겨냥하는 원인", p.cause], ["참고한 사례", p.ref], ["사례와 다른 점", p.transfer], ["얻는 것", w.s4?.trade?.[p.id]?.gain], ["포기하는 것", w.s4?.trade?.[p.id]?.cost]), p.nick]) },
        { title: "AI 검토와 모둠 판단", rows: ofStage(4).map((l) => {
          const p = props.find((x) => x.id === l.payload?.proposalId), d = w.s4?.decisions?.[l.id] || {};
          return [`검토 대상: ${(p?.text || l.input).slice(0, 60)}`, joinLines(["판단", d.choice], ["공통 지적", d.compare], ["이유", d.reason],
            ["AI 검토", (parse(l.output).reviews || []).map((r) => `[${r.label}] ${r.text}`).join("\n")]), l.nickname];
        }) },
        { title: "최종 대안", rows: [["앞세운 가치(견주기)", w.s4?.tradeValue], ["최종 대안", w.s4?.final], ["고른 이유", w.s4?.finalReason], ["문제 질문의 두 바람", w.s4?.finalFit], ["점검: 효과", w.s4?.check?.effect], ["점검: 힘들어지는 사람", w.s4?.check?.fair]].filter(([, v]) => tx(v)) },
      ];
    }
    case 5: return [
      { title: "이해관계자 반응 예측", rows: [...listOf(w.s5?.predictions).map((r) => [r.stakeholder, r.text, r.nick]), ...(tx(w.s5?.chain) ? [["연쇄 반응", w.s5.chain]] : [])] },
      { title: "시나리오와 모둠 판단", rows: ofStage(5).map((l) => {
        const sc = parse(l.output).scenarios || [], sel = w.s5?.selection?.[l.id] || {};
        return [`${l.payload?.proposalId === "final" ? "최종 대안" : "후보 대안"} · ${l.payload?.round}년 후`, joinLines(
          ["", sc.map((x, i) => `${sel.idx === i ? "✓ " : "· "}${x.title}`).join("\n")],
          ["고른 시나리오의 작동 기제", sc[sel.idx]?.mechanism], ["내 예측과 견주기", sel.vs], ["작동 기제 점검", sel.mech], ["고른 이유", sel.reason]), l.nickname];
      }) },
      { title: "예상되는 문제", rows: [["예상 문제", w.s5?.newProblem]].filter(([, v]) => tx(v)) },
    ];
    case 6: {
      const p = w.s6?.plan || {};
      return [{ title: p.type === "patch" ? "대안 보완안" : "행동 계획", rows: [["대상", p.target], ["내용", p.content], ["권한·제안 경로", p.authority], ["방법", p.method], ["기대 효과", p.effect], ["어려움과 대응", p.difficulty]].filter(([, v]) => tx(v)) }];
    }
    case 7: return [{ title: "돌아보기", rows: [["발표 정리", w.s7?.share], ["실제 전개와 비교", w.s7?.compare], ["달랐던 까닭", w.s7?.why], ["AI 활용 점검", hasKeys(w.s7?.checks) ? `${countTrue(w.s7.checks)} / ${REFLECT_N}` : ""], ["성찰", w.s7?.reflection]].filter(([, v]) => tx(v)) }];
  }
  return [];
}

function sectionsHtml(secs) {
  return secs.map((s) => `<div class="w-sec"><h4>${esc(s.title)}</h4>${s.rows.length
    ? s.rows.map(([k, v, by]) => `<div class="logline"><div class="q">${esc(k)}${by ? ` <span class="meta-line">· ${esc(by)}</span>` : ""}</div><div class="a">${esc(v || "")}</div></div>`).join("")
    : `<div class="meta-line">아직 없음</div>`}</div>`).join("");
}
function workRows(g) {
  const out = [];
  for (let n = 1; n <= 7; n++) for (const s of stageSections(n, g)) for (const [k, v, by] of s.rows) out.push([n, `${s.title} · ${k}`, by || "", v || ""]);
  return out;
}

function renderWorkViews() {
  if (!current) return;
  $("#cmp-stages").innerHTML = STAGE_NAMES.slice(1).map((nm, i) => `<button class="chip sm ${cmpStage === i + 1 ? "on" : ""}" data-cs="${i + 1}">${i + 1}. ${nm}</button>`).join("");
  $("#cmp-body").innerHTML = groups.map((g) => `<div class="cmp-g"><div class="cmp-h">${esc(g.name)}</div>${sectionsHtml(stageSections(cmpStage, g))}</div>`).join("")
    || `<div class="meta-line">모둠이 없습니다.</div>`;
  if (workGid) {
    const g = groups.find((x) => x.id === workGid); if (!g) return;
    $("#detail-title").textContent = `${g.name} 산출물 (실시간)`;
    $("#detail-body").innerHTML = STAGE_NAMES.slice(1).map((nm, i) => `<div class="w-stage"><div class="cmp-h">${i + 1}단계 ${nm}</div>${sectionsHtml(stageSections(i + 1, g))}</div>`).join("");
    $("#detail").classList.remove("hidden");
  }
}
$("#cmp-stages").onclick = (e) => { const b = e.target.closest("[data-cs]"); if (b) { cmpStage = Number(b.dataset.cs); renderWorkViews(); } };

// ---------- 자료 관리 (2단계 실제 사건 자료) ----------
// 분류(category) 안에 자료(item)가 있다. 추가·수정·삭제·순서 바꾸기는 바로 서버에 저장한다.
const KINDS = ["사실", "증언", "주장", "의견"];
const KIND_HELP = "사실·증언은 일어난 일, 주장·의견은 누군가의 생각입니다.";
const mat = { cats: [], isDefault: true, loaded: false, editItem: null, editCat: null };
const uid8 = () => Math.random().toString(36).slice(2, 8);
const catOf = (id) => mat.cats.find((c) => c.id === id);

async function loadMats(force = false) {
  if (mat.loaded && !force) return renderMats();
  $("#mat-body").innerHTML = `<div class="card">${waitHtml({ steps: STEPS.load })}</div>`;
  try {
    const { data } = await call("getMaterials")({ code: current });
    Object.assign(mat, { cats: data.categories, isDefault: data.isDefault, loaded: true, editItem: null, editCat: null });
    renderMats();
  } catch (e) { $("#mat-body").innerHTML = `<div class="notice">${esc(errMsg(e))}</div>`; }
}

// 서버에 저장하고, 서버가 정리한 목록(id 부여, 길이 제한)으로 화면을 맞춘다. 실패하면 서버의 값으로 되돌린다.
// undo: 바꾸기 전 목록. 주면 알림에 '되돌리기'가 붙고, 누르면 그 목록을 다시 저장한다.
async function saveMats(okMsg = "저장했습니다", undo = null) {
  try {
    const { data } = await call("saveMaterials")({ code: current, categories: mat.cats });
    Object.assign(mat, { cats: data.categories, isDefault: false, editItem: null, editCat: null });
    if (undo) toastAction(okMsg, "되돌리기", () => { mat.cats = undo; saveMats("되돌렸습니다"); }, 8000);
    else toast(okMsg);
  } catch (e) { toast(errMsg(e), true); await loadMats(true); return; }
  renderMats();
}
const matsCopy = () => JSON.parse(JSON.stringify(mat.cats));

const kindOptions = (sel) => KINDS.map((k) => `<option ${k === sel ? "selected" : ""}>${k}</option>`).join("");
function itemForm(c, it) {
  const isNew = !it;
  const v = it || { kind: "사실", date: "", text: "", caption: "" };
  const key = isNew ? `new:${c.id}` : `edit:${c.id}:${it.id}`;
  return `<div class="mform" data-form="${esc(key)}">
    <div class="two"><div><label class="lbl" style="margin-top:0">종류</label><select data-f="kind">${kindOptions(v.kind)}</select></div>
      ${c.type === "timeline" ? `<div><label class="lbl" style="margin-top:0">시점</label><input type="text" data-f="date" maxlength="24" placeholder="예) 2018. 6. 25." value="${esc(v.date)}" /></div>` : ""}</div>
    <label class="lbl">내용</label><textarea data-f="text" maxlength="600" placeholder="학생이 읽을 문장 (600자 이내)">${esc(v.text)}</textarea>
    <label class="lbl">출처</label><input type="text" data-f="caption" maxlength="80" placeholder="예) 한겨레 2018.7.3. (비우면 '선생님이 준비한 자료'로 표시)" value="${esc(v.caption)}" />
    <div class="meta-line" style="margin-top:6px">${KIND_HELP}</div>
    <div class="row" style="margin-top:10px"><button class="btn btn-primary btn-sm" data-m="${isNew ? "item-add" : "item-save"}" data-c="${esc(c.id)}" ${isNew ? "" : `data-i="${esc(it.id)}"`}>${isNew ? "추가" : "저장"}</button>
      ${isNew ? "" : `<button class="btn btn-plain btn-sm" data-m="item-cancel">취소</button>`}</div></div>`;
}
function catForm(c) {
  const isNew = !c;
  const v = c || { title: "", type: "list" };
  return `<div class="mform" data-form="${isNew ? "newcat" : "editcat:" + esc(c.id)}">
    <div class="two"><div><label class="lbl" style="margin-top:0">분류 이름</label><input type="text" data-f="title" maxlength="40" placeholder="예) 현지 주민의 목소리" value="${esc(v.title)}" /></div>
      <div><label class="lbl" style="margin-top:0">보여 주는 방식</label><select data-f="type"><option value="list" ${v.type === "list" ? "selected" : ""}>목록</option><option value="timeline" ${v.type === "timeline" ? "selected" : ""}>시간 순 흐름 (시점 입력)</option></select></div></div>
    <div class="row" style="margin-top:10px"><button class="btn btn-primary btn-sm" data-m="${isNew ? "cat-add" : "cat-save"}" ${isNew ? "" : `data-c="${esc(c.id)}"`}>${isNew ? "분류 만들기" : "저장"}</button>
      ${isNew ? "" : `<button class="btn btn-plain btn-sm" data-m="item-cancel">취소</button>`}</div></div>`;
}

function renderMats() {
  $("#mat-status").innerHTML = mat.isDefault
    ? `<div class="notice green">지금은 <b>기본 자료</b>(출처 원문 대조를 마친 자료)를 쓰고 있습니다. 아래에서 고치면 이 수업만의 자료가 됩니다.</div>`
    : `<div class="notice green row" style="justify-content:space-between"><span>이 수업만의 자료를 쓰고 있습니다.</span><button class="btn btn-plain btn-sm" data-m="reset">기본 자료로 되돌리기</button></div>`;
  const total = mat.cats.reduce((n, c) => n + c.items.length, 0);
  $("#mat-body").innerHTML = mat.cats.map((c, ci) => `<div class="card mcat">
      <div class="mcat-h"><h3>${esc(c.title)}</h3><span class="tag ${c.type === "timeline" ? "b" : "x"}">${c.type === "timeline" ? "시간 순" : "목록"}</span><span class="meta-line">${c.items.length}개</span>
        <button class="btn btn-plain btn-sm btn-ico" data-m="cat-up" data-c="${esc(c.id)}" ${ci === 0 ? "disabled" : ""} title="위로">▲</button><button class="btn btn-plain btn-sm btn-ico" data-m="cat-down" data-c="${esc(c.id)}" ${ci === mat.cats.length - 1 ? "disabled" : ""} title="아래로">▼</button>
        <button class="btn btn-tinted btn-sm" data-m="cat-edit" data-c="${esc(c.id)}">이름·방식 수정</button><button class="btn btn-danger btn-sm" data-m="cat-del" data-c="${esc(c.id)}">분류 삭제</button></div>
      ${mat.editCat === c.id ? catForm(c) : ""}
      ${c.stats?.length ? `<div class="mstats">${c.stats.map((s) => `<span class="tag x">${esc(s.label)} ${esc(s.value)}</span>`).join("")}</div><div class="meta-line" style="margin-bottom:6px">위 숫자 요약은 기본 자료의 것으로, 여기서는 고칠 수 없습니다.</div>` : ""}
      ${c.items.length ? c.items.map((it, ii) => mat.editItem === `${c.id}:${it.id}` ? itemForm(c, it) : `<div class="mitem">
        <div class="mbody"><span class="kind k-${esc(it.kind)}">${esc(it.kind)}</span> ${it.date ? `<span class="mdate">${esc(it.date)}</span>` : ""}${esc(it.text)}<div class="meta-line">${esc(it.caption || "출처 없음 (학생에게는 '선생님이 준비한 자료'로 표시)")}</div></div>
        <div class="mact"><button class="btn btn-plain btn-sm btn-ico" data-m="item-up" data-c="${esc(c.id)}" data-i="${esc(it.id)}" ${ii === 0 ? "disabled" : ""} title="위로">▲</button><button class="btn btn-plain btn-sm btn-ico" data-m="item-down" data-c="${esc(c.id)}" data-i="${esc(it.id)}" ${ii === c.items.length - 1 ? "disabled" : ""} title="아래로">▼</button>
          <button class="btn btn-tinted btn-sm" data-m="item-edit" data-c="${esc(c.id)}" data-i="${esc(it.id)}">수정</button><button class="btn btn-danger btn-sm" data-m="item-del" data-c="${esc(c.id)}" data-i="${esc(it.id)}">삭제</button></div></div>`).join("")
        : `<div class="meta-line">이 분류에는 아직 자료가 없습니다. 비어 있는 분류는 학생에게 보이지 않습니다.</div>`}
      <details class="fold" style="margin:10px 0 0;box-shadow:none;background:var(--fill)"><summary>＋ 이 분류에 자료 추가</summary><div class="inner">${itemForm(c, null)}</div></details>
    </div>`).join("") +
    `<div class="card"><h3>새 분류 만들기</h3><p class="desc">예) 전문가 의견, 언론 보도 비교, 다른 나라의 사례 …  (전체 ${total}개 자료, ${mat.cats.length}개 분류)</p>${catForm(null)}</div>`;
}

const formVals = (key) => {
  const f = [...document.querySelectorAll("#mat-body [data-form]")].find((x) => x.dataset.form === key);
  const o = {};
  f?.querySelectorAll("[data-f]").forEach((el) => { o[el.dataset.f] = el.value; });
  return o;
};
const swap = (arr, i, j) => { if (j < 0 || j >= arr.length) return false; [arr[i], arr[j]] = [arr[j], arr[i]]; return true; };

$("#cpane-materials").onclick = async (e) => {
  const b = e.target.closest("[data-m]"); if (!b) return;
  const act = b.dataset.m, c = catOf(b.dataset.c), id = b.dataset.i;
  const it = c?.items.find((x) => x.id === id);
  switch (act) {
    case "item-add": {
      const v = formVals(`new:${c.id}`);
      if (!(v.text || "").trim()) return toast("내용을 입력하세요.", true);
      c.items.push({ id: "m-" + uid8(), kind: v.kind, date: v.date || "", text: v.text, caption: v.caption || "" });
      return saveMats("자료를 추가했습니다");
    }
    case "item-edit": mat.editItem = `${c.id}:${id}`; mat.editCat = null; return renderMats();
    case "item-cancel": mat.editItem = null; mat.editCat = null; return renderMats();
    case "item-save": {
      const v = formVals(`edit:${c.id}:${id}`);
      if (!(v.text || "").trim()) return toast("내용을 입력하세요.", true);
      Object.assign(it, { kind: v.kind, date: v.date ?? it.date, text: v.text, caption: v.caption || "" });
      return saveMats("자료를 고쳤습니다");
    }
    case "item-del": {
      const before = matsCopy();
      c.items = c.items.filter((x) => x.id !== id);
      return saveMats("자료를 삭제했어요", before);
    }
    case "item-up": case "item-down": {
      const i = c.items.findIndex((x) => x.id === id);
      if (swap(c.items, i, act === "item-up" ? i - 1 : i + 1)) return saveMats("순서를 바꿨습니다");
      return;
    }
    case "cat-add": {
      const v = formVals("newcat");
      if (!(v.title || "").trim()) return toast("분류 이름을 입력하세요.", true);
      mat.cats.push({ id: "c-" + uid8(), title: v.title, type: v.type, items: [] });
      return saveMats("분류를 만들었습니다. 이제 자료를 추가하세요");
    }
    case "cat-edit": mat.editCat = c.id; mat.editItem = null; return renderMats();
    case "cat-save": {
      const v = formVals(`editcat:${c.id}`);
      if (!(v.title || "").trim()) return toast("분류 이름을 입력하세요.", true);
      Object.assign(c, { title: v.title, type: v.type });
      return saveMats("분류를 고쳤습니다");
    }
    case "cat-del": {
      const before = matsCopy();
      mat.cats = mat.cats.filter((x) => x.id !== c.id);
      return saveMats(`'${c.title}' 분류(자료 ${c.items.length}개)를 삭제했어요`, before);
    }
    case "cat-up": case "cat-down": {
      const i = mat.cats.findIndex((x) => x.id === c.id);
      if (swap(mat.cats, i, act === "cat-up" ? i - 1 : i + 1)) return saveMats("순서를 바꿨습니다");
      return;
    }
    case "reset": { // 고친 자료를 들고 있다가, '되돌리기'를 누르면 이 수업만의 자료로 다시 저장한다
      const before = matsCopy();
      try {
        const { data } = await call("resetMaterials")({ code: current });
        Object.assign(mat, { cats: data.categories, isDefault: true, editItem: null, editCat: null });
        toastAction("기본 자료로 바꿨어요", "되돌리기", () => { mat.cats = before; saveMats("고친 자료로 되돌렸습니다"); }, 8000);
        renderMats();
      } catch (err) { toast(errMsg(err), true); }
    }
  }
};

// ---------- 수업 설정 ----------
const curRow = () => sessionRows.find((r) => r.code === current);
function studentGuide() {
  const r = curRow();
  return `[AI-EPS 수업 입장 안내]\n주소: ${location.origin}/\n수업 코드: ${current}\n모둠 번호: 1~${r?.groupCount ?? ""}번 중 우리 모둠\n별명과 비밀번호(4자 이상)를 정해 입장하세요. 처음 정한 비밀번호를 기억해 두면 다시 들어와도 하던 것이 이어집니다. 끝나면 꼭 로그아웃하세요.`;
}
function fillSettings() {
  const r = curRow(); if (!r) return;
  $("#s-title").value = r.title;
  $("#s-groups").value = r.groupCount;
  $("#s-ailimit").value = r.aiLimit || 150;
  $("#s-chatlimit").value = r.chatLimit || 5;
  $("#s-web").value = r.webSearch === false ? "0" : "1";
  $("#s-coach").value = r.coach === false ? "0" : "1";
  $("#s-auto").value = String(r.autoCloseHours || 0);
  $("#s-level").value = r.level === "middle" ? "middle" : "high";
  renderDeep(r.deep || {});
  $("#s-topic-card").classList.toggle("hidden", !r.topicId);
  $("#s-guide").style.whiteSpace = "pre-wrap";
  $("#s-guide").textContent = studentGuide();
}
// ---------- 학교급과 심화 활동 (functions/level.js 와 같은 목록) ----------
// 학교급을 바꾸면 심화 활동 체크는 그 학교급의 기본값(고등학교 모두 켬, 중학교 모두 끔)으로 맞춘다. 그 뒤 하나씩 바꿀 수 있다.
const DEEP = [
  ["beliefs", "1단계 · 인물이 틀린 믿음을 맞는 사실과 섞어 그럴듯하게 말해요 (찾기 어렵게)"],
  ["premise", "1단계 · 인물이 당연하게 여기는 것(전제)과 부딪히는 가치 찾기"],
  ["causeMap", "2·3단계 · 원인끼리 잇기(인과 지도)와 뿌리가 되는 원인 따지기"],
  ["sources", "3단계 · 다른 자료로 한 번 더 확인하고, 자료를 만든 쪽 따지기"],
  ["tradeoff", "4단계 · 해결책 두 개를 얻는 것·포기하는 것으로 견주기, 사례를 옮길 때의 조건"],
  ["chain", "5단계 · 한 사람의 반응이 다른 사람에게 미치는 연쇄 예측"],
  ["power", "6단계 · 결정 권한이 있는 곳과 제안 경로 찾기"],
  ["why", "7단계 · 실제와 달랐던 까닭 분석"],
];
const LEVEL_NAMES = { high: "고등학교", middle: "중학교" };
const LEVEL_NOTE = {
  high: "AI가 고등학생 수준으로 말하고, 심화 활동이 모두 켜진 채로 시작해요(수업 설정에서 바꿀 수 있어요).",
  middle: "AI가 더 짧고 쉬운 말로 답해요. 원인 갈래 2개, 판정 3가지, 사실·의견 가르기, 해결책 점검, 1년 뒤 미래로 단순하게 진행하고, 심화 활동은 꺼진 채로 시작해요.",
};
function renderDeep(d) {
  $("#s-deep").innerHTML = DEEP.map(([k, label]) => `<label class="cell" style="cursor:pointer"><input type="checkbox" data-deep="${k}" ${d[k] === true ? "checked" : ""} style="width:20px;height:20px;margin-top:2px"><span class="grow">${esc(label)}</span></label>`).join("");
}
const deepNow = () => Object.fromEntries([...document.querySelectorAll("#s-deep [data-deep]")].map((el) => [el.dataset.deep, el.checked]));
$("#s-level").onchange = () => renderDeep(Object.fromEntries(DEEP.map(([k]) => [k, $("#s-level").value === "high"])));
$("#t-level").onchange = () => { $("#t-level-note").textContent = LEVEL_NOTE[$("#t-level").value]; };
$("#t-level-note").textContent = LEVEL_NOTE.high;

$("#s-save").onclick = async () => {
  try {
    const r = curRow(), level = $("#s-level").value, deep = deepNow();
    const changed = (r?.level === "middle" ? "middle" : "high") !== level || DEEP.some(([k]) => (r?.deep?.[k] === true) !== deep[k]);
    // 진행 중인 수업에서 학교급·심화 활동을 바꾸면 학생 화면의 칸이 바로 바뀐다. 이미 쓴 내용은 그대로 남는다.
    if (changed && r?.started !== false && !(await confirmModal("학교급·심화 활동을 바꿀까요?", "학생 화면의 활동 칸이 바로 바뀌어요. 이미 쓴 내용은 그대로 남지만, 새로 생긴 칸을 채워야 단계가 완료될 수 있어요.", "바꾸기", "취소"))) return;
    await call("updateSession")({
      code: current, title: $("#s-title").value, groupCount: Number($("#s-groups").value),
      aiLimit: Number($("#s-ailimit").value), chatLimit: Number($("#s-chatlimit").value), webSearch: $("#s-web").value === "1", coach: $("#s-coach").value === "1", autoCloseHours: Number($("#s-auto").value),
      level, deep,
    });
    toast("저장했습니다");
    setTimeout(fillSettings, 400);
  } catch (e) { toast(errMsg(e), true); }
};
$("#s-sync").onclick = async () => {
  if (!(await confirmModal("주제의 최신 내용으로 바꿀까요?", "내 주제에서 고친 인물·자료와 원문 확인 결과가 이 수업에 반영돼요. 이미 한 대화와 산출물은 그대로예요.", "바꾸기", "취소"))) return;
  const b = $("#s-sync"); b.disabled = true;
  try { await call("topics")({ action: "syncSession", code: current }); pe.loaded = false; mat.loaded = false; toast("최신 내용으로 바꿨어요"); }
  catch (e) { toast(errMsg(e), true); }
  finally { b.disabled = false; }
};
$("#s-copy-guide").onclick = async () => { try { await navigator.clipboard.writeText(studentGuide()); toast("안내문을 복사했어요"); } catch { toast("복사하지 못했습니다. 위 글을 직접 선택해 복사하세요.", true); } };
$("#s-delete").onclick = async () => {
  // 되돌릴 수 없으므로 수업 코드를 직접 쳐야 삭제 버튼이 눌린다
  const ok = await deleteDialog();
  if (!ok) return;
  try { await call("deleteSession")({ code: current }); toast("수업을 삭제했습니다"); closeSession(); }
  catch (e) { toast(errMsg(e), true); }
};

function deleteDialog() {
  const p = showModal({
    title: `'${esc(curTitle)}' 수업을 삭제할까요?`, dismissible: true,
    body: `<p>모둠 산출물, AI 기록, 학생 대화가 모두 지워지고 되돌릴 수 없어요. 필요하면 먼저 <button class="link" type="button" id="del-csv">기록 CSV</button>를 받아 두세요.</p>
      <label class="lbl" for="del-code">확인을 위해 수업 코드 <b>${esc(current)}</b>를 입력하세요</label>
      <input type="text" id="del-code" maxlength="10" autocomplete="off" autocapitalize="characters" spellcheck="false" />`,
    actions: [{ label: "삭제", value: true, kind: "btn-danger", disabled: true }, { label: "취소", value: false }],
  });
  const input = document.querySelector("#del-code"), btn = document.querySelector('.modal .btn-danger');
  input.oninput = () => { input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); btn.disabled = input.value !== current; };
  input.onkeydown = (e) => { if (e.key === "Enter" && !e.isComposing && !btn.disabled) btn.click(); };
  document.querySelector("#del-csv").onclick = () => $("#csv-btn").click();
  input.focus();
  return p.then((v) => v === true);
}

// ---------- 수업 열기/닫기 ----------
// 닫으면 새로 입장할 수도, 이미 들어와 있던 학생이 이어서 쓸 수도 없다(수업이 끝난 뒤 접속 차단). 언제든 다시 열 수 있다.
function renderOpen() {
  const r = sessionRows.find((x) => x.code === current);
  const closed = !!r?.closed;
  const b = $("#open-btn");
  b.textContent = closed ? "수업 열기" : "수업 닫기";
  b.className = "btn btn-sm " + (closed ? "btn-primary" : "btn-danger");
  const waiting = !closed && r?.started === false;
  $("#open-note").innerHTML = closed
    ? `<span class="tag r">닫힘</span> <span class="meta-line">학생 접속이 막혀 있어요</span>`
    : waiting
      ? `<span class="tag y">대기 중</span> <span class="meta-line">모두 들어오면 아래 '수업 시작하기'</span>`
      : `<span class="tag">진행 중</span> <span class="meta-line">끝나면 '수업 닫기'</span>`;
  renderLobby();
  renderNoticeCard();
}

// ---------- 대기실: 모두 들어왔는지 확인하고 수업 시작 ----------
function renderLobby() {
  const box = $("#lobby"); if (!box) return;
  const r = curRow();
  const waiting = !!r && r.started === false && !r.closed;
  box.classList.toggle("hidden", !waiting);
  if (!waiting) return;
  const online = members.filter(isOnline).length;
  $("#lobby-body").innerHTML = `<div class="lobby-kpi"><b>${members.length}명</b> 입장 · 접속 중 <b>${online}명</b></div>` +
    groups.map((g) => {
      const ms = members.filter((m) => m.groupId === g.id).sort((a, b) => (a.nickname || "").localeCompare(b.nickname || ""));
      return `<div class="lobby-g"><div class="lobby-gh"><b>${esc(g.name)}</b> <span class="meta-line">${ms.length}명</span></div><div class="lobby-ms">${ms.length
        ? ms.map((m) => `<span class="lobby-m"><i class="dot ${isOnline(m) ? "on" : ""}"></i>${esc(m.nickname)}<button type="button" class="lobby-mv" data-move="${esc(m.uid)}" data-nick="${esc(m.nickname)}" data-g="${esc(m.groupId)}" aria-label="${esc(m.nickname)} 학생 모둠 이동">이동</button></span>`).join("")
        : `<span class="meta-line">아직 없음</span>`}</div></div>`;
    }).join("");
  $("#start-btn").textContent = members.length ? `수업 시작하기 (${members.length}명)` : "수업 시작하기";
}
$("#lobby").onclick = (e) => { const mv = e.target.closest("[data-move]"); if (mv) moveDialog(mv.dataset.move, mv.dataset.nick, mv.dataset.g); };
$("#start-btn").onclick = async () => {
  const away = members.filter((m) => !isOnline(m)).length;
  const empty = groups.filter((g) => !members.some((m) => m.groupId === g.id)).length;
  const warn = [!members.length && "아직 입장한 학생이 없어요.", away && `접속이 끊긴 학생이 ${away}명 있어요.`, empty && members.length && `학생이 없는 모둠이 ${empty}개 있어요.`].filter(Boolean);
  const ok = await confirmModal("수업을 시작할까요?", `<p>시작하면 학생 화면이 바로 활동 화면으로 바뀌고, 되돌릴 수 없어요.</p>${warn.map((w) => `<p class="notice yellow">${esc(w)}</p>`).join("")}`, "수업 시작", "아직이요");
  if (!ok) return;
  try { await call("updateSession")({ code: current, started: true }); toast("수업을 시작했어요. 학생 화면이 바뀝니다."); }
  catch (err) { toast(errMsg(err), true); }
};

// 학생을 다른 모둠으로 옮긴다: 모둠 중에서 고른다. 인물·대화·개인 정리·비밀번호가 함께 옮겨지고, 학생 화면은 저절로 새 모둠으로 바뀐다.
async function moveDialog(uid, nick, fromId) {
  const to = await showModal({
    title: `${esc(nick)} 학생을 옮길 모둠`, dismissible: true, grid: true,
    body: `<p class="meta-line">지금은 ${esc(String(fromId).replace("g", ""))}모둠이에요. 인물·대화·비밀번호가 함께 옮겨져요.</p>`,
    actions: [...groups.map((g) => ({ label: `${esc(g.name)} <small>(${members.filter((m) => m.groupId === g.id).length}명)</small>`, value: g.id, kind: g.id === fromId ? "btn-tinted" : "btn-plain", disabled: g.id === fromId })), { label: "취소", value: null }],
  });
  if (!to) return;
  try { await call("moveStudent")({ code: current, uid, groupNo: parseInt(String(to).slice(1), 10) }); toast(`'${nick}' 학생을 ${to.replace("g", "")}모둠으로 옮겼습니다.`); }
  catch (err) { toast(errMsg(err), true); }
}
$("#open-btn").onclick = async () => {
  const closing = !sessionRows.find((x) => x.code === current)?.closed;
  if (closing) {
    // 닫기 전에 아직 남은 상황(접속 중인 학생, 7단계를 마치지 않은 모둠)을 보여 준다
    const online = members.filter(isOnline).length;
    const unfinished = groups.filter((g) => members.some((m) => m.groupId === g.id) && !filled(g.work?.s7?.share)).map((g) => g.name);
    const warn = [online && `지금 접속 중인 학생이 ${online}명 있어요.`, unfinished.length && `7단계 발표 준비를 아직 쓰지 않은 모둠: ${unfinished.join(", ")}`].filter(Boolean);
    const ok = await confirmModal("수업을 닫을까요?", `<p>학생이 더 이상 입장하거나 AI를 쓸 수 없어요. 기록은 남고, 언제든 다시 열 수 있어요.</p>${warn.map((w) => `<p class="notice yellow">${esc(w)}</p>`).join("")}`, "수업 닫기", "아직이요", true);
    if (!ok) return;
  }
  try { await call("updateSession")({ code: current, closed: closing }); toast(closing ? "수업을 닫았습니다" : "수업을 열었습니다"); }
  catch (e) { toast(errMsg(e), true); }
};

$("#s-clone").onclick = async () => {
  if (!(await confirmModal("이 수업을 복제할까요?", "<p>이름·모둠 수·설정과 고친 자료·인물을 가져와 새 수업 코드를 만들어요. 학생과 기록은 가져오지 않아요.</p>", "복제", "취소"))) return;
  try {
    const { data } = await call("cloneSession")({ code: current });
    toast(`복제했습니다. 새 코드: ${data.code}`);
    openSession(data.code, data.title);
  } catch (e) { toast(errMsg(e), true); }
};

// ---------- 확인이 필요해요 (수업 중 눈여겨볼 것) ----------
let piiBy = {}; // 학생 uid → 개인정보 의심 입력 수
const ALERT_AWAY_MIN = 10;
function renderAlerts() {
  const r = curRow(), lim = r?.aiLimit || 150, out = [];
  for (const g of groups) {
    if (g.lastAiError) out.push(["r", `${g.name}: AI 오류 (${g.lastAiError.stage}단계) — ${g.lastAiError.message}`]);
    if ((g.aiCount || 0) >= lim * 0.8) out.push(["y", `${g.name}: AI 사용 ${g.aiCount}/${lim}회 — 한도가 가깝습니다 (수업 설정에서 늘릴 수 있어요)`]);
    if ((g.guardCount || 0) >= 3) out.push(["y", `${g.name}: 감독자가 ${g.guardCount}번 개입했습니다 — 학생 질문을 확인해 보세요`]);
  }
  for (const g of groups) { const st = stuckMin(g); if (st) out.push(["y", `${g.name}: ${st}분째 산출물·대화가 그대로예요 — 막혔는지 살펴보세요`]); }
  for (const [uid, n] of Object.entries(piiBy)) {
    const m = members.find((x) => x.uid === uid);
    out.push(["r", `${m?.nickname || "학생"}: 개인정보로 보이는 입력 ${n}건 — 대화 보기에서 확인하고 안내해 주세요`]);
  }
  // 수업이 진행 중일 때(누군가 접속 중) 오래 자리를 비운 학생
  if (!r?.closed && r?.started !== false && members.some(isOnline)) {
    for (const m of members) {
      const t = m.lastSeen?.toMillis?.();
      if (t && !isOnline(m) && Date.now() - t > ALERT_AWAY_MIN * 60000 && (m.stage || 1) < 7) out.push(["x", `${m.nickname}: ${ago(m)}부터 접속이 없습니다 (${m.stage || 1}단계)`]);
    }
  }
  $("#alerts").classList.toggle("hidden", !out.length);
  $("#alerts-body").innerHTML = out.map(([k, t]) => `<div class="notice ${k === "r" ? "" : k === "y" ? "yellow" : "muted"}" style="margin-bottom:6px">${esc(t)}</div>`).join("");
}

// ---------- 인물 편집 ----------
const PERSONA_FIELDS = [
  ["letter", "편지 (학생이 처음 받는 글, 한 줄에 한 문단)", "list", 5],
  ["voice", "말투", "text", 3], ["habits", "말버릇", "text", 2], ["inner", "마음속 고민", "text", 3],
  ["story", "삶의 이야기 (한 줄에 하나)", "list", 6], ["episodes", "기억나는 장면 (한 줄에 하나)", "list", 6], ["views", "인물의 생각·의견 (한 줄에 하나)", "list", 6],
];
let pe = { personas: [], overrides: {}, loaded: false };
async function loadPersonaEdit() {
  if (pe.loaded) return renderPersonaEdit();
  $("#persona-edit").innerHTML = `<div class="card">${waitHtml({ steps: STEPS.load })}</div>`;
  try {
    const [c, o] = await Promise.all([call("getCase")(curRow()?.topicId ? { code: current, admin: true } : { eventId: curRow()?.eventId || "jeju2018" }), call("getPersonaOverrides")({ code: current })]);
    Object.assign(pe, { personas: c.data.personas, overrides: o.data.overrides, loaded: true });
    renderPersonaEdit();
  } catch (e) { $("#persona-edit").innerHTML = `<div class="notice">${esc(errMsg(e))}</div>`; }
}
const peValue = (p, k) => (pe.overrides[p.id]?.[k] ?? p[k]);
function renderPersonaEdit() {
  $("#persona-edit").innerHTML = pe.personas.map((p) => {
    const changed = Object.keys(pe.overrides[p.id] || {}).length;
    return `<details class="fold" data-pid="${esc(p.id)}"><summary><span><span class="tag b">${esc(p.axis || "")}</span> ${esc(p.name)} <span class="meta-line">· ${esc(p.label)}</span></span>${changed ? ` <span class="tag y">${changed}개 항목 고침</span>` : ""}</summary><div class="inner">
      ${PERSONA_FIELDS.map(([k, label, type, rows]) => `<label class="lbl">${label}</label><textarea data-pf="${k}" rows="${rows}" style="min-height:0">${esc(type === "list" ? (peValue(p, k) || []).join("\n") : peValue(p, k) || "")}</textarea>`).join("")}
      <div class="row" style="margin-top:12px"><button class="btn btn-primary btn-sm" data-pe="save" data-p="${esc(p.id)}">이 인물 저장</button>
        <button class="btn btn-plain btn-sm" data-pe="reset" data-p="${esc(p.id)}" ${changed ? "" : "disabled"}>원래대로 되돌리기</button></div></div></details>`;
  }).join("");
}
$("#cpane-personas").onclick = async (e) => {
  const b = e.target.closest("[data-pe]"); if (!b) return;
  const pid = b.dataset.p, box = b.closest("details");
  const open = [...document.querySelectorAll("#persona-edit details[open]")].map((d) => d.dataset.pid);
  try {
    if (b.dataset.pe === "save") {
      const fields = {};
      for (const [k, , type] of PERSONA_FIELDS) {
        const v = box.querySelector(`[data-pf="${k}"]`).value;
        fields[k] = type === "list" ? v.split("\n").map((x) => x.trim()).filter(Boolean) : v;
      }
      const { data } = await call("savePersonaOverride")({ code: current, personaId: pid, fields });
      pe.overrides = data.overrides; toast("저장했습니다. 이 수업의 새 대화부터 적용됩니다.");
    } else {
      const before = pe.overrides[pid];
      const { data } = await call("resetPersonaOverride")({ code: current, personaId: pid });
      pe.overrides = data.overrides;
      toastAction("원래 내용으로 바꿨어요", "되돌리기", async () => {
        try { const { data: d } = await call("savePersonaOverride")({ code: current, personaId: pid, fields: before }); pe.overrides = d.overrides; toast("고친 내용으로 되돌렸습니다."); }
        catch (err) { return toast(errMsg(err), true); }
        redrawPersonas(open);
      }, 8000);
    }
  } catch (err) { return toast(errMsg(err), true); }
  redrawPersonas(open);
};
// 다시 그려도 펼쳐 둔 인물은 펼친 채로
function redrawPersonas(open) {
  renderPersonaEdit();
  open.forEach((id) => document.querySelector(`#persona-edit details[data-pid="${id}"]`)?.setAttribute("open", ""));
}

// ---------- 수업 전 연결 점검 ----------
$("#health-btn").onclick = async () => {
  const btn = $("#health-btn"); btn.disabled = true;
  $("#health-out").innerHTML = waitHtml({ first: "서버와 AI에 연결해 보는 중이에요", steps: [[0, "서버와 AI에 연결해 보는 중이에요"], [10, "AI 모델이 응답하기를 기다리는 중이에요"], [30, "평소보다 오래 걸려요. 서버는 일하는 중이에요"]] });
  try {
    const { data: r } = await call("healthCheck")({});
    const row = (name, x, extra = "") => `<div class="cell"><span class="tag ${x.ok ? "" : "r"}">${x.ok ? "정상" : "실패"}</span><div class="grow"><b>${esc(name)}</b> <span class="meta-line">${x.ms}ms</span>${extra}${x.error ? `<div class="meta-line" style="color:var(--danger)">${esc(x.error)}</div>` : ""}</div></div>`;
    const off = (name) => `<div class="cell"><span class="tag x">꺼짐</span><div class="grow"><b>${esc(name)}</b> <span class="meta-line">PERSONA_WEB_SEARCH=false</span></div></div>`;
    const ts = r.topicSearch;
    $("#health-out").innerHTML = `<div class="group">${row("Firestore(서버 저장소)", r.firestore)}${r.models.map((m) => row(`AI 모델 ${m.model || ""}`, m,
      `${m.roles?.length ? `<div class="meta-line">쓰는 곳: ${esc(m.roles.join(", "))}</div>` : ""}${m.reply ? ` <span class="meta-line">응답: ${esc(m.reply)}</span>` : ""}`)).join("")}${
      !r.lookup ? "" : r.lookup.skipped ? off("인물의 사실 찾아보기") : row(`인물의 사실 찾아보기 ${r.lookup.model || ""}`, r.lookup, ` <span class="meta-line">도구를 쓰는 대화 경로</span>`)}${
      r.search.skipped ? off("웹 검색") : row(`웹 검색 ${r.search.model || ""}`, r.search, r.search.ok ? ` <span class="meta-line">${r.search.found ? `찾음 · 출처 ${r.search.sources}개` : "시험 질문의 답을 못 찾음"}</span>` : "")}${
      !ts ? "" : row(`내 주제 조사 ${ts.model || ""}`, ts, ts.ok ? ` <span class="meta-line">인용 링크 ${ts.cites}개${ts.cites ? "" : " · 인용이 붙지 않으면 주제 조사가 멈춰요"}</span>` : "")}</div>
      <div class="meta-line" style="margin-top:8px">사용 가능한 인물 ${r.config.personas}명 · 검색 허용 도메인 ${r.config.allowedDomains ? r.config.allowedDomains + "개" : "제한 없음"}</div>
      ${r.search.error ? `<div class="notice yellow" style="margin-top:8px">${esc(r.search.error)}</div>` : ""}`;
  } catch (e) { $("#health-out").innerHTML = `<div class="notice">${esc(errMsg(e))}</div>`; }
  finally { btn.disabled = false; }
};

// ---------- 입장 안내: QR·크게 띄우기 ----------
// QR 을 찍으면 수업 코드가 채워진 입장 화면이 열린다(학생은 모둠·별명·비밀번호만 쓰면 된다)
const joinUrl = () => `${location.origin}/?code=${current}`;
function qrSvg(text) {
  if (!window.qrcode) return "";
  const q = window.qrcode(0, "M"); q.addData(text); q.make();
  return q.createSvgTag({ cellSize: 4, margin: 8, scalable: true, title: "수업 입장 QR" });
}
function renderQr() {
  const svg = current ? qrSvg(joinUrl()) : "";
  $("#d-qr").innerHTML = svg;
  $("#d-qr").classList.toggle("hidden", !svg);
}
const presentOpen = () => !$("#present").classList.contains("hidden");
function openPresent() {
  $("#present").classList.remove("hidden");
  document.body.classList.add("presenting");
  renderPresent();
  $("#present-close").focus();
  document.documentElement.requestFullscreen?.().catch(() => {});
}
function closePresent() {
  if (!presentOpen()) return;
  $("#present").classList.add("hidden");
  document.body.classList.remove("presenting");
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  $("#present-btn")?.focus();
}
function renderPresent() {
  if (!presentOpen() || !current) return;
  const online = members.filter(isOnline).length;
  $("#p-title").textContent = curTitle;
  $("#p-url").textContent = `${location.host}/`;
  $("#p-code").textContent = current;
  if (!$("#p-qr").dataset.code || $("#p-qr").dataset.code !== current) { $("#p-qr").innerHTML = qrSvg(joinUrl()); $("#p-qr").dataset.code = current; }
  $("#p-count").innerHTML = `<b>${members.length}명</b> 입장${members.length ? ` · 접속 중 ${online}명` : ""}`;
}
$("#present-btn").onclick = openPresent;
$("#d-qr").onclick = openPresent;
$("#present-close").onclick = closePresent;
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && presentOpen()) closePresent(); });

// ---------- 학생에게 한마디 ----------
const QUICK_NOTICES = ["5분 남았어요", "잠깐 화면을 봐 주세요", "모둠끼리 이야기해 보세요", "다음 단계로 넘어가요"];
$("#n-quick").innerHTML = QUICK_NOTICES.map((t) => `<button class="chip sm" type="button" data-nq="${esc(t)}">${esc(t)}</button>`).join("");
// 빠른 문구는 칸에 채우기만 한다(눌러서 바로 나가는 실수를 막고, 고쳐서 보낼 수 있게)
$("#n-quick").onclick = (e) => { const b = e.target.closest("[data-nq]"); if (b) { $("#n-text").value = b.dataset.nq; $("#n-text").focus(); } };
function renderNoticeCard() {
  const sel = $("#n-target");
  const opts = `<option value="">모든 모둠</option>${groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join("")}`;
  if (sel.dataset.opts !== opts) { const keep = sel.value; sel.innerHTML = opts; sel.dataset.opts = opts; sel.value = groups.some((g) => g.id === keep) ? keep : ""; }
  const n = curRow()?.notice;
  const to = n?.groups?.length ? n.groups.map((g) => groups.find((x) => x.id === g)?.name || g).join(", ") : "모든 모둠";
  $("#n-cur").innerHTML = n?.text ? `<div class="notice muted n-now"><span>지금 학생 화면에 보이는 말 (${esc(to)}): <b>${esc(n.text)}</b></span><button class="link" type="button" id="n-clear">내리기</button></div>` : "";
}
async function sendNotice(text, groupsTo) {
  try {
    await call("updateSession")({ code: current, notice: { text, groups: groupsTo } });
    toast(text ? "학생 화면에 띄웠어요" : "내렸어요");
  } catch (e) { toast(errMsg(e), true); }
}
$("#n-send").onclick = async () => {
  const text = $("#n-text").value.trim();
  if (!text) { $("#n-text").focus(); return toast("보낼 말을 쓰세요.", true); }
  const g = $("#n-target").value;
  $("#n-send").disabled = true;
  await sendNotice(text, g ? [g] : []);
  $("#n-send").disabled = false;
  $("#n-text").value = "";
};
$("#n-text").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) $("#n-send").click(); });
$("#n-cur").onclick = (e) => { if (e.target.closest("#n-clear")) sendNotice("", []); };

// ---------- 오래 멈춘 모둠 ----------
// 모둠 산출물·AI 사용·인물 대화 수가 STUCK_MIN 분 넘게 그대로이면 표시한다(교사 화면을 연 뒤부터 센다).
const STUCK_MIN = 10;
const changedAt = {}; // 모둠 ID → { sig, t }
function trackChanges() {
  for (const g of groups) {
    const { live, ...work } = g.work || {};
    const chats = members.filter((m) => m.groupId === g.id).reduce((n, m) => n + (m.chatCount || 0), 0);
    const sig = `${JSON.stringify(work)}|${g.aiCount || 0}|${chats}`;
    if (changedAt[g.id]?.sig !== sig) changedAt[g.id] = { sig, t: Date.now() };
  }
}
function stuckMin(g) {
  const r = curRow(), c = changedAt[g.id];
  if (!c || !r || r.closed || r.started === false || filled(g.work?.s7?.share)) return 0;
  if (!members.some((m) => m.groupId === g.id && isOnline(m))) return 0; // 아무도 없는 모둠은 멈춘 것이 아니다
  const min = Math.floor((Date.now() - c.t) / 60000);
  return min >= STUCK_MIN ? min : 0;
}
