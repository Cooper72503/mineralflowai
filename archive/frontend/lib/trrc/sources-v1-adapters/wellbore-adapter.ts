import type { SourceAdapter, WellInput } from './base';
import type { SourceResult, TrrcRecord } from '../types';
import { makeRecord, makeResult } from './base';
import { EWA_BASE, fetchViaProxy, formBody, parseEwaTable } from './ewa-helpers';

export class WellboreAdapter implements SourceAdapter {
  readonly id = 'wellbore_identity';
  readonly name = 'Wellbore Identity Record';
  readonly category = 'well_identity' as const;
  readonly sourceSystem = 'TRRC EWA';

  // Return the resolved well data so the orchestrator can seed other adapters
  resolvedWell: Record<string, string> = {};

  async retrieve(input: WellInput): Promise<SourceResult> {
    const start = new Date();
    const sourceUrl = `${EWA_BASE}/wellboreQueryAction.do?searchArgs.apiNoPrefixArg=${input.apiPrefix}&searchArgs.apiNoSuffixArg=${input.apiSuffix}&searchArgs.scheduleTypeArg=Both&methodToCall=search`;

    try {
      const html = await fetchViaProxy(
        `${EWA_BASE}/wellboreQueryAction.do`,
        formBody({
          'searchArgs.apiNoPrefixArg': input.apiPrefix,
          'searchArgs.apiNoSuffixArg': input.apiSuffix,
          'searchArgs.scheduleTypeArg': 'Both',
          'methodToCall': 'search',
        }),
      );

      const parsed = parseEwaTable(html);
      if (!parsed) {
        return makeResult(this, 'not_found', [], start, 'No wellbore records found in TRRC');
      }

      const records: TrrcRecord[] = parsed.rows.slice(0, 10).map((obj, i) => {
        // Seed resolved well from first row
        if (i === 0) this.resolvedWell = obj;

        return makeRecord(input.runId ?? '', this, input, {
          documentName: `Wellbore Record - API 42-${input.apiPrefix}-${input.apiSuffix}`,
          recordType: 'Wellbore Identity',
          sourceUrl,
          retrievalMethod: 'link_only',
          leaseNumber: obj['lease_no_'] ?? obj['lease_no'] ?? input.leaseNumber,
          district: obj['district'] ?? input.district,
          structuredData: obj,
        });
      });

      // Seed the input from what we found
      if (this.resolvedWell['district']) input.district = this.resolvedWell['district'];
      if (this.resolvedWell['lease_no_'] || this.resolvedWell['lease_no']) {
        input.leaseNumber = this.resolvedWell['lease_no_'] ?? this.resolvedWell['lease_no'] ?? null;
      }
      if (this.resolvedWell['operator_name']) input.operatorName = this.resolvedWell['operator_name'];

      return makeResult(this, 'found', records, start);
    } catch (err) {
      return makeResult(this, 'failed', [], start, String(err));
    }
  }
}
