const test = require("node:test");
const assert = require("node:assert");
const { guardMessages, parseVerdict, fallbackFor, resolveOutput, FALLBACKS, FIXABLE } = require("../guard");
const { CHARTER, charterText } = require("../charter");
const { PERSONAS } = require("../case");

test("규범은 사건 범위·시점과 새 규칙(사람처럼, 묻는 것에만, 핵심 사실은 모르면 모른다)을 명시한다", () => {
  assert.match(CHARTER.scope.event, /제주/);
  assert.match(CHARTER.scope.event, /예멘/);
  assert.match(CHARTER.scope.time, /2018년 12월/);
  assert.ok(CHARTER.scope.outOfScope.some((x) => /다른 난민 사건/.test(x)));
  const rules = CHARTER.rules.join(" ");
  assert.match(rules, /잘 모르겠다/);
  assert.match(rules, /사소한 일상/);
  assert.match(rules, /물어본 것에만/);
  assert.match(charterText(), /상위 규범/);
});

test("감독자 메시지: 근거 진술, 인물 설정, 판정 기준(날조·정체 노출·과다 응답), 학생 질문과 응답이 들어간다", () => {
  const p = PERSONAS[0];
  const [sys, user] = guardMessages({ persona: p, claims: p.claims, studentMessage: "시리아 난민은 어때요?", reply: "그건..." });
  assert.equal(sys.role, "system");
  assert.match(sys.content, /확실한 위반만 지적한다/);
  assert.match(sys.content, /overshare/);
  assert.match(sys.content, /meta/);
  assert.match(sys.content, /사소한 일상/);
  assert.ok(sys.content.includes(p.setting));
  assert.ok(p.claims.every((c) => sys.content.includes(c[0])));
  assert.match(user.content, /시리아 난민은 어때요\?/);
});

test("판정 해석: 정상 응답은 통과, 위반은 분류별로 해석", () => {
  assert.equal(parseVerdict('{"ok":true,"category":"ok","reason":""}').ok, true);
  const v = parseVerdict('{"ok":false,"category":"scope","reason":"다른 사건"}');
  assert.equal(v.ok, false);
  assert.equal(v.category, "scope");
});

test("판정 해석: ok=true 라도 category 가 위반이면 차단한다", () => {
  assert.equal(parseVerdict('{"ok":true,"category":"fabrication","reason":"x"}').ok, false);
});

test("판정 해석: 깨진 응답이나 알 수 없는 분류는 안전 쪽으로 처리한다", () => {
  assert.equal(parseVerdict("not json").category, "error");
  assert.equal(parseVerdict("not json").ok, false);
  assert.equal(parseVerdict('{"ok":false,"category":"weird","reason":"x"}').category, "scope");
});

test("판정 해석: 코드펜스로 감싼 JSON 과 fixed 도 해석한다", () => {
  const v = parseVerdict('```json\n{"ok":false,"category":"overshare","reason":"길다","fixed":"네, 맞아요 🙂"}\n```');
  assert.equal(v.category, "overshare");
  assert.equal(v.fixed, "네, 맞아요 🙂");
});

test("최종 출력: 정상은 원문, 가벼운 위반은 고쳐 쓴 응답, 무거운 위반·검사 실패는 안내", () => {
  assert.deepEqual(resolveOutput({ ok: true }, "원문"), { text: "원문", replaced: false });
  const fixed = resolveOutput({ ok: false, category: "fabrication", fixed: "그건 저도 잘 몰라요 🙏" }, "원문");
  assert.equal(fixed.text, "그건 저도 잘 몰라요 🙏");
  assert.equal(fixed.how, "fixed");
  const noFix = resolveOutput({ ok: false, category: "overshare", fixed: "" }, "원문");
  assert.equal(noFix.how, "fallback");
  assert.equal(noFix.text, FALLBACKS.overshare);
  // 범위 이탈 등은 fixed 가 있어도 고쳐 쓰지 않고 안내로 대체
  const scope = resolveOutput({ ok: false, category: "scope", fixed: "아무 말" }, "원문");
  assert.equal(scope.text, FALLBACKS.scope);
  assert.equal(resolveOutput({ ok: false, category: "error", fixed: "" }, "원문").text, FALLBACKS.error);
  assert.ok(FIXABLE.every((c) => FALLBACKS[c]));
});

test("대체 안내문은 인물 말투이며 'AI·수업·자료' 같은 메타 표현이 없다", () => {
  for (const [c, t] of Object.entries(FALLBACKS)) {
    assert.ok(t.length > 5, c);
    assert.doesNotMatch(t, /AI|수업|자료|챗봇|보도/, c);
  }
  assert.equal(fallbackFor("zzz"), FALLBACKS.error);
});
