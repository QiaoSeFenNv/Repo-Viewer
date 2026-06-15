# Repo Viewer

Repo Viewer is a local web app for reading GitHub repositories as a browsable, translated workspace. It focuses on large repositories: directories are loaded on demand, files open in a preview pane, and Markdown/text files can be shown side by side with a Chinese translation.

## Features

- Local repository reader: paste any local repository path.
- Lazy file explorer: only the opened directory is scanned, so startup stays fast on large repos.
- Code preview: readable line numbers and light code blocks by default.
- Markdown preview: headings, lists, code blocks, inline code, links, and local images.
- Default Chinese comparison: Markdown/text files open in source + Chinese translation view.
- Translation optimization: common code/config files are skipped, Markdown code blocks/inline code are preserved, and text is batched to reduce provider calls.
- Translation feedback: the translated pane shows a loading animation while a translation is running.
- Translation providers: repository-local translations, free Google endpoint with MyMemory fallback, MyMemory, OpenAI-compatible APIs, or a custom generic POST endpoint.
- Themes: paper, light, dark, eye-care green, and high contrast.

## Run with npx

```bash
npx @8865a/repo-viewer C:\path\to\repo
```

Or pass options explicitly:

```bash
npx @8865a/repo-viewer --root C:\path\to\repo --port 4173
```

The command starts a local web server and prints the browser URL:

```text
Repo Viewer running at http://localhost:4173
```

If no repository path is provided, Repo Viewer opens the current working directory.

## Global install

```bash
npm install -g @8865a/repo-viewer
repo-viewer C:\path\to\repo
```

Useful CLI options:

```bash
repo-viewer --help
repo-viewer --version
repo-viewer --check --root C:\path\to\repo
repo-viewer --root C:\path\to\repo --port 4180
```

## Local development

```bash
npm start
```

Open:

```text
http://localhost:4173
```

By default the app reads the current working directory.

To open another local repository, paste its absolute path into the top input and click `读取`, or pass it in the URL:

```text
http://localhost:4173/?root=C:\path\to\repo
```

## Translation

Translation is resolved in this order:

1. Repository translation files, such as `README.zh-CN.md` or `docs/zh-CN/README.md`.
2. The configured provider in the page `配置` dialog.
3. Local glossary fallback for offline demos.

Free providers:

```env
TRANSLATE_PROVIDER=google-free
```

`google-free` is the default provider when no local translation config exists.

```env
TRANSLATE_PROVIDER=mymemory-free
```

`google-free` uses an unofficial Google Translate endpoint. It needs no API key. On Windows, the app can fall back to the system PowerShell HTTP stack when Node's direct Google request is blocked or slow. `mymemory-free` also needs no API key and is best for shorter text.

## Translation diagnostics and proxy

Repo Viewer prints translation diagnostics in the terminal by default. The logs include the selected provider, chunk count, HTTP host, proxy source, elapsed time, and fallback reason. They do not print source document text or API keys.

On Windows, translation requests automatically use the current system proxy when one is configured in Windows Internet Settings. Environment proxies are also recognized:

```powershell
$env:HTTPS_PROXY="http://127.0.0.1:7897"
$env:TRANSLATE_PROVIDER="google-free"
npx @8865a/repo-viewer C:\path\to\repo
```

Useful diagnostics:

```powershell
$env:TRANSLATE_LOG="1"
npx @8865a/repo-viewer --check --root C:\path\to\repo
npx @8865a/repo-viewer C:\path\to\repo
```

To turn translation logs off:

```powershell
$env:TRANSLATE_LOG="0"
```

AI-compatible provider:

```env
TRANSLATE_PROVIDER=openai-compatible
TRANSLATE_ENDPOINT=https://api.openai.com/v1/chat/completions
TRANSLATE_MODEL=gpt-4.1-mini
TRANSLATE_API_KEY=your-api-key
```

Custom provider:

```env
TRANSLATE_PROVIDER=generic
TRANSLATE_ENDPOINT=http://localhost:8080/translate
TRANSLATE_API_KEY=
```

When running through the CLI, the page configuration dialog writes to `.repo-viewer.env` in the directory where the command was started. In local development it writes to `.env` in this project. Both files are ignored by git.

## API

- `GET /api/tree?root=<path>&path=<dir>`: read one directory level.
- `GET /api/file?root=<path>&path=<file>`: read a file preview.
- `GET /api/raw?root=<path>&path=<file>`: stream raw assets.
- `POST /api/translate`: translate Markdown/text while preserving code.
- `GET /api/translation-status`: inspect translation provider status.
- `POST /api/translation-config`: save translation provider settings.
