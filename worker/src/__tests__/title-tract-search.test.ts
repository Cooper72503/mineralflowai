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
