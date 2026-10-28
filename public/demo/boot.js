// 체험(demo) 화면 준비: 주소의 ?t=주제 를 확인하고, 학생 화면(app.js)이 입장 화면 없이 바로 열리도록 입장 코드를 심는다.
// (실제 입장 정보 대신 주제 이름이 수업 코드 자리에 들어간다. 저장은 모두 이 기기 안에서만 이뤄진다.)
(function () {
  var t = new URLSearchParams(location.search).get("t") || "";
  if (!/^[a-z0-9]+$/.test(t)) { location.replace("demo.html"); return; }
  document.documentElement.classList.add("demo");
  // 수업 코드 자리 값은 store.js 의 codeOf 와 같게: 중학교 체험(?lv=middle)은 뒤에 M 을 붙여 고등학교 체험과 저장을 나눈다
  var mid = /[?&]lv=middle(?:&|$)/.test(location.search);
  if (mid) document.documentElement.classList.add("demo-mid");
  try { sessionStorage.setItem("eps_code", t.toUpperCase() + (mid ? "M" : "")); } catch (e) {}
  // 단계에 처음 들어갈 때 뜨는 안내 팝업 끝에 '체험에서는 이렇게 달라요'를 덧붙인다(app.js 의 maybeHelp 가 부른다)
  var AI = "체험용 가벼운 AI라 실제 수업(더 고성능 AI)보다 답의 질이 떨어질 수 있어요.";
  var DIFF = {
    "1-pick": "모둠 친구가 없어서 모든 인물을 고를 수 있어요. 실제 수업에서는 모둠원마다 다른 인물을 맡아요.",
    "1-chat": "인물의 대답은 " + AI + " 묻기는 5번까지이고, 인물이 웹 검색을 하지 않으며, 부적절한 말 경고·대화 멈춤·선생님 알림이 없어요.",
    "1-note": "혼자 정리하고 선생님에게 제출되지 않아요. 실제 수업에서는 모둠원이 낸 글이 함께 보여요.",
    "1-group": "모둠 친구 없이 혼자 문제를 정해요. 실제 수업에서는 모둠원과 실시간으로 함께 써요.",
    "2": "생각 도우미는 " + AI + " 2~5단계 AI 도우미를 합쳐 5번까지예요.",
    "3": "AI 검색 도우미는 웹 검색 없이 수업 자료만 근거로 답하고, " + AI + " (2~5단계 합쳐 5번까지)",
    "4": "AI 의견은 " + AI + " (2~5단계 합쳐 5번까지) 모둠원과의 실시간 입력, 선생님 알림은 없어요.",
    "5": "미래 이야기는 " + AI + " (2~5단계 합쳐 5번까지) 모둠원과의 실시간 입력, 선생님 알림은 없어요.",
    "6": "모둠 친구와 함께 쓰지 않고, 쓴 글이 선생님 화면으로 가지 않아요.",
    "7": "모둠 친구와 함께 쓰지 않고, 쓴 글이 선생님 화면으로 가지 않아요."
  };
  window.EPS_HELP_EXTRA = function (key) {
    return DIFF[key] ? '<div class="help-demo" role="note"><b>체험에서는</b> ' + DIFF[key] + "</div>" : "";
  };
  // 화면 가져오기(import map)를 못 쓰는 오래된 브라우저
  var ok = !!(window.HTMLScriptElement && HTMLScriptElement.supports && HTMLScriptElement.supports("importmap"));
  if (!ok) document.addEventListener("DOMContentLoaded", function () {
    document.body.insertAdjacentHTML("afterbegin", '<p style="padding:24px;font-size:16px;line-height:1.7">이 브라우저에서는 체험을 열 수 없어요. 휴대폰·컴퓨터의 브라우저(Chrome, Safari, Edge)를 최신으로 바꿔서 다시 열어 주세요.</p>');
  });
})();
