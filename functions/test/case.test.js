const test = require("node:test");
const assert = require("node:assert");
const { SOURCES, EVENTS, PERSONAS, AXES, MATERIALS, availablePersonas, personaSourceIds, personaVerified, materialsFor, materialsAdmin, CASES, AFTERMATH, casesFor, aftermathFor } = require("../case");
const { personaPrompt } = require("../prompts");

const KINDS = ["증언", "사실", "주장", "의견"];

test("사건은 제주 예멘 하나뿐이고, 인물 9명이 네 축(당사자·도민·시민사회·제도)에 나뉘며 축마다 2명 이상이다", () => {
  assert.deepEqual(Object.keys(EVENTS), ["jeju2018"]);
  assert.equal(PERSONAS.length, 9);
  assert.equal(new Set(PERSONAS.map((p) => p.id)).size, 9);
  assert.ok(PERSONAS.every((p) => p.events.length === 1 && p.events[0] === "jeju2018"));
  for (const a of AXES) assert.ok(PERSONAS.filter((p) => p.axis === a).length >= 2, a);
  assert.ok(PERSONAS.every((p) => AXES.includes(p.axis)));
});

test("인물마다 쟁점에 대한 자기 생각(views)이 있고, 사건 공통 배경은 출처가 있는 사실이다", () => {
  for (const p of PERSONAS) {
    assert.ok(Array.isArray(p.views) && p.views.length >= 3, p.id);
    assert.doesNotMatch(p.views.join(" "), /수업용|챗봇|AI|자료|보도|인터뷰/, p.id);
  }
  const bg = EVENTS.jeju2018.background;
  assert.ok(bg.length >= 5);
  for (const [text, src, kind] of bg) { assert.ok(text.length > 10); assert.ok(SOURCES[src]); assert.ok(KINDS.includes(kind)); }
});

test("인물은 사람 이름과 편지, 말투, 설정을 갖고, 이름은 서로 다르다", () => {
  assert.equal(new Set(PERSONAS.map((p) => p.name)).size, PERSONAS.length);
  for (const p of PERSONAS) {
    assert.ok(p.name && p.name.length <= 4, `${p.id}: 사람 이름이어야 한다`);
    assert.ok(p.label && p.label !== p.name, `${p.id}: 교사용 역할명(label)`);
    assert.ok(p.voice.length > 10 && p.setting.length > 10, p.id);
    assert.ok(Array.isArray(p.letter) && p.letter.length >= 7 && p.letter.join("").length >= 500, `${p.id}: 편지는 7문단 이상, 충분히 길게`);
    assert.ok(p.letter[0].includes(p.name), `${p.id}: 편지 첫머리에 이름`);
    // 편지는 인물 목소리여야 하므로 개발자·수업 관점의 말이 없어야 한다
    assert.doesNotMatch([...p.letter, p.ps || ""].join(" "), /수업용|챗봇|AI|자료|보도|인터뷰/, p.id);
    // 개인으로 등장하는 인물(난민 신청자·도민)은 나이·가족 같은 신상 질문에 설정대로 답해야 하므로, 설정이나 삶의 이야기에 나이와 가족이 있어야 한다
    if (require("../charter").isPersonal(p)) {
      const life = [p.setting, ...p.story].join(" ");
      assert.match(life, /(\d+세|\d+대|스물|서른|마흔|쉰|예순|[가-힣]{1,3}\s*살)/, `${p.id}: 나이`);
      assert.match(life, /(부모|아버지|어머니|엄마|아빠|아내|남편|아이|딸|아들|동생|가족|형|누나)/, `${p.id}: 가족`);
    }
  }
});

test("모든 근거 진술은 존재하는 출처·허용된 종류를 가지며, 출처에는 https url이 있다", () => {
  for (const p of PERSONAS) {
    assert.ok(p.claims.length >= 6, `${p.id}: 근거 진술이 부족하다`);
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
  assert.equal(availablePersonas("jeju2018", true).length, 9);
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
  const ids = [...personaSourceIds(p), ...EVENTS.jeju2018.background.map((c) => c[1])];
  ids.forEach((id) => (SOURCES[id].verified = true));
  try {
    assert.equal(personaVerified(p), true);
    assert.ok(availablePersonas("jeju2018", false).some((x) => x.id === "j_officer"));
    // 공통 배경 출처가 하나라도 미검증이면 인물은 나오지 않는다
    SOURCES[EVENTS.jeju2018.background[0][1]].verified = false;
    assert.equal(availablePersonas("jeju2018", false).some((x) => x.id === "j_officer"), false);
    SOURCES[EVENTS.jeju2018.background[0][1]].verified = true;
    assert.ok(materialsFor(false).some((c) => c.id === "timeline"));
  } finally {
    ids.forEach((id) => (SOURCES[id].verified = false));
  }
});

test("페르소나 프롬프트: 공통 배경·자기 생각 포함, 생각을 물으면 회피하지 않음, 출처·메타 발언 금지, 핵심 사실은 지어내지 않음", () => {
  const p = PERSONAS.find((x) => x.id === "j_resident");
  const prompt = personaPrompt(EVENTS.jeju2018, p);
  assert.match(prompt, /'미경'/);
  assert.match(prompt, /\[상위 규범\]/);
  assert.match(prompt, /메신저 대화/);
  assert.match(prompt, /1~4문장/);
  assert.match(prompt, /\[모두가 아는 배경\]/);
  assert.match(prompt, /\[네 생각\]/);
  assert.ok(p.views.every((v) => prompt.includes(v)));
  assert.match(prompt, /답을 피하는 말은 하지 않는다/);
  assert.match(prompt, /앞의 대화를 기억/);
  assert.match(prompt, /이모지/);
  assert.match(prompt, /\[주장\]/);
  assert.match(prompt, /정확히는 모르겠어요/);
  assert.match(prompt, /출처 번호도 붙이지 않는다/);
  assert.doesNotMatch(prompt, /\(자료\d\)/);
  assert.doesNotMatch(prompt, /울산|아프간/);
});

test("인물마다 실존 인물처럼 구체적인 삶의 이야기·기억나는 장면·마음속 고민·말버릇이 있고, 메타 표현이 없다", () => {
  for (const p of PERSONAS) {
    assert.ok(p.story.length >= 6 && p.episodes.length >= 4, p.id);
    assert.ok(p.inner.length > 20 && p.habits.length > 10, p.id);
    assert.doesNotMatch([...p.story, ...p.episodes, p.inner, p.habits].join(" "), /수업용|챗봇|AI|자료|보도|인터뷰/, p.id);
  }
  const prompt = personaPrompt(EVENTS.jeju2018, PERSONAS[0]);
  assert.match(prompt, /\[네 삶의 이야기\]/);
  assert.match(prompt, /\[기억나는 장면\]/);
  assert.ok(PERSONAS[0].episodes.every((e) => prompt.includes(e)));
});

test("인물들의 삶은 서로 스친다: 이야기 속 연결이 양쪽 인물 모두에 있다", () => {
  const life = (id) => { const p = PERSONAS.find((x) => x.id === id); return [...p.story, ...p.episodes].join(" "); };
  assert.match(life("j_applicant"), /선장님/); assert.match(life("j_employer"), /멀미/);        // 아델 ↔ 강태호
  assert.match(life("j_applicant2"), /쉼터/); assert.match(life("j_shelter"), /기술자/);        // 하산 ↔ 오성민
  assert.match(life("j_applicant2"), /인권 활동가/); assert.match(life("j_supporter"), /가장/); // 하산 ↔ 서진
  assert.match(life("j_applicant"), /김치전/); assert.match(life("j_host"), /김치전/);          // 아델 ↔ 지혜
  assert.match(life("j_resident"), /법무부 소관/); assert.match(life("j_province"), /법무부 소관/); // 미경 ↔ 윤서영
});

test("미경의 4·3 기억은 남기되 경계(조심할 이야기)가 프롬프트·감독자·규범에 모두 들어간다", () => {
  const { guardMessages } = require("../guard");
  const { CHARTER } = require("../charter");
  const p = PERSONAS.find((x) => x.id === "j_resident");
  assert.ok(p.episodes.some((e) => e.includes("4·3")));
  assert.ok(p.limits.length >= 1 && /할머니들이 더 잘 아시죠/.test(p.limits[0]));
  const prompt = personaPrompt(EVENTS.jeju2018, p);
  assert.match(prompt, /\[조심할 이야기\]/);
  assert.ok(prompt.includes(p.limits[0]));
  const [sys] = guardMessages({ persona: p, claims: p.claims, background: EVENTS.jeju2018.background, studentMessage: "4·3이 뭐예요?", reply: "..." });
  assert.ok(sys.content.includes(p.limits[0]));
  assert.ok(CHARTER.scope.outOfScope.some((x) => /4·3/.test(x) && /짧게 언급하는 것은 허용/.test(x)));
  // 다른 인물의 프롬프트에는 이 경계가 없다
  assert.doesNotMatch(personaPrompt(EVENTS.jeju2018, PERSONAS.find((x) => x.id === "j_applicant")), /\[조심할 이야기\]/);
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

test("모든 출처에 검색 교차 확인 기록이 있고, 교차 확인만으로는 학생에게 공개되지 않는다", () => {
  for (const [id, x] of Object.entries(SOURCES)) {
    assert.ok(["ok", "partial", "fixed", "todo"].includes(x.crossCheck?.status), id);
    assert.ok(x.crossCheck.note.length > 5, id);
    assert.equal(x.verified, false, id);
  }
});
