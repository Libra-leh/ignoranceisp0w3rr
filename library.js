// ================================================================
// THE LIBRARY — Application Logic
// Firebase + Vanilla JS | No frameworks
//
// Sections:
//   STORAGE     — Firestore data layer & local cache
//   STATE       — App-wide variables
//   BOOT        — Startup, login flow
//   USER SELECT — Account picker UI
//   PROFILE     — Profile modal & avatar
//   SHARE       — Share link generation
//   FRIENDS     — Friends section & live sync
//   DRAG        — Drag & drop reorder (My Order)
//   RENDER      — renderBooks, book cards
//   CATEGORIES  — Custom categories
//   BOOK MODAL  — Add / Edit book form
//   COVER       — Cover search & suggestions
//   KNOWLEDGE   — Daily fact modal
//   MISC        — Toast, keyboard, welcome modal
// ================================================================

// ============================================================
//                      STORAGE HELPERS                      
// ============================================================
// Each user's data is stored under keys: lib_u_{username}_books, lib_u_{username}_profile

// ============================================================
//                    FIRESTORE DATA LAYER                   
// ============================================================
// Data is stored in Firestore for cross-device sync.
// A local in-memory cache makes all sync reads work as before.
// localStorage is only used for: language preference, last-user hint.


// ============================================================
//                   DEVICE-LOCAL USER LIST                  
// ============================================================
// Only usernames added/logged-in on THIS device are stored here.
// Other devices start fresh — they never see accounts from other machines.
function getDeviceUsers() {
  try { return JSON.parse(localStorage.getItem('lib_device_users') || '[]'); } catch(e) { return []; }
}
function addDeviceUser(username) {
  const list = getDeviceUsers();
  if (!list.includes(username)) { list.push(username); localStorage.setItem('lib_device_users', JSON.stringify(list)); }
}
function removeDeviceUser(username) {
  const list = getDeviceUsers().filter(u => u !== username);
  localStorage.setItem('lib_device_users', JSON.stringify(list));
}

let _usersCache    = [];  // array of username strings
let _profileCache  = {};  // username -> profile object
let _booksCache    = {};  // username -> books array
let _hashCache     = {};  // username -> pwhash string
let _recoveryCache = {};  // username -> recovery object

// Sync getters (use local cache — populated at boot)
function getUsers()        { return _usersCache; }
function getUserProfile(u) { return _profileCache[u] || null; }
function getUserBooks(u)   { return _booksCache[u]   || []; }
function getUserHash(u)    { return _hashCache[u]    || ''; }
function getUserRecovery(u){ return _recoveryCache[u] || null; }

// Load all users from Firestore into local cache
async function fsLoadAllUsers() {
  if (!db) return; // not configured yet
  // Force fetch from server — bypass stale IndexedDB persistence cache
  const snap = await db.collection(FS_COLLECTION).get({ source: 'server' });
  snap.forEach(d => {
    const data = d.data();
    if (!_usersCache.includes(d.id)) _usersCache.push(d.id);
    _profileCache[d.id]  = data.profile  || null;
    _booksCache[d.id]    = data.books    || [];
    _hashCache[d.id]     = data.pwhash   || '';
    _recoveryCache[d.id] = data.recovery || null;
  });
}

// Write helpers — update cache + Firestore
async function fsCreateUser(username, profile, pwhash, recovery) {
  if (!_usersCache.includes(username)) _usersCache.push(username);
  _profileCache[username]  = profile;
  _booksCache[username]    = [];
  _hashCache[username]     = pwhash;
  _recoveryCache[username] = recovery || null;
  if (db) await db.collection(FS_COLLECTION).doc(username).set({
    profile, pwhash, books: [], recovery: recovery || null, createdAt: Date.now()
  });
}
async function fsUpdateProfile(username, profile) {
  _profileCache[username] = profile;
  if (db) await db.collection(FS_COLLECTION).doc(username).update({ profile });
}
async function fsSaveBooks(username, booksArr) {
  _booksCache[username] = booksArr;
  if (db) {
    // Use set+merge instead of update — works even if 'books' field is missing from document
    await db.collection(FS_COLLECTION).doc(username).set({ books: booksArr }, { merge: true });
  }
}
async function fsUpdateHash(username, pwhash) {
  _hashCache[username] = pwhash;
  if (db) await db.collection(FS_COLLECTION).doc(username).update({ pwhash });
}
async function fsUpdateRecovery(username, recovery) {
  _recoveryCache[username] = recovery;
  if (db) await db.collection(FS_COLLECTION).doc(username).update({ recovery });
}
async function fsDeleteUser(username) {
  _usersCache = _usersCache.filter(u => u !== username);
  delete _profileCache[username];
  delete _booksCache[username];
  delete _hashCache[username];
  delete _recoveryCache[username];
  if (db) await db.collection(FS_COLLECTION).doc(username).delete();
}


// ============================================================
//                           STATE                           
// ============================================================
let currentUser = null;   // username string
let books = [];
let profile = {};
let isReadOnly = false;
let editingId = null, currentFilter = 'all', currentRating = 0;
let nbAvEmoji = '📖', nbAvImg = null, nbAvPreset = null;
let peAvEmoji = '📖', peAvData = null, peAvPreset = null;
let suggestTimer = null, lastSuggestQuery = '';

function uid() { return Date.now().toString(36)+Math.random().toString(36).slice(2); }
function saveBooks() {
  setSyncStatus('saving');
  return fsSaveBooks(currentUser, books)
    .then(() => setSyncStatus('saved'))
    .catch(e => {
      setSyncStatus('error');
      console.warn('saveBooks:', e);
      showToast('⚠️ Books not saved — check your connection or Firestore rules.');
    });
}

let _syncClearTimer = null;
function setSyncStatus(state) {
  const el = document.getElementById('syncIndicator');
  if (!el) return;
  clearTimeout(_syncClearTimer);
  const states = {
    saving: { icon: '☁️', text: t('syncSaving'), color: 'rgba(200,169,110,.9)' },
    saved:  { icon: '✓',  text: t('syncSaved'),  color: 'rgba(100,180,100,.9)' },
    error:  { icon: '✗',  text: t('syncError'),  color: 'rgba(220,80,80,.9)' },
  };
  const s = states[state] || states.saved;
  el.style.display = 'flex';
  el.style.color = s.color;
  el.innerHTML = `${s.icon} ${s.text}`;
  if (state === 'saved') {
    _syncClearTimer = setTimeout(() => { el.style.display = 'none'; }, 3000);
  }
}


// ===================== GCS DIAGNOSTIC — removed =====================


// ============================================================
//                            BOOT                           
// ============================================================
window.addEventListener('load', async () => {
  // Safety timeout — if loading hangs for 12s, show an error
  const loadTimeout = setTimeout(() => {
    if (document.getElementById('loadingScreen').style.display !== 'none') {
      document.getElementById('loadingMsg').textContent = '⚠️ Taking too long…';
      document.getElementById('loadingError').style.display = 'block';
      document.getElementById('loadingError').innerHTML =
        'Could not connect to Firebase. Check your internet connection or Firestore security rules, then reload.<br>' +
        '<a href="https://console.firebase.google.com" target="_blank" style="color:#c8a96e">→ Open Firebase Console</a>';
    }
  }, 12000);
  window._loadTimeout = loadTimeout;
  const params = new URLSearchParams(window.location.search);
  const shareUser = params.get('share');
  const shared = params.get('lib');
  const compressed = params.get('z') === '1';
  if (shareUser) {
    document.getElementById('loadingScreen').style.display = 'none';
    loadLiveSharedLibrary(shareUser);
    return;
  }
  if (shared) {
    document.getElementById('loadingScreen').style.display = 'none';
    loadSharedLibrary(shared, compressed);
    return;
  }

  // Check Firebase is configured
  if (window._firebaseInitError) {
    document.getElementById('loadingMsg').textContent = '⚠️ Firebase failed to load.';
    document.getElementById('loadingError').style.display = 'block';
    document.getElementById('loadingError').innerHTML =
      'Firebase SDK could not be loaded. Check your internet connection and try reloading.<br><small style="color:#999">' + window._firebaseInitError + '</small>';
    return;
  }
  if (!FIREBASE_CONFIGURED) {
    document.getElementById('loadingMsg').textContent = '⚠️ Firebase not configured yet.';
    document.getElementById('loadingError').style.display = 'block';
    document.getElementById('loadingError').innerHTML =
      'Open the HTML file and replace the <strong>YOUR_...</strong> values in the Firebase config section with your project credentials.<br><br>' +
      '<a href="https://console.firebase.google.com" target="_blank" style="color:#c8a96e;font-weight:700">→ Create a free Firebase project</a>';
    return;
  }

  // Load all users from Firestore
  try {
    document.getElementById('loadingMsg').textContent = 'Syncing your library…';
    await fsLoadAllUsers();
  } catch(e) {
    console.error('Firestore load error:', e);
    document.getElementById('loadingMsg').textContent = '⚠️ Could not connect to database.';
    document.getElementById('loadingError').style.display = 'block';
    document.getElementById('loadingError').innerHTML =
      'Check your Firebase config and Firestore security rules, then reload.<br><small style="color:#999">' + e.message + '</small>';
    return;
  }

  clearTimeout(window._loadTimeout);
  document.getElementById('loadingScreen').style.display = 'none';
  // GCS test available: type testGCS() in browser console to diagnose

  // Always show user select — no auto-login, so each person picks their own account
  showUserSelect();
});


// ============================================================
//                        USER SELECT                        
// ============================================================
function showUserSelect() {
  document.getElementById('userSelect').classList.remove('hidden');
  ['mainHeader','mainControls','mainContent'].forEach(id => document.getElementById(id).style.display='none');
  document.getElementById('readonly-banner').classList.remove('show');
  renderUserList();
  // Refresh all known device-user data from server so book counts are accurate
  if (db) {
    const deviceUsers = getDeviceUsers();
    deviceUsers.forEach(u => {
      db.collection(FS_COLLECTION).doc(u).get({ source: 'server' })
        .then(doc => {
          if (!doc.exists) return;
          const data = doc.data();
          _booksCache[u]   = data.books   || [];
          _profileCache[u] = data.profile || {};
          renderUserList(); // re-render with fresh counts
        }).catch(() => {});
    });
  }
}

function renderUserList() {
  // Only show accounts that were created or logged into on THIS device
  const deviceUsers = getDeviceUsers();
  const users = getUsers().filter(u => deviceUsers.includes(u));
  const list = document.getElementById('usUserList');
  if (users.length === 0) {
    list.innerHTML = '';
    // auto-open new user form — directly show username step
    const f = document.getElementById('usNewForm');
    f.classList.add('open');
    document.getElementById('nb-step-new').style.display='none';
    document.getElementById('nb-returning-preview').style.display='none';
    document.getElementById('nb-continue-btn').style.display='';
    document.getElementById('nb-continue-btn').style.opacity='.45';
    document.getElementById('nb-continue-btn').style.pointerEvents='none';
    document.getElementById('usNewToggle').style.display = 'none';
    return;
  }
  document.getElementById('usNewToggle').style.display = '';
  list.innerHTML = users.map(u => {
    const p = getUserProfile(u) || {};
    const bks = getUserBooks(u);
    const avatarSrc = p.avatarImg || (p.avatarPreset ? _avSVG(p.avatarPreset) : null);
    return `<div class="us-user-row" onclick="loginUser('${u}')">
      <div class="us-user-avatar">${avatarSrc ? `<img src="${escHtml(avatarSrc)}" class="show" alt="">` : (p.avatarEmoji||'📖')}</div>
      <div class="us-user-info">
        <div class="us-user-name">${escHtml(p.name||u)}</div>
        <div class="us-user-meta">@${escHtml(u)} · ${currentLang==='vi'?`${bks.length} cuốn sách`:`${bks.length} book${bks.length!==1?'s':''}`}</div>
      </div>
      <span class="us-user-arrow">›</span>
      <button class="us-user-del" title="Delete account" onclick="deleteUserAccount(event,'${u}')">🗑</button>
    </div>`;
  }).join('');
}

function toggleNewUserForm() {
  const f = document.getElementById('usNewForm');
  f.classList.toggle('open');
  if(f.classList.contains('open')){
    // Reset state
    document.getElementById('nb-username').value='';
    document.getElementById('nb-step-new').style.display='none';
    document.getElementById('nb-returning-preview').style.display='none';
    document.getElementById('nb-continue-btn').style.display='';
    document.getElementById('nb-continue-btn').style.opacity='.45';
    document.getElementById('nb-continue-btn').style.pointerEvents='none';
    document.getElementById('nb-continue-btn').textContent=t('continueBtn');
    document.getElementById('nb-username-hint').textContent=t('usernameHint');
    document.getElementById('nb-username-hint').style.color='';
    hidePwLoginBox();
    // Clear password fields
    ['nb-password','nb-password2','nb-login-pw'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
    const pe=document.getElementById('nb-pw-error'); if(pe) pe.textContent='';
    setTimeout(()=>document.getElementById('nb-username').focus(),200);
  }
}

// Live username lookup — autofill if returning user
function onUsernameInput(){
  const raw = document.getElementById('nb-username').value.trim();
  const username = raw.toLowerCase().replace(/[^a-z0-9_]/g,'');
  const btn = document.getElementById('nb-continue-btn');
  const preview = document.getElementById('nb-returning-preview');
  const hint = document.getElementById('nb-username-hint');
  const newStep = document.getElementById('nb-step-new');

  if(username.length === 0){
    btn.style.opacity='.45'; btn.style.pointerEvents='none';
    preview.style.display='none'; newStep.style.display='none';
    hint.textContent=t('usernameHint');
    hint.style.color='';
    return;
  }

  const users = getUsers();
  if(users.includes(username)){
    // RETURNING USER — show preview card
    const p = getUserProfile(username)||{};
    const bks = getUserBooks(username);
    const retAvSrc = p.avatarImg || (p.avatarPreset ? _avSVG(p.avatarPreset) : null);
    document.getElementById('nb-ret-avatar').textContent = retAvSrc ? '' : (p.avatarEmoji||'📖');
    if(retAvSrc){
      document.getElementById('nb-ret-avatar').innerHTML=`<img src="${retAvSrc}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;">`;
    }
    document.getElementById('nb-ret-name').textContent = p.name || username;
    document.getElementById('nb-ret-meta').textContent = `${p.libname||t('myLibrary')} · ${currentLang==='vi'?`${bks.length} cuốn sách`:`${bks.length} book${bks.length!==1?'s':''}`}`;
    preview.style.display='flex';
    newStep.style.display='none';
    hint.textContent = t('accountFoundPw');
    hint.style.color='var(--forest)';
    btn.textContent = t('openLibBtn');
    btn.style.opacity='1'; btn.style.pointerEvents='auto';
    showPwLoginBox();
  } else {
    hidePwLoginBox();
    // NEW USER
    hidePwLoginBox();
    preview.style.display='none';
    hint.textContent = username.length >= 2 ? t('newUsernameHint') : t('usernameHint');
    hint.style.color = username.length >= 2 ? 'var(--warm)' : '';
    if(username.length >= 2){
      newStep.style.display='block';
      btn.style.display='none'; // hide continue, createUser btn used instead
    } else {
      newStep.style.display='none';
      btn.style.opacity='.45'; btn.style.pointerEvents='none';
    }
    btn.textContent=t('continueBtn');
  }
}

async function onUsernameContinue(){
  const raw = document.getElementById('nb-username').value.trim();
  const username = raw.toLowerCase().replace(/[^a-z0-9_]/g,'');
  if(!username) return;
  const users = getUsers();
  if(users.includes(username)){
    const storedHash = getUserHash(username);
    // If account has a password, verify it
    if(storedHash){
      const pwVal = (document.getElementById('nb-login-pw')||{}).value || '';
      if(!pwVal){ document.getElementById('nb-login-error').textContent=t('enterPasswordErr'); return; }
      const entered = await sha256(username + pwVal);
      if(entered !== storedHash){
        document.getElementById('nb-login-error').textContent=t('wrongPasswordErr');
        return;
      }
      document.getElementById('nb-login-error').textContent='';
    }
    hidePwLoginBox();
    loginUser(username);
    setTimeout(()=>showToast(`👋 ${t('greeting')} ${getUserProfile(username)?.name||username}!`),300);
  }
}

// Track active real-time listener so we can unsubscribe on logout/switch
let _activeListener = null;

function loginUser(username) {
  currentUser = username;
  profile = getUserProfile(username) || {};
  books = getUserBooks(username);
  isReadOnly = false;
  addDeviceUser(username); // remember this account on this device
  document.getElementById('userSelect').classList.add('hidden');
  document.getElementById('btnAdd').style.display = '';
  document.getElementById('btnShare').style.display = '';
  document.getElementById('btnSwitch').style.display = '';
  ['mainHeader','mainControls','mainContent'].forEach(id => document.getElementById(id).style.display='');
  applyProfile();
  applyLang();
  renderBooks();
  showFriendsSection();
  // Apply any books queued from friend's read-only pages
  try {
    const queue = JSON.parse(localStorage.getItem('lib_add_queue') || '[]');
    if(queue.length){
      localStorage.removeItem('lib_add_queue');
      const existing = _booksCache[username] || [];
      const existingKeys = new Set(existing.map(x => (x.title||'').toLowerCase().trim()+'|'+(x.author||'').toLowerCase().trim()));
      const toAdd = queue.filter(b => !existingKeys.has((b.title||'').toLowerCase().trim()+'|'+(b.author||'').toLowerCase().trim()))
        .map(b => ({ id:uid(), addedAt:Date.now(), title:b.title||'', author:b.author||'', cover:b.cover||'', genre:b.genre||'', status:'want', rating:0, review:'', year:null, category:'', pinned:false, manualOrder:null }));
      if(toAdd.length){
        const updatedBooks = [...existing, ...toAdd];
        _booksCache[username] = updatedBooks;
        books = updatedBooks;
        fsSaveBooks(username, updatedBooks).catch(()=>{});
        renderBooks();
        showToast(`📚 Added ${toAdd.length} queued book${toAdd.length>1?'s':''} to your library!`);
      }
    }
  } catch(e){}
  // Listen for books queued from a friend's read-only tab in another window
  window.addEventListener('storage', e => {
    if(e.key !== 'lib_add_queue' || !e.newValue || !currentUser || isReadOnly) return;
    try {
      const queue = JSON.parse(e.newValue || '[]');
      if(!queue.length) return;
      localStorage.removeItem('lib_add_queue');
      const existing = _booksCache[currentUser] || [];
      const existingKeys = new Set(existing.map(x => (x.title||'').toLowerCase().trim()+'|'+(x.author||'').toLowerCase().trim()));
      const toAdd = queue.filter(b => !existingKeys.has((b.title||'').toLowerCase().trim()+'|'+(b.author||'').toLowerCase().trim()))
        .map(b => ({ id:uid(), addedAt:Date.now(), title:b.title||'', author:b.author||'', cover:b.cover||'', genre:b.genre||'', status:'want', rating:0, review:'', year:null, category:'', pinned:false, manualOrder:null }));
      if(toAdd.length){
        const updatedBooks = [...existing, ...toAdd];
        _booksCache[currentUser] = updatedBooks;
        books = updatedBooks;
        fsSaveBooks(currentUser, updatedBooks).catch(()=>{});
        renderBooks();
        showToast(`📚 Added ${toAdd.length} book${toAdd.length>1?'s':''} from friend's library!`);
      }
    } catch(err){}
  });

  // Auto-show daily knowledge modal after a short delay
  setTimeout(() => openKnowledgeModal(), 800);

  // --- SYNC FIX: Tear down any previous listener ---
  if (_activeListener) { _activeListener(); _activeListener = null; }

  if (db) {
    // 1) Immediate fresh pull from server (fix stale cache on login)
    db.collection(FS_COLLECTION).doc(username).get({ source: 'server' })
      .then(doc => {
        if (!doc.exists || currentUser !== username) return;
        const data = doc.data();
        _booksCache[username]   = data.books   || [];
        _profileCache[username] = data.profile || {};
        if (currentUser === username) {
          books   = _booksCache[username];
          profile = _profileCache[username];
          renderBooks();
          applyProfile();
        }
      }).catch(() => {}); // silently fall back to cached data if offline

    // 2) Real-time listener — auto-updates books whenever another device saves
    _activeListener = db.collection(FS_COLLECTION).doc(username)
      .onSnapshot({ includeMetadataChanges: false }, doc => {
        if (!doc.exists || currentUser !== username) return;
        if (_dgSaveTimer) return; // drag save in flight
        const data = doc.data();
        _booksCache[username]   = data.books   || [];
        _profileCache[username] = data.profile || {};
        if (currentUser === username) {
          books   = _booksCache[username];
          profile = _profileCache[username];
          renderBooks();
          applyProfile();
        }
      }, () => {}); // ignore listener errors (offline)
  }
}

async function createUser() {
  let username = document.getElementById('nb-username').value.trim().toLowerCase().replace(/[^a-z0-9_]/g,'');
  const name    = document.getElementById('nb-name').value.trim() || username;
  const libname = document.getElementById('nb-libname').value.trim() || t('myLibrary');
  const pw      = document.getElementById('nb-password').value;
  const pw2     = document.getElementById('nb-password2').value;
  const recQ    = document.getElementById('nb-recovery-q').value;
  const recA    = document.getElementById('nb-recovery-a').value.trim().toLowerCase();
  const pwErr   = document.getElementById('nb-pw-error');

  if(!username){ showToast(t('usernameRequired')); return; }
  if(!pw)       { pwErr.textContent=t('passwordRequired'); return; }
  if(pw.length < 4){ pwErr.textContent=t('passwordTooShort'); return; }
  if(pw !== pw2){ pwErr.textContent=t('passwordMismatch'); return; }
  pwErr.textContent='';

  // Show loading state on button
  const startBtn = document.querySelector('#nb-step-new .btn-start');
  const origBtnText = startBtn ? startBtn.textContent : '';
  if(startBtn){ startBtn.textContent = '⟳ Creating…'; startBtn.disabled = true; }

  try {
    // Always verify username availability directly in Firestore
    // Avoids race where fsLoadAllUsers populates cache mid-form
    if(db){
      const existing = await db.collection(FS_COLLECTION).doc(username).get();
      if(existing.exists){
        const d = existing.data();
        _profileCache[username] = d.profile || {};
        _booksCache[username]   = d.books   || [];
        _hashCache[username]    = d.pwhash  || '';
        if(!_usersCache.includes(username)) _usersCache.push(username);
        pwErr.textContent = t('accountFoundPw') || 'That username already exists. Try logging in.';
        if(startBtn){ startBtn.textContent = origBtnText; startBtn.disabled = false; }
        return;
      }
    }

    const pwHash = await sha256(username + pw);
    const p = { name, libname, avatarEmoji: nbAvEmoji, avatarImg: nbAvImg, avatarPreset: nbAvPreset };
    let recovery = null;
    if(recQ && recA){
      const aHash = await sha256(recA);
      recovery = { q: recQ, aHash };
    }
    await fsCreateUser(username, p, pwHash, recovery);
    loginUser(username);
    showToast(t('libraryCreated'));
    setTimeout(()=>openWelcomeModal(), 600);
  } catch(err) {
    console.error('createUser error:', err);
    pwErr.textContent = currentLang==='vi'
      ? '⚠️ Không thể tạo tài khoản. Kiểm tra kết nối mạng.'
      : '⚠️ Could not create account. Check your connection and try again.';
    if(startBtn){ startBtn.textContent = origBtnText; startBtn.disabled = false; }
  }
}

function deleteUserAccount(e, username) {
  e.stopPropagation();
  const p = getUserProfile(username)||{};
  if (!confirm(currentLang==='vi' ? `Xóa tài khoản của ${p.name||username} và tất cả sách? Không thể hoàn tác.` : `Delete ${p.name||username}'s account and all their books? This cannot be undone.`)) return;
  fsDeleteUser(username).catch(err => console.warn('deleteUser:', err));
  removeDeviceUser(username);
  renderUserList();
  showToast(t('accountDeleted'));
}

function goToUserSelect() {
  _dgInited = false;
  if (_activeListener) { _activeListener(); _activeListener = null; }
  if (_roListener)     { _roListener();     _roListener = null;     }
  currentUser = null; books = []; profile = {}; isReadOnly = false;
  _dragInited = false; // reset so drag re-attaches on next login
  const hint = document.getElementById('dragHint'); if(hint) hint.remove();
  const si = document.getElementById('syncIndicator'); if (si) si.style.display = 'none';
  document.getElementById('searchInput').value = '';
  setFilter('all', document.querySelector('.filter-btn'));
  hideFriendsSection();
  showUserSelect();
}

function startOwnLibraryFromReadOnly() {
  if (_roListener) { _roListener(); _roListener = null; }
  document.body.classList.remove('ro-mode');
  isReadOnly = false;
  books = []; profile = {}; currentUser = null;
  _dragInited = false;
  const hint = document.getElementById('dragHint'); if(hint) hint.remove();
  ['mainHeader','mainControls','mainContent'].forEach(id => document.getElementById(id).style.display='none');
  document.getElementById('readonly-banner').classList.remove('show');
  hideFriendsSection();
  // Clear ?share= param so refresh doesn't reload shared library
  if(history.replaceState) history.replaceState(null,'',location.pathname);
  // Load all users from Firestore so username availability check works correctly
  showUserSelect();
  if(db) fsLoadAllUsers().then(()=>renderUserList()).catch(()=>{});
}


// ============================================================
//                      NEW USER AVATAR                      
// ============================================================
function handleNbAvUpload(e) {
  const f=e.target.files[0]; if(!f) return;
  const r=new FileReader(); r.onload=ev=>{
    nbAvImg=ev.target.result; nbAvPreset=null; nbAvEmoji=null;
    document.getElementById('nb-av-img').src=nbAvImg;
    document.getElementById('nb-av-img').classList.add('show');
    document.getElementById('nb-av-emoji').style.display='none';
    document.querySelectorAll('.av-pic[data-prefix="nb"]').forEach(e=>e.classList.remove('sel'));
  }; r.readAsDataURL(f);
}


// ============================================================
//                       PROFILE MODAL                       
// ============================================================
function openProfileModal() {
  if (isReadOnly) return;
  peAvEmoji = profile.avatarEmoji||'📖';
  peAvData = profile.avatarImg||null;
  peAvPreset = profile.avatarPreset||null;
  document.getElementById('pe-name').value = profile.name||'';
  document.getElementById('pe-libname').value = profile.libname||'';
  const img=document.getElementById('pe-av-img'), emo=document.getElementById('pe-av-emoji');
  if(peAvData){ img.src=peAvData; img.classList.add('show'); emo.style.display='none'; }
  else if(peAvPreset){ const src=_avSVG(peAvPreset); if(src){ img.src=src; img.classList.add('show'); emo.style.display='none'; } else { emo.textContent=peAvEmoji; img.classList.remove('show'); emo.style.display=''; } }
  else { emo.textContent=peAvEmoji; img.classList.remove('show'); emo.style.display=''; }
  // Restore selected state in grid
  document.querySelectorAll('.av-pic[data-prefix="pe"]').forEach(el=>{
    el.classList.toggle('sel', !!peAvPreset && el.dataset.av===peAvPreset && !peAvData);
  });
  document.getElementById('profileOverlay').classList.add('open');
}
function handlePeAvUpload(e){
  const f=e.target.files[0]; if(!f) return;
  const r=new FileReader(); r.onload=ev=>{
    peAvData=ev.target.result; peAvPreset=null;
    document.getElementById('pe-av-img').src=peAvData;
    document.getElementById('pe-av-img').classList.add('show');
    document.getElementById('pe-av-emoji').style.display='none';
    document.querySelectorAll('.av-pic[data-prefix="pe"]').forEach(e=>e.classList.remove('sel'));
  }; r.readAsDataURL(f);
}
// Override saveProfile to also persist
function saveProfile() {
  profile.name = document.getElementById('pe-name').value.trim()||currentUser;
  profile.libname = document.getElementById('pe-libname').value.trim()||'My Library';
  profile.avatarEmoji = peAvEmoji; profile.avatarImg = peAvData; profile.avatarPreset = peAvPreset;
  fsUpdateProfile(currentUser, profile).catch(e => console.warn('saveProfile:', e));
  applyProfile(); closeModal('profileOverlay'); showToast(t('profileUpdated'));
}

function applyProfile() {
  const ss=document.getElementById('sortSelect');
  if(ss) delete ss.dataset.userChanged;
  const name = profile.name||currentUser||'Reader';
  const libname = profile.libname||t('myLibrary');
  document.title = `${name}'s Library`;
  document.getElementById('headerNameText').textContent = name;
  document.getElementById('headerLibName').textContent = libname;
  const img=document.getElementById('headerAvatarImg'), emo=document.getElementById('headerAvatarEmoji');
  if(profile.avatarImg){
    img.src=profile.avatarImg; img.classList.add('show'); emo.style.display='none';
  } else if(profile.avatarPreset){
    const src=_avSVG(profile.avatarPreset);
    if(src){ img.src=src; img.classList.add('show'); emo.style.display='none'; }
    else { emo.textContent=profile.avatarEmoji||'📖'; img.classList.remove('show'); emo.style.display=''; }
  } else {
    emo.textContent=profile.avatarEmoji||'📖';
    img.classList.remove('show'); emo.style.display='';
  }
}


// ============================================================
//                           SHARE                           
// ============================================================
function openShareModal(){
  document.getElementById('shareOverlay').classList.add('open');
  const base = window.location.origin + window.location.pathname;
  const liveUrl = base + '?share=' + encodeURIComponent(currentUser);
  document.getElementById('shareLiveUrl').textContent = liveUrl;
}

function copyLiveShareLink(){
  const btn = document.getElementById('btnCopyLiveLink');
  const url = document.getElementById('shareLiveUrl').textContent;
  navigator.clipboard.writeText(url).then(()=>{
    btn.textContent = '✓ Copied!';
    setTimeout(()=>{ btn.textContent = '🔗 Copy link'; }, 2200);
  }).catch(()=>{
    // Fallback for browsers that block clipboard
    const ta = document.createElement('textarea');
    ta.value = url; ta.style.position='fixed'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    btn.textContent = '✓ Copied!';
    setTimeout(()=>{ btn.textContent = '🔗 Copy link'; }, 2200);
  });
  showToast('🔗 Link copied!');
}

function downloadReadOnlyPage(){
  const btn = document.getElementById('btnDownloadShare');
  btn.textContent = '⟳ Generating…';
  btn.disabled = true;

  // Gather data — strip base64 covers to keep file small (URL covers are fine)
  const sp = {name:profile.name, libname:profile.libname, avatarEmoji:profile.avatarEmoji, customStatuses: profile.customStatuses||[]};
  const sb = books.map(b=>({
    title:    b.title,  author: b.author,
    genre:    b.genre||'', year: b.year||null,
    status:   b.status,   category: b.category||'',
    rating:   b.rating||0, review: b.review||'',
    cover:    (b.cover && !b.cover.startsWith('data:')) ? b.cover : '',
  }));
  const payload = JSON.stringify({profile:sp, books:sb});

  // Build a minimal self-contained read-only HTML
  const ownerName = profile.name || 'Someone';
  const libName   = profile.libname || 'Library';
  const html = buildReadOnlyHTML(ownerName, libName, payload, sp);

  // Trigger download
  const blob = new Blob([html], {type:'text/html;charset=utf-8'});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${(ownerName).replace(/[^a-z0-9]/gi,'_')}_library.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  btn.textContent = currentLang==='vi' ? '✓ Đã tải xuống!' : '✓ Downloaded!';
  btn.disabled = false;
  setTimeout(()=>{ btn.textContent=t('btnDownloadShare'); }, 2500);
  showToast(currentLang==='vi' ? '📥 Đã tải trang chỉ đọc!' : '📥 Read-only page downloaded!');
}

function buildReadOnlyHTML(ownerName, libName, payloadJson, sp){
  // Inline minimal CSS + rendering logic into a standalone HTML file
  const data = payloadJson.replace(/</g,'\\u003c').replace(/>/g,'\\u003e');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(ownerName)}'s Library — ${escHtml(libName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;1,400&family=Karla:wght@400;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Karla',sans-serif;background:#f5f0e8;color:#2c2016;min-height:100vh}
header{background:#1e2d4a;color:#f5f0e8;padding:18px 28px;display:flex;align-items:center;gap:14px}
header h1{font-family:'Playfair Display',serif;font-size:22px;font-weight:700}
header p{font-size:12px;opacity:.7;margin-top:2px}
.banner{background:#e8dfc8;border-bottom:1px solid #d4c4a0;padding:8px 24px;font-size:12px;color:#8b7355;text-align:center}
.controls{padding:14px 24px;display:flex;gap:12px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #e8dfc8;background:#faf6ee}
.controls input{flex:1;min-width:160px;border:1.5px solid #d4c4a0;border-radius:20px;padding:7px 14px;font-family:'Karla',sans-serif;font-size:13px;background:#fff;outline:none}
.controls input:focus{border-color:#c8a96e}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:18px;padding:24px}
.card{background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);display:flex;flex-direction:column}
.cover{width:100%;height:200px;background:#e8dfc8;overflow:hidden;flex-shrink:0}
.cover img{width:100%;height:100%;object-fit:cover}
.cover-ph{width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:36px;color:#c8a96e}
.body{padding:12px;flex:1;display:flex;flex-direction:column;gap:5px}
.genre{font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#c8a96e}
.title{font-family:'Playfair Display',serif;font-size:14px;font-weight:700;line-height:1.3;color:#2c2016}
.author{font-size:11px;color:#8b7355}
.meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:3px}
.badge{font-size:10px;padding:2px 7px;border-radius:10px;font-weight:600}
.read{background:#d4e8d0;color:#2d6a2d}.reading{background:#d4e0f0;color:#1e3d6b}.want{background:#f0e8d0;color:#8b6a2e}
.stars{display:flex;gap:1px;align-items:center}
.star-f{color:#c8a96e;font-size:14px}.star-e{color:#e8dfc8;font-size:14px}
.review-snippet{font-size:11px;color:#8b7355;font-style:italic;line-height:1.5;border-top:1px solid #e8dfc8;margin-top:6px;padding-top:6px;cursor:pointer}
.review-snippet .read-more{color:#c8a96e;font-style:normal;font-weight:600;font-size:10px;margin-left:3px;white-space:nowrap}
.empty{text-align:center;padding:60px 24px;color:#8b7355}
.empty h2{font-family:'Playfair Display',serif;font-size:24px;margin-bottom:8px}
.card{cursor:pointer;transition:transform .15s,box-shadow .15s}
.card:hover{transform:translateY(-3px);box-shadow:0 8px 24px rgba(0,0,0,.13)}
/* Sort controls */
.sort-wrap{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.sort-wrap label{font-size:11px;color:#8b7355;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.sort-btn{background:#fff;border:1.5px solid #d4c4a0;border-radius:20px;padding:5px 13px;font-family:'Karla',sans-serif;font-size:12px;color:#6b5533;cursor:pointer;transition:background .15s,border-color .15s,color .15s;font-weight:600}
.sort-btn:hover{background:#f5efdf;border-color:#c8a96e}
.sort-btn.active{background:#1e2d4a;border-color:#1e2d4a;color:#f5f0e8}
/* Review modal */
.rev-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px;opacity:0;pointer-events:none;transition:opacity .2s}
.rev-overlay.open{opacity:1;pointer-events:auto}
.rev-modal{background:#fff;border-radius:14px;max-width:520px;width:100%;max-height:85vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.2);transform:translateY(16px);transition:transform .22s}
.rev-overlay.open .rev-modal{transform:translateY(0)}
.rev-modal-header{display:flex;gap:14px;align-items:flex-start;padding:20px 20px 14px;border-bottom:1px solid #e8dfc8}
.rev-modal-cover{width:56px;height:80px;border-radius:6px;object-fit:cover;flex-shrink:0;background:#e8dfc8}
.rev-modal-cover-ph{width:56px;height:80px;border-radius:6px;background:#e8dfc8;display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0}
.rev-modal-info{flex:1;min-width:0}
.rev-modal-title{font-family:'Playfair Display',serif;font-size:18px;font-weight:700;color:#2c2016;line-height:1.3;margin-bottom:4px}
.rev-modal-author{font-size:13px;color:#8b7355;margin-bottom:8px}
.rev-modal-meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.rev-modal-body{padding:16px 20px 22px}
.rev-modal-review{font-size:13px;color:#4a3a28;line-height:1.75;font-style:italic;white-space:pre-wrap}
.rev-modal-no-review{font-size:13px;color:#a08060;font-style:italic;text-align:center;padding:20px 0}
.rev-modal-close{position:absolute;top:12px;right:14px;background:none;border:none;font-size:20px;color:#8b7355;cursor:pointer;line-height:1;padding:4px}
.rev-modal-close:hover{color:#2c2016}
.rev-modal-links{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px;padding-top:12px;border-top:1px solid #e8dfc8}
.rev-link-btn{display:inline-flex;align-items:center;gap:5px;font-family:'Karla',sans-serif;font-size:12px;font-weight:600;padding:6px 14px;border-radius:20px;text-decoration:none;transition:opacity .15s}
.rev-link-btn:hover{opacity:.8}
.rev-link-gr{background:#f4f1ea;color:#382110;border:1.5px solid #c8b89a}
.rev-link-google{background:#e8f0fb;color:#1a3a7a;border:1.5px solid #bad0f0}
.cat-pill{font-size:10px;padding:2px 8px;border-radius:10px;font-weight:600;background:rgba(58,95,170,.12);color:#3a5faa;}
.filter-pills{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:10px 24px;border-bottom:1px solid #e8dfc8;background:#faf6ee;}
.filter-pill{background:#fff;border:1.5px solid #d4c4a0;border-radius:20px;padding:5px 13px;font-family:'Karla',sans-serif;font-size:12px;color:#6b5533;cursor:pointer;font-weight:600;transition:background .15s,border-color .15s,color .15s;}
.filter-pill:hover{background:#f5efdf;border-color:#c8a96e;}
.filter-pill.active{background:#1e2d4a;border-color:#1e2d4a;color:#f5f0e8;}
.filter-label{font-size:11px;color:#8b7355;font-weight:600;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap;}
@media(max-width:600px){
  .filter-pills{padding:8px 14px;}
  .controls{padding:10px 14px;}
  .grid{padding:14px;gap:12px;}
}
</style>
</head>
<body>
<header>
  <div style="width:44px;height:44px;border-radius:50%;background:#c8a96e;display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0">${escHtml(sp.avatarEmoji||'📖')}</div>
  <div><h1>${escHtml(ownerName)}'s Library</h1><p>${escHtml(libName)}</p></div>
</header>
<div class="banner">👁️ Read-only view — browsing ${escHtml(ownerName)}'s books &nbsp;·&nbsp; click any card to read the full review</div>
<div class="controls">
  <input type="search" id="srch" placeholder="Search titles or authors…" oninput="applyFilters()">
  <div class="sort-wrap">
    <label>Sort:</label>
    <button class="sort-btn active" data-sort="default" onclick="setSort(this)">Recent</button>
    <button class="sort-btn" data-sort="title" onclick="setSort(this)">Title A–Z</button>
    <button class="sort-btn" data-sort="author" onclick="setSort(this)">Author</button>
    <button class="sort-btn" data-sort="rating" onclick="setSort(this)">Rating ↓</button>
    <button class="sort-btn" data-sort="status" onclick="setSort(this)">Status</button>
    <button class="sort-btn" data-sort="category" onclick="setSort(this)">Category A–Z</button>
  </div>
</div>
<div class="filter-pills" id="catPills" style="display:none"></div>
<div class="grid" id="grid"></div>

<!-- Review modal -->
<div class="rev-overlay" id="revOverlay" onclick="closeReview(event)">
  <div class="rev-modal" style="position:relative">
    <button class="rev-modal-close" onclick="closeReview()">✕</button>
    <div class="rev-modal-header">
      <div id="revCoverWrap"></div>
      <div class="rev-modal-info">
        <div class="rev-modal-title" id="revTitle"></div>
        <div class="rev-modal-author" id="revAuthor"></div>
        <div class="rev-modal-meta" id="revMeta"></div>
      </div>
    </div>
    <div class="rev-modal-body">
      <div id="revContent"></div>
    </div>
  </div>
</div>

<script>
const RAW = ${data};
const books = RAW.books || [];
let currentSort = 'default';

function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function stars(r){if(!r)return '';let h='';for(let i=1;i<=5;i++){if(r>=i)h+='<span class="star-f">★</span>';else if(r>=i-0.5)h+='<span class="star-f" style="opacity:.5">★</span>';else h+='<span class="star-e">★</span>';}return '<div class="stars">'+h+'<span style="font-size:11px;color:#8b7355;margin-left:4px">'+r+'</span></div>';}
function badge(s){const m={read:['✓ Read','read'],reading:['📖 Reading','reading'],want:['🔖 Want','want']};if(!m[s])return '';const[l,cc]=m[s];return '<span class="badge '+cc+'">'+l+'</span>';}
const CATS = (RAW.profile||{}).customStatuses||[];
function catBadge(catId){if(!catId)return '';const cc=CATS.find(x=>x.id===catId);return cc?'<span class="cat-pill">'+(cc.emoji||'📁')+' '+esc(cc.label)+'</span>':'';}
function _roCatLabel(catId){if(!catId)return '~';const cc=CATS.find(x=>x.id===catId);return cc?cc.label:catId;}
let currentCat='all';
function renderCatPills(){
  var wrap=document.getElementById('catPills');
  if(!CATS.length){wrap.style.display='none';return;}
  wrap.style.display='flex';
  var h='<span class="filter-label">Category:</span>';
  h+='<button class="filter-pill'+(currentCat==='all'?' active':'')+'" data-cat="__all__">\ud83d\udcc2 All</button>';
  CATS.forEach(function(cs){
    h+='<button class="filter-pill'+(currentCat===cs.id?' active':'')+'" data-cat="'+esc(cs.id)+'">'+esc((cs.emoji||'\ud83d\udcc1')+' '+cs.label)+'</button>';
  });
  wrap.innerHTML=h;
  wrap.querySelectorAll('.filter-pill').forEach(function(btn){
    btn.addEventListener('click',function(){setCat(this.dataset.cat==='__all__'?'all':this.dataset.cat);});
  });
}
function setCat(id){currentCat=id;renderCatPills();applyFilters();}

function truncateReview(text, wordLimit){
  if(!text) return {snippet:'', truncated:false};
  const words = text.split(/\\s+/);
  if(words.length <= wordLimit) return {snippet: text, truncated: false};
  return {snippet: words.slice(0, wordLimit).join(' '), truncated: true};
}

function render(list){
  const g=document.getElementById('grid');
  if(!list.length){g.innerHTML='<div class="empty"><h2>No books found.</h2></div>';return;}
  g.innerHTML=list.map((b,i)=>{
    const {snippet, truncated} = truncateReview(b.review, 20);
    const reviewHtml = b.review
      ? '<div class="review-snippet">&ldquo;'+esc(snippet)+(truncated?'…<span class=\\"read-more\\">Read more ↗</span>':'\&rdquo;')+'</div>'
      : '';
    const coverHtml = b.cover
      ? '<img src="'+esc(b.cover)+'" loading="lazy" onerror="this.outerHTML=\\'<div class=\\"cover-ph\\">📖</div>\\'">'
      : '<div class="cover-ph">📖</div>';
    return \`<div class="card" onclick="openReview(\${i})" data-idx="\${i}">
      <div class="cover">\${coverHtml}</div>
      <div class="body">
        \${b.genre?'<div class="genre">'+esc(b.genre)+'</div>':''}
        <div class="title">\${esc(b.title)}</div>
        <div class="author">by \${esc(b.author)}</div>
        <div class="meta">\${b.year?'<span style="font-size:11px;color:#8b7355">📅 '+b.year+'</span>':''}\${badge(b.status)}\${catBadge(b.category)}</div>
        \${stars(b.rating)}
        \${reviewHtml}
      </div>
    </div>\`;
  }).join('');
}

let renderedList = [];
function applyFilters(){
  const q=(document.getElementById('srch').value||'').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'');
  let list = books.filter(b=>currentCat==='all'||b.category===currentCat);
  list = q ? list.filter(b=>{
    const t=(b.title||'').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'');
    const a=(b.author||'').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'');
    return t.includes(q)||a.includes(q);
  }) : list;
  const statusOrder = {read:0,reading:1,want:2};
  if(currentSort==='title') list.sort((a,b)=>(a.title||'').localeCompare(b.title||''));
  else if(currentSort==='author') list.sort((a,b)=>(a.author||'').localeCompare(b.author||''));
  else if(currentSort==='rating') list.sort((a,b)=>(b.rating||0)-(a.rating||0));
  else if(currentSort==='status') list.sort((a,b)=>(statusOrder[a.status]||0)-(statusOrder[b.status]||0));
  else if(currentSort==='category') list.sort((a,b)=>_roCatLabel(a.category).localeCompare(_roCatLabel(b.category)));
  renderedList = list;
  render(list);
}

function setSort(btn){
  document.querySelectorAll('.sort-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  currentSort = btn.dataset.sort;
  applyFilters();
}

function openReview(idx){
  const b = renderedList[idx];
  if(!b) return;
  document.getElementById('revTitle').textContent = b.title||'';
  document.getElementById('revAuthor').textContent = 'by '+(b.author||'');
  const metaEl = document.getElementById('revMeta');
  metaEl.innerHTML = (b.year?'<span style="font-size:11px;color:#8b7355;background:#f0ead8;padding:2px 8px;border-radius:10px">📅 '+b.year+'</span>':'')+badge(b.status)+(b.rating?stars(b.rating):'');
  const coverWrap = document.getElementById('revCoverWrap');
  coverWrap.innerHTML = b.cover
    ? '<img class="rev-modal-cover" src="'+esc(b.cover)+'" onerror="this.outerHTML=\\'<div class=\\"rev-modal-cover-ph\\">📖</div>\\'">'
    : '<div class="rev-modal-cover-ph">📖</div>';
  const contentEl = document.getElementById('revContent');
  if(b.review){
    contentEl.innerHTML = '<div class="rev-modal-review">&ldquo;'+esc(b.review)+'&rdquo;</div>';
  } else {
    contentEl.innerHTML = '<div class="rev-modal-no-review">No review written for this book.</div>';
  }
  const grQ = encodeURIComponent((b.title||'')+' '+(b.author||''));
  const gQ  = encodeURIComponent((b.title||'')+' '+(b.author||'')+' book');
  contentEl.innerHTML += \`<div class="rev-modal-links">
    <a class="rev-link-btn rev-link-google" href="https://www.google.com/search?q=\${gQ}" target="_blank" rel="noopener">🔍 Search Google ↗</a>
  </div>\`;
  document.getElementById('revOverlay').classList.add('open');
  document.body.style.overflow='hidden';
}

function closeReview(e){
  if(e && e.target !== document.getElementById('revOverlay') && !e.target.classList.contains('rev-modal-close')) return;
  document.getElementById('revOverlay').classList.remove('open');
  document.body.style.overflow='';
}
document.addEventListener('keydown', e=>{ if(e.key==='Escape') { document.getElementById('revOverlay').classList.remove('open'); document.body.style.overflow=''; }});

renderCatPills();
applyFilters();
<\/script>
</body>
</html>`;
}



// ============================================================
//                       LIVE READ-ONLY                      
// ============================================================
let _roListener = null;

async function loadLiveSharedLibrary(ownerUsername){
  // Hide login screen, show main UI skeleton
  document.getElementById('userSelect').classList.add('hidden');
  document.body.classList.add('ro-mode');
  ['mainHeader','mainControls','mainContent'].forEach(id=>document.getElementById(id).style.display='');
  document.getElementById('btnAdd').style.display='none';
  document.getElementById('btnShare').style.display='none';
  document.getElementById('btnSwitch').style.display='none';
  document.getElementById('btnManageCats').style.display='none';

  // Wait up to 8s for Firebase SDK to finish loading (it's loaded via CDN <script>)
  if(!db){
    let waited = 0;
    while(!db && waited < 8000){
      await new Promise(r=>setTimeout(r,200));
      waited += 200;
    }
  }
  if(!db){
    document.body.innerHTML='<div style="text-align:center;padding:80px 20px;font-family:Georgia,serif"><h2>⚠️ Firebase not available</h2><p style="margin-top:12px;color:#888">Cannot load live library. Check your connection and reload.</p></div>';
    return;
  }

  // Show loading indicator in grid
  const grid = document.getElementById('booksGrid');
  if(grid) grid.innerHTML='<div style="text-align:center;padding:60px;color:var(--muted);font-size:14px">Loading library…</div>';

  // Subscribe to live updates
  _roListener = db.collection(FS_COLLECTION).doc(ownerUsername)
    .onSnapshot({ includeMetadataChanges: false }, doc => {
      if(!doc.exists){
        if(grid) grid.innerHTML='<div style="text-align:center;padding:60px;color:var(--muted);font-size:14px">Library not found.</div>';
        return;
      }
      const data = doc.data();
      const sp = data.profile || {};
      const rawBooks = data.books || [];

      // Migrate any old custom-status books
      const _std = new Set(['read','reading','want','owned','']);
      const _cats = new Set((sp.customStatuses||[]).map(x=>x.id));

      isReadOnly = true;
      profile = sp;
      currentUser = '__readonly__';
      books = rawBooks.map(b=>({
        id: b.id || uid(),
        addedAt: b.addedAt || Date.now(),
        title:     b.title     || b.t  || '',
        author:    b.author    || b.a  || '',
        genre:     b.genre     || b.g  || '',
        year:      b.year      || b.y  || null,
        status:    b.status    || b.s  || 'read',
        category:  b.category  || b.cat|| '',
        rating:    b.rating    || b.r  || 0,
        review:    b.review    || b.v  || '',
        cover:     b.cover     || b.c  || '',
        dateStart: b.dateStart || b.ds || null,
        dateEnd:   b.dateEnd   || b.de || null,
      }));
      books.forEach(b=>{ if(b.status && !_std.has(b.status) && _cats.has(b.status)){ b.category=b.status; b.status='read'; }});

      applyProfile();
      renderCustomFilterBtns();
      renderBooks();

      // Update banner
      const banner = document.getElementById('readonly-banner');
      const label  = document.getElementById('readonly-label');
      if(banner && !banner.classList.contains('show')){
        banner.classList.add('show');
        document.getElementById('btnAdd').style.display='none';
        document.getElementById('btnShare').style.display='none';
        document.getElementById('btnSwitch').style.display='none';
        document.getElementById('btnManageCats').style.display='none';
      }
      if(label) label.innerHTML=`👁️ ${currentLang==='vi'
        ?`Đang xem thư viện của <strong>${sp.name||ownerUsername}</strong> — <span style="color:#e05252">● trực tiếp</span>`
        :`Viewing <strong>${sp.name||ownerUsername}</strong>'s library — <span style="color:#e05252">● live</span>`}`;

    }, err => {
      console.warn('Live share listener error:', err);
      if(grid) grid.innerHTML='<div style="text-align:center;padding:60px;color:var(--muted)">Connection lost. Please reload.</div>';
    });
}


// ============================================================
//                         READ-ONLY                         
// ============================================================
async function loadSharedLibrary(encoded, compressed){
  try{
    let json;
    if(compressed){
      // Decompress: reverse URL-safe base64, then DecompressionStream
      const b64 = encoded.replace(/-/g,'+').replace(/_/g,'/');
      const binary = atob(b64);
      const bytes = Uint8Array.from(binary, c=>c.charCodeAt(0));
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      writer.write(bytes);
      writer.close();
      json = await new Response(ds.readable).text();
    } else {
      json = decodeURIComponent(atob(encoded));
    }
    const parsed = JSON.parse(json);
    // Support both old format {profile,books} and new compact {p,b}
    const sp = parsed.profile || parsed.p || {};
    const rawBooks = parsed.books || parsed.b || [];
    // Expand compact book keys back to full names
    const sb = rawBooks.map(b=>({
      id: uid(), addedAt: Date.now(),
      title:  b.title  || b.t || '',
      author: b.author || b.a || '',
      genre:  b.genre  || b.g || '',
      year:   b.year   || b.y || null,
      status: b.status || b.s || 'read',
      rating: b.rating || b.r || 0,
      review: b.review || b.v || '',
      cover:    b.cover    || b.c   || '',
      category: b.category || b.cat || '',
      pinned:   b.pinned   || false,
      dateStart:b.dateStart || b.ds  || null,
      dateEnd:  b.dateEnd   || b.de  || null,
    }));
    isReadOnly=true; profile=sp; books=sb; currentUser='__readonly__';
    // Migrate old books that had custom category stored in status field
    const _std = new Set(['read','reading','want','owned','']);
    const _cats = new Set((sp.customStatuses||[]).map(x=>x.id));
    books.forEach(b=>{ if(b.status && !_std.has(b.status) && _cats.has(b.status)){ b.category=b.status; b.status='read'; }});
    document.body.classList.add('ro-mode');
    ['mainHeader','mainControls','mainContent'].forEach(id=>document.getElementById(id).style.display='');
    document.getElementById('btnAdd').style.display='none';
    document.getElementById('btnShare').style.display='none';
    document.getElementById('btnSwitch').style.display='none';
    document.getElementById('btnManageCats').style.display='none';
    applyProfile();
    renderCustomFilterBtns();
    renderBooks();
    document.getElementById('readonly-banner').classList.add('show');
    document.getElementById('readonly-label').innerHTML=`👁️ ${currentLang==='vi'?`Đang xem thư viện của <strong>${sp.name||'ai đó'}</strong> — chỉ đọc`:`Viewing <strong>${sp.name||'someone'}</strong>'s library — read only`}`;
  }catch(e){
    document.body.innerHTML='<div style="text-align:center;padding:80px 20px;font-family:Georgia,serif"><h2>Invalid share link 😞</h2><p style="margin-top:12px;color:#888">This link may be broken.</p></div>';
  }
}



// ============================================================
//                          FRIENDS                          
// ============================================================
let _friendListeners = {};
let _friendData      = {};
let _fpSelectedUser  = null; // which friend's log is being shown

function getFriends(){ return profile.friends || []; }

function showFriendsSection(){
  if(isReadOnly) return;
  const btn = document.getElementById('btnFriends');
  if(btn) btn.style.display = '';
  subscribeFriends();
  updateFriendsBtnNotif();
}

function hideFriendsSection(){
  const btn = document.getElementById('btnFriends');
  if(btn) btn.style.display = 'none';
  closeFriendsPanel();
  unsubscribeAllFriends();
}

function unsubscribeAllFriends(){
  Object.values(_friendListeners).forEach(unsub => { try{ unsub(); }catch(e){} });
  _friendListeners = {};
}

function subscribeFriends(){
  if(!db) return;
  const friends = getFriends();
  Object.keys(_friendListeners).forEach(u => {
    if(!friends.includes(u)){ try{ _friendListeners[u](); }catch(e){} delete _friendListeners[u]; }
  });
  friends.forEach(username => {
    if(_friendListeners[username]) return;
    _friendListeners[username] = db.collection(FS_COLLECTION).doc(username)
      .onSnapshot({ includeMetadataChanges: false }, doc => {
        if(!doc.exists) return;
        const data = doc.data();
        const prev = _friendData[username];
        const newBooks   = data.books   || [];
        const newProfile = data.profile || {};
        let notif = prev ? (prev.notif || 0) : 0;
        if(prev && prev.books !== undefined){
          const prevCount  = prev.books.length;
          const newCount   = newBooks.length;
          if(newCount > prevCount) notif += (newCount - prevCount);
          const prevReading = new Set(prev.books.filter(b=>b.status==='reading').map(b=>b.id));
          const nowReading  = newBooks.filter(b=>b.status==='reading' && !prevReading.has(b.id));
          if(nowReading.length) notif += nowReading.length;
          // New or updated reviews
          const prevReviews = Object.fromEntries(prev.books.map(b=>[b.id, b.review||'']));
          const newReviewed = newBooks.filter(b => (b.review||'').length > 0 && (b.review||'') !== (prevReviews[b.id]||''));
          if(newReviewed.length) notif += newReviewed.length;
        }
        _friendData[username] = { profile: newProfile, books: newBooks, notif };
        updateFriendsBtnNotif();
        if(document.getElementById('friendsPanel').classList.contains('open'))
          renderFriendsPanel();
      }, () => {});
  });
}

function updateFriendsBtnNotif(){
  const btn = document.getElementById('btnFriends');
  if(!btn) return;
  const total = Object.values(_friendData).reduce((s,d)=>s+(d.notif||0),0);
  btn.classList.toggle('has-notif', total > 0);
}

function openFriendsPanel(){
  _fpSelectedUser = null;
  document.getElementById('friendsPanel').classList.add('open');
  document.getElementById('friendsOverlay').classList.add('open');
  renderFriendsPanel();
  // Clear all notifs
  Object.values(_friendData).forEach(d => { d.notif = 0; });
  updateFriendsBtnNotif();
}

function closeFriendsPanel(){
  document.getElementById('friendsPanel').classList.remove('open');
  document.getElementById('friendsOverlay').classList.remove('open');
  _fpSelectedUser = null;
}

function renderFriendsPanel(){
  const body = document.getElementById('fpFriendList');
  if(!body) return;
  const friends = getFriends();
  if(!friends.length){
    body.innerHTML = '<div class="fp-empty">No friends yet.<br>Paste a share link above to add one.</div>';
    return;
  }

  if(_fpSelectedUser){
    renderFriendLog(_fpSelectedUser);
    return;
  }

  body.innerHTML = friends.map(username => {
    const d = _friendData[username];
    const p = d?.profile || {};
    const name   = p.name || username;
    const emoji  = p.avatarEmoji || '📖';
    const notif  = d?.notif || 0;
    const books  = d?.books || [];
    const reading = books.filter(b => b.status==='reading');
    let activity = '';
    if(d){
      if(reading.length) activity = '📖 ' + escHtml((reading[0].title||'Reading…').slice(0,28));
      else               activity = books.length + ' book' + (books.length===1?'':'s');
    } else { activity = 'Loading…'; }
    return `<div class="fp-friend-row" onclick="fpShowLog('${username}')">
      <div class="fp-avatar">${escHtml(emoji)}</div>
      <div class="fp-info">
        <div class="fp-name">${escHtml(name)}</div>
        <div class="fp-activity">${activity}</div>
      </div>
      ${notif ? `<span class="fp-notif-badge">${notif>9?'9+':notif}</span>` : ''}
      <button class="fp-remove" onclick="fpRemove(event,'${username}')" title="Remove">✕</button>
    </div>`;
  }).join('');
}

function fpShowLog(username){
  _fpSelectedUser = username;
  renderFriendLog(username);
}

function renderFriendLog(username){
  const body = document.getElementById('fpFriendList');
  if(!body) return;
  const d = _friendData[username];
  const p = d?.profile || {};
  const bks = d?.books || [];
  const name = p.name || username;

  // Back button + friend name
  let html = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
    <button onclick="_fpSelectedUser=null;renderFriendsPanel()" style="background:none;border:none;cursor:pointer;color:var(--warm);font-size:18px;padding:0;line-height:1">←</button>
    <strong style="font-size:14px">${escHtml(name)}'s Library</strong>
    <a href="${location.origin+location.pathname}?share=${encodeURIComponent(username)}" target="_blank" style="margin-left:auto;font-size:11px;color:var(--warm);font-weight:700">Open →</a>
  </div>`;

  if(!bks.length){
    html += '<div class="fp-empty">No books yet.</div>';
    body.innerHTML = html;
    return;
  }

  // Sort by most recently added
  const sorted = [...bks].sort((a,b)=>(b.addedAt||0)-(a.addedAt||0));
  html += '<div class="fp-log-title">Recent Activity</div><div class="fp-log">';
  html += sorted.slice(0,20).map(b => {
    const status = b.status==='reading'?'📖 Reading':b.status==='read'?'✓ Read':b.status==='want'?'🔖 Want':'📦 Owned';
    const stars  = b.rating ? '★'.repeat(Math.floor(b.rating)) + (b.rating%1?'½':'') : '';
    const coverHtml = b.cover
      ? `<img src="${escHtml(b.cover)}" loading="lazy" onerror="this.parentElement.textContent='📖'">`
      : '📖';
    return `<div class="fp-log-item">
      <div class="fp-log-cover">${coverHtml}</div>
      <div class="fp-log-text">
        <div class="fp-log-book">${escHtml(b.title||'Untitled')}</div>
        <div class="fp-log-meta">${escHtml(b.author||'')} ${stars ? '· '+stars : ''} · ${status}</div>
        ${b.review ? `<div class="fp-log-review">"${escHtml(b.review)}"</div>` : ''}
      </div>
    </div>`;
  }).join('');
  html += '</div>';
  body.innerHTML = html;
}

function fpRemove(e, username){
  e.stopPropagation();
  profile.friends = getFriends().filter(u => u !== username);
  if(_friendListeners[username]){ try{ _friendListeners[username](); }catch(e2){} delete _friendListeners[username]; }
  delete _friendData[username];
  if(currentUser) fsUpdateProfile(currentUser, profile).catch(()=>{});
  renderFriendsPanel();
  updateFriendsBtnNotif();
}

async function fpAddFriend(){
  const input = document.getElementById('fpLinkInput');
  const raw   = (input?.value || '').trim();
  if(!raw) return;

  let username = null;
  try {
    const url = new URL(raw);
    username = url.searchParams.get('share');
  } catch(e) {
    if(/^[a-z0-9_]{1,40}$/i.test(raw)) username = raw.toLowerCase();
  }
  if(!username){ showToast('⚠️ Invalid link'); return; }
  if(getFriends().includes(username)){ showToast('Already a friend!'); return; }

  if(input) input.disabled = true;
  try {
    if(!db) throw new Error('No DB');
    const doc = await db.collection(FS_COLLECTION).doc(username).get();
    if(!doc.exists) throw new Error('User not found');
    const d = doc.data();
    _friendData[username] = { profile: d.profile||{}, books: d.books||[], notif: 0 };
    profile.friends = [...getFriends(), username];
    subscribeFriends();
    if(currentUser) fsUpdateProfile(currentUser, profile).catch(()=>{});
    if(input){ input.value=''; input.disabled=false; }
    renderFriendsPanel();
    showToast('👥 Friend added!');
  } catch(err) {
    showToast('⚠️ ' + err.message);
    if(input) input.disabled = false;
  }
}

// Keep old openAddFriends working (used elsewhere)
function openAddFriends(){ openFriendsPanel(); }




// ============================================================
//                    DRAG & DROP REORDER                    
// ============================================================
let _dgInited      = false;
let _dgSrcId       = null;
let _dgTargetId    = null;   // id of card we'll insert near
let _dgInsertBefore= true;   // insert before or after target
let _dgClone       = null;
let _dgOffX        = 0, _dgOffY = 0;
let _dgActive      = false;
let _dgDidDrag     = false;
let _dgSaveTimer   = null;
let _dgPending     = null;
let _dgSx = 0, _dgSy = 0;
let _dgRaf         = false;
let _dgRenderedIds = [];

function _isMyOrder(){
  const ss = document.getElementById('sortSelect');
  return !isReadOnly && !!(ss && ss.value === 'manual');
}

function _dgClearTarget(){
  document.querySelectorAll('.drag-target-before,.drag-target-after')
    .forEach(el => el.classList.remove('drag-target-before','drag-target-after'));
}

function _dgMove(e){
  const cx = e.clientX, cy = e.clientY;

  if(_dgPending){
    if(Math.hypot(cx - _dgSx, cy - _dgSy) < 8) return;

    // Activate drag
    const card = _dgPending; _dgPending = null;
    _dgSrcId  = card.dataset.bookid;
    _dgActive = true;
    const rect = card.getBoundingClientRect();
    _dgOffX = cx - rect.left;
    _dgOffY = cy - rect.top;

    // Mark source — pointer-events:none via CSS class
    card.classList.add('drag-src');

    // Build clone
    _dgClone = card.cloneNode(true);
    _dgClone.id = 'dg-clone';
    _dgClone.style.width  = rect.width  + 'px';
    _dgClone.style.height = rect.height + 'px';
    _dgClone.style.left   = rect.left   + 'px';
    _dgClone.style.top    = rect.top    + 'px';
    document.body.appendChild(_dgClone);

    document.body.style.touchAction = 'none';
    if(navigator.vibrate) navigator.vibrate(18);
  }

  if(!_dgActive || !_dgClone) return;
  e.preventDefault();
  _dgDidDrag = true;

  // Move clone smoothly
  _dgClone.style.left = (cx - _dgOffX) + 'px';
  _dgClone.style.top  = (cy - _dgOffY) + 'px';

  // Throttle target detection to one RAF
  if(_dgRaf) return;
  _dgRaf = true;
  const pcx = cx, pcy = cy;
  requestAnimationFrame(() => {
    _dgRaf = false;
    if(!_dgActive || !_dgClone) return;

    // Source card has pointer-events:none, clone is hidden — clean hit test
    _dgClone.style.visibility = 'hidden';
    const el = document.elementFromPoint(pcx, pcy);
    _dgClone.style.visibility = '';

    const hov = el ? el.closest('#booksGrid .book-card[data-bookid]:not(.drag-src)') : null;

    _dgClearTarget();
    if(!hov){ _dgTargetId = null; return; }

    // Left half → insert before, right half → insert after
    const r      = hov.getBoundingClientRect();
    const before = pcx < r.left + r.width / 2;
    hov.classList.add(before ? 'drag-target-before' : 'drag-target-after');
    _dgTargetId     = hov.dataset.bookid;
    _dgInsertBefore = before;
  });
}

function _dgEnd(commit){
  _dgPending = null;
  document.removeEventListener('pointermove', _dgMove);
  document.removeEventListener('pointerup',   _dgUp);
  document.removeEventListener('pointercancel', _dgCancel);
  document.body.style.touchAction = '';

  _dgClearTarget();
  document.querySelectorAll('.drag-src').forEach(el => el.classList.remove('drag-src'));
  if(_dgClone){ _dgClone.remove(); _dgClone = null; }

  if(!_dgActive){ _dgActive = false; return; }
  _dgActive = false;

  if(commit && _dgDidDrag && _dgTargetId && _dgTargetId !== _dgSrcId){
    const srcBook = books.find(b => b.id === _dgSrcId);
    if(srcBook){
      // Remove src from array
      const rest = books.filter(b => b.id !== _dgSrcId);
      // Find target position
      const tgtIdx = rest.findIndex(b => b.id === _dgTargetId);
      if(tgtIdx !== -1){
        const insertAt = _dgInsertBefore ? tgtIdx : tgtIdx + 1;
        rest.splice(insertAt, 0, srcBook);
      } else {
        rest.push(srcBook);
      }
      // Commit — rebuild books in-place
      books.length = 0;
      rest.forEach((b, i) => { b.manualOrder = i * 1000; books.push(b); });

      const ss = document.getElementById('sortSelect');
      if(ss){ ss.value = 'manual'; ss.dataset.userChanged = '1'; }

      const p = saveBooks();
      _dgSaveTimer = p || true;
      if(p && p.then) p.finally(() => setTimeout(() => { _dgSaveTimer = null; }, 2000));
      else setTimeout(() => { _dgSaveTimer = null; }, 2600);
    }
  }

  _dgSrcId = null; _dgTargetId = null; _dgDidDrag = false;
  renderBooks();
}

function _dgUp()     { _dgEnd(true);  }
function _dgCancel() { _dgEnd(false); }

function initDragDrop(){
  if(_dgInited) return;
  _dgInited = true;
  const grid = document.getElementById('booksGrid');
  if(!grid) return;

  grid.addEventListener('pointerdown', e => {
    if(!_isMyOrder()) return;
    const card = e.target.closest('#booksGrid .book-card[data-bookid]');
    if(!card) return;
    if(e.target.closest('button,a,input,select,textarea')) return;
    _dgPending = card; _dgSx = e.clientX; _dgSy = e.clientY; _dgDidDrag = false;
    document.addEventListener('pointermove',   _dgMove,   { passive: false });
    document.addEventListener('pointerup',     _dgUp,     { once: true });
    document.addEventListener('pointercancel', _dgCancel, { once: true });
  });

  grid.addEventListener('click', e => {
    if(_dgDidDrag){ _dgDidDrag = false; e.stopImmediatePropagation(); }
  }, true);
}

// Re-init drag listeners after every renderBooks call
const _origRenderBooks = renderBooks;


// ============================================================
//                           RENDER                          
// ============================================================
function starsHTML(r,sz=18){
  if(!r) return '';
  let h='';
  for(let i=1;i<=5;i++){
    if(r>=i){
      h+=`<span style="font-size:${sz}px;color:var(--warm)">★</span>`;
    } else if(r>=i-0.5){
      // Half star: overlay trick - bg star + clipped fill star
      h+=`<span style="font-size:${sz}px;position:relative;display:inline-block;width:${sz*0.85}px;height:${sz}px;">` +
         `<span style="position:absolute;left:0;top:0;color:var(--warm-light)">★</span>` +
         `<span style="position:absolute;left:0;top:0;width:50%;overflow:hidden;display:block;color:var(--warm)">★</span>` +
         `</span>`;
    } else {
      h+=`<span style="font-size:${sz}px;color:var(--warm-light)">★</span>`;
    }
  }
  return h;
}
function statusBadge(s){
  const L = LANG[currentLang]||LANG.en;
  const m={read:[L.filterRead,'status-read'],reading:[L.filterReading,'status-reading'],want:[L.filterWant,'status-want'],owned:[L.filterOwned,'status-owned']};
  if(m[s]){ const[l,cl]=m[s]; return `<span class="status-badge ${cl}">${l}</span>`; }
  return '';
}
function catLabel(catId){
  if(!catId) return '~'; // sort uncategorised last
  const cc = (profile.customStatuses||[]).find(x=>x.id===catId);
  return cc ? cc.label : catId;
}
function categoryBadge(catId){
  if(!catId) return '';
  const cc = (profile.customStatuses||[]).find(x=>x.id===catId);
  if(cc) return `<span class="cat-badge">${cc.emoji||'📁'} ${cc.label}</span>`;
  return '';
}

// ============================================================
//                     CUSTOM CATEGORIES                     
// ============================================================
function getCustomStatuses(){ return profile.customStatuses||[]; }

function rebuildStatusSelect(){
  const L = LANG[currentLang]||LANG.en;
  const fs = document.getElementById('f-status');
  if(!fs) return;
  const prev = fs.value;
  fs.innerHTML = '';
  const built = [
    {value:'want',    text: L.statusWant},
    {value:'reading', text: L.statusReading},
    {value:'read',    text: L.statusRead},
    {value:'owned',   text: L.statusOwned},
  ];
  built.forEach(({value,text})=>{
    const o = document.createElement('option');
    o.value = value; o.textContent = text; fs.appendChild(o);
  });
  // Restore previous value if still valid
  if([...fs.options].some(o=>o.value===prev)) fs.value=prev;
}

function populateCategorySelect(){
  const fc = document.getElementById('f-category');
  if(!fc) return;
  const prev = fc.value;
  fc.innerHTML = '<option value="">— None —</option>';
  const src = isReadOnly ? (profile.customStatuses||[]) : getCustomStatuses();
  src.forEach(cs=>{
    const o = document.createElement('option');
    o.value = cs.id; o.textContent = (cs.emoji||'📁')+' '+cs.label; fc.appendChild(o);
  });
  if([...fc.options].some(o=>o.value===prev)) fc.value=prev;
}

function renderCustomFilterBtns(){
  const container = document.getElementById('customFilterBtns');
  if(!container) return;
  container.innerHTML = '';
  const src = isReadOnly ? (profile.customStatuses||[]) : getCustomStatuses();
  if(!src.length) return;
  const div = document.createElement('span');
  div.style.cssText = 'display:inline-flex;align-items:center;margin:0 4px;color:var(--muted);font-size:12px;opacity:.5;';
  div.textContent = '│';
  container.appendChild(div);
  // "All categories" reset button
  const allBtn = document.createElement('button');
  allBtn.className = 'filter-btn' + (currentCatFilter==='all'?' active':'');
  allBtn.style.cssText = currentCatFilter==='all'?'':'background:rgba(58,95,170,.06);border-color:rgba(58,95,170,.18);color:#3a5faa;';
  allBtn.textContent = '📂 All';
  allBtn.onclick = function(){ currentCatFilter='all'; renderCustomFilterBtns(); renderBooks(); };
  container.appendChild(allBtn);
  src.forEach(cs=>{
    const btn = document.createElement('button');
    const active = currentCatFilter===cs.id;
    btn.className = 'filter-btn' + (active?' active':'');
    btn.style.cssText = active?'':'background:rgba(58,95,170,.06);border-color:rgba(58,95,170,.18);color:#3a5faa;';
    btn.textContent = (cs.emoji||'📁')+' '+cs.label;
    btn.onclick = function(){ currentCatFilter = currentCatFilter===cs.id?'all':cs.id; renderCustomFilterBtns(); renderBooks(); };
    container.appendChild(btn);
  });
}

let currentCatFilter = 'all';
function setCatFilter(v, el){
  if(currentCatFilter === v){ currentCatFilter='all'; }
  else { currentCatFilter = v; }
  renderCustomFilterBtns();
  renderBooks();
}

function openManageCats(){
  if(isReadOnly) return;
  renderCatModalList();
  document.getElementById('manageCatsOverlay').classList.add('open');
}

function renderCatModalList(){
  const L = LANG[currentLang]||LANG.en;
  const list = document.getElementById('catModalList');
  if(!list) return;
  const cats = getCustomStatuses();
  if(cats.length===0){
    list.innerHTML = `<li style="font-size:12px;color:var(--muted);font-style:italic;padding:6px 2px;">${currentLang==='vi'?'Chưa có danh mục tuỳ chỉnh.':'No custom categories yet.'}</li>`;
    return;
  }
  list.innerHTML = cats.map((cs,i)=>`
    <li class="cat-modal-item">
      <span class="cat-modal-item-emoji">${cs.emoji||'📁'}</span>
      <span class="cat-modal-item-label">${escHtml(cs.label)}</span>
      <button class="cat-modal-item-del" onclick="deleteCustomCategory('${cs.id}')" title="${L.catDeleteConfirm}">✕</button>
    </li>`).join('');
}

function addCustomCategory(){
  const L = LANG[currentLang]||LANG.en;
  const emoji = (document.getElementById('catEmojiInput').value.trim()||'📁');
  const label = document.getElementById('catLabelInput').value.trim();
  if(!label){ showToast(L.catNameRequired); return; }
  const id = 'cs_' + Date.now();
  if(!profile.customStatuses) profile.customStatuses = [];
  profile.customStatuses.push({id, emoji, label});
  populateCategorySelect();
  document.getElementById('catEmojiInput').value = '';
  document.getElementById('catLabelInput').value = '';
  _persistCategories();
  renderCatModalList();
  rebuildStatusSelect();
  renderCustomFilterBtns();
}

function deleteCustomCategory(id){
  const L = LANG[currentLang]||LANG.en;
  if(!confirm(L.catDeleteConfirm)) return;
  profile.customStatuses = (profile.customStatuses||[]).filter(c=>c.id!==id);
  if(currentCatFilter===id){ currentCatFilter='all'; }
  populateCategorySelect();
  // If currently filtering by deleted cat, reset to all
  if(currentFilter===id) setFilter('all', document.getElementById('filterBtnAll'));
  _persistCategories();
  renderCatModalList();
  rebuildStatusSelect();
  renderCustomFilterBtns();
  renderBooks();
}

function _persistCategories(){
  if(currentUser) fsUpdateProfile(currentUser, profile).catch(e=>console.warn('saveCats:',e));
}

function spineColor(g){const c={'Fiction':'#8b6e4e','Literary Fiction':'#7a5c3e','Historical Fiction':'#6b5533','Non-fiction':'#4a6741','Science Fiction':'#3d5a80','Fantasy':'#6b4c7a','Horror':'#3a2a2a','Mystery & Thriller':'#5c3317','Crime':'#4a2a10','Romance':'#8b4a5c','Adventure':'#2d6b4a','Short Stories':'#7a6b4e','Classic Literature':'#6b5a2e','Biography':'#4a5568','Memoir & Autobiography':'#556070','History':'#6b5a3e','True Crime':'#4a3020','Self-help':'#2d6a4f','Psychology':'#5a4a7a','Philosophy':'#4a4a6b','Science':'#1e4d6b','Nature & Environment':'#3a6b3a','Technology':'#2a4a6b','Business & Economics':'#4a5a3a','Politics & Society':'#5a4a3a','Spirituality & Religion':'#7a6a4e','Health & Wellness':'#3a6b5a','Cooking & Food':'#8b6a2a','Travel':'#2a6b7a','Art & Design':'#7a4a6b','Music':'#5a3a7a','Sports':'#2a5a3a','Essays':'#6b6b4e','Poetry':'#6b4a3e','Young Adult':'#5a6b8b','Children\'s':'#6b8b5a','Graphic Novel / Manga':'#8b5a6b'};return c[g]||'#c8a96e';}
function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

let _renderTimer=null;
function debounceRender(){clearTimeout(_renderTimer);_renderTimer=setTimeout(renderBooks,120);}

function renderBooks(){
  const raw=document.getElementById('searchInput').value;
  // Normalize: remove accents, lowercase for flexible multilingual search
  // Vietnamese-aware normalization: try both exact and accent-stripped matching
  const normalize=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const q=normalize(raw);
  const qRaw=raw.toLowerCase(); // also match exact Vietnamese with diacritics
  const ss=document.getElementById('sortSelect');
  if(ss && !ss.dataset.userChanged && profile.defaultSort && ss.value!==profile.defaultSort && ss.value!=='manual'){
    ss.value=profile.defaultSort;
  }
  updateSortDefaultBtn();
  // In read-only mode, if the owner used My Order, respect it
  const sort = isReadOnly && books.some(b => b.manualOrder != null)
    ? 'manual'
    : (ss ? ss.value : 'date-desc');
  let f=books.filter(b=>(currentFilter==='all'||b.status===currentFilter)&&(currentCatFilter==='all'||b.category===currentCatFilter)&&(!q||(normalize(b.title).includes(q)||normalize(b.author).includes(q))||(b.title.toLowerCase().includes(qRaw)||b.author.toLowerCase().includes(qRaw))));
  f.sort((a,b)=>{
    if(sort==='title')  return a.title.localeCompare(b.title);
    if(sort==='author') return a.author.localeCompare(b.author);
    if(sort==='rating-desc') return (b.rating||0)-(a.rating||0);
    if(sort==='rating-asc')  return (a.rating||0)-(b.rating||0);
    if(sort==='year-read-desc'||sort==='year-read-asc'){
      const da=a.dateEnd||a.dateStart||null;
      const db2=b.dateEnd||b.dateStart||null;
      if(!da && !db2) return 0;
      if(!da) return 1;   // undated always to bottom
      if(!db2) return -1;
      return sort==='year-read-desc' ? db2.localeCompare(da) : da.localeCompare(db2);
    }
    if(sort==='pub-year-desc'||sort==='pub-year-asc'){
      const ya=a.year||null, yb=b.year||null;
      if(!ya && !yb) return 0;
      if(!ya) return 1;   // no pub year to bottom
      if(!yb) return -1;
      return sort==='pub-year-desc' ? yb-ya : ya-yb;
    }
    if(sort==='category'){const ca=catLabel(a.category);const cb=catLabel(b.category);return ca.localeCompare(cb);}
    if(sort==='manual') return (a.manualOrder??a.addedAt)-(b.manualOrder??b.addedAt);
    if(sort==='date-asc') return a.addedAt-b.addedAt;
    return b.addedAt-a.addedAt;
  });
  const grid=document.getElementById('booksGrid'),empty=document.getElementById('emptyState');
  const acts=isReadOnly?'':
    `<div class="book-actions">
      <button class="action-btn" onclick="openEdit('{{ID}}')"><svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path stroke-linecap="round" stroke-linejoin="round" d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>${t('editBtn')}</button>
      <button class="action-btn delete" onclick="deleteBook('{{ID}}')"><svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><polyline stroke-linecap="round" stroke-linejoin="round" points="3 6 5 6 21 6"/><path stroke-linecap="round" stroke-linejoin="round" d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path stroke-linecap="round" stroke-linejoin="round" d="M10 11v6m4-6v6"/><path stroke-linecap="round" stroke-linejoin="round" d="M9 6V4h6v2"/></svg>${t('deleteBtn')}</button>
    </div>`;
  if(f.length===0){
    grid.innerHTML='';empty.classList.add('show');
    empty.querySelector('h2').textContent=books.length===0?t('emptyShelf'):t('noResults');
    empty.querySelector('p').textContent=books.length===0?t('emptyAdd'):t('noResultsSub');
  }else{
    empty.classList.remove('show');
    const readingF = f.filter(b=>b.status==='reading');
    const pinnedF  = f.filter(b=>b.pinned && b.status!=='reading');
    const regularF = f.filter(b=>!b.pinned && b.status!=='reading');

    // Build sections: Currently Reading → Pinned → Rest
    const sections = [];
    if(readingF.length){
      sections.push('<div class="reading-label">📖 Currently Reading</div>');
      sections.push(...readingF.map((b,i)=>makeCard(b,i)));
      if(pinnedF.length||regularF.length) sections.push('<div class="pinned-divider"></div>');
    }
    if(pinnedF.length){
      sections.push('<div class="pinned-label">📌 Pinned</div>');
      sections.push(...pinnedF.map((b,i)=>makeCard(b,readingF.length+i)));
      if(regularF.length) sections.push('<div class="pinned-divider"></div>');
    }
    sections.push(...regularF.map((b,i)=>makeCard(b,readingF.length+pinnedF.length+i)));
    grid.innerHTML = sections.join('');

    function makeCard(b,i){ return `<div class="book-card${_isMyOrder()?' draggable-card':''}" data-bookid="${b.id}" style="position:relative;animation-delay:${Math.min(i,5)*30}ms;${isReadOnly?'cursor:pointer;':''}" >
      ${isReadOnly?'':('<button class="pin-btn'+(b.pinned?' pinned':'')+'" onclick="togglePin(\''+b.id+'\',event)" title="'+(b.pinned?'Unpin':'Pin (max 10)')+'">📌</button>')}
      ${b.pinned?'<div class="pinned-badge">📌</div>':''}
      <div class="book-cover">${b.cover?`<img src="${escHtml(b.cover)}" alt="${escHtml(b.title)}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=\'book-cover-placeholder\'>📖<span>${t('noCover')}</span></div>'">`:`<div class="book-cover-placeholder">📖<span>${t('noCover')}</span></div>`}</div>
      <div class="book-spine" style="background:${spineColor(b.genre)}"></div>
      <div class="book-body">
        ${b.genre?`<span class="book-genre">${escHtml(b.genre)}</span>`:''}
        <div class="book-title">${escHtml(b.title)}</div>
        <div class="book-author">by ${escHtml(b.author)}</div>
        <div class="book-meta">${b.year?`<span>📅 ${b.year}</span>`:''} ${statusBadge(b.status)} ${categoryBadge(b.category)}</div>
        ${b.rating?`<div class="stars-display">${starsHTML(b.rating,24)}<span class="star-count">${b.rating}</span></div>`:''}
        ${b.review?`<p class="book-review">"${escHtml(b.review)}"</p>`:''}
        ${(b.dateStart||b.dateEnd)?`<div class="book-duration">${readingDuration(b.dateStart,b.dateEnd)}</div>`:''}
      </div>
      ${acts.replace(/{{ID}}/g,b.id)}
    </div>`; }
  }
  updateStats();
  if(!isReadOnly) initDragDrop();
  // Show/hide drag hint bar
  const existHint = document.getElementById('dragHint');
  if(_isMyOrder() && !isReadOnly){
    if(!existHint){
      const hint = document.createElement('p');
      hint.id = 'dragHint';
      hint.style.cssText = 'text-align:center;font-size:11px;color:var(--warm);font-weight:600;padding:4px 0 10px;letter-spacing:.03em;';
      hint.textContent = '☝️ Hold any card to drag and reorder';
      const grid2 = document.getElementById('booksGrid');
      if(grid2 && grid2.parentNode) grid2.parentNode.insertBefore(hint, grid2);
    }
  } else {
    if(existHint) existHint.remove();
  }
}

function openRoReview(bookId){
  const b = books.find(x=>x.id===bookId);
  if(!b) return;
  const coverEl = document.getElementById('roRevCover');
  coverEl.innerHTML = b.cover
    ? `<img src="${escHtml(b.cover)}" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.innerHTML='📖'">`
    : '📖';
  document.getElementById('roRevTitle').textContent = b.title || '';
  document.getElementById('roRevAuthor').textContent = b.author ? 'by ' + b.author : '';
  const meta = document.getElementById('roRevMeta');
  meta.innerHTML = [
    b.year ? `<span style="font-size:11px;color:var(--muted);background:var(--paper);padding:2px 8px;border-radius:10px">📅 ${b.year}</span>` : '',
    statusBadge(b.status),
    categoryBadge(b.category),
    b.rating ? `<span style="display:inline-flex;align-items:center;gap:3px">${starsHTML(b.rating,14)}<span style="font-size:11px;color:var(--muted)">${b.rating}</span></span>` : ''
  ].filter(Boolean).join('');
  const content = document.getElementById('roRevContent');
  content.innerHTML = b.review
    ? `<p style="font-size:13px;color:var(--ink);line-height:1.75;font-style:italic;white-space:pre-wrap">&ldquo;${escHtml(b.review)}&rdquo;</p>`
    : `<p style="font-size:13px;color:var(--muted);font-style:italic;text-align:center;padding:16px 0">No review written yet.</p>`;
  const gQ = encodeURIComponent((b.title||'') + ' ' + (b.author||'') + ' book');
  const myUser = getDeviceUsers()[0] || null; // last logged-in user on this device
  const alreadyOwned = myUser && _booksCache[myUser] &&
    _booksCache[myUser].some(x =>
      (x.title||'').toLowerCase().trim() === (b.title||'').toLowerCase().trim() &&
      (x.author||'').toLowerCase().trim() === (b.author||'').toLowerCase().trim()
    );
  // Store book data safely — avoid JSON in onclick
  window._roBooks = window._roBooks || {};
  window._roBooks[b.id] = {id:b.id, title:b.title, author:b.author, cover:b.cover||'', genre:b.genre||''};
  const addBtnHtml = myUser
    ? `<button class="btn-add-to-lib${alreadyOwned?' added':''}" onclick="addToMyLibrary('${b.id}',this)" ${alreadyOwned?'disabled':''}>
        ${alreadyOwned ? '✓ In your library' : '＋ Add to my library'}
      </button>`
    : `<span style="font-size:11px;color:var(--muted);font-style:italic">Log into your library first, then visit this page to add books.</span>`;
  document.getElementById('roRevLinks').innerHTML =
    addBtnHtml +
    `<a href="https://www.google.com/search?q=${gQ}" target="_blank" rel="noopener"
        style="display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;padding:6px 14px;border-radius:20px;text-decoration:none;background:#e8f0fb;color:#1a3a7a;border:1.5px solid #bad0f0">
       🔍 Search Google ↗</a>`;
  const ov = document.getElementById('roReviewOverlay');
  ov.style.display = 'flex';
  requestAnimationFrame(()=>ov.classList.add('open'));
  document.body.style.overflow = 'hidden';
}

function closeRoReview(e){
  if(e && e.target !== document.getElementById('roReviewOverlay') && !e.target.classList.contains('modal-close')) return;
  const ov = document.getElementById('roReviewOverlay');
  ov.classList.remove('open');
  setTimeout(()=>{ if(!ov.classList.contains('open')) ov.style.display='none'; }, 260);
  document.body.style.overflow = '';
}



function addToMyLibrary(bookIdOrData, btn){
  const bookData = (typeof bookIdOrData === 'string')
    ? (window._roBooks && window._roBooks[bookIdOrData])
    : bookIdOrData;
  if(!bookData){ showToast('⚠️ Could not find book data'); return; }

  const myUser = getDeviceUsers()[0];

  // No logged-in user → queue for next login
  if(!myUser || !db){
    try {
      const queue = JSON.parse(localStorage.getItem('lib_add_queue') || '[]');
      if(!queue.some(x => (x.title||'').toLowerCase().trim() === (bookData.title||'').toLowerCase().trim()))
        queue.push(bookData);
      localStorage.setItem('lib_add_queue', JSON.stringify(queue));
    } catch(e){}
    showToast(currentLang==='vi'
      ? '📚 Đã lưu tạm! Mở tab thư viện của bạn để thêm sách.'
      : '📚 Saved! Switch to your library tab to add this book.');
    if(btn){ btn.textContent = '✓ Queued'; btn.classList.add('added'); }
    return;
  }

  if(btn){ btn.disabled = true; btn.textContent = '⟳ Adding…'; }

  // Always fetch fresh from Firestore — cache is empty in readonly context
  db.collection(FS_COLLECTION).doc(myUser).get({ source: 'server' })
    .then(doc => {
      const existing = (doc.exists ? doc.data().books : null) || _booksCache[myUser] || [];

      const dup = existing.some(x =>
        (x.title||'').toLowerCase().trim() === (bookData.title||'').toLowerCase().trim() &&
        (x.author||'').toLowerCase().trim() === (bookData.author||'').toLowerCase().trim()
      );
      if(dup){
        showToast(currentLang==='vi' ? '📚 Sách đã có trong thư viện của bạn' : '📚 Already in your library');
        if(btn){ btn.textContent = '✓ Already owned'; btn.classList.add('added'); }
        return Promise.resolve(undefined);
      }

      const newBook = {
        id: uid(), addedAt: Date.now(),
        title: bookData.title||'', author: bookData.author||'',
        cover: bookData.cover||'', genre: bookData.genre||'',
        status: 'want', rating: 0, review: '', year: null,
        category: '', pinned: false, manualOrder: null,
      };

      const updatedBooks = [...existing, newBook];
      _booksCache[myUser] = updatedBooks;
      return fsSaveBooks(myUser, updatedBooks);
    })
    .then(result => {
      if(result === undefined) return;
      showToast(currentLang==='vi' ? '✓ Đã thêm vào thư viện của bạn!' : '✓ Added to your library!');
      if(btn){ btn.textContent = '✓ Added!'; btn.classList.add('added'); btn.disabled = true; }
    })
    .catch(() => {
      showToast('⚠️ Could not save — check your connection');
      if(btn){ btn.disabled = false; btn.textContent = '＋ Add to my library'; }
    });
}
function togglePin(bookId, e){
  if(e){ e.stopPropagation(); e.preventDefault(); }
  const b = books.find(x => x.id === bookId);
  if(!b) return;
  if(!b.pinned){
    const count = books.filter(x => x.pinned).length;
    if(count >= 10){
      showToast(currentLang==='vi' ? '📌 Tối đa 10 sách được ghim' : '📌 Max 10 books can be pinned');
      return;
    }
  }
  b.pinned = !b.pinned;
  saveBooks();
  renderBooks();
  showToast(b.pinned
    ? (currentLang==='vi' ? '📌 Đã ghim!' : '📌 Pinned!')
    : (currentLang==='vi' ? '📌 Đã bỏ ghim' : '📌 Unpinned'));
}
function updateStats(){
  document.getElementById('total-count').textContent=books.length;
  document.getElementById('read-count').textContent=books.filter(b=>b.status==='read').length;
  const rated=books.filter(b=>b.rating);
  document.getElementById('avg-rating').textContent=rated.length?(rated.reduce((s,b)=>s+b.rating,0)/rated.length).toFixed(1):'—';
}
function setSortDefault(){
  const val = document.getElementById('sortSelect').value;
  profile.defaultSort = val;
  updateSortDefaultBtn();
  if(currentUser) fsUpdateProfile(currentUser, profile).catch(e=>console.warn('setSortDefault:', e));
  showToast(currentLang==='vi' ? '⭐ Đã đặt mặc định!' : '⭐ Default sort saved!');
}

function updateSortDefaultBtn(){
  const btn = document.getElementById('btnSetSortDefault');
  if(!btn) return;
  const sel = document.getElementById('sortSelect');
  const def = profile.defaultSort || 'date-desc';
  if(sel && sel.value === def){
    btn.classList.add('is-default');
    btn.title = currentLang==='vi' ? 'Đây là sắp xếp mặc định' : 'This is your default sort';
  } else {
    btn.classList.remove('is-default');
    btn.title = currentLang==='vi' ? 'Đặt làm mặc định' : 'Set as default sort';
  }
}

function setFilter(v,el){
  currentFilter=v;
  document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
  if(el) el.classList.add('active');
  renderBooks();
}


// ============================================================
//                         BOOK MODAL                        
// ============================================================
function openModal(bookId=null){
  if(isReadOnly)return;
  editingId=bookId; currentRating=0;
  document.getElementById("modal-title").textContent=bookId?t('modalEditTitle'):t('modalAddTitle');
  resetForm();
  if(bookId){
    const b=books.find(x=>x.id===bookId);
    if(b){
      try{ document.getElementById("f-title").value=b.title||"";}catch(e){}
      try{ document.getElementById("f-author").value=b.author||"";}catch(e){}
      try{ if(typeof setGenreValue==="function") setGenreValue(b.genre||"");}catch(e){}
      try{ document.getElementById("f-year").value=b.year||"";}catch(e){}
      try{ document.getElementById("f-status").value=b.status||"want";}catch(e){}
      try{ populateCategorySelect(); document.getElementById("f-category").value=b.category||'';}catch(e){}
      try{ document.getElementById("f-review").value=b.review||"";}catch(e){}
      try{ document.getElementById("f-date-start").value=b.dateStart||"";}catch(e){}
      try{ document.getElementById("f-date-end").value=b.dateEnd||"";}catch(e){}
      try{ updateTrackerDuration();}catch(e){}
      try{ setCoverPreview(b.cover||"");}catch(e){}
      try{ setStars(b.rating||0);}catch(e){}
    }
  }
  document.getElementById("bookOverlay").classList.add("open");
  setTimeout(()=>{try{document.getElementById("f-title").focus();}catch(e){}},240);
}
function openEdit(id){openModal(id);}
function closeModal(id){document.getElementById(id).classList.remove("open");if(id==="bookOverlay")editingId=null;}
function handleOverlayClick(e,id){if(e.target===document.getElementById(id))closeModal(id);}
function resetForm(){
  ['f-title','f-author','f-year','f-review'].forEach(id=>document.getElementById(id).value='');
  clearGenres();document.getElementById('f-status').value='want';populateCategorySelect();document.getElementById('f-category').value='';
  ['f-date-start','f-date-end'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  const _dur=document.getElementById('tracker-duration');if(_dur)_dur.textContent='';
  document.getElementById('f-cover').value='';document.getElementById('coverUrlInput').value='';
  // Reset book search
  const bsi = document.getElementById('bookSearchInput');
  if(bsi) bsi.value='';
  lastBookSearchQ='';
  lastSearchFailed=false;
  closeBookSearch();
  setCoverPreview('');setStars(0);hideSuggest();
}

// ── Half-star rating — mouse + touch ──
function initStars(){
  document.querySelectorAll('.star-wrap').forEach(wrap=>{
    // Mouse
    let _starRafPending=false;
    wrap.addEventListener('mousemove', e=>{
      if(_starRafPending) return;
      _starRafPending=true;
      requestAnimationFrame(()=>{
        highlightStarsTo(getStarVal(wrap, e.clientX));
        _starRafPending=false;
      });
    });
    wrap.addEventListener('mouseleave', ()=>highlightStarsTo(currentRating));
    wrap.addEventListener('click', e=>{
      const val = getStarVal(wrap, e.clientX);
      currentRating = (val === currentRating) ? 0 : val;
      highlightStarsTo(currentRating);
      updateStarLabel(currentRating);
    });
    // Touch
    wrap.addEventListener('touchstart', e=>{
      e.preventDefault();
      const t = e.touches[0];
      const v = getStarVal(wrap, t.clientX);
      highlightStarsTo(v);
    }, {passive:false});
    wrap.addEventListener('touchend', e=>{
      e.preventDefault();
      const t = e.changedTouches[0];
      const val = getStarVal(wrap, t.clientX);
      currentRating = (val === currentRating) ? 0 : val;
      highlightStarsTo(currentRating);
      updateStarLabel(currentRating);
    }, {passive:false});
  });
}
function getStarVal(wrap, clientX){
  const rect = wrap.getBoundingClientRect();
  const half = clientX - rect.left < rect.width / 2;
  return half ? parseInt(wrap.dataset.star) - 0.5 : parseInt(wrap.dataset.star);
}

function highlightStarsTo(v){
  for(let i=1;i<=5;i++){
    const fill = document.getElementById('sf'+i);
    if(!fill) continue;
    if(v >= i) fill.style.width = '100%';
    else if(v >= i - 0.5) fill.style.width = '50%';
    else fill.style.width = '0%';
  }
}

function readingDuration(dateStart, dateEnd){
  if(!dateStart && !dateEnd) return '';
  const L = LANG[currentLang]||LANG.en;
  const fmtDate = (d) => {
    if(!d) return '';
    const dt = new Date(d);
    return dt.toLocaleDateString(currentLang==='vi'?'vi-VN':'en-GB',{day:'numeric',month:'short',year:'numeric'});
  };
  if(dateStart && dateEnd){
    const ms = new Date(dateEnd) - new Date(dateStart);
    if(ms >= 0){
      const days = Math.round(ms / 86400000);
      const dayWord = days === 1 ? L.dayRead : L.daysRead;
      return `📅 ${fmtDate(dateStart)} → ${fmtDate(dateEnd)} · ${days} ${dayWord}`;
    }
  }
  if(dateStart) return `📅 ${L.startedReading}: ${fmtDate(dateStart)}`;
  if(dateEnd)   return `📅 ${L.finishedReading}: ${fmtDate(dateEnd)}`;
  return '';
}

function updateTrackerDuration(){
  const s = document.getElementById('f-date-start');
  const e = document.getElementById('f-date-end');
  const d = document.getElementById('tracker-duration');
  if(!d) return;
  const start = s ? s.value : '';
  const end   = e ? e.value : '';
  d.textContent = readingDuration(start, end);
}

function updateStarLabel(v){
  const lbl = document.getElementById('starLabel');
  if(!lbl) return;
  if(!v){ lbl.textContent=''; return; }
  const full = Math.floor(v);
  const hasHalf = v % 1 !== 0;
  const stars = '★'.repeat(full) + (hasHalf ? '½' : '');
  lbl.textContent = `${v} / 5  ${stars}`;
}

function setStars(v){
  currentRating=v;
  highlightStarsTo(v);
  updateStarLabel(v);
}
document.addEventListener('DOMContentLoaded', initStars);


// ============================================================
//                        GENRE PICKER                       
// ============================================================
(function(){
  let _selected = [];

  function renderSelected(){
    const el = document.getElementById('genreSelected');
    if(!el) return;
    if(_selected.length === 0){
      el.innerHTML = `<span class="genre-placeholder">${t('genrePlaceholder')}</span>`;
    } else {
      el.innerHTML = _selected.map(g => {
        const label = (GENRE_LABELS[g] && GENRE_LABELS[g][currentLang]) || g;
        return `<span class="genre-chip">${label}<span class="chip-x" onclick="event.stopPropagation();window._removeGenre('${g.replace(/'/g,"\\'")}')">×</span></span>`;
      }).join('');
    }
    const hid = document.getElementById('f-genre');
    if(hid) hid.value = _selected.join(', ');
  }

  window.toggleGenreDropdown = function(){
    const p = document.getElementById('genrePicker');
    if(!p) return;
    p.classList.toggle('open');
    if(p.classList.contains('open')){
      // close on outside click
      setTimeout(() => {
        document.addEventListener('click', function _close(e){
          if(!p.contains(e.target)){ p.classList.remove('open'); document.removeEventListener('click',_close); }
        });
      }, 0);
    }
  };

  window._removeGenre = function(g){
    _selected = _selected.filter(x => x !== g);
    document.querySelectorAll('.genre-opt').forEach(el => {
      if(el.dataset.val === g) el.classList.remove('selected');
    });
    renderSelected();
  };

  window.getGenreValue = function(){ return _selected.join(', '); };

  window.setGenreValue = function(val){
    _selected = val ? val.split(',').map(s=>s.trim()).filter(Boolean) : [];
    document.querySelectorAll('.genre-opt').forEach(el => {
      el.classList.toggle('selected', _selected.includes(el.dataset.val));
    });
    renderSelected();
  };

  window.clearGenres = function(){
    _selected = [];
    document.querySelectorAll('.genre-opt').forEach(el => el.classList.remove('selected'));
    renderSelected();
  };

  // Wire handlers immediately — script is at bottom of body, DOM already parsed
  function _bindGenreOpts(){
    document.querySelectorAll('.genre-opt').forEach(el => {
      if(el.dataset.gb) return; // skip already-bound
      el.dataset.gb = '1';
      el.addEventListener('click', () => {
        const v = el.dataset.val;
        if(_selected.includes(v)){
          _selected = _selected.filter(x => x !== v);
          el.classList.remove('selected');
        } else {
          _selected.push(v);
          el.classList.add('selected');
        }
        renderSelected();
      });
    });
  }
  _bindGenreOpts();
})();

function saveBook(){
  const title=document.getElementById('f-title').value.trim(),author=document.getElementById('f-author').value.trim();
  if(!title||!author){showToast(t('titleAuthorRequired'));return;}
  const data={title,author,genre:getGenreValue(),year:document.getElementById('f-year').value?parseInt(document.getElementById('f-year').value):null,status:document.getElementById('f-status').value,category:document.getElementById('f-category').value||'',rating:currentRating,review:document.getElementById('f-review').value.trim(),cover:document.getElementById('f-cover').value||'',dateStart:document.getElementById('f-date-start').value||null,dateEnd:document.getElementById('f-date-end').value||null};
  if(editingId){const idx=books.findIndex(b=>b.id===editingId);if(idx>=0)books[idx]={...books[idx],...data};showToast(t('bookUpdated'));}
  else{books.unshift({id:uid(),addedAt:Date.now(),...data});showToast(t('bookAdded'));}
  saveBooks();closeModal('bookOverlay');renderBooks();
}
function deleteBook(id){
  const b=books.find(x=>x.id===id);if(!b)return;
  if(!confirm(currentLang==='vi'?`Xóa "${b.title}"?`:`Remove "${b.title}"?`))return;
  books=books.filter(x=>x.id!==id);saveBooks();renderBooks();showToast(t('bookRemoved'));
}


// ============================================================
//                           COVER                           
// ============================================================
function setCoverPreview(src){
  const p=document.getElementById('coverPreview'),ph=document.getElementById('coverPlaceholder'),rm=document.getElementById('coverRemove'),z=document.getElementById('coverDropZone'),hid=document.getElementById('f-cover');
  if(src){p.src=src;p.classList.add('show');ph.style.display='none';rm.classList.add('show');z.classList.add('has-image');hid.value=src;}
  else{p.src='';p.classList.remove('show');ph.style.display='';rm.classList.remove('show');z.classList.remove('has-image');hid.value='';}
}
function removeCover(e){e.stopPropagation();setCoverPreview('');document.getElementById('coverUrlInput').value='';document.getElementById('coverFileInput').value='';}
function handleFileUpload(e){
  const f=e.target.files[0];
  if(!f)return;
  if(!f.type.startsWith('image/')){showToast('⚠️ Image files only.');return;}
  if(f.size>5*1024*1024){showToast('⚠️ Max 5MB.');return;}
  const r=new FileReader();
  r.onload=ev=>{
    // Compress image to max 300x450px, quality 0.7 before storing
    const img=new Image();
    img.onload=()=>{
      const MAX_W=300,MAX_H=450;
      let w=img.width,h=img.height;
      if(w>MAX_W||h>MAX_H){const s=Math.min(MAX_W/w,MAX_H/h);w=Math.round(w*s);h=Math.round(h*s);}
      const c=document.createElement('canvas');c.width=w;c.height=h;
      c.getContext('2d').drawImage(img,0,0,w,h);
      setCoverPreview(c.toDataURL('image/jpeg',0.72));
    };
    img.src=ev.target.result;
  };
  r.readAsDataURL(f);
}
function loadCoverUrl(){const url=document.getElementById('coverUrlInput').value.trim();if(!url)return;const img=new Image();img.onload=()=>setCoverPreview(url);img.onerror=()=>showToast('⚠️ Could not load that URL.');img.src=url;}
const dropZone=document.getElementById('coverDropZone');
dropZone.addEventListener('dragover',e=>{e.preventDefault();dropZone.style.borderColor='var(--warm)';});
dropZone.addEventListener('dragleave',()=>{dropZone.style.borderColor='';});
dropZone.addEventListener('drop',e=>{e.preventDefault();dropZone.style.borderColor='';const f=e.dataTransfer.files[0];if(f&&f.type.startsWith('image/')){const r=new FileReader();r.onload=ev=>setCoverPreview(ev.target.result);r.readAsDataURL(f);}});


// ============================================================
//                     COVER AUTO-SUGGEST                    
// ============================================================
function debounceCoverSearch(){
  clearTimeout(suggestTimer);
  const title=document.getElementById('f-title').value.trim();
  if(title.length<2){hideSuggest();return;}
  suggestTimer=setTimeout(()=>fetchCoverSuggestions(title),520);
}
function hideSuggest(){document.getElementById('coverSuggestWrap').classList.remove('show');document.getElementById('coverSuggestGrid').innerHTML='';lastSuggestQuery='';}

// Map ISO language codes to readable labels + flag emojis
const LANG_LABELS = {
  en:'EN 🇬🇧',fr:'FR 🇫🇷',de:'DE 🇩🇪',es:'ES 🇪🇸',it:'IT 🇮🇹',pt:'PT 🇵🇹',
  nl:'NL 🇳🇱',ru:'RU 🇷🇺',ja:'JA 🇯🇵',zh:'ZH 🇨🇳',ar:'AR 🇸🇦',ko:'KO 🇰🇷',
  pl:'PL 🇵🇱',sv:'SV 🇸🇪',da:'DA 🇩🇰',fi:'FI 🇫🇮',nb:'NO 🇳🇴',cs:'CS 🇨🇿',
  tr:'TR 🇹🇷',he:'HE 🇮🇱',hi:'HI 🇮🇳',fa:'FA 🇮🇷',uk:'UK 🇺🇦',vi:'VI 🇻🇳',
  id:'ID 🇮🇩',el:'EL 🇬🇷',ro:'RO 🇷🇴',hu:'HU 🇭🇺',bg:'BG 🇧🇬',hr:'HR 🇭🇷',
  sk:'SK 🇸🇰',ca:'CA','la':'LA','mul':'🌐'
};
function langLabel(code){if(!code)return '';const c=code.split('-')[0].toLowerCase();return LANG_LABELS[c]||c.toUpperCase();}

async function fetchCoverSuggestions(title){
  const author = document.getElementById('f-author').value.trim();
  // Lower bar: always GB (English covers). Vietnamese covers → use upper search bar.
  const isVi = false;
  const query = [title, author].filter(Boolean).join(' ');
  if(query === lastSuggestQuery) return;
  lastSuggestQuery = query;

  const wrap  = document.getElementById('coverSuggestWrap');
  const label = document.getElementById('coverSuggestLabel');
  const grid  = document.getElementById('coverSuggestGrid');
  wrap.classList.add('show');
  label.innerHTML = '<span class="spin">⟳</span> Searching Google Books…';
  grid.innerHTML  = '';

  const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
  const titleNorm  = norm(title);
  const titleWords = titleNorm.split(/\s+/).filter(w => w.length > 1);
  function scoreTitle(candidate){
    if(!candidate) return 0;
    const cn = norm(candidate);
    if(cn === titleNorm) return 100;
    if(cn.includes(titleNorm) || titleNorm.includes(cn)) return 85;
    if(!titleWords.length) return 30;
    const matches = titleWords.filter(w => cn.includes(w)).length;
    return (matches / titleWords.length) * 70;
  }

  // Cover search: Google Custom Search (image) + Google Books + Open Library

  // ── 1. Goodreads via GCS — disabled ─────────────────────────────────────
  const grFetch = Promise.resolve([]);

  const gImgFetch = Promise.resolve([]); // CSE removed

  // ── 3. Google Books ────────────────────────────────────────────────────
  const gbCoverPromise = (async()=>{
    const gbField = 'fields=items(volumeInfo(title,language,imageLinks))';
    const gbUrl = q => `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=40&printType=books&${gbField}`;
    const exactQ = `intitle:${encodeURIComponent(title)}${author?'+inauthor:'+encodeURIComponent(author):''}`;
    const looseQ = encodeURIComponent([title,author].filter(Boolean).join(' '));
    const titleOnlyQ = `intitle:${encodeURIComponent(title)}`;
    try{
      const items = [];
      const seen = new Set();
      const addItems = d => {
        if(!d?.items) return;
        for(const it of d.items){
          const key = it.volumeInfo?.imageLinks?.thumbnail || it.volumeInfo?.title;
          if(key && !seen.has(key)){ seen.add(key); items.push(it); }
        }
      };
      // Use global gbFetch queue — shared with search bar so no concurrent GB calls
      const r1 = await gbFetch(gbUrl(exactQ));
      if(r1) addItems(await r1.json());
      const r2 = await gbFetch(gbUrl(looseQ));
      if(r2) addItems(await r2.json());
      if(items.filter(i=>i.volumeInfo?.imageLinks).length < 15){
        const r3 = await gbFetch(gbUrl(titleOnlyQ));
        if(r3) addItems(await r3.json());
      }
      return items;
    }catch(e){ return []; }
  })();

  // ── Await all in parallel ─────────────────────────────────────────────
  const [grItems, gImgItems, gbItems] = await Promise.all([grFetch, gImgFetch, gbCoverPromise]);

  const covers = [];
  const seenUrls = new Set();

  // Goodreads
  for(const c of grItems){
    if(seenUrls.has(c.large)) continue; seenUrls.add(c.large);
    covers.push(c);
  }

  // Google Images
  for(const c of gImgItems){
    if(seenUrls.has(c.large)) continue; seenUrls.add(c.large);
    covers.push(c);
  }

  // Google Books — primary
  for(const item of gbItems){
    const vi = item.volumeInfo||{};
    if(!vi.imageLinks) continue;
    let thumb = (vi.imageLinks.medium||vi.imageLinks.thumbnail||vi.imageLinks.smallThumbnail||'')
      .replace(/^http:\/\//,'https://').replace('zoom=1','zoom=2');
    if(!thumb||seenUrls.has(thumb)) continue; seenUrls.add(thumb);
    const large = thumb.replace('zoom=2','zoom=3').replace('zoom=1','zoom=3');
    const lang = (vi.language||'').toLowerCase();
    const langBonus = isVi?(lang==='vi'?40:lang==='en'?10:0):(lang==='en'?20:lang===''?5:0);
    covers.push({ thumb, large, title:vi.title||'', lang, score:scoreTitle(vi.title||'')+langBonus+30, src:'gb' });
  }

  // GCS first, then GB sorted by score
  const gbCo   = covers.filter(c => c.src === 'gb').sort((a,b) => b.score - a.score);
  const otherCo= covers.filter(c => c.src !== 'gb').sort((a,b) => b.score - a.score);
  const display = [...otherCo, ...gbCo].slice(0, 60);

  label.innerHTML = '✦ Suggested covers — click to apply';
  if(!display.length){
    grid.innerHTML = `<span class="cover-suggest-none">${isVi?'Không tìm thấy bìa. Hãy thêm tên tác giả.':'No covers found. Try adding the author name.'}</span>`;
    return;
  }

  // Store cover data for applySuggestedCover so it can attempt full URL then fall back to cache
  window._coverData = {};

  function makeCoverThumb(c, idx){
    const safeTitle = (c.title||'').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    // Always display the guaranteed-loading thumbnail (Google cache for GCS/gimg, direct for GB/OL)
    const displaySrc = c.thumb;
    const srcBadge = c.src==='gr'   ? `<div class="cover-lang-badge" style="background:#382110;color:#f4f1ea;font-size:9px;font-weight:700;">📗GR</div>`
                   : c.src==='gimg' ? `<div class="cover-lang-badge" style="background:#1a73e8;color:#fff;font-size:9px;">🔍G</div>`
                   : c.src==='gb'   ? (langLabel(c.lang)?`<div class="cover-lang-badge">${langLabel(c.lang)}</div>`:'')
                   : '';
    window._coverData[idx] = { full: c.large, cache: c.cache||c.thumb, src: c.src||'gb' };
    return `<div class="cover-thumb" title="${safeTitle}" onclick="applySuggestedCoverIdx(${idx},this)">
      ${srcBadge}
      <img src="${displaySrc}" alt="${safeTitle}" loading="lazy"
        onerror="this.closest('.cover-thumb').style.display='none'">
    </div>`;
  }

  grid.innerHTML = display.map((c,i) => makeCoverThumb(c,i)).join('') +
    `<div style="width:100%;margin-top:8px;padding-top:7px;border-top:1px solid var(--warm-light);font-size:10.5px;color:var(--muted);font-style:italic;line-height:1.5;">
      📸 Can't find your cover? Take a photo of your book and upload it above :))
    </div>`;
}

// Auto-trim white/light borders from a cover image (used for Tiki covers)
function trimWhiteBorders(src){ 
  return new Promise((resolve)=>{
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width  = img.naturalWidth  || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const W = canvas.width, H = canvas.height;
        if(W === 0 || H === 0){ resolve(src); return; }
        const data = ctx.getImageData(0, 0, W, H).data;
        const THRESH = 235; // pixels brighter than this on all channels = "white"
        function isBright(x, y){
          const i = (y * W + x) * 4;
          return data[i] >= THRESH && data[i+1] >= THRESH && data[i+2] >= THRESH;
        }
        let top = 0, bottom = H - 1, left = 0, right = W - 1;
        // Scan top
        outer: for(let y = 0; y < H; y++){ for(let x = 0; x < W; x++){ if(!isBright(x,y)){top=y;break outer;} } }
        // Scan bottom
        outer: for(let y = H-1; y >= 0; y--){ for(let x = 0; x < W; x++){ if(!isBright(x,y)){bottom=y;break outer;} } }
        // Scan left
        outer: for(let x = 0; x < W; x++){ for(let y = top; y <= bottom; y++){ if(!isBright(x,y)){left=x;break outer;} } }
        // Scan right
        outer: for(let x = W-1; x >= 0; x--){ for(let y = top; y <= bottom; y++){ if(!isBright(x,y)){right=x;break outer;} } }
        // Add 2px padding so we don't crop too tight
        top    = Math.max(0, top    - 2);
        bottom = Math.min(H - 1, bottom + 2);
        left   = Math.max(0, left   - 2);
        right  = Math.min(W - 1, right  + 2);
        const cw = right - left + 1;
        const ch = bottom - top + 1;
        // Only crop if meaningful white area found (>3% each side)
        const trimFrac = 1 - (cw * ch) / (W * H);
        if(trimFrac < 0.03){ resolve(src); return; }
        const out = document.createElement('canvas');
        out.width = cw; out.height = ch;
        out.getContext('2d').drawImage(canvas, left, top, cw, ch, 0, 0, cw, ch);
        resolve(out.toDataURL('image/jpeg', 0.85));
      } catch(e) { resolve(src); }
    };
    img.onerror = () => resolve(src);
    img.src = src;
  });
}

function applySuggestedCoverIdx(idx, el){
  document.querySelectorAll('.cover-thumb').forEach(t=>t.classList.remove('selected'));
  el.classList.add('selected');
  const d = (window._coverData||{})[idx];
  if(!d){ return; }

  const applyWithTrim = async (url, fallback) => {
    // Tiki covers often have white padding baked in — auto-trim it
    if(d.src === 'cf'){
      showToast('⟳ Trimming cover…');
      const trimmed = await trimWhiteBorders(url).catch(()=>null);
      if(trimmed && trimmed !== url){
        setCoverPreview(trimmed);
        showToast('✓ Cover applied!');
        return;
      }
    }
    // For GB or if trim didn't change anything, try full-res then fallback
    const img = new Image();
    img.onload  = () => { setCoverPreview(url); showToast('✓ Cover applied!'); };
    img.onerror = () => {
      if(fallback && fallback !== url){
        setCoverPreview(fallback);
        showToast('✓ Cover applied!');
      }
    };
    img.src = url;
  };

  applyWithTrim(d.full, d.cache);
  // Auto-suggest author if empty
  const authorField = document.getElementById('f-author');
  if(!authorField.value.trim()){
    const title = document.getElementById('f-title').value.trim();
    if(title) debounceAuthorSearch(true);
  }
}
// keep old signature working too
function applySuggestedCover(url, el){
  document.querySelectorAll('.cover-thumb').forEach(t=>t.classList.remove('selected'));
  el.classList.add('selected');
  setCoverPreview(url);
  showToast('✓ Cover applied!');
}
// Event delegation for book card clicks (readonly review + owner edit)
document.addEventListener('click', e => {
  const card = e.target.closest('.book-card[data-bookid]');
  if (!card) return;
  const id = card.dataset.bookid;
  if (isReadOnly) {
    openRoReview(id);
  } else {
    openModal(id);
  }
});

document.addEventListener('DOMContentLoaded',()=>{
  const a=document.getElementById('f-author');
  if(a)a.addEventListener('input',()=>{clearTimeout(suggestTimer);const t=document.getElementById('f-title').value.trim();if(t.length>=2)suggestTimer=setTimeout(()=>fetchCoverSuggestions(t),600);});
});



// ============================================================
//                     AUTHOR AUTOSUGGEST                    
// ============================================================
let authorSuggestTimer = null;
function debounceAuthorSearch(immediate=false){
  clearTimeout(authorSuggestTimer);
  const delay = immediate ? 0 : 400;
  authorSuggestTimer = setTimeout(fetchAuthorSuggestions, delay);
}
async function fetchAuthorSuggestions(){
  const input = document.getElementById('f-author');
  const q = input.value.trim();
  const drop = document.getElementById('authorSuggestDrop');
  // Also use title to help narrow results
  const title = document.getElementById('f-title').value.trim();
  const searchQ = q.length > 1 ? q : (title.length > 2 ? title : '');
  if(!searchQ){ drop.classList.remove('show'); return; }
  drop.classList.add('show');
  drop.innerHTML = '<div class="author-suggest-loading">⟳ Searching authors…</div>';
  try{
    // Detect Japanese to also search in native script
    const isJa = /[\u3040-\u30FF\u4E00-\u9FFF]/.test(searchQ);
    // Use Open Library author search
    const res = await fetch(`https://openlibrary.org/search/authors.json?q=${encodeURIComponent(searchQ)}&limit=8`);
    const data = await res.json();
    let authors = (data.docs||[]).slice(0,8);

    // For Japanese queries, also try romaji / English name search if few results
    if(isJa && authors.length < 3){
      try{
        // Also search Google Books for the author name
        const gbRes = await fetch(`https://www.googleapis.com/books/v1/volumes?q=inauthor:${encodeURIComponent(searchQ)}&maxResults=5&langRestrict=ja&printType=books`);
        if(gbRes.ok){
          const gbData = await gbRes.json();
          const gbAuthors = [];
          for(const item of (gbData.items||[])){
            for(const a of (item.volumeInfo?.authors||[])){
              if(!gbAuthors.find(x=>x.name===a)) gbAuthors.push({name:a, work_count:null, top_work:item.volumeInfo?.title||''});
            }
          }
          // Merge: prepend GB authors not already in OL results
          for(const ga of gbAuthors){
            if(!authors.find(a=>a.name?.toLowerCase()===ga.name.toLowerCase())) authors.unshift(ga);
          }
          authors = authors.slice(0,8);
        }
      }catch(e){}
    }

    if(!authors.length){ drop.innerHTML='<div class="author-suggest-loading">No authors found.</div>'; return; }
    drop.innerHTML = authors.map(a => {
      const name = a.name||'';
      const works = a.work_count ? `${a.work_count} works` : '';
      const topWork = a.top_work||'';
      const meta = [works, topWork].filter(Boolean).join(' · ');
      return `<div class="author-suggest-item" onclick="selectAuthor('${name.replace(/'/g,"\'")}')">
        <span class="asug-name">${escHtml(name)}</span>
        ${meta ? `<span class="asug-works">${escHtml(meta)}</span>` : ''}
      </div>`;
    }).join('');
  }catch(e){
    drop.classList.remove('show');
  }
}
function selectAuthor(name){
  document.getElementById('f-author').value = name;
  document.getElementById('authorSuggestDrop').classList.remove('show');
  // Trigger cover search now that we have author
  debounceCoverSearch();
}
// Close author dropdown when clicking outside
document.addEventListener('click', e=>{
  const wrap = document.querySelector('.author-suggest-wrap');
  if(wrap && !wrap.contains(e.target)) document.getElementById('authorSuggestDrop').classList.remove('show');
});


// ===================== GOOGLE BOOKS SEARCH (Add Book) =====================
let bookSearchTimer  = null;
let lastBookSearchQ  = '';
let lastSearchFailed = false;


// ── GB mutex: strict serial queue, one request at a time, globally ──────────
let _currentSearchId = 0;
let _gbQueue = Promise.resolve();
function gbFetch(url){
  // Each call gets its own promise that resolves to ITS OWN result
  let resolveMe;
  const myPromise = new Promise(res => { resolveMe = res; });
  _gbQueue = _gbQueue.then(async () => {
    try{
      const r = await fetch(url);
      if(r.status === 429){
        await new Promise(res => setTimeout(res, 4000));
        resolveMe(null);
        return;
      }
      resolveMe(r.ok ? r : null);
    }catch(e){ resolveMe(null); }
  });
  return myPromise;
}

function debounceBookSearch(){
  clearTimeout(bookSearchTimer);
  const q = document.getElementById('bookSearchInput').value.trim();
  if(q.length < 2){ closeBookSearch(); return; }
  bookSearchTimer = setTimeout(()=>runBookSearch(q), 900);
}

function closeBookSearch(){
  document.getElementById('bookSearchResults').classList.remove('show');
  document.getElementById('bookSearchSpinner').classList.remove('show');
}

async function runBookSearch(q){
  if(q === lastBookSearchQ && !lastSearchFailed) return;
  lastBookSearchQ  = q;
  lastSearchFailed = false;

  const isVi = currentLang === 'vi';
  const isJa = /[\u3040-\u30FF\u4E00-\u9FFF\uFF65-\uFF9F]/.test(q);

  const spinner = document.getElementById('bookSearchSpinner');
  const results = document.getElementById('bookSearchResults');
  spinner.classList.add('show');
  results.classList.add('show');
  results.innerHTML = '';

  // ── ENGINE 1: Cloudflare Worker (primary) ───────────────────────────────
  // CF goes first — only call GB if CF returns nothing
  let cfItems = [];
  try{
    const cfUrl = `https://alexandrialibra.nmp2039162.workers.dev/?q=${encodeURIComponent(q)}`;
    const cfR = await fetch(cfUrl);
    if(cfR.ok){
      const d = await cfR.json();
      if(Array.isArray(d.items)) cfItems = d.items.map(x=>({...x,_source:'cf'}));
      else if(Array.isArray(d)) cfItems = d.map(x=>({...x,_source:'cf'}));
    }
  }catch(e){}

  // Upper bar is Tiki/CF only — no GB fallback here
  // (use the lower cover search bar for English/GB covers)
  const mySearchId = ++_currentSearchId;
  const gbItems = [];

  spinner.classList.remove('show');

  const seen = new Set();
  const dedup = arr => arr.filter(item=>{
    const v   = item.volumeInfo||{};
    const key = (v.title||'').toLowerCase().trim().slice(0,30)+'|'+(v.authors||[])[0]?.toLowerCase?.()?.slice(0,20);
    if(seen.has(key)) return false;
    seen.add(key); return true;
  });

  const unique = [...dedup(cfItems), ...dedup(gbItems)].slice(0,15);

  if(!unique.length){
    lastSearchFailed = true;
    results.innerHTML = `<div class="book-search-none">${
      isVi ? 'Không tìm thấy sách. Thử từ khóa khác.' : 'No books found. Try different keywords.'
    }</div>`;
    return;
  }

  results._items = unique;

  const srcBadge = src => {
    if(src==='cf') return `<span style="background:#fff3e0;color:#b34700;font-size:9px;font-weight:700;padding:1px 5px;border-radius:4px;flex-shrink:0">☁️ CF</span>`;
    return             `<span style="background:#e8f3ff;color:#1e3a5f;font-size:9px;font-weight:700;padding:1px 5px;border-radius:4px;flex-shrink:0">📘 GB</span>`;
  };

  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

  results.innerHTML = unique.map((item,i)=>{
    const v      = item.volumeInfo||{};
    const title  = v.title||'(Unknown title)';
    const author = (v.authors||[]).join(', ');
    const year   = (v.publishedDate||'').slice(0,4);
    const genre  = (v.categories||[])[0]||'';
    const lang   = v.language||'';
    let thumb = '';
    if(v.imageLinks){
      thumb = (v.imageLinks.thumbnail||v.imageLinks.smallThumbnail||'').replace(/^http:\/\//,'https://');
    }
    const thumbHtml = thumb
      ? `<img class="book-result-thumb" src="${esc(thumb)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=\\'book-result-thumb no-img\\'>📖</div>'">`
      : `<div class="book-result-thumb no-img">📖</div>`;
    const genreTag = genre ? `<span>${esc(genre.split('/')[0].trim().slice(0,22))}</span>` : '';
    const yearTag  = year  ? `<span>📅 ${esc(year)}</span>` : '';
    const langTag  = lang  ? `<span>${esc(langLabel(lang))}</span>` : '';
    return `<div class="book-result-item" onclick="selectBookResult(${i})">
      ${thumbHtml}
      <div class="book-result-info">
        <div class="book-result-title">${srcBadge(item._source)} ${esc(title)}</div>
        ${author ? `<div class="book-result-author">${esc(author)}</div>` : ''}
        <div class="book-result-meta">${yearTag}${genreTag}${langTag}</div>
      </div>
    </div>`;
  }).join('');
}

function selectBookResult(idx){
  const results = document.getElementById('bookSearchResults');
  const item    = (results._items||[])[idx];
  if(!item) return;
  const v = item.volumeInfo || {};

  const title  = v.title || '';
  const author = (v.authors||[]).join(', ');
  const year   = (v.publishedDate||'').slice(0,4);
  const genre  = (v.categories||[])[0] || '';

  // Fill fields
  const setVal = (id, val) => { const el=document.getElementById(id); if(el&&val) el.value=val; };
  setVal('f-title',  title);
  setVal('f-author', author);
  setVal('f-year',   year);

  // Match genre to dropdown
  const genreMap = {
    'fiction':'Fiction','novel':'Fiction',
    'literary fiction':'Literary Fiction','literary':'Literary Fiction',
    'historical fiction':'Historical Fiction',
    'non-fiction':'Non-fiction','nonfiction':'Non-fiction',
    'science fiction':'Science Fiction','sci-fi':'Science Fiction','space':'Science Fiction',
    'fantasy':'Fantasy','epic fantasy':'Fantasy','magic':'Fantasy',
    'horror':'Horror','supernatural':'Horror',
    'mystery':'Mystery & Thriller','thriller':'Mystery & Thriller','suspense':'Mystery & Thriller',
    'crime':'Crime','detective':'Crime',
    'romance':'Romance','love':'Romance',
    'adventure':'Adventure','action':'Adventure',
    'short stories':'Short Stories','short story':'Short Stories','anthology':'Short Stories',
    'classic':'Classic Literature','classics':'Classic Literature',
    'biography':'Biography',
    'autobiography':'Memoir & Autobiography','memoir':'Memoir & Autobiography',
    'history':'History','historical':'History',
    'true crime':'True Crime',
    'self-help':'Self-help','personal development':'Self-help','motivational':'Self-help',
    'psychology':'Psychology','psycholog':'Psychology',
    'science':'Science','physics':'Science','biology':'Science','chemistry':'Science',
    'nature':'Nature & Environment','environment':'Nature & Environment','ecology':'Nature & Environment',
    'technology':'Technology','computers':'Technology','programming':'Technology',
    'business':'Business & Economics','economics':'Business & Economics','finance':'Business & Economics',
    'philosophy':'Philosophy',
    'politics':'Politics & Society','society':'Politics & Society','sociology':'Politics & Society',
    'religion':'Spirituality & Religion','spirituality':'Spirituality & Religion','faith':'Spirituality & Religion',
    'health':'Health & Wellness','wellness':'Health & Wellness','medicine':'Health & Wellness',
    'cooking':'Cooking & Food','food':'Cooking & Food','culinary':'Cooking & Food',
    'travel':'Travel','guide':'Travel',
    'art':'Art & Design','design':'Art & Design','photography':'Art & Design',
    'music':'Music',
    'sports':'Sports','sport':'Sports',
    'essays':'Essays',
    'poetry':'Poetry','poems':'Poetry',
    'young adult':'Young Adult','ya':'Young Adult','teen':'Young Adult',
    'children':'Children\'s','juvenile':'Children\'s','kids':'Children\'s',
    'graphic novel':'Graphic Novel / Manga','manga':'Graphic Novel / Manga','comics':'Graphic Novel / Manga',
  };
  const gLow = genre.toLowerCase();
  for(const [k,v2] of Object.entries(genreMap)){
    if(gLow.includes(k)){
      if(typeof setGenreValue==='function') setGenreValue(v2);
      break;
    }
  }

  // Cover — prefer highest resolution available
  const img = v.imageLinks || {};
  const coverUrl = (img.extraLarge||img.large||img.medium||img.thumbnail||img.smallThumbnail||'')
    .replace(/^http:\/\//,'https://')
    .replace('zoom=1','zoom=3');
  if(coverUrl) setCoverPreview(coverUrl);

  // Also trigger cover suggestions for more options
  debounceCoverSearch();

  closeBookSearch();
  document.getElementById('bookSearchInput').value = '';
  lastBookSearchQ  = '';
  lastSearchFailed = false;

  showToast(t('bookDetailsFilled'));
}

// Close search results when clicking outside
document.addEventListener('click', e=>{
  const wrap = document.getElementById('bookSearchWrap');
  if(wrap && !wrap.contains(e.target)) closeBookSearch();
});



// ============================================================
//                      PASSWORD / AUTH                      
// ============================================================

// SHA-256 via WebCrypto (built into every modern browser)
async function sha256(str){
  const buf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

function togglePw(inputId, btn){
  const el = document.getElementById(inputId);
  if(!el) return;
  const show = el.type === 'password';
  el.type = show ? 'text' : 'password';
  btn.textContent = show ? '🙈' : '👁';
}

function checkPasswordStrength(){
  const pw  = document.getElementById('nb-password').value;
  const bar = document.getElementById('pwStrengthBar');
  const lbl = document.getElementById('pwStrengthLabel');
  if(!bar) return;
  let score = 0;
  if(pw.length >= 6)  score++;
  if(pw.length >= 10) score++;
  if(/[A-Z]/.test(pw)) score++;
  if(/[0-9]/.test(pw)) score++;
  if(/[^A-Za-z0-9]/.test(pw)) score++;
  const levels = [
    {w:'0%',  c:'#e0e0e0', t:''},
    {w:'20%', c:'var(--rust)',   t:t('pwVeryWeak')},
    {w:'40%', c:'#e8872a',       t:t('pwWeak')},
    {w:'60%', c:'#d4b800',       t:t('pwFair')},
    {w:'80%', c:'#5a9e3a',       t:t('pwStrong')},
    {w:'100%',c:'var(--forest)', t:t('pwVeryStrong')},
  ];
  const l = levels[score] || levels[0];
  bar.style.width = l.w; bar.style.background = l.c;
  lbl.textContent = l.t; lbl.style.color = l.c;
}

// Storage helpers for auth — now backed by Firestore (via cache)
function setUserHash(u,h)   { fsUpdateHash(u, h).catch(e => console.warn('setUserHash:', e)); }
function setUserRecovery(u,obj){ fsUpdateRecovery(u, obj).catch(e => console.warn('setUserRecovery:', e)); }

// Show password box when returning user is detected
function showPwLoginBox(){
  const box = document.getElementById('nb-pw-login-box');
  if(box){ box.classList.add('show'); setTimeout(()=>document.getElementById('nb-login-pw').focus(), 150); }
}
function hidePwLoginBox(){
  const box = document.getElementById('nb-pw-login-box');
  if(box) box.classList.remove('show');
  const err = document.getElementById('nb-login-error');
  if(err) err.textContent = '';
  const el = document.getElementById('nb-login-pw');
  if(el) el.value = '';
}

function showRecovery(){
  const username = document.getElementById('nb-username').value.trim().toLowerCase().replace(/[^a-z0-9_]/g,'');
  const rec = getUserRecovery(username);
  const sec = document.getElementById('nb-recovery-section');
  if(!rec || !rec.q){ showToast(t('noRecoveryQuestion')); return; }
  document.getElementById('nb-recovery-q-label').textContent = rec.q;
  sec.style.display = 'block';
}

async function attemptRecovery(){
  const username = document.getElementById('nb-username').value.trim().toLowerCase().replace(/[^a-z0-9_]/g,'');
  const answer   = document.getElementById('nb-recovery-ans').value.trim().toLowerCase();
  const rec      = getUserRecovery(username);
  const errEl    = document.getElementById('nb-recovery-error');
  if(!answer){ errEl.textContent=t('enterAnswerErr'); return; }
  const answerHash = await sha256(answer);
  if(!rec || answerHash !== rec.aHash){ errEl.textContent=t('incorrectAnswerErr'); return; }
  // Correct — reset password prompt
  errEl.textContent='';
  showToast(t('identityVerified'));
  document.getElementById('nb-recovery-section').style.display='none';
  // Let them reset: show a reset password prompt
  const newPw = prompt(t('newPasswordPrompt'));
  if(!newPw || newPw.length < 4){ showToast(t('passwordTooShortToast')); return; }
  const newHash = await sha256(username + newPw);
  setUserHash(username, newHash);
  showToast(t('passwordReset'));
  loginUser(username);
}



// ============================================================
//                           TOAST                           
// ============================================================
function showToast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2800);}


// ============================================================
//                          KEYBOARD                         
// ============================================================
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){
    const roOv=document.getElementById('roReviewOverlay');
    if(roOv&&roOv.classList.contains('open')){closeRoReview();return;}
    ['bookOverlay','profileOverlay','shareOverlay','addFriendsOverlay'].forEach(id=>{if(document.getElementById(id).classList.contains('open'))closeModal(id);});
    closeKnowledgeModal();
    closeWelcomeModal();
  }
  if(e.key==='Enter'&&document.getElementById('bookOverlay').classList.contains('open')&&e.target.tagName!=='TEXTAREA'&&e.target.tagName!=='SELECT')saveBook();
});



// ============================================================
//                      DAILY KNOWLEDGE                      
// ============================================================
const KN_FACTS = [
  // ── PHYSICS ──────────────────────────────────────────────────────────────
  {c:'Physics',  e:'⚛️',  f:'The speed of light in a vacuum is exactly 299,792,458 m/s — by definition, since the metre is defined in terms of it.', fVi:'Tốc độ ánh sáng trong chân không là chính xác 299.792.458 m/s — theo định nghĩa, vì mét được định nghĩa dựa trên nó.'},
  {c:'Physics',  e:'⚛️',  f:'A neutron star can spin up to 716 times per second. Pulsar PSR J1748-2446ad holds the record, completing one full rotation in 1.4 milliseconds.', fVi:'Một sao neutron có thể quay tới 716 vòng mỗi giây. Pulsar PSR J1748-2446ad giữ kỷ lục, hoàn thành một vòng quay trong 1,4 mili giây.'},
  {c:'Physics',  e:'⚛️',  f:'E=mc²: a single gram of matter, if fully converted to energy, would release about 21 kilotons of TNT — roughly the yield of the Hiroshima bomb.', fVi:'E=mc²: chỉ một gam vật chất, nếu hoàn toàn chuyển đổi thành năng lượng, sẽ giải phóng khoảng 21 kiloton TNT — tương đương sức công phá của quả bom Hiroshima.'},
  {c:'Physics',  e:'⚛️',  f:'The temperature of a lightning bolt reaches about 30,000 K — nearly five times hotter than the visible surface of the Sun.', fVi:'Nhiệt độ của một tia sét đạt tới khoảng 30.000 K — gần gấp năm lần nhiệt độ bề mặt nhìn thấy được của Mặt Trời.'},
  {c:'Physics',  e:'⚛️',  f:'Absolute zero (0 K, −273.15°C) is the lowest possible temperature. At this point, atoms have minimum possible kinetic energy and molecular motion essentially stops.', fVi:'Không độ tuyệt đối (0 K, −273,15°C) là nhiệt độ thấp nhất có thể có. Ở điểm này, các nguyên tử có động năng tối thiểu và chuyển động phân tử về cơ bản dừng lại.'},
  {c:'Physics',  e:'⚛️',  f:'The photoelectric effect — that light ejects electrons from metal surfaces only above a threshold frequency — earned Einstein the 1921 Nobel Prize, not relativity.', fVi:'Hiệu ứng quang điện — ánh sáng làm bật electron ra khỏi bề mặt kim loại chỉ khi tần số vượt ngưỡng nhất định — đã mang lại cho Einstein Giải Nobel 1921, không phải thuyết tương đối.'},
  {c:'Physics',  e:'⚛️',  f:"Heisenberg's uncertainty principle: the more precisely you know a particle's position, the less precisely you can know its momentum. This is a fundamental property of nature, not a limitation of instruments.", fVi:'Nguyên lý bất định Heisenberg: bạn càng biết chính xác vị trí của một hạt, bạn càng biết ít chính xác xung lượng của nó. Đây là thuộc tính cơ bản của tự nhiên, không phải hạn chế của thiết bị đo.'},
  {c:'Physics',  e:'⚛️',  f:'A black hole with the same mass as the Sun would have an event horizon radius of only about 3 km. Yet its gravitational pull from a distance would be identical to the Sun\'s.', fVi:'Một lỗ đen có cùng khối lượng với Mặt Trời sẽ có bán kính chân trời sự kiện chỉ khoảng 3 km. Tuy nhiên, lực hút hấp dẫn của nó từ khoảng cách xa sẽ giống hệt của Mặt Trời.'},
  {c:'Physics',  e:'⚛️',  f:'The Casimir effect: two uncharged, parallel metal plates placed extremely close together in a vacuum attract each other — because quantum fluctuations in the "empty" space between them create a net inward pressure.', fVi:'Hiệu ứng Casimir: hai tấm kim loại phẳng không tích điện đặt rất gần nhau trong chân không hút nhau — vì các dao động lượng tử trong không gian giữa chúng tạo ra áp lực hướng vào trong.'},
  {c:'Physics',  e:'⚛️',  f:'Water expands by about 9% when it freezes. This makes ice less dense than liquid water — which is why ice floats, and why lakes freeze from the top down rather than the bottom up, allowing aquatic life to survive.', fVi:'Nước nở ra khoảng 9% khi đóng băng. Điều này khiến băng nhẹ hơn nước lỏng — đó là lý do băng nổi, và tại sao hồ đóng băng từ trên xuống thay vì từ dưới lên, cho phép sinh vật thủy sinh tồn tại.'},
  {c:'Physics',  e:'⚛️',  f:'The Large Hadron Collider (CERN) has a circumference of 27 km and accelerates protons to 99.9999991% the speed of light — their relativistic mass becomes over 7,000 times their rest mass.', fVi:'Máy gia tốc hạt lớn LHC tại CERN có chu vi 27 km và tăng tốc proton lên 99,9999991% tốc độ ánh sáng — khối lượng tương đối tính của chúng tăng hơn 7.000 lần so với khối lượng nghỉ.'},
  {c:'Physics',  e:'⚛️',  f:'Quantum tunnelling allows particles to pass through energy barriers they classically cannot overcome. It is what powers nuclear fusion in the Sun and makes tunnel diodes and flash memory possible.', fVi:'Hiện tượng xuyên hầm lượng tử cho phép các hạt vượt qua các rào cản năng lượng mà chúng không thể vượt qua về mặt cổ điển. Đây là cơ chế thúc đẩy phản ứng nhiệt hạch trong Mặt Trời và làm cho điốt hầm cùng bộ nhớ flash hoạt động được.'},
  {c:'Physics',  e:'⚛️',  f:'Cherenkov radiation is the blue glow seen in nuclear reactor pools. It occurs when a charged particle travels through water faster than light travels through water (light is slower in media than in vacuum).', fVi:'Bức xạ Cherenkov là ánh sáng xanh lam thấy trong bể lò phản ứng hạt nhân. Nó xảy ra khi một hạt tích điện di chuyển trong nước nhanh hơn tốc độ ánh sáng trong nước (ánh sáng chậm hơn trong vật chất so với chân không).'},
  {c:'Physics',  e:'⚛️',  f:'Tokamaks — doughnut-shaped magnetic confinement devices — heat plasma to over 100 million °C for fusion experiments. This is about 7× hotter than the Sun\'s core.', fVi:'Tokamak — thiết bị giam cầm từ trường hình bánh rán — đốt nóng plasma lên hơn 100 triệu °C cho các thí nghiệm nhiệt hạch. Điều này nóng hơn lõi Mặt Trời khoảng 7 lần.'},
  {c:'Physics',  e:'⚛️',  f:'The Doppler effect applies to light: galaxies moving away from us have their light redshifted. Edwin Hubble used this in 1929 to discover that the universe is expanding.', fVi:'Hiệu ứng Doppler áp dụng cho ánh sáng: các thiên hà đang di chuyển ra xa chúng ta có ánh sáng dịch chuyển về phía đỏ. Edwin Hubble đã sử dụng điều này vào năm 1929 để khám phá ra rằng vũ trụ đang giãn nở.'},
  {c:'Physics',  e:'⚛️',  f:'In the double-slit experiment, electrons and photons create an interference pattern as if they are waves — but when you measure which slit they pass through, the interference pattern disappears and they behave as particles.', fVi:'Trong thí nghiệm hai khe, electron và photon tạo ra hình nhiễu xạ như thể chúng là sóng — nhưng khi bạn đo xem chúng đi qua khe nào, hình nhiễu xạ biến mất và chúng hoạt động như hạt.'},
  {c:'Physics',  e:'⚛️',  f:'Entropy always increases in a closed system (Second Law of Thermodynamics). This is why heat spontaneously flows from hot to cold, and why it is easy to scramble an egg but impossible to unscramble one.', fVi:'Entropy luôn tăng trong một hệ kín (Định luật nhiệt động lực học thứ hai). Đó là lý do nhiệt tự nhiên truyền từ nóng sang lạnh, và tại sao dễ đánh tan trứng nhưng không thể hoàn nguyên lại.'},
  {c:'Physics',  e:'⚛️',  f:'Piezoelectricity — the ability of quartz and certain ceramics to generate voltage under mechanical stress — powers guitar pickups, ultrasound machines, gas lighters, and atomic clocks.', fVi:'Áp điện — khả năng của thạch anh và một số gốm sứ tạo ra điện áp dưới áp lực cơ học — cấp nguồn cho các đầu thu guitar, máy siêu âm, bật lửa gas và đồng hồ nguyên tử.'},
  {c:'Physics',  e:'⚛️',  f:'Dark matter comprises about 27% of the universe\'s total energy content. It does not interact with light at all, but its gravitational effects are clearly observed on galactic rotation curves and gravitational lensing.', fVi:'Vật chất tối chiếm khoảng 27% tổng năng lượng của vũ trụ. Nó không tương tác với ánh sáng chút nào, nhưng các hiệu ứng hấp dẫn của nó được quan sát rõ ràng trên đường cong quay của thiên hà và thấu kính hấp dẫn.'},
  {c:'Physics',  e:'⚛️',  f:'The Coriolis effect, caused by Earth\'s rotation, deflects moving air masses to the right in the Northern Hemisphere and to the left in the Southern — this is why hurricanes spin counterclockwise in the north.', fVi:'Hiệu ứng Coriolis, gây ra bởi sự quay của Trái Đất, làm lệch các khối khí chuyển động sang phải ở Bắc Bán Cầu và sang trái ở Nam Bán Cầu — đó là lý do tại sao bão quay ngược chiều kim đồng hồ ở bán cầu bắc.'},
  {c:'Physics',  e:'⚛️',  f:'Sound travels about 4× faster in water (~1,480 m/s) than in air (~343 m/s at 20°C), because water molecules are closer together and transmit vibrations more efficiently.', fVi:'Âm thanh truyền nhanh hơn khoảng 4 lần trong nước (~1.480 m/s) so với trong không khí (~343 m/s ở 20°C), vì các phân tử nước gần nhau hơn và truyền dao động hiệu quả hơn.'},
  {c:'Physics',  e:'⚛️',  f:'A superconductor conducts electricity with exactly zero resistance below its critical temperature. The record high-temperature superconductor currently works at around −70°C, still far from room temperature.', fVi:'Chất siêu dẫn dẫn điện với điện trở bằng không dưới nhiệt độ tới hạn. Kỷ lục siêu dẫn nhiệt độ cao hiện tại hoạt động ở khoảng −70°C, vẫn còn xa so với nhiệt độ phòng.'},
  {c:'Physics',  e:'⚛️',  f:'The four fundamental forces of nature are gravity (weakest, infinite range), electromagnetism (infinite range), the weak nuclear force (radioactive decay), and the strong nuclear force (holds atomic nuclei together).', fVi:'Bốn lực cơ bản của tự nhiên là hấp dẫn (yếu nhất, tầm xa vô hạn), điện từ (tầm xa vô hạn), lực hạt nhân yếu (phân rã phóng xạ) và lực hạt nhân mạnh (giữ hạt nhân nguyên tử lại với nhau).'},
  {c:'Physics',  e:'⚛️',  f:'Ferrofluid — a liquid that becomes strongly magnetized in a magnetic field — was invented by NASA engineers in the 1960s as a method of moving rocket fuel in zero gravity using magnetic fields.', fVi:'Ferrofluid — chất lỏng bị từ hóa mạnh trong từ trường — được các kỹ sư NASA phát minh vào những năm 1960 như một phương pháp di chuyển nhiên liệu tên lửa trong môi trường không trọng lực bằng từ trường.'},
  {c:'Physics',  e:'⚛️',  f:'Nuclear fission splits heavy nuclei (like uranium-235) releasing energy; nuclear fusion combines light nuclei (like hydrogen isotopes) releasing far more energy per unit mass. Both exploit E=mc².', fVi:'Phân hạch hạt nhân tách các hạt nhân nặng (như uranium-235) giải phóng năng lượng; nhiệt hạch hạt nhân kết hợp các hạt nhân nhẹ (như đồng vị hydro) giải phóng năng lượng nhiều hơn nhiều trên mỗi đơn vị khối lượng. Cả hai đều khai thác E=mc².'},
  {c:'Physics',  e:'⚛️',  f:'The Planck length (~1.6 × 10⁻³⁵ m) is thought to be the smallest meaningful length scale in physics — below it, the concepts of length and distance break down under current physics.', fVi:'Chiều dài Planck (~1,6 × 10⁻³⁵ m) được coi là thang chiều dài nhỏ nhất có ý nghĩa trong vật lý — dưới đây, các khái niệm về chiều dài và khoảng cách sụp đổ theo vật lý hiện tại.'},
  {c:'Physics',  e:'⚛️',  f:'Thomson\'s 1897 cathode-ray tube experiment proved electrons exist as particles smaller than atoms — making electrons the first subatomic particles ever identified.', fVi:'Thí nghiệm ống tia âm cực năm 1897 của Thomson đã chứng minh rằng electron tồn tại như các hạt nhỏ hơn nguyên tử — khiến electron trở thành hạt hạ nguyên tử đầu tiên được xác định.'},
  {c:'Physics',  e:'⚛️',  f:"Feynman diagrams, developed by Richard Feynman in the 1940s, are pictorial tools for calculating the probability of particle interactions in quantum electrodynamics (QED). They don't depict actual physical paths — they represent terms in a mathematical expansion.", fVi:'Giản đồ Feynman, được Richard Feynman phát triển vào những năm 1940, là các công cụ hình ảnh để tính xác suất tương tác hạt trong điện động lực học lượng tử (QED). Chúng không mô tả các đường vật lý thực tế — chúng đại diện cho các số hạng trong một khai triển toán học.'},
  {c:'Physics',  e:'⚛️',  f:'On the Moon, a feather and a hammer fall at exactly the same rate — as demonstrated live by Apollo 15 astronaut David Scott in 1971, confirming Galileo\'s equivalence principle without air resistance.', fVi:'Trên Mặt Trăng, một chiếc lông và một cái búa rơi với tốc độ chính xác như nhau — như đã được chứng minh trực tiếp bởi phi hành gia Apollo 15 David Scott năm 1971, xác nhận nguyên lý tương đương của Galileo mà không có lực cản không khí.'},
  {c:'Physics',  e:'⚛️',  f:'The Higgs boson, discovered at CERN in 2012, is the quantum excitation of the Higgs field — the field that gives elementary particles their mass through interaction with it.', fVi:'Boson Higgs, được phát hiện tại CERN năm 2012, là kích thích lượng tử của trường Higgs — trường cung cấp khối lượng cho các hạt cơ bản thông qua tương tác với nó.'},

  // ── CHEMISTRY ────────────────────────────────────────────────────────────
  {c:'Chemistry',e:'🧪',  f:'Hydrogen is the most abundant element in the universe, comprising about 75% of all normal matter by mass. Most of it exists as plasma in stars.', fVi:'Hydro là nguyên tố phổ biến nhất trong vũ trụ, chiếm khoảng 75% tổng lượng vật chất bình thường theo khối lượng. Phần lớn tồn tại ở dạng plasma trong các ngôi sao.'},
  {c:'Chemistry',e:'🧪',  f:'Diamond and graphite are both pure carbon — their dramatically different properties (one is the hardest natural substance, the other soft and lubricating) arise entirely from how their carbon atoms are arranged.', fVi:'Kim cương và than chì đều là carbon nguyên chất — tính chất khác nhau đáng kể của chúng (một là chất cứng nhất tự nhiên, một thì mềm và bôi trơn) hoàn toàn xuất phát từ cách sắp xếp các nguyên tử carbon.'},
  {c:'Chemistry',e:'🧪',  f:'Gallium melts in your hand: its melting point is just 29.76°C (85.57°F), barely above comfortable room temperature.', fVi:'Gallium tan chảy trong tay bạn: điểm nóng chảy của nó chỉ là 29,76°C (85,57°F), hầu như bằng nhiệt độ phòng thoải mái.'},
  {c:'Chemistry',e:'🧪',  f:'Osmium is the densest naturally occurring element at 22.59 g/cm³ — about twice as dense as lead and nearly 23× denser than water.', fVi:'Osmi là nguyên tố tự nhiên có mật độ cao nhất ở 22,59 g/cm³ — nặng gấp đôi chì và gần gấp 23 lần nước.'},
  {c:'Chemistry',e:'🧪',  f:'Fluorine is the most electronegative and most reactive of all elements. It reacts vigorously with nearly every substance, including glass, and even forms compounds with noble gases like xenon.', fVi:'Flo là nguyên tố có độ âm điện và phản ứng mạnh nhất trong tất cả các nguyên tố. Nó phản ứng mạnh với gần như mọi chất, kể cả kính, và thậm chí tạo thành hợp chất với các khí trơ như xenon.'},
  {c:'Chemistry',e:'🧪',  f:'The pH scale is logarithmic. Battery acid (pH ~1) is 10 million times more acidic than pure water (pH 7). A change of just one pH unit represents a 10× change in acidity.', fVi:'Thang pH là logarit. Axit ắc quy (pH ~1) có tính axit gấp 10 triệu lần nước tinh khiết (pH 7). Thay đổi một đơn vị pH đại diện cho thay đổi 10 lần độ axit.'},
  {c:'Chemistry',e:'🧪',  f:'Aerogel is the least dense solid ever made — 99.98% air. It can support 4,000 times its own weight and is an extraordinary thermal insulator used in NASA Mars rovers and space suits.', fVi:'Aerogel là chất rắn có mật độ thấp nhất từng được tạo ra — 99,98% là không khí. Nó có thể chịu được 4.000 lần trọng lượng của chính nó và là chất cách nhiệt tuyệt vời được sử dụng trong xe thám hiểm Sao Hỏa và bộ vũ trụ của NASA.'},
  {c:'Chemistry',e:'🧪',  f:'Carbon-14 is produced in the atmosphere by cosmic rays and has a half-life of 5,730 years. This predictable decay makes radiocarbon dating reliable for organic materials up to ~50,000 years old.', fVi:'Carbon-14 được tạo ra trong khí quyển bởi tia vũ trụ và có chu kỳ bán rã 5.730 năm. Sự phân rã có thể dự đoán này làm cho phương pháp định tuổi bằng carbon phóng xạ đáng tin cậy cho vật liệu hữu cơ lên đến ~50.000 năm tuổi.'},
  {c:'Chemistry',e:'🧪',  f:'The Maillard reaction — a complex set of chemical reactions between amino acids and sugars above ~140°C — is responsible for the browning and rich flavours of grilled meat, bread crusts, toasted coffee, and beer.', fVi:'Phản ứng Maillard — một tập hợp các phản ứng hóa học phức tạp giữa axit amin và đường ở trên ~140°C — là nguyên nhân tạo ra màu nâu và hương vị phong phú của thịt nướng, vỏ bánh mì, cà phê rang và bia.'},
  {c:'Chemistry',e:'🧪',  f:'Noble gases (He, Ne, Ar, Kr, Xe, Rn) are chemically inert because their outermost electron shells are completely full, giving them no tendency to form bonds with other elements.', fVi:'Các khí trơ (He, Ne, Ar, Kr, Xe, Rn) về mặt hóa học không hoạt động vì lớp electron ngoài cùng của chúng hoàn toàn đầy, không có xu hướng tạo liên kết với các nguyên tố khác.'},
  {c:'Chemistry',e:'🧪',  f:'Mercury is the only metal liquid at room temperature (25°C). Bromine is the only other element that is liquid at room temperature. Both are toxic.', fVi:'Thủy ngân là kim loại duy nhất ở dạng lỏng ở nhiệt độ phòng (25°C). Brom là nguyên tố duy nhất khác ở dạng lỏng ở nhiệt độ phòng. Cả hai đều độc hại.'},
  {c:'Chemistry',e:'🧪',  f:'Soap works because its molecules have a hydrophilic (water-attracting) head and a hydrophobic (oil-attracting) tail. The tails surround grease particles in micelles, allowing water to rinse them away.', fVi:'Xà phòng hoạt động vì các phân tử của nó có đầu ưa nước (hút nước) và đuôi kỵ nước (hút dầu). Các đuôi bao quanh các hạt dầu mỡ trong micelle, cho phép nước rửa trôi chúng đi.'},
  {c:'Chemistry',e:'🧪',  f:'Stainless steel contains at least 10.5% chromium. The chromium reacts with oxygen in air to form a thin, invisible chromium oxide layer that protects the iron underneath from rust.', fVi:'Thép không gỉ chứa ít nhất 10,5% crom. Crom phản ứng với oxy trong không khí để tạo thành một lớp oxit crom mỏng, vô hình bảo vệ sắt bên dưới khỏi bị gỉ.'},
  {c:'Chemistry',e:'🧪',  f:'Silicon makes up 27.7% of Earth\'s crust by mass — the second most abundant element after oxygen. Silicate minerals make up about 90% of Earth\'s crust.', fVi:'Silic chiếm 27,7% khối lượng vỏ Trái Đất — nguyên tố phổ biến thứ hai sau oxy. Các khoáng vật silicat chiếm khoảng 90% vỏ Trái Đất.'},
  {c:'Chemistry',e:'🧪',  f:'Potassium reacts so violently with water that it ignites the hydrogen gas produced by the reaction, burning with a distinctive violet flame. In larger amounts the reaction is explosive.', fVi:'Kali phản ứng dữ dội với nước đến mức nó đốt cháy khí hydro tạo ra từ phản ứng, cháy với ngọn lửa tím đặc trưng. Với lượng lớn hơn, phản ứng có thể gây nổ.'},
  {c:'Chemistry',e:'🧪',  f:'Chlorophyll (in plants) and haemoglobin (in human blood) share a nearly identical molecular core structure called a porphyrin ring. The key difference: chlorophyll has a magnesium ion at the centre; haemoglobin has iron.', fVi:'Diệp lục (trong thực vật) và hemoglobin (trong máu người) có cấu trúc phân tử lõi gần như giống hệt nhau gọi là vòng porphyrin. Sự khác biệt chính: diệp lục có ion magie ở trung tâm; hemoglobin có sắt.'},
  {c:'Chemistry',e:'🧪',  f:'Gold is chemically inert in most environments because its electrons are held very tightly (relativistic effects). It only dissolves in aqua regia — a 3:1 mixture of concentrated hydrochloric and nitric acids.', fVi:'Vàng về mặt hóa học trơ trong hầu hết các môi trường vì electron của nó được giữ rất chặt (hiệu ứng tương đối tính). Nó chỉ hòa tan trong nước cường toan — hỗn hợp 3:1 của axit clohidric và axit nitric đậm đặc.'},
  {c:'Chemistry',e:'🧪',  f:'Dry ice is solid CO₂ at −78.5°C. At normal atmospheric pressure it sublimates directly from solid to gas without passing through a liquid phase, which is why it produces that characteristic fog effect.', fVi:'Đá khô là CO₂ rắn ở −78,5°C. Ở áp suất khí quyển bình thường, nó thăng hoa trực tiếp từ chất rắn sang khí mà không qua pha lỏng, tạo ra hiệu ứng sương mù đặc trưng.'},
  {c:'Chemistry',e:'🧪',  f:'Ozone (O₃) in the stratosphere absorbs 97–99% of the Sun\'s harmful UV-B and UV-C radiation. The ozone hole was caused primarily by synthetic chlorofluorocarbons (CFCs) breaking down ozone catalytically.', fVi:'Ozon (O₃) trong tầng bình lưu hấp thụ 97–99% bức xạ UV-B và UV-C có hại từ Mặt Trời. Lỗ thủng tầng ozon chủ yếu do các hợp chất chlorofluorocarbon (CFC) tổng hợp phân hủy ozon theo cơ chế xúc tác.'},
  {c:'Chemistry',e:'🧪',  f:'Water has an exceptionally high specific heat capacity (4.18 J/g·°C), meaning it resists temperature change. This is why the oceans moderate Earth\'s climate and why coastal cities have milder weather than inland ones.', fVi:'Nước có nhiệt dung riêng đặc biệt cao (4,18 J/g·°C), nghĩa là nó chống lại sự thay đổi nhiệt độ. Đó là lý do tại sao các đại dương điều hòa khí hậu Trái Đất và tại sao các thành phố ven biển có thời tiết ôn hòa hơn các thành phố nội địa.'},
  {c:'Chemistry',e:'🧪',  f:'Thermite — a mixture of aluminium powder and iron oxide — burns at ~2,500°C and cannot be extinguished with water (water decomposes in the heat, producing hydrogen that feeds the fire). It is used industrially to weld rail tracks.', fVi:'Thermit — hỗn hợp bột nhôm và oxit sắt — cháy ở nhiệt độ ~2.500°C và không thể dập tắt bằng nước (nước phân hủy trong nhiệt, tạo ra hydro tiếp thêm nhiên liệu cho ngọn lửa). Nó được sử dụng trong công nghiệp để hàn đường ray.'},
  {c:'Chemistry',e:'🧪',  f:'Nylon was the first fully synthetic fibre, developed by DuPont chemist Wallace Carothers in 1935. Its name was reportedly chosen to be unmemorable so it couldn\'t be trademarked. Nylon stockings went on sale in 1939.', fVi:'Nylon là sợi tổng hợp hoàn toàn đầu tiên, được nhà hóa học DuPont Wallace Carothers phát triển năm 1935. Tên của nó được chọn để không thể nhớ được nên không thể đăng ký thương hiệu. Vớ nylon được bán lần đầu năm 1939.'},
  {c:'Chemistry',e:'🧪',  f:'Teflon (PTFE) was discovered accidentally in 1938 when Roy Plunkett found a pressurised cylinder of tetrafluoroethylene gas had polymerised overnight. Its extreme chemical resistance comes from the carbon-fluorine bond, the strongest single bond in organic chemistry.', fVi:'Teflon (PTFE) được khám phá tình cờ vào năm 1938 khi Roy Plunkett phát hiện một bình khí tetrafluoroethylene dưới áp suất đã polymer hóa qua đêm. Khả năng chống hóa chất cực cao của nó đến từ liên kết carbon-flo, liên kết đơn mạnh nhất trong hóa học hữu cơ.'},
  {c:'Chemistry',e:'🧪',  f:'Rust (iron(III) oxide, Fe₂O₃) forms when iron reacts with water and oxygen. Salt accelerates the process by increasing the electrical conductivity of water — this is why cars rust faster on salted winter roads or near the sea.', fVi:'Gỉ sét (oxit sắt(III), Fe₂O₃) hình thành khi sắt phản ứng với nước và oxy. Muối đẩy nhanh quá trình bằng cách tăng độ dẫn điện của nước — đó là lý do xe hơi bị gỉ nhanh hơn trên đường rải muối mùa đông hoặc gần biển.'},
  {c:'Chemistry',e:'🧪',  f:'Bioluminescence in fireflies is produced by the enzyme luciferase catalysing the oxidation of a molecule called luciferin in the presence of ATP. The reaction converts chemical energy directly into light with near-100% efficiency — virtually no heat is produced.', fVi:'Phát quang sinh học ở đom đóm được tạo ra bởi enzyme luciferase xúc tác quá trình oxy hóa một phân tử gọi là luciferin khi có mặt ATP. Phản ứng chuyển đổi năng lượng hóa học trực tiếp thành ánh sáng với hiệu suất gần 100% — hầu như không sinh nhiệt.'},
  {c:'Chemistry',e:'🧪',  f:"The human body's approximate elemental composition by mass: 65% oxygen, 18% carbon, 10% hydrogen, 3% nitrogen — the rest is calcium, phosphorus, potassium, sulphur and traces of dozens of other elements.", fVi:'Thành phần nguyên tố gần đúng của cơ thể người theo khối lượng: 65% oxy, 18% carbon, 10% hydro, 3% nitơ — phần còn lại là canxi, phốt pho, kali, lưu huỳnh và vết của hàng chục nguyên tố khác.'},
  {c:'Chemistry',e:'🧪',  f:'Flame colour reveals temperature. Blue flames (~1,400°C) are hotter than yellow-orange ones (~1,000°C). Candle flames are yellow because of glowing soot particles (carbon) suspended in the flame, not the gas itself.', fVi:'Màu ngọn lửa cho biết nhiệt độ. Ngọn lửa xanh (~1.400°C) nóng hơn ngọn lửa vàng-cam (~1.000°C). Ngọn lửa nến có màu vàng vì các hạt muội than (carbon) lơ lửng trong ngọn lửa, không phải do bản thân khí gas.'},
  {c:'Chemistry',e:'🧪',  f:'TNT (2,4,6-trinitrotoluene) detonates so rapidly that its shock wave travels faster than sound. The energy comes from the extremely fast rearrangement of nitrogen, carbon and oxygen atoms into N₂, CO₂ and H₂O — all far more stable molecules.', fVi:'TNT (2,4,6-trinitrotoluene) phát nổ nhanh đến mức sóng xung kích của nó truyền nhanh hơn âm thanh. Năng lượng đến từ sự sắp xếp lại cực kỳ nhanh của các nguyên tử nitơ, carbon và oxy thành N₂, CO₂ và H₂O — tất cả đều là các phân tử ổn định hơn nhiều.'},
  {c:'Chemistry',e:'🧪',  f:"Carbon is unique in forming the enormous diversity of organic compounds because it can form four stable covalent bonds and long chains with itself. It's estimated that over 10 million distinct carbon compounds are known.", fVi:'Carbon độc đáo ở chỗ nó tạo ra sự đa dạng khổng lồ của các hợp chất hữu cơ vì nó có thể tạo bốn liên kết cộng hóa trị ổn định và các chuỗi dài với chính nó. Ước tính có hơn 10 triệu hợp chất carbon riêng biệt được biết đến.'},
  {c:'Chemistry',e:'🧪',  f:'Lithium-ion batteries work by lithium ions shuttling between a graphite anode and a lithium metal oxide cathode through an electrolyte. Goodenough, Whittingham and Yoshino shared the 2019 Nobel Chemistry Prize for their development.', fVi:'Pin lithium-ion hoạt động bằng cách các ion lithium di chuyển giữa anốt graphit và catốt oxit kim loại lithium qua chất điện phân. Goodenough, Whittingham và Yoshino đã chia sẻ Giải Nobel Hóa học 2019 vì sự phát triển của chúng.'},

  // ── BIOLOGY ──────────────────────────────────────────────────────────────
  {c:'Biology',  e:'🧬',  f:'The human body contains approximately 37.2 trillion cells, according to a 2013 estimate. Red blood cells alone account for about 70% of that total.', fVi:'Cơ thể người chứa khoảng 37,2 nghìn tỷ tế bào, theo ước tính năm 2013. Riêng tế bào hồng cầu chiếm khoảng 70% tổng số đó.'},
  {c:'Biology',  e:'🧬',  f:'All the DNA in a single human cell, if stretched end-to-end, would be about 2 metres long. All the DNA in your body laid end-to-end would stretch from Earth to Pluto and back several times over.', fVi:'Tất cả DNA trong một tế bào người, nếu kéo dài hết, sẽ dài khoảng 2 mét. Tất cả DNA trong cơ thể bạn trải dài hết sẽ từ Trái Đất đến Sao Diêm Vương và trở lại nhiều lần.'},
  {c:'Biology',  e:'🧬',  f:'Your gut microbiome contains approximately 38 trillion bacteria — roughly equal in number to all your body\'s own cells. They collectively weigh about 200g and influence immunity, metabolism, and even mood.', fVi:'Hệ vi sinh đường ruột của bạn chứa khoảng 38 nghìn tỷ vi khuẩn — gần bằng tổng số tế bào cơ thể của bạn. Chúng nặng tổng cộng khoảng 200g và ảnh hưởng đến hệ miễn dịch, chuyển hóa và thậm chí tâm trạng.'},
  {c:'Biology',  e:'🧬',  f:'The mantis shrimp has 16 types of photoreceptors (humans have 3 — red, green, blue). It can perceive wavelengths from ultraviolet to far-red infrared, plus circular polarised light invisible to all other known animals.', fVi:'Tôm tít có 16 loại thụ thể quang học (người có 3 — đỏ, xanh lá, xanh lam). Nó có thể nhận biết bước sóng từ tử ngoại đến hồng ngoại xa, cộng với ánh sáng phân cực tròn vô hình với tất cả các động vật khác được biết đến.'},
  {c:'Biology',  e:'🧬',  f:'Tardigrades (water bears, ~0.5 mm long) can survive −272°C, 150°C, 6× the pressure of the deepest ocean trench, intense radiation, and the vacuum of space. They do so by entering cryptobiosis, replacing water in their cells with a glass-like sugar.', fVi:'Gấu nước (tardigrade, ~0,5 mm) có thể sống sót ở −272°C, 150°C, áp suất gấp 6 lần rãnh đại dương sâu nhất, bức xạ mạnh, và chân không vũ trụ. Chúng làm điều này bằng cách bước vào trạng thái ngủ đông, thay thế nước trong tế bào bằng một loại đường dạng thủy tinh.'},
  {c:'Biology',  e:'🧬',  f:'Mitochondria have their own DNA separate from the cell\'s nuclear DNA. They are thought to have originated about 1.5 billion years ago as free-living bacteria that were engulfed by a host cell — a process called endosymbiosis.', fVi:'Ti thể có DNA riêng tách biệt với DNA hạt nhân của tế bào. Chúng được cho là có nguồn gốc khoảng 1,5 tỷ năm trước là vi khuẩn sống tự do bị một tế bào chủ bao bọc — quá trình gọi là nội cộng sinh.'},
  {c:'Biology',  e:'🧬',  f:'The immortal jellyfish (Turritopsis dohrnii) can revert to its juvenile polyp stage after reaching sexual maturity — a process called transdifferentiation. It may repeat this cycle indefinitely, making it biologically immortal.', fVi:'Con sứa bất tử (Turritopsis dohrnii) có thể quay trở lại giai đoạn polip ấu trùng sau khi đạt đến tuổi trưởng thành — một quá trình gọi là phản biệt hóa. Nó có thể lặp lại chu kỳ này vô thời hạn, khiến nó bất tử về mặt sinh học.'},
  {c:'Biology',  e:'🧬',  f:'Trees in forests share carbon, water and nutrients through underground fungal networks (mycorrhizae) connecting their roots. These networks span thousands of square kilometres and are called the "wood wide web."', fVi:'Các cây trong rừng chia sẻ carbon, nước và chất dinh dưỡng qua mạng lưới nấm dưới lòng đất (mycorrhizae) kết nối rễ của chúng. Những mạng lưới này trải dài hàng nghìn km² và được gọi là mạng lưới rộng của rừng.'},
  {c:'Biology',  e:'🧬',  f:'Octopuses have three hearts, blue blood (the oxygen-carrier haemocyanin uses copper instead of iron), and a distributed nervous system: one central brain and a ganglion with two-thirds of the neurons in each of their eight arms.', fVi:'Bạch tuộc có ba tim, máu xanh (chất mang oxy haemocyanin sử dụng đồng thay vì sắt), và hệ thần kinh phân tán: một não trung tâm và một hạch với hai phần ba tế bào thần kinh nằm trong mỗi tám cánh tay.'},
  {c:'Biology',  e:'🧬',  f:'The axolotl (Ambystoma mexicanum) can fully regenerate lost limbs, damaged heart tissue, spinal cord sections, and even portions of its brain — without scarring. It is the most studied vertebrate for regenerative medicine research.', fVi:'Kỳ nhông axolotl (Ambystoma mexicanum) có thể tái tạo hoàn toàn các chi bị mất, mô tim bị tổn thương, đoạn tủy sống và thậm chí một phần não — mà không để lại sẹo. Đây là động vật có xương sống được nghiên cứu nhiều nhất về y học tái tạo.'},
  {c:'Biology',  e:'🧬',  f:'Humans share roughly 60% of their DNA with bananas, 85% with zebrafish, and 98.7% with chimpanzees. DNA similarity reflects the degree of shared evolutionary ancestry.', fVi:'Con người chia sẻ khoảng 60% DNA với chuối, 85% với cá ngựa vằn và 98,7% với tinh tinh. Độ tương đồng DNA phản ánh mức độ chia sẻ tổ tiên tiến hóa.'},
  {c:'Biology',  e:'🧬',  f:'CRISPR-Cas9, awarded the 2020 Nobel Prize in Chemistry to Jennifer Doudna and Emmanuelle Charpentier, allows precise editing of DNA sequences using a guide RNA to direct the Cas9 protein to cut the genome at a specific location.', fVi:'CRISPR-Cas9, được trao Giải Nobel Hóa học 2020 cho Jennifer Doudna và Emmanuelle Charpentier, cho phép chỉnh sửa chính xác các trình tự DNA bằng cách sử dụng RNA dẫn đường để định hướng protein Cas9 cắt bộ gen tại một vị trí cụ thể.'},
  {c:'Biology',  e:'🧬',  f:'The blue whale\'s heart beats only 4–8 times per minute during a deep dive and is roughly the size of a small car. During surface feeding, its heart rate jumps to up to 37 beats per minute.', fVi:'Tim của cá voi xanh chỉ đập 4–8 lần mỗi phút khi lặn sâu và có kích thước xấp xỉ một chiếc xe nhỏ. Khi nổi lên kiếm ăn, nhịp tim của nó tăng lên tới 37 lần mỗi phút.'},
  {c:'Biology',  e:'🧬',  f:'All Cavendish bananas (the kind sold worldwide) are genetic clones propagated vegetatively. This means a single fungal pathogen — as happened with the Gros Michel in the 1950s — could in theory devastate the entire global crop.', fVi:'Tất cả chuối Cavendish (loại được bán trên toàn thế giới) là các bản sao di truyền được nhân giống sinh dưỡng. Điều này có nghĩa là một mầm bệnh nấm duy nhất — như đã xảy ra với giống Gros Michel vào những năm 1950 — về lý thuyết có thể tàn phá toàn bộ cây trồng toàn cầu.'},
  {c:'Biology',  e:'🧬',  f:'The electric eel (Electrophorus electricus) can discharge up to 860 volts — enough to stun a horse. It uses high-voltage pulses to hunt and low-voltage pulses as a sort of sonar to detect prey.', fVi:'Lươn điện (Electrophorus electricus) có thể phóng điện lên tới 860 volt — đủ để gây choáng ngựa. Nó sử dụng các xung điện cao áp để săn mồi và các xung điện thấp áp như một loại sonar để phát hiện con mồi.'},
  {c:'Biology',  e:'🧬',  f:'A hummingbird\'s heart beats up to 1,260 times per minute in flight. At rest it drops to ~250 bpm. In overnight torpor — a state of extreme metabolic slowdown — it drops to as few as 50 bpm to conserve energy.', fVi:'Tim của chim ruồi đập tới 1.260 lần mỗi phút khi bay. Lúc nghỉ ngơi, nó giảm xuống ~250 nhịp mỗi phút. Trong trạng thái ngủ đông qua đêm — trạng thái giảm chuyển hóa cực độ — nó giảm xuống còn 50 nhịp mỗi phút để tiết kiệm năng lượng.'},
  {c:'Biology',  e:'🧬',  f:'A strand of spider silk is stronger than steel of the same diameter and more elastic than nylon. Its combination of tensile strength and extensibility gives it the highest toughness of any known natural fibre.', fVi:'Một sợi tơ nhện bền hơn thép có cùng đường kính và đàn hồi hơn nylon. Sự kết hợp giữa độ bền kéo và khả năng giãn nở của nó cho nó độ bền cao nhất trong bất kỳ sợi tự nhiên nào được biết đến.'},
  {c:'Biology',  e:'🧬',  f:'Plants do not get their mass primarily from soil nutrients. About 95% of a tree\'s dry mass comes from CO₂ absorbed from the air and converted to sugars by photosynthesis. When a tree burns, that carbon returns to the atmosphere.', fVi:'Cây không lấy khối lượng chủ yếu từ chất dinh dưỡng trong đất. Khoảng 95% khối lượng khô của cây đến từ CO₂ hấp thụ từ không khí và chuyển đổi thành đường bởi quá trình quang hợp. Khi cây cháy, carbon đó trở lại khí quyển.'},
  {c:'Biology',  e:'🧬',  f:'The naked mole rat is effectively immune to cancer, insensitive to certain types of pain (e.g. acid), and lives up to 30 years — ten times longer than predicted by its body mass. It lives in colonies with a eusocial structure like ants and bees.', fVi:'Chuột chũi trần (naked mole rat) thực tế miễn dịch với ung thư, không nhạy cảm với một số loại đau (ví dụ acid), và sống tới 30 năm — gấp mười lần so với dự đoán dựa trên khối lượng cơ thể của nó. Nó sống trong đàn với cấu trúc xã hội như kiến và ong.'},
  {c:'Biology',  e:'🧬',  f:'Slime moulds (Physarum polycephalum) are single-celled organisms with no brain or neurons that can solve mazes, find the shortest path through networks, and were used to re-create the Tokyo rail network almost exactly when given food at station locations.', fVi:'Nấm nhầy (Physarum polycephalum) là sinh vật đơn bào không có não hay tế bào thần kinh nhưng có thể giải quyết mê cung, tìm đường ngắn nhất qua các mạng lưới, và được sử dụng để tái tạo gần như chính xác mạng lưới đường sắt Tokyo khi được cho thức ăn tại các vị trí ga.'},
  {c:'Biology',  e:'🧬',  f:'Viruses are not considered living by most definitions: they have no cells, cannot reproduce independently, and carry out no metabolism. They are essentially self-replicating molecular machines that hijack a host cell\'s machinery.', fVi:'Virus không được coi là sống theo hầu hết các định nghĩa: chúng không có tế bào, không thể tự sinh sản và không thực hiện quá trình trao đổi chất. Chúng về cơ bản là các máy móc phân tử tự nhân bản xâm chiếm bộ máy của tế bào chủ.'},
  {c:'Biology',  e:'🧬',  f:'Epigenetics shows that gene expression can be modified by environmental factors — diet, stress, toxins — in ways that alter DNA methylation patterns without changing the sequence, and some modifications may be heritable across generations.', fVi:'Biểu sinh học cho thấy biểu hiện gen có thể bị thay đổi bởi các yếu tố môi trường — chế độ ăn, stress, độc chất — theo cách thay đổi các mẫu methyl hóa DNA mà không thay đổi trình tự, và một số thay đổi có thể di truyền qua các thế hệ.'},
  {c:'Biology',  e:'🧬',  f:'Bats use echolocation: they emit ultrasonic pulses at up to 200 Hz and analyse the returning echoes to build a three-dimensional picture of their surroundings in complete darkness, accurately detecting objects smaller than 1 mm.', fVi:'Dơi sử dụng định vị bằng tiếng vang: chúng phát ra các xung siêu âm lên đến 200 Hz và phân tích các tiếng vang trở về để xây dựng bức tranh ba chiều về môi trường xung quanh trong bóng tối hoàn toàn, phát hiện chính xác các vật thể nhỏ hơn 1 mm.'},
  {c:'Biology',  e:'🧬',  f:'The human brain uses about 20% of the body\'s total energy despite being only ~2% of body weight. It contains roughly 86 billion neurons, each connected to thousands of others through synapses — making an estimated 100 trillion connections total.', fVi:'Não người sử dụng khoảng 20% tổng năng lượng của cơ thể mặc dù chỉ chiếm ~2% trọng lượng cơ thể. Nó chứa khoảng 86 tỷ tế bào thần kinh, mỗi tế bào kết nối với hàng nghìn tế bào khác qua synapse — tạo ra ước tính 100 nghìn tỷ kết nối tổng cộng.'},
  {c:'Biology',  e:'🧬',  f:'Photosynthesis produces not only sugars but also all the oxygen in Earth\'s atmosphere as a byproduct of splitting water molecules. Before photosynthesis evolved ~2.7 billion years ago, Earth\'s atmosphere had virtually no free oxygen.', fVi:'Quang hợp không chỉ tạo ra đường mà còn tạo ra tất cả oxy trong khí quyển Trái Đất như một sản phẩm phụ của quá trình phân tách phân tử nước. Trước khi quang hợp tiến hóa ~2,7 tỷ năm trước, khí quyển Trái Đất hầu như không có oxy tự do.'},
  {c:'Biology',  e:'🧬',  f:'The appendix is now thought to act as a "safe house" for beneficial gut bacteria during intestinal illness — the bacteria shelter there and repopulate the gut after recovery. This may explain why the appendix is retained in most mammals.', fVi:'Ruột thừa hiện được cho là hoạt động như một ngôi nhà an toàn cho vi khuẩn đường ruột có lợi trong thời gian bệnh đường ruột — vi khuẩn ẩn náu ở đó và tái sinh đường ruột sau khi phục hồi. Điều này có thể giải thích tại sao ruột thừa được giữ lại ở hầu hết các loài động vật có vú.'},
  {c:'Biology',  e:'🧬',  f:'Paul Erdős (1913–1996) said "A mathematician is a device for turning coffee into theorems." The adult human body produces about 2.5 million red blood cells per second to replace the ~120-day lifespan of each cell.', fVi:'Cơ thể người trưởng thành sản xuất khoảng 2,5 triệu tế bào hồng cầu mỗi giây để thay thế vòng đời ~120 ngày của mỗi tế bào.'},
  {c:'Biology',  e:'🧬',  f:'The heart generates enough pressure to squirt blood about 9 metres. It beats roughly 100,000 times per day, pumping around 7,500 litres of blood — a lifetime total of about 3 billion beats.', fVi:'Tim tạo ra đủ áp lực để bắn máu ra khoảng 9 mét. Nó đập khoảng 100.000 lần mỗi ngày, bơm khoảng 7.500 lít máu — tổng số trong cả đời là khoảng 3 tỷ nhịp đập.'},
  {c:'Biology',  e:'🧬',  f:'Identical twins have the same DNA sequence at birth, but their gene expression (epigenome) diverges over time due to different environments, diets, and experiences — explaining why identical twins can have different disease risks.', fVi:'Sinh đôi giống hệt nhau có cùng trình tự DNA khi sinh, nhưng biểu hiện gen (biểu sinh) của họ phân kỳ theo thời gian do các môi trường, chế độ ăn và trải nghiệm khác nhau — giải thích tại sao sinh đôi giống hệt có thể có nguy cơ mắc bệnh khác nhau.'},
  {c:'Biology',  e:'🧬',  f:"The mantis shrimp's punch accelerates at 10,000g — about 50 times the acceleration of a bullet — and generates cavitation bubbles on impact. These bubbles collapse with enough force to stun or kill prey even if the punch misses.", fVi:'Cú đấm của tôm tít tăng tốc ở 10.000g — khoảng 50 lần gia tốc của một viên đạn — và tạo ra các bong bóng xâm thực khi va chạm. Các bong bóng này xẹp với đủ lực để gây choáng hoặc giết chết con mồi ngay cả khi cú đấm trượt.'},

  // ── ASTRONOMY ────────────────────────────────────────────────────────────
  {c:'Astronomy',e:'🔭',  f:'The observable universe is approximately 93 billion light-years in diameter — meaning light from the most distant objects we can see has been travelling for 13.8 billion years but those objects are now about 46.5 billion light-years away, because space itself expanded as the light travelled.', fVi:'Vũ trụ có thể quan sát được có đường kính khoảng 93 tỷ năm ánh sáng — ánh sáng từ các vật thể xa nhất đã đi được 13,8 tỷ năm nhưng các vật thể đó hiện ở cách khoảng 46,5 tỷ năm ánh sáng, vì chính không gian đã giãn nở trong khi ánh sáng di chuyển.'},
  {c:'Astronomy',e:'🔭',  f:'There are an estimated 2 × 10²³ stars in the observable universe — more than all the grains of sand on Earth\'s beaches. Yet they fill so little of space that the universe is, overwhelmingly, empty.', fVi:'Có ước tính 2 × 10²³ ngôi sao trong vũ trụ có thể quan sát — nhiều hơn tất cả các hạt cát trên các bãi biển của Trái Đất. Tuy nhiên chúng chiếm rất ít không gian đến mức vũ trụ, về cơ bản, là rỗng không.'},
  {c:'Astronomy',e:'🔭',  f:'A day on Venus (243 Earth days) is longer than its year (225 Earth days). Venus also rotates retrograde — in the opposite direction to most planets — so the Sun rises in the west and sets in the east there.', fVi:'Một ngày trên Sao Kim (243 ngày Trái Đất) dài hơn một năm của nó (225 ngày Trái Đất). Sao Kim cũng quay ngược chiều — ngược chiều với hầu hết các hành tinh — vì vậy Mặt Trời mọc ở phía tây và lặn ở phía đông ở đó.'},
  {c:'Astronomy',e:'🔭',  f:'Voyager 1, launched in September 1977, crossed the heliopause into interstellar space in 2012 and is currently over 23 billion kilometres from Earth — the most distant human-made object ever.', fVi:'Tàu Voyager 1, được phóng vào tháng 9 năm 1977, đã vượt qua vành đai nhật quyển vào không gian liên sao năm 2012 và hiện ở cách Trái Đất hơn 23 tỷ km — vật thể nhân tạo xa nhất từng có.'},
  {c:'Astronomy',e:'🔭',  f:"Saturn's rings span up to 282,000 km in diameter (larger than the distance from Earth to the Moon) but are only 10–100 metres thick on average — proportionally thinner than a sheet of paper relative to a football field.", fVi:'Vành đai Sao Thổ có đường kính lên tới 282.000 km (lớn hơn khoảng cách từ Trái Đất đến Mặt Trăng) nhưng chỉ dày trung bình 10–100 mét — mỏng theo tỷ lệ hơn một tờ giấy so với một sân bóng đá.'},
  {c:'Astronomy',e:'🔭',  f:'The Sun converts about 4.7 million tonnes of mass into energy every second through nuclear fusion. Over its ~4.6 billion year life, it has converted roughly the mass of Saturn into pure energy.', fVi:'Mặt Trời chuyển đổi khoảng 4,7 triệu tấn khối lượng thành năng lượng mỗi giây qua phản ứng nhiệt hạch. Trong suốt ~4,6 tỷ năm tồn tại của nó, nó đã chuyển đổi xấp xỉ khối lượng của Sao Thổ thành năng lượng thuần túy.'},
  {c:'Astronomy',e:'🔭',  f:"Jupiter's Great Red Spot is an anticyclonic storm that has been continuously observed since at least 1830 and is estimated to have been raging for over 350 years. It is large enough to fit two Earths inside it.", fVi:'Vết Đỏ Lớn của Sao Mộc là một cơn bão phản xoáy đã được quan sát liên tục ít nhất từ năm 1830 và được ước tính đã hoành hành hơn 350 năm. Nó đủ lớn để chứa hai Trái Đất bên trong.'},
  {c:'Astronomy',e:'🔭',  f:'A magnetar is a type of neutron star with a magnetic field about 10¹⁵ times stronger than Earth\'s — the strongest in the known universe. If one existed at the distance of the Moon, it would erase every magnetic stripe on every credit card on Earth.', fVi:'Từ tinh (magnetar) là một loại sao neutron có từ trường mạnh hơn khoảng 10¹⁵ lần so với Trái Đất — mạnh nhất trong vũ trụ đã biết. Nếu một chiếc tồn tại ở khoảng cách của Mặt Trăng, nó sẽ xóa mọi dải từ trên mọi thẻ tín dụng trên Trái Đất.'},
  {c:'Astronomy',e:'🔭',  f:'The Andromeda Galaxy (M31) is approaching the Milky Way at ~110 km/s. In approximately 4.5 billion years, the two galaxies will collide and merge. Individual stars are so far apart that very few stellar collisions will occur.', fVi:'Thiên hà Andromeda (M31) đang tiếp cận Dải Ngân Hà với tốc độ ~110 km/s. Trong khoảng 4,5 tỷ năm, hai thiên hà sẽ va chạm và hợp nhất. Các ngôi sao riêng lẻ cách xa nhau đến mức hầu như không xảy ra va chạm sao.'},
  {c:'Astronomy',e:'🔭',  f:'The cosmic microwave background (CMB) is electromagnetic radiation left over from ~380,000 years after the Big Bang — the earliest light that could travel freely after the universe cooled enough for electrons and protons to combine into atoms.', fVi:'Bức xạ nền vũ trụ vi sóng (CMB) là bức xạ điện từ còn lại từ ~380.000 năm sau Vụ Nổ Lớn — ánh sáng sớm nhất có thể truyền tự do sau khi vũ trụ nguội đủ để electron và proton kết hợp thành nguyên tử.'},
  {c:'Astronomy',e:'🔭',  f:"Mars' Olympus Mons is the largest volcano in the solar system: 22 km high (nearly 3× Everest) and 600 km in diameter. It is so wide that, standing at the edge, the opposite rim would be below the horizon.", fVi:'Olympus Mons trên Sao Hỏa là ngọn núi lửa lớn nhất trong hệ mặt trời: cao 22 km (gần 3 lần Everest) và có đường kính 600 km. Nó rộng đến mức, đứng ở rìa, bờ đối diện sẽ nằm dưới đường chân trời.'},
  {c:'Astronomy',e:'🔭',  f:"Europa, Jupiter's fourth-largest moon, has a liquid water ocean beneath its icy crust containing an estimated twice as much water as all of Earth's oceans. It is one of the most promising candidates for extraterrestrial life in the solar system.", fVi:'Europa, mặt trăng thứ tư lớn nhất của Sao Mộc, có một đại dương nước lỏng bên dưới lớp vỏ băng chứa ước tính gấp đôi lượng nước trong tất cả các đại dương của Trái Đất. Đây là một trong những ứng cử viên đầy hứa hẹn nhất cho sự sống ngoài Trái Đất trong hệ mặt trời.'},
  {c:'Astronomy',e:'🔭',  f:'Stephen Hawking\'s 1974 prediction: black holes emit a faint thermal radiation (Hawking radiation) due to quantum effects near the event horizon and will eventually evaporate completely over astronomically long timescales.', fVi:'Dự đoán năm 1974 của Stephen Hawking: các lỗ đen phát ra bức xạ nhiệt yếu ớt (bức xạ Hawking) do các hiệu ứng lượng tử gần chân trời sự kiện và cuối cùng sẽ bốc hơi hoàn toàn trong thời gian thiên văn học cực dài.'},
  {c:'Astronomy',e:'🔭',  f:'Light from the Sun takes 8 minutes 20 seconds to reach Earth. If the Sun were to suddenly vanish, we would continue to see it in the sky for over 8 minutes — and Earth would continue orbiting an empty point for 8 minutes before drifting off into space.', fVi:'Ánh sáng từ Mặt Trời mất 8 phút 20 giây để đến Trái Đất. Nếu Mặt Trời đột ngột biến mất, chúng ta vẫn sẽ tiếp tục nhìn thấy nó trên bầu trời hơn 8 phút — và Trái Đất sẽ tiếp tục quay quanh một điểm trống 8 phút trước khi trôi dạt vào không gian.'},
  {c:'Astronomy',e:'🔭',  f:'Millisecond pulsars (rapidly rotating neutron stars) can be more stable timekeepers than atomic clocks — some maintain rotational stability to within a nanosecond over years, making them useful for detecting gravitational waves.', fVi:'Pulsar mili giây (sao neutron quay nhanh) có thể ổn định hơn đồng hồ nguyên tử — một số duy trì độ ổn định quay trong vòng một nano giây trong nhiều năm, làm cho chúng hữu ích để phát hiện sóng hấp dẫn.'},
  {c:'Astronomy',e:'🔭',  f:'Pluto was reclassified as a "dwarf planet" by the International Astronomical Union in 2006, largely because it shares its orbital neighbourhood with many similar Kuiper Belt objects, failing the third criterion for planethood.', fVi:'Sao Diêm Vương được phân loại lại là hành tinh lùn bởi Liên minh Thiên văn Quốc tế năm 2006, chủ yếu vì nó chia sẻ vùng lân cận quỹ đạo với nhiều vật thể Vành đai Kuiper tương tự, không đáp ứng tiêu chí thứ ba của hành tinh.'},
  {c:'Astronomy',e:'🔭',  f:'The ISS orbits at ~7.66 km/s, completing one orbit every 92 minutes. Astronauts aboard experience 16 sunrises and sunsets every 24 hours, and age about 0.007 seconds less per year than people on Earth due to time dilation.', fVi:'Trạm vũ trụ ISS quay quanh Trái Đất ở ~7,66 km/s, hoàn thành một quỹ đạo sau mỗi 92 phút. Các phi hành gia trên đó trải nghiệm 16 lần mặt trời mọc và lặn mỗi 24 giờ, và già đi khoảng 0,007 giây ít hơn mỗi năm so với người trên Trái Đất do giãn nở thời gian.'},
  {c:'Astronomy',e:'🔭',  f:'Dark matter comprises ~27% of the universe\'s energy content. Every attempt to detect it directly has so far failed, yet its gravitational influence is unmistakable — galaxies rotate far too fast to be held together by their visible matter alone.', fVi:'Vật chất tối chiếm ~27% năng lượng của vũ trụ. Mọi nỗ lực phát hiện trực tiếp nó đến nay đều thất bại, tuy nhiên ảnh hưởng hấp dẫn của nó rất rõ ràng — các thiên hà quay quá nhanh để được giữ lại bởi vật chất nhìn thấy của chúng.'},
  {c:'Astronomy',e:'🔭',  f:"Titan, Saturn's largest moon, is the only moon in the solar system with a dense atmosphere (thicker than Earth's) and liquid on its surface — rivers, lakes and seas of liquid methane and ethane at −179°C.", fVi:'Titan, mặt trăng lớn nhất của Sao Thổ, là mặt trăng duy nhất trong hệ mặt trời có bầu khí quyển dày (dày hơn Trái Đất) và chất lỏng trên bề mặt — các con sông, hồ và biển metan và etan lỏng ở −179°C.'},
  {c:'Astronomy',e:'🔭',  f:'The first confirmed exoplanet around a Sun-like star — 51 Pegasi b — was discovered in 1995 by Michel Mayor and Didier Queloz. As of 2024, over 5,600 exoplanets have been confirmed, with billions estimated in the Milky Way alone.', fVi:'Hành tinh ngoài hệ đầu tiên được xác nhận quanh một ngôi sao giống Mặt Trời — 51 Pegasi b — được phát hiện năm 1995 bởi Michel Mayor và Didier Queloz. Tính đến năm 2024, hơn 5.600 hành tinh ngoài hệ đã được xác nhận, với hàng tỷ được ước tính chỉ trong Dải Ngân Hà.'},
  {c:'Astronomy',e:'🔭',  f:'A light-year is ~9.46 × 10¹² km. The nearest star system, Alpha Centauri, is 4.37 light-years away. At the New Horizons probe\'s speed (~58,000 km/h), it would take about 78,000 years to reach it.', fVi:'Một năm ánh sáng là ~9,46 × 10¹² km. Hệ sao gần nhất, Alpha Centauri, cách 4,37 năm ánh sáng. Với tốc độ của tàu thăm dò New Horizons (~58.000 km/h), sẽ mất khoảng 78.000 năm để đến đó.'},
  {c:'Astronomy',e:'🔭',  f:'Neptune was discovered mathematically before it was visually observed. In 1846, Adams (England) and Le Verrier (France) independently predicted its position from anomalies in Uranus\'s orbit, and Johann Galle found it within 1° of the predicted location the same night.', fVi:'Sao Hải Vương được phát hiện bằng toán học trước khi quan sát trực quan. Năm 1846, Adams (Anh) và Le Verrier (Pháp) độc lập dự đoán vị trí của nó từ các bất thường trong quỹ đạo của Sao Thiên Vương, và Johann Galle tìm thấy nó trong vòng 1° so với vị trí dự đoán ngay đêm đó.'},
  {c:'Astronomy',e:'🔭',  f:'The universe is approximately 13.8 billion years old, determined by three independent measurements: the Hubble constant (expansion rate), the age of the oldest stars, and the CMB temperature anisotropies.', fVi:'Vũ trụ có tuổi khoảng 13,8 tỷ năm, được xác định bởi ba phép đo độc lập: hằng số Hubble (tốc độ giãn nở), tuổi của các ngôi sao cổ nhất và các dị hướng nhiệt độ CMB.'},
  {c:'Astronomy',e:'🔭',  f:'Betelgeuse, the red supergiant forming Orion\'s right shoulder, is ~700 light-years away and ~700× the diameter of the Sun. It is expected to explode as a supernova within the next ~100,000 years — brief enough on cosmic timescales to be "soon."', fVi:'Betelgeuse, siêu sao khổng lồ đỏ tạo thành vai phải của Orion, cách ~700 năm ánh sáng và có đường kính ~700 lần Mặt Trời. Nó được dự kiến sẽ nổ thành siêu tân tinh trong ~100.000 năm tới — đủ ngắn trên thang thời gian vũ trụ để coi là sắp.'},
  {c:'Astronomy',e:'🔭',  f:'The Hubble Space Telescope was launched with a primary mirror ground to the wrong shape (off by 2.2 micrometres). Astronauts installed corrective optics during a 1993 spacewalk, and it has since produced some of the deepest images of the universe ever taken.', fVi:'Kính viễn vọng Hubble được phóng với gương chính được mài sai hình dạng (lệch 2,2 micromet). Các phi hành gia đã lắp đặt quang học hiệu chỉnh trong chuyến đi bộ ngoài không gian năm 1993, và kể từ đó nó đã tạo ra một số hình ảnh sâu nhất của vũ trụ từng được chụp.'},
  {c:'Astronomy',e:'🔭',  f:'Gravitational waves — ripples in spacetime predicted by Einstein in 1916 — were first directly detected by LIGO on September 14, 2015, from two merging black holes 1.3 billion light-years away. The collision released ~3 solar masses of energy in under a second.', fVi:'Sóng hấp dẫn — gợn sóng trong không-thời gian được Einstein dự đoán năm 1916 — lần đầu tiên được phát hiện trực tiếp bởi LIGO vào ngày 14 tháng 9 năm 2015, từ hai lỗ đen hợp nhất cách 1,3 tỷ năm ánh sáng. Vụ va chạm giải phóng ~3 khối lượng mặt trời của năng lượng trong chưa đầy một giây.'},
  {c:'Astronomy',e:'🔭',  f:'The asteroid belt between Mars and Jupiter contains millions of objects, but their combined mass is less than 4% of the Moon\'s mass. If assembled into a planet, it would be smaller than our Moon.', fVi:'Vành đai tiểu hành tinh giữa Sao Hỏa và Sao Mộc chứa hàng triệu thiên thể, nhưng khối lượng tổng hợp của chúng ít hơn 4% khối lượng của Mặt Trăng. Nếu được lắp ráp thành một hành tinh, nó sẽ nhỏ hơn Mặt Trăng của chúng ta.'},
  {c:'Astronomy',e:'🔭',  f:'The first image of a black hole (M87*, 6.5 billion solar masses, 55 million light-years away) was released by the Event Horizon Telescope collaboration in April 2019 — using a virtual telescope the size of Earth.', fVi:'Hình ảnh đầu tiên về một lỗ đen (M87*, 6,5 tỷ lần khối lượng mặt trời, cách 55 triệu năm ánh sáng) được công bố bởi cộng tác Event Horizon Telescope vào tháng 4 năm 2019 — sử dụng kính viễn vọng ảo có kích thước bằng Trái Đất.'},
  {c:'Astronomy',e:'🔭',  f:'Solar flares travel to Earth in 8 minutes (at the speed of light). Coronal mass ejections — huge plasma clouds — take 1–3 days. A major CME hitting Earth\'s magnetic field can cause widespread power grid failures and aurora visible at equatorial latitudes.', fVi:'Bùng phát mặt trời di chuyển đến Trái Đất trong 8 phút (với tốc độ ánh sáng). Các vụ phóng vật chất corona — đám mây plasma khổng lồ — mất 1–3 ngày. Một CME lớn va chạm với từ trường Trái Đất có thể gây ra mất điện lưới rộng và cực quang nhìn thấy ở vĩ độ xích đạo.'},
  {c:'Astronomy',e:'🔭',  f:'The Big Bang was not an explosion into pre-existing empty space. It was an expansion of space itself from an initial singularity of infinite density. There was no "centre" of the Big Bang — every point in the universe is equally the centre.', fVi:'Vụ Nổ Lớn không phải là vụ nổ vào không gian trống rỗng đã tồn tại từ trước. Đó là sự giãn nở của không gian từ một điểm kỳ dị ban đầu có mật độ vô hạn. Không có tâm điểm của Vụ Nổ Lớn — mọi điểm trong vũ trụ đều bình đẳng là tâm điểm.'},

  // ── HISTORY ──────────────────────────────────────────────────────────────
  {c:'History',  e:'📜',  f:'Cleopatra VII (69–30 BC) lived closer in time to the Moon landing (1969 AD) — just 1,999 years — than to the construction of the Great Pyramid at Giza (~2560 BC), which predates her by 2,491 years.', fVi:'Cleopatra VII (69–30 TCN) sống gần thời điểm hạ cánh Mặt Trăng (1969 SCN) hơn — chỉ 1.999 năm — so với thời điểm xây dựng Đại Kim Tự Tháp Giza (~2560 TCN), vốn đến trước bà 2.491 năm.'},
  {c:'History',  e:'📜',  f:'The Black Death (1347–1351) killed an estimated 30–60% of Europe\'s total population — approximately 25 million people in just four years. Some towns lost 70–80% of their inhabitants.', fVi:'Dịch Cái Chết Đen (1347–1351) đã giết chết ước tính 30–60% tổng dân số châu Âu — khoảng 25 triệu người chỉ trong bốn năm. Một số thị trấn mất 70–80% dân số.'},
  {c:'History',  e:'📜',  f:'The Mongol Empire (1206–1368), at its peak under Kublai Khan, covered about 24 million km² — roughly 16% of Earth\'s total land area — making it the largest contiguous empire in history.', fVi:'Đế chế Mông Cổ (1206–1368), ở đỉnh cao dưới thời Hốt Tất Liệt, bao phủ khoảng 24 triệu km² — khoảng 16% tổng diện tích đất liền của Trái Đất — khiến nó trở thành đế chế liên tục lớn nhất trong lịch sử.'},
  {c:'History',  e:'📜',  f:"Johannes Gutenberg's printing press (~1440) is credited with enabling the Protestant Reformation, the Scientific Revolution, and ultimately modern democracy, by making books affordable enough for middle-class people to own.", fVi:'Máy in của Johannes Gutenberg (~1440) được cho là đã tạo điều kiện cho Cải cách Tin Lành, Cách mạng Khoa học và cuối cùng là nền dân chủ hiện đại, bằng cách làm cho sách đủ rẻ để tầng lớp trung lưu có thể sở hữu.'},
  {c:'History',  e:'📜',  f:'The Byzantine Empire (Eastern Roman Empire) survived for nearly 1,000 years after the fall of Western Rome in 476 AD, finally falling to the Ottoman Turks on May 29, 1453.', fVi:'Đế chế Byzantine (Đế chế La Mã phía Đông) tồn tại gần 1.000 năm sau sự sụp đổ của La Mã phía Tây vào năm 476 SCN, cuối cùng bị người Thổ Ottoman chinh phục vào ngày 29 tháng 5 năm 1453.'},
  {c:'History',  e:'📜',  f:'The total death toll of World War II is estimated at 70–85 million people — about 3% of the 1940 world population. The Soviet Union alone lost an estimated 27 million, the largest national toll.', fVi:'Tổng số người chết trong Thế chiến II được ước tính là 70–85 triệu người — khoảng 3% dân số thế giới năm 1940. Riêng Liên Xô mất ước tính 27 triệu người, con số quốc gia lớn nhất.'},
  {c:'History',  e:'📜',  f:'Napoleon Bonaparte was not unusually short: at ~5\'7" (170 cm) he was slightly above average for a French man of his era. The myth arose partly from British propaganda and partly from confusion between French and English inch measurements.', fVi:'Napoleon Bonaparte không hề thấp bất thường: ở ~170 cm, ông nhỉnh hơn trung bình một chút so với người Pháp thời đó. Huyền thoại này xuất phát một phần từ tuyên truyền của Anh và một phần từ sự nhầm lẫn giữa các đơn vị đo inch Pháp và Anh.'},
  {c:'History',  e:'📜',  f:"The Aztec capital Tenochtitlán (now Mexico City), when Hernán Cortés arrived in 1519, had a population of roughly 200,000–300,000 people — making it larger than any city in Europe at the time.", fVi:'Thủ đô Tenochtitlán của người Aztec (nay là Thành phố Mexico), khi Hernán Cortés đến năm 1519, có dân số khoảng 200.000–300.000 người — lớn hơn bất kỳ thành phố nào ở châu Âu thời bấy giờ.'},
  {c:'History',  e:'📜',  f:'The Spanish flu pandemic (1918–1920) infected an estimated 500 million people — one-third of humanity — and killed 50–100 million, far more than the First World War. Unusually, it was most lethal for healthy adults aged 20–40.', fVi:'Đại dịch cúm Tây Ban Nha (1918–1920) lây nhiễm ước tính 500 triệu người — một phần ba nhân loại — và giết chết 50–100 triệu người, nhiều hơn nhiều so với Thế chiến I. Bất thường là nó gây tử vong cao nhất cho người trưởng thành khỏe mạnh từ 20–40 tuổi.'},
  {c:'History',  e:'📜',  f:'The Viking settlement at L\'Anse aux Meadows in Newfoundland (~1000 AD) is the only confirmed Norse site in North America and predates Columbus\'s 1492 voyage to the Americas by approximately 500 years.', fVi:'Khu định cư Viking tại L\'Anse aux Meadows ở Newfoundland (~1000 SCN) là địa điểm Norse duy nhất được xác nhận ở Bắc Mỹ và đến trước chuyến đi năm 1492 của Columbus đến châu Mỹ khoảng 500 năm.'},
  {c:'History',  e:'📜',  f:'The Rosetta Stone (196 BC), discovered by Napoleon\'s soldiers in 1799, carries the same decree in three scripts: Ancient Egyptian hieroglyphics, Demotic script, and Greek — enabling Jean-François Champollion to decipher hieroglyphics in 1822.', fVi:'Đá Rosetta (196 TCN), được phát hiện bởi quân lính của Napoleon năm 1799, mang cùng một sắc lệnh bằng ba chữ: chữ tượng hình Ai Cập cổ, chữ thông thường (Demotic) và tiếng Hy Lạp — cho phép Jean-François Champollion giải mã chữ tượng hình năm 1822.'},
  {c:'History',  e:'📜',  f:'The Wright Brothers\' first powered flight on December 17, 1903, lasted 12 seconds and covered 37 metres — shorter than the wingspan of a Boeing 747. By the end of the same day they achieved a flight of 59 seconds and 260 metres.', fVi:'Chuyến bay có động cơ đầu tiên của anh em nhà Wright vào ngày 17 tháng 12 năm 1903, kéo dài 12 giây và bay được 37 mét — ngắn hơn sải cánh của máy bay Boeing 747. Vào cuối ngày hôm đó, họ đạt được chuyến bay 59 giây và 260 mét.'},
  {c:'History',  e:'📜',  f:'The Library of Alexandria was not destroyed in a single dramatic event. It declined gradually over centuries through a series of partial destructions, budget cuts, and neglect, with fire during Caesar\'s siege (48 BC) being only one episode.', fVi:'Thư viện Alexandria không bị phá hủy trong một sự kiện kịch tính duy nhất. Nó suy tàn dần qua nhiều thế kỷ qua một loạt các vụ phá hủy một phần, cắt giảm ngân sách và bị bỏ bê, với đám cháy trong cuộc bao vây của Caesar (48 TCN) chỉ là một trong nhiều sự kiện.'},
  {c:'History',  e:'📜',  f:'The Silk Road was not a single road but a vast network of trade routes stretching ~6,400 km from Han Dynasty China to the Roman Mediterranean, active from ~130 BC. It transmitted not just silk but spices, ideas, religions, and diseases.', fVi:'Con đường Tơ lụa không phải là một con đường duy nhất mà là một mạng lưới rộng lớn các tuyến đường thương mại trải dài ~6.400 km từ Trung Quốc thời nhà Hán đến Địa Trung Hải La Mã, hoạt động từ ~130 TCN. Nó truyền tải không chỉ tơ lụa mà còn cả gia vị, ý tưởng, tôn giáo và dịch bệnh.'},
  {c:'History',  e:'📜',  f:"The Great Wall of China is not visible from the Moon or from low Earth orbit with the naked eye. At 5–8 metres wide, it is far too narrow. This myth was popularised in the 19th century long before anyone actually went to space.", fVi:'Vạn Lý Trường Thành không thể nhìn thấy từ Mặt Trăng hay từ quỹ đạo Trái Đất thấp bằng mắt thường. Rộng 5–8 mét, nó quá hẹp. Huyền thoại này đã được phổ biến vào thế kỷ 19 trước khi bất kỳ ai thực sự lên vũ trụ.'},
  {c:'History',  e:'📜',  f:'The Thirty Years\' War (1618–1648) was so catastrophic that some German territories lost a third to half of their total population to war, famine, and plague. It fundamentally reshaped European borders and established the modern concept of state sovereignty.', fVi:'Chiến tranh Ba Mươi Năm (1618–1648) thảm khốc đến mức một số lãnh thổ Đức mất từ một phần ba đến một nửa tổng dân số do chiến tranh, nạn đói và dịch bệnh. Nó đã định hình lại căn bản các biên giới châu Âu và thiết lập khái niệm hiện đại về chủ quyền quốc gia.'},
  {c:'History',  e:'📜',  f:'The Antikythera mechanism (~100 BC) is an ancient Greek analogue computer that accurately predicted solar and lunar eclipses, planetary positions, and the four-year Olympic cycle — roughly 1,500 years ahead of comparable European technology.', fVi:'Cơ chế Antikythera (~100 TCN) là một máy tính tương tự của người Hy Lạp cổ đại dự đoán chính xác nhật thực và nguyệt thực, vị trí hành tinh và chu kỳ Thế vận hội bốn năm — vượt trước công nghệ châu Âu tương đương khoảng 1.500 năm.'},
  {c:'History',  e:'📜',  f:'Alexander the Great conquered a territory stretching from Greece to northwestern India by age 30, without losing a single pitched battle. His empire — the largest the world had seen — fragmented within a decade of his death in 323 BC.', fVi:'Alexander Đại đế đã chinh phục lãnh thổ trải từ Hy Lạp đến tây bắc Ấn Độ trước năm 30 tuổi, mà không thua một trận giáo chiến nào. Đế chế của ông — lớn nhất thế giới từng thấy — tan rã trong vòng một thập kỷ sau cái chết của ông năm 323 TCN.'},
  {c:'History',  e:'📜',  f:'The Atlantic slave trade forcibly transported an estimated 12.5 million Africans to the Americas between ~1500 and 1900. Approximately 1.8 million died during the Middle Passage — the journey across the Atlantic.', fVi:'Buôn bán nô lệ xuyên Đại Tây Dương đã vận chuyển cưỡng bức ước tính 12,5 triệu người châu Phi đến châu Mỹ giữa ~1500 và 1900. Khoảng 1,8 triệu người đã chết trong hành trình Trung Đoạn — chuyến vượt Đại Tây Dương.'},
  {c:'History',  e:'📜',  f:'Julius Caesar was almost certainly not born by Caesarean section. The term likely derives from the Latin "caedere" (to cut). His mother Aurelia lived long after his birth, which would have been virtually impossible given the surgery\'s mortality in that era.', fVi:'Julius Caesar gần như chắc chắn không được sinh ra qua phẫu thuật Caesarean. Thuật ngữ này có thể xuất phát từ tiếng Latin \'caedere\' (để cắt). Mẹ của ông, Aurelia, sống lâu sau khi ông sinh ra, điều này hầu như không thể xảy ra do tỷ lệ tử vong của phẫu thuật trong thời đó.'},
  {c:'History',  e:'📜',  f:'The first photograph — "View from the Window at Le Gras" by Nicéphore Niépce (1826) — required an exposure time of approximately 8 hours. The earliest surviving photographic portrait dates to 1839.', fVi:'Bức ảnh đầu tiên — \'View from the Window at Le Gras\' của Nicéphore Niépce (1826) — đòi hỏi thời gian phơi sáng khoảng 8 giờ. Bức ảnh chân dung sớm nhất còn tồn tại có từ năm 1839.'},
  {c:'History',  e:'📜',  f:'The Haitian Revolution (1791–1804) was the only successful large-scale slave uprising in history, resulting in Haiti becoming the first free Black republic — and the first nation in the Western Hemisphere to abolish slavery permanently.', fVi:'Cách mạng Haiti (1791–1804) là cuộc nổi dậy nô lệ quy mô lớn thành công duy nhất trong lịch sử, dẫn đến việc Haiti trở thành nước cộng hòa tự do người da đen đầu tiên — và quốc gia đầu tiên ở Tây Bán Cầu xóa bỏ chế độ nô lệ vĩnh viễn.'},
  {c:'History',  e:'📜',  f:'The Code of Hammurabi (~1754 BC), inscribed on a 2.25m basalt stele, is one of the earliest complete written legal codes. It established proportional justice ("an eye for an eye"), but also included consumer protection laws and minimum wages.', fVi:'Bộ luật Hammurabi (~1754 TCN), được khắc trên một tấm đá cẩm thạch đen cao 2,25m, là một trong những bộ luật thành văn hoàn chỉnh sớm nhất. Nó thiết lập công lý tương xứng (mắt đổi mắt), nhưng cũng bao gồm luật bảo vệ người tiêu dùng và mức lương tối thiểu.'},
  {c:'History',  e:'📜',  f:'The Meiji Restoration (1868) transformed Japan from a feudal, isolationist society into an industrialised nation within a single generation — culminating in Japan\'s defeat of Russia in the Russo-Japanese War of 1905, the first time a non-European power defeated a European great power in a major war.', fVi:'Cải cách Minh Trị (1868) đã biến Nhật Bản từ một xã hội phong kiến, biệt lập thành một quốc gia công nghiệp hóa trong một thế hệ — đỉnh điểm là Nhật Bản đánh bại Nga trong Chiến tranh Nga-Nhật 1905, lần đầu tiên một cường quốc phi châu Âu đánh bại một cường quốc châu Âu trong một cuộc chiến lớn.'},
  {c:'History',  e:'📜',  f:'Ancient Rome\'s Colosseum (completed 80 AD) could hold 50,000–80,000 spectators, featured a retractable canvas awning (the velarium), and had underground tunnels for animals and gladiators beneath a wooden arena floor that could be flooded for mock naval battles.', fVi:'Đấu trường La Mã (hoàn thành năm 80 SCN) có thể chứa 50.000–80.000 khán giả, có mái che bằng vải có thể thu vào, và có các đường hầm ngầm cho động vật và đấu sĩ bên dưới sàn đấu trường bằng gỗ có thể được ngập nước để tái hiện các trận hải chiến.'},
  {c:'History',  e:'📜',  f:'The Treaty of Westphalia (1648) established the foundational principle of modern international relations: state sovereignty — the idea that nations have the right to govern their internal affairs without external interference.', fVi:'Hiệp ước Westphalia (1648) đã thiết lập nguyên tắc nền tảng của quan hệ quốc tế hiện đại: chủ quyền quốc gia — ý tưởng rằng các quốc gia có quyền điều hành các công việc nội bộ của mình mà không có sự can thiệp từ bên ngoài.'},
  {c:'History',  e:'📜',  f:'The Hundred Years\' War between England and France actually lasted 116 years (1337–1453). It was not one continuous conflict but a series of wars, largely over the English crown\'s claim to the French throne.', fVi:'Chiến tranh Trăm Năm giữa Anh và Pháp thực ra kéo dài 116 năm (1337–1453). Đó không phải là một cuộc xung đột liên tục duy nhất mà là một loạt các cuộc chiến, phần lớn liên quan đến yêu cầu của vương miện Anh đối với ngai vàng Pháp.'},
  {c:'History',  e:'📜',  f:'The Spanish Armada (1588), sent by Philip II of Spain to invade England, was defeated not primarily by English naval forces but by a severe storm in the North Atlantic that scattered and wrecked much of the fleet.', fVi:'Hạm đội Tây Ban Nha (1588), được Vua Philip II gửi để xâm chiếm nước Anh, thất bại không phải chủ yếu do lực lượng hải quân Anh mà do một cơn bão dữ dội ở Bắc Đại Tây Dương đã phân tán và đắm phần lớn hạm đội.'},
  {c:'History',  e:'📜',  f:'Marie Curie is the only person ever to win Nobel Prizes in two different scientific disciplines: Physics (1903, for discovering radioactivity, shared with Pierre Curie and Henri Becquerel) and Chemistry (1911, for isolating radium and polonium).', fVi:'Marie Curie là người duy nhất từng giành được Giải Nobel trong hai lĩnh vực khoa học khác nhau: Vật lý (1903, vì đã khám phá ra phóng xạ) và Hóa học (1911, vì đã phân lập radium và polonium).'},

  // ── GEOGRAPHY ────────────────────────────────────────────────────────────
  {c:'Geography',e:'🌍',  f:'Russia spans 11 time zones and covers ~17.1 million km² — about 11% of Earth\'s total land area. It shares land borders with 14 countries, more than any other country.', fVi:'Nga trải dài 11 múi giờ và bao phủ ~17,1 triệu km² — khoảng 11% tổng diện tích đất liền của Trái Đất. Nó có biên giới đất liền với 14 quốc gia, nhiều hơn bất kỳ quốc gia nào khác.'},
  {c:'Geography',e:'🌍',  f:"Canada has the world's longest coastline at ~202,080 km — more than 6× the circumference of Earth at the equator. It also has more lakes than the rest of the world combined, holding about 20% of the world's fresh surface water.", fVi:'Canada có đường bờ biển dài nhất thế giới với ~202.080 km — hơn 6 lần chu vi Trái Đất tại đường xích đạo. Nó cũng có nhiều hồ hơn phần còn lại của thế giới cộng lại, chứa khoảng 20% nước mặt ngọt của thế giới.'},
  {c:'Geography',e:'🌍',  f:"The Amazon River discharges about 20% of all fresh water entering the world's oceans. During the wet season its mouth is ~50 km wide. It contains more fresh water than the next seven largest rivers combined.", fVi:'Sông Amazon thoát ra khoảng 20% tổng lượng nước ngọt đổ vào các đại dương của thế giới. Trong mùa mưa, cửa sông rộng ~50 km. Nó chứa nhiều nước ngọt hơn bảy con sông lớn tiếp theo cộng lại.'},
  {c:'Geography',e:'🌍',  f:"Lake Baikal in Siberia holds approximately 23% of Earth's unfrozen surface fresh water — more than all five North American Great Lakes combined. At 1,642 metres, it is also the world's deepest lake and oldest (~25 million years).", fVi:'Hồ Baikal ở Siberia chứa khoảng 23% tổng lượng nước ngọt bề mặt chưa đóng băng của Trái Đất — nhiều hơn cả năm Hồ Lớn Bắc Mỹ cộng lại. Ở độ sâu 1.642 mét, đây cũng là hồ sâu nhất và lâu đời nhất thế giới (~25 triệu năm).'},
  {c:'Geography',e:'🌍',  f:"The Mariana Trench's Challenger Deep reaches approximately 10,935 metres — about 2 km deeper than Mount Everest is tall. The pressure at this depth is about 1,086 times atmospheric pressure.", fVi:'Vực thẳm Challenger Deep trong Rãnh Mariana đạt khoảng 10.935 mét — sâu hơn khoảng 2 km so với chiều cao của Everest. Áp suất ở độ sâu này khoảng 1.086 lần áp suất khí quyển.'},
  {c:'Geography',e:'🌍',  f:'Antarctica holds about 70% of Earth\'s fresh water as ice. If all Antarctic ice melted, global sea levels would rise approximately 58–60 metres, submerging most coastal cities worldwide.', fVi:'Nam Cực giữ khoảng 70% nước ngọt của Trái Đất dưới dạng băng. Nếu toàn bộ băng Nam Cực tan chảy, mực nước biển toàn cầu sẽ dâng khoảng 58–60 mét, nhấn chìm hầu hết các thành phố ven biển trên thế giới.'},
  {c:'Geography',e:'🌍',  f:'The Pacific Ocean covers ~165 million km² — more area than all of Earth\'s land surfaces combined. It contains more than half of all water on Earth\'s surface.', fVi:'Thái Bình Dương bao phủ ~165 triệu km² — diện tích lớn hơn tất cả diện tích đất liền của Trái Đất cộng lại. Nó chứa hơn một nửa tổng lượng nước trên bề mặt Trái Đất.'},
  {c:'Geography',e:'🌍',  f:'The Dead Sea surface sits at ~430 m below sea level (the lowest exposed land surface on Earth). Its salinity of ~34% (10× the ocean) prevents virtually all life except extremophile bacteria.', fVi:'Bề mặt Biển Chết ở mức ~430 m dưới mực nước biển — bề mặt đất lộ thiên thấp nhất trên Trái Đất. Độ mặn ~34% (10 lần đại dương) ngăn cản gần như mọi sinh vật ngoại trừ vi khuẩn ưa cực.'},
  {c:'Geography',e:'🌍',  f:'The Sahara Desert (~9.2 million km²) is roughly the size of the contiguous United States. However, only about 25% of the Sahara is covered in sand dunes (ergs) — most is rocky plateau (hamada) or gravel plains (regs).', fVi:'Sa mạc Sahara (~9,2 triệu km²) có diện tích xấp xỉ bằng các tiểu bang liên tục của Hoa Kỳ. Tuy nhiên, chỉ khoảng 25% sa mạc Sahara là cồn cát — phần lớn là cao nguyên đá hoặc đồng bằng sỏi.'},
  {c:'Geography',e:'🌍',  f:'Iceland sits directly on the Mid-Atlantic Ridge, where the North American and Eurasian tectonic plates are diverging at ~2.5 cm/year. The island is growing — you can walk across the boundary of two plates in Þingvellir National Park.', fVi:'Iceland nằm trực tiếp trên Sống núi Đại Tây Dương Giữa, nơi các mảng kiến tạo Bắc Mỹ và Á-Âu đang phân kỳ ở ~2,5 cm/năm. Hòn đảo đang phát triển — bạn có thể đi bộ qua ranh giới của hai mảng ở Vườn quốc gia Þingvellir.'},
  {c:'Geography',e:'🌍',  f:'Mount Chimborazo in Ecuador (6,263 m above sea level) is the farthest point from Earth\'s centre — farther than Everest — because the planet bulges at the equator, adding ~21 km to the equatorial radius compared to the poles.', fVi:'Núi Chimborazo ở Ecuador (6.263 m so với mực nước biển) là điểm xa nhất tính từ tâm Trái Đất — xa hơn Everest — vì hành tinh phình ra ở xích đạo, thêm ~21 km vào bán kính xích đạo so với cực.'},
  {c:'Geography',e:'🌍',  f:'The Congo River is the world\'s deepest river (over 220 m in some sections) and second only to the Amazon in discharge volume. The Congo Basin is the world\'s second-largest tropical rainforest after the Amazon.', fVi:'Sông Congo là con sông sâu nhất thế giới (hơn 220 m ở một số đoạn) và chỉ đứng sau Amazon về lưu lượng. Lưu vực Congo là rừng mưa nhiệt đới lớn thứ hai thế giới sau Amazon.'},
  {c:'Geography',e:'🌍',  f:'Vatican City (0.44 km²) is the world\'s smallest sovereign state — smaller than most golf courses. Despite its size, it has its own postal service, radio station, railway, and issues its own euro coins (which are collectors\' items).', fVi:'Vatican (0,44 km²) là nhà nước có chủ quyền nhỏ nhất thế giới — nhỏ hơn hầu hết các sân golf. Bất chấp kích thước, nó có dịch vụ bưu chính, đài phát thanh, đường sắt riêng và phát hành đồng euro riêng.'},
  {c:'Geography',e:'🌍',  f:'Indonesia consists of over 17,000 islands, spans the equivalent distance of London to Tehran, and straddles the equator across four time zones. It is home to about 4% of all known plant and animal species.', fVi:'Indonesia bao gồm hơn 17.000 đảo, trải dài khoảng cách tương đương từ London đến Tehran, và bắc qua đường xích đạo qua bốn múi giờ. Nó là nơi sinh sống của khoảng 4% tất cả các loài thực vật và động vật đã biết.'},
  {c:'Geography',e:'🌍',  f:'The Atacama Desert in northern Chile receives less than 1 mm of rainfall per year in some areas — the driest non-polar desert on Earth. Some weather stations have never recorded any rain at all. Its soil chemistry is so similar to Mars that NASA tests equipment there.', fVi:'Sa mạc Atacama ở bắc Chile nhận ít hơn 1 mm lượng mưa mỗi năm ở một số khu vực — sa mạc không có cực khô nhất Trái Đất. Một số trạm thời tiết chưa bao giờ ghi nhận bất kỳ lượng mưa nào. Hóa học đất của nó rất giống Sao Hỏa đến mức NASA thử nghiệm thiết bị ở đó.'},
  {c:'Geography',e:'🌍',  f:'New Zealand was the last substantial landmass on Earth to be settled by humans. Polynesian ancestors (Māori) arrived around 1250–1300 AD — meaning the entire human history of New Zealand fits within the last ~750 years.', fVi:'New Zealand là vùng đất rộng lớn cuối cùng trên Trái Đất được con người định cư. Tổ tiên người Polynesia (Māori) đến khoảng năm 1250–1300 SCN — có nghĩa là toàn bộ lịch sử của con người ở New Zealand chỉ gói gọn trong ~750 năm qua.'},
  {c:'Geography',e:'🌍',  f:'The Caspian Sea is technically the world\'s largest lake by both area (~371,000 km²) and volume. It is called a "sea" because of its saltiness (~1.2%) and because it was connected to the world ocean ~5.5 million years ago.', fVi:'Biển Caspian về mặt kỹ thuật là hồ lớn nhất thế giới theo cả diện tích (~371.000 km²) và thể tích. Nó được gọi là biển vì độ mặn (~1,2%) và vì nó đã được kết nối với đại dương thế giới ~5,5 triệu năm trước.'},
  {c:'Geography',e:'🌍',  f:'Bolivia maintains a navy despite being landlocked since the War of the Pacific (1879), when it lost its coastline to Chile. Its navy patrols Lake Titicaca and river borders, and Bolivia still legally claims a right to coastal access.', fVi:'Bolivia duy trì một hải quân mặc dù bị không giáp biển từ Chiến tranh Thái Bình Dương (1879), khi mất đường bờ biển vào tay Chile. Hải quân của nó tuần tra Hồ Titicaca và biên giới sông, và Bolivia vẫn yêu cầu quyền tiếp cận biển hợp pháp.'},
  {c:'Geography',e:'🌍',  f:'Africa is the only continent to span all four hemispheres (North, South, East, and West). It is also the most centrally located continent, bisected by both the equator and the prime meridian.', fVi:'Châu Phi là lục địa duy nhất trải dài qua cả bốn bán cầu (Bắc, Nam, Đông và Tây). Đây cũng là lục địa nằm ở vị trí trung tâm nhất, bị chia cắt bởi cả đường xích đạo và kinh tuyến gốc.'},
  {c:'Geography',e:'🌍',  f:'The Himalayas are geologically young (~50 million years old) and still rising at about 5 mm per year as the Indian Plate continues to collide with the Eurasian Plate. Mount Everest grows ~4 mm taller per year through tectonic uplift.', fVi:'Dãy Himalaya về mặt địa chất còn khá trẻ (~50 triệu năm tuổi) và vẫn đang cao lên khoảng 5 mm mỗi năm khi mảng Ấn Độ tiếp tục va chạm với mảng Á-Âu. Đỉnh Everest cao thêm ~4 mm mỗi năm do nâng kiến tạo.'},
  {c:'Geography',e:'🌍',  f:"The Great Rift Valley runs ~6,000 km from Ethiopia's Afar Triangle south to Mozambique. East Africa is slowly splitting apart at ~5 mm/year. In ~10 million years, a new ocean is expected to form, separating the Horn of Africa from the rest of the continent.", fVi:'Thung lũng Rift Lớn trải dài ~6.000 km từ Tam giác Afar của Ethiopia về phía nam đến Mozambique. Đông Phi đang dần tách ra ở ~5 mm/năm. Trong ~10 triệu năm, một đại dương mới dự kiến sẽ hình thành, tách Sừng châu Phi ra khỏi phần còn lại của lục địa.'},
  {c:'Geography',e:'🌍',  f:"Greenland (2.17 million km²) is the world's largest island. Despite its name, about 80% of it is covered in ice. Iceland, despite its name, is only ~11% glaciated and has a surprisingly temperate climate moderated by the Gulf Stream.", fVi:'Greenland (2,17 triệu km²) là đảo lớn nhất thế giới. Bất chấp tên gọi, khoảng 80% diện tích phủ băng. Iceland, bất chấp tên gọi, chỉ ~11% là sông băng và có khí hậu ôn đới đáng ngạc nhiên được điều hòa bởi Dòng chảy Vịnh.'},
  {c:'Geography',e:'🌍',  f:'The Strait of Malacca between Malaysia/Singapore and Indonesia is one of the most strategically critical waterways on Earth — about 25% of global maritime trade passes through it, including roughly one-third of the world\'s seaborne oil.', fVi:'Eo biển Malacca giữa Malaysia/Singapore và Indonesia là một trong những tuyến đường thủy chiến lược quan trọng nhất Trái Đất — khoảng 25% thương mại hàng hải toàn cầu đi qua đó, bao gồm khoảng một phần ba dầu mỏ vận chuyển bằng đường biển của thế giới.'},
  {c:'Geography',e:'🌍',  f:"Norway's Svalbard archipelago hosts the Global Seed Vault, built into permafrost 130 m inside a mountain on Spitsbergen island. It preserves over 1.3 million seed samples from virtually every nation on Earth as a backup against global agricultural catastrophe.", fVi:'Kho Hạt Svalbard của Na Uy xây dựng trong lớp đất đóng băng 130 m bên trong một ngọn núi trên đảo Spitsbergen, bảo tồn hơn 1,3 triệu mẫu hạt giống từ gần như mọi quốc gia trên Trái Đất như là bản sao lưu chống lại thảm họa nông nghiệp toàn cầu.'},
  {c:'Geography',e:'🌍',  f:"The Indian Ocean is the world's warmest ocean and the only one with seasonally reversing surface currents (driven by the monsoon). It hosts the world's busiest sea lanes and contains about 20% of the world's total ocean water.", fVi:'Ấn Độ Dương là đại dương ấm nhất thế giới và là đại dương duy nhất có dòng chảy bề mặt đảo chiều theo mùa (do gió mùa). Nó là nơi có các tuyến đường biển nhộn nhịp nhất thế giới và chứa khoảng 20% tổng lượng nước đại dương của thế giới.'},
  {c:'Geography',e:'🌍',  f:'The Channel Tunnel (Eurotunnel) between England and France is 50.45 km long, with 37.9 km of that undersea — the longest undersea rail tunnel in the world. It runs through chalk marl, chosen because it is nearly impermeable to water.', fVi:'Đường hầm Channel (Eurotunnel) giữa Anh và Pháp dài 50,45 km, với 37,9 km dưới biển — đường hầm đường sắt dưới biển dài nhất thế giới. Nó chạy qua đá phấn marl, được chọn vì gần như không thấm nước.'},
  {c:'Geography',e:'🌍',  f:'Australia is simultaneously a country, a continent, and the world\'s largest island (if islands are defined as land masses surrounded entirely by water). Its Great Barrier Reef at ~2,300 km is the largest living structure on Earth, visible from space.', fVi:'Australia đồng thời là một quốc gia, một lục địa và đảo lớn nhất thế giới. Rạn san hô Great Barrier ~2.300 km là cấu trúc sống lớn nhất trên Trái Đất, có thể nhìn thấy từ không gian.'},
  {c:'Geography',e:'🌍',  f:'The Amazon Basin receives so much rainfall (~2,300 mm/year on average) that the forest creates its own weather — the trees release enough water vapour to form "flying rivers" of atmospheric moisture that deliver rain thousands of kilometres away.', fVi:'Lưu vực Amazon nhận lượng mưa rất lớn (~2.300 mm/năm) đến mức khu rừng tự tạo ra thời tiết riêng — các cây thải đủ hơi nước để tạo thành các con sông bay mang mưa đến hàng nghìn km xa.'},
  {c:'Geography',e:'🌍',  f:'Mongolia is the world\'s most sparsely populated sovereign country (excluding city-states and dependencies), with a population density of ~2 people per km². About 30% of Mongolians are nomadic or semi-nomadic.', fVi:'Mông Cổ là quốc gia có chủ quyền thưa dân nhất thế giới (không kể các thành phố-nhà nước), với mật độ dân số ~2 người/km². Khoảng 30% người Mông Cổ là du mục hoặc bán du mục.'},

  // ── FINANCE ──────────────────────────────────────────────────────────────
  {c:'Finance',  e:'💰',  f:"Compound interest: Warren Buffett made more than 97% of his wealth after his 50th birthday. He started investing at age 11, had a net worth of ~$1 million by 30, but the vast majority of his fortune is the product of decades of compounding at above-market rates.", fVi:'Lãi kép: Warren Buffett kiếm được hơn 97% tài sản sau tuổi 50. Ông bắt đầu đầu tư năm 11 tuổi, có tài sản ròng ~1 triệu đô la ở tuổi 30, nhưng phần lớn tài sản của ông là kết quả của nhiều thập kỷ tích lũy ở mức trên thị trường.'},
  {c:'Finance',  e:'💰',  f:'The Rule of 72: divide 72 by your annual return to estimate how many years it takes to double your money. At 6%, it doubles in 12 years. At 12%, in 6 years. At 1% (typical savings account), it takes 72 years.', fVi:'Quy tắc 72: chia 72 cho lợi suất hàng năm của bạn để ước tính mất bao nhiêu năm để tiền tăng gấp đôi. Ở 6%, tiền tăng gấp đôi sau 12 năm. Ở 12%, sau 6 năm. Ở 1% (tài khoản tiết kiệm điển hình), mất 72 năm.'},
  {c:'Finance',  e:'💰',  f:'The S&P 500 has returned approximately 10% per year on average (about 7% after inflation) since 1957, despite the 1987 Black Monday crash, the dot-com bust, the 2008 financial crisis, and the 2020 pandemic crash.', fVi:'Chỉ số S&P 500 đã mang lại lợi nhuận trung bình khoảng 10% mỗi năm (khoảng 7% sau lạm phát) kể từ năm 1957, bất chấp sụp đổ Thứ Hai Đen 1987, bong bóng dot-com, khủng hoảng tài chính 2008 và sụp đổ đại dịch 2020.'},
  {c:'Finance',  e:'💰',  f:"A 1% annual management fee on an investment may seem negligible, but over 30 years at a 7% return, it reduces your final portfolio value by approximately 25%. On a $100,000 investment, that's ~$75,000 lost to fees alone.", fVi:'Phí quản lý 1% hàng năm có vẻ không đáng kể, nhưng sau 30 năm với lợi suất 7%, nó làm giảm giá trị danh mục cuối kỳ khoảng 25%. Với khoản đầu tư 100.000 đô la, đó là ~75.000 đô la mất vào phí.'},
  {c:'Finance',  e:'💰',  f:'The Dutch East India Company (VOC, 1602) is considered the world\'s first publicly traded company and the first to issue bonds and shares to the general public. At its 17th-century peak its inflation-adjusted valuation is estimated at ~$8 trillion.', fVi:'Công ty Đông Ấn Hà Lan (VOC, 1602) được coi là công ty đại chúng đầu tiên trên thế giới và là công ty đầu tiên phát hành trái phiếu và cổ phiếu cho công chúng. Ở đỉnh cao thế kỷ 17, định giá được điều chỉnh theo lạm phát của nó ước tính ~8 nghìn tỷ đô la.'},
  {c:'Finance',  e:'💰',  f:'Loss aversion (Kahneman & Tversky, 1979): humans feel the psychological pain of a financial loss approximately 2× as intensely as the pleasure of an equivalent gain. This leads to irrational decisions like holding losing stocks too long.', fVi:'Tránh thua lỗ (Kahneman & Tversky, 1979): con người cảm thấy đau khổ tâm lý của một khoản thua lỗ tài chính khoảng 2 lần so với niềm vui của một khoản lãi tương đương. Điều này dẫn đến những quyết định phi lý như giữ cổ phiếu thua lỗ quá lâu.'},
  {c:'Finance',  e:'💰',  f:"Index funds — pioneered by John Bogle who launched the first retail index fund at Vanguard in 1976 — consistently beat the majority of actively managed funds over 10–20 year periods. Bogle's insight: minimise costs, don't try to beat the market.", fVi:'Quỹ chỉ số — được tiên phong bởi John Bogle khi ông ra mắt quỹ chỉ số bán lẻ đầu tiên tại Vanguard năm 1976 — liên tục đánh bại hầu hết các quỹ được quản lý tích cực trong khoảng thời gian 10–20 năm. Bài học của Bogle: giảm thiểu chi phí, đừng cố gắng đánh bại thị trường.'},
  {c:'Finance',  e:'💰',  f:'The global derivatives market has a notional value exceeding $600 trillion — roughly 6× the entire world\'s annual GDP. However, the actual economic exposure (net notional) is far smaller, as contracts are frequently netted against each other.', fVi:'Thị trường phái sinh toàn cầu có giá trị danh nghĩa vượt 600 nghìn tỷ đô la — gấp khoảng 6 lần GDP hàng năm của toàn thế giới. Tuy nhiên, mức độ tiếp xúc kinh tế thực tế nhỏ hơn nhiều, vì các hợp đồng thường được bù trừ với nhau.'},
  {c:'Finance',  e:'💰',  f:"Hyperinflation in Zimbabwe peaked at an estimated 89.7 sextillion percent per month (November 2008). The central bank issued a 100 trillion dollar note. Ultimately, Zimbabwe abandoned its currency entirely and adopted the US dollar.", fVi:'Siêu lạm phát ở Zimbabwe đạt đỉnh ước tính 89,7 tỷ tỷ phần trăm mỗi tháng (tháng 11 năm 2008). Ngân hàng trung ương phát hành tờ tiền 100 nghìn tỷ đô la. Cuối cùng, Zimbabwe đã từ bỏ tiền tệ của mình và áp dụng đô la Mỹ.'},
  {c:'Finance',  e:'💰',  f:'Dollar-cost averaging — investing a fixed amount at regular intervals regardless of price — eliminates the need to time the market. Studies consistently show it produces better risk-adjusted returns for most retail investors than attempting to buy at market lows.', fVi:'Đầu tư định kỳ theo mức cố định — đầu tư một lượng cố định theo định kỳ bất kể giá cả — loại bỏ nhu cầu chọn thời điểm thị trường. Các nghiên cứu nhất quán cho thấy nó mang lại lợi nhuận điều chỉnh theo rủi ro tốt hơn cho hầu hết các nhà đầu tư bán lẻ.'},
  {c:'Finance',  e:'💰',  f:"The 4% rule (from the 1994 Trinity Study by Bengen): retirees who withdraw 4% of their initial portfolio annually (adjusted for inflation) have historically had a very high probability of their money lasting 30+ years. It's a guideline, not a guarantee.", fVi:'Quy tắc 4% (từ Nghiên cứu Trinity năm 1994): những người về hưu rút 4% danh mục ban đầu hàng năm (điều chỉnh theo lạm phát) về mặt lịch sử có xác suất rất cao là tiền dùng đủ 30+ năm. Đây là hướng dẫn, không phải đảm bảo.'},
  {c:'Finance',  e:'💰',  f:"Bitcoin's protocol hard-caps total supply at exactly 21 million coins. As of 2024, ~19.7 million have been mined. The last bitcoin is projected to be mined around 2140. After that, miners will be compensated only by transaction fees.", fVi:'Giao thức Bitcoin giới hạn cứng tổng nguồn cung ở đúng 21 triệu đồng. Tính đến năm 2024, ~19,7 triệu đã được đào. Bitcoin cuối cùng dự kiến sẽ được đào vào khoảng năm 2140. Sau đó, những người đào sẽ chỉ được bồi thường bằng phí giao dịch.'},
  {c:'Finance',  e:'💰',  f:'The IMF and World Bank were both established at the Bretton Woods Conference (July 1944, 44 nations) with the explicit goal of preventing the economic nationalism, currency wars, and mass unemployment that contributed to WWII.', fVi:'IMF và Ngân hàng Thế giới đều được thành lập tại Hội nghị Bretton Woods (tháng 7 năm 1944, 44 quốc gia) với mục tiêu rõ ràng là ngăn chặn chủ nghĩa quốc gia kinh tế, chiến tranh tiền tệ và tình trạng thất nghiệp hàng loạt đã góp phần vào Thế chiến II.'},
  {c:'Finance',  e:'💰',  f:'Chinese paper money (jiaozi, 10th century AD) predates European banknotes by ~600 years. The Song Dynasty issued them because copper coins were too heavy to carry for large transactions. Marco Polo described them with amazement in the 13th century.', fVi:'Tiền giấy Trung Quốc (jiaozi, thế kỷ 10 SCN) ra đời trước tờ tiền giấy châu Âu ~600 năm. Triều đại Tống phát hành chúng vì đồng tiền xu quá nặng để mang theo cho các giao dịch lớn. Marco Polo đã mô tả chúng với sự kinh ngạc vào thế kỷ 13.'},
  {c:'Finance',  e:'💰',  f:"Dutch Tulip Mania (1636–1637) is one of history's earliest recorded speculative bubbles. At its peak, a single Semper Augustus tulip bulb sold for ~10 guilders — equivalent to roughly 10× the annual wage of a skilled craftsman — before the market collapsed within weeks.", fVi:'Cơn điên hoa tulip Hà Lan (1636–1637) là một trong những bong bóng đầu cơ được ghi chép sớm nhất trong lịch sử. Ở đỉnh cao, một củ hoa tulip Semper Augustus duy nhất được bán với giá ~10 guilder — tương đương khoảng 10 lần tiền lương hàng năm của một thợ thủ công lành nghề — trước khi thị trường sụp đổ trong vài tuần.'},
  {c:'Finance',  e:'💰',  f:'The Pareto principle (80/20 rule), observed by Vilfredo Pareto in 1906 when he noted 80% of Italy\'s land was owned by 20% of the population, appears across economics, business, and productivity: roughly 80% of effects come from 20% of causes.', fVi:'Nguyên tắc Pareto (quy tắc 80/20), được Vilfredo Pareto quan sát năm 1906, xuất hiện trong kinh tế, kinh doanh và năng suất: khoảng 80% kết quả đến từ 20% nguyên nhân.'},
  {c:'Finance',  e:'💰',  f:'Short selling — borrowing shares to sell them, hoping to buy them back cheaper later — carries theoretically unlimited risk: a stock can only fall to zero (capped profit) but can rise without limit (uncapped loss). The GameStop short squeeze of 2021 cost short sellers ~$6 billion in a week.', fVi:'Bán khống — vay cổ phiếu để bán, hy vọng mua lại rẻ hơn sau — có rủi ro lý thuyết vô hạn: cổ phiếu chỉ có thể giảm xuống không (lợi nhuận có giới hạn) nhưng có thể tăng vô hạn (thua lỗ không giới hạn). Vụ siết vắt bán khống GameStop năm 2021 khiến những người bán khống thiệt hại ~6 tỷ đô la trong một tuần.'},
  {c:'Finance',  e:'💰',  f:"The FDIC (created 1933, after nearly 9,000 US banks failed during the Great Depression) insures bank deposits up to $250,000 per depositor. Since the FDIC's creation, no depositor has lost a single cent of insured funds.", fVi:'FDIC (thành lập năm 1933, sau khi gần 9.000 ngân hàng Mỹ phá sản trong Đại Suy Thoái) bảo hiểm tiền gửi ngân hàng lên đến 250.000 đô la mỗi người gửi. Kể từ khi FDIC thành lập, không có người gửi nào mất một xu nào trong số tiền được bảo hiểm.'},
  {c:'Finance',  e:'💰',  f:"Inflation erodes purchasing power silently. $100 in 1924 had the same buying power as approximately $1,750 in 2024 — meaning over 100 years, 94% of the dollar's purchasing power was destroyed by a seemingly modest average inflation rate of ~3% per year.", fVi:'Lạm phát âm thầm làm xói mòn sức mua. 100 đô la năm 1924 có sức mua tương đương với khoảng 1.750 đô la năm 2024 — nghĩa là qua 100 năm, 94% sức mua của đô la đã bị phá hủy bởi tỷ lệ lạm phát trung bình ~3% mỗi năm.'},
  {c:'Finance',  e:'💰',  f:"Compounding is asymmetric in losses. Losing 50% requires a 100% gain to recover. A portfolio that drops −10%, −20%, −30% sequentially doesn't need +10%, +20%, +30% to recover — it needs +10%, +25%, and +43% respectively.", fVi:'Tổng hợp bất đối xứng trong tổn thất. Mất 50% cần tăng 100% để phục hồi. Một danh mục giảm −10%, −20%, −30% liên tiếp không cần +10%, +20%, +30% để phục hồi — nó cần +10%, +25% và +43% tương ứng.'},
  {c:'Finance',  e:'💰',  f:'Sovereign wealth funds manage over $11 trillion in assets globally. Norway\'s Government Pension Fund Global (~$1.7 trillion) — funded by North Sea oil revenues — is the largest and owns stakes in over 9,000 companies across 70+ countries.', fVi:'Các quỹ tài sản quốc gia quản lý hơn 11 nghìn tỷ đô la tài sản toàn cầu. Quỹ Hưu trí Chính phủ Toàn cầu của Na Uy (~1,7 nghìn tỷ đô la) — được tài trợ bởi doanh thu dầu Biển Bắc — là lớn nhất và sở hữu cổ phần trong hơn 9.000 công ty ở 70+ quốc gia.'},
  {c:'Finance',  e:'💰',  f:'The stock market is not the economy. GDP measures current economic activity; stock prices reflect expectations of future corporate earnings. Markets often start rising during recessions (pricing in recovery) and falling during booms (pricing in slowdown).', fVi:'Thị trường chứng khoán không phải là nền kinh tế. GDP đo lường hoạt động kinh tế hiện tại; giá cổ phiếu phản ánh kỳ vọng về lợi nhuận doanh nghiệp tương lai. Thị trường thường bắt đầu tăng trong thời kỳ suy thoái (dự đoán phục hồi) và giảm trong thời kỳ bùng nổ (dự đoán suy giảm).'},
  {c:'Finance',  e:'💰',  f:"Net worth = total assets − total liabilities. The median US household net worth is ~$192,700 (2022), but the mean is ~$1.06 million — the vast difference illustrates that wealth is heavily concentrated at the top, skewing the average far above most people's actual situation.", fVi:'Tài sản ròng = tổng tài sản − tổng nợ phải trả. Tài sản ròng trung vị của hộ gia đình Mỹ là ~192.700 đô la (2022), nhưng giá trị trung bình là ~1,06 triệu đô la — sự chênh lệch lớn minh họa rằng của cải tập trung nhiều ở đầu, khiến mức trung bình cao hơn nhiều so với tình trạng thực tế của hầu hết mọi người.'},
  {c:'Finance',  e:'💰',  f:"The 2008 Global Financial Crisis was triggered by the collapse of the US subprime mortgage market and the complex securities (CDOs, MBS) built on it. Global stock markets lost ~$10 trillion in value in 18 months. The US government's bailout of financial institutions exceeded $700 billion.", fVi:'Khủng hoảng Tài chính Toàn cầu 2008 được kích hoạt bởi sự sụp đổ của thị trường thế chấp thứ cấp Mỹ và các chứng khoán phức tạp (CDO, MBS) xây dựng trên đó. Thị trường chứng khoán toàn cầu mất ~10 nghìn tỷ đô la giá trị trong 18 tháng. Gói cứu trợ của chính phủ Mỹ vượt 700 tỷ đô la.'},
  {c:'Finance',  e:'💰',  f:"Diversification is famously the only 'free lunch' in investing: combining assets whose returns are not perfectly correlated reduces a portfolio's overall risk without necessarily reducing its expected return. This is the core insight of Harry Markowitz's 1952 Modern Portfolio Theory.", fVi:'Đa dạng hóa nổi tiếng là bữa ăn miễn phí duy nhất trong đầu tư: kết hợp các tài sản có lợi nhuận không tương quan hoàn toàn giúp giảm rủi ro tổng thể của danh mục mà không nhất thiết giảm lợi nhuận kỳ vọng. Đây là cái nhìn sâu sắc cốt lõi của Lý thuyết Danh mục Hiện đại của Harry Markowitz năm 1952.'},
  {c:'Finance',  e:'💰',  f:"GDP (Gross Domestic Product) measures the total value of goods and services produced in a country in a year. It has significant limitations: it counts pollution clean-up as positive activity, doesn't measure inequality, and ignores unpaid work like child-rearing and volunteering.", fVi:'GDP (Tổng sản phẩm quốc nội) đo tổng giá trị hàng hóa và dịch vụ được sản xuất trong một quốc gia trong một năm. Nó có những hạn chế đáng kể: nó tính việc dọn dẹp ô nhiễm là hoạt động tích cực, không đo bất bình đẳng và bỏ qua công việc không được trả lương như chăm sóc trẻ em và tình nguyện.'},
  {c:'Finance',  e:'💰',  f:"The efficient market hypothesis (EMH, Eugene Fama, 1970) argues that asset prices fully reflect all available information, making consistent outperformance theoretically impossible. Yet about 2–3% of fund managers reliably beat the market over a 20-year career — debated endlessly.", fVi:'Lý thuyết thị trường hiệu quả (EMH, Eugene Fama, 1970) lập luận rằng giá tài sản phản ánh đầy đủ tất cả thông tin hiện có, khiến cho việc vượt trội liên tục là không thể về mặt lý thuyết. Tuy nhiên, khoảng 2–3% các nhà quản lý quỹ đáng tin cậy đánh bại thị trường trong 20 năm — được tranh luận bất tận.'},
  {c:'Finance',  e:'💰',  f:"Michael Burry, featured in 'The Big Short,' purchased credit default swaps on subprime mortgage bonds in 2005 when almost no one believed they would fail. His fund, Scion Capital, returned ~489% (net of fees) in 2007 while the S&P 500 fell ~37%.", fVi:'Michael Burry, được giới thiệu trong \'The Big Short\', đã mua hoán đổi rủi ro tín dụng trên trái phiếu thế chấp thứ cấp năm 2005 khi gần như không ai tin rằng chúng sẽ thất bại. Quỹ của ông, Scion Capital, mang lại ~489% lợi nhuận (sau phí) năm 2007 trong khi S&P 500 giảm ~37%.'},
  {c:'Finance',  e:'💰',  f:"Time in the market beats timing the market. A study by Putnam Investments found that missing just the 10 best days in the S&P 500 between 2003 and 2022 would have reduced a $10,000 investment's growth from ~$64,844 to ~$29,708 — less than half.", fVi:'Thời gian trong thị trường đánh bại việc chọn thời điểm thị trường. Một nghiên cứu của Putnam Investments cho thấy bỏ lỡ chỉ 10 ngày tốt nhất trong S&P 500 giữa 2003 và 2022 sẽ làm giảm tăng trưởng của khoản đầu tư 10.000 đô la từ ~64.844 đô la xuống còn ~29.708 đô la — chưa đến một nửa.'},

  // ── NOTABLE PEOPLE ───────────────────────────────────────────────────────
  {c:'Notable People',e:'🧑‍🎓', f:'Nikola Tesla held ~300 patents and in the 1890s predicted wireless global communication and free energy transmission — essentially envisioning the internet and Wi-Fi. He died alone and nearly penniless in a New York hotel room in 1943.', fVi:'Nikola Tesla nắm giữ ~300 bằng sáng chế và vào những năm 1890 đã dự đoán truyền thông không dây toàn cầu và truyền tải năng lượng miễn phí — về cơ bản là hình dung ra internet và Wi-Fi. Ông qua đời một mình và gần như khánh kiệt trong một phòng khách sạn ở New York năm 1943.'},
  {c:'Notable People',e:'🧑‍🎓', f:'Ada Lovelace (1815–1852) wrote the first algorithm designed for a computing machine — for Babbage\'s Analytical Engine, which was never built in her lifetime. She is considered the world\'s first computer programmer, over 100 years before the first electronic computer.', fVi:'Ada Lovelace (1815–1852) đã viết thuật toán đầu tiên được thiết kế cho một máy tính — cho Máy Phân tích của Babbage, chưa bao giờ được chế tạo trong cuộc đời bà. Bà được coi là lập trình viên máy tính đầu tiên trên thế giới, hơn 100 năm trước khi máy tính điện tử đầu tiên ra đời.'},
  {c:'Notable People',e:'🧑‍🎓', f:"Isaac Newton spent more time writing about alchemy and biblical prophecy than about physics. His unpublished theological manuscripts run to millions of words. He genuinely believed he was selected by God to decode the hidden meaning of Scripture.", fVi:'Isaac Newton dành nhiều thời gian hơn để viết về giả kim thuật và lời tiên tri Kinh thánh so với vật lý. Các bản thảo thần học chưa được xuất bản của ông lên đến hàng triệu từ. Ông thực sự tin rằng Chúa đã chọn ông để giải mã ý nghĩa ẩn của Kinh thánh.'},
  {c:'Notable People',e:'🧑‍🎓', f:'Marie Curie coined the term "radioactivity," discovered polonium (named after her homeland Poland) and radium, and was the first person ever to win two Nobel Prizes — and in two different sciences. She carried radioactive samples in her pockets and kept them in her desk drawer.', fVi:'Marie Curie đặt ra thuật ngữ \'phóng xạ\', khám phá ra polonium (đặt theo tên quê hương Ba Lan của bà) và radium, và là người đầu tiên giành được hai Giải Nobel — và trong hai lĩnh vực khoa học khác nhau. Bà mang các mẫu phóng xạ trong túi và để chúng trong ngăn kéo bàn làm việc.'},
  {c:'Notable People',e:'🧑‍🎓', f:"Albert Einstein did not fail mathematics as a child — a popular myth. He had mastered calculus by age 15. He did, however, fail the entrance exam for ETH Zurich on his first attempt, due to weak grades in French and botany. He passed the following year.", fVi:'Albert Einstein không trượt môn toán khi còn nhỏ — một huyền thoại phổ biến. Ông đã thành thạo giải tích lúc 15 tuổi. Tuy nhiên, ông đã trượt kỳ thi đầu vào ETH Zurich lần đầu, do điểm yếu trong môn tiếng Pháp và thực vật học. Ông đậu năm sau.'},
  {c:'Notable People',e:'🧑‍🎓', f:"Alan Turing's codebreaking at Bletchley Park — particularly his Bombe machine for cracking Enigma — is credited by historians with shortening WWII by 2–4 years and saving an estimated 14 million lives. He was later prosecuted for homosexuality and died in 1954 aged 41.", fVi:'Công trình giải mã của Alan Turing tại Bletchley Park — đặc biệt là máy Bombe để phá mã Enigma — được các nhà sử học ghi nhận là đã rút ngắn Thế chiến II khoảng 2–4 năm và cứu ước tính 14 triệu sinh mạng. Sau đó ông bị truy tố vì đồng tính luyến ái và qua đời năm 1954 ở tuổi 41.'},
  {c:'Notable People',e:'🧑‍🎓', f:'Leonardo da Vinci left the majority of his artworks unfinished. His notebooks (~13,000 pages) describe flying machines, solar power, a calculator, plate tectonics, and accurate anatomical drawings — most of which weren\'t built or verified by anyone else for 400 years.', fVi:'Leonardo da Vinci để lại phần lớn các tác phẩm nghệ thuật của mình chưa hoàn thành. Sổ tay của ông (~13.000 trang) mô tả máy bay, năng lượng mặt trời, máy tính, kiến tạo mảng và các bản vẽ giải phẫu chính xác — hầu hết không được xây dựng hay xác minh bởi ai khác trong 400 năm.'},
  {c:'Notable People',e:'🧑‍🎓', f:'Charles Darwin delayed publishing "On the Origin of Species" for approximately 20 years after formulating the theory of evolution by natural selection in 1838, reportedly from anxiety about the religious and social backlash. He was finally pushed to publish in 1859 when Alfred Russel Wallace independently developed the same theory.', fVi:'Charles Darwin đã trì hoãn xuất bản \'Nguồn gốc các loài\' khoảng 20 năm sau khi hình thành lý thuyết tiến hóa bằng chọn lọc tự nhiên năm 1838, được cho là do lo lắng về phản ứng tôn giáo và xã hội. Ông cuối cùng bị thúc đẩy xuất bản năm 1859 khi Alfred Russel Wallace độc lập phát triển cùng lý thuyết.'},
  {c:'Notable People',e:'🧑‍🎓', f:'Rosalind Franklin\'s X-ray diffraction image of DNA ("Photo 51," 1952) was the critical experimental evidence used by Watson and Crick to confirm the double-helix structure in 1953. It was shown to them without her knowledge or consent. She died of cancer in 1958, aged 37 — four years before Watson, Crick, and Wilkins received the Nobel Prize.', fVi:'Ảnh chụp X quang nhiễu xạ DNA của Rosalind Franklin (\'Ảnh 51\', 1952) là bằng chứng thực nghiệm quan trọng mà Watson và Crick sử dụng để xác nhận cấu trúc xoắn kép năm 1953. Nó được cho họ xem mà không có sự hiểu biết hay đồng ý của bà. Bà qua đời vì ung thư năm 1958, ở tuổi 37 — bốn năm trước khi Watson, Crick và Wilkins nhận Giải Nobel.'},
  {c:'Notable People',e:'🧑‍🎓', f:'Mahatma Gandhi was thrown off a first-class train in Pietermaritzburg, South Africa in 1893 for refusing to move to the "coloured" carriage despite holding a valid first-class ticket. He later described that night — shivering in the cold station — as the turning point that launched his career in civil disobedience.', fVi:'Mahatma Gandhi bị ném ra khỏi tàu hạng nhất ở Pietermaritzburg, Nam Phi năm 1893 vì từ chối chuyển sang toa dành cho người da màu mặc dù có vé hạng nhất hợp lệ. Ông sau đó mô tả đêm đó — run rẩy trong ga tàu lạnh — là bước ngoặt đã khởi động sự nghiệp bất tuân dân sự của ông.'},
  {c:'Notable People',e:'🧑‍🎓', f:'Florence Nightingale (1820–1910) was not only the founder of modern nursing; she was a pioneering statistician. She invented the polar area diagram (a form of pie chart) to visualise that most soldier deaths in the Crimean War were from preventable sanitary conditions, not battlefield wounds — and used it to lobby Parliament.', fVi:'Florence Nightingale (1820–1910) không chỉ là người sáng lập y tế điều dưỡng hiện đại; bà còn là một nhà thống kê tiên phong. Bà phát minh ra biểu đồ hình quạt cực để trực quan hóa rằng hầu hết cái chết của binh sĩ trong Chiến tranh Crimea là do điều kiện vệ sinh có thể ngăn ngừa, không phải thương tích chiến trường — và dùng nó để vận động Quốc hội.'},
  {c:'Notable People',e:'🧑‍🎓', f:'John von Neumann could reportedly read a page of a phone book once and recite it from memory years later. He was central to the Manhattan Project, created the mathematical framework for quantum mechanics, invented game theory, and designed the architecture used by essentially every computer built since 1945.', fVi:'John von Neumann được cho là có thể đọc một trang danh bạ điện thoại một lần và đọc thuộc lòng nhiều năm sau. Ông đóng vai trò trung tâm trong Dự án Manhattan, tạo ra khuôn khổ toán học cho cơ học lượng tử, phát minh lý thuyết trò chơi và thiết kế kiến trúc được sử dụng bởi hầu hết mọi máy tính kể từ năm 1945.'},
  {c:'Notable People',e:'🧑‍🎓', f:'Benjamin Franklin invented bifocals, the lightning rod, the flexible urinary catheter, the glass armonica, and bifocals — and never patented a single invention, believing all innovations should be freely shared for the public good.', fVi:'Benjamin Franklin đã phát minh ra kính hai tròng, cột thu lôi, ống thông tiểu linh hoạt và cung đàn thủy tinh — và không bao giờ đăng ký bằng sáng chế nào, tin rằng tất cả các đổi mới nên được chia sẻ tự do vì lợi ích công cộng.'},
  {c:'Notable People',e:'🧑‍🎓', f:'Richard Feynman won the Nobel Prize in Physics for quantum electrodynamics, personally investigated the Challenger Space Shuttle disaster (famously demonstrating the O-ring failure with a glass of ice water), cracked safes at Los Alamos for fun, and was an accomplished bongo drummer and painter.', fVi:'Richard Feynman đã giành Giải Nobel Vật lý cho điện động lực học lượng tử, điều tra cá nhân vụ tai nạn tàu con thoi Challenger (nổi tiếng với việc chứng minh hỏng hóc vòng chữ O với một ly nước đá), bẻ khóa két sắt tại Los Alamos để giải trí, và là một tay trống bongo và họa sĩ tài năng.'},
  {c:'Notable People',e:'🧑‍🎓', f:'Stephen Hawking was diagnosed with motor neurone disease (ALS) at age 21 and given 2–3 years to live. He lived 55 more years, until age 76, and produced some of the most important theoretical physics of the 20th century — including Hawking radiation, the Penrose-Hawking singularity theorems, and the no-boundary proposal.', fVi:'Stephen Hawking được chẩn đoán mắc bệnh thần kinh vận động (ALS) ở tuổi 21 và được cho sống 2–3 năm. Ông sống thêm 55 năm, đến 76 tuổi, và tạo ra một số vật lý lý thuyết quan trọng nhất của thế kỷ 20 — bao gồm bức xạ Hawking, các định lý kỳ dị Penrose-Hawking và đề xuất không có ranh giới.'},
  {c:'Notable People',e:'🧑‍🎓', f:'Hypatia of Alexandria (~360–415 AD) was one of the first recorded female mathematicians, astronomers, and philosophers. She headed the Platonist school of Alexandria, built astrolabes and hydrometers, and was murdered by a Christian mob during a period of political and religious violence.', fVi:'Hypatia của Alexandria (~360–415 SCN) là một trong những nhà toán học, thiên văn học và triết học nữ đầu tiên được ghi chép. Bà đứng đầu trường phái Platonist tại Alexandria, xây dựng thiên cầu và máy đo tỷ trọng, và bị một đám đông sát hại trong thời kỳ bạo lực chính trị và tôn giáo.'},
  {c:'Notable People',e:'🧑‍🎓', f:"Nikola Tesla and Thomas Edison had a bitter rivalry known as the 'War of Currents.' Tesla's AC system (backed by Westinghouse) ultimately prevailed over Edison's DC system as the standard for power distribution — Edison's DC couldn't transmit electricity over long distances without massive power loss.", fVi:'Nikola Tesla và Thomas Edison có cuộc cạnh tranh gay gắt được gọi là Chiến tranh Dòng điện. Hệ thống AC của Tesla (được Westinghouse hậu thuẫn) cuối cùng đã đánh bại hệ thống DC của Edison như là tiêu chuẩn phân phối điện — DC của Edison không thể truyền điện trên khoảng cách xa mà không mất điện đáng kể.'},
  {c:'Notable People',e:'🧑‍🎓', f:'Carl Sagan estimated there are more stars in the observable universe than grains of sand on all Earth\'s beaches, popularised the idea of "cosmic insignificance" as a source of wonder rather than despair, and co-wrote the message on the Pioneer and Voyager golden records — humanity\'s first physical messages to potential extraterrestrial civilisations.', fVi:'Carl Sagan ước tính có nhiều ngôi sao trong vũ trụ có thể quan sát hơn hạt cát trên tất cả các bãi biển của Trái Đất, phổ biến hóa ý tưởng về sự vô nghĩa vũ trụ như một nguồn kỳ diệu thay vì tuyệt vọng, và cùng viết thông điệp trên đĩa Pioneer và Voyager — những thông điệp vật lý đầu tiên của nhân loại gửi đến các nền văn minh ngoài Trái Đất tiềm năng.'},
  {c:'Notable People',e:'🧑‍🎓', f:"Claude Shannon's 1948 paper 'A Mathematical Theory of Communication' founded information theory and introduced the concept of the 'bit' as the fundamental unit of information. It laid the mathematical foundation for all digital communication, data compression, cryptography, and computing.", fVi:'Bài báo \'Lý thuyết Toán học về Truyền thông\' năm 1948 của Claude Shannon đã sáng lập lý thuyết thông tin và giới thiệu khái niệm \'bit\' như đơn vị cơ bản của thông tin. Nó đặt nền tảng toán học cho tất cả truyền thông kỹ thuật số, nén dữ liệu, mật mã học và tính toán.'},
  {c:'Notable People',e:'🧑‍🎓', f:'Archimedes (~287–212 BC) discovered the principle of buoyancy, approximated π to within 0.04% (using 96-sided polygons), invented the Archimedes screw for moving water, and designed war machines — including a "claw" crane and possibly a heat ray — that helped Syracuse hold off the Roman siege for three years.', fVi:'Archimedes (~287–212 TCN) đã khám phá ra nguyên lý nổi, xấp xỉ π trong phạm vi 0,04% (sử dụng đa giác 96 cạnh), phát minh ra vít Archimedes để di chuyển nước, và thiết kế các máy chiến tranh — bao gồm móng vuốt cẩu và có thể là tia nhiệt — giúp Syracuse chống lại cuộc bao vây của La Mã trong ba năm.'},
  {c:'Notable People',e:'🧑‍🎓', f:'Lise Meitner co-discovered nuclear fission with Otto Hahn in 1938, providing the theoretical explanation for the results Hahn could not interpret. Hahn received the 1944 Nobel Prize in Chemistry alone; Meitner — who had fled Nazi Germany — was overlooked. The element meitnerium (109) was named in her honour in 1997.', fVi:'Lise Meitner cùng khám phá ra phân hạch hạt nhân với Otto Hahn năm 1938, cung cấp giải thích lý thuyết cho các kết quả mà Hahn không thể giải thích. Hahn nhận Giải Nobel Hóa học 1944 một mình; Meitner — người đã trốn khỏi Đức Quốc xã — bị bỏ qua. Nguyên tố meitnerium (109) được đặt tên để vinh danh bà năm 1997.'},
  {c:'Notable People',e:'🧑‍🎓', f:"Srinivasa Ramanujan, a self-taught Indian mathematician with almost no formal training, mailed 120 unsolicited theorems to Cambridge mathematician G.H. Hardy in 1913. Hardy recognised genius and arranged for Ramanujan to come to Cambridge. Most of his theorems were entirely original and correct — some remain unproven a century later.", fVi:'Srinivasa Ramanujan, một nhà toán học người Ấn Độ tự học với gần như không có đào tạo chính thức, đã gửi thư 120 định lý không được yêu cầu cho nhà toán học Cambridge G.H. Hardy năm 1913. Hardy nhận ra thiên tài và thu xếp để Ramanujan đến Cambridge. Hầu hết các định lý của ông hoàn toàn mới và đúng — một số vẫn chưa được chứng minh một thế kỷ sau.'},
  {c:'Notable People',e:'🧑‍🎓', f:"Katherine Johnson calculated orbital mechanics for NASA's Mercury and Apollo missions entirely by hand. When NASA first introduced electronic computers, astronaut John Glenn refused to fly unless 'the girl' had personally checked the computer's numbers. She was awarded the Presidential Medal of Freedom in 2015.", fVi:'Katherine Johnson đã tính toán cơ học quỹ đạo cho các nhiệm vụ Mercury và Apollo của NASA hoàn toàn bằng tay. Khi NASA lần đầu giới thiệu máy tính điện tử, phi hành gia John Glenn từ chối bay trừ khi \'cô gái\' đó đã đích thân kiểm tra các con số của máy tính. Bà được trao Huân chương Tự do Tổng thống năm 2015.'},
  {c:'Notable People',e:'🧑‍🎓', f:'Gottfried Leibniz and Isaac Newton independently developed calculus in the 1660s–80s, sparking a bitter priority dispute. Newton developed it first (~1666) but published later; Leibniz published first (1684). The notation we use today — dy/dx, ∫, and Σ — is Leibniz\'s.', fVi:'Gottfried Leibniz và Isaac Newton đã độc lập phát triển giải tích vào những năm 1660–80, gây ra tranh chấp ưu tiên gay gắt. Newton phát triển trước (~1666) nhưng xuất bản sau; Leibniz xuất bản trước (1684). Ký hiệu chúng ta dùng ngày nay — dy/dx, ∫ và Σ — là của Leibniz.'},
  {c:'Notable People',e:'🧑‍🎓', f:'Paul Erdős (1913–1996) authored or co-authored ~1,525 mathematical papers across his lifetime — the most of any mathematician in history. He owned almost nothing, lived out of a suitcase, and showed up at colleagues\' houses unannounced to collaborate, famously saying: "another roof, another proof."', fVi:'Paul Erdős (1913–1996) là tác giả hoặc đồng tác giả của ~1.525 bài báo toán học trong suốt cuộc đời — nhiều nhất trong số bất kỳ nhà toán học nào trong lịch sử. Ông gần như không sở hữu gì, sống với một chiếc vali, và xuất hiện tại nhà đồng nghiệp mà không báo trước, nổi tiếng nói: \'một mái nhà khác, một định lý khác.\''},
  {c:'Notable People',e:'🧑‍🎓', f:'Tu Youyou won the 2015 Nobel Prize in Medicine for discovering artemisinin, the most effective anti-malarial drug known. She found the lead compound by systematically searching through thousands of traditional Chinese medicine recipes, ultimately finding a reference to sweet wormwood in a 1,600-year-old text.', fVi:'Tu Youyou đã giành Giải Nobel Y học 2015 cho việc khám phá artemisinin, thuốc chống sốt rét hiệu quả nhất được biết đến. Bà tìm ra hợp chất chủ đạo bằng cách tìm kiếm có hệ thống qua hàng nghìn công thức y học cổ truyền Trung Quốc, cuối cùng tìm thấy tham chiếu đến ngải hương trong một văn bản 1.600 năm tuổi.'},
  {c:'Notable People',e:'🧑‍🎓', f:"Euclid's 'Elements' (~300 BC) was the primary geometry textbook for over 2,000 years — second only to the Bible as the most printed book in history. Abraham Lincoln reportedly carried a copy on the frontier and taught himself Euclidean geometry by candlelight to sharpen his logical thinking.", fVi:'Elements của Euclid (~300 TCN) là sách giáo khoa hình học chính trong hơn 2.000 năm — chỉ đứng sau Kinh thánh là cuốn sách được in nhiều nhất trong lịch sử. Abraham Lincoln được cho là đã mang theo một bản trên biên giới và tự học hình học Euclid dưới ánh nến để mài giũa tư duy logic.'},
  {c:'Notable People',e:'🧑‍🎓', f:"Nicolaus Copernicus held off publishing his heliocentric model of the solar system until he was on his deathbed, reportedly receiving the first printed copy of 'De Revolutionibus Orbium Coelestium' in his final hours in 1543. He had sat on the manuscript for ~30 years, fearing ridicule.", fVi:'Nicolaus Copernicus trì hoãn xuất bản mô hình nhật tâm của hệ mặt trời cho đến khi ông hấp hối, được cho là nhận bản in đầu tiên của De Revolutionibus Orbium Coelestium trong những giờ cuối của cuộc đời năm 1543. Ông đã giữ bản thảo trong tay ~30 năm, sợ bị chế nhạo.'},
  {c:'Notable People',e:'🧑‍🎓', f:'Frida Kahlo painted approximately 143 works, most of them self-portraits. She began painting seriously while bedridden after a near-fatal bus accident in 1925 that fractured her spine, collarbone, ribs, and pelvis, and shattered her right leg. She painted using a special easel built over her bed.', fVi:'Frida Kahlo vẽ khoảng 143 tác phẩm, hầu hết là chân dung tự họa. Bà bắt đầu vẽ nghiêm túc khi nằm trên giường sau một vụ tai nạn xe buýt gần chết năm 1925 làm gãy cột sống, xương đòn, xương sườn và xương chậu, và đập tan chân phải của bà. Bà vẽ bằng một giá vẽ đặc biệt được xây dựng phía trên giường bệnh.'},
  {c:'Notable People',e:'🧑‍🎓', f:"Nikola Tesla reportedly worked in absolute isolation, claimed to need only 2 hours of sleep per night (though he took daytime naps), had a severe phobia of germs, refused to shake hands, and became obsessed in his later years with the number 3 — always walking around a building three times before entering.", fVi:'Nikola Tesla được cho là làm việc trong sự cô lập hoàn toàn, tuyên bố chỉ cần 2 giờ ngủ mỗi đêm (mặc dù ông nghỉ ngơi ban ngày), có nỗi ám ảnh vi khuẩn nghiêm trọng, từ chối bắt tay, và trở nên ám ảnh với số 3 trong những năm sau này — luôn đi quanh một tòa nhà ba lần trước khi vào.'},
];

// Category colour map
const KN_CAT_STYLE = {
  'Physics':       'kn-cat-physics',
  'Chemistry':     'kn-cat-chemistry',
  'Biology':       'kn-cat-biology',
  'Astronomy':     'kn-cat-astronomy',
  'History':       'kn-cat-history',
  'Geography':     'kn-cat-geography',
  'Finance':       'kn-cat-finance',
  'Notable People':'kn-cat-people',
};

function _getDayOfYear() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  return Math.floor((now - start) / 86400000);
}

function _getTodayKey() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

// Returns {fact, wikiEvents} from cache or fresh, always resolves
async function _loadDailyKnowledge() {
  const key = 'kn_daily_' + _getTodayKey();
  try {
    const cached = localStorage.getItem(key);
    if (cached) return JSON.parse(cached);
  } catch(e) {}

  // Pick fact by dayOfYear so it's consistent all day
  const dayIdx = _getDayOfYear();
  const fact = KN_FACTS[dayIdx % KN_FACTS.length];

  // Fetch Wikipedia OTD
  let wikiEvents = [];
  try {
    const now = new Date();
    const month = now.getMonth() + 1;
    const day   = now.getDate();
    const resp  = await fetch(
      `https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${month}/${day}`,
      { headers: { 'Accept': 'application/json' } }
    );
    if (resp.ok) {
      const data = await resp.json();
      // Pick 3 interesting events — filter by year diversity, avoid recent trivial events
      const events = (data.events || [])
        .filter(e => e.year && e.text && e.year < 2010)
        .sort(() => Math.random() - 0.5) // shuffle for variety across refreshes same day
        .slice(0, 3)
        .sort((a, b) => a.year - b.year); // re-sort chronologically for display
      wikiEvents = events.map(e => ({ year: e.year, text: e.text }));
    }
  } catch(e) {}

  const payload = { fact, wikiEvents };
  try { localStorage.setItem(key, JSON.stringify(payload)); } catch(e) {}
  return payload;
}

function openKnowledgeModal() {
  const ov = document.getElementById('knOverlay');
  if (!ov) return;
  ov.classList.add('open');
  document.body.style.overflow = 'hidden';
  _renderKnowledgeModal();
}

function closeKnowledgeModal() {
  const ov = document.getElementById('knOverlay');
  if (ov) ov.classList.remove('open');
  document.body.style.overflow = '';
}

function handleKnOverlayClick(e) {
  if (e.target === document.getElementById('knOverlay')) closeKnowledgeModal();
}

async function _renderKnowledgeModal() {
  // Date badge
  const db = document.getElementById('knDateBadge');
  if (db) {
    const d = new Date();
    db.textContent = d.toLocaleDateString(currentLang === 'vi' ? 'vi-VN' : 'en-GB',
      { day: 'numeric', month: 'long', year: 'numeric' });
  }

  // Show loading state for fact
  const factSec = document.getElementById('knFactSection');
  const wikiSec = document.getElementById('knWikiSection');
  if (factSec) factSec.innerHTML = '<div class="kn-wiki-loading">'+t('knLoadingFact')+'</div>';
  if (wikiSec) wikiSec.innerHTML = '<div class="kn-wiki-loading">'+t('knLoadingHistory')+'</div>';

  const { fact, wikiEvents } = await _loadDailyKnowledge();

  // Render fact card
  if (factSec && fact) {
    const cls = KN_CAT_STYLE[fact.c] || 'kn-cat-history';
    const totalInCat = KN_FACTS.filter(f => f.c === fact.c).length;
    const idx = _getDayOfYear() % KN_FACTS.length;
    const VI_CAT_NAMES = {
      'Physics':'Vật lý', 'Chemistry':'Hóa học', 'Biology':'Sinh học',
      'Astronomy':'Thiên văn', 'History':'Lịch sử', 'Geography':'Địa lý',
      'Finance':'Tài chính', 'Notable People':'Nhân vật nổi bật'
    };
    const catLabel = currentLang === 'vi' ? (VI_CAT_NAMES[fact.c] || fact.c) : fact.c;
    const factText = (currentLang === 'vi' && fact.fVi) ? fact.fVi : fact.f;
    factSec.innerHTML = `
      <div class="kn-fact-card ${cls}">
        <div class="kn-cat-pill ${cls}">${fact.e} ${catLabel}</div>
        <p class="kn-fact-text">${escHtml(factText)}</p>
        <span class="kn-fact-num">${t('knFactOf')} ${(KN_FACTS.indexOf(fact) % totalInCat) + 1} ${t('knFactOfIn')} ${totalInCat} ${t('knFactCategory')}</span>
      </div>`;
  }

  // Render Wikipedia OTD
  if (wikiSec) {
    if (!wikiEvents || !wikiEvents.length) {
      wikiSec.innerHTML = `<div class="kn-wiki-card"><div class="kn-wiki-text" style="font-style:italic;color:var(--muted)">${t('knNoHistory')}</div></div>`;
    } else {
      const now = new Date();
      const qs = `${now.toLocaleString('default',{month:'long'})} ${now.getDate()}`;
      wikiSec.innerHTML = `<div class="kn-wiki-events">` +
        wikiEvents.map(ev => `
          <div class="kn-wiki-card">
            <div class="kn-wiki-year">${ev.year} AD</div>
            <div class="kn-wiki-text">${escHtml(ev.text)}</div>
          </div>`).join('') +
        `</div>
        <a class="kn-wiki-link" href="https://en.wikipedia.org/wiki/Wikipedia:On_this_day/${qs.replace(' ','_')}" target="_blank" rel="noopener">
          ${t('knSeeAll')}
        </a>`;
    }
  }
}


// ============================================================
//                       WELCOME MODAL                       
// ============================================================
function openWelcomeModal(){
  const ov = document.getElementById('welcomeOverlay');
  if(!ov) return;
  ov.classList.add('open');
  document.body.style.overflow = 'hidden';
  // Reset scroll & button state each time
  const scroll = document.getElementById('welcomeScroll');
  if(scroll) scroll.scrollTop = 0;
  const btn = document.getElementById('welcomeContinueBtn');
  if(btn){ btn.disabled = true; }
  const txt = document.getElementById('welcomeBtnText');
  if(txt) txt.textContent = currentLang==='vi' ? 'Cuộn xuống để tiếp tục…' : 'Scroll to continue…';
  const hint = document.getElementById('welcomeScrollHint');
  if(hint) hint.classList.remove('hidden');
  // If content doesn't overflow (short screen), unlock immediately
  setTimeout(()=>{
    if(scroll && scroll.scrollHeight <= scroll.clientHeight + 8) _unlockWelcome();
  }, 300);
}

function closeWelcomeModal(){
  const ov = document.getElementById('welcomeOverlay');
  if(ov) ov.classList.remove('open');
  document.body.style.overflow = '';
}

function onWelcomeScroll(){
  const scroll = document.getElementById('welcomeScroll');
  if(!scroll) return;
  const nearBottom = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 32;
  if(nearBottom) _unlockWelcome();
}

function _unlockWelcome(){
  const btn = document.getElementById('welcomeContinueBtn');
  if(btn && btn.disabled){
    btn.disabled = false;
    const txt = document.getElementById('welcomeBtnText');
    if(txt) txt.textContent = currentLang==='vi' ? 'Bắt đầu nào! →' : 'Let\'s get started →';
    const hint = document.getElementById('welcomeScrollHint');
    if(hint) hint.classList.add('hidden');
  }
}


// ============================================================
//                   LANGUAGE / VIETNAMESE                   
// ============================================================
let currentLang = localStorage.getItem('lib_lang') || 'en';


// ============================================================
//                       AVATAR LIBRARY                      
// ============================================================
const AVATARS = [
// ---- GREEK GODS ----
{id:'athena',nameEn:'Athena',nameVi:'Thần Athena',cat:'god',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1e2d50"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#2c4a80"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#c4956a"/><defs><radialGradient id="fgathena" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#f0d8b8"/><stop offset="100%" stop-color="#c4956a"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#c4956a"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#c4956a"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgathena)"/><path d="M18 28Q17 14 32 12Q47 14 46 28Q44 16 32 16Q20 16 18 28Z" fill="#8090a0"/><path d="M18 28Q16 24 17 20Q18 15 18 28" fill="#8090a0"/><path d="M46 28Q48 24 47 20Q46 15 46 28" fill="#8090a0"/><path d="M29 12Q32 4 35 12" stroke="#c83020" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M31 12L31 24M33 12L33 24" stroke="#c83020" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#3a2810" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#3a2810" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#a0b8c8"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#a0b8c8"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#c4956a" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#3a2810" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#b06060" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#b06060" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#c4956a" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><circle cx="50" cy="12" r="5" fill="#8090a0"/><circle cx="50" cy="12" r="3" fill="#6070a0"/><circle cx="50" cy="10.5" r="1" fill="#d0d8e0"/><circle cx="51.2" cy="11.5" r=".7" fill="#d0d8e0"/></svg>`},
{id:'apollo',nameEn:'Apollo',nameVi:'Thần Apollo',cat:'god',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#b87010"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#d49030"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#d4a870"/><defs><radialGradient id="fgapollo" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#fce8c0"/><stop offset="100%" stop-color="#d4a870"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#d4a870"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#d4a870"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgapollo)"/><path d="M18 26Q18 12 32 11Q46 12 46 26Q44 16 32 16Q20 16 18 26Z" fill="#c8a030"/><path d="M23 13Q30 9 41 12" stroke="#f0d060" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><path d="M18 22Q20 18 24 20Q22 24 18 22Z" fill="#3a7020"/><path d="M20 20Q23 15 27 18Q24 22 20 20Z" fill="#3a7020"/><path d="M22 18Q26 12 30 16Q27 20 22 18Z" fill="#3a7020"/><path d="M34 16Q38 12 42 18Q38 20 34 16Z" fill="#3a7020"/><path d="M37 18Q41 15 44 20Q40 22 37 18Z" fill="#3a7020"/><path d="M44 22Q48 18 46 22Q44 26 44 22Z" fill="#3a7020"/><path d="M18 22Q32 17 46 22" stroke="#3a7020" stroke-width="1.2" fill="none"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#7a5010" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#7a5010" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#3060b0"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#3060b0"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#d4a870" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#7a5010" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#c07060" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#c07060" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#d4a870" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><circle cx="50" cy="10" r="6" fill="#f0c020" opacity=".6"/><circle cx="50" cy="10" r="4" fill="#f8e040" opacity=".8"/><path d="M44 10Q50 6 56 10M44 10Q50 14 56 10" stroke="#f8c020" stroke-width="1" fill="none" opacity=".5"/></svg>`},
{id:'artemis',nameEn:'Artemis',nameVi:'Thần Artemis',cat:'god',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0c1830"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#1a2e4a"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#b8906a"/><defs><radialGradient id="fgartemis" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#e8d0b0"/><stop offset="100%" stop-color="#b8906a"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#b8906a"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#b8906a"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgartemis)"/><path d="M18 25Q16 18 20 14Q26 10 32 10Q38 10 44 14Q48 18 46 25Q44 15 32 15Q20 15 18 25Z" fill="#2a2030"/><path d="M18 25Q15 35 16 48Q22 52 22 45Q18 38 18 25" fill="#2a2030"/><path d="M46 25Q49 35 48 48Q42 52 42 45Q46 38 46 25" fill="#2a2030"/><path d="M23 12Q30 8 41 11" stroke="#6a5060" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#3a2a20" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#3a2a20" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#8098b0"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#8098b0"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#b8906a" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#3a2a20" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#a06070" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#a06070" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#b8906a" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><path d="M47 8Q52 12 50 18Q56 13 52 8Q48 4 44 8Z" fill="#d0d8e8"/><path d="M47 8Q48 13 50 18" stroke="#a0b0c8" stroke-width="1.2" fill="none"/></svg>`},
{id:'hermes',nameEn:'Hermes',nameVi:'Thần Hermes',cat:'god',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#2858a0"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#3068b8"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#d4a860"/><defs><radialGradient id="fghermes" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#fce0b0"/><stop offset="100%" stop-color="#d4a860"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#d4a860"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#d4a860"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fghermes)"/><path d="M18 26Q18 12 32 11Q46 12 46 26Q44 16 32 16Q20 16 18 26Z" fill="#c0a858"/><path d="M23 13Q30 9 41 12" stroke="#e8cc70" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><path d="M14 22Q10 18 12 14Q16 12 18 18" fill="#d8d0b0"/><path d="M50 22Q54 18 52 14Q48 12 46 18" fill="#d8d0b0"/><path d="M10 18Q8 13 12 14" stroke="#b0c8e8" stroke-width="1.5" fill="none" stroke-linecap="round"/><path d="M54 18Q56 13 52 14" stroke="#b0c8e8" stroke-width="1.5" fill="none" stroke-linecap="round"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#7a6020" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#7a6020" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#507040"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#507040"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#d4a860" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#7a6020" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#b87050" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#b87050" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#d4a860" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/></svg>`},
{id:'dionysus',nameEn:'Dionysus',nameVi:'Thần Dionysus',cat:'god',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#3a0860"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#5a1888"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#c09060"/><defs><radialGradient id="fgdionysus" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#ecc8a8"/><stop offset="100%" stop-color="#c09060"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#c09060"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#c09060"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgdionysus)"/><path d="M18 28Q16 16 20 12Q26 8 32 8Q38 8 44 12Q48 16 46 28Q42 14 32 14Q22 14 18 28Z" fill="#3a0050"/><path d="M18 28Q14 20 15 14Q17 10 20 12" fill="#3a0050"/><path d="M46 28Q50 20 49 14Q47 10 44 12" fill="#3a0050"/><path d="M19 18Q17 14 19 12M25 14Q22 10 25 9M39 14Q42 10 39 9M45 18Q47 14 45 12" stroke="#7a2090" stroke-width="1.2" fill="none" stroke-linecap="round" opacity=".5"/><circle cx="20" cy="19" r="2.2" fill="#8a1090"/><circle cx="25" cy="15" r="2" fill="#a018a0"/><circle cx="32" cy="13" r="2.2" fill="#8a1090"/><circle cx="39" cy="15" r="2" fill="#a018a0"/><circle cx="44" cy="19" r="2.2" fill="#8a1090"/><path d="M18 20Q26 14 38 14Q44 17 46 20" stroke="#2a4a10" stroke-width="1.5" fill="none"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#3a0050" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#3a0050" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#7838a8"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#7838a8"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#c09060" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#3a0050" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#a04080" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#a04080" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#c09060" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/></svg>`},
{id:'aphrodite',nameEn:'Aphrodite',nameVi:'Thần Aphrodite',cat:'god',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#c03468"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#e04880"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#e0b0a0"/><defs><radialGradient id="fgaphrodite" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#fce8e0"/><stop offset="100%" stop-color="#e0b0a0"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#e0b0a0"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#e0b0a0"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgaphrodite)"/><path d="M17 27Q17 12 32 10Q47 12 47 27Q45 15 32 15Q19 15 17 27Z" fill="#d47090"/><path d="M17 27Q14 38 15 50" stroke="#d47090" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M47 27Q50 38 49 50" stroke="#d47090" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M15 34Q18 30 21 34Q18 38 15 34" fill="#d47090"/><path d="M49 34Q46 30 43 34Q46 38 49 34" fill="#d47090"/><path d="M23 12Q30 8 41 11" stroke="#f8b0c0" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#b05878" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#b05878" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#4870c0"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#4870c0"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#e0b0a0" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#b05878" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#e04878" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#e04878" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#e0b0a0" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><circle cx="50" cy="11" r="4" fill="#e84080"/><circle cx="50" cy="11" r="2.5" fill="#f8a0c0"/><path d="M46 11Q50 7 54 11Q50 15 46 11Z" fill="#e84080" opacity=".4"/></svg>`},
{id:'poseidon',nameEn:'Poseidon',nameVi:'Thần Poseidon',cat:'god',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0a3850"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#104858"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#a08050"/><defs><radialGradient id="fgposeidon" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#d4c0a0"/><stop offset="100%" stop-color="#a08050"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#a08050"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#a08050"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgposeidon)"/><path d="M17 27Q17 12 32 10Q47 12 47 27Q45 15 32 15Q19 15 17 27Z" fill="#1a4060"/><path d="M17 27Q14 38 15 50" stroke="#1a4060" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M47 27Q50 38 49 50" stroke="#1a4060" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M15 34Q18 30 21 34Q18 38 15 34" fill="#1a4060"/><path d="M49 34Q46 30 43 34Q46 38 49 34" fill="#1a4060"/><path d="M23 12Q30 8 41 11" stroke="#3080a0" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#1a3050" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#1a3050" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#309080"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#309080"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#a08050" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#1a3050" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#907050" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#907050" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#a08050" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><path d="M52 6L52 20M49 9L52 6L55 9M49 14L52 11L55 14M49 19L52 16L55 19" stroke="#80c0d0" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>`},
{id:'zeus',nameEn:'Zeus',nameVi:'Thần Zeus',cat:'god',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#303848"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#404858"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#a88050"/><defs><radialGradient id="fgzeus" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#d4b890"/><stop offset="100%" stop-color="#a88050"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#a88050"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#a88050"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgzeus)"/><path d="M18 26Q18 12 32 11Q46 12 46 26Q44 16 32 16Q20 16 18 26Z" fill="#e0e4e8"/><path d="M23 13Q30 9 41 12" stroke="#fff" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><ellipse cx="32" cy="47" rx="11" ry="7" fill="#e0e4e8"/><ellipse cx="32" cy="47" rx="9" ry="5" fill="#edf0f4"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#c0c8d0" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#c0c8d0" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#5878a0"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#5878a0"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#a88050" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#c0c8d0" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#907860" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#907860" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#a88050" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><path d="M48 8L50 14L46 14L50 20" stroke="#f0d020" stroke-width="2.5" fill="none" stroke-linejoin="round" stroke-linecap="round"/></svg>`},
{id:'hades',nameEn:'Hades',nameVi:'Thần Hades',cat:'god',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0a0a18"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#10101e"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#9090b0"/><defs><radialGradient id="fghades" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#c8c0d8"/><stop offset="100%" stop-color="#9090b0"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#9090b0"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#9090b0"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fghades)"/><path d="M17 26Q17 11 32 9Q47 11 47 26Q45 14 32 14Q19 14 17 26Z" fill="#1a1028"/><path d="M17 26Q13 36 14 52" stroke="#1a1028" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M47 26Q51 36 50 52" stroke="#1a1028" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M24 12Q30 8 40 11" stroke="#3a2050" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".45"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#2a1848" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#2a1848" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#6040a0"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#6040a0"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#9090b0" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#2a1848" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#7050a0" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#7050a0" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#9090b0" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><path d="M24 18L26 12L32 10L38 12L40 18L36 14L32 12L28 14Z" fill="#2a1848"/><path d="M26 12L28 8L30 12M34 12L36 8L38 12" stroke="#6040a0" stroke-width="1.2" fill="none"/><circle cx="32" cy="10" r="1.5" fill="#9060c0"/></svg>`},
{id:'hera',nameEn:'Hera',nameVi:'Thần Hera',cat:'god',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#5a2880"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#7a38a0"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#d4a878"/><defs><radialGradient id="fghera" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#f8e8d0"/><stop offset="100%" stop-color="#d4a878"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#d4a878"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#d4a878"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fghera)"/><path d="M18 26Q18 12 32 11Q46 12 46 26Q44 16 32 16Q20 16 18 26Z" fill="#1a0828"/><path d="M23 13Q30 9 41 12" stroke="#4a2060" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><path d="M20 20L22 12L26 18L32 10L38 18L42 12L44 20Z" fill="#c8a820"/><path d="M20 20L44 20" stroke="#c8a820" stroke-width="2" fill="none"/><circle cx="26" cy="18" r="1.5" fill="#f8e080"/><circle cx="32" cy="13" r="2" fill="#f8e080"/><circle cx="38" cy="18" r="1.5" fill="#f8e080"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#3a1848" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#3a1848" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#3860b0"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#3860b0"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#d4a878" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#3a1848" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#c04878" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#c04878" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#d4a878" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><circle cx="26" cy="17" r="2" fill="#1a6040"/><circle cx="26" cy="17" r="1" fill="#40a870"/><circle cx="32" cy="11" r="2.5" fill="#1a6040"/><circle cx="32" cy="11" r="1.2" fill="#40a870"/><circle cx="38" cy="17" r="2" fill="#1a6040"/><circle cx="38" cy="17" r="1" fill="#40a870"/></svg>`},
{id:'ares',nameEn:'Ares',nameVi:'Thần Ares',cat:'god',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#6a1010"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#8a1818"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#c08050"/><defs><radialGradient id="fgares" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#e8c090"/><stop offset="100%" stop-color="#c08050"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#c08050"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#c08050"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgares)"/><path d="M18 28Q17 14 32 12Q47 14 46 28Q44 16 32 16Q20 16 18 28Z" fill="#7a7a8a"/><path d="M18 28Q16 24 17 20Q18 15 18 28" fill="#7a7a8a"/><path d="M46 28Q48 24 47 20Q46 15 46 28" fill="#7a7a8a"/><path d="M29 12Q32 4 35 12" stroke="#c03020" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M31 12L31 24M33 12L33 24" stroke="#c03020" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#3a1808" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#3a1808" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#c03020"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#c03020"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#c08050" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#3a1808" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#a04030" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#a04030" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#c08050" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><path d="M48 8L54 8L54 14L50 14L52 18L48 18L50 14L46 14L46 8Z" fill="#c03020"/><circle cx="50" cy="10" r="1.5" fill="#f05040"/></svg>`},
{id:'demeter',nameEn:'Demeter',nameVi:'Thần Demeter',cat:'god',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#5a3810"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#7a5020"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#c89060"/><defs><radialGradient id="fgdemeter" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#f4d8b0"/><stop offset="100%" stop-color="#c89060"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#c89060"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#c89060"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgdemeter)"/><path d="M18 25Q16 18 20 14Q26 10 32 10Q38 10 44 14Q48 18 46 25Q44 15 32 15Q20 15 18 25Z" fill="#b07020"/><path d="M18 25Q15 35 16 48Q22 52 22 45Q18 38 18 25" fill="#b07020"/><path d="M46 25Q49 35 48 48Q42 52 42 45Q46 38 46 25" fill="#b07020"/><path d="M23 12Q30 8 41 11" stroke="#e0a030" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><path d="M20 18Q22 12 24 16Q22 18 20 18Z" fill="#c89020"/><path d="M26 14Q28 8 30 13Q27 16 26 14Z" fill="#d4a030"/><path d="M34 13Q36 8 38 14Q35 16 34 13Z" fill="#c89020"/><path d="M40 16Q42 12 44 18Q42 18 40 16Z" fill="#d4a030"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#5a3010" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#5a3010" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#70a030"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#70a030"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#c89060" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#5a3010" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#b06850" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#b06850" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#c89060" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/></svg>`},
{id:'nike',nameEn:'Nike',nameVi:'Thần Nike',cat:'god',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#f0f0f8"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#e0e8f8"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#d4a870"/><defs><radialGradient id="fgnike" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#fce8c8"/><stop offset="100%" stop-color="#d4a870"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#d4a870"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#d4a870"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgnike)"/><path d="M18 25Q16 18 20 14Q26 10 32 10Q38 10 44 14Q48 18 46 25Q44 15 32 15Q20 15 18 25Z" fill="#f0d060"/><path d="M18 25Q15 35 16 48Q22 52 22 45Q18 38 18 25" fill="#f0d060"/><path d="M46 25Q49 35 48 48Q42 52 42 45Q46 38 46 25" fill="#f0d060"/><path d="M23 12Q30 8 41 11" stroke="#fff8d0" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#806020" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#806020" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#4060b0"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#4060b0"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#d4a870" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#806020" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#e06858" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#e06858" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#d4a870" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><path d="M6 20Q10 28 14 24Q10 32 14 32Q8 35 12 38" stroke="#e8f0ff" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M58 20Q54 28 50 24Q54 32 50 32Q56 35 52 38" stroke="#e8f0ff" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M6 20Q10 24 14 24" fill="#d0e0f8"/><path d="M58 20Q54 24 50 24" fill="#d0e0f8"/></svg>`},
{id:'nyx',nameEn:'Nyx',nameVi:'Thần Nyx',cat:'god',svg:`<rect width="64" height="64" fill="#08102a"/><circle cx="8" cy="7" r=".7" fill="#fff" opacity=".8"/><circle cx="20" cy="4" r=".5" fill="#fff" opacity=".6"/><circle cx="55" cy="6" r=".7" fill="#fff" opacity=".7"/><circle cx="59" cy="20" r=".5" fill="#fff" opacity=".5"/><circle cx="5" cy="30" r=".6" fill="#fff" opacity=".7"/><circle cx="58" cy="42" r=".6" fill="#fff" opacity=".6"/><circle cx="12" cy="50" r=".5" fill="#fff" opacity=".5"/><circle cx="50" cy="55" r=".7" fill="#fff" opacity=".6"/><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#08102a"/><circle cx="8" cy="7" r=".7" fill="#fff" opacity=".8"/><circle cx="20" cy="4" r=".5" fill="#fff" opacity=".6"/><circle cx="55" cy="6" r=".7" fill="#fff" opacity=".7"/><circle cx="59" cy="20" r=".5" fill="#fff" opacity=".5"/><circle cx="5" cy="30" r=".6" fill="#fff" opacity=".7"/><circle cx="58" cy="42" r=".6" fill="#fff" opacity=".6"/><circle cx="12" cy="50" r=".5" fill="#fff" opacity=".5"/><circle cx="50" cy="55" r=".7" fill="#fff" opacity=".6"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#0c0820"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#8880b0"/><defs><radialGradient id="fgnyx" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#c8c0e0"/><stop offset="100%" stop-color="#8880b0"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#8880b0"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#8880b0"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgnyx)"/><path d="M17 26Q17 11 32 9Q47 11 47 26Q45 14 32 14Q19 14 17 26Z" fill="#080618"/><path d="M17 26Q13 36 14 52" stroke="#080618" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M47 26Q51 36 50 52" stroke="#080618" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M24 12Q30 8 40 11" stroke="#2a1848" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".45"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#1a0838" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#1a0838" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#d0c0f0"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#d0c0f0"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#8880b0" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#1a0838" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#7058a0" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#7058a0" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#8880b0" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><circle cx="24" cy="15" r="1" fill="#fff" opacity=".8"/><circle cx="38" cy="13" r=".8" fill="#fff" opacity=".7"/><circle cx="30" cy="12" r=".6" fill="#fff" opacity=".6"/></svg>`},
{id:'hecate',nameEn:'Hecate',nameVi:'Thần Hecate',cat:'god',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1a0830"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#2a1040"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#9878b0"/><defs><radialGradient id="fghecate" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#d8c0e0"/><stop offset="100%" stop-color="#9878b0"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#9878b0"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#9878b0"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fghecate)"/><path d="M18 25Q16 18 20 14Q26 10 32 10Q38 10 44 14Q48 18 46 25Q44 15 32 15Q20 15 18 25Z" fill="#1a0828"/><path d="M18 25Q15 35 16 48Q22 52 22 45Q18 38 18 25" fill="#1a0828"/><path d="M46 25Q49 35 48 48Q42 52 42 45Q46 38 46 25" fill="#1a0828"/><path d="M23 12Q30 8 41 11" stroke="#5a2070" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#2a1040" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#2a1040" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#c080e0"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#c080e0"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#9878b0" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#2a1040" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#9050b0" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#9050b0" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#9878b0" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><circle cx="20" cy="10" r="3.5" fill="none" stroke="#d0b0e8" stroke-width="1.5"/><circle cx="32" cy="8" r="4" fill="#d0b0e8" opacity=".8"/><circle cx="44" cy="10" r="3.5" fill="none" stroke="#d0b0e8" stroke-width="1.5"/><circle cx="30.5" cy="8" r="2.5" fill="#1a0830"/></svg>`},
{id:'helios',nameEn:'Helios',nameVi:'Thần Helios',cat:'god',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#e08010"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#e8a020"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#e0b050"/><defs><radialGradient id="fghelios" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#fef0c0"/><stop offset="100%" stop-color="#e0b050"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#e0b050"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#e0b050"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fghelios)"/><path d="M18 26Q18 12 32 11Q46 12 46 26Q44 16 32 16Q20 16 18 26Z" fill="#f0c020"/><path d="M23 13Q30 9 41 12" stroke="#fff8a0" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><path d="M32 8Q32 3 32 1M22 10Q18 6 16 4M42 10Q46 6 48 4M17 22Q12 20 10 18M47 22Q52 20 54 18" stroke="#f8d020" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#a06010" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#a06010" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#e07020"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#e07020"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#e0b050" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#a06010" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#c07040" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#c07040" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#e0b050" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><circle cx="32" cy="32" r="28" fill="#f0c020" opacity=".06"/></svg>`},
// ---- GREEK HEROES & MYTHS ----
{id:'odysseus',nameEn:'Odysseus',nameVi:'Odysseus',cat:'hero',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#5a2808"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#7a3810"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#9a6838"/><defs><radialGradient id="fgodysseus" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#d4a870"/><stop offset="100%" stop-color="#9a6838"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#9a6838"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#9a6838"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgodysseus)"/><path d="M18 28Q17 14 32 12Q47 14 46 28Q44 16 32 16Q20 16 18 28Z" fill="#8a2820"/><path d="M18 28Q16 24 17 20Q18 15 18 28" fill="#8a2820"/><path d="M46 28Q48 24 47 20Q46 15 46 28" fill="#8a2820"/><path d="M29 12Q32 4 35 12" stroke="#c04020" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M31 12L31 24M33 12L33 24" stroke="#c04020" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#5a2808" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#5a2808" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#6a4020"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#6a4020"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#9a6838" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#5a2808" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#9a5030" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#9a5030" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#9a6838" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><path d="M22 33Q24 30 26 33" stroke="#5a2808" stroke-width="1.2" fill="none"/></svg>`},
{id:'achilles',nameEn:'Achilles',nameVi:'Achilles',cat:'hero',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#806020"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#a07828"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#d4a870"/><defs><radialGradient id="fgachilles" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#fce8c0"/><stop offset="100%" stop-color="#d4a870"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#d4a870"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#d4a870"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgachilles)"/><path d="M18 26Q18 12 32 11Q46 12 46 26Q44 16 32 16Q20 16 18 26Z" fill="#c8a030"/><path d="M23 13Q30 9 41 12" stroke="#e0c060" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#7a5010" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#7a5010" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#3050a0"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#3050a0"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#d4a870" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#7a5010" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#c07858" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#c07858" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#d4a870" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><path d="M17 24Q18 12 32 11Q46 12 47 24" fill="#c09030" opacity=".7"/><path d="M18 26Q15 24 17 22" stroke="#c09030" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M46 26Q49 24 47 22" stroke="#c09030" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`},
{id:'persephone',nameEn:'Persephone',nameVi:'Persephone',cat:'hero',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1a3010"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#4a2060"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#c89868"/><defs><radialGradient id="fgpersephone" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#f0dcc0"/><stop offset="100%" stop-color="#c89868"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#c89868"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#c89868"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgpersephone)"/><path d="M18 25Q16 18 20 14Q26 10 32 10Q38 10 44 14Q48 18 46 25Q44 15 32 15Q20 15 18 25Z" fill="#1a0828"/><path d="M18 25Q15 35 16 48Q22 52 22 45Q18 38 18 25" fill="#1a0828"/><path d="M46 25Q49 35 48 48Q42 52 42 45Q46 38 46 25" fill="#1a0828"/><path d="M23 12Q30 8 41 11" stroke="#5a2060" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><circle cx="22" cy="19" r="2" fill="#e04870"/><circle cx="32" cy="16" r="2.5" fill="#c03060"/><circle cx="42" cy="19" r="2" fill="#e04870"/><circle cx="20" cy="22" r="1.5" fill="#3a8030"/><circle cx="38" cy="16" r="1.5" fill="#3a8030"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#3a1040" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#3a1040" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#7030a0"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#7030a0"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#c89868" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#3a1040" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#c03870" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#c03870" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#c89868" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/></svg>`},
{id:'medusa',nameEn:'Medusa',nameVi:'Medusa',cat:'hero',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0a2820"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#103828"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#608068"/><defs><radialGradient id="fgmedusa" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#a8c898"/><stop offset="100%" stop-color="#608068"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#608068"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#608068"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgmedusa)"/><path d="M18 27Q14 18 18 12Q20 22 18 27" stroke="#2a8050" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M22 20Q18 10 22 8Q24 16 22 20" stroke="#3a9060" stroke-width="2.5" fill="none" stroke-linecap="round"/><path d="M28 16Q26 8 30 6Q30 14 28 16" stroke="#2a8050" stroke-width="2.5" fill="none" stroke-linecap="round"/><path d="M36 16Q38 8 34 6Q34 14 36 16" stroke="#3a9060" stroke-width="2.5" fill="none" stroke-linecap="round"/><path d="M42 20Q46 10 42 8Q40 16 42 20" stroke="#2a8050" stroke-width="2.5" fill="none" stroke-linecap="round"/><path d="M46 27Q50 18 46 12Q44 22 46 27" stroke="#3a9060" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="18" cy="11" r="1.8" fill="#40a060"/><circle cx="22" cy="7" r="1.5" fill="#30a050"/><circle cx="30" cy="5" r="1.8" fill="#40a060"/><circle cx="38" cy="5" r="1.5" fill="#30a050"/><circle cx="46" cy="11" r="1.8" fill="#40a060"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#205830" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#205830" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#d0c010"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#d0c010"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#608068" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#205830" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#409060" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#409060" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#608068" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/></svg>`},
{id:'perseus',nameEn:'Perseus',nameVi:'Perseus',cat:'hero',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#304870"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#405880"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#c8986a"/><defs><radialGradient id="fgperseus" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#f0d8b0"/><stop offset="100%" stop-color="#c8986a"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#c8986a"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#c8986a"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgperseus)"/><path d="M18 26Q18 12 32 11Q46 12 46 26Q44 16 32 16Q20 16 18 26Z" fill="#4a2808"/><path d="M23 13Q30 9 41 12" stroke="#7a4820" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#3a1808" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#3a1808" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#4068a0"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#4068a0"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#c8986a" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#3a1808" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#b07050" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#b07050" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#c8986a" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><circle cx="50" cy="12" r="5.5" fill="#d0d8e0"/><circle cx="50" cy="12" r="4" fill="#a0b0c0"/><path d="M47 9Q50 7 53 9Q50 15 47 9Z" fill="#c0c8d8" opacity=".6"/><circle cx="50" cy="12" r="1.5" fill="#e0e8f0"/></svg>`},
{id:'heracles',nameEn:'Heracles',nameVi:'Heracles',cat:'hero',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#5a3010"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#7a4818"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#c09060"/><defs><radialGradient id="fgheracles" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#e8c898"/><stop offset="100%" stop-color="#c09060"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#c09060"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#c09060"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgheracles)"/><path d="M18 26Q18 12 32 11Q46 12 46 26Q44 16 32 16Q20 16 18 26Z" fill="#5a2808"/><path d="M23 13Q30 9 41 12" stroke="#8a5028" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><path d="M16 28Q14 20 16 18Q20 17 22 21" fill="#c08028" opacity=".8"/><path d="M48 28Q50 20 48 18Q44 17 42 21" fill="#c08028" opacity=".8"/><ellipse cx="32" cy="48" rx="10" ry="6" fill="#8a5020"/><ellipse cx="32" cy="47" rx="8" ry="4" fill="#a06028"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#3a1808" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#3a1808" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#705030"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#705030"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#c09060" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#3a1808" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#9a5830" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#9a5830" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#c09060" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/></svg>`},
{id:'theseus',nameEn:'Theseus',nameVi:'Theseus',cat:'hero',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#284060"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#384858"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#c09060"/><defs><radialGradient id="fgtheseus" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#ecd0a8"/><stop offset="100%" stop-color="#c09060"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#c09060"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#c09060"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgtheseus)"/><path d="M18 26Q18 12 32 11Q46 12 46 26Q44 16 32 16Q20 16 18 26Z" fill="#2a1808"/><path d="M23 13Q30 9 41 12" stroke="#5a3818" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#2a1808" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#2a1808" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#5888b0"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#5888b0"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#c09060" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#2a1808" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#b07050" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#b07050" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#c09060" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><rect x="46" y="7" width="10" height="10" rx="2" fill="none" stroke="#c0a858" stroke-width="1.2"/><path d="M48 9H54M48 12H51M51 12V14H54V9" stroke="#c0a858" stroke-width="1" fill="none"/></svg>`},
{id:'jason',nameEn:'Jason',nameVi:'Jason',cat:'hero',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#3a5020"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#4a6030"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#c89060"/><defs><radialGradient id="fgjason" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#f0d8b0"/><stop offset="100%" stop-color="#c89060"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#c89060"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#c89060"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgjason)"/><path d="M18 26Q18 12 32 11Q46 12 46 26Q44 16 32 16Q20 16 18 26Z" fill="#4a2808"/><path d="M23 13Q30 9 41 12" stroke="#7a4820" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#3a2010" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#3a2010" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#508040"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#508040"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#c89060" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#3a2010" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#b07050" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#b07050" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#c89060" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><path d="M46 8Q50 6 54 8Q54 14 50 16Q46 14 46 8Z" fill="#c8a020"/><path d="M48 10Q50 8 52 10Q52 13 50 14Q48 13 48 10Z" fill="#e0c040"/></svg>`},
{id:'atalanta',nameEn:'Atalanta',nameVi:'Atalanta',cat:'hero',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#2a4820"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#3a5828"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#c09060"/><defs><radialGradient id="fgatalanta" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#e8c898"/><stop offset="100%" stop-color="#c09060"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#c09060"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#c09060"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgatalanta)"/><path d="M18 25Q16 18 20 14Q26 10 32 10Q38 10 44 14Q48 18 46 25Q44 15 32 15Q20 15 18 25Z" fill="#8a3010"/><path d="M18 25Q15 35 16 48Q22 52 22 45Q18 38 18 25" fill="#8a3010"/><path d="M46 25Q49 35 48 48Q42 52 42 45Q46 38 46 25" fill="#8a3010"/><path d="M23 12Q30 8 41 11" stroke="#b05020" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#5a2808" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#5a2808" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#507830"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#507830"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#c09060" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#5a2808" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#b06050" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#b06050" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#c09060" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><path d="M47 6L57 12L47 18L49 12Z" fill="#a07830" opacity=".8"/><line x1="47" y1="12" x2="57" y2="12" stroke="#7a5820" stroke-width="1.5"/></svg>`},
{id:'orpheus',nameEn:'Orpheus',nameVi:'Orpheus',cat:'hero',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#2a1848"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#3a2858"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#c0987a"/><defs><radialGradient id="fgorpheus" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#ecd8b8"/><stop offset="100%" stop-color="#c0987a"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#c0987a"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#c0987a"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgorpheus)"/><path d="M17 27Q17 12 32 10Q47 12 47 27Q45 15 32 15Q19 15 17 27Z" fill="#3a1808"/><path d="M17 27Q14 38 15 50" stroke="#3a1808" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M47 27Q50 38 49 50" stroke="#3a1808" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M15 34Q18 30 21 34Q18 38 15 34" fill="#3a1808"/><path d="M49 34Q46 30 43 34Q46 38 49 34" fill="#3a1808"/><path d="M23 12Q30 8 41 11" stroke="#6a3818" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#2a1808" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#2a1808" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#5060a0"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#5060a0"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#c0987a" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#2a1808" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#b06858" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#b06858" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#c0987a" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="51" cy="12" rx="4" ry="5.5" fill="none" stroke="#c0a050" stroke-width="1.5"/><line x1="49" y1="8" x2="49" y2="17" stroke="#c0a050" stroke-width="1"/><line x1="51" y1="7.5" x2="51" y2="17.5" stroke="#c0a050" stroke-width="1"/><line x1="53" y1="8" x2="53" y2="17" stroke="#c0a050" stroke-width="1"/><line x1="47" y1="12" x2="55" y2="12" stroke="#c0a050" stroke-width="1.5"/></svg>`},
{id:'circe',nameEn:'Circe',nameVi:'Circe',cat:'hero',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1a3820"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#284830"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#b8987a"/><defs><radialGradient id="fgcirce" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#e8d8c0"/><stop offset="100%" stop-color="#b8987a"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#b8987a"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#b8987a"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgcirce)"/><path d="M18 25Q16 18 20 14Q26 10 32 10Q38 10 44 14Q48 18 46 25Q44 15 32 15Q20 15 18 25Z" fill="#4a0060"/><path d="M18 25Q15 35 16 48Q22 52 22 45Q18 38 18 25" fill="#4a0060"/><path d="M46 25Q49 35 48 48Q42 52 42 45Q46 38 46 25" fill="#4a0060"/><path d="M23 12Q30 8 41 11" stroke="#8030a0" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#2a0848" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#2a0848" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#30a070"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#30a070"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#b8987a" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#2a0848" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#a04080" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#a04080" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#b8987a" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><circle cx="50" cy="10" r="4" fill="#30a070" opacity=".3"/><circle cx="50" cy="10" r="2.5" fill="#40b880" opacity=".6"/><path d="M46 10Q50 6 54 10Q50 14 46 10Z" stroke="#30a070" stroke-width="1" fill="none" opacity=".5"/></svg>`},
{id:'prometheus',nameEn:'Prometheus',nameVi:'Prometheus',cat:'hero',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#2a1008"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#3a1810"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#a07858"/><defs><radialGradient id="fgprometheus" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#d4b898"/><stop offset="100%" stop-color="#a07858"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#a07858"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#a07858"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgprometheus)"/><path d="M18 25Q16 18 20 14Q26 10 32 10Q38 10 44 14Q48 18 46 25Q44 15 32 15Q20 15 18 25Z" fill="#1a0808"/><path d="M18 25Q15 35 16 48Q22 52 22 45Q18 38 18 25" fill="#1a0808"/><path d="M46 25Q49 35 48 48Q42 52 42 45Q46 38 46 25" fill="#1a0808"/><path d="M23 12Q30 8 41 11" stroke="#3a1808" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#2a1008" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#2a1008" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#c04020"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#c04020"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#a07858" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#2a1008" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#a05030" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#a05030" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#a07858" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><path d="M49 16Q51 10 53 8Q54 12 52 14Q54 12 56 14Q54 16 52 16Q54 16 54 18Q51 16 49 16Z" fill="#f08020"/><path d="M51 14Q52 11 54 10Q53 13 51 14Z" fill="#f8d040"/></svg>`},
{id:'cassandra',nameEn:'Cassandra',nameVi:'Cassandra',cat:'hero',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#3a1808"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#501820"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#c89870"/><defs><radialGradient id="fgcassandra" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#f0d8c0"/><stop offset="100%" stop-color="#c89870"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#c89870"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#c89870"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgcassandra)"/><path d="M17 27Q17 12 32 10Q47 12 47 27Q45 15 32 15Q19 15 17 27Z" fill="#1a0808"/><path d="M17 27Q14 38 15 50" stroke="#1a0808" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M47 27Q50 38 49 50" stroke="#1a0808" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M15 34Q18 30 21 34Q18 38 15 34" fill="#1a0808"/><path d="M49 34Q46 30 43 34Q46 38 49 34" fill="#1a0808"/><path d="M23 12Q30 8 41 11" stroke="#3a1010" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#3a1808" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#3a1808" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#8850a0"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#8850a0"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#c89870" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#3a1808" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#c05060" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#c05060" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#c89870" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><circle cx="50" cy="10" r="3.5" fill="#8050a0" opacity=".4"/><path d="M47 10Q50 6 53 10Q50 14 47 10Z" fill="#a060c0" opacity=".5"/><circle cx="50" cy="10" r="1.5" fill="#d0b0e8"/></svg>`},
// ---- ARCHETYPES ----
{id:'scholar',nameEn:'The Scholar',nameVi:'Học Giả',cat:'archetype',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#5a3800"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#7a5010"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#c8986a"/><defs><radialGradient id="fgscholar" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#f0d8b0"/><stop offset="100%" stop-color="#c8986a"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#c8986a"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#c8986a"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgscholar)"/><path d="M18 26Q18 12 32 11Q46 12 46 26Q44 16 32 16Q20 16 18 26Z" fill="#2a1808"/><path d="M23 13Q30 9 41 12" stroke="#5a3820" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#3a1808" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#3a1808" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#6a4820"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#6a4820"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#c8986a" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#3a1808" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#b07850" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#b07850" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#c8986a" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><circle cx="25.5" cy="31.5" r="4.5" fill="none" stroke="#c0a050" stroke-width="1.5"/><circle cx="38.5" cy="31.5" r="4.5" fill="none" stroke="#c0a050" stroke-width="1.5"/><line x1="30" y1="31.5" x2="34" y2="31.5" stroke="#c0a050" stroke-width="1.5"/><line x1="21" y1="30" x2="18" y2="29" stroke="#c0a050" stroke-width="1.5"/><line x1="43" y1="30" x2="46" y2="29" stroke="#c0a050" stroke-width="1.5"/></svg>`},
{id:'sage',nameEn:'The Sage',nameVi:'Hiền Nhân',cat:'archetype',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#141428"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#202040"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#a09070"/><defs><radialGradient id="fgsage" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#d0c0a8"/><stop offset="100%" stop-color="#a09070"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#a09070"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#a09070"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgsage)"/><path d="M18 26Q18 12 32 11Q46 12 46 26Q44 16 32 16Q20 16 18 26Z" fill="#d8dce4"/><path d="M23 13Q30 9 41 12" stroke="#fff" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><ellipse cx="32" cy="48" rx="11" ry="7" fill="#d8dce4"/><ellipse cx="32" cy="47" rx="9" ry="5" fill="#e8ecf0"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#a0a8b8" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#a0a8b8" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#7890b0"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#7890b0"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#a09070" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#a0a8b8" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#9a8870" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#9a8870" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#a09070" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/></svg>`},
{id:'sorceress',nameEn:'Sorceress',nameVi:'Pháp Sư',cat:'archetype',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#10061e"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#1c0c30"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#a898c0"/><defs><radialGradient id="fgsorceress" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#d8c0e0"/><stop offset="100%" stop-color="#a898c0"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#a898c0"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#a898c0"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgsorceress)"/><path d="M17 26Q17 11 32 9Q47 11 47 26Q45 14 32 14Q19 14 17 26Z" fill="#2a0860"/><path d="M17 26Q13 36 14 52" stroke="#2a0860" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M47 26Q51 36 50 52" stroke="#2a0860" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M24 12Q30 8 40 11" stroke="#6030a0" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".45"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#2a0860" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#2a0860" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#9040d0"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#9040d0"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#a898c0" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#2a0860" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#a040c0" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#a040c0" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#a898c0" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><path d="M24 20L25 16L26 20L30 21L26 22L25 26L24 22L20 21Z" fill="#e0c040"/><path d="M40 20L41 16L42 20L46 21L42 22L41 26L40 22L36 21Z" fill="#e0c040"/><circle cx="32" cy="17" r="2" fill="#d0a0f0"/></svg>`},
{id:'wanderer',nameEn:'Wanderer',nameVi:'Lữ Khách',cat:'archetype',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#182808"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#243810"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#906040"/><defs><radialGradient id="fgwanderer" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#c8a878"/><stop offset="100%" stop-color="#906040"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#906040"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#906040"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgwanderer)"/><path d="M18 25Q16 18 20 14Q26 10 32 10Q38 10 44 14Q48 18 46 25Q44 15 32 15Q20 15 18 25Z" fill="#2a1808"/><path d="M18 25Q15 35 16 48Q22 52 22 45Q18 38 18 25" fill="#2a1808"/><path d="M46 25Q49 35 48 48Q42 52 42 45Q46 38 46 25" fill="#2a1808"/><path d="M23 12Q30 8 41 11" stroke="#5a3820" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><path d="M12 34Q10 28 12 24Q14 23 15 28Z" fill="#2a1808"/><path d="M52 34Q54 28 52 24Q50 23 49 28Z" fill="#2a1808"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#3a1808" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#3a1808" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#508040"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#508040"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#906040" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#3a1808" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#a07050" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#a07050" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#906040" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/></svg>`},
{id:'knight',nameEn:'The Knight',nameVi:'Hiệp Sĩ',cat:'archetype',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#243450"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#304060"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#c09060"/><defs><radialGradient id="fgknight" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#ecc8a0"/><stop offset="100%" stop-color="#c09060"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#c09060"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#c09060"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgknight)"/><path d="M17 28Q17 12 32 11Q47 12 47 28Q45 15 32 15Q19 15 17 28Z" fill="#8898a8"/><path d="M17 28Q15 22 17 18" stroke="#8898a8" stroke-width="4.5" fill="none" stroke-linecap="round"/><path d="M47 28Q49 22 47 18" stroke="#8898a8" stroke-width="4.5" fill="none" stroke-linecap="round"/><line x1="17" y1="25" x2="47" y2="25" stroke="#6878a0" stroke-width="1.5"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#4a3820" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#4a3820" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#3060a0"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#3060a0"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#c09060" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#4a3820" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#b08060" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#b08060" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#c09060" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/></svg>`},
{id:'alchemist',nameEn:'Alchemist',nameVi:'Giả Kim Sư',cat:'archetype',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#5a1400"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#7a2008"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#a87850"/><defs><radialGradient id="fgalchemist" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#d8b090"/><stop offset="100%" stop-color="#a87850"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#a87850"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#a87850"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgalchemist)"/><path d="M18 25Q16 18 20 14Q26 10 32 10Q38 10 44 14Q48 18 46 25Q44 15 32 15Q20 15 18 25Z" fill="#801800"/><path d="M18 25Q15 35 16 48Q22 52 22 45Q18 38 18 25" fill="#801800"/><path d="M46 25Q49 35 48 48Q42 52 42 45Q46 38 46 25" fill="#801800"/><path d="M23 12Q30 8 41 11" stroke="#b03020" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#3a0a00" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#3a0a00" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#a06020"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#a06020"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#a87850" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#3a0a00" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#a04828" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#a04828" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#a87850" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><circle cx="25.5" cy="31.5" r="4.5" fill="none" stroke="#b08020" stroke-width="2"/><circle cx="25.5" cy="31.5" r="2.5" fill="#280800" opacity=".5"/><circle cx="38.5" cy="31.5" r="4.5" fill="none" stroke="#b08020" stroke-width="2"/><circle cx="38.5" cy="31.5" r="2.5" fill="#280800" opacity=".5"/><line x1="30" y1="31.5" x2="34" y2="31.5" stroke="#b08020" stroke-width="2"/></svg>`},
{id:'bard',nameEn:'The Bard',nameVi:'Thi Nhân',cat:'archetype',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#480e1a"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#601220"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#c49060"/><defs><radialGradient id="fgbard" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#ecc8a0"/><stop offset="100%" stop-color="#c49060"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#c49060"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#c49060"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgbard)"/><path d="M18 26Q18 12 32 11Q46 12 46 26Q44 16 32 16Q20 16 18 26Z" fill="#3a1808"/><path d="M23 13Q30 9 41 12" stroke="#6a3818" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><path d="M42 18Q48 8 46 4Q42 10 42 18" fill="#1a8888"/><path d="M41 18Q46 10 45 6Q41 11 41 18" fill="#20a8a0"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#3a1808" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#3a1808" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#7a4820"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#7a4820"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#c49060" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#3a1808" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#b87060" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#b87060" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#c49060" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/></svg>`},
{id:'oracle',nameEn:'The Oracle',nameVi:'Tiên Tri',cat:'archetype',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#d0d8e8"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#c0c8e0"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#dcc8b0"/><defs><radialGradient id="fgoracle" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#f8f0e8"/><stop offset="100%" stop-color="#dcc8b0"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#dcc8b0"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#dcc8b0"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgoracle)"/><path d="M18 26Q18 13 32 11Q46 13 46 26Q44 16 32 16Q20 16 18 26Z" fill="#e0dcd0"/><path d="M17 24Q14 32 15 50Q18 48 18 36Z" fill="#c8d0e0" opacity=".7"/><path d="M47 24Q50 32 49 50Q46 48 46 36Z" fill="#c8d0e0" opacity=".7"/><path d="M17 24Q32 18 47 24" stroke="#c8d0e0" stroke-width="3" fill="none" opacity=".8"/><path d="M23 13Q30 9 41 12" stroke="#fff" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#9098a8" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#9098a8" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#6080a0"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#6080a0"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#dcc8b0" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#9098a8" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#9090a0" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#9090a0" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#dcc8b0" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><circle cx="50" cy="10" r="4" fill="#d0d8f0" opacity=".7"/><circle cx="50" cy="10" r="2.5" fill="#b0bcd8" opacity=".8"/><path d="M46 10Q50 6 54 10Q50 14 46 10Z" fill="#d0d8f0" opacity=".4"/></svg>`},
{id:'warrior',nameEn:'The Warrior',nameVi:'Chiến Binh',cat:'archetype',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1a1a18"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#282820"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#a07850"/><defs><radialGradient id="fgwarrior" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#d4b090"/><stop offset="100%" stop-color="#a07850"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#a07850"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#a07850"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgwarrior)"/><path d="M18 28Q17 14 32 12Q47 14 46 28Q44 16 32 16Q20 16 18 28Z" fill="#484848"/><path d="M18 28Q16 24 17 20Q18 15 18 28" fill="#484848"/><path d="M46 28Q48 24 47 20Q46 15 46 28" fill="#484848"/><path d="M29 12Q32 4 35 12" stroke="#c83820" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M31 12L31 24M33 12L33 24" stroke="#c83820" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#2a1808" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#2a1808" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#805030"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#805030"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#a07850" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#2a1808" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#a06040" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#a06040" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#a07850" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><path d="M48 10L50 4L52 10L56 12L52 14L50 20L48 14L44 12Z" fill="#c0a020" opacity=".7"/></svg>`},
{id:'dreamer',nameEn:'The Dreamer',nameVi:'Kẻ Mộng Mơ',cat:'archetype',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1a1040"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#261848"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#c0a080"/><defs><radialGradient id="fgdreamer" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#e8d8c8"/><stop offset="100%" stop-color="#c0a080"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#c0a080"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#c0a080"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgdreamer)"/><path d="M17 27Q17 12 32 10Q47 12 47 27Q45 15 32 15Q19 15 17 27Z" fill="#4a3060"/><path d="M17 27Q14 38 15 50" stroke="#4a3060" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M47 27Q50 38 49 50" stroke="#4a3060" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M15 34Q18 30 21 34Q18 38 15 34" fill="#4a3060"/><path d="M49 34Q46 30 43 34Q46 38 49 34" fill="#4a3060"/><path d="M23 12Q30 8 41 11" stroke="#7050a0" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#3a2050" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#3a2050" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#9080c0"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#9080c0"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#c0a080" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#3a2050" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#b090c0" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#b090c0" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#c0a080" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><path d="M47 8Q52 10 50 16Q56 11 52 8Q48 4 44 8Q46 8 47 8Z" fill="#c0a0e0" opacity=".7"/><circle cx="20" cy="12" r="1.5" fill="#b090d0" opacity=".6"/><circle cx="14" cy="18" r="1" fill="#b090d0" opacity=".5"/></svg>`},
{id:'trickster',nameEn:'Trickster',nameVi:'Kẻ Lừa Đảo',cat:'archetype',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#302008"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#483010"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#c0986a"/><defs><radialGradient id="fgtrickster" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#e8d0a0"/><stop offset="100%" stop-color="#c0986a"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#c0986a"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#c0986a"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgtrickster)"/><path d="M18 28Q16 16 20 12Q26 8 32 8Q38 8 44 12Q48 16 46 28Q42 14 32 14Q22 14 18 28Z" fill="#1a0a08"/><path d="M18 28Q14 20 15 14Q17 10 20 12" fill="#1a0a08"/><path d="M46 28Q50 20 49 14Q47 10 44 12" fill="#1a0a08"/><path d="M19 18Q17 14 19 12M25 14Q22 10 25 9M39 14Q42 10 39 9M45 18Q47 14 45 12" stroke="#402010" stroke-width="1.2" fill="none" stroke-linecap="round" opacity=".5"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#3a1808" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#3a1808" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#80a020"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#80a020"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#c0986a" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#3a1808" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#c06840" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#c06840" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#c0986a" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><path d="M47 8L50 4L53 8L56 5L54 10L57 12L53 11L50 15L47 11L43 12L46 10L44 5Z" fill="#c0a820" opacity=".6"/></svg>`},
{id:'seer',nameEn:'The Seer',nameVi:'Tiên Tri Sĩ',cat:'archetype',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0c1830"/><ellipse cx="32" cy="72" rx="30" ry="16" fill="#101c38"/><rect x="28.5" y="48" width="7" height="9" rx="3" fill="#909898"/><defs><radialGradient id="fgseer" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#c8d0d8"/><stop offset="100%" stop-color="#909898"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#909898"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#909898"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgseer)"/><path d="M18 25Q16 18 20 14Q26 10 32 10Q38 10 44 14Q48 18 46 25Q44 15 32 15Q20 15 18 25Z" fill="#101828"/><path d="M18 25Q15 35 16 48Q22 52 22 45Q18 38 18 25" fill="#101828"/><path d="M46 25Q49 35 48 48Q42 52 42 45Q46 38 46 25" fill="#101828"/><path d="M23 12Q30 8 41 11" stroke="#2a3848" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><path d="M21.5 26.5Q25.5 24.5 29 26.5" stroke="#202830" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M35 26.5Q38.5 24.5 42.5 26.5" stroke="#202830" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="25.5" cy="31.5" r="1.9" fill="#e0e8f8"/><circle cx="25.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="26.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff"/><circle cx="38.5" cy="31.5" r="1.9" fill="#e0e8f8"/><circle cx="38.5" cy="31.5" r="1.0" fill="#140a04"/><circle cx="39.6" cy="30.7" r="0.65" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#1a0a04" stroke-width="0.8" fill="none"/><path d="M32 35Q31 38.5 30 39.5Q32 40.5 34 39.5Q33 38.5 32 35" fill="#909898" opacity=".28"/><path d="M30 39.5Q32 40.5 34 39.5" stroke="#202830" stroke-width="0.7" fill="none" opacity=".4"/><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#708090" opacity=".95"/><path d="M27 43Q32 41.5 37 43" fill="#708090" opacity=".6"/><path d="M30 43Q32 43.8 34 43" stroke="#909898" stroke-width="0.5" fill="none" opacity=".4"/><ellipse cx="19" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><ellipse cx="45" cy="37" rx="3" ry="2" fill="#e06050" opacity=".10"/><circle cx="50" cy="11" r="5" fill="none" stroke="#4060a0" stroke-width="1.5"/><circle cx="50" cy="11" r="3" fill="#2040a0" opacity=".6"/><circle cx="50" cy="11" r="1.5" fill="#80a0e0"/><circle cx="50.8" cy="10.2" r=".6" fill="#fff" opacity=".8"/></svg>`},
// ---- GREEK CREATURES ----
{id:'hydra',nameEn:'Hydra',nameVi:'Hydra',cat:'creature',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0d2010"/><ellipse cx="32" cy="56" rx="28" ry="14" fill="#0a1a0c"/><!-- necks --><path d="M20 50Q18 38 15 28" stroke="#2a5a20" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M26 52Q26 36 20 22" stroke="#3a6a28" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M32 53Q32 36 32 20" stroke="#2a5a20" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M38 52Q38 36 44 22" stroke="#3a6a28" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M44 50Q46 38 49 28" stroke="#2a5a20" stroke-width="5" fill="none" stroke-linecap="round"/><!-- heads left cluster --><ellipse cx="14" cy="24" rx="8" ry="6" fill="#2a5018"/><ellipse cx="14" cy="24" rx="6" ry="4.5" fill="#3a6828"/><ellipse cx="11" cy="23" rx="2.5" ry="2" fill="#f8e060"/><circle cx="11" cy="23" r="1.1" fill="#1a0a00"/><circle cx="11.7" cy="22.4" r=".45" fill="#fff" opacity=".8"/><ellipse cx="17" cy="23" rx="2.5" ry="2" fill="#f8e060"/><circle cx="17" cy="23" r="1.1" fill="#1a0a00"/><circle cx="17.7" cy="22.4" r=".45" fill="#fff" opacity=".8"/><path d="M10 27Q14 29 18 27" stroke="#1a3010" stroke-width="1.2" fill="none"/><path d="M12 27L11 30M14 28L14 31M16 27L17 30" stroke="#c03020" stroke-width="1.2" fill="none" stroke-linecap="round"/><!-- head center --><ellipse cx="32" cy="16" rx="9" ry="7" fill="#2a5018"/><ellipse cx="32" cy="16" rx="7" ry="5.5" fill="#3a6828"/><ellipse cx="28.5" cy="15" rx="2.8" ry="2.2" fill="#f8e060"/><circle cx="28.5" cy="15" r="1.3" fill="#1a0a00"/><circle cx="29.3" cy="14.3" r=".5" fill="#fff" opacity=".8"/><ellipse cx="35.5" cy="15" rx="2.8" ry="2.2" fill="#f8e060"/><circle cx="35.5" cy="15" r="1.3" fill="#1a0a00"/><circle cx="36.3" cy="14.3" r=".5" fill="#fff" opacity=".8"/><path d="M28 19Q32 21.5 36 19" stroke="#1a3010" stroke-width="1.3" fill="none"/><path d="M30 20L29 23M32 21L32 24M34 20L35 23" stroke="#c03020" stroke-width="1.2" fill="none" stroke-linecap="round"/><!-- head right cluster --><ellipse cx="50" cy="24" rx="8" ry="6" fill="#2a5018"/><ellipse cx="50" cy="24" rx="6" ry="4.5" fill="#3a6828"/><ellipse cx="47" cy="23" rx="2.5" ry="2" fill="#f8e060"/><circle cx="47" cy="23" r="1.1" fill="#1a0a00"/><circle cx="47.7" cy="22.4" r=".45" fill="#fff" opacity=".8"/><ellipse cx="53" cy="23" rx="2.5" ry="2" fill="#f8e060"/><circle cx="53" cy="23" r="1.1" fill="#1a0a00"/><circle cx="53.7" cy="22.4" r=".45" fill="#fff" opacity=".8"/><path d="M46 27Q50 29 54 27" stroke="#1a3010" stroke-width="1.2" fill="none"/><path d="M48 27L47 30M50 28L50 31M52 27L53 30" stroke="#c03020" stroke-width="1.2" fill="none" stroke-linecap="round"/><!-- scales pattern on necks --><path d="M20 44Q18 40 17 36M26 47Q25 41 23 35M32 48Q32 42 32 36M38 47Q39 41 41 35M44 44Q46 40 47 36" stroke="#408030" stroke-width="1" fill="none" opacity=".5"/></svg>`},
{id:'cerberus',nameEn:'Cerberus',nameVi:'Cerberus',cat:'creature',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#150808"/><ellipse cx="32" cy="58" rx="28" ry="12" fill="#1e0a08"/><!-- hellfire glow --><ellipse cx="32" cy="56" rx="26" ry="10" fill="#c03010" opacity=".18"/><!-- left head --><ellipse cx="14" cy="32" rx="10" ry="9" fill="#2a1818"/><ellipse cx="14" cy="32" rx="8.5" ry="7.5" fill="#3a2020"/><!-- left ears --><path d="M7 25Q5 18 10 20Q10 26 7 25Z" fill="#2a1818"/><path d="M21 25Q23 18 18 20Q18 26 21 25Z" fill="#2a1818"/><ellipse cx="9.5" cy="31" rx="2.2" ry="2" fill="#d04020"/><circle cx="9.5" cy="31" r="1.0" fill="#140404"/><circle cx="10.2" cy="30.4" r=".4" fill="#fff" opacity=".8"/><ellipse cx="18.5" cy="31" rx="2.2" ry="2" fill="#d04020"/><circle cx="18.5" cy="31" r="1.0" fill="#140404"/><circle cx="19.2" cy="30.4" r=".4" fill="#fff" opacity=".8"/><path d="M10 37Q14 39.5 18 37" stroke="#1a0808" stroke-width="1.5" fill="none"/><path d="M11 37.5L10 41M14 38.5L14 42M17 37.5L18 41" stroke="#e03020" stroke-width="1.5" fill="none" stroke-linecap="round"/><!-- center head (largest) --><ellipse cx="32" cy="27" rx="12" ry="11" fill="#2e1c1c"/><ellipse cx="32" cy="27" rx="10.5" ry="9.5" fill="#3e2828"/><!-- center ears --><path d="M22 18Q19 10 25 13Q26 19 22 18Z" fill="#2a1818"/><path d="M42 18Q45 10 39 13Q38 19 42 18Z" fill="#2a1818"/><ellipse cx="27.5" cy="26" rx="2.8" ry="2.5" fill="#c83020"/><circle cx="27.5" cy="26" r="1.3" fill="#140404"/><circle cx="28.4" cy="25.2" r=".55" fill="#fff" opacity=".8"/><ellipse cx="36.5" cy="26" rx="2.8" ry="2.5" fill="#c83020"/><circle cx="36.5" cy="26" r="1.3" fill="#140404"/><circle cx="37.4" cy="25.2" r=".55" fill="#fff" opacity=".8"/><path d="M27 32Q32 35 37 32" stroke="#1a0808" stroke-width="1.6" fill="none"/><path d="M28 33L27 37M32 34.5L32 38.5M36 33L37 37" stroke="#e03020" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M25 22Q29 20 35 20Q39 22 40 25" stroke="#c04030" stroke-width="1" fill="none" opacity=".5"/><!-- right head --><ellipse cx="50" cy="32" rx="10" ry="9" fill="#2a1818"/><ellipse cx="50" cy="32" rx="8.5" ry="7.5" fill="#3a2020"/><path d="M43 25Q41 18 46 20Q46 26 43 25Z" fill="#2a1818"/><path d="M57 25Q59 18 54 20Q54 26 57 25Z" fill="#2a1818"/><ellipse cx="45.5" cy="31" rx="2.2" ry="2" fill="#d04020"/><circle cx="45.5" cy="31" r="1.0" fill="#140404"/><circle cx="46.2" cy="30.4" r=".4" fill="#fff" opacity=".8"/><ellipse cx="54.5" cy="31" rx="2.2" ry="2" fill="#d04020"/><circle cx="54.5" cy="31" r="1.0" fill="#140404"/><circle cx="55.2" cy="30.4" r=".4" fill="#fff" opacity=".8"/><path d="M46 37Q50 39.5 54 37" stroke="#1a0808" stroke-width="1.5" fill="none"/><path d="M47 37.5L46 41M50 38.5L50 42M53 37.5L54 41" stroke="#e03020" stroke-width="1.5" fill="none" stroke-linecap="round"/><!-- chain collar center --><path d="M22 36Q32 39 42 36" stroke="#a08020" stroke-width="2" fill="none"/><circle cx="27" cy="37.5" r="1.5" fill="#c0a030"/><circle cx="32" cy="39" r="1.5" fill="#c0a030"/><circle cx="37" cy="37.5" r="1.5" fill="#c0a030"/></svg>`},
{id:'chimera',nameEn:'Chimera',nameVi:'Chimera',cat:'creature',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#2a1008"/><ellipse cx="32" cy="58" rx="28" ry="12" fill="#201008"/><!-- mane --><path d="M14 30Q10 20 14 12Q18 8 20 14Q16 20 14 30Z" fill="#c07820"/><path d="M18 24Q16 14 20 10Q24 8 24 16Q20 20 18 24Z" fill="#d08a28"/><path d="M50 30Q54 20 50 12Q46 8 44 14Q48 20 50 30Z" fill="#c07820"/><path d="M46 24Q48 14 44 10Q40 8 40 16Q44 20 46 24Z" fill="#d08a28"/><path d="M24 14Q28 8 32 8Q36 8 40 14Q36 12 32 12Q28 12 24 14Z" fill="#b06818"/><!-- lion face --><ellipse cx="32" cy="32" rx="15" ry="14" fill="#d48a38"/><ellipse cx="32" cy="32" rx="13" ry="12" fill="#e0a050"/><!-- goat horns on top --><path d="M24 20Q22 12 26 10Q27 16 24 20Z" fill="#d0c090"/><path d="M40 20Q42 12 38 10Q37 16 40 20Z" fill="#d0c090"/><!-- lion eyes --><ellipse cx="26" cy="30" rx="3.5" ry="2.8" fill="#fff8e0"/><circle cx="26" cy="30" r="2" fill="#c08020"/><circle cx="26" cy="30" r="1.1" fill="#180800"/><circle cx="26.8" cy="29.3" r=".5" fill="#fff" opacity=".9"/><ellipse cx="38" cy="30" rx="3.5" ry="2.8" fill="#fff8e0"/><circle cx="38" cy="30" r="2" fill="#c08020"/><circle cx="38" cy="30" r="1.1" fill="#180800"/><circle cx="38.8" cy="29.3" r=".5" fill="#fff" opacity=".9"/><!-- nose --><ellipse cx="32" cy="36" rx="3" ry="2.2" fill="#b07040"/><ellipse cx="30.5" cy="36.5" rx="1.2" ry=".9" fill="#301000" opacity=".5"/><ellipse cx="33.5" cy="36.5" rx="1.2" ry=".9" fill="#301000" opacity=".5"/><!-- whisker dots --><circle cx="23" cy="37" r=".8" fill="#a06828"/><circle cx="20" cy="38" r=".8" fill="#a06828"/><circle cx="23" cy="39" r=".8" fill="#a06828"/><circle cx="41" cy="37" r=".8" fill="#a06828"/><circle cx="44" cy="38" r=".8" fill="#a06828"/><circle cx="41" cy="39" r=".8" fill="#a06828"/><!-- serpent tail head emerging bottom --><path d="M40 50Q44 44 48 42Q52 44 50 48Q46 48 44 52Z" fill="#2a6020"/><ellipse cx="46" cy="44" rx="4" ry="3" fill="#3a7030"/><ellipse cx="44.5" cy="43.5" rx="1.5" ry="1.3" fill="#f8e060"/><circle cx="44.5" cy="43.5" r=".7" fill="#180800"/><path d="M44 47Q46 48.5 48 47" stroke="#1a3010" stroke-width="1" fill="none"/><path d="M45 47.5L44.5 50M46.5 48L46.5 51" stroke="#c03020" stroke-width="1" fill="none" stroke-linecap="round"/><!-- mouth --><path d="M26 40Q32 44 38 40Q35 42 32 43Q29 42 26 40Z" fill="#c03820"/><path d="M26 40Q32 38 38 40" stroke="#a02818" stroke-width=".8" fill="none"/></svg>`},
{id:'minotaur',nameEn:'Minotaur',nameVi:'Minotaur',cat:'creature',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1a1008"/><ellipse cx="32" cy="60" rx="28" ry="12" fill="#140c08"/><!-- bull neck/shoulders --><ellipse cx="32" cy="62" rx="24" ry="16" fill="#3a2010"/><rect x="18" y="48" width="28" height="18" rx="8" fill="#3a2010"/><!-- bull ears --><ellipse cx="12" cy="30" rx="6" ry="4" fill="#4a2818"/><ellipse cx="12" cy="30" rx="4" ry="2.8" fill="#6a3820"/><ellipse cx="52" cy="30" rx="6" ry="4" fill="#4a2818"/><ellipse cx="52" cy="30" rx="4" ry="2.8" fill="#6a3820"/><!-- horns --><path d="M20 22Q12 10 8 6Q10 14 18 24" fill="#d0c080"/><path d="M44 22Q52 10 56 6Q54 14 46 24" fill="#d0c080"/><path d="M20 22Q14 12 10 8" stroke="#e0d090" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><path d="M44 22Q50 12 54 8" stroke="#e0d090" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".5"/><!-- bull face --><ellipse cx="32" cy="36" rx="16" ry="17" fill="#4a2818"/><ellipse cx="32" cy="35" rx="14" ry="15" fill="#5a3020"/><!-- bull snout --><ellipse cx="32" cy="44" rx="9" ry="6" fill="#3a1c10"/><ellipse cx="28.5" cy="44.5" rx="2.5" ry="2" fill="#1a0a06" opacity=".8"/><ellipse cx="35.5" cy="44.5" rx="2.5" ry="2" fill="#1a0a06" opacity=".8"/><!-- bull eyes — small, deep-set --><ellipse cx="25" cy="33" rx="3.5" ry="3" fill="#1a0c08"/><ellipse cx="25" cy="33" rx="3" ry="2.5" fill="#2a1410"/><ellipse cx="25" cy="33" rx="2" ry="1.8" fill="#c04020"/><circle cx="25" cy="33" r="1.1" fill="#080402"/><circle cx="25.7" cy="32.3" r=".5" fill="#fff" opacity=".7"/><ellipse cx="39" cy="33" rx="3.5" ry="3" fill="#1a0c08"/><ellipse cx="39" cy="33" rx="3" ry="2.5" fill="#2a1410"/><ellipse cx="39" cy="33" rx="2" ry="1.8" fill="#c04020"/><circle cx="39" cy="33" r="1.1" fill="#080402"/><circle cx="39.7" cy="32.3" r=".5" fill="#fff" opacity=".7"/><!-- brow ridge --><path d="M21 28Q25 26 29 28" stroke="#3a1808" stroke-width="2.5" fill="none" stroke-linecap="round"/><path d="M35 28Q39 26 43 28" stroke="#3a1808" stroke-width="2.5" fill="none" stroke-linecap="round"/><!-- chain/ring in nose --><circle cx="32" cy="44" r="2.5" fill="none" stroke="#c0a030" stroke-width="1.8"/><rect x="31" y="43" width="2" height="2.5" fill="#c0a030"/><!-- labyrinth mark on forehead --><path d="M29 22Q32 20 35 22M30 22Q32 24 34 22" stroke="#8a5028" stroke-width=".8" fill="none"/></svg>`},
{id:'sphinx',nameEn:'Sphinx',nameVi:'Nhân Sư',cat:'creature',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#8a6010"/><ellipse cx="32" cy="60" rx="30" ry="14" fill="#7a5008"/><!-- desert sun halo --><circle cx="32" cy="10" r="16" fill="#f0c020" opacity=".12"/><!-- nemes headdress (pharaoh cloth) --><path d="M16 26Q14 18 18 12Q24 8 32 8Q40 8 46 12Q50 18 48 26Q44 16 32 16Q20 16 16 26Z" fill="#d4a820"/><path d="M16 26Q12 36 14 52" stroke="#c09010" stroke-width="6" fill="none" stroke-linecap="round"/><path d="M48 26Q52 36 50 52" stroke="#c09010" stroke-width="6" fill="none" stroke-linecap="round"/><!-- headdress stripes --><path d="M16 26Q32 22 48 26" stroke="#1a1408" stroke-width="1.2" fill="none"/><path d="M15 30Q32 26 49 30" stroke="#1a1408" stroke-width="1.2" fill="none"/><path d="M14 35Q32 31 50 35" stroke="#1a1408" stroke-width="1.2" fill="none"/><!-- golden uraeus cobra on forehead --><path d="M30 14Q32 10 34 14Q33 18 32 16Q31 18 30 14Z" fill="#c03020"/><path d="M31 12Q32 8 33 12" stroke="#f0c020" stroke-width="1.5" fill="none" stroke-linecap="round"/><!-- face --><defs><radialGradient id="fgsphinx" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#f4d8a0"/><stop offset="100%" stop-color="#c8a060"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#c8a060"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#c8a060"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgsphinx)"/><!-- kohl-lined eyes --><path d="M22 29Q26 27 30 29" stroke="#1a0808" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M34 29Q38 27 42 29" stroke="#1a0808" stroke-width="2" fill="none" stroke-linecap="round"/><ellipse cx="26" cy="31.5" rx="3.5" ry="2.6" fill="#fff8e8"/><circle cx="26" cy="31.5" r="1.9" fill="#806020"/><circle cx="26" cy="31.5" r="1.0" fill="#0a0600"/><circle cx="26.8" cy="30.7" r=".6" fill="#fff" opacity=".9"/><path d="M22 30.5Q26 28.8 30 30.5" stroke="#1a0808" stroke-width=".7" fill="none"/><path d="M30 30.5Q30 32 32 32" stroke="#1a0808" stroke-width=".8" fill="none" stroke-linecap="round"/><ellipse cx="38" cy="31.5" rx="3.5" ry="2.6" fill="#fff8e8"/><circle cx="38" cy="31.5" r="1.9" fill="#806020"/><circle cx="38" cy="31.5" r="1.0" fill="#0a0600"/><circle cx="38.8" cy="30.7" r=".6" fill="#fff" opacity=".9"/><path d="M34 30.5Q38 28.8 42 30.5" stroke="#1a0808" stroke-width=".7" fill="none"/><path d="M34 30.5Q34 32 32 32" stroke="#1a0808" stroke-width=".8" fill="none" stroke-linecap="round"/><!-- nose --><path d="M32 35Q31 38 30 39Q32 40 34 39Q33 38 32 35" fill="#c8a060" opacity=".3"/><!-- lips --><path d="M27 43Q32 46 37 43Q34 44 32 44Q30 44 27 43Z" fill="#c06040" opacity=".9"/><path d="M27 43Q32 41.5 37 43" fill="#c06040" opacity=".5"/><!-- golden collar --><path d="M18 48Q32 52 46 48Q44 50 32 51Q20 50 18 48Z" fill="#c8a020"/><path d="M19 49Q32 53 45 49" stroke="#f0d040" stroke-width="1" fill="none" opacity=".6"/></svg>`},
{id:'cyclops',nameEn:'Cyclops',nameVi:'Cyclops',cat:'creature',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1a0c04"/><ellipse cx="32" cy="62" rx="28" ry="14" fill="#140a04"/><!-- cave torchlight --><ellipse cx="32" cy="58" rx="24" ry="10" fill="#e08020" opacity=".15"/><!-- body shoulders --><ellipse cx="32" cy="66" rx="26" ry="18" fill="#5a3820"/><rect x="14" y="52" width="36" height="18" rx="10" fill="#5a3820"/><!-- thick neck --><rect x="25" y="47" width="14" height="12" rx="6" fill="#6a4428"/><!-- head — enormous, primitive --><defs><radialGradient id="fgcyclops" cx="45%" cy="35%" r="65%"><stop offset="0%" stop-color="#c8906a"/><stop offset="100%" stop-color="#8a5030"/></radialGradient></defs><ellipse cx="10" cy="30" rx="3.5" ry="5" fill="#8a5030"/><ellipse cx="54" cy="30" rx="3.5" ry="5" fill="#8a5030"/><ellipse cx="32" cy="30" rx="19" ry="20" fill="url(#fgcyclops)"/><!-- huge single central eye --><ellipse cx="32" cy="28" rx="9" ry="7" fill="#fff8f0"/><ellipse cx="32" cy="28" rx="7.5" ry="5.8" fill="#c05820"/><circle cx="32" cy="28" r="4.5" fill="#3a1808"/><circle cx="34" cy="26" r="1.8" fill="#fff" opacity=".9"/><circle cx="36" cy="29" r=".8" fill="#fff" opacity=".5"/><!-- mono brow --><path d="M20 20Q32 16 44 20" stroke="#4a2a10" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M22 19Q32 15.5 42 19" stroke="#5a3818" stroke-width="2" fill="none" stroke-linecap="round"/><!-- nose — large, bulbous --><ellipse cx="32" cy="37" rx="5" ry="4" fill="#9a6040" opacity=".7"/><ellipse cx="29.5" cy="38" rx="2" ry="1.5" fill="#2a1008" opacity=".6"/><ellipse cx="34.5" cy="38" rx="2" ry="1.5" fill="#2a1008" opacity=".6"/><!-- mouth — sneering --><path d="M22 45Q32 50 42 45Q38 47 32 48Q26 47 22 45Z" fill="#8a3020"/><path d="M22 45Q32 43 42 45" stroke="#6a2018" stroke-width="1" fill="none"/><!-- teeth --><rect x="25" y="45.5" width="3" height="3.5" rx="1" fill="#f0e8d0"/><rect x="30" y="46" width="4" height="4" rx="1" fill="#f0e8d0"/><rect x="36" y="45.5" width="3" height="3.5" rx="1" fill="#f0e8d0"/><!-- matted hair --><path d="M14 22Q13 10 18 8Q20 16 14 22Z" fill="#3a1808"/><path d="M20 16Q20 8 25 7Q25 14 20 16Z" fill="#3a1808"/><path d="M50 22Q51 10 46 8Q44 16 50 22Z" fill="#3a1808"/><path d="M44 16Q44 8 39 7Q39 14 44 16Z" fill="#3a1808"/></svg>`},
{id:'pegasus',nameEn:'Pegasus',nameVi:'Pegasus',cat:'creature',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#e8f0ff"/><ellipse cx="32" cy="60" rx="28" ry="14" fill="#d0d8f0"/><!-- wings spreading --><path d="M8 30Q2 18 4 10Q10 20 12 30" fill="#fff"/><path d="M8 30Q0 22 2 14Q8 24 10 30" fill="#f0f4ff"/><path d="M4 22Q6 16 8 20Q6 24 4 22Z" fill="#e0e8ff"/><path d="M56 30Q62 18 60 10Q54 20 52 30" fill="#fff"/><path d="M56 30Q64 22 62 14Q56 24 54 30" fill="#f0f4ff"/><path d="M60 22Q58 16 56 20Q58 24 60 22Z" fill="#e0e8ff"/><!-- neck --><path d="M24 52Q28 42 30 36" stroke="#e8e0d8" stroke-width="8" fill="none" stroke-linecap="round"/><!-- horse head --><defs><radialGradient id="fgpeg" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#fff8f0"/><stop offset="100%" stop-color="#e0d8c8"/></radialGradient></defs><ellipse cx="36" cy="30" rx="14" ry="16" fill="url(#fgpeg)"/><!-- horse muzzle/snout extension --><ellipse cx="38" cy="42" rx="8" ry="6" fill="#ddd0c0"/><ellipse cx="36.5" cy="44" rx="3" ry="2.2" fill="#a89080" opacity=".7"/><ellipse cx="42" cy="44.5" rx="2.5" ry="2" fill="#a89080" opacity=".5"/><!-- horse eye — large, side-facing --><ellipse cx="28" cy="28" rx="4.5" ry="3.5" fill="#fff"/><ellipse cx="28" cy="28" rx="3.5" ry="2.8" fill="#60a0c0"/><circle cx="28" cy="28" r="2" fill="#100808"/><circle cx="29.2" cy="27" r=".9" fill="#fff" opacity=".9"/><!-- mane --><path d="M34 14Q36 8 40 6Q40 14 36 18Z" fill="#d8d0e8"/><path d="M30 16Q31 10 35 9Q34 16 30 16Z" fill="#e8e0f0"/><path d="M26 19Q26 12 30 12Q29 18 26 19Z" fill="#d0c8e0"/><!-- nostril --><ellipse cx="42" cy="42.5" rx="1.8" ry="1.3" fill="#b0908a" opacity=".7"/><!-- magic sparkle --><path d="M50 12L51 8L52 12L56 13L52 14L51 18L50 14L46 13Z" fill="#d0d8ff" opacity=".8"/><circle cx="8" cy="20" r="1.5" fill="#d0d8ff" opacity=".7"/><circle cx="56" cy="25" r="1" fill="#d0d8ff" opacity=".6"/></svg>`},
{id:'harpy',nameEn:'Harpy',nameVi:'Harpy',cat:'creature',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1a1028"/><ellipse cx="32" cy="60" rx="28" ry="14" fill="#14091e"/><!-- dark wings --><path d="M6 28Q2 16 6 8Q12 18 14 30" fill="#2a1848"/><path d="M6 28Q0 20 2 12Q8 20 10 28" fill="#1e1038"/><path d="M2 18Q5 13 7 18Q5 22 2 18Z" fill="#3a2058"/><path d="M58 28Q62 16 58 8Q52 18 50 30" fill="#2a1848"/><path d="M58 28Q64 20 62 12Q56 20 54 28" fill="#1e1038"/><path d="M62 18Q59 13 57 18Q59 22 62 18Z" fill="#3a2058"/><!-- feather details --><path d="M8 20Q10 16 12 20M10 25Q12 21 14 25" stroke="#4a2878" stroke-width="1" fill="none"/><path d="M56 20Q54 16 52 20M54 25Q52 21 50 25" stroke="#4a2878" stroke-width="1" fill="none"/><!-- neck/body --><rect x="26" y="48" width="12" height="14" rx="5" fill="#c09880"/><ellipse cx="32" cy="62" rx="20" ry="12" fill="#a08060"/><!-- face --><defs><radialGradient id="fgharpy" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#e8c8a0"/><stop offset="100%" stop-color="#b89060"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#b89060"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#b89060"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgharpy)"/><!-- wild hair/feathers on head --><path d="M18 26Q16 14 20 10Q22 18 18 26Z" fill="#2a1848"/><path d="M22 20Q22 10 27 9Q26 16 22 20Z" fill="#3a2060"/><path d="M32 18Q32 8 35 8Q34 15 32 18Z" fill="#2a1848"/><path d="M42 20Q42 10 37 9Q38 16 42 20Z" fill="#3a2060"/><path d="M46 26Q48 14 44 10Q42 18 46 26Z" fill="#2a1848"/><!-- fierce yellow eyes --><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fffae0"/><circle cx="25.5" cy="31.5" r="2" fill="#d0a010"/><circle cx="25.5" cy="31.5" r="1.1" fill="#0a0800"/><circle cx="26.3" cy="30.7" r=".55" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#0a0800" stroke-width=".8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fffae0"/><circle cx="38.5" cy="31.5" r="2" fill="#d0a010"/><circle cx="38.5" cy="31.5" r="1.1" fill="#0a0800"/><circle cx="39.3" cy="30.7" r=".55" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#0a0800" stroke-width=".8" fill="none"/><!-- beak-like nose, sharp --><path d="M32 35Q30 40 32 42Q34 40 32 35" fill="#b09050" opacity=".8"/><path d="M30 40Q32 42 34 40" stroke="#806030" stroke-width=".8" fill="none"/><!-- snarling mouth --><path d="M26 44Q32 48 38 44" stroke="#8a3020" stroke-width="1.5" fill="none"/><path d="M27 44Q32 43 37 44" stroke="#6a2018" stroke-width=".8" fill="none"/></svg>`},
{id:'scylla',nameEn:'Scylla',nameVi:'Scylla',cat:'creature',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#041428"/><!-- deep sea ripples --><ellipse cx="32" cy="58" rx="30" ry="10" fill="#082040" opacity=".8"/><path d="M4 52Q16 48 32 50Q48 48 60 52Q48 54 32 53Q16 54 4 52Z" fill="#0a2850"/><path d="M8 56Q20 52 32 54Q44 52 56 56Q44 58 32 57Q20 58 8 56Z" fill="#082040"/><!-- rock/base --><ellipse cx="32" cy="55" rx="22" ry="8" fill="#1a3050"/><!-- multiple serpent necks emanating from rocks --><path d="M16 54Q14 44 10 34Q12 28 16 24" stroke="#0a4060" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M22 54Q20 42 18 30Q20 22 22 18" stroke="#0c4e70" stroke-width="4.5" fill="none" stroke-linecap="round"/><path d="M28 54Q28 40 26 28Q28 20 30 14" stroke="#0a4060" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M36 54Q36 42 38 30Q40 22 42 16" stroke="#0c4e70" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M42 54Q44 44 48 34Q46 28 44 24" stroke="#0a4060" stroke-width="4.5" fill="none" stroke-linecap="round"/><!-- dog-head tentacles at body base --><circle cx="18" cy="53" r="3" fill="#0c3858"/><circle cx="46" cy="53" r="3" fill="#0c3858"/><!-- Heads - left --><ellipse cx="12" cy="22" rx="7.5" ry="6" fill="#0a4060"/><ellipse cx="12" cy="22" rx="6" ry="4.8" fill="#0e5878"/><ellipse cx="9.5" cy="21" rx="2.2" ry="1.8" fill="#80d0f0"/><circle cx="9.5" cy="21" r="1" fill="#040a10"/><circle cx="10.2" cy="20.4" r=".4" fill="#fff" opacity=".8"/><ellipse cx="14.5" cy="21" rx="2.2" ry="1.8" fill="#80d0f0"/><circle cx="14.5" cy="21" r="1" fill="#040a10"/><circle cx="15.2" cy="20.4" r=".4" fill="#fff" opacity=".8"/><path d="M9 25.5Q12 27.5 15 25.5" stroke="#042030" stroke-width="1.2" fill="none"/><path d="M10.5 25.5L10 28M12 26.5L12 29M13.5 25.5L14 28" stroke="#a03020" stroke-width="1.2" fill="none" stroke-linecap="round"/><!-- Head center-left --><ellipse cx="24" cy="16" rx="7.5" ry="6" fill="#0a4060"/><ellipse cx="24" cy="16" rx="6" ry="4.8" fill="#0e5878"/><ellipse cx="21.5" cy="15" rx="2.2" ry="1.8" fill="#80d0f0"/><circle cx="21.5" cy="15" r="1" fill="#040a10"/><circle cx="22.2" cy="14.4" r=".4" fill="#fff" opacity=".8"/><ellipse cx="26.5" cy="15" rx="2.2" ry="1.8" fill="#80d0f0"/><circle cx="26.5" cy="15" r="1" fill="#040a10"/><circle cx="27.2" cy="14.4" r=".4" fill="#fff" opacity=".8"/><path d="M21 19.5Q24 21.5 27 19.5" stroke="#042030" stroke-width="1.2" fill="none"/><path d="M22.5 19.5L22 22M24 20.5L24 23M25.5 19.5L26 22" stroke="#a03020" stroke-width="1.2" fill="none" stroke-linecap="round"/><!-- Head center --><ellipse cx="32" cy="11" rx="8" ry="6.5" fill="#0a4060"/><ellipse cx="32" cy="11" rx="6.5" ry="5.2" fill="#0e5878"/><ellipse cx="29" cy="10" rx="2.5" ry="2" fill="#90e0ff"/><circle cx="29" cy="10" r="1.1" fill="#040a10"/><circle cx="29.8" cy="9.4" r=".5" fill="#fff" opacity=".8"/><ellipse cx="35" cy="10" rx="2.5" ry="2" fill="#90e0ff"/><circle cx="35" cy="10" r="1.1" fill="#040a10"/><circle cx="35.8" cy="9.4" r=".5" fill="#fff" opacity=".8"/><path d="M29 14.5Q32 16.5 35 14.5" stroke="#042030" stroke-width="1.2" fill="none"/><path d="M30 14.5L29.5 17.5M32 15.5L32 18.5M34 14.5L34.5 17.5" stroke="#a03020" stroke-width="1.2" fill="none" stroke-linecap="round"/><!-- Head center-right --><ellipse cx="40" cy="14" rx="7.5" ry="6" fill="#0a4060"/><ellipse cx="40" cy="14" rx="6" ry="4.8" fill="#0e5878"/><ellipse cx="37.5" cy="13" rx="2.2" ry="1.8" fill="#80d0f0"/><circle cx="37.5" cy="13" r="1" fill="#040a10"/><circle cx="38.2" cy="12.4" r=".4" fill="#fff" opacity=".8"/><ellipse cx="42.5" cy="13" rx="2.2" ry="1.8" fill="#80d0f0"/><circle cx="42.5" cy="13" r="1" fill="#040a10"/><circle cx="43.2" cy="12.4" r=".4" fill="#fff" opacity=".8"/><path d="M37 17.5Q40 19.5 43 17.5" stroke="#042030" stroke-width="1.2" fill="none"/><path d="M38.5 17.5L38 20M40 18.5L40 21M41.5 17.5L42 20" stroke="#a03020" stroke-width="1.2" fill="none" stroke-linecap="round"/><!-- Head right --><ellipse cx="52" cy="20" rx="7.5" ry="6" fill="#0a4060"/><ellipse cx="52" cy="20" rx="6" ry="4.8" fill="#0e5878"/><ellipse cx="49.5" cy="19" rx="2.2" ry="1.8" fill="#80d0f0"/><circle cx="49.5" cy="19" r="1" fill="#040a10"/><circle cx="50.2" cy="18.4" r=".4" fill="#fff" opacity=".8"/><ellipse cx="54.5" cy="19" rx="2.2" ry="1.8" fill="#80d0f0"/><circle cx="54.5" cy="19" r="1" fill="#040a10"/><circle cx="55.2" cy="18.4" r=".4" fill="#fff" opacity=".8"/><path d="M49 23.5Q52 25.5 55 23.5" stroke="#042030" stroke-width="1.2" fill="none"/><path d="M50.5 23.5L50 26M52 24.5L52 27M53.5 23.5L54 26" stroke="#a03020" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg>`},
{id:'typhon',nameEn:'Typhon',nameVi:'Typhon',cat:'creature',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1a0408"/><!-- volcanic glow --><ellipse cx="32" cy="60" rx="30" ry="12" fill="#c03010" opacity=".25"/><ellipse cx="32" cy="64" rx="28" ry="14" fill="#2a0808"/><!-- serpentine lower body/legs --><path d="M18 60Q14 48 16 38" stroke="#4a1020" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M26 62Q22 50 20 40" stroke="#3a0c18" stroke-width="6" fill="none" stroke-linecap="round"/><path d="M38 62Q42 50 44 40" stroke="#4a1020" stroke-width="6" fill="none" stroke-linecap="round"/><path d="M46 60Q50 48 48 38" stroke="#3a0c18" stroke-width="7" fill="none" stroke-linecap="round"/><!-- coil tips / snake tails --><path d="M16 38Q12 32 14 28Q18 32 16 38Z" fill="#4a1020"/><path d="M48 38Q52 32 50 28Q46 32 48 38Z" fill="#4a1020"/><!-- huge torso/body --><ellipse cx="32" cy="58" rx="22" ry="18" fill="#3a1010"/><rect x="16" y="42" width="32" height="20" rx="10" fill="#3a1010"/><!-- thick neck --><rect x="24" y="40" width="16" height="12" rx="7" fill="#4a1818"/><!-- head — titan, fierce --><defs><radialGradient id="fgtyphon" cx="45%" cy="35%" r="65%"><stop offset="0%" stop-color="#c07050"/><stop offset="100%" stop-color="#7a2818"/></radialGradient></defs><ellipse cx="10" cy="28" rx="4" ry="5.5" fill="#7a2818"/><ellipse cx="54" cy="28" rx="4" ry="5.5" fill="#7a2818"/><ellipse cx="32" cy="28" rx="20" ry="21" fill="url(#fgtyphon)"/><!-- serpent wings emerging head-sides --><path d="M12 22Q6 14 8 8Q14 16 14 24" fill="#3a0810" opacity=".8"/><path d="M52 22Q58 14 56 8Q50 16 50 24" fill="#3a0810" opacity=".8"/><!-- volcanic eyes glowing --><ellipse cx="24" cy="26" rx="5" ry="4" fill="#ff8020" opacity=".9"/><ellipse cx="24" cy="26" rx="3.8" ry="3" fill="#ff4010"/><circle cx="24" cy="26" r="2.2" fill="#1a0400"/><circle cx="25.2" cy="24.8" r=".9" fill="#ffb040" opacity=".8"/><ellipse cx="40" cy="26" rx="5" ry="4" fill="#ff8020" opacity=".9"/><ellipse cx="40" cy="26" rx="3.8" ry="3" fill="#ff4010"/><circle cx="40" cy="26" r="2.2" fill="#1a0400"/><circle cx="41.2" cy="24.8" r=".9" fill="#ffb040" opacity=".8"/><!-- smoke/fume from head --><circle cx="20" cy="10" r="4" fill="#404040" opacity=".4"/><circle cx="24" cy="6" r="3" fill="#505050" opacity=".3"/><circle cx="44" cy="10" r="4" fill="#404040" opacity=".4"/><circle cx="40" cy="6" r="3" fill="#505050" opacity=".3"/><!-- brow ridge --><path d="M18 20Q24 17 30 20" stroke="#4a1808" stroke-width="3.5" fill="none" stroke-linecap="round"/><path d="M34 20Q40 17 46 20" stroke="#4a1808" stroke-width="3.5" fill="none" stroke-linecap="round"/><!-- nose lava --><path d="M32 33Q30 38 31 40Q32 41 33 40Q34 38 32 33" fill="#8a2010" opacity=".7"/><!-- open roaring mouth --><path d="M20 40Q32 47 44 40Q40 44 32 46Q24 44 20 40Z" fill="#9a1808"/><path d="M20 40Q32 37.5 44 40" stroke="#7a1010" stroke-width="1" fill="none"/><rect x="24" y="40.5" width="4" height="4.5" rx="1.5" fill="#f0e0d0"/><rect x="30" y="41" width="4" height="5" rx="1.5" fill="#f0e0d0"/><rect x="36" y="40.5" width="4" height="4.5" rx="1.5" fill="#f0e0d0"/><!-- lava crack on forehead --><path d="M32 12Q30 18 32 22Q34 18 32 12" stroke="#f04010" stroke-width="1.2" fill="none" opacity=".7"/></svg>`},
{id:'griffin',nameEn:'Griffin',nameVi:'Griffin',cat:'creature',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#3a2808"/><ellipse cx="32" cy="60" rx="28" ry="14" fill="#2a1c08"/><!-- wings --><path d="M6 28Q2 16 6 8Q12 20 12 30" fill="#8a6020"/><path d="M6 28Q0 18 2 10Q8 22 10 30" fill="#6a4818"/><path d="M58 28Q62 16 58 8Q52 20 52 30" fill="#8a6020"/><path d="M58 28Q64 18 62 10Q56 22 54 30" fill="#6a4818"/><!-- feather detail --><path d="M8 18Q10 14 12 18M8 24Q10 20 12 24" stroke="#a07830" stroke-width="1" fill="none"/><path d="M56 18Q54 14 52 18M56 24Q54 20 52 24" stroke="#a07830" stroke-width="1" fill="none"/><!-- eagle neck feathers --><path d="M20 46Q18 38 20 32" stroke="#c8a040" stroke-width="4.5" fill="none" stroke-linecap="round"/><path d="M22 48Q20 40 22 34" stroke="#b89030" stroke-width="3.5" fill="none" stroke-linecap="round"/><!-- eagle head --><defs><radialGradient id="fggriff" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#f0d880"/><stop offset="100%" stop-color="#c0a030"/></radialGradient></defs><ellipse cx="32" cy="28" rx="16" ry="15" fill="url(#fggriff)"/><!-- white head cap --><ellipse cx="32" cy="22" rx="14" ry="10" fill="#f8f4e8"/><path d="M18 22Q20 14 32 12Q44 14 46 22Q42 16 32 16Q22 16 18 22Z" fill="#fff8f0"/><!-- beak --><path d="M30 34Q32 30 34 34Q36 38 32 40Q28 38 30 34Z" fill="#e0b020"/><path d="M30 34Q32 36 34 34Q32 38 30 34Z" fill="#c09010" opacity=".5"/><!-- eagle eyes, fierce gold --><ellipse cx="25.5" cy="28" rx="4" ry="3.2" fill="#1a1008"/><ellipse cx="25.5" cy="28" rx="3.3" ry="2.6" fill="#d0a010"/><circle cx="25.5" cy="28" r="1.6" fill="#080400"/><circle cx="26.4" cy="27.2" r=".7" fill="#fff" opacity=".9"/><!-- eye ring gold --><path d="M21.8 26Q25.5 24 29.2 26" stroke="#a07808" stroke-width="1.2" fill="none"/><ellipse cx="38.5" cy="28" rx="4" ry="3.2" fill="#1a1008"/><ellipse cx="38.5" cy="28" rx="3.3" ry="2.6" fill="#d0a010"/><circle cx="38.5" cy="28" r="1.6" fill="#080400"/><circle cx="39.4" cy="27.2" r=".7" fill="#fff" opacity=".9"/><path d="M34.8 26Q38.5 24 42.2 26" stroke="#a07808" stroke-width="1.2" fill="none"/><!-- ear tufts --><path d="M21 18Q18 10 22 12Q22 16 21 18Z" fill="#d0a020"/><path d="M43 18Q46 10 42 12Q42 16 43 18Z" fill="#d0a020"/><!-- lion body suggestion at base --><ellipse cx="32" cy="56" rx="20" ry="12" fill="#c08030"/><ellipse cx="32" cy="55" rx="18" ry="10" fill="#d09040"/><path d="M18 50Q22 44 26 48Q24 52 18 50Z" fill="#c08030"/><path d="M46 50Q42 44 38 48Q40 52 46 50Z" fill="#c08030"/></svg>`},
{id:'satyr',nameEn:'Satyr',nameVi:'Satyr',cat:'creature',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#2a3810"/><ellipse cx="32" cy="60" rx="28" ry="14" fill="#1e2c08"/><!-- goat ears --><path d="M16 30Q10 22 12 16Q16 18 18 28" fill="#c09060" opacity=".9"/><path d="M14 27Q10 20 12 16Q16 18 16 26" fill="#e8c0a0" opacity=".7"/><path d="M48 30Q54 22 52 16Q48 18 46 28" fill="#c09060" opacity=".9"/><path d="M50 27Q54 20 52 16Q48 18 48 26" fill="#e8c0a0" opacity=".7"/><!-- goat horns, curling --><path d="M22 20Q18 10 22 6Q26 10 24 18" fill="#d0c090"/><path d="M22 18Q19 12 22 8Q25 12 24 18" stroke="#b0a060" stroke-width="1" fill="none" opacity=".5"/><path d="M42 20Q46 10 42 6Q38 10 40 18" fill="#d0c090"/><path d="M42 18Q45 12 42 8Q39 12 40 18" stroke="#b0a060" stroke-width="1" fill="none" opacity=".5"/><!-- face — ruddy, joyful --><defs><radialGradient id="fgsatyr" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#f0c898"/><stop offset="100%" stop-color="#c09060"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#c09060"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#c09060"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fgsatyr)"/><!-- shaggy eyebrows --><path d="M21 26Q25 23.5 29 26" stroke="#4a2808" stroke-width="2.8" fill="none" stroke-linecap="round"/><path d="M35 26Q39 23.5 43 26" stroke="#4a2808" stroke-width="2.8" fill="none" stroke-linecap="round"/><!-- merry eyes --><ellipse cx="25.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff8e0"/><circle cx="25.5" cy="31.5" r="2" fill="#60a820"/><circle cx="25.5" cy="31.5" r="1" fill="#0a0800"/><circle cx="26.4" cy="30.7" r=".55" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#0a0800" stroke-width=".7" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.5" ry="2.6" fill="#fff8e0"/><circle cx="38.5" cy="31.5" r="2" fill="#60a820"/><circle cx="38.5" cy="31.5" r="1" fill="#0a0800"/><circle cx="39.4" cy="30.7" r=".55" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#0a0800" stroke-width=".7" fill="none"/><!-- snub nose --><ellipse cx="32" cy="37" rx="3.5" ry="2.8" fill="#c09060" opacity=".5"/><ellipse cx="30.5" cy="37.5" rx="1.4" ry="1" fill="#3a1808" opacity=".4"/><ellipse cx="33.5" cy="37.5" rx="1.4" ry="1" fill="#3a1808" opacity=".4"/><!-- big grin --><path d="M24 43Q32 49 40 43Q36 46 32 47Q28 46 24 43Z" fill="#c03820"/><path d="M24 43Q32 41 40 43" stroke="#a02818" stroke-width=".8" fill="none"/><rect x="29" y="43.5" width="6" height="4" rx="1.5" fill="#f0e0d0"/><!-- rosy cheeks --><ellipse cx="19" cy="37" rx="4" ry="3" fill="#e04050" opacity=".2"/><ellipse cx="45" cy="37" rx="4" ry="3" fill="#e04050" opacity=".2"/><!-- little beard tuft --><path d="M29 48Q32 52 35 48Q32 53 29 48Z" fill="#8a4820"/></svg>`},
{id:'centaur',nameEn:'Centaur',nameVi:'Nhân Mã',cat:'creature',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#2a1c08"/><ellipse cx="32" cy="62" rx="28" ry="12" fill="#1e1408"/><!-- horse body at bottom --><ellipse cx="32" cy="56" rx="24" ry="14" fill="#8a5820"/><ellipse cx="32" cy="54" rx="22" ry="12" fill="#a06828"/><!-- horse legs hint --><rect x="20" y="56" width="5" height="12" rx="2" fill="#8a5820"/><rect x="28" y="58" width="5" height="10" rx="2" fill="#8a5820"/><rect x="36" y="58" width="5" height="10" rx="2" fill="#8a5820"/><rect x="44" y="56" width="5" height="12" rx="2" fill="#8a5820"/><!-- horse tail --><path d="M52 52Q58 46 56 40Q50 46 52 52Z" fill="#6a3818"/><!-- human torso transition --><rect x="24" y="36" width="16" height="18" rx="6" fill="#d4a070"/><!-- arm/shoulder suggestion --><ellipse cx="18" cy="38" rx="5" ry="7" fill="#c89060" opacity=".8"/><ellipse cx="46" cy="38" rx="5" ry="7" fill="#c89060" opacity=".8"/><!-- head --><defs><radialGradient id="fgcent" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#f0d0a0"/><stop offset="100%" stop-color="#c89060"/></radialGradient></defs><ellipse cx="18" cy="31" rx="2.5" ry="3.5" fill="#c89060"/><ellipse cx="46" cy="31" rx="2.5" ry="3.5" fill="#c89060"/><ellipse cx="32" cy="25" rx="14" ry="15" fill="url(#fgcent)"/><!-- strong brow, warrior --><path d="M21 18Q25.5 15.5 29 18" stroke="#4a2808" stroke-width="2.5" fill="none" stroke-linecap="round"/><path d="M35 18Q38.5 15.5 43 18" stroke="#4a2808" stroke-width="2.5" fill="none" stroke-linecap="round"/><!-- eyes --><ellipse cx="25.5" cy="23.5" rx="3.5" ry="2.6" fill="#fff8e8"/><circle cx="25.5" cy="23.5" r="2" fill="#70a030"/><circle cx="25.5" cy="23.5" r="1.1" fill="#0a0600"/><circle cx="26.4" cy="22.7" r=".55" fill="#fff" opacity=".9"/><path d="M22 22Q25.5 20.4 29 22" stroke="#0a0800" stroke-width=".8" fill="none"/><ellipse cx="38.5" cy="23.5" rx="3.5" ry="2.6" fill="#fff8e8"/><circle cx="38.5" cy="23.5" r="2" fill="#70a030"/><circle cx="38.5" cy="23.5" r="1.1" fill="#0a0600"/><circle cx="39.4" cy="22.7" r=".55" fill="#fff" opacity=".9"/><path d="M35 22Q38.5 20.4 42 22" stroke="#0a0800" stroke-width=".8" fill="none"/><!-- nose --><path d="M32 27Q31 30 30 31Q32 32 34 31Q33 30 32 27" fill="#c89060" opacity=".3"/><!-- lips --><path d="M27 35Q32 38 37 35Q34 36 32 36Q30 36 27 35Z" fill="#b06850" opacity=".9"/><path d="M27 35Q32 33.5 37 35" fill="#b06850" opacity=".5"/><!-- beard --><path d="M26 37Q32 42 38 37Q36 40 32 42Q28 40 26 37Z" fill="#5a2c0e"/><!-- warrior headband --><path d="M18 15Q32 12 46 15" stroke="#c0a030" stroke-width="2.5" fill="none"/><path d="M20 14Q32 11 44 14" stroke="#e0c040" stroke-width="1" fill="none" opacity=".6"/></svg>`},
{id:'gorgon',nameEn:'Gorgon',nameVi:'Gorgon',cat:'creature',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0c1c08"/><ellipse cx="32" cy="60" rx="28" ry="14" fill="#081408"/><!-- serpentine hair in all directions --><path d="M18 28Q12 20 10 12Q14 18 16 28" stroke="#406820" stroke-width="2.5" fill="none" stroke-linecap="round"/><path d="M20 22Q16 12 18 8Q22 16 22 24" stroke="#508a28" stroke-width="2.5" fill="none" stroke-linecap="round"/><path d="M24 18Q22 8 26 6Q26 14 24 18" stroke="#406820" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M32 16Q32 6 33 4Q34 12 32 16" stroke="#508a28" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M40 18Q42 8 38 6Q38 14 40 18" stroke="#406820" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M44 22Q48 12 46 8Q42 16 42 24" stroke="#508a28" stroke-width="2.5" fill="none" stroke-linecap="round"/><path d="M46 28Q52 20 54 12Q50 18 48 28" stroke="#406820" stroke-width="2.5" fill="none" stroke-linecap="round"/><!-- snake tips --><circle cx="10" cy="11" r="2" fill="#60a030"/><circle cx="18" cy="7" r="1.8" fill="#50901c"/><circle cx="26" cy="5" r="1.8" fill="#60a030"/><circle cx="32" cy="3" r="1.8" fill="#50901c"/><circle cx="38" cy="5" r="1.8" fill="#60a030"/><circle cx="46" cy="7" r="1.8" fill="#50901c"/><circle cx="54" cy="11" r="2" fill="#60a030"/><!-- body/clothing --><rect x="24" y="48" width="16" height="16" rx="6" fill="#285020"/><ellipse cx="32" cy="62" rx="22" ry="14" fill="#204018"/><!-- face --><defs><radialGradient id="fggorgon" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#b8d098"/><stop offset="100%" stop-color="#788848"/></radialGradient></defs><ellipse cx="18" cy="33" rx="2.5" ry="3.5" fill="#788848"/><ellipse cx="46" cy="33" rx="2.5" ry="3.5" fill="#788848"/><ellipse cx="32" cy="33" rx="14" ry="15" fill="url(#fggorgon)"/><!-- petrifying golden eyes --><ellipse cx="25.5" cy="31.5" rx="3.8" ry="2.8" fill="#ffe870"/><circle cx="25.5" cy="31.5" r="2.2" fill="#c0a010"/><circle cx="25.5" cy="31.5" r="1.2" fill="#080800"/><circle cx="26.4" cy="30.7" r=".6" fill="#fff" opacity=".9"/><path d="M22 30Q25.5 28.4 29 30" stroke="#0a0800" stroke-width=".8" fill="none"/><ellipse cx="38.5" cy="31.5" rx="3.8" ry="2.8" fill="#ffe870"/><circle cx="38.5" cy="31.5" r="2.2" fill="#c0a010"/><circle cx="38.5" cy="31.5" r="1.2" fill="#080800"/><circle cx="39.4" cy="30.7" r=".6" fill="#fff" opacity=".9"/><path d="M35 30Q38.5 28.4 42 30" stroke="#0a0800" stroke-width=".8" fill="none"/><!-- tusks --><path d="M26 44L24 50" stroke="#f0e8d0" stroke-width="2.5" fill="none" stroke-linecap="round"/><path d="M38 44L40 50" stroke="#f0e8d0" stroke-width="2.5" fill="none" stroke-linecap="round"/><!-- mouth, menacing --><path d="M25 43Q32 47.5 39 43Q36 45 32 46Q28 45 25 43Z" fill="#a03020"/><path d="M25 43Q32 41.5 39 43" stroke="#801810" stroke-width="1" fill="none"/><!-- scales on cheeks --><path d="M19 33Q20 31 21 33Q20 35 19 33Z" fill="#608038" opacity=".6"/><path d="M43 33Q44 31 45 33Q44 35 43 33Z" fill="#608038" opacity=".6"/></svg>`},
{id:'phoenix',nameEn:'Phoenix',nameVi:'Phượng Hoàng',cat:'creature',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1a0800"/><!-- fire glow --><ellipse cx="32" cy="56" rx="28" ry="14" fill="#e06010" opacity=".25"/><ellipse cx="32" cy="60" rx="24" ry="12" fill="#c04008" opacity=".3"/><!-- sweeping wings of flame --><path d="M6 28Q2 14 8 6Q14 18 14 32" fill="#e06010"/><path d="M6 28Q0 16 4 8Q10 20 12 32" fill="#f08020"/><path d="M4 18Q8 10 10 16Q8 22 4 18Z" fill="#f0c020"/><path d="M10 10Q12 6 14 10Q12 14 10 10Z" fill="#f8e040"/><path d="M58 28Q62 14 56 6Q50 18 50 32" fill="#e06010"/><path d="M58 28Q64 16 60 8Q54 20 52 32" fill="#f08020"/><path d="M60 18Q56 10 54 16Q56 22 60 18Z" fill="#f0c020"/><path d="M54 10Q52 6 50 10Q52 14 54 10Z" fill="#f8e040"/><!-- tail feathers bottom --><path d="M28 52Q26 62 24 66Q28 58 32 56Q36 58 40 66Q38 62 36 52" fill="#e06010"/><path d="M30 52Q28 60 27 64Q31 57 32 54Q33 57 37 64Q36 60 34 52" fill="#f0a020"/><!-- body --><ellipse cx="32" cy="44" rx="12" ry="14" fill="#d04010"/><ellipse cx="32" cy="42" rx="10" ry="12" fill="#e06018"/><!-- neck plumage --><path d="M26 34Q28 28 32 26Q36 28 38 34Q34 30 32 30Q30 30 26 34Z" fill="#f08020"/><!-- head — noble eagle-like --><defs><radialGradient id="fgphoenix" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#f8d870"/><stop offset="100%" stop-color="#e09020"/></radialGradient></defs><ellipse cx="32" cy="26" rx="13" ry="12" fill="url(#fgphoenix)"/><!-- crest feathers fire --><path d="M26 18Q24 10 28 8Q28 14 26 18Z" fill="#f04010"/><path d="M30 16Q29 8 32 7Q32 12 30 16Z" fill="#f08020"/><path d="M34 16Q35 8 32 7Q32 12 34 16Z" fill="#f04010"/><path d="M38 18Q40 10 36 8Q36 14 38 18Z" fill="#f08020"/><!-- beak — curved, strong --><path d="M30 30Q32 27 34 30Q35 34 32 35Q29 34 30 30Z" fill="#e0a010"/><path d="M30 30Q32 32 34 30Q32 34 30 30Z" fill="#c08008" opacity=".6"/><!-- golden eye L --><ellipse cx="26" cy="25" rx="3.5" ry="2.8" fill="#fff8d0"/><circle cx="26" cy="25" r="2.2" fill="#f0a820"/><circle cx="26" cy="25" r="1.2" fill="#100800"/><circle cx="27" cy="24.2" r=".6" fill="#fff" opacity=".9"/><!-- eye ring --><path d="M22.5 23Q26 21 29.5 23" stroke="#a07008" stroke-width="1.2" fill="none"/><!-- golden eye R --><ellipse cx="38" cy="25" rx="3.5" ry="2.8" fill="#fff8d0"/><circle cx="38" cy="25" r="2.2" fill="#f0a820"/><circle cx="38" cy="25" r="1.2" fill="#100800"/><circle cx="39" cy="24.2" r=".6" fill="#fff" opacity=".9"/><path d="M34.5 23Q38 21 41.5 23" stroke="#a07008" stroke-width="1.2" fill="none"/><!-- ember sparks --><circle cx="10" cy="15" r="1.5" fill="#f8c020" opacity=".8"/><circle cx="54" cy="12" r="1" fill="#f8e040" opacity=".7"/><circle cx="50" cy="20" r="1.2" fill="#f8a020" opacity=".6"/><circle cx="14" cy="22" r="1" fill="#f8c020" opacity=".6"/></svg>`},
{id:'kraken',nameEn:'Kraken',nameVi:'Kraken',cat:'creature',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#020c18"/><!-- deep ocean --><ellipse cx="32" cy="58" rx="30" ry="12" fill="#041428"/><path d="M2 48Q16 44 32 46Q48 44 62 48Q48 50 32 50Q16 50 2 48Z" fill="#041828"/><!-- massive tentacles --><path d="M10 62Q8 50 10 38Q14 32 16 28" stroke="#0c3050" stroke-width="8" fill="none" stroke-linecap="round"/><path d="M20 64Q18 52 20 40Q22 32 24 26" stroke="#0e3858" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M44 64Q46 52 44 40Q42 32 40 26" stroke="#0c3050" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M54 62Q56 50 54 38Q50 32 48 28" stroke="#0e3858" stroke-width="8" fill="none" stroke-linecap="round"/><!-- tentacle curls --><path d="M16 28Q10 22 12 16Q18 20 16 28Z" fill="#0c3050"/><path d="M24 26Q18 18 22 12Q26 16 24 26Z" fill="#0e3858"/><path d="M40 26Q46 18 42 12Q38 16 40 26Z" fill="#0c3050"/><path d="M48 28Q54 22 52 16Q46 20 48 28Z" fill="#0e3858"/><!-- suction cups on tentacles --><circle cx="16" cy="34" r="2" fill="#1a4060" opacity=".8"/><circle cx="16" cy="40" r="2" fill="#1a4060" opacity=".8"/><circle cx="22" cy="32" r="1.8" fill="#1a4060" opacity=".8"/><circle cx="22" cy="38" r="1.8" fill="#1a4060" opacity=".8"/><circle cx="42" cy="32" r="1.8" fill="#1a4060" opacity=".8"/><circle cx="42" cy="38" r="1.8" fill="#1a4060" opacity=".8"/><circle cx="48" cy="34" r="2" fill="#1a4060" opacity=".8"/><circle cx="48" cy="40" r="2" fill="#1a4060" opacity=".8"/><!-- enormous body emerging from depths --><ellipse cx="32" cy="42" rx="20" ry="16" fill="#0a2840"/><ellipse cx="32" cy="40" rx="18" ry="14" fill="#0e3050"/><!-- giant eyes, bioluminescent --><ellipse cx="24" cy="34" rx="6" ry="5" fill="#20a0e0" opacity=".8"/><ellipse cx="24" cy="34" rx="4.5" ry="3.8" fill="#40d0ff"/><circle cx="24" cy="34" r="2.8" fill="#041018"/><circle cx="25.5" cy="32.5" r="1.2" fill="#80e8ff" opacity=".9"/><ellipse cx="40" cy="34" rx="6" ry="5" fill="#20a0e0" opacity=".8"/><ellipse cx="40" cy="34" rx="4.5" ry="3.8" fill="#40d0ff"/><circle cx="40" cy="34" r="2.8" fill="#041018"/><circle cx="41.5" cy="32.5" r="1.2" fill="#80e8ff" opacity=".9"/><!-- beak-like maw --><path d="M26 44Q32 50 38 44Q35 47 32 48Q29 47 26 44Z" fill="#081828"/><path d="M26 44Q32 42 38 44" stroke="#0a2030" stroke-width="1.2" fill="none"/><!-- bio-luminescent spots --><circle cx="18" cy="38" r="1.5" fill="#20c0e0" opacity=".7"/><circle cx="46" cy="38" r="1.5" fill="#20c0e0" opacity=".7"/><circle cx="32" cy="38" r="1.2" fill="#20c0e0" opacity=".5"/></svg>`},
{id:'basilisk',nameEn:'Basilisk',nameVi:'Basilisk',cat:'creature',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0a1800"/><!-- coiled serpent body rings at base --><path d="M8 60Q8 50 16 46Q24 44 28 48Q24 52 16 52Q10 56 12 60Z" fill="#1e4810"/><path d="M56 60Q56 50 48 46Q40 44 36 48Q40 52 48 52Q54 56 52 60Z" fill="#1e4810"/><path d="M12 60Q16 54 24 54Q32 56 32 60Q32 56 40 54Q48 54 52 60" fill="#2a5a18" opacity=".8"/><!-- thick serpent neck rising from coils --><path d="M20 52Q22 38 28 28" stroke="#2a5818" stroke-width="10" fill="none" stroke-linecap="round"/><path d="M44 52Q42 38 36 28" stroke="#2a5818" stroke-width="10" fill="none" stroke-linecap="round"/><path d="M20 52Q22 40 32 32Q42 40 44 52" stroke="#3a6820" stroke-width="8" fill="none" stroke-linecap="round"/><!-- serpent neck scales --><path d="M22 46Q26 42 30 46Q26 48 22 46Z" fill="#3a6820" opacity=".6"/><path d="M34 44Q38 40 42 44Q38 46 34 44Z" fill="#3a6820" opacity=".6"/><!-- crest/crown — king of serpents --><path d="M26 20Q24 12 28 10Q28 16 26 20Z" fill="#c08020"/><path d="M32 18Q32 8 34 8Q33 14 32 18Z" fill="#d09028"/><path d="M38 20Q40 12 36 10Q36 16 38 20Z" fill="#c08020"/><path d="M24 20Q32 16 40 20" stroke="#a07018" stroke-width="1.5" fill="none"/><!-- basilisk head --><defs><radialGradient id="fgbasi" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#6aaa40"/><stop offset="100%" stop-color="#306a18"/></radialGradient></defs><ellipse cx="32" cy="28" rx="16" ry="15" fill="url(#fgbasi)"/><!-- deadly eyes — lethal red glow --><ellipse cx="25.5" cy="27" rx="4.5" ry="3.5" fill="#ff0010" opacity=".9"/><ellipse cx="25.5" cy="27" rx="3.2" ry="2.5" fill="#ff4020"/><circle cx="25.5" cy="27" r="1.8" fill="#080000"/><circle cx="26.5" cy="26" r=".8" fill="#ff8060" opacity=".9"/><ellipse cx="38.5" cy="27" rx="4.5" ry="3.5" fill="#ff0010" opacity=".9"/><ellipse cx="38.5" cy="27" rx="3.2" ry="2.5" fill="#ff4020"/><circle cx="38.5" cy="27" r="1.8" fill="#080000"/><circle cx="39.5" cy="26" r=".8" fill="#ff8060" opacity=".9"/><!-- scales on face --><path d="M18 27Q20 24 22 27Q20 30 18 27Z" fill="#508028" opacity=".6"/><path d="M42 27Q44 24 46 27Q44 30 42 27Z" fill="#508028" opacity=".6"/><path d="M26 21Q28 18 30 21Q28 23 26 21Z" fill="#508028" opacity=".5"/><path d="M34 21Q36 18 38 21Q36 23 34 21Z" fill="#508028" opacity=".5"/><!-- nostril slits --><ellipse cx="30" cy="31" rx="1.5" ry=".8" fill="#184810" opacity=".7"/><ellipse cx="34" cy="31" rx="1.5" ry=".8" fill="#184810" opacity=".7"/><!-- forked tongue --><path d="M29 39Q32 42 35 39Q33 40 32 42Q31 40 29 39Z" fill="#d02020"/><path d="M30 42L28 46M34 42L36 46" stroke="#d02020" stroke-width="1.5" fill="none" stroke-linecap="round"/><!-- brow ridge --><path d="M20 22Q25.5 19.5 30 22" stroke="#204810" stroke-width="2.5" fill="none" stroke-linecap="round"/><path d="M34 22Q38.5 19.5 44 22" stroke="#204810" stroke-width="2.5" fill="none" stroke-linecap="round"/></svg>`},
{id:'empusa',nameEn:'Empusa',nameVi:'Empusa',cat:'creature',svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#200828"/><!-- fire leg (bronze) left --><path d="M18 64Q16 52 18 40Q20 36 22 40Q22 52 20 64" fill="#c04810"/><path d="M20 40Q18 36 20 32Q22 36 20 40Z" fill="#f07020"/><path d="M20 38Q19 34 20 30Q21 34 20 38Z" fill="#f8c040"/><!-- donkey leg right --><path d="M44 64Q46 52 44 40Q42 36 40 40Q40 52 42 64" fill="#604020"/><path d="M42 44Q40 40 42 36Q44 40 42 44Z" fill="#806030"/><!-- body/robe of shadow --><rect x="20" y="46" width="24" height="20" rx="8" fill="#381050"/><ellipse cx="32" cy="62" rx="20" ry="12" fill="#301040"/><!-- arms --><path d="M18 42Q14 36 14 30" stroke="#3a1848" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M46 42Q50 36 50 30" stroke="#3a1848" stroke-width="5" fill="none" stroke-linecap="round"/><!-- clawed hands --><path d="M14 30Q12 28 10 30M14 30Q14 27 12 26M14 30Q16 27 14 25" stroke="#6a2080" stroke-width="1.5" fill="none" stroke-linecap="round"/><path d="M50 30Q52 28 54 30M50 30Q50 27 52 26M50 30Q48 27 50 25" stroke="#6a2080" stroke-width="1.5" fill="none" stroke-linecap="round"/><!-- face — seductive but horrifying --><defs><radialGradient id="fgemp" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#d8b0e0"/><stop offset="100%" stop-color="#9060b0"/></radialGradient></defs><ellipse cx="18" cy="31" rx="2.5" ry="3.5" fill="#9060b0"/><ellipse cx="46" cy="31" rx="2.5" ry="3.5" fill="#9060b0"/><ellipse cx="32" cy="31" rx="14" ry="15" fill="url(#fgemp)"/><!-- flowing dark hair --><path d="M18 26Q16 14 20 10Q22 18 18 26Z" fill="#1a0828"/><path d="M46 26Q48 14 44 10Q42 18 46 26Z" fill="#1a0828"/><path d="M20 18Q22 10 28 9Q26 16 20 18Z" fill="#1a0828"/><path d="M44 18Q42 10 36 9Q38 16 44 18Z" fill="#1a0828"/><path d="M32 16Q32 8 32 6Q32 12 32 16Z" fill="#2a1038"/><!-- hypnotic eyes --><ellipse cx="25.5" cy="29.5" rx="3.5" ry="2.6" fill="#fff0ff"/><circle cx="25.5" cy="29.5" r="2" fill="#c040f0"/><circle cx="25.5" cy="29.5" r="1.1" fill="#0a0010"/><circle cx="26.4" cy="28.7" r=".55" fill="#fff" opacity=".9"/><path d="M22 28.5Q25.5 26.8 29 28.5" stroke="#0a0010" stroke-width=".8" fill="none"/><ellipse cx="38.5" cy="29.5" rx="3.5" ry="2.6" fill="#fff0ff"/><circle cx="38.5" cy="29.5" r="2" fill="#c040f0"/><circle cx="38.5" cy="29.5" r="1.1" fill="#0a0010"/><circle cx="39.4" cy="28.7" r=".55" fill="#fff" opacity=".9"/><path d="M35 28.5Q38.5 26.8 42 28.5" stroke="#0a0010" stroke-width=".8" fill="none"/><!-- fangs --><path d="M27 39Q32 43 37 39Q34 41 32 41Q30 41 27 39Z" fill="#9030c0"/><path d="M28.5 40L27 44M35.5 40L37 44" stroke="#d0b0e8" stroke-width="2" fill="none" stroke-linecap="round"/><!-- nose & lips --><path d="M32 32Q31 35 30 36Q32 37 34 36Q33 35 32 32" fill="#9060b0" opacity=".3"/><path d="M27 39Q32 37.5 37 39" fill="#9030c0" opacity=".5"/></svg>`},
];

// Total avatars: 41


function _avSVG(id){
  const av=AVATARS.find(a=>a.id===id);
  return av?'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(av.svg):null;
}

function initAvGrids(){
  ['nb','pe'].forEach(prefix=>{
    ['god','hero','archetype','creature'].forEach(cat=>{
      const panel=document.getElementById(`${prefix}-av-panel-${cat}`);
      if(!panel) return;
      const avs=AVATARS.filter(a=>a.cat===cat);
      panel.innerHTML=`<div class="av-grid av-grid-lg">${avs.map(a=>`<div class="av-pic-wrap"><div class="av-pic" data-prefix="${prefix}" data-av="${a.id}" onclick="selectPresetAvatar('${prefix}','${a.id}')"><img src="${_avSVG(a.id)}" alt="${a.nameEn}" loading="lazy"></div><div class="av-pic-name av-pic-name-${a.id}">${currentLang==='vi'?a.nameVi:a.nameEn}</div></div>`).join('')}</div>`;
    });
  });
}

function refreshAvNames(){
  AVATARS.forEach(a=>{
    document.querySelectorAll(`.av-pic-name-${a.id}`).forEach(el=>{
      el.textContent = currentLang==='vi'?a.nameVi:a.nameEn;
    });
  });
  // Also update tab labels
  const tabLabels = {
    god: currentLang==='vi'?'Thần':'Gods',
    hero: currentLang==='vi'?'Anh Hùng':'Heroes',
    archetype: currentLang==='vi'?'Nguyên Mẫu':'Archetypes',
    creature: currentLang==='vi'?'🐉 Sinh Vật':'🐉 Creatures',
    upload: currentLang==='vi'?'📷 Tải lên':'📷 Upload',
  };
  ['nb','pe'].forEach(prefix=>{
    Object.entries(tabLabels).forEach(([cat,label])=>{
      const btn = document.getElementById(`${prefix}-tab-${cat}`);
      if(btn) btn.textContent = label;
    });
  });
}

function switchAvTab(prefix,tab,btn){
  btn.closest('.av-tabs').querySelectorAll('.av-tab').forEach(t=>t.classList.remove('active'));
  btn.classList.add('active');
  ['god','hero','archetype','creature','upload'].forEach(c=>{
    const p=document.getElementById(`${prefix}-av-panel-${c}`);
    if(p)p.classList.toggle('active',c===tab);
  });
}

function selectPresetAvatar(prefix,id){
  const src=_avSVG(id);
  if(!src)return;
  if(prefix==='nb'){
    nbAvPreset=id; nbAvImg=null; nbAvEmoji=null;
    const img=document.getElementById('nb-av-img'),emo=document.getElementById('nb-av-emoji');
    img.src=src; img.classList.add('show'); emo.style.display='none';
  } else {
    peAvPreset=id; peAvData=null;
    const img=document.getElementById('pe-av-img'),emo=document.getElementById('pe-av-emoji');
    img.src=src; img.classList.add('show'); emo.style.display='none';
  }
  document.querySelectorAll(`.av-pic[data-prefix="${prefix}"]`).forEach(el=>{
    el.classList.toggle('sel',el.dataset.av===id);
  });
}

const GENRE_LABELS = {
  'Fiction':                { en: 'Fiction',            vi: 'Tiểu thuyết' },
  'Literary Fiction':       { en: 'Literary Fiction',   vi: 'Văn học' },
  'Historical Fiction':     { en: 'Historical Fiction', vi: 'Tiểu thuyết lịch sử' },
  'Science Fiction':        { en: 'Sci-Fi',             vi: 'Khoa học viễn tưởng' },
  'Fantasy':                { en: 'Fantasy',            vi: 'Giả tưởng' },
  'Horror':                 { en: 'Horror',             vi: 'Kinh dị' },
  'Mystery & Thriller':     { en: 'Mystery',            vi: 'Bí ẩn & Ly kỳ' },
  'Crime':                  { en: 'Crime',              vi: 'Trinh thám' },
  'Romance':                { en: 'Romance',            vi: 'Lãng mạn' },
  'Adventure':              { en: 'Adventure',          vi: 'Phiêu lưu' },
  'Surrealism':             { en: 'Surrealism',         vi: 'Siêu thực' },
  'Magical Realism':        { en: 'Magical Realism',    vi: 'Huyền ảo hiện thực' },
  'Dystopian':              { en: 'Dystopian',          vi: 'Phản địa đàng' },
  'Absurdist Fiction':      { en: 'Absurdist',          vi: 'Phi lý' },
  'Short Stories':          { en: 'Short Stories',      vi: 'Truyện ngắn' },
  'Classic Literature':     { en: 'Classic Lit',        vi: 'Văn học kinh điển' },
  'Young Adult':            { en: 'YA',                 vi: 'Thiếu niên' },
  "Children's":             { en: "Children's",         vi: 'Thiếu nhi' },
  'Graphic Novel / Manga':  { en: 'Manga',              vi: 'Manga / Truyện tranh' },
  'Non-fiction':            { en: 'Non-fiction',        vi: 'Phi hư cấu' },
  'Biography':              { en: 'Biography',          vi: 'Tiểu sử' },
  'Memoir & Autobiography': { en: 'Memoir',             vi: 'Hồi ký' },
  'History':                { en: 'History',            vi: 'Lịch sử' },
  'True Crime':             { en: 'True Crime',         vi: 'Tội phạm có thật' },
  'Science':                { en: 'Science',            vi: 'Khoa học' },
  'Nature & Environment':   { en: 'Nature',             vi: 'Thiên nhiên' },
  'Technology':             { en: 'Tech',               vi: 'Công nghệ' },
  'Business & Economics':   { en: 'Business',           vi: 'Kinh doanh' },
  'Self-help':              { en: 'Self-help',          vi: 'Tự phát triển' },
  'Psychology':             { en: 'Psychology',         vi: 'Tâm lý học' },
  'Philosophy':             { en: 'Philosophy',         vi: 'Triết học' },
  'Politics & Society':     { en: 'Politics',           vi: 'Chính trị & Xã hội' },
  'Spirituality & Religion':{ en: 'Spirituality',       vi: 'Tâm linh' },
  'Health & Wellness':      { en: 'Health',             vi: 'Sức khỏe' },
  'Cooking & Food':         { en: 'Cooking',            vi: 'Nấu ăn' },
  'Travel':                 { en: 'Travel',             vi: 'Du lịch' },
  'Art & Design':           { en: 'Art',                vi: 'Nghệ thuật' },
  'Essays':                 { en: 'Essays',             vi: 'Tản văn' },
  'Poetry':                 { en: 'Poetry',             vi: 'Thơ ca' },
  'Other':                  { en: 'Other',              vi: 'Khác' },
};

const LANG = {
  en: {
    searchPlaceholder: 'Search…',
    filterAll: 'All', filterRead: '✓ Read', filterReading: '📖 Reading', filterWant: '🔖 Want', filterOwned: '📦 Owned',
    sortDate: 'Recently Added', sortDateAsc: 'Oldest Added', sortTitle: 'Title A–Z', sortAuthor: 'Author A–Z', sortRating: 'Highest Rated', sortRatingAsc: 'Lowest Rated',
    sortYearReadDesc: 'Year Read (Newest)', sortYearReadAsc: 'Year Read (Oldest)',
    sortPubYearDesc: 'Pub. Year (Newest)', sortPubYearAsc: 'Pub. Year (Oldest)', sortManual: '✋ My Order',
    addBook: 'Add Book', share: 'Share', switchUser: 'Switch user',
    modalAddTitle: 'Add a Book', modalEditTitle: 'Edit Book',
    labelCover: 'Book Cover', labelTitle: 'Title', labelAuthor: 'Author', labelGenre: 'Genre',
    labelYear: 'Year of Reading', labelStatus: 'Status', labelRating: 'Rating', labelReview: 'Your Review',
    statusWant: '🔖 Want to Read', statusReading: '📖 Currently Reading', statusRead: '✓ Read', statusOwned: '📦 Owned',
    btnSave: 'Save Book', btnCancel: 'Cancel',
    emptyShelf: 'Your shelves await.', emptyAdd: 'Add your first book to start building your library.',
    noResults: 'No books found.', noResultsSub: 'Try a different search or filter.',
    coverClick: 'Click to upload', coverDrag: 'or drag & drop · JPG PNG WEBP max 5MB',
    reviewPlaceholder: 'What did you think? (optional)',
    authorPlaceholder: 'Author name', titlePlaceholder: 'Book title',
    langBtn: '🌐 VI', greeting: 'Welcome back,',
    whoReading: "Who's reading today?", createAccount: 'Create my account',
    newReader: 'New reader', startReading: 'Start reading →',
    usernameLabel: 'Username', displayNameLabel: 'Display name', libraryNameLabel: 'Library name',
    passwordLabel: 'Password', confirmPasswordLabel: 'Confirm Password', recoveryQuestionLabel: 'Recovery Question',
    usernamePlaceholder: 'e.g. sophie, alex42…', displayNamePlaceholder: 'How you want to be greeted',
    libraryNamePlaceholder: 'e.g. The Night Shelf…',
    enterPasswordPlaceholder: 'Enter your password', recoveryAnswerPlaceholder: 'Your recovery answer (case-insensitive)',
    continueBtn: 'Continue →', openLibBtn: 'Open my library →',
    recoverAccessBtn: 'Recover Access →', forgotPassword: 'Forgot password?',
    usernameHint: 'Your unique key to access your library.',
    accountFoundPw: '✓ Account found — enter your password below.',
    newUsernameHint: '✦ New username — fill in your details below.',
    myLibrary: 'My Library',
    statBooks: 'Books', statRead: 'Read', statAvg: 'Avg',
    editBtn: 'Edit', deleteBtn: 'Delete', noCover: 'No cover',
    enterPasswordErr: 'Please enter your password.',
    wrongPasswordErr: '❌ Wrong password. Try again.',
    usernameRequired: '⚠️ Please enter a username.',
    passwordRequired: 'Password is required.',
    passwordTooShort: 'Password must be at least 4 characters.',
    passwordMismatch: '❌ Passwords do not match.',
    libraryCreated: '🎉 Library created! Start adding your books.',
    accountDeleted: '🗑 Account deleted.',
    titleAuthorRequired: '⚠️ Title and author required.',
    bookUpdated: '✓ Book updated!', bookAdded: '✓ Book added!',
    bookRemoved: '🗑 Removed.',
    profileUpdated: '✓ Profile updated!',
    syncSaving: 'Saving…', syncSaved: 'Saved', syncError: 'Not saved',
    readonlySuffix: "'s library — read only",
    createOwnLibrary: '📚 Create my own library',
    noRecoveryQuestion: '⚠️ No recovery question set for this account.',
    enterAnswerErr: 'Please enter your answer.',
    incorrectAnswerErr: '❌ Incorrect answer.',
    identityVerified: '✓ Identity verified! Please set a new password.',
    newPasswordPrompt: 'Enter your new password (min 4 characters):',
    passwordTooShortToast: '⚠️ Password too short.',
    passwordReset: '✓ Password reset! Logging you in…',
    bookDetailsFilled: '✓ Book details filled in!',
    pwVeryWeak: 'Very weak', pwWeak: 'Weak', pwFair: 'Fair', pwStrong: 'Strong', pwVeryStrong: 'Very strong',
    // Genre picker
    genreClickToPick: 'click to pick',
    genrePlaceholder: '— choose genres —',
    genreFiction: 'Fiction',
    genreNonFiction: 'Non-Fiction',
    // Reading tracker
    readingTracker: 'Reading Tracker',
    startedOn: 'Started on',
    endedOn: 'Ended on',
    halfStarHint: 'Click left half of a ★ for 0.5 steps',
    // Profile modal
    editProfile: 'Edit Profile',
    uploadPhoto: 'Upload photo',
    pickEmojiBelow: 'or pick emoji below',
    btnSaveProfile: 'Save',
    // Share modal
    shareModalTitle: 'Share Your Library',
    shareHeading: 'Share your library — read only',
    shareDesc: "Friends can browse your books, ratings &amp; reviews but can't edit anything. Works offline — no account needed to view.",
    readOnlySnapshot: 'Read-only snapshot',
    shareDownloadDesc: "Downloads a self-contained HTML file with your library baked in. Anyone who opens it can browse your books, ratings &amp; reviews — but can't edit anything.",
    btnDownloadShare: '⬇️ Download read-only page',
    shareTip: '<strong>Tip:</strong> Send the downloaded file via email, WhatsApp, or any file-sharing app. The recipient just opens it in their browser.',
    // Knowledge modal
    knowledgeTitle: '💡 Daily Knowledge',
    todayInHistory: '📅 Today in History',
    knFactOf: 'Fact', knFactOfIn: 'of', knFactCategory: 'in this category',
    knLoadingFact: 'Loading…', knLoadingHistory: "Fetching today's history…",
    knNoHistory: "Could not load today's history. Check your connection.",
    knSeeAll: '📖 See all events on Wikipedia ↗',
    // Welcome modal
    welcomeTitle: 'Welcome to The Library',
    wlCard1: 'This website was built by a <strong>very idle student</strong> with little knowledge about coding. There might be bugs somewhere and occasional hiccups with web fluidity or book search — bear with it!',
    wlCard2: 'This app is designed to help you <strong>keep track of your personal library</strong> — physical books or ebooks. Feel free to upload pictures of your own covers.',
    wlCard3: '<strong>Share your colossal library</strong> with friends. Let\'s enjoy reading together and inspire each other with what\'s on our shelves.',
    wlCard4: 'The <strong>upper search bar</strong> finds Vietnamese book covers. The <strong>lower search bar</strong> finds English book covers. Use whichever matches the language of your book!',
    wlCard5: 'You can <strong>categorize books</strong> however you like. Tap the <strong>＋ button</strong> next to the category folder icon to create your own categories and organize your shelf.',
    wlCard6: 'This website runs with <strong>zero budget</strong>. There may be occasional limitations on the database or book search — but as long as you don\'t search more than 10,000 books a day, not a penny is spent. 😊',
    wlCard4Quote: '"Knowledge is an Ouroboros."',
    wlCard4Text: 'The more you read, the more you realise how much there is left to read. The snake devours its own tail — and the cycle never ends.',
    // Reading duration
    dayRead: 'day', daysRead: 'days', readIn: 'Read in', startedReading: 'Started', finishedReading: 'Finished',
    // Category management
    manageCategories: 'Manage Categories', addNewCategory: 'Add new category',
    catEmojiPlaceholder: '📁', catLabelPlaceholder: 'e.g. Wishlist…',
    catAddBtn: '+ Add', catDeleteConfirm: 'Delete this category?',
    catNameRequired: '⚠️ Category name required.',
    catAddCatBtn: '＋',
  },
  vi: {
    searchPlaceholder: 'Tìm kiếm…',
    filterAll: 'Tất cả', filterRead: '✓ Đã đọc', filterReading: '📖 Đang đọc', filterWant: '🔖 Muốn đọc', filterOwned: '📦 Đã có',
    sortDate: 'Mới thêm', sortDateAsc: 'Cũ nhất', sortTitle: 'Tên A–Z', sortAuthor: 'Tác giả A–Z', sortRating: 'Đánh giá cao nhất', sortRatingAsc: 'Đánh giá thấp nhất',
    sortYearReadDesc: 'Năm đọc (Mới nhất)', sortYearReadAsc: 'Năm đọc (Cũ nhất)',
    sortPubYearDesc: 'Năm xuất bản (Mới nhất)', sortPubYearAsc: 'Năm xuất bản (Cũ nhất)', sortManual: '✋ Thứ tự của tôi',
    addBook: 'Thêm sách', share: 'Chia sẻ', switchUser: 'Đổi người dùng',
    modalAddTitle: 'Thêm sách', modalEditTitle: 'Sửa sách',
    labelCover: 'Ảnh bìa', labelTitle: 'Tên sách', labelAuthor: 'Tác giả', labelGenre: 'Thể loại',
    labelYear: 'Năm đọc', labelStatus: 'Trạng thái', labelRating: 'Đánh giá', labelReview: 'Nhận xét của bạn',
    statusWant: '🔖 Muốn đọc', statusReading: '📖 Đang đọc', statusRead: '✓ Đã đọc', statusOwned: '📦 Đã có',
    btnSave: 'Lưu sách', btnCancel: 'Hủy',
    emptyShelf: 'Giá sách đang chờ bạn.', emptyAdd: 'Thêm cuốn sách đầu tiên để bắt đầu thư viện của bạn.',
    noResults: 'Không tìm thấy sách.', noResultsSub: 'Thử tìm kiếm hoặc lọc khác.',
    coverClick: 'Nhấn để tải lên', coverDrag: 'hoặc kéo thả · JPG PNG WEBP tối đa 5MB',
    reviewPlaceholder: 'Bạn nghĩ gì về cuốn sách? (tùy chọn)',
    authorPlaceholder: 'Tên tác giả', titlePlaceholder: 'Tên sách',
    langBtn: '🌐 EN', greeting: 'Chào mừng trở lại,',
    whoReading: 'Hôm nay ai đọc sách?', createAccount: 'Tạo tài khoản của tôi',
    newReader: 'Người đọc mới', startReading: 'Bắt đầu đọc →',
    usernameLabel: 'Tên đăng nhập', displayNameLabel: 'Tên hiển thị', libraryNameLabel: 'Tên thư viện',
    passwordLabel: 'Mật khẩu', confirmPasswordLabel: 'Xác nhận mật khẩu', recoveryQuestionLabel: 'Câu hỏi khôi phục',
    usernamePlaceholder: 'vd: nguyen, tran123…', displayNamePlaceholder: 'Tên bạn muốn được gọi',
    libraryNamePlaceholder: 'vd: Kệ sách đêm khuya…',
    enterPasswordPlaceholder: 'Nhập mật khẩu của bạn', recoveryAnswerPlaceholder: 'Câu trả lời của bạn (không phân biệt hoa thường)',
    continueBtn: 'Tiếp tục →', openLibBtn: 'Mở thư viện của tôi →',
    recoverAccessBtn: 'Khôi phục quyền truy cập →', forgotPassword: 'Quên mật khẩu?',
    usernameHint: 'Khóa duy nhất để truy cập thư viện của bạn.',
    accountFoundPw: '✓ Đã tìm thấy tài khoản — nhập mật khẩu bên dưới.',
    newUsernameHint: '✦ Tên đăng nhập mới — điền thông tin bên dưới.',
    myLibrary: 'Thư viện của tôi',
    statBooks: 'Sách', statRead: 'Đã đọc', statAvg: 'TB',
    editBtn: 'Sửa', deleteBtn: 'Xóa', noCover: 'Không có bìa',
    enterPasswordErr: 'Vui lòng nhập mật khẩu.',
    wrongPasswordErr: '❌ Sai mật khẩu. Thử lại.',
    usernameRequired: '⚠️ Vui lòng nhập tên đăng nhập.',
    passwordRequired: 'Mật khẩu là bắt buộc.',
    passwordTooShort: 'Mật khẩu phải có ít nhất 4 ký tự.',
    passwordMismatch: '❌ Mật khẩu không khớp.',
    libraryCreated: '🎉 Đã tạo thư viện! Bắt đầu thêm sách của bạn.',
    accountDeleted: '🗑 Đã xóa tài khoản.',
    titleAuthorRequired: '⚠️ Tên sách và tác giả là bắt buộc.',
    bookUpdated: '✓ Đã cập nhật sách!', bookAdded: '✓ Đã thêm sách!',
    bookRemoved: '🗑 Đã xóa.',
    profileUpdated: '✓ Đã cập nhật hồ sơ!',
    syncSaving: 'Đang lưu…', syncSaved: 'Đã lưu', syncError: 'Chưa lưu',
    readonlySuffix: "'s thư viện — chỉ đọc",
    createOwnLibrary: '📚 Tạo thư viện của tôi',
    noRecoveryQuestion: '⚠️ Tài khoản này chưa đặt câu hỏi khôi phục.',
    enterAnswerErr: 'Vui lòng nhập câu trả lời.',
    incorrectAnswerErr: '❌ Câu trả lời không đúng.',
    identityVerified: '✓ Đã xác minh! Vui lòng đặt mật khẩu mới.',
    newPasswordPrompt: 'Nhập mật khẩu mới (ít nhất 4 ký tự):',
    passwordTooShortToast: '⚠️ Mật khẩu quá ngắn.',
    passwordReset: '✓ Đặt lại mật khẩu! Đang đăng nhập…',
    bookDetailsFilled: '✓ Đã điền thông tin sách!',
    pwVeryWeak: 'Rất yếu', pwWeak: 'Yếu', pwFair: 'Khá', pwStrong: 'Mạnh', pwVeryStrong: 'Rất mạnh',
    // Genre picker
    genreClickToPick: 'nhấn để chọn',
    genrePlaceholder: '— chọn thể loại —',
    genreFiction: 'Hư cấu',
    genreNonFiction: 'Phi hư cấu',
    // Reading tracker
    readingTracker: 'Theo dõi đọc sách',
    startedOn: 'Bắt đầu',
    endedOn: 'Kết thúc',
    halfStarHint: 'Nhấn nửa trái ★ để chọn 0.5 sao',
    // Profile modal
    editProfile: 'Chỉnh sửa hồ sơ',
    uploadPhoto: 'Tải ảnh lên',
    pickEmojiBelow: 'hoặc chọn emoji bên dưới',
    btnSaveProfile: 'Lưu',
    // Share modal
    shareModalTitle: 'Chia sẻ thư viện',
    shareHeading: 'Chia sẻ thư viện của bạn — chỉ đọc',
    shareDesc: "Bạn bè có thể xem sách, đánh giá &amp; nhận xét nhưng không thể chỉnh sửa. Hoạt động ngoại tuyến — không cần tài khoản.",
    readOnlySnapshot: 'Bản xem chỉ đọc',
    shareDownloadDesc: "Tải xuống file HTML độc lập chứa toàn bộ thư viện của bạn. Ai mở file đó đều có thể xem sách, đánh giá &amp; nhận xét — nhưng không thể chỉnh sửa.",
    btnDownloadShare: '⬇️ Tải trang chỉ đọc',
    shareTip: '<strong>Mẹo:</strong> Gửi file đã tải qua email, WhatsApp hoặc ứng dụng chia sẻ file. Người nhận chỉ cần mở bằng trình duyệt.',
    // Knowledge modal
    knowledgeTitle: '💡 Tri thức hôm nay',
    todayInHistory: '📅 Hôm nay trong lịch sử',
    knFactOf: 'Tri thức', knFactOfIn: 'trong số', knFactCategory: 'trong danh mục này',
    knLoadingFact: 'Đang tải…', knLoadingHistory: 'Đang tải lịch sử hôm nay…',
    knNoHistory: 'Không thể tải lịch sử hôm nay. Kiểm tra kết nối mạng.',
    knSeeAll: '📖 Xem tất cả sự kiện trên Wikipedia ↗',
    // Welcome modal
    welcomeTitle: 'Chào mừng đến với Thư viện',
    wlCard1: 'Trang web này được xây dựng bởi một <strong>học sinh rất rảnh</strong> với ít kiến thức lập trình. Có thể có lỗi đâu đó — mong bạn thông cảm!',
    wlCard2: 'Ứng dụng này giúp bạn <strong>theo dõi thư viện cá nhân</strong> — sách giấy hoặc ebook. Hãy thoải mái tải ảnh bìa của riêng bạn.',
    wlCard3: '<strong>Chia sẻ thư viện khổng lồ của bạn</strong> với bạn bè. Cùng nhau đọc sách và truyền cảm hứng qua những cuốn sách trên kệ.',
    wlCard4: 'Thanh tìm kiếm <strong>phía trên</strong> tìm bìa sách tiếng Việt. Thanh tìm kiếm <strong>phía dưới</strong> tìm bìa sách tiếng Anh. Dùng cái phù hợp với ngôn ngữ sách của bạn!',
    wlCard5: 'Bạn có thể <strong>phân loại sách</strong> theo ý muốn. Nhấn nút <strong>＋</strong> gần biểu tượng thư mục để tạo danh mục riêng và sắp xếp kệ sách.',
    wlCard6: 'Trang web này hoạt động với <strong>ngân sách bằng 0</strong>. Có thể có giới hạn nhỏ về cơ sở dữ liệu hoặc tìm kiếm — nhưng miễn là bạn không tìm quá 10.000 cuốn mỗi ngày, không tốn một xu nào. 😊',
    wlCard4Quote: '"Kiến thức là Ouroboros."',
    wlCard4Text: 'Càng đọc nhiều, bạn càng nhận ra còn bao nhiêu điều chưa đọc. Con rắn nuốt đuôi mình — và vòng tuần hoàn không bao giờ kết thúc.',
    // Reading duration
    dayRead: 'ngày', daysRead: 'ngày', readIn: 'Đọc trong', startedReading: 'Bắt đầu', finishedReading: 'Kết thúc',
    // Category management
    manageCategories: 'Quản lý danh mục', addNewCategory: 'Thêm danh mục mới',
    catEmojiPlaceholder: '📁', catLabelPlaceholder: 'vd: Danh sách ước…',
    catAddBtn: '+ Thêm', catDeleteConfirm: 'Xóa danh mục này?',
    catNameRequired: '⚠️ Vui lòng nhập tên danh mục.',
    catAddCatBtn: '＋',
  }
};

function t(key){ return (LANG[currentLang]||LANG.en)[key] || key; }

function toggleLang(){
  currentLang = currentLang === 'en' ? 'vi' : 'en';
  localStorage.setItem('lib_lang', currentLang);
  applyLang();
}

function applyLang(){
  try{
  const L = LANG[currentLang] || LANG.en;

  // Search & sort bar
  const si = document.getElementById('searchInput');
  if(si) si.placeholder = L.searchPlaceholder;
  const bsi = document.getElementById('bookSearchInput');
  if(bsi) bsi.placeholder = currentLang==='vi' ? '🔍 Tìm kiếm sách theo tên hoặc tác giả…' : '🔍 Search a book title or author…';
  const bsd = document.querySelector('.book-search-divider span');
  if(bsd) bsd.textContent = currentLang==='vi' ? 'hoặc điền thủ công' : 'or fill in manually';

  // Language toggle button
  const lb = document.getElementById('langToggleBtn');
  if(lb) lb.innerHTML = L.langBtn;

  // Sort select
  const ss = document.getElementById('sortSelect');
  if(ss && ss.options.length >= 4){
    ss.options[0].text = L.sortDate;
    if(ss.options[1]) ss.options[1].text = L.sortDateAsc||'Oldest Added';
    if(ss.options[2]) ss.options[2].text = L.sortTitle;
    if(ss.options[3]) ss.options[3].text = L.sortAuthor;
    if(ss.options[4]) ss.options[4].text = L.sortRating;
    if(ss.options[5]) ss.options[5].text = L.sortRatingAsc||'Lowest Rated';
    if(ss.options[6]) ss.options[6].text = L.sortYearReadDesc||'Year Read (Newest)';
    if(ss.options[7]) ss.options[7].text = L.sortYearReadAsc||'Year Read (Oldest)';
    if(ss.options[8]) ss.options[8].text = L.sortPubYearDesc||'Pub. Year (Newest)';
    if(ss.options[9]) ss.options[9].text = L.sortPubYearAsc||'Pub. Year (Oldest)';
    if(ss.options[10]) ss.options[10].text = L.sortCategory||'Category A–Z';
    if(ss.options[11]) ss.options[11].text = L.sortManual||'✋ My Order';
  }
  updateSortDefaultBtn();

  // Filter buttons — update built-ins and re-render custom ones
  const fbAll = document.getElementById('filterBtnAll'); if(fbAll) fbAll.textContent = L.filterAll;
  const fbRead = document.getElementById('filterBtnRead'); if(fbRead) fbRead.textContent = L.filterRead;
  const fbReading = document.getElementById('filterBtnReading'); if(fbReading) fbReading.textContent = L.filterReading;
  const fbWant = document.getElementById('filterBtnWant'); if(fbWant) fbWant.textContent = L.filterWant;
  const fbOwned = document.getElementById('filterBtnOwned'); if(fbOwned) fbOwned.textContent = L.filterOwned;
  renderCustomFilterBtns();
  const manageBtn = document.getElementById('btnManageCats');
  if(manageBtn) manageBtn.title = L.manageCategories;

  // Header action buttons — target the text node safely
  const setLastText = (id, txt) => {
    const el = document.getElementById(id);
    if(!el) return;
    // Find last text node child
    for(let i = el.childNodes.length-1; i >= 0; i--){
      if(el.childNodes[i].nodeType === 3){
        el.childNodes[i].textContent = ' ' + txt;
        return;
      }
    }
    // Fallback: append text node
    el.appendChild(document.createTextNode(' ' + txt));
  };
  setLastText('btnAdd',    L.addBook);
  setLastText('label-reading-status', currentLang==='vi'?'Trạng thái đọc':'Reading Status');
  setLastText('label-category-field', currentLang==='vi'?'Danh mục':'Category');
  setLastText('btnShare',  L.share);
  setLastText('btnSwitch', L.switchUser);

  // Greeting
  const gr = document.querySelector('.profile-greeting');
  if(gr) gr.textContent = L.greeting;

  // Book modal form labels
  const labelMap = {
    'Book Cover': L.labelCover,     'Ảnh bìa': L.labelCover,
    'Title': L.labelTitle,          'Tên sách': L.labelTitle,
    'Author': L.labelAuthor,        'Tác giả': L.labelAuthor,
    'Genre': L.labelGenre,          'Thể loại': L.labelGenre,
    'Year of Reading': L.labelYear, 'Năm đọc': L.labelYear,
    'Status': L.labelStatus,        'Trạng thái': L.labelStatus,
    'Rating': L.labelRating,        'Đánh giá': L.labelRating,
    'Your Review': L.labelReview,   'Nhận xét của bạn': L.labelReview,
    'Display Name': L.displayNameLabel, 'Tên hiển thị': L.displayNameLabel,
    'Library Name': L.libraryNameLabel, 'Tên thư viện': L.libraryNameLabel,
    'Avatar': 'Avatar',
  };
  document.querySelectorAll('.form-label').forEach(lb=>{
    // Get text content ignoring child elements (req span)
    const txt = Array.from(lb.childNodes)
      .filter(n => n.nodeType === 3)
      .map(n => n.textContent.trim())
      .join('').replace(/\s+/g,' ').trim();
    if(labelMap[txt]){
      // Update only the text node, leave child spans intact
      for(const n of lb.childNodes){
        if(n.nodeType === 3 && n.textContent.trim().length > 0){
          n.textContent = labelMap[txt] + ' ';
          break;
        }
      }
    }
  });

  // Form inputs / selects
  const sp = (id, txt) => { const el=document.getElementById(id); if(el) el.placeholder=txt; };
  sp('f-title',  L.titlePlaceholder);
  sp('f-author', L.authorPlaceholder);
  sp('f-review', L.reviewPlaceholder);

  // Status select — rebuild fully to include custom categories
  rebuildStatusSelect();

  // Save / Cancel buttons
  document.querySelectorAll('#bookOverlay .btn-submit').forEach(b => b.textContent = L.btnSave);
  document.querySelectorAll('.btn-cancel').forEach(b => b.textContent = L.btnCancel);

  // User-select screen
  const sub = document.querySelector('.us-sub');
  if(sub) sub.textContent = L.whoReading;
  const div = document.querySelector('.us-divider span');
  if(div) div.textContent = L.newReader;
  const startBtn = document.querySelector('#nb-step-new .btn-start');
  if(startBtn) startBtn.textContent = L.startReading;

  // New-user form ob-labels
  const obMap = {
    'Username': L.usernameLabel,       'Tên đăng nhập': L.usernameLabel,
    'Display name': L.displayNameLabel,'Tên hiển thị': L.displayNameLabel,
    'Library name': L.libraryNameLabel,'Tên thư viện': L.libraryNameLabel,
    'Password': L.passwordLabel,       'Mật khẩu': L.passwordLabel,
    'Confirm Password': L.confirmPasswordLabel, 'Xác nhận mật khẩu': L.confirmPasswordLabel,
    'Recovery Question': L.recoveryQuestionLabel, 'Câu hỏi khôi phục': L.recoveryQuestionLabel,
  };
  document.querySelectorAll('.ob-label').forEach(lb=>{
    const txt = Array.from(lb.childNodes)
      .filter(n => n.nodeType === 3)
      .map(n => n.textContent.trim())
      .join('').replace(/\s+/g,' ').trim();
    if(obMap[txt]){
      for(const n of lb.childNodes){
        if(n.nodeType === 3 && n.textContent.trim().length > 0){
          n.textContent = obMap[txt] + ' ';
          break;
        }
      }
    }
  });

  sp('nb-username', L.usernamePlaceholder);
  sp('nb-name',     L.displayNamePlaceholder);
  sp('nb-libname',  L.libraryNamePlaceholder);
  sp('nb-login-pw', L.enterPasswordPlaceholder);
  sp('nb-recovery-ans', L.recoveryAnswerPlaceholder);

  // Recover / forgot password links
  const recoverBtn = document.querySelector('#nb-recovery-section .btn-start');
  if(recoverBtn) recoverBtn.textContent = L.recoverAccessBtn;
  const forgotLink = document.querySelector('.recovery-link');
  if(forgotLink) forgotLink.textContent = L.forgotPassword;

  // Header stat labels
  const sbl = document.getElementById('stat-label-books'); if(sbl) sbl.textContent = L.statBooks;
  const slr = document.getElementById('stat-label-read');  if(slr) slr.textContent = L.statRead;
  const sla = document.getElementById('stat-label-avg');   if(sla) sla.textContent = L.statAvg;

  // Readonly banner
  const roBtn = document.getElementById('btnCreateOwnLibrary');
  if(roBtn) roBtn.textContent = L.createOwnLibrary;

  // Hint texts — only reset if still showing a default hint (not a dynamic status message)
  const hint = document.getElementById('nb-username-hint');
  const defaultHints = [LANG.en.usernameHint, LANG.vi.usernameHint, LANG.en.accountFoundPw, LANG.vi.accountFoundPw, LANG.en.newUsernameHint, LANG.vi.newUsernameHint];
  if(hint && defaultHints.includes(hint.textContent.trim())){
    hint.textContent = L.usernameHint;
  }

  // Create account toggle button
  const tog = document.getElementById('usNewToggle');
  if(tog){
    for(const n of tog.childNodes){
      if(n.nodeType === 3 && n.textContent.trim().length > 0){
        n.textContent = ' ' + L.createAccount;
        break;
      }
    }
  }

  const knBtnTxt = document.getElementById('btnKnowledgeText');
  if(knBtnTxt) knBtnTxt.textContent = L.knowledgeTitle || (currentLang==='vi' ? 'Tri thức hôm nay' : 'Daily Fact');

  // Knowledge modal static elements
  const knTitle = document.getElementById('knTitle');
  if(knTitle) knTitle.textContent = L.knowledgeTitle;
  const knTodayInHistory = document.getElementById('knTodayInHistory');
  if(knTodayInHistory) knTodayInHistory.textContent = L.todayInHistory;
  // Re-render fact card if modal is currently open (so language switch takes effect)
  const knOverlay = document.getElementById('knOverlay');
  if(knOverlay && knOverlay.classList.contains('open')) _renderKnowledgeModal();

  // About pill & welcome modal
  const pillTxt = document.querySelector('.about-pill-text');
  if(pillTxt) pillTxt.textContent = currentLang==='vi' ? 'Về thư viện này' : 'About this library';
  const welcomeTxt = document.getElementById('welcomeBtnText');
  const welcomeBtn = document.getElementById('welcomeContinueBtn');
  if(welcomeTxt && welcomeBtn && !welcomeBtn.disabled)
    welcomeTxt.textContent = currentLang==='vi' ? 'Bắt đầu nào! →' : "Let's get started →";
  const scrollHintEl = document.getElementById('welcomeScrollHint');
  if(scrollHintEl && !scrollHintEl.classList.contains('hidden'))
    scrollHintEl.innerHTML = `<span class="wl-bounce">↓</span> ${currentLang==='vi'?'Cuộn xuống để tiếp tục':'Scroll down to continue'}`;

  // Welcome modal card content
  const wlTitleEl = document.getElementById('wlTitle');
  if(wlTitleEl) wlTitleEl.textContent = L.welcomeTitle;
  const wlCard1El = document.getElementById('wlCard1');
  if(wlCard1El) wlCard1El.innerHTML = L.wlCard1;
  const wlCard2El = document.getElementById('wlCard2');
  if(wlCard2El) wlCard2El.innerHTML = L.wlCard2;
  const wlCard3El = document.getElementById('wlCard3');
  if(wlCard3El) wlCard3El.innerHTML = L.wlCard3;
  const wlCard4El = document.getElementById('wlCard4');
  if(wlCard4El) wlCard4El.innerHTML = L.wlCard4;
  const wlCard5El = document.getElementById('wlCard5');
  if(wlCard5El) wlCard5El.innerHTML = L.wlCard5;
  const wlCard6El = document.getElementById('wlCard6');
  if(wlCard6El) wlCard6El.innerHTML = L.wlCard6;
  const wlCard4QuoteEl = document.getElementById('wlCard4Quote');
  if(wlCard4QuoteEl) wlCard4QuoteEl.textContent = L.wlCard4Quote;
  const wlCard4TextEl = document.getElementById('wlCard4Text');
  if(wlCard4TextEl) wlCard4TextEl.textContent = L.wlCard4Text;

  // Genre picker labels & options
  const genreLabel = document.querySelector('#genrePicker')?.closest('.form-group')?.querySelector('.form-label');
  if(genreLabel){
    const clickSpan = genreLabel.querySelector('span');
    if(clickSpan) clickSpan.textContent = L.genreClickToPick;
    for(const n of genreLabel.childNodes){
      if(n.nodeType===3 && n.textContent.trim().length>0){ n.textContent = L.labelGenre+' '; break; }
    }
  }
  const genrePlaceholderEl = document.querySelector('.genre-placeholder');
  if(genrePlaceholderEl) genrePlaceholderEl.textContent = L.genrePlaceholder;
  document.querySelectorAll('.genre-opt').forEach(opt=>{
    const val = opt.dataset.val;
    if(val && GENRE_LABELS[val]) opt.textContent = GENRE_LABELS[val][currentLang] || GENRE_LABELS[val].en;
  });
  const genreGroupLabels = document.querySelectorAll('.genre-group-label');
  if(genreGroupLabels[0]) genreGroupLabels[0].textContent = L.genreFiction;
  if(genreGroupLabels[1]) genreGroupLabels[1].textContent = L.genreNonFiction;

  // Reading tracker labels
  const trackerLabel = document.getElementById('label-reading-tracker');
  if(trackerLabel){
    const svgEl = trackerLabel.querySelector('svg');
    Array.from(trackerLabel.childNodes).forEach(n=>{ if(n.nodeType===3) n.remove(); });
    trackerLabel.appendChild(document.createTextNode(' ' + L.readingTracker));
    if(svgEl && trackerLabel.firstChild !== svgEl) trackerLabel.prepend(svgEl);
  }
  const dateStartLabel = document.getElementById('label-date-start');
  if(dateStartLabel) dateStartLabel.textContent = L.startedOn;
  const dateEndLabel = document.getElementById('label-date-end');
  if(dateEndLabel) dateEndLabel.textContent = L.endedOn;
  updateTrackerDuration();

  // Half-star hint
  const halfStarHintEl = document.getElementById('half-star-hint');
  if(halfStarHintEl) halfStarHintEl.textContent = L.halfStarHint;

  // Profile modal
  const editProfileTitle = document.getElementById('profile-modal-title');
  if(editProfileTitle) editProfileTitle.textContent = L.editProfile;
  const pickEmojiEl = document.getElementById('profile-pick-emoji');
  if(pickEmojiEl) pickEmojiEl.textContent = L.pickEmojiBelow;
  document.querySelectorAll('#profileOverlay .btn-submit').forEach(b => b.textContent = L.btnSaveProfile);

  // Share modal
  const shareMTitle = document.getElementById('share-modal-title');
  if(shareMTitle) shareMTitle.textContent = L.shareModalTitle;
  const shareHeadEl = document.getElementById('share-heading');
  if(shareHeadEl) shareHeadEl.textContent = L.shareHeading;
  const shareDescEl = document.getElementById('share-desc');
  if(shareDescEl) shareDescEl.textContent = L.shareDesc?.replace(/&amp;/g,'&');
  const shareSnapshotLabel = document.getElementById('share-snapshot-label');
  if(shareSnapshotLabel) shareSnapshotLabel.textContent = L.readOnlySnapshot;
  const shareDownloadDescEl = document.getElementById('share-download-desc');
  if(shareDownloadDescEl) shareDownloadDescEl.textContent = L.shareDownloadDesc?.replace(/&amp;/g,'&');
  const btnDownloadEl = document.getElementById('btnDownloadShare');
  if(btnDownloadEl) btnDownloadEl.textContent = L.btnDownloadShare;
  const shareTipEl = document.getElementById('share-note-el');
  if(shareTipEl) shareTipEl.innerHTML = L.shareTip;


  // Manage categories modal
  const mcTitle = document.getElementById('manage-cats-title');
  if(mcTitle) mcTitle.textContent = L.manageCategories;
  const mcAddLabel = document.getElementById('manage-cats-add-label');
  if(mcAddLabel) mcAddLabel.textContent = L.addNewCategory;
  const catLabelInput = document.getElementById('catLabelInput');
  if(catLabelInput) catLabelInput.placeholder = L.catLabelPlaceholder;
  const catAddBtn = document.querySelector('#manageCatsOverlay .cat-add-btn');
  if(catAddBtn) catAddBtn.textContent = L.catAddBtn;
  const btnManageCats2 = document.getElementById('btnManageCats');
  if(btnManageCats2) btnManageCats2.textContent = L.catAddCatBtn;

  // Refresh avatar name labels when language switches
  refreshAvNames();

  renderBooks(); // re-render so status badges update
  }catch(e){ console.warn('applyLang error:', e); }
}
// Call applyLang on load
document.addEventListener('DOMContentLoaded', ()=>{ applyLang(); initAvGrids(); });


// ============================================================
//                            END                            
// ============================================================