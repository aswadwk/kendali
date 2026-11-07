const $ = (id) => document.getElementById(id);

async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: 'status' });
  $('st').classList.toggle('on', s.connected);
  $('txt').textContent = s.connected ? `Connected (port ${s.port})` : `Waiting for MCP server on ${s.port}…`;
  if (document.activeElement !== $('port')) $('port').value = s.port;
  if (document.activeElement !== $('name')) $('name').value = s.name || '';
  $('dev').textContent = `deviceId ${s.deviceId}`;
}

$('save').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'setPort', port: +$('port').value });
  setTimeout(refresh, 800);
};
$('saveName').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'setName', name: $('name').value });
  $('name').blur();
  refresh();
};

refresh();
setInterval(refresh, 1000);
