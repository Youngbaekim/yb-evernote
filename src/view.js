// 웹에 게시한 노트 열람 화면 (로그인 없음 · 읽기 전용 · 실시간 반영)
import './style.css';
import './theme.js';
import { useReadOnlyBase, watchPublic } from './store.js';
import { createEditor, hydrateJSON } from './editor.js';
import { downloadUrl, hostLabel, stripTags } from './share-utils.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sid = new URLSearchParams(location.search).get('s') || '';

function message(title, sub = '') {
  $('#editor').hidden = true;
  $('#v-files').hidden = true;
  $('#v-live').hidden = true;
  $('#v-msg').hidden = false;
  $('#v-msg').innerHTML = `<p class="ph-title">${esc(title)}</p>${sub ? `<p>${esc(sub)}</p>` : ''}`;
}

if (!/^[a-z0-9]{12,32}$/.test(sid)) {
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
