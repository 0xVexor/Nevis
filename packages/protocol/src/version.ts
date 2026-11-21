/** The schema version of this build's data (ADR-0002 `sv`): the ProseMirror schema and the record shapes. ONE constant for the whole
 *  repository: the envelope carries it, `doc_state.max_sv` records it, and every client, harness and test imports it from here.
 *  A change of any schema is an `SV + 1` and a golden fixture (docs/PROCESS.md, ADR-0003 §8). Never write the number as a literal. */
export const SV = 2
