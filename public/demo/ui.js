// 체험 화면의 덧붙임: 머리글의 '홈'·'초기화' 단추, '체험' 표시, 안내 띠. 학생 화면(app.js)은 그대로 쓴다.
import { TOPIC, LEVEL, resetTopic, flush } from "./store.js";
import { runTour } from "../tour.js";

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

// 'PC 화면으로 보기' ↔ '모바일·태블릿 화면으로 보기' 링크가 체험 화면으로 가게 한다
const lv = LEVEL === "middle" ? "&lv=middle" : "";
document.querySelectorAll('a[href^="index.html"]').forEach((a) => { a.href = `demo-play.html?view=pc&t=${TOPIC}${lv}`; });
document.querySelectorAll('a[href^="m.html"]').forEach((a) => { a.href = `demo-play-m.html?view=m&t=${TOPIC}${lv}`; });
document.querySelectorAll('a[href^="t.html"]').forEach((a) => { a.href = `demo-play-t.html?view=t&t=${TOPIC}${lv}`; });

// 처음 체험을 시작한 사람에게 학생 화면 사용법을 짚어 준다(tour.js, 한 번만). 단계 안내 창이 먼저 뜨므로 그 창이 닫힌 뒤에 시작한다.
const TOUR = [
  { title: `${LEVEL === "middle" ? "중학교" : "고등학교"} 수업을 학생이 되어 해 봐요`, text: `<p>실제 수업과 같은 학생 화면이에요. 모둠 친구 없이 혼자 1~7단계를 해 보고, 쓴 글은 이 기기에만 저장돼요.</p><p>수업 전체 흐름과 중·고 차이는 <a href="guide.html" target="_blank" rel="noopener">수업 안내</a>에서 볼 수 있어요.</p>` },
  { el: "#tabs", title: "1~7단계", text: "<p>단계를 눌러 언제든 오갈 수 있어요. 마친 단계에는 체크가 붙어요.</p>" },
  { el: ".hero-next, #panel .next", title: "지금 할 일", text: "<p>지금 할 일 하나를 알려 주고, 할 곳을 파란 테두리와 한 줄 설명으로 짚어 줘요.</p>" },
  { el: "#help-btn", title: "단계 안내", text: "<p>단계마다 무엇을 어떻게 하는지 다시 보고 싶으면 <b>?</b>를 눌러요. 체험이 실제 수업과 다른 점도 함께 알려 줘요.</p>" },
  { el: "#demo-home", title: "홈 · 초기화", text: "<p><b>홈</b>은 주제와 학교급을 고르는 처음 화면으로, <b>초기화</b>는 이 주제를 처음부터 다시 하기예요.</p>" },
];
(async () => {
  for (let i = 0; i < 100 && !document.querySelector("#tabs .stage-tab"); i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 800)); // 단계 안내 창이 뜰 틈을 준다(뜨면 tour.js 가 닫힐 때까지 기다린다)
  runTour("demo-play", TOUR);
})();
