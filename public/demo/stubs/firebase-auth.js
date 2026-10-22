// 체험용 가짜 로그인: 누구나 같은 익명 사용자 한 명으로 바로 들어간다.
import { UID } from "../store.js";
const user = { uid: UID, isAnonymous: true };
const auth = { currentUser: user, authStateReady: async () => {} };
export const getAuth = () => auth;
export const setPersistence = async () => {};
export const browserSessionPersistence = {};
export const onAuthStateChanged = (_a, cb) => { setTimeout(() => cb(user), 0); return () => {}; };
export const signInAnonymously = async () => ({ user });
export const signOut = async () => {};
