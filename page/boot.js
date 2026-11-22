(async () => {
  const appearance = await window.magpie?.ready;
  const query = new URLSearchParams();
  if (appearance?.lang) query.set('lang', appearance.lang);
  if (typeof appearance?.dark === 'boolean') query.set('theme', appearance.dark ? 'dark' : 'light');
  const english = appearance?.lang && !appearance.lang.toLowerCase().startsWith('zh');
  const status = document.getElementById('status');
  const retry = document.getElementById('retry');
  if (english) status.textContent = 'Starting the local CLI service…';
  if (english) retry.textContent = 'Retry';

  // Desktop and a local magpie web browser can reach the host on this machine.
  if (location.hostname && !['localhost', 'wails.localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
    status.textContent = english ? 'Open Magpie on this computer to use local CLIs.' : '请在运行 Magpie 的这台电脑上打开页面。';
    return;
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    const session = await new Promise((resolve) => {
      delete globalThis.localCliBootstrap;
      const script = document.createElement('script');
      script.src = `.runtime/session.js?v=${Date.now()}`;
      script.onload = script.onerror = () => {
        script.remove();
        resolve(globalThis.localCliBootstrap);
      };
      document.head.append(script);
    });
    if (Number.isInteger(session?.port) && session.port > 0 && session.port < 65536 && /^[a-f0-9]{64}$/.test(session?.key)) {
      // Unlike the navigation key, the WebSocket capability never appears in a served asset.
      query.set('k', session.key);
      location.replace(`http://127.0.0.1:${session.port}/open?${query}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  status.textContent = english ? 'Plugin host is unavailable. Reload the plugin in Magpie if retrying fails.' : '插件服务暂未启动。如果重试失败，请在 Magpie 中重新加载插件。';
  retry.hidden = false;
  retry.onclick = () => location.reload();
})();
