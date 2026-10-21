const test = require("node:test");
const assert = require("node:assert");
const { defaultMaterials, sanitizeMaterials, toStudentMaterials, LIMITS } = require("../materials");
const { parseResponses, buildResponsesBody, buildBody } = require("../openai");
const { lookupTool } = require("../lookup");
const { EVENTS } = require("../case");

test("기본 자료는 항목마다 id 가 있고 출처 ID 는 없다", () => {
  const d = defaultMaterials("jeju2018", true);
  assert.ok(d.length >= 5);
  for (const c of d) for (const it of c.items) assert.ok(it.id && it.text && !("src" in it));
  assert.ok(d.find((c) => c.stats?.length));
  assert.equal(JSON.stringify(sanitizeMaterials(d)).includes("src"), false);
});

test("sanitize: 종류·길이를 정리하고 id 중복을 없앤다", () => {
  const out = sanitizeMaterials([
    { id: "a", title: "  분류  ", type: "weird", items: [{ id: "x", text: " 내용 ", kind: "엉뚱", date: "d".repeat(100) }, { id: "x", text: "둘째" }] },
  ]);
  assert.equal(out[0].title, "분류");
  assert.equal(out[0].type, "list");
  assert.equal(out[0].items[0].kind, "사실");
  assert.equal(out[0].items[0].date.length, LIMITS.date);
  assert.notEqual(out[0].items[0].id, out[0].items[1].id);
});

test("sanitize: 잘못된 입력은 거부한다", () => {
  assert.throws(() => sanitizeMaterials("x"), /형식/);
  assert.throws(() => sanitizeMaterials([{ title: "", items: [] }]), /분류 이름/);
  assert.throws(() => sanitizeMaterials([{ title: "a", items: [{ text: "" }] }]), /내용이 빈/);
  assert.throws(() => sanitizeMaterials(Array.from({ length: LIMITS.categories + 1 }, () => ({ title: "a", items: [] }))), /최대/);
  assert.throws(() => sanitizeMaterials([{ title: "a", items: Array.from({ length: LIMITS.items + 1 }, () => ({ text: "t" })) }]), /최대/);
});

test("학생용 변환: 빈 분류는 빠지고, 통계만 있는 분류는 남는다", () => {
  const s = toStudentMaterials([{ id: "a", title: "A", items: [] }, { id: "b", title: "B", stats: [{ label: "l", value: "1" }], items: [] }, { id: "c", title: "C", items: [{ kind: "사실", text: "t", caption: "" }] }]);
  assert.deepEqual(s.map((c) => c.id), ["b", "c"]);
  assert.equal(s[1].items[0].caption, "선생님이 준비한 자료");
});

test("Responses API: 글과 인용 출처(중복 제거)를 꺼낸다", () => {
  const r = parseResponses({ output: [{ type: "web_search_call" }, { type: "message", content: [{ type: "output_text", text: "412명이다.", annotations: [{ type: "url_citation", url: "https://a", title: "A" }, { type: "url_citation", url: "https://a", title: "A2" }, { type: "url_citation", url: "https://b" }] }] }] });
  assert.equal(r.text, "412명이다.");
  assert.deepEqual(r.sources.map((s) => s.url), ["https://a", "https://b"]);
  assert.deepEqual(parseResponses({}), { text: "", sources: [] });
});

test("요청 본문: 검색은 web_search 도구를 쓰고 minimal 사고량은 low 로 올린다 / 일반 호출은 tools 를 넣을 때만 보낸다", () => {
  const b = buildResponsesBody({ model: "gpt-5-mini", instructions: "i", input: "q", effort: "minimal" });
  assert.equal(b.tools[0].type, "web_search");
  assert.equal(b.reasoning.effort, "low");
  assert.equal("tools" in buildBody({ model: "gpt-5-mini", messages: [] }), false);
  assert.equal(buildBody({ model: "gpt-5-mini", messages: [], tools: [lookupTool(EVENTS.jeju2018)] }).tools[0].function.name, "lookup");
});

test("materialsText: 3단계 근거용으로 분류·종류·날짜·출처를 한 줄씩 적고, 길면 줄 단위로 자른다", () => {
  const { materialsText } = require("../materials");
  const cats = [{ title: "심사 결과", stats: [{ label: "인도적 체류", value: "412명" }], items: [{ kind: "사실", date: "2018.12", text: "심사가 끝났다", caption: "법무부" }] }];
  const t = materialsText(cats);
  assert.match(t, /^- \[심사 결과\] \(통계\) 인도적 체류: 412명/);
  assert.match(t, /- \[심사 결과\] \(사실\) 2018\.12 심사가 끝났다 — 법무부/);
  assert.equal(materialsText(cats, 30).split("\n").length, 1);
  assert.equal(materialsText(undefined), "");
});
