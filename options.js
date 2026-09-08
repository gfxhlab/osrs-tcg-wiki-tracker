const albumInput = document.querySelector('#album');
const collectionModeInput = document.querySelector('#collectionMode');
const refreshInput = document.querySelector('#refreshMinutes');
const status = document.querySelector('#status');
document.querySelector('#version').textContent = `Version ${chrome.runtime.getManifest().version}`;

document.querySelector('#save').addEventListener('click', async () => {
  const response = await send({
    type: 'SAVE_SETTINGS',
    settings: {
      album: albumInput.value,
      collectionMode: collectionModeInput.value,
      refreshMinutes: Number(refreshInput.value),
    },
  });
  if (response?.error) {
    showStatus(response.error, true);
    return;
  }
  showStatus('Saved. Refreshing collection…');
  const refreshed = await send({ type: 'REFRESH' });
  showResult(refreshed);
});

document.querySelector('#refresh').addEventListener('click', async () => {
  showStatus('Refreshing collection…');
  showResult(await send({ type: 'REFRESH' }));
});

loadSettings();

async function loadSettings() {
  const response = await send({ type: 'GET_SETTINGS' });
  if (response?.settings) {
    albumInput.value = response.settings.album;
    collectionModeInput.value = response.settings.collectionMode || 'individual';
    refreshInput.value = String(response.settings.refreshMinutes);
  }
}

function showResult(response) {
  if (response?.error) {
    showStatus(response.error, true);
    return;
  }
  const count = response?.album?.stats?.uniqueOwned ?? response?.album?.cardEntries?.length;
  const label = response?.settings?.collectionMode === 'group' ? 'Group collection' : 'Individual collection';
  showStatus(`${label} updated${count == null ? '' : ` · ${Number(count).toLocaleString()} unique cards owned`}.`);
}

function showStatus(message, error = false) {
  status.textContent = message;
  status.style.color = error ? '#b42318' : '';
}

function send(message) {
  return chrome.runtime.sendMessage(message).catch((error) => ({ error: error.message }));
}
