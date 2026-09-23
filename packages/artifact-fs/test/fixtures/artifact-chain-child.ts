/**
 * T11 fixture: writes the source -> analysis -> report chain into a fresh
 * artifact store rooted at argv[2], prints the record ids as JSON.
 */
import { ArtifactStore } from "../../src/index.js";

const root = process.argv[2];
if (root === undefined) {
  process.stderr.write("usage: artifact-chain-child.js <artifactRoot>\n");
  process.exit(64);
}

const store = await ArtifactStore.open({ root });
const source = await store.write({
  content: "let x = 1\n",
  mediaType: "text/x-python",
  producer: { type: "human", id: "author-1" },
});
const analysis = await store.write({
  content: "{\"findings\":[\"f1\"]}\n",
  mediaType: "application/json",
  producer: { type: "agent", id: "pi-session-1" },
  parents: [source.id],
  refs: { session: "pi-session-1", toolCall: "call-7" },
});
const report = await store.write({
  content: "# report\nfinal.\n",
  mediaType: "text/markdown",
  producer: { type: "tool", id: "report-writer" },
  parents: [analysis.id],
  refs: { run: "run-42" },
});
process.stdout.write(`${JSON.stringify({ source: source.id, analysis: analysis.id, report: report.id })}\n`);
