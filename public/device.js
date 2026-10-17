// 휴대폰으로 PC 화면(index.html, teacher.html)을 열면 모바일 전용 화면(m.html, m-teacher.html)으로 옮긴다.
//  - <head> 에서 바로 실행해 PC 화면이 그려지기 전에 옮긴다. 쿼리(?…)와 # 은 그대로 넘긴다.
//  - 휴대폰에서도 PC 화면을 쓰고 싶으면 ?view=pc 로 열면 되고, 이 기기에서는 그 선택을 기억한다(?view=m 으로 되돌림).
//  - 태블릿은 PC 화면이 이미 맞춰지므로 옮기지 않는다.
//  - 모바일 화면에서는 글을 입력하는 동안 아래쪽 이동 막대를 숨긴다(키보드 위 공간 확보).
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

  document.addEventListener("DOMContentLoaded", function () {
    // PC 화면을 고른 휴대폰에는 모바일 화면으로 돌아가는 링크를 보여 준다
    var back = document.getElementById("to-mobile");
    if (back && phone) back.classList.remove("hidden");
    if (!document.body.classList.contains("m")) return;
    var isText = function (el) { return el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !/checkbox|radio|button|submit/.test(el.type))); };
    document.addEventListener("focusin", function (e) { if (isText(e.target)) document.body.classList.add("typing"); });
    document.addEventListener("focusout", function () {
      setTimeout(function () { if (!isText(document.activeElement)) document.body.classList.remove("typing"); }, 50);
    });
  });
})();
