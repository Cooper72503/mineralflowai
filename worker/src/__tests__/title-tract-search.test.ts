import { describe, it, expect } from 'vitest';
import { indexMatchesTract, tractQueries } from '../title-tract-search.js';
const tract = { id: 't', county: 'Midland', section_name: '37', block_number: '39 T4S', match_status: 'confirmed' };
describe('tract index discovery', () => {
  it.each([
    ['SEC 37 BLK 39 T4S', true],
    ['SECTION 37 BLOCK 39 T 4 S', true],
    ['SEC 37 BLK 39 T3S', false],
    ['SEC 13 BLK 39 T4S', false],
    ['OWNER: 3810 BUTTERCUP GARDENDALE TX 79758', false],
    ['SEC 37 BLK 39 T3S; SEC 13 BLK 39 T4S', false],
    ['SEC 37 BLK 39', false],
  ])('checks %s', (legal, expected) => expect(indexMatchesTract(legal, tract)).toBe(expected));
  it('does not manufacture township or use unconfirmed scope', () => {
    expect(tractQueries({ ...tract, block_number: '39' })).toEqual([]);
    expect(tractQueries({ ...tract, match_status: 'proposed' })).toEqual([]);
  });
});

describe("aliquot parts before the section number (Howard County clerk format)", () => {
  const sec10 = { id: "t", county: "Howard", section_name: "10", block_number: "34 T2N", match_status: "confirmed" };
  it("reads the section after an aliquot part", () => {
    expect(indexMatchesTract("Survey Name: T&PRR Survey Block: 34 Township: 2N Section: E/2 10 Acres: PT 641.27", sec10)).toBe(true);
    expect(indexMatchesTract("Survey Name: T&PRR Survey Block: 34 Township: 2N Section: W/2 10 Acres: PT 639.9", sec10)).toBe(true);
    expect(indexMatchesTract("Section: NE/4 OF 10 Block: 34 Township: 2N", sec10)).toBe(true);
  });
  it("never reads the aliquot denominator as the section", () => {
    const sec2 = { ...sec10, section_name: "2" };
    expect(indexMatchesTract("Survey Name: T&PRR Survey Block: 34 Township: 2N Section: E/2 10", sec2)).toBe(false);
    const sec4 = { ...sec10, section_name: "4" };
    expect(indexMatchesTract("Section: NE/4 OF 10 Block: 34 Township: 2N", sec4)).toBe(false);
  });
});
