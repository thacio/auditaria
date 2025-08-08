# Auditaria CLI

- [Jump to English Instructions](#english)

- [Instruções em Português (BR)](#português)

---

<a id="português"></a>
![Captura de Tela do Auditaria CLI](./docs/assets/auditaria-screenshot-pt.png)

O Auditaria CLI é um fork especializado do [Google Gemini CLI](https://github.com/google-gemini/gemini-cli) projetado especificamente para fluxos de trabalho de **auditorias**, **engenharia de software** e **análise de dados**. Este fork aprimora a ferramenta original com recursos focados em auditoria, suporte multi-idioma e capacidades de fluxo de trabalho melhoradas, mantendo **todas as capacidades originais de engenharia de software** intactas.

### Principais Melhorias

- **🛠️ Ferramenta TODO**: Sistema completo de gerenciamento de tarefas para rastrear e organizar fluxos de trabalho complexos de auditoria
- **🌐 Suporte Multi-idioma**: Internacionalização completa com suporte para Português e Inglês (com comando `/language`)
- **⚙️ Controle Avançado de Modelo**: Comandos slash aprimorados para melhor gerenciamento de modelos de IA:
  - `/model-switch` - Alternar entre modelos Gemini Pro e Flash
  - `/stay-pro` - Desabilitar/habilitar fallback para modelo Flash
  - `/fallback-improved` - Alternar entre estratégias de retry
- **🔄 Estratégia de Retry Melhorada**: 7 tentativas com delays de 2 segundos e reset automático para Gemini Pro a cada mensagem do usuário
- **🎯 Recursos Focados em Auditoria**: Prompts de sistema especializados e capacidades adaptadas para tarefas de auditoria
- **📊 Ferramentas de Análise de Dados**: Capacidades aprimoradas para analisar e trabalhar com dados de auditoria
- **🌐 Interface Web**: Interface web integrada para interação baseada em navegador (porta padrão 8629, usa porta aleatória se ocupada)

### Suporte a Idiomas

Atualmente suporta:
- **Inglês** (en)
- **Português** (pt)

Use o comando `/language` para alternar entre idiomas suportados durante a execução.

### Interface Web

A interface web fornece uma maneira alternativa de interagir com o Auditaria CLI através do seu navegador:

- **Iniciar com interface web**: `auditaria --web` (abre automaticamente o navegador)
- **Iniciar sem abrir navegador**: `auditaria --web no-browser`
- **Comando durante execução**: Use `/web` para abrir a interface web a qualquer momento
- **Porta padrão**: 8629 (usa uma porta aleatória se estiver ocupada)
- **Recursos**: Sincronização em tempo real de mensagens, exibição de execução de ferramentas, histórico completo da conversa

---

Este repositório contém o Auditaria CLI, uma ferramenta de fluxo de trabalho de IA por linha de comando que se conecta às suas ferramentas, entende seu código e acelera seus fluxos de trabalho.

Com o Auditaria CLI você pode:

- Consultar e editar grandes bases de código dentro e além da janela de contexto de 1M tokens do Gemini.
- Gerar novos aplicativos a partir de PDFs ou esboços, usando as capacidades multimodais do Gemini.
- Automatizar tarefas operacionais, como consultar pull requests ou lidar com rebases complexos.
- Usar ferramentas e servidores MCP para conectar novas capacidades, incluindo [geração de mídia com Imagen, Veo ou Lyria](https://github.com/GoogleCloudPlatform/vertex-ai-creative-studio/tree/main/experiments/mcp-genmedia)
- Fundamentar suas consultas com a ferramenta [Google Search](https://ai.google.dev/gemini-api/docs/grounding), integrada ao Gemini.

## Início Rápido

### Com Node

1. **Pré-requisitos:** Certifique-se de ter o [Node.js versão 20](https://nodejs.org/en/download) ou superior instalado.
2. **Execute a CLI:** Execute o seguinte comando em seu terminal:

   ```bash
   npx https://github.com/thacio/auditaria
   ```

   Ou instale globalmente com:
   ```bash
   npm install -g https://github.com/thacio/auditaria/releases/latest/download/auditaria-cli-latest.tgz
   ```
   ou instale globalmente clonando este repositório
   
   ```bash
   git clone https://github.com/thacio/auditaria
   cd ./auditaria
   npm run build
   npm install -g .
   ```

   Em seguida, execute a CLI de qualquer lugar:

   ```bash
   auditaria
   ```

### Configuração de Firewall Corporativo (MITM)

**⚠️ AVISO DE SEGURANÇA**: Desabilitar a verificação SSL pode representar uma falha de segurança. No entanto, em ambientes corporativos com firewall MITM, o npm recusará a instalação porque o firewall substitui os certificados SSL originais por seus próprios certificados para inspecionar o tráfego. Isso faz com que o npm detecte um certificado "não confiável" e bloqueie a instalação. **Use estas configurações apenas em redes corporativas confiáveis onde a TI controla a infraestrutura.**

Se você estiver usando o Auditaria CLI atrás de um firewall corporativo que realiza inspeção de certificado man-in-the-middle (MITM), você pode encontrar erros de certificado SSL. Veja como resolver isso:

#### Configuração do NPM para Instalação

Se você encontrar erros SSL durante a instalação com npm, use o flag inline para desabilitar temporariamente a verificação SSL estrita:

```bash
# Instalar o Auditaria CLI com verificação SSL desabilitada
npm install -g https://github.com/thacio/auditaria/releases/latest/download/auditaria-cli-latest.tgz --strict-ssl=false
```

#### Configuração de Execução

Quando a CLI tentar se conectar ao servidor do Google, configure a variável de ambiente:

#### Windows Command Prompt (cmd)
```cmd
set NODE_TLS_REJECT_UNAUTHORIZED=0
auditaria
```

Ou execute ambos os comandos juntos:
```cmd
set NODE_TLS_REJECT_UNAUTHORIZED=0 && auditaria
```

#### Windows PowerShell
```powershell
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"
auditaria
```

Ou execute ambos os comandos juntos:
```powershell
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"; auditaria
```

#### Linux/macOS
```bash
export NODE_TLS_REJECT_UNAUTHORIZED=0
auditaria
```

Ou execute ambos os comandos juntos:
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 auditaria
```

#### Configuração Permanente (Opcional)
Se você quiser defini-la permanentemente para todas as sessões:

**Windows (em todo o sistema, requer admin):**
```cmd
setx NODE_TLS_REJECT_UNAUTHORIZED 0 /M
```

**Windows (apenas usuário):**
```cmd
setx NODE_TLS_REJECT_UNAUTHORIZED 0
```

**Linux/macOS (adicionar ao ~/.bashrc ou ~/.zshrc):**
```bash
export NODE_TLS_REJECT_UNAUTHORIZED=0
```

Nota: Após usar `setx` no Windows, reinicie seu terminal para que a mudança tenha efeito.

#### Revertendo a Configuração
Para remover a variável de ambiente e restaurar a validação normal de certificado SSL:

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

**Remover configuração permanente (Windows):**
```cmd
setx NODE_TLS_REJECT_UNAUTHORIZED "" /M
```
ou
```cmd
setx NODE_TLS_REJECT_UNAUTHORIZED ""
```

**⚠️ Nota de Segurança:** Esta configuração desabilita a validação de certificado SSL. Use apenas em ambientes corporativos confiáveis onde a TI controla a infraestrutura de rede.

### Configuração

1. **Escolha um tema de cor**
2. **Autentique:** Quando solicitado, faça login com sua conta pessoal do Google. Isso lhe concederá até 60 solicitações de modelo por minuto e 1.000 solicitações de modelo por dia usando o Gemini.

Agora você está pronto para usar o Auditaria CLI!

### Use uma chave da API Gemini:

A API Gemini fornece um nível gratuito com [100 solicitações por dia](https://ai.google.dev/gemini-api/docs/rate-limits#free-tier) usando Gemini 2.5 Pro, controle sobre qual modelo usar e acesso a limites de taxa mais altos (com um plano pago):

1. Gere uma chave do [Google AI Studio](https://aistudio.google.com/apikey).
2. Defina-a como uma variável de ambiente em seu terminal. Substitua `YOUR_API_KEY` por sua chave gerada.

   ```bash
   export GEMINI_API_KEY="YOUR_API_KEY"
   ```

3. (Opcionalmente) Atualize seu projeto da API Gemini para um plano pago na página da chave da API (desbloqueará automaticamente os [limites de taxa Tier 1](https://ai.google.dev/gemini-api/docs/rate-limits#tier-1))

### Use uma chave da API Vertex AI:

A API Vertex AI fornece um [nível gratuito](https://cloud.google.com/vertex-ai/generative-ai/docs/start/express-mode/overview) usando modo expresso para Gemini 2.5 Pro, controle sobre qual modelo usar e acesso a limites de taxa mais altos com uma conta de cobrança:

1. Gere uma chave do [Google Cloud](https://cloud.google.com/vertex-ai/generative-ai/docs/start/api-keys).
2. Defina-a como uma variável de ambiente em seu terminal. Substitua `YOUR_API_KEY` por sua chave gerada e defina GOOGLE_GENAI_USE_VERTEXAI como true

   ```bash
   export GOOGLE_API_KEY="YOUR_API_KEY"
   export GOOGLE_GENAI_USE_VERTEXAI=true
   ```

3. (Opcionalmente) Adicione uma conta de cobrança ao seu projeto para obter acesso a [limites de uso mais altos](https://cloud.google.com/vertex-ai/generative-ai/docs/quotas)

Para outros métodos de autenticação, incluindo contas do Google Workspace, consulte o guia de [autenticação](./docs/cli/authentication.md).

## Exemplos

Uma vez que a CLI esteja rodando, você pode começar a interagir com o Gemini do seu shell.

Você pode iniciar um projeto a partir de um novo diretório:

```sh
cd novo-projeto/
auditaria
> Escreva-me um bot Discord Gemini que responde perguntas usando um arquivo FAQ.md que fornecerei
```

Ou trabalhar com um projeto existente:

```sh
git clone https://github.com/thacio/auditaria
cd auditaria
auditaria
> Me dê um resumo de todas as mudanças que entraram ontem
```

### Próximos passos

- Aprenda como [contribuir ou construir a partir do código fonte](./CONTRIBUTING.md).
- Explore os **[Comandos CLI](./docs/cli/commands.md)** disponíveis.
- Se encontrar algum problema, revise o **[guia de solução de problemas](./docs/troubleshooting.md)**.
- Para documentação mais abrangente, veja a [documentação completa](./docs/index.md).
- Dê uma olhada em algumas [tarefas populares](#tarefas-populares) para mais inspiração.
- Confira nosso **[Roadmap Oficial](./ROADMAP.md)**

### Solução de Problemas

Vá para o [guia de solução de problemas](docs/troubleshooting.md) se estiver tendo problemas.

## Tarefas populares

### Explorar uma nova base de código

Comece executando `cd` em um repositório existente ou recém-clonado e executando `auditaria`.

```text
> Descreva as principais partes da arquitetura deste sistema.
```

```text
> Quais mecanismos de segurança estão em vigor?
```

### Trabalhar com seu código existente

```text
> Implemente um primeiro rascunho para a issue do GitHub #123.
```

```text
> Me ajude a migrar esta base de código para a versão mais recente do Java. Comece com um plano.
```

### Automatizar seus fluxos de trabalho

Use servidores MCP para integrar suas ferramentas de sistema local com seu conjunto de colaboração empresarial.

```text
> Faça-me uma apresentação de slides mostrando o histórico do git dos últimos 7 dias, agrupado por recurso e membro da equipe.
```

```text
> Faça um aplicativo web em tela cheia para um display de parede para mostrar nossas issues do GitHub com mais interação.
```

### Interagir com seu sistema

```text
> Converta todas as imagens neste diretório para png e renomeie-as para usar datas dos dados exif.
```

```text
> Organize minhas faturas PDF por mês de despesa.
```

### Desinstalar

Vá para o guia de [Desinstalação](docs/Uninstall.md) para instruções de desinstalação.

## Termos de Serviço e Aviso de Privacidade

Para detalhes sobre os termos de serviço e aviso de privacidade aplicáveis ao seu uso do Gemini CLI, consulte os [Termos de Serviço e Aviso de Privacidade](./docs/tos-privacy.md).


---

<a id="english"></a>
# Auditaria CLI

![Auditaria CLI Screenshot](./docs/assets/auditaria-screenshot.png)

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
- **🌐 Web Interface**: Built-in web interface for browser-based interaction (default port 8629, uses random port if occupied)

### Language Support

Currently supports:
- **English** (en)
- **Portuguese** (pt)

Use the `/language` command to switch between supported languages at runtime.

### Web Interface

The web interface provides an alternative way to interact with Auditaria CLI through your browser:

- **Start with web interface**: `auditaria --web` (automatically opens browser)
- **Start without opening browser**: `auditaria --web no-browser`
- **Command during runtime**: Use `/web` to open the web interface at any time
- **Default port**: 8629 (uses a random port if occupied)
- **Features**: Real-time message sync, tool execution display, full conversation history

---

This repository contains Auditaria CLI, a command-line AI workflow tool that connects to your
tools, understands your code and accelerates your workflows.

With Auditaria CLI you can:

- Query and edit large codebases in and beyond Gemini's 1M token context window.
- Generate new apps from PDFs or sketches, using Gemini's multimodal capabilities.
- Automate operational tasks, like querying pull requests or handling complex rebases.
- Integrate with GitHub: Use the [Gemini CLI GitHub Action](https://github.com/google-github-actions/run-gemini-cli) for automated PR reviews, issue triage, and on-demand AI assistance directly in your repositories.
- Use tools and MCP servers to connect new capabilities, including [media generation with Imagen,
  Veo or Lyria](https://github.com/GoogleCloudPlatform/vertex-ai-creative-studio/tree/main/experiments/mcp-genmedia)
- Ground your queries with the [Google Search](https://ai.google.dev/gemini-api/docs/grounding)
  tool, built into Gemini.

## Quickstart

### With Node

1. **Prerequisites:** Ensure you have [Node.js version 20](https://nodejs.org/en/download) or higher installed.
2. **Run the CLI:** Execute the following command in your terminal:

   ```bash
   npx https://github.com/thacio/auditaria
   ```

   Or install it globally with:
   ```bash
   npm install -g https://github.com/thacio/auditaria/releases/latest/download/auditaria-cli-latest.tgz
   ```
   or install globally by clones this repository
   
   ```bash
   git clone https://github.com/thacio/auditaria
   cd ./auditaria
   npm run build
   npm install -g .
   ```


   Then, run the CLI from anywhere:

   ```bash
   auditaria
   ```


### Corporate Firewall (MITM) Setup

**⚠️ SECURITY WARNING**: Disabling SSL verification may represent a security flaw. However, in corporate environments with MITM firewalls, npm will refuse to install because the firewall replaces the original SSL certificates with its own certificates to inspect traffic. This causes npm to detect an "untrusted" certificate and block the installation. **Use these settings only in trusted corporate networks where IT controls the infrastructure.**

If you're using Auditaria CLI behind a corporate firewall that performs man-in-the-middle (MITM) certificate inspection, you may encounter SSL certificate errors. Here's how to resolve this:

#### NPM Configuration for Installation

If you encounter SSL errors during npm installation, use the inline flag to temporarily disable strict SSL verification:

```bash
# Install Auditaria CLI with SSL verification disabled
npm install -g https://github.com/thacio/auditaria/releases/latest/download/auditaria-cli-latest.tgz --strict-ssl=false
```

#### Runtime Configuration

When the CLI tries to connect to Google's server, set the environment variable:

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
auditaria
> Write me a Gemini Discord bot that answers questions using a FAQ.md file I will provide
```

Or work with an existing project:

```sh
git clone https://github.com/thacio/auditaria
cd auditaria
auditaria
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

## GitHub Integration

Integrate Gemini CLI directly into your GitHub workflows with the [**Gemini CLI GitHub Action**](https://github.com/google-github-actions/run-gemini-cli). Key features include:

- **Pull Request Reviews**: Automatically review pull requests when they're opened.
- **Issue Triage**: Automatically triage and label GitHub issues.
- **On-demand Collaboration**: Mention `@gemini-cli` in issues and pull requests for assistance and task delegation.
- **Custom Workflows**: Set up your own scheduled tasks and event-driven automations.

## Popular tasks

### Explore a new codebase

Start by `cd`ing into an existing or newly-cloned repository and running `auditaria`.

```text
> Describe the main pieces of this system's architecture.
```

```text
> What security mechanisms are in place?
```

```text
> Provide a step-by-step dev onboarding doc for developers new to the codebase.
```

```text
> Summarize this codebase and highlight the most interesting patterns or techniques I could learn from.
```

```text
> Identify potential areas for improvement or refactoring in this codebase, highlighting parts that appear fragile, complex, or hard to maintain.
```

```text
> Which parts of this codebase might be challenging to scale or debug?
```

```text
> Generate a README section for the [module name] module explaining what it does and how to use it.
```

```text
> What kind of error handling and logging strategies does the project use?
```

```text
> Which tools, libraries, and dependencies are used in this project?
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

## Security Disclosures

Please see our [security disclosure process](SECURITY.md). All [security advisories](https://github.com/google-gemini/gemini-cli/security/advisories) are managed on Github.
