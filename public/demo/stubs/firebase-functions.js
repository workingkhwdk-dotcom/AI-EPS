// 체험용 가짜 서버 함수: ../server.js 가 서버 대신 답한다.
import { callFunction } from "../server.js";
export const getFunctions = () => ({});
export const httpsCallable = (_f, name) => async (data) => ({ data: await callFunction(name, data || {}) });
