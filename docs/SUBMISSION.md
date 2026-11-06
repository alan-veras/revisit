# Submissão do Revisit ao catálogo da Obsidian

Este guia descreve como enviar o Revisit para a lista de plugins da comunidade da Obsidian. A submissão é feita pelo portal oficial e exige conta na Obsidian e conta no GitHub.

## Passo a passo

1. Acesse https://community.obsidian.md e faça login com a sua conta da Obsidian.
2. Vincule a sua conta do GitHub no portal (a conta precisa ser dona do repositório do plugin ou ter acesso a ele).
3. Clique em **Add your plugin** (Adicionar seu plugin).
4. Informe o repositório do GitHub do Revisit no formato `usuario/revisit`.
5. Envie o pedido. A equipe da Obsidian revisa o plugin e, se aprovado, ele entra na lista.

## Requisitos da submissão

- O arquivo `manifest.json` no **HEAD da branch padrão** do repositório (a `main`) é o que a Obsidian lê. Ele precisa estar com a versão final, incluindo `id`, `name`, `version`, `minAppVersion`, `description`, `author` e `isDesktopOnly`.
- A **tag da release deve ser exatamente igual ao campo `version`** do `manifest.json`. Exemplo: se `version` for `0.2.0`, a tag é `0.2.0`, sem o prefixo `v`.
- A release precisa anexar os três arquivos: `main.js`, `manifest.json` e `styles.css`. O workflow `.github/workflows/releases.yml` faz isso automaticamente ao receber uma tag.
- O `id` do plugin é permanente. Não o altere depois da submissão.

## Como publicar uma nova versão

1. Atualize a versão com `npm version minor` (ou `patch`/`major`, conforme o caso). Isso altera `package.json`, `manifest.json` e `versions.json`.
2. Envie o commit e a tag: `git push` seguido de `git push --tags`.
3. Aguarde o workflow de release ficar verde e confira se a release tem os três assets.

## Checklist antes de enviar

- [ ] `npm run build`, `npm run lint` e `npm test` passam sem erros.
- [ ] O lint do `eslint-plugin-obsidianmd` está sem avisos.
- [ ] O plugin não tem atalho (hotkey) padrão atribuído.
- [ ] O plugin não faz requisições de rede e não usa APIs privadas da Obsidian.
- [ ] `manifest.json` está no HEAD da branch `main`, com a versão final.
- [ ] A tag da release é igual ao `version` do `manifest.json`.
- [ ] A release contém `main.js`, `manifest.json` e `styles.css`.
- [ ] `LICENSE` (0-BSD) e `README.md` estão no repositório e o README está em inglês, voltado ao usuário final.
- [ ] A descrição no `manifest.json` é curta e clara.
- [ ] Testado em um vault vazio: instalação, seleção de texto, "Add to review" e "Review".
- [ ] Testado no celular (o `manifest.json` deve refletir o resultado: `isDesktopOnly` só é `true` se o plugin realmente não funcionar no celular).

## Texto para o Buy Me a Coffee

Use este texto na descrição da sua página do Buy Me a Coffee:

> O Revisit transforma os trechos que você seleciona nas suas notas em cartões de revisão espaçada, agendados com o algoritmo FSRS. Se o plugin ajuda você a estudar, considere pagar um café para apoiar o desenvolvimento. Obrigado!
