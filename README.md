# Revisit

Flashcards for Obsidian with FSRS, kept small: pick your time, review, done.

## How it works

1. **Start.** Open Revisit from the ribbon icon, the status bar or the `Review` command and answer one question: *How much time today?* (2, 5 or 10 min, keys 1 to 3).
2. **Review.** One card at a time. Space or a click flips it (and flips it back); grade with Again, Hard, Good or Easy (keys 1 to 4), each showing its next interval. The session ends by itself when the time is up. `E` edits the card, `O` opens its source, `D` twice deletes the card, `Ctrl+Z` undoes the last grade. The `?` in the corner lists every key.
3. **Done.** A calm screen: how many cards you did and when the next one comes back. If cards of today were left over, *Keep going?* offers 2, 5 or 10 more minutes; if not, *Ahead of schedule?* offers new cards past the daily limit, then cards before their day.

New cards enter at most 10 per day.

## Creating cards

**Select the text, run `New card`, write the question, press `Ctrl+Enter`.** That is the whole rule.

`New card` (command, the editor context menu or the Done screen) opens two fields, Front and Back. A selection in the editor goes to Back. With the front left empty and a short selection (up to 8 words), the card is saved as a cloze of the sentence around it. `Ctrl+Enter` saves, `Esc` cancels.

There is no deck to pick. Cards are grouped by the top-level folder of the note you were in (a note at the vault root groups by its own name; with no note open, cards go to `Inbox`). Grouping only decides the file the card is kept in: a review always mixes every deck.

## Card format

Cards are plain markdown in the cards folder, one file per deck, blocks separated by `---`:

```
Front: What does `kubectl rollout undo` do?
Back: Rolls a deployment back to its previous revision.
Type: Question
Topic: Kubernetes > Workloads
Source: [[CKA study plan]] ^lk7q2a
```

`==highlights==` in the front of a `Type: Cloze` card make one card per highlight. The schedule lives in `state.json` and every grade in `review-log.jsonl`, in the same folder. Files from earlier versions (including cards of the old Reference and Problem types) are read as they are and kept untouched.

## Settings

Cards folder and desired retention (default 90%).

## Install

Manually: download `main.js`, `manifest.json` and `styles.css` from the [latest release](../../releases) into `<vault>/.obsidian/plugins/revisit/`, then enable Revisit under Settings → Community plugins.

## Support

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?logo=buymeacoffee&logoColor=000000)](https://www.buymeacoffee.com/alanveras)

## License

0-BSD. See [LICENSE](LICENSE).
