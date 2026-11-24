// Chess Helper - Background Service Worker
// Quản lý offscreen document (Stockfish) và chuyển tiếp message giữa tab <-> offscreen.
// Không giữ state quan trọng ở đây vì MV3 service worker có thể bị tắt bất cứ lúc nào.

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
let creating = null;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
  });
  return contexts.length > 0;
}

// Tái sử dụng offscreen đang có (trước đây mỗi lần SW khởi động lại đều đóng/tạo lại -> mất engine)
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['WORKERS'],
      justification: 'Running Stockfish chess engine in a Web Worker'
    }).finally(() => { creating = null; });
  }
  await creating;
}

// Offscreen vừa tạo có thể chưa đăng ký listener -> thử lại vài lần
async function sendToOffscreen(msg) {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await chrome.runtime.sendMessage(Object.assign({}, msg, { target: 'offscreen' }));
      if (res && res.ok) return;
    } catch (e) { /* receiving end chưa sẵn sàng */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Offscreen document not responding');
}

chrome.runtime.onInstalled.addListener(() => { ensureOffscreen().catch(console.error); });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'offscreen') return;

  // Từ content script
  if (sender.tab) {
    const tabId = sender.tab.id;
    if (['SF_INIT', 'SF_ANALYZE', 'SF_STOP'].includes(message.type)) {
      ensureOffscreen()
        .then(() => sendToOffscreen(Object.assign({}, message, { tabId })))
        .catch((err) => {
          chrome.tabs.sendMessage(tabId, { type: 'SF_ERROR', error: String(err.message || err) }).catch(() => {});
        });
    }
    return;
  }

  // Từ offscreen -> chuyển đúng tab đã yêu cầu
  if (message.source === 'offscreen') {
    if (message.tabId != null) chrome.tabs.sendMessage(message.tabId, message).catch(() => {});
    return;
  }

  // Từ popup
  if (message.type === 'GET_STATUS') {
    hasOffscreen().then((ready) => sendResponse({ ready }));
    return true;
  }
  if (message.type === 'TOGGLE' || message.type === 'SET_DEPTH') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].id) chrome.tabs.sendMessage(tabs[0].id, message).catch(() => {});
    });
  }
});
