# Graphify no Jatobá Brain

Graphify fornece a memória estrutural: relações do código dentro de um repositório. PostgreSQL e pgvector continuam responsáveis pela memória histórica e semântica; o Work Graph registra a história operacional.

```text
Jatobá / PostgreSQL -> o que aconteceu e por quê?
Graphify            -> como o código está conectado?
Git                 -> qual é o estado real agora?
```

## Versão validada

O ambiente validado usa Graphify CLI `0.9.55`, invocado como um processo local. A indexação usa extração de código e não exige um modelo de linguagem disponível.

## Indexação por repositório

`graph_index` é explícita. Ela valida o caminho do repositório registrado, lê o commit Git atual, executa Graphify e persiste somente metadados em `repository_graphs`: projeto, repositório, caminho do snapshot, commit, estado, contagens, timestamps e código de erro seguro.

Snapshots ficam separados por projeto e repositório no diretório `GRAPH_DIR`. Não são gravados no PostgreSQL nem devem ser versionados no Git.

## Estados

- `READY`: o grafo corresponde ao commit atual.
- `STALE`: o commit Git mudou depois da última geração.
- `INDEXING`: uma indexação está em curso.
- `ERROR`: Graphify falhou ou não produziu uma saída válida.

`graph_status` informa essas condições. Uma falha de Graphify não interrompe `remember`, `recall`, MCP ou a memória temporal; consultas podem usar um snapshot pronto existente quando apropriado.

## Consulta limitada e rebuild

`graph_query`, `graph_neighbors` e `graph_impact` retornam somente um subgrafo limitado por profundidade, nós e arestas. A profundidade aceita de 1 a 4. O `graph.json` completo nunca é enviado ao agente.

O Jatobá não reconstrói grafos em toda chamada de `recall` ou `context_retrieve`. Quando o estado for `STALE`, execute `graph_index` conscientemente. O processo usa lock por repositório para evitar indexações concorrentes.

## Limitações atuais

- A retenção de snapshots antigos ainda exige política operacional.
- Apenas repositórios Git registrados e dentro do workspace configurado podem ser indexados.
- O grafo descreve estrutura estática; não substitui testes, análise de runtime ou revisão humana.
