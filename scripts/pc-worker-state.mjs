/** Read a field from an existing dispatch for wait/release operations. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
try {
  const [action, home, field] = process.argv.slice(2);
  if (action !== 'get') throw new Error('Unknown worker state operation');
  console.log(JSON.parse(readFileSync(join(home, 'dispatch.json'), 'utf8'))[field]);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
