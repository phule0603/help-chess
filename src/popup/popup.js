// Chess Helper - Popup Script

document.addEventListener('DOMContentLoaded', async () => {
  const enabledCheckbox = document.getElementById('enabled');
  const depthSlider = document.getElementById('depth');
  const depthValue = document.getElementById('depth-value');
  const autoAnalyzeCheckbox = document.getElementById('auto-analyze');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');

  // Load saved settings
  const settings = await chrome.storage.local.get(['enabled', 'depth', 'autoAnalyze']);
  enabledCheckbox.checked = settings.enabled !== false;
  depthSlider.value = settings.depth || 18;
  depthValue.textContent = settings.depth || 18;
  autoAnalyzeCheckbox.checked = settings.autoAnalyze !== false;

  // Check status
  checkStatus();

  // Event listeners
  enabledCheckbox.addEventListener('change', async () => {
    const enabled = enabledCheckbox.checked;
    await chrome.storage.local.set({ enabled });

    // Notify content script
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url?.includes('chess.com')) {
      chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE', enabled });
    }
  });

  depthSlider.addEventListener('input', () => {
    depthValue.textContent = depthSlider.value;
  });

  depthSlider.addEventListener('change', async () => {
    const depth = parseInt(depthSlider.value);
    await chrome.storage.local.set({ depth });

    // Notify content script
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url?.includes('chess.com')) {
      chrome.tabs.sendMessage(tab.id, { type: 'SET_DEPTH', depth });
    }
  });

  // Brilliant mode: lưu vào storage, content script tự đồng bộ qua storage.onChanged
  const brilliantCheckbox = document.getElementById('brilliant');
  const { brilliantMode } = await chrome.storage.local.get(['brilliantMode']);
  brilliantCheckbox.checked = !!brilliantMode;
  brilliantCheckbox.addEventListener('change', () => {
    chrome.storage.local.set({ brilliantMode: brilliantCheckbox.checked });
  });

  autoAnalyzeCheckbox.addEventListener('change', async () => {
    const autoAnalyze = autoAnalyzeCheckbox.checked;
    await chrome.storage.local.set({ autoAnalyze });
  });

  // Check if on chess.com
  async function checkStatus() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (tab && tab.url?.includes('chess.com')) {
      statusDot.classList.add('active');
      statusText.textContent = 'Connected to chess.com';

      // Check Stockfish status
      chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
        if (response && response.ready) {
          statusText.textContent = 'Engine ready';
        } else {
          statusText.textContent = 'Loading engine...';
        }
      });
    } else {
      statusDot.classList.remove('active');
      statusText.textContent = 'Not on chess.com';
    }
  }
});
