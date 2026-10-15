import { auth, db, call, esc, toast, errMsg } from "./fb.js";
import { GoogleAuthProvider, signInWithPopup, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, query, where, orderBy, onSnapshot, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const $ = (s) => document.querySelector(s);
const STAGE_NAMES = ["", "사건 경험", "원인 탐색", "검증", "대안 구상", "미래 시나리오", "행동계획", "공유·성찰"];
const ONLINE_MS = 75 * 1000; // 학생 화면은 30초마다 접속 신호를 보낸다
const fmt = (ts) => (ts?.toDate ? ts.toDate().toLocaleString("ko-KR") : "");
const hasKeys = (o) => o && typeof o === "object" && Object.keys(o).length > 0;
const filled = (v) => (typeof v === "string" ? v.trim() !== "" : hasKeys(v));

let current = null, curTitle = "", unsubs = [], members = [], groups = [], alerts = [], gFilter = "all";
let tickTimer = null;

// ---------- 로그인 ----------
$("#login-btn").onclick = () => signInWithPopup(auth, new GoogleAuthProvider()).catch((e) => toast(errMsg(e), true));
onAuthStateChanged(auth, (u) => {
  const ok = u && !u.isAnonymous;
  $("#login").classList.toggle("hidden", !!ok);
  $("#main").classList.toggle("hidden", !ok);
  $("#who").textContent = ok ? u.email : "";
  if (ok) { listSessions(u.uid); refreshCase("jeju2018").catch(() => {}); }
});

// ---------- 탭 ----------
function showTab(name) {
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  for (const t of ["live", "new", "check"]) $(`#tab-${t}`).classList.toggle("hidden", t !== name);
  if (name === "check") loadCheck($("#t-event").value);
}
$("#tabs").onclick = (e) => { const b = e.target.closest("[data-tab]"); if (b) showTab(b.dataset.tab); };

// ---------- 수업 만들기·목록 ----------
$("#create-btn").onclick = async () => {
  try {
    const title = $("#t-title").value;
    const { data } = await call("createSession")({ title, eventId: $("#t-event").value, groupCount: Number($("#t-groups").value) });
    toast(`수업 코드: ${data.code}`);
    showTab("live");
    openSession(data.code, title);
  } catch (e) { toast(errMsg(e), true); }
};

function listSessions(uid) {
  onSnapshot(query(collection(db, "sessions"), where("teacherUid", "==", uid)), (s) => {
    const rows = s.docs.map((d) => ({ code: d.id, ...d.data() })).sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    $("#sessions").innerHTML = rows.map((r) =>
      `<div class="cell"><div class="grow"><b>${esc(r.title)}</b><br><span class="meta-line">코드 ${r.code} · ${r.groupCount}모둠 · ${fmt(r.createdAt)}</span></div><button class="btn btn-tinted btn-sm" data-code="${r.code}" data-title="${esc(r.title)}">열기</button></div>`
    ).join("") || `<div class="cell meta-line">아직 만든 수업이 없습니다. '새 수업' 탭에서 만들어 보세요.</div>`;
  }, (e) => toast(errMsg(e), true));
}
$("#sessions").onclick = (e) => { const b = e.target.closest("[data-code]"); if (b) openSession(b.dataset.code, b.dataset.title); };

// ---------- 수업 현황 ----------
function progressOf(work) {
  const w = work || {};
  return [
    hasKeys(w.s1?.findings),
    filled(w.s2?.problem) || hasKeys(w.s2?.checks),
    hasKeys(w.s3?.checks) || filled(w.s3?.chain?.cause),
    hasKeys(w.s4?.proposals) || filled(w.s4?.final),
    hasKeys(w.s5?.selection) || filled(w.s5?.newProblem),
    hasKeys(w.s6?.plan),
    filled(w.s7?.reflection) || filled(w.s7?.compare) || hasKeys(w.s7?.checks),
  ];
}

function openSession(code, title) {
  current = code; curTitle = title; gFilter = "all"; alerts = [];
  unsubs.forEach((u) => u()); unsubs = [];
  clearInterval(tickTimer);
  $("#dash").classList.remove("hidden");
  $("#detail").classList.add("hidden");
  $("#d-title").textContent = title;
  $("#d-code").textContent = code;
  unsubs.push(onSnapshot(collection(db, `sessions/${code}/members`), (s) => { members = s.docs.map((d) => ({ uid: d.id, ...d.data() })); renderDash(); }));
  unsubs.push(onSnapshot(collection(db, `sessions/${code}/groups`), (s) => {
    groups = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => parseInt(a.id.slice(1)) - parseInt(b.id.slice(1)));
    renderDash();
  }));
  unsubs.push(onSnapshot(query(collection(db, `sessions/${code}/alerts`), orderBy("createdAt", "desc")), (s) => {
    const before = alerts.length;
    alerts = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (before && alerts.length > before) toast("⚠ 대화 규칙 위반 신호가 새로 들어왔습니다", true);
    renderDash();
  }, (e) => console.error(e)));
  tickTimer = setInterval(renderDash, 15000); // 접속 상태를 주기적으로 갱신
  window.scrollTo({ top: 0, behavior: "smooth" });
}

const isOnline = (m) => m.lastSeen?.toMillis && Date.now() - m.lastSeen.toMillis() < ONLINE_MS;
const ago = (m) => { const t = m.lastSeen?.toMillis?.(); if (!t) return "기록 없음"; const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}초 전` : s < 3600 ? `${Math.round(s / 60)}분 전` : `${Math.round(s / 3600)}시간 전`; };
const personaLabels = {}; // 인물 ID → 교사용 역할명 (getCase 로 채움)

function renderDash() {
  if (!current) return;
  const online = members.filter(isOnline).length;
  const ai = groups.reduce((n, g) => n + (g.aiCount || 0), 0);
  const guard = groups.reduce((n, g) => n + (g.guardCount || 0), 0);
  const lockedN = members.filter((m) => m.chatLocked).length;
  $("#kpis").innerHTML = [["접속 중", `${online}명`], ["참여 학생", `${members.length}명`], ["AI 호출", `${ai}회`], ["감독자 개입", `${guard}회`],
    ["규칙 위반 신호", `${alerts.length}건`, alerts.length ? "warn" : ""], ["대화 멈춤", `${lockedN}명`, lockedN ? "warn" : ""]]
    .map(([k, v, c]) => `<div class="kpi ${c || ""}"><b>${v}</b><span>${k}</span></div>`).join("");

  // 규칙 위반 신호: 최근 것부터. 대화가 멈춘 학생은 다시 열 수 있다
  $("#alerts-card").classList.toggle("hidden", !alerts.length);
  $("#alerts").innerHTML = alerts.slice(0, 30).map((a) => {
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
    <td><b>${esc(m.nickname)}</b></td><td>${esc(m.groupId.replace("g", ""))}모둠</td>
    <td>${esc(personaLabels[m.personaId] || m.personaId)}</td>
    <td><span class="pill">${m.stage || 1}. ${STAGE_NAMES[m.stage || 1]}</span></td>
    <td><span class="dot ${isOnline(m) ? "on" : ""}"></span>${isOnline(m) ? "접속 중" : `자리 비움 · ${ago(m)}`}
      ${m.chatLocked ? ` <span class="tag r">대화 멈춤</span>` : m.conduct?.total ? ` <span class="tag y" title="누적 위반">⚠ ${m.conduct.total}</span>` : ""}</td>
    <td>${m.aiCount || 0}회</td>
    <td><button class="btn btn-tinted btn-sm" data-chat="${m.uid}">대화 보기</button></td></tr>`).join("");
  $("#no-students").textContent = rows.length ? "" : "아직 입장한 학생이 없습니다. 위의 수업 코드와 모둠 번호를 학생에게 알려 주세요.";

  $("#groups").innerHTML = groups.map((g) => {
    const ms = members.filter((m) => m.groupId === g.id);
    const pr = progressOf(g.work);
    const cur = ms.length ? Math.max(...ms.map((m) => m.stage || 1)) : 0;
    return `<tr><td><b>${esc(g.name)}</b></td><td>${ms.length}명 <span class="meta-line">(접속 ${ms.filter(isOnline).length})</span></td>
      <td><span class="dots">${pr.map((f, i) => `<i class="${f ? "on" : ""} ${cur === i + 1 ? "cur" : ""}" title="${i + 1}단계 ${STAGE_NAMES[i + 1]}"></i>`).join("")}</span></td>
      <td>${g.aiCount || 0}회${g.lastAiError ? ` <span class="tag r" title="${esc(g.lastAiError.message)}">오류</span>` : ""}</td>
      <td>${g.guardCount || 0}회${g.conductCount ? ` <span class="tag r">위반 ${g.conductCount}</span>` : ""}</td>
      <td><button class="btn btn-tinted btn-sm" data-glog="${g.id}">모둠 기록</button></td></tr>`;
  }).join("");
}

$("#g-filter").onclick = (e) => { const b = e.target.closest("[data-g]"); if (b) { gFilter = b.dataset.g; renderDash(); } };
$("#copy-btn").onclick = async () => { try { await navigator.clipboard.writeText(current); toast("코드를 복사했어요"); } catch { toast(`수업 코드: ${current}`); } };
$("#detail-close").onclick = () => $("#detail").classList.add("hidden");

// ---------- 대화·기록 보기 ----------
function showDetail(title, html) {
  $("#detail-title").textContent = title;
  $("#detail-body").innerHTML = html;
  $("#detail").classList.remove("hidden");
  $("#detail").scrollIntoView({ behavior: "smooth", block: "start" });
}
const CONDUCT_LABELS = { mockery: "조롱·모욕", sexual: "성적 희롱" };
const guardTag = (g) => !g || g.ok ? "" : ` <span class="tag ${g.how === "fixed" ? "y" : "r"}">감독자 ${g.how === "fixed" ? "수정" : "대체"} · ${esc(g.category)}</span>`;

async function loadChat(uid) {
  const m = members.find((x) => x.uid === uid);
  const snap = await getDocs(query(collection(db, `sessions/${current}/members/${uid}/chat`), orderBy("createdAt")));
  const rows = snap.docs.map((d) => d.data());
  const html = rows.map((l) => `<div class="logline">
    <div class="q">학생 ${esc(l.input)}</div>
    <div class="a">${esc(m?.nickname || "")} ↔ ${esc(personaLabels[l.personaId] || l.personaId)}: ${esc(l.output)}${l.conduct ? ` <span class="tag r">학생 ${esc(CONDUCT_LABELS[l.conduct.category] || "")} · 경고 ${l.conduct.strikes}/3</span>` : guardTag(l.guard)}</div>
    ${l.guard && !l.guard.ok ? `<details><summary class="meta-line">감독자 판정 보기</summary><div class="meta-line">사유: ${esc(l.guard.reason)}<br>인물의 원래 응답: ${esc(l.guard.original || "")}</div></details>` : ""}
    <div class="meta-line">${fmt(l.createdAt)} · ${esc(l.model)}</div></div>`).join("") || `<div class="meta-line">대화가 없습니다.</div>`;
  showDetail(`${m?.nickname || ""} · ${personaLabels[m?.personaId] || ""} 대화`, html);
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
$("#students").onclick = (e) => { const b = e.target.closest("[data-chat]"); if (b) loadChat(b.dataset.chat).catch((err) => toast(errMsg(err), true)); };
$("#alerts").onclick = async (e) => {
  const c = e.target.closest("[data-chat]"); if (c) return loadChat(c.dataset.chat).catch((err) => toast(errMsg(err), true));
  const u = e.target.closest("[data-unlock]"); if (!u) return;
  u.disabled = true;
  try { await call("unlockChat")({ code: current, uid: u.dataset.unlock }); toast("대화를 다시 열었습니다"); }
  catch (err) { toast(errMsg(err), true); u.disabled = false; }
};
$("#groups").onclick = (e) => { const b = e.target.closest("[data-glog]"); if (b) loadGroupLogs(b.dataset.glog).catch((err) => toast(errMsg(err), true)); };

// CSV: 연구·평가 기록용. 엑셀에서 한글이 깨지지 않도록 BOM 포함
$("#csv-btn").onclick = async () => {
  const lines = [["구분", "모둠", "단계", "별명", "시각", "모델", "학생 입력", "AI 응답", "감독자 판정", "학생 태도"]];
  const T = (l) => fmt(l.createdAt);
  for (const m of members) {
    const s = await getDocs(query(collection(db, `sessions/${current}/members/${m.uid}/chat`), orderBy("createdAt")));
    s.docs.map((d) => d.data()).forEach((l) => lines.push(["인물 대화", m.groupId, 1, m.nickname, T(l), l.model, l.input, l.output, l.guard ? `${l.guard.ok ? "통과" : l.guard.how}:${l.guard.category}:${l.guard.original || ""}` : "", l.conduct ? `${l.conduct.category}(${l.conduct.strikes}/3)` : ""]));
  }
  for (const g of groups) {
    const s = await getDocs(query(collection(db, `sessions/${current}/groups/${g.id}/logs`), orderBy("createdAt")));
    s.docs.map((d) => d.data()).forEach((l) => lines.push(["모둠 AI", g.id, l.stage, l.nickname, T(l), l.model, l.input, l.output, ""]));
  }
  const csv = lines.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  a.download = `ai-eps-${current}.csv`; a.click();
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
    $("#check-note").innerHTML = `<div class="notice muted">교사 메모: ${esc(data.event.teacherNote)}</div>`;
    $("#persona-check").innerHTML = data.personas.map((p) => {
      const ok = p.sources.every((s) => s.verified);
      return `<details class="fold"><summary><span>${esc(p.name)} <span class="meta-line">· ${esc(p.label)}</span></span> <span class="tag ${ok ? "" : "y"}">${ok ? "원문 대조 완료" : "대조 필요"}</span></summary><div class="inner">
        <div class="meta-line">입장: ${esc(p.stance)}</div><div class="meta-line">설정: ${esc(p.setting)}</div><div class="meta-line">가상 신상: ${esc(p.profile || "")}</div>
        <details style="margin-top:8px"><summary class="meta-line">삶의 이야기·생각 (대화에서 쓰임)</summary><div class="ai-out">${esc((p.story || []).join("\n"))}\n\n${esc((p.views || []).join("\n"))}</div></details><div class="meta-line">말투: ${esc(p.voice)}</div><div class="meta-line">융합 근거: ${esc(p.basis)}</div>
        <div style="margin-top:10px"><b>학생에게 보이는 편지</b><div class="ai-out">${p.letter.map(esc).join("\n\n")}${p.ps ? `\n\n추신. ${esc(p.ps)}` : ""}</div></div>
        <div style="margin-top:10px"><b>근거 진술</b>${p.claims.map((c) => `<div class="meta-line" style="color:var(--ink);margin-top:4px"><span class="tag ${c.kind === "주장" || c.kind === "의견" ? "y" : ""}">${esc(c.kind)}</span> ${esc(c.text)} <span class="tag x">${esc(c.src)}</span></div>`).join("")}</div>
        <div style="margin-top:10px"><b>출처 (원문을 열어 진술과 대조)</b>${p.sources.map((s) => `<div style="margin-top:8px"><span class="tag ${s.verified ? "" : "x"}">${s.id}</span>
          <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>${s.titleIsDescriptive ? ' <span class="meta-line">(제목은 설명 문구, 실제 제목 확인)</span>' : ""}
          <div class="meta-line">${esc(s.outlet)} · ${esc(s.date)}</div><div class="meta-line">확인할 것: ${esc(s.check)}</div></div>`).join("")}</div></div></details>`;
    }).join("");
    $("#material-check").innerHTML = data.materials.map((c) => `<details class="fold"><summary>${esc(c.title)} <span class="meta-line">· ${c.items.length}개</span></summary><div class="inner">
      ${c.items.map((it) => `<div class="logline"><span class="kind k-${esc(it.kind)}">${esc(it.kind)}</span> ${it.date ? `<b>${esc(it.date)}</b> ` : ""}${esc(it.text)}
        <div class="meta-line">${it.src.map((id) => `<span class="tag ${it.verified ? "" : "x"}">${id}</span>`).join(" ")} 학생에게 보이는 캡션: ${esc(it.caption)}${it.verified ? "" : " · 미검증"}</div></div>`).join("")}</div></details>`).join("");
    const srcList = (sources) => sources.map((s) => `<div style="margin-top:8px"><span class="tag ${s.verified ? "" : "x"}">${s.id}</span>
      <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>${s.titleIsDescriptive ? ' <span class="meta-line">(제목은 설명 문구, 실제 제목 확인)</span>' : ""}
      <div class="meta-line">${esc(s.outlet)} · ${esc(s.date)}</div><div class="meta-line">확인할 것: ${esc(s.check)}</div></div>`).join("");
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
