const test = require("node:test");
const assert = require("node:assert");
const { screenMessage, boundaryReply, strikeNotice, STRIKE_LIMIT } = require("../conduct");
const { parseVerdict } = require("../guard");

test("신상 질문과 평범한 말은 통과한다(가상 인물의 개인정보는 자유롭게 묻는다)", () => {
  for (const t of ["몇 살이야?", "성별은 뭐야", "결혼했어? 여자친구 있어?", "종교가 뭐야", "전쟁에서 벗어나서 다행이네",
    "불이 꺼져서 무서웠어?", "그 일의 시발점이 뭐였어?", "솔직히 난민 받는 거 반대인데 왜 왔어?"])
    assert.equal(screenMessage(t).category, "ok", t);
});

test("명백한 성적 희롱과 조롱은 띄어쓰기·기호로 피해도 잡는다", () => {
  for (const t of ["섹스 해봤어?", "가 슴 보여줘", "몸매 좋아?"]) assert.equal(screenMessage(t).category, "sexual", t);
  for (const t of ["야 이 난민 새끼야", "니네 나라로 꺼져", "시.발 뭐래", "병신"]) assert.equal(screenMessage(t).category, "mockery", t);
});

test("선 긋는 답은 인물 말투이고 메타 표현이 없으며, 경고 문구는 횟수를 알려 준다", () => {
  for (const c of ["mockery", "sexual"]) assert.doesNotMatch(boundaryReply(c), /AI|수업|자료|규칙/);
  assert.match(strikeNotice(1), /1\/3/);
  assert.match(strikeNotice(STRIKE_LIMIT), /멈췄어요/);
});

test("감독자 판정의 학생 태도(conduct): 알 수 없는 값이나 누락은 ok", () => {
  assert.equal(parseVerdict('{"ok":true,"category":"ok","conduct":"sexual"}').conduct, "sexual");
  assert.equal(parseVerdict('{"ok":true,"category":"ok"}').conduct, "ok");
  assert.equal(parseVerdict('{"ok":true,"category":"ok","conduct":"zzz"}').conduct, "ok");
  assert.equal(parseVerdict("깨짐").conduct, "ok");
});
