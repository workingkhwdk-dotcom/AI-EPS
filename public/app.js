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

const S = {
  code: null, groupId: null, nick: null, uid: null, info: null, me: null,
  work: {}, logs: [], chat: [], stage: 1, aiCount: 0,
  busy: null, sending: false, pending: null, draft: "", letterClosed: false, matTab: null, proposalId: null, round: 1,
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

async function save(path, value) {
  try { await updateDoc(groupRef, { ["work." + path]: value }); }
  catch (e) { console.error(e); toast("저장하지 못했습니다. 연결을 확인하세요.", true); }
}
const addItem = async (path, obj) => { const id = newId(); await save(`${path}.${id}`, { ...obj, t: Date.now(), by: S.uid, nick: S.nick }); return id; };
const delItem = (path, id) => save(`${path}.${id}`, deleteField());
const who = (it) => (it.nick ? `<span class="authored">${esc(it.nick)}</span>` : "");

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
  onSnapshot(groupRef, (s) => { const d = s.data() || {}; S.work = d.work || {}; S.aiCount = d.aiCount || 0; render(); });
  onSnapshot(collection(db, `sessions/${code}/groups/${S.groupId}/logs`), (s) => { S.logs = s.docs.map((d) => ({ id: d.id, ...d.data() })); render(); });
  onSnapshot(query(collection(db, `sessions/${code}/members/${S.uid}/chat`), orderBy("createdAt")), (s) => {
    S.chat = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (S.stage === 1) { if (!$("#msgs")) render(true); else renderMsgs(); }
  });
  renderTabs();
  startPresence();
}

onAuthStateChanged(auth, async (u) => {
  if (!u) { await signInAnonymously(auth); return; }
  S.uid = u.uid;
  const saved = localStorage.getItem("eps_code");
  if (saved && !S.code) enter(saved).catch(console.error);
});

// ---------- 공통 렌더 ----------
function renderTabs() {
  $("#tabs").innerHTML = STAGES.map((s) =>
    `<button class="stage-tab ${S.stage === s.n ? "on" : ""}" data-stage="${s.n}"><b>${s.n}</b><span>${s.name}</span></button>`).join("");
}
$("#tabs").onclick = (e) => {
  const b = e.target.closest("[data-stage]"); if (!b) return;
  S.stage = Number(b.dataset.stage); renderTabs(); render(true); ping(); window.scrollTo(0, 0);
};

const gyrBanner = (n) => {
  const s = STAGES[n - 1];
  if (s.ai === "X") return `<div class="notice muted"><span class="tag x">AI 사용 안 함</span> 이 단계는 우리 모둠이 스스로 생각하는 단계입니다. 활동: ${s.cap}</div>`;
  return `<div class="notice yellow"><span class="tag y">YELLOW</span> 먼저 우리가 생각해서 쓰고, 그 다음에 AI를 사용합니다. AI의 답은 그대로 쓰지 않고 우리 말로 바꿔 판단합니다. 활동: ${s.cap}</div>`;
};
const loading = (msg = "AI가 답을 만드는 중입니다…") => `<div class="loading-strip"><div class="spinner"></div><span>${msg}</span></div>`;

function listHtml(path, rowFn, empty = "아직 없습니다.") {
  const items = list(path);
  if (!items.length) return `<div class="meta-line">${empty}</div>`;
  return `<div class="group">${items.map((it) =>
    `<div class="cell"><div class="grow">${rowFn(it)}${who(it) ? `<br>${who(it)}` : ""}</div><button class="btn btn-plain btn-sm" data-act="del" data-path="${path}" data-id="${it.id}">삭제</button></div>`).join("")}</div>`;
}

let lastKey = "";
function render(force = false) {
  if (!S.info) return;
  const ae = document.activeElement;
  const typing = !force && panel.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName);
  if (typing) return;
  const html = renderStage[S.stage]() + `<div class="meta-line" style="text-align:right">우리 모둠 AI 사용 ${S.aiCount}회</div>`;
  const key = S.stage + S.busy + html;
  if (!force && key === lastKey) return;
  lastKey = key;
  const sc = window.scrollY;
  panel.innerHTML = html;
  if (S.stage === 1) { const m = $("#msg"); if (m && S.draft) m.value = S.draft; renderMsgs(true); }
  else window.scrollTo(0, sc);
}

// ---------- 1단계: 편지 + 메신저 대화 ----------
let lastMsgCount = -1;
function msgsHtml() {
  const name = S.me?.name || "", ini = esc(name.slice(0, 1));
  const rows = [];
  for (const l of S.chat) {
    rows.push(`<div class="msg me"><div class="col"><div class="bubble">${esc(l.input)}</div><span class="time">${fmtTime(l.createdAt)}</span></div></div>`);
    rows.push(`<div class="msg ai"><div class="avatar sm">${ini}</div><div class="col"><span class="name">${esc(name)}</span><div class="bubble">${esc(l.output)}</div><span class="time">${fmtTime(l.createdAt)}</span></div></div>`);
  }
  if (S.pending && S.chat.length <= S.pending.base)
    rows.push(`<div class="msg me"><div class="col"><div class="bubble">${esc(S.pending.text)}</div></div></div>`);
  if (S.sending)
    rows.push(`<div class="msg ai typing"><div class="avatar sm">${ini}</div><div class="col"><div class="bubble"><i></i><i></i><i></i></div></div></div>`);
  if (!rows.length) rows.push(`<div class="empty">${esc(name)}에게 궁금한 점을 물어보세요.<br>대화하면서 질문은 얼마든지 바뀌어도 좋아요.</div>`);
  return rows.join("");
}
function renderMsgs(forceScroll = false) {
  const el = $("#msgs"); if (!el) return;
  el.innerHTML = msgsHtml();
  const n = S.chat.length + (S.sending ? 1 : 0) + (S.pending ? 1 : 0);
  // 대화가 시작되면 편지는 접는다
  if (n > 0 && !S.letterClosed) { document.querySelector("details.letter")?.removeAttribute("open"); S.letterClosed = true; }
  // 새 말풍선이 생기면 입력창이 화면 아래에 오도록 이어서 내려간다(대화창 안쪽 스크롤은 없다)
  if ((forceScroll && n > 0) || n !== lastMsgCount) requestAnimationFrame(() => document.getElementById("chat-form")?.scrollIntoView({ block: "end" }));
  lastMsgCount = n;
  const btn = $("#send-btn"); if (btn) btn.disabled = S.sending;
}

async function sendChat(text) {
  S.sending = true; S.pending = { text, base: S.chat.length }; renderMsgs(true);
  try {
    await call("aiRequest")({ code: S.code, stage: 1, type: "persona_chat", payload: { message: text } });
    S.draft = "";
  } catch (e) {
    toast(errMsg(e), true);
    S.pending = null; S.draft = text; const m = $("#msg"); if (m) m.value = text;
  } finally {
    S.sending = false;
    renderMsgs();
    setTimeout(() => { S.pending = null; renderMsgs(); }, 6000);
  }
}

const SEND_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>';

const renderStage = {
  1() {
    const info = S.info, me = S.me;
    if (!me) return `${gyrBanner(1)}<div class="notice">배정된 인물이 없습니다. 선생님께 알려 주세요.</div>`;
    const notes = toList(w("s1.findings"));
    const mine = w(`s1.findings.${S.uid}`)?.text || "";
    const others = notes.filter((n) => n.id !== S.uid && (n.text || "").trim());
    return `${gyrBanner(1)}
    <div class="card"><h2>${esc(info.title)}</h2><p>${esc(info.summary)}</p></div>
    <details class="letter" ${S.chat.length ? "" : "open"}>
      <summary>${esc(me.name)}에게서 온 편지</summary>
      <div class="body">${me.letter.map((p) => `<p>${esc(p)}</p>`).join("")}<div class="sign">${esc(me.name)} 드림</div></div>
    </details>
    <div class="card chat-card">
      <div class="chat-head"><div class="avatar">${esc(me.name.slice(0, 1))}</div><div><div class="nm">${esc(me.name)}</div><div class="st">대화 중</div></div></div>
      <div class="msgs" id="msgs"></div>
      <form class="composer" id="chat-form" autocomplete="off">
        <input type="text" id="msg" maxlength="500" placeholder="${esc(me.name)}에게 메시지 보내기" />
        <button class="send" id="send-btn" type="submit" aria-label="보내기">${SEND_ICON}</button>
      </form>
    </div>
    <div class="card"><h3>내가 알아낸 점 (내 말로 정리)</h3>
      <p class="desc">대화에서 알게 된 사실, 이 사람의 입장, 더 궁금한 점을 적으세요. 모둠원이 이 글을 읽고 함께 토의합니다.</p>
      <textarea id="s1note" data-notes="1" placeholder="${esc(me.name)}에게서 알게 된 점">${esc(mine)}</textarea></div>
    <div class="card"><h3>모둠원이 알아온 점</h3>
      ${others.map((n) => `<div style="margin-bottom:10px"><b>${esc(n.nick || "모둠원")}</b>
        <div class="ai-out" style="background:var(--surface-2)">${esc(n.text)}</div></div>`).join("") || `<div class="meta-line">아직 모둠원이 정리한 내용이 없습니다.</div>`}
      <div class="meta-line">모둠원은 서로 다른 사람과 이야기를 나눴어요. 같은 사건을 누가 어떻게 다르게 말하는지 비교해 보세요.</div></div>`;
  },

  2() {
    const cats = S.info.materials || [];
    const cur = cats.find((c) => c.id === S.matTab) || cats[0];
    const notes = toList(w("s1.findings")).filter((n) => (n.text || "").trim());
    const itemHtml = (it) => `<div class="mat-item"><span class="kind k-${esc(it.kind)}">${esc(it.kind)}</span><p>${esc(it.text)}</p><div class="cap">${esc(it.caption)}</div></div>`;
    const matBody = !cur ? `<div class="notice muted">선생님이 실제 자료를 준비하는 중입니다.</div>`
      : cur.type === "timeline"
        ? `<div class="timeline">${cur.items.map((it) => `<div class="tl"><div class="d">${esc(it.date)}</div><p>${esc(it.text)}</p><div class="cap">${esc(it.caption)}</div></div>`).join("")}</div>`
        : `${cur.stats ? `<div class="stats">${cur.stats.map((s, i) => `<div class="stat ${i === 2 ? "g" : i === 0 ? "" : "b"}"><b>${esc(s.value)}</b><span>${esc(s.label)}</span></div>`).join("")}</div>` : ""}
           <div class="mat">${cur.items.map(itemHtml).join("")}</div>`;
    return `${gyrBanner(2)}
    <div class="card"><h2>실제 사건 자료</h2>
      <p class="desc">대화에서 들은 이야기가 실제와 같은지 비교해 보는 자료입니다. 말한 사람과 확인 가능성에 따라 <span class="kind">사실</span> <span class="kind k-증언">증언</span> <span class="kind k-주장">주장</span> <span class="kind k-의견">의견</span>으로 나누어 두었습니다. 주장과 의견은 사실처럼 받아들이지 말고 확인해 보세요.</p>
      <div class="chipbar scroll">${cats.map((c) => `<button class="chip ${cur && c.id === cur.id ? "on" : ""}" data-act="mat-tab" data-id="${c.id}">${esc(c.title)}</button>`).join("")}</div>
      ${matBody}</div>
    <div class="card"><h3>① 들은 이야기와 검증 질문</h3>
      <p class="desc">인터뷰에서 AI 인물에게 들은 이야기 중, 사실인지 확인하고 싶은 것을 골라 적고, <b>이 말이 사실인지 어떻게 확인할 수 있을지</b> 질문으로 만드세요. 3단계에서 이 질문으로 확인합니다.</p>
      ${notes.length ? `<details class="fold" style="box-shadow:none;background:var(--fill)"><summary>모둠원이 알아온 점 보기</summary><div class="inner">${notes.map((n) => `<p><b>${esc(n.nick || "모둠원")}</b><br>${esc(n.text)}</p>`).join("")}</div></details>` : ""}
      ${list("s2.checks").map((c) => `<div class="card flat" style="margin-bottom:10px">
        <div><span class="tag b">들은 이야기</span> ${esc(c.heard)}</div>
        <div style="margin-top:6px"><span class="tag y">검증 질문</span> ${esc(c.question)}</div>
        <label class="lbl">자료와 비교해 확인한 내용 (같음 / 다름 / 확인 안 됨)</label>
        <input type="text" data-save="s2.checks.${c.id}.real" value="${esc(c.real || "")}" placeholder="실제 자료에서는 어떻게 나와 있나요?" />
        <div class="row" style="margin-top:8px;justify-content:space-between">${who(c)}<button class="btn btn-plain btn-sm" data-act="del" data-path="s2.checks" data-id="${c.id}">삭제</button></div></div>`).join("") || `<div class="meta-line" style="margin-bottom:8px">아직 없습니다. 아래에 추가하세요.</div>`}
      <label class="lbl">들은 이야기 (누가 어떤 말을 했나요?)</label><input type="text" id="ch-heard" placeholder="예) 일자리를 구하기 어려웠다고 했다" />
      <label class="lbl">검증 질문 (이 말이 사실인지 무엇으로 확인할까요?)</label><input type="text" id="ch-q" placeholder="예) 난민 신청자는 제주에서 일을 할 수 있었을까? 근거는?" />
      <div style="margin-top:10px"><button class="btn btn-tinted" data-act="add-check">추가</button></div></div>
    <div class="card"><h3>② 나·우리와의 연결고리</h3>
      <p class="desc">공감을 넘어서, 이 사람의 처지가 <b>나와 우리 주변과 어떻게 이어지는지</b> 찾아보세요. 이어진 점이 진짜인지 확인하는 방법도 함께 적습니다.</p>
      ${listHtml("s2.links", (r) => `<span class="tag">${esc(r.level)}</span> <b>${esc(r.situation)}</b><br>이어지는 점: ${esc(r.point)}<br>확인하는 방법: ${esc(r.confirm)}`)}
      <label class="lbl">어느 층위의 연결인가요?</label>
      <select id="lk-level"><option>개인·가족</option><option>학교·지역</option><option>제도·사회</option></select>
      <label class="lbl">그 사람의 처지 (한 문장)</label><input type="text" id="lk-sit" placeholder="예) 말이 통하지 않아 일자리를 구하기 어렵다" />
      <label class="lbl">나·우리 주변에서 이어지는 점</label><input type="text" id="lk-pt" placeholder="예) 우리 동네 시장에도 외국인 노동자가 일한다" />
      <label class="lbl">그 점이 정말 이어지는지 확인하는 방법</label><input type="text" id="lk-cf" placeholder="예) 구청 외국인 지원 현황을 찾아본다" />
      <div style="margin-top:10px"><button class="btn btn-tinted" data-act="add-link">연결고리 추가</button></div></div>
    <div class="card"><h3>③ 문제의 원인 추측</h3>
      <p class="desc">개인의 노력 문제인지, 제도·사회 구조의 문제인지 여러 층위에서 생각해 보세요.</p>
      ${listHtml("s2.causes", (q) => esc(q.text))}
      <div class="row" style="margin-top:8px"><input type="text" id="cz" placeholder="원인을 추측해 적으세요" style="flex:1;min-width:0" /><button class="btn btn-tinted" data-act="add-cause">추가</button></div></div>`;
  },

  3() {
    const checks = list("s2.checks");
    const chain = (k) => esc(w(`s3.chain.${k}`) || "");
    return `${gyrBanner(3)}
    <div class="card"><h3>검증 질문으로 확인하기</h3>
      <p class="desc">2단계에서 만든 검증 질문을 AI 검색 보조자에게 물어 정보를 얻고, <b>우리가 직접 찾은 자료와 비교해</b> 받아들일지 판단합니다. AI의 답은 확인할 대상입니다.</p>
      ${!checks.length ? `<div class="notice">2단계에서 검증 질문을 먼저 만들어야 합니다.</div>` : ""}</div>
    ${checks.map((c) => {
      const logs = stageLogs(3).filter((l) => l.payload?.checkId === c.id);
      return `<div class="card">
        <div><span class="tag b">들은 이야기</span> ${esc(c.heard)}</div>
        <div style="margin-top:6px"><span class="tag y">검증 질문</span> <b>${esc(c.question)}</b></div>
        ${c.real ? `<div class="meta-line" style="margin-top:6px">2단계 메모: ${esc(c.real)}</div>` : ""}
        <div class="row" style="margin-top:10px"><button class="btn btn-primary btn-sm" data-act="ask-check" data-id="${c.id}" ${S.busy ? "disabled" : ""}>AI에게 물어보기</button></div>
        ${S.busy === "check:" + c.id ? loading() : ""}
        ${logs.map((l) => { const v = w(`s3.checks.${l.id}`) || {};
          return `<div data-log="${l.id}" style="margin-top:12px"><div class="ai-out">${esc(l.output)}</div>
          <label class="lbl">내가 직접 찾아 확인한 자료 (출처·주소)</label><input type="text" data-f="source" value="${esc(v.source || "")}" />
          <label class="lbl">판단</label><select data-f="verdict">${["", "수용", "보류", "불수용"].map((x) => `<option ${v.verdict === x ? "selected" : ""}>${x}</option>`).join("")}</select>
          <label class="lbl">이유 (내 말로)</label><textarea data-f="reason">${esc(v.reason || "")}</textarea>
          <div style="margin-top:8px"><button class="btn btn-tinted btn-sm" data-act="save-check" data-id="${l.id}">검증 결과 저장</button></div></div>`; }).join("")}
      </div>`; }).join("")}
    <div class="card"><h3>핵심 원인 도출</h3>
      <p class="desc">확인한 정보를 그대로 원인으로 옮기지 말고, <b>근거 → 내 해석 → 원인</b> 순서로 이어서 써 보세요. 자료를 해석하는 것이 원인을 찾는 핵심 과정입니다.</p>
      <label class="lbl">① 수용한 정보 (근거)</label><textarea data-save="s3.chain.evidence" placeholder="우리가 확인해서 받아들인 정보">${chain("evidence")}</textarea>
      <label class="lbl">② 이 정보가 뜻하는 것 (내 해석)</label><textarea data-save="s3.chain.meaning" placeholder="그 정보가 무엇을 보여 준다고 생각하나요?">${chain("meaning")}</textarea>
      <label class="lbl">③ 그래서 핵심 원인은</label><textarea data-save="s3.chain.cause" placeholder="모둠 토의로 정리한 핵심 원인">${chain("cause")}</textarea></div>`;
  },

  4() {
    const props = list("s4.proposals"), logs = stageLogs(4);
    return `${gyrBanner(4)}
    <div class="card"><h3>① 우리 모둠 대안 쓰기</h3>
      <p class="desc">다른 지역·나라의 사례에서 얻은 아이디어로 모둠이 먼저 대안을 만드세요. (30자 이상 저장해야 AI 검토를 받을 수 있습니다.)</p>
      ${props.map((p) => `<div class="card flat" style="margin-bottom:10px"><div class="grow">${esc(p.text)}</div>${who(p)}
        <div class="row" style="margin-top:8px"><button class="btn btn-primary btn-sm" data-act="ask-feedback" data-id="${p.id}" ${S.busy ? "disabled" : ""}>AI 검토 받기</button>
        <button class="btn btn-plain btn-sm" data-act="del" data-path="s4.proposals" data-id="${p.id}">삭제</button></div></div>`).join("")}
      <textarea id="pt" placeholder="우리 모둠의 해결 대안을 구체적으로 적으세요."></textarea>
      <div style="margin-top:8px"><button class="btn btn-tinted" data-act="add-proposal">대안 추가</button></div>
      ${S.busy === "feedback" ? loading("서로 다른 관점의 검토자 3명이 검토하는 중입니다…") : ""}</div>
    ${logs.map((l) => { let rv = []; try { rv = JSON.parse(l.output).reviews || []; } catch {}
      const d = w(`s4.decisions.${l.id}`) || {}; const p = props.find((x) => x.id === l.payload?.proposalId);
      return `<div class="card" data-log="${l.id}"><div class="meta-line">검토를 받은 대안</div><b>${esc((p?.text || l.input).slice(0, 80))}</b>
      <p class="desc" style="margin-top:6px">서로 다른 관점의 독립 검토자 3명의 의견입니다. AI도 틀릴 수 있으니 의견을 비교하고, 같은 점과 다른 점을 찾아보세요.</p>
      ${rv.map((r) => `<div class="card flat" style="margin-bottom:8px"><span class="tag b">${esc(r.label)}</span><div class="ai-out" style="background:transparent;padding:6px 0 0">${esc(r.text)}</div></div>`).join("")}
      <label class="lbl">세 의견의 같은 점과 다른 점</label><textarea data-f="compare">${esc(d.compare || "")}</textarea>
      <label class="lbl">이 검토를 어떻게 할까요?</label><select data-f="choice">${["", "수용", "수정해서 반영", "기각"].map((x) => `<option ${d.choice === x ? "selected" : ""}>${x}</option>`).join("")}</select>
      <label class="lbl">이유 (우리 말로)</label><textarea data-f="reason">${esc(d.reason || "")}</textarea>
      <div style="margin-top:8px"><button class="btn btn-tinted btn-sm" data-act="save-decision" data-id="${l.id}">판단 저장</button></div></div>`; }).join("")}
    <div class="card"><h3>② 최종 대안 (검토를 참고해 약점 보완)</h3>
      <textarea data-save="s4.final" placeholder="1순위 대안을 고르고 약점을 보완한 최종 대안">${esc(w("s4.final") || "")}</textarea>
      <label class="lbl">최종 대안을 선택한 이유</label><textarea data-save="s4.finalReason">${esc(w("s4.finalReason") || "")}</textarea></div>`;
  },

  5() {
    const props = list("s4.proposals"), preds = list("s5.predictions"), logs = stageLogs(5);
    const sh = S.info.stakeholders || [];
    if (!S.proposalId && props[0]) S.proposalId = props[0].id;
    return `${gyrBanner(5)}
    <div class="card"><h3>① 이해관계자 반응 먼저 예측하기</h3>
      <p class="desc">AI 시뮬레이션 전에, 우리 대안이 실행되면 이해관계자들이 어떻게 반응하고 서로 어떤 영향을 줄지 모둠이 먼저 예측하세요. (2개 이상)</p>
      ${listHtml("s5.predictions", (r) => `<span class="tag">${esc(r.stakeholder)}</span> ${esc(r.text)}`)}
      <div class="row" style="margin-top:8px"><select id="ps" style="width:auto">${sh.map((x) => `<option>${esc(x)}</option>`).join("")}</select>
      <input type="text" id="pp" placeholder="예측과 이유" style="flex:1;min-width:0" /><button class="btn btn-tinted" data-act="add-pred">추가</button></div></div>
    <div class="card"><h3>② AI 시뮬레이션</h3>
      <div class="notice muted">시뮬레이션은 실제 미래의 <b>예측이 아니라</b> 가능한 시나리오 중 일부입니다. 시간이 지나며 생기는 파급효과와 의도하지 않은 결과, 그리고 <b>그렇게 되는 이유(작동 기제)</b>를 살펴보세요.</div>
      ${props.length ? `<label class="lbl">시뮬레이션할 대안</label><select id="sp">${props.map((p) => `<option value="${p.id}" ${p.id === S.proposalId ? "selected" : ""}>${esc((p.text || "").slice(0, 50))}</option>`).join("")}</select>
      <label class="lbl">몇 년 후?</label><div class="chipbar">${ROUNDS.map((r) => `<button class="chip ${S.round === r ? "on" : ""}" data-act="round" data-r="${r}">${r}년 후</button>`).join("")}</div>
      ${S.busy === "scenario" ? loading("시나리오를 만드는 중입니다. 최대 1~2분 걸릴 수 있어요…") : ""}<div style="margin-top:10px"><button class="btn btn-primary" data-act="ask-scenario" ${preds.length >= 2 && !S.busy ? "" : "disabled"}>시나리오 만들기</button></div>`
        : `<div class="notice">4단계에서 대안을 먼저 작성하세요.</div>`}</div>
    ${logs.map((l) => { let sc = []; try { sc = JSON.parse(l.output).scenarios || []; } catch {}
      const sel = w(`s5.selection.${l.id}`) || {};
      return `<div class="card" data-log="${l.id}"><div class="meta-line">${l.payload?.round}년 후 시나리오</div>
      ${sc.map((x, i) => `<div class="scn ${sel.idx === i ? "sel" : ""}"><b>${esc(x.title)}</b><p style="margin-top:6px">${esc(x.story)}</p>
        <div class="mech"><b>작동 기제</b> ${esc(x.mechanism || "")}</div>
        <div class="meta-line">의도하지 않은 결과: ${esc([].concat(x.unintended || []).join(" / "))}</div>
        <div class="meta-line">예상되는 문제: ${esc([].concat(x.newProblems || []).join(" / "))}</div>
        <button class="btn btn-plain btn-sm" style="margin-top:8px" data-act="pick-scn" data-id="${l.id}" data-i="${i}">이 시나리오가 더 개연성 있다</button></div>`).join("")}
      <label class="lbl">작동 기제는 현실에서 가능할까요? 어느 부분이 약한가요?</label><textarea data-f="mech">${esc(sel.mech || "")}</textarea>
      <label class="lbl">개연성이 높다고 판단한 이유 (내 말로)</label><textarea data-f="reason">${esc(sel.reason || "")}</textarea>
      <div style="margin-top:8px"><button class="btn btn-tinted btn-sm" data-act="save-scn" data-id="${l.id}">판단 저장</button></div></div>`; }).join("")}
    <div class="card"><h3>③ 선택한 시나리오에서 예상되는 문제</h3>
      <textarea data-save="s5.newProblem" placeholder="대안을 실행한 뒤 생길 수 있는 문제는 무엇인가요?">${esc(w("s5.newProblem") || "")}</textarea></div>`;
  },

  6() {
    const p = w("s6.plan") || {};
    const type = p.type || "action";
    const f = (k, l, ph) => `<label class="lbl">${l}</label><textarea data-plan="${k}" placeholder="${ph}">${esc(p[k] || "")}</textarea>`;
    return `${gyrBanner(6)}
    <div class="card"><h3>5단계에서 예상한 문제</h3><div class="ai-out" style="background:var(--accent-tint)">${esc(w("s5.newProblem") || "아직 적지 않았습니다.")}</div></div>
    <div class="card"><h3>무엇을 계획할까요?</h3>
      <div class="chipbar"><button class="chip ${type === "action" ? "on" : ""}" data-act="plan-type" data-v="action">행동 계획</button><button class="chip ${type === "patch" ? "on" : ""}" data-act="plan-type" data-v="patch">대안 보완안 (예상 문제 예방)</button></div>
      <p class="desc" style="margin-top:10px">${type === "action" ? "우리 학교 안에서 실제로 할 수 있는 수준으로 구체적으로 계획하세요. (예: 설득하는 편지 쓰기, 우리의 실천 약속)" : "실천이 어렵다면, 5단계에서 예상한 문제가 생기지 않도록 우리 대안을 어떻게 고칠지 계획하세요."}</p>
      ${f("target", type === "action" ? "누구에게 / 무엇에 대해" : "어떤 예상 문제를 막을까요", "대상(누구의 어떤 반응·문제)")}${f("content", type === "action" ? "내용" : "고칠 내용", "무엇을 전하거나 실천·수정할 것인가")}
      ${f("method", "방법", "어떻게 할 것인가")}${f("effect", "기대 효과", "이 계획으로 기대하는 변화")}${f("difficulty", "예상되는 어려움과 대응", "실패한다면 어느 단계를 다시 살펴볼까?")}
      <div style="margin-top:10px"><button class="btn btn-primary" data-act="save-plan">계획 저장</button></div></div>
    <div class="card"><h3>결과가 예상과 다르다면?</h3><p class="desc">이전 단계로 돌아가 다시 생각해 볼 수 있습니다.</p>
      <div class="row"><button class="btn btn-plain btn-sm" data-go="2">원인 다시 보기(2·3단계)</button><button class="btn btn-plain btn-sm" data-go="4">대안 다시 보기(4단계)</button><button class="btn btn-plain btn-sm" data-go="5">예측 다시 보기(5단계)</button></div></div>`;
  },

  7() {
    const rows = [[1, "인터뷰 대화", S.chat.length], ...[3, 4, 5].map((n) => [n, `${n}단계 (${STAGES[n - 1].name})`, stageLogs(n).length])];
    const dec = Object.values(w("s4.decisions") || {}), cnt = (k) => dec.filter((d) => d.choice === k).length;
    const checks = w("s7.checks") || {};
    return `${gyrBanner(7)}
    <div class="card"><h3>① AI 사용 기록</h3>
      <div class="group">${rows.map((b) => `<div class="cell"><span class="grow">${b[1]}</span><b>${b[2]}회</b></div>`).join("")}
      <div class="cell"><span class="grow">AI 검토에 대한 판단</span><span>수용 ${cnt("수용")} · 수정 ${cnt("수정해서 반영")} · 기각 ${cnt("기각")}</span></div></div>
      <div class="meta-line" style="margin-top:6px">인터뷰 대화 횟수는 내 대화만 셉니다.</div></div>
    <div class="card"><h3>② 산출물 공유</h3>
      <p class="desc">발표할 내용을 간단히 정리하세요.</p>
      <textarea data-save="s7.share">${esc(w("s7.share") || "")}</textarea></div>
    <div class="card"><h3>③ AI 활용 성찰 체크리스트</h3>
      <div class="group">${CHECKLIST.map((t, i) => `<label class="cell" style="cursor:pointer"><input type="checkbox" data-chk="${i}" ${checks[i] ? "checked" : ""} style="width:20px;height:20px;margin-top:2px"><span class="grow">${esc(t)}</span></label>`).join("")}</div>
      <label class="lbl">오늘 AI를 어떻게 썼고, 무엇을 받아들이거나 버렸는지 돌아보기</label>
      <textarea data-save="s7.reflection">${esc(w("s7.reflection") || "")}</textarea></div>`;
  },
};

// ---------- 이벤트 ----------
const val = (id) => document.getElementById(id)?.value.trim() ?? "";

async function aiGroup(stage, type, payload, busyKey) {
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
panel.addEventListener("input", (e) => { if (e.target.id === "msg") S.draft = e.target.value; });

panel.addEventListener("click", async (e) => {
  const go = e.target.closest("[data-go]");
  if (go) { S.stage = Number(go.dataset.go); renderTabs(); render(true); ping(); window.scrollTo(0, 0); return; }
  const b = e.target.closest("[data-act]"); if (!b) return;
  const a = b.dataset.act, d = b.dataset;
  const card = b.closest("[data-log]");
  const field = (f) => card?.querySelector(`[data-f=${f}]`)?.value.trim() || "";

  switch (a) {
    case "del": await delItem(d.path, d.id); break;
    case "mat-tab": S.matTab = d.id; render(true); break;
    case "add-check": {
      if (val("ch-heard").length < 3 || val("ch-q").length < 5) return toast("들은 이야기와 검증 질문을 구체적으로 쓰세요.", true);
      await addItem("s2.checks", { heard: val("ch-heard"), question: val("ch-q") }); render(true); break;
    }
    case "add-link": {
      if (val("lk-sit").length < 4 || val("lk-pt").length < 4 || val("lk-cf").length < 4) return toast("세 칸을 모두 구체적으로 쓰세요.", true);
      await addItem("s2.links", { level: val("lk-level"), situation: val("lk-sit"), point: val("lk-pt"), confirm: val("lk-cf") }); render(true); break;
    }
    case "add-cause": { if (val("cz").length < 4) return toast("원인을 구체적으로 쓰세요.", true); await addItem("s2.causes", { text: val("cz") }); render(true); break; }
    case "ask-check": await aiGroup(3, "verify_query", { checkId: d.id }, "check:" + d.id); break;
    case "save-check": await save(`s3.checks.${d.id}`, { source: field("source"), verdict: field("verdict"), reason: field("reason") }); toast("저장했어요"); break;
    case "add-proposal": {
      const t = val("pt"); if (t.length < 30) return toast("대안을 30자 이상 쓰세요.", true);
      S.proposalId = await addItem("s4.proposals", { text: t }); render(true); break;
    }
    case "ask-feedback": S.proposalId = d.id; await aiGroup(4, "proposal_feedback", { proposalId: d.id }, "feedback"); break;
    case "save-decision": await save(`s4.decisions.${d.id}`, { compare: field("compare"), choice: field("choice"), reason: field("reason") }); toast("저장했어요"); break;
    case "add-pred": {
      if (val("pp").length < 10) return toast("예측과 이유를 10자 이상 쓰세요.", true);
      await addItem("s5.predictions", { stakeholder: val("ps"), text: val("pp") }); render(true); break;
    }
    case "round": S.round = Number(d.r); render(true); break;
    case "ask-scenario": { const pid = val("sp") || S.proposalId; S.proposalId = pid; await aiGroup(5, "scenario", { proposalId: pid, round: S.round }, "scenario"); break; }
    case "pick-scn": { const cur = w(`s5.selection.${d.id}`) || {}; await save(`s5.selection.${d.id}`, { ...cur, idx: Number(d.i) }); break; }
    case "save-scn": { const cur = w(`s5.selection.${d.id}`) || {}; await save(`s5.selection.${d.id}`, { ...cur, mech: field("mech"), reason: field("reason") }); toast("저장했어요"); break; }
    case "plan-type": { const cur = w("s6.plan") || {}; await save("s6.plan", { ...cur, type: d.v }); render(true); break; }
    case "save-plan": {
      const plan = { type: (w("s6.plan") || {}).type || "action" };
      panel.querySelectorAll("[data-plan]").forEach((t) => (plan[t.dataset.plan] = t.value.trim()));
      await save("s6.plan", plan); toast("저장했어요"); break;
    }
  }
});

// 자유 서술 칸: 입력이 멈추면 자동 저장
let t;
panel.addEventListener("input", (e) => {
  const el = e.target;
  if (el.dataset?.save) { clearTimeout(t); t = setTimeout(() => save(el.dataset.save, el.value), 700); }
  else if (el.dataset?.notes) {
    clearTimeout(t);
    t = setTimeout(() => save(`s1.findings.${S.uid}`, { nick: S.nick, text: el.value, t: Date.now() }), 700);
  }
});
panel.addEventListener("change", (e) => {
  const c = e.target.dataset?.chk; if (c == null) return;
  save(`s7.checks.${c}`, e.target.checked);
});
