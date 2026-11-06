// Copies the built plugin into a vault: REVISIT_VAULT=/path/to/vault npm run deploy
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const vault = process.env.REVISIT_VAULT;
if (!vault) {
	process.stderr.write('Set REVISIT_VAULT to the vault folder.\n');
	process.exit(1);
}
const target = join(vault, '.obsidian', 'plugins', 'revisit');

mkdirSync(target, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) copyFileSync(file, join(target, file));
process.stdout.write(`Revisit copied to ${target}\n`);
