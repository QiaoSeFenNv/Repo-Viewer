import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect as netConnect } from "node:net";
import { extname, join, relative, resolve, sep } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(__dirname, "..");
const staticRoot = join(projectRoot, "src");
const defaultRepoRoot = resolve(process.env.REPO_ROOT || process.cwd());
const envPath = resolve(process.env.REPO_VIEWER_ENV_PATH || join(projectRoot, ".env"));

async function loadEnvFile() {
  if (!existsSync(envPath)) return;

  const content = await readFile(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

await loadEnvFile();

const port = Number(process.env.PORT || 4173);
const maxTextBytes = Number(process.env.MAX_TEXT_BYTES || 1024 * 1024);
const maxTreeEntries = Number(process.env.MAX_TREE_ENTRIES || 12000);
const defaultTranslateProvider = "google-free";
const translateTimeoutMs = Number(process.env.TRANSLATE_TIMEOUT_MS || 20000);
const translateLogEnabled = process.env.TRANSLATE_LOG !== "0" && process.env.REPO_VIEWER_TRANSLATE_LOG !== "0";
const defaultTranslateProxyUrl = "http://127.0.0.1:7897";

const ignoredNames = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".turbo",
  "__pycache__"
]);

const binaryExtensions = new Set([
  ".7z",
  ".avi",
  ".bmp",
  ".class",
  ".dll",
  ".doc",
  ".docx",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".pdf",
  ".png",
  ".ppt",
  ".pptx",
  ".pyc",
  ".rar",
  ".so",
  ".ttf",
  ".webp",
  ".woff",
  ".woff2",
  ".xls",
  ".xlsx",
  ".zip"
]);

const imageExtensions = new Set([".gif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"]
]);

const languageByExtension = new Map([
  [".c", "C"],
  [".cc", "C++"],
  [".cpp", "C++"],
  [".cs", "C#"],
  [".css", "CSS"],
  [".go", "Go"],
  [".html", "HTML"],
  [".java", "Java"],
  [".js", "JavaScript"],
  [".jsx", "JavaScript"],
  [".json", "JSON"],
  [".kt", "Kotlin"],
  [".md", "Markdown"],
  [".mjs", "JavaScript"],
  [".py", "Python"],
  [".rb", "Ruby"],
  [".rs", "Rust"],
  [".sh", "Shell"],
  [".sql", "SQL"],
  [".ts", "TypeScript"],
  [".tsx", "TypeScript"],
  [".txt", "Text"],
  [".xml", "XML"],
  [".yaml", "YAML"],
  [".yml", "YAML"]
]);

const translatableExtensions = new Set([".md", ".markdown", ".mdx", ".txt", ".rst", ".adoc"]);
const codeExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".json",
  ".kt",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".ts",
  ".tsx",
  ".xml",
  ".yaml",
  ".yml"
]);

const translationCache = new Map();

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(body);
}

function sendError(response, statusCode, message, detail) {
  sendJson(response, statusCode, { error: message, detail });
}

function safeRoot(inputRoot) {
  const root = resolve(inputRoot || defaultRepoRoot);
  if (!existsSync(root)) {
    const error = new Error(`Repository path does not exist: ${root}`);
    error.statusCode = 404;
    throw error;
  }
  return root;
}

function safeRepoPath(root, inputPath = "") {
  const normalizedInput = String(inputPath).replaceAll("\\", "/");
  const absolutePath = resolve(root, normalizedInput);
  const relativePath = relative(root, absolutePath);
  if (relativePath.startsWith("..") || relativePath === ".." || absolutePath === root + sep) {
    const error = new Error("Path is outside the selected repository.");
    error.statusCode = 400;
    throw error;
  }
  return absolutePath;
}

function toRepoPath(root, absolutePath) {
  return relative(root, absolutePath).replaceAll("\\", "/");
}

function isIgnored(name) {
  return ignoredNames.has(name) || name.endsWith(".log") || name.endsWith(".lockb");
}

function classifyFile(filePath, size) {
  const extension = extname(filePath).toLowerCase();
  const isImage = imageExtensions.has(extension);
  const isBinary = binaryExtensions.has(extension) && !extension.endsWith(".svg");
  const isMarkdown = extension === ".md" || extension === ".markdown" || extension === ".mdx";
  const isCode = codeExtensions.has(extension) && !isMarkdown;
  return {
    extension,
    language: languageByExtension.get(extension) || (extension ? extension.slice(1).toUpperCase() : "Text"),
    isMarkdown,
    isCode,
    translatable: translatableExtensions.has(extension) || (!extension && size <= maxTextBytes),
    isImage,
    isBinary,
    isLarge: size > maxTextBytes
  };
}

function sortNodes(a, b) {
  if (a.type !== b.type) {
    return a.type === "directory" ? -1 : 1;
  }
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

async function countDirectoryChildren(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (isIgnored(entry.name)) continue;
    count += 1;
  }
  return count;
}

async function readDirectoryLevel(root, dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const children = [];

  for (const entry of entries) {
    if (isIgnored(entry.name)) continue;

    const absolutePath = join(dirPath, entry.name);
    const entryStats = await lstat(absolutePath);
    if (entryStats.isSymbolicLink()) continue;

    const repoPath = toRepoPath(root, absolutePath);

    if (entry.isDirectory()) {
      children.push({
        id: repoPath || ".",
        type: "directory",
        name: entry.name,
        path: repoPath,
        loaded: false,
        childCount: await countDirectoryChildren(absolutePath),
        children: []
      });
      continue;
    }

    if (entry.isFile()) {
      const classification = classifyFile(absolutePath, entryStats.size);
      children.push({
        id: repoPath,
        type: "file",
        name: entry.name,
        path: repoPath,
        size: entryStats.size,
        modifiedAt: entryStats.mtime.toISOString(),
        ...classification
      });
    }
  }

  return children.sort(sortNodes);
}

async function handleTree(requestUrl, response) {
  const root = safeRoot(requestUrl.searchParams.get("root"));
  const repoPath = requestUrl.searchParams.get("path") || "";
  const dirPath = safeRepoPath(root, repoPath);
  const dirStats = await stat(dirPath);
  if (!dirStats.isDirectory()) {
    sendError(response, 400, "Selected path is not a directory.");
    return;
  }

  const children = await readDirectoryLevel(root, dirPath);
  const tree = {
    id: repoPath || ".",
    type: "directory",
    name: repoPath ? repoPath.split("/").at(-1) : root.split(/[\\/]/).at(-1) || root,
    path: repoPath,
    root,
    generatedAt: new Date().toISOString(),
    loaded: true,
    childCount: children.length,
    children
  };
  sendJson(response, 200, tree);
}

function detectText(buffer) {
  if (buffer.includes(0)) return false;
  const sample = buffer.subarray(0, 4096).toString("utf8");
  return !sample.includes("\uFFFD");
}

async function handleFile(requestUrl, response) {
  const root = safeRoot(requestUrl.searchParams.get("root"));
  const repoPath = requestUrl.searchParams.get("path") || "";
  const absolutePath = safeRepoPath(root, repoPath);
  const fileStats = await stat(absolutePath);

  if (!fileStats.isFile()) {
    sendError(response, 400, "Selected path is not a file.");
    return;
  }

  const classification = classifyFile(absolutePath, fileStats.size);
  const headerBuffer = await readFile(absolutePath, { encoding: null }).then((buffer) => buffer.subarray(0, 4096));
  const isText = !classification.isBinary && detectText(headerBuffer);

  if (!isText || classification.isImage) {
    sendJson(response, 200, {
      path: toRepoPath(root, absolutePath),
      name: absolutePath.split(/[\\/]/).at(-1),
      size: fileStats.size,
      modifiedAt: fileStats.mtime.toISOString(),
      content: "",
      rawUrl: `/api/raw?root=${encodeURIComponent(root)}&path=${encodeURIComponent(toRepoPath(root, absolutePath))}`,
      text: false,
      ...classification
    });
    return;
  }

  const fullBuffer = await readFile(absolutePath, { encoding: null });
  const limited = fullBuffer.subarray(0, maxTextBytes);
  const content = limited.toString("utf8");
  const hash = createHash("sha256").update(fullBuffer).digest("hex");

  sendJson(response, 200, {
    path: toRepoPath(root, absolutePath),
    name: absolutePath.split(/[\\/]/).at(-1),
    size: fileStats.size,
    modifiedAt: fileStats.mtime.toISOString(),
    content,
    hash,
    text: true,
    truncated: fullBuffer.byteLength > maxTextBytes,
    ...classification
  });
}

async function handleRaw(requestUrl, response) {
  const root = safeRoot(requestUrl.searchParams.get("root"));
  const absolutePath = safeRepoPath(root, requestUrl.searchParams.get("path") || "");
  const fileStats = await stat(absolutePath);
  if (!fileStats.isFile()) {
    sendError(response, 400, "Selected path is not a file.");
    return;
  }

  const extension = extname(absolutePath).toLowerCase();
  response.writeHead(200, {
    "content-type": mimeTypes.get(extension) || "application/octet-stream",
    "content-length": fileStats.size
  });
  createReadStream(absolutePath).pipe(response);
}

function preserveCodeBlocks(markdown) {
  const blocks = [];
  const protectedText = markdown.replace(/```[\s\S]*?```/g, (block) => {
    const token = `__CODE_BLOCK_${blocks.length}__`;
    blocks.push(block);
    return token;
  });
  return { protectedText, restore: (text) => text.replace(/__CODE_BLOCK_(\d+)__/g, (_, index) => blocks[Number(index)] || "") };
}

function shouldTranslateFile(body) {
  const extension = extname(String(body.path || "")).toLowerCase();
  return translatableExtensions.has(extension) || (!extension && String(body.text || "").length < 20000);
}

function splitMarkdownForTranslation(markdown) {
  const parts = [];
  const pattern = /(```[\s\S]*?```|`[^`\n]+`)/g;
  let lastIndex = 0;
  for (const match of markdown.matchAll(pattern)) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", value: markdown.slice(lastIndex, match.index) });
    }
    parts.push({ type: "code", value: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < markdown.length) {
    parts.push({ type: "text", value: markdown.slice(lastIndex) });
  }
  return parts;
}

function translationConcurrency() {
  const configured = Number(process.env.TRANSLATE_CONCURRENCY || 3);
  if (!Number.isFinite(configured)) return 3;
  return Math.max(1, Math.min(4, Math.floor(configured)));
}

function translationBatchMaxChars() {
  const configured = Number(process.env.TRANSLATE_BATCH_CHARS || 3200);
  if (!Number.isFinite(configured)) return 3200;
  return Math.max(800, Math.min(12000, Math.floor(configured)));
}

function translationBatchMaxItems() {
  const configured = Number(process.env.TRANSLATE_BATCH_ITEMS || 24);
  if (!Number.isFinite(configured)) return 24;
  return Math.max(2, Math.min(80, Math.floor(configured)));
}

async function mapWithConcurrency(items, limit, mapper) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      await mapper(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
}

function buildTranslationBatches(items) {
  const batches = [];
  const maxChars = translationBatchMaxChars();
  const maxItems = translationBatchMaxItems();
  let current = [];
  let currentLength = 0;

  for (const item of items) {
    const delimiterOverhead = current.length ? 38 : 0;
    const nextLength = currentLength + delimiterOverhead + item.core.length;
    if (current.length && (current.length >= maxItems || nextLength > maxChars)) {
      batches.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(item);
    currentLength += (current.length > 1 ? delimiterOverhead : 0) + item.core.length;
  }

  if (current.length) batches.push(current);
  return batches;
}

async function translateBatch(batch, targetLanguage, sourceLanguage, batchIndex) {
  if (batch.length === 1) {
    const item = batch[0];
    const translated = await remoteTranslate(item.core, targetLanguage, sourceLanguage);
    if (!translated) throw new Error("Translation provider is not configured.");
    item.apply(translated);
    return;
  }

  const markers = batch.slice(1).map((_, index) => `REPO_VIEWER_TRANSLATE_PART_${batchIndex}_${index}`);
  const body = batch.map((item, index) => (index === 0 ? item.core : `<<<${markers[index - 1]}>>>\n${item.core}`)).join("\n");
  const translated = await remoteTranslate(body, targetLanguage, sourceLanguage);
  if (!translated) throw new Error("Translation provider is not configured.");

  let remaining = translated;
  const pieces = [];
  for (const marker of markers) {
    const markerPattern = new RegExp(`<+\\s*${marker}\\s*>+`);
    const markerMatch = remaining.match(markerPattern);
    const markerIndex = markerMatch?.index ?? -1;
    if (markerIndex < 0) {
      translateLog("batch-split-fallback", { batch: batchIndex + 1, items: batch.length, missing: marker });
      await mapWithConcurrency(batch, translationConcurrency(), async (item) => {
        const part = await remoteTranslate(item.core, targetLanguage, sourceLanguage);
        if (!part) throw new Error("Translation provider is not configured.");
        item.apply(part);
      });
      return;
    }
    pieces.push(remaining.slice(0, markerIndex));
    remaining = remaining.slice(markerIndex + markerMatch[0].length);
  }
  pieces.push(remaining);

  for (const [index, item] of batch.entries()) {
    item.apply(pieces[index].trim());
  }
}

async function translateMarkdownWithoutCode(markdown, targetLanguage, sourceLanguage) {
  const parts = splitMarkdownForTranslation(markdown);
  const translatedParts = new Array(parts.length);
  const items = [];

  for (const [index, part] of parts.entries()) {
    if (part.type === "code") {
      translatedParts[index] = part.value;
      continue;
    }

    const leading = part.value.match(/^\s*/)?.[0] || "";
    const trailing = part.value.match(/\s*$/)?.[0] || "";
    const core = part.value.slice(leading.length, part.value.length - trailing.length);
    if (!core) {
      translatedParts[index] = part.value;
      continue;
    }

    items.push({
      core,
      apply: (translated) => {
        translatedParts[index] = `${leading}${translated}${trailing}`;
      }
    });
  }

  const batches = buildTranslationBatches(items);
  translateLog("request-plan", {
    parts: parts.length,
    textItems: items.length,
    batches: batches.length,
    batchChars: translationBatchMaxChars(),
    batchItems: translationBatchMaxItems()
  });

  await mapWithConcurrency(batches, translationConcurrency(), async (batch, index) => {
    translateLog("batch-start", {
      batch: `${index + 1}/${batches.length}`,
      items: batch.length,
      chars: batch.reduce((sum, item) => sum + item.core.length, 0)
    });
    await translateBatch(batch, targetLanguage, sourceLanguage, index);
    translateLog("batch-ok", { batch: `${index + 1}/${batches.length}` });
  });

  return translatedParts.join("");
}

function localTranslateMarkdownWithoutCode(markdown, targetLanguage) {
  const languageLabel = { "zh-CN": "简体中文", en: "English", ja: "日本語", ko: "한국어" }[targetLanguage] || targetLanguage;
  const body = splitMarkdownForTranslation(markdown)
    .map((part) => (part.type === "code" ? part.value : localGlossaryReplace(part.value, targetLanguage)))
    .join("");
  return `> 未配置可用的远程翻译服务，以下内容仅使用本地术语表替换（${languageLabel}），不是完整翻译。\n\n${body}`;
}

const localGlossaries = {
  "zh-CN": new Map([
    ["Repository", "仓库"],
    ["repository", "仓库"],
    ["File", "文件"],
    ["file", "文件"],
    ["Folder", "文件夹"],
    ["folder", "文件夹"],
    ["Command", "命令"],
    ["command", "命令"],
    ["Install", "安装"],
    ["install", "安装"],
    ["Configuration", "配置"],
    ["configuration", "配置"],
    ["Agent", "智能体"],
    ["agent", "智能体"],
    ["Skill", "技能"],
    ["skill", "技能"],
    ["Rule", "规则"],
    ["rule", "规则"],
    ["Workflow", "工作流"],
    ["workflow", "工作流"],
    ["Security", "安全"],
    ["security", "安全"],
    ["Test", "测试"],
    ["test", "测试"],
    ["Development", "开发"],
    ["development", "开发"]
  ]),
  ja: new Map([
    ["Repository", "リポジトリ"],
    ["repository", "リポジトリ"],
    ["File", "ファイル"],
    ["file", "ファイル"],
    ["Folder", "フォルダ"],
    ["folder", "フォルダ"],
    ["Command", "コマンド"],
    ["command", "コマンド"],
    ["Install", "インストール"],
    ["install", "インストール"],
    ["Security", "セキュリティ"],
    ["security", "セキュリティ"]
  ]),
  ko: new Map([
    ["Repository", "저장소"],
    ["repository", "저장소"],
    ["File", "파일"],
    ["file", "파일"],
    ["Folder", "폴더"],
    ["folder", "폴더"],
    ["Command", "명령"],
    ["command", "명령"],
    ["Install", "설치"],
    ["install", "설치"],
    ["Security", "보안"],
    ["security", "보안"]
  ]),
  en: new Map([
    ["仓库", "repository"],
    ["文件", "file"],
    ["文件夹", "folder"],
    ["命令", "command"],
    ["安装", "install"],
    ["配置", "configuration"],
    ["智能体", "agent"],
    ["技能", "skill"],
    ["规则", "rule"],
    ["工作流", "workflow"],
    ["安全", "security"],
    ["测试", "test"],
    ["开发", "development"]
  ])
};

const repoLanguageDirs = {
  "zh-CN": "zh-CN",
  en: "en",
  ja: "ja-JP",
  ko: "ko-KR"
};

function candidateTranslationPaths(sourcePath, targetLanguage) {
  const normalizedPath = String(sourcePath || "").replaceAll("\\", "/");
  if (!normalizedPath) return [];

  const targetDir = repoLanguageDirs[targetLanguage] || targetLanguage;
  const candidates = [];
  const segments = normalizedPath.split("/");
  const fileName = segments.at(-1) || "";
  const extension = extname(fileName);
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;

  if (targetLanguage === "en") {
    if (fileName === "README.zh-CN.md" || fileName === "README.zh-TW.md") candidates.push("README.md");
    if (segments[0] === "docs" && segments.length > 2) candidates.push(segments.slice(2).join("/"));
  }

  if (normalizedPath === "README.md") {
    candidates.push(`README.${targetDir}.md`, `docs/${targetDir}/README.md`);
  }

  if (!normalizedPath.startsWith("docs/")) {
    candidates.push(`docs/${targetDir}/${normalizedPath}`);
  }

  if (extension) {
    const sibling = [...segments.slice(0, -1), `${stem}.${targetDir}${extension}`].join("/");
    candidates.push(sibling);
  }

  if (segments[0] === "docs" && segments.length > 2) {
    const replaced = ["docs", targetDir, ...segments.slice(2)].join("/");
    candidates.push(replaced);
  }

  return [...new Set(candidates.filter((candidate) => candidate !== normalizedPath))];
}

async function findRepositoryTranslation(root, sourcePath, targetLanguage) {
  if (!root || !sourcePath) return null;

  for (const candidate of candidateTranslationPaths(sourcePath, targetLanguage)) {
    const absolutePath = safeRepoPath(root, candidate);
    if (!existsSync(absolutePath)) continue;

    const fileStats = await stat(absolutePath);
    if (!fileStats.isFile() || fileStats.size > maxTextBytes) continue;

    const buffer = await readFile(absolutePath, { encoding: null });
    if (!detectText(buffer.subarray(0, 4096))) continue;

    return {
      translatedText: buffer.toString("utf8"),
      candidatePath: candidate
    };
  }

  return null;
}

function localGlossaryReplace(text, targetLanguage) {
  const glossary = localGlossaries[targetLanguage] || localGlossaries["zh-CN"];
  let translated = text;
  for (const [source, target] of glossary.entries()) {
    translated = translated.replaceAll(source, target);
  }
  return translated;
}

function localTranslate(text, targetLanguage) {
  const languageLabel = { "zh-CN": "简体中文", en: "English", ja: "日本語", ko: "한국어" }[targetLanguage] || targetLanguage;
  return `> 未配置可用的远程翻译服务，以下内容仅使用本地术语表替换（${languageLabel}），不是完整翻译。\n\n${localGlossaryReplace(text, targetLanguage)}`;
}

function splitForTranslation(text, maxLength = 4200) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let index = remaining.lastIndexOf("\n\n", maxLength);
    if (index < maxLength * 0.45) index = remaining.lastIndexOf("\n", maxLength);
    if (index < maxLength * 0.45) index = remaining.lastIndexOf(". ", maxLength);
    if (index < maxLength * 0.45) index = maxLength;
    chunks.push(remaining.slice(0, index).trimEnd());
    remaining = remaining.slice(index).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function normalizeFreeLanguage(language) {
  const map = {
    "zh-CN": "zh-CN",
    zh: "zh-CN",
    en: "en",
    ja: "ja",
    ko: "ko"
  };
  return map[language] || language;
}

function translateLog(event, details = {}) {
  if (!translateLogEnabled) return;
  const fields = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  console.log(`[translate] ${new Date().toISOString()} ${event}${fields ? ` ${fields}` : ""}`);
}

function durationSince(startedAt) {
  return `${Date.now() - startedAt}ms`;
}

function errorMessage(error) {
  return error?.message || String(error);
}

function redactProxyUrl(proxyUrl) {
  if (!proxyUrl) return "";
  try {
    const url = new URL(proxyUrl);
    if (url.username) url.username = "***";
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return proxyUrl.replace(/\/\/[^@/]+@/, "//***@");
  }
}

function normalizeProxyUrl(value) {
  const proxy = String(value || "").trim();
  if (!proxy) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(proxy)) return proxy;
  return `http://${proxy}`;
}

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  return !["0", "false", "off", "no"].includes(String(value).trim().toLowerCase());
}

function proxyConfig() {
  const enabled = parseBoolean(process.env.TRANSLATE_PROXY_ENABLED, true);
  const url = normalizeProxyUrl(process.env.TRANSLATE_PROXY_URL || defaultTranslateProxyUrl);
  return { enabled, url };
}

function proxyForUrl() {
  const config = proxyConfig();
  if (!config.enabled || !config.url) return { source: "disabled", url: "" };
  return { source: "configured", url: config.url };
}

function proxyAuthorization(proxyUrl) {
  const username = decodeURIComponent(proxyUrl.username || "");
  const password = decodeURIComponent(proxyUrl.password || "");
  if (!username && !password) return "";
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function openTcpSocket(host, port, timeoutMs) {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = netConnect({ host, port });
    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
    };
    const onConnect = () => {
      cleanup();
      resolveSocket(socket);
    };
    const onError = (error) => {
      cleanup();
      rejectSocket(error);
    };
    const onTimeout = () => {
      cleanup();
      socket.destroy();
      rejectSocket(new Error(`Proxy connection timed out: ${host}:${port}`));
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
  });
}

function writeSocket(socket, data) {
  return new Promise((resolveWrite, rejectWrite) => {
    socket.write(data, (error) => {
      if (error) rejectWrite(error);
      else resolveWrite();
    });
  });
}

function readHeaders(socket, timeoutMs) {
  return new Promise((resolveHeaders, rejectHeaders) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      cleanup();
      socket.pause();
      resolveHeaders({
        header: buffer.subarray(0, headerEnd).toString("latin1"),
        rest: buffer.subarray(headerEnd + 4)
      });
    };
    const onError = (error) => {
      cleanup();
      rejectHeaders(error);
    };
    const onTimeout = () => {
      cleanup();
      socket.destroy();
      rejectHeaders(new Error("Timed out while reading proxy response."));
    };
    socket.setTimeout(timeoutMs);
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    socket.resume();
  });
}

function connectTlsSocket(socket, servername, timeoutMs) {
  return new Promise((resolveTls, rejectTls) => {
    const tlsSocket = tlsConnect({ socket, servername });
    const cleanup = () => {
      tlsSocket.off("secureConnect", onConnect);
      tlsSocket.off("error", onError);
      tlsSocket.off("timeout", onTimeout);
    };
    const onConnect = () => {
      cleanup();
      resolveTls(tlsSocket);
    };
    const onError = (error) => {
      cleanup();
      rejectTls(error);
    };
    const onTimeout = () => {
      cleanup();
      tlsSocket.destroy();
      rejectTls(new Error(`TLS connection timed out: ${servername}`));
    };
    tlsSocket.setTimeout(timeoutMs);
    tlsSocket.once("secureConnect", onConnect);
    tlsSocket.once("error", onError);
    tlsSocket.once("timeout", onTimeout);
  });
}

function readSocketToEnd(socket, initialBuffer, timeoutMs) {
  return new Promise((resolveRead, rejectRead) => {
    const chunks = initialBuffer?.length ? [initialBuffer] : [];
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
    };
    const onData = (chunk) => chunks.push(chunk);
    const onEnd = () => {
      cleanup();
      resolveRead(Buffer.concat(chunks));
    };
    const onError = (error) => {
      cleanup();
      rejectRead(error);
    };
    const onTimeout = () => {
      cleanup();
      socket.destroy();
      rejectRead(new Error("Timed out while reading response."));
    };
    socket.setTimeout(timeoutMs);
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    socket.resume();
  });
}

function parseHeaderBlock(headerBlock) {
  const lines = headerBlock.split("\r\n");
  const statusMatch = lines.shift()?.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)\s*(.*)$/i);
  const status = Number(statusMatch?.[1] || 0);
  const statusText = statusMatch?.[2] || "";
  const headers = {};
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return { status, statusText, headers };
}

function decodeChunkedBody(buffer) {
  const chunks = [];
  let offset = 0;
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf("\r\n", offset);
    if (lineEnd < 0) break;
    const sizeText = buffer.subarray(offset, lineEnd).toString("latin1").split(";")[0].trim();
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size)) break;
    offset = lineEnd + 2;
    if (size === 0) break;
    chunks.push(buffer.subarray(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(chunks);
}

function responseBodyBuffer(headers, body) {
  if (headers["transfer-encoding"]?.toLowerCase().includes("chunked")) {
    return decodeChunkedBody(body);
  }
  return body;
}

function buildRequestHeaders(target, options, body, useAbsoluteUrl = false, proxyAuth = "") {
  const headers = {
    host: target.host,
    accept: "application/json",
    "accept-encoding": "identity",
    connection: "close",
    ...(options.headers || {})
  };
  if (body) headers["content-length"] = Buffer.byteLength(body);
  if (proxyAuth) headers["proxy-authorization"] = proxyAuth;

  const path = useAbsoluteUrl ? String(target) : `${target.pathname}${target.search}`;
  const method = options.method || "GET";
  const lines = [`${method} ${path || "/"} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && value !== null && value !== "") lines.push(`${name}: ${value}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

async function fetchJsonViaProxy(target, options, proxyInfo) {
  const proxy = new URL(proxyInfo.url);
  const proxyHost = proxy.hostname;
  const proxyPort = Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
  if (proxy.protocol !== "http:") {
    throw new Error(`Only HTTP proxies are supported: ${redactProxyUrl(proxyInfo.url)}`);
  }

  const timeoutMs = options.timeoutMs || translateTimeoutMs;
  let socket = await openTcpSocket(proxyHost, proxyPort, timeoutMs);
  const body = options.body || "";
  const proxyAuth = proxyAuthorization(proxy);

  try {
    if (target.protocol === "https:") {
      const targetPort = target.port || 443;
      const connectHeaders = [
        `CONNECT ${target.hostname}:${targetPort} HTTP/1.1`,
        `Host: ${target.hostname}:${targetPort}`,
        "Proxy-Connection: Keep-Alive",
        proxyAuth ? `Proxy-Authorization: ${proxyAuth}` : ""
      ]
        .filter(Boolean)
        .join("\r\n");
      const connectRequest = `${connectHeaders}\r\n\r\n`;
      await writeSocket(socket, connectRequest);
      const connectResponse = await readHeaders(socket, timeoutMs);
      const connectStatus = parseHeaderBlock(connectResponse.header);
      if (connectStatus.status !== 200) {
        throw new Error(`Proxy CONNECT failed: ${connectStatus.status} ${connectStatus.statusText}`.trim());
      }
      socket = await connectTlsSocket(socket, target.hostname, timeoutMs);
      await writeSocket(socket, `${buildRequestHeaders(target, options, body)}${body}`);
    } else {
      await writeSocket(socket, `${buildRequestHeaders(target, options, body, true, proxyAuth)}${body}`);
    }

    const response = await readHeaders(socket, timeoutMs);
    const meta = parseHeaderBlock(response.header);
    const rawBody = await readSocketToEnd(socket, response.rest, timeoutMs);
    const payload = responseBodyBuffer(meta.headers, rawBody).toString("utf8");
    if (meta.status < 200 || meta.status >= 300) {
      throw new Error(`${target.host} returned ${meta.status}`);
    }
    return JSON.parse(payload);
  } finally {
    socket.destroy();
  }
}

async function fetchJson(url, options = {}) {
  const startedAt = Date.now();
  const target = new URL(String(url));
  const proxyInfo = proxyForUrl();
  const method = options.method || "GET";
  const proxyLabel = proxyInfo.url ? `${proxyInfo.source}:${redactProxyUrl(proxyInfo.url)}` : proxyInfo.source;
  const mode = proxyInfo.url ? "configured-proxy" : "node-fetch";

  translateLog("http-start", { method, host: target.host, mode, proxy: proxyLabel });

  try {
    const data = proxyInfo.url
      ? await fetchJsonViaProxy(target, options, proxyInfo)
      : await fetch(url, {
          method,
          headers: options.headers,
          body: options.body,
          signal: AbortSignal.timeout(options.timeoutMs || translateTimeoutMs)
        }).then(async (response) => {
          if (!response.ok) throw new Error(`${target.host} returned ${response.status}`);
          return response.json();
        });
    translateLog("http-ok", { method, host: target.host, mode, elapsed: durationSince(startedAt) });
    return data;
  } catch (error) {
    translateLog("http-failed", { method, host: target.host, mode, elapsed: durationSince(startedAt), error: errorMessage(error) });
    throw error;
  }
}

async function googleFreeTranslate(text, targetLanguage, sourceLanguage) {
  const chunks = splitForTranslation(text);
  const translatedChunks = [];
  translateLog("provider-start", { provider: "google-free", chunks: chunks.length, chars: text.length, target: targetLanguage });
  for (const [index, chunk] of chunks.entries()) {
    const url = new URL("https://translate.googleapis.com/translate_a/single");
    url.searchParams.set("client", "gtx");
    url.searchParams.set("sl", sourceLanguage === "auto" ? "auto" : normalizeFreeLanguage(sourceLanguage));
    url.searchParams.set("tl", normalizeFreeLanguage(targetLanguage));
    url.searchParams.set("dt", "t");
    url.searchParams.set("q", chunk);
    translateLog("chunk-start", { provider: "google-free", chunk: `${index + 1}/${chunks.length}`, chars: chunk.length });
    const data = await fetchGoogleFreeJson(url);
    const translated = data?.[0]?.map((part) => part?.[0] || "").join("");
    if (!translated) throw new Error("Google free translate returned an empty result.");
    translatedChunks.push(translated);
    translateLog("chunk-ok", { provider: "google-free", chunk: `${index + 1}/${chunks.length}` });
  }
  return translatedChunks.join("\n\n");
}

async function fetchGoogleFreeJson(url) {
  return fetchJson(url, { timeoutMs: translateTimeoutMs });
}

async function myMemoryTranslate(text, targetLanguage, sourceLanguage) {
  const chunks = splitForTranslation(text, 450);
  const translatedChunks = [];
  const source = sourceLanguage === "auto" ? "en" : normalizeFreeLanguage(sourceLanguage);
  const target = normalizeFreeLanguage(targetLanguage);
  translateLog("provider-start", { provider: "mymemory-free", chunks: chunks.length, chars: text.length, target: targetLanguage });
  for (const [index, chunk] of chunks.entries()) {
    const url = new URL("https://api.mymemory.translated.net/get");
    url.searchParams.set("q", chunk);
    url.searchParams.set("langpair", `${source}|${target}`);
    translateLog("chunk-start", { provider: "mymemory-free", chunk: `${index + 1}/${chunks.length}`, chars: chunk.length });
    const data = await fetchJson(url, { timeoutMs: translateTimeoutMs });
    const translated = data?.responseData?.translatedText;
    if (!translated) throw new Error("MyMemory translate returned an empty result.");
    translatedChunks.push(translated);
    translateLog("chunk-ok", { provider: "mymemory-free", chunk: `${index + 1}/${chunks.length}` });
  }
  return translatedChunks.join("\n\n");
}

async function remoteTranslate(text, targetLanguage, sourceLanguage) {
  const provider = freeTranslateProvider(process.env.TRANSLATE_PROVIDER);
  translateLog("remote-provider", { provider, chars: text.length, target: targetLanguage });
  if (provider === "google-free") {
    try {
      return await googleFreeTranslate(text, targetLanguage, sourceLanguage);
    } catch (error) {
      translateLog("provider-fallback", { from: "google-free", to: "mymemory-free", error: errorMessage(error) });
      return myMemoryTranslate(text, targetLanguage, sourceLanguage);
    }
  }
  if (provider === "mymemory-free") return myMemoryTranslate(text, targetLanguage, sourceLanguage);
}

function freeTranslateProvider(provider) {
  return provider === "mymemory-free" ? "mymemory-free" : defaultTranslateProvider;
}

function translationConfig() {
  const provider = freeTranslateProvider(process.env.TRANSLATE_PROVIDER);
  const proxy = proxyConfig();
  return {
    remoteConfigured: true,
    provider,
    proxy,
    repositoryTranslations: true,
    localFallback: true
  };
}

function handleTranslationStatus(response) {
  sendJson(response, 200, translationConfig());
}

function serializeEnvValue(value) {
  const stringValue = String(value || "");
  if (!stringValue || /^[A-Za-z0-9_./:?-]+$/.test(stringValue)) return stringValue;
  return JSON.stringify(stringValue);
}

async function saveTranslationConfig(config) {
  const provider = freeTranslateProvider(config.provider);
  const proxyEnabled = parseBoolean(config.proxyEnabled, true);
  const proxyUrl = normalizeProxyUrl(config.proxyUrl || defaultTranslateProxyUrl);

  process.env.TRANSLATE_PROVIDER = provider;
  delete process.env.TRANSLATE_ENDPOINT;
  delete process.env.TRANSLATE_MODEL;
  process.env.TRANSLATE_PROXY_ENABLED = proxyEnabled ? "1" : "0";
  process.env.TRANSLATE_PROXY_URL = proxyUrl;
  delete process.env.TRANSLATE_API_KEY;

  const lines = [
    "# Saved by Repo Viewer. Do not commit this file.",
    `TRANSLATE_PROVIDER=${serializeEnvValue(process.env.TRANSLATE_PROVIDER)}`,
    `TRANSLATE_PROXY_ENABLED=${serializeEnvValue(process.env.TRANSLATE_PROXY_ENABLED)}`,
    `TRANSLATE_PROXY_URL=${serializeEnvValue(process.env.TRANSLATE_PROXY_URL)}`
  ];
  await writeFile(envPath, `${lines.join("\n")}\n`, "utf8");
  translationCache.clear();
  return translationConfig();
}

async function handleSaveTranslationConfig(request, response) {
  let payload = "";
  for await (const chunk of request) {
    payload += chunk;
    if (payload.length > 64 * 1024) {
      sendError(response, 413, "Translation config payload is too large.");
      return;
    }
  }
  const body = JSON.parse(payload || "{}");
  const config = await saveTranslationConfig(body);
  sendJson(response, 200, config);
}

async function handleTranslate(request, response) {
  const requestStartedAt = Date.now();
  let payload = "";
  for await (const chunk of request) {
    payload += chunk;
    if (payload.length > maxTextBytes * 2) {
      sendError(response, 413, "Translation payload is too large.");
      return;
    }
  }

  const body = JSON.parse(payload || "{}");
  const text = String(body.text || "");
  const targetLanguage = String(body.targetLanguage || "zh-CN");
  const sourceLanguage = String(body.sourceLanguage || "auto");
  const sourcePath = String(body.path || "");
  const root = body.root ? safeRoot(String(body.root)) : null;
  const key = createHash("sha256").update(`${targetLanguage}:${sourceLanguage}:${sourcePath}:${text}`).digest("hex");
  translateLog("request-start", {
    path: sourcePath || "(inline)",
    provider: process.env.TRANSLATE_PROVIDER || defaultTranslateProvider,
    target: targetLanguage,
    chars: text.length
  });

  if (translationCache.has(key)) {
    translateLog("request-cache-hit", { path: sourcePath || "(inline)", elapsed: durationSince(requestStartedAt) });
    sendJson(response, 200, { ...translationCache.get(key), cached: true });
    return;
  }

  const repositoryTranslation = await findRepositoryTranslation(root, sourcePath, targetLanguage);
  if (repositoryTranslation) {
    translateLog("request-repository-hit", { path: sourcePath, translation: repositoryTranslation.candidatePath, elapsed: durationSince(requestStartedAt) });
    const result = {
      translatedText: repositoryTranslation.translatedText,
      targetLanguage,
      sourceLanguage,
      provider: "repository",
      sourcePath: repositoryTranslation.candidatePath
    };
    translationCache.set(key, result);
    sendJson(response, 200, result);
    return;
  }

  let provider = "local";
  let translated = null;
  let fallbackReason = "";

  if (!shouldTranslateFile(body)) {
    translateLog("request-skipped-code", { path: sourcePath || "(inline)", chars: text.length, elapsed: durationSince(requestStartedAt) });
    const result = {
      translatedText: text,
      targetLanguage,
      sourceLanguage,
      provider: "skipped-code",
      fallbackReason: "代码或结构化配置文件未送入翻译，已原样显示。"
    };
    translationCache.set(key, result);
    sendJson(response, 200, result);
    return;
  }

  try {
    translated = await translateMarkdownWithoutCode(text, targetLanguage, sourceLanguage);
    if (translated) provider = freeTranslateProvider(process.env.TRANSLATE_PROVIDER);
  } catch (error) {
    translated = null;
    fallbackReason = error.message || "Remote translation failed.";
    translateLog("request-remote-failed", { path: sourcePath || "(inline)", error: errorMessage(error) });
  }

  if (!translated) {
    translateLog("request-local-fallback", { path: sourcePath || "(inline)", reason: fallbackReason || "empty translation" });
    translated = localTranslateMarkdownWithoutCode(text, targetLanguage);
  }

  const result = {
    translatedText: translated,
    targetLanguage,
    sourceLanguage,
    provider,
    fallbackReason
  };
  translationCache.set(key, result);
  translateLog("request-done", { path: sourcePath || "(inline)", provider, elapsed: durationSince(requestStartedAt), fallback: fallbackReason ? "yes" : "no" });
  sendJson(response, 200, result);
}

async function serveStatic(requestUrl, response) {
  const pathname = requestUrl.pathname === "/" ? "/index.html" : decodeURIComponent(requestUrl.pathname);
  const absolutePath = resolve(staticRoot, `.${pathname}`);
  const relativePath = relative(staticRoot, absolutePath);

  if (relativePath.startsWith("..") || relativePath === "..") {
    sendError(response, 403, "Forbidden.");
    return;
  }

  if (!existsSync(absolutePath)) {
    sendError(response, 404, "Not found.");
    return;
  }

  const extension = extname(absolutePath).toLowerCase();
  const fileStats = await stat(absolutePath);
  response.writeHead(200, {
    "content-type": mimeTypes.get(extension) || "application/octet-stream",
    "content-length": fileStats.size
  });
  createReadStream(absolutePath).pipe(response);
}

async function handleRequest(request, response) {
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  try {
    if (request.method === "GET" && requestUrl.pathname === "/api/tree") {
      await handleTree(requestUrl, response);
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/file") {
      await handleFile(requestUrl, response);
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/raw") {
      await handleRaw(requestUrl, response);
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/translate") {
      await handleTranslate(request, response);
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/translation-status") {
      handleTranslationStatus(response);
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/translation-config") {
      await handleSaveTranslationConfig(request, response);
      return;
    }
    if (request.method === "GET") {
      await serveStatic(requestUrl, response);
      return;
    }
    sendError(response, 405, "Method not allowed.");
  } catch (error) {
    sendError(response, error.statusCode || 500, error.message || "Unexpected server error.");
  }
}

async function runCheck() {
  const root = safeRoot(process.env.REPO_ROOT || defaultRepoRoot);
  const children = await readDirectoryLevel(root, root);
  if (!children.length) {
    throw new Error("Tree scan returned no entries.");
  }
  const readmePath = join(root, "README.md");
  if (existsSync(readmePath)) {
    const content = await readFile(readmePath, "utf8");
    if (!content.trim()) {
      throw new Error("README.md is empty.");
    }
  }
  console.log(`check ok: scanned root directory with ${children.length} entries from ${root}`);
}

if (process.argv.includes("--check")) {
  runCheck().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
} else {
  createServer(handleRequest).listen(port, () => {
    console.log(`Repo Viewer running at http://localhost:${port}`);
    console.log(`Default repository: ${defaultRepoRoot}`);
    console.log(`Translation provider: ${process.env.TRANSLATE_PROVIDER || defaultTranslateProvider}`);
    console.log(`Translation config: ${envPath}`);
    const proxyInfo = proxyForUrl();
    const proxyLabel = proxyInfo.url ? `${proxyInfo.source}:${redactProxyUrl(proxyInfo.url)}` : proxyInfo.source;
    console.log(`Translation proxy: ${proxyLabel}`);
  });
}
