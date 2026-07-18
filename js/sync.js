// Realtime sync layer — Firebase Realtime Database (free Spark tier)
// Loads as a module after app.js; app.js works standalone if this never loads.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getDatabase, ref, onValue, set, update, runTransaction } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

const app = initializeApp({
  databaseURL: 'https://calciopoli-wc26-default-rtdb.europe-west1.firebasedatabase.app',
});
const db = getDatabase(app);
// ?sandbox → separate practice league in Firebase; the real one is never touched
const LEAGUE = new URLSearchParams(location.search).has('sandbox')
  ? 'the-league-sandbox' : 'the-league-2627';
const base = `leagues/${LEAGUE}`;

window.WCSync = {
  league: LEAGUE,
  set: (path, val) => set(ref(db, `${base}/${path}`), val),
  setRoot: val => set(ref(db, base), val),
  // atomic multi-key write: one snapshot, no partial states, unlisted keys kept
  update: obj => update(ref(db, base), obj),
  txn: (path, fn) => runTransaction(ref(db, `${base}/${path}`), fn),
};

onValue(ref(db, base), snap => window.onSharedSnapshot?.(snap.val()),
  err => console.warn('[sync] read error', err));
onValue(ref(db, '.info/connected'), snap => window.onSyncConnection?.(!!snap.val()));
