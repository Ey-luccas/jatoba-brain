# Arquitetura do Jatobá Brain

## Princípios

1. **Memória fora do modelo.** Nenhum agente é a fonte única da verdade.
2. **Isolamento por projeto.** Toda memória operacional recebe `project_id`.
3. **Global só quando explícito.** `recall(scope="global")` é uma ação deliberada.
4. **Git é objetivo.** IA explica intenções; Git registra o que realmente mudou.
5. **Grafo não é histórico.** Graphify descreve estrutura do código; PostgreSQL descreve evolução.
6. **Documentação é derivada.** Markdown/PDF/DOCX são projeções da memória, não a memória em si.

## Hierarquia

```text
WORKSPACE
  └── PROJECT
      └── REPOSITORY
          └── TASK
              ├── MEMORY
              ├── DECISION
              ├── ERROR
              ├── CHANGE
              └── CHECKPOINT
```

## Memória objetiva vs. semântica

### Objetiva

- commit e branch;
- arquivos modificados;
- status/diff Git;
- testes;
- timestamps;
- agente executor;
- task/run.

### Semântica

- por que uma mudança foi feita;
- qual decisão foi tomada;
- qual erro ocorreu;
- causa e solução;
- pendências;
- conhecimento reaproveitável.

## Context budget

O Jatobá deve recuperar pequenos blocos relevantes em vez de todo o histórico. Uma política inicial razoável:

```text
Project state        ~800 tokens
Memórias relevantes ~1500
Decisões             ~1000
Graphify             ~1000
Tarefa anterior       ~500
--------------------------
Budget alvo          ~4800
```

O Jatobá não força esse orçamento no protocolo nesta versão; ele é uma política para o orquestrador.
