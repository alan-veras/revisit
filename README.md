# Revisit

**Revisit** turns the passages you select in your notes into spaced repetition flashcards, scheduled with the FSRS algorithm (`ts-fsrs`). You study what you already wrote, at the moment you choose, without leaving your notes.

<!-- DEMO PLACEHOLDER: replace with demo/demo.gif once it is recorded -->
![Revisit demo](demo/demo.gif)

## Why Revisit is different

- **Study for the time you have.** Pick 10, 15 or 30 minutes, or any custom length. Each choice shows how many cards fit, and the session holds exactly that many, the most forgotten first.
- **Know tomorrow's workload.** The panel forecasts the next 30 days in minutes against your daily budget and tells you whether the load is Light, Sustainable or Heavy. When a session ends you see tomorrow's minutes too.
- **A backlog never becomes a wall.** What does not fit in today's session simply waits; nothing is rescheduled or lost.
- **Catch-up mode when you fall behind.** A big backlog is spread over the coming days within your budget.
- **Your source note stays untouched.** Cards live in their own files. Creating a card never adds a mark, link or change to the note you took it from.
- **Works on mobile.** Large Again, Hard, Good and Easy buttons stay at the bottom of the screen, and a tap on the card flips it.

## Quickstart in 3 steps

1. **Select** a passage in any note.
2. Run **Add to review** (from the selection menu or the command palette).
3. Run **Review** whenever you have time. Choose a session length, flip the card (tap it, or press Space), and grade how well you remembered it (buttons, or keys 1 to 4).

That's it. There is nothing else to configure to get started.

The four grade buttons mean what they say: **Again** did not remember, **Hard** remembered with effort, **Good** remembered, **Easy** remembered instantly. Each button shows the next interval, and a card graded Again comes back inside the same session.

## Cards beyond the selection

You never need an open editor to work on cards:

- **New card** buttons live in the panel (Today and Search), in *Cards of this note*, and in the empty review session. The source note and your last topic come prefilled. Right-click any note or PDF in the file explorer and choose **New card from this file**.
- The capture window has a **Tags** field: `#important` makes the card come back more often. You can also toggle it with the **Important** button (or key I) in the session.
- **Delete** a card from the Search row menu, from *Cards of this note*, or from the session toolbar. Every delete asks first, and removes the card's schedule with it.
- The capture window points at what it is missing: an empty answer focuses the Back field, and a long excerpt asks for the question instead of failing with nowhere to look.

## Decks are the topics

A deck is just a topic, and it is chosen when the card is created: type it in the capture window (the **Pick deck** button lists the ones you already have) and the card lives in the deck's own file, one file per deck (`Sustento > Caridade` becomes `Sustento/Caridade.md` inside the cards folder; a card without a topic goes to `No deck.md`). The panel builds a tree from the topics:

- **Rename** a topic from its row menu and every card under it follows, children included, in one pass, moving to the renamed deck's file.
- **Retire** a topic to suspend all its cards at once (an exam that passed, a course that ended) and **wake it up** later; nothing is deleted.
- **Change topic** from a card's menu, or in bulk: filter the Search tab and press *Change topic of N…*. The card moves to the new deck's file, schedule intact.

## Card format

A card is plain text inside a file in your vault. Each card uses these fields:

```text
Front: What does FSRS stand for?
Back: Free Spaced Repetition Scheduler.
Type: Question
Topic: Spaced repetition
Tags: #memory #study
Reverse: yes
Source: [[Learning notes]]
```

| Field | Meaning |
|---|---|
| `Front:` | What you see first |
| `Back:` | The answer, shown when you flip the card |
| `Type:` | The kind of card (see below) |
| `Topic:` | An optional grouping label |
| `Tags:` | Optional tags; `#important` makes the card come back more often |
| `Reverse:` | Optional; `yes` also studies the card back to front |
| `Source:` | The note the card came from |

Card types:

- **Question**: a question and its answer.
- **Cloze**: a sentence with a hidden part to recall.
- **Reference**: a term and its definition or explanation.
- **Problem**: a problem and its solution.

### Cards written inside a note

Put the tag from the *Tag of notes with inline cards* setting (default `#flashcards`) on a note and Revisit reads cards straight from its text, without ever changing it:

- `Question::Answer` is a card.
- `Question:::Answer` is a card studied both ways.
- `==cloze==` hides the highlighted part of a sentence.

## Settings

Every setting has a default, so none is required. Open the plugin's settings tab to change them.

**Review**

| Setting | Default | What it does |
|---|---|---|
| Review budget per day, in minutes | 20 | Preselected on the start screen; also the line the forecast and the Light/Sustainable/Heavy badge are measured against. |
| New cards per day | 20 | One quota for all cards together. 0 pauses new cards. It shrinks on its own when due reviews fill the budget. |
| Desired retention, in % | 90 | Chance of remembering on the review day (70 to 95). Higher means more reviews. |
| Retention of #important cards, in % | 95 | Same, for cards tagged `#important`. |
| Interleave topics | on | Mixes topics inside a session; off reviews one topic at a time. |
| A wrong card comes back after how many cards | 3 | Grade Again and the card returns in the same session after this many cards. |

**Session**

| Setting | Default | What it does |
|---|---|---|
| Words per hint | 3 | On Reference cards, each hint reveals this many more words. |
| New badge | on | Marks cards you see for the first time. |

**Note rereading**

| Setting | Default | What it does |
|---|---|---|
| Tag of the notes to reread | empty | Notes with this tag are reread from time to time; empty ignores the tag. |
| New notes to reread per day | 2 | How many never-read notes enter per day. |

**Reminder**

| Setting | Default | What it does |
|---|---|---|
| Daily reminder | empty | An `HH:MM` time. If cards are waiting and you have not reviewed, a notice offers a Review button. Empty turns it off. |

**Files**

| Setting | Default | What it does |
|---|---|---|
| Cards folder | `Revisit` | Where the card files, `state.json` and `review-log.jsonl` live. |
| Tag of notes with inline cards | `#flashcards` | See above; empty turns inline cards off. |

Revisit adds no default hotkeys. Bind any command (Review, Add to review, Open panel...) in *Settings > Hotkeys*.

## How Revisit compares to Spaced Repetition

Spaced Repetition is the established, widely used plugin with its own card syntax; Revisit is newer, built around time-boxed sessions and a workload forecast, and it never changes your source notes.

## Your data stays local

Revisit stores your cards, schedule (`state.json`) and review history (`review-log.jsonl`) inside your vault. Nothing is sent to a server, and there is no account to create. They are plain vault files, so they follow your vault sync; avoid reviewing on two devices at the same time (last write wins). Renamed a source note or folder? Your cards follow: the `Source:` link is rewritten automatically.

## Install

Manually: download `main.js`, `manifest.json` and `styles.css` from the [latest release](../../releases) into `<vault>/.obsidian/plugins/revisit/`, then enable Revisit under Settings → Community plugins. Once the catalog review is through, it also shows up in Obsidian's Community plugins search.

## Support

If Revisit helps you study, you can support its development:

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?logo=buymeacoffee&logoColor=000000)](https://www.buymeacoffee.com/alanveras)

## License

0-BSD. See [LICENSE](LICENSE).
