const test = require("node:test");
const assert = require("node:assert");
const { SOURCES, EVENTS, PERSONAS, MATERIALS, DEFAULT_EVENT, CASES, AFTERMATH, availablePersonas, personaSourceIds, personaVerified, materialsFor, materialsAdmin, casesFor, aftermathFor } = require("../case");
const { personaPrompt } = require("../prompts");

const KINDS = ["증언", "사실", "주장", "의견"];
const s0 = (id) => SOURCES[id];

// 원문 대조를 마친 기본 주제 다섯 개, 새 주제 여섯 개(NEW).
// 새 주제 여섯 개는 기본 주제와 같은 방식(출처마다 검색으로 기사 내용을 다시 찾아 대조)으로 대조를 마쳤다(SEARCHED).
const CHECKED = ["jeju2018", "waste2019", "school2018", "junam2025", "changwon2025"];
const NEW = ["phone2026", "climate2024", "wildfire2025", "smallschool2026", "dogmeat2024", "pension2025"];
const SEARCHED = NEW;
const sourceIdsOf = (ids) => ids.flatMap((id) => Object.keys(require(`../cases/${id}`).SOURCES));

test("사건은 제주 예멘·쓰레기 수출·강서 특수학교·주남저수지·창원 인구 다섯 가지와 새 주제 여섯 가지이고, 사건마다 인물 9명이 네 축에 나뉘며 축마다 2명 이상이다", () => {
  assert.deepEqual(Object.keys(EVENTS), [...CHECKED, ...NEW]);
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
    ...Object.values(MATERIALS).flat().flatMap((m) => [...(m.statsSrc || []), ...m.items.flatMap((i) => i.src)]),
    ...Object.values(CASES).flat().flatMap((c) => c.src),
    ...Object.values(AFTERMATH).flat().flatMap((a) => a.src),
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

test("기본 주제 다섯 개는 출처 대조를 마쳐 검증됨이고, 대조 기록이 남아 있으며, 인물과 자료가 학생에게 노출된다", () => {
  const checked = sourceIdsOf(CHECKED);
  assert.ok(checked.every((id) => SOURCES[id].verified === true));
  const ids = (re) => checked.filter((id) => re.test(id));
  assert.ok(ids(/^[JCAN]\d/).every((id) => s0(id).crossCheck), "제주 출처는 교차 확인 기록(CROSS_CHECK)");
  assert.ok(ids(/^([WS]|JN|P)/).every((id) => /대조함/.test(SOURCES[id].check)), "쓰레기·특수학교·주남저수지·창원 인구 출처는 check 에 [대조함]");
  for (const ev of CHECKED) {
    assert.equal(availablePersonas(ev, false).length, 9, ev);
    assert.deepEqual(materialsFor(ev, false).map((c) => c.id), MATERIALS[ev].map((c) => c.id), ev);
  }
});

test("새 주제 여섯 개는 출처 대조를 마쳐 검증됨이고, 출처마다 [대조함] 기록이 있으며, 인물과 자료가 학생에게 노출된다", () => {
  for (const ev of SEARCHED) {
    const file = require(`../cases/${ev}`);
    for (const [id, s] of Object.entries(file.SOURCES)) {
      assert.equal(s.verified, true, `${ev} ${id}: verified`);
      assert.match(s.check, /^\[대조함\]/, `${ev} ${id}: check 는 [대조함] 으로 시작한다`);
      assert.doesNotMatch(s.check, /원문 미대조|검색 요약만 봄/, `${ev} ${id}: 미대조 표시가 남아 있지 않다`);
    }
    assert.equal(availablePersonas(ev, false).length, 9, ev);
    assert.deepEqual(materialsFor(ev, false).map((c) => c.id), MATERIALS[ev].map((c) => c.id), ev);
    assert.equal(casesFor(ev, false).length, CASES[ev].length, ev);
    assert.equal(aftermathFor(ev, false).length, AFTERMATH[ev].length, ev);
  }
});

test("새 주제 여섯 개: 그 사건의 시점·범위만 담고, 다른 사건 내용은 섞이지 않으며, 실존 인물·실제 가해자 이름은 나오지 않는다", () => {
  const others = { phone2026: /난민|산불|개농장|통폐합|청구인/, climate2024: /스마트폰|산불|개농장|통폐합/, wildfire2025: /스마트폰|청구인|개농장|통폐합/,
    smallschool2026: /스마트폰|청구인|산불|개농장/, dogmeat2024: /스마트폰|청구인|산불|통폐합/, pension2025: /스마트폰|청구인|산불|개농장|통폐합|난민/ };
  const when = { phone2026: /2026년 3월/, climate2024: /2026년 3월/, wildfire2025: /2025년 5월/, smallschool2026: /2026년 6월/, dogmeat2024: /2025년 8월/, pension2025: /2025년 3월/ };
  for (const ev of NEW) {
    assert.match(EVENTS[ev].now, when[ev], ev);
    for (const p of PERSONAS.filter((x) => x.events.includes(ev))) {
      const prompt = personaPrompt(EVENTS[ev], p);
      assert.ok(prompt.includes(EVENTS[ev].now) && EVENTS[ev].background.every((c) => prompt.includes(c[0])), p.id);
      assert.doesNotMatch(prompt, /예멘|필리핀|공진초|주남|창원 인구/, p.id);
      assert.doesNotMatch([...p.letter, ...p.story, ...p.episodes, ...p.views].join(" "), others[ev], p.id);
    }
  }
  // 전직 대통령·장관 등 실존 인물과 재판받은 실화자의 이름은 인물 이야기에 쓰지 않는다
  assert.doesNotMatch(PERSONAS.filter((x) => NEW.includes(x.events[0])).flatMap((p) => [...p.letter, ...p.story, ...p.episodes]).join(" "), /원민경|송미령|김정호/);
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

test("출처가 모두 검증되어야 해당 인물·자료가 사용 가능하다(하나라도 미검증이면 숨는다)", () => {
  const p = PERSONAS.find((x) => x.id === "j_officer");
  const ids = [...personaSourceIds(p), ...EVENTS.jeju2018.background.map((c) => c[1])];
  const before = Object.fromEntries(ids.map((id) => [id, SOURCES[id].verified]));
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
    ids.forEach((id) => (SOURCES[id].verified = before[id]));
  }
});

test("페르소나 프롬프트: 공통 배경·자기 생각 포함, 생각을 물으면 회피하지 않음, 출처·메타 발언 금지, 핵심 사실은 지어내지 않음", () => {
  const p = PERSONAS.find((x) => x.id === "j_resident");
  const prompt = personaPrompt(EVENTS.jeju2018, p);
  assert.match(prompt, /'미경'/);
  assert.match(prompt, /\[상위 규범\]/);
  assert.match(prompt, /메신저 대화/);
  assert.match(prompt, /1~5문장/);
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

test("창원 두 사건: 2020년대 사건이고, 그 사건의 시점·범위만 담으며, 실존 인물 이름은 나오지 않고, 인물들의 삶은 서로 스친다", () => {
  assert.match(EVENTS.junam2025.now, /2025년 4월/);
  assert.match(EVENTS.changwon2025.now, /2025년 2월/);
  for (const id of ["junam2025", "changwon2025"]) {
    const ev = EVENTS[id];
    assert.ok(ev.scope.outOfScope.some((x) => /실존 인물/.test(x)), id);
    for (const p of PERSONAS.filter((x) => x.events.includes(id))) {
      const prompt = personaPrompt(ev, p);
      assert.ok(prompt.includes(ev.now) && ev.background.every((c) => prompt.includes(c[0])), p.id);
      assert.doesNotMatch(prompt, /예멘|필리핀|공진초/, p.id);
      // 시장·국회의원·단체 대표 같은 실존 인물 이름은 쓰지 않는다
      assert.doesNotMatch([...p.letter, ...p.story, ...p.episodes, ...p.views, ...p.claims.map((c) => c[0])].join(" "), /홍남표|장금용|박완수|허성무|윤한홍|이종욱/, p.id);
    }
  }
  const life = (id) => { const p = PERSONAS.find((x) => x.id === id); return [...p.story, ...p.episodes].join(" "); };
  assert.match(life("jn_chief"), /활동가의 팔을 붙잡고/); assert.match(life("jn_activist"), /이장이 팔을 붙잡으며/);   // 박상규 ↔ 서미란
  assert.match(life("jn_farmer"), /쌍안경을 든 대학원생/); assert.match(life("jn_birder"), /논 주인 아저씨/);          // 황만수 ↔ 이준서
  assert.match(life("jn_grandma"), /카페 공사장에 떡/); assert.match(life("jn_returnee"), /이웃 할머니가 떡/);          // 옥순자 ↔ 윤다솜
  assert.match(life("jn_landowner"), /시청 담당자에게 몇 번이나 전화/); assert.match(life("jn_officer"), /몇 번이나 전화를 건 땅 주인/); // 정태식 ↔ 김혜진
  assert.match(life("jn_farmer"), /농어촌공사에 전화/); assert.match(life("jn_water"), /한 농민이 전화/);                // 황만수 ↔ 강동훈
  assert.match(life("cw_leaver"), /엄마의 분식집/); assert.match(life("cw_merchant"), /서울로 간 딸/);                  // 최유진 ↔ 이정숙
  assert.match(life("cw_stayer"), /사장님/); assert.match(life("cw_ceo"), /3년 차 직원/);                               // 김도윤 ↔ 윤상철
  assert.match(life("cw_stayer"), /베트남에서 온 동료/); assert.match(life("cw_worker"), /한국인 선배/);                // 김도윤 ↔ 투안
  assert.match(life("cw_student"), /청년 간담회/); assert.match(life("cw_researcher"), /한 대학생이 손을 들고/);          // 박서연 ↔ 오세라
  assert.match(life("cw_elder"), /시청 직원이 경로당/); assert.match(life("cw_officer"), /경로당 설명회/);                // 정병철 ↔ 한지훈
});

test("모든 사건: 인물·공통 배경·2단계 자료는 대화 시점 뒤에 나온 출처를 쓰지 않고, 7단계 이후 전개는 대화 시점 전의 출처를 쓰지 않는다", () => {
  // 대화 시점 전의 사실(시행 중인 제도, 이미 나온 통계·조사)을 뒤에 나온 글로 확인한 경우만 예외. 출처의 check 에 이유를 적었다.
  const STANDING = ["FA1", "Y26", "Y28", "N12", "PA2", "JNC5"];
  const ym = (d) => { const m = /^(\d{4})(?:-(\d{2}))?/.exec(d || ""); return m ? [+m[1], m[2] ? +m[2] : 0] : null; };
  for (const ev of Object.keys(EVENTS)) {
    const f = require(`../cases/${ev}`);
    const [ny, nm] = /(\d{4})년 (\d{1,2})월/.exec(EVENTS[ev].now).slice(1).map(Number);
    const after = (id) => { const d = ym(f.SOURCES[id].date); return d && (d[0] > ny || (d[0] === ny && d[1] > nm)); };
    const before = (id) => { const d = ym(f.SOURCES[id].date); return d && d[1] && (d[0] < ny || (d[0] === ny && d[1] < nm)); };
    const used = [...EVENTS[ev].background.map((c) => c[1]), ...f.PERSONAS.flatMap((p) => p.claims.map((c) => c[1])),
      ...f.MATERIALS.flatMap((m) => [...(m.statsSrc || []), ...m.items.flatMap((i) => i.src)])];
    assert.deepEqual([...new Set(used.filter((id) => after(id) && !STANDING.includes(id)))], [], `${ev}: 인물·배경·2단계 자료가 시점 뒤 출처를 씀`);
    assert.deepEqual(f.AFTERMATH.flatMap((a) => a.src).filter(before), [], `${ev}: 7단계가 시점 전 출처를 씀`);
  }
  for (const id of STANDING) assert.match(SOURCES[id].check, /대화 시점/, `${id}: 예외인 이유를 check 에 적는다`);
});

test("모든 사건: 인물마다 틀릴 수 있는 믿음과 실제 메모가 있고, 낱말 풀이와 '같은 사실, 다른 해석' 분류를 갖는다", () => {
  for (const p of PERSONAS) {
    assert.ok((p.beliefs || []).length >= 1, `${p.id}: 믿음`);
    for (const [b, memo] of p.beliefs) assert.ok(b.length > 15 && memo.length > 15, p.id);
  }
  for (const ev of Object.keys(EVENTS)) {
    const ids = MATERIALS[ev].map((c) => c.id);
    assert.ok(ids.includes("words") && ids.includes("readings"), ev);
    assert.ok(MATERIALS[ev].find((c) => c.id === "words").items.length >= 6, `${ev}: 낱말 풀이`);
    assert.ok(MATERIALS[ev].find((c) => c.id === "readings").items.length >= 5, `${ev}: 같은 사실, 다른 해석`);
  }
});

test("국민연금 개혁 사건: 실존 정치인·장관 이름이 나오지 않고, 같은 세대 안에서도 입장이 갈리며, 이후 전개는 대화 시점 뒤의 출처만 쓴다", () => {
  assert.ok(EVENTS.pension2025.scope.outOfScope.some((x) => /실존 인물/.test(x)));
  for (const p of PERSONAS.filter((x) => x.events.includes("pension2025")))
    assert.doesNotMatch([...p.letter, ...p.story, ...p.episodes, ...p.views, ...p.claims.map((c) => c[0])].join(" "),
      /이재명|윤석열|한덕수|최상목|한동훈|유승민|이준석|박수영|진성준|권성동|김남희|우재준|정은경|조규홍|남인순/, p.id);
  // 세대만으로 편이 갈리지 않는다: 청년 가운데 소득보장, 노인 가운데 양보를 말하는 인물이 있다
  assert.match(PERSONAS.find((x) => x.id === "pn_student").stance, /소득보장/);
  assert.match(PERSONAS.find((x) => x.id === "pn_retiree").stance, /양보/);
  for (const a of AFTERMATH.pension2025) assert.ok(a.src.every((id) => /^YA/.test(id)), a.text);
});

test("4단계 해외 사례 카드: 여는 정책과 막는 정책이 섞여 있고, 출처 링크가 있으며 검증된 것만 학생에게 나간다", () => {
  const all = Object.values(CASES).flat();
  for (const [ev, list] of Object.entries(CASES)) assert.ok(list.length >= 3, ev);
  assert.ok(CASES.jeju2018.some((c) => c.id === "australia") && CASES.jeju2018.some((c) => c.id === "canada"));
  for (const c of all) {
    assert.ok(c.country && c.title && c.what.length > 30 && c.result.length > 30 && c.think.length > 20, c.id);
    for (const id of c.src) assert.match(SOURCES[id].url, /^https:\/\//, `${c.id}: ${id}`);
  }
  assert.equal(casesFor("jeju2018", false).length, CASES.jeju2018.length);
  // 출처 대조를 마친 사건의 카드는 학생에게 나간다
  assert.equal(casesFor("waste2019", false).length, CASES.waste2019.length);
  for (const ev of ["school2018", "junam2025", "changwon2025"]) assert.equal(casesFor(ev, false).length, CASES[ev].length, ev);
  const shown = casesFor("jeju2018", true);
  assert.ok(shown.every((c) => c.links.length && !("src" in c) && c.links.every((l) => l.url && !("verified" in l))));
});

test("7단계 이후 전개 자료: 종류와 출처가 있고 검증된 것만 학생에게 나간다", () => {
  for (const [ev, list] of Object.entries(AFTERMATH)) assert.ok(list.length >= 4, ev);
  for (const a of Object.values(AFTERMATH).flat()) { assert.ok(KINDS.includes(a.kind)); assert.ok(a.src.every((id) => SOURCES[id])); }
  assert.equal(aftermathFor("jeju2018", false).length, AFTERMATH.jeju2018.length);
  for (const ev of ["school2018", "junam2025", "changwon2025"]) assert.equal(aftermathFor(ev, false).length, AFTERMATH[ev].length, ev);
  assert.ok(aftermathFor("jeju2018", true).every((a) => a.caption && a.links.length));
});

test("제주 출처에는 모두 검색 교차 확인 기록이 있고, 확인 못 한 진술을 정리한 뒤 검증됨으로 표시했다", () => {
  for (const [id, x] of Object.entries(SOURCES).filter(([id]) => /^[JCAN]\d/.test(id))) {
    assert.ok(["ok", "partial", "fixed", "todo"].includes(x.crossCheck?.status), id);
    assert.ok(x.crossCheck.note.length > 5, id);
    assert.equal(x.verified, true, id);
  }
});

test("인물마다 틀릴 수 있는 믿음(beliefs)이 있어 인물끼리 같은 사실을 다르게 말하고, 프롬프트·감독자는 이를 위반으로 보지 않는다", () => {
  const { guardMessages } = require("../guard");
  for (const ev of Object.values(EVENTS)) {
    const withB = PERSONAS.filter((p) => p.events.includes(ev.id) && (p.beliefs || []).length);
    assert.ok(withB.length >= 4, ev.id);
    for (const p of withB) {
      for (const [t, note] of p.beliefs) { assert.ok(t.length > 15 && note.length > 15, p.id); }
      const prompt = personaPrompt(ev, p);
      assert.match(prompt, /\[네가 믿고 있는 것\]/);
      assert.ok(p.beliefs.every((b) => prompt.includes(b[0])), p.id);
      assert.ok(!p.beliefs.some((b) => prompt.includes(b[1])), `${p.id}: 교사용 메모(실제)는 인물에게 주지 않는다`);
      const [sys] = guardMessages({ event: ev, persona: p, claims: p.claims, studentMessage: "정말요?", reply: "..." });
      assert.ok(p.beliefs.every((b) => sys.content.includes(b[0])), p.id);
      assert.match(sys.content, /fabrication·kind 위반이 아니다/);
    }
  }
  assert.match(personaPrompt(EVENTS.jeju2018, PERSONAS.find((p) => p.id === "j_resident")), /자기 처지에서|네 처지에서/);
});

test("새 주제 여섯 개: 인물들의 삶이 서로 스치고(양쪽 이야기에 같은 장면), 모든 사건이 자료·사례·인물 이야기의 풍부함 기준을 채운다", () => {
  const life = (id) => { const p = PERSONAS.find((x) => x.id === id); assert.ok(p, id); return [...p.story, ...p.episodes].join(" "); };
  const both = (a, b, mark) => { assert.match(life(a), new RegExp(mark), `${a}: ${mark}`); assert.match(life(b), new RegExp(mark), `${b}: ${mark}`); };
  const sep = (a, am, b, bm) => { assert.match(life(a), new RegExp(am), `${a}: ${am}`); assert.match(life(b), new RegExp(bm), `${b}: ${bm}`); };
  // 스마트폰
  both("ph_middle", "ph_mom", "학교로 전화를"); both("ph_middle", "ph_teacher", "뒷자리 아이를");
  both("ph_assist", "ph_head", "매번 설명하지 않게 해 주세요"); both("ph_dad", "ph_activist", "학부모 단체");
  sep("ph_head", "장학사에게 전화를", "ph_officer", "교감이 전화로");
  // 기후소송
  both("cl_plaintiff", "cl_activist", "우리 이겼는데 왜"); both("cl_future", "cl_citizen", "그럼 어떻게 하면 좋을까요");
  both("cl_voc", "cl_sme", "대표님, 이 일 앞으로 괜찮을까요"); both("cl_activist", "cl_coal", "가족 이야기");
  both("cl_aide", "cl_activist", "복도"); both("cl_activist", "cl_officer", "하한이 목표가 될 거예요");
  // 산불
  both("wf_grandma", "wf_volunteer", "사과 한 알"); both("wf_chief", "wf_forestry", "우리 마을 언제 불 꺼집니까");
  both("wf_teen", "wf_volunteer", "우리 집 이제 없어요"); both("wf_forester", "wf_activist", "내 산 좀 같이 걸어");
  both("wf_diner", "wf_county", "손을 맞잡");
  // 작은 학교
  both("sm_pupil", "sm_teacher", "우리 학교 없어져요"); both("sm_chief", "sm_store", "평상"); both("sm_returnee", "sm_chief", "감자를 한 상자");
  both("sm_parent", "sm_returnee", "학부모 모임"); both("sm_office", "sm_ministry", "돈보다 선생님이 필요하다"); both("sm_activist", "sm_ministry", "이게 혁신입니까");
  // 개식용
  both("dm_farmer", "dm_neighbor", "이제 좀 조용하겠네요"); both("dm_farmer", "dm_local", "이게 다예요"); both("dm_son", "dm_farmer", "아버지, 미안해요");
  both("dm_activist", "dm_vet", "이십 마리를 받아 줄 수 있나요"); both("dm_restaurant", "dm_student", "메뉴판"); both("dm_ministry", "dm_activist", "언제까지요");
  // 국민연금 개혁
  both("pn_worker", "pn_owner", "연금 박사"); both("pn_worker", "pn_fiscal", "청년 연금 간담회"); both("pn_student", "pn_welfare", "할머니가 되었을 때의 당신에게");
  both("pn_freelancer", "pn_ceo", "그림값을 조금 더"); both("pn_retiree", "pn_grandma", "귤 한 봉지"); both("pn_fiscal", "pn_welfare", "결국 둘 다 연금을 지키자는 거죠");

  // 풍부함 기준: 열 개 사건 모두
  for (const ev of Object.keys(EVENTS)) {
    const mats = materialsFor(ev, true);
    assert.ok(mats.length >= 6, `${ev}: 자료 분류`);
    assert.ok(mats.reduce((a, c) => a + c.items.length, 0) >= 35, `${ev}: 자료 항목`);
    assert.ok(mats.some((c) => c.stats && c.stats.length >= 3), `${ev}: 숫자 타일`);
    assert.ok(CASES[ev].length >= 4, `${ev}: 4단계 사례`);
    assert.ok(AFTERMATH[ev].length >= 6, `${ev}: 이후 전개`);
    const ps = PERSONAS.filter((p) => p.events.includes(ev));
    assert.ok(ps.reduce((a, p) => a + p.claims.length, 0) / ps.length >= 7, `${ev}: 인물당 근거 진술`);
    assert.ok(ps.every((p) => p.episodes.length >= 4 && p.story.length >= 6), `${ev}: 인물 이야기`);
    assert.ok(EVENTS[ev].teacherNote.length >= 400, `${ev}: 교사 메모`);
  }
  // 새 주제 여섯 개는 낱말 풀이와 '같은 사실, 다른 해석' 분류를 갖는다
  for (const ev of NEW) {
    const ids = MATERIALS[ev].map((c) => c.id);
    assert.ok(ids.includes("words") && ids.includes("readings"), ev);
    assert.ok(MATERIALS[ev].find((c) => c.id === "words").items.length >= 6, ev);
    assert.ok(MATERIALS[ev].find((c) => c.id === "readings").items.length >= 5, ev);
  }
});
