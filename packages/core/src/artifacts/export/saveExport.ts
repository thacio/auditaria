/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_ARTIFACTS: export files live outside immutable artifact versions.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ExportResult, SavedExport } from './types.js';

export const SHAREPOINT_INSTRUCTIONS = `# HTML independente / SharePoint

O arquivo HTML contém as dependências convertidas. Consulte o relatório antes de distribuir: "needs_adaptation" significa que ainda há funções que precisam de ajuste. Tamanho gera aviso, sem bloquear exportação.

1. Envie o HTML para uma biblioteca SharePoint ou pasta OneDrive/Teams sincronizada. Confirme a sincronização na biblioteca.
2. Conceda acesso ao arquivo e à página que o incorpora. Um link para a organização exige login; não é publicação anônima.
3. Obtenha o UniqueId real do arquivo pelos metadados da biblioteca. Na sessão autenticada, a API de leitura /_api/web/GetFileByServerRelativeUrl('<caminho-relativo-do-arquivo>')?$select=UniqueId pode fornecê-lo. Não use o token do link de compartilhamento como GUID.

   Como preencher: TENANT é o prefixo do domínio da organização; SITE é o caminho do site. O caminho do arquivo começa em /sites/SITE/ e inclui biblioteca, pastas, nome e extensão. Use o caminho real da URL, não apenas o nome exibido da biblioteca. Codifique espaços como %20. Peça ajuda para caminhos com apóstrofos, # ou %.

   Exemplo de consulta completa, para adaptar e abrir no navegador já conectado ao SharePoint:
   https://TENANT.sharepoint.com/sites/SITE/_api/web/GetFileByServerRelativeUrl('/sites/SITE/Documentos%20Compartilhados/PASTA/arquivo.html')?$select=UniqueId

   A resposta será JSON ou XML: procure UniqueId e copie seu valor no formato xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx. A consulta só lê metadados. Não use o ID numérico do item nem o identificador do artefato Auditaria. Se não souber o caminho, forneça à IA o link do arquivo já enviado e peça a consulta preenchida; links de compartilhamento opacos precisam ser resolvidos antes.

4. Em uma página moderna, adicione o componente Embed e cole um iframe HTTPS com o endereço abaixo, substituindo tenant, site e GUID:

<iframe src="https://TENANT.sharepoint.com/sites/SITE/_layouts/15/embed.aspx?UniqueId=GUID&amp;nb=true" width="100%" height="900" title="Artifact"></iframe>

   GUID é o UniqueId confirmado na consulta anterior. Não cole todo o HTML no campo Embed nem use localhost como endereço. A IA pode fornecer o iframe preenchido depois de confirmar os metadados do arquivo correto.

5. Salve/publique a página conforme seu fluxo e teste com outro leitor autorizado. Uma miniatura pode exigir clique para ativar.
6. Para atualizar, substitua o conteúdo do mesmo arquivo e verifique se o UniqueId foi preservado. Excluir e recriar pode mudar o identificador.

Observação de testes de 2026-09-10: o visualizador usado aceitou scripts presentes no HTML, CSS/fontes/imagens incorporados, SQLite em memória, importação manual e descompactação gzip por DecompressionStream. Bloqueou rede, scripts externos, workers, frames por URL, object/embed, localStorage e IndexedDB. Iframe srcdoc estático funcionou. São observações daquele ambiente, não garantia de todos os tenants/navegadores.

APIs, autenticação, colaboração e gravação de dados compartilhados não passam a funcionar por incorporar bibliotecas. claude.use() retorna null; dados incorporados são snapshots acessíveis a quem recebe o HTML. Mudanças em memória desaparecem ao recarregar. Downloads, PDFs interativos e mídias precisam de teste específico. Dados comprimidos exigem DecompressionStream; exporte com compress_data:false para navegadores sem suporte.

Não é necessário renomear para ASPX. Um link de download direto é diferente do endereço do visualizador. Se houver "File not found", confira sincronização, GUID e acesso. O comportamento de embed.aspx/nb=true pode variar.

Documentação Microsoft: https://support.microsoft.com/en-us/sharepoint/sites-pages/add-content-to-your-page-using-the-embed-web-part
`;

export async function saveExport(
  result: ExportResult,
  outDir: string,
  name = 'artifact',
  signal?: AbortSignal,
): Promise<SavedExport> {
  signal?.throwIfAborted();
  await fs.mkdir(outDir, { recursive: true });
  // A fresh directory makes publication atomic and never overwrites source or previous output.
  const destination = path.join(
    path.resolve(outDir),
    `${name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60)}-${randomBytes(4).toString('hex')}`,
  );
  const staging = destination + '.partial';
  await fs.mkdir(staging);
  try {
    await fs.writeFile(
      path.join(staging, 'report.json'),
      JSON.stringify(result.report, null, 2) + '\n',
      { signal },
    );
    await fs.writeFile(
      path.join(staging, 'LEIA-ME.md'),
      SHAREPOINT_INSTRUCTIONS,
      { signal },
    );
    if (result.report.conversionStatus === 'ready')
      await fs.writeFile(
        path.join(staging, `artifact.${result.report.target}.html`),
        result.html,
        { signal },
      );
    signal?.throwIfAborted();
    await fs.rename(staging, destination);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
  return {
    report: result.report,
    htmlFile:
      result.report.conversionStatus === 'ready'
        ? path.join(destination, `artifact.${result.report.target}.html`)
        : undefined,
    reportFile: path.join(destination, 'report.json'),
    instructionsFile: path.join(destination, 'LEIA-ME.md'),
  };
}
