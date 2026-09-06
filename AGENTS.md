# Jatobá Brain — instruções para agentes

Este repositório usa o MCP `jatoba` como memória persistente. Sempre que o servidor estiver disponível, siga este protocolo:

1. Antes de uma tarefa relevante, use `project_select` para o seu `actor` e projeto.
2. Consulte `project_context` e depois `recall` com a intenção da tarefa.
3. Abra `start_task` antes de alterar código.
4. Não registre cada pensamento. Registre fatos úteis e reutilizáveis.
5. Use `record_decision` para decisões arquiteturais ou de produto que afetem trabalho futuro.
6. Use `record_error` quando um problema e sua solução possam reaparecer.
7. Ao concluir, use `finish_task` com resumo, arquivos alterados, commit, testes, decisões e pendências.
8. Crie `checkpoint` quando o projeto atingir um estado estável.
9. Use `session_start/session_note/session_finish` apenas quando preservar o histórico de uma sessão trouxer valor. Prefira promover um resumo curto.
10. Busca global (`scope=global`) só deve ser usada quando for desejado reutilizar conhecimento de outros projetos.

## Actors sugeridos

- `maestro`
- `backend`
- `frontend`
- `testes`
- `revisor`
- `escriba`

## Regra de contexto

Não injete todo o banco no prompt. Recupere apenas o necessário para a tarefa atual. A memória é uma ferramenta de seleção de contexto, não uma cópia infinita da conversa.
