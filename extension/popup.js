const $ = (id) => document.getElementById(id);

async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: 'status' });
  $('st').classList.toggle('on', s.connected);
  $('txt').textContent = s.connected ? `Connected (port ${s.port})`
    : s.busy ? 'Another browser/profile is connected to the server'
    : `Waiting for MCP server on ${s.port}…`;
  if (document.activeElement !== $('port')) $('port').value = s.port;
}

$('save').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'setPort', port: +$('port').value });
  setTimeout(refresh, 800);
};

refresh();
setInterval(refresh, 1000);
