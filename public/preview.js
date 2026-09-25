// Root-only /preview page. Everything from the server is rendered with textContent, never innerHTML.
(() => {
  const el = id => document.getElementById(id);

  function line(text, className = '') {
    const p = document.createElement('p');
    p.textContent = text;
    if (className) p.className = className;
    return p;
  }
  function show(id, ...nodes) { el(id).replaceChildren(...nodes); }
  const say = (id, text, isError = false) => show(id, line(text, isError ? 'text-ric-red' : ''));

  async function call(url, method = 'POST') {
    const response = await fetch(url, { method });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `ผิดพลาด (${response.status})`);
    return data;
  }
  async function busy(buttonId, work) {
    const button = el(buttonId);
    button.disabled = true;
    try { await work(); } finally { button.disabled = false; }
  }

  window.previewTestPush = () => busy('btn-test-push', async () => {
    say('out-test-push', 'กำลังส่ง...');
    try {
      const r = await call('/api/preview/test-push');
      if (!r.devices) return say('out-test-push', 'ยังไม่มีอุปกรณ์ที่สมัครไว้ — เปิดแจ้งเตือนที่เมนูซ้ายของหน้าหลักก่อน', true);
      const extra = (r.failed ? ` · ล้มเหลว ${r.failed}` : '') + (r.pruned ? ` · ลบอุปกรณ์ที่หมดอายุ ${r.pruned}` : '');
      say('out-test-push', `ส่งสำเร็จ ${r.sent} จาก ${r.devices} อุปกรณ์${extra}`, r.sent === 0);
    } catch (error) { say('out-test-push', error.message, true); }
  });

  const PERMISSION = { granted: 'อนุญาตแล้ว', denied: 'ถูกปิดกั้นในเบราว์เซอร์', default: 'ยังไม่ได้ตัดสินใจ' };

  window.previewSubscriptions = () => busy('btn-subs', async () => {
    say('out-subs', 'กำลังตรวจสอบ...');
    try {
      const devices = await call('/api/preview/subscriptions', 'GET');
      const nodes = [];
      nodes.push(line(devices.length ? `อุปกรณ์ที่สมัครไว้ ${devices.length} เครื่อง` : 'ยังไม่มีอุปกรณ์ที่สมัครไว้'));
      for (const d of devices) nodes.push(line(`• ${d.host} · สมัครเมื่อ ${new Date(d.created_at).toLocaleString('th-TH')}`, 'text-xs text-ric-gray'));
      const permission = 'Notification' in window ? PERMISSION[Notification.permission] || Notification.permission : 'เบราว์เซอร์นี้ไม่รองรับ';
      nodes.push(line(`เบราว์เซอร์เครื่องนี้: สิทธิ์แจ้งเตือน ${permission}`, 'text-xs'));
      const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
      nodes.push(line(`Service worker: ${registration ? 'พร้อมใช้งาน' : 'ยังไม่ลงทะเบียน'}`, 'text-xs'));
      show('out-subs', ...nodes);
    } catch (error) { say('out-subs', error.message, true); }
  });

  window.previewDryRun = () => busy('btn-dry-run', async () => {
    say('out-dry-run', 'กำลังคำนวณ...');
    try {
      const r = await call('/api/preview/dry-run');
      const nodes = [line(`เวลาไทยตอนนี้ ${r.now} · ${r.candidates.length ? `จะส่ง ${r.candidates.length} รายการ` : 'ไม่มีรายการที่ต้องส่ง'}`, 'text-xs text-ric-gray')];
      for (const c of r.candidates) {
        const card = document.createElement('div');
        card.className = 'rounded-lg border border-gray-100 p-3 space-y-0.5';
        card.append(line(c.title, 'font-medium'), line(c.body, 'text-xs text-ric-gray'),
          line(c.alreadySent ? 'ส่งแล้ว (จะไม่ส่งซ้ำ)' : 'ยังไม่ได้ส่ง', c.alreadySent ? 'text-xs text-ric-gray' : 'text-xs text-amber-600'));
        nodes.push(card);
      }
      show('out-dry-run', ...nodes);
    } catch (error) { say('out-dry-run', error.message, true); }
  });
})();
