/* ============================================================================
   ESPARTANOS STUDY — LÓGICA DA APLICAÇÃO
   Estado persistido no localStorage.
============================================================================ */

const STORAGE_KEY = 'espartanos-study-state-v1';

/* ---------- Configuração de níveis ---------- */
const LEVEL_TITLES = [
  [1, 5, 'Aprendiz'],
  [6, 10, 'Recruta'],
  [11, 15, 'Guerreiro'],
  [16, 20, 'Hoplita'],
  [21, 25, 'Centurião'],
  [26, 29, 'General'],
  [30, 30, 'Mestre do Foco'],
];
const MAX_LEVEL = 30;

function xpNeededFor(level){
  return 100 + (level - 1) * 50;
}
function titleForLevel(level){
  const row = LEVEL_TITLES.find(([min, max]) => level >= min && level <= max);
  return row ? row[2] : 'Aprendiz';
}

/* ---------- Estado padrão ---------- */
function defaultState(){
  return {
    level: 1,
    xp: 0,
    streak: 0,
    lastStudyDate: null,
    dailyGoalMinutes: 180,
    dailyStudiedMinutes: 0,
    dailyDate: null,
    cyclesToday: 0,
    tasks: [],
    week: {
      weekKey: null,
      totalMinutes: 0,
      tasksCompleted: 0,
      subjects: {}
    }
  };
}

function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return Object.assign(defaultState(), parsed);
  }catch(e){
    console.warn('Falha ao ler estado salvo, iniciando do zero.', e);
    return defaultState();
  }
}
function saveState(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

let state = loadState();

/* ---------- Utilidades de data ---------- */
function todayKey(d = new Date()){
  return d.toISOString().slice(0,10);
}
function isoWeekKey(d = new Date()){
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${weekNo}`;
}

function rollDailyAndWeekly(){
  const tKey = todayKey();
  if(state.dailyDate !== tKey){
    state.dailyDate = tKey;
    state.dailyStudiedMinutes = 0;
    state.cyclesToday = 0;
  }
  const wKey = isoWeekKey();
  if(state.week.weekKey !== wKey){
    state.week = { weekKey: wKey, totalMinutes: 0, tasksCompleted: 0, subjects: {} };
  }
}
rollDailyAndWeekly();

/* ---------- Concessão de XP e progressão de nível ---------- */
function grantXP(amount, reasonLabel){
  state.xp += amount;
  let needed = xpNeededFor(state.level);
  while(state.xp >= needed && state.level < MAX_LEVEL){
    state.xp -= needed;
    state.level += 1;
    needed = xpNeededFor(state.level);
    showToast(`Subiu para o nível ${state.level} — ${titleForLevel(state.level)}!`);
  }
  if(state.level >= MAX_LEVEL){
    state.xp = Math.min(state.xp, xpNeededFor(MAX_LEVEL));
  }
  if(reasonLabel) showToast(`+${amount} XP · ${reasonLabel}`);
  saveState();
  renderAll();
}

function registerStudyForStreak(){
  const tKey = todayKey();
  if(state.lastStudyDate === tKey) return; 
  const y = new Date(); y.setDate(y.getDate() - 1);
  const yesterdayKey = todayKey(y);
  if(state.lastStudyDate === yesterdayKey){
    state.streak += 1;
  } else {
    state.streak = 1;
  }
  state.lastStudyDate = tKey;
}

function showToast(text){
  const layer = document.getElementById('toast-layer');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  layer.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

/* ============================================================================
   POMODORO
============================================================================ */
const FOCUS_SECONDS = 25 * 60;
const BREAK_SECONDS = 5 * 60;

let timer = { mode: 'focus', remaining: FOCUS_SECONDS, running: false, intervalId: null };

const timeDisplay   = document.getElementById('time-display');
const phaseDisplay  = document.getElementById('phase-display');
const startBtn      = document.getElementById('start-btn');
const resetBtn      = document.getElementById('reset-btn');
const modeFocusBtn  = document.getElementById('mode-focus-btn');
const modeBreakBtn  = document.getElementById('mode-break-btn');
const progCircle    = document.getElementById('prog-circle');
const distractionModal = document.getElementById('distraction-modal');
const resumeBtn     = document.getElementById('resume-btn');
const subjectField  = document.getElementById('subject-field');

const RADIUS = 100;
const CIRC = 2 * Math.PI * RADIUS;
progCircle.style.strokeDasharray = `${CIRC}`;

function totalForMode(mode) { return mode === 'focus' ? FOCUS_SECONDS : BREAK_SECONDS; }
function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function renderTimer(){
  timeDisplay.textContent = formatTime(timer.remaining);
  const total = totalForMode(timer.mode);
  const progressRatio = 1 - (timer.remaining / total);
  progCircle.style.strokeDashoffset = `${CIRC * (1 - progressRatio)}`;
  phaseDisplay.textContent = timer.running
    ? (timer.mode === 'focus' ? 'Focando…' : 'Em pausa…')
    : (timer.mode === 'focus' ? 'Pronto para focar' : 'Pronto para pausar');
  startBtn.textContent = timer.running ? 'Pausar' : (timer.remaining < total ? 'Continuar' : 'Iniciar');
  modeFocusBtn.classList.toggle('active', timer.mode === 'focus');
  modeBreakBtn.classList.toggle('active', timer.mode === 'break');
  document.getElementById('cycle-count').textContent =
    `${state.cyclesToday} ciclo(s) de foco concluído(s) hoje`;
}

function tick(){
  timer.remaining -= 1;
  if(timer.remaining <= 0){ completeCycle(); return; }
  renderTimer();
}
function startTimer(){ timer.running = true; clearInterval(timer.intervalId); timer.intervalId = setInterval(tick, 1000); renderTimer(); }
function pauseTimer(){ timer.running = false; clearInterval(timer.intervalId); renderTimer(); }
function resetTimer(){ pauseTimer(); timer.remaining = totalForMode(timer.mode); renderTimer(); }
function switchMode(mode){ timer.mode = mode; resetTimer(); }

function completeCycle(){
  pauseTimer();
  timer.remaining = 0;
  renderTimer();

  if(timer.mode === 'focus'){
    const minutes = FOCUS_SECONDS / 60;
    state.cyclesToday += 1;
    state.dailyStudiedMinutes += minutes;
    state.week.totalMinutes += minutes;
    const subject = (subjectField.value || 'Geral').trim() || 'Geral';
    state.week.subjects[subject] = (state.week.subjects[subject] || 0) + minutes;
    registerStudyForStreak();
    grantXP(25, 'Ciclo de foco concluído');
    switchMode('break');
  } else {
    showToast('Pausa concluída — hora de focar de novo!');
    switchMode('focus');
  }
}

startBtn.addEventListener('click', () => { if(timer.running) pauseTimer(); else startTimer(); });
resetBtn.addEventListener('click', resetTimer);
modeFocusBtn.addEventListener('click', () => { if(!timer.running) switchMode('focus'); });
modeBreakBtn.addEventListener('click', () => { if(!timer.running) switchMode('break'); });

/* ---------- Mecânica anti-distração ---------- */
let wasDistracted = false;

document.addEventListener('visibilitychange', () => {
  if(document.hidden && timer.running && timer.mode === 'focus'){
    pauseTimer();
    wasDistracted = true;
    distractionModal.classList.add('open');
  }
});
window.addEventListener('blur', () => {
  if(timer.running && timer.mode === 'focus'){
    pauseTimer();
    wasDistracted = true;
    distractionModal.classList.add('open');
  }
});
resumeBtn.addEventListener('click', () => {
  distractionModal.classList.remove('open');
  wasDistracted = false;
  startTimer();
});

/* ============================================================================
   TO-DO LIST
============================================================================ */
const taskForm      = document.getElementById('task-form');
const taskTextInput = document.getElementById('task-text');
const taskPomInput  = document.getElementById('task-pomodoros');
const taskListEl    = document.getElementById('task-list');
const emptyNote     = document.getElementById('empty-note');

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

taskForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = taskTextInput.value.trim();
  if(!text) return;
  const pomodoros = Math.max(0, parseInt(taskPomInput.value, 10) || 0);
  state.tasks.unshift({ id: uid(), text, pomodoros, done: false });
  taskTextInput.value = '';
  taskPomInput.value = 1;
  saveState();
  renderTasks();
});

function toggleTask(id){
  const task = state.tasks.find(t => t.id === id);
  if(!task) return;
  task.done = !task.done;
  if(task.done){
    state.week.tasksCompleted += 1;
    saveState();
    grantXP(10, 'Tarefa concluída'); 
  } else {
    state.week.tasksCompleted = Math.max(0, state.week.tasksCompleted - 1);
    saveState();
    renderAll();
  }
}

function deleteTask(id){
  state.tasks = state.tasks.filter(t => t.id !== id);
  saveState();
  renderTasks();
}

function renderTasks(){
  taskListEl.innerHTML = '';
  emptyNote.style.display = state.tasks.length ? 'none' : 'block';
  state.tasks.forEach(task => {
    const li = document.createElement('li');
    li.className = 'task-item' + (task.done ? ' done' : '');
    li.innerHTML = `
      <button class="check" aria-label="Concluir tarefa">${task.done ? '✓' : ''}</button>
      <span class="task-text"></span>
      <span class="task-meta">${task.pomodoros ? '🍅 x' + task.pomodoros : ''}</span>
      <button class="task-del" aria-label="Excluir tarefa">✕</button>
    `;
    li.querySelector('.task-text').textContent = task.text;
    li.querySelector('.check').addEventListener('click', () => toggleTask(task.id));
    li.querySelector('.task-del').addEventListener('click', () => deleteTask(task.id));
    taskListEl.appendChild(li);
  });
}

/* ============================================================================
   RANKING GLOBAL (LEADERBOARD)
============================================================================ */
const MOCK_USERS = [
  { name: 'Alexandre P.', baseXP: 4200 },
  { name: 'Lea D.',       baseXP: 3100 },
  { name: 'Kassandra M.', baseXP: 2650 },
  { name: 'Theron V.',    baseXP: 1800 },
  { name: 'Nina S.',      baseXP: 950 },
  { name: 'Bruno F.',     baseXP: 420 },
];

function totalXPFromState(){
  let total = 0;
  for(let l = 1; l < state.level; l++) total += xpNeededFor(l);
  return total + state.xp;
}

function renderLeaderboard(){
  const list = document.getElementById('leaderboard-list');
  const entries = MOCK_USERS.map(u => ({ name: u.name, xp: u.baseXP, me: false }));
  entries.push({ name: 'Você', xp: totalXPFromState(), me: true });
  entries.sort((a, b) => b.xp - a.xp);

  const medals = ['🥇', '🥈', '🥉'];
  list.innerHTML = '';
  entries.forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'lb-row' + (entry.me ? ' me' : '');
    const rankContent = i < 3 ? medals[i] : (i + 1);
    row.innerHTML = `
      <span class="lb-rank${i < 3 ? ' top' : ''}">${rankContent}</span>
      <span class="lb-name"></span>
      <span class="lb-xp"></span>
    `;
    const nameEl = row.querySelector('.lb-name');
    nameEl.textContent = entry.name;
    if(entry.me){
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'nível ' + state.level;
      nameEl.appendChild(tag);
    }
    row.querySelector('.lb-xp').textContent = entry.xp.toLocaleString('pt-BR') + ' XP';
    list.appendChild(row);
  });
}

/* ============================================================================
   PAINEL DE ESTATÍSTICAS
============================================================================ */
function renderStats(){
  const totalMin = Math.round(state.week.totalMinutes);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  document.getElementById('stat-hours').textContent = `${h}h ${m}min`;

  let topSubject = '—';
  let topMinutes = 0;
  Object.entries(state.week.subjects).forEach(([subject, minutes]) => {
    if(minutes > topMinutes){ topMinutes = minutes; topSubject = subject; }
  });
  document.getElementById('stat-subject').textContent = topSubject;
  document.getElementById('stat-tasks').textContent = state.week.tasksCompleted;
}

/* ============================================================================
   HEADER / DASHBOARD
============================================================================ */
function renderHeader(){
  const needed = xpNeededFor(state.level);
  const ratio = state.level >= MAX_LEVEL ? 1 : Math.min(1, state.xp / needed);

  document.getElementById('level-number').textContent = state.level;
  document.getElementById('level-title').textContent = titleForLevel(state.level);
  document.getElementById('xp-sub').textContent =
    state.level >= MAX_LEVEL ? 'Nível máximo alcançado' : `${state.xp} / ${needed} XP`;
  document.getElementById('xp-label').textContent =
    state.level >= MAX_LEVEL ? 'Máximo' : `${state.xp} / ${needed} XP`;
  document.getElementById('xp-fill').style.width = (ratio * 100) + '%';
  document.getElementById('streak-count').textContent = state.streak;

  const goalRatio = Math.min(1, state.dailyStudiedMinutes / state.dailyGoalMinutes);
  const studiedH = (state.dailyStudiedMinutes / 60).toFixed(1).replace('.0', '');
  const goalH = (state.dailyGoalMinutes / 60).toFixed(1).replace('.0', '');
  document.getElementById('goal-label').textContent = `${studiedH}h / ${goalH}h`;
  document.getElementById('goal-fill').style.width = (goalRatio * 100) + '%';
}

function renderAll(){
  rollDailyAndWeekly();
  renderHeader();
  renderTasks();
  renderLeaderboard();
  renderStats();
  renderTimer();
}

renderAll();