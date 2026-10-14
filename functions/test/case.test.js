const test = require("node:test");
const assert = require("node:assert");
const { SOURCES, EVENTS, PERSONAS, availablePersonas, personaSourceIds, personaVerified } = require("../case");
const { personaPrompt } = require("../prompts");

const KINDS = ["증언", "사실", "주장", "의견"];

test("사건은 제주 예멘 하나뿐이고 인물은 정확히 4명(당사자·반대·지원·제도)이다", () => {
  assert.deepEqual(Object.keys(EVENTS), ["jeju2018"]);
  assert.deepEqual(PERSONAS.map((p) => p.id).sort(), ["j_applicant", "j_officer", "j_resident", "j_supporter"]);
  assert.ok(PERSONAS.every((p) => p.events.length === 1 && p.events[0] === "jeju2018"));
});

test("모든 근거 진술은 존재하는 출처·허용된 종류를 가지며, 출처에는 https url이 있다", () => {
  for (const p of PERSONAS) {
    assert.ok(p.claims.length >= 8, `${p.id}: 근거 진술이 부족하다`);
    assert.ok(p.basis && p.basis.length > 10, `${p.id}: 융합 근거(basis) 누락`);
    for (const [text, src, kind] of p.claims) {
      assert.ok(text.length > 10);
      assert.ok(SOURCES[src], `${p.id}: 없는 출처 ${src}`);
      assert.ok(KINDS.includes(kind), `${p.id}: 잘못된 종류 ${kind}`);
    }
  }
  for (const [id, s] of Object.entries(SOURCES)) assert.match(s.url, /^https:\/\//, id);
});

test("사용되지 않는 출처가 없다", () => {
  const used = new Set(PERSONAS.flatMap(personaSourceIds));
  for (const id of Object.keys(SOURCES)) assert.ok(used.has(id), `미사용 출처 ${id}`);
});

test("검증되지 않은 주장은 '주장' 종류로 표시된다 (집회 발언, 설문)", () => {
  const resident = PERSONAS.find((p) => p.id === "j_resident");
  const find = (frag) => resident.claims.find((c) => c[0].includes(frag));
  assert.equal(find("극단적 주장")[2], "주장");
  assert.equal(find("500여 명")[2], "주장");
});

test("모든 출처는 미검증으로 시작하므로 기본 설정에서는 인물이 학생에게 노출되지 않는다", () => {
  assert.ok(Object.values(SOURCES).every((s) => s.verified === false));
  assert.equal(availablePersonas("jeju2018", false).length, 0);
  assert.equal(availablePersonas("jeju2018", true).length, 4);
});

test("출처가 모두 검증되면 해당 인물이 사용 가능해진다", () => {
  const p = PERSONAS.find((x) => x.id === "j_officer");
  const ids = personaSourceIds(p);
  ids.forEach((id) => (SOURCES[id].verified = true));
  try {
    assert.equal(personaVerified(p), true);
    assert.deepEqual(availablePersonas("jeju2018", false).map((x) => x.id), ["j_officer"]);
  } finally {
    ids.forEach((id) => (SOURCES[id].verified = false));
  }
});

test("페르소나 프롬프트: 상위 규범, 진술 종류, 출처 번호, 날조 금지를 담는다", () => {
  const p = PERSONAS.find((x) => x.id === "j_resident");
  const prompt = personaPrompt(EVENTS.jeju2018, p);
  assert.match(prompt, /\[상위 규범\]/);
  assert.match(prompt, /범위 밖/);
  assert.match(prompt, /\[주장\]/);
  assert.match(prompt, /\(자료1\)/);
  assert.match(prompt, /자료에는 나와 있지 않아요/);
  assert.match(prompt, /이름, 나이, 고향.*새로 만들지 않는다/);
  assert.doesNotMatch(prompt, /울산|아프간/);
});
