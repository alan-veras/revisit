# Revisit

Flashcards for Obsidian with FSRS, kept small: pick your time, review, done.

## How it works

1. **Start.** Open Revisit from the ribbon icon, the status bar or the `Review` command and answer one question: *How much time today?* (5, 10 or 15 min, keys 1 to 3).
2. **Review.** One card at a time. Space or a click flips it; grade with Again, Hard, Good or Easy (keys 1 to 4), each showing its next interval. The session ends by itself when the time is up. `E` edits the card, `O` opens its source, `D` discards a new card, `Ctrl+Z` undoes the last grade.
3. **Done.** A calm screen: how many cards you did, when the next one comes back, and a `5 more min` button if something was left.

New cards enter at most 10 per day.

## Creating cards

`New card` (command, or the editor context menu) opens two fields, Front and Back. A selection in the editor goes to Back. With the front left empty and a short selection (up to 8 words), the card is saved as a cloze of the sentence around it. The area comes from the note's folder. `Ctrl+Enter` saves, `Esc` cancels.

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
