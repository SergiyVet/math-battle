const socket = io();

// ========== ГЛОБАЛЬНІ ЗМІННІ ==========
let myName = 'Guest';
let currentLevel = 'normal'; // easy, normal, hard
let isGuest = true; // флаг: чи гравець грає як гість
let questionsInGame = [];
let currentQuestionIndex = 0;
let gameStartTime = 0;
let gameTimer = null;
let questionTimer = null;
let audioEnabled = true;
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const QUESTIONS_PER_GAME = 10;
let waitingToAutoStart = false;
let penaltyTime = 0; // штрафний час в секундах

// ========== ЗВУКОВІ ЕФЕКТИ ==========
function playTone(freq, duration, type = 'sine') {
  if (!audioEnabled) return;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = type;
  o.frequency.value = freq;
  o.connect(g);
  g.connect(audioCtx.destination);
  o.start();
  g.gain.setValueAtTime(0.001, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.2, audioCtx.currentTime + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration / 1000);
  o.stop(audioCtx.currentTime + duration / 1000 + 0.02);
}

function soundCorrect() { playTone(880, 120, 'sine'); playTone(1320, 60, 'sine'); }
function soundWrong() { playTone(220, 300, 'square'); }
function soundTimeout() { playTone(330, 200, 'sawtooth'); }

// ========== DOM ЕЛЕМЕНТИ ==========
const loginDiv = document.getElementById('login');
const difficultySelect = document.getElementById('difficulty-select');
const gameDiv = document.getElementById('game');
const resultsDiv = document.getElementById('results');

const nameInput = document.getElementById('name');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const registerBtn = document.getElementById('register');
const loginBtn = document.getElementById('loginBtn');
const joinBtn = document.getElementById('join');
const googleLogin = document.getElementById('googleLogin');

const difficultyCards = document.querySelectorAll('.difficulty-card');
const backToMenuBtn = document.getElementById('back-to-menu');

const questionDiv = document.getElementById('question');
const answerInput = document.getElementById('answer');
const submitBtn = document.getElementById('submit');
const newBtn = document.getElementById('new');
const quitGameBtn = document.getElementById('quit-game');
const toggleLeaderboardBtn = document.getElementById('toggle-leaderboard');

const leaderboardOl = document.getElementById('leaderboard');
const levelNameDisplay = document.getElementById('level-name');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const timerValue = document.getElementById('timer');
const timerProgress = document.getElementById('timer-progress');
const statusMessage = document.getElementById('status-message');
const levelBadge = document.getElementById('level-badge');
const displayName = document.getElementById('display-name');

const playAgainBtn = document.getElementById('play-again');
const backMenuBtn = document.getElementById('back-menu');
const resultLeaderboard = document.getElementById('result-leaderboard');
const guestNotice = document.getElementById('guest-register-notice');
const registerFromResultsBtn = document.getElementById('register-from-results');

// ========== ЛОГІН ==========
joinBtn.addEventListener('click', () => {
  const stored = localStorage.getItem('math_token');
  if (stored) {
    socket.emit('join', { token: stored });
    const p = parseJwt(stored);
    myName = p && p.name ? p.name : (nameInput.value || 'Guest');
    isGuest = false;
  } else {
    myName = nameInput.value || 'Guest';
    socket.emit('join', myName);
    isGuest = true; // Гравець грає як гість
  }
  displayName.textContent = myName;
  loginDiv.style.display = 'none';
  difficultySelect.style.display = 'flex';
});

// Toggle leaderboard on mobile
if (toggleLeaderboardBtn) {
  toggleLeaderboardBtn.addEventListener('click', () => {
    const sb = document.querySelector('.sidebar');
    if (!sb) return;
    sb.classList.toggle('open');
  });
}

// Google login redirect (falls back to server-side /auth/google)
if (googleLogin) {
  googleLogin.addEventListener('click', (e) => {
    e.preventDefault();
    // try redirecting to conventional OAuth path
    window.location.href = '/auth/google';
  });
}

// Реєстрація з екрана результатів
if (registerFromResultsBtn) {
  registerFromResultsBtn.addEventListener('click', () => {
    // Очистити поля та перейти на форму
    nameInput.value = '';
    emailInput.value = '';
    passwordInput.value = '';
    
    // Показати логін-екран
    resultsDiv.style.display = 'none';
    loginDiv.style.display = 'flex';
  });
}

registerBtn.addEventListener('click', async () => {
  const name = nameInput.value || '';
  const email = emailInput.value || '';
  const pass = passwordInput.value || '';
  if (!email || !pass) { alert('Введи email і пароль'); return; }
  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password: pass })
    });
    const data = await res.json();
    if (res.ok && data.token) { setToken(data.token); isGuest = false; alert('Зареєстровано'); joinBtn.click(); }
    else alert(data.error || 'Помилка реєстрації');
  } catch (e) { alert('Помилка мережі'); }
});

loginBtn.addEventListener('click', async () => {
  const email = emailInput.value || '';
  const pass = passwordInput.value || '';
  if (!email || !pass) { alert('Введи email і пароль'); return; }
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pass })
    });
    const data = await res.json();
    if (res.ok && data.token) { setToken(data.token); isGuest = false; alert('Успішний вхід'); joinBtn.click(); }
    else alert(data.error || 'Невірні дані');
  } catch (e) { alert('Помилка мережі'); }
});

window.addEventListener('load', () => {
  const params = new URLSearchParams(window.location.search);
  const t = params.get('token');
  if (t) {
    setToken(t);
    window.history.replaceState({}, document.title, window.location.pathname);
    joinBtn.click();
  } else {
    // Автоматичний логін якщо є токен
    const stored = localStorage.getItem('math_token');
    if (stored) {
      const p = parseJwt(stored);
      if (p && p.exp && p.exp * 1000 > Date.now()) {
        // Токен ще дійсний - автоматично логінимось
        myName = p.name || 'User';
        isGuest = false;
        displayName.textContent = myName;
        socket.emit('join', { token: stored });
        loginDiv.style.display = 'none';
        difficultySelect.style.display = 'flex';
        gameDiv.style.display = 'none';
        resultsDiv.style.display = 'none';
      } else {
        // Токен застарів - видаляємо
        localStorage.removeItem('math_token');
        loginDiv.style.display = 'flex';
        difficultySelect.style.display = 'none';
        gameDiv.style.display = 'none';
        resultsDiv.style.display = 'none';
      }
    } else {
      // Немає токена - показати логін
      loginDiv.style.display = 'flex';
      difficultySelect.style.display = 'none';
      gameDiv.style.display = 'none';
      resultsDiv.style.display = 'none';
    }
  }
});

function setToken(token) {
  localStorage.setItem('math_token', token);
  const p = parseJwt(token);
  myName = p && p.name ? p.name : myName;
  isGuest = false; // Вже не гість
  displayName.textContent = myName;
}

function parseJwt(token) {
  try {
    const payload = token.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decodeURIComponent(escape(json)));
  } catch (e) { return null; }
}

// ========== ВИБІР РІВНЯ ==========
difficultyCards.forEach(card => {
  card.addEventListener('click', () => {
    currentLevel = card.dataset.level;
    startNewGame();
  });
});

backToMenuBtn.addEventListener('click', () => {
  difficultySelect.style.display = 'none';
  loginDiv.style.display = 'flex';
});

// ========== ГЕРА - СТАРТ ==========
function startNewGame() {
  questionsInGame = [];
  currentQuestionIndex = 0;
  gameStartTime = Date.now();
  penaltyTime = 0;
  answerInput.value = '';
  statusMessage.textContent = '';
  // close mobile leaderboard when starting
  document.querySelector('.sidebar')?.classList.remove('open');
  
  // Повідомити сервер про початок нової гри
  socket.emit('startNewGame');
  
  // Оновити UI
  const levelLabels = { easy: '🌱 ЛЕГКИЙ', normal: '⚔️ ЗВИЧАЙНИЙ', hard: '🔥 СКЛАДНИЙ' };
  levelBadge.textContent = levelLabels[currentLevel];
  
  difficultySelect.style.display = 'none';
  gameDiv.style.display = 'block';
  resultsDiv.style.display = 'none';
  
  // Запросити рекорди для цього рівня
  socket.emit('getLeaderboard', { level: currentLevel });
  
  updateProgress();
  requestNextQuestion();
}

function requestNextQuestion() {
  socket.emit('getQuestion', { level: currentLevel });
}

socket.on('question', (q) => {
  questionsInGame.push({ ...q, answer: null, time: 0, correct: false });
  showQuestion(q);
  // if we requested this question as part of auto-advance, start timer immediately
  if (waitingToAutoStart) {
    waitingToAutoStart = false;
    startQuestionTimer();
    newBtn.disabled = true;
  }
});

function showQuestion(q) {
  questionDiv.textContent = q.text;
  answerInput.value = '';
  statusMessage.textContent = '';
  newBtn.textContent = currentQuestionIndex === 0 ? '▶ Почати' : '▶ Далі';
  newBtn.disabled = false;
  
  // Фокусуємо input після короткої затримки
  setTimeout(() => {
    answerInput.focus();
    
    // Скролимо до питання після того як клавіатура відкриється
    setTimeout(() => {
      const questionSection = document.querySelector('.question-section');
      if (questionSection) {
        questionSection.scrollIntoView({ 
          behavior: 'smooth', 
          block: 'start',
          inline: 'nearest'
        });
      }
    }, 400); // Більша затримка для клавіатури
  }, 50);
}

// ========== ГЕРА - ГРАВЕЦЬ ==========
newBtn.addEventListener('click', () => {
  // manual start: cancel any pending auto-start
  waitingToAutoStart = false;
  if (currentQuestionIndex < QUESTIONS_PER_GAME) {
    if (currentQuestionIndex < questionsInGame.length) {
      startQuestionTimer();
      newBtn.disabled = true;
      answerInput.focus();
    } else {
      requestNextQuestion();
    }
  }
});

function startQuestionTimer() {
  clearInterval(questionTimer);
  let remaining = 15000; // 15 секунд на питання
  updateTimerDisplay(remaining);
  
  questionTimer = setInterval(() => {
    remaining -= 100;
    updateTimerDisplay(remaining);
    
    if (remaining <= 0) {
      clearInterval(questionTimer);
      autoSubmitQuestion(null);
    }
  }, 100);
}

function updateTimerDisplay(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  timerValue.textContent = seconds;
  
  // SVG прогрес круг
  const total = 15;
  const percent = Math.max(0, seconds / total);
  const circumference = 2 * Math.PI * 45;
  timerProgress.style.strokeDashoffset = circumference * (1 - percent);
}

submitBtn.addEventListener('click', () => {
  const ans = answerInput.value.trim();
  if (ans === '') {
    alert('Введи відповідь!');
    return;
  }
  clearInterval(questionTimer);
  submitAnswer(ans);
});

answerInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    submitBtn.click();
  }
});

// Скрол при фокусі вже не потрібен - скрол відбувається в showQuestion()
// answerInput.addEventListener('focus', ...) - видалено

function submitAnswer(answer) {
  const time = Date.now() - gameStartTime;
  const currentQ = questionsInGame[currentQuestionIndex];
  
  if (currentQ) {
    currentQ.answer = answer;
    currentQ.time = time;
    
    socket.emit('checkAnswer', {
      questionId: currentQ.id,
      questionIndex: currentQuestionIndex,
      question: currentQ.text,
      answer: answer,
      level: currentLevel
    });
  }
}

function autoSubmitQuestion(answer) {
  statusMessage.textContent = '⏱️ Час вийшов!';
  statusMessage.className = 'status-message timeout';
  if (audioEnabled) soundTimeout();
  
  const time = Date.now() - gameStartTime;
  const currentQ = questionsInGame[currentQuestionIndex];
  
  if (currentQ) {
    currentQ.answer = answer;
    currentQ.time = time;
    
    socket.emit('checkAnswer', {
      questionId: currentQ.id,
      questionIndex: currentQuestionIndex,
      question: currentQ.text,
      answer: answer,
      level: currentLevel
    });
  }
}

socket.on('answerResult', (result) => {
  clearInterval(questionTimer);
  
  if (result.correct) {
    statusMessage.textContent = '✓ Правильно!';
    statusMessage.className = 'status-message correct';
    if (audioEnabled) soundCorrect();
  } else {
    penaltyTime += 5; // Додати 5 секунд штрафу
    statusMessage.textContent = `✗ Неправильно. Відповідь: ${result.correctAnswer} (+5 сек)`;
    statusMessage.className = 'status-message wrong';
    if (audioEnabled) soundWrong();
  }
  
  // mark result
  questionsInGame[currentQuestionIndex].correct = result.correct;
  currentQuestionIndex++;
  updateProgress();

  if (currentQuestionIndex >= QUESTIONS_PER_GAME) {
    setTimeout(() => {
      finishGame();
    }, 1500);
  } else {
    // show feedback for 2s, then auto-advance to next question
    setTimeout(() => {
      // if next question already loaded, show it and start timer
      if (currentQuestionIndex < questionsInGame.length) {
        showQuestion(questionsInGame[currentQuestionIndex]);
        startQuestionTimer();
        newBtn.disabled = true;
      } else {
        // request next question and start when it arrives
        waitingToAutoStart = true;
        requestNextQuestion();
      }
    }, 2000);

    // allow player to manually advance earlier if they want
    newBtn.disabled = false;
    newBtn.textContent = '▶ Далі';
  }
});

function updateProgress() {
  const percent = (currentQuestionIndex / QUESTIONS_PER_GAME) * 100;
  progressFill.style.width = percent + '%';
  progressText.textContent = `${currentQuestionIndex}/${QUESTIONS_PER_GAME}`;
}

// ========== ЗАВЕРШЕННЯ ГЕРИ ==========
function finishGame() {
  clearInterval(questionTimer);
  clearInterval(gameTimer);
  
  const cleanTime = (Date.now() - gameStartTime) / 1000; // чистий час в секундах
  const totalTime = cleanTime + penaltyTime; // загальний час з штрафами
  const correctCount = questionsInGame.filter(q => q.correct).length;
  
  // Зберегти результат тільки якщо не гість
  if (!isGuest) {
    socket.emit('saveGameResult', {
      level: currentLevel,
      correctCount,
      totalTime,
      questionsCount: QUESTIONS_PER_GAME
    });
  }
  
  // Показати результати
  showResults(correctCount, cleanTime, totalTime);
}

function showResults(correct, cleanTime, totalTime) {
  gameDiv.style.display = 'none';
  resultsDiv.style.display = 'flex';
  
  document.getElementById('result-name').textContent = myName;
  
  const levelLabels = { easy: '🌱 Легкий', normal: '⚔️ Звичайний', hard: '🔥 Складний' };
  document.getElementById('result-level').textContent = levelLabels[currentLevel];
  
  document.getElementById('result-correct').textContent = `${correct}/10`;
  document.getElementById('result-clean-time').textContent = `${cleanTime.toFixed(2)} с`;
  document.getElementById('result-time').textContent = `${totalTime.toFixed(2)} с`;
  
  // Показати штраф якщо є помилки
  const penaltyStat = document.getElementById('penalty-stat');
  const penaltyValue = document.getElementById('result-penalty');
  if (penaltyTime > 0) {
    const wrongCount = 10 - correct;
    penaltyStat.style.display = 'block';
    penaltyValue.textContent = `+${penaltyTime} с (${wrongCount} помилок)`;
  } else {
    penaltyStat.style.display = 'none';
  }
  
  // Показати повідомлення про реєстрацію, якщо гість
  if (isGuest) {
    guestNotice.style.display = 'block';
  } else {
    guestNotice.style.display = 'none';
  }
  
  // Show leaderboard for current level (тільки якщо не гість)
  if (!isGuest) {
    socket.emit('getLeaderboard', { level: currentLevel });
  }
}

playAgainBtn.addEventListener('click', () => {
  resultsDiv.style.display = 'none';
  difficultySelect.style.display = 'flex';
});

backMenuBtn.addEventListener('click', () => {
  resultsDiv.style.display = 'none';
  difficultySelect.style.display = 'none';
  gameDiv.style.display = 'none';
  loginDiv.style.display = 'flex';
  
  nameInput.value = myName;
  emailInput.value = '';
  passwordInput.value = '';
});

quitGameBtn.addEventListener('click', () => {
  clearInterval(questionTimer);
  clearInterval(gameTimer);
  // Скинути стан гри
  questionsInGame = [];
  currentQuestionIndex = 0;
  waitingToAutoStart = false;
  penaltyTime = 0;
  answerInput.value = '';
  statusMessage.textContent = '';
  gameDiv.style.display = 'none';
  difficultySelect.style.display = 'flex';
});

// ========== ТАБЛИЦЯ РЕКОРДІВ ==========
socket.on('leaderboard', (rows) => {
  console.log('Leaderboard received:', rows, 'Current level:', currentLevel);
  
  // Update game sidebar leaderboard
  leaderboardOl.innerHTML = '';
  
  // Оновити назву рівня
  const levelLabels = { easy: '🌱 ЛЕГКИЙ', normal: '⚔️ ЗВИЧАЙНИЙ', hard: '🔥 СКЛАДНИЙ' };
  if (levelNameDisplay) {
    levelNameDisplay.textContent = levelLabels[currentLevel] || 'ЗВИЧАЙНИЙ';
  }
  
  // Фільтрувати по рівню
  const filteredRows = rows.filter(r => r.level === currentLevel).slice(0, 10);
  console.log('Filtered rows:', filteredRows);
  
  if (filteredRows.length === 0) {
    leaderboardOl.innerHTML = '<li style="color: #999;">Немає рекордів</li>';
  } else {
    filteredRows.forEach((r, index) => {
      const li = document.createElement('li');
      const timeStr = typeof r.totalTime === 'number' 
        ? r.totalTime.toFixed(2) + ' с' 
        : r.totalTime;
      
      li.textContent = `${r.name} — ${timeStr}`;
      
      if (r.name === myName) {
        li.classList.add('me');
      }
      leaderboardOl.appendChild(li);
    });
  }

  // Also update results page leaderboard if visible
  if (resultsDiv.style.display === 'flex' && resultLeaderboard) {
    resultLeaderboard.innerHTML = '';
    const filteredResults = rows.filter(r => r.level === currentLevel).slice(0, 10);
    
    if (filteredResults.length === 0) {
      resultLeaderboard.innerHTML = '<li style="color: #999;">Немає рекордів</li>';
    } else {
      filteredResults.forEach((r) => {
        const li = document.createElement('li');
        const timeStr = typeof r.totalTime === 'number' 
          ? r.totalTime.toFixed(2) + ' с' 
          : r.totalTime;
        
        li.textContent = `${r.name} — ${timeStr}`;
        
        if (r.name === myName) {
          li.classList.add('me');
        }
        resultLeaderboard.appendChild(li);
      });
    }
  }
});

// Запросити таблицю рекордів при змінені рівня
socket.on('connect', () => {
  socket.emit('getLeaderboard', { level: currentLevel });
});
