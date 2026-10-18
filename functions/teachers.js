// 교사 자격 판정. 아래 세 곳 중 어디에든 이메일이 있으면 교사로 인정한다(대소문자 무시).
//  1) ADMIN_EMAILS  : 코드에 고정된 관리자. 설정 실수로 잠기지 않도록 항상 교사다.
//     FIXED_TEACHERS: 코드에 고정된 교사(관리자는 아님). 바꾸려면 재배포가 필요하다.
//  2) TEACHER_EMAILS: 배포 설정(.env)의 쉼표 목록
//  3) Firestore config/teachers 문서의 emails 필드: Firebase 콘솔에서 바로 추가·삭제(재배포 불필요)
// 교사는 인증된 이메일(구글 로그인)이어야 한다. 예외로 PASSWORD_TEACHERS 는 관리자가 Firebase 콘솔(Authentication)에서
// 직접 만든 이메일·비밀번호 계정이라 이메일 인증 표시가 없어도 교사로 인정한다. 이미 만들어 둔 계정이므로 다른 사람이
// 같은 이메일로 새로 가입할 수 없다. 이 계정을 콘솔에서 지우면 여기서도 지울 것(지운 뒤 남이 같은 이메일로 가입하지 못하게).

const ADMIN_EMAILS = ["working.khwdk@gmail.com"];
const FIXED_TEACHERS = ["ccchoihy@gmail.com"];
const PASSWORD_TEACHERS = ["teacher@knue.com"];

const norm = (e) => String(e || "").trim().toLowerCase();

// Firestore 필드는 문자열 배열이 기본이지만, 쉼표로 구분된 문자열로 입력해도 인정한다.
function parseEmails(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  return list.map(norm).filter(Boolean);
}

// 교사로 볼 수 있는 로그인인지: 인증된 이메일이거나, 관리자가 만든 이메일·비밀번호 교사 계정
function trustedLogin(token) {
  if (token?.email_verified === true) return true;
  return token?.firebase?.sign_in_provider === "password" && PASSWORD_TEACHERS.map(norm).includes(norm(token.email));
}

async function isTeacherEmail(email, { envList = "", readDoc }) {
  const e = norm(email);
  if (!e) return false;
  if ([...ADMIN_EMAILS, ...FIXED_TEACHERS, ...PASSWORD_TEACHERS].map(norm).includes(e)) return true;
  if (parseEmails(envList).includes(e)) return true;
  try {
    const doc = await readDoc();
    return parseEmails(doc?.emails).includes(e);
  } catch (err) {
    console.error("config/teachers 읽기 실패", err);
    return false;
  }
}

module.exports = { ADMIN_EMAILS, FIXED_TEACHERS, PASSWORD_TEACHERS, parseEmails, isTeacherEmail, trustedLogin };
