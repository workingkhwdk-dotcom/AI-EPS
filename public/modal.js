// 학생·교사 화면이 함께 쓰는 알림 창. 가운데에 뜨고(휴대폰에서는 아래에서 올라온다), 버튼을 눌러야 닫힌다.
//   showModal({ title, body, actions: [{ label, value, kind, disabled }], dismissible })
//   → 누른 버튼의 value 로 풀리는 Promise. dismissible 이면 바깥을 누르거나 Esc 로 닫을 수 있고 그때는 null.
// title 과 body 는 HTML 이므로 사용자 입력은 호출하는 쪽에서 esc() 로 감싼다.
let open = null;

export function showModal({ title, body = "", actions = [], dismissible = false, wide = false, grid = false }) {
  open?.(null); // 한 번에 하나만
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `<div class="modal${wide ? " wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="mdl-t" tabindex="-1">
      <h3 id="mdl-t">${title}</h3><div class="modal-body">${body}</div>
      <div class="modal-acts${grid ? " grid" : ""}">${actions.map((a, i) => `<button type="button" class="btn ${a.kind || "btn-plain"}" data-i="${i}" ${a.disabled ? "disabled" : ""}>${a.label}</button>`).join("")}</div></div>`;
    document.body.appendChild(back);
    document.body.classList.add("modal-open");
    const box = back.querySelector(".modal");
    const done = (v) => {
      if (open !== done) return;
      open = null;
      document.removeEventListener("keydown", onKey, true);
      back.remove();
      document.body.classList.remove("modal-open");
      try { prevFocus?.focus?.(); } catch {}
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === "Escape" && dismissible) { e.preventDefault(); done(null); return; }
      if (e.key !== "Tab") return;
      const f = [...box.querySelectorAll("button:not([disabled]), a[href], input, select, textarea")];
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    };
    open = done;
    document.addEventListener("keydown", onKey, true);
    back.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-i]");
      if (b && box.contains(b)) return done(actions[Number(b.dataset.i)].value);
      if (e.target === back && dismissible) done(null);
    });
    (box.querySelector(".btn-primary") || box.querySelector("button:not([disabled])") || box).focus();
  });
}

// 예/아니요 확인 창
export const confirmModal = (title, body, yes = "확인", no = "취소", danger = false) =>
  showModal({ title, body, dismissible: true, actions: [{ label: yes, value: true, kind: danger ? "btn-danger" : "btn-primary" }, { label: no, value: false }] }).then((v) => v === true);
