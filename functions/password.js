// 학생 비밀번호 확인용 도구. 별명 + 비밀번호로 본인임을 확인한다(구글 계정까지는 아님).
//  - 비밀번호는 scrypt 로 해시해 서버 전용 문서(sessions/{code}/creds/*)에만 저장한다. 클라이언트는 읽을 수 없다.
//  - 같은 (모둠, 별명)에는 비밀번호가 하나다. 처음 입장하면 정하고, 다시 들어올 때는 같은 비밀번호를 쓴다.
//  - 연속으로 틀리면 잠시 잠근다.
const crypto = require("crypto");

const MIN_LEN = 4;
const MAX_LEN = 40;
// 잠금은 두 겹이다. (1) 틀린 사람(접속 계정)별: 5번 연속 틀리면 1분. 같은 모둠 친구가 일부러 틀려서 다른 학생을 못 들어오게 하는 일을 막는다.
// (2) 별명 전체: 여러 계정을 바꿔 가며 알아내려는 시도를 막기 위해 누적 30번 틀리면 5분.
const MAX_FAILS = 5;
const LOCK_MS = 60 * 1000;
const MAX_TOTAL_FAILS = 30;
const TOTAL_LOCK_MS = 5 * 60 * 1000;

function validatePassword(pw) {
  const s = String(pw ?? "");
  if (s.length < MIN_LEN) return `비밀번호는 ${MIN_LEN}자 이상으로 정하세요.`;
  if (s.length > MAX_LEN) return `비밀번호는 ${MAX_LEN}자 이하로 정하세요.`;
  return null;
}

// scrypt 는 CPU 를 많이 쓴다. 동기 함수(scryptSync)는 그동안 서버가 다른 요청을 못 받아서, 한 반이 동시에 입장하면 줄을 서서
// 마지막 학생이 몇 초씩 기다린다. 비동기 scrypt 는 따로 돌아가 여러 학생이 함께 처리된다.
const scrypt = (pw, salt) => new Promise((resolve, reject) => crypto.scrypt(String(pw), salt, 32, (e, key) => (e ? reject(e) : resolve(key))));

async function hashPassword(pw, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: (await scrypt(pw, salt)).toString("hex") };
}

async function verifyPassword(pw, cred) {
  if (!cred?.salt || !cred?.hash) return false;
  const a = await scrypt(pw, cred.salt);
  const b = Buffer.from(cred.hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 별명은 앞뒤 공백, 대소문자, 유니코드 표기 차이를 무시하고 같은 별명으로 본다
const normNick = (n) => String(n ?? "").trim().normalize("NFC").toLowerCase();
const credKey = (groupNo, nick) => `${groupNo}_${crypto.createHash("sha1").update(normNick(nick)).digest("hex").slice(0, 20)}`;

// 지금 잠겨 있으면 남은 초, 아니면 0
const lockedSeconds = (cred, now = Date.now()) => (cred?.lockUntil > now ? Math.ceil((cred.lockUntil - now) / 1000) : 0);

// 실패 후 저장할 값
function afterFail(cred, now = Date.now(), max = MAX_FAILS, lockMs = LOCK_MS) {
  const fails = (cred?.fails || 0) + 1;
  return fails >= max ? { fails: 0, lockUntil: now + lockMs } : { fails, lockUntil: 0 };
}
const afterTotalFail = (cred, now = Date.now()) => afterFail(cred, now, MAX_TOTAL_FAILS, TOTAL_LOCK_MS);

module.exports = { validatePassword, hashPassword, verifyPassword, normNick, credKey, lockedSeconds, afterFail, afterTotalFail, MIN_LEN, MAX_LEN, MAX_FAILS, LOCK_MS, MAX_TOTAL_FAILS, TOTAL_LOCK_MS };
