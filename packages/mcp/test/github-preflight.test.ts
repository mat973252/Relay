import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { preflight } from "../examples/github-preflight.js";

const input = { repository: "fixture/repo", repositoryId: 17, name: "RELAY_PROBE_NEW" };
const repo = { id: 17, full_name: "fixture/repo", permissions: { admin: true } };
const token = "authentication-sentinel";
const observed: { url: string; options: RequestInit }[] = [];
afterEach(() => {
  for (const { url, options } of observed.splice(0)) {
    assert.ok(url.startsWith("https://api.github.com/repos/fixture/repo"));
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal((options.headers as Record<string, string>).authorization, `Bearer ${token}`);
  }
});
function transport(bodies: unknown[], statuses: number[] = []) {
  const calls: string[] = [];
  const fetcher = async (url: string, options: RequestInit) => {
    observed.push({ url, options });
    calls.push(url);
    return new Response(JSON.stringify(bodies[calls.length - 1]), { status: statuses[calls.length - 1] ?? 200 });
  };
  return { fetcher, calls };
}
it("requires a token and valid explicit context without making a request", async () => {
  const mock = transport([]);
  assert.equal((await preflight(input, undefined, mock.fetcher)).status, "blocked");
  await assert.rejects(preflight({ ...input, repository: "../escape" }, token, mock.fetcher), /invalid/);
  assert.equal(mock.calls.length, 0);
});
it("does not serialize unexpected runtime input fields", async () => {
  const extra = { ...input, token };
  const report = await preflight(extra, undefined, transport([]).fetcher);
  assert.ok(!JSON.stringify(report).includes(token));
});
it("walks all pages, reports only absence evidence, and never grants write permission", async () => {
  const variables = Array.from({ length: 30 }, (_, i) => ({ name: `OLD_${i}`, value: "private-value-sentinel" }));
  const mock = transport([repo, { total_count: 31, variables }, { total_count: 31, variables: [{ name: "LAST", value: "private-value-sentinel" }] }]);
  const report = await preflight(input, token, mock.fetcher);
  assert.equal(report.status, "enumeration_complete");
  assert.equal(report.atomicSnapshot, false);
  assert.equal(report.postAuthorized, false);
  assert.equal(report.variablesWrite, "unverified");
  assert.equal(mock.calls.length, 3);
  assert.match(mock.calls[2]!, /page=2$/);
  assert.ok(!JSON.stringify(report).includes("sentinel"));
});
it("blocks changing totals, duplicated pages, name identity mismatch and thrown secret errors", async () => {
  const variables = Array.from({ length: 30 }, (_, i) => ({ name: `V_${i}` }));
  for (const bodies of [
    [repo, { total_count: 31, variables }, { total_count: 30, variables: [] }],
    [repo, { total_count: 31, variables }, { total_count: 31, variables: [variables[0]] }],
    [{ ...repo, full_name: "fixture/replaced" }],
  ]) assert.equal((await preflight(input, token, transport(bodies).fetcher)).status, "blocked");
  const failed = await preflight(input, token, async () => { throw new Error(token); });
  assert.equal(failed.status, "blocked");
  assert.ok(!JSON.stringify(failed).includes(token));
});
it("rejects collisions and repository identity changes", async () => {
  const collision = transport([repo, { total_count: 1, variables: [{ name: input.name.toLowerCase() }] }]);
  assert.equal((await preflight(input, token, collision.fetcher)).absence, "name_exists");
  const mismatch = transport([{ ...repo, id: 18 }]);
  assert.equal((await preflight(input, token, mismatch.fetcher)).identity, "unverified");
  assert.equal(mismatch.calls.length, 1);
});
it("does not interpret 404, malformed, or incomplete lists as absence", async () => {
  for (const status of [401, 403, 404, 500]) {
    const mock = transport([repo, { message: token }], [200, status]);
    const report = await preflight(input, token, mock.fetcher);
    assert.equal(report.status, "blocked");
    assert.equal(report.absence, "unverified");
    assert.ok(!JSON.stringify(report).includes(token));
  }
  for (const body of [null, { total_count: 2, variables: [] }, { total_count: 1, variables: [{}] }]) {
    assert.equal((await preflight(input, token, transport([repo, body]).fetcher)).status, "blocked");
  }
});
it("stops at the page budget without claiming absence", async () => {
  const pages = Array.from({ length: 100 }, (_, page) => ({ total_count: 3001,
    variables: Array.from({ length: 30 }, (_, i) => ({ name: `PAGE_${page}_${i}` })) }));
  const mock = transport([repo, ...pages]);
  const report = await preflight(input, token, mock.fetcher);
  assert.equal(mock.calls.length, 101);
  assert.equal(report.status, "blocked");
  assert.equal(report.absence, "unverified");
  assert.deepEqual(report.reasons, ["pagination_limit"]);
});
