# Graphify + Jatobá Brain

Os dois componentes não competem.

```text
Jatobá → o que aconteceu e por quê?
Graphify → como o código está conectado?
Git → qual é o código real agora?
```

## Instalar

```bash
uv tool install graphifyy
graphify install
```

## Criar o grafo

O build do Graphify é acionado dentro de um assistente compatível:

```text
/graphify .
```

Saída típica:

```text
graphify-out/
├── graph.json
├── graph.html
└── GRAPH_REPORT.md
```

## Atualizar

```text
/graphify . --update
```

## Compartilhar com vários agentes

```bash
python -m graphify.serve graphify-out/graph.json --transport http --port 8080
```

Cada projeto/repositório pode ter seu próprio `graphify-out/`. Na primeira versão, o Jatobá não copia o grafo para o PostgreSQL; ele mantém essa responsabilidade separada.

## Estratégia multi-projeto

```text
graphs/
├── achei/backend/graph.json
├── achei/mobile/graph.json
└── mundo-mae/backend/graph.json
```

Pode-se iniciar uma instância Graphify por grafo quando vários projetos precisam ser consultados simultaneamente. Uma versão futura do Jatobá pode atuar como roteador desses endpoints.
