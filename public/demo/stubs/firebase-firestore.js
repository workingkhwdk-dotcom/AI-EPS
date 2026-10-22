// 체험용 가짜 Firestore: ../store.js(이 기기의 localStorage)를 쓴다.
import * as st from "../store.js";
st.seed();
export const getFirestore = () => ({});
export const initializeFirestore = () => ({});
export const doc = (_db, p) => ({ p });
export const collection = (_db, p) => ({ p });
export const orderBy = (field) => ({ orderBy: field });
export const query = (c, ...ops) => ({ ...c, order: ops.find((o) => o.orderBy)?.orderBy });
export const serverTimestamp = () => st.SERVER_TS;
export const deleteField = () => st.DELETE;
export const increment = (n) => st.inc(n);
const one = async (ref) => st.snapshotOf(ref.p);
export const getDoc = one;
export const getDocFromServer = one;
export const updateDoc = async (ref, data) => { st.update(ref.p, data); };
export const setDoc = async (ref, data) => { st.set(ref.p, data); };
export const onSnapshot = (ref, cb) => st.subscribe(ref, cb);
