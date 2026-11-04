# Revisit

Obsidian plugin for flashcards made from your notes, scheduled with FSRS (`ts-fsrs`).

- **Capture:** select a passage (in a note or in the PDF reader) and run `Add to review`. The source note gets no mark at all.
- **Review:** `Review` opens the session: the card shows the front, `Space` flips it, and `1` to `4` grade it (Again, Hard, Good, Easy).
- **Where it lives:** the cards are markdown in `8_System/Lembro/<path of the source>.md`; the schedule in `estado.json` and the history in `revisoes.jsonl`, in the same folder.

The card format inside the notes stays in Portuguese (`Frente:`, `Verso:`, `Tipo:`, `Área:`, `Assunto:`, `Tags:`, `Reverso:`, `Fonte:`, and the types `Pergunta`, `Lacuna`, `Referência`, `Questão`): it is the data format of the vault, and the writer keeps producing it. The plugin's private storage migrated to English schemas (`estado.json`, `data.json`), with a one-time `.backup-pre-migration` copy of each file before the first write; the readers accept the old Portuguese schemas forever, and `revisoes.jsonl` is never rewritten (the reader accepts both field languages forever).

The Obsidian CLI commands moved to the `revisit:` prefix with English names (`today`, `cards`, `show`, `new`, `batch`, `edit`, `suspend`, `review`); the old Portuguese names work as exact aliases (`hoje`, `cartoes`, `ver`, `novo`, `lote`, `editar`, `suspender`, `revisar`).

Specification and phases: `3_Outputs/Desenvolvimento Pessoal/Projetos/Lembro/` in the vault.

```bash
npm install
npm test
npm run lint
npm run deploy   # copies to .obsidian/plugins/revisit (REVISIT_VAULT changes the vault; LEMBRO_VAULT still works)
```
