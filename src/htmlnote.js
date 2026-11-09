// HTML 노트 보기·편집 (v0.9.0)
// - 원본 HTML을 분리된 화면(iframe)에 그대로 표시: 스크립트는 실행되지 않음(sandbox에 allow-scripts 없음)
// - [편집]을 켜면 그 자리에서 글자 수정 (브라우저 편집 기능 designMode), 붙여넣기는 글자만
// - 높이는 문서 길이에 맞춰 늘려 바깥 화면 하나로만 스크롤

export function createHtmlView(host, { onChange = () => {}, readOnly = false } = {}) {
  const frame = document.createElement('iframe');
  frame.className = 'html-frame';
  frame.title = 'HTML 노트';
  // allow-same-origin: 편집·높이 맞춤을 위해 앱이 문서에 접근 (스크립트가 없으므로 안전)
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals allow-popups allow-popups-to-escape-sandbox');
  frame.hidden = true;
  host.appendChild(frame);

  let editing = false;
  let dirty = false;
  let ro = null;
  let loadedHtml = null;
  let onLoaded = null;

  const doc = () => frame.contentDocument;

  function fit() {
    const d = doc();
    if (!d?.documentElement) return;
    const h = Math.max(d.documentElement.scrollHeight, d.body?.scrollHeight || 0);
    frame.style.height = `${h}px`;
  }

  function wire() {
    const d = doc();
    if (!d) return;
    ro?.disconnect();
    ro = new ResizeObserver(fit);
    ro.observe(d.documentElement);
    if (d.body) ro.observe(d.body);
    d.querySelectorAll('img').forEach((img) => img.addEventListener('load', fit));
    fit();
    // 링크: 보기 상태에서는 새 창으로, 편집 중에는 열지 않음
    d.addEventListener('click', (e) => {
      const a = e.target.closest?.('a[href]');
      if (!a) return;
      e.preventDefault();
      if (editing) return;
      const href = a.getAttribute('href');
      if (href.startsWith('#')) { d.getElementById(href.slice(1))?.scrollIntoView(); return; }
      window.open(a.href, '_blank', 'noopener');
    });
    d.addEventListener('input', () => { dirty = true; fit(); onChange(); });
    // 붙여넣기는 글자만 (다른 곳의 서식이 섞여 문서 모양이 깨지지 않도록)
    d.addEventListener('paste', (e) => {
      if (!editing) return;
      e.preventDefault();
      const text = e.clipboardData?.getData('text/plain') || '';
      d.execCommand('insertText', false, text);
    });
    d.addEventListener('drop', (e) => { if (editing) e.preventDefault(); });
    // 표 칸·목록 안의 Enter는 줄바꿈만 (칸이나 구조가 새로 생기지 않도록)
    d.addEventListener('keydown', (e) => {
      if (!editing) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        const sel = d.getSelection();
        const node = sel?.anchorNode?.nodeType === 1 ? sel.anchorNode : sel?.anchorNode?.parentElement;
        if (node?.closest?.('td, th, caption, h1, h2, h3, h4, h5, h6, li, dt, dd')) {
          e.preventDefault();
          d.execCommand('insertLineBreak');
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') e.preventDefault();
    });
    d.designMode = editing ? 'on' : 'off';
    onLoaded?.();
  }
  frame.addEventListener('load', wire);

  return {
    frame,
    /** 문서 표시 (같은 내용이면 다시 그리지 않음) */
    show(html, { force = false } = {}) {
      frame.hidden = false;
      if (!force && html === loadedHtml) return Promise.resolve();
      loadedHtml = html;
      dirty = false;
      return new Promise((res) => {
        onLoaded = () => { onLoaded = null; res(); };
        frame.srcdoc = html || '<!DOCTYPE html><html><body></body></html>';
      });
    },
    hide() {
      frame.hidden = true;
      this.setEditing(false);
    },
    get visible() { return !frame.hidden; },
    isEditing: () => editing,
    isDirty: () => dirty,
    setEditing(on) {
      editing = !!on && !readOnly;
      const d = doc();
      if (d) d.designMode = editing ? 'on' : 'off';
      frame.classList.toggle('editing', editing);
      if (editing) frame.contentWindow?.focus();
    },
    /** 저장용 HTML */
    serialize() {
      const d = doc();
      if (!d?.documentElement) return loadedHtml || '';
      const html = '<!DOCTYPE html>\n' + d.documentElement.outerHTML;
      loadedHtml = html; // 저장한 내용과 같으면 다시 그리지 않음
      dirty = false;
      return html;
    },
    exec(cmd, value = null) {
      const d = doc();
      if (!d || !editing) return;
      if (cmd === 'hiliteColor') d.execCommand('styleWithCSS', false, true);
      d.execCommand(cmd, false, value);
      dirty = true;
      onChange();
    },
    print() { frame.contentWindow?.focus(); frame.contentWindow?.print(); },
  };
}
