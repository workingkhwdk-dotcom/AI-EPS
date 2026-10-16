// 학생 비밀번호 확인용 도구. 별명 + 비밀번호로 본인임을 확인한다(구글 계정까지는 아님).
//  - 비밀번호는 scrypt 로 해시해 서버 전용 문서(sessions/{code}/creds/*)에만 저장한다. 클라이언트는 읽을 수 없다.
//  - 같은 (모둠, 별명)에는 비밀번호가 하나다. 처음 입장하면 정하고, 다시 들어올 때는 같은 비밀번호를 쓴다.
//  - 연속으로 틀리면 잠시 잠근다.
const crypto = require("crypto");

const MIN_LEN = 4;
const MAX_LEN = 40;
const MAX_FAILS = 5;
const LOCK_MS = 60 * 1000;

function validatePassword(pw) {
  const s = String(pw ?? "");
  if (s.length < MIN_LEN) return `비밀번호는 ${MIN_LEN}자 이상으로 정하세요.`;
  if (s.length > MAX_LEN) return `비밀번호는 ${MAX_LEN}자 이하로 정하세요.`;
  return null;
}

function hashPassword(pw, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(String(pw), salt, 32).toString("hex") };
}

function verifyPassword(pw, cred) {
  if (!cred?.salt || !cred?.hash) return false;
  const a = Buffer.from(hashPassword(pw, cred.salt).hash, "hex");
  const b = Buffer.from(cred.hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 별명은 앞뒤 공백, 대소문자, 유니코드 표기 차이를 무시하고 같은 별명으로 본다
const normNick = (n) => String(n ?? "").trim().normalize("NFC").toLowerCase();
const credKey = (groupNo, nick) => `${groupNo}_${crypto.createHash("sha1").update(normNick(nick)).digest("hex").slice(0, 20)}`;

// 지금 잠겨 있으면 남은 초, 아니면 0
const lockedSeconds = (cred, now = Date.now()) => (cred?.lockUntil > now ? Math.ceil((cred.lockUntil - now) / 1000) : 0);

// 실패 후 저장할 값
function afterFail(cred, now = Date.now()) {
  const fails = (cred?.fails || 0) + 1;
  return fails >= MAX_FAILS ? { fails: 0, lockUntil: now + LOCK_MS } : { fails, lockUntil: 0 };
}

module.exports = { validatePassword, hashPassword, verifyPassword, normNick, credKey, lockedSeconds, afterFail, MIN_LEN, MAX_LEN, MAX_FAILS, LOCK_MS };
