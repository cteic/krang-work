import { WorkError, WorkStore } from "../src/work-store.ts";

// Test helper, run as a separate process by work-store.test.ts. It tries to
// claim every issue id it is given and prints one "<id> <actor>" line per win.
// A refused claim is the expected result for most attempts; anything else is a
// fault and exits non-zero so the test fails loudly.

const [, , root, actor, ...ids] = process.argv;
if (root === undefined || actor === undefined) {
  console.error("usage: claim-racer.ts <work-dir> <actor> <id>...");
  process.exit(2);
}

const store = new WorkStore(root);
for (const id of ids) {
  try {
    store.claim(id, actor, 600, "local");
    console.log(`${id} ${actor}`);
  } catch (error) {
    if (error instanceof WorkError && error.code === "already_claimed") continue;
    throw error;
  }
}
