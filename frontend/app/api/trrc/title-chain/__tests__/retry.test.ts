import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const { from, getUser, update, eq, maybeSingle } = vi.hoisted(() => ({ from: vi.fn(), getUser: vi.fn(), update: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() }));
vi.mock('@/lib/supabase/from-route-request', () => ({ createSupabaseFromRouteRequest: async () => ({ from, auth: { getUser } }) }));
import { POST } from '../[jobId]/retry/route';
const run = () => POST(new NextRequest('https://example.test/api/trrc/title-chain/j/retry', { method: 'POST' }), { params: Promise.resolve({ jobId: 'j' }) });
const job = { id: 'j', status: 'awaiting_tract_confirmation', attempt_count: 8, updated_at: '2026-09-23T00:00:00Z' };
beforeEach(() => {
 vi.resetAllMocks();
 const chain = { select: vi.fn().mockReturnThis(), eq, update, maybeSingle };
 eq.mockReturnValue(chain); update.mockReturnValue(chain); from.mockReturnValue(chain);
 getUser.mockResolvedValue({ data: { user: { id: 'owner' } }, error: null });
 maybeSingle.mockResolvedValueOnce({ data: job, error: null }).mockResolvedValueOnce({ data: { id: 'j' }, error: null });
});
describe('authenticated title retrieval resume', () => {
 it('resumes a review-paused job and preserves accumulated evidence and attempts', async () => {
  expect((await run()).status).toBe(200);
  expect(from.mock.calls.every(([table]) => table === 'title_research_jobs')).toBe(true);
  expect(update.mock.calls[0][0]).toMatchObject({ status: 'pending' });
  expect(update.mock.calls[0][0]).not.toHaveProperty('attempt_count');
  expect(eq).toHaveBeenCalledWith('user_id', 'owner');
  expect(eq).toHaveBeenCalledWith('status', job.status);
  expect(eq).toHaveBeenCalledWith('updated_at', job.updated_at);
 });
 it('returns conflict if cancellation or another action wins the update race', async () => {
  maybeSingle.mockReset().mockResolvedValueOnce({ data: job }).mockResolvedValueOnce({ data: null, error: null });
  expect((await run()).status).toBe(409);
 });
 it.each(['searching_records', 'ingesting', 'analyzing', 'complete', 'cancelled'])('cannot resume %s', async status => {
  maybeSingle.mockReset().mockResolvedValueOnce({ data: { ...job, status } });
  expect((await run()).status).toBe(409); expect(update).not.toHaveBeenCalled();
 });
 it('preserves the failed-job attempt limit', async () => {
  maybeSingle.mockReset().mockResolvedValueOnce({ data: { ...job, status: 'failed' } });
  expect((await run()).status).toBe(409); expect(update).not.toHaveBeenCalled();
 });
 it('requires authentication', async () => {
  getUser.mockResolvedValue({ data: { user: null } });
  expect((await run()).status).toBe(401); expect(from).not.toHaveBeenCalled();
 });
 it('hides missing or other-owner jobs', async () => {
  maybeSingle.mockReset().mockResolvedValueOnce({ data: null, error: null });
  expect((await run()).status).toBe(404); expect(update).not.toHaveBeenCalled();
 });
});
