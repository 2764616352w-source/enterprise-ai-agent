(function () {
  "use strict";

  /* ---------- 常量 ---------- */
  var API = {
    chat: "/api/v1/chat",
    chatStream: "/api/v1/chat/stream",
    docs: "/api/v1/documents",
    docsUpload: "/api/v1/documents/upload",
    health: "/api/v1/health",
    healthReady: "/api/v1/health/ready"
  };

  var AUTO_REFRESH_MS = 15000;

  var GREETING =
    "你好，我是企业 AI Agent。\n" +
    "我已接入你的文档库，可以结合检索结果回答业务问题。\n" +
    "当前会话保持多轮上下文，我会记住上文内容；需要开始新话题时，请点击右上角「清空」。";

  var STATUS_MAP = [
    { keys: ["processing", "pending", "indexing", "uploading", "queued"], label: "处理中", cls: "warn" },
    { keys: ["uploaded", "ready", "active", "completed", "done", "success", "ok"], label: "已就绪", cls: "ok" },
    { keys: ["failed", "error", "dead", "rejected"], label: "失败", cls: "danger" }
  ];

  var HEALTH_OK = ["ok", "up", "healthy", "ready", "pass", "passing"];

  /* ---------- 状态 ---------- */
  var state = {
    messages: [{ role: "assistant", content: GREETING, ts: Date.now() }],
    busy: false
  };

  /* ---------- DOM ---------- */
  var el = {
    navItems: document.querySelectorAll(".nav-item"),
    sections: document.querySelectorAll(".view"),
    toasts: document.getElementById("toasts"),
    chatScroll: document.getElementById("chat-scroll"),
    chatMessages: document.getElementById("chat-messages"),
    chatInput: document.getElementById("chat-input"),
    btnSend: document.getElementById("btn-send"),
    btnClear: document.getElementById("btn-clear"),
    chkNonstream: document.getElementById("chk-nonstream"),
    pModel: document.getElementById("p-model"),
    pTemp: document.getElementById("p-temperature"),
    pTokens: document.getElementById("p-max-tokens"),
    dropzone: document.getElementById("dropzone"),
    fileInput: document.getElementById("file-input"),
    uploadProgress: document.getElementById("upload-progress"),
    uploadProgressLabel: document.getElementById("upload-progress-label"),
    uploadProgressBar: document.getElementById("upload-progress-bar"),
    docsTbody: document.getElementById("docs-tbody"),
    docsCount: document.getElementById("docs-count"),
    docsEmpty: document.getElementById("docs-empty"),
    docsError: document.getElementById("docs-error"),
    btnDocsRefresh: document.getElementById("btn-docs-refresh"),
    chkAutoRefresh: document.getElementById("chk-auto-refresh"),
    btnHealthRefresh: document.getElementById("btn-health-refresh"),
    btnHealthRefresh2: document.getElementById("btn-health-refresh2"),
    healthUpdated: document.getElementById("health-updated"),
    healthError: document.getElementById("health-error"),
    hcDotService: document.getElementById("hc-dot-service"),
    hcValService: document.getElementById("hc-val-service"),
    hcDotDb: document.getElementById("hc-dot-db"),
    hcValDb: document.getElementById("hc-val-db"),
    hcValEnv: document.getElementById("hc-val-env"),
    sidebarStatus: document.querySelector(".side-status"),
    sidebarStatusText: document.querySelector(".side-status-text")
  };

  var healthTimer = null;

  /* ---------- 工具函数 ---------- */

  function storageGet(key, fallback) {
    try {
      var v = localStorage.getItem("ai-console:" + key);
      return v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem("ai-console:" + key, value);
    } catch (e) {
      /* 忽略存储失败 */
    }
  }

  function toast(message, type) {
    var t = document.createElement("div");
    t.className = "toast toast-" + (type || "info");
    t.textContent = message;
    el.toasts.appendChild(t);
    var gone = false;
    function remove() {
      if (gone) return;
      gone = true;
      t.classList.add("is-leaving");
      setTimeout(function () { t.remove(); }, 180);
    }
    setTimeout(remove, 4200);
    t.addEventListener("click", remove);
  }

  async function readApiError(res) {
    var msg = "请求失败（HTTP " + res.status + "）";
    try {
      var j = await res.json();
      if (j && j.detail !== undefined && j.detail !== null) {
        msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
      } else if (j && j.message) {
        msg = j.message;
      }
    } catch (e) {
      /* 响应体不是 JSON，保留默认信息 */
    }
    return msg;
  }

  async function apiJSON(url, options) {
    options = options || {};
    if (options.cache === undefined) options.cache = "no-store";
    var res = await fetch(url, options);
    if (!res.ok) throw new Error(await readApiError(res));
    return res.json();
  }

  function iconDoc() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h6"/></svg>';
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* ---------- 视图切换 ---------- */

  function showView(name) {
    for (var i = 0; i < el.navItems.length; i++) {
      el.navItems[i].classList.toggle("is-active", el.navItems[i].getAttribute("data-view") === name);
    }
    for (var j = 0; j < el.sections.length; j++) {
      var active = el.sections[j].id === "view-" + name;
      el.sections[j].hidden = !active;
      el.sections[j].classList.toggle("is-active", active);
    }
    storageSet("view", name);
  }

  function wireNav() {
    for (var i = 0; i < el.navItems.length; i++) {
      el.navItems[i].addEventListener("click", function () {
        showView(this.getAttribute("data-view"));
      });
    }
  }

  /* ---------- AI 对话 ---------- */

  function nowHM(ts) {
    var d = new Date(ts);
    function p(n) { return n < 10 ? "0" + n : "" + n; }
    return p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function appendMessageEl(m) {
    var row = document.createElement("div");
    var isUser = m.role === "user";
    row.className = "msg " + (isUser ? "msg-user" : "msg-assistant");

    var avatar = document.createElement("div");
    avatar.className = "msg-avatar";
    avatar.textContent = isUser ? "我" : "AI";

    var body = document.createElement("div");
    body.className = "msg-body";

    var role = document.createElement("div");
    role.className = "msg-role";
    role.textContent = isUser ? "你 · USER" : "Agent · ASSISTANT";

    var bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = m.content;

    var meta = document.createElement("div");
    meta.className = "chat-meta";
    meta.textContent = m.ts ? nowHM(m.ts) : "";

    body.appendChild(role);
    body.appendChild(bubble);
    body.appendChild(meta);
    row.appendChild(avatar);
    row.appendChild(body);
    el.chatMessages.appendChild(row);
    return bubble;
  }

  function renderMessages() {
    el.chatMessages.textContent = "";
    for (var i = 0; i < state.messages.length; i++) {
      var m = state.messages[i];
      if (typeof m.content === "string" && m.content.length > 0) appendMessageEl(m);
    }
    stickToBottom(true);
  }

  function stickToBottom(force) {
    var near = el.chatScroll.scrollHeight - el.chatScroll.scrollTop - el.chatScroll.clientHeight < 40;
    if (force || near) el.chatScroll.scrollTop = el.chatScroll.scrollHeight;
  }

  function autoResize() {
    var t = el.chatInput;
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight, 180) + "px";
  }

  function setBusy(busy) {
    state.busy = busy;
    el.btnSend.disabled = busy;
  }

  function buildBody(messages) {
    var body = { messages: messages };
    var model = el.pModel.value.trim();
    var temp = parseFloat(el.pTemp.value);
    var tokens = parseInt(el.pTokens.value, 10);
    if (model) body.model = model;
    if (!isNaN(temp) && temp >= 0 && temp <= 2 && el.pTemp.value !== "") body.temperature = temp;
    if (!isNaN(tokens) && tokens > 0) body.max_tokens = tokens;
    return body;
  }

  function createAssistantBubble() {
    var row = document.createElement("div");
    row.className = "msg msg-assistant";

    var avatar = document.createElement("div");
    avatar.className = "msg-avatar";
    avatar.textContent = "AI";

    var body = document.createElement("div");
    body.className = "msg-body";

    var role = document.createElement("div");
    role.className = "msg-role";
    role.textContent = "Agent · ASSISTANT";

    var bubble = document.createElement("div");
    bubble.className = "bubble";
    var text = document.createElement("span");
    var caret = document.createElement("span");
    caret.className = "caret";
    bubble.appendChild(text);
    bubble.appendChild(caret);

    body.appendChild(role);
    body.appendChild(bubble);
    row.appendChild(avatar);
    row.appendChild(body);
    el.chatMessages.appendChild(row);
    return {
      root: row,
      bubble: bubble,
      text: text,
      caret: caret
    };
  }

  function renderErrorInline(message) {
    var row = document.createElement("div");
    row.className = "msg msg-assistant";

    var avatar = document.createElement("div");
    avatar.className = "msg-avatar";
    avatar.textContent = "AI";

    var body = document.createElement("div");
    body.className = "msg-body";

    var role = document.createElement("div");
    role.className = "msg-role";
    role.textContent = "Agent · ERROR";

    var bubble = document.createElement("div");
    bubble.className = "bubble msg-error";
    bubble.textContent = message;

    body.appendChild(role);
    body.appendChild(bubble);
    row.appendChild(avatar);
    row.appendChild(body);
    el.chatMessages.appendChild(row);
    stickToBottom(true);
  }

  function finishBubble(b, mainText, fullText) {
    b.caret.remove();
    var text = fullText === undefined ? mainText : fullText;
    if (mainText) b.text.textContent = mainText;
    if (text) state.messages.push({ role: "assistant", content: text, ts: Date.now() });
    stickToBottom(true);
  }

  function renderCitations(b, json) {
    var cites = (json && json.citations) || [];
    if (!cites.length) return;
    var wrap = document.createElement("div");
    wrap.className = "cites";
    var head = document.createElement("div");
    head.className = "cites-head";
    head.textContent = "检索引用";
    wrap.appendChild(head);
    for (var i = 0; i < cites.length; i++) {
      var c = cites[i] || {};
      var item = document.createElement("div");
      item.className = "cite-item";
      var idx = document.createElement("span");
      idx.className = "cite-idx";
      idx.textContent = "[" + c.index + "]";
      var txt = document.createElement("span");
      txt.className = "cite-text";
      txt.textContent = c.snippet || "";
      item.appendChild(idx);
      item.appendChild(txt);
      wrap.appendChild(item);
    }
    b.bubble.appendChild(wrap);
    stickToBottom(true);
  }

  async function runStream(messages) {
    var res = await fetch(API.chatStream, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildBody(messages))
    });
    if (!res.ok) throw new Error(await readApiError(res));
    if (!res.body) throw new Error("当前环境不支持流式响应，请改用「非流式」模式");

    var b = createAssistantBubble();
    var acc = "";
    var reader = res.body.getReader();
    var decoder = new TextDecoder("utf-8");
    var buffer = "";
    var doneEvt = null;

    function processLine(line) {
      var s = line.trim();
      if (s.indexOf("data:") !== 0) return;
      var raw = s.slice(5).trim();
      if (!raw) return;
      var evt;
      try {
        evt = JSON.parse(raw);
      } catch (e) {
        console.warn("无法解析流事件:", raw);
        return;
      }
      if (evt && evt.error) {
        throw new Error(typeof evt.error === "string" ? evt.error : JSON.stringify(evt.error));
      }
      if (evt && evt.done) {
        doneEvt = evt;
        return "done";
      }
      var piece = (evt && evt.content) || (evt && evt.choices && evt.choices[0] && evt.choices[0].delta && evt.choices[0].delta.content) || "";
      if (piece) {
        acc += piece;
        b.text.textContent = acc;
        stickToBottom(false);
      }
    }

    function finishStream() {
      finishBubble(b, acc, acc);
      if (doneEvt) renderCitations(b, doneEvt);
      stickToBottom(true);
    }

    try {
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var idx;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          var line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          var r = processLine(line);
          if (r === "done") {
            finishStream();
            return;
          }
        }
      }
      buffer += decoder.decode();
      var end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        var line2 = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        var rr = processLine(line2);
        if (rr === "done") {
          finishStream();
          return;
        }
      }
      finishStream();
    } catch (err) {
      finishStream();
      throw err;
    }
  }

  async function runNonStream(messages) {
    var json = await apiJSON(API.chat, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildBody(messages))
    });
    var content = (json && json.content) || (json && json.answer) || (json && json.message) || "";
    var b = createAssistantBubble();
    var text = content || "（服务返回了空内容）";
    finishBubble(b, text, content || "");
    if (json && json.citations) renderCitations(b, json);
  }

  async function sendMessage() {
    if (state.busy) return;
    var text = el.chatInput.value.trim();
    if (!text) return;

    state.messages.push({ role: "user", content: text, ts: Date.now() });
    appendMessageEl({ role: "user", content: text, ts: Date.now() });
    stickToBottom(true);
    el.chatInput.value = "";
    autoResize();
    setBusy(true);

    try {
      if (el.chkNonstream.checked) {
        await runNonStream(state.messages);
      } else {
        await runStream(state.messages);
      }
    } catch (err) {
      renderErrorInline(err && err.message ? err.message : "请求失败，请稍后重试");
      toast(err && err.message ? err.message : "请求失败，请检查后端服务", "error");
    } finally {
      setBusy(false);
      el.chatInput.focus();
    }
  }

  function clearChat() {
    if (state.busy) return;
    state.messages = [{ role: "assistant", content: GREETING, ts: Date.now() }];
    renderMessages();
    toast("会话已清空，多轮上下文已重置", "info");
    el.chatInput.focus();
  }

  function wireChat() {
    el.btnSend.addEventListener("click", sendMessage);
    el.btnClear.addEventListener("click", clearChat);
    el.chatInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendMessage();
      }
    });
    el.chatInput.addEventListener("input", autoResize);
  }

  /* ---------- 文档库 ---------- */

  function statusInfo(raw) {
    var s = String(raw || "").toLowerCase();
    for (var i = 0; i < STATUS_MAP.length; i++) {
      if (STATUS_MAP[i].keys.indexOf(s) !== -1) {
        return { label: STATUS_MAP[i].label, cls: STATUS_MAP[i].cls };
      }
    }
    return { label: raw && raw !== "" ? raw : "未知", cls: "muted" };
  }

  function renderDocs(docs) {
    var list = Array.isArray(docs) ? docs : [];
    el.docsCount.textContent = list.length + " 项";
    el.docsTbody.textContent = "";

    var showEmpty = list.length === 0;
    el.docsEmpty.hidden = !showEmpty;
    document.querySelector(".table-wrap").style.display = showEmpty ? "none" : "";

    for (var i = 0; i < list.length; i++) {
      var d = list[i] || {};
      var st = statusInfo(d.status);
      var tr = document.createElement("tr");

      var fileCell = document.createElement("td");
      fileCell.className = "cell-file";
      fileCell.innerHTML = '<span class="file-ico">' + iconDoc() + "</span><span class=\"file-name\">" + esc(d.filename || "(未命名)") + "</span>";

      var typeCell = document.createElement("td");
      typeCell.className = "cell-type";
      typeCell.textContent = d.mime_type || "—";

      var statusCell = document.createElement("td");
      var badge = document.createElement("span");
      badge.className = "badge badge-" + st.cls;
      badge.textContent = st.label;
      statusCell.appendChild(badge);

      var timeCell = document.createElement("td");
      timeCell.className = "cell-time";
      timeCell.textContent = formatTime(d.created_at);

      tr.appendChild(fileCell);
      tr.appendChild(typeCell);
      tr.appendChild(statusCell);
      tr.appendChild(timeCell);
      el.docsTbody.appendChild(tr);
    }
  }

  function formatTime(v) {
    if (!v) return "—";
    var d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleString("zh-CN", { hour12: false });
  }

  function hideDocsError() { el.docsError.hidden = true; }
  function showDocsError(msg) {
    el.docsError.textContent = msg;
    el.docsError.hidden = false;
  }

  async function refreshDocs() {
    el.btnDocsRefresh.disabled = true;
    hideDocsError();
    try {
      var docs = await apiJSON(API.docs);
      renderDocs(docs);
    } catch (err) {
      showDocsError("加载文档列表失败：" + (err && err.message ? err.message : "网络错误"));
      toast("加载文档列表失败：" + (err && err.message ? err.message : "网络错误"), "error");
    } finally {
      el.btnDocsRefresh.disabled = false;
    }
  }

  function setUploadProgress(percent, label, cls) {
    el.uploadProgress.hidden = false;
    el.uploadProgress.className = "upload-progress" + (cls ? " " + cls : "");
    el.uploadProgressLabel.textContent = label;
    el.uploadProgressBar.style.width = percent + "%";
  }

  function hideUploadProgress() {
    setTimeout(function () {
      el.uploadProgress.hidden = true;
      el.uploadProgressBar.style.width = "0%";
      el.uploadProgress.className = "upload-progress";
    }, 1200);
  }

  async function uploadFile(file) {
    if (!file) return;
    var fd = new FormData();
    fd.append("file", file, file.name);
    setUploadProgress(20, "上传中 " + file.name + " (" + formatBytes(file.size) + ")");
    requestAnimationFrame(function () { setUploadProgress(85, "上传中 " + file.name + " · 等待处理…"); });

    try {
      var res = await fetch(API.docsUpload, { method: "POST", body: fd });
      if (!res.ok) throw new Error(await readApiError(res));
      var j = await res.json().catch(function () { return {}; });
      var chunkCount = j && j.chunk_count !== undefined ? j.chunk_count : "—";
      var st = j && j.status ? String(j.status) : "—";
      setUploadProgress(100, "已上传 " + file.name + " · 分块 " + chunkCount + " · 状态 " + st, "is-ok");
      toast("上传成功「" + file.name + "」\n分块 " + chunkCount + " · 状态 " + st, "ok");
      hideUploadProgress();
      refreshDocs();
    } catch (err) {
      setUploadProgress(100, "上传失败 " + file.name, "is-err");
      toast("上传失败「" + file.name + "」：" + (err && err.message ? err.message : "网络错误"), "error");
      setTimeout(function () {
        el.uploadProgress.hidden = true;
        el.uploadProgress.className = "upload-progress";
        el.uploadProgressBar.style.width = "0%";
      }, 1800);
    }
  }

  function formatBytes(n) {
    if (!n) return "0 B";
    var units = ["B", "KB", "MB", "GB"];
    var i = 0;
    var v = n;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + " " + units[i];
  }

  function wireDocs() {
    el.btnDocsRefresh.addEventListener("click", refreshDocs);

    el.dropzone.addEventListener("click", function () { el.fileInput.click(); });
    el.dropzone.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        el.fileInput.click();
      }
    });
    el.fileInput.addEventListener("change", function () {
      for (var i = 0; i < el.fileInput.files.length; i++) uploadFile(el.fileInput.files[i]);
      el.fileInput.value = "";
    });

    ["dragenter", "dragover"].forEach(function (type) {
      el.dropzone.addEventListener(type, function (e) {
        e.preventDefault();
        e.stopPropagation();
        el.dropzone.classList.add("is-dragover");
      });
    });
    ["dragleave", "drop"].forEach(function (type) {
      el.dropzone.addEventListener(type, function (e) {
        e.preventDefault();
        e.stopPropagation();
        el.dropzone.classList.remove("is-dragover");
      });
    });
    el.dropzone.addEventListener("drop", function (e) {
      var files = e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files : [];
      for (var i = 0; i < files.length; i++) uploadFile(files[i]);
    });
  }

  /* ---------- 系统状态 ---------- */

  function healthInfo(v) {
    var s = String(v == null ? "" : v).toLowerCase();
    if (HEALTH_OK.indexOf(s) !== -1) return { label: v == null || v === "" ? "正常" : String(v), cls: "ok" };
    if (["degraded", "warn", "warning", "starting", "starting_up", "initializing", "notready", "not_ready", "unavailable"].indexOf(s) !== -1) {
      return { label: v == null || v === "" ? "降级" : String(v), cls: "warn" };
    }
    if (["down", "fail", "failed", "error", "dead", "critical", "offline", "disconnected"].indexOf(s) !== -1) {
      return { label: v == null || v === "" ? "异常" : String(v), cls: "danger" };
    }
    return { label: v == null || v === "" ? "未知" : String(v), cls: "muted" };
  }

  function setValue(elDot, elValue, v) {
    var info = healthInfo(v);
    elDot.className = "dot dot-" + info.cls;
    elValue.textContent = info.label;
    elValue.className = "health-value mono is-" + info.cls;
  }

  function setSidebarStatus(cls, text) {
    var dot = el.sidebarStatus.querySelector(".dot");
    dot.className = "dot dot-" + cls;
    el.sidebarStatusText.textContent = text;
  }

  function hideHealthError() { el.healthError.hidden = true; }
  function showHealthError(msg) {
    el.healthError.textContent = msg;
    el.healthError.hidden = false;
  }

  async function refreshHealth() {
    setSidebarStatus("running", "服务 · 检查中");
    try {
      var results = await Promise.all([
        apiJSON(API.health),
        apiJSON(API.healthReady)
      ]);
      var h = results[0] || {};
      var rd = results[1] || {};

      setValue(el.hcDotService, el.hcValService, h.status !== undefined ? h.status : "ok");
      setValue(el.hcDotDb, el.hcValDb, rd.database !== undefined && rd.database !== null ? rd.database : (rd.status !== undefined ? rd.status : "—"));
      el.hcValEnv.textContent = rd.app_env !== undefined && rd.app_env !== null ? String(rd.app_env) : "—";
      el.hcValEnv.className = "health-value mono";

      hideHealthError();
      var serviceOk = h.status !== undefined && HEALTH_OK.indexOf(String(h.status).toLowerCase()) !== -1;
      setSidebarStatus(serviceOk ? "ok" : "danger", serviceOk ? "服务 · 在线" : "服务 · 异常");
    } catch (err) {
      setValue(el.hcDotService, el.hcValService, "error");
      setValue(el.hcDotDb, el.hcValDb, "—");
      showHealthError("获取系统状态失败：" + (err && err.message ? err.message : "网络错误"));
      setSidebarStatus("danger", "服务 · 离线");
    } finally {
      el.healthUpdated.textContent = "最近更新 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
    }
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    healthTimer = setInterval(refreshHealth, AUTO_REFRESH_MS);
  }

  function stopAutoRefresh() {
    if (healthTimer) {
      clearInterval(healthTimer);
      healthTimer = null;
    }
  }

  function wireHealth() {
    el.btnHealthRefresh.addEventListener("click", refreshHealth);
    el.btnHealthRefresh2.addEventListener("click", refreshHealth);
    el.chkAutoRefresh.addEventListener("change", function () {
      storageSet("autoRefresh", el.chkAutoRefresh.checked ? "1" : "0");
      if (el.chkAutoRefresh.checked) startAutoRefresh();
      else stopAutoRefresh();
    });
  }

  /* ---------- 初始化 ---------- */

  function persistParams() {
    storageSet("model", el.pModel.value);
    storageSet("temperature", el.pTemp.value);
    storageSet("maxTokens", el.pTokens.value);
    storageSet("nonstream", el.chkNonstream.checked ? "1" : "0");
  }

  function restoreParams() {
    el.pModel.value = storageGet("model", "");
    var temp = storageGet("temperature", "0.7");
    el.pTemp.value = temp === "" ? "0.7" : temp;
    var tok = storageGet("maxTokens", "2048");
    el.pTokens.value = tok === "" ? "2048" : tok;
    el.chkNonstream.checked = storageGet("nonstream", "0") === "1";
    el.chkAutoRefresh.checked = storageGet("autoRefresh", "1") === "1";
    el.pModel.addEventListener("change", persistParams);
    el.pTemp.addEventListener("change", persistParams);
    el.pTokens.addEventListener("change", persistParams);
    el.chkNonstream.addEventListener("change", persistParams);
  }

  function init() {
    wireNav();
    wireChat();
    wireDocs();
    wireHealth();

    restoreParams();
    var savedView = storageGet("view", "chat");
    showView(savedView);

    renderMessages();
    refreshHealth();
    refreshDocs();
    if (el.chkAutoRefresh.checked) startAutoRefresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();