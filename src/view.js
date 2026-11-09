// 웹에 게시한 노트 열람 화면 (로그인 없음 · 읽기 전용 · 실시간 반영)
import './style.css';
import { getTheme, setTheme } from './theme.js';
import { useReadOnlyBase, watchPublic } from './store.js';
import { createEditor, hydrateJSON } from './editor.js';
import { downloadUrl, hostLabel, stripTags, CODE_RE, sanitizeHtml } from './share-utils.js';
import { createHtmlView } from './htmlnote.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// 다크 모드만은 열람자가 바꿀 수 있음 (이 기기에만 기억)
const themeSel = document.querySelector('#v-theme');
themeSel.value = getTheme();
themeSel.onchange = () => setTheme(themeSel.value);

const sid = (new URLSearchParams(location.search).get('s') || '').toLowerCase();

let htmlView = null;
function message(title, sub = '') {
  $('#editor').hidden = true;
  htmlView?.hide();
  $('#v-files').hidden = true;
  $('#v-live').hidden = true;
  $('#v-msg').hidden = false;
  $('#v-msg').innerHTML = `<p class="ph-title">${esc(title)}</p>${sub ? `<p>${esc(sub)}</p>` : ''}`;
}

if (!CODE_RE.test(sid)) {
  message('주소가 올바르지 않습니다', '받은 주소 전체를 다시 확인해 주세요.');
} else {
  useReadOnlyBase(sid);
  const editor = createEditor($('#editor'), { onUpdate() {}, getNoteId: () => 'view', onInk() {} });
  editor.setEditable(false, false);
  let lastJson = null;
  let seq = 0;
  watchPublic(sid, async (d) => {
    const my = ++seq;
    if (!d) return message('게시가 종료되었거나 없는 주소입니다', '노트를 게시한 분께 새 주소를 받아 주세요.');
    const title = stripTags(d.title) || '제목 없음';
    $('#v-name').textContent = d.shareName || 'YB 노트';
    $('#v-title').textContent = title;
    document.title = `${title} - ${d.shareName || 'YB 노트'}`;
    $('#v-live').hidden = false;
    // 자료 링크
    const files = (d.attachments || []).filter((a) => a?.url);
    $('#v-files').hidden = !files.length;
    $('#v-file-list').innerHTML = files
      .map((a) => `<li><span class="vf-name">${esc(a.name)}</span><span class="vf-host">${esc(hostLabel(a.url))}</span><a class="btn-primary vf-btn" href="${esc(downloadUrl(a.url))}" target="_blank" rel="noopener">내려받기</a></li>`)
      .join('');
    // HTML 노트: 원본 문서를 그대로 (스크립트 없이, 읽기 전용)
    if (d.type === 'html') {
      htmlView ??= createHtmlView($('.v-wrap'), { readOnly: true });
      $('#editor').hidden = true;
      const wrap = $('.v-wrap');
      const top = wrap.scrollTop;
      const before = htmlView.visible;
      await htmlView.show(sanitizeHtml(d.html || ''));
      if (my !== seq) return;
      wrap.scrollTop = top;
      if (before) flash();
      $('#v-msg').hidden = true;
      return;
    }
    htmlView?.hide();
    // 본문 (바뀐 경우에만 다시 그림, 읽던 위치 유지)
    const ed = $('#editor');
    ed.dataset.bg = d.background || 'lined';
    ed.dataset.color = d.bgColor || '';
    if (d.contentJson !== lastJson) {
      lastJson = d.contentJson;
      let json = null;
      try { json = d.contentJson ? JSON.parse(d.contentJson) : null; } catch { json = null; }
      const content = await hydrateJSON(json);
      if (my !== seq) return; // 그새 더 새 내용이 옴
      const wrap = $('.v-wrap');
      const top = wrap.scrollTop;
      editor.commands.setContent(content || '', { emitUpdate: false });
      wrap.scrollTop = top;
      flash();
    }
    ed.hidden = false;
    $('#v-msg').hidden = true;
  });
}

let flashTimer = 0;
function flash() {
  const el = $('#v-live');
  el.classList.add('pulse');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove('pulse'), 1200);
}
