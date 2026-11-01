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

// ---------- 수업 시간대 미리 깨우기 ----------
test("미리 깨우기 시간표: 비우면 평일 8~16시 5분마다, off 면 쓰지 않음, 직접 정하면 그대로", () => {
  const { warmSchedule, WARM_DEFAULT } = require("../maintenance");
  assert.equal(warmSchedule(undefined), WARM_DEFAULT);
  assert.equal(warmSchedule(""), "*/5 8-16 * * 1-5");
  assert.equal(warmSchedule("OFF"), null);
  assert.equal(warmSchedule(" */10 9-15 * * 1-5 "), "*/10 9-15 * * 1-5");
});

test("미리 깨우기: 학생이 처음 부르는 함수 4개에 { warm: true } 를 보내고, 실패해도 결과만 모은다", async () => {
  const { pingWarm, WARM_FUNCTIONS } = require("../maintenance");
  const sent = [];
  const fetchImpl = async (url, o) => { sent.push([url, JSON.parse(o.body)]); if (url.endsWith("/getCase")) throw new Error("network"); return { ok: !url.endsWith("/aiRequest"), status: url.endsWith("/aiRequest") ? 500 : 200 }; };
  const r = await pingWarm({ region: "asia-northeast3", project: "p1", fetchImpl });
  assert.deepEqual(sent.map(([u]) => u), WARM_FUNCTIONS.map((n) => `https://asia-northeast3-p1.cloudfunctions.net/${n}`));
  assert.ok(sent.every(([, b]) => b.data.warm === true));
  assert.deepEqual(r.map((x) => [x.name, x.ok]), [["joinSession", true], ["choosePersona", true], ["getCase", false], ["aiRequest", false]]);
});
