(() => {
  const PROTOCOL_VERSION = 1;
  const ROOM_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
  const isValidRoomId = (value) => typeof value === "string" && value.length <= 64 && value === value.trim() && ROOM_ID_PATTERN.test(value);
  const MAX_CLIENT_MESSAGES = 100;
  const MAX_CLIENT_TOOLS = 100;
  const MAX_CLIENT_TEXT = 64 * 1024;
  const MAX_CLIENT_PATH = 4_096;
  const MAX_CLIENT_FRAME_TEXT = 128 * 1024;
  const MAX_FRAME_BYTES = 256 * 1024;
  const SNAPSHOT_FRAME_BUDGET = MAX_FRAME_BYTES - 1024;
  const MAX_BUFFERED_BYTES = 1024 * 1024;
  const MAX_PENDING_REQUESTS = 256;
  const MAX_CLIENT_HOSTS = 64;
  const UTF8_ENCODER = new TextEncoder();
  function safePrefix(value, maxLength) {
    if (value.length <= maxLength) return value;
    let end = Math.max(0, maxLength);
    if (end < value.length && end > 0) {
      const code = value.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end--;
    }
    return value.slice(0, end);
  }
  function safeSuffix(value, maxLength) {
    if (value.length <= maxLength) return value;
    let start = Math.max(0, value.length - maxLength);
    if (start > 0 && start < value.length) {
      const code = value.charCodeAt(start);
      if (code >= 0xdc00 && code <= 0xdfff) start++;
    }
    return value.slice(start);
  }
  const $ = (id) => document.getElementById(id);
  // Some privacy modes and sandboxed documents expose sessionStorage but throw
  // on access. Treat it as an optional convenience cache rather than allowing
  // storage policy to prevent the relay UI from loading.
  let sessionStore = null;
  try { sessionStore = globalThis.sessionStorage; } catch {}
  function storageGet(key) {
    try { return sessionStore?.getItem(key) ?? null; } catch { return null; }
  }
  function storageSet(key, value) {
    try { sessionStore?.setItem(key, value); } catch {}
  }
  function storageRemove(key) {
    try { sessionStore?.removeItem(key); } catch {}
  }
  const loginView = $("login-view");
  const appView = $("app-view");
  const loginForm = $("login-form");
  const loginError = $("login-error");
  const roomInput = $("room-input");
  const tokenInput = $("token-input");
  const connectionLabel = $("connection-label");
  const hostSelect = $("host-select");
  const hostStatus = $("host-status");
  const modelStatus = $("model-status");
  const thinkingSelect = $("thinking-select");
  const phaseStatus = $("phase-status");
  const transcript = $("transcript");
  const noticeArea = $("notice-area");
  const noticeTimers = new Map();
  const promptForm = $("prompt-form");
  const promptInput = $("prompt-input");
  const deliverySelect = $("delivery-select");
  const abortButton = $("abort-button");
  const filesButton = $("files-button");
  const filesPanel = $("files-panel");
  const filesClose = $("files-close");
  const filesBack = $("files-back");
  const filesPath = $("files-path");
  const fileList = $("file-list");
  const fileViewer = $("file-viewer");
  const historyRefresh = $("history-refresh");
  const historyList = $("history-list");
  const historyDetail = $("history-detail");
  const historyDetailTitle = $("history-detail-title");
  const historyDetailClose = $("history-detail-close");
  const historyDetailMessages = $("history-detail-messages");
  const logoutButton = $("logout-button");

  let socket = null;
  let relayReady = false;
  let reconnectTimer = null;
  let reconnectDelay = 500;
  let snapshot = null;
  let knownHosts = new Map();
  let hostSnapshots = new Map();
  // Keep only the old context fence while a replacement host is waiting for
  // its authoritative snapshot. It is never rendered or used for writes, but
  // it lets a read-only request that raced the ready gate be retried safely.
  let hostRetryContexts = new Map();
  let selectedHostId = storageGet("pi-collab-host-id") || null;
  if (selectedHostId && selectedHostId.length > 128) selectedHostId = null;
  let manuallyDisconnected = false;
  let activeToken = storageGet("pi-collab-token");
  let activeRoom = storageGet("pi-collab-room") || "main";
  let pendingRequests = new Map();
  let historyNoticeShown = false;
  let currentDirectory = ".";
  let peerId = storageGet("pi-collab-peer-id");
  function randomId() {
    try {
      if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
    } catch {}
    try {
      if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
        const bytes = new Uint8Array(16);
        globalThis.crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      }
    } catch {}
    return "web-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  }
  if (!peerId || peerId.length > 128) {
    peerId = randomId();
    storageSet("pi-collab-peer-id", peerId);
  }

  function setConnection(text, kind = "") {
    connectionLabel.textContent = text;
    connectionLabel.className = "status-line " + kind;
  }

  function removeNotice(item) {
    const timer = noticeTimers.get(item);
    if (timer !== undefined) {
      clearTimeout(timer);
      noticeTimers.delete(item);
    }
    item.remove();
  }

  function showNotice(message, level = "info") {
    const item = document.createElement("div");
    item.className = "notice " + level;
    item.textContent = typeof message === "string" ? safePrefix(message, 2_048) : "Pi Cafe Space notice unavailable";
    noticeArea.appendChild(item);
    if (level !== "error") {
      const timer = setTimeout(() => {
        noticeTimers.delete(item);
        item.remove();
      }, 5000);
      noticeTimers.set(item, timer);
    }
    while (noticeArea.children.length > 4) {
      const first = noticeArea.firstElementChild;
      if (!first) break;
      removeNotice(first);
    }
  }

  function clearNotices() {
    for (const timer of noticeTimers.values()) clearTimeout(timer);
    noticeTimers.clear();
    noticeArea.replaceChildren();
  }

  function wsUrl() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return protocol + "//" + location.host + "/ws";
  }

  function send(message, allowBeforeWelcome = false) {
    const currentSocket = socket;
    if (!currentSocket || currentSocket.readyState !== WebSocket.OPEN || (!relayReady && !allowBeforeWelcome)) {
      showNotice("当前未连接到 relay", "error");
      return false;
    }
    let encoded;
    try {
      encoded = JSON.stringify(message);
      if (typeof encoded !== "string") throw new Error("not serializable");
    } catch {
      showNotice("消息无法序列化", "error");
      return false;
    }
    if (UTF8_ENCODER.encode(encoded).byteLength > MAX_FRAME_BYTES) {
      showNotice("消息超过 relay 帧大小限制", "error");
      return false;
    }
    if (currentSocket.bufferedAmount + UTF8_ENCODER.encode(encoded).byteLength > MAX_BUFFERED_BYTES) {
      try { currentSocket.close(1013, "client is too slow"); } catch {}
      showNotice("发送队列过满，连接已关闭", "error");
      return false;
    }
    try {
      currentSocket.send(encoded);
      return true;
    } catch {
      if (socket === currentSocket) {
        try { currentSocket.close(); } catch {}
      }
      showNotice("relay 连接已断开", "error");
      return false;
    }
  }

  function canonicalCommandPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    switch (payload.name) {
      case "prompt": {
        if (!boundedString(payload.content, MAX_CLIENT_TEXT, true)) return null;
        if (payload.delivery !== undefined && payload.delivery !== "steer" && payload.delivery !== "followUp") return null;
        const delivery = payload.delivery;
        return { name: "prompt", content: payload.content, ...(delivery === undefined ? {} : { delivery }) };
      }
      case "abort": return { name: "abort" };
      case "set_thinking":
        return payload.level === "off" || payload.level === "minimal" || payload.level === "low" || payload.level === "medium" ||
          payload.level === "high" || payload.level === "xhigh" || payload.level === "max"
          ? { name: "set_thinking", level: payload.level } : null;
      case "set_model":
        return boundedString(payload.provider, 128, true) && boundedString(payload.modelId, 256, true)
          ? { name: "set_model", provider: payload.provider, modelId: payload.modelId } : null;
      case "list_dir": return boundedString(payload.path, MAX_CLIENT_PATH)
        ? { name: "list_dir", path: payload.path } : null;
      case "read_file":
        if (!boundedString(payload.path, MAX_CLIENT_PATH) ||
            (payload.offset !== undefined && (!Number.isSafeInteger(payload.offset) || payload.offset < 0 || payload.offset > 100_000_000)) ||
            (payload.limit !== undefined && (!Number.isSafeInteger(payload.limit) || payload.limit < 1 || payload.limit > 256 * 1024))) return null;
        return {
          name: "read_file",
          path: payload.path,
          ...(payload.offset === undefined ? {} : { offset: payload.offset }),
          ...(payload.limit === undefined ? {} : { limit: payload.limit }),
        };
      case "list_sessions": return { name: "list_sessions" };
      case "get_session": return boundedString(payload.sessionId, 256, true)
        ? { name: "get_session", sessionId: payload.sessionId } : null;
      default: return null;
    }
  }

  function command(payload) {
    const safePayload = canonicalCommandPayload(payload);
    if (!safePayload) {
      showNotice("命令格式无效", "error");
      return null;
    }
    const selected = selectedHostId ? knownHosts.get(selectedHostId) : null;
    const readOnly = safePayload.name === "list_dir" || safePayload.name === "read_file" ||
      safePayload.name === "list_sessions" || safePayload.name === "get_session";
    // During a same-host replacement the old projection is deliberately not
    // rendered. A read-only request may still use its bounded context fence so
    // a command sent in the status/snapshot race can receive HOST_NOT_READY
    // and be retried after the replacement snapshot; writes remain blocked.
    const commandSnapshot = snapshot || (readOnly && selectedHostId ? hostRetryContexts.get(selectedHostId) : null);
    if (!commandSnapshot || !selected) {
      showNotice("尚未收到 Pi 会话状态", "error");
      return;
    }
    if ((selected.connected !== true || selected.ready === false) && !readOnly) {
      showNotice("当前 Pi 实例离线或正在同步，暂时不能发送命令", "warning");
      return;
    }
    if (pendingRequests.size >= MAX_PENDING_REQUESTS) {
      showNotice("待处理请求过多，请稍后再试", "error");
      return null;
    }
    const requestId = randomId();
    const message = { type: "command", requestId, expectedStreamId: commandSnapshot.streamId, expectedSessionId: commandSnapshot.sessionId, payload: safePayload };
    if (typeof commandSnapshot.cwd === "string" && commandSnapshot.cwd.length > 0) message.expectedCwd = commandSnapshot.cwd;
    if (selectedHostId) message.targetHostId = selectedHostId;
    pendingRequests.set(requestId, { hostId: selectedHostId, message, retryAfterHostSync: false, retryableAfterHostSync: readOnly });
    if (send(message)) {
      return requestId;
    }
    pendingRequests.delete(requestId);
    return null;
  }

  function textNode(text, className) {
    const node = document.createElement("div");
    node.className = className || "";
    node.textContent = text || "";
    return node;
  }

  function hostLabel(info) {
    const cwd = typeof info.cwd === "string" ? info.cwd : "";
    const parts = cwd.split(/[\\\\/]/).filter(Boolean);
    const project = parts.length ? parts[parts.length - 1] : "";
    const session = typeof info.sessionName === "string" && info.sessionName ? info.sessionName :
      typeof info.sessionId === "string" && info.sessionId ? "session " + info.sessionId.slice(0, 8) : "Pi 实例";
    const shortId = typeof info.hostId === "string" ? info.hostId.replace(/^pi-host-/, "").slice(0, 12) : "";
    const state = !info.connected ? "离线" : info.ready === false ? "连接中" : "在线";
    return (project || session) + (shortId ? " · " + shortId : "") + " · " + state;
  }

  function updateHostSelector() {
    hostSelect.replaceChildren();
    const values = Array.from(knownHosts.values());
    if (!values.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "等待 Pi 实例…";
      hostSelect.appendChild(option);
      hostSelect.disabled = true;
      return;
    }
    for (const info of values) {
      const option = document.createElement("option");
      option.value = info.hostId;
      option.textContent = hostLabel(info);
      hostSelect.appendChild(option);
    }
    hostSelect.disabled = false;
    hostSelect.value = selectedHostId && knownHosts.has(selectedHostId) ? selectedHostId : "";
  }

  function clearSelectedPanels() {
    historyNoticeShown = false;
    currentDirectory = ".";
    fileList.replaceChildren();
    fileViewer.hidden = true;
    historyList.replaceChildren();
    historyDetail.hidden = true;
    historyDetailMessages.replaceChildren();
  }

  function canonicalHostInfo(value) {
    return {
      hostId: value.hostId,
      connected: value.connected === true,
      ready: value.connected === true && value.ready !== false,
      streamId: value.streamId === null ? null : value.streamId,
      sessionId: value.sessionId === null ? null : value.sessionId,
      sessionName: value.sessionName === null ? null : value.sessionName,
      cwd: value.cwd === null ? null : value.cwd,
    };
  }

  function markHostsDisconnected() {
    if (knownHosts.size) {
      knownHosts = new Map(Array.from(knownHosts, ([id, info]) => [id, { ...canonicalHostInfo(info), connected: false, ready: false }]));
    }
    updateHostSelector();
    render();
  }

  function activateSelectedHost(refreshPanels = false) {
    const selectedInfo = selectedHostId ? knownHosts.get(selectedHostId) : null;
    // Do not drive commands or render the retained old session while a
    // replacement socket is connected but has not delivered its first snapshot.
    snapshot = selectedHostId && !(selectedInfo && selectedInfo.connected && selectedInfo.ready === false)
      ? hostSnapshots.get(selectedHostId) || null
      : null;
    render();
    if (refreshPanels && snapshot && selectedInfo?.connected !== false) {
      listDirectory(currentDirectory);
      listSessions();
    }
  }

  function selectHost(hostId, refreshPanels = true) {
    const next = hostId && knownHosts.has(hostId) ? hostId : null;
    if (next !== selectedHostId) {
      for (const [requestId, request] of pendingRequests) {
        if (request.hostId !== next) pendingRequests.delete(requestId);
      }
    }
    selectedHostId = next;
    historyNoticeShown = false;
    if (selectedHostId) storageSet("pi-collab-host-id", selectedHostId);
    else storageRemove("pi-collab-host-id");
    clearSelectedPanels();
    updateHostSelector();
    activateSelectedHost(refreshPanels);
  }

  function updateHosts(message) {
    const next = new Map();
    if (Array.isArray(message.hosts)) {
      for (const info of message.hosts) {
        if (isUsableHostInfo(info)) next.set(info.hostId, canonicalHostInfo(info));
      }
    } else {
      const id = boundedString(message.hostId, 128, true) ? message.hostId : "legacy";
      next.set(id, {
        hostId: id,
        connected: message.connected === true,
        ready: message.connected === true && message.ready !== false,
        streamId: boundedString(message.streamId, 128, true) ? message.streamId : null,
        sessionId: boundedString(message.sessionId, 256, true) ? message.sessionId : null,
        sessionName: null,
        cwd: null,
      });
    }
    for (const [id, info] of next) {
      // A replacement connection must provide a fresh authoritative snapshot.
      // Invalidate the old sequence before that snapshot arrives; otherwise a
      // legitimate sequence reset could be mistaken for a stale snapshot.
      if (info.connected === true && info.ready === false) {
        const previous = hostSnapshots.get(id);
        if (previous) {
          hostRetryContexts.set(id, {
            streamId: previous.streamId,
            sessionId: previous.sessionId,
            cwd: previous.cwd,
          });
        }
        hostSnapshots.delete(id);
        if (id === selectedHostId) clearSelectedPanels();
        continue;
      }
      // Host status can race with a snapshot broadcast from another server
      // task. Never keep rendering a projection whose advertised stream,
      // session, or project root is already known to be different.
      const projected = hostSnapshots.get(id);
      if (projected && ((info.streamId !== null && projected.streamId !== info.streamId) ||
          (info.sessionId !== null && projected.sessionId !== info.sessionId) ||
          (info.cwd !== null && projected.cwd !== info.cwd))) {
        hostSnapshots.delete(id);
        if (id === selectedHostId) clearSelectedPanels();
      }
    }
    knownHosts = next;
    for (const id of hostSnapshots.keys()) {
      if (!knownHosts.has(id)) hostSnapshots.delete(id);
    }
    for (const id of hostRetryContexts.keys()) {
      if (!knownHosts.has(id)) hostRetryContexts.delete(id);
    }
    const preferred = selectedHostId && knownHosts.has(selectedHostId) ? selectedHostId :
      Array.from(knownHosts.values()).find((info) => info.connected)?.hostId || Array.from(knownHosts.keys())[0] || null;
    updateHostSelector();
    if (preferred !== selectedHostId) selectHost(preferred);
    else {
      activateSelectedHost(false);
      updateHostSelector();
    }
  }

  function renderToolExecution(tool, message = null) {
    const status = message
      ? message.status === "error" ? "error" : message.status === "streaming" ? "running" : "complete"
      : tool?.status || "complete";
    const name = tool?.toolName || message?.toolName || "工具";
    const argsText = tool?.argsText || "";
    const output = message?.text || tool?.output || "";
    const article = document.createElement("article");
    article.className = "conversation-tool " + status;
    if (tool?.toolCallId || message?.toolCallId) article.dataset.toolCallId = tool?.toolCallId || message.toolCallId;

    const header = document.createElement("div");
    header.className = "tool-header";
    header.appendChild(textNode(name, "tool-name"));
    header.appendChild(textNode(status === "running" ? "执行中" : status === "error" ? "失败" : "完成", "tool-status"));
    article.appendChild(header);

    const appendDetail = (label, value) => {
      if (!value) return;
      const details = document.createElement("details");
      details.className = "tool-detail";
      details.open = status !== "complete";
      const summary = document.createElement("summary");
      summary.textContent = label;
      details.appendChild(summary);
      details.appendChild(textNode(value, "tool-detail-content"));
      article.appendChild(details);
    };
    appendDetail("参数", argsText);
    appendDetail("输出", output);
    return article;
  }

  function render() {
    const selected = selectedHostId ? knownHosts.get(selectedHostId) : null;
    if (selected) {
      const onlineCount = Array.from(knownHosts.values()).filter((info) => info.connected).length;
      hostStatus.textContent = !selected.connected ? "离线" : selected.ready === false ? "连接中" : onlineCount > 1 ? "在线 · " + onlineCount + " 个实例" : "在线";
    } else {
      hostStatus.textContent = knownHosts.size ? "请选择实例" : "离线";
    }
    if (!snapshot) {
      modelStatus.textContent = "—";
      thinkingSelect.value = "off";
      phaseStatus.textContent = "—";
      transcript.replaceChildren(textNode(selected ? "等待该 Pi 实例发送状态…" : "等待 Pi 实例…", "empty-state"));
      return;
    }
    const wasNearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
    const onlineCount = Array.from(knownHosts.values()).filter((info) => info.connected).length;
    hostStatus.textContent = !selected || !selected.connected ? "离线" : selected.ready === false ? "连接中" : snapshot.phase === "waiting_local_ui" ? "等待本机 UI" : onlineCount > 1 ? "在线 · " + onlineCount + " 个实例" : "在线";
    modelStatus.textContent = snapshot.model ? snapshot.model.provider + "/" + snapshot.model.id : "—";
    thinkingSelect.value = snapshot.thinkingLevel;
    const phaseText = snapshot.phase === "idle" ? "空闲" : snapshot.phase === "running" ? "运行中" : "等待本机批准";
    phaseStatus.textContent = phaseText + (snapshot.hasPendingMessages ? " · 有排队" : "");

    transcript.replaceChildren();
    const toolsById = new Map(snapshot.tools.map((tool) => [tool.toolCallId, tool]));
    const renderedToolIds = new Set();
    if (snapshot.messages.length === 0 && snapshot.tools.length === 0) {
      transcript.appendChild(textNode("等待 Pi 会话事件…", "empty-state"));
    } else {
      for (const message of snapshot.messages) {
        if (message.role === "tool") {
          const tool = message.toolCallId ? toolsById.get(message.toolCallId) : null;
          if (message.toolCallId) renderedToolIds.add(message.toolCallId);
          transcript.appendChild(renderToolExecution(tool, message));
          continue;
        }
        const article = document.createElement("article");
        article.className = "message " + message.role;
        const header = document.createElement("div");
        header.className = "message-header";
        header.appendChild(textNode(message.role === "user" ? "你" : message.role === "assistant" ? "Pi" : "系统", "message-role"));
        header.appendChild(textNode(message.status === "streaming" ? "流式中" : message.status === "error" ? "错误" : "", "message-status"));
        article.appendChild(header);
        if (message.thinking) {
          const details = document.createElement("details");
          const summary = document.createElement("summary");
          summary.textContent = "思考过程";
          details.appendChild(summary);
          details.appendChild(textNode(message.thinking, "thinking"));
          article.appendChild(details);
        }
        if (message.text) article.appendChild(textNode(message.text, "message-text"));
        transcript.appendChild(article);
      }
      // A tool-execution event can arrive before its tool-result message. Keep
      // every unmatched execution at the live edge of the transcript; once
      // that message arrives it is rendered at the message's authoritative
      // position above.
      for (const tool of snapshot.tools) {
        if (!renderedToolIds.has(tool.toolCallId)) {
          transcript.appendChild(renderToolExecution(tool));
        }
      }
    }
    if (wasNearBottom) transcript.scrollTop = transcript.scrollHeight;
  }

  function renderDirectory(data) {
    currentDirectory = typeof data.path === "string" && data.path ? data.path : ".";
    filesPath.textContent = currentDirectory;
    fileViewer.hidden = true;
    fileList.replaceChildren();
    const entries = Array.isArray(data.entries) ? data.entries : [];
    if (!entries.length) {
      fileList.appendChild(textNode("目录为空", "empty-state small"));
    }
    for (const entry of entries) {
      if (!usableDirectoryEntry(entry)) continue;
      const kind = entry.kind;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "file-entry " + kind;
      button.appendChild(textNode(kind === "directory" ? "▸" : kind === "link" ? "↗" : "·", "file-icon"));
      button.appendChild(textNode(entry.name, "file-name"));
      if (kind === "link") button.title = "符号链接不会被远程打开";
      button.addEventListener("click", () => {
        const nextPath = currentDirectory === "." ? entry.name : currentDirectory.replace(/[\\\\/]$/, "") + "/" + entry.name;
        if (kind === "directory") listDirectory(nextPath);
        else if (kind === "file") readProjectFile(nextPath);
        else showNotice("为安全起见，不能通过符号链接打开文件", "warning");
      });
      fileList.appendChild(button);
    }
    if (data.truncated) showNotice("目录内容过多，只显示前 300 项", "warning");
  }

  function renderFile(data) {
    filesPath.textContent = typeof data.path === "string" ? data.path : currentDirectory;
    fileList.replaceChildren();
    fileViewer.hidden = false;
    fileViewer.textContent = typeof data.content === "string" ? data.content : "";
    if (data.truncated) showNotice("文件内容已截断，可在后续版本加入分页读取", "warning");
  }

  function listDirectory(path) {
    currentDirectory = path || ".";
    return command({ name: "list_dir", path: currentDirectory });
  }

  function readProjectFile(path) {
    return command({ name: "read_file", path, offset: 0, limit: 128 * 1024 });
  }

  function openFiles() {
    filesPanel.classList.add("open");
    if (snapshot && !fileList.children.length) listDirectory(currentDirectory);
  }

  function closeFiles() {
    filesPanel.classList.remove("open");
  }

  function listSessions() {
    return command({ name: "list_sessions" });
  }

  function renderSessions(data) {
    historyList.replaceChildren();
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    if (!sessions.length) {
      historyList.appendChild(textNode("没有历史会话", "empty-state small"));
      return;
    }
    for (const session of sessions) {
      if (!usableSessionSummary(session)) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "history-entry" + (session.sessionId === data.currentSessionId ? " current" : "");
      const title = session.name || session.firstMessage || session.sessionId;
      button.appendChild(textNode(title, "history-title"));
      const date = new Date(session.modified).toLocaleString();
      button.appendChild(textNode(`${date} · ${session.messageCount} 条消息`, "history-meta"));
      button.addEventListener("click", () => command({ name: "get_session", sessionId: session.sessionId }));
      historyList.appendChild(button);
    }
    if (data.historyTruncated === true) showNotice("历史会话列表较长，只显示最近 100 条", "warning");
  }

  function renderHistoricalSession(data) {
    historyDetail.hidden = false;
    historyDetailTitle.textContent = data.name || data.sessionId || "历史会话";
    historyDetailMessages.replaceChildren();
    const messages = Array.isArray(data.messages) ? data.messages : [];
    for (const message of messages) {
      if (!usableTranscriptMessage(message)) continue;
      const article = document.createElement("article");
      article.className = "history-message " + message.role;
      article.appendChild(textNode(message.role === "user" ? "你" : message.role === "assistant" ? "Pi" : message.role === "system" ? "系统" : "工具", "history-message-role"));
      if (message.thinking) article.appendChild(textNode(message.thinking, "history-thinking"));
      if (message.text) article.appendChild(textNode(message.text, "history-message-text"));
      historyDetailMessages.appendChild(article);
    }
    if (!messages.length) historyDetailMessages.appendChild(textNode("该会话没有可显示的消息", "empty-state small"));
    if (data.historyTruncated) showNotice("历史会话较长，只显示最近 100 条消息", "warning");
  }

  function applyEvent(event) {
    const hasExplicitHostId = typeof event.hostId === "string";
    if (!hasExplicitHostId && knownHosts.size > 1) {
      // A legacy event without the relay-added host identity is ambiguous in a
      // multi-host room. Never apply it to whichever host happens to be
      // selected; discard the projection and obtain an authoritative sync.
      reconnectForSync();
      return;
    }
    const eventHostId = hasExplicitHostId ? event.hostId : knownHosts.size === 1
      ? Array.from(knownHosts.keys())[0] : selectedHostId;
    if (!eventHostId) {
      reconnectForSync();
      return;
    }
    // Keep every host's projection current, even while another host is selected.
    // Otherwise switching back to a busy host would display an old snapshot and
    // the first new event would look like a sequence gap.
    const target = hostSnapshots.get(eventHostId);
    if (!target) {
      // An event without a projection cannot be applied safely. This also
      // covers an event for an unknown host, which may otherwise leave a
      // permanently stale per-host stream in the page.
      reconnectForSync();
      return;
    }
    const info = knownHosts.get(eventHostId);
    if (!info) {
      // A late event for a host that has already disappeared is not safe to
      // apply to a retained projection. Re-establish the authoritative host
      // inventory instead of silently reviving that host in the UI.
      reconnectForSync();
      return;
    }
    // Do not apply a queued event from an old socket while a replacement is
    // synchronizing (or after the host has gone offline).
    if (!info.connected || info.ready === false) return;
    if (event.streamId !== target.streamId || event.sessionId !== target.sessionId) {
      reconnectForSync();
      return;
    }
    if (event.seq <= target.lastEventSeq) return;
    if (event.seq !== target.lastEventSeq + 1) {
      if (eventHostId === selectedHostId) showNotice("事件序号出现缺口，正在重新同步", "warning");
      reconnectForSync();
      return;
    }
    target.lastEventSeq = event.seq;
    const value = event.event;
    switch (value.kind) {
      case "session_state":
        target.phase = value.phase;
        target.hasPendingMessages = value.hasPendingMessages;
        break;
      case "message_started":
      case "message_finished": {
        const index = target.messages.findIndex((item) => item.id === value.message.id);
        const message = {
          id: value.message.id,
          role: value.message.role,
          text: typeof value.message.text === "string" ? safeSuffix(value.message.text, MAX_CLIENT_TEXT) : "",
          thinking: typeof value.message.thinking === "string" ? safeSuffix(value.message.thinking, MAX_CLIENT_TEXT) : "",
          timestamp: value.message.timestamp,
          status: value.message.status,
          toolName: value.message.toolName,
          toolCallId: value.message.toolCallId,
        };
        if (index < 0) target.messages.push(message);
        else target.messages[index] = message;
        if (target.messages.length > MAX_CLIENT_MESSAGES) {
          target.messages = target.messages.slice(-MAX_CLIENT_MESSAGES);
          target.historyTruncated = true;
        }
        break;
      }
      case "message_delta": {
        const message = target.messages.find((item) => item.id === value.messageId);
        if (message) {
          const previousLength = value.channel === "text" ? message.text.length : message.thinking.length;
          if (value.channel === "text") message.text = safeSuffix(message.text + value.delta, MAX_CLIENT_TEXT);
          else if (value.channel === "thinking") message.thinking = safeSuffix(message.thinking + value.delta, MAX_CLIENT_TEXT);
          if (previousLength + value.delta.length > MAX_CLIENT_TEXT) target.historyTruncated = true;
        } else {
          target.historyTruncated = true;
        }
        break;
      }
      case "tool_started":
      case "tool_finished": {
        const index = target.tools.findIndex((item) => item.toolCallId === value.tool.toolCallId);
        const tool = {
          toolCallId: value.tool.toolCallId,
          toolName: value.tool.toolName,
          argsText: typeof value.tool.argsText === "string" ? safeSuffix(value.tool.argsText, MAX_CLIENT_TEXT) : "",
          output: typeof value.tool.output === "string" ? safeSuffix(value.tool.output, MAX_CLIENT_TEXT) : "",
          status: value.tool.status,
        };
        if (index < 0) target.tools.push(tool);
        else target.tools[index] = tool;
        if (target.tools.length > MAX_CLIENT_TOOLS) {
          target.tools = target.tools.slice(-MAX_CLIENT_TOOLS);
          target.historyTruncated = true;
        }
        break;
      }
      case "tool_updated": {
        const tool = target.tools.find((item) => item.toolCallId === value.toolCallId);
        if (tool) tool.output = typeof value.output === "string" ? safeSuffix(value.output, MAX_CLIENT_TEXT) : "";
        else target.historyTruncated = true;
        break;
      }
      case "model_changed": target.model = value.model ? { provider: value.model.provider, id: value.model.id } : null; break;
      case "thinking_changed": target.thinkingLevel = value.level; break;
      case "ui_wait": target.phase = value.waiting ? "waiting_local_ui" : "running"; break;
      case "notice": if (eventHostId === selectedHostId) showNotice(value.message, value.level); break;
    }
    const compactedTarget = compactClientSnapshot(target, eventHostId);
    hostSnapshots.set(eventHostId, compactedTarget);
    if (eventHostId === selectedHostId) {
      snapshot = compactedTarget;
      render();
    }
  }

  function replayPendingRequests(readyHostId = null) {
    if (!relayReady || !pendingRequests.size) return;
    for (const request of pendingRequests.values()) {
      if (!request.retryAfterHostSync) {
        // A normal reconnect replay preserves the request ID so the relay can
        // transfer an in-flight result. Do not replay it merely because an
        // unrelated host sent a fresh snapshot.
        if (readyHostId === null) send(request.message);
        continue;
      }
      if (readyHostId === null || request.hostId !== readyHostId) continue;
      const current = hostSnapshots.get(readyHostId);
      const info = knownHosts.get(readyHostId);
      if (!current || !info?.connected || info.ready === false) continue;
      request.message.expectedStreamId = current.streamId;
      request.message.expectedSessionId = current.sessionId;
      if (typeof current.cwd === "string" && current.cwd.length > 0) request.message.expectedCwd = current.cwd;
      else delete request.message.expectedCwd;
      if (send(request.message)) request.retryAfterHostSync = false;
    }
  }

  function reconnectForSync() {
    pendingRequests = new Map();
    // A full resync is authoritative. Do not compare the next snapshot with a
    // projection from the diverged socket, since a host replacement may
    // legitimately restart the sequence at a lower value.
    hostSnapshots = new Map();
    hostRetryContexts = new Map();
    snapshot = null;
    clearSelectedPanels();
    const currentSocket = socket;
    socket = null;
    relayReady = false;
    if (currentSocket) {
      try { currentSocket.close(); } catch {}
    }
    markHostsDisconnected();
    scheduleReconnect();
  }

  function boundedString(value, max, required = false) {
    return typeof value === "string" && (required ? value.length > 0 : true) && value.length <= max;
  }

  function nullableString(value, max) {
    return value === null || boundedString(value, max);
  }

  function usableModel(value) {
    return value === null || (value && typeof value === "object" && !Array.isArray(value) &&
      boundedString(value.provider, 128, true) && boundedString(value.id, 256, true));
  }

  function usableTranscriptMessage(value) {
    return value && typeof value === "object" && !Array.isArray(value) &&
      boundedString(value.id, 128, true) &&
      (value.role === "user" || value.role === "assistant" || value.role === "tool" || value.role === "system") &&
      boundedString(value.text, MAX_CLIENT_TEXT) && boundedString(value.thinking, MAX_CLIENT_TEXT) &&
      typeof value.timestamp === "number" && Number.isFinite(value.timestamp) &&
      (value.status === "streaming" || value.status === "complete" || value.status === "error") &&
      nullableString(value.toolName, 256) && nullableString(value.toolCallId, 256);
  }

  function usableTool(value) {
    return value && typeof value === "object" && !Array.isArray(value) &&
      boundedString(value.toolCallId, 256, true) && boundedString(value.toolName, 256, true) &&
      boundedString(value.argsText, MAX_CLIENT_TEXT) && boundedString(value.output, MAX_CLIENT_TEXT) &&
      (value.status === "running" || value.status === "complete" || value.status === "error");
  }

  function isUsableSnapshot(value) {
    return value && typeof value === "object" && !Array.isArray(value) && value.protocolVersion === PROTOCOL_VERSION &&
      boundedString(value.streamId, 128, true) && boundedString(value.sessionId, 256, true) &&
      nullableString(value.sessionName, 256) && boundedString(value.cwd, 16384) &&
      nullableString(value.activeLeafId, 128) && usableModel(value.model) &&
      (value.thinkingLevel === "off" || value.thinkingLevel === "minimal" || value.thinkingLevel === "low" ||
        value.thinkingLevel === "medium" || value.thinkingLevel === "high" || value.thinkingLevel === "xhigh" || value.thinkingLevel === "max") &&
      (value.phase === "idle" || value.phase === "running" || value.phase === "waiting_local_ui") &&
      typeof value.hasPendingMessages === "boolean" && Array.isArray(value.messages) && value.messages.length <= 1000 &&
      value.messages.every(usableTranscriptMessage) && (value.historyTruncated === undefined || typeof value.historyTruncated === "boolean") &&
      Array.isArray(value.tools) && value.tools.length <= 500 && value.tools.every(usableTool) &&
      Number.isSafeInteger(value.lastEventSeq) && value.lastEventSeq >= 0 && value.lastEventSeq <= 1_000_000_000;
  }

  function compactClientSnapshot(value, hostId = null) {
    let textTruncated = false;
    let messages = value.messages.slice(-MAX_CLIENT_MESSAGES).map((message) => {
      const text = safeSuffix(message.text, MAX_CLIENT_TEXT);
      const thinking = safeSuffix(message.thinking, MAX_CLIENT_TEXT);
      textTruncated ||= text.length !== message.text.length || thinking.length !== message.thinking.length;
      return {
        id: message.id,
        role: message.role,
        text,
        thinking,
        timestamp: message.timestamp,
        status: message.status,
        toolName: message.toolName,
        toolCallId: message.toolCallId,
      };
    });
    let toolTextTruncated = false;
    let tools = value.tools.slice(-MAX_CLIENT_TOOLS).map((tool) => {
      const argsText = safeSuffix(tool.argsText, MAX_CLIENT_TEXT);
      const output = safeSuffix(tool.output, MAX_CLIENT_TEXT);
      toolTextTruncated ||= argsText.length !== tool.argsText.length || output.length !== tool.output.length;
      return {
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
        argsText,
        output,
        status: tool.status,
      };
    });
    let historyTruncated = value.historyTruncated === true || messages.length < value.messages.length || tools.length < value.tools.length || textTruncated || toolTextTruncated;
    const makeSnapshot = () => ({
      protocolVersion: PROTOCOL_VERSION,
      streamId: value.streamId,
      sessionId: value.sessionId,
      sessionName: value.sessionName,
      cwd: value.cwd,
      activeLeafId: value.activeLeafId,
      model: value.model ? { provider: value.model.provider, id: value.model.id } : null,
      thinkingLevel: value.thinkingLevel,
      phase: value.phase,
      hasPendingMessages: value.hasPendingMessages,
      historyTruncated,
      messages,
      tools,
      lastEventSeq: value.lastEventSeq,
    });
    const frameSize = () => {
      try {
        const envelope = { type: "snapshot", ...(hostId ? { hostId } : {}), snapshot: makeSnapshot() };
        return UTF8_ENCODER.encode(JSON.stringify(envelope)).byteLength;
      } catch {
        return Number.POSITIVE_INFINITY;
      }
    };
    const trimText = (messageLimit, toolLimit) => {
      messages = messages.map((message) => ({ ...message, text: safeSuffix(message.text, messageLimit), thinking: safeSuffix(message.thinking, messageLimit) }));
      tools = tools.map((tool) => ({ ...tool, argsText: safeSuffix(tool.argsText, toolLimit), output: safeSuffix(tool.output, toolLimit) }));
      historyTruncated = true;
    };
    while (messages.length > 1 && frameSize() > SNAPSHOT_FRAME_BUDGET) {
      messages = messages.slice(1);
      historyTruncated = true;
    }
    while (tools.length > 0 && frameSize() > SNAPSHOT_FRAME_BUDGET) {
      tools = tools.slice(1);
      historyTruncated = true;
    }
    if (frameSize() > SNAPSHOT_FRAME_BUDGET) trimText(8_192, 4_096);
    while (messages.length > 1 && frameSize() > SNAPSHOT_FRAME_BUDGET) {
      messages = messages.slice(1);
      historyTruncated = true;
    }
    while (tools.length > 0 && frameSize() > SNAPSHOT_FRAME_BUDGET) {
      tools = tools.slice(1);
      historyTruncated = true;
    }
    if (frameSize() > SNAPSHOT_FRAME_BUDGET) trimText(1_024, 1_024);
    while (messages.length > 1 && frameSize() > SNAPSHOT_FRAME_BUDGET) {
      messages = messages.slice(1);
      historyTruncated = true;
    }
    while (tools.length > 0 && frameSize() > SNAPSHOT_FRAME_BUDGET) {
      tools = tools.slice(1);
      historyTruncated = true;
    }
    if (frameSize() > SNAPSHOT_FRAME_BUDGET) {
      const latest = messages.at(-1);
      messages = latest ? [latest] : [];
      tools = [];
      historyTruncated = true;
    }
    if (frameSize() > SNAPSHOT_FRAME_BUDGET) {
      messages = [];
      tools = [];
      historyTruncated = true;
    }
    return makeSnapshot();
  }

  function isUsableEvent(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || value.type !== "event" ||
        (value.hostId !== undefined && !boundedString(value.hostId, 128, true)) ||
        !boundedString(value.streamId, 128, true) || !boundedString(value.sessionId, 256, true) ||
        !Number.isSafeInteger(value.seq) || value.seq < 0 || value.seq > 1_000_000_000 || !boundedString(value.emittedAt, 64, true) ||
        !value.event || typeof value.event !== "object" || Array.isArray(value.event)) return false;
    const event = value.event;
    switch (event.kind) {
      case "session_state":
        return (event.phase === "idle" || event.phase === "running" || event.phase === "waiting_local_ui") &&
          typeof event.hasPendingMessages === "boolean";
      case "message_started":
      case "message_finished":
        return usableTranscriptMessage(event.message);
      case "message_delta":
        return boundedString(event.messageId, 128, true) && (event.channel === "text" || event.channel === "thinking") &&
          boundedString(event.delta, MAX_CLIENT_TEXT);
      case "tool_started":
      case "tool_finished":
        return usableTool(event.tool);
      case "tool_updated":
        return boundedString(event.toolCallId, 256, true) && boundedString(event.output, MAX_CLIENT_TEXT);
      case "model_changed":
        return usableModel(event.model);
      case "thinking_changed":
        return event.level === "off" || event.level === "minimal" || event.level === "low" || event.level === "medium" ||
          event.level === "high" || event.level === "xhigh" || event.level === "max";
      case "ui_wait":
        return typeof event.waiting === "boolean" && nullableString(event.title, 512);
      case "notice":
        return (event.level === "info" || event.level === "warning" || event.level === "error") && boundedString(event.message, 16384, true);
      default:
        return false;
    }
  }

  function isUsableHostInfo(value) {
    return value && typeof value === "object" && !Array.isArray(value) && boundedString(value.hostId, 128, true) &&
      typeof value.connected === "boolean" && (value.ready === undefined || typeof value.ready === "boolean") &&
      nullableString(value.streamId, 128) && nullableString(value.sessionId, 256) && nullableString(value.sessionName, 256) &&
      nullableString(value.cwd, 16384);
  }

  function isUsableHostStatus(value) {
    if (value.hosts === undefined) return true;
    if (!Array.isArray(value.hosts) || value.hosts.length > MAX_CLIENT_HOSTS) return false;
    const ids = new Set();
    for (const host of value.hosts) {
      if (!isUsableHostInfo(host) || ids.has(host.hostId)) return false;
      ids.add(host.hostId);
    }
    return true;
  }

  function usableDirectoryEntry(value) {
    return value && typeof value === "object" && !Array.isArray(value) && boundedString(value.name, 1_024, true) &&
      value.name !== "." && value.name !== ".." && !/[\\/\0]/.test(value.name) &&
      (value.kind === "file" || value.kind === "directory" || value.kind === "link");
  }

  function usableSessionSummary(value) {
    return value && typeof value === "object" && !Array.isArray(value) && boundedString(value.sessionId, 256, true) &&
      nullableString(value.name, 256) && nullableString(value.cwd, MAX_CLIENT_PATH) && boundedString(value.created, 64, true) &&
      boundedString(value.modified, 64, true) && Number.isSafeInteger(value.messageCount) && value.messageCount >= 0 &&
      typeof value.firstMessage === "string" && value.firstMessage.length <= 2_048;
  }

  function usableJsonValue(value, depth = 0, state = { nodes: 0, stringBytes: 0 }, seen = new WeakSet()) {
    state.nodes += 1;
    if (state.nodes > 20_000) return false;
    if (value === null || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value === "string") {
      if (value.length > MAX_FRAME_BYTES) return false;
      state.stringBytes += UTF8_ENCODER.encode(value).byteLength;
      return state.stringBytes <= MAX_FRAME_BYTES;
    }
    if (!value || typeof value !== "object" || depth > 8 || seen.has(value)) return false;
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > 500) return false;
        return value.every((item) => usableJsonValue(item, depth + 1, state, seen));
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return false;
      const keys = Object.keys(value);
      if (keys.length > 500) return false;
      for (const key of keys) {
        if (key.length > 4_096) return false;
        state.stringBytes += UTF8_ENCODER.encode(key).byteLength;
        if (state.stringBytes > MAX_FRAME_BYTES || !usableJsonValue(value[key], depth + 1, state, seen)) return false;
      }
      return true;
    } catch {
      return false;
    } finally {
      seen.delete(value);
    }
  }

  function usableResultData(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return true;
    if (value.kind === "directory") {
      return boundedString(value.path, MAX_CLIENT_PATH) && typeof value.truncated === "boolean" && Array.isArray(value.entries) &&
        value.entries.length <= 300 && value.entries.every(usableDirectoryEntry);
    }
    if (value.kind === "file") {
      return boundedString(value.path, MAX_CLIENT_PATH) && Number.isSafeInteger(value.offset) && value.offset >= 0 &&
        Number.isSafeInteger(value.size) && value.size >= 0 && Number.isSafeInteger(value.bytesRead) && value.bytesRead >= 0 &&
        value.bytesRead <= MAX_CLIENT_FRAME_TEXT && typeof value.truncated === "boolean" && boundedString(value.content, MAX_CLIENT_FRAME_TEXT);
    }
    if (value.kind === "sessions") {
      return boundedString(value.currentSessionId, 256, true) && Array.isArray(value.sessions) && value.sessions.length <= 100 &&
        (value.historyTruncated === undefined || typeof value.historyTruncated === "boolean") &&
        value.sessions.every(usableSessionSummary);
    }
    if (value.kind === "session") {
      return boundedString(value.sessionId, 256, true) && nullableString(value.name, 256) && nullableString(value.cwd, MAX_CLIENT_PATH) &&
        nullableString(value.activeLeafId, 128) && (value.model === null || usableModel(value.model)) &&
        (value.thinkingLevel === "off" || value.thinkingLevel === "minimal" || value.thinkingLevel === "low" || value.thinkingLevel === "medium" ||
          value.thinkingLevel === "high" || value.thinkingLevel === "xhigh" || value.thinkingLevel === "max") &&
        Array.isArray(value.messages) && value.messages.length <= 100 && value.messages.every(usableTranscriptMessage) &&
        typeof value.historyTruncated === "boolean" && boundedString(value.modified, 64, true);
    }
    return true;
  }

  function isUsableCommandResult(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || value.type !== "command_result" ||
        (value.hostId !== undefined && !boundedString(value.hostId, 128, true)) || !boundedString(value.requestId, 128, true) ||
        (value.status !== "dispatched" && value.status !== "applied" && value.status !== "rejected") ||
        !nullableString(value.code, 128) || !nullableString(value.message, 2048)) return false;
    if (value.data === undefined) return true;
    try {
      return usableJsonValue(value.data) && UTF8_ENCODER.encode(JSON.stringify(value.data)).byteLength <= MAX_FRAME_BYTES && usableResultData(value.data);
    } catch { return false; }
  }

  function handleSnapshot(message) {
    if (!message || (message.hostId !== undefined && !boundedString(message.hostId, 128, true)) || !isUsableSnapshot(message.snapshot)) {
      showNotice("收到无效的 Pi 会话快照", "error");
      reconnectForSync();
      return;
    }
    const hasExplicitHostId = typeof message.hostId === "string" && message.hostId.length > 0;
    if (!hasExplicitHostId && knownHosts.size > 1) {
      showNotice("收到无法确定所属 Pi 实例的快照，正在重新同步", "error");
      reconnectForSync();
      return;
    }
    const id = hasExplicitHostId ? message.hostId :
      knownHosts.size === 1 ? Array.from(knownHosts.keys())[0] : "legacy";
    if (hasExplicitHostId && !knownHosts.has(id)) {
      showNotice("收到未知的 Pi 实例快照，正在重新同步", "error");
      reconnectForSync();
      return;
    }
    const value = compactClientSnapshot(message.snapshot, id);
    if (!hostSnapshots.has(id) && !knownHosts.has(id) && knownHosts.size >= MAX_CLIENT_HOSTS) {
      showNotice("收到过多 Pi 实例状态，正在重新同步", "error");
      reconnectForSync();
      return;
    }
    const previousSnapshot = hostSnapshots.get(id);
    const contextChanged = previousSnapshot && (previousSnapshot.streamId !== value.streamId || previousSnapshot.sessionId !== value.sessionId || previousSnapshot.cwd !== value.cwd);
    const shouldRefreshPanels = !previousSnapshot || !!contextChanged;
    if (contextChanged && id === selectedHostId) clearSelectedPanels();
    if (previousSnapshot && previousSnapshot.streamId === value.streamId && previousSnapshot.sessionId === value.sessionId &&
        value.lastEventSeq < previousSnapshot.lastEventSeq) {
      showNotice("收到过期的 Pi 会话快照，正在重新同步", "warning");
      reconnectForSync();
      return;
    }
    hostSnapshots.set(id, value);
    hostRetryContexts.delete(id);
    const previous = knownHosts.get(id) || null;
    // A snapshot can be replayed for an offline host from relay memory. Preserve
    // the host_status connectivity bit instead of turning that cached snapshot
    // into a false "online" state.
    const connected = previous ? previous.connected === true : true;
    const ready = previous ? previous.connected === true : true;
    knownHosts.set(id, {
      hostId: id,
      connected,
      ready,
      streamId: value.streamId,
      sessionId: value.sessionId,
      sessionName: value.sessionName,
      cwd: value.cwd,
    });
    updateHostSelector();
    if (!selectedHostId) selectHost(id);
    else if (selectedHostId === id) {
      snapshot = value;
      if (connected) setConnection("实时同步中", "connected");
      else setConnection("relay 已连接，Pi 离线", "warning");
      if (snapshot.historyTruncated && !historyNoticeShown) {
        showNotice("当前会话较长，页面显示的是最近 100 条消息", "warning");
        historyNoticeShown = true;
      }
      render();
      if (connected && shouldRefreshPanels) {
        listDirectory(currentDirectory);
        listSessions();
      }
    } else {
      render();
    }
    // A browser reconnect can replay a request just before a replacement
    // host's fresh snapshot arrives. Retry requests that were held at the
    // ready gate once this authoritative snapshot is installed, regardless of
    // which host is currently selected.
    if (connected && ready) replayPendingRequests(id);
  }

  function showLoginError(message) {
    manuallyDisconnected = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    const currentSocket = socket;
    socket = null;
    relayReady = false;
    if (currentSocket) {
      try { currentSocket.close(); } catch {}
    }
    storageRemove("pi-collab-token");
    storageRemove("pi-collab-host-id");
    activeToken = null;
    pendingRequests = new Map();
    snapshot = null;
    knownHosts = new Map();
    hostSnapshots = new Map();
    hostRetryContexts = new Map();
    selectedHostId = null;
    clearNotices();
    clearSelectedPanels();
    filesPanel.classList.remove("open");
    promptInput.value = "";
    loginError.textContent = message;
    loginError.hidden = false;
    appView.hidden = true;
    loginView.hidden = false;
    tokenInput.value = "";
    setConnection("未连接", "error");
  }

  function handleMessage(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      showNotice("收到无效的 relay 消息", "error");
      reconnectForSync();
      return;
    }
    switch (message.type) {
      case "welcome": {
        const expectedRoom = activeRoom || storageGet("pi-collab-room") || "main";
        if (message.protocolVersion !== PROTOCOL_VERSION || !boundedString(message.connectionId, 128, true) ||
            message.peerRole !== "client" || !boundedString(message.roomId, 128, true) || message.roomId !== expectedRoom || typeof message.hostConnected !== "boolean") {
          showNotice("收到无效的 relay 握手", "error");
          reconnectForSync();
          return;
        }
        relayReady = true;
        reconnectDelay = 500;
        setConnection("已连接 relay，等待 Pi", "connected");
        replayPendingRequests();
        return;
      }
      case "host_status":
        if (typeof message.connected !== "boolean" || (message.ready !== undefined && typeof message.ready !== "boolean") ||
            !nullableString(message.streamId, 128) || !nullableString(message.sessionId, 256) ||
            (message.hostId !== undefined && !nullableString(message.hostId, 128)) || !isUsableHostStatus(message)) {
          showNotice("收到无效的 Pi 实例状态", "error");
          reconnectForSync();
          return;
        }
        updateHosts(message);
        if (!message.connected) setConnection("relay 已连接，Pi 离线", "warning");
        else setConnection("已连接 relay", "connected");
        return;
      case "snapshot":

        handleSnapshot(message);
        return;
      case "event":
        if (!isUsableEvent(message)) {
          showNotice("收到无效的 Pi 会话事件", "error");
          reconnectForSync();
          return;
        }
        applyEvent(message);
        return;
      case "command_result": {
        if (!isUsableCommandResult(message)) {
          showNotice("收到无效的 relay 命令结果", "error");
          reconnectForSync();
          return;
        }
        const hasPendingRequest = pendingRequests.has(message.requestId);
        const pendingRequest = pendingRequests.get(message.requestId);
        const requestHostId = pendingRequest?.hostId || null;
        const resultHostId = typeof message.hostId === "string" ? message.hostId : requestHostId;
        // A delayed result from another host must never satisfy this request.
        if (requestHostId && resultHostId && requestHostId !== resultHostId) return;
        const currentResultSnapshot = requestHostId ? hostSnapshots.get(requestHostId) : null;
        const expectedStreamId = pendingRequest?.message?.expectedStreamId;
        const expectedSessionId = pendingRequest?.message?.expectedSessionId;
        const expectedCwd = pendingRequest?.message?.expectedCwd;
        const resultFenceMatches = !requestHostId ? true : !!currentResultSnapshot &&
          currentResultSnapshot.streamId === expectedStreamId &&
          (expectedSessionId === undefined || currentResultSnapshot.sessionId === expectedSessionId) &&
          (expectedCwd === undefined || currentResultSnapshot.cwd === expectedCwd);
        const requestStillPending = message.status === "dispatched" && message.code === "REQUEST_PENDING";
        const retryAfterHostSync = hasPendingRequest && pendingRequest?.retryableAfterHostSync === true && message.code === "HOST_NOT_READY";
        if (retryAfterHostSync && pendingRequest) pendingRequest.retryAfterHostSync = true;
        if (!requestStillPending && !retryAfterHostSync) pendingRequests.delete(message.requestId);
        // Never render unsolicited or late results after a reconnect/page reload.
        if (!hasPendingRequest) return;
        if (retryAfterHostSync) {
          if (!resultHostId || resultHostId === selectedHostId) showNotice("Pi 实例正在同步，待新快照到达后会重试请求", "info");
          return;
        }
        if (requestStillPending) {
          if (!resultHostId || resultHostId === selectedHostId) showNotice(message.message || "请求仍在处理中", "info");
          return;
        }
        const resultIsVisible = !resultHostId || resultHostId === selectedHostId;
        if (resultIsVisible && resultFenceMatches) {
          if (message.data && message.data.kind === "directory") renderDirectory(message.data);
          else if (message.data && message.data.kind === "file") renderFile(message.data);
          else if (message.data && message.data.kind === "sessions") renderSessions(message.data);
          else if (message.data && message.data.kind === "session") renderHistoricalSession(message.data);
        } else if (resultIsVisible && !resultFenceMatches && message.status === "applied") {
          showNotice("命令结果属于旧的 Pi 会话，已忽略", "warning");
        }
        if (resultIsVisible && (!resultFenceMatches || message.status !== "applied" || !message.data)) {
          if (message.status === "rejected") showNotice(message.message || "命令被拒绝", "error");
          else if (message.status === "dispatched") showNotice(message.message || "已发送", "info");
        }
        return;
      }
      case "error":
        if (!boundedString(message.code, 128, true) || !boundedString(message.message, 2048, true)) {
          showNotice("收到无效的 relay 错误", "error");
          reconnectForSync();
          return;
        }
        if (message.code === "UNAUTHORIZED") {
          showLoginError("客户端 Token 无效，请重新输入");
          return;
        }
        if (message.code === "INVALID_ROOM") {
          showLoginError("房间名无效，请重新输入");
          return;
        }
        showNotice(message.message || message.code || "relay 错误", "error");
        return;
      default:
        showNotice("收到无效的 relay 消息", "error");
        reconnectForSync();
        return;
    }
  }

  function scheduleReconnect() {
    if (manuallyDisconnected || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(10000, reconnectDelay * 2);
  }

  function connect() {
    const token = activeToken || storageGet("pi-collab-token");
    const room = activeRoom || storageGet("pi-collab-room") || "main";
    if (!token) return;
    if (token.length > 4_096) {
      showLoginError("客户端 Token 过长");
      return;
    }
    if (!isValidRoomId(room)) {
      showLoginError("房间名无效，请重新输入");
      return;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    manuallyDisconnected = false;
    relayReady = false;
    const previousSocket = socket;
    socket = null;
    if (previousSocket) {
      try { previousSocket.close(); } catch {}
    }
    setConnection("连接中…");
    let nextSocket;
    try {
      nextSocket = new WebSocket(wsUrl());
    } catch {
      setConnection("无法创建连接", "error");
      scheduleReconnect();
      return;
    }
    socket = nextSocket;
    nextSocket.addEventListener("open", () => {
      if (socket !== nextSocket) return;
      send({ type: "hello", protocolVersion: PROTOCOL_VERSION, peerRole: "client", peerId, roomId: room, token }, true);
    });
    nextSocket.addEventListener("message", (event) => {
      if (socket !== nextSocket) return;
      try {
        if (typeof event.data !== "string" || event.data.length > MAX_FRAME_BYTES || UTF8_ENCODER.encode(event.data).byteLength > MAX_FRAME_BYTES) {
          showNotice("收到超大的 relay 消息", "error");
          reconnectForSync();
          return;
        }
        handleMessage(JSON.parse(event.data));
      } catch {
        showNotice("收到无法解析的 relay 消息", "error");
        reconnectForSync();
      }
    });
    nextSocket.addEventListener("error", () => {
      if (socket !== nextSocket) return;
      socket = null;
      relayReady = false;
      markHostsDisconnected();
      setConnection("连接错误，重连中…", "error");
      // Enter retry immediately rather than depending on a damaged transport
      // to dispatch close. A later close event is ignored by socket identity.
      try { nextSocket.close(); } catch {}
      if (!manuallyDisconnected) scheduleReconnect();
    });
    nextSocket.addEventListener("close", () => {
      if (socket !== nextSocket) return;
      socket = null;
      relayReady = false;
      markHostsDisconnected();
      if (!manuallyDisconnected) {
        setConnection("连接断开，重连中…", "warning");
        scheduleReconnect();
      }
    });
  }

  loginForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const token = tokenInput.value.trim();
    const room = roomInput.value;
    if (!token || !room) return;
    if (token.length > 4_096) {
      loginError.textContent = "客户端 Token 过长";
      loginError.hidden = false;
      return;
    }
    if (!isValidRoomId(room)) {
      loginError.textContent = "房间名无效，请重新输入";
      loginError.hidden = false;
      return;
    }
    activeToken = token;
    activeRoom = room;
    storageSet("pi-collab-token", token);
    storageSet("pi-collab-room", room);
    clearNotices();
    reconnectDelay = 500;
    knownHosts = new Map();
    hostSnapshots = new Map();
    hostRetryContexts = new Map();
    pendingRequests = new Map();
    selectedHostId = null;
    snapshot = null;
    storageRemove("pi-collab-host-id");
    clearSelectedPanels();
    loginError.hidden = true;
    loginView.hidden = true;
    appView.hidden = false;
    connect();
  });

  promptForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const content = promptInput.value.trim();
    if (!content || !snapshot) return;
    let delivery;
    const selected = deliverySelect.value;
    if (selected === "steer" || selected === "followUp") delivery = selected;
    else if (snapshot.phase !== "idle") delivery = "followUp";
    const payload = { name: "prompt", content };
    if (delivery) payload.delivery = delivery;
    if (command(payload)) {
      promptInput.value = "";
      promptInput.focus();
    }
  });

  hostSelect.addEventListener("change", () => {
    selectHost(hostSelect.value);
  });
  abortButton.addEventListener("click", () => { command({ name: "abort" }); });
  filesButton.addEventListener("click", openFiles);
  filesClose.addEventListener("click", closeFiles);
  filesBack.addEventListener("click", () => {
    if (!fileViewer.hidden) {
      listDirectory(currentDirectory);
      return;
    }
    if (currentDirectory === ".") return;
    const normalized = currentDirectory.replace(/[\\\\/]$/, "");
    const separator = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\\\"));
    listDirectory(separator < 0 ? "." : normalized.slice(0, separator) || ".");
  });
  historyRefresh.addEventListener("click", listSessions);
  historyDetailClose.addEventListener("click", () => { historyDetail.hidden = true; });
  thinkingSelect.addEventListener("change", () => { command({ name: "set_thinking", level: thinkingSelect.value }); });
  logoutButton.addEventListener("click", () => {
    manuallyDisconnected = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    const oldSocket = socket;
    socket = null;
    if (oldSocket) {
      try { oldSocket.close(1000, "user disconnected"); } catch {}
    }
    relayReady = false;
    storageRemove("pi-collab-token");
    storageRemove("pi-collab-host-id");
    activeToken = null;
    activeRoom = null;
    snapshot = null;
    knownHosts = new Map();
    hostSnapshots = new Map();
    hostRetryContexts = new Map();
    pendingRequests = new Map();
    selectedHostId = null;
    clearNotices();
    clearSelectedPanels();
    filesPanel.classList.remove("open");
    promptInput.value = "";
    appView.hidden = true;
    loginView.hidden = false;
    tokenInput.value = "";
    setConnection("未连接");
  });

  const savedToken = activeToken;
  const savedRoom = activeRoom;
  const isLoopback = location.hostname === "127.0.0.1" || location.hostname === "localhost" || location.hostname === "::1" || location.hostname === "[::1]";
  if ((savedToken && isValidRoomId(savedRoom || "main")) || isLoopback) {
    if (!savedToken) {
      activeToken = "local-dev-client-token";
      storageSet("pi-collab-token", activeToken);
    }
    activeRoom = savedRoom && isValidRoomId(savedRoom) ? savedRoom : "main";
    storageSet("pi-collab-room", activeRoom);
    roomInput.value = activeRoom;
    loginView.hidden = true;
    appView.hidden = false;
    connect();
  }
})();
