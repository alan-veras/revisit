# Lembro

Plugin do Obsidian para flashcards feitos a partir das suas notas, agendados com FSRS (`ts-fsrs`).

- **Capturar:** selecione um trecho (em nota ou no leitor de PDF) e rode `Adicionar à revisão`. A nota de origem não recebe marca nenhuma.
- **Revisar:** `Revisar` abre a sessão: o cartão mostra a frente, vira com `Espaço`, e `1` a `4` avaliam (Errei, Difícil, Bom, Fácil).
- **Onde fica:** os cartões são markdown em `8_System/Lembro/<caminho da origem>.md`; o agendamento em `estado.json` e o histórico em `revisoes.jsonl`, na mesma pasta.

Especificação e fases: `3_Outputs/Desenvolvimento Pessoal/Projetos/Lembro/` no vault.

```bash
npm install
npm test
npm run lint
npm run deploy   # copia para .obsidian/plugins/lembro (LEMBRO_VAULT muda o vault)
```
