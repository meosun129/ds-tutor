/* ================================================================
   DS Tutor — script.js
   상명대 게임전공 자료구조 튜터링 앱
   ================================================================ */

const API = window.location.origin; // 백엔드: 동일 origin (포트 3001)

// ── 로컬스토리지 키 ──────────────────────────────────────────
const STORAGE_TOKEN_KEY    = 'ds-tutor-token';
const STORAGE_ACTIVE_TAB   = 'ds-tutor-active-tab';

// ── 앱 상태 ─────────────────────────────────────────────────
let currentUser = null; // { id, name, email, role }
let activeTab   = null;
let socket      = null;

// ── 퀴즈 진행 상태 (학생용) ──────────────────────────────────
let quizState = {
  quizzes: [],
  currentIndex: 0,
  score: 0,
  answered: false,
};

// ================================================================
// 유틸리티
// ================================================================

function getToken() {
  return localStorage.getItem(STORAGE_TOKEN_KEY);
}

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${getToken()}`,
  };
}

function isLoggedIn() {
  return !!getToken();
}

/** JWT 페이로드 디코딩 (UTF-8 한글 지원) */
function decodeToken(token) {
  try {
    const payload = token.split('.')[1];
    const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decodeURIComponent(decoded.split('').map(c =>
      '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
    ).join('')));
  } catch {
    return null;
  }
}

/** 토스트 메시지 표시 */
function showToast(msg, duration = 2800) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.add('hidden'), duration);
}

/** 퀴즈 유형 한국어 변환 */
function quizTypeLabel(type) {
  if (type === 'ox') return 'OX';
  if (type === 'multiple') return '객관식';
  if (type === 'code_trace') return '코드추적';
  return type;
}

// ================================================================
// Auth — 로그인 / 회원가입 / 로그아웃
// ================================================================

async function login(email, password) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '로그인에 실패했어요.');
  localStorage.setItem(STORAGE_TOKEN_KEY, data.token);
}

async function register(name, email, password, role) {
  const res = await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password, role }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '회원가입에 실패했어요.');
  localStorage.setItem(STORAGE_TOKEN_KEY, data.token);
}

function logout() {
  localStorage.removeItem(STORAGE_TOKEN_KEY);
  localStorage.removeItem(STORAGE_ACTIVE_TAB);
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  currentUser = null;
  activeTab   = null;
  showAuthScreen();
}

// ================================================================
// 화면 전환
// ================================================================

function showAuthScreen() {
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('app-screen').classList.add('hidden');
}

function showAppScreen() {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app-screen').classList.remove('hidden');
}

// ================================================================
// 앱 초기화 (로그인 성공 후)
// ================================================================

function initApp() {
  const token = getToken();
  if (!token) { showAuthScreen(); return; }

  const payload = decodeToken(token);
  if (!payload) { showAuthScreen(); return; }

  // 사용자 상태 세팅
  currentUser = {
    id:    payload.id   || payload.userId,
    name:  payload.name || payload.email,
    email: payload.email,
    role:  payload.role || 'student',
  };

  // 헤더 업데이트
  document.getElementById('user-name').textContent = currentUser.name;
  const roleBadge = document.getElementById('role-badge');
  if (currentUser.role === 'tutor') {
    roleBadge.textContent = '튜터';
    roleBadge.dataset.role = 'tutor';
  } else {
    roleBadge.textContent = '학생';
    roleBadge.dataset.role = 'student';
  }

  showAppScreen();
  buildTabNav();
  connectSocket();

  // 저장된 탭 복원 또는 첫 번째 탭으로
  const savedTab = localStorage.getItem(STORAGE_ACTIVE_TAB);
  const tabs     = getTabsForRole(currentUser.role);
  const target   = tabs.find(t => t.id === savedTab) ? savedTab : tabs[0].id;
  switchTab(target);
}

// ================================================================
// 탭 정의
// ================================================================

/** role에 맞는 탭 목록 반환 */
function getTabsForRole(role) {
  if (role === 'tutor') {
    return [
      { id: 'dashboard',    label: '대시보드' },
      { id: 'week-manager', label: '주차관리' },
      { id: 'session',      label: '세션' },
      { id: 'report',       label: '보고서' },
    ];
  }
  return [
    { id: 'today-quiz',  label: '오늘퀴즈' },
    { id: 'materials',   label: '학습자료' },
    { id: 'my-weakness', label: '내약점' },
  ];
}

/** 탭 내비게이션 DOM 생성 */
function buildTabNav() {
  const nav  = document.getElementById('tab-nav');
  const tabs = getTabsForRole(currentUser.role);

  nav.innerHTML = tabs.map(t => `
    <button class="tab-btn"
            id="tab-btn-${t.id}"
            role="tab"
            aria-selected="false"
            aria-controls="tab-content"
            data-tab="${t.id}">
      ${t.label}
    </button>
  `).join('');

  // 이벤트 위임
  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (btn) switchTab(btn.dataset.tab);
  });
}

/** 탭 전환 */
function switchTab(tabId) {
  activeTab = tabId;
  localStorage.setItem(STORAGE_ACTIVE_TAB, tabId);

  // 탭 버튼 active 상태 업데이트
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const isActive = btn.dataset.tab === tabId;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive);
  });

  // 콘텐츠 렌더링
  renderTab(tabId);
}

/** tabId에 맞는 렌더 함수 호출 */
function renderTab(tabId) {
  switch (tabId) {
    case 'dashboard':    renderDashboard();   break;
    case 'week-manager': renderWeekManager(); break;
    case 'session':      renderSession();     break;
    case 'report':       renderReport();      break;
    case 'today-quiz':   renderTodayQuiz();   break;
    case 'materials':    renderMaterials();   break;
    case 'my-weakness':  renderMyWeakness();  break;
    default: renderEmpty('알 수 없는 탭입니다.');
  }
}

// ================================================================
// 공통 헬퍼
// ================================================================

/** 탭 콘텐츠 교체 */
function setContent(html) {
  document.getElementById('tab-content').innerHTML = html;
}

/** 준비 중 플레이스홀더 카드 */
function skeletonCard(title, description = '기능 준비 중이에요.') {
  return `
    <div class="content-card skeleton-card">
      <h2 class="card-title">${title}</h2>
      <p class="card-desc">${description}</p>
      <div class="skeleton-block"></div>
      <div class="skeleton-block short"></div>
    </div>
  `;
}

function renderEmpty(msg) {
  setContent(`<div class="empty-state"><p>${msg}</p></div>`);
}

// ================================================================
// API 함수
// ================================================================

async function fetchWeeks() {
  const res = await fetch(`${API}/weeks`, { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '주차 목록을 불러오지 못했어요.');
  return data.data || data;
}

async function fetchStudents() {
  const res = await fetch(`${API}/users/students`, { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '학생 목록을 불러오지 못했어요.');
  return data.data || data;
}

async function fetchQuizzes(params = {}) {
  const query = new URLSearchParams(params).toString();
  const res = await fetch(`${API}/quizzes${query ? '?' + query : ''}`, { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '퀴즈 목록을 불러오지 못했어요.');
  return data.data || data;
}

async function fetchSessions() {
  const res = await fetch(`${API}/sessions`, { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '세션 목록을 불러오지 못했어요.');
  return data.data || data;
}

async function submitQuizAnswer(quizId, userAnswer) {
  const res = await fetch(`${API}/quizzes/${quizId}/submit`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ user_answer: userAnswer }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '답안 제출에 실패했어요.');
  return data.data || data;
}

async function approveQuiz(quizId) {
  const res = await fetch(`${API}/quizzes/${quizId}/approve`, {
    method: 'POST',
    headers: authHeaders(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '승인에 실패했어요.');
  return data;
}

async function rejectQuiz(quizId) {
  const res = await fetch(`${API}/quizzes/${quizId}/reject`, {
    method: 'POST',
    headers: authHeaders(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '삭제에 실패했어요.');
  return data;
}

async function createWeek(weekNo, title) {
  const res = await fetch(`${API}/weeks`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ week_no: weekNo, title }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '주차 생성에 실패했어요.');
  return data.data || data;
}

async function uploadPdf(weekId, files) {
  const formData = new FormData();
  Array.from(files).forEach((file) => formData.append('pdf', file));
  const res = await fetch(`${API}/weeks/${weekId}/upload-pdf`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${getToken()}` },
    body: formData,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'PDF 업로드에 실패했어요.');
  return data.data || data;
}

// ================================================================
// 튜터 탭 렌더러
// ================================================================

/** 대시보드 — 전체 현황 요약 */
async function renderDashboard() {
  setContent(`
    <section class="tab-section" aria-label="대시보드">
      <div class="content-card">
        <h2 class="card-title">대시보드</h2>
        <p class="card-desc">튜터링 전체 현황을 한눈에 볼 수 있어요.</p>
      </div>
      <div class="stats-grid">
        <div class="stat-card">
          <span class="stat-num" id="stat-students">-</span>
          <span class="stat-label">담당 학생</span>
        </div>
        <div class="stat-card">
          <span class="stat-num" id="stat-weeks">-</span>
          <span class="stat-label">진행 주차</span>
        </div>
        <div class="stat-card">
          <span class="stat-num" id="stat-quizzes">-</span>
          <span class="stat-label">승인된 퀴즈</span>
        </div>
        <div class="stat-card">
          <span class="stat-num" id="stat-sessions">-</span>
          <span class="stat-label">총 세션</span>
        </div>
      </div>
    </section>
  `);

  // 병렬로 데이터 로딩
  const results = await Promise.allSettled([
    fetchStudents(),
    fetchWeeks(),
    fetchQuizzes({ approved: 'true' }),
    fetchSessions(),
  ]);

  const [studentsRes, weeksRes, quizzesRes, sessionsRes] = results;

  if (studentsRes.status === 'fulfilled') {
    const count = Array.isArray(studentsRes.value) ? studentsRes.value.length : (studentsRes.value.count || '-');
    document.getElementById('stat-students').textContent = count;
  }
  if (weeksRes.status === 'fulfilled') {
    const count = Array.isArray(weeksRes.value) ? weeksRes.value.length : '-';
    document.getElementById('stat-weeks').textContent = count;
  }
  if (quizzesRes.status === 'fulfilled') {
    const count = Array.isArray(quizzesRes.value) ? quizzesRes.value.length : '-';
    document.getElementById('stat-quizzes').textContent = count;
  }
  if (sessionsRes.status === 'fulfilled') {
    const count = Array.isArray(sessionsRes.value) ? sessionsRes.value.length : '-';
    document.getElementById('stat-sessions').textContent = count;
  }
}

/** 주차 관리 — 주차별 학습 내용 설정 */
async function renderWeekManager() {
  setContent(`
    <section class="tab-section" aria-label="주차 관리">
      <div class="content-card">
        <div class="week-manager-header">
          <div>
            <h2 class="card-title">주차 관리</h2>
            <p class="card-desc">매 주차의 학습 주제와 자료를 관리해요.</p>
          </div>
          <button class="action-btn" id="add-week-btn">+ 주차 추가</button>
        </div>
        <div id="week-form-area"></div>
      </div>
      <div id="week-list">
        <div class="list-placeholder">주차 목록을 불러오는 중...</div>
      </div>
    </section>
  `);

  // 주차 추가 버튼
  document.getElementById('add-week-btn').addEventListener('click', () => {
    toggleWeekForm();
  });

  await loadWeekList();
}

function toggleWeekForm() {
  const area = document.getElementById('week-form-area');
  if (area.innerHTML.trim()) {
    area.innerHTML = '';
    return;
  }
  area.innerHTML = `
    <div class="week-form">
      <input class="week-form-input" id="new-week-no" type="number" placeholder="주차 번호 (예: 2)" min="1" max="16" />
      <input class="week-form-input" id="new-week-title" type="text" placeholder="주차 제목 (예: 포인터와 배열)" />
      <div class="week-form-actions">
        <button class="action-btn" id="week-form-submit">추가</button>
        <button class="action-btn secondary" id="week-form-cancel">취소</button>
      </div>
    </div>
  `;
  document.getElementById('week-form-cancel').addEventListener('click', () => {
    document.getElementById('week-form-area').innerHTML = '';
  });
  document.getElementById('week-form-submit').addEventListener('click', async () => {
    const weekNo = parseInt(document.getElementById('new-week-no').value);
    const title  = document.getElementById('new-week-title').value.trim();
    if (!weekNo || !title) {
      showToast('주차 번호와 제목을 모두 입력해주세요.');
      return;
    }
    try {
      document.getElementById('week-form-submit').disabled = true;
      await createWeek(weekNo, title);
      document.getElementById('week-form-area').innerHTML = '';
      showToast(`${weekNo}주차가 추가되었어요.`);
      await loadWeekList();
    } catch (err) {
      showToast(err.message);
    } finally {
      const btn = document.getElementById('week-form-submit');
      if (btn) btn.disabled = false;
    }
  });
  document.getElementById('new-week-no').focus();
}

async function loadWeekList() {
  const listEl = document.getElementById('week-list');
  if (!listEl) return;

  try {
    const weeks = await fetchWeeks();
    if (!weeks || weeks.length === 0) {
      listEl.innerHTML = `<div class="list-placeholder">아직 등록된 주차가 없어요. 주차를 추가해보세요.</div>`;
      return;
    }

    listEl.innerHTML = weeks.map(w => {
      let pdfFiles = [];
      try { pdfFiles = JSON.parse(w.pdf_files || '[]'); } catch {}
      const pdfListHtml = pdfFiles.length > 0
        ? `<ul class="pdf-file-list">
            ${pdfFiles.map(f => `
              <li class="pdf-file-item">
                <span class="pdf-file-icon">📄</span>
                <span class="pdf-file-name">${escapeHtml(f.original)}</span>
                <span class="pdf-file-date">${new Date(f.uploadedAt).toLocaleDateString('ko-KR')}</span>
              </li>`).join('')}
           </ul>`
        : '';
      return `
      <div class="week-card" data-week-id="${w.id}">
        <div class="week-header">
          <div class="week-info">
            <span class="week-badge">${w.week_no}주차</span>
            <span class="week-title">${w.title}</span>
            <span class="week-pdf-status ${w.pdf_text ? 'has-pdf' : 'no-pdf'}">
              ${pdfFiles.length > 0 ? `PDF ${pdfFiles.length}개` : 'PDF 없음'}
            </span>
          </div>
          <div class="week-actions">
            <label class="upload-btn" title="PDF 업로드">
              PDF 업로드
              <input type="file" accept="application/pdf" multiple class="pdf-file-input visually-hidden" data-week-id="${w.id}" />
            </label>
            <button class="action-btn secondary quiz-manage-btn" data-week-id="${w.id}">퀴즈 관리</button>
          </div>
        </div>
        ${pdfListHtml}
        <div class="quiz-panel hidden" id="quiz-panel-${w.id}"></div>
      </div>
    `}).join('');

    // PDF 업로드 이벤트 위임
    listEl.addEventListener('change', async (e) => {
      const input = e.target.closest('.pdf-file-input');
      if (!input) return;
      const weekId = input.dataset.weekId;
      const files  = input.files;
      if (!files || files.length === 0) return;

      const label = input.closest('.upload-btn');
      const originalText = label.childNodes[0].textContent.trim();
      label.childNodes[0].textContent = '업로드 중... ';

      try {
        await uploadPdf(weekId, files);
        showToast(`PDF ${files.length}개 업로드 완료! AI가 퀴즈를 생성 중입니다...`);
        await loadWeekList();
        // 30초 후 퀴즈 생성 완료 가능성이 높으므로 목록 재갱신
        setTimeout(async () => {
          await loadWeekList();
          showToast('퀴즈 관리 버튼을 눌러 생성된 퀴즈를 확인하세요.');
        }, 30000);
      } catch (err) {
        showToast(err.message);
        label.childNodes[0].textContent = originalText + ' ';
      }
    });

    // 퀴즈 관리 버튼 이벤트 위임
    listEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('.quiz-manage-btn');
      if (!btn) return;
      const weekId = btn.dataset.weekId;
      const panel  = document.getElementById(`quiz-panel-${weekId}`);
      if (!panel) return;

      if (!panel.classList.contains('hidden')) {
        panel.classList.add('hidden');
        panel.innerHTML = '';
        return;
      }

      panel.classList.remove('hidden');
      panel.innerHTML = '<div class="list-placeholder">퀴즈 목록 불러오는 중...</div>';
      await loadQuizPanel(weekId, panel);
    });

  } catch (err) {
    listEl.innerHTML = `<div class="list-placeholder">${err.message}</div>`;
  }
}

async function loadQuizPanel(weekId, panelEl) {
  try {
    const quizzes = await fetchQuizzes({ week_id: weekId });

    if (!quizzes || quizzes.length === 0) {
      panelEl.innerHTML = '<div class="list-placeholder">이 주차에 퀴즈가 없어요. PDF를 업로드해서 AI 퀴즈를 생성하세요.</div>';
      return;
    }

    const pending  = quizzes.filter(q => !q.approved);
    const approved = quizzes.filter(q => q.approved);

    panelEl.innerHTML = `
      <div class="quiz-panel-inner">
        ${pending.length ? `
          <div class="quiz-panel-section">
            <h4 class="quiz-panel-section-title">미승인 퀴즈 (${pending.length}개) — 검토 후 승인하세요</h4>
            ${pending.map(q => renderQuizCard(q, true)).join('')}
          </div>
        ` : ''}
        ${approved.length ? `
          <div class="quiz-panel-section">
            <h4 class="quiz-panel-section-title">승인된 퀴즈 (${approved.length}개)</h4>
            ${approved.map(q => renderQuizCard(q, false)).join('')}
          </div>
        ` : ''}
      </div>
    `;

    // 승인/삭제 이벤트 위임
    panelEl.addEventListener('click', async (e) => {
      const approveBtn = e.target.closest('.approve-btn');
      const rejectBtn  = e.target.closest('.reject-btn');

      if (approveBtn) {
        const quizId = approveBtn.dataset.quizId;
        try {
          approveBtn.disabled = true;
          await approveQuiz(quizId);
          showToast('퀴즈가 승인되었어요.');
          await loadQuizPanel(weekId, panelEl);
        } catch (err) {
          showToast(err.message);
          approveBtn.disabled = false;
        }
      }

      if (rejectBtn) {
        const quizId = rejectBtn.dataset.quizId;
        try {
          rejectBtn.disabled = true;
          await rejectQuiz(quizId);
          showToast('퀴즈가 삭제되었어요.');
          await loadQuizPanel(weekId, panelEl);
        } catch (err) {
          showToast(err.message);
          rejectBtn.disabled = false;
        }
      }
    });

  } catch (err) {
    panelEl.innerHTML = `<div class="list-placeholder">${err.message}</div>`;
  }
}

function renderQuizCard(quiz, showActions) {
  let choicesHtml = '';
  if (quiz.type === 'multiple' && quiz.choices_json) {
    let choices = quiz.choices_json;
    if (typeof choices === 'string') {
      try { choices = JSON.parse(choices); } catch { choices = []; }
    }
    choicesHtml = `
      <ol class="quiz-choices-preview">
        ${choices.map((c, i) => `<li class="${quiz.answer == i + 1 || quiz.answer === c ? 'correct-choice' : ''}">${c}</li>`).join('')}
      </ol>
    `;
  }

  return `
    <div class="quiz-card" data-quiz-id="${quiz.id}">
      <div class="quiz-card-header">
        <span class="quiz-type-badge type-${quiz.type}">${quizTypeLabel(quiz.type)}</span>
        ${showActions ? '<span class="pending-badge">미승인</span>' : '<span class="approved-badge">승인됨</span>'}
      </div>
      <p class="quiz-question">${quiz.question}</p>
      ${choicesHtml}
      ${quiz.type === 'code_trace' ? `<pre class="code-block">${escapeHtml(quiz.question)}</pre>` : ''}
      <div class="quiz-answer-row">
        <span class="quiz-answer-label">정답:</span>
        <span class="quiz-answer-value">${quiz.answer}</span>
      </div>
      ${quiz.explanation ? `<p class="quiz-explanation">${quiz.explanation}</p>` : ''}
      ${showActions ? `
        <div class="quiz-card-actions">
          <button class="approve-btn" data-quiz-id="${quiz.id}">승인</button>
          <button class="reject-btn" data-quiz-id="${quiz.id}">삭제</button>
        </div>
      ` : ''}
    </div>
  `;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 세션 — 튜터링 세션 기록 */
async function renderSession() {
  setContent(`
    <section class="tab-section" aria-label="세션">
      <div class="content-card">
        <div class="week-manager-header">
          <div>
            <h2 class="card-title">세션 관리</h2>
            <p class="card-desc">튜터링 세션을 기록하고 관리해요.</p>
          </div>
          <button class="action-btn" id="new-session-btn">+ 새 세션 시작</button>
        </div>
        <div id="session-form-area"></div>
      </div>
      <div id="session-list">
        <div class="list-placeholder">세션 데이터를 불러오는 중...</div>
      </div>
    </section>
  `);

  document.getElementById('new-session-btn').addEventListener('click', () => {
    toggleSessionForm();
  });

  await loadSessionList();
}

async function toggleSessionForm() {
  const area = document.getElementById('session-form-area');
  if (area.innerHTML.trim()) {
    area.innerHTML = '';
    return;
  }

  area.innerHTML = '<div class="list-placeholder">폼 불러오는 중...</div>';

  let weeks = [];
  let students = [];
  try {
    [weeks, students] = await Promise.all([fetchWeeks(), fetchStudents()]);
  } catch (err) {
    area.innerHTML = `<div class="list-placeholder">${err.message}</div>`;
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const nowTime = new Date().toTimeString().slice(0, 5);

  area.innerHTML = `
    <div class="session-form">
      <div class="session-form-row">
        <label class="form-label">주차 선택</label>
        <select class="week-form-input" id="sf-week">
          <option value="">-- 주차 선택 --</option>
          ${weeks.sort((a, b) => a.week_no - b.week_no).map(w =>
            `<option value="${w.id}">${w.week_no}주차 · ${w.title}</option>`
          ).join('')}
        </select>
      </div>
      <div class="session-form-row">
        <label class="form-label">날짜</label>
        <input class="week-form-input" type="date" id="sf-date" value="${today}" />
      </div>
      <div class="session-form-row">
        <label class="form-label">시작 시간</label>
        <input class="week-form-input" type="time" id="sf-start-time" value="${nowTime}" />
      </div>
      <div class="session-form-row">
        <label class="form-label">참석 학생</label>
        <div class="student-checkboxes">
          ${students.length === 0
            ? '<span class="card-desc">등록된 학생이 없어요.</span>'
            : students.map(s => `
                <label class="checkbox-label">
                  <input type="checkbox" class="student-check" value="${s.id}" />
                  <span>${s.name} (${s.email})</span>
                </label>
              `).join('')
          }
        </div>
      </div>
      <div class="session-form-row">
        <label class="form-label">다룬 토픽 <span class="form-hint">(쉼표로 구분)</span></label>
        <textarea class="week-form-input" id="sf-topics" rows="2" placeholder="예: 포인터, 배열, 구조체"></textarea>
      </div>
      <div class="session-form-row">
        <label class="form-label">튜터 노트</label>
        <textarea class="week-form-input" id="sf-note" rows="3" placeholder="오늘 세션 특이사항, 학생 반응 등을 기록하세요."></textarea>
      </div>
      <div class="week-form-actions">
        <button class="action-btn" id="sf-submit">세션 기록 저장</button>
        <button class="action-btn secondary" id="sf-cancel">취소</button>
      </div>
    </div>
  `;

  document.getElementById('sf-cancel').addEventListener('click', () => {
    document.getElementById('session-form-area').innerHTML = '';
  });

  document.getElementById('sf-submit').addEventListener('click', async () => {
    const weekId    = document.getElementById('sf-week').value;
    const date      = document.getElementById('sf-date').value;
    const startTime = document.getElementById('sf-start-time').value;
    const topicsRaw = document.getElementById('sf-topics').value.trim();
    const note      = document.getElementById('sf-note').value.trim();

    if (!weekId) { showToast('주차를 선택해주세요.'); return; }
    if (!date)   { showToast('날짜를 입력해주세요.'); return; }

    const topics = topicsRaw
      ? topicsRaw.split(',').map(t => t.trim()).filter(Boolean)
      : [];

    const checkedStudents = [...document.querySelectorAll('.student-check:checked')]
      .map(cb => parseInt(cb.value));

    const submitBtn = document.getElementById('sf-submit');
    submitBtn.disabled = true;

    try {
      const res = await fetch(`${API}/sessions`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          week_id: parseInt(weekId),
          date,
          start_time: startTime,
          topics_covered_json: JSON.stringify(topics),
          tutor_note: note,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '세션 저장에 실패했어요.');

      const newSession = data.data || data;

      if (checkedStudents.length > 0) {
        try {
          await fetch(`${API}/sessions/${newSession.id}/attendance`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ student_ids: checkedStudents }),
          });
        } catch {
          // 출석 저장 실패해도 세션 자체는 성공으로 처리
        }
      }

      document.getElementById('session-form-area').innerHTML = '';
      showToast('세션이 기록되었어요.');
      await loadSessionList();
    } catch (err) {
      showToast(err.message);
      submitBtn.disabled = false;
    }
  });
}

function parseTopics(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); } catch { return []; }
}

async function loadSessionList() {
  const listEl = document.getElementById('session-list');
  if (!listEl) return;

  try {
    const sessions = await fetchSessions();

    if (!sessions || sessions.length === 0) {
      listEl.innerHTML = '<div class="list-placeholder">아직 세션 기록이 없어요. 새 세션을 시작해보세요.</div>';
      return;
    }

    listEl.innerHTML = sessions
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .map(s => {
        const topics = parseTopics(s.topics_covered_json);
        return `
          <div class="session-card" data-session-id="${s.id}">
            <div class="session-card-header">
              <div class="session-meta">
                <span class="session-date">${s.date || '-'}</span>
                ${s.week_no ? `<span class="session-week">${s.week_no}주차</span>` : ''}
                <span class="session-time">${s.start_time || ''} ~ ${s.end_time || '진행 중'}</span>
              </div>
              <div class="session-card-actions">
                ${!s.end_time ? `
                  <button class="action-btn end-session-btn" data-session-id="${s.id}">종료 시간 기록</button>
                ` : ''}
                <button class="action-btn secondary download-btn" data-session-id="${s.id}">보고서</button>
              </div>
            </div>
            ${topics.length > 0 ? `
              <div class="session-topics">
                <strong>다룬 토픽:</strong> ${topics.join(', ')}
              </div>
            ` : ''}
            ${s.tutor_note ? `<p class="session-note">${s.tutor_note}</p>` : ''}
          </div>
        `;
      }).join('');

    // 종료 시간 기록 이벤트 위임
    listEl.addEventListener('click', async (e) => {
      const endBtn = e.target.closest('.end-session-btn');
      const dlBtn  = e.target.closest('.download-btn');

      if (endBtn) {
        const sessionId = endBtn.dataset.sessionId;
        const nowTime   = new Date().toTimeString().slice(0, 5);
        endBtn.disabled = true;
        try {
          const res = await fetch(`${API}/sessions/${sessionId}`, {
            method: 'PUT',
            headers: authHeaders(),
            body: JSON.stringify({ end_time: nowTime }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || '종료 시간 저장에 실패했어요.');
          showToast(`종료 시간 ${nowTime} 기록됨`);
          await loadSessionList();
        } catch (err) {
          showToast(err.message);
          endBtn.disabled = false;
        }
      }

      if (dlBtn) {
        const sessionId = dlBtn.dataset.sessionId;
        await downloadReport(sessionId);
      }
    });

  } catch (err) {
    listEl.innerHTML = `<div class="list-placeholder">${err.message}</div>`;
  }
}

/** 보고서 다운로드 (fetch + blob 방식, Authorization 헤더 포함) */
async function downloadReport(sessionId) {
  try {
    const res = await fetch(`${API}/sessions/${sessionId}/report`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || '보고서 다운로드에 실패했어요.');
    }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `report_session_${sessionId}.txt`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
  } catch (err) {
    showToast(err.message);
  }
}

/** 보고서 — 학생별 성취 보고서 */
async function renderReport() {
  setContent(`
    <section class="tab-section" aria-label="보고서">
      <div class="content-card">
        <h2 class="card-title">보고서</h2>
        <p class="card-desc">세션별 활동 보고서를 다운로드해요 (상명튜터링 양식).</p>
      </div>
      <div class="report-area" id="report-area">
        <div class="list-placeholder">보고서 데이터를 불러오는 중...</div>
      </div>
    </section>
  `);

  try {
    const sessions = await fetchSessions();
    const areaEl   = document.getElementById('report-area');
    if (!areaEl) return;

    if (!sessions || sessions.length === 0) {
      areaEl.innerHTML = '<div class="list-placeholder">아직 세션 데이터가 없어요. 세션을 먼저 기록해주세요.</div>';
      return;
    }

    areaEl.innerHTML = sessions
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .map(s => {
        const topics = parseTopics(s.topics_covered_json);
        return `
          <div class="report-card">
            <div class="report-card-header">
              <div class="session-meta">
                <span class="session-date">${s.date || '-'}</span>
                ${s.week_no ? `<span class="session-week">${s.week_no}주차</span>` : ''}
                <span class="session-time">${s.start_time || ''} ~ ${s.end_time || '-'}</span>
              </div>
              <button class="action-btn download-btn" data-session-id="${s.id}">
                보고서 다운로드
              </button>
            </div>
            ${topics.length > 0 ? `
              <div class="session-topics">
                <strong>다룬 토픽:</strong> ${topics.join(', ')}
              </div>
            ` : ''}
            ${s.tutor_note ? `<p class="session-note">${s.tutor_note}</p>` : ''}
          </div>
        `;
      }).join('');

    areaEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('.download-btn');
      if (!btn) return;
      const sessionId = btn.dataset.sessionId;
      btn.disabled = true;
      await downloadReport(sessionId);
      btn.disabled = false;
    });

  } catch (err) {
    const areaEl = document.getElementById('report-area');
    if (areaEl) areaEl.innerHTML = `<div class="list-placeholder">${err.message}</div>`;
  }
}

// ================================================================
// 학생 탭 렌더러
// ================================================================

/** 오늘의 퀴즈 */
async function renderTodayQuiz() {
  setContent(`
    <section class="tab-section" aria-label="오늘퀴즈">
      <div class="content-card">
        <h2 class="card-title">오늘의 퀴즈</h2>
        <p class="card-desc">자료구조 퀴즈를 풀어봐요.</p>
      </div>
      <div id="quiz-area">
        <div class="list-placeholder">퀴즈를 불러오는 중...</div>
      </div>
    </section>
  `);

  try {
    // 가장 최근 주차 파악
    const weeks = await fetchWeeks();
    if (!weeks || weeks.length === 0) {
      document.getElementById('quiz-area').innerHTML =
        '<div class="list-placeholder">아직 등록된 주차가 없어요.</div>';
      return;
    }

    const latestWeek = weeks.sort((a, b) => b.week_no - a.week_no)[0];
    const quizzes    = await fetchQuizzes({ week_id: latestWeek.id, approved: 'true' });

    if (!quizzes || quizzes.length === 0) {
      document.getElementById('quiz-area').innerHTML =
        `<div class="list-placeholder">${latestWeek.week_no}주차 퀴즈가 아직 없어요.</div>`;
      return;
    }

    // 퀴즈 상태 초기화
    quizState = {
      quizzes,
      currentIndex: 0,
      score: 0,
      answered: false,
      weekTitle: latestWeek.title,
      weekNo: latestWeek.week_no,
    };

    renderCurrentQuiz();

  } catch (err) {
    const areaEl = document.getElementById('quiz-area');
    if (areaEl) areaEl.innerHTML = `<div class="list-placeholder">${err.message}</div>`;
  }
}

function renderCurrentQuiz() {
  const { quizzes, currentIndex, score, weekNo, weekTitle } = quizState;

  if (currentIndex >= quizzes.length) {
    renderQuizSummary();
    return;
  }

  const quiz    = quizzes[currentIndex];
  const total   = quizzes.length;
  const progress = Math.round(((currentIndex) / total) * 100);

  let questionBodyHtml = '';

  if (quiz.type === 'ox') {
    questionBodyHtml = `
      <div class="ox-buttons">
        <button class="choice-btn ox-btn" data-answer="O">O</button>
        <button class="choice-btn ox-btn" data-answer="X">X</button>
      </div>
    `;
  } else if (quiz.type === 'multiple') {
    let choices = quiz.choices_json;
    if (typeof choices === 'string') {
      try { choices = JSON.parse(choices); } catch { choices = []; }
    }
    const circleNums = ['①', '②', '③', '④'];
    questionBodyHtml = `
      <div class="multiple-choices">
        ${(choices || []).map((c, i) => `
          <label class="choice-label">
            <input type="radio" name="quiz-choice" value="${circleNums[i] || (i + 1)}" class="choice-radio" />
            <span class="choice-text">${c}</span>
          </label>
        `).join('')}
      </div>
      <button class="submit-btn" id="submit-multiple">제출</button>
    `;
  } else if (quiz.type === 'code_trace') {
    let ctChoices = quiz.choices_json;
    if (typeof ctChoices === 'string') {
      try { ctChoices = JSON.parse(ctChoices); } catch { ctChoices = []; }
    }
    const circleNums = ['①', '②', '③', '④'];
    questionBodyHtml = `
      <div class="multiple-choices">
        ${(ctChoices || []).map((c, i) => `
          <label class="choice-label">
            <input type="radio" name="quiz-choice" value="${circleNums[i] || (i + 1)}" class="choice-radio" />
            <span class="choice-text">${c}</span>
          </label>
        `).join('')}
      </div>
      <button class="submit-btn" id="submit-code-trace">제출</button>
    `;
  }

  document.getElementById('quiz-area').innerHTML = `
    <div class="quiz-progress-bar-wrap">
      <div class="quiz-progress-bar" style="width: ${progress}%"></div>
    </div>
    <div class="quiz-meta">
      <span class="quiz-week-label">${weekNo}주차 · ${weekTitle}</span>
      <span class="quiz-counter">${currentIndex + 1} / ${total}</span>
    </div>
    <div class="quiz-card-student">
      <div class="quiz-card-top">
        <span class="quiz-type-badge type-${quiz.type}">${quizTypeLabel(quiz.type)}</span>
        <span class="quiz-score-display">현재 점수: ${score}점</span>
      </div>
      <p class="quiz-question">${quiz.question}</p>
      <div class="quiz-body" id="quiz-body">
        ${questionBodyHtml}
      </div>
      <div class="quiz-result hidden" id="quiz-result"></div>
    </div>
  `;

  quizState.answered = false;

  // OX 이벤트 위임
  const body = document.getElementById('quiz-body');
  if (body) {
    body.addEventListener('click', async (e) => {
      if (quizState.answered) return;

      const oxBtn     = e.target.closest('.ox-btn');
      const submitMul = e.target.closest('#submit-multiple');
      const submitCt  = e.target.closest('#submit-code-trace');

      if (oxBtn) {
        await handleQuizSubmit(quiz, oxBtn.dataset.answer);
      }
      if (submitMul) {
        const checked = document.querySelector('input[name="quiz-choice"]:checked');
        if (!checked) { showToast('보기를 선택해주세요.'); return; }
        await handleQuizSubmit(quiz, checked.value);
      }
      if (submitCt) {
        const checked = document.querySelector('input[name="quiz-choice"]:checked');
        if (!checked) { showToast('보기를 선택해주세요.'); return; }
        await handleQuizSubmit(quiz, checked.value);
      }
    });
  }
}

async function handleQuizSubmit(quiz, userAnswer) {
  quizState.answered = true;

  // 버튼 비활성화
  document.querySelectorAll('.choice-btn, .submit-btn, .choice-radio').forEach(el => {
    el.disabled = true;
  });

  let isCorrect = false;
  try {
    const result = await submitQuizAnswer(quiz.id, userAnswer);
    isCorrect = result.is_correct;
  } catch {
    // 오프라인 폴백: 클라이언트 측 정답 비교
    isCorrect = String(userAnswer).trim().toLowerCase() === String(quiz.answer).trim().toLowerCase();
  }

  if (isCorrect) quizState.score += 1;

  // 결과 표시
  const resultEl = document.getElementById('quiz-result');
  if (resultEl) {
    resultEl.classList.remove('hidden');
    resultEl.innerHTML = `
      <div class="result-indicator ${isCorrect ? 'correct' : 'wrong'}">
        ${isCorrect ? '정답' : '오답'}
      </div>
      <div class="result-answer">
        정답: <strong>${quiz.answer}</strong>
        ${!isCorrect ? `<span class="your-answer"> / 내 답: ${userAnswer}</span>` : ''}
      </div>
      ${quiz.explanation ? `<p class="result-explanation">${quiz.explanation}</p>` : ''}
      <button class="submit-btn next-btn" id="next-quiz-btn">
        ${quizState.currentIndex + 1 < quizState.quizzes.length ? '다음 문제' : '결과 보기'}
      </button>
    `;

    document.getElementById('next-quiz-btn').addEventListener('click', () => {
      quizState.currentIndex += 1;
      renderCurrentQuiz();
    });
  }

  // 정답 보기 하이라이트
  if (quiz.type === 'ox') {
    document.querySelectorAll('.ox-btn').forEach(btn => {
      if (btn.dataset.answer === quiz.answer) btn.classList.add('correct');
      else if (btn.dataset.answer === userAnswer && !isCorrect) btn.classList.add('wrong');
    });
  }
}

/** 주차 번호에서 이해도 체크 토픽 목록 반환 */
function getTopicsForWeek(weekNo, weekTitle) {
  if (weekNo === 2)  return ['포인터', '자료구조 개념'];
  if (weekNo === 3)  return ['배열', '구조체'];
  if (weekNo === 4)  return ['스택', 'push/pop'];
  if (weekNo >= 5)   return ['연결 리스트', 'ADT'];
  return [weekTitle];
}

async function renderQuizSummary() {
  const { quizzes, score, weekNo, weekTitle } = quizState;
  const total      = quizzes.length;
  const percentage = Math.round((score / total) * 100);
  const message    = percentage >= 80 ? '훌륭해요!' : percentage >= 60 ? '잘 했어요!' : '더 노력해봐요!';
  const topics     = getTopicsForWeek(weekNo, weekTitle);

  document.getElementById('quiz-area').innerHTML = `
    <div class="quiz-summary-card">
      <div class="summary-title">${weekNo}주차 퀴즈 완료</div>
      <div class="summary-score">${score} / ${total}</div>
      <div class="summary-percent">${percentage}%</div>
      <div class="summary-message">${message}</div>
      <button class="submit-btn" id="retry-quiz-btn">다시 풀기</button>
    </div>
    <div class="understanding-section hidden" id="understanding-section">
      <h3 class="understanding-title">이 주차 내용이 얼마나 이해됐나요?</h3>
      <div id="understanding-rows">
        ${topics.map(topic => `
          <div class="understanding-row" data-topic="${topic}">
            <span class="understanding-topic">${topic}</span>
            <div class="understanding-btns">
              <button class="level-btn good" data-level="good" data-topic="${topic}">O 잘이해</button>
              <button class="level-btn confused" data-level="confused" data-topic="${topic}">△ 헷갈림</button>
              <button class="level-btn lost" data-level="lost" data-topic="${topic}">X 모름</button>
            </div>
          </div>
        `).join('')}
      </div>
      <p class="understanding-status" id="understanding-status"></p>
    </div>
  `;

  document.getElementById('retry-quiz-btn').addEventListener('click', () => {
    renderTodayQuiz();
  });

  // 현재 주차의 최근 세션 조회 → 이해도 체크 UI 표시 여부 결정
  try {
    const weeks = await fetchWeeks();
    const currentWeek = weeks.find(w => w.week_no === weekNo);
    if (!currentWeek) return;

    const res = await fetch(`${API}/sessions?week_id=${currentWeek.id}`, { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    const sessions = data.data || data;

    if (!sessions || sessions.length === 0) return;

    // 가장 최근 세션
    const latestSession = sessions.sort((a, b) => new Date(b.date) - new Date(a.date))[0];

    const section = document.getElementById('understanding-section');
    if (section) section.classList.remove('hidden');

    // 이해도 버튼 이벤트 위임
    const rowsEl = document.getElementById('understanding-rows');
    if (!rowsEl) return;

    rowsEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('.level-btn');
      if (!btn) return;

      const topic = btn.dataset.topic;
      const level = btn.dataset.level;

      // 같은 토픽의 버튼 선택 상태 업데이트
      rowsEl.querySelectorAll(`.level-btn[data-topic="${topic}"]`).forEach(b => {
        b.classList.toggle('selected', b === btn);
      });

      const statusEl = document.getElementById('understanding-status');
      try {
        const postRes = await fetch(`${API}/sessions/${latestSession.id}/understanding`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ topic, level }),
        });
        if (!postRes.ok) {
          const d = await postRes.json().catch(() => ({}));
          throw new Error(d.error || '저장 실패');
        }
        if (statusEl) statusEl.textContent = `"${topic}" 이해도가 저장되었어요.`;
      } catch (err) {
        if (statusEl) statusEl.textContent = `저장 오류: ${err.message}`;
      }
    });

  } catch {
    // 세션 조회 실패 시 이해도 체크 UI는 숨김 유지
  }
}

/** 학습 자료 */
async function renderMaterials() {
  setContent(`
    <section class="tab-section" aria-label="학습자료">
      <div class="content-card">
        <h2 class="card-title">학습 자료</h2>
        <p class="card-desc">주차별 핵심 개념을 확인해요.</p>
      </div>
      <div id="materials-list">
        <div class="list-placeholder">학습 자료를 불러오는 중...</div>
      </div>
    </section>
  `);

  try {
    const weeks = await fetchWeeks();
    const listEl = document.getElementById('materials-list');
    if (!listEl) return;

    if (!weeks || weeks.length === 0) {
      listEl.innerHTML = '<div class="list-placeholder">아직 등록된 학습 자료가 없어요.</div>';
      return;
    }

    listEl.innerHTML = weeks
      .sort((a, b) => a.week_no - b.week_no)
      .map(w => `
        <div class="material-card">
          <div class="material-header">
            <span class="week-badge">${w.week_no}주차</span>
            <span class="material-title">${w.title}</span>
            ${w.pdf_text ? '<span class="pdf-badge">PDF 있음</span>' : ''}
          </div>
          ${w.pdf_text ? `
            <div class="material-preview">
              <p class="material-preview-text">${w.pdf_text.slice(0, 200).replace(/\n/g, ' ')}${w.pdf_text.length > 200 ? '...' : ''}</p>
            </div>
          ` : `<p class="no-material-text">아직 학습 자료가 없어요.</p>`}
        </div>
      `).join('');

  } catch (err) {
    const listEl = document.getElementById('materials-list');
    if (listEl) listEl.innerHTML = `<div class="list-placeholder">${err.message}</div>`;
  }
}

/** 내 약점 */
async function renderMyWeakness() {
  setContent(`
    <section class="tab-section" aria-label="내약점">
      <div class="content-card">
        <h2 class="card-title">내 약점</h2>
        <p class="card-desc">퀴즈에서 틀린 문제를 다시 확인하고 개념을 다져봐요.</p>
      </div>
      <div id="weakness-area">
        <div class="list-placeholder">약점 분석 중...</div>
      </div>
    </section>
  `);

  try {
    // 모든 승인된 퀴즈의 내 결과를 조회
    const res = await fetch(`${API}/quizzes/my-results`, { headers: authHeaders() });
    let results = [];
    if (res.ok) {
      const data = await res.json();
      results = data.data || data;
    }

    const areaEl = document.getElementById('weakness-area');
    if (!areaEl) return;

    if (!results || results.length === 0) {
      areaEl.innerHTML = '<div class="list-placeholder">아직 풀어본 퀴즈가 없어요. 오늘 퀴즈를 먼저 풀어보세요!</div>';
      return;
    }

    const wrong   = results.filter(r => !r.is_correct);
    const correct = results.filter(r => r.is_correct);
    const total   = results.length;
    const score   = correct.length;
    const pct     = Math.round((score / total) * 100);

    areaEl.innerHTML = `
      <div class="weakness-summary">
        <div class="weakness-stat">
          <span class="weakness-stat-num correct-color">${score}</span>
          <span class="weakness-stat-label">맞은 문제</span>
        </div>
        <div class="weakness-stat">
          <span class="weakness-stat-num wrong-color">${wrong.length}</span>
          <span class="weakness-stat-label">틀린 문제</span>
        </div>
        <div class="weakness-stat">
          <span class="weakness-stat-num">${pct}%</span>
          <span class="weakness-stat-label">정답률</span>
        </div>
      </div>
      ${wrong.length === 0 ? `
        <div class="list-placeholder">완벽해요! 틀린 문제가 없어요.</div>
      ` : `
        <div class="weakness-wrong-list">
          <h3 class="weakness-section-title">틀린 문제 다시보기 (${wrong.length}개)</h3>
          ${wrong.map(r => `
            <div class="weakness-quiz-card">
              <div class="weakness-quiz-top">
                <span class="quiz-type-badge type-${r.type}">${quizTypeLabel(r.type)}</span>
                <span class="wrong-badge">오답</span>
              </div>
              <p class="quiz-question">${r.question}</p>
              <div class="weakness-answers">
                <span class="your-answer-label">내 답: <strong>${r.user_answer}</strong></span>
                <span class="correct-answer-label">정답: <strong>${r.answer}</strong></span>
              </div>
              ${r.explanation ? `<p class="result-explanation">${r.explanation}</p>` : ''}
            </div>
          `).join('')}
        </div>
      `}
    `;

  } catch (err) {
    const areaEl = document.getElementById('weakness-area');
    if (areaEl) areaEl.innerHTML = `<div class="list-placeholder">${err.message}</div>`;
  }
}

// ================================================================
// Socket.io — 실시간 연결
// ================================================================

function connectSocket() {
  if (typeof io === 'undefined') return;

  socket = io(API, { transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    console.log('[Socket] 연결됨:', socket.id);
    if (currentUser) {
      socket.emit('join', `user:${currentUser.id}`);
    }
  });

  socket.on('disconnect', () => {
    console.log('[Socket] 연결 해제됨');
  });

  socket.on('quiz:new', () => {
    if (activeTab === 'today-quiz') renderTodayQuiz();
  });

  socket.on('material:added', () => {
    if (activeTab === 'materials') renderMaterials();
  });
}

// ================================================================
// 이벤트 리스너 등록
// ================================================================

function bindAuthEvents() {
  // 로그인 / 회원가입 탭 전환
  document.getElementById('tab-login').addEventListener('click', () => {
    document.getElementById('tab-login').classList.add('active');
    document.getElementById('tab-login').setAttribute('aria-selected', 'true');
    document.getElementById('tab-register').classList.remove('active');
    document.getElementById('tab-register').setAttribute('aria-selected', 'false');
    document.getElementById('panel-login').classList.remove('hidden');
    document.getElementById('panel-register').classList.add('hidden');
  });

  document.getElementById('tab-register').addEventListener('click', () => {
    document.getElementById('tab-register').classList.add('active');
    document.getElementById('tab-register').setAttribute('aria-selected', 'true');
    document.getElementById('tab-login').classList.remove('active');
    document.getElementById('tab-login').setAttribute('aria-selected', 'false');
    document.getElementById('panel-register').classList.remove('hidden');
    document.getElementById('panel-login').classList.add('hidden');
  });

  // 로그인 제출
  document.getElementById('login-submit').addEventListener('click', async () => {
    const email    = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const errEl    = document.getElementById('login-error');
    errEl.textContent = '';

    if (!email || !password) {
      errEl.textContent = '이메일과 비밀번호를 모두 입력해주세요.';
      return;
    }
    try {
      document.getElementById('login-submit').disabled = true;
      await login(email, password);
      initApp();
    } catch (err) {
      errEl.textContent = err.message;
    } finally {
      document.getElementById('login-submit').disabled = false;
    }
  });

  // 회원가입 제출
  document.getElementById('register-submit').addEventListener('click', async () => {
    const name     = document.getElementById('register-name').value.trim();
    const email    = document.getElementById('register-email').value.trim();
    const password = document.getElementById('register-password').value;
    const role     = document.querySelector('input[name="register-role"]:checked').value;
    const errEl    = document.getElementById('register-error');
    errEl.textContent = '';

    if (!name || !email || !password) {
      errEl.textContent = '모든 항목을 입력해주세요.';
      return;
    }
    if (password.length < 6) {
      errEl.textContent = '비밀번호는 6자 이상이어야 해요.';
      return;
    }
    try {
      document.getElementById('register-submit').disabled = true;
      await register(name, email, password, role);
      initApp();
    } catch (err) {
      errEl.textContent = err.message;
    } finally {
      document.getElementById('register-submit').disabled = false;
    }
  });

  // Enter 키 지원
  document.getElementById('login-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('login-submit').click();
  });
  document.getElementById('register-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('register-submit').click();
  });
}

function bindAppEvents() {
  document.getElementById('logout-btn').addEventListener('click', () => {
    logout();
    showToast('로그아웃했어요.');
  });
}

// ================================================================
// 앱 시작점
// ================================================================

document.addEventListener('DOMContentLoaded', () => {
  bindAuthEvents();
  bindAppEvents();

  if (isLoggedIn()) {
    initApp();
  } else {
    showAuthScreen();
  }
});
