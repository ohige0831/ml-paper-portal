import type { PagesFunction } from '@cloudflare/workers-types';
import { getTagsWithCount } from '../../src/db/queries';

interface Env { DB: D1Database }

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  try {
    const tags = await getTagsWithCount(ctx.env.DB);
    return Response.json(tags, {
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
};
