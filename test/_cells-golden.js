// The checkStep results over every cells / table / diff worked example (and tampered variants), as plain JSON. The fixture
// test/fixtures/cells-golden.json was produced by this function against the code BEFORE ruling #82 (HEAD 98e6523 + the docs), so a test
// that compares today's output to it proves `checkStep`'s contract did not change. Takes the module namespace so it can run on any copy.
export async function computeGolden(m) {
  const { createRubric, checkStep, tableSha, rubricVocabulary } = m;
  const tables = rubricVocabulary.cells.exampleTables;
  const out = {};
  for (const rule of ["cells", "table", "diff"]) {
    for (const [op, d] of Object.entries(rubricVocabulary.rules[rule].ops)) {
      const check = d.example.check;
      const claim = d.example.output ?? { answer: { value: "x" } };
      const names = rule === "diff" ? [check.before] : [check.table];
      const variants = {
        plain: { tables },
        tamperedCell: { tables: { ...tables, t: { header: tables.t.header, rows: tables.t.rows.map((r, i) => (i === 0 ? { rowNumber: r.rowNumber, cells: r.cells.map((c, j) => (j === 1 ? "999" : c)) } : r)) } }, signed: tables },
        missingTable: { tables: { a: tables.a }, signed: tables },
        raggedTable: { tables: { ...tables, t: { header: tables.t.header, rows: [{ rowNumber: 2, cells: ["x"] }] } }, signed: { t: tables.t, a: tables.a } },
      };
      for (const [vn, v] of Object.entries(variants)) {
        const signedTables = v.signed ?? v.tables;
        const rubric = createRubric({ schema: 1, goal: "g", inputs: names.map((n) => ({ name: n, sha256: tableSha(signedTables[n]) })), checkpoints: { cp: { gating: true, checks: [check] } } });
        out[`${rule}.${op}.${vn}`] = JSON.parse(JSON.stringify(await checkStep(rubric, "cp", claim, { tables: v.tables })));
      }
    }
  }
  return out;
}
