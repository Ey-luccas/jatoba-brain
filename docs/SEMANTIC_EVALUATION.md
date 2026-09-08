# Semantic Evaluation

Status desta avaliação: **INCONCLUSIVE**.

O repositório agora possui uma avaliação explícita e reproduzível em `npm run eval:embeddings`, com 30 memórias e 12 consultas públicas em português. Ela compara PostgreSQL FTS, vector-only e o ranking hybrid atual, executa múltiplas rodadas e registra median/p95 de latência do provider.

## Execução

O comando não baixa modelos e não depende de `npm test`:

```bash
EMBEDDINGS_ENABLED=true \
EMBEDDING_PROVIDER=openai-compatible \
EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1/embeddings \
EMBEDDING_MODEL=nomic-embed-text \
EMBEDDING_DIMENSION=768 \
npm run eval:embeddings
```

O provider precisa ser local ou compatível com a API OpenAI, e `DATABASE_URL` deve apontar para um PostgreSQL com pgvector. O corpus é carregado em tabela temporária; nenhum conteúdo privado do workspace é enviado ao provider.

## Ambiente atual

- Avaliação semântica real local: **BLOCKED BY DISK CAPACITY**.
- Disco livre disponível no ambiente desta auditoria: aproximadamente **2 GB**.
- SHA-256 do corpus avaliado: `518fd78910212a1ff09cf66f83467871ad1de903455182820c5b015b8f0cb0d8`.

- Provider real disponível: nenhum detectado nesta máquina.
- Modelo executado: nenhum.
- Dimensão observada: nenhuma.
- Corpus: 30 memórias, versionadas em `eval/semantic-corpus.json`.
- Queries: 12, com paráfrases em português e termos técnicos em inglês.
- Recall@1/3/5: não medido.
- Latência: não medida.
- GraphRAG: não medido; o corpus não possui entidades estruturais ou Work Graph associadas.

Não há evidência suficiente para classificar a qualidade semântica como `GOOD`, `ACCEPTABLE` ou `POOR`; a classificação correta é **INCONCLUSIVE**.

## Contrato de embeddings

`EmbeddingProvider` mantém provider, modelo, dimensão e operação `embed(text)` fora de `memory.service`. O endpoint é opcional, possui timeout, rejeita respostas inválidas ou com dimensão inesperada e retorna ao fallback textual quando falha.

Memórias novas registram `embedding_provider`, `embedding_model`, `embedding_dimension` e `embedding_version`. A migration 005 é aditiva. A troca de modelo não remove vetores existentes: o próximo passo seguro é re-embedar em lotes, validar a nova dimensão e promover a versão somente após avaliação. Durante a transição, vetores com dimensão incompatível são ignorados na similaridade e continuam disponíveis para FTS.

O cache em processo é indexado por hash do provider, modelo e conteúdo. Ele não persiste texto, vetor ou credencial em logs.

## Classificação atual

| Área | Status | Motivo |
| --- | --- | --- |
| Vector integration | READY | pgvector, validação dimensional e fallback cobertos pelos testes determinísticos. |
| Real semantic quality | INCONCLUSIVE | Ainda não há provider/modelo real disponível neste ambiente. |
| Provider portability | READY | Contrato agnóstico e endpoint OpenAI-compatible configurável. |
| Fallback | READY | Timeout, provider offline, dimensão inválida e resposta inválida retornam ao FTS. |

O default de produção não foi alterado: embeddings continuam desativados até uma avaliação real ser executada e revisada.
