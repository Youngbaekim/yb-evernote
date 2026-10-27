// 끌어서 순서 바꾸기 — 마우스는 바로, 손가락·펜은 길게 눌러(0.35초) 시작
// onDrop(sourceEl, targetEl, place) — place: 'before' | 'after' | 'inside'

const LONG_PRESS = 350;
const MOVE_TOL = 8;

/**
 * @param {object} o
 * @param {HTMLElement} o.root         끌기를 시작할 수 있는 영역
 * @param {string} o.item              끌 수 있는 항목 선택자
 * @param {(el: Element) => boolean} [o.enabled]
 * @param {(src: Element, target: Element) => ('before'|'after'|'inside'|null)[]} o.places  대상별 허용 위치
 * @param {string} o.targets           놓을 수 있는 대상 선택자 (다른 영역 포함 가능)
 * @param {(src: Element, target: Element, place: string) => void} o.onDrop
 */
export function makeSortable(o) {
  let press = null; // { el, x, y, id, timer, type }
  let drag = null; // { el, ghost, target, place, dx, dy }
  let suppressClick = false;

  const clear = () => {
    document.querySelectorAll('.drop-before, .drop-after, .drop-inside').forEach((x) => x.classList.remove('drop-before', 'drop-after', 'drop-inside'));
  };

  function start(e) {
    const el = press.el;
    const r = el.getBoundingClientRect();
    const ghost = el.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.style.width = `${r.width}px`;
    document.body.appendChild(ghost);
    el.classList.add('dragging');
    document.body.classList.add('is-dragging');
    drag = { el, ghost, dx: press.x - r.left, dy: press.y - r.top, target: null, place: null };
    navigator.vibrate?.(15);
    move(e);
  }

  function move(e) {
    const { ghost } = drag;
    ghost.style.transform = `translate(${e.clientX - drag.dx}px, ${e.clientY - drag.dy}px)`;
    clear();
    drag.target = null;
    drag.place = null;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const t = under?.closest(o.targets);
    if (t && t !== drag.el) {
      const allowed = o.places(drag.el, t);
      const r = t.getBoundingClientRect();
      const ratio = (e.clientY - r.top) / r.height;
      let place = null;
      if (allowed.includes('inside') && (!allowed.includes('before') || (ratio > 0.3 && ratio < 0.7))) place = 'inside';
      else if (allowed.includes('before') && ratio < 0.5) place = 'before';
      else if (allowed.includes('after')) place = 'after';
      if (place) {
        t.classList.add(`drop-${place}`);
        drag.target = t;
        drag.place = place;
      }
    }
    autoScroll(e);
  }

  function autoScroll(e) {
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const box = under?.closest('.note-list, .folder-nav');
    if (!box) return;
    const r = box.getBoundingClientRect();
    if (e.clientY < r.top + 40) box.scrollTop -= 12;
    else if (e.clientY > r.bottom - 40) box.scrollTop += 12;
  }

  function end(commit) {
    if (press?.timer) clearTimeout(press.timer);
    if (drag) {
      const { el, ghost, target, place } = drag;
      ghost.remove();
      el.classList.remove('dragging');
      document.body.classList.remove('is-dragging');
      clear();
      if (commit && target && place) o.onDrop(el, target, place);
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 0);
    }
    press = null;
    drag = null;
  }

  o.root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const el = e.target.closest(o.item);
    if (!el || !o.root.contains(el) || e.target.closest('.f-more, .f-caret, .tag-chip')) return;
    if (o.enabled && !o.enabled(el)) return;
    press = { el, x: e.clientX, y: e.clientY, id: e.pointerId, type: e.pointerType };
    if (e.pointerType !== 'mouse') {
      press.timer = setTimeout(() => press && !drag && start({ clientX: press.x, clientY: press.y }), LONG_PRESS);
    }
  });

  window.addEventListener('pointermove', (e) => {
    if (!press || e.pointerId !== press.id) return;
    if (drag) {
      e.preventDefault();
      return move(e);
    }
    const far = Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOL;
    if (press.type === 'mouse') {
      if (far) start(e);
    } else if (far) {
      end(false); // 길게 누르기 전에 움직이면 일반 스크롤
    }
  }, { passive: false });

  window.addEventListener('pointerup', (e) => { if (press && e.pointerId === press.id) end(true); });
  window.addEventListener('pointercancel', (e) => { if (press && e.pointerId === press.id) end(false); });
  // 끄는 중에는 화면이 스크롤되지 않도록
  window.addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });
  // 끌기 직후의 클릭(노트 열기 등)은 무시
  window.addEventListener('click', (e) => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);
  // 길게 누를 때 뜨는 메뉴 방지
  o.root.addEventListener('contextmenu', (e) => { if (press || drag) e.preventDefault(); });
}
