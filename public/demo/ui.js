// 체험 화면의 덧붙임: 머리글의 '홈'·'초기화' 단추, '체험' 표시, 안내 띠. 학생 화면(app.js)은 그대로 쓴다.
import { TOPIC, resetTopic, flush } from "./store.js";

const $ = (s) => document.querySelector(s);
const right = $(".hdr-right");
const nameOf = async () => { try { return (await (await fetch("demo/topics.json")).json()).find((t) => t.id === TOPIC)?.title || ""; } catch { return ""; } };

// 머리글: 학교 이름 줄 옆에 '체험' 표시, 오른쪽에 홈·초기화
$(".logo")?.insertAdjacentHTML("beforeend", "<em>체험</em>");
right?.insertAdjacentHTML("afterbegin",
  `<button class="btn-out" id="demo-home" type="button" aria-label="주제 고르는 처음 화면으로">홈</button><button class="btn-out" id="demo-reset" type="button" aria-label="이 주제를 처음부터 다시 하기">초기화</button>`);

// 쓰던 글이 저장될 시간을 조금 주고 나간다(입력은 잠깐 모았다가 저장되므로)
async function settle() { document.activeElement?.blur?.(); await new Promise((r) => setTimeout(r, 900)); flush(); }
$("#demo-home").onclick = async () => { await settle(); location.href = "demo.html"; };
$("#demo-reset").onclick = async () => {
  const name = await nameOf();
  if (!confirm(`${name ? `'${name}' ` : ""}체험을 처음부터 다시 할까요?\n\n지금까지 쓴 글과 대화가 모두 지워져요.`)) return;
  resetTopic(TOPIC);
  location.reload();
};

// 안내: 체험이라는 것, 저장 위치, AI 횟수. PC 넓은 화면은 머리글 가운데 한 줄(.demo-badge)로 보여 활동 자리를 차지하지 않고,
// 좁은 화면은 본문 위 띠(.demo-note)로 보여 준다(닫으면 이 기기에서는 다시 띄우지 않는다).
$(".brand")?.insertAdjacentHTML("afterend", `<div class="demo-badge" role="note">혼자 해 보는 체험 · 쓴 글은 이 기기에만 저장 · 인물 5번 · AI 도우미 5번까지 실제 AI</div>`);
const NOTE = "eps_demo_note";
let hidden = false; try { hidden = localStorage.getItem(NOTE) === "1"; } catch {}
if (!hidden) {
  const el = document.createElement("div");
  el.className = "demo-note"; el.setAttribute("role", "note");
  el.innerHTML = `<span><b>체험</b> 이 기기에만 저장 · AI는 인물·도우미 5번씩</span><button type="button" aria-label="안내 닫기">✕</button>`;
  el.querySelector("button").onclick = () => { el.remove(); try { localStorage.setItem(NOTE, "1"); } catch {} };
  $("#main")?.prepend(el);
}

// 'PC 화면으로 보기' ↔ '모바일 화면으로 보기' 링크가 체험 화면으로 가게 한다
document.querySelectorAll('a[href^="index.html"]').forEach((a) => { a.href = `demo-play.html?view=pc&t=${TOPIC}`; });
document.querySelectorAll('a[href^="m.html"]').forEach((a) => { a.href = `demo-play-m.html?view=m&t=${TOPIC}`; });

// '데모라서' 줄: 지금 보는 단계에서 실제 수업과 다른 점을 항상 보여 준다(닫을 수 없다).
// PC 넓은 화면은 펼친 채로, 좁은 화면(휴대폰)은 한 줄로 접어 두고 누르면 펼친다.
// 화면(app.js)이 단계를 바꿀 때마다 #panel 을 다시 그리므로, 바뀌면 맨 위에 다시 붙인다.
const DIFF = {
  "1-pick": "모둠 친구가 없어서 모든 인물을 고를 수 있어요. 실제 수업에서는 모둠원마다 다른 인물을 맡아요.",
  "1-chat": "인물에게 묻기는 주제마다 5번까지예요. 인물이 웹 검색을 하지 않고, 부적절한 말에 대한 경고 횟수·대화 멈춤·선생님 알림도 없어요.",
  "1-note": "혼자 정리하고, 선생님에게 제출되거나 확인받지 않아요. 실제 수업에서는 모둠원이 낸 글이 함께 보여요.",
  "1-group": "모둠 친구 없이 혼자 문제를 정해요. 실제 수업에서는 모둠원의 글과 입력 중 표시가 실시간으로 함께 보여요.",
  2: "AI 도우미(생각 도우미)는 5번까지예요. 모둠원과 함께 쓰는 실시간 입력, 선생님의 설정(도우미 켜기·끄기)은 없어요.",
  3: "AI 검색 도우미는 웹 검색 없이 수업 자료만 근거로 답하고, 5번까지예요(2~5단계 합쳐서 세요).",
  4: "AI 의견은 5번까지예요(2~5단계 AI 도우미 합쳐서). 모둠원과 함께 쓰는 실시간 입력, 선생님 알림은 없어요.",
  5: "미래 이야기는 5번까지예요(2~5단계 AI 도우미 합쳐서). 모둠원과 함께 쓰는 실시간 입력, 선생님 알림은 없어요.",
  6: "모둠 친구와 함께 쓰는 실시간 입력이 없고, 쓴 글이 선생님 화면으로 가지 않아요.",
  7: "모둠 친구와 함께 쓰는 실시간 입력이 없고, 쓴 글이 선생님 화면으로 가지 않아요.",
};
const panel = $("#panel");
function diffKey() {
  const stage = $("#tabs .stage-tab.on")?.dataset.stage;
  if (!stage) return null;
  if (stage !== "1") return stage;
  const sub = $(".subnav button.on")?.dataset.sub;
  return sub ? `1-${sub}` : null;
}
function showDiff() {
  if (!panel) return;
  const key = diffKey(), cur = panel.querySelector(":scope > .demo-diff");
  if (!key || !DIFF[key]) { cur?.remove(); return; }
  if (cur && cur.dataset.key === key && panel.firstElementChild === cur) return;
  cur?.remove();
  const wide = window.matchMedia("(min-width:1100px)").matches;
  panel.insertAdjacentHTML("afterbegin", `<details class="demo-diff" data-key="${key}" role="note" ${wide ? "open" : ""}><summary><span class="tag y">데모라서</span> <span class="dd-s">실제 수업과 다른 점</span></summary><span class="dd-t">${DIFF[key]}</span></details>`);
}
if (panel) {
  new MutationObserver(showDiff).observe(panel, { childList: true });
  new MutationObserver(showDiff).observe($("#tabs") || panel, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  showDiff();
}
