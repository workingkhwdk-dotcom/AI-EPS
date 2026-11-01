// 단계 시간(수업 시계): 교사가 반 전체의 단계와 남은 시간을 정한다(서버 functions/clock.js, 수업 문서의 clock).
// 이 파일은 남은 시간 계산과 학생 화면의 시간 표시를 맡는다.
//  - 단계에 들어가면 주어진 시간이 크게 떴다가 사라지고(팝업),
//  - 남은 시간이 5분 단위(25·20·15·10·5분)를 지날 때마다 펄스와 함께 화면 위에 겹쳐 떴다가 사라지며,
//  - 1분이 남으면 초 단위 카운트다운이 화면 위쪽에 보인다. 시간이 끝나면 알리기만 하고, 넘어가는 것은 선생님이 정한다.
//  - 머리글의 시간 칩은 늘 남은 시간을 보여 주고, 누르면 지금 단계의 시간을 다시 띄운다.

// 기본 시간(분): 수업지도안의 배분. 서버 functions/clock.js 의 STAGE_MIN_DEFAULT 와 같게 둔다.
export const STAGE_MIN_DEFAULT = { 1: 30, 2: 20, 3: 20, 4: 25, 5: 20, 6: 10, 7: 20 };
const MIN = 60 * 1000;

// 남은 시간(ms, 지나면 음수). off: 서버 시각 - 이 기기 시각. 시계가 없으면 null.
export function leftOf(clock, off = 0) {
  if (!clock?.stage) return null;
  if (clock.endsAt == null) return clock.left ?? 0;
  return clock.endsAt - (Date.now() + off);
}
// 12:34 꼴(지나면 0:00)
export function mmss(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
// 'N분' 꼴(1분이 안 되면 '1분 안')
export const minText = (ms) => (ms >= MIN ? `${Math.ceil(ms / MIN)}분` : ms > 0 ? "1분 안" : "0분");
const totalMin = (c) => (c?.min || 0) + (c?.add || 0);

// 서버 시각과 이 기기 시각의 차이를 잰다. 요청을 보낸 때와 받은 때의 가운데를 서버가 답한 순간으로 본다.
export function offsetFrom(serverNow, sentAt, gotAt = Date.now()) {
  return typeof serverNow === "number" ? serverNow - Math.round((sentAt + gotAt) / 2) : 0;
}

// ---------- 학생 화면 ----------
// stageName(n): 단계 이름, esc: HTML 이스케이프, toast: 짧은 알림, mountChip(el): 머리글에 칩을 붙이는 곳
export function studentClock({ stageName, esc, toast, mountChip }) {
  let clock = null, off = 0, lastT = null, lastLeft = null, ended = false, tick = null, hideTimer = null;

  const chip = document.createElement("button");
  chip.type = "button"; chip.id = "clock-chip"; chip.className = "btn-out clock-chip hidden";
  chip.onclick = () => intro(true);
  mountChip(chip);

  const layer = document.createElement("div");
  layer.id = "clock-layer"; layer.className = "clk-layer hidden"; layer.setAttribute("role", "status"); layer.setAttribute("aria-live", "assertive");
  layer.onclick = hide;
  document.body.append(layer);

  const cd = document.createElement("div");
  cd.id = "clock-cd"; cd.className = "clk-cd hidden"; cd.setAttribute("aria-hidden", "true");
  document.body.append(cd);

  function show(kind, html, ms = 3200) {
    clearTimeout(hideTimer);
    layer.className = `clk-layer clk-${kind}`;
    layer.innerHTML = `<div class="clk-card"><span class="clk-ring"></span><span class="clk-ring r2"></span>${html}</div>`;
    void layer.offsetWidth; layer.classList.add("on");
    hideTimer = setTimeout(hide, ms);
  }
  function hide() {
    clearTimeout(hideTimer);
    if (layer.classList.contains("hidden")) return;
    layer.classList.remove("on"); layer.classList.add("out");
    hideTimer = setTimeout(() => { layer.className = "clk-layer hidden"; layer.innerHTML = ""; }, 450);
  }
  const head = () => `<div class="clk-stage">${clock.stage}단계 · ${esc(stageName(clock.stage))}</div>`;
  // 단계에 들어왔을 때(또는 칩을 눌렀을 때): 이 단계에 주어진 시간과 남은 시간
  function intro(again = false) {
    if (!clock) return;
    const left = leftOf(clock, off), tot = totalMin(clock);
    const fresh = !again && clock.ev === "go" && left > (tot - 0.5) * MIN;
    const big = fresh ? `${tot}분` : left > 0 ? mmss(left) : "0:00";
    const sub = fresh ? "이 단계에 주어진 시간이에요"
      : clock.endsAt == null ? `선생님이 시간을 잠깐 멈췄어요 · 주어진 시간 ${tot}분`
      : left > 0 ? `남은 시간 · 주어진 시간 ${tot}분` : "시간이 끝났어요. 선생님 안내를 기다려요";
    show("intro", `${head()}<div class="clk-big">${big}</div><div class="clk-sub">${esc(sub)}</div>`, 4000);
  }
  function mark(min) {
    show("mark", `${head()}<div class="clk-big">${min}분</div><div class="clk-sub">남았어요</div>`, 2600);
  }

  function frame() {
    if (!clock) return;
    const left = leftOf(clock, off), running = clock.endsAt != null;
    // 5분 단위를 지나는 순간(처음 받은 시간 그 자체는 빼고) 한 번 띄운다. 화면이 꺼져 있다 켜지는 등 크게 건너뛰면 띄우지 않는다.
    if (running && lastLeft != null && lastLeft - left < 15000) {
      const b = Math.floor((lastLeft - 1) / (5 * MIN)) * 5 * MIN; // lastLeft 아래의 가장 큰 5분 단위
      if (b > 0 && left <= b && b < totalMin(clock) * MIN) mark(b / MIN);
    }
    lastLeft = running ? left : null;
    // 시간 끝: 한 번 알린다(계속 쓸 수 있다)
    if (running && left <= 0 && !ended) {
      ended = true;
      show("end", `${head()}<div class="clk-big">시간 끝</div><div class="clk-sub">선생님 안내를 기다려요. 쓰던 것은 계속 쓸 수 있어요</div>`, 4000);
      try { navigator.vibrate?.([60, 80, 60]); } catch {}
    }
    if (left > 0) ended = false;
    // 머리글 칩
    chip.classList.remove("hidden");
    chip.classList.toggle("warn", left <= MIN);
    chip.classList.toggle("over", left <= 0);
    chip.textContent = !running ? `⏸ ${mmss(left)}` : left <= 0 ? "⏱ 시간 끝" : left <= MIN ? `⏱ ${mmss(left)}` : `⏱ ${minText(left)}`;
    chip.setAttribute("aria-label", `${clock.stage}단계 남은 시간 ${left > 0 ? mmss(left) : "없음"}${running ? "" : " (멈춤)"}. 누르면 크게 보기`);
    // 1분 이하: 초 단위 카운트다운
    const showCd = running && left > 0 && left <= MIN;
    cd.classList.toggle("hidden", !showCd);
    if (showCd) {
      const s = Math.ceil(left / 1000);
      if (cd.dataset.s !== String(s)) {
        cd.dataset.s = String(s);
        cd.classList.toggle("last", s <= 10);
        cd.innerHTML = `<span class="clk-cd-k">남은 시간</span><b>${s}</b><span class="clk-cd-u">초</span><svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17" pathLength="60" style="stroke-dashoffset:${60 - s}"/></svg>`;
        cd.classList.remove("beat"); void cd.offsetWidth; cd.classList.add("beat");
      }
    } else cd.dataset.s = "";
  }

  return {
    setOffset(o) { off = o || 0; },
    // 수업 문서의 clock 이 바뀔 때마다 부른다. 새 조작(t)이면 그에 맞게 띄운다.
    update(c) {
      const next = c?.stage ? c : null;
      const isNew = !!next && next.t !== lastT, first = lastT === null;
      clock = next; lastT = next ? next.t : lastT;
      if (!clock) { clearInterval(tick); tick = null; chip.classList.add("hidden"); cd.classList.add("hidden"); hide(); lastLeft = null; return; }
      if (!tick) tick = setInterval(frame, 250);
      if (isNew) {
        lastLeft = null; ended = leftOf(clock, off) <= 0;
        if (first || clock.ev === "go") intro();
        else if (clock.ev === "add") show("add", `${head()}<div class="clk-big">+${clock.addNow || ""}분</div><div class="clk-sub">시간이 늘었어요 · 남은 시간 ${esc(minText(leftOf(clock, off)))}</div>`, 3000);
        else if (clock.ev === "pause") toast("선생님이 시간을 잠깐 멈췄어요 ⏸");
        else if (clock.ev === "resume") toast("시간이 다시 흘러요 ⏱");
      }
      frame();
    },
    intro: () => intro(true),
  };
}
