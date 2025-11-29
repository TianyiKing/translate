document.addEventListener('DOMContentLoaded', () => {
  const inputText = document.getElementById('inputText');
  const listenBtn = document.getElementById('listenBtn');
  const selectionToggle = document.getElementById('selectionToggle');
  const floatingToggle = document.getElementById('floatingToggle');
  const shortcutsToggle = document.getElementById('shortcutsToggle');

  const baiduToggle = document.getElementById('baiduToggle');
  const baiduSettings = document.getElementById('baiduSettings');
  const baiduAppId = document.getElementById('baiduAppId');
  const baiduSecret = document.getElementById('baiduSecret');
  const saveBaiduKeysBtn = document.getElementById('saveBaiduKeys');

  const baiduKeyInputs = document.getElementById('baiduKeyInputs');

  // Assuming translateBtn and outputText are defined elsewhere in the full document
  const translateBtn = document.getElementById('translateBtn');
  const outputText = document.getElementById('outputText');

  // Load states
  chrome.storage.local.get(['selectionMode', 'floatingMode', 'shortcutsEnabled', 'useBaidu', 'baiduAppId', 'baiduSecret', 'lastInput', 'lastOutput'], async (result) => {
    selectionToggle.checked = result.selectionMode || false;
    floatingToggle.checked = result.floatingMode || false;
    shortcutsToggle.checked = result.shortcutsEnabled || false;
    baiduToggle.checked = result.useBaidu || false;

    if (result.lastInput) inputText.value = result.lastInput;
    if (result.lastOutput) outputText.textContent = result.lastOutput;

    if (result.useBaidu) {
      baiduSettings.classList.remove('hidden');
    }

    if (result.baiduAppId) baiduAppId.value = result.baiduAppId;
    if (result.baiduSecret) baiduSecret.value = result.baiduSecret;

    // Determine initial state of keys UI
    if (result.baiduAppId && result.baiduSecret) {
      // Keys exist, show "Edit" mode (inputs hidden)
      baiduKeyInputs.classList.add('hidden');
      saveBaiduKeysBtn.textContent = 'Edit Keys';
    } else {
      // Keys missing, show "Save" mode (inputs visible)
      baiduKeyInputs.classList.remove('hidden');
      saveBaiduKeysBtn.textContent = 'Save Keys';
    }

    // Try to load default keys if not set
    if (!result.baiduAppId && !result.baiduSecret) {
      try {
        const response = await fetch(chrome.runtime.getURL('key.baidu'));
        if (response.ok) {
          const keys = await response.json();
          if (keys.appid && keys.secret) {
            baiduAppId.value = keys.appid;
            baiduSecret.value = keys.secret;
            // If we loaded defaults, we are in "Save" mode, user can click save
          }
        }
      } catch (e) {
        console.log('No default keys found');
      }
    }
  });

  // Save input text on change
  inputText.addEventListener('input', () => {
    chrome.storage.local.set({ lastInput: inputText.value });
  });

  // Toggle selection mode
  selectionToggle.addEventListener('change', () => {
    const isChecked = selectionToggle.checked;
    chrome.storage.local.set({ selectionMode: isChecked });
  });

  // Toggle floating mode
  floatingToggle.addEventListener('change', async () => {
    const isChecked = floatingToggle.checked;
    chrome.storage.local.set({ floatingMode: isChecked });

    // Notify active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { action: 'TOGGLE_FLOATING', value: isChecked })
        .catch(err => {
          console.log('Could not send message to tab:', err);
        });
    }
  });

  // Toggle shortcuts
  shortcutsToggle.addEventListener('change', async () => {
    const isChecked = shortcutsToggle.checked;
    chrome.storage.local.set({ shortcutsEnabled: isChecked });

    // Notify active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { action: 'TOGGLE_SHORTCUTS', value: isChecked })
        .catch(err => {
          console.log('Could not send message to tab:', err);
        });
    }
  });

  // Toggle Baidu mode
  baiduToggle.addEventListener('change', () => {
    const isChecked = baiduToggle.checked;
    chrome.storage.local.set({ useBaidu: isChecked });
    if (isChecked) {
      baiduSettings.classList.remove('hidden');
    } else {
      baiduSettings.classList.add('hidden');
    }
  });

  // Save/Edit Baidu Keys
  saveBaiduKeysBtn.addEventListener('click', () => {
    if (saveBaiduKeysBtn.textContent === 'Edit Keys') {
      // Switch to Edit Mode
      baiduKeyInputs.classList.remove('hidden');
      saveBaiduKeysBtn.textContent = 'Save Keys';
    } else {
      // Save Keys
      const appid = baiduAppId.value.trim();
      const secret = baiduSecret.value.trim();

      if (!appid || !secret) {
        alert('Please enter both App ID and Secret Key.');
        return;
      }

      chrome.storage.local.set({ baiduAppId: appid, baiduSecret: secret }, () => {
        // Switch to View Mode
        baiduKeyInputs.classList.add('hidden');
        saveBaiduKeysBtn.textContent = 'Edit Keys';
      });
    }
  });

  translateBtn.addEventListener('click', async () => {
    const text = inputText.value.trim();
    if (!text) {
      outputText.textContent = '';
      chrome.storage.local.set({ lastOutput: '' });
      return;
    }

    outputText.textContent = 'Translating...';
    // Don't save "Translating..." state, wait for result

    try {
      // Delegate to background script
      chrome.runtime.sendMessage({ action: 'TRANSLATE_TEXT', text }, (response) => {
        if (chrome.runtime.lastError) {
          const msg = 'Error: ' + chrome.runtime.lastError.message;
          outputText.textContent = msg;
          chrome.storage.local.set({ lastOutput: msg });
          return;
        }
        if (response && response.translation) {
          if (response.translation.startsWith('ERROR:')) {
            const errorMap = {
              'ERROR:BAIDU_54003': 'Baidu Error: Access Frequency Too High',
              'ERROR:BAIDU_54004': 'Baidu Error: Insufficient Balance (Check Quota/Bill)',
              'ERROR:BAIDU_54005': 'Baidu Error: Long Query Frequency Too High',
              'ERROR:BAIDU_52003': 'Baidu Error: Unauthorized User (Check App ID)',
              'ERROR:BAIDU_58002': 'Baidu Error: Service Timeout',
              'ERROR:TIMEOUT': 'Translation Timed Out',
              'ERROR:FAILED': 'Translation Failed'
            };
            const errorMsg = errorMap[response.translation] || 'Translation failed: ' + response.translation;
            outputText.textContent = errorMsg;
            chrome.storage.local.set({ lastOutput: errorMsg });
          } else {
            outputText.textContent = response.translation;
            chrome.storage.local.set({ lastOutput: response.translation });
          }
        } else {
          const msg = 'Translation failed.';
          outputText.textContent = msg;
          chrome.storage.local.set({ lastOutput: msg });
        }
      });
    } catch (error) {
      console.error('Translation Error:', error);
      const msg = 'Error: ' + error.message;
      outputText.textContent = msg;
      chrome.storage.local.set({ lastOutput: msg });
    }
  });

  listenBtn.addEventListener('click', () => {
    const text = inputText.value.trim();
    if (!text) return;

    chrome.runtime.sendMessage({ action: 'SPEAK_TEXT', text }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('TTS Error:', chrome.runtime.lastError);
        alert('TTS Error: ' + chrome.runtime.lastError.message);
        return;
      }
      if (!response || !response.success) {
        const errorMsg = response?.error || 'Unknown error';
        console.error('TTS playback failed:', errorMsg);
        alert('Audio playback failed: ' + errorMsg);
      }
    });
  });
});
