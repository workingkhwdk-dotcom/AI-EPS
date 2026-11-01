// 운영 편의: 자동 닫힘, 오래된 익명 계정 정리. 순수 함수로 나눠 테스트한다.
const toMs = (v) => (typeof v === "number" ? v : v?.toMillis?.() ?? 0);

// 자동 닫힘 시간 선택지(시간). 0 은 사용 안 함.
const AUTO_CLOSE_CHOICES = [0, 1, 2, 4, 8, 24];

// 수업의 마지막 활동 시각: 만들거나 다시 연 때와 학생들의 마지막 접속 중 가장 늦은 것
const lastActivityMs = (sess, members) =>
  Math.max(toMs(sess.openedAt), toMs(sess.createdAt), ...members.map((m) => toMs(m.lastSeen)));

// 열려 있고 자동 닫힘이 켜져 있으며, 마지막 활동 후 정한 시간이 지났으면 닫아야 한다
const autoCloseDue = (sess, members, now = Date.now()) =>
  !sess.closed && sess.autoCloseHours > 0 && now - lastActivityMs(sess, members) >= sess.autoCloseHours * 3600 * 1000;

// 학생이 쓰던 익명 계정(로그인 수단 없음) 중 마지막 로그인이 오래된 것의 uid 목록
const ANON_KEEP_DAYS = 30;
const staleAnonymousUids = (users, now = Date.now(), days = ANON_KEEP_DAYS) =>
  users
    .filter((u) => !u.email && !(u.providerData || []).length)
    .filter((u) => now - Date.parse(u.metadata?.lastSignInTime || u.metadata?.creationTime || 0) > days * 86400000)
    .map((u) => u.uid);

// 수업 시간대 미리 깨우기: MIN_INSTANCES(항상 켜 두기)는 하루 종일 요금이 붙는다. 대신 수업이 있는 시간대에만
// 몇 분마다 학생이 처음 부르는 함수들에 { warm: true } 를 보내 켜 둔다. 요청을 처리하는 순간에만 요금이 붙어 거의 공짜다.
// 기본은 끔(가장 저렴): 학생 화면이 입장 화면·수업 시작 때 필요한 함수를 스스로 깨운다. 첫 학생이 몇 초 기다릴 수 있다.
// WARM_SCHEDULE: 한국 시간 cron. on 이면 평일 8:00~16:55 5분마다(WARM_DEFAULT), 비우거나 off 면 쓰지 않는다.
const WARM_FUNCTIONS = ["joinSession", "choosePersona", "getCase", "aiRequest"];
const WARM_DEFAULT = "*/5 8-16 * * 1-5";
const warmSchedule = (v) => { const t = String(v ?? "").trim(); if (!t || t.toLowerCase() === "off") return null; return t.toLowerCase() === "on" ? WARM_DEFAULT : t; };
// 호출 가능 함수(onCall)를 HTTPS 로 직접 부른다. 실패해도 다음 차례에 다시 부르므로 결과만 모아 돌려준다.
async function pingWarm({ region, project, fetchImpl = fetch, names = WARM_FUNCTIONS, timeoutMs = 20000 }) {
  return Promise.all(names.map(async (name) => {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`https://${region}-${project}.cloudfunctions.net/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: { warm: true } }), signal: ctl.signal });
      return { name, ok: !!res.ok, status: res.status };
    } catch (e) { return { name, ok: false, error: e.message }; } finally { clearTimeout(timer); }
  }));
}

module.exports = { WARM_FUNCTIONS, WARM_DEFAULT, warmSchedule, pingWarm, toMs, AUTO_CLOSE_CHOICES, lastActivityMs, autoCloseDue, staleAnonymousUids, ANON_KEEP_DAYS };
