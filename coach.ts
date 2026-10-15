// Supabase Edge Function: coach  (Dashboard → Edge Functions → Deploy new function → name it "coach")
// Secret needed: ANTHROPIC_API_KEY (Edge Functions → Secrets)
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const J = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const clip = (s: unknown, n = 400) => String(s ?? '').slice(0, n);
const arr = (x: unknown) => (Array.isArray(x) ? x.slice(0, 40).map((i) => clip(i, 60)) : []);

async function claude(system: string, user: string) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5-5',
      max_tokens: 400,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!r.ok) throw new Error('The AI request failed. Try again.');
  const d = await r.json();
  return d.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return J({ error: 'Please log in again.' }, 401);
    const b = await req.json();
    if (!['suggest', 'explain', 'overview'].includes(b.mode)) return J({ error: 'Bad request.' }, 400);

    // Daily limit: 5 questions, +3 for every friend who joined with the user's code (up to 5 friends)
    const refs = (await sb.rpc('my_referral_count')).data ?? 0;
    const limit = 5 + 3 * Math.min(refs, 5);
    const since = new Date(Date.now() - 864e5).toISOString();
    const { count } = await sb.from('ai_usage').select('id', { count: 'exact', head: true }).gte('created_at', since);
    if ((count ?? 0) >= limit) return J({ error: "You've used today's AI questions. Invite a friend to get 3 more." }, 429);
    await sb.from('ai_usage').insert({ user_id: user.id });
    const left = limit - (count ?? 0) - 1;

    if (b.mode === 'suggest') {
      const options = arr(b.options), selected = arr(b.selected);
      const raw = await claude(
        'You help people explore their interests, strengths and values. Reply ONLY with JSON: {"picks":[...],"why":"..."}. ' +
          'picks: 1 to 5 items copied exactly from the allowed list. why: at most 2 short sentences linking the picks to what the person wrote. ' +
          'Be encouraging. Never diagnose, never promise outcomes.',
        `Field: ${clip(b.field, 30)}\nAllowed: ${JSON.stringify(options)}\nAlready selected: ${JSON.stringify(selected)}\nThe person wrote: ${clip(b.text)}`,
      );
      const m = raw.match(/\{[\s\S]*\}/);
      const j = m ? JSON.parse(m[0]) : {};
      const picks = (Array.isArray(j.picks) ? j.picks : []).filter((p: string) => options.includes(p) && !selected.includes(p)).slice(0, 5);
      return J({ picks, why: clip(j.why, 300), left });
    }

    if (b.mode === 'overview') {
      const raw = await claude(
        'Reply ONLY with JSON: {"what":"...","skills":["..."],"start":"..."}. what: one plain sentence (max 25 words) saying what this field or skill involves. ' +
          'skills: exactly 4 beginner-friendly skills. start: one small first step a beginner can do this week. No promises about jobs or income.',
        `Skill or career: ${clip(b.skill, 80)}`,
      );
      const m = raw.match(/\{[\s\S]*\}/);
      const j = m ? JSON.parse(m[0]) : {};
      return J({ what: clip(j.what, 200), skills: arr(j.skills).slice(0, 4), start: clip(j.start, 200), left });
    }

    const p = b.profile ?? {};
    const text = await claude(
      'In at most 3 short sentences, explain why this direction may fit the person, using only the interests, strengths and values given. ' +
        'Say it is a possibility to test, not a verdict. Plain text, no lists.',
      `Direction: ${clip(b.direction, 80)}\nInterests: ${JSON.stringify(arr(p.interests))}\nDemonstrated strengths: ${JSON.stringify(arr(p.strengths))}\nValues: ${JSON.stringify(arr(p.values))}`,
    );
    return J({ text: clip(text, 600), left });
  } catch (e) {
    return J({ error: e instanceof Error ? e.message : 'Something went wrong.' }, 500);
  }
});
