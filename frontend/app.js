const API_BASE = "https://4zruyyxh4m.execute-api.us-east-2.amazonaws.com";
const DEFAULT_CONFIG = {p1Hr:2,p2Hr:4,p3Hr:8,eod:'00:00',target:50};
const POINTS = {p1:{onTime:12,late:6,miss:-6},p2:{onTime:8,late:4,miss:-4},p3:{onTime:5,late:2,miss:-2}};
const COGNITO_CONFIG = window.__MERIDIAN_COGNITO_CONFIG__ || {};
const COGNITO_SCOPE = typeof COGNITO_CONFIG.scope === 'string' && COGNITO_CONFIG.scope.trim()
  ? COGNITO_CONFIG.scope.trim()
  : (Array.isArray(COGNITO_CONFIG.scope) && COGNITO_CONFIG.scope.length
    ? COGNITO_CONFIG.scope.join(' ')
    : 'openid email profile');
const OIDC = window.oidc || null;

let state = {
  user: null,
  tasks: [],
  points: 0,
  dailyEarned: 0,
  streak: 0,
  lastResetDate: null,
  lastResetAt: null,
  log: [],
  config: {...DEFAULT_CONFIG}
};

let draggedTaskId = null;
let dragHoverPriority = null;
let undoAction = null;
let undoTimer = null;
let authMode = 'login';
let authSession = null;
let userManager = null;

function isCognitoConfigured(){
  return Boolean(OIDC && COGNITO_CONFIG.domain && COGNITO_CONFIG.clientId && COGNITO_CONFIG.authority);
}

function getCognitoBaseUrl(){
  return isCognitoConfigured() ? `https://${String(COGNITO_CONFIG.domain).replace(/\/+$/, '')}` : '';
}

function getRedirectUri(){
  if(typeof COGNITO_CONFIG.redirectUri === 'string' && COGNITO_CONFIG.redirectUri.trim()) return COGNITO_CONFIG.redirectUri.trim();
  if(window.location && /^https?:$/.test(window.location.protocol)) return window.location.origin + window.location.pathname;
  return '';
}

function getLogoutUri(){
  if(typeof COGNITO_CONFIG.logoutUri === 'string' && COGNITO_CONFIG.logoutUri.trim()) return COGNITO_CONFIG.logoutUri.trim();
  return getRedirectUri();
}

function buildCognitoMetadata(){
  const baseUrl = getCognitoBaseUrl();
  return {
    authorization_endpoint: `${baseUrl}/oauth2/authorize`,
    token_endpoint: `${baseUrl}/oauth2/token`,
    end_session_endpoint: `${baseUrl}/logout`
  };
}

function ensureUserManager(){
  if(userManager || !isCognitoConfigured()) return userManager;
  const storage = new OIDC.WebStorageStateStore({store: window.localStorage});
  userManager = new OIDC.UserManager({
    authority: COGNITO_CONFIG.authority,
    client_id: COGNITO_CONFIG.clientId,
    redirect_uri: getRedirectUri(),
    post_logout_redirect_uri: getLogoutUri(),
    response_type: 'code',
    scope: COGNITO_SCOPE,
    loadUserInfo: false,
    automaticSilentRenew: true,
    monitorSession: false,
    userStore: storage,
    metadata: buildCognitoMetadata()
  });
  return userManager;
}

function getAuthIdentity(){
  if(authSession?.identity) return authSession.identity;
  const profile = authSession?.profile || {};
  const userId = profile.sub || profile.username || profile['cognito:username'] || profile.email || null;
  if(!userId) return null;
  return {
    userId,
    displayName: profile.preferred_username || profile.email || profile.username || userId,
    claims: profile
  };
}

function setLoginError(message){
  const el = document.getElementById('login-err');
  if(el) el.textContent = message || '';
}

function setAuthShellState(){
  const configured = isCognitoConfigured();
  document.body.classList.toggle('cognito-auth', configured);
  const password = document.getElementById('password');
  if(password) password.hidden = configured;
  const status = document.getElementById('auth-status');
  if(status){
    status.textContent = configured
      ? 'Amazon Cognito managed login is enabled.'
      : 'Demo login is active until Cognito is configured.';
  }
}

function updateAuthCopy(){
  const configured = isCognitoConfigured();
  const submit = document.getElementById('auth-submit');
  const hint = document.getElementById('auth-hint');
  const copy = document.getElementById('auth-copy');
  const switchBtn = document.getElementById('auth-switch');
  const switchPrefix = document.getElementById('auth-switch-prefix');

  if(submit){
    submit.textContent = configured
      ? (authMode === 'signup' ? 'Create account' : 'Continue with Cognito')
      : (authMode === 'signup' ? 'Sign up' : 'Log in');
  }

  if(hint){
    hint.textContent = configured
      ? (authMode === 'signup'
        ? 'You will finish registration in Amazon Cognito.'
        : 'You will be redirected to Amazon Cognito.')
      : 'Demo access.';
  }

  if(copy){
    copy.textContent = configured
      ? (authMode === 'signup'
        ? 'Create your account in managed login, then return here automatically.'
        : 'Sign in through the Cognito hosted login page.')
      : (authMode === 'signup'
        ? 'Set up a workspace for later.'
        : 'A quiet place for the day ahead.');
  }

  if(switchBtn){
    switchBtn.textContent = authMode === 'signup' ? 'Log in' : 'Sign up';
    switchBtn.onclick = () => setAuthMode(authMode === 'signup' ? 'login' : 'signup');
  }

  if(switchPrefix){
    switchPrefix.textContent = authMode === 'signup' ? 'Already inside?' : 'New here?';
  }
}

function setAuthMode(mode){
  authMode = mode === 'signup' ? 'signup' : 'login';
  updateAuthCopy();
  const username = document.getElementById('username');
  if(username) username.focus();
}

async function startCognitoFlow(mode, loginHint = ''){
  const manager = ensureUserManager();
  if(!manager) throw new Error('Cognito is not configured.');
  if(mode === 'signup'){
    const signinRequest = await manager._client.createSigninRequest({
      login_hint: loginHint || undefined
    });
    const signupUrl = new URL(signinRequest.url);
    signupUrl.pathname = '/signup';
    window.location.assign(signupUrl.toString());
    return;
  }
  await manager.signinRedirect({
    login_hint: loginHint || undefined
  });
}

async function restoreCognitoSession(){
  const manager = ensureUserManager();
  if(!manager) return null;
  const user = await manager.getUser();
  if(!user){
    authSession = null;
    return null;
  }
  authSession = user;
  if(user.expired || (typeof user.expires_in === 'number' && user.expires_in < 60)){
    try{
      const refreshed = await manager.signinSilent();
      if(refreshed){
        authSession = refreshed;
        return refreshed;
      }
    }catch(e){
      console.warn('Cognito session refresh failed', e);
      authSession = null;
      await manager.removeUser().catch(()=>{});
      return null;
    }
  }
  return user;
}

async function getActiveCognitoAccessToken(){
  const manager = ensureUserManager();
  if(!manager) return null;
  let user = authSession || await manager.getUser();
  if(!user){
    authSession = null;
    return null;
  }
  if(user.expired || (typeof user.expires_in === 'number' && user.expires_in < 60)){
    try{
      user = await manager.signinSilent();
    }catch(e){
      console.warn('Cognito session refresh failed while preparing a request', e);
      authSession = null;
      await manager.removeUser().catch(()=>{});
      return null;
    }
  }
  authSession = user;
  return user.access_token || user.accessToken || null;
}

async function signOutRedirect(){
  const manager = ensureUserManager();
  if(!manager) return;
  const user = authSession || await manager.getUser();
  const idTokenHint = user?.id_token || user?.idToken || undefined;
  await manager.removeUser().catch(()=>{});
  await manager.signoutRedirect({
    id_token_hint: idTokenHint,
    post_logout_redirect_uri: getLogoutUri()
  });
}

async function completeCognitoRedirect(){
  const manager = ensureUserManager();
  if(!manager) return false;
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if(error){
    throw new Error(url.searchParams.get('error_description') || error);
  }
  if(!code) return false;
  const user = await manager.signinCallback();
  authSession = user || null;
  window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
  return Boolean(user);
}

async function enterApp(userKey){
  await loadState(userKey);
  await loadRemoteTasks(userKey);
  document.getElementById('login-screen').style.display='none';
  document.getElementById('app').style.display='flex';
  syncSettings();
  await checkEODReset();
  render();
  startTick();
}

async function bootstrapAuth(){
  updateAuthCopy();
  setAuthShellState();
  const manager = ensureUserManager();
  if(!manager) return;
  try{
    if(await completeCognitoRedirect()){
      const identity = getAuthIdentity();
      if(identity?.userId){
        await enterApp(identity.userId);
        return;
      }
    }
    const restored = await restoreCognitoSession();
    if(restored){
      const identity = getAuthIdentity();
      if(identity?.userId){
        await enterApp(identity.userId);
      }
    }
  }catch(e){
    console.error('Could not restore Cognito session', e);
    setLoginError(e.message || 'Could not restore your Cognito session.');
    authSession = null;
    await manager.removeUser().catch(()=>{});
  }
}

function normalizeTask(task, fallbackIndex = 0){
  const taskId = task?.taskId ?? task?.id ?? `local-${Date.now()}-${fallbackIndex}`;
  return {
    id: String(taskId),
    taskId: String(taskId),
    userId: task?.userId ?? state.user,
    name: task?.name ?? task?.title ?? 'Untitled Task',
    priority: task?.priority || 'dz',
    recurring: Boolean(task?.recurring),
    startedAt: task?.startedAt ?? null,
    elapsedBeforeMove: task?.elapsedBeforeMove ?? 0,
    scheduledTime: normalizeTimeInput(task?.scheduledTime || ''),
    createdAt: task?.createdAt ?? null,
    updatedAt: task?.updatedAt ?? null
  };
}

function serializeState(){
  const {tasks, ...rest} = state;
  return rest;
}

function saveState(){
  if(!state.user) return;
  try{localStorage.setItem('meridian_'+state.user, JSON.stringify(serializeState()));}catch(e){}
}

async function apiRequest(path, options = {}){
  const {method = 'GET', body} = options;
  const init = {
    method,
    headers: {
      'Content-Type': 'application/json'
    }
  };
  const accessToken = await getActiveCognitoAccessToken();
  if(accessToken){
    init.headers.Authorization = `Bearer ${accessToken}`;
  }
  if(body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(API_BASE + path, init);
  const text = await response.text();
  let data = null;
  if(text){
    try{
      data = JSON.parse(text);
    }catch(e){
      data = text;
    }
  }
  if(!response.ok){
    const message = (data && data.message) ? data.message : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}

async function loadTasksFromApi(user){
  const items = await apiRequest(`/tasks?userId=${encodeURIComponent(user)}`);
  if(!Array.isArray(items)) return [];
  return items.map((task, index) => normalizeTask(task, index));
}

async function createTaskOnApi(task){
  const created = await apiRequest('/tasks', {
    method: 'POST',
    body: {
      userId: state.user,
      name: task.name,
      priority: task.priority,
      recurring: task.recurring,
      startedAt: task.startedAt,
      elapsedBeforeMove: task.elapsedBeforeMove,
      scheduledTime: task.scheduledTime
    }
  });
  return normalizeTask(created);
}

async function updateTaskOnApi(task){
  const updated = await apiRequest(`/tasks/${encodeURIComponent(task.taskId)}`, {
    method: 'PUT',
    body: {
      userId: state.user,
      taskId: task.taskId,
      name: task.name,
      priority: task.priority,
      recurring: task.recurring,
      startedAt: task.startedAt,
      elapsedBeforeMove: task.elapsedBeforeMove,
      scheduledTime: task.scheduledTime
    }
  });
  return normalizeTask(updated);
}

async function deleteTaskOnApi(task){
  return apiRequest(`/tasks/${encodeURIComponent(task.taskId)}`, {
    method: 'DELETE',
    body: {
      userId: state.user,
      taskId: task.taskId
    }
  });
}

function syncAuthMode(){
  updateAuthCopy();
  setAuthShellState();
}

async function loadState(user){
  try{
    const d = localStorage.getItem('meridian_'+user);
    if(d){
      const persisted = JSON.parse(d);
      state = {
        user,
        tasks: [],
        points: typeof persisted.points === 'number' ? persisted.points : 0,
        dailyEarned: typeof persisted.dailyEarned === 'number' ? persisted.dailyEarned : 0,
        streak: typeof persisted.streak === 'number' ? persisted.streak : 0,
        lastResetDate: persisted.lastResetDate ?? null,
        lastResetAt: typeof persisted.lastResetAt === 'number' ? persisted.lastResetAt : null,
        log: Array.isArray(persisted.log) ? persisted.log.map(normalizeLogEntry) : [],
        config: {...DEFAULT_CONFIG, ...(persisted.config||{})}
      };
      if(state.config.target == null && state.config.cap != null) state.config.target = state.config.cap;
      if(state.config.cap == null && state.config.target != null) state.config.cap = state.config.target;
      state.user = user;
      return;
    }
  }catch(e){}
  state = {user,tasks:[],points:0,dailyEarned:0,streak:0,lastResetDate:null,lastResetAt:null,log:[],config:{...DEFAULT_CONFIG}};
}

function setTasks(tasks){
  state.tasks = tasks.map((task, index) => normalizeTask(task, index));
}

async function loadRemoteTasks(user){
  try{
    const tasks = await loadTasksFromApi(user);
    setTasks(tasks);
    return true;
  }catch(e){
    console.error('Could not load tasks from API', e);
    state.tasks = [];
    return false;
  }
}

async function tryLogin(){
  const u = document.getElementById('username').value.trim();
  const p = document.getElementById('password').value;
  if(isCognitoConfigured()){
    if(!u){setLoginError('Enter a username or email.');return;}
    setLoginError('');
    try{
      await startCognitoFlow(authMode, u);
    }catch(e){
      console.error('Could not start Cognito flow', e);
      setLoginError(e.message || 'Could not start Cognito sign-in.');
    }
    return;
  }
  if(!u){setLoginError('Enter a username.');return;}
  if(!p){setLoginError('Enter a password.');return;}
  setLoginError('');
  await loadState(u);
  await loadRemoteTasks(u);
  document.getElementById('login-screen').style.display='none';
  document.getElementById('app').style.display='flex';
  syncSettings();
  await checkEODReset();
  render();
  startTick();
}

function logout(){
  saveState();
  clearInterval(window._tick);
  const configured = isCognitoConfigured();
  state.user=null;
  authSession = null;
  setAuthMode('login');
  document.getElementById('login-screen').style.display='flex';
  document.getElementById('app').style.display='none';
  document.getElementById('username').value='';
  document.getElementById('password').value='';
  setLoginError('');
  if(configured){
    void signOutRedirect().catch(err => {
      console.error('Could not sign out from Cognito', err);
    });
    return;
  }
}

document.getElementById('password').addEventListener('keydown',e=>{if(e.key==='Enter')tryLogin();});
document.getElementById('username').addEventListener('keydown',e=>{
  if(e.key!=='Enter') return;
  if(isCognitoConfigured()){
    tryLogin();
    return;
  }
  document.getElementById('password').focus();
});

function getDurationSec(priority){
  const defaults = {p1:2*3600,p2:4*3600,p3:8*3600};
  const set = {p1:state.config.p1Hr*3600,p2:state.config.p2Hr*3600,p3:state.config.p3Hr*3600};
  return set[priority] || defaults[priority];
}
function getPoints(priority){
  const base = POINTS[priority];
  if(!base) return {onTime:0,late:0,miss:0};
  return base;
}

function getLocalDateKey(date = new Date()){
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function todayStr(){
  return getLocalDateKey();
}

function getResetBoundary(date = new Date()){
  const boundary = new Date(date);
  const [h, m] = String(state.config.eod || '00:00').split(':').map(Number);
  boundary.setHours(h, m, 0, 0);
  return boundary;
}

function getCurrentWorkdayKey(date = new Date()){
  const boundary = getResetBoundary(date);
  const workday = new Date(date);
  if(date < boundary) workday.setDate(workday.getDate() - 1);
  return getLocalDateKey(workday);
}

function getPreviousWorkdayKey(date = new Date()){
  const day = new Date(date);
  day.setDate(day.getDate() - 1);
  return getLocalDateKey(day);
}

function getWorkdayKeyForTimestamp(timestamp){
  return getCurrentWorkdayKey(new Date(timestamp));
}

function parseLoggedTimestamp(dateKey, timeValue){
  const dateMatch = String(dateKey || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = String(timeValue || '').trim().match(/^(\d{1,2}):(\d{2})(?:\s*([AP]M))?$/i);
  if(!dateMatch || !timeMatch) return null;
  let hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  const meridian = timeMatch[3] ? timeMatch[3].toUpperCase() : null;
  if(Number.isNaN(hours) || Number.isNaN(minutes) || minutes < 0 || minutes > 59) return null;
  if(meridian === 'AM'){
    if(hours === 12) hours = 0;
  }else if(meridian === 'PM'){
    if(hours !== 12) hours += 12;
  }
  if(hours < 0 || hours > 23) return null;
  const d = new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]), hours, minutes, 0, 0);
  return d;
}

function normalizeLogEntry(entry){
  if(!entry || typeof entry !== 'object') return entry;
  if(typeof entry.at === 'number' && typeof entry.dayKey === 'string') return entry;
  const parsed = parseLoggedTimestamp(entry.date, entry.time);
  const at = typeof entry.at === 'number' ? entry.at : (parsed ? parsed.getTime() : Date.now());
  const dayKey = typeof entry.dayKey === 'string' ? entry.dayKey : getWorkdayKeyForTimestamp(at);
  return {...entry, at, dayKey};
}

function getEarnedForDate(dateKey){
  return state.log.reduce((sum, entry) => {
    const normalized = normalizeLogEntry(entry);
    return sum + (normalized.dayKey === dateKey ? (normalized.pts || 0) : 0);
  }, 0);
}

function formatLogDate(dateKey){
  const today = getCurrentWorkdayKey();
  if(dateKey === today) return 'Today';

  const yesterday = getPreviousWorkdayKey();
  if(dateKey === yesterday) return 'Yesterday';

  const parsed = new Date(dateKey + 'T12:00:00');
  if(Number.isNaN(parsed.getTime())) return dateKey;
  try{
    return new Intl.DateTimeFormat(undefined, {weekday:'short', month:'short', day:'numeric'}).format(parsed);
  }catch(e){
    return dateKey;
  }
}

function addPoints(pts, desc, dateKey = getCurrentWorkdayKey()){
  const at = Date.now();
  const entryDateKey = dateKey || getCurrentWorkdayKey(new Date(at));
  state.points = Math.max(0, state.points + pts);
  const ts = new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  state.log.unshift({pts, desc, time: ts, at, dayKey: entryDateKey, date: entryDateKey});
  if(state.log.length > 200) state.log.pop();
  state.dailyEarned = getEarnedForDate(getCurrentWorkdayKey());
  saveState();
}

function updateTopbar(){
  const target = Math.max(1, state.config.target || 50);
  const today = document.getElementById('today-display');
  const todayKey = getCurrentWorkdayKey();
  const earnedToday = getEarnedForDate(todayKey);
  state.dailyEarned = earnedToday;
  const done = earnedToday >= target;
  if(today){
    const remaining = Math.max(0, target - earnedToday);
    today.textContent = done ? target + ' / ' + target : remaining + ' left today';
    today.dataset.state = done ? 'done' : remaining <= Math.max(5, Math.ceil(target * 0.25)) ? 'warning' : 'pending';
  }
}

function nowSec(){return Date.now()/1000;}
function fmtTimer(sec){
  if(sec<=0) return '0:00';
  const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s=Math.floor(sec%60);
  if(h>0) return h+':'+(m<10?'0':'')+m+':'+(s<10?'0':'')+s;
  return m+':'+(s<10?'0':'')+s;
}
function getScheduledStartSec(task){
  if(!task || !task.scheduledTime) return null;
  const normalized = normalizeTimeInput(task.scheduledTime);
  if(!normalized) return null;
  const [hours, minutes] = normalized.split(':').map(Number);
  const d = new Date();
  d.setHours(hours, minutes, 0, 0);
  return d.getTime() / 1000;
}
function isScheduledPending(task){
  if(!task || task.priority === 'dz' || !task.scheduledTime) return false;
  const scheduledStart = getScheduledStartSec(task);
  return scheduledStart != null && nowSec() < scheduledStart;
}
function getElapsedSec(task){
  if(!task.startedAt) return 0;
  const scheduledStart = getScheduledStartSec(task);
  const effectiveStart = scheduledStart == null ? task.startedAt : Math.max(task.startedAt, scheduledStart);
  return Math.max(0, nowSec() - effectiveStart);
}
function isLate(task){
  if(!task.priority || task.priority==='dz') return false;
  return getElapsedSec(task) > getDurationSec(task.priority);
}

// EOD
function getEODToday(){
  const [h,m] = state.config.eod.split(':').map(Number);
  const d = new Date(); d.setHours(h,m,0,0);
  if(d<=new Date()) d.setDate(d.getDate()+1);
  return d;
}
async function checkEODReset(){
  const now = new Date();
  const boundary = getResetBoundary(now);
  if(now < boundary) return false;
  const boundaryTs = boundary.getTime();
  if(typeof state.lastResetAt === 'number' && state.lastResetAt >= boundaryTs) return false;
  const today = getCurrentWorkdayKey(now);
  const previousDay = getPreviousWorkdayKey(now);
  const newTasks = [];
  const syncActions = [];
  for(const t of state.tasks){
    if(t.priority && t.priority !== 'dz'){
      const p = getPoints(t.priority);
      addPoints(p.miss, 'Missed: '+priorityLabel(t.priority)+' - '+t.name, previousDay);
      if(t.recurring){
        const resetTask = {...t, priority:'dz', startedAt:null, elapsedBeforeMove:0};
        newTasks.push(resetTask);
        syncActions.push(updateTaskOnApi(resetTask));
      } else {
        syncActions.push(deleteTaskOnApi(t));
      }
    } else {
      if(t.recurring){
        const resetTask = {...t, priority:'dz', startedAt:null, elapsedBeforeMove:0};
        newTasks.push(resetTask);
        syncActions.push(updateTaskOnApi(resetTask));
      }
      // single-use in pending: deleted
    }
  }
  state.tasks = newTasks;
  if(getEarnedForDate(previousDay) >= Math.max(1, state.config.target || 50)) state.streak++;
  else state.streak = 0;
  state.dailyEarned = getEarnedForDate(today);
  state.lastResetDate = today;
  state.lastResetAt = Date.now();
  saveState();
  await Promise.allSettled(syncActions);
  return true;
}

function updateEODBar(){
  const eod = getEODToday();
  const diff = Math.max(0, (eod - Date.now())/1000);
  const el = document.getElementById('eod-countdown');
  if(el) el.textContent = 'Reset in ' + fmtTimer(diff);
}

// RENDER
function getPriorityColor(p){
  if(p==='p1') return 'var(--p1)';
  if(p==='p2') return 'var(--p2)';
  if(p==='p3') return 'var(--p3)';
  return 'var(--dz)';
}

function priorityLabel(priority){
  return priority==='p1' ? 'High priority' : priority==='p2' ? 'Medium priority' : priority==='p3' ? 'Low priority' : 'Pending';
}

function normalizeTimeInput(value){
  if(typeof value !== 'string') return '';
  const match = value.trim().match(/^(\d{2}):(\d{2})$/);
  if(!match) return '';
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if(Number.isNaN(hours) || Number.isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return '';
  return `${match[1]}:${match[2]}`;
}

function formatScheduleTime(value){
  const normalized = normalizeTimeInput(value);
  if(!normalized) return '';
  const [hours, minutes] = normalized.split(':').map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  try{
    return new Intl.DateTimeFormat(undefined, {hour:'numeric', minute:'2-digit'}).format(date);
  }catch(e){
    const h = hours % 12 || 12;
    const ampm = hours < 12 ? 'AM' : 'PM';
    return `${h}:${String(minutes).padStart(2,'0')} ${ampm}`;
  }
}

function clearUndoToast(){
  if(undoTimer){
    clearTimeout(undoTimer);
    undoTimer = null;
  }
  undoAction = null;
  const toast = document.getElementById('undo-toast');
  if(toast) toast.hidden = true;
}

function showUndoToast(message, action){
  clearUndoToast();
  undoAction = action;
  const text = document.getElementById('undo-toast-text');
  const toast = document.getElementById('undo-toast');
  if(text) text.textContent = message;
  if(toast) toast.hidden = false;
  undoTimer = setTimeout(clearUndoToast, 6000);
}

function undoLastAction(){
  if(!undoAction) return;
  const action = undoAction;
  clearUndoToast();
  action();
}

function renderCard(task){
  const el = document.createElement('div');
  el.className='task-card';
  el.dataset.priority = task.priority || 'dz';
  el.dataset.id=task.taskId || task.id;
  el.draggable = true;
  el.addEventListener('dragstart', e => startTaskDrag(task.taskId || task.id, e));
  el.addEventListener('dragend', endTaskDrag);

  // Name
  const nm = document.createElement('div');
  nm.className='task-name'; nm.textContent=task.name;
  el.appendChild(nm);

  // Tags
  const tags = document.createElement('div'); tags.className='task-tags';
  if(task.recurring){const t=document.createElement('span');t.className='tag tag-recurring';t.textContent='Repeat';tags.appendChild(t);}
  if(task.scheduledTime){const t=document.createElement('span');t.className='tag tag-scheduled';t.textContent='At '+formatScheduleTime(task.scheduledTime);tags.appendChild(t);}
  const late = task.priority && task.priority!=='dz' && isLate(task);
  if(late) el.classList.add('is-late');
  const waiting = isScheduledPending(task);
  if(waiting) el.classList.add('is-waiting');
  if(tags.childElementCount>0) el.appendChild(tags);

  // Timer bar (if in a priority)
  if(task.priority && task.priority!=='dz'){
    const dur = getDurationSec(task.priority);
    const elapsed = getElapsedSec(task);
    const frac = waiting ? 0 : Math.max(0, 1 - elapsed/dur);
    const bar = document.createElement('div'); bar.className='task-timer';
    const lrow = document.createElement('div'); lrow.className='timer-label';
    const ll = document.createElement('span');
    ll.textContent = waiting
      ? 'Starts at '+formatScheduleTime(task.scheduledTime)
      : frac>0
        ? fmtTimer(Math.max(0,dur-elapsed))+' left'
        : 'Late';
    lrow.appendChild(ll);
    const bg = document.createElement('div'); bg.className='timer-bar-bg';
    const fill = document.createElement('div'); fill.className='timer-bar-fill';
    const color = waiting
      ? '#b8c0c8'
      : task.priority === 'p1'
        ? 'var(--p1)'
        : frac > 0.5
          ? getPriorityColor(task.priority)
          : frac > 0.2
            ? 'var(--p2)'
            : 'var(--p1)';
    fill.style.cssText='width:'+Math.round(frac*100)+'%;background:'+color;
    bg.appendChild(fill); bar.appendChild(lrow); bar.appendChild(bg);
    el.appendChild(bar);
  }

  // Actions
  const acts = document.createElement('div'); acts.className='task-actions';
  const mkBtn=(label,cls,fn)=>{const b=document.createElement('button');b.className='act-btn '+(cls||'');b.textContent=label;b.onclick=fn;return b;};

  // Complete
  acts.appendChild(mkBtn('Done','complete',()=>completeTask(task.taskId || task.id)));
  // Delete
  acts.appendChild(mkBtn('Delete','delete',()=>deleteTask(task.taskId || task.id)));
  // Recurring toggle
  acts.appendChild(mkBtn(task.recurring?'Once':'Repeat','',()=>toggleRecurring(task.taskId || task.id)));

  el.appendChild(acts);
  return el;
}

function startTaskDrag(id, event){
  draggedTaskId = id;
  dragHoverPriority = null;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', String(id));

  requestAnimationFrame(() => {
    const card = document.querySelector(`.task-card[data-id="${id}"]`);
    if(card) card.classList.add('is-dragging');
  });
}

function endTaskDrag(){
  draggedTaskId = null;
  dragHoverPriority = null;
  document.querySelectorAll('.task-card.is-dragging').forEach(el => el.classList.remove('is-dragging'));
  document.querySelectorAll('.col.is-drop-target').forEach(el => el.classList.remove('is-drop-target'));
}

function handleColumnDragOver(event, priority){
  if(draggedTaskId == null) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  if(dragHoverPriority === priority) return;
  document.querySelectorAll('.col.is-drop-target').forEach(el => el.classList.remove('is-drop-target'));
  event.currentTarget.classList.add('is-drop-target');
  dragHoverPriority = priority;
}

function dropTask(event, priority){
  event.preventDefault();
  const rawId = event.dataTransfer.getData('text/plain');
  const id = draggedTaskId ?? rawId;
  if(id != null && id !== '') moveTask(id, priority);
  endTaskDrag();
}

function updateLiveTaskVisuals(){
  for(const task of state.tasks){
    if(!task.priority || task.priority === 'dz') continue;
    const card = document.querySelector(`.task-card[data-id="${task.taskId || task.id}"]`);
    if(!card) continue;

    const waiting = isScheduledPending(task);
    const elapsed = getElapsedSec(task);
    const dur = getDurationSec(task.priority);
    const frac = waiting ? 0 : Math.max(0, 1 - elapsed / dur);
    const late = !waiting && frac <= 0;

    card.classList.toggle('is-late', late);
    card.classList.toggle('is-waiting', waiting);
    card.dataset.priority = task.priority;

    const label = card.querySelector('.timer-label span');
    if(label){
      label.textContent = waiting
        ? 'Starts at ' + formatScheduleTime(task.scheduledTime)
        : late
          ? 'Late'
          : fmtTimer(Math.max(0, dur - elapsed)) + ' left';
    }

    const fill = card.querySelector('.timer-bar-fill');
    if(fill){
      fill.style.width = Math.round(frac * 100) + '%';
      fill.style.background = waiting
        ? '#b8c0c8'
        : task.priority === 'p1'
          ? 'var(--p1)'
          : frac > 0.5
            ? getPriorityColor(task.priority)
            : frac > 0.2
              ? 'var(--p2)'
              : 'var(--p1)';
    }

  }
}

function render(){
  const priorities = ['dz','p3','p2','p1'];
  const emptyStateText = {
    dz: 'Add a task to start.',
    p3: 'No low priority tasks.',
    p2: 'No medium priority tasks.',
    p1: 'No high priority tasks.'
  };
  for(const p of priorities){
    const col = document.getElementById('tasks-'+p);
    col.innerHTML='';
    const items = state.tasks.filter(t=>t.priority===p);
    if(items.length){
      for(const t of items) col.appendChild(renderCard(t));
    }else{
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.dataset.priority = p;
      empty.textContent = emptyStateText[p];
      col.appendChild(empty);
    }
  }
  updateTopbar();
  updateEODBar();
  renderLog();
}

function renderLog(){
  const list = document.getElementById('log-list');
  list.innerHTML='';
  if(!state.log.length){list.innerHTML='<div class="log-empty">No entries yet.</div>';return;}
  const entries = state.log
    .map(normalizeLogEntry)
    .filter(Boolean)
    .sort((a,b) => (b.at || 0) - (a.at || 0));
  const buckets = new Map();
  for(const entryData of entries){
    const key = entryData.dayKey || getWorkdayKeyForTimestamp(entryData.at || Date.now());
    if(!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(entryData);
  }

  const orderedKeys = [...buckets.keys()].sort((a,b) => {
    const aTs = (parseLoggedTimestamp(a, '12:00 AM') || new Date(a + 'T00:00:00')).getTime();
    const bTs = (parseLoggedTimestamp(b, '12:00 AM') || new Date(b + 'T00:00:00')).getTime();
    return bTs - aTs;
  });

  for(const dayKey of orderedKeys){
    const group = document.createElement('div');
    group.className = 'log-day-group';

    const head = document.createElement('div');
    head.className = 'log-day-head';

    const dayEntries = buckets.get(dayKey) || [];
    const dayTotal = dayEntries.reduce((sum, entry) => sum + (entry.pts || 0), 0);

    const label = document.createElement('div');
    label.className = 'log-day-label';
    label.textContent = formatLogDate(dayKey);

    const total = document.createElement('div');
    total.className = 'log-day-total';
    total.textContent = (dayTotal > 0 ? '+' : '') + dayTotal + ' XP';

    head.appendChild(label);
    head.appendChild(total);
    group.appendChild(head);

    for(const entryData of dayEntries){
      const el = document.createElement('div');
      el.className='log-item';
      const pts = document.createElement('div');
      pts.className='log-pts '+(entryData.pts>0?'log-pos':entryData.pts<0?'log-neg':'log-zero');
      pts.textContent=(entryData.pts>0?'+':'')+entryData.pts+' XP';
      const desc = document.createElement('div'); desc.className='log-desc'; desc.textContent=entryData.desc;
      const time = document.createElement('div'); time.className='log-time'; time.textContent=entryData.time;
      el.appendChild(pts); el.appendChild(desc); el.appendChild(time);
      group.appendChild(el);
    }

    list.appendChild(group);
  }
}

// TASK OPS
async function addTask(name, scheduledTime){
  const taskName = name.trim();
  if(!taskName) return;
  const time = normalizeTimeInput(scheduledTime);
  try{
    const created = await createTaskOnApi({
      name: taskName,
      priority: 'dz',
      recurring: false,
      startedAt: null,
      elapsedBeforeMove: 0,
      scheduledTime: time
    });
    state.tasks.push(created);
    saveState();
    render();
  }catch(e){
    console.error('Could not create task', e);
    alert('Could not create task. Please try again.');
  }
}
function handleAddKey(e){
  if(e.key!=='Enter') return;
  const nameInput = document.getElementById('new-task-input');
  const timeInput = document.getElementById('new-task-time');
  addTask(nameInput.value, timeInput.value);
  nameInput.value='';
  timeInput.value='';
}
async function completeTask(id){
  const t=state.tasks.find(x=>x.id===id);
  if(!t) return;
  try{
    await deleteTaskOnApi(t);
  }catch(e){
    console.error('Could not complete task', e);
    alert('Could not complete task. Please try again.');
    return;
  }
  if(t.priority && t.priority!=='dz'){
    const p=getPoints(t.priority);
    const late=isLate(t);
    const pts=late?p.late:p.onTime;
    addPoints(pts, (late?'Late':'On time')+': '+priorityLabel(t.priority)+' - '+t.name);
  }
  state.tasks=state.tasks.filter(x=>x.id!==id);
  saveState(); render();
}
async function deleteTask(id){
  const index = state.tasks.findIndex(x=>x.id===id);
  if(index < 0) return;
  const removed = {...state.tasks[index]};
  state.tasks.splice(index, 1);
  saveState(); render();
  try{
    await deleteTaskOnApi(removed);
  }catch(e){
    console.error('Could not delete task', e);
    state.tasks.splice(index, 0, removed);
    saveState(); render();
    alert('Could not delete task. Please try again.');
    return;
  }
  showUndoToast('Deleted "'+removed.name+'"', async () => {
    try{
      const recreated = await createTaskOnApi({
        name: removed.name,
        priority: removed.priority,
        recurring: removed.recurring,
        startedAt: removed.startedAt,
        elapsedBeforeMove: removed.elapsedBeforeMove,
        scheduledTime: removed.scheduledTime
      });
      const insertAt = Math.min(index, state.tasks.length);
      state.tasks.splice(insertAt, 0, recreated);
      saveState(); render();
    }catch(e){
      console.error('Could not undo delete', e);
      alert('Could not restore the task.');
    }
  });
}
async function toggleRecurring(id){
  const t=state.tasks.find(x=>x.id===id);
  if(!t) return;
  const previous = {...t};
  t.recurring=!t.recurring;
  saveState(); render();
  try{
    const updated = await updateTaskOnApi(t);
    const idx = state.tasks.findIndex(x=>x.id===updated.id);
    if(idx >= 0) state.tasks[idx] = updated;
    saveState(); render();
  }catch(e){
    console.error('Could not update recurring state', e);
    const idx = state.tasks.findIndex(x=>x.id===previous.id);
    if(idx >= 0) state.tasks[idx] = previous;
    saveState(); render();
    alert('Could not update task. Please try again.');
  }
}
async function moveTask(id, newPriority){
  const t=state.tasks.find(x=>x.id===id);
  if(!t) return;
  const oldPriority = t.priority;
  if(newPriority===oldPriority) return;
  const previous = {...t};
  const previousIndex = state.tasks.findIndex(x=>x.id===id);
  const wasDead = oldPriority === 'dz';
  const isDead = newPriority === 'dz';

  if(wasDead && !isDead){
    const pausedElapsed = t.elapsedBeforeMove || 0;
    t.startedAt = nowSec() - pausedElapsed;
  } else if(!wasDead && isDead){
    t.elapsedBeforeMove = getElapsedSec(t);
    t.startedAt = null;
  } else if(!wasDead && !isDead && !t.startedAt){
    t.startedAt = nowSec() - (t.elapsedBeforeMove || 0);
  }

  t.priority=newPriority;
  saveState(); render();
  try{
    const updated = await updateTaskOnApi(t);
    const currentIndex = state.tasks.findIndex(x=>x.id===updated.id);
    if(currentIndex >= 0) state.tasks[currentIndex] = updated;
    saveState(); render();
  }catch(e){
    console.error('Could not move task', e);
    const currentIndex = state.tasks.findIndex(x=>x.id===previous.id);
    if(currentIndex >= 0) state.tasks[currentIndex] = previous;
    else state.tasks.splice(Math.min(previousIndex, state.tasks.length), 0, previous);
    saveState(); render();
    alert('Could not move task. Please try again.');
    return;
  }
  showUndoToast('Moved "'+t.name+'" to '+priorityLabel(newPriority), async () => {
    try{
      const restored = await updateTaskOnApi(previous);
      const currentIndex = state.tasks.findIndex(x=>x.id===restored.id);
      if(currentIndex >= 0) state.tasks[currentIndex] = restored;
      else state.tasks.splice(Math.min(previousIndex, state.tasks.length), 0, restored);
      saveState(); render();
    }catch(e){
      console.error('Could not undo move', e);
      alert('Could not restore the previous task state.');
    }
  });
}

// SETTINGS
function syncSettings(){
  document.getElementById('s-p1-hr').value=state.config.p1Hr;
  document.getElementById('s-p2-hr').value=state.config.p2Hr;
  document.getElementById('s-p3-hr').value=state.config.p3Hr;
  document.getElementById('s-eod').value=state.config.eod||'00:00';
  document.getElementById('s-target').value=state.config.target ?? state.config.cap ?? 50;
}
function saveSettings(){
  const p1=parseFloat(document.getElementById('s-p1-hr').value)||2;
  const p2=parseFloat(document.getElementById('s-p2-hr').value)||4;
  const p3=parseFloat(document.getElementById('s-p3-hr').value)||8;
  state.config.p1Hr=Math.min(24,Math.max(.25,p1));
  state.config.p2Hr=Math.min(24,Math.max(.25,p2));
  state.config.p3Hr=Math.min(24,Math.max(.25,p3));
  state.config.eod=document.getElementById('s-eod').value||'00:00';
  state.config.target=Math.min(200,Math.max(20,parseInt(document.getElementById('s-target').value)||50));
  state.config.cap=state.config.target;
  syncSettings();
  saveState(); render();
}

// TABS
function switchTab(name, btn){
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  ['board','log','settings'].forEach(t=>{
    document.getElementById('tab-'+t).style.display=t===name?'block':'none';
  });
  if(name==='log') renderLog();
}

// TICK
function startTick(){
  clearInterval(window._tick);
  window._tick=setInterval(()=>{
    (async () => {
      if(await checkEODReset()){
        render();
        return;
      }
      updateLiveTaskVisuals();
      updateTopbar();
      updateEODBar();
    })().catch(err => console.error('Tick loop failed', err));
  }, 1000);
}

bootstrapAuth();
