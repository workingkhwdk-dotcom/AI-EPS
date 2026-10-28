// 처음 들어온 사람에게 화면 사용법을 차례로 짚어 주는 안내(교사 화면·체험 화면).
//   runTour(key, steps, { force }) → 끝나거나 건너뛰면 풀리는 Promise. 이미 본 안내는 force 없이는 띄우지 않는다.
//   steps: [{ el: 선택자(없으면 화면 가운데 카드), title, text(HTML) }]  보이지 않는 칸을 가리키는 단계는 건너뛴다.
//   선택자가 여러 곳에 맞으면(예: PC 머리말과 휴대폰 띠) 그중 보이는 첫 칸을 짚는다.
// 띄운 안내는 이 기기에 기억해(eps_tour_<key>) 다시 띄우지 않는다(끝까지 보지 않고 닫아도). '사용법 다시 보기'는 force 로 부른다.
// 다른 창(.modal)이 떠 있으면 닫힐 때까지 기다렸다가 시작한다.
const KEY = (k) => `eps_tour_${k}`;
export const tourSeen = (k) => { try { return localStorage.getItem(KEY(k)) === "1"; } catch { return false; } };
const markSeen = (k) => { try { localStorage.setItem(KEY(k), "1"); } catch {} };
const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
// 선택자에 맞는 칸 가운데 보이는 첫 칸
const find = (sel) => (sel ? [...document.querySelectorAll(sel)].find(visible) || null : null);
const waitNoModal = () => new Promise((r) => { const t = setInterval(() => { if (!document.querySelector(".modal-back")) { clearInterval(t); r(); } }, 250); if (!document.querySelector(".modal-back")) { clearInterval(t); r(); } });

// 안내는 한 번에 하나씩: 앞 안내가 끝나면 다음 안내가 이어진다(예: 교사 화면 안내 → 수업 화면 안내)
let queue = Promise.resolve();
export function runTour(key, steps, { force = false } = {}) {
  const job = queue.then(async () => {
    if (!force && tourSeen(key)) return;
    await waitNoModal();
    if (await play(steps)) markSeen(key); // 짚을 칸이 하나도 보이지 않아 띄우지 못했으면 다음에 다시
  });
  queue = job.catch(() => {});
  return job;
}

function play(steps) {
  return new Promise((resolve) => {
    const list = steps.filter((s) => !s.el || find(s.el));
    // 짚을 칸이 하나도 안 보이면(예: 그 화면을 이미 떠남) 띄우지 않는다
    if (!list.length || (list.every((s) => !s.el) && steps.some((s) => s.el))) return resolve(false);
    const prevFocus = document.activeElement;
    const root = document.createElement("div");
    root.className = "tour";
    root.innerHTML = `<div class="tour-hole" aria-hidden="true"></div>
      <div class="tour-tip" role="dialog" aria-modal="true" aria-labelledby="tour-t" aria-describedby="tour-b">
        <div class="tour-top"><span class="tour-n" aria-live="polite"></span><button type="button" class="tour-x" data-t="skip" aria-label="안내 닫기">✕</button></div>
        <h3 id="tour-t"></h3><div class="tour-b" id="tour-b"></div>
        <div class="tour-acts"><button type="button" class="btn btn-plain btn-sm" data-t="prev">이전</button><button type="button" class="btn btn-primary btn-sm" data-t="next">다음</button></div></div>`;
    document.body.appendChild(root);
    const hole = root.querySelector(".tour-hole"), tip = root.querySelector(".tour-tip");
    let i = 0;
    const place = () => {
      const s = list[i], el = find(s.el);
      const narrow = innerWidth < 600;
      tip.classList.toggle("center", !el);
      root.classList.toggle("spot", !!el);
      if (!el) { hole.style.cssText = "display:none"; tip.style.cssText = ""; return; }
      const r = el.getBoundingClientRect(), pad = 6;
      hole.style.cssText = `display:block;top:${r.top - pad}px;left:${r.left - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px`;
      if (narrow) { tip.style.cssText = r.top > innerHeight / 2 ? "top:12px;bottom:auto" : "bottom:12px;top:auto"; return; }
      const tw = Math.min(360, innerWidth - 24), th = tip.offsetHeight || 180;
      const below = r.bottom + 12 + th < innerHeight || r.top - 12 - th < 0;
      const top = below ? Math.min(r.bottom + 12, innerHeight - th - 12) : Math.max(12, r.top - 12 - th);
      const left = Math.max(12, Math.min(r.left, innerWidth - tw - 12));
      tip.style.cssText = `top:${top}px;left:${left}px;width:${tw}px`;
    };
    const show = () => {
      const s = list[i], el = find(s.el);
      root.querySelector(".tour-n").textContent = `${i + 1} / ${list.length}`;
      root.querySelector("#tour-t").textContent = s.title;
      root.querySelector(".tour-b").innerHTML = s.text;
      root.querySelector('[data-t="prev"]').style.display = i === 0 ? "none" : ""; // .btn 의 display 가 hidden 속성보다 앞서므로 직접 감춘다
      root.querySelector('[data-t="next"]').textContent = i === list.length - 1 ? "시작하기" : "다음";
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.top < 70 || r.bottom > innerHeight - 40) el.scrollIntoView({ block: "center" });
      }
      place();
      root.querySelector('[data-t="next"]').focus();
    };
    const end = () => {
      removeEventListener("resize", place); removeEventListener("scroll", place, true); document.removeEventListener("keydown", onKey, true);
      root.remove();
      try { prevFocus?.focus?.(); } catch {}
      resolve(true);
    };
    const go = (d) => { const n = i + d; if (n < 0) return; if (n >= list.length) return end(); i = n; show(); };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); end(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
      else if (e.key === "Tab") { // 안내 창 안에서만 돈다
        const f = [...tip.querySelectorAll("button")].filter((b) => b.style.display !== "none");
        const k = f.indexOf(document.activeElement);
        if (e.shiftKey && k <= 0) { e.preventDefault(); f.at(-1).focus(); }
        else if (!e.shiftKey && k === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    };
    root.addEventListener("click", (e) => {
      const b = e.target.closest("[data-t]"); if (!b) return;
      if (b.dataset.t === "skip") end(); else go(b.dataset.t === "next" ? 1 : -1);
    });
    addEventListener("resize", place); addEventListener("scroll", place, true); document.addEventListener("keydown", onKey, true);
    show();
  });
}
