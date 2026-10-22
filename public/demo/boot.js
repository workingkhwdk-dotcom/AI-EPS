// 체험(demo) 화면 준비: 주소의 ?t=주제 를 확인하고, 학생 화면(app.js)이 입장 화면 없이 바로 열리도록 입장 코드를 심는다.
// (실제 입장 정보 대신 주제 이름이 수업 코드 자리에 들어간다. 저장은 모두 이 기기 안에서만 이뤄진다.)
(function () {
  var t = new URLSearchParams(location.search).get("t") || "";
  if (!/^[a-z0-9]+$/.test(t)) { location.replace("demo.html"); return; }
  document.documentElement.classList.add("demo");
  try { sessionStorage.setItem("eps_code", t.toUpperCase()); } catch (e) {}
  // 화면 가져오기(import map)를 못 쓰는 오래된 브라우저
  var ok = !!(window.HTMLScriptElement && HTMLScriptElement.supports && HTMLScriptElement.supports("importmap"));
  if (!ok) document.addEventListener("DOMContentLoaded", function () {
    document.body.insertAdjacentHTML("afterbegin", '<p style="padding:24px;font-size:16px;line-height:1.7">이 브라우저에서는 체험을 열 수 없어요. 휴대폰·컴퓨터의 브라우저(Chrome, Safari, Edge)를 최신으로 바꿔서 다시 열어 주세요.</p>');
  });
})();
