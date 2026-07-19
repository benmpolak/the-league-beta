// Realtime layer — Firebase RTDB reads + Auth + server-side mutations.
// Clients can no longer write the database directly: every consequential
// change goes through the `mutate` Cloud Function (see functions/index.js),
// which derives the actor from the verified sign-in token. This module owns
// the Firebase SDK; app.js talks to window.WCSync only.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getDatabase, ref, onValue, connectDatabaseEmulator } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import {
  getAuth, connectAuthEmulator, onAuthStateChanged, signOut,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';

const app = initializeApp({
  apiKey: 'AIzaSyCe9-VZep_3_2BWRPj9TMY0OLSbT8XxPk4',
  authDomain: 'calciopoli-wc26.firebaseapp.com',
  projectId: 'calciopoli-wc26',
  appId: '1:877245883022:web:ae9ed3ee31e6fd910cdfdf',
  databaseURL: 'https://calciopoli-wc26-default-rtdb.europe-west1.firebasedatabase.app',
});
const db = getDatabase(app);
const auth = getAuth(app);
const functions = getFunctions(app, 'europe-west1');

// ?emu=host runs the whole stack against local emulators (tests only)
const params = new URLSearchParams(location.search);
if (params.has('emu')) {
  const host = params.get('emu') || '127.0.0.1';
  connectDatabaseEmulator(db, host, 9000);
  connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
  connectFunctionsEmulator(functions, host, 5001);
}

// ?sandbox → separate practice league; the real one is never touched
const LEAGUE = params.has('sandbox') ? 'the-league-sandbox' : 'the-league-2627';
const base = `v2/leagues/${LEAGUE}`;
const EMAIL_KEY = 'tl-auth-email';

const mutateFn = httpsCallable(functions, 'mutate');

window.WCSync = {
  league: LEAGUE,
  // the one write path: server-authoritative mutation
  call: (action, data = {}) => mutateFn({ league: LEAGUE, action, data }).then(r => r.data),

  auth: {
    user: () => auth.currentUser,
    async sendLink(email) {
      await sendSignInLinkToEmail(auth, email, { url: location.origin + location.pathname + location.search, handleCodeInApp: true });
      localStorage.setItem(EMAIL_KEY, email);
    },
    // completes a magic-link visit; returns true if this page load was one
    async completeLink() {
      if (!isSignInWithEmailLink(auth, location.href)) return false;
      let email = localStorage.getItem(EMAIL_KEY);
      if (!email) email = prompt('Confirm your email to finish signing in:');
      if (!email) return false;
      await signInWithEmailLink(auth, email, location.href);
      localStorage.removeItem(EMAIL_KEY);
      // scrub the one-time code from the address bar
      history.replaceState(null, '', location.pathname + (LEAGUE.endsWith('sandbox') ? '?sandbox' : '') + location.hash);
      return true;
    },
    signOut: () => signOut(auth),
  },
};

// public game state — same callback contract the app has always had
onValue(ref(db, `${base}/public`), snap => window.onSharedSnapshot?.(snap.val()),
  err => console.warn('[sync] read error', err));
onValue(ref(db, '.info/connected'), snap => window.onSyncConnection?.(!!snap.val()));

// per-user private data (autolist + blind claims) and membership follow auth state
let detachers = [];
onAuthStateChanged(auth, user => {
  for (const off of detachers) off();
  detachers = [];
  if (user) {
    detachers.push(onValue(ref(db, `${base}/private/${user.uid}`),
      snap => window.onPrivateSnapshot?.(snap.val()),
      err => console.warn('[sync] private read error', err)));
    detachers.push(onValue(ref(db, `${base}/server/membership/${user.uid}`),
      snap => window.onMembershipSnapshot?.(snap.val()),
      err => console.warn('[sync] membership read error', err)));
  } else {
    window.onPrivateSnapshot?.(null);
    window.onMembershipSnapshot?.(null);
  }
  window.onAuthChanged?.(user ? { uid: user.uid, email: user.email } : null);
});

// finish a magic-link sign-in if this load is one
WCSync.auth.completeLink().catch(e => console.warn('[auth] link', e));
