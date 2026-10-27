const test = require("node:test");
const assert = require("node:assert");
const { checkBundle } = require("../topicCheck");

const FILES = ["jeju2018", "waste2019", "school2018", "junam2025", "changwon2025",
  "phone2026", "climate2024", "wildfire2025", "smallschool2026", "dogmeat2024", "pension2025"].map((f) => require(`../cases/${f}`));
const copy = (x) => JSON.parse(JSON.stringify(x));

test("기본 주제 열한 개는 구조 검사에서 오류도 경고도 없다(교사 주제와 같은 기준)", () => {
  for (const f of FILES) {
    const r = checkBundle(f);
    assert.deepEqual(r.errors, [], f.EVENT.id);
    assert.deepEqual(r.warnings, [], f.EVENT.id);
    assert.equal(r.ok, true);
  }
});

test("빠진 칸·없는 출처·축 부족·메타 표현·실존 인물 이름·한 줄 소개 누락을 오류로 잡는다", () => {
  const f = copy(FILES[3]);
  const p = f.PERSONAS[0];
  p.claims[0][1] = "XX1";
  p.letter[2] += " 이건 수업용 인물이에요.";
  f.EVENT.realNames = ["홍길동"];
  p.story[0] += " 홍길동 시장이 왔다.";
  delete f.BRIEFS[f.PERSONAS[1].id];
  delete f.EVENT.ui.priorQuestion;
  f.PERSONAS = f.PERSONAS.filter((x) => x.axis !== f.EVENT.axes[3]);
  const r = checkBundle(f);
  const has = (re) => r.errors.some((e) => re.test(`${e.where} ${e.msg}`));
  assert.equal(r.ok, false);
  assert.ok(has(/없는 출처 XX1/));
  assert.ok(has(/수업·개발 관점의 말\('수업용'\)/));
  assert.ok(has(/실존 인물 이름 '홍길동'/));
  assert.ok(has(/한 줄 소개/));
  assert.ok(has(/priorQuestion/));
  assert.ok(has(new RegExp(`'${f.EVENT.axes[3]}' 축의 인물이 없습니다`)));
});

test("기본 주제보다 덜 다듬어진 곳은 경고로 알려 준다(인물 수, 근거 진술 수, 이후 전개, 스치는 장면)", () => {
  const f = copy(FILES[0]);
  f.PERSONAS = f.PERSONAS.slice(0, 8);
  f.PERSONAS[0].claims = f.PERSONAS[0].claims.slice(0, 5);
  f.AFTERMATH = [];
  const r = checkBundle(f, { links: [{ a: f.PERSONAS[0].id, b: f.PERSONAS[1].id, a_mark: "없는 장면", b_mark: "쉼터" }] });
  const has = (re) => r.warnings.some((e) => re.test(`${e.where} ${e.msg}`));
  assert.ok(has(/인물이 8명/));
  assert.ok(has(/근거 진술이 5개/));
  assert.ok(has(/이후 전개가 0개/));
  assert.ok(has(/'없는 장면' 장면이 없습니다/));
  assert.ok(!has(/'쉼터' 장면이 없습니다/));
  assert.ok(has(/쓰이지 않는 출처/), "인물을 뺐더니 그 인물만 쓰던 출처가 남는다");
});
