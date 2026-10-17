// 휴대폰으로 PC 화면(index.html, teacher.html)을 열면 모바일 전용 화면(m.html, m-teacher.html)으로 옮긴다.
//  - <head> 에서 바로 실행해 PC 화면이 그려지기 전에 옮긴다. 쿼리(?…)와 # 은 그대로 넘긴다.
//  - 휴대폰에서도 PC 화면을 쓰고 싶으면 ?view=pc 로 열면 되고, 이 기기에서는 그 선택을 기억한다(?view=m 으로 되돌림).
//  - 태블릿은 PC 화면이 이미 맞춰지므로 옮기지 않는다.
//  - 모바일 화면에서는 글을 입력하는 동안 아래쪽 이동 막대를 숨긴다(키보드 위 공간 확보).
//  - 모바일 화면에서는 아래로 스크롤하면 머리글·아래 막대를 숨기고 위로 스크롤하면 보인다(활동 공간 극대화).
//  - 모바일 화면에서 한 줄로 줄인 설명(.desc, .tip, p.meta-line)은 누르면 펼친다.
(function () {
  var me = document.currentScript;
  var target = me && me.getAttribute("data-mobile");
  var KEY = "eps_view";
  var get = function () { try { return localStorage.getItem(KEY); } catch (e) { return null; } };
  var set = function (v) { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch (e) {} };

  var pick = /[?&]view=(pc|m)(?:&|$)/.exec(location.search);
  if (pick) set(pick[1] === "pc" ? "pc" : null);
  var ua = navigator.userAgent || "";
  var phone = !!((navigator.userAgentData && navigator.userAgentData.mobile) || /iPhone|iPod|Android.+Mobile|Windows Phone|Mobi/i.test(ua));
  window.EPS_PHONE = phone;

  if (target && phone && get() !== "pc") {
    var q = location.search.replace(/([?&])view=(pc|m)(&|$)/, function (_, a, __, b) { return b ? a : ""; }).replace(/[?&]$/, "");
    location.replace(target + q + location.hash);
    return;
  }

  // 키보드가 올라오면 '보이는 화면'(visualViewport)이 줄어든다. 그 크기를 CSS 변수로 알려서
  // 대화 화면이 보이는 영역에 딱 맞게 하고(입력창이 키보드 바로 위에 붙는다), 화면이 위아래로 밀리지 않게 한다.
  var vv = window.visualViewport;
  if (vv) {
    var setVV = function () {
      var r = document.documentElement.style;
      r.setProperty("--vvh", vv.height + "px");
      r.setProperty("--vvt", vv.offsetTop + "px");
    };
    vv.addEventListener("resize", setVV);
    vv.addEventListener("scroll", setVV);
    setVV();
  }

  document.addEventListener("DOMContentLoaded", function () {
    // PC 화면을 고른 휴대폰에는 모바일 화면으로 돌아가는 링크를 보여 준다
    var back = document.getElementById("to-mobile");
    if (back && phone) back.classList.remove("hidden");
    if (!document.body.classList.contains("m")) return;
    var isText = function (el) { return el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !/checkbox|radio|button|submit/.test(el.type))); };
    document.addEventListener("focusin", function (e) {
      if (!isText(e.target)) return;
      document.body.classList.add("typing");
      // 대화 화면에서는 키보드가 올라올 때 브라우저가 화면을 밀어 올리지 않도록 맨 위로 되돌린다
      if (document.body.classList.contains("chat-mode")) setTimeout(function () { window.scrollTo(0, 0); }, 50);
    });
    document.addEventListener("focusout", function () {
      setTimeout(function () { if (!isText(document.activeElement)) document.body.classList.remove("typing"); }, 50);
    });
    // 아래로 스크롤하면 머리글·아래 막대를 숨겨 활동 공간을 넓히고, 위로 스크롤하면 다시 보여 준다(맨 위 근처에서는 항상 보임).
    // (교사 화면은 아래 메뉴를 자주 쓰므로 숨기지 않는다)
    var lastY = window.scrollY, tick = false, teacher = document.body.classList.contains("m-teacher");
    window.addEventListener("scroll", function () {
      if (tick || teacher) return; tick = true;
      requestAnimationFrame(function () {
        tick = false;
        var b = document.body, y = window.scrollY, d = y - lastY;
        if (b.classList.contains("typing") || b.classList.contains("modal-open")) { lastY = y; return; }
        if (y < 80) { b.classList.remove("chrome-hidden"); lastY = y; }
        else if (d > 12) { b.classList.add("chrome-hidden"); lastY = y; }
        else if (d < -12) { b.classList.remove("chrome-hidden"); lastY = y; }
      });
    }, { passive: true });
    // 한 줄로 줄여 둔 설명·안내는 누르면 펼치고 다시 누르면 접는다. 화면을 다시 그려도 펼친 것은 펼친 채로 둔다.
    var FOLD = ".desc, .tip, p.meta-line", opened = {};
    document.addEventListener("click", function (e) {
      if (e.target.closest("a, button, input, select, textarea, label")) return;
      var el = e.target.closest(FOLD); if (!el) return;
      var on = el.classList.toggle("open");
      opened[el.textContent] = on;
    });
    new MutationObserver(function () {
      document.querySelectorAll(FOLD).forEach(function (el) { if (opened[el.textContent] && !el.classList.contains("open")) el.classList.add("open"); });
    }).observe(document.body, { childList: true, subtree: true });
  });
})();
