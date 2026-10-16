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

module.exports = { toMs, AUTO_CLOSE_CHOICES, lastActivityMs, autoCloseDue, staleAnonymousUids, ANON_KEEP_DAYS };
