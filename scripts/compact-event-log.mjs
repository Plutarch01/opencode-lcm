import path from 'node:path';

import { DEFAULT_OPTIONS } from '../dist/options.js';
import { SqliteLcmStore } from '../dist/store.js';

function parseArgs(argv) {
  let workspace = process.cwd();
  let vacuum = true;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--workspace' && index + 1 < argv.length) {
      workspace = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--no-vacuum') {
      vacuum = false;
    }
  }

  return { workspace, vacuum };
}

const { workspace, vacuum } = parseArgs(process.argv.slice(2));
const store = new SqliteLcmStore(workspace, DEFAULT_OPTIONS);

try {
  await store.init();
  const result = await store.compactEventLog({
    apply: true,
    vacuum,
    limit: 20,
  });
  console.log(result);
} finally {
  store.close();
}
