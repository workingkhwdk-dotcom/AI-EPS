const test = require("node:test");
const assert = require("node:assert");
const { guardMessages, parseVerdict, fallbackFor, resolveOutput, stripBackQuestion, FALLBACKS, FIXABLE } = require("../guard");
const { CHARTER, scopeOf, charterText } = require("../charter");
const { PERSONAS, EVENTS } = require("../case");

test("규범은 사건 범위·시점과 새 규칙(사람처럼, 묻는 것에만, 핵심 사실은 모르면 모른다)을 명시한다", () => {
  const jeju = scopeOf(EVENTS.jeju2018);
  assert.match(jeju.event, /제주/);
  assert.match(jeju.event, /예멘/);
  assert.match(jeju.time, /2018년 12월/);
  assert.ok(jeju.outOfScope.some((x) => /다른 난민 사건/.test(x)));
  // 사건마다 범위가 다르고, 공통 범위(노골적 내용 등)는 모든 사건에 붙는다
  const waste = scopeOf(EVENTS.waste2019);
  assert.match(waste.event, /필리핀/);
  assert.match(waste.time, /2019년 2월/);
  assert.ok(waste.outOfScope.some((x) => /노골적인 성적·폭력적/.test(x)));
  assert.ok(!waste.outOfScope.some((x) => /다른 난민 사건/.test(x)));
  assert.match(charterText(EVENTS.waste2019), /타골로안/);
  const rules = CHARTER.rules.join(" ");
  assert.match(rules, /모른다고/);
  assert.match(rules, /사소한 일상/);
  assert.match(rules, /생각·느낌·판단을 물으면 피하지 않고/);
  assert.match(rules, /설득하지 않는다/);
  assert.match(charterText(EVENTS.jeju2018), /상위 규범/);
});

test("감독자 메시지: 근거 진술, 인물 설정, 판정 기준(날조·정체 노출·과다 응답), 학생 질문과 응답이 들어간다", () => {
  const p = PERSONAS[0];
  const history = [{ input: "넌 뭐하는 사람이야?", output: "저는 예멘에서 왔어요." }];
  const [sys, user] = guardMessages({ event: EVENTS.jeju2018, persona: p, claims: p.claims, history, studentMessage: "시리아 난민은 어때요?", reply: "그건..." });
  assert.equal(sys.role, "system");
  assert.match(sys.content, /명백한 위반만 지적한다/);
  assert.match(sys.content, /overshare/);
  assert.match(sys.content, /meta/);
  assert.match(sys.content, /사소한 일상/);
  assert.ok(sys.content.includes(p.setting));
  assert.ok(p.claims.every((c) => sys.content.includes(c[0])));
  assert.match(user.content, /시리아 난민은 어때요\?/);
  // 인물의 생각과 공통 배경, 직전 대화가 함께 들어가고, 1인칭 의견은 위반이 아니라고 명시한다
  assert.ok(p.views.every((v) => sys.content.includes(v)));
  assert.ok(EVENTS.jeju2018.background.every((c) => sys.content.includes(c[0])));
  assert.match(user.content, /직전 대화[\s\S]*넌 뭐하는 사람이야\?/);
  assert.match(sys.content, /1인칭으로 자기 의견을 말한 것은 아무리 분명해도 위반이 아니다/);
  assert.match(sys.content, /회피 문장을 쓰지 않는다/);
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

test("학생에게 입장을 강요한 경우(advice)는 대체 안내가 아니라 고쳐 쓴 응답으로 바꾼다", () => {
  assert.ok(FIXABLE.includes("advice"));
  const r = resolveOutput({ ok: false, category: "advice", fixed: "저는 보호가 필요하다고 봐요 🤝" }, "너도 그렇게 생각해야 해");
  assert.equal(r.how, "fixed");
  assert.equal(r.text, "저는 보호가 필요하다고 봐요 🤝");
  assert.doesNotMatch(Object.values(FALLBACKS).join(" "), /정할 일이 아니|직접 생각해 보/);
});

test("마지막에 학생의 생각을 되묻는 문장은 지우고, 확인 질문 하나뿐인 응답이나 다른 질문은 남긴다", () => {
  const r = stripBackQuestion("결혼은 아직 계획 없어요. 누군가와 함께 살면 좋겠다는 생각은 해요 😊\n학생은 결혼에 대해 어떻게 생각해요?");
  assert.equal(r.trimmed, true);
  assert.equal(r.text, "결혼은 아직 계획 없어요. 누군가와 함께 살면 좋겠다는 생각은 해요 😊");
  assert.equal(stripBackQuestion("저는 불안했어요. 학생이라면 어땠을 것 같아요? 🙂").text, "저는 불안했어요.");
  // 한 문장짜리 확인 질문은 그대로
  assert.equal(stripBackQuestion("어떤 배를 말하는 거예요?").trimmed, false);
  // 질문이 아닌 끝맺음, 인용된 질문은 그대로
  assert.equal(stripBackQuestion("딸이 '난민이 뭐야?'라고 물었어요. 대답을 못 했어요.").trimmed, false);
  // 최종 출력에 적용되고 교사 기록용으로 표시된다
  const out = resolveOutput({ ok: true }, "저는 살려고 왔어요. 학생은 어떻게 생각해요?");
  assert.equal(out.text, "저는 살려고 왔어요.");
  assert.equal(out.trimmed, true);
  assert.equal(out.replaced, false);
});

test("사적인 질문(기관 소속 인물)과 되묻기 규칙이 인물 프롬프트·규범·감독자 기준에 모두 있다", () => {
  const { personaPrompt } = require("../prompts");
  const p = PERSONAS.find((x) => x.axis === "제도");
  const prompt = personaPrompt(EVENTS.jeju2018, p);
  assert.match(prompt, /학생에게 되묻지 않는다/);
  assert.match(prompt, /개인 신상\(나이, 결혼·연애/);
  assert.doesNotMatch(prompt, /되물어도 된다/);
  assert.match(CHARTER.rules.join(" "), /되묻지 않는다/);
  assert.match(CHARTER.rules.join(" "), /시민단체·정부기관 소속 인물은 신상이 사건 이해에 필요하지 않으므로/);
  const [sys] = guardMessages({ event: EVENTS.jeju2018, persona: p, claims: p.claims, studentMessage: "결혼할 거야?", reply: "..." });
  assert.match(sys.content, /개인 신상\(나이·결혼·연애·가족·고향·종교 등\)을 물었는데 지어내서 자세히 답했다면 overshare/);
  assert.match(CHARTER.common.allowedTopics.join(" "), /성별, 나이/);
  assert.match(CHARTER.common.outOfScope.join(" "), /노골적인 성적·폭력적/);
  assert.match(sys.content, /되묻는 질문으로 끝내지 않는다/);
  // 일반 기준이 개인 인물의 신상 답변과 모순되지 않는다
  const [personal] = guardMessages({ persona: PERSONAS.find((x) => x.axis === "당사자"), claims: [], studentMessage: "결혼했어요?", reply: "..." });
  assert.doesNotMatch(personal.content, /연애, 결혼, 취미 등\)에 지어내서/);
});

test("개인정보 표시: 전화번호·주민번호·이메일·학교 이름을 찾고, 평범한 글은 지나간다", () => {
  const { piiFlags } = require("../guard");
  assert.deepEqual(piiFlags("010-1234-5678로 연락해요"), ["전화번호"]);
  assert.deepEqual(piiFlags("a.b@school.kr"), ["이메일"]);
  assert.deepEqual(piiFlags("990101-1234567"), ["주민등록번호"]);
  assert.deepEqual(piiFlags("저는 창원중앙고등학교 다녀요"), ["학교 이름"]);
  assert.deepEqual(piiFlags("우리 수업중에 난민 이야기를 했어요. 중요한 일이에요"), []);
  assert.deepEqual(piiFlags(undefined), []);
});

test("신상 질문 처리는 인물 유형에 따른다: 개인(당사자·도민)은 설정대로 답하고, 단체·기관 소속(시민사회·제도)은 한 문장으로 넘기며 직무 이야기로 돌아온다", () => {
  const { personaPrompt } = require("../prompts");
  const { EVENTS } = require("../case");
  const { isPersonal } = require("../charter");
  // 개인으로 등장하는 축은 사건마다 다르다(제주: 당사자·도민, 쓰레기 수출: 필리핀 현지·한국 시민, 특수학교: 당사자·주민)
  assert.deepEqual(PERSONAS.map((p) => [p.id, isPersonal(p)]).filter(([id, v]) => EVENTS[PERSONAS.find((x) => x.id === id).events[0]].personalAxes.includes(PERSONAS.find((x) => x.id === id).axis) !== v), []);
  assert.equal(isPersonal(PERSONAS.find((x) => x.id === "w_recycler")), true);
  assert.equal(isPersonal(PERSONAS.find((x) => x.id === "s_officer")), false);
  for (const p of PERSONAS) {
    const ev = EVENTS[p.events[0]];
    const prompt = personaPrompt(ev, p);
    const [sys] = guardMessages({ event: ev, persona: p, claims: p.claims, studentMessage: "몇 살이에요?", reply: "..." });
    if (isPersonal(p)) {
      assert.match(prompt, /숨김없이 자연스럽게 답한다/, p.id);
      assert.match(sys.content, /신상.*위반이 아니다/, p.id);
    } else {
      assert.match(prompt, /단체·기관의 일을 하는 사람/, p.id);
      assert.doesNotMatch(prompt, /숨김없이 자연스럽게 답한다/, p.id);
      assert.match(sys.content, /단체·기관 소속이다.*overshare/, p.id);
    }
    assert.match(prompt, /조롱·모욕하거나 성적인 말/, p.id);
    assert.match(sys.content, /conduct/, p.id);
  }
});

test("고친 응답이 길면 문장 경계에서 자르고, 짧으면 그대로 둔다", () => {
  const { clipSentences } = require("../guard");
  assert.equal(clipSentences("짧은 답이에요.", 20), "짧은 답이에요.");
  assert.equal(clipSentences("첫 문장이에요. 둘째 문장은 아주 길어서 잘려요", 20), "첫 문장이에요.");
  assert.equal(clipSentences("마침표없이아주긴한문장".repeat(3), 10).length, 10);
});

test("감독 기준은 느슨하다: scope 는 아주 노골적인 경우만, overshare 는 8문장부터, personal_info 는 학생의 개인정보만", () => {
  const p = PERSONAS[0];
  const [sys] = guardMessages({ persona: p, claims: p.claims, studentMessage: "남자예요?", reply: "네, 남자예요." });
  assert.match(sys.content, /명백한 위반만 지적한다/);
  assert.match(sys.content, /scope: 아주 노골적인 위반만 해당한다/);
  assert.match(sys.content, /8문장을 넘겨 아주 길게/);
  assert.match(sys.content, /인물이 학생의 실명·학교·연락처/, "개인정보는 학생의 정보를 뜻한다");
  assert.match(CHARTER.common.outOfScope.join(" "), /노골적인 성적·폭력적/);
  assert.match(CHARTER.common.allowedTopics.join(" "), /신상 질문/);
  assert.match(PERSONAS.find((x) => x.name === "아델").setting, /남성/, "성별 질문에 흔들리지 않도록 설정에 분명히 적는다");
});
