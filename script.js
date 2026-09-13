/* ============================================================================
   ESPARTANOS STUDY — LÓGICA DA APLICAÇÃO
   Tudo em um único arquivo. Estado persistido no localStorage.
============================================================================ */

const STORAGE_KEY = 'espartanos-study-state-v1';

/* ---------- Configuração de níveis ----------
   XP necessário para o nível N: 100 + (N-1) * 50 (cresce a cada nível).
   Títulos por faixa de nível, do Aprendiz ao Mestre do Foco (nível 30). */
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

function xpNeededFor(level) {
  return 100 + (level - 1) * 50;
}
function titleForLevel(level) {
  const row = LEVEL_TITLES.find(([min, max]) => level >= min && level <= max);
  return row ? row[2] : 'Aprendiz';
}

/* ---------- Estado padrão ---------- */
function defaultState() {
  return {
    level: 1,
    xp: 0,                     // XP acumulado dentro do nível atual
    streak: 0,
    lastStudyDate: null,       // data (YYYY-MM-DD) da última sessão que gerou XP de estudo
    dailyGoalMinutes: 180,     // meta diária: 3h
    dailyStudiedMinutes: 0,
    dailyDate: null,           // data em que dailyStudiedMinutes foi zerado pela última vez
    cyclesToday: 0,
    tasks: [],                 // {id, text, pomodoros, done}
    flashcards: [],             // {id, front, back}
    playerVolume: 50,           // volume do player de música (0-100), persistido
    week: {
      weekKey: null,           // ex: "2026-W37" para saber quando resetar
      totalMinutes: 0,
      tasksCompleted: 0,
      subjects: {}             // { "Matemática": 50, ... } em minutos
    }
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return Object.assign(defaultState(), parsed);
  } catch (e) {
    console.warn('Falha ao ler estado salvo, iniciando do zero.', e);
    return defaultState();
  }
}
function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

let state = loadState();

/* ---------- Utilidades de data ---------- */
function todayKey(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
function isoWeekKey(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${weekNo}`;
}

/* Garante que os contadores diários/semanais correspondem ao dia/semana atual,
   resetando-os quando o período muda (ex: usuário volta no dia seguinte). */
function rollDailyAndWeekly() {
  const tKey = todayKey();
  if (state.dailyDate !== tKey) {
    state.dailyDate = tKey;
    state.dailyStudiedMinutes = 0;
    state.cyclesToday = 0;
  }
  const wKey = isoWeekKey();
  if (state.week.weekKey !== wKey) {
    state.week = { weekKey: wKey, totalMinutes: 0, tasksCompleted: 0, subjects: {} };
  }
}
rollDailyAndWeekly();

/* ---------- Concessão de XP e progressão de nível ---------- */
function grantXP(amount, reasonLabel) {
  state.xp += amount;
  let needed = xpNeededFor(state.level);
  while (state.xp >= needed && state.level < MAX_LEVEL) {
    state.xp -= needed;
    state.level += 1;
    needed = xpNeededFor(state.level);
    showToast(`Subiu para o nível ${state.level} — ${titleForLevel(state.level)}!`);
  }
  if (state.level >= MAX_LEVEL) {
    state.xp = Math.min(state.xp, xpNeededFor(MAX_LEVEL));
  }
  if (reasonLabel) showToast(`+${amount} XP · ${reasonLabel}`);
  saveState();
  renderAll();
}

/* Atualiza a sequência de dias (streak) quando uma sessão de estudo é concluída. */
function registerStudyForStreak() {
  const tKey = todayKey();
  if (state.lastStudyDate === tKey) return; // já contabilizado hoje
  const y = new Date(); y.setDate(y.getDate() - 1);
  const yesterdayKey = todayKey(y);
  if (state.lastStudyDate === yesterdayKey) {
    state.streak += 1;
  } else {
    state.streak = 1;
  }
  state.lastStudyDate = tKey;
}

/* ---------- Toasts de feedback instantâneo ---------- */
function showToast(text) {
  const layer = document.getElementById('toast-layer');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  layer.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

/* ============================================================================
   POMODORO — com detecção de foco via Page Visibility API
============================================================================ */
const FOCUS_SECONDS = 25 * 60;
const BREAK_SECONDS = 5 * 60;

let timer = {
  mode: 'focus',            // 'focus' | 'break'
  remaining: FOCUS_SECONDS,
  running: false,
  intervalId: null,
};

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

function totalForMode(mode) {
  return mode === 'focus' ? FOCUS_SECONDS : BREAK_SECONDS;
}

function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function renderTimer() {
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

function tick() {
  timer.remaining -= 1;
  if (timer.remaining <= 0) {
    completeCycle();
    return;
  }
  renderTimer();
}

function startTimer() {
  timer.running = true;
  clearInterval(timer.intervalId);
  timer.intervalId = setInterval(tick, 1000);
  renderTimer();
}

function pauseTimer() {
  timer.running = false;
  clearInterval(timer.intervalId);
  renderTimer();
}

function resetTimer() {
  pauseTimer();
  timer.remaining = totalForMode(timer.mode);
  renderTimer();
}

function switchMode(mode) {
  timer.mode = mode;
  resetTimer();
}

function completeCycle() {
  pauseTimer();
  timer.remaining = 0;
  renderTimer();

  if (timer.mode === 'focus') {
    // Ciclo de foco completo: concede XP, soma minutos de estudo e streak.
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

startBtn.addEventListener('click', () => {
  if (timer.running) pauseTimer();
  else startTimer();
});
resetBtn.addEventListener('click', resetTimer);
modeFocusBtn.addEventListener('click', () => { if (!timer.running) switchMode('focus'); });
modeBreakBtn.addEventListener('click', () => { if (!timer.running) switchMode('break'); });

/* ---------- Mecânica anti-distração (Page Visibility API) ----------
   Quando o usuário muda de aba ou minimiza a janela durante um ciclo de
   FOCO em andamento, o timer pausa automaticamente e um modal é exibido.
   O usuário precisa clicar em "Retomar o foco" para continuar — o timer
   não volta sozinho, para reforçar a intenção consciente de focar. */
let wasDistracted = false;

document.addEventListener('visibilitychange', () => {
  if (document.hidden && timer.running && timer.mode === 'focus') {
    pauseTimer();
    wasDistracted = true;
    distractionModal.classList.add('open');
  }
});

// Fallback complementar: perda de foco da janela (ex: alguns navegadores/OS
// disparam blur sem mudar document.hidden, como ao trocar de app no desktop).
window.addEventListener('blur', () => {
  if (timer.running && timer.mode === 'focus') {
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
   PLAYER DE ESTUDO — playlist local em loop
============================================================================ */
const PLAYLIST = ['1.mp3', '2.mp3', '3.mp3'];
let currentTrackIndex = 0;

const lofiAudio     = document.getElementById('lofi-audio');
const playerCardEl  = document.getElementById('player-card');
const playBtn       = document.getElementById('play-btn');
const playIcon      = document.getElementById('play-icon');
const skipBtn       = document.getElementById('skip-btn');
const vinylEl       = document.getElementById('vinyl');
const playerTrack   = document.getElementById('player-track');
const playerStatus  = document.getElementById('player-status');
const volumeSlider  = document.getElementById('volume-slider');

const ICON_PLAY  = '<path d="M8 5v14l11-7z"></path>';
const ICON_PAUSE = '<path d="M6 5h4v14H6zM14 5h4v14h-4z"></path>';

function loadTrack(index, autoplay) {
  currentTrackIndex = (index + PLAYLIST.length) % PLAYLIST.length;
  lofiAudio.src = PLAYLIST[currentTrackIndex];
  playerTrack.textContent = `Tocando: ${PLAYLIST[currentTrackIndex]}`;
  if (autoplay) lofiAudio.play().catch(() => showToast('Não foi possível iniciar o áudio agora.'));
}

lofiAudio.volume = (state.playerVolume ?? 50) / 100;
volumeSlider.value = state.playerVolume ?? 50;
loadTrack(0, false);

function setPlayerVisual(isPlaying) {
  vinylEl.classList.toggle('spinning', isPlaying);
  playerCardEl.classList.toggle('playing', isPlaying);
  playIcon.innerHTML = isPlaying ? ICON_PAUSE : ICON_PLAY;
  playerStatus.textContent = isPlaying ? 'Tocando agora' : 'Pausado';
}

playBtn.addEventListener('click', () => {
  if (lofiAudio.paused) lofiAudio.play().catch(() => showToast('Não foi possível iniciar o áudio agora.'));
  else lofiAudio.pause();
});
skipBtn.addEventListener('click', () => loadTrack(currentTrackIndex + 1, !lofiAudio.paused));
lofiAudio.addEventListener('ended', () => loadTrack(currentTrackIndex + 1, true));
lofiAudio.addEventListener('play', () => setPlayerVisual(true));
lofiAudio.addEventListener('pause', () => setPlayerVisual(false));

volumeSlider.addEventListener('input', () => {
  const v = Number(volumeSlider.value);
  lofiAudio.volume = v / 100;
  state.playerVolume = v;
  saveState();
});

setPlayerVisual(false);

/* ============================================================================
   TO-DO LIST — conectada ao XP
============================================================================ */
const taskForm      = document.getElementById('task-form');
const taskTextInput = document.getElementById('task-text');
const taskPomInput  = document.getElementById('task-pomodoros');
const taskListEl    = document.getElementById('task-list');
const emptyNote     = document.getElementById('empty-note');

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

taskForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = taskTextInput.value.trim();
  if (!text) return;
  const pomodoros = Math.max(0, parseInt(taskPomInput.value, 10) || 0);
  state.tasks.unshift({ id: uid(), text, pomodoros, done: false });
  taskTextInput.value = '';
  taskPomInput.value = 1;
  saveState();
  renderTasks();
});

function toggleTask(id) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  task.done = !task.done;
  if (task.done) {
    state.week.tasksCompleted += 1;
    saveState();
    grantXP(10, 'Tarefa concluída'); // grantXP já salva e re-renderiza tudo
  } else {
    state.week.tasksCompleted = Math.max(0, state.week.tasksCompleted - 1);
    saveState();
    renderAll();
  }
}

function deleteTask(id) {
  state.tasks = state.tasks.filter(t => t.id !== id);
  saveState();
  renderTasks();
}

function renderTasks() {
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
    li.querySelector('.task-text').textContent = task.text; // texto via textContent evita injeção de HTML
    li.querySelector('.check').addEventListener('click', () => toggleTask(task.id));
    li.querySelector('.task-del').addEventListener('click', () => deleteTask(task.id));
    taskListEl.appendChild(li);
  });
}

/* ============================================================================
   FLASHCARDS — repetição espaçada simples
   O baralho fica salvo em state.flashcards. O índice do card atual e o
   estado de "virado" são apenas de interface (não precisam persistir).
============================================================================ */
let currentFlashIndex = 0;
let flashFlipped = false;

const flashForm       = document.getElementById('flash-form');
const flashFrontInput = document.getElementById('flash-front');
const flashBackInput  = document.getElementById('flash-back');
const flashStage      = document.getElementById('flash-stage');
const flashEmpty      = document.getElementById('flash-empty');
const flashcardEl     = document.getElementById('flashcard');
const flashFrontText  = document.getElementById('flash-front-text');
const flashBackText   = document.getElementById('flash-back-text');
const flashProgress   = document.getElementById('flash-progress');
const flashPrevBtn    = document.getElementById('flash-prev');
const flashNextBtn    = document.getElementById('flash-next');
const flashDelBtn     = document.getElementById('flash-del');

flashForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const front = flashFrontInput.value.trim();
  const back = flashBackInput.value.trim();
  if (!front || !back) return;
  state.flashcards.push({ id: uid(), front, back });
  currentFlashIndex = state.flashcards.length - 1; // mostra a carta recém-criada
  flashFlipped = false;
  flashFrontInput.value = '';
  flashBackInput.value = '';
  saveState();
  renderFlashcards();
  showToast('Flashcard criado!');
});

function flipCurrentCard() {
  if (!state.flashcards.length) return;
  flashFlipped = !flashFlipped;
  flashcardEl.classList.toggle('flipped', flashFlipped);
}
flashcardEl.addEventListener('click', flipCurrentCard);
flashcardEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flipCurrentCard(); }
});

flashPrevBtn.addEventListener('click', () => {
  if (!state.flashcards.length) return;
  currentFlashIndex = (currentFlashIndex - 1 + state.flashcards.length) % state.flashcards.length;
  flashFlipped = false;
  renderFlashcards();
});
flashNextBtn.addEventListener('click', () => {
  if (!state.flashcards.length) return;
  currentFlashIndex = (currentFlashIndex + 1) % state.flashcards.length;
  flashFlipped = false;
  renderFlashcards();
});
flashDelBtn.addEventListener('click', () => {
  if (!state.flashcards.length) return;
  state.flashcards.splice(currentFlashIndex, 1);
  if (currentFlashIndex >= state.flashcards.length) currentFlashIndex = Math.max(0, state.flashcards.length - 1);
  flashFlipped = false;
  saveState();
  renderFlashcards();
});

function renderFlashcards() {
  const hasCards = state.flashcards.length > 0;
  flashStage.style.display = hasCards ? 'block' : 'none';
  flashEmpty.style.display = hasCards ? 'none' : 'block';
  if (!hasCards) return;

  if (currentFlashIndex >= state.flashcards.length) currentFlashIndex = 0;
  const card = state.flashcards[currentFlashIndex];
  flashFrontText.textContent = card.front;
  flashBackText.textContent = card.back;
  flashcardEl.classList.toggle('flipped', flashFlipped);
  flashProgress.textContent = `Carta ${currentFlashIndex + 1} de ${state.flashcards.length}`;
}

/* ============================================================================
   RANKING GLOBAL (LEADERBOARD)
   Usuários simulados com XP fixo + o usuário atual, cujo XP é derivado do
   nível e XP atuais para comparação justa (XP total acumulado).
============================================================================ */
const MOCK_USERS = [
  { name: 'Alexandre P.', baseXP: 4200 },
  { name: 'Lea D.',       baseXP: 3100 },
  { name: 'Kassandra M.', baseXP: 2650 },
  { name: 'Theron V.',    baseXP: 1800 },
  { name: 'Nina S.',      baseXP: 950 },
  { name: 'Bruno F.',     baseXP: 420 },
];

// Converte nível + xp restante em um total de XP acumulado, somando o que
// era necessário para alcançar cada nível anterior.
function totalXPFromState() {
  let total = 0;
  for (let l = 1; l < state.level; l++) total += xpNeededFor(l);
  return total + state.xp;
}

function renderLeaderboard() {
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
    if (entry.me) {
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
   PAINEL DE ESTATÍSTICAS (semanal)
============================================================================ */
function renderStats() {
  const totalMin = Math.round(state.week.totalMinutes);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  document.getElementById('stat-hours').textContent = `${h}h ${m}min`;

  let topSubject = '—';
  let topMinutes = 0;
  Object.entries(state.week.subjects).forEach(([subject, minutes]) => {
    if (minutes > topMinutes) { topMinutes = minutes; topSubject = subject; }
  });
  document.getElementById('stat-subject').textContent = topSubject;
  document.getElementById('stat-tasks').textContent = state.week.tasksCompleted;
}

/* ============================================================================
   HEADER / DASHBOARD DE GAMIFICAÇÃO
============================================================================ */
function renderHeader() {
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

/* ---------- Renderização geral ---------- */
function renderAll() {
  rollDailyAndWeekly();
  renderHeader();
  renderTasks();
  renderFlashcards();
  renderLeaderboard();
  renderStats();
  renderTimer();
}

renderAll();

/* ============================================================================
   MAGIC BLOB — aura de fundo que segue o cursor e pulsa com a música
   (bloco adicionado sem alterar nenhuma lógica existente do app)
============================================================================ */
const magicBlob = document.getElementById('magic-blob');
let magicBlobScale = 1;

/* ---- Mouse: segue o cursor com "lag" cinemático via Web Animations API ---- */
window.addEventListener('mousemove', (e) => {
  magicBlob.animate(
    { left: `${e.clientX}px`, top: `${e.clientY}px` },
    { duration: 3000, fill: 'forwards' }
  );
});

/* ---- Áudio: Web Audio API só é criada após a 1ª interação do usuário ---- */
let magicAudioCtx = null;
let magicAnalyser = null;
let magicFreqData = null;
let magicAudioReady = false;

function initMagicAudio() {
  if (magicAudioReady) return;
  magicAudioReady = true;

  magicAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  magicAnalyser = magicAudioCtx.createAnalyser();
  magicAnalyser.fftSize = 256;
  magicFreqData = new Uint8Array(magicAnalyser.frequencyBinCount);

  const magicSource = magicAudioCtx.createMediaElementSource(lofiAudio);
  magicSource.connect(magicAnalyser);
  magicAnalyser.connect(magicAudioCtx.destination);

  requestAnimationFrame(updateMagicBlobFromAudio);
}

function updateMagicBlobFromAudio() {
  if (magicAnalyser) {
    magicAnalyser.getByteFrequencyData(magicFreqData);
    // Foca nos graves: primeiros bins do espectro de frequência.
    const bassSlice = magicFreqData.slice(0, 8);
    const bassAvg = bassSlice.reduce((sum, v) => sum + v, 0) / bassSlice.length;
    const targetScale = 1 + (bassAvg / 255) * 0.9; // pulsa entre ~1x e ~1.9x
    magicBlobScale += (targetScale - magicBlobScale) * 0.15; // suaviza o pulso
    magicBlob.style.transform = `translate(-50%, -50%) scale(${magicBlobScale.toFixed(3)})`;
  }
  requestAnimationFrame(updateMagicBlobFromAudio);
}

// Reaproveita o botão de play/pause já existente: adiciona um listener extra
// (não substitui o listener original do player) só para iniciar o áudio reativo.
playBtn.addEventListener('click', initMagicAudio);