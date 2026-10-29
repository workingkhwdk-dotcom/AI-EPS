// 학생 화면의 '내 결과': 교사가 공개한 점수(수준별 평가 근거 포함)와 세특을 보여 준다.
//  - 수업 중에는 로그인한 계정으로, 수업이 닫힌 뒤에는 입장 화면의 모둠·별명·비밀번호로 myResult 를 부른다.
//  - 점수와 세특은 교사가 따로 공개한다. 서버가 공개된 것만 돌려주므로 화면은 받은 것만 그린다.
import { call, esc, toast, errMsg } from "./fb.js";
import { showModal } from "./modal.js";

const seenKey = (code) => `eps_res_${code}`;
export const seenAt = (code) => { try { return Number(localStorage.getItem(seenKey(code))) || 0; } catch { return 0; } };
export const markSeen = (code, t) => { try { localStorage.setItem(seenKey(code), String(t || Date.now())); } catch {} };

// 이의 신청: 확정된 항목마다 한 번, 마감 전까지. 선생님 화면의 ② 확인으로 가고, 처리되면 답이 여기에 보인다.
// r.preview 는 선생님의 미리보기라 단추를 누를 수 없게 글로만 보여 준다.
const fmtUntil = (t) => new Date(t).toLocaleString("ko-KR", { month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
function appealHtml(it, r) {
  if (!it.scored) return "";
  const ap = it.appeal, closed = r.appealUntil && Date.now() > r.appealUntil;
  if (!ap) return closed ? "" : r.preview ? `<div class="res-ap meta-line">(학생 화면에는 '이 점수에 이의가 있어요' 단추가 있어요)</div>` : `<div class="res-ap"><button class="link" type="button" data-appeal="${esc(it.id)}">이 점수에 이의가 있어요</button></div>`;
  return `<div class="res-ap"><span class="tag ${ap.status === "open" ? "y" : ""}">이의 신청 ${ap.status === "open" ? "· 선생님이 확인하는 중" : "· 처리됨"}</span> <span class="meta-line">“${esc(ap.text)}”</span>${ap.reply ? `<div class="res-note">선생님 답: ${esc(ap.reply)}</div>` : ""}</div>`;
}
const areaOf = (it) => (it.scope === "student" ? (it.area === "group" ? "모둠 활동 속 내 기여" : "내 활동") : "우리 모둠 활동");
function scoreHtml(sc, r) {
  const rows = [];
  let last = "";
  for (const it of sc.items) {
    if (it.element !== last) { rows.push(`<h4 style="margin:14px 0 2px;color:var(--ink-2)">${esc(it.element)}</h4>`); last = it.element; }
    rows.push(`<div class="res-item"><div class="rh"><b>${esc(it.name)}</b><span>${it.scored ? `<b>${it.pts}</b> / ${it.max}점` : `<span class="tag x">채점 전</span>`}</span></div>
      <div class="meta-line">${areaOf(it)}${it.scored ? ` · <span class="tag ${it.level === "미제출" ? "r" : "b"}">${esc(it.level)}</span>` : ""}</div>
      ${it.desc ? `<div class="meta-line">${esc(it.desc)}</div>` : ""}${it.note ? `<div class="res-note">${esc(it.note)}</div>` : ""}${appealHtml(it, r)}</div>`);
  }
  const until = r.appealUntil ? `<div class="meta-line" style="margin-top:4px">${Date.now() > r.appealUntil ? "이의 신청 기간이 끝났어요." : `점수에 이의가 있으면 ${esc(fmtUntil(r.appealUntil))}까지 항목마다 한 번 신청할 수 있어요.`}</div>` : "";
  return `<div class="res-total">${sc.total}<small> / ${sc.max}점</small></div>
    <div class="meta-line">내 활동 ${sc.indiv} / ${sc.indivMax}점 + 우리 모둠 활동 ${sc.group} / ${sc.groupMax}점${sc.items.some((it) => it.area === "group" && it.scope === "student") ? "(모둠 활동 속 내 기여 포함)" : ""}${sc.complete ? "" : ` · 아직 ${sc.count - sc.done}칸은 채점 전이에요`}</div>${until}${rows.join("")}`;
}

export function resultHtml(r) {
  const parts = [];
  if (r.excluded && r.released.score) parts.push(`<h3 style="margin-top:6px">내 점수</h3><div class="notice muted">이번 수행평가에서는 '${esc(r.excluded.label)}'(으)로 평가에서 빠졌어요. 대체 평가나 점수는 선생님께 여쭤보세요.</div>`);
  if (r.released.score && r.score) parts.push(`<h3 style="margin-top:6px">내 점수</h3>${scoreHtml(r.score, r)}`);
  if (r.released.seteuk) parts.push(`<h3 style="margin-top:16px">내 세특</h3>${r.seteuk?.text ? `<div class="res-seteuk">${esc(r.seteuk.text)}</div>` : `<div class="meta-line">아직 선생님이 쓰는 중이에요.</div>`}`);
  return parts.join("") || `<p>선생님이 아직 공개하지 않았어요. 공개하면 여기서 볼 수 있어요.</p>`;
}

// args: { code } (수업 중) 또는 { code, groupNo, nickname, password } (수업이 끝난 뒤)
let cur = null; // 열려 있는 결과 창의 호출 정보(이의 신청을 같은 방식으로 보내려고)
const bodyHtml = (r) => `<div class="meta-line" style="margin-bottom:6px">${esc(r.title || "")}</div>${resultHtml(r)}`;
export async function openResult(args) {
  let r;
  try { r = (await call("myResult")(args)).data; } catch (e) { toast(errMsg(e), true); return null; }
  cur = { args, r };
  await showModal({ title: `${esc(r.nickname)}의 결과`, body: bodyHtml(r), actions: [{ label: "닫기", value: true, kind: "btn-primary" }], dismissible: true, wide: true });
  cur = null;
  return r;
}
document.addEventListener("click", async (e) => {
  if (!cur) return;
  const open = e.target.closest("[data-appeal]"), send = e.target.closest("[data-appeal-send]"), cancel = e.target.closest("[data-appeal-cancel]");
  if (open) {
    open.closest(".res-ap").innerHTML = `<textarea class="res-ap-t" maxlength="300" rows="3" placeholder="어느 부분이 왜 다르다고 생각하는지 써 주세요(4자 이상)"></textarea>
      <div class="row" style="margin-top:6px"><button class="btn btn-primary btn-sm" type="button" data-appeal-send="${esc(open.dataset.appeal)}">선생님께 보내기</button><button class="btn btn-plain btn-sm" type="button" data-appeal-cancel>취소</button></div>`;
  } else if (cancel) { document.querySelector(".modal-body").innerHTML = bodyHtml(cur.r); }
  else if (send) {
    const text = send.closest(".res-ap").querySelector(".res-ap-t").value;
    send.disabled = true;
    try {
      cur.r = (await call("myResult")({ ...cur.args, appeal: { criterion: send.dataset.appealSend, text } })).data;
      document.querySelector(".modal-body").innerHTML = bodyHtml(cur.r);
      toast("선생님께 보냈어요");
    } catch (err) { toast(errMsg(err), true); send.disabled = false; }
  }
});
