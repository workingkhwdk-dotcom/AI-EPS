// 체험 화면의 덧붙임: 머리글의 '홈'·'초기화' 단추, '체험' 표시, 안내 띠. 학생 화면(app.js)은 그대로 쓴다.
import { TOPIC, LEVEL, resetTopic, flush } from "./store.js";

const $ = (s) => document.querySelector(s);
const right = $(".hdr-right");
const nameOf = async () => { try { return (await (await fetch("demo/topics.json")).json()).find((t) => t.id === TOPIC)?.title || ""; } catch { return ""; } };

// 머리글: 학교 이름 줄 옆에 '체험' 표시, 오른쪽에 홈·초기화
$(".logo")?.insertAdjacentHTML("beforeend", `<em>${LEVEL === "middle" ? "중학교 체험" : "고등학교 체험"}</em>`);
right?.insertAdjacentHTML("afterbegin",
  `<button class="btn-out" id="demo-home" type="button" aria-label="주제 고르는 처음 화면으로">홈</button><button class="btn-out" id="demo-reset" type="button" aria-label="이 주제를 처음부터 다시 하기">초기화</button>`);

// 쓰던 글이 저장될 시간을 조금 주고 나간다(입력은 잠깐 모았다가 저장되므로)
async function settle() { document.activeElement?.blur?.(); await new Promise((r) => setTimeout(r, 900)); flush(); }
$("#demo-home").onclick = async () => { await settle(); location.href = "demo.html"; };
$("#demo-reset").onclick = async () => {
  const name = await nameOf();
  if (!confirm(`${name ? `'${name}' ` : ""}체험을 처음부터 다시 할까요?\n\n지금까지 쓴 글과 대화가 모두 지워져요.`)) return;
  resetTopic(TOPIC, LEVEL);
  location.reload();
};

// 안내: 체험이라는 것, 저장 위치, 체험용 AI. (단계마다 실제 수업과 다른 점은 단계 안내 팝업이 알려 준다: boot.js) PC 넓은 화면은 머리글 가운데 한 줄(.demo-badge)로 보여 활동 자리를 차지하지 않고,
// 좁은 화면은 본문 위 띠(.demo-note)로 보여 준다(닫으면 이 기기에서는 다시 띄우지 않는다).
$(".brand")?.insertAdjacentHTML("afterend", `<div class="demo-badge" role="note">혼자 해 보는 가상 수업 · 쓴 글은 이 기기에만 저장 · 체험용 AI(실제 수업은 더 고성능 AI)</div>`);
const NOTE = "eps_demo_note";
let hidden = false; try { hidden = localStorage.getItem(NOTE) === "1"; } catch {}
if (!hidden) {
  const el = document.createElement("div");
  el.className = "demo-note"; el.setAttribute("role", "note");
  el.innerHTML = `<span><b>체험</b> 가상 수업 · 이 기기에만 저장 · 체험용 AI</span><button type="button" aria-label="안내 닫기">✕</button>`;
  el.querySelector("button").onclick = () => { el.remove(); try { localStorage.setItem(NOTE, "1"); } catch {} };
  $("#main")?.prepend(el);
}

// 'PC 화면으로 보기' ↔ '모바일 화면으로 보기' 링크가 체험 화면으로 가게 한다
const lv = LEVEL === "middle" ? "&lv=middle" : "";
document.querySelectorAll('a[href^="index.html"]').forEach((a) => { a.href = `demo-play.html?view=pc&t=${TOPIC}${lv}`; });
document.querySelectorAll('a[href^="m.html"]').forEach((a) => { a.href = `demo-play-m.html?view=m&t=${TOPIC}${lv}`; });
