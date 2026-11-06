#!/usr/bin/env bash
# Records the Revisit demo without touching your own Obsidian: builds a throwaway
# vault (cards, schedule and 60 days of history, all invented), opens a SECOND
# Obsidian instance on it (own profile, forced to X11), films only that window and
# cuts a GIF for the README. Run it when the screen is free.
#
# Usage:  ./demo/gravar-demo.sh        (writes demo/demo-raw.mp4 and demo/demo.gif)
# Needs:  node, xdotool, ffmpeg, Obsidian's Electron, and a built main.js (npm run build).
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${DEMO_WORK:-/tmp/claude-1000/-home-alanv-Trabalhos-Obsidian-second-brain/ff95b9dc-7cc8-4f0d-9949-b2186ced42f6/scratchpad}"
DEMO="$WORK/revisit-demo-vault"
PROFILE="$WORK/revisit-obsidian-profile"
OUT="$REPO/demo"
ASAR="/usr/lib/obsidian/app.asar"
ELECTRON="$(command -v electron || command -v electron43 || true)"
[ -n "$ELECTRON" ] || { echo "Obsidian's Electron not found (adjust ASAR/ELECTRON at the top of the script)"; exit 1; }
[ -f "$REPO/main.js" ] || { echo "main.js missing: run npm run build first"; exit 1; }
mkdir -p "$OUT" "$DEMO/.obsidian/plugins/revisit" "$DEMO/Notes"

cp "$REPO/main.js" "$REPO/manifest.json" "$REPO/styles.css" "$DEMO/.obsidian/plugins/revisit/"
printf '["revisit"]\n' > "$DEMO/.obsidian/community-plugins.json"
cat > "$DEMO/.obsidian/plugins/revisit/data.json" <<'JSON'
{ "folder": "Revisit", "budgetMinutes": 20, "newPerDay": 5 }
JSON

# invented cards: Biology, History and English notes, a schedule with cards due
# today, tomorrow and over the next weeks, and 60 days of review history
DEMO="$DEMO" node --input-type=module - <<'JS'
import { mkdirSync, writeFileSync } from 'node:fs';

const root = process.env.DEMO;
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const DAY = 86400000;
const now = Date.now();
const day0 = new Date(); day0.setHours(0, 0, 0, 0);

const notes = {
	Biology: [
		['Which organelle produces ATP?', 'The mitochondrion.', 'Biology > Cytology'],
		['What carries genetic information in the nucleus?', 'DNA, packed into chromosomes.', 'Biology > Cytology'],
		['Where does photosynthesis happen?', 'In the chloroplasts.', 'Biology > Cytology'],
		['What does the ribosome do?', 'It builds proteins from RNA instructions.', 'Biology > Cytology'],
		['What is osmosis?', 'Water moving through a membrane toward the saltier side.', 'Biology > Cytology'],
		['What are the four DNA bases?', 'Adenine, thymine, guanine, cytosine.', 'Biology > Genetics'],
		['What is a recessive allele?', 'One that shows only when both copies are the same.', 'Biology > Genetics'],
		['What does mRNA do?', 'Carries a gene copy from the nucleus to the ribosome.', 'Biology > Genetics'],
		['What is natural selection?', 'Traits that help survival become more common over generations.', 'Biology > Evolution'],
		['What is a species?', 'A group that can breed and have fertile offspring.', 'Biology > Evolution'],
	],
	History: [
		['When did the French Revolution begin?', '1789.', 'History > Modern'],
		['What started the First World War?', 'The assassination of Archduke Franz Ferdinand in 1914.', 'History > Modern'],
		['Who was the first emperor of Rome?', 'Augustus.', 'History > Ancient'],
		['What was the Renaissance?', 'A revival of art and science in Europe, from the 14th century.', 'History > Medieval'],
		['When did the Berlin Wall fall?', '1989.', 'History > Modern'],
		['What was the Silk Road?', 'A trade network linking China to the Mediterranean.', 'History > Ancient'],
		['What was the Industrial Revolution?', 'The shift to machine production that began in Britain around 1760.', 'History > Modern'],
		['Who wrote the Magna Carta?', 'English barons forced King John to sign it in 1215.', 'History > Medieval'],
	],
	English: [
		['Past tense of "to bring"?', 'Brought.', 'English > Verbs'],
		['Difference between "affect" and "effect"?', 'Affect is a verb; effect is a noun.', 'English > Vocabulary'],
		['What does "ubiquitous" mean?', 'Found everywhere.', 'English > Vocabulary'],
		['Plural of "criterion"?', 'Criteria.', 'English > Vocabulary'],
		['What is a gerund?', 'A verb used as a noun: "Swimming is fun".', 'English > Grammar'],
		['Past participle of "to write"?', 'Written.', 'English > Verbs'],
		['What does "ephemeral" mean?', 'Lasting a very short time.', 'English > Vocabulary'],
		['When do we use "fewer"?', 'With things you can count: fewer apples.', 'English > Grammar'],
	],
};

mkdirSync(`${root}/Revisit`, { recursive: true });
mkdirSync(`${root}/Notes`, { recursive: true });
const state = {};
const log = [];
const ids = new Set();
const newId = () => {
	for (;;) {
		let id = 'l';
		for (let i = 0; i < 5; i++) id += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(rnd() * 36)];
		if (!ids.has(id)) return (ids.add(id), id);
	}
};
const cards = [];
for (const [name, list] of Object.entries(notes)) {
	writeFileSync(`${root}/Notes/${name}.md`, `# ${name}\n\nStudy notes. The cards for this note live in the Revisit folder.\n`);
	const blocks = list.map(([front, back, topic]) => {
		const id = newId();
		cards.push({ id, topic });
		return `Front: ${front}\nBack: ${back}\nType: Question\nTopic: ${topic}\nSource: [[Notes/${name}|${name}]] ^${id}`;
	});
	writeFileSync(`${root}/Revisit/${name}.md`, blocks.join('\n\n---\n\n') + '\n');
}

// schedule: most cards learned and spread out; about 40% due today, some tomorrow, the rest later
cards.forEach((c, i) => {
	if (i % 9 === 8) return; // a few stay new
	const stability = 3 + Math.floor(rnd() * 25);
	const offset = i % 5 < 2 ? -Math.floor(rnd() * 3) : 1 + Math.floor(rnd() * 20);
	const due = new Date(day0.getTime() + offset * DAY + 8 * 3600000);
	const last = new Date(due.getTime() - stability * DAY);
	state[c.id] = { st: 'active', fsrs: { due: due.toISOString(), stability, difficulty: 4 + rnd() * 4, elapsed_days: stability, scheduled_days: stability, reps: 3 + Math.floor(rnd() * 8), lapses: Math.floor(rnd() * 2), learning_steps: 0, state: 2, last_review: last.toISOString() } };
});

// 60 days of history, a session on most days
for (let ago = 60; ago >= 1; ago--) {
	if (rnd() < 0.18) continue;
	const n = 6 + Math.floor(rnd() * 28);
	for (let k = 0; k < n; k++) {
		const c = cards[Math.floor(rnd() * cards.length)];
		const t = new Date(day0.getTime() - ago * DAY + 19 * 3600000 + k * 40000);
		log.push(JSON.stringify({ id: c.id, t: t.toISOString(), grade: rnd() < 0.14 ? 1 : rnd() < 0.5 ? 3 : 4, seconds: 5 + Math.floor(rnd() * 18), type: 'Question', new: false, extra: false, state: 2 }));
	}
}
writeFileSync(`${root}/Revisit/state.json`, JSON.stringify(state));
writeFileSync(`${root}/Revisit/review-log.jsonl`, log.join('\n') + '\n');
console.log(`demo vault: ${cards.length} cards, ${Object.keys(state).length} scheduled, ${log.length} past reviews`);
JS

export DISPLAY="${DISPLAY:-:0}"
"$ELECTRON" "$ASAR" --user-data-dir="$PROFILE" --ozone-platform=x11 "obsidian://open?path=$DEMO" >/dev/null 2>&1 &

WIN=""
for i in $(seq 1 30); do
	WIN="$(xdotool search --name "revisit-demo-vault" 2>/dev/null | tail -1)"
	[ -n "$WIN" ] && break
	[ "$i" = 12 ] && echo "If the window opened asking for trust, click 'Trust author and enable plugins'."
	sleep 2
done
[ -n "$WIN" ] || { echo "The demo vault window did not show up; open the vault by hand and run again."; exit 1; }
xdotool windowactivate "$WIN" 2>/dev/null
sleep 1
eval "$(xdotool getwindowgeometry --shell "$WIN")"
echo
echo "Recording the ${WIDTH}x${HEIGHT}+${X}+${Y} window. Ctrl+C stops it and makes the GIF."
echo
echo "Script (about 60s):"
echo "  1. Click the layers icon in the left ribbon: the panel opens with the 30-day forecast (Progress tab)."
echo "  2. Back on Today, press Review: pick 10 min and show how many cards fit each length. Press Start."
echo "  3. Flip a card (click it or press Space), grade a few with the buttons or the keys 1 to 4."
echo "  4. Press Q to end: show the summary with tomorrow's minutes."
echo "  (For the phone shot, drag the window narrow, about 390 px wide, before step 2.)"
ffmpeg -y -f x11grab -framerate 30 -video_size "${WIDTH}x${HEIGHT}" -i ":0.0+${X},${Y}" \
	-c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p "$OUT/demo-raw.mp4" || true
[ -s "$OUT/demo-raw.mp4" ] || { echo "Empty recording."; exit 1; }
ffmpeg -y -i "$OUT/demo-raw.mp4" \
	-vf "crop=iw*0.8:ih*0.9:iw*0.1:ih*0.05,fps=12,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" \
	"$OUT/demo.gif" || true
echo "Done: $OUT/demo-raw.mp4 and $OUT/demo.gif (the GIF goes in the README)."
