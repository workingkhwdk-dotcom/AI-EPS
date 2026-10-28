// 기기에 맞는 화면으로 옮긴다: 휴대폰은 모바일 화면(m.html, m-teacher.html), 태블릿은 태블릿 화면(t.html, t-teacher.html), 그 밖은 PC 화면.
//  - 페이지가 <script src="device.js" data-mobile="…" data-tablet="…"> 로 다른 화면의 주소를 알려 준다. 적지 않은 쪽으로는 옮기지 않는다.
//  - <head> 에서 바로 실행해 화면이 그려지기 전에 옮긴다. 쿼리(?…)와 # 은 그대로 넘긴다.
//  - ?view=pc|m|t 로 열면 그 화면을 고른 것으로 보고 이 탭에서 기억한다(아래쪽 '○○ 화면으로 보기' 링크가 쓴다).
//  - 모바일 화면에서는 글을 입력하는 동안 아래쪽 이동 막대를 숨긴다(키보드 위 공간 확보).
//  - 모바일 화면에서는 아래로 스크롤하면 머리글·아래 막대를 숨기고 위로 스크롤하면 보인다(활동 공간 극대화).
//  - 모바일 화면에서 한 줄로 줄인 설명(.desc, .tip, p.meta-line)은 누르면 펼친다.
(function () {
  var me = document.currentScript;
  var attr = function (n) { return me && me.getAttribute(n); };
  var KEY = "eps_view";
  // 'PC 화면으로 보기' 선택은 이 탭에서만 기억한다(실수로 눌러도 탭을 닫고 다시 열면 모바일 화면으로 돌아온다)
  var get = function () { try { return sessionStorage.getItem(KEY); } catch (e) { return null; } };
  var set = function (v) { try { v ? sessionStorage.setItem(KEY, v) : sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); } catch (e) {} };

  var pick = /[?&]view=(pc|m|t)(?:&|$)/.exec(location.search);
  if (pick) set(pick[1]);
  var ua = navigator.userAgent || "";
  // '데스크톱 사이트 요청'이나 앱 안 브라우저처럼 UA 에 휴대폰 표시가 없어도, 손가락으로 쓰는 작은 화면이면 휴대폰으로 본다
  var small = false;
  try { small = !!(window.matchMedia && matchMedia("(pointer:coarse)").matches && Math.min(screen.width, screen.height) <= 600); } catch (e) {}
  // 아이패드 사파리의 UA 에도 'Mobile/…'이 들어 있으므로 태블릿 표시가 있으면 휴대폰으로 보지 않는다
  var tabletUA = /iPad|Tablet|PlayBook|Silk|Kindle/i.test(ua);
  var phone = !tabletUA && !!((navigator.userAgentData && navigator.userAgentData.mobile) || /iPhone|iPod|Android.+Mobile|Windows Phone|Mobi/i.test(ua) || small);
  // 태블릿: 아이패드(요즘 아이패드는 맥처럼 알리므로 터치 지점 수로 가린다), '휴대폰' 표시가 없는 안드로이드, 손가락으로 쓰는 큰 화면
  var coarseBig = false;
  try { coarseBig = !!(window.matchMedia && matchMedia("(pointer:coarse)").matches && Math.min(screen.width, screen.height) > 600); } catch (e) {}
  var tablet = !phone && !!(tabletUA || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) || (/Android/i.test(ua) && !/Mobile/i.test(ua)) || coarseBig);
  window.EPS_PHONE = phone; window.EPS_TABLET = tablet;

  // 고른 화면이 있으면 그것, 없으면 기기에 맞는 화면. 그 화면의 주소를 이 페이지가 알려 줬으면 옮긴다(예전에 고른 'm'은 기기대로 본다)
  var choice = get();
  var want = choice === "pc" || choice === "t" ? choice : phone ? "m" : tablet ? "t" : "pc";
  var target = want === "m" ? attr("data-mobile") : want === "t" ? attr("data-tablet") : null;
  if (target) {
    var q = location.search.replace(/([?&])view=(pc|m|t)(&|$)/, function (_, a, __, b) { return b ? a : ""; }).replace(/[?&]$/, "");
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
    // PC 화면을 고른 휴대폰·태블릿에는 그 기기 화면으로 돌아가는 링크를 보여 준다
    var back = document.getElementById("to-mobile");
    if (back && phone) back.classList.remove("hidden");
    var backT = document.getElementById("to-tablet");
    if (backT && tablet) backT.classList.remove("hidden");
    var isT = document.body.classList.contains("t");
    if (!document.body.classList.contains("m") && !isT) return;
    // 태블릿: 머리글 높이를 CSS 변수(--hdr-h)로 알려 단계 막대·옆 막대가 머리글 바로 아래에 붙게 한다(화면을 돌리면 다시 잰다)
    var hdr = isT && document.querySelector(".hdr");
    if (hdr) {
      var setH = function () { document.documentElement.style.setProperty("--hdr-h", hdr.offsetHeight + "px"); };
      setH();
      if (window.ResizeObserver) new ResizeObserver(setH).observe(hdr); else window.addEventListener("resize", setH);
    }
    var isText = function (el) { return el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !/checkbox|radio|button|submit/.test(el.type))); };
    document.addEventListener("focusin", function (e) {
      if (!isText(e.target)) return;
      document.body.classList.add("typing");
      // 대화 입력창은 화면 아래에 붙어 있어 따로 끌어올리지 않는다
      if (document.body.classList.contains("chat-mode")) return;
      // 다른 화면: 키보드가 다 올라온 뒤, 쓰고 있는 칸(위의 칸 이름까지)을 보이는 화면 위쪽으로 끌어올린다
      setTimeout(function () { showField(e.target); }, 320);
    });
    // 쓰고 있는 칸이 키보드에 가리면, 칸 이름이 보이는 화면 맨 위 근처에 오도록 스크롤한다
    var showField = function (el) {
      if (!el || document.activeElement !== el || document.body.classList.contains("chat-mode")) return;
      var lbl = el.previousElementSibling && el.previousElementSibling.matches("label") ? el.previousElementSibling : el;
      var top = lbl.getBoundingClientRect().top, bottom = el.getBoundingClientRect().bottom;
      var viewH = vv ? vv.height : window.innerHeight, viewTop = vv ? vv.offsetTop : 0;
      if (top - viewTop >= 8 && bottom - viewTop <= viewH - 8) return; // 이미 다 보이면 그대로
      window.scrollBy({ top: top - viewTop - 12, behavior: "smooth" });
    };
    // 키보드 높이가 바뀌면(예측 단어 줄이 생기는 등) 한 번 더 맞춘다
    if (vv) vv.addEventListener("resize", function () { var a = document.activeElement; if (isText(a)) showField(a); });
    document.addEventListener("focusout", function () {
      setTimeout(function () { if (!isText(document.activeElement)) document.body.classList.remove("typing"); }, 50);
    });
    // 아래로 스크롤하면 머리글·아래 막대를 숨겨 활동 공간을 넓히고, 위로 스크롤하면 다시 보여 준다(맨 위 근처에서는 항상 보임).
    // (교사 화면은 아래 메뉴를 자주 쓰므로 숨기지 않는다)
    if (isT) return; // 태블릿: 입력 중 표시(typing)와 칸 끌어올리기까지만 쓴다(머리글은 숨기지 않는다)
    var lastY = window.scrollY, tick = false, teacher = document.body.classList.contains("m-teacher");
    window.addEventListener("scroll", function () {
      if (tick || teacher) return; tick = true;
      requestAnimationFrame(function () {
        tick = false;
        var b = document.body, y = window.scrollY, d = y - lastY;
        // 맨 위 근처에서는 항상 보인다. 창이 떠 있거나 입력 중에 화면이 맨 위로 옮겨 가도(예: 인물을 고르면 대화 화면 맨 위로 간다)
        // 숨긴 채로 남지 않게, 이 확인을 먼저 한다(맨 위에서는 더 올릴 수 없어 다시 꺼낼 방법이 없다).
        if (y < 80) { b.classList.remove("chrome-hidden"); lastY = y; return; }
        if (b.classList.contains("typing") || b.classList.contains("modal-open")) { lastY = y; return; }
        if (d > 12) { b.classList.add("chrome-hidden"); lastY = y; }
        else if (d < -12) { b.classList.remove("chrome-hidden"); lastY = y; }
      });
    }, { passive: true });
  });
})();
