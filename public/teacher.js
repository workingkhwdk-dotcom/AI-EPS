import { auth, db, call, esc, toast, errMsg } from "./fb.js";
import { GoogleAuthProvider, signInWithPopup, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, query, where, onSnapshot, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const $ = (s) => document.querySelector(s);
const fmt = (ts) => (ts?.toDate ? ts.toDate().toLocaleString("ko-KR") : "");
let current = null, unsubGroups = null, unsubLogs = null, groups = [];

$("#login-btn").onclick = () => signInWithPopup(auth, new GoogleAuthProvider()).catch((e) => toast(errMsg(e), true));

onAuthStateChanged(auth, (u) => {
  const ok = u && !u.isAnonymous;
  $("#login").classList.toggle("hidden", !!ok);
  $("#main").classList.toggle("hidden", !ok);
  $("#who").textContent = ok ? u.email : "";
  if (ok) listSessions(u.uid);
});

$("#create-btn").onclick = async () => {
  try {
    const { data } = await call("createSession")({ title: $("#t-title").value, groupCount: Number($("#t-groups").value) });
    toast(`수업 코드: ${data.code}`);
    openSession(data.code, $("#t-title").value);
  } catch (e) { toast(errMsg(e), true); }
};

function listSessions(uid) {
  onSnapshot(query(collection(db, "sessions"), where("teacherUid", "==", uid)), (s) => {
    const rows = s.docs.map((d) => ({ code: d.id, ...d.data() })).sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    $("#sessions").innerHTML = rows.map((r) =>
      `<div class="cell"><div class="grow"><b>${esc(r.title)}</b><br><span class="meta-line">코드 ${r.code} · ${r.groupCount}모둠 · ${fmt(r.createdAt)}</span></div><button class="btn btn-tinted btn-sm" data-code="${r.code}" data-title="${esc(r.title)}">열기</button></div>`
    ).join("") || `<div class="cell meta-line">아직 만든 수업이 없습니다.</div>`;
  }, (e) => toast(errMsg(e), true));
}
$("#sessions").onclick = (e) => { const b = e.target.closest("[data-code]"); if (b) openSession(b.dataset.code, b.dataset.title); };

const STAGE_KEYS = [["s1", "preQuestions"], ["s2", "verifyQuestions"], ["s3", "coreCause"], ["s4", "final"], ["s5", "newProblem"], ["s6", "plan"], ["s7", "reflection"]];
const filled = (work, [s, k]) => { const v = work?.[s]?.[k]; return Array.isArray(v) ? v.length > 0 : v && Object.keys(v).length !== 0 && v !== ""; };

function openSession(code, title) {
  current = code;
  unsubGroups?.(); unsubLogs?.();
  $("#monitor").classList.remove("hidden");
  $("#m-title").textContent = title;
  $("#m-code").textContent = `수업 코드: ${code} (학생에게 이 코드와 모둠 번호를 알려 주세요)`;
  $("#logs").innerHTML = ""; $("#log-title").textContent = "AI 사용 로그 (모둠을 선택하세요)";
  unsubGroups = onSnapshot(collection(db, `sessions/${code}/groups`), (s) => {
    groups = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => parseInt(a.id.slice(1)) - parseInt(b.id.slice(1)));
    $("#groups").innerHTML = `<div class="group">${groups.map((g) =>
      `<div class="cell"><div class="grow"><b>${esc(g.name)}</b> <span class="meta-line">AI ${g.aiCount || 0}회</span>
       <div class="chipbar" style="margin-top:6px">${STAGE_KEYS.map((k, i) => `<span class="chip sm ${filled(g.work, k) ? "on" : ""}">${i + 1}</span>`).join("")}</div></div>
       <button class="btn btn-tinted btn-sm" data-g="${g.id}">로그 보기</button></div>`).join("")}</div>`;
  });
}

$("#groups").onclick = (e) => {
  const b = e.target.closest("[data-g]"); if (!b) return;
  unsubLogs?.();
  $("#log-title").textContent = `${b.dataset.g.replace("g", "")}모둠 AI 사용 로그`;
  unsubLogs = onSnapshot(collection(db, `sessions/${current}/groups/${b.dataset.g}/logs`), (s) => {
    const rows = s.docs.map((d) => d.data()).sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
    $("#logs").innerHTML = rows.map((l) =>
      `<div class="scn"><div class="meta-line">${l.stage}단계 · ${esc(l.nickname)} · ${fmt(l.createdAt)} · ${esc(l.model)}</div>
       <b>${esc(l.input)}</b><div class="ai-out">${esc(l.output)}</div></div>`).join("") || `<div class="meta-line">로그가 없습니다.</div>`;
  });
};

// 로그 CSV (연구·평가 기록용). 엑셀에서 한글이 깨지지 않도록 BOM 포함
$("#csv-btn").onclick = async () => {
  const lines = [["모둠", "단계", "별명", "시각", "모델", "학생 입력", "AI 응답"]];
  for (const g of groups) {
    const s = await getDocs(collection(db, `sessions/${current}/groups/${g.id}/logs`));
    s.docs.map((d) => d.data()).sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0))
      .forEach((l) => lines.push([g.name, l.stage, l.nickname, fmt(l.createdAt), l.model, l.input, l.output]));
  }
  const csv = lines.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  a.download = `ai-eps-${current}.csv`; a.click();
};
