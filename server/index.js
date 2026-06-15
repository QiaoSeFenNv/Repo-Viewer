import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { lstat, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(__dirname, "..");
const staticRoot = join(projectRoot, "src");
const defaultRepoRoot = resolve(process.env.REPO_ROOT || process.cwd());
const envPath = resolve(process.env.REPO_VIEWER_ENV_PATH || join(projectRoot, ".env"));
const execFileAsync = promisify(execFile);

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
let windowsProxyConfigPromise = null;

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

async function translateMarkdownWithoutCode(markdown, targetLanguage, sourceLanguage) {
  const parts = splitMarkdownForTranslation(markdown);
  const translatedParts = new Array(parts.length);

  await mapWithConcurrency(parts, translationConcurrency(), async (part, index) => {
    if (part.type === "code") {
      translatedParts[index] = part.value;
      return;
    }

    const leading = part.value.match(/^\s*/)?.[0] || "";
    const trailing = part.value.match(/\s*$/)?.[0] || "";
    const core = part.value.slice(leading.length, part.value.length - trailing.length);
    if (!core) {
      translatedParts[index] = part.value;
      return;
    }

    const translated = await remoteTranslate(core, targetLanguage, sourceLanguage);
    if (!translated) throw new Error("Translation provider is not configured.");
    translatedParts[index] = `${leading}${translated}${trailing}`;
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

function envProxyForUrl(targetUrl) {
  const protocol = new URL(String(targetUrl)).protocol;
  const candidates =
    protocol === "https:"
      ? ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"]
      : ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
  for (const name of candidates) {
    const value = process.env[name];
    if (value) {
      return {
        source: process.platform === "win32" ? name : `${name}-unsupported`,
        url: process.platform === "win32" ? normalizeProxyUrl(value) : "",
        usePowerShell: process.platform === "win32"
      };
    }
  }
  return null;
}

function selectWindowsProxy(proxyServer, protocol) {
  const raw = String(proxyServer || "").trim();
  if (!raw) return "";
  if (!raw.includes("=")) return normalizeProxyUrl(raw.split(";")[0]);

  const entries = new Map();
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    entries.set(part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim());
  }

  const key = protocol.replace(":", "").toLowerCase();
  return normalizeProxyUrl(entries.get(key) || entries.get("http") || entries.values().next().value || "");
}

async function windowsProxyConfig() {
  if (process.platform !== "win32" || process.env.REPO_VIEWER_DISABLE_SYSTEM_PROXY === "1") return null;
  if (!windowsProxyConfigPromise) {
    windowsProxyConfigPromise = execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        [
          "$p=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';",
          "[Console]::OutputEncoding=[Text.UTF8Encoding]::UTF8;",
          "[pscustomobject]@{ProxyEnable=$p.ProxyEnable;ProxyServer=$p.ProxyServer;AutoConfigURL=$p.AutoConfigURL}|ConvertTo-Json -Compress"
        ].join(" ")
      ],
      { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 256 }
    )
      .then(({ stdout }) => JSON.parse(stdout || "{}"))
      .catch((error) => {
        translateLog("proxy-detect-failed", { error: errorMessage(error) });
        return null;
      });
  }
  return windowsProxyConfigPromise;
}

async function proxyForUrl(targetUrl) {
  const envProxy = envProxyForUrl(targetUrl);
  if (envProxy) return envProxy;

  const config = await windowsProxyConfig();
  if (!config) return { source: "none", url: "", usePowerShell: false };

  const proxyEnabled = Number(config.ProxyEnable) === 1;
  const proxyUrl = proxyEnabled ? selectWindowsProxy(config.ProxyServer, new URL(String(targetUrl)).protocol) : "";
  if (proxyUrl) return { source: "windows-system", url: proxyUrl, usePowerShell: true };
  if (config.AutoConfigURL) return { source: "windows-pac", url: "", usePowerShell: true };
  return { source: "none", url: "", usePowerShell: false };
}

async function fetchJsonWithPowerShell(url, options = {}, proxyInfo = {}) {
  const headers = options.headers || {};
  const env = {
    ...process.env,
    REPO_VIEWER_REQUEST_URL: String(url),
    REPO_VIEWER_REQUEST_METHOD: options.method || "GET",
    REPO_VIEWER_REQUEST_BODY: options.body || "",
    REPO_VIEWER_REQUEST_CONTENT_TYPE: headers["content-type"] || headers["Content-Type"] || "",
    REPO_VIEWER_REQUEST_AUTHORIZATION: headers.authorization || headers.Authorization || "",
    REPO_VIEWER_PROXY_URL: proxyInfo.url || ""
  };
  const command = [
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::UTF8;",
    "$headers=@{};",
    "if ($env:REPO_VIEWER_REQUEST_AUTHORIZATION) { $headers['Authorization']=$env:REPO_VIEWER_REQUEST_AUTHORIZATION };",
    "$params=@{Uri=$env:REPO_VIEWER_REQUEST_URL;Method=$env:REPO_VIEWER_REQUEST_METHOD;TimeoutSec=[Math]::Ceiling($env:REPO_VIEWER_TIMEOUT_MS/1000);UseBasicParsing=$true};",
    "if ($headers.Count -gt 0) { $params.Headers=$headers };",
    "if ($env:REPO_VIEWER_REQUEST_BODY) { $params.Body=$env:REPO_VIEWER_REQUEST_BODY; if ($env:REPO_VIEWER_REQUEST_CONTENT_TYPE) { $params.ContentType=$env:REPO_VIEWER_REQUEST_CONTENT_TYPE } else { $params.ContentType='application/json; charset=utf-8' } };",
    "if ($env:REPO_VIEWER_PROXY_URL) { $params.Proxy=$env:REPO_VIEWER_PROXY_URL };",
    "(Invoke-WebRequest @params).Content"
  ].join(" ");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], {
    timeout: options.timeoutMs || translateTimeoutMs + 5000,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 8,
    env: { ...env, REPO_VIEWER_TIMEOUT_MS: String(options.timeoutMs || translateTimeoutMs) }
  });
  return JSON.parse(stdout);
}

async function fetchJson(url, options = {}) {
  const startedAt = Date.now();
  const target = new URL(String(url));
  const proxyInfo = await proxyForUrl(target);
  const method = options.method || "GET";
  const proxyLabel = proxyInfo.url ? `${proxyInfo.source}:${redactProxyUrl(proxyInfo.url)}` : proxyInfo.source;
  const usePowerShell = process.platform === "win32" && (proxyInfo.usePowerShell || proxyInfo.url);

  translateLog("http-start", { method, host: target.host, mode: usePowerShell ? "powershell" : "node-fetch", proxy: proxyLabel });

  if (usePowerShell) {
    try {
      const data = await fetchJsonWithPowerShell(url, options, proxyInfo);
      translateLog("http-ok", { method, host: target.host, mode: "powershell", elapsed: durationSince(startedAt) });
      return data;
    } catch (error) {
      translateLog("http-failed", { method, host: target.host, mode: "powershell", elapsed: durationSince(startedAt), error: errorMessage(error) });
      throw error;
    }
  }

  try {
    const response = await fetch(url, {
      method,
      headers: options.headers,
      body: options.body,
      signal: AbortSignal.timeout(options.timeoutMs || translateTimeoutMs)
    });
    if (!response.ok) throw new Error(`${target.host} returned ${response.status}`);
    const data = await response.json();
    translateLog("http-ok", { method, host: target.host, mode: "node-fetch", elapsed: durationSince(startedAt) });
    return data;
  } catch (error) {
    if (process.platform !== "win32") {
      translateLog("http-failed", { method, host: target.host, mode: "node-fetch", elapsed: durationSince(startedAt), error: errorMessage(error) });
      throw error;
    }
    translateLog("http-retry", { method, host: target.host, from: "node-fetch", to: "powershell", error: errorMessage(error) });
    try {
      const data = await fetchJsonWithPowerShell(url, options, proxyInfo);
      translateLog("http-ok", { method, host: target.host, mode: "powershell", elapsed: durationSince(startedAt) });
      return data;
    } catch (retryError) {
      translateLog("http-failed", { method, host: target.host, mode: "powershell", elapsed: durationSince(startedAt), error: errorMessage(retryError) });
      throw retryError;
    }
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
  const provider = process.env.TRANSLATE_PROVIDER || defaultTranslateProvider;
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

  const endpoint = process.env.TRANSLATE_ENDPOINT;
  if (!endpoint) return null;
  const apiKey = process.env.TRANSLATE_API_KEY;
  const headers = {
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
  };

  if (provider === "openai-compatible") {
    const model = process.env.TRANSLATE_MODEL;
    if (!model) throw new Error("TRANSLATE_MODEL is required for openai-compatible provider.");

    const data = await fetchJson(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content:
              "You are a precise software documentation translator. Preserve Markdown, code blocks, inline code, links, paths, identifiers, commands, and frontmatter exactly. Return only the translated content."
          },
          {
            role: "user",
            content: `Translate from ${sourceLanguage} to ${targetLanguage}:\n\n${text}`
          }
        ]
      }),
      timeoutMs: translateTimeoutMs
    });
    return data.choices?.[0]?.message?.content || null;
  }

  const data = await fetchJson(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text,
      targetLanguage,
      sourceLanguage,
      preserveMarkdown: true,
      preserveCodeBlocks: true
    }),
    timeoutMs: translateTimeoutMs
  });

  return data.translation || data.translatedText || data.text || null;
}

function translationConfig() {
  const endpoint = process.env.TRANSLATE_ENDPOINT || "";
  const provider = process.env.TRANSLATE_PROVIDER || defaultTranslateProvider;
  const freeProvider = provider === "google-free" || provider === "mymemory-free";
  return {
    remoteConfigured: freeProvider || Boolean(endpoint && (provider !== "openai-compatible" || process.env.TRANSLATE_MODEL)),
    endpointConfigured: Boolean(endpoint),
    apiKeyConfigured: Boolean(process.env.TRANSLATE_API_KEY),
    provider,
    endpoint,
    model: process.env.TRANSLATE_MODEL || "",
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
  const allowedProviders = new Set(["generic", "openai-compatible", "google-free", "mymemory-free"]);
  const provider = allowedProviders.has(config.provider) ? config.provider : defaultTranslateProvider;
  const isFreeProvider = provider === "google-free" || provider === "mymemory-free";
  const endpoint = isFreeProvider ? "" : String(config.endpoint || "").trim();
  const model = provider === "openai-compatible" ? String(config.model || "").trim() : "";
  const apiKey = String(config.apiKey || "").trim();

  process.env.TRANSLATE_PROVIDER = provider;
  process.env.TRANSLATE_ENDPOINT = endpoint;
  process.env.TRANSLATE_MODEL = model;
  if (apiKey) {
    process.env.TRANSLATE_API_KEY = apiKey;
  } else if (isFreeProvider || config.clearApiKey) {
    delete process.env.TRANSLATE_API_KEY;
  }

  const lines = [
    "# Saved by Repo Viewer. Do not commit this file.",
    `TRANSLATE_PROVIDER=${serializeEnvValue(process.env.TRANSLATE_PROVIDER)}`,
    `TRANSLATE_ENDPOINT=${serializeEnvValue(process.env.TRANSLATE_ENDPOINT)}`,
    `TRANSLATE_MODEL=${serializeEnvValue(process.env.TRANSLATE_MODEL)}`,
    `TRANSLATE_API_KEY=${serializeEnvValue(process.env.TRANSLATE_API_KEY || "")}`
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
    if (translated) provider = process.env.TRANSLATE_PROVIDER || defaultTranslateProvider;
  } catch (error) {
    translated = null;
    fallbackReason = error.message || "Remote translation failed.";
    translateLog("request-remote-failed", { path: sourcePath || "(inline)", error: errorMessage(error) });
  }

  if (!translated) {
    const configuredProvider = process.env.TRANSLATE_PROVIDER || defaultTranslateProvider;
    if (!process.env.TRANSLATE_ENDPOINT && configuredProvider !== "google-free" && configuredProvider !== "mymemory-free") {
      fallbackReason = "TRANSLATE_ENDPOINT is not configured.";
    }
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
    proxyForUrl("https://translate.googleapis.com")
      .then((proxyInfo) => {
        const proxyLabel = proxyInfo.url ? `${proxyInfo.source}:${redactProxyUrl(proxyInfo.url)}` : proxyInfo.source;
        console.log(`Translation proxy: ${proxyLabel}`);
      })
      .catch((error) => {
        console.log(`Translation proxy: detect failed (${errorMessage(error)})`);
      });
  });
}
