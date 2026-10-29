document.addEventListener('DOMContentLoaded', () => {
  const inputText = document.getElementById('inputText');
  const listenBtn = document.getElementById('listenBtn');
  const selectionToggle = document.getElementById('selectionToggle');
  const floatingToggle = document.getElementById('floatingToggle');
  const shortcutsToggle = document.getElementById('shortcutsToggle');

  const providerRadios = document.querySelectorAll('input[name="provider"]');
  const ttsProviderRadios = document.querySelectorAll('input[name="ttsProvider"]');

  const baiduSettings = document.getElementById('baiduSettings');
  const baiduAppId = document.getElementById('baiduAppId');
  const baiduSecret = document.getElementById('baiduSecret');
  const saveBaiduKeysBtn = document.getElementById('saveBaiduKeys');
  const baiduKeyInputs = document.getElementById('baiduKeyInputs');

  const localModelSettings = document.getElementById('localModelSettings');
  const localModelName = document.getElementById('localModelName');
  const localModelPort = document.getElementById('localModelPort');
  const saveLocalModelBtn = document.getElementById('saveLocalModel');
  const localModelInputs = document.getElementById('localModelInputs');

  const hyMt2Settings = document.getElementById('hyMt2Settings');
  const hyMt2Port = document.getElementById('hyMt2Port');
  const hyMt2TimeoutSeconds = document.getElementById('hyMt2TimeoutSeconds');
  const saveHyMt2Btn = document.getElementById('saveHyMt2');
  const hyMt2Inputs = document.getElementById('hyMt2Inputs');

  const localTtsSettings = document.getElementById('localTtsSettings');
  const localTtsUrl = document.getElementById('localTtsUrl');
  const localTtsVoiceRadios = document.querySelectorAll('input[name="localTtsVoice"]');
  const saveLocalTtsBtn = document.getElementById('saveLocalTts');
  const localTtsInputs = document.getElementById('localTtsInputs');

  const translateBtn = document.getElementById('translateBtn');
  const outputText = document.getElementById('outputText');

  const DEFAULT_LOCAL_MODEL = 'mlx-community/gemma-4-31b-it-mxfp4';
  const DEFAULT_LOCAL_PORT = '8099';
  const DEFAULT_HY_MT2_PORT = 8096;
  const DEFAULT_HY_MT2_TIMEOUT_SECONDS = 32;
  const DEFAULT_LOCAL_TTS_URL = 'http://127.0.0.1:8098/v1/audio/speech';
  const DEFAULT_LOCAL_TTS_VOICE = 'af_heart';

  function setRadio(radios, value) {
    radios.forEach(r => { r.checked = r.value === value; });
  }

  function getRadio(radios) {
    for (const r of radios) if (r.checked) return r.value;
    return null;
  }

  function updateBaiduSettingsVisibility(provider, ttsProvider) {
    if (provider === 'baidu' || ttsProvider === 'baidu') {
      baiduSettings.classList.remove('hidden');
    } else {
      baiduSettings.classList.add('hidden');
    }
  }

  function updateLocalModelSettingsVisibility(provider) {
    if (provider === 'local') {
      localModelSettings.classList.remove('hidden');
    } else {
      localModelSettings.classList.add('hidden');
    }
  }

  function updateLocalTtsSettingsVisibility(ttsProvider) {
    if (ttsProvider === 'local') {
      localTtsSettings.classList.remove('hidden');
    } else {
      localTtsSettings.classList.add('hidden');
    }
  }

  function updateHyMt2SettingsVisibility(provider) {
    hyMt2Settings.classList.toggle('hidden', provider !== 'hy_mt2');
  }

  // Load states
  chrome.storage.local.get(
    [
      'selectionMode', 'floatingMode', 'shortcutsEnabled',
      'provider', 'ttsProvider', 'useBaidu',
      'baiduAppId', 'baiduSecret',
      'localModelName', 'localModelPort',
      'hyMt2Port', 'hyMt2TimeoutSeconds',
      'localTtsUrl', 'localTtsVoice',
      'lastInput', 'lastOutput'
    ],
    async (result) => {
      selectionToggle.checked = result.selectionMode || false;
      floatingToggle.checked = result.floatingMode || false;
      shortcutsToggle.checked = result.shortcutsEnabled || false;

      // Migrate from legacy useBaidu if provider/ttsProvider not yet set
      const provider = result.provider
        || (result.useBaidu ? 'baidu' : 'google');
      const ttsProvider = result.ttsProvider
        || (result.useBaidu ? 'baidu' : 'google');
      setRadio(providerRadios, provider);
      setRadio(ttsProviderRadios, ttsProvider);

      if (result.lastInput) inputText.value = result.lastInput;
      if (result.lastOutput) outputText.textContent = result.lastOutput;

      // Baidu settings UI
      if (result.baiduAppId) baiduAppId.value = result.baiduAppId;
      if (result.baiduSecret) baiduSecret.value = result.baiduSecret;
      if (result.baiduAppId && result.baiduSecret) {
        baiduKeyInputs.classList.add('hidden');
        saveBaiduKeysBtn.textContent = 'Edit Keys';
      } else {
        baiduKeyInputs.classList.remove('hidden');
        saveBaiduKeysBtn.textContent = 'Save Keys';
      }

      // Try to load default Baidu keys if not set
      if (!result.baiduAppId && !result.baiduSecret) {
        try {
          const response = await fetch(chrome.runtime.getURL('key.baidu'));
          if (response.ok) {
            const keys = await response.json();
            if (keys.appid && keys.secret) {
              baiduAppId.value = keys.appid;
              baiduSecret.value = keys.secret;
            }
          }
        } catch (e) {
          console.log('No default Baidu keys found');
        }
      }

      // Local Model settings UI
      localModelName.value = result.localModelName || DEFAULT_LOCAL_MODEL;
      localModelPort.value = result.localModelPort || DEFAULT_LOCAL_PORT;
      if (result.localModelName && result.localModelPort) {
        localModelInputs.classList.add('hidden');
        saveLocalModelBtn.textContent = 'Edit Model Settings';
      } else {
        localModelInputs.classList.remove('hidden');
        saveLocalModelBtn.textContent = 'Save Model Settings';
      }

      const savedPort = Number(result.hyMt2Port);
      const savedTimeout = Number(result.hyMt2TimeoutSeconds);
      const validPort = Number.isInteger(savedPort) && savedPort >= 1 && savedPort <= 65535;
      const validTimeout = Number.isInteger(savedTimeout) && savedTimeout >= 1 && savedTimeout <= 120;
      hyMt2Port.value = validPort ? savedPort : DEFAULT_HY_MT2_PORT;
      hyMt2TimeoutSeconds.value = validTimeout ? savedTimeout : DEFAULT_HY_MT2_TIMEOUT_SECONDS;
      hyMt2Inputs.classList.toggle('hidden', validPort && validTimeout);
      saveHyMt2Btn.textContent = validPort && validTimeout ? 'Edit Hy-MT2 Settings' : 'Save Hy-MT2 Settings';

      // Local TTS settings UI
      localTtsUrl.value = result.localTtsUrl || DEFAULT_LOCAL_TTS_URL;
      const ttsVoice = result.localTtsVoice || DEFAULT_LOCAL_TTS_VOICE;
      setRadio(localTtsVoiceRadios, ttsVoice);
      if (result.localTtsUrl && result.localTtsVoice) {
        localTtsInputs.classList.add('hidden');
        saveLocalTtsBtn.textContent = 'Edit TTS Settings';
      } else {
        localTtsInputs.classList.remove('hidden');
        saveLocalTtsBtn.textContent = 'Save TTS Settings';
      }

      updateBaiduSettingsVisibility(provider, ttsProvider);
      updateLocalModelSettingsVisibility(provider);
      updateHyMt2SettingsVisibility(provider);
      updateLocalTtsSettingsVisibility(ttsProvider);
    }
  );

  // Save input text on change
  inputText.addEventListener('input', () => {
    chrome.storage.local.set({ lastInput: inputText.value });
  });

  // Toggle selection mode
  selectionToggle.addEventListener('change', () => {
    chrome.storage.local.set({ selectionMode: selectionToggle.checked });
  });

  // Toggle floating mode
  floatingToggle.addEventListener('change', async () => {
    const isChecked = floatingToggle.checked;
    chrome.storage.local.set({ floatingMode: isChecked });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { action: 'TOGGLE_FLOATING', value: isChecked })
        .catch(err => console.log('Could not send message to tab:', err));
    }
  });

  // Toggle shortcuts
  shortcutsToggle.addEventListener('change', async () => {
    const isChecked = shortcutsToggle.checked;
    chrome.storage.local.set({ shortcutsEnabled: isChecked });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { action: 'TOGGLE_SHORTCUTS', value: isChecked })
        .catch(err => console.log('Could not send message to tab:', err));
    }
  });

  // Provider radio change
  providerRadios.forEach(r => {
    r.addEventListener('change', () => {
      const provider = getRadio(providerRadios);
      const ttsProvider = getRadio(ttsProviderRadios);
      chrome.storage.local.set({ provider });
      updateBaiduSettingsVisibility(provider, ttsProvider);
      updateLocalModelSettingsVisibility(provider);
      updateHyMt2SettingsVisibility(provider);
    });
  });

  // TTS provider radio change
  ttsProviderRadios.forEach(r => {
    r.addEventListener('change', () => {
      const provider = getRadio(providerRadios);
      const ttsProvider = getRadio(ttsProviderRadios);
      chrome.storage.local.set({ ttsProvider });
      updateBaiduSettingsVisibility(provider, ttsProvider);
      updateLocalTtsSettingsVisibility(ttsProvider);
    });
  });

  // Save/Edit Baidu Keys
  saveBaiduKeysBtn.addEventListener('click', () => {
    if (saveBaiduKeysBtn.textContent === 'Edit Keys') {
      baiduKeyInputs.classList.remove('hidden');
      saveBaiduKeysBtn.textContent = 'Save Keys';
      return;
    }
    const appid = baiduAppId.value.trim();
    const secret = baiduSecret.value.trim();
    if (!appid || !secret) {
      alert('Please enter both App ID and Secret Key.');
      return;
    }
    chrome.storage.local.set({ baiduAppId: appid, baiduSecret: secret }, () => {
      baiduKeyInputs.classList.add('hidden');
      saveBaiduKeysBtn.textContent = 'Edit Keys';
    });
  });

  // Save/Edit Local Model Settings
  saveLocalModelBtn.addEventListener('click', () => {
    if (saveLocalModelBtn.textContent === 'Edit Model Settings') {
      localModelInputs.classList.remove('hidden');
      saveLocalModelBtn.textContent = 'Save Model Settings';
      return;
    }
    const name = localModelName.value.trim();
    const port = localModelPort.value.trim();
    if (!name || !port) {
      alert('Please enter both Model Name and Port.');
      return;
    }
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      alert('Port must be a number between 1 and 65535.');
      return;
    }
    chrome.storage.local.set({ localModelName: name, localModelPort: port }, () => {
      localModelInputs.classList.add('hidden');
      saveLocalModelBtn.textContent = 'Edit Model Settings';
    });
  });

  saveHyMt2Btn.addEventListener('click', () => {
    if (hyMt2Inputs.classList.contains('hidden')) {
      hyMt2Inputs.classList.remove('hidden');
      saveHyMt2Btn.textContent = 'Save Hy-MT2 Settings';
      return;
    }
    const port = Number(hyMt2Port.value);
    const timeoutSeconds = Number(hyMt2TimeoutSeconds.value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      alert('Port must be an integer between 1 and 65535.');
      return;
    }
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) {
      alert('Timeout must be an integer between 1 and 120 seconds.');
      return;
    }
    chrome.storage.local.set({ hyMt2Port: port, hyMt2TimeoutSeconds: timeoutSeconds }, () => {
      if (chrome.runtime.lastError) {
        alert('Could not save Hy-MT2 settings.');
        return;
      }
      hyMt2Inputs.classList.add('hidden');
      saveHyMt2Btn.textContent = 'Edit Hy-MT2 Settings';
    });
  });

  // Save/Edit Local TTS Settings
  saveLocalTtsBtn.addEventListener('click', () => {
    if (saveLocalTtsBtn.textContent === 'Edit TTS Settings') {
      localTtsInputs.classList.remove('hidden');
      saveLocalTtsBtn.textContent = 'Save TTS Settings';
      return;
    }
    const url = localTtsUrl.value.trim();
    const voice = getRadio(localTtsVoiceRadios);
    if (!url) {
      alert('Please enter the Endpoint URL.');
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      alert('Endpoint URL must start with http:// or https://');
      return;
    }
    if (!voice) {
      alert('Please select a Voice.');
      return;
    }
    chrome.storage.local.set({ localTtsUrl: url, localTtsVoice: voice }, () => {
      localTtsInputs.classList.add('hidden');
      saveLocalTtsBtn.textContent = 'Edit TTS Settings';
    });
  });

  translateBtn.addEventListener('click', () => {
    const text = inputText.value.trim();
    if (!text) {
      outputText.textContent = '';
      chrome.storage.local.set({ lastOutput: '' });
      return;
    }

    outputText.textContent = 'Translating...';

    try {
      chrome.runtime.sendMessage({
        action: 'TRANSLATE_TEXT', text, provider: getRadio(providerRadios) || 'google'
      }, (response) => {
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
              'ERROR:LOCAL_CONNREFUSED': 'Local Model Server Unreachable (Start mlx_vlm.server)',
              'ERROR:HY_MT2_CONNREFUSED': 'Hy-MT2 Server Unreachable (Check Service and Port)',
              'ERROR:GOOGLE_BLOCKED': 'Google Blocked by Anti-Bot (Try Baidu/Local)',
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
