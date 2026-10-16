const test = require("node:test");
const assert = require("node:assert");
const { sanitizeOverride, applyOverride, EDITABLE } = require("../personaEdit");
const { PERSONAS } = require("../case");

test("편집 가능한 항목은 말투·삶의 이야기·의견·편지뿐이고 사실·출처·설정은 포함되지 않는다", () => {
  assert.deepEqual([...EDITABLE].sort(), ["episodes", "habits", "inner", "letter", "story", "views", "voice"].sort());
  for (const forbidden of ["claims", "setting", "stance", "role", "sources", "id", "name"]) assert.equal(EDITABLE.includes(forbidden), false);
});

test("sanitize: 허용 항목만 남기고 길이를 줄이며 빈 줄은 버린다. 비워선 안 되는 항목은 거부한다", () => {
  const o = sanitizeOverride({ voice: "  차분하게  ", story: ["하나", " ", "둘"], claims: [["해킹", "J1", "사실"]], setting: "x", name: "y" });
  assert.deepEqual(o, { voice: "차분하게", story: ["하나", "둘"] });
  assert.throws(() => sanitizeOverride({ letter: ["  "] }), /편지/);
  assert.throws(() => sanitizeOverride({ views: [] }), /생각/);
  assert.throws(() => sanitizeOverride({ story: "문자열" }), /형식/);
  assert.throws(() => sanitizeOverride({ story: Array.from({ length: 13 }, () => "a") }), /최대/);
  assert.throws(() => sanitizeOverride({ claims: [] }), /고칠 항목/);
  assert.equal(sanitizeOverride({ voice: "x".repeat(999) }).voice.length, 300);
});

test("apply: 고친 항목만 바뀌고 나머지(근거 진술 등)는 그대로다", () => {
  const p = PERSONAS[0];
  const q = applyOverride(p, { voice: "새 말투", claims: "해킹", name: "해킹" });
  assert.equal(q.voice, "새 말투");
  assert.equal(q.claims, p.claims);
  assert.equal(q.name, p.name);
  assert.equal(applyOverride(p, undefined), p);
});
