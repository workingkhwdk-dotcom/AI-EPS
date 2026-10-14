const test = require("node:test");
const assert = require("node:assert");
const { SOURCES, EVENTS, PERSONAS, availablePersonas, personaSourceIds, personaVerified } = require("../case");
const { personaPrompt } = require("../prompts");

test("모든 근거 진술은 존재하는 출처를 가리키고, 출처에는 url이 있다", () => {
  for (const p of PERSONAS) {
    assert.ok(p.claims.length >= 3, `${p.id}: 근거 진술이 너무 적다`);
    for (const [text, src] of p.claims) {
      assert.ok(text.length > 10);
      assert.ok(SOURCES[src], `${p.id}: 없는 출처 ${src}`);
    }
  }
  for (const [id, s] of Object.entries(SOURCES)) assert.match(s.url, /^https:\/\//, id);
});

test("모든 출처는 미검증 상태로 시작하므로 기본 설정에서는 학생에게 인물이 노출되지 않는다", () => {
  assert.ok(Object.values(SOURCES).every((s) => s.verified === false));
  for (const id of Object.keys(EVENTS)) {
    assert.equal(availablePersonas(id, false).length, 0);
    assert.ok(availablePersonas(id, true).length >= 3, `${id}: 리허설용 인물이 3명 미만`);
  }
});

test("출처가 모두 검증되면 해당 인물이 사용 가능해진다", () => {
  const p = PERSONAS.find((x) => x.id === "u_student");
  const ids = personaSourceIds(p);
  ids.forEach((id) => (SOURCES[id].verified = true));
  try {
    assert.equal(personaVerified(p), true);
    assert.ok(availablePersonas("ulsan2022", false).some((x) => x.id === "u_student"));
  } finally {
    ids.forEach((id) => (SOURCES[id].verified = false));
  }
});

test("한 사건에는 서로 다른 입장의 인물이 여러 명 있다", () => {
  const ulsan = availablePersonas("ulsan2022", true).map((p) => p.id);
  for (const need of ["u_student", "u_parent", "u_resident", "u_teacher", "u_officer"]) assert.ok(ulsan.includes(need), need);
  assert.ok(new Set(ulsan).size === ulsan.length);
});

test("페르소나 프롬프트: 근거 진술과 출처 번호를 담고, 세부를 지어내지 않도록 제한한다", () => {
  const p = PERSONAS.find((x) => x.id === "u_parent");
  const prompt = personaPrompt(EVENTS.ulsan2022, p);
  assert.match(prompt, /서부초 운동장에 학부모 수십 명/);
  assert.match(prompt, /\(자료1\)/);
  assert.match(prompt, /자료에는 나와 있지 않아요/);
  assert.match(prompt, /이름, 나이, 고향.*새로 만들지 않는다/);
});
