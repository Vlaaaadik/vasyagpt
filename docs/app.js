const API_BASE_URL = "https://vasya-bot.vbeskerov.workers.dev"; // Замените на URL вашего Cloudflare Worker (без слэша в конце)

(function () {
  "use strict";

  const STORAGE_KEYS = {
    CHATS: "vasya_chats_v1",
    ACTIVE_CHAT: "vasya_active_chat_v1",
    THEME: "vasya_theme_v1",
    THINKING: "vasya_thinking_v1"
  };

  // Состояние приложения
  let chats = [];
  let activeChatId = null;
  let thinkingLevel = "MEDIUM";
  let isImageMode = false;
  let isGenerating = false;
  let currentAbortController = null;
  let pendingAttachment = null; // { base64, mimeType, dataUrl, width, height, sizeKB }

  // DOM-элементы
  const sidebarEl = document.getElementById("sidebar");
  const sidebarBackdropEl = document.getElementById("sidebar-backdrop");
  const sidebarToggleBtn = document.getElementById("sidebar-toggle-btn");
  const sidebarCloseBtn = document.getElementById("sidebar-close-btn");
  const newChatBtn = document.getElementById("new-chat-btn");
  const chatListEl = document.getElementById("chat-list");
  const currentChatTitleEl = document.getElementById("current-chat-title");
  const chatMessagesEl = document.getElementById("chat-messages");
  const welcomeScreenEl = document.getElementById("welcome-screen");

  const themeToggleBtn = document.getElementById("theme-toggle-btn");
  const themeToggleSidebarBtn = document.getElementById("theme-toggle-sidebar");
  const themeIconHeaderEl = document.getElementById("theme-icon-header");
  const themeIconSidebarEl = document.getElementById("theme-icon-sidebar");
  const themeLabelSidebarEl = document.getElementById("theme-label-sidebar");
  const hljsThemeDarkEl = document.getElementById("hljs-theme-dark");
  const hljsThemeLightEl = document.getElementById("hljs-theme-light");

  const thinkingBtns = document.querySelectorAll(".thinking-btn");
  const chatFormEl = document.getElementById("chat-form");
  const promptInputEl = document.getElementById("prompt-input");
  const attachBtn = document.getElementById("attach-btn");
  const imageFileInputEl = document.getElementById("image-file-input");
  const imageModeBtn = document.getElementById("image-mode-btn");
  const sendBtn = document.getElementById("send-btn");
  const stopBtn = document.getElementById("stop-btn");

  const attachmentPreviewEl = document.getElementById("attachment-preview");
  const attachmentThumbEl = document.getElementById("attachment-thumb");
  const attachmentInfoEl = document.getElementById("attachment-info");
  const removeAttachmentBtn = document.getElementById("remove-attachment-btn");

  // --- Инициализация ---
  function init() {
    configureMarkdown();
    loadSettings();
    loadChats();
    bindEvents();
    renderChatList();
    renderActiveChat();
    updateComposerUI();
  }

  function configureMarkdown() {
    if (window.marked) {
      window.marked.setOptions({
        breaks: true,
        gfm: true
      });
    }
  }

  // --- Темы и настройки ---
  function loadSettings() {
    const savedTheme = localStorage.getItem(STORAGE_KEYS.THEME) || "dark";
    applyTheme(savedTheme);

    const savedThinking = localStorage.getItem(STORAGE_KEYS.THINKING) || "MEDIUM";
    setThinkingLevel(["LOW", "MEDIUM", "HIGH"].includes(savedThinking) ? savedThinking : "MEDIUM", false);
  }

  function applyTheme(theme) {
    const resolved = theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", resolved);
    localStorage.setItem(STORAGE_KEYS.THEME, resolved);

    const isLight = resolved === "light";
    themeIconHeaderEl.textContent = isLight ? "🌙" : "☀️";
    themeIconSidebarEl.textContent = isLight ? "🌙" : "☀️";
    themeLabelSidebarEl.textContent = isLight ? "Тёмная тема" : "Светлая тема";

    if (hljsThemeDarkEl && hljsThemeLightEl) {
      hljsThemeDarkEl.disabled = isLight;
      hljsThemeLightEl.disabled = !isLight;
    }
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") || "dark";
    applyTheme(current === "dark" ? "light" : "dark");
  }

  function setThinkingLevel(level, persist = true) {
    thinkingLevel = level;
    if (persist) {
      localStorage.setItem(STORAGE_KEYS.THINKING, level);
    }
    thinkingBtns.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.level === level);
    });
  }

  // --- Управление чатами в localStorage ---
  function generateId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return "chat_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
  }

  function createNewChatObject() {
    const now = Date.now();
    return {
      id: generateId(),
      title: "Новый чат",
      createdAt: now,
      updatedAt: now,
      messages: []
    };
  }

  function loadChats() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.CHATS);
      const parsed = raw ? JSON.parse(raw) : [];
      chats = Array.isArray(parsed) ? parsed : [];
    } catch {
      chats = [];
    }

    if (chats.length === 0) {
      const initialChat = createNewChatObject();
      chats.push(initialChat);
      activeChatId = initialChat.id;
      saveChats();
      return;
    }

    const savedActiveId = localStorage.getItem(STORAGE_KEYS.ACTIVE_CHAT);
    const exists = chats.some((c) => c.id === savedActiveId);
    activeChatId = exists ? savedActiveId : chats[0].id;
    localStorage.setItem(STORAGE_KEYS.ACTIVE_CHAT, activeChatId);
  }

  function saveChats() {
    localStorage.setItem(STORAGE_KEYS.ACTIVE_CHAT, activeChatId || "");
    try {
      localStorage.setItem(STORAGE_KEYS.CHATS, JSON.stringify(chats));
    } catch (err) {
      // Если localStorage переполнен из-за больших картинок, очищаем старые imageDataUrl
      if (err && (err.name === "QuotaExceededError" || err.code === 22)) {
        const trimmed = chats.map((chat) => ({
          ...chat,
          messages: chat.messages.map((msg) => ({
            ...msg,
            imageDataUrl: undefined,
            generatedImageUrl: undefined
          }))
        }));
        try {
          localStorage.setItem(STORAGE_KEYS.CHATS, JSON.stringify(trimmed));
        } catch {
          // Игнорируем, если хранилище полностью заблокировано
        }
      }
    }
  }

  function getActiveChat() {
    return chats.find((c) => c.id === activeChatId) || null;
  }

  function startNewChat() {
    if (isGenerating) stopGeneration();

    const current = getActiveChat();
    if (current && current.messages.length === 0) {
      closeMobileSidebar();
      promptInputEl.focus();
      return;
    }

    const newChat = createNewChatObject();
    chats.unshift(newChat);
    activeChatId = newChat.id;
    clearPendingAttachment();
    saveChats();
    renderChatList();
    renderActiveChat();
    closeMobileSidebar();
    promptInputEl.focus();
  }

  function selectChat(chatId) {
    if (chatId === activeChatId) {
      closeMobileSidebar();
      return;
    }
    if (isGenerating) stopGeneration();

    activeChatId = chatId;
    clearPendingAttachment();
    saveChats();
    renderChatList();
    renderActiveChat();
    closeMobileSidebar();
  }

  function deleteChat(chatId, event) {
    event.stopPropagation();
    const targetChat = chats.find((c) => c.id === chatId);
    if (!targetChat) return;

    if (isGenerating && activeChatId === chatId) {
      stopGeneration();
    }

    // Очищаем память на сервере в фоне
    if (API_BASE_URL && !API_BASE_URL.includes("ВАШ-ВОРКЕР")) {
      fetch(`${API_BASE_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: chatId, clearHistory: true })
      }).catch(() => {});
    }

    chats = chats.filter((c) => c.id !== chatId);
    if (chats.length === 0) {
      const fresh = createNewChatObject();
      chats.push(fresh);
      activeChatId = fresh.id;
    } else if (activeChatId === chatId) {
      activeChatId = chats[0].id;
    }

    saveChats();
    renderChatList();
    renderActiveChat();
  }

  // --- Сайдбар ---
  function toggleSidebar() {
    const isMobile = window.innerWidth <= 768;
    if (isMobile) {
      const open = sidebarEl.classList.toggle("mobile-open");
      sidebarBackdropEl.classList.toggle("visible", open);
    } else {
      sidebarEl.classList.toggle("collapsed");
    }
  }

  function closeMobileSidebar() {
    sidebarEl.classList.remove("mobile-open");
    sidebarBackdropEl.classList.remove("visible");
  }

  // --- Рендер списка чатов и сообщений ---
  function renderChatList() {
    chatListEl.innerHTML = "";
    const sorted = [...chats].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    sorted.forEach((chat) => {
      const item = document.createElement("div");
      item.className = "chat-item" + (chat.id === activeChatId ? " active" : "");
      item.setAttribute("role", "button");
      item.tabIndex = 0;

      const titleSpan = document.createElement("span");
      titleSpan.className = "chat-item-title";
      titleSpan.textContent = chat.title || "Новый чат";

      const delBtn = document.createElement("button");
      delBtn.className = "chat-item-delete";
      delBtn.type = "button";
      delBtn.title = "Удалить чат";
      delBtn.setAttribute("aria-label", "Удалить чат");
      delBtn.textContent = "×";
      delBtn.addEventListener("click", (e) => deleteChat(chat.id, e));

      item.appendChild(titleSpan);
      item.appendChild(delBtn);

      item.addEventListener("click", () => selectChat(chat.id));
      item.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selectChat(chat.id);
        }
      });

      chatListEl.appendChild(item);
    });
  }

  function renderActiveChat() {
    const chat = getActiveChat();
    currentChatTitleEl.textContent = chat ? chat.title : "Новый чат";

    // Удаляем все сообщения, оставляя welcomeScreenEl в DOM
    Array.from(chatMessagesEl.children).forEach((child) => {
      if (child !== welcomeScreenEl) {
        child.remove();
      }
    });

    if (!chat || chat.messages.length === 0) {
      welcomeScreenEl.classList.remove("hidden");
      return;
    }

    welcomeScreenEl.classList.add("hidden");
    chat.messages.forEach((msg) => {
      const row = buildMessageElement(msg);
      chatMessagesEl.appendChild(row);
    });

    scrollToBottom();
  }

  function createAssistantAvatar() {
    const avatar = document.createElement("div");
    avatar.className = "assistant-avatar";
    avatar.setAttribute("aria-hidden", "true");

    const img = document.createElement("img");
    img.src = "avatar.png";
    img.alt = "ВасяGPT";
    img.className = "vasya-avatar";

    avatar.appendChild(img);
    return avatar;
  }

  function buildMessageElement(msg) {
    const row = document.createElement("div");
    row.className = `message-row ${msg.role}`;

    if (msg.role === "assistant") {
      row.appendChild(createAssistantAvatar());
    }

    const bubble = document.createElement("div");
    bubble.className = "message-bubble" + (msg.isError ? " error-bubble" : "");

    if (msg.role === "user") {
      if (msg.imageDataUrl) {
        const img = document.createElement("img");
        img.className = "user-attached-image";
        img.src = msg.imageDataUrl;
        img.alt = "Прикреплённое изображение";
        bubble.appendChild(img);
      }
      if (msg.text) {
        const textDiv = document.createElement("div");
        textDiv.className = "user-text-content";
        textDiv.textContent = msg.text;
        bubble.appendChild(textDiv);
      }
    } else if (msg.generatedImageUrl) {
      const wrap = document.createElement("div");
      wrap.className = "generated-image-wrap";

      const img = document.createElement("img");
      img.className = "generated-image";
      img.src = msg.generatedImageUrl;
      img.alt = msg.imagePrompt || "Сгенерированное изображение";

      const actions = document.createElement("div");
      actions.className = "image-actions";

      const label = document.createElement("span");
      label.className = "image-prompt-label";
      label.textContent = msg.imagePrompt ? `Промпт: ${msg.imagePrompt}` : "Сгенерировано Flux-1";

      const downloadLink = document.createElement("a");
      downloadLink.className = "download-img-btn";
      downloadLink.href = msg.generatedImageUrl;
      downloadLink.download = `vasyagpt-${Date.now()}.png`;
      downloadLink.textContent = "⬇ Скачать";

      actions.appendChild(label);
      actions.appendChild(downloadLink);
      wrap.appendChild(img);
      wrap.appendChild(actions);
      bubble.appendChild(wrap);
    } else {
      const contentDiv = document.createElement("div");
      contentDiv.className = "markdown-body";
      renderSafeMarkdownAndMath(contentDiv, msg.text || "");
      bubble.appendChild(contentDiv);
    }

    row.appendChild(bubble);
    return row;
  }

  // --- Безопасный рендер Markdown + DOMPurify + highlight.js + KaTeX ---
  function escapeHtmlText(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function renderSafeMarkdownAndMath(container, rawText) {
    if (!rawText) {
      container.textContent = "";
      return;
    }

    // 1. Защищаем блоки кода, чтобы внутри них не искались формулы LaTeX
    const codePlaceholders = [];
    let working = rawText.replace(/```[\s\S]*?```|`[^`\n]+`/g, (match) => {
      const token = `@@VASYA_CODE_${codePlaceholders.length}@@`;
      codePlaceholders.push(match);
      return token;
    });

    // 2. Защищаем формулы LaTeX до прохода marked (чтобы _ и * внутри формул не ломались)
    const mathPlaceholders = [];
    const protectMath = (fullMatch) => {
      const token = `@@VASYA_MATH_${mathPlaceholders.length}@@`;
      mathPlaceholders.push(fullMatch);
      return token;
    };

    working = working
      .replace(/\$\$([\s\S]+?)\$\$/g, protectMath)
      .replace(/\\\[([\s\S]+?)\\\]/g, protectMath)
      .replace(/\\\(([\s\S]+?)\\\)/g, protectMath)
      .replace(/(?<!\\)\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g, protectMath);

    // Возвращаем код обратно перед marked.parse
    working = working.replace(/@@VASYA_CODE_(\d+)@@/g, (_, idx) => codePlaceholders[Number(idx)]);

    // 3. Парсим Markdown и обязательно очищаем HTML через DOMPurify
    const parsedHtml = window.marked ? window.marked.parse(working) : escapeHtmlText(working);
    let safeHtml = window.DOMPurify
      ? window.DOMPurify.sanitize(parsedHtml)
      : escapeHtmlText(working);

    // 4. Возвращаем экранированные LaTeX-формулы, чтобы KaTeX auto-render их отрисовал без XSS
    safeHtml = safeHtml.replace(/@@VASYA_MATH_(\d+)@@/g, (_, idx) =>
      escapeHtmlText(mathPlaceholders[Number(idx)])
    );

    container.innerHTML = safeHtml;

    // 5. Безопасные внешние ссылки
    container.querySelectorAll("a[href]").forEach((a) => {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    });

    // 6. Рендер формул через KaTeX auto-render
    if (typeof window.renderMathInElement === "function") {
      try {
        window.renderMathInElement(container, {
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "$", right: "$", display: false },
            { left: "\\[", right: "\\]", display: true },
            { left: "\\(", right: "\\)", display: false }
          ],
          throwOnError: false,
          ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"]
        });
      } catch (e) {
        console.warn("KaTeX render warning:", e);
      }
    }

    // 7. Подсветка кода (highlight.js) + кнопки «Копировать»
    enhanceCodeBlocks(container);
  }

  function enhanceCodeBlocks(container) {
    const preElements = container.querySelectorAll("pre");
    preElements.forEach((pre) => {
      if (pre.parentElement && pre.parentElement.classList.contains("code-block-wrapper")) {
        return;
      }

      const codeEl = pre.querySelector("code");
      let langLabel = "code";
      if (codeEl) {
        const langClass = Array.from(codeEl.classList).find((cls) => cls.startsWith("language-"));
        if (langClass) {
          langLabel = langClass.replace("language-", "");
        }
        if (window.hljs && typeof window.hljs.highlightElement === "function") {
          try {
            window.hljs.highlightElement(codeEl);
          } catch {}
        }
      }

      const wrapper = document.createElement("div");
      wrapper.className = "code-block-wrapper";

      const header = document.createElement("div");
      header.className = "code-block-header";

      const langSpan = document.createElement("span");
      langSpan.className = "code-lang-label";
      langSpan.textContent = langLabel;

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "copy-code-btn";
      copyBtn.textContent = "Копировать";

      copyBtn.addEventListener("click", async () => {
        const textToCopy = codeEl ? codeEl.textContent : pre.textContent;
        try {
          await navigator.clipboard.writeText(textToCopy || "");
          copyBtn.textContent = "Скопировано ✓";
          copyBtn.classList.add("copied");
          setTimeout(() => {
            copyBtn.textContent = "Копировать";
            copyBtn.classList.remove("copied");
          }, 1800);
        } catch {
          copyBtn.textContent = "Ошибка";
        }
      });

      header.appendChild(langSpan);
      header.appendChild(copyBtn);

      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(header);
      wrapper.appendChild(pre);
    });
  }

  // --- Сжатие фото через Canvas для Vision ---
  async function compressImageFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Не удалось прочитать файл изображения"));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("Повреждённое или неподдерживаемое изображение"));
        img.onload = () => {
          const maxSide = 1280;
          let targetW = img.width;
          let targetH = img.height;

          if (targetW > maxSide || targetH > maxSide) {
            if (targetW >= targetH) {
              targetH = Math.round((targetH * maxSide) / targetW);
              targetW = maxSide;
            } else {
              targetW = Math.round((targetW * maxSide) / targetH);
              targetH = maxSide;
            }
          }

          const canvas = document.createElement("canvas");
          canvas.width = targetW;
          canvas.height = targetH;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, targetW, targetH);

          const mimeType = "image/jpeg";
          const dataUrl = canvas.toDataURL(mimeType, 0.82);
          const base64 = dataUrl.split(",")[1];
          const sizeKB = Math.round((base64.length * 3) / 4 / 1024);

          resolve({
            base64,
            mimeType,
            dataUrl,
            width: targetW,
            height: targetH,
            sizeKB
          });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function handleSelectedImageFile(file) {
    if (!file || !file.type.startsWith("image/")) return;

    try {
      const compressed = await compressImageFile(file);
      pendingAttachment = compressed;
      if (isImageMode) {
        toggleImageMode(false);
      }
      attachmentThumbEl.src = compressed.dataUrl;
      attachmentInfoEl.textContent = `Сжато для Vision: ${compressed.width}×${compressed.height} (~${compressed.sizeKB} КБ)`;
      attachmentPreviewEl.classList.remove("hidden");
      updateComposerUI();
    } catch (err) {
      alert(err.message || "Ошибка сжатия изображения");
    }
  }

  function clearPendingAttachment() {
    pendingAttachment = null;
    imageFileInputEl.value = "";
    attachmentThumbEl.src = "";
    attachmentPreviewEl.classList.add("hidden");
    updateComposerUI();
  }

  // --- Режим генерации картинок ---
  function toggleImageMode(forceValue) {
    isImageMode = typeof forceValue === "boolean" ? forceValue : !isImageMode;
    imageModeBtn.classList.toggle("active", isImageMode);
    imageModeBtn.setAttribute("aria-pressed", String(isImageMode));
    chatFormEl.classList.toggle("image-mode-active", isImageMode);

    if (isImageMode && pendingAttachment) {
      clearPendingAttachment();
    }

    attachBtn.disabled = isImageMode;
    promptInputEl.placeholder = isImageMode
      ? "Опишите картинку для генерации (желательно на английском)..."
      : "Напишите сообщение Васе...";
    updateComposerUI();
  }

  // --- Управление вводом и генерацией ---
  function autoResizeTextarea() {
    promptInputEl.style.height = "auto";
    promptInputEl.style.height = Math.min(promptInputEl.scrollHeight, 180) + "px";
  }

  function updateComposerUI() {
    const hasText = promptInputEl.value.trim().length > 0;
    const canSend = !isGenerating && (hasText || Boolean(pendingAttachment));

    sendBtn.disabled = !canSend;
    sendBtn.classList.toggle("hidden", isGenerating);
    stopBtn.classList.toggle("hidden", !isGenerating);
    promptInputEl.disabled = isGenerating;
    attachBtn.disabled = isGenerating || isImageMode;
  }

  function isNearBottom() {
    return chatMessagesEl.scrollHeight - chatMessagesEl.scrollTop - chatMessagesEl.clientHeight < 140;
  }

  function scrollToBottom(instant = false) {
    if (instant) {
      chatMessagesEl.scrollTo({ top: chatMessagesEl.scrollHeight, behavior: "auto" });
    } else {
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    }
  }

  function appendStreamingCursor(container) {
    const cursor = document.createElement("span");
    cursor.className = "streaming-cursor";
    cursor.setAttribute("aria-hidden", "true");

    let target = container;
    const lastEl = container.lastElementChild;
    if (lastEl) {
      if (/^(P|H[1-6]|BLOCKQUOTE)$/.test(lastEl.tagName)) {
        target = lastEl;
      } else if ((lastEl.tagName === "UL" || lastEl.tagName === "OL") && lastEl.lastElementChild) {
        target = lastEl.lastElementChild;
      }
    }
    target.appendChild(cursor);
  }

  function showLoadingIndicator(labelText) {
    const row = document.createElement("div");
    row.className = "message-row assistant loading-row";

    const avatar = createAssistantAvatar();

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    bubble.innerHTML = `
      <div class="typing-indicator">
        <div class="typing-dots"><span></span><span></span><span></span></div>
        <span>${escapeHtmlText(labelText)}</span>
      </div>
    `;

    row.appendChild(avatar);
    row.appendChild(bubble);
    chatMessagesEl.appendChild(row);
    scrollToBottom();
    return row;
  }

  function stopGeneration() {
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }
    isGenerating = false;
    updateComposerUI();
  }

  function detectImageMimeFromBase64(b64) {
    if (b64.startsWith("/9j/")) return "image/jpeg";
    if (b64.startsWith("iVBOR")) return "image/png";
    if (b64.startsWith("UklGR")) return "image/webp";
    return "image/jpeg";
  }

  async function handleSubmit(event) {
    if (event) event.preventDefault();
    if (isGenerating) return;

    const rawText = promptInputEl.value.trim();
    const attachment = pendingAttachment;

    if (!rawText && !attachment) return;

    const chat = getActiveChat();
    if (!chat) return;

    // Определяем, нужно ли генерировать изображение (кнопка режима или команда /img)
    const imgCmdMatch = rawText.match(/^\/img\s+([\s\S]+)$/i);
    const shouldGenerateImage = isImageMode || Boolean(imgCmdMatch);
    const imagePrompt = imgCmdMatch ? imgCmdMatch[1].trim() : rawText;

    // Добавляем сообщение пользователя в историю
    const userMsg = {
      role: "user",
      text: rawText || "Опиши это изображение",
      imageDataUrl: attachment ? attachment.dataUrl : undefined,
      timestamp: Date.now()
    };

    chat.messages.push(userMsg);
    if (chat.title === "Новый чат" || chat.messages.length === 1) {
      const baseTitle = rawText || "Анализ фото";
      chat.title = baseTitle.length > 36 ? baseTitle.slice(0, 36) + "…" : baseTitle;
    }
    chat.updatedAt = Date.now();

    // Очищаем поле ввода
    promptInputEl.value = "";
    autoResizeTextarea();
    clearPendingAttachment();

    welcomeScreenEl.classList.add("hidden");
    currentChatTitleEl.textContent = chat.title;
    chatMessagesEl.appendChild(buildMessageElement(userMsg));
    saveChats();
    renderChatList();
    scrollToBottom();

    // Запускаем запрос с AbortController
    isGenerating = true;
    currentAbortController = new AbortController();
    updateComposerUI();

    const loadingRow = showLoadingIndicator(
      shouldGenerateImage ? "Генерация изображения..." : "Вася печатает..."
    );

    let streamingRow = null;
    let streamingContentEl = null;
    let accumulatedText = "";
    let renderRafId = null;

    const cancelScheduledRender = () => {
      if (renderRafId !== null) {
        cancelAnimationFrame(renderRafId);
        renderRafId = null;
      }
    };

    const ensureStreamingBubble = () => {
      if (streamingRow) return;
      loadingRow.remove();
      streamingRow = buildMessageElement({ role: "assistant", text: "" });
      streamingContentEl = streamingRow.querySelector(".markdown-body");
      if (activeChatId === chat.id) {
        chatMessagesEl.appendChild(streamingRow);
      }
    };

    const renderStreamingFrame = (withCursor) => {
      if (!streamingContentEl) return;
      const shouldScroll = isNearBottom();
      renderSafeMarkdownAndMath(streamingContentEl, accumulatedText);
      if (withCursor) {
        appendStreamingCursor(streamingContentEl);
      }
      if (shouldScroll && activeChatId === chat.id) {
        scrollToBottom(true);
      }
    };

    const scheduleStreamingRender = () => {
      if (renderRafId !== null) return;
      renderRafId = requestAnimationFrame(() => {
        renderRafId = null;
        renderStreamingFrame(true);
      });
    };

    try {
      if (API_BASE_URL.includes("ВАШ-ВОРКЕР")) {
        throw new Error(
          "Укажите URL вашего Cloudflare Worker в первой строке файла docs/app.js (переменная API_BASE_URL)."
        );
      }

      if (shouldGenerateImage) {
        const resp = await fetch(`${API_BASE_URL}/api/image`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: imagePrompt }),
          signal: currentAbortController.signal
        });

        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.imageBase64) {
          throw new Error(data.error || `Ошибка сервера (${resp.status})`);
        }

        const mime = detectImageMimeFromBase64(data.imageBase64);
        const assistantMsg = {
          role: "assistant",
          generatedImageUrl: `data:${mime};base64,${data.imageBase64}`,
          imagePrompt,
          timestamp: Date.now()
        };

        loadingRow.remove();
        chat.messages.push(assistantMsg);
        chat.updatedAt = Date.now();
        if (activeChatId === chat.id) {
          chatMessagesEl.appendChild(buildMessageElement(assistantMsg));
          scrollToBottom();
        }
        saveChats();
      } else {
        const resp = await fetch(`${API_BASE_URL}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: chat.id,
            message: rawText,
            imageBase64: attachment ? attachment.base64 : undefined,
            imageMimeType: attachment ? attachment.mimeType : undefined,
            thinkingLevel,
            stream: true
          }),
          signal: currentAbortController.signal
        });

        const contentType = (resp.headers.get("content-type") || "").toLowerCase();

        if (!resp.ok) {
          const errData = contentType.includes("application/json")
            ? await resp.json().catch(() => ({}))
            : {};
          throw new Error(errData.error || `Ошибка сервера (${resp.status})`);
        }

        // Фолбэк на обычный JSON-ответ, если сервер вернул не SSE
        if (contentType.includes("application/json") || !resp.body) {
          const data = await resp.json().catch(() => ({}));
          if (typeof data.reply !== "string") {
            throw new Error(data.error || `Ошибка сервера (${resp.status})`);
          }
          accumulatedText = data.reply;
        } else {
          const reader = resp.body.getReader();
          const decoder = new TextDecoder("utf-8");
          let sseBuffer = "";
          let streamDone = false;

          const processSseLine = (line) => {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) return;

            const payloadStr = trimmed.slice(5).trim();
            if (!payloadStr || payloadStr === "[DONE]") {
              streamDone = true;
              return;
            }

            let parsed;
            try {
              parsed = JSON.parse(payloadStr);
            } catch {
              return;
            }

            if (parsed.error) {
              throw new Error(parsed.error);
            }

            if (typeof parsed.text === "string" && parsed.text.length > 0) {
              ensureStreamingBubble();
              accumulatedText += parsed.text;
              scheduleStreamingRender();
            }

            if (parsed.done) {
              streamDone = true;
            }
          };

          while (!streamDone) {
            const { done, value } = await reader.read();
            if (done) break;

            sseBuffer += decoder.decode(value, { stream: true });
            const lines = sseBuffer.split(/\r?\n/);
            sseBuffer = lines.pop() || "";

            for (const line of lines) {
              processSseLine(line);
              if (streamDone) break;
            }
          }

          sseBuffer += decoder.decode();
          if (!streamDone && sseBuffer.trim()) {
            for (const line of sseBuffer.split(/\r?\n/)) {
              processSseLine(line);
            }
          }
        }

        cancelScheduledRender();
        const finalText = accumulatedText || "Пустой ответ от нейросети.";

        if (streamingContentEl) {
          renderStreamingFrame(false);
        } else {
          loadingRow.remove();
          if (activeChatId === chat.id) {
            chatMessagesEl.appendChild(
              buildMessageElement({ role: "assistant", text: finalText })
            );
          }
        }

        const assistantMsg = {
          role: "assistant",
          text: finalText,
          timestamp: Date.now()
        };
        chat.messages.push(assistantMsg);
        chat.updatedAt = Date.now();
        saveChats();
        if (activeChatId === chat.id && isNearBottom()) {
          scrollToBottom();
        }
      }
    } catch (err) {
      cancelScheduledRender();
      loadingRow.remove();

      if (err && err.name === "AbortError") {
        if (accumulatedText && streamingContentEl) {
          const stoppedText = accumulatedText + "\n\n_Генерация остановлена пользователем._";
          renderSafeMarkdownAndMath(streamingContentEl, stoppedText);
          const partialMsg = {
            role: "assistant",
            text: stoppedText,
            timestamp: Date.now()
          };
          chat.messages.push(partialMsg);
          chat.updatedAt = Date.now();
          saveChats();
        } else {
          const stoppedMsg = {
            role: "assistant",
            text: "_Генерация остановлена пользователем._",
            timestamp: Date.now()
          };
          chat.messages.push(stoppedMsg);
          chat.updatedAt = Date.now();
          if (activeChatId === chat.id) {
            chatMessagesEl.appendChild(buildMessageElement(stoppedMsg));
          }
          saveChats();
        }
      } else {
        if (streamingRow && !accumulatedText) {
          streamingRow.remove();
        } else if (streamingContentEl && accumulatedText) {
          renderSafeMarkdownAndMath(streamingContentEl, accumulatedText);
          chat.messages.push({
            role: "assistant",
            text: accumulatedText,
            timestamp: Date.now()
          });
        }

        const errorMsg = {
          role: "assistant",
          text: `Ошибка: ${err?.message || "Не удалось получить ответ от сервера."}`,
          isError: true,
          timestamp: Date.now()
        };
        chat.messages.push(errorMsg);
        chat.updatedAt = Date.now();
        if (activeChatId === chat.id) {
          chatMessagesEl.appendChild(buildMessageElement(errorMsg));
        }
        saveChats();
      }
      if (activeChatId === chat.id) {
        scrollToBottom();
      }
    } finally {
      cancelScheduledRender();
      currentAbortController = null;
      isGenerating = false;
      updateComposerUI();
      promptInputEl.focus();
    }
  }

  // --- События ---
  function bindEvents() {
    sidebarToggleBtn.addEventListener("click", toggleSidebar);
    sidebarCloseBtn.addEventListener("click", closeMobileSidebar);
    sidebarBackdropEl.addEventListener("click", closeMobileSidebar);
    newChatBtn.addEventListener("click", startNewChat);

    themeToggleBtn.addEventListener("click", toggleTheme);
    themeToggleSidebarBtn.addEventListener("click", toggleTheme);

    thinkingBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        setThinkingLevel(btn.dataset.level, true);
      });
    });

    imageModeBtn.addEventListener("click", () => toggleImageMode());

    attachBtn.addEventListener("click", () => {
      imageFileInputEl.click();
    });

    imageFileInputEl.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) handleSelectedImageFile(file);
    });

    removeAttachmentBtn.addEventListener("click", clearPendingAttachment);

    promptInputEl.addEventListener("input", () => {
      autoResizeTextarea();
      updateComposerUI();
    });

    promptInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!sendBtn.disabled) {
          handleSubmit();
        }
      }
    });

    // Поддержка вставки скриншотов/картинок через Ctrl+V
    promptInputEl.addEventListener("paste", (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            handleSelectedImageFile(file);
            break;
          }
        }
      }
    });

    chatFormEl.addEventListener("submit", handleSubmit);
    stopBtn.addEventListener("click", stopGeneration);

    // Быстрые стартовые карточки на приветственном экране
    document.querySelectorAll(".starter-card").forEach((card) => {
      card.addEventListener("click", () => {
        const textPrompt = card.getAttribute("data-prompt");
        const imgPrompt = card.getAttribute("data-image-prompt");
        if (imgPrompt) {
          toggleImageMode(true);
          promptInputEl.value = imgPrompt;
        } else if (textPrompt) {
          toggleImageMode(false);
          promptInputEl.value = textPrompt;
        }
        autoResizeTextarea();
        updateComposerUI();
        handleSubmit();
      });
    });
  }

  init();
})();
