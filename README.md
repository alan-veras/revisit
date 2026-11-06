# Revisit

**Revisit** turns the passages you select in your notes into spaced repetition flashcards, scheduled with the FSRS algorithm (`ts-fsrs`). You study what you already wrote, at the moment you choose, without leaving your notes.

<!-- DEMO PLACEHOLDER: replace with demo/demo.gif once it is recorded -->
![Revisit demo](demo/demo.gif)

## Why Revisit is different

- **Study for the time you have.** Pick a 5, 10, 20 or 30 minute session and Revisit fills it with the cards that matter most right now.
- **Know tomorrow's workload.** A forecast shows how many cards are due in the coming days, so you can plan before the pile grows.
- **Catch-up mode.** Missed a few days? Catch-up mode spreads the backlog over the following sessions instead of dumping it all on you at once.
- **Your source note stays untouched.** Cards live in their own files. Creating a card never adds a mark, link or change to the note you took it from.
- **Works on mobile.** Review on your phone as well as on desktop.

## Quickstart in 3 steps

1. **Select** a passage in any note.
2. Run **Add to review** (from the selection menu or the command palette).
3. Run **Review** whenever you have time. Choose a session length, flip the card, and grade how well you remembered it.

That's it. There is nothing else to configure to get started.

## Card format

A card is plain text inside a file in your vault. Each card uses these fields:

```text
Front: What does FSRS stand for?
Back: Free Spaced Repetition Scheduler.
Type: Question
Topic: Spaced repetition
Tags: memory, study
Reverse: no
Source: [[Learning notes]]
```

| Field | Meaning |
|---|---|
| `Front:` | What you see first |
| `Back:` | The answer, shown when you flip the card |
| `Type:` | The kind of card (see below) |
| `Topic:` | An optional grouping label |
| `Tags:` | Optional comma-separated tags |
| `Reverse:` | Optional; whether the card is also studied in the reverse direction |
| `Source:` | The note the card came from |

Card types:

- **Question**: a question and its answer.
- **Cloze**: a sentence with a hidden part to recall.
- **Reference**: a term and its definition or explanation.
- **Problem**: a problem and its solution.

## Settings

Open the plugin's settings tab to adjust how Revisit behaves.

<!-- TODO: list the final settings once the plugin is final -->

## How Revisit compares to Spaced Repetition

Spaced Repetition is the established, widely used plugin with its own card syntax; Revisit is newer, built around time-boxed sessions and a workload forecast, and it never changes your source notes.

## Your data stays local

Revisit stores your cards, schedule and review history inside your vault. Nothing is sent to a server, and there is no account to create.

## Support

If Revisit helps you study, you can support its development:

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?logo=buymeacoffee&logoColor=000000)](https://www.buymeacoffee.com/alanveras)

## License

0-BSD. See [LICENSE](LICENSE).
