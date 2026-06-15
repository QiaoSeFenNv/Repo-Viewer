const state = {
  root: "",
  tree: null,
  expanded: new Set([""]),
  selectedPath: "",
  selectedFile: null,
  translation: null,
  translationLoading: false,
  translationConfig: null,
  viewMode: "source",
  filter: "",
  theme: localStorage.getItem("repo-viewer-theme") || "paper"
};

const elements = {
  repoMeta: document.querySelector("#repoMeta"),
  repoForm: document.querySelector("#repoForm"),
  repoRoot: document.querySelector("#repoRoot"),
  refreshTree: document.querySelector("#refreshTree"),
  treeSearch: document.querySelector("#treeSearch"),
  tree: document.querySelector("#tree"),
  fileTitle: document.querySelector("#fileTitle"),
  filePath: document.querySelector("#filePath"),
  status: document.querySelector("#status"),
  translationConfig: document.querySelector("#translationConfig"),
  configureTranslation: document.querySelector("#configureTranslation"),
  translationDialog: document.querySelector("#translationDialog"),
  translationForm: document.querySelector("#translationForm"),
  closeTranslationDialog: document.querySelector("#closeTranslationDialog"),
  configProvider: document.querySelector("#configProvider"),
  configEndpoint: document.querySelector("#configEndpoint"),
  configModel: document.querySelector("#configModel"),
  configApiKey: document.querySelector("#configApiKey"),
  clearApiKey: document.querySelector("#clearApiKey"),
  configFields: document.querySelectorAll("[data-config-field]"),
  configHint: document.querySelector("#configHint"),
  preview: document.querySelector("#preview"),
  targetLanguage: document.querySelector("#targetLanguage"),
  themeSelect: document.querySelector("#themeSelect"),
  translateFile: document.querySelector("#translateFile"),
  viewButtons: document.querySelectorAll("[data-view]")
};

const params = new URLSearchParams(window.location.search);
state.root = params.get("root") || "";
elements.repoRoot.value = state.root;
document.body.dataset.theme = state.theme;
elements.themeSelect.value = state.theme;

function apiUrl(path, search = {}) {
  const query = new URLSearchParams(search);
  if (state.root) query.set("root", state.root);
  return `${path}?${query.toString()}`;
}

async function apiGet(path, search = {}) {
  const response = await fetch(apiUrl(path, search));
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "请求失败");
  }
  return data;
}

async function apiPost(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "请求失败");
  }
  return data;
}

async function loadTranslationConfig() {
  try {
    const config = await apiGet("/api/translation-status");
    state.translationConfig = config;
    if (config.remoteConfigured) {
      const model = config.model ? ` · ${config.model}` : "";
      elements.translationConfig.className = "translation-config";
      elements.translationConfig.textContent = `翻译源已配置：${config.provider}${model} · 仓库内译文优先`;
    } else {
      elements.translationConfig.className = "translation-config warning";
      elements.translationConfig.textContent = "翻译源未配置：仅可使用仓库内译文；无对应译文时会使用本地术语表 fallback";
    }
  } catch (error) {
    elements.translationConfig.className = "translation-config warning";
    elements.translationConfig.textContent = `无法读取翻译配置：${error.message}`;
  }
}

function fillTranslationForm() {
  const config = state.translationConfig || {};
  elements.configProvider.value = config.provider || "google-free";
  elements.configEndpoint.value = config.endpoint || "";
  elements.configModel.value = config.model || "";
  elements.configApiKey.value = "";
  elements.clearApiKey.checked = false;
  updateTranslationFormFields();
}

function updateTranslationFormFields() {
  const provider = elements.configProvider.value;
  const isFreeProvider = provider === "google-free" || provider === "mymemory-free";
  const isOpenAiProvider = provider === "openai-compatible";
  elements.configFields.forEach((field) => {
    const fieldType = field.dataset.configField;
    const visible = !isFreeProvider && (fieldType !== "model" || isOpenAiProvider);
    field.classList.toggle("is-hidden", !visible);
  });

  if (provider === "google-free") {
    elements.configHint.textContent = "Google 免费端点无需 API Key；如果 Google 超时或限流，会自动切到 MyMemory。";
  } else if (provider === "mymemory-free") {
    elements.configHint.textContent = "MyMemory 免费端点无需 API Key，适合短文本，长文会自动分块。";
  } else if (provider === "generic") {
    elements.configHint.textContent = "Generic POST 只需要 Endpoint；请求体会包含 text、targetLanguage、sourceLanguage。";
  } else {
    const config = state.translationConfig || {};
    elements.configHint.textContent = config.apiKeyConfigured
      ? "已保存 API Key。留空会继续保留；勾选清空可移除。"
      : "尚未保存 API Key。API Key 只写入本地 .env，不会回显。";
  }
}

function openTranslationDialog() {
  fillTranslationForm();
  elements.translationDialog.showModal();
}

function closeTranslationDialog() {
  elements.translationDialog.close();
}

async function saveTranslationConfig(event) {
  event.preventDefault();
  elements.configHint.textContent = "正在保存配置";
  const provider = elements.configProvider.value;
  const isFreeProvider = provider === "google-free" || provider === "mymemory-free";
  try {
    const config = await apiPost("/api/translation-config", {
      provider,
      endpoint: isFreeProvider ? "" : elements.configEndpoint.value,
      model: provider === "openai-compatible" ? elements.configModel.value : "",
      apiKey: isFreeProvider ? "" : elements.configApiKey.value,
      clearApiKey: isFreeProvider || elements.clearApiKey.checked
    });
    state.translationConfig = config;
    closeTranslationDialog();
    await loadTranslationConfig();
    setStatus(config.remoteConfigured ? "翻译配置已保存，远程翻译可用" : "翻译配置已保存，但远程翻译仍未完整配置");
  } catch (error) {
    elements.configHint.textContent = `保存失败：${error.message}`;
  }
}

function setStatus(message, tone = "neutral") {
  elements.status.textContent = message;
  elements.status.dataset.tone = tone;
}

function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizePathForFilter(path) {
  return path.toLowerCase();
}

function nodeMatches(node, filter) {
  if (!filter) return true;
  if (normalizePathForFilter(node.path || node.name).includes(filter)) return true;
  return node.children?.some((child) => nodeMatches(child, filter));
}

function findNodeByPath(node, path) {
  if (!node) return null;
  if (node.path === path) return node;
  for (const child of node.children || []) {
    const match = findNodeByPath(child, path);
    if (match) return match;
  }
  return null;
}

async function loadDirectory(node) {
  if (node.loaded || node.loading) return;
  node.loading = true;
  renderTree();
  try {
    const directory = await apiGet("/api/tree", { path: node.path });
    node.children = directory.children || [];
    node.childCount = directory.childCount ?? node.children.length;
    node.loaded = true;
  } finally {
    node.loading = false;
  }
}

function renderTreeNode(node, parent) {
  const filter = state.filter.trim().toLowerCase();
  if (!nodeMatches(node, filter)) return;

  const item = document.createElement("li");
  const row = document.createElement("button");
  row.type = "button";
  row.className = `tree-row ${state.selectedPath === node.path ? "active" : ""}`;
  row.style.paddingLeft = `${Math.max(0, (node.path.split("/").length - 1) * 4 + 7)}px`;

  const twisty = document.createElement("span");
  twisty.className = "twisty";
  twisty.textContent = node.type === "directory" ? (state.expanded.has(node.path) ? "▾" : "▸") : "";

  const name = document.createElement("span");
  name.className = "node-name";
  name.textContent = `${node.type === "directory" ? "📁" : "□"} ${node.name}`;

  const meta = document.createElement("span");
  meta.className = "node-meta";
  meta.textContent = node.type === "file" ? formatBytes(node.size) : node.loading ? "..." : `${node.childCount ?? node.children?.length ?? 0}`;

  row.append(twisty, name, meta);
  row.addEventListener("click", async () => {
    if (node.type === "directory") {
      if (state.expanded.has(node.path)) {
        state.expanded.delete(node.path);
        renderTree();
        return;
      }
      state.expanded.add(node.path);
      if (!node.loaded) {
        try {
          setStatus(`加载目录 ${node.path || node.name}`);
          await loadDirectory(node);
          setStatus("目录已加载");
        } catch (error) {
          state.expanded.delete(node.path);
          setStatus(`目录加载失败：${error.message}`, "error");
        }
      }
      renderTree();
      return;
    }
    selectFile(node.path);
  });

  item.append(row);

  if (node.type === "directory" && state.expanded.has(node.path) && node.children?.length) {
    const list = document.createElement("ul");
    node.children.forEach((child) => renderTreeNode(child, list));
    item.append(list);
  }

  parent.append(item);
}

function renderTree() {
  elements.tree.innerHTML = "";
  if (!state.tree) {
    elements.tree.textContent = "目录树为空";
    return;
  }
  const list = document.createElement("ul");
  state.tree.children.forEach((child) => renderTreeNode(child, list));
  elements.tree.append(list);
}

function renderCode(content) {
  const lines = content.split("\n");
  return `<pre class="code">${lines
    .map(
      (line, index) =>
        `<span class="line"><span class="line-number">${index + 1}</span><span class="line-code">${escapeHtml(line) || " "}</span></span>`
    )
    .join("")}</pre>`;
}

function resolveAssetUrl(rawUrl) {
  if (!state.selectedFile || /^(https?:)?\/\//.test(rawUrl) || rawUrl.startsWith("data:")) {
    return rawUrl;
  }
  if (rawUrl.startsWith("#")) return rawUrl;
  const baseParts = state.selectedFile.path.split("/");
  baseParts.pop();
  const parts = rawUrl.startsWith("/") ? [] : baseParts;
  for (const segment of rawUrl.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return apiUrl("/api/raw", { path: parts.join("/") });
}

function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let inCode = false;
  let listOpen = false;

  const closeList = () => {
    if (listOpen) {
      html.push("</ul>");
      listOpen = false;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.startsWith("```")) {
      closeList();
      html.push(inCode ? "</code></pre>" : "<pre><code>");
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      html.push(`${escapeHtml(rawLine)}\n`);
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeList();
      html.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    if (line.startsWith("> ")) {
      closeList();
      html.push(`<blockquote>${inlineMarkdown(line.slice(2))}</blockquote>`);
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${inlineMarkdown(bullet[1])}</li>`);
      continue;
    }
    closeList();
    html.push(`<p>${inlineMarkdown(line)}</p>`);
  }

  closeList();
  return `<article class="markdown">${html.join("")}</article>`;
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/!\[([^\]]*?)\]\(([^)]+?)\)/g, (_match, alt, url) => {
      const cleanUrl = url.split(/\s+/)[0];
      return `<img class="markdown-image" src="${escapeHtml(resolveAssetUrl(cleanUrl))}" alt="${alt}" />`;
    })
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+?)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+?)\]\(([^)]+?)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function renderPane(title, content, file) {
  const body = file?.isMarkdown ? renderMarkdown(content) : renderCode(content);
  return `<section class="pane"><div class="pane-title"><span>${title}</span><span>${file?.language || "Text"}</span></div>${body}</section>`;
}

function translationPaneTitle(file) {
  const hasTranslation = state.translation?.sourcePath === file.path;
  if (!hasTranslation) return "Translated";
  if (state.translation.provider === "skipped-code") return "Translated · 原文保留";
  return `Translated · ${state.translation.provider}`;
}

function keepOriginalInTranslationPane(file) {
  state.translation = {
    translatedText: file.content,
    provider: "skipped-code",
    sourcePath: file.path
  };
}

function renderLoadingPane(file) {
  return `<section class="pane loading-pane">
    <div class="pane-title"><span>Translated · loading</span><span>${file?.language || "Text"}</span></div>
    <div class="translation-loading">
      <div class="loader-ring" aria-hidden="true"></div>
      <h3>正在生成中文对比</h3>
      <p>已跳过代码块和常见代码文件，正在处理可翻译文本。</p>
      <div class="loader-bar"><span></span></div>
    </div>
  </section>`;
}

function renderPreview() {
  const file = state.selectedFile;
  if (!file) return;

  elements.fileTitle.textContent = file.name;
  elements.filePath.textContent = `${file.path} · ${formatBytes(file.size)} · ${file.language}`;

  if (file.isImage) {
    elements.preview.className = "preview";
    elements.preview.innerHTML = `<div class="asset-preview"><img src="${file.rawUrl}" alt="${escapeHtml(file.name)}" /></div>`;
    return;
  }

  if (!file.text) {
    elements.preview.className = "preview";
    elements.preview.innerHTML = `<div class="notice">该文件看起来是二进制文件，当前仅提供元数据预览。大小：${formatBytes(file.size)}</div>`;
    return;
  }

  const hasTranslation = state.translation?.sourcePath === file.path;
  const translatedText = hasTranslation ? state.translation.translatedText : "尚未翻译。点击右上角“翻译”生成目标语言内容。";
  const translatedTitle = translationPaneTitle(file);
  const gridClass = state.viewMode === "split" ? "preview-grid split" : "preview-grid";

  let panes = "";
  if (state.viewMode === "source") {
    panes = renderPane("Source", file.content, file);
  } else if (state.viewMode === "translated") {
    panes = state.translationLoading ? renderLoadingPane(file) : renderPane(translatedTitle, translatedText, file);
  } else {
    panes = `${renderPane("Source", file.content, file)}${
      state.translationLoading
        ? renderLoadingPane(file)
        : renderPane(translatedTitle, translatedText, file)
    }`;
  }

  elements.preview.className = "preview";
  elements.preview.innerHTML = `<div class="${gridClass}">${panes}</div>`;
}

async function selectFile(path) {
  try {
    state.selectedPath = path;
    state.translation = null;
    state.translationLoading = false;
    setStatus(`读取 ${path}`);
    renderTree();
    const file = await apiGet("/api/file", { path });
    state.selectedFile = file;
    state.viewMode = "source";
    updateViewButtons();
    setStatus(file.truncated ? "文件较大，已截取前 1 MB 预览" : "文件已载入");
    renderPreview();
    if (file.text && file.translatable && !file.isCode) {
      elements.targetLanguage.value = "zh-CN";
      state.viewMode = "split";
      updateViewButtons();
      renderPreview();
      await translateCurrentFile({ automatic: true });
    } else if (file.isCode) {
      keepOriginalInTranslationPane(file);
      state.viewMode = "split";
      updateViewButtons();
      setStatus("代码内容已原样显示，未进行翻译");
      renderPreview();
    }
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function loadTree() {
  try {
    setStatus("正在扫描仓库目录");
    const tree = await apiGet("/api/tree");
    state.tree = tree;
    state.root = tree.root;
    elements.repoRoot.value = tree.root;
    elements.repoMeta.textContent = `${tree.root} · 根目录 ${tree.childCount} 项 · 按需加载`;
    state.expanded = new Set([""]);
    state.selectedFile = null;
    renderTree();
    setStatus("目录树已生成");
  } catch (error) {
    setStatus(error.message, "error");
    elements.tree.innerHTML = `<div class="notice">${escapeHtml(error.message)}</div>`;
  }
}

async function translateCurrentFile(options = {}) {
  const file = state.selectedFile;
  if (!file?.text) {
    setStatus("当前文件不支持文本翻译", "error");
    return;
  }
  if (!file.translatable || file.isCode) {
    keepOriginalInTranslationPane(file);
    state.viewMode = "split";
    updateViewButtons();
    setStatus("代码内容已原样显示，未进行翻译");
    renderPreview();
    return;
  }

  try {
    setStatus(options.automatic ? "正在自动生成中文对比" : "正在翻译当前文件");
    state.translationLoading = true;
    state.viewMode = state.viewMode === "source" ? "split" : state.viewMode;
    updateViewButtons();
    renderPreview();
    const data = await apiPost("/api/translate", {
      text: file.content,
      targetLanguage: elements.targetLanguage.value,
      sourceLanguage: "auto",
      root: state.root,
      path: file.path,
      hash: file.hash
    });
    state.translation = { ...data, sourcePath: file.path };
    state.translationLoading = false;
    state.viewMode = state.viewMode === "source" ? "split" : state.viewMode;
    updateViewButtons();
    const providerLabel =
      data.provider === "repository"
        ? `仓库内译文 ${data.sourcePath || ""}`
        : data.provider === "google-free"
          ? "Google 免费翻译"
          : data.provider === "mymemory-free"
            ? "MyMemory 免费翻译"
            : data.provider === "openai-compatible" || data.provider === "generic"
              ? "远程翻译端点"
              : data.provider === "skipped-code"
                ? "已跳过代码翻译"
              : "本地 fallback";
    const reason = data.fallbackReason ? ` · 原因：${data.fallbackReason}` : "";
    setStatus(`翻译完成：${providerLabel}${reason}${data.cached ? " · cached" : ""}`);
    renderPreview();
  } catch (error) {
    state.translationLoading = false;
    renderPreview();
    setStatus(error.message, "error");
  }
}

function updateViewButtons() {
  elements.viewButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.viewMode);
  });
}

elements.repoForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.root = elements.repoRoot.value.trim();
  const url = new URL(window.location.href);
  if (state.root) url.searchParams.set("root", state.root);
  else url.searchParams.delete("root");
  window.history.replaceState({}, "", url);
  loadTree();
});

elements.refreshTree.addEventListener("click", loadTree);

elements.treeSearch.addEventListener("input", (event) => {
  state.filter = event.target.value;
  renderTree();
});

elements.themeSelect.addEventListener("change", (event) => {
  state.theme = event.target.value;
  document.body.dataset.theme = state.theme;
  localStorage.setItem("repo-viewer-theme", state.theme);
});

elements.translateFile.addEventListener("click", translateCurrentFile);
elements.configureTranslation.addEventListener("click", openTranslationDialog);
elements.closeTranslationDialog.addEventListener("click", closeTranslationDialog);
elements.translationForm.addEventListener("submit", saveTranslationConfig);
elements.configProvider.addEventListener("change", updateTranslationFormFields);

elements.viewButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.viewMode = button.dataset.view;
    updateViewButtons();
    renderPreview();
  });
});

loadTranslationConfig();
loadTree();
