import './style.css';

const VERSION = 'v0.0.1 · 0단계';

// 0단계: 화면 골격 확인용 예시 데이터 (1단계에서 실제 저장소로 교체)
const SYSTEM_FOLDERS = [
  { id: 'all', name: '모든 노트', icon: '▤' },
  { id: 'fav', name: '즐겨찾기', icon: '☆' },
  { id: 'locked', name: '잠긴 노트', icon: '🔒' },
  { id: 'trash', name: '휴지통', icon: '🗑' },
];

const SAMPLE_FOLDERS = [
  { id: 'f-work', name: '(SSU) 업무, 회의노트' },
  { id: 'f-sermon', name: '설교 노트' },
  { id: 'f-manual', name: '(매뉴얼) 제품, 교회음향' },
  { id: 'f-personal', name: 'YB Personal' },
];

const SAMPLE_NOTES = [
  { id: 'n1', folder: 'f-sermon', title: '주일 설교 노트 (예시)', type: '혼합', updated: '오늘', fav: true },
  { id: 'n2', folder: 'f-work', title: '교육과정 회의 메모 (예시)', type: '텍스트', updated: '어제', fav: false },
  { id: 'n3', folder: 'f-manual', title: '음향장비 연결도 (예시)', type: '필기', updated: '10월 20일', fav: false },
  { id: 'n4', folder: 'f-personal', title: '할 일 목록 (예시)', type: '텍스트', updated: '10월 15일', fav: true },
];

const state = { folder: 'all', note: null };
const $ = (sel) => document.querySelector(sel);
const app = $('#app');

function folderName(id) {
  return [...SYSTEM_FOLDERS, ...SAMPLE_FOLDERS].find((f) => f.id === id)?.name ?? '';
}

function visibleNotes() {
  if (state.folder === 'all') return SAMPLE_NOTES;
  if (state.folder === 'fav') return SAMPLE_NOTES.filter((n) => n.fav);
  if (state.folder === 'locked' || state.folder === 'trash') return [];
  return SAMPLE_NOTES.filter((n) => n.folder === state.folder);
}

function renderFolders() {
  const item = (f, icon) => `
    <button class="folder ${state.folder === f.id ? 'active' : ''}" data-folder="${f.id}">
      <span class="f-icon">${icon}</span><span class="f-name">${f.name}</span>
    </button>`;
  $('#folder-nav').innerHTML =
    SYSTEM_FOLDERS.map((f) => item(f, f.icon)).join('') +
    '<div class="nav-label">폴더</div>' +
    SAMPLE_FOLDERS.map((f) => item(f, '▢')).join('');
}

function renderList() {
  $('#list-title').textContent = folderName(state.folder);
  const notes = visibleNotes();
  $('#note-list').innerHTML = notes.length
    ? notes
        .map(
          (n) => `
      <li>
        <button class="note-card ${state.note === n.id ? 'active' : ''}" data-note="${n.id}">
          <span class="nc-title">${n.fav ? '★ ' : ''}${n.title}</span>
          <span class="nc-meta">${n.type} · ${n.updated}</span>
        </button>
      </li>`
        )
        .join('')
    : '<li class="empty">노트가 없습니다.</li>';
}

function renderEditor() {
  const n = SAMPLE_NOTES.find((x) => x.id === state.note);
  $('#editor-title').textContent = n ? n.title : '노트를 선택하세요';
}

function render() {
  renderFolders();
  renderList();
  renderEditor();
}

// 이벤트
document.addEventListener('click', (e) => {
  const f = e.target.closest('[data-folder]');
  if (f) {
    state.folder = f.dataset.folder;
    state.note = null;
    app.dataset.view = 'list';
    render();
    return;
  }
  const n = e.target.closest('[data-note]');
  if (n) {
    state.note = n.dataset.note;
    app.dataset.view = 'editor';
    render();
    return;
  }
  const go = e.target.closest('[data-go]');
  if (go) app.dataset.view = go.dataset.go;
});

$('#version').textContent = VERSION;
render();
