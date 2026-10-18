const test = require("node:test");
const assert = require("node:assert");
const { SOURCES, EVENTS, PERSONAS, MATERIALS, DEFAULT_EVENT, availablePersonas, personaSourceIds, personaVerified, materialsFor, materialsAdmin } = require("../case");
const { personaPrompt } = require("../prompts");

const KINDS = ["증언", "사실", "주장", "의견"];

test("사건은 제주 예멘·쓰레기 수출·강서 특수학교 세 가지이고, 사건마다 인물 9명이 네 축에 나뉘며 축마다 2명 이상이다", () => {
  assert.deepEqual(Object.keys(EVENTS), ["jeju2018", "waste2019", "school2018"]);
  assert.equal(DEFAULT_EVENT, "jeju2018");
  assert.equal(new Set(PERSONAS.map((p) => p.id)).size, PERSONAS.length);
  assert.ok(PERSONAS.every((p) => p.events.length === 1 && EVENTS[p.events[0]]));
  for (const ev of Object.values(EVENTS)) {
    const ps = PERSONAS.filter((p) => p.events.includes(ev.id));
    assert.equal(ps.length, 9, ev.id);
    assert.equal(ev.axes.length, 4, ev.id);
    for (const a of ev.axes) assert.ok(ps.filter((p) => p.axis === a).length >= 2, `${ev.id}: ${a}`);
    assert.ok(ps.every((p) => ev.axes.includes(p.axis)), ev.id);
  }
});

test("사건마다 대화 시점·범위·검색 범위·화면 예시 문구가 있다", () => {
  for (const ev of Object.values(EVENTS)) {
    assert.ok(ev.now && ev.backgroundIntro, ev.id);
    for (const k of ["event", "time", "place"]) assert.ok(ev.scope[k], `${ev.id}: scope.${k}`);
    assert.ok(ev.scope.allowedTopics.length >= 3 && ev.scope.outOfScope.length >= 2, ev.id);
    assert.ok(ev.search.scope && ev.search.example, ev.id);
    for (const k of ["letterSign", "causeExample", "badQuestion", "goodQuestion", "checkQuestion", "heardExample", "broadProblem", "decidedProblem"]) assert.ok(ev.ui[k], `${ev.id}: ui.${k}`);
  }
  assert.match(EVENTS.waste2019.now, /2019년 2월/);
  assert.match(EVENTS.waste2019.scope.event, /필리핀/);
});

test("인물마다 쟁점에 대한 자기 생각(views)이 있고, 사건 공통 배경은 출처가 있는 사실이다", () => {
  for (const p of PERSONAS) {
    assert.ok(Array.isArray(p.views) && p.views.length >= 3, p.id);
    assert.doesNotMatch(p.views.join(" "), /수업용|챗봇|AI|자료|보도|인터뷰/, p.id);
  }
  for (const ev of Object.values(EVENTS)) {
    assert.ok(ev.background.length >= 5, ev.id);
    for (const [text, src, kind] of ev.background) { assert.ok(text.length > 10); assert.ok(SOURCES[src]); assert.ok(KINDS.includes(kind)); }
  }
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
    assert.doesNotMatch(p.letter.join(" "), /수업용|챗봇|AI|자료|보도|인터뷰/, p.id);
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
    ...Object.values(MATERIALS).flat().flatMap((m) => [...(m.statsSrc || []), ...m.items.flatMap((i) => i.src)]),
  ]);
  for (const id of Object.keys(SOURCES)) assert.ok(used.has(id), `미사용 출처 ${id}`);
});

test("실제 자료: 항목마다 종류와 존재하는 출처를 갖는다", () => {
  for (const mats of Object.values(MATERIALS)) assert.ok(mats.length >= 5);
  for (const c of Object.values(MATERIALS).flat()) for (const it of c.items) {
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
  const locals = MATERIALS.jeju2018.find((m) => m.id === "locals").items;
  assert.equal(locals.find((i) => i.text.includes("500여 명")).kind, "주장");
});

test("대조를 마친 출처만 검증됨으로 본다: 제주 출처는 미검증이라 노출되지 않고, 쓰레기 수출·강서 특수학교는 노출된다", () => {
  const ids = (prefix) => Object.keys(SOURCES).filter((id) => id.startsWith(prefix));
  assert.ok(ids("J").every((id) => SOURCES[id].verified === false));
  assert.ok([...ids("W"), ...ids("S")].every((id) => SOURCES[id].verified === true));
  assert.ok([...ids("W"), ...ids("S")].every((id) => /대조함/.test(SOURCES[id].check)), "대조 결과가 check 에 적혀 있다");
  assert.equal(availablePersonas("jeju2018", false).length, 0);
  assert.equal(availablePersonas("jeju2018", true).length, 9);
  assert.equal(availablePersonas("waste2019", false).length, 9);
  assert.equal(availablePersonas("school2018", false).length, 9);
  assert.deepEqual(materialsFor("jeju2018", false), []);
  assert.deepEqual(materialsFor("waste2019", false).map((c) => c.id), MATERIALS.waste2019.map((c) => c.id));
  assert.deepEqual(materialsFor("school2018", false).map((c) => c.id), MATERIALS.school2018.map((c) => c.id));
});

test("학생용 자료에는 출처 ID·URL 없이 매체·날짜 캡션만 있다", () => {
  const all = materialsFor("jeju2018", true);
  assert.ok(all.length >= 5);
  const json = JSON.stringify(all);
  assert.doesNotMatch(json, /https?:\/\/|"src"|"J\d+"/);
  assert.ok(all.flatMap((c) => c.items).every((i) => i.caption.length > 0));
  assert.match(all.find((c) => c.id === "applicants").items[0].caption, /서울신문 2018\.7\.5/);
  assert.equal(all.find((c) => c.id === "result").stats.length, 5);
  assert.ok(materialsAdmin("jeju2018").every((c) => c.items.every((i) => Array.isArray(i.src))));
  // 사건마다 자기 자료가 나간다
  const waste = materialsFor("waste2019", true);
  assert.ok(waste.length >= 5);
  assert.doesNotMatch(JSON.stringify(waste), /https?:\/\/|"src"|"W\d+"|예멘/);
  assert.equal(waste.find((c) => c.id === "return").stats.length, 5);
  assert.ok(materialsAdmin("waste2019").every((c) => c.items.every((i) => i.src.every((id) => id.startsWith("W")))));
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
    assert.ok(materialsFor("jeju2018", false).some((c) => c.id === "timeline"));
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
  const p = PERSONAS.find((x) => x.id === "j_resident");
  assert.ok(p.episodes.some((e) => e.includes("4·3")));
  assert.ok(p.limits.length >= 1 && /할머니들이 더 잘 아시죠/.test(p.limits[0]));
  const prompt = personaPrompt(EVENTS.jeju2018, p);
  assert.match(prompt, /\[조심할 이야기\]/);
  assert.ok(prompt.includes(p.limits[0]));
  const [sys] = guardMessages({ event: EVENTS.jeju2018, persona: p, claims: p.claims, studentMessage: "4·3이 뭐예요?", reply: "..." });
  assert.ok(sys.content.includes(p.limits[0]));
  assert.ok(EVENTS.jeju2018.scope.outOfScope.some((x) => /4·3/.test(x) && /짧게 언급하는 것은 허용/.test(x)));
  assert.ok(!EVENTS.waste2019.scope.outOfScope.some((x) => /4·3/.test(x)));
  // 다른 인물의 프롬프트에는 이 경계가 없다
  assert.doesNotMatch(personaPrompt(EVENTS.jeju2018, PERSONAS.find((x) => x.id === "j_applicant")), /\[조심할 이야기\]/);
});

test("쓰레기 수출 사건: 인물 프롬프트는 그 사건의 시점·범위·배경만 담고 제주 사건 내용은 없다", () => {
  const ev = EVENTS.waste2019;
  for (const p of PERSONAS.filter((x) => x.events.includes("waste2019"))) {
    const prompt = personaPrompt(ev, p);
    assert.ok(prompt.includes(ev.now), p.id);
    assert.ok(prompt.includes(ev.scope.event), p.id);
    assert.ok(ev.background.every((c) => prompt.includes(c[0])), p.id);
    assert.doesNotMatch(prompt, /예멘|제주도 예멘|4·3/, p.id);
  }
  // 제주 인물 프롬프트에는 쓰레기 사건 내용이 없다
  assert.doesNotMatch(personaPrompt(EVENTS.jeju2018, PERSONAS[0]), /필리핀|타골로안/);
});

test("쓰레기 수출 사건: 실제 회사 이름은 인물 이야기에 나오지 않고, 인물들의 삶은 서로 스친다", () => {
  const ws = PERSONAS.filter((x) => x.events.includes("waste2019"));
  for (const p of ws) assert.doesNotMatch([...p.letter, ...p.story, ...p.episodes, ...p.views].join(" "), /베르데|Verde|소코/, p.id);
  const life = (id) => { const p = PERSONAS.find((x) => x.id === id); return [...p.story, ...p.episodes].join(" "); };
  assert.match(life("w_worker"), /가게 아주머니/); assert.match(life("w_resident"), /단골 청년/);     // 로웰 ↔ 마리셀
  assert.match(life("w_citizen"), /선별장/); assert.match(life("w_recycler"), /분리수거 반장/);       // 이수진 ↔ 박정수
  assert.match(life("w_customs"), /마스크/); assert.match(life("w_ministry"), /마스크/);             // 카를로 ↔ 최윤재
  assert.match(life("w_ph_activist"), /서울의 젊은 활동가/); assert.match(life("w_kr_activist"), /필리핀 활동가/); // 조이 ↔ 김다은
  assert.match(life("w_pyeongtaek"), /환경부에 전화/); assert.match(life("w_ministry"), /포승/);    // 한경희 ↔ 최윤재
  assert.match(life("w_kr_activist"), /선별장 사장/); assert.match(life("w_recycler"), /환경단체 활동가/); // 김다은 ↔ 박정수
});

test("강서 특수학교 사건: 그 사건의 시점·범위만 담고, 실존 인물 이름은 인물 이야기에 나오지 않으며, 인물들의 삶은 서로 스친다", () => {
  const ev = EVENTS.school2018;
  assert.match(ev.now, /2018년 9월/);
  assert.ok(ev.scope.outOfScope.some((x) => /실존 인물/.test(x)));
  const ss = PERSONAS.filter((x) => x.events.includes("school2018"));
  for (const p of ss) {
    const prompt = personaPrompt(ev, p);
    assert.ok(prompt.includes(ev.now) && ev.background.every((c) => prompt.includes(c[0])), p.id);
    assert.doesNotMatch(prompt, /예멘|필리핀/, p.id);
    // 실존 인물(교육감·국회의원·단체 대표)의 이름과, 대화 시점 뒤에 정해진 학교 이름은 쓰지 않는다
    assert.doesNotMatch([...p.letter, ...p.story, ...p.episodes, ...p.views, ...p.claims.map((c) => c[0])].join(" "), /조희연|김성태|손동호|김남연|채유미|양민규|서진학교/, p.id);
  }
  const life = (id) => { const p = PERSONAS.find((x) => x.id === id); return [...p.story, ...p.episodes].join(" "); };
  assert.match(life("s_mother"), /담임 선생님/); assert.match(life("s_teacher"), /버스 노선을 (모두|다) 외우는/);     // 최은숙 ↔ 문소영
  assert.match(life("s_mother"), /할아버지/); assert.match(life("s_elder"), /미안해요/);                            // 최은숙 ↔ 안덕수
  assert.match(life("s_sister"), /같은 아파트 단지에 사는 엄마/); assert.match(life("s_neighbor"), /대학생의 글/); // 하늘 ↔ 나윤희
  assert.match(life("s_opponent"), /젊은 활동가/); assert.match(life("s_mediator"), /부동산 사무소/);               // 송기철 ↔ 고민석
  assert.match(life("s_parent_group"), /장학사에게 전화/); assert.match(life("s_officer"), /부모 단체 활동가가 전화/); // 임현주 ↔ 백승민
});
