(() => {
  'use strict';

  const query = new URLSearchParams(location.search);
  const language = query.get('lang');
  const chinese = !language || language.toLowerCase().startsWith('zh');
  const theme = query.get('theme');
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
  document.documentElement.lang = chinese ? 'zh-CN' : 'en';

  const token = /^#t=([0-9a-f]{64})$/i.exec(location.hash)?.[1]?.toLowerCase();
  if (location.hash) {
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch {
      // Sandboxed frames may deny history changes.
    }
  }

  const labels = chinese ? {
    appTitle: 'Local CLI', settings: '会话设置', agent: '代理', workspace: '工作区路径',
    workspacePlaceholder: '使用本机主目录', workspaceHelp: '输入绝对路径，或留空使用本机主目录。',
    invalidPath: '请输入绝对路径，例如 C:\\Projects\\app 或 /home/me/app。',
    missingHome: '未收到本机主目录。请输入绝对路径。',
    conversation: '对话', reset: '重置对话', emptyTitle: '开始本地对话',
    emptyHelp: '选择代理和工作区，发送消息以启动本地 CLI。', message: '消息', retry: '重新连接',    promptTooLong: '消息长度不能超过 32,000 个字符。',
    promptPlaceholder: '输入消息…', shortcut: 'Enter 发送 · Shift + Enter 换行', stop: '停止', send: '发送',
    idle: '未连接', connecting: '正在连接…', ready: '已连接', offline: '连接已断开', invalid: '凭据无效',
    invalidToken: '打开此页面需要有效的连接凭据。请从 Magpie 重新打开。',
    disconnected: '连接已断开。发送新消息可重新连接。',
    unknown: '连接后检测', available: '可用', unavailable: '不可用',
    unavailableAgent: (agent) => `${agent} 不可用。`,
    session: (id) => `会话 ${id}`, you: '你', thought: '思考过程', tool: '工具',
    permission: '权限请求', permissionWaiting: '等待选择', permissionSent: '已提交选择',
    permissionResolved: '已处理', permissionEnded: '请求已结束', permissionDisconnected: '连接已断开',
    submitting: '正在发送…', working: '代理正在处理…', stopping: '正在停止…',
    stoppedBeforeSend: '连接已停止，消息尚未发送。', resetting: '正在重置对话…',
    resetComplete: '对话已重置。', error: '操作失败。', turnEnded: (reason) => `回复已结束（${reason}）。`,
    done: {
      completed: '回复完成。', end_turn: '回复完成。', cancelled: '已停止。',
      interrupted: '已停止。', error: '回复失败。', max_tokens: '已达到输出长度上限。',
      max_turn_requests: '已达到本轮请求上限。', refusal: '代理拒绝了此请求。',
    },
    toolStatus: {
      pending: '等待中', in_progress: '执行中', running: '执行中', completed: '已完成',
      success: '成功', failed: '失败', error: '失败', declined: '已拒绝',
      cancelled: '已取消', interrupted: '已中断',
    },
  } : {
    appTitle: 'Local CLI', settings: 'Session settings', agent: 'Agent', workspace: 'Workspace path',
    workspacePlaceholder: 'Use local home directory', workspaceHelp: 'Enter an absolute path or leave blank to use your local home.',
    invalidPath: 'Enter an absolute path such as C:\\Projects\\app or /home/me/app.',
    missingHome: 'The local home directory is unavailable. Enter an absolute path.',
    conversation: 'Conversation', reset: 'Reset chat', emptyTitle: 'Start a local conversation',
    emptyHelp: 'Choose an agent and workspace, then send a message to start the local CLI.', message: 'Message', retry: 'Reconnect',
    promptTooLong: 'A message can contain up to 32,000 characters.',
    promptPlaceholder: 'Write a message…', shortcut: 'Enter to send · Shift + Enter for a new line', stop: 'Stop', send: 'Send',
    idle: 'Disconnected', connecting: 'Connecting…', ready: 'Connected', offline: 'Connection closed', invalid: 'Invalid credential',
    invalidToken: 'This page needs a valid connection credential. Reopen it from Magpie.',
    disconnected: 'Connection closed. Send a new message to reconnect.',
    unknown: 'Checked on connect', available: 'Available', unavailable: 'Unavailable',
    unavailableAgent: (agent) => `${agent} is unavailable.`,
    session: (id) => `Session ${id}`, you: 'You', thought: 'Thoughts', tool: 'Tool',
    permission: 'Permission request', permissionWaiting: 'Awaiting choice', permissionSent: 'Choice submitted',
    permissionResolved: 'Resolved', permissionEnded: 'Request ended', permissionDisconnected: 'Connection closed',
    submitting: 'Sending…', working: 'Agent is working…', stopping: 'Stopping…',
    stoppedBeforeSend: 'Connection stopped before the message was sent.', resetting: 'Resetting conversation…',
    resetComplete: 'Conversation reset.', error: 'The operation failed.', turnEnded: (reason) => `Turn ended (${reason}).`,
    done: {
      completed: 'Reply complete.', end_turn: 'Reply complete.', cancelled: 'Stopped.',
      interrupted: 'Stopped.', error: 'Reply failed.', max_tokens: 'Output limit reached.',
      max_turn_requests: 'Turn request limit reached.', refusal: 'The agent refused this request.',
    },
    toolStatus: {
      pending: 'Pending', in_progress: 'In progress', running: 'Running', completed: 'Completed',
      success: 'Succeeded', failed: 'Failed', error: 'Failed', declined: 'Declined',
      cancelled: 'Cancelled', interrupted: 'Interrupted',
    },
  };

  document.title = labels.appTitle;
  for (const item of document.querySelectorAll('[data-i18n]')) item.textContent = labels[item.dataset.i18n];
  for (const item of document.querySelectorAll('[data-i18n-placeholder]')) {
    item.placeholder = labels[item.dataset.i18nPlaceholder];
  }

  const $ = (id) => document.getElementById(id);
  const agentList = $('agent-list');
  const activeAgentLabel = $('active-agent');
  const workspace = $('workspace');
  const workspaceNote = $('workspace-note');
  const connectionStatus = $('connection-status');
  const connectionLabel = $('connection-label');
  const sessionLabel = $('session-label');
  const transcript = $('transcript');
  const emptyState = $('empty-state');
  const entries = $('entries');
  const notice = $('notice');
  const prompt = $('prompt');
  const retryButton = $('retry-button');
  const sendButton = $('send-button');
  const stopButton = $('stop-button');
  const resetButton = $('reset-button');

  const agentDefaults = new Map([
    ['codex', { label: 'Codex', icon: 'CX' }],
    ['claude', { label: 'Claude', icon: 'CL' }],
    ['gemini', { label: 'Gemini', icon: 'GM' }],
    ['antigravity', { label: 'Antigravity', icon: 'AG' }],
    ['grok', { label: 'Grok', icon: 'GK' }],
  ]);
  const agentViews = new Map();
  const agents = new Map();
  const tools = new Map();
  const permissions = new Map();

  let activeAgent = 'codex';
  let home = '';
  let conversationWorkspace = null;
  let connection = token ? 'idle' : 'invalid';
  let socket = null;
  let turn = 'idle';
  let pendingPrompt = null;
  let resetting = false;
  let turnFailed = false;
  let stream = null;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (typeof text === 'string') node.textContent = text;
    return node;
  }

  function nameOf(agent) {
    return agents.get(agent)?.label || agentDefaults.get(agent).label;
  }

  function createAgentPicker() {
    for (const [id, defaults] of agentDefaults) {
      const row = element('label', 'agent-row');
      const radio = element('input', 'agent-radio');
      radio.type = 'radio';
      radio.name = 'agent';
      radio.value = id;
      radio.checked = id === activeAgent;
      const icon = element('span', 'agent-icon', defaults.icon);
      icon.setAttribute('aria-hidden', 'true');
      const copy = element('span', 'agent-copy');
      const name = element('span', 'agent-name');
      name.id = `agent-name-${id}`;
      const status = element('span', 'agent-status');
      status.id = `agent-status-${id}`;
      radio.setAttribute('aria-labelledby', name.id);
      radio.setAttribute('aria-describedby', status.id);
      copy.append(name, status);
      const dot = element('span', 'agent-dot');
      dot.setAttribute('aria-hidden', 'true');
      row.append(radio, icon, copy, dot);
      agentList.append(row);
      agentViews.set(id, { row, radio, name, status });
      radio.addEventListener('change', () => {
        if (radio.checked) switchAgent(id);
      });
    }
  }

  function renderAgents() {
    for (const [id, view] of agentViews) {
      const info = agents.get(id);
      const availability = info ? (info.available ? 'available' : 'unavailable') : 'unknown';
      view.row.dataset.availability = availability;
      view.name.textContent = nameOf(id);
      view.status.textContent = labels[availability];
      view.row.title = [info?.protocol, info?.hint].filter(Boolean).join(' · ');
    }
    activeAgentLabel.textContent = nameOf(activeAgent);
  }

  function setConnection(state) {
    connection = state;
    connectionStatus.dataset.state = state;
    connectionLabel.textContent = labels[state];
    updateControls();
  }

  function updateControls() {
    const busy = turn !== 'idle' && turn !== 'awaiting-ready';
    retryButton.hidden = connection !== 'offline';
    sendButton.disabled = connection === 'invalid' || turn !== 'idle' || resetting || !prompt.value.trim();
    stopButton.hidden = turn === 'idle';
    stopButton.disabled = turn === 'stopping';
    resetButton.disabled = resetting || busy || !entries.childElementCount;
    for (const { radio } of agentViews.values()) radio.disabled = resetting || busy;
    emptyState.hidden = entries.childElementCount > 0;
  }

  function setNotice(message = '', tone = '') {
    notice.textContent = message;
    notice.dataset.tone = tone;
    notice.hidden = !message;
  }

  function setWorkspaceError(message = '') {
    workspace.setAttribute('aria-invalid', String(Boolean(message)));
    workspaceNote.textContent = message || labels.workspaceHelp;
    workspaceNote.dataset.tone = message ? 'error' : '';
  }

  function setSession(id = '') {
    sessionLabel.hidden = !id;
    sessionLabel.textContent = id ? labels.session(id) : '';
    sessionLabel.title = sessionLabel.textContent;
  }

  function changeTranscript(change, forceScroll = false) {
    const follow = forceScroll || transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 48;
    change();
    updateControls();
    if (follow) transcript.scrollTop = transcript.scrollHeight;
  }

  function addMessage(role, sender, text) {
    stream = null;
    const entry = element('article', `entry entry-${role}`);
    entry.append(element('p', 'entry-label', sender), element('div', 'entry-text', text));
    changeTranscript(() => entries.append(entry), role === 'user');
  }

  function addError(message) {
    stream = null;
    const entry = element('p', 'entry entry-error entry-text', message);
    changeTranscript(() => entries.append(entry));
  }

  function addStream(type, value) {
    if (typeof value !== 'string' || !value) return;
    changeTranscript(() => {
      if (stream?.type === type) {
        stream.text.appendData(value);
        return;
      }
      const body = element('div', 'entry-text');
      const text = document.createTextNode(value);
      body.append(text);
      const entry = type === 'thought' ? element('details', 'entry entry-thought') : element('article', 'entry entry-assistant');
      const heading = type === 'thought' ? element('summary', '', labels.thought) : element('p', 'entry-label', nameOf(activeAgent));
      entry.append(heading, body);
      entries.append(entry);
      stream = { type, text };
    });
  }

  function statusKey(status) {
    return status.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[ -]/g, '_').toLowerCase();
  }

  function addTool(event) {
    if (typeof event.id !== 'string') return;
    changeTranscript(() => {
      let view = tools.get(event.id);
      if (!view) {
        stream = null;
        const row = element('div', 'entry entry-tool');
        view = { title: element('strong', '', labels.tool), status: element('span', 'tool-status') };
        tools.set(event.id, view);
        row.append(view.title, view.status);
        entries.append(row);
      }
      if (typeof event.title === 'string' && event.title) view.title.textContent = event.title;
      if (typeof event.status !== 'string') return;
      const key = statusKey(event.status);
      view.status.textContent = Object.hasOwn(labels.toolStatus, key) ? labels.toolStatus[key] : event.status;
      view.status.dataset.tone = ['failed', 'error', 'declined'].includes(key) ? 'error' :
        ['completed', 'success'].includes(key) ? 'success' : '';
    });
  }

  function permissionButtonClass(kind) {
    if (kind === 'allow_once') return 'button button-approve';
    if (kind === 'reject_once') return 'button button-reject';
    return 'button';
  }

  function addPermission(event) {
    if (typeof event.id !== 'string' || permissions.has(event.id)) return;
    stream = null;
    const row = element('section', 'entry entry-permission');
    const heading = element('div', 'permission-heading');
    const status = element('span', 'permission-state', labels.permissionWaiting);
    status.setAttribute('role', 'status');
    heading.append(element('strong', '', typeof event.title === 'string' && event.title ? event.title : labels.permission), status);
    row.append(heading);
    if (typeof event.detail === 'string' && event.detail) row.append(element('p', 'entry-text', event.detail));
    const actions = element('div', 'permission-options');
    const view = { row, status, buttons: [], state: 'open' };
    const options = Array.isArray(event.options) ? event.options : [];
    for (const option of options) {
      if (!option || typeof option.id !== 'string' || typeof option.label !== 'string') continue;
      const button = element('button', permissionButtonClass(option.kind), option.label);
      button.type = 'button';
      button.addEventListener('click', () => {
        if (view.state !== 'open' || connection !== 'ready' || turn !== 'running') return;
        if (send({ type: 'decision', id: event.id, optionId: option.id })) {
          setPermissionState(view, 'sent', labels.permissionSent);
        }
      });
      view.buttons.push(button);
      actions.append(button);
    }
    if (view.buttons.length) row.append(actions);
    permissions.set(event.id, view);
    changeTranscript(() => entries.append(row));
  }

  function setPermissionState(view, state, message) {
    view.state = state;
    view.row.dataset.state = state;
    view.status.textContent = message;
    for (const button of view.buttons) button.disabled = state !== 'open';
  }

  function finishPermissions(message) {
    for (const view of permissions.values()) {
      if (view.state !== 'closed') setPermissionState(view, 'closed', message);
    }
    permissions.clear();
  }

  function clearConversation() {
    pendingPrompt = null;
    turn = 'idle';
    turnFailed = false;
    stream = null;
    conversationWorkspace = null;
    tools.clear();
    permissions.clear();
    entries.replaceChildren();
    setSession();
    updateControls();
  }

  function dropSocket() {
    const previous = socket;
    socket = null;
    if (previous) previous.close();
  }

  function switchAgent(id) {
    if (id === activeAgent) return;
    activeAgent = id;
    clearConversation();
    renderAgents();
    if (connection === 'ready') requestReset();
    else if (connection === 'connecting') setNotice(labels.connecting);
  }

  function handleDisconnect(code) {
    dropSocket();
    pendingPrompt = null;
    resetting = false;
    turn = 'idle';
    stream = null;
    tools.clear();
    finishPermissions(labels.permissionDisconnected);
    setSession();
    const invalid = code === 4401;
    setConnection(invalid ? 'invalid' : 'offline');
    setNotice(invalid ? labels.invalidToken : labels.disconnected, 'error');
  }

  function send(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      handleDisconnect();
      return false;
    }
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      handleDisconnect();
      return false;
    }
  }

  function connect() {
    setConnection('connecting');
    setNotice(labels.connecting);
    let candidate;
    try {
      candidate = new WebSocket(`ws://${location.host}/socket`);
    } catch {
      handleDisconnect();
      return;
    }
    socket = candidate;
    candidate.addEventListener('open', () => {
      if (socket === candidate) send({ type: 'hello', token });
    });
    candidate.addEventListener('message', (message) => {
      if (socket !== candidate || typeof message.data !== 'string') return;
      let event;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      if (event && typeof event.type === 'string') receive(event);
    });
    candidate.addEventListener('close', (event) => {
      if (socket === candidate) handleDisconnect(event.code);
    });
  }

  function receiveReady(event) {
    if (typeof event.cwd === 'string' && event.cwd) {
      home = event.cwd;
      workspace.placeholder = home;
    }
    agents.clear();
    if (Array.isArray(event.agents)) {
      for (const info of event.agents) {
        if (!info || !agentDefaults.has(info.id) || typeof info.available !== 'boolean') continue;
        agents.set(info.id, {
          label: typeof info.label === 'string' ? info.label : '',
          protocol: typeof info.protocol === 'string' ? info.protocol : '',
          hint: typeof info.hint === 'string' ? info.hint : '',
          available: info.available,
        });
      }
    }
    renderAgents();
    setConnection('ready');
    const request = pendingPrompt;
    pendingPrompt = null;
    if (request) sendPrompt(request);
    else setNotice();
  }

  function receive(event) {
    if (event.type === 'ready') {
      if (connection === 'connecting') receiveReady(event);
      return;
    }
    if (connection !== 'ready') return;
    if (event.type === 'reset') {
      resetting = false;
      clearConversation();
      setNotice(labels.resetComplete);
      return;
    }
    if (resetting) {
      if (event.type === 'error') {
        resetting = false;
        setNotice(typeof event.message === 'string' && event.message ? event.message : labels.error, 'error');
        updateControls();
      }
      return;
    }
    if (event.type === 'error') {
      const message = typeof event.message === 'string' && event.message ? event.message : labels.error;
      if (turn !== 'idle') {
        turnFailed = true;
        addError(message);
        if (turn === 'sending') finishTurn('error');
      } else {
        setNotice(message, 'error');
      }
      return;
    }
    if (turn === 'idle') return;
    switch (event.type) {
      case 'start':
        if (turn !== 'stopping') {
          turn = 'running';
          setNotice(labels.working);
        }
        updateControls();
        break;
      case 'session':
        if (typeof event.sessionId === 'string') setSession(event.sessionId);
        break;
      case 'text':
      case 'thought':
        addStream(event.type, event.text);
        break;
      case 'tool':
        addTool(event);
        break;
      case 'permission':
        addPermission(event);
        break;
      case 'resolved': {
        const view = permissions.get(event.id);
        if (view) setPermissionState(view, 'closed', labels.permissionResolved);
        break;
      }
      case 'done':
        finishTurn(event.reason);
        break;
    }
  }

  function finishTurn(reason) {
    turn = 'idle';
    stream = null;
    tools.clear();
    finishPermissions(labels.permissionEnded);
    const key = typeof reason === 'string' && reason ? statusKey(reason) : 'completed';
    const failed = turnFailed || key === 'error';
    const message = failed ? labels.done.error : Object.hasOwn(labels.done, key) ? labels.done[key] : labels.turnEnded(reason);
    setNotice(message, failed ? 'error' : '');
    updateControls();
  }

  function absolutePath(path) {
    return path.startsWith('/') || /^[a-z]:[\\/]/i.test(path) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(path);
  }

  function sendPrompt(request) {
    const info = agents.get(request.agent);
    const cwd = request.cwd || home;
    if (info?.available === false || !cwd) {
      turn = 'idle';
      if (info?.available === false) {
        setNotice([labels.unavailableAgent(nameOf(request.agent)), info.hint].filter(Boolean).join(' '), 'error');
      } else {
        setWorkspaceError(labels.missingHome);
        setNotice(labels.missingHome, 'error');
      }
      updateControls();
      return;
    }
    conversationWorkspace = cwd;
    turn = 'sending';
    if (send({ type: 'prompt', agent: request.agent, cwd, text: request.text })) {
      setNotice(labels.submitting);
      updateControls();
    }
  }

  function submitPrompt() {
    const text = prompt.value;
    if (connection === 'invalid' || !text.trim() || turn !== 'idle' || resetting) return;
    if (text.length > 32000) {
      setNotice(labels.promptTooLong, 'error');
      return;
    }
    const cwd = workspace.value.trim();
    if (cwd && !absolutePath(cwd)) {
      setWorkspaceError(labels.invalidPath);
      workspace.focus();
      return;
    }
    if (connection === 'ready' && agents.get(activeAgent)?.available === false) {
      const info = agents.get(activeAgent);
      setNotice([labels.unavailableAgent(nameOf(activeAgent)), info.hint].filter(Boolean).join(' '), 'error');
      return;
    }
    const effectivePath = cwd || home;
    if (conversationWorkspace !== null && effectivePath !== conversationWorkspace) clearConversation();
    conversationWorkspace = effectivePath;
    turnFailed = false;
    setWorkspaceError();
    prompt.value = '';
    addMessage('user', labels.you, text);
    const request = { agent: activeAgent, cwd, text };
    if (connection === 'ready') {
      sendPrompt(request);
    } else {
      pendingPrompt = request;
      turn = 'awaiting-ready';
      if (connection !== 'connecting') connect();
      updateControls();
    }
  }

  function requestReset() {
    resetting = true;
    if (send({ type: 'reset' })) setNotice(labels.resetting);
    updateControls();
  }

  createAgentPicker();
  renderAgents();
  if (token) connect();
  else {
    setConnection('invalid');
    setNotice(labels.invalidToken, 'error');
  }

  retryButton.addEventListener('click', () => {
    if (connection === 'offline') connect();
  });

  workspace.addEventListener('input', () => setWorkspaceError());
  prompt.addEventListener('input', updateControls);
  prompt.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!sendButton.disabled) submitPrompt();
  });
  sendButton.addEventListener('click', submitPrompt);
  stopButton.addEventListener('click', () => {
    if (turn === 'awaiting-ready') {
      pendingPrompt = null;
      turn = 'idle';
      setNotice(labels.stoppedBeforeSend);
      updateControls();
    } else if ((turn === 'running' || turn === 'sending') && send({ type: 'cancel' })) {
      turn = 'stopping';
      finishPermissions(labels.permissionEnded);
      setNotice(labels.stopping);
      updateControls();
    }
  });
  resetButton.addEventListener('click', () => {
    if (resetButton.disabled) return;
    if (connection === 'ready') {
      requestReset();
    } else {
      clearConversation();
      setNotice(labels.resetComplete);
    }
  });
})();
