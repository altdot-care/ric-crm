// Loaded only on the authenticated dashboard. Keep permission requests in the tap handler.
(() => {
  let publicKey = null;
  let registration = null;
  let busy = false;
  let initialized = false;
  const el = id => document.getElementById(id);
  const status = text => { el('notif-status').textContent = text; };

  async function request(endpoint, method = 'GET', body) {
    const response = await fetch(endpoint, {
      method, headers: { 'Content-Type': 'application/json' },
      ...(body && { body: JSON.stringify(body) }),
    });
    if (method === 'DELETE' && response.status === 404) return null;
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error || 'เชื่อมต่อไม่สำเร็จ');
    return data;
  }

  async function ready() {
    let timer;
    try {
      return await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('เตรียมการแจ้งเตือนไม่สำเร็จ กรุณาโหลดหน้าใหม่')), 8000); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  window.initPushNotifications = async key => {
    if (initialized || busy) return;
    busy = true;
    publicKey = key;
    el('notif-toggle-wrap').classList.remove('hidden');
    const checkbox = el('notif-toggle');
    checkbox.disabled = true;
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    try {
      // Check before PushManager: iOS browser tabs do not expose it.
      if (ios && !installed) {
        status('เปิดใน Safari กดแชร์ → เพิ่มไปยังหน้าจอโฮม แล้วเปิดแอปจากไอคอนเพื่อเปิดแจ้งเตือน');
        return;
      }
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        status('เบราว์เซอร์นี้ยังไม่รองรับการแจ้งเตือน');
        return;
      }
      registration = await ready();
      const existing = await registration.pushManager.getSubscription();
      if (existing) {
        const owned = await request(`/api/push-subscriptions?endpoint=${encodeURIComponent(existing.endpoint)}`);
        if (owned) checkbox.checked = true;
        else {
          // Never silently attach a previous user's device subscription to the new account.
          if (!await existing.unsubscribe()) throw new Error('กรุณาปิดการแจ้งเตือนในตั้งค่าเบราว์เซอร์แล้วลองใหม่');
          checkbox.checked = false;
        }
      }
      if (!key && !checkbox.checked) { status('ยังไม่เปิดบริการแจ้งเตือน กรุณาติดต่อผู้ดูแล'); return; }
      checkbox.disabled = false;
      initialized = true;
      status(checkbox.checked ? 'เปิดแจ้งเตือนบนอุปกรณ์นี้แล้ว' : 'แจ้งเตือนงานและใบรับรองบนอุปกรณ์นี้');
    } catch (error) {
      status('ตรวจสอบการแจ้งเตือนไม่สำเร็จ: ' + error.message);
    } finally { busy = false; }
  };

  async function disable() {
    const existing = await registration.pushManager.getSubscription();
    if (!existing) return;
    // Remove on server before revoking locally so a failed request remains retryable.
    await request(`/api/push-subscriptions?endpoint=${encodeURIComponent(existing.endpoint)}`, 'DELETE');
    if (!await existing.unsubscribe()) throw new Error('กรุณาลองปิดการแจ้งเตือนอีกครั้ง');
  }

  window.onNotifToggleChange = async () => {
    if (busy) return;
    const checkbox = el('notif-toggle');
    const enabling = checkbox.checked;
    busy = true;
    checkbox.disabled = true;
    let created = null;
    try {
      if (enabling) {
        // No await before this call: Safari requires a direct user activation.
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') throw new Error('กรุณาอนุญาตการแจ้งเตือนในการตั้งค่าเบราว์เซอร์');
        if (!publicKey) throw new Error('ยังไม่เปิดบริการแจ้งเตือน');
        const base64 = publicKey.replace(/-/g, '+').replace(/_/g, '/');
        const applicationServerKey = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        created = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
        const data = created.toJSON();
        await request('/api/push-subscriptions', 'POST', { endpoint: data.endpoint, p256dh: data.keys.p256dh, auth: data.keys.auth });
        status('เปิดแจ้งเตือนบนอุปกรณ์นี้แล้ว');
      } else {
        await disable();
        status('ปิดแจ้งเตือนบนอุปกรณ์นี้แล้ว');
      }
    } catch (error) {
      if (created) { try { await created.unsubscribe(); } catch { /* Retry on next initialization. */ } }
      checkbox.checked = !enabling;
      status('เปลี่ยนการแจ้งเตือนไม่สำเร็จ: ' + error.message);
    } finally { checkbox.disabled = false; busy = false; }
  };

  window.logoutWithNotifications = async form => {
    if (busy) { status('กรุณารอให้การตั้งค่าแจ้งเตือนเสร็จก่อน'); return; }
    busy = true;
    try {
      if ('serviceWorker' in navigator && 'PushManager' in window) {
        // Logout must also work when registration/activation never succeeded.
        const current = await navigator.serviceWorker.getRegistration();
        const existing = await current?.pushManager.getSubscription();
        if (existing) {
          // Either server removal OR browser revocation is enough to stop delivery.
          // Attempt both independently so an API outage cannot strand the user.
          const [server, browser] = await Promise.allSettled([
            request(`/api/push-subscriptions?endpoint=${encodeURIComponent(existing.endpoint)}`, 'DELETE'),
            existing.unsubscribe(),
          ]);
          if (server.status === 'rejected' && (browser.status === 'rejected' || !browser.value)) {
            throw new Error('ปิดการแจ้งเตือนในตั้งค่าเบราว์เซอร์แล้วลองออกจากระบบอีกครั้ง');
          }
        }
      }
      form.submit();
    } catch (error) {
      status('ออกจากระบบไม่สำเร็จ: ' + error.message);
    } finally { busy = false; }
  };
})();
