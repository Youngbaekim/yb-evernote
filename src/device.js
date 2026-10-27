// 기기 ID: 이 기기에서 만든 기록(획 묶음 등)을 구분하는 데 사용
export const DEVICE_ID = (() => {
  try {
    let id = localStorage.getItem('yb-device-id');
    if (!id) {
      id = Math.random().toString(36).slice(2, 10);
      localStorage.setItem('yb-device-id', id);
    }
    return id;
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
})();
