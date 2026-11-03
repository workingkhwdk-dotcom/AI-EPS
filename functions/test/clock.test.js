// 단계 시간(수업 시계): 기본값, 교사가 보낸 값 검사, 조작(시작·더하기·멈춤·이어 가기·끄기)
const test = require("node:test");
const assert = require("node:assert");
const { STAGE_MIN_DEFAULT, stageMinOf, sanitizeStageMin, leftMs, applyClock } = require("../clock");

const M = 60 * 1000;

test("기본 시간은 수업지도안 배분(1단계 30·2단계 20·3단계 20·4단계 25·5단계 20·6단계 10·7단계 20분)", () => {
  assert.deepEqual(STAGE_MIN_DEFAULT, { 1: 30, 2: 20, 3: 20, 4: 25, 5: 20, 6: 10, 7: 20 });
  // 1단계 30 + 2단계 앞부분 15 + 수업 열기 5 = 1차시 50, 2단계 뒷부분 5 + 3단계 20 + 4단계 25 = 2차시 50, 5·6·7단계 = 3차시 50
  assert.equal(Object.values(STAGE_MIN_DEFAULT).reduce((a, b) => a + b, 0) + 5, 150);
  assert.deepEqual(stageMinOf({}), STAGE_MIN_DEFAULT, "예전 수업은 기본값");
  assert.deepEqual(stageMinOf({ stageMin: { 1: 40, 2: "x", 3: 0, 4: 121 } }), { ...STAGE_MIN_DEFAULT, 1: 40 }, "틀린 값은 기본값으로");
});

test("교사가 보낸 단계별 시간은 1~7단계 모두 1~120분 정수여야 한다", () => {
  assert.deepEqual(sanitizeStageMin({ ...STAGE_MIN_DEFAULT, 4: "30" }), { ...STAGE_MIN_DEFAULT, 4: 30 });
  assert.equal(sanitizeStageMin({ ...STAGE_MIN_DEFAULT, 7: undefined }), null);
  assert.equal(sanitizeStageMin({ ...STAGE_MIN_DEFAULT, 1: 0 }), null);
  assert.equal(sanitizeStageMin({ ...STAGE_MIN_DEFAULT, 1: 121 }), null);
  assert.equal(sanitizeStageMin({ ...STAGE_MIN_DEFAULT, 1: 2.5 }), null);
  assert.equal(sanitizeStageMin([1, 2]), null);
  assert.equal(sanitizeStageMin(null), null);
});

test("단계 시작 → 시간 더하기 → 멈춤 → 이어 가기 → 다음 단계 → 끄기", () => {
  const sm = { ...STAGE_MIN_DEFAULT, 2: 15 };
  let c = applyClock(null, { op: "go", stage: 2 }, sm, 1000);
  assert.deepEqual(c, { stage: 2, min: 15, add: 0, endsAt: 1000 + 15 * M, left: null, ev: "go", t: 1000 });
  assert.equal(leftMs(c, 1000 + 5 * M), 10 * M);
  c = applyClock(c, { op: "add", min: 3 }, sm, 2000);
  assert.equal(c.endsAt, 1000 + 18 * M); assert.equal(c.add, 3); assert.equal(c.addNow, 3); assert.equal(c.ev, "add");
  c = applyClock(c, { op: "pause" }, sm, 1000 + 8 * M);
  assert.equal(c.endsAt, null); assert.equal(c.left, 10 * M); assert.equal(leftMs(c, 1e12), 10 * M, "멈춘 동안은 줄지 않는다");
  assert.equal(applyClock(c, { op: "pause" }, sm, 5), c, "이미 멈췄으면 그대로");
  c = applyClock(c, { op: "add", min: 2 }, sm, 9e9);
  assert.equal(c.left, 12 * M, "멈춘 동안 더하면 남은 시간에 더한다");
  c = applyClock(c, { op: "resume" }, sm, 5e6);
  assert.equal(c.endsAt, 5e6 + 12 * M); assert.equal(c.left, null);
  c = applyClock(c, { op: "go", stage: 3 }, sm, 6e6);
  assert.equal(c.stage, 3); assert.equal(c.min, 20); assert.equal(c.add, 0);
  assert.equal(applyClock(c, { op: "stop" }, sm, 7e6), null);
});

test("시간이 지난 뒤 더하면 지금부터 센다. 잘못된 조작은 오류", () => {
  const sm = STAGE_MIN_DEFAULT;
  const c = applyClock(null, { op: "go", stage: 6 }, sm, 0);
  const late = 10 * M + 30 * 1000;
  assert.ok(leftMs(c, late) < 0);
  assert.equal(applyClock(c, { op: "add", min: 1 }, sm, late).endsAt, late + M);
  assert.throws(() => applyClock(null, { op: "add", min: 1 }, sm, 0), /먼저/);
  assert.throws(() => applyClock(c, { op: "add", min: 0 }, sm, 0), /1~30분/);
  assert.throws(() => applyClock(c, { op: "add", min: 31 }, sm, 0), /1~30분/);
  assert.throws(() => applyClock(null, { op: "go", stage: 8 }, sm, 0), /1~7/);
  assert.throws(() => applyClock(null, { op: "go", stage: "x" }, sm, 0), /1~7/);
  assert.throws(() => applyClock(c, { op: "boom" }, sm, 0), /알 수 없는/);
  assert.equal(leftMs(null, 0), null);
});
