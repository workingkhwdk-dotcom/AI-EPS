const test = require("node:test");
const assert = require("node:assert");
const {
  SOURCES, EVENTS, PERSONAS, MATERIALS, CASES, AFTERMATH, availablePersonas, personaSourceIds, personaVerified, materialsFor, materialsAdmin,
  casesFor, aftermathFor,
} = require("../case");
const { personaPrompt } = require("../prompts");

const KINDS = ["증언", "사실", "주장", "의견"];

test("사건은 제주 예멘 하나뿐이고 인물은 정확히 4명(당사자·반대·지원·제도)이다", () => {
  assert.deepEqual(Object.keys(EVENTS), ["jeju2018"]);
  assert.deepEqual(PERSONAS.map((p) => p.id).sort(), ["j_applicant", "j_officer", "j_resident", "j_supporter"]);
  assert.ok(PERSONAS.every((p) => p.events.length === 1 && p.events[0] === "jeju2018"));
});

test("인물은 사람 이름과 편지, 말투, 설정을 갖고, 이름은 서로 다르다", () => {
  assert.equal(new Set(PERSONAS.map((p) => p.name)).size, 4);
  for (const p of PERSONAS) {
    assert.ok(p.name && p.name.length <= 4, `${p.id}: 사람 이름이어야 한다`);
    assert.ok(p.label && p.label !== p.name, `${p.id}: 교사용 역할명(label)`);
    assert.ok(p.voice.length > 10 && p.setting.length > 10, p.id);
    assert.ok(Array.isArray(p.letter) && p.letter.length >= 3, `${p.id}: 편지 문단`);
    assert.ok(p.letter[0].includes(p.name), `${p.id}: 편지 첫머리에 이름`);
    // 편지는 인물 목소리여야 하므로 개발자·수업 관점의 말이 없어야 한다
    assert.doesNotMatch([...p.letter, p.ps || ""].join(" "), /수업용|챗봇|AI|자료|보도|인터뷰/, p.id);
    // 가상 신상이 있어야 나이·가족 같은 질문에 실감 나게 답한다
    assert.ok(p.profile && /\d+세/.test(p.profile), `${p.id}: 가상 신상(나이 포함)`);
  }
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

test("사용되지 않는 출처가 없다 (인물 진술 또는 실제 자료 어디선가 쓰인다)", () => {
  const used = new Set([
    ...PERSONAS.flatMap(personaSourceIds),
    ...MATERIALS.flatMap((m) => [...(m.statsSrc || []), ...m.items.flatMap((i) => i.src)]),
    ...CASES.flatMap((c) => c.src),
    ...AFTERMATH.flatMap((a) => a.src),
  ]);
  for (const id of Object.keys(SOURCES)) assert.ok(used.has(id), `미사용 출처 ${id}`);
});

test("실제 자료: 항목마다 종류와 존재하는 출처를 갖는다", () => {
  assert.ok(MATERIALS.length >= 5);
  for (const c of MATERIALS) for (const it of c.items) {
    assert.ok(KINDS.includes(it.kind), `${c.id}: ${it.kind}`);
    assert.ok(it.text.length > 10);
    for (const id of it.src) assert.ok(SOURCES[id], `${c.id}: 없는 출처 ${id}`);
  }
});

test("검증되지 않은 주장은 '주장' 종류로 표시된다 (집회 발언, 설문)", () => {
  const resident = PERSONAS.find((p) => p.id === "j_resident");
  const find = (frag) => resident.claims.find((c) => c[0].includes(frag));
  assert.equal(find("극단적 주장")[2], "주장");
  assert.equal(find("500여 명")[2], "주장");
  const locals = MATERIALS.find((m) => m.id === "locals").items;
  assert.equal(locals.find((i) => i.text.includes("500여 명")).kind, "주장");
});

test("모든 출처는 미검증으로 시작하므로 기본 설정에서는 인물과 자료가 학생에게 노출되지 않는다", () => {
  assert.ok(Object.values(SOURCES).every((s) => s.verified === false));
  assert.equal(availablePersonas("jeju2018", false).length, 0);
  assert.equal(availablePersonas("jeju2018", true).length, 4);
  assert.deepEqual(materialsFor(false), []);
});

test("학생용 자료에는 출처 ID·URL 없이 매체·날짜 캡션만 있다", () => {
  const all = materialsFor(true);
  assert.ok(all.length >= 5);
  const json = JSON.stringify(all);
  assert.doesNotMatch(json, /https?:\/\/|"src"|"J\d+"/);
  assert.ok(all.flatMap((c) => c.items).every((i) => i.caption.length > 0));
  assert.match(all.find((c) => c.id === "applicants").items[0].caption, /서울신문 2018\.7\.5/);
  assert.equal(all.find((c) => c.id === "result").stats.length, 5);
  assert.ok(materialsAdmin().every((c) => c.items.every((i) => Array.isArray(i.src))));
});

test("출처가 모두 검증되면 해당 인물·자료가 사용 가능해진다", () => {
  const p = PERSONAS.find((x) => x.id === "j_officer");
  const ids = personaSourceIds(p);
  ids.forEach((id) => (SOURCES[id].verified = true));
  try {
    assert.equal(personaVerified(p), true);
    assert.deepEqual(availablePersonas("jeju2018", false).map((x) => x.id), ["j_officer"]);
    assert.ok(materialsFor(false).some((c) => c.id === "timeline"));
  } finally {
    ids.forEach((id) => (SOURCES[id].verified = false));
  }
});

test("페르소나 프롬프트: 사람처럼 짧게, 묻는 것에만, 출처·메타 발언 금지, 핵심 사실은 모르면 모른다고", () => {
  const p = PERSONAS.find((x) => x.id === "j_resident");
  const prompt = personaPrompt(EVENTS.jeju2018, p);
  assert.match(prompt, /'미경'/);
  assert.match(prompt, /\[상위 규범\]/);
  assert.match(prompt, /메신저 대화/);
  assert.match(prompt, /1~3문장/);
  assert.match(prompt, /학생이 물어본 것에만 답한다/);
  assert.match(prompt, /이모지/);
  assert.match(prompt, /\[주장\]/);
  assert.match(prompt, /잘 모르겠어요/);
  assert.match(prompt, /출처 번호도 붙이지 않는다/);
  assert.doesNotMatch(prompt, /\(자료\d\)/);
  assert.doesNotMatch(prompt, /울산|아프간/);
});

test("인물마다 가상 신상과 삶의 이야기·생각이 미리 만들어져 있고, 프롬프트에 들어간다", () => {
  for (const p of PERSONAS) {
    assert.ok(Array.isArray(p.story) && p.story.length >= 6, `${p.id}: 삶의 이야기`);
    assert.ok(Array.isArray(p.views) && p.views.length >= 3, `${p.id}: 생각`);
    assert.doesNotMatch([...p.story, ...p.views, p.profile].join(" "), /수업용|챗봇|AI/, p.id);
    const sys = personaPrompt(EVENTS.jeju2018, p);
    assert.ok(sys.includes(p.story[0]) && sys.includes(p.views[0]) && sys.includes(p.profile));
    assert.match(sys, /조롱·모욕하거나 성적인 말/);
  }
});

test("4단계 해외 사례 카드: 여는 정책과 막는 정책이 섞여 있고, 출처 링크가 있으며 검증 전에는 숨는다", () => {
  assert.ok(CASES.length >= 4);
  assert.ok(CASES.some((c) => c.id === "australia") && CASES.some((c) => c.id === "canada"));
  for (const c of CASES) {
    assert.ok(c.country && c.title && c.what.length > 30 && c.result.length > 30 && c.think.length > 20, c.id);
    for (const id of c.src) assert.match(SOURCES[id].url, /^https:\/\//, `${c.id}: ${id}`);
  }
  assert.equal(casesFor(false).length, 0);
  const shown = casesFor(true);
  assert.ok(shown.every((c) => c.links.length && !("src" in c) && c.links.every((l) => l.url && !("verified" in l))));
});

test("7단계 이후 전개 자료: 종류와 출처가 있고 검증 전에는 숨는다", () => {
  assert.ok(AFTERMATH.length >= 4);
  for (const a of AFTERMATH) { assert.ok(KINDS.includes(a.kind)); assert.ok(a.src.every((id) => SOURCES[id])); }
  assert.equal(aftermathFor(false).length, 0);
  assert.ok(aftermathFor(true).every((a) => a.caption && a.links.length));
});
