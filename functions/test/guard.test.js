const test = require("node:test");
const assert = require("node:assert");
const { guardMessages, parseVerdict, fallbackFor, FALLBACKS } = require("../guard");
const { CHARTER, charterText } = require("../charter");
const { PERSONAS } = require("../case");

test("규범은 사건 범위와 범위 밖을 명시한다", () => {
  assert.match(CHARTER.scope.event, /제주/);
  assert.match(CHARTER.scope.event, /예멘/);
  assert.ok(CHARTER.scope.outOfScope.some((x) => /다른 난민 사건/.test(x)));
  assert.match(charterText(), /상위 규범/);
});

test("감독자 메시지: 근거 진술과 학생 질문, 인물 응답이 모두 들어간다", () => {
  const p = PERSONAS[0];
  const [sys, user] = guardMessages({ persona: p, claims: p.claims, studentMessage: "시리아 난민은 어때요?", reply: "그건..." });
  assert.equal(sys.role, "system");
  assert.match(sys.content, /확실한 위반만 지적한다/);
  assert.ok(p.claims.every((c) => sys.content.includes(c[0])));
  assert.match(user.content, /시리아 난민은 어때요\?/);
});

test("판정 해석: 정상 응답은 통과, 위반은 분류별로 차단", () => {
  assert.deepEqual(parseVerdict('{"ok":true,"category":"ok","reason":""}'), { ok: true, category: "ok", reason: "" });
  const v = parseVerdict('{"ok":false,"category":"scope","reason":"다른 사건"}');
  assert.equal(v.ok, false);
  assert.equal(v.category, "scope");
});

test("판정 해석: ok=true 라도 category 가 위반이면 차단한다", () => {
  assert.equal(parseVerdict('{"ok":true,"category":"fabrication","reason":"x"}').ok, false);
});

test("판정 해석: 깨진 응답이나 알 수 없는 분류는 안전 쪽(차단)으로 처리한다", () => {
  assert.deepEqual(parseVerdict("not json").category, "error");
  assert.equal(parseVerdict("not json").ok, false);
  assert.equal(parseVerdict('{"ok":false,"category":"weird","reason":"x"}').category, "scope");
});

test("위반 분류마다 학생용 안내문이 있고, 알 수 없는 분류는 오류 안내문", () => {
  for (const c of ["scope", "fabrication", "hate", "advice", "personal_info", "kind"]) assert.ok(FALLBACKS[c].length > 10, c);
  assert.equal(fallbackFor("zzz"), FALLBACKS.error);
});
