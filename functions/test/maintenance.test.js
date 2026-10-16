const test = require("node:test");
const assert = require("node:assert");
const { autoCloseDue, lastActivityMs, staleAnonymousUids, toMs } = require("../maintenance");
const { buildResponsesBody } = require("../openai");

const H = 3600 * 1000;
test("자동 닫힘: 마지막 활동 후 정한 시간이 지나야 닫고, 꺼져 있거나 이미 닫혔거나 최근 접속이 있으면 닫지 않는다", () => {
  const sess = { createdAt: 0, autoCloseHours: 2, closed: false };
  assert.equal(autoCloseDue(sess, [], 2 * H), true);
  assert.equal(autoCloseDue(sess, [], 2 * H - 1), false);
  assert.equal(autoCloseDue(sess, [{ lastSeen: 1.5 * H }], 3 * H), false, "학생이 최근에 접속했다");
  assert.equal(autoCloseDue(sess, [{ lastSeen: 1.5 * H }], 3.5 * H), true);
  assert.equal(autoCloseDue({ ...sess, autoCloseHours: 0 }, [], 99 * H), false);
  assert.equal(autoCloseDue({ ...sess, closed: true }, [], 99 * H), false);
  assert.equal(autoCloseDue({ ...sess, openedAt: 10 * H }, [], 11 * H), false, "다시 연 때부터 센다");
  assert.equal(lastActivityMs({ createdAt: { toMillis: () => 5 } }, [{ lastSeen: { toMillis: () => 9 } }]), 9);
  assert.equal(toMs(undefined), 0);
});

test("익명 계정 정리: 오래 안 쓴 익명 계정만 고르고 구글 계정·이메일 계정은 건드리지 않는다", () => {
  const now = Date.parse("2026-10-16T00:00:00Z");
  const users = [
    { uid: "old-anon", providerData: [], metadata: { lastSignInTime: "2026-08-01T00:00:00Z" } },
    { uid: "new-anon", providerData: [], metadata: { lastSignInTime: "2026-10-10T00:00:00Z" } },
    { uid: "teacher", email: "t@x.kr", providerData: [{ providerId: "google.com" }], metadata: { lastSignInTime: "2020-01-01T00:00:00Z" } },
    { uid: "email-user", email: "a@b.c", providerData: [], metadata: { lastSignInTime: "2020-01-01T00:00:00Z" } },
  ];
  assert.deepEqual(staleAnonymousUids(users, now), ["old-anon"]);
});

test("검색 도메인 제한: 목록이 있을 때만 allowed_domains 를 보낸다", () => {
  assert.equal("filters" in buildResponsesBody({ model: "gpt-5-mini", instructions: "i", input: "q" }).tools[0], false);
  assert.deepEqual(buildResponsesBody({ model: "gpt-5-mini", instructions: "i", input: "q", domains: ["yna.co.kr"] }).tools[0].filters, { allowed_domains: ["yna.co.kr"] });
});
