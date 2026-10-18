const test = require("node:test");
const assert = require("node:assert");
const { validatePassword, hashPassword, verifyPassword, credKey, normNick, lockedSeconds, afterFail, afterTotalFail } = require("../password");

test("비밀번호 길이 규칙", () => {
  assert.ok(validatePassword("abc"));
  assert.equal(validatePassword("abcd"), null);
  assert.ok(validatePassword("x".repeat(41)));
  assert.ok(validatePassword(undefined));
});

test("해시: 같은 비밀번호만 통과하고, 소금이 달라 해시도 다르다", async () => {
  const a = await hashPassword("sesame1"), b = await hashPassword("sesame1");
  assert.notEqual(a.hash, b.hash);
  assert.ok(await verifyPassword("sesame1", a));
  assert.equal(await verifyPassword("sesame2", a), false);
  assert.equal(await verifyPassword("sesame1", null), false);
  assert.equal(await verifyPassword("", a), false);
});

test("해시는 서버를 막지 않는다: 여러 학생이 동시에 입장해도 함께 처리된다(비동기 scrypt)", async () => {
  const t = Date.now();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5); // 해시를 하는 동안에도 서버가 다른 일을 할 수 있으면 계속 올라간다
  const hashes = await Promise.all(Array.from({ length: 6 }, (_, i) => hashPassword("pw" + i)));
  clearInterval(timer);
  assert.equal(hashes.length, 6);
  assert.ok(ticks > 2, `해시하는 동안 다른 일이 멈췄다 (${ticks}번, ${Date.now() - t}ms)`);
});

test("별명 키: 공백·대소문자·표기 차이는 같은 별명, 모둠이 다르면 다른 키", () => {
  assert.equal(credKey(1, " Garam "), credKey(1, "garam"));
  assert.equal(normNick("가람 "), "가람");
  assert.notEqual(credKey(1, "가람"), credKey(2, "가람"));
  assert.notEqual(credKey(1, "가람"), credKey(1, "나래"));
  assert.match(credKey(1, "가람"), /^1_[0-9a-f]{20}$/);
});

test("잠금: 5번째 실패에서 잠기고 시간이 지나면 풀린다", () => {
  let cred = {};
  for (let i = 0; i < 4; i++) cred = { ...cred, ...afterFail(cred, 1000) };
  assert.equal(lockedSeconds(cred, 1000), 0);
  cred = { ...cred, ...afterFail(cred, 1000) };
  assert.equal(lockedSeconds(cred, 1000), 60);
  assert.equal(lockedSeconds(cred, 1000 + 61000), 0);
});

test("별명 전체 잠금은 누적 30번에서 5분", () => {
  let cred = {};
  for (let i = 0; i < 29; i++) cred = { ...cred, ...afterTotalFail(cred, 0) };
  assert.equal(lockedSeconds(cred, 0), 0);
  cred = { ...cred, ...afterTotalFail(cred, 0) };
  assert.equal(lockedSeconds(cred, 0), 300);
});
