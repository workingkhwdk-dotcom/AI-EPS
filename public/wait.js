// 기다리는 동안 "멈춘 게 아니라 일하는 중"임을 보여 주는 표시.
//  - 움직이는 점·막대, 흐르는 시간(초), 시간이 지날수록 바뀌는 안내 문구
//  - 서버 연결이 살아 있다는 안내, 너무 오래 걸릴 때의 안내
// 화면이 다시 그려져도 시간이 이어지도록 시작 시각(since)을 바깥에서 넘긴다.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// 기본 안내: [몇 초부터, 문구]
export const STEPS = {
  chat: [[0, "인물이 답을 생각하는 중이에요"], [8, "자료를 확인하고 있어요. 모르는 내용은 찾아보느라 조금 더 걸릴 수 있어요"], [25, "평소보다 오래 걸리고 있어요. 서버는 일하는 중이니 조금만 더 기다려 주세요"], [70, "아직 답이 오지 않았어요. 최대 5분까지 기다리고, 그래도 안 오면 오류로 알려 드려요. 화면을 닫지 마세요"]],
  ai: [[0, "AI가 답을 만드는 중이에요"], [10, "생각을 정리하는 중이에요"], [30, "평소보다 오래 걸리고 있어요. 서버는 일하는 중이니 조금만 더 기다려 주세요"], [90, "아직 답이 오지 않았어요. 최대 5분까지 기다리고, 그래도 안 오면 오류로 알려 드려요. 화면을 닫지 마세요"]],
  join: [[0, "입장하는 중이에요"], [4, "내 자리를 준비하고 있어요"], [10, "조금 오래 걸리고 있어요. 여러 친구가 함께 들어오는 중일 수 있어요"], [25, "아직 입장하지 못했어요. 연결을 확인하고, 계속 안 되면 선생님께 알려 주세요"]],
  load: [[0, "불러오는 중이에요"], [10, "조금 오래 걸리고 있어요. 서버는 일하는 중이에요"], [40, "아직 답이 오지 않았어요. 연결을 확인해 주세요"]],
};

// opts: { steps: [[sec, text]], first: 첫 문구 바꾸기, since: 시작 시각(ms), compact: 작은 한 줄 }
export function waitHtml({ steps = STEPS.ai, first, since = Date.now(), compact = false } = {}) {
  const st = first ? [[0, first], ...steps.filter(([t]) => t > 0)] : steps;
  const secs = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const msg = [...st].reverse().find(([t]) => secs >= t)?.[1] ?? st[0][1];
  return `<div class="wait${compact ? " compact" : ""}" role="status" aria-live="polite" data-since="${since}" data-steps="${esc(JSON.stringify(st))}">
    <div class="wait-anim" aria-hidden="true"><span class="ring"></span><i></i><i></i><i></i></div>
    <div class="wait-text"><div class="wait-msg">${esc(msg)}</div>
      <div class="wait-sub"><span class="wait-sec">${secs}</span>초째 · 연결은 살아 있어요</div>
      ${compact ? "" : `<div class="wait-bar" aria-hidden="true"><b></b></div>`}</div></div>`;
}

// 화면에 있는 모든 대기 표시의 시간·문구를 갱신한다(1초마다)
export function tickWaits(root = document) {
  const now = Date.now();
  root.querySelectorAll(".wait[data-since]").forEach((el) => {
    const secs = Math.max(0, Math.floor((now - Number(el.dataset.since)) / 1000));
    const sec = el.querySelector(".wait-sec"); if (sec && sec.textContent !== String(secs)) sec.textContent = String(secs);
    let steps; try { steps = JSON.parse(el.dataset.steps); } catch { return; }
    const msg = [...steps].reverse().find(([t]) => secs >= t)?.[1];
    const m = el.querySelector(".wait-msg"); if (m && msg && m.textContent !== msg) m.textContent = msg;
    el.classList.toggle("slow", secs >= (steps[2]?.[0] ?? 30));
  });
}
let timer = null;
export function startWaitTicker() { if (!timer) timer = setInterval(() => tickWaits(), 1000); }
