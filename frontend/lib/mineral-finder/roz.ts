import { sanAndresRozContext, type RozContext } from "../geology/san-andres-roz";
import type { Prospect } from "./types";

/**
 * A lead's published ROZ context. Results sealed before the context existed carry
 * no `roz` key; for those it is derived from the lead's own saved county and field
 * name against the same static, versioned dataset, so the answer is identical.
 */
export const rozOf = (p: Prospect): RozContext | null =>
  p.roz !== undefined ? p.roz : sanAndresRozContext(p.well.county, p.well.association?.fieldName ?? null);
