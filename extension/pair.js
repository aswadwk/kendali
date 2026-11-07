const id = new URLSearchParams(location.search).get('id');
const $ = (x) => document.getElementById(x);

chrome.runtime.sendMessage({ type: 'status' }).then((s) => { $('name').value = s.name || ''; });

$('ok').onclick = async () => {
  $('ok').disabled = true;
  const r = await chrome.runtime.sendMessage({ type: 'pairAccept', id, name: $('name').value });
  if (!r?.ok) { $('ok').disabled = false; $('ok').textContent = 'Not connected — retry'; return; }
  window.close();
};
$('no').onclick = () => window.close();
