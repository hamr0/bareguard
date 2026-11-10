import test from "node:test";
import assert from "node:assert/strict";
import { createRubric, checkStep, rubricSha, rubricVocabulary } from "../src/index.js";

// in / notIn `ignoreCase` (RULED #74). Frozen cases from mailproof's POC (F26/F27).

const mk = (checks) => createRubric({ schema: 1, goal: "g", checkpoints: { a: { gating: true, checks } } });
const chk = (rule, values, extra = {}) => ({ id: "k", rule, field: "firstLine", values, ...extra });
const run = (rule, values, firstLine, extra) => checkStep(mk([chk(rule, values, extra)]), "a", { firstLine });
const refused = (checks) => {
  try { mk(checks); } catch (e) { return e; }
  assert.fail("expected createRubric to refuse");
};

test("frozen case 1: in [APPROVE], default -> RED", async () => {
  assert.equal((await run("in", ["APPROVE"], "Approved.")).verdict, "red");
});
test("frozen case 2: in [approved], ignoreCase -> RED (the period must still match)", async () => {
  assert.equal((await run("in", ["approved"], "Approved.", { ignoreCase: true })).verdict, "red");
});
test("frozen case 3: in [Approved.], default -> GREEN", async () => {
  assert.equal((await run("in", ["Approved."], "Approved.")).verdict, "green");
});
test("frozen case 4: in [APPROVED.], ignoreCase -> GREEN", async () => {
  assert.equal((await run("in", ["APPROVED."], "Approved.", { ignoreCase: true })).verdict, "green");
});
test("frozen case 5: in [Mashy], default: Mashy GREEN, mashy RED", async () => {
  assert.equal((await run("in", ["Mashy"], "Mashy")).verdict, "green");
  assert.equal((await run("in", ["Mashy"], "mashy")).verdict, "red");
});
test("frozen case 6: notIn [approved.], ignoreCase -> RED", async () => {
  assert.equal((await run("notIn", ["approved."], "Approved.", { ignoreCase: true })).verdict, "red");
});
test("frozen case 7: createRubric in [Mashy, mashy] + ignoreCase -> REFUSED at the list", () => {
  const e = refused([chk("in", ["Mashy", "mashy"], { ignoreCase: true })]);
  assert.equal(e.path, "spec.checkpoints.a.checks[0].values");
  assert.match(e.message, /duplicates/);
  const n = refused([chk("notIn", ["Mashy", "mashy"], { ignoreCase: true })]);
  assert.equal(n.path, "spec.checkpoints.a.checks[0].values");
});

test("without ignoreCase (absent or false) a case-differing list stays legal", async () => {
  assert.doesNotThrow(() => mk([chk("in", ["Mashy", "mashy"])]));
  assert.doesNotThrow(() => mk([chk("in", ["Mashy", "mashy"], { ignoreCase: false })]));
  assert.equal((await run("in", ["Mashy", "mashy"], "mashy", { ignoreCase: false })).verdict, "green");
});

test("ignoreCase: false does NOT fold: a case-differing value is red for in, green for notIn", async () => {
  assert.equal((await run("in", ["approved."], "Approved.", { ignoreCase: false })).verdict, "red");
  assert.equal((await run("notIn", ["approved."], "Approved.", { ignoreCase: false })).verdict, "green");
  assert.equal((await run("in", ["approved."], "Approved.", { ignoreCase: true })).verdict, "green");
  assert.equal((await run("notIn", ["approved."], "Approved.", { ignoreCase: true })).verdict, "red");
});

test("notIn default: Approved. vs [approved.] -> GREEN (case differs)", async () => {
  assert.equal((await run("notIn", ["approved."], "Approved.")).verdict, "green");
  assert.equal((await run("notIn", ["Approved."], "Approved.")).verdict, "red");
});

test("non-boolean ignoreCase is refused with the exact path", () => {
  for (const v of ["true", 1, 0, null, [], {}]) {
    for (const rule of ["in", "notIn"]) {
      const e = refused([chk(rule, ["a"], { ignoreCase: v })]);
      assert.equal(e.path, "spec.checkpoints.a.checks[0].ignoreCase", String(v));
      assert.match(e.message, /must be a boolean/);
    }
  }
});

test("no NFC: composed e-acute vs decomposed with ignoreCase -> RED; same form folds", async () => {
  const composed = "é";
  const decomposed = "é";
  assert.equal((await run("in", [composed], decomposed, { ignoreCase: true })).verdict, "red");
  assert.equal((await run("in", [decomposed], composed, { ignoreCase: true })).verdict, "red");
  assert.equal((await run("in", ["É"], composed, { ignoreCase: true })).verdict, "green");
});

test("no trim: whole-value equality, surrounding space or punctuation is red", async () => {
  assert.equal((await run("in", ["approved."], " Approved.", { ignoreCase: true })).verdict, "red");
  assert.equal((await run("in", ["approved."], "Approved", { ignoreCase: true })).verdict, "red");
});

test("ignoreCase on an already lower-case value is a no-op (same verdict, same gap)", async () => {
  for (const [rule, values, value] of [["in", ["a@x.io"], "a@x.io"], ["in", ["a@x.io"], "b@x.io"], ["notIn", ["a@x.io"], "a@x.io"], ["notIn", ["a@x.io"], "b@x.io"]]) {
    const a = await run(rule, values, value);
    const b = await run(rule, values, value, { ignoreCase: true });
    assert.equal(b.verdict, a.verdict);
    assert.deepEqual(b.gaps, a.gaps);
  }
});

test("gaps keep today's kinds and show the field and signed values as written (not folded)", async () => {
  const r = await run("in", ["APPROVED.", "OK."], "Nope", { ignoreCase: true });
  assert.equal(r.verdict, "red");
  const g = r.gaps[0];
  assert.equal(g.kind, "not-in");
  assert.equal(g.measured, "Nope");
  assert.deepEqual(g.items, ["APPROVED.", "OK."]);
  const f = await run("notIn", ["APPROVED."], "Approved.", { ignoreCase: true });
  assert.equal(f.gaps[0].kind, "forbidden");
  assert.equal(f.gaps[0].measured, "Approved.");
  assert.deepEqual(f.gaps[0].items, ["APPROVED."]);
});

test("non-string values stay wrong-type, with or without ignoreCase", async () => {
  for (const extra of [{}, { ignoreCase: true }]) {
    for (const rule of ["in", "notIn"]) {
      const r = await checkStep(mk([chk(rule, ["1"], extra)]), "a", { firstLine: 1 });
      assert.equal(r.verdict, "red");
      assert.equal(r.gaps[0].kind, "wrong-type");
    }
  }
});

test("rubricSha of absent / false ignoreCase specs is the one main produced (3bb777e, hard-coded)", () => {
  const spec = (checks) => ({ schema: 1, goal: "g", checkpoints: { a: { gating: true, checks } } });
  assert.equal(rubricSha(spec([chk("in", ["Approved."])])), "f22b5e6879c524cc0d38b8fe8da6d68df46d4102de3c412c362ab0e5fd654c3f");
  assert.equal(rubricSha(spec([chk("notIn", ["Mashy", "mashy"])])), "263ef12e884d132a337d2b7063541e629d544e1eaf601e66ece0a0442962b2db");
  // opting in is a different signed spec
  assert.notEqual(rubricSha(spec([chk("in", ["Approved."], { ignoreCase: true })])), "f22b5e6879c524cc0d38b8fe8da6d68df46d4102de3c412c362ab0e5fd654c3f");
});

test("vocabulary: in and notIn list ignoreCase, and each worked example runs GREEN", async () => {
  for (const rule of ["in", "notIn"]) {
    const d = rubricVocabulary.rules[rule];
    assert.deepEqual(Object.keys(d.fields), ["field", "values", "ignoreCase", "text"]);
    assert.deepEqual(d.fields.ignoreCase, { type: "boolean", required: false, default: false });
    assert.ok(d.description.includes("ignoreCase?: boolean = false"));
    const { check, output } = d.example;
    assert.equal(check.ignoreCase, true);
    const ok = await checkStep(mk([{ ...check }]), "a", output);
    assert.equal(ok.verdict, "green", JSON.stringify(ok.gaps));
    // mutation-sensitive: without the fold the same example is not green for `in`, and not for notIn either
    const noFold = { ...check }; delete noFold.ignoreCase;
    const exact = await checkStep(mk([noFold]), "a", output);
    assert.equal(exact.verdict === "green", rule === "notIn");
  }
});
