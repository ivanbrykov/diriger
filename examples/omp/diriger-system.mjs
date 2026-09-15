// Explicit OMP extension: replace worker instructions, not compaction prompts.
// Keep --system-prompt FILE in argv so Diriger fingerprints the prompt dependency.
import {readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';
export default function dirigerSystem(api) {
  const index = process.argv.indexOf('--system-prompt');
  const promptPath = index >= 0 ? process.argv[index + 1] : undefined;
  if (!promptPath || !isAbsolute(promptPath)) {
    throw new Error('Diriger prompt extension requires --system-prompt ABSOLUTE_FILE');
  }
  const prompt = readFileSync(promptPath, 'utf8');
  if (!prompt.trim()) throw new Error('Diriger worker system prompt is empty');
  // OMP applies this override to worker turns. Its independent history-summary
  // calls retain their own system prompt and implementation.
  api.on('before_agent_start', () => ({systemPrompt: [prompt]}));
}
