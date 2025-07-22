# Auditaria CLI

[![Auditaria CLI CI](https://github.com/thacio/auditaria/actions/workflows/ci.yml/badge.svg)](https://github.com/thacio/auditaria/actions/workflows/ci.yml)

![Auditaria CLI Screenshot](./docs/assets/auditaria-screenshot.png)

## About This Fork

Auditaria CLI is a specialized fork of the [Google Gemini CLI](https://github.com/google-gemini/gemini-cli) designed specifically for **audits**, **software engineering**, and **data analysis** workflows. This fork enhances the original tool with audit-focused features, multi-language support, and improved workflow capabilities while **maintaining all original software engineering capabilities** intact.

### Key Enhancements

- **🛠️ TODO Tool**: Complete task management system for tracking and organizing complex audit workflows
- **🌐 Multi-language Support**: Full internationalization with Portuguese and English support (with `/language` command)
- **⚙️ Advanced Model Control**: Enhanced slash commands for better AI model management:
  - `/model-switch` - Switch between Gemini Pro and Flash models
  - `/stay-pro` - Disable/enable fallback to Flash model
  - `/fallback-improved` - Toggle between retry strategies
- **🔄 Improved Retry Strategy**: 7 retries with 2-second delays and automatic reset to Gemini Pro on each user message
- **🎯 Audit-Focused Features**: Specialized system prompts and capabilities tailored for audit tasks
- **📊 Data Analysis Tools**: Enhanced capabilities for analyzing and working with audit data

### Language Support

Currently supports:
- **English** (en)
- **Portuguese** (pt)

Use the `/language` command to switch between supported languages at runtime.

---

This repository contains Auditaria CLI, a command-line AI workflow tool that connects to your
tools, understands your code and accelerates your workflows.

With Auditaria CLI you can:

- Query and edit large codebases in and beyond Gemini's 1M token context window.
- Generate new apps from PDFs or sketches, using Gemini's multimodal capabilities.
- Automate operational tasks, like querying pull requests or handling complex rebases.
- Use tools and MCP servers to connect new capabilities, including [media generation with Imagen,
  Veo or Lyria](https://github.com/GoogleCloudPlatform/vertex-ai-creative-studio/tree/main/experiments/mcp-genmedia)
- Ground your queries with the [Google Search](https://ai.google.dev/gemini-api/docs/grounding)
  tool, built into Gemini.

## Quickstart

### With Node

1. **Prerequisites:** Ensure you have [Node.js version 20](https://nodejs.org/en/download) or higher installed.
2. **Run the CLI:** Execute the following command in your terminal:

   ```bash
   npx https://github.com/thacio/auditaria-cli
   ```

   Or install it globally with:
   ```bash
   npm install -g https://github.com/thacio/auditaria-cli/releases/latest/download/auditaria-cli-latest.tgz
   ```
   or install globally by clones this repository
   
   ```bash
   git clone https://github.com/thacio/auditaria-cli
   cd ./auditaria-cli
   npm run build
   npm install -g .
   ```


   Then, run the CLI from anywhere:

   ```bash
   auditaria
   ```


### Corporate Firewall (MITM) Setup

If you're using Auditaria CLI behind a corporate firewall that performs man-in-the-middle (MITM) certificate inspection, you may encounter SSL certificate errors when the CLI tries to connect to to Google's server. Here's how to resolve this:

#### Windows Command Prompt (cmd)
```cmd
set NODE_TLS_REJECT_UNAUTHORIZED=0
auditaria
```

Or run both commands together:
```cmd
set NODE_TLS_REJECT_UNAUTHORIZED=0 && auditaria
```

#### Windows PowerShell
```powershell
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"
auditaria
```

Or run both commands together:
```powershell
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"; auditaria
```

#### Linux/macOS
```bash
export NODE_TLS_REJECT_UNAUTHORIZED=0
auditaria
```

Or run both commands together:
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 auditaria
```

#### Permanent Setting (Optional)
If you want to set it permanently for all sessions:

**Windows (System-wide, requires admin):**
```cmd
setx NODE_TLS_REJECT_UNAUTHORIZED 0 /M
```

**Windows (User-only):**
```cmd
setx NODE_TLS_REJECT_UNAUTHORIZED 0
```

**Linux/macOS (add to ~/.bashrc or ~/.zshrc):**
```bash
export NODE_TLS_REJECT_UNAUTHORIZED=0
```

Note: After using `setx` on Windows, restart your terminal for the change to take effect.

#### Reverting the Setting
To remove the environment variable and restore normal SSL certificate validation:

**Windows Command Prompt:**
```cmd
set NODE_TLS_REJECT_UNAUTHORIZED=
```

**Windows PowerShell:**
```powershell
Remove-Item Env:NODE_TLS_REJECT_UNAUTHORIZED
```

**Linux/macOS:**
```bash
unset NODE_TLS_REJECT_UNAUTHORIZED
```

**Remove permanent setting (Windows):**
```cmd
setx NODE_TLS_REJECT_UNAUTHORIZED "" /M
```
or
```cmd
setx NODE_TLS_REJECT_UNAUTHORIZED ""
```

**⚠️ Security Note:** This setting disables SSL certificate validation. Only use it in trusted corporate environments where IT controls the network infrastructure.

### Configuration

1. **Pick a color theme**
2. **Authenticate:** When prompted, sign in with your personal Google account. This will grant you up to 60 model requests per minute and 1,000 model requests per day using Gemini.

You are now ready to use Auditaria CLI!

### Use a Gemini API key:

The Gemini API provides a free tier with [100 requests per day](https://ai.google.dev/gemini-api/docs/rate-limits#free-tier) using Gemini 2.5 Pro, control over which model you use, and access to higher rate limits (with a paid plan):

1. Generate a key from [Google AI Studio](https://aistudio.google.com/apikey).
2. Set it as an environment variable in your terminal. Replace `YOUR_API_KEY` with your generated key.

   ```bash
   export GEMINI_API_KEY="YOUR_API_KEY"
   ```

3. (Optionally) Upgrade your Gemini API project to a paid plan on the API key page (will automatically unlock [Tier 1 rate limits](https://ai.google.dev/gemini-api/docs/rate-limits#tier-1))

### Use a Vertex AI API key:

The Vertex AI API provides a [free tier](https://cloud.google.com/vertex-ai/generative-ai/docs/start/express-mode/overview) using express mode for Gemini 2.5 Pro, control over which model you use, and access to higher rate limits with a billing account:

1. Generate a key from [Google Cloud](https://cloud.google.com/vertex-ai/generative-ai/docs/start/api-keys).
2. Set it as an environment variable in your terminal. Replace `YOUR_API_KEY` with your generated key and set GOOGLE_GENAI_USE_VERTEXAI to true

   ```bash
   export GOOGLE_API_KEY="YOUR_API_KEY"
   export GOOGLE_GENAI_USE_VERTEXAI=true
   ```

3. (Optionally) Add a billing account on your project to get access to [higher usage limits](https://cloud.google.com/vertex-ai/generative-ai/docs/quotas)

For other authentication methods, including Google Workspace accounts, see the [authentication](./docs/cli/authentication.md) guide.

## Examples

Once the CLI is running, you can start interacting with Gemini from your shell.

You can start a project from a new directory:

```sh
cd new-project/
gemini
> Write me a Gemini Discord bot that answers questions using a FAQ.md file I will provide
```

Or work with an existing project:

```sh
git clone https://github.com/google-gemini/gemini-cli
cd gemini-cli
gemini
> Give me a summary of all of the changes that went in yesterday
```

### Next steps

- Learn how to [contribute to or build from the source](./CONTRIBUTING.md).
- Explore the available **[CLI Commands](./docs/cli/commands.md)**.
- If you encounter any issues, review the **[troubleshooting guide](./docs/troubleshooting.md)**.
- For more comprehensive documentation, see the [full documentation](./docs/index.md).
- Take a look at some [popular tasks](#popular-tasks) for more inspiration.
- Check out our **[Official Roadmap](./ROADMAP.md)**

### Troubleshooting

Head over to the [troubleshooting guide](docs/troubleshooting.md) if you're
having issues.

## Popular tasks

### Explore a new codebase

Start by `cd`ing into an existing or newly-cloned repository and running `gemini`.

```text
> Describe the main pieces of this system's architecture.
```

```text
> What security mechanisms are in place?
```

### Work with your existing code

```text
> Implement a first draft for GitHub issue #123.
```

```text
> Help me migrate this codebase to the latest version of Java. Start with a plan.
```

### Automate your workflows

Use MCP servers to integrate your local system tools with your enterprise collaboration suite.

```text
> Make me a slide deck showing the git history from the last 7 days, grouped by feature and team member.
```

```text
> Make a full-screen web app for a wall display to show our most interacted-with GitHub issues.
```

### Interact with your system

```text
> Convert all the images in this directory to png, and rename them to use dates from the exif data.
```

```text
> Organize my PDF invoices by month of expenditure.
```

### Uninstall

Head over to the [Uninstall](docs/Uninstall.md) guide for uninstallation instructions.

## Terms of Service and Privacy Notice

For details on the terms of service and privacy notice applicable to your use of Gemini CLI, see the [Terms of Service and Privacy Notice](./docs/tos-privacy.md).
