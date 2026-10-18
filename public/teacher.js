import { auth, db, call, esc, toast, errMsg } from "./fb.js";
import { waitHtml, startWaitTicker, STEPS } from "./wait.js";
import { showModal, confirmModal } from "./modal.js";
startWaitTicker();
import { GoogleAuthProvider, signInWithPopup, signInWithRedirect, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, query, where, orderBy, onSnapshot, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const $ = (s) => document.querySelector(s);
const STAGE_NAMES = ["", "사건 경험", "원인 탐색", "검증", "대안 구상", "미래 시나리오", "행동계획", "공유·성찰"];
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
// 휴대폰 브라우저가 팝업을 막으면 같은 창에서 구글 로그인으로 넘어갔다가 돌아온다
$("#login-btn").onclick = () => signInWithPopup(auth, new GoogleAuthProvider()).catch((e) => {
  if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment", "auth/cancelled-popup-request"].includes(e?.code)) return signInWithRedirect(auth, new GoogleAuthProvider());
  toast(errMsg(e), true);
});
$("#t-logout").onclick = () => signOut(auth).then(() => location.reload());
let listUnsub = null;
onAuthStateChanged(auth, (u) => {
  const ok = u && !u.isAnonymous;
  $("#login").classList.toggle("hidden", !!ok);
  $("#main").classList.toggle("hidden", !ok);
  $("#t-logout").classList.toggle("hidden", !ok);
  $("#who").textContent = ok ? u.email : "";
  if (ok) { listSessions(u.uid); eventIds().forEach((id) => refreshCase(id).catch(() => {})); }
});

// ---------- 탭 ----------
function showTab(name) {
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  for (const t of ["classes", "check"]) $(`#tab-${t}`).classList.toggle("hidden", t !== name);
  if (name === "check") loadCheck($("#check-event").value);
}
$("#tabs").onclick = (e) => { const b = e.target.closest("[data-tab]"); if (b) showTab(b.dataset.tab); };

// 수업을 연 뒤의 세 가지 작업: 진행 현황 / 자료 관리 / 수업 설정
function showCTab(name) {
  document.querySelectorAll("#ctabs button").forEach((b) => b.classList.toggle("on", b.dataset.ctab === name));
  for (const t of ["live", "materials", "personas", "settings"]) $(`#cpane-${t}`).classList.toggle("hidden", t !== name);
  if (name === "materials") loadMats();
  if (name === "personas") loadPersonaEdit();
  if (name === "settings") fillSettings();
}
$("#ctabs").onclick = (e) => { const b = e.target.closest("[data-ctab]"); if (b) showCTab(b.dataset.ctab); };

// ---------- 사건 고르기 ----------
// 사건 목록은 수업 만들기 칸의 <select id="t-event"> 에 있다. 점검 탭의 사건 고르기도 같은 목록을 쓴다.
const eventIds = () => [...$("#t-event").options].map((o) => o.value);
$("#check-event").innerHTML = $("#t-event").innerHTML;
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
    const { data } = await call("createSession")({ title, eventId: $("#t-event").value, groupCount: Number($("#t-groups").value), chatLimit: Number($("#t-chatlimit").value) });
    toast(`수업을 만들었습니다. 코드: ${data.code}`);
    toggleNew(false);
    openSession(data.code, title.trim() || "수업");
  } catch (e) { toast(errMsg(e), true); }
  finally { btn.disabled = false; }
};

let sessionRows = [];
function listSessions(uid) {
  listUnsub?.();
  listUnsub = onSnapshot(query(collection(db, "sessions"), where("teacherUid", "==", uid)), (s) => {
    sessionRows = s.docs.map((d) => ({ code: d.id, ...d.data() })).sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    $("#sessions").innerHTML = sessionRows.map((r) =>
      `<div class="cell cls"><div class="grow"><b>${esc(r.title)}</b>${r.closed ? ` <span class="tag r">닫힘</span>` : r.started === false ? ` <span class="tag y">대기 중</span>` : ` <span class="tag">진행 중</span>`}<br><span class="meta-line"><span class="code">${r.code}</span> · ${r.groupCount}모둠 · ${fmt(r.createdAt)}</span></div><button class="btn btn-tinted btn-sm" data-code="${r.code}">열기</button></div>`
    ).join("") || `<div class="cell meta-line">아직 만든 수업이 없습니다. 위의 '＋ 새 수업 만들기'로 시작하세요.</div>`;
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

function openSession(code, title) {
  title = title || sessionRows.find((r) => r.code === code)?.title || "수업";
  current = code; curTitle = title; gFilter = "all"; conduct = []; logsBy = {}; workGid = null; mat.loaded = false; pe.loaded = false; assigns = {}; picked = new Set();
  unsubs.forEach((u) => u()); unsubs = [];
  clearInterval(tickTimer);
  $("#class-list-view").classList.add("hidden");
  $("#class-view").classList.remove("hidden");
  showCTab("live");
  $("#detail").classList.add("hidden");
  $("#d-title").textContent = title;
  $("#d-code").textContent = code;
  renderOpen();
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

function renderDash() {
  if (!current) return;
  renderLobby();
  renderAlerts();
  const online = members.filter(isOnline).length;
  const ai = members.reduce((n, m) => n + (m.aiCount || 0), 0); // 인물 대화 + 3~5단계
  const guard = groups.reduce((n, g) => n + (g.guardCount || 0), 0);
  const lockedN = members.filter((m) => m.chatLocked).length;
  $("#kpis").innerHTML = [["접속 중", `${online}명`], ["참여 학생", `${members.length}명`], ["AI 호출", `${ai}회`], ["감독자 개입", `${guard}회`],
    ["규칙 위반 신호", `${conduct.length}건`, conduct.length ? "warn" : ""], ["대화 멈춤", `${lockedN}명`, lockedN ? "warn" : ""]]
    .map(([k, v, c]) => `<div class="kpi ${c || ""}"><b>${v}</b><span>${k}</span></div>`).join("");

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
  $("#no-students").textContent = rows.length ? "" : "아직 입장한 학생이 없습니다. 위의 수업 코드와 모둠 번호를 학생에게 알려 주세요.";

  $("#groups").innerHTML = groups.map((g) => {
    const ms = members.filter((m) => m.groupId === g.id);
    const pr = progressOf(g.work);
    const cur = ms.length ? Math.max(...ms.map((m) => m.stage || 1)) : 0;
    return `<tr><td><b>${esc(g.name)}</b></td><td>${ms.length}명 <span class="meta-line">(접속 ${ms.filter(isOnline).length})</span></td>
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
    else if (j.scenarios) body = j.scenarios.map((s) => `■ ${s.title}\n${s.story}\n작동 기제: ${s.mechanism || ""}`).join("\n\n");
  } catch {}
  return body;
};
async function loadGroupLogs(gid) {
  const snap = await getDocs(query(collection(db, `sessions/${current}/groups/${gid}/logs`), orderBy("createdAt")));
  const g = groups.find((x) => x.id === gid);
  const html = (g?.lastAiError ? `<div class="notice">최근 AI 오류 (${g.lastAiError.stage}단계): ${esc(g.lastAiError.message)}</div>` : "") +
    (snap.docs.map((d) => d.data()).map((l) => `<div class="logline"><div class="meta-line">${l.stage}단계 · ${esc(l.nickname)} · ${fmt(l.createdAt)} · ${esc(l.model)}</div>
      <div class="q">${esc(l.input)}</div><div class="a">${esc(prettyLog(l))}</div></div>`).join("") || `<div class="meta-line">3~5단계 AI 기록이 없습니다.</div>`);
  showDetail(`${g?.name || gid} 3~5단계 AI 기록`, html);
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
$("#bulk-reset").onclick = async () => {
  if (!picked.size || !confirm(`선택한 ${picked.size}명의 비밀번호를 지울까요?\n각 학생이 같은 별명으로 다시 입장하면서 새 비밀번호를 정합니다. 하던 내용은 그대로 이어집니다.`)) return;
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
    if (!confirm(`'${r.dataset.nick}' 학생의 비밀번호를 지울까요?\n학생이 같은 별명으로 다시 입장하면서 새 비밀번호를 정합니다. 하던 내용은 그대로 이어집니다.`)) return;
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
  const { data } = await call("getCase")({ eventId });
  data.personas.forEach((p) => (personaLabels[p.id] = `${p.name} · ${p.label}`));
  renderDash();
  return data;
}
async function loadCheck(eventId) {
  try {
    const data = await refreshCase(eventId);
    $("#check-mode").innerHTML = data.allowUnverified ? `<div class="notice yellow">리허설 모드: 원문 대조 전 인물·자료도 학생에게 보입니다 (ALLOW_UNVERIFIED_PERSONAS=true). 실제 수업 전에는 false로 바꾸세요.</div>` : "";
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
          joinLines(["누구", f.who], ["힘든 것", f.hard], ["바라는 것", f.want], ["기억에 남는 말", f.quote], ["확인할 말", f.doubt], ["", f.text]), f.nick]) },
        { title: "모둠 문제 정의", rows: [
          ["같은 점", pb.common], ["부딪히는 점", pb.conflict], ["문제 상황", pb.situation], ["우리가 풀 질문", pb.hmw],
          ["점검표", hasKeys(pb.checks) ? `${countTrue(pb.checks)} / ${PROBLEM_CHECK_N}` : ""]].filter(([, v]) => tx(v)) },
      ];
    }
    case 2: return [
      { title: "나·우리와의 연결고리", rows: listOf(w.s2?.links).map((r) => [r.level, joinLines(["처지", r.situation], ["이어지는 점", r.point], ["확인 방법", r.confirm]), r.nick]) },
      { title: "원인 가설", rows: listOf(w.s2?.causes).map((c) => [c.level || "원인", c.text, c.nick]) },
      { title: "검증 질문", rows: listOf(w.s2?.checks).map((c) => [`확인할 말: ${c.heard || ""}`, joinLines(
        ["관련 원인 가설", c.causeId ? listOf(w.s2?.causes).find((x) => x.id === c.causeId)?.text || "(삭제됨)" : ""],
        ["검증 질문", c.question], ["확인할 자료", c.srcType], ["자료 비교", c.real]), c.nick]) },
    ];
    case 3: {
      const checks = listOf(w.s2?.checks);
      const ch = w.s3?.chain || {};
      return [
        { title: "검증 결과", rows: ofStage(3).map((l) => {
          const c = checks.find((x) => x.id === l.payload?.checkId), v = w.s3?.checks?.[l.id] || {};
          return [`질문: ${c?.question || l.input}`, joinLines(["판정", v.verdict], ["판정 근거", v.source], ["AI 답 점검", v.reason], ["AI 답", l.output]), l.nickname];
        }) },
        { title: "원인 가설 점검", rows: listOf(w.s2?.causes).map((q) => [q.text, w.s3?.causes?.[q.id]?.status || "판단 안 함", q.nick]) },
        { title: "핵심 원인", rows: [["확인된 사실", ch.evidence], ["뜻하는 것", ch.meaning], ["핵심 원인", ch.cause]].filter(([, v]) => tx(v)) },
      ];
    }
    case 4: {
      const props = listOf(w.s4?.proposals);
      return [
        { title: "모둠 대안", rows: props.map((p) => ["대안", joinLines(["", p.text], ["겨냥하는 원인", p.cause], ["참고한 사례", p.ref]), p.nick]) },
        { title: "AI 검토와 모둠 판단", rows: ofStage(4).map((l) => {
          const p = props.find((x) => x.id === l.payload?.proposalId), d = w.s4?.decisions?.[l.id] || {};
          return [`검토 대상: ${(p?.text || l.input).slice(0, 60)}`, joinLines(["판단", d.choice], ["공통 지적", d.compare], ["이유", d.reason],
            ["AI 검토", (parse(l.output).reviews || []).map((r) => `[${r.label}] ${r.text}`).join("\n")]), l.nickname];
        }) },
        { title: "최종 대안", rows: [["최종 대안", w.s4?.final], ["고른 이유", w.s4?.finalReason], ["문제 질문의 두 바람", w.s4?.finalFit]].filter(([, v]) => tx(v)) },
      ];
    }
    case 5: return [
      { title: "이해관계자 반응 예측", rows: listOf(w.s5?.predictions).map((r) => [r.stakeholder, r.text, r.nick]) },
      { title: "시나리오와 모둠 판단", rows: ofStage(5).map((l) => {
        const sc = parse(l.output).scenarios || [], sel = w.s5?.selection?.[l.id] || {};
        return [`${l.payload?.proposalId === "final" ? "최종 대안" : "후보 대안"} · ${l.payload?.round}년 후`, joinLines(
          ["", sc.map((x, i) => `${sel.idx === i ? "✓ " : "· "}${x.title}`).join("\n")],
          ["고른 시나리오의 작동 기제", sc[sel.idx]?.mechanism], ["작동 기제 점검", sel.mech], ["고른 이유", sel.reason]), l.nickname];
      }) },
      { title: "예상되는 문제", rows: [["예상 문제", w.s5?.newProblem]].filter(([, v]) => tx(v)) },
    ];
    case 6: {
      const p = w.s6?.plan || {};
      return [{ title: p.type === "patch" ? "대안 보완안" : "행동 계획", rows: [["대상", p.target], ["내용", p.content], ["방법", p.method], ["기대 효과", p.effect], ["어려움과 대응", p.difficulty]].filter(([, v]) => tx(v)) }];
    }
    case 7: return [{ title: "공유·성찰", rows: [["발표 정리", w.s7?.share], ["실제 전개와 비교", w.s7?.compare], ["AI 활용 점검", hasKeys(w.s7?.checks) ? `${countTrue(w.s7.checks)} / ${REFLECT_N}` : ""], ["성찰", w.s7?.reflection]].filter(([, v]) => tx(v)) }];
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
async function saveMats(okMsg = "저장했습니다") {
  try {
    const { data } = await call("saveMaterials")({ code: current, categories: mat.cats });
    Object.assign(mat, { cats: data.categories, isDefault: false, editItem: null, editCat: null });
    toast(okMsg);
  } catch (e) { toast(errMsg(e), true); await loadMats(true); return; }
  renderMats();
}

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
    case "item-del":
      if (!confirm("이 자료를 삭제할까요? 학생 화면에서도 사라집니다.")) return;
      c.items = c.items.filter((x) => x.id !== id);
      return saveMats("자료를 삭제했습니다");
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
    case "cat-del":
      if (!confirm(`'${c.title}' 분류와 안의 자료 ${c.items.length}개를 모두 삭제할까요?`)) return;
      mat.cats = mat.cats.filter((x) => x.id !== c.id);
      return saveMats("분류를 삭제했습니다");
    case "cat-up": case "cat-down": {
      const i = mat.cats.findIndex((x) => x.id === c.id);
      if (swap(mat.cats, i, act === "cat-up" ? i - 1 : i + 1)) return saveMats("순서를 바꿨습니다");
      return;
    }
    case "reset":
      if (!confirm("이 수업에서 고친 자료를 모두 버리고 기본 자료로 되돌릴까요? 되돌릴 수 없습니다.")) return;
      try {
        const { data } = await call("resetMaterials")({ code: current });
        Object.assign(mat, { cats: data.categories, isDefault: true, editItem: null, editCat: null });
        toast("기본 자료로 되돌렸습니다"); renderMats();
      } catch (err) { toast(errMsg(err), true); }
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
  $("#s-auto").value = String(r.autoCloseHours || 0);
  $("#s-guide").style.whiteSpace = "pre-wrap";
  $("#s-guide").textContent = studentGuide();
}
$("#s-save").onclick = async () => {
  try {
    await call("updateSession")({
      code: current, title: $("#s-title").value, groupCount: Number($("#s-groups").value),
      aiLimit: Number($("#s-ailimit").value), chatLimit: Number($("#s-chatlimit").value), webSearch: $("#s-web").value === "1", autoCloseHours: Number($("#s-auto").value),
    });
    toast("저장했습니다");
    setTimeout(fillSettings, 400);
  } catch (e) { toast(errMsg(e), true); }
};
$("#s-copy-guide").onclick = async () => { try { await navigator.clipboard.writeText(studentGuide()); toast("안내문을 복사했어요"); } catch { toast("복사하지 못했습니다. 위 글을 직접 선택해 복사하세요.", true); } };
$("#s-delete").onclick = async () => {
  const typed = prompt(`'${curTitle}' 수업을 삭제합니다. 모든 기록이 지워지고 되돌릴 수 없습니다.\n계속하려면 수업 코드(${current})를 입력하세요.`);
  if (typed === null) return;
  if (typed.trim().toUpperCase() !== current) return toast("수업 코드가 맞지 않아 삭제하지 않았습니다.", true);
  try { await call("deleteSession")({ code: current }); toast("수업을 삭제했습니다"); closeSession(); }
  catch (e) { toast(errMsg(e), true); }
};

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
    ? `<span class="tag r">닫힘</span> <span class="meta-line">학생은 입장할 수 없고, 들어와 있던 학생도 더 쓸 수 없습니다.</span>`
    : waiting
      ? `<span class="tag y">대기 중</span> <span class="meta-line">학생이 모두 들어오면 아래 '수업 시작하기'를 누르세요.</span>`
      : `<span class="tag">진행 중</span> <span class="meta-line">수업이 끝나면 '수업 닫기'를 눌러 추가 접속을 막으세요.</span>`;
  renderLobby();
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
    body: `<p class="meta-line">지금은 ${esc(String(fromId).replace("g", ""))}모둠이에요. 인물·대화·개인 정리·비밀번호가 함께 옮겨지고, 학생 화면은 새 모둠으로 저절로 바뀝니다.</p>`,
    actions: [...groups.map((g) => ({ label: `${esc(g.name)} <small>(${members.filter((m) => m.groupId === g.id).length}명)</small>`, value: g.id, kind: g.id === fromId ? "btn-tinted" : "btn-plain", disabled: g.id === fromId })), { label: "취소", value: null }],
  });
  if (!to) return;
  try { await call("moveStudent")({ code: current, uid, groupNo: parseInt(String(to).slice(1), 10) }); toast(`'${nick}' 학생을 ${to.replace("g", "")}모둠으로 옮겼습니다.`); }
  catch (err) { toast(errMsg(err), true); }
}
$("#open-btn").onclick = async () => {
  const closing = !sessionRows.find((x) => x.code === current)?.closed;
  if (closing && !confirm("수업을 닫을까요? 학생이 더 이상 입장하거나 AI를 쓸 수 없습니다. 기록은 그대로 보존되고 언제든 다시 열 수 있습니다.")) return;
  try { await call("updateSession")({ code: current, closed: closing }); toast(closing ? "수업을 닫았습니다" : "수업을 열었습니다"); }
  catch (e) { toast(errMsg(e), true); }
};

$("#s-clone").onclick = async () => {
  if (!confirm("이 수업을 복제할까요? 새 수업 코드가 만들어집니다.")) return;
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
    const [c, o] = await Promise.all([call("getCase")({ eventId: curRow()?.eventId || "jeju2018" }), call("getPersonaOverrides")({ code: current })]);
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
      if (!confirm("이 인물을 원래 내용으로 되돌릴까요?")) return;
      const { data } = await call("resetPersonaOverride")({ code: current, personaId: pid });
      pe.overrides = data.overrides; toast("원래대로 되돌렸습니다.");
    }
  } catch (err) { return toast(errMsg(err), true); }
  renderPersonaEdit();
  open.forEach((id) => document.querySelector(`#persona-edit details[data-pid="${id}"]`)?.setAttribute("open", ""));
};

// ---------- 수업 전 연결 점검 ----------
$("#health-btn").onclick = async () => {
  const btn = $("#health-btn"); btn.disabled = true;
  $("#health-out").innerHTML = waitHtml({ first: "서버와 AI에 연결해 보는 중이에요", steps: [[0, "서버와 AI에 연결해 보는 중이에요"], [10, "AI 모델이 응답하기를 기다리는 중이에요"], [30, "평소보다 오래 걸려요. 서버는 일하는 중이에요"]] });
  try {
    const { data: r } = await call("healthCheck")({});
    const row = (name, x, extra = "") => `<div class="cell"><span class="tag ${x.ok ? "" : "r"}">${x.ok ? "정상" : "실패"}</span><div class="grow"><b>${esc(name)}</b> <span class="meta-line">${x.ms}ms</span>${extra}${x.error ? `<div class="meta-line" style="color:var(--danger)">${esc(x.error)}</div>` : ""}</div></div>`;
    $("#health-out").innerHTML = `<div class="group">${row("Firestore(서버 저장소)", r.firestore)}${r.models.map((m) => row(`AI 모델 ${m.model || ""}`, m, m.reply ? ` <span class="meta-line">응답: ${esc(m.reply)}</span>` : "")).join("")}${
      r.search.skipped ? `<div class="cell"><span class="tag x">꺼짐</span><div class="grow"><b>웹 검색</b> <span class="meta-line">PERSONA_WEB_SEARCH=false</span></div></div>`
        : row("인물의 웹 검색", r.search, r.search.ok ? ` <span class="meta-line">${r.search.found ? `찾음 · 출처 ${r.search.sources}개` : "시험 질문의 답을 못 찾음"}</span>` : "")}</div>
      <div class="meta-line" style="margin-top:8px">사용 가능한 인물 ${r.config.personas}명 · 검색 허용 도메인 ${r.config.allowedDomains ? r.config.allowedDomains + "개" : "제한 없음"}${r.config.allowUnverified ? " · <b>리허설 모드(원문 대조 전 인물도 보임)</b>" : ""}</div>
      ${r.search.error ? `<div class="notice yellow" style="margin-top:8px">${esc(r.search.error)}</div>` : ""}`;
  } catch (e) { $("#health-out").innerHTML = `<div class="notice">${esc(errMsg(e))}</div>`; }
  finally { btn.disabled = false; }
};
